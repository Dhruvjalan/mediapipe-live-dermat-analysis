/**
 * The health history on this device, in the browser's built-in database
 * (IndexedDB). Nothing leaves the device. Where the browser won't keep data
 * (some private windows, site data blocked), history is simply unavailable:
 * scans and consultations carry on exactly as before.
 */

import {
  GUEST,
  newEntry,
  newestFirst,
  recordConsultation,
  userKeyFrom,
  type HistoryConsultation,
  type HistoryEntry,
  type HistoryStore,
} from './health-history';
import type { SkinMetrics } from './skin-interpretation';

const DB_NAME = 'ayurgenx';
const DB_VERSION = 1;
const ENTRIES = 'history';
/** sessionStorage: the saved scan that the current consultation is about, and when it was taken. */
const CURRENT_ENTRY = 'ayurgenx-history-entry';
const CURRENT_SCAN_TIME = 'ayurgenx-history-scan-time';

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once a write transaction is safely stored. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // While the error is still bubbling, tx.error can be null; fall back to the request's error.
    tx.onerror = (event) =>
      reject(tx.error ?? (event.target as IDBRequest | null)?.error ?? new Error('History write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('History write was aborted'));
  });
}

let connection: Promise<IDBDatabase> | null = null;

/**
 * The open database, opened on first use and opened again whenever the browser
 * closes it (site data cleared, storage lost, a newer version of the app in
 * another tab), so history keeps saving without a page reload.
 */
function database(): Promise<IDBDatabase> {
  connection ??= openDatabase().catch((err) => {
    connection = null; // let the next attempt try again
    throw err;
  });
  return connection;
}

class IndexedDbHistoryStore implements HistoryStore {
  /** A transaction on the current connection; a connection that has gone stale is reopened once. */
  private async open(mode: IDBTransactionMode) {
    for (let attempt = 1; ; attempt++) {
      const db = await database();
      try {
        const tx = db.transaction(ENTRIES, mode);
        return { tx, entries: tx.objectStore(ENTRIES) };
      } catch (err) {
        if (attempt > 1 || (err as DOMException).name !== 'InvalidStateError') throw err;
        connection = null;
      }
    }
  }

  async addScan(userKey: string, metrics: SkinMetrics, at?: number): Promise<HistoryEntry> {
    const entry = newEntry(userKey, metrics, at);
    const { tx, entries } = await this.open('readwrite');
    entries.add(entry);
    await committed(tx);
    return entry;
  }

  async attachConsultation(id: string, consultation: HistoryConsultation): Promise<HistoryEntry | null> {
    const { tx, entries } = await this.open('readwrite');
    let updated = null as HistoryEntry | null;
    // Read and write in one transaction, so nothing can change the entry in between.
    const read = entries.get(id);
    read.onsuccess = () => {
      const entry = read.result as HistoryEntry | undefined;
      if (!entry) return;
      updated = { ...entry, consultation };
      entries.put(updated);
    };
    await committed(tx);
    return updated;
  }

  async list(userKey: string): Promise<HistoryEntry[]> {
    const { entries } = await this.open('readonly');
    const found = (await settled(entries.index('userKey').getAll(userKey))) as HistoryEntry[];
    return found.sort(newestFirst);
  }

  async get(id: string): Promise<HistoryEntry | null> {
    const { entries } = await this.open('readonly');
    return ((await settled(entries.get(id))) as HistoryEntry | undefined) ?? null;
  }

  async remove(id: string): Promise<void> {
    const { tx, entries } = await this.open('readwrite');
    entries.delete(id);
    await committed(tx);
  }

  async clear(userKey: string): Promise<void> {
    const { tx, entries } = await this.open('readwrite');
    const keys = entries.index('userKey').getAllKeys(userKey);
    keys.onsuccess = () => keys.result.forEach((key) => entries.delete(key));
    await committed(tx);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not supported here'));
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      return reject(err); // some browsers refuse storage synchronously (SecurityError)
    }
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const entries = request.result.createObjectStore(ENTRIES, { keyPath: 'id' });
        entries.createIndex('userKey', 'userKey');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        if (connection && db === currentDb) connection = null;
      };
      currentDb = db;
      // Let a deletion or a newer version of the app go ahead, and reopen on next use.
      db.onversionchange = () => {
        db.close();
        forget();
      };
      db.onclose = forget; // closed by the browser (storage lost, site data cleared)
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The history is open in an older tab of this app'));
  });
}

let currentDb: IDBDatabase | null = null;
const store = new IndexedDbHistoryStore();

/** The history on this device, or null when this browser won't keep data. */
export async function openHistoryStore(): Promise<HistoryStore | null> {
  try {
    await database();
    return store;
  } catch (err) {
    console.warn('Health history is not available in this browser:', err);
    return null;
  }
}

/** Whose history to show and save: the signed-in email, or "guest". */
export function currentUserKey(): string {
  try {
    return userKeyFrom(localStorage.getItem('ayurgenx_user'));
  } catch {
    return GUEST;
  }
}

/** Saves a finished scan, and remembers it for the consultation that follows. Never throws. */
export async function saveScanToHistory(metrics: SkinMetrics): Promise<void> {
  const scannedAt = Date.now();
  try {
    // A new scan: the next report belongs to it.
    sessionStorage.removeItem(CURRENT_ENTRY);
    sessionStorage.setItem(CURRENT_SCAN_TIME, String(scannedAt));
    const history = await openHistoryStore();
    if (!history) return;
    const entry = await history.addScan(currentUserKey(), metrics, scannedAt);
    sessionStorage.setItem(CURRENT_ENTRY, entry.id);
  } catch (err) {
    console.warn('Could not save this scan to your history:', err);
  }
}

/**
 * Saves a finished consultation with the scan it followed. Another report on
 * the same scan replaces the earlier one. Never throws.
 */
export async function saveConsultationToHistory(metrics: SkinMetrics, consultation: HistoryConsultation): Promise<void> {
  try {
    const history = await openHistoryStore();
    if (!history) return;
    const entryId = sessionStorage.getItem(CURRENT_ENTRY);
    const scannedAt = Number(sessionStorage.getItem(CURRENT_SCAN_TIME)) || undefined;
    const entry = await recordConsultation(history, entryId, currentUserKey(), metrics, consultation, scannedAt);
    sessionStorage.setItem(CURRENT_ENTRY, entry.id);
  } catch (err) {
    console.warn('Could not save this consultation to your history:', err);
  }
}

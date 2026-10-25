/**
 * Health History — every completed scan, and the consultation that followed it,
 * so people can see how their skin and habits change over time. Kept on this
 * device (see history-store.ts); this file holds the shapes and the rules, so
 * they can be tested without a browser.
 */

import type { ReportAssessment } from './groq-service';
import type { SkinMetrics } from './skin-interpretation';

// ── Types ────────────────────────────────────────────────────────────────────

/** The consultation that followed a scan: what the report was written from, and the report itself. */
export interface HistoryConsultation {
  /** When the report was written (ms since 1970). */
  completedAt: number;
  assessment: ReportAssessment;
  /** The report letter (markdown), so it can be opened again. */
  report: string;
}

export interface HistoryEntry {
  id: string;
  /** Whose history this is: the signed-in email, or "guest". */
  userKey: string;
  /** When the scan was completed (ms since 1970). */
  createdAt: number;
  /** Exactly what the scan table showed, including the scan engine version. */
  metrics: SkinMetrics;
  consultation?: HistoryConsultation;
}

export interface HistoryStore {
  /** Saves a completed scan as a new entry. */
  addScan(userKey: string, metrics: SkinMetrics, at?: number): Promise<HistoryEntry>;
  /** Adds the consultation to an entry, replacing any earlier one; null if the entry is gone. */
  attachConsultation(id: string, consultation: HistoryConsultation): Promise<HistoryEntry | null>;
  /** One user's entries, newest first. */
  list(userKey: string): Promise<HistoryEntry[]>;
  get(id: string): Promise<HistoryEntry | null>;
  remove(id: string): Promise<void>;
  /** Deletes all of one user's entries. */
  clear(userKey: string): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export const GUEST = 'guest';

/** The history owner from the stored sign-in ({"email": ...}); "guest" when nobody is signed in. */
export function userKeyFrom(storedUser: string | null): string {
  try {
    const email = JSON.parse(storedUser ?? 'null')?.email;
    return typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : GUEST;
  } catch {
    return GUEST;
  }
}

export function newEntry(userKey: string, metrics: SkinMetrics, at = Date.now()): HistoryEntry {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${at.toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { id, userKey, createdAt: at, metrics: { ...metrics } };
}

export const newestFirst = (a: HistoryEntry, b: HistoryEntry) => b.createdAt - a.createdAt;

/**
 * What is kept of a consultation: everything except the user's verbatim words
 * quoted in a risk ("Said: ..."), which can be as sensitive as a self-harm
 * statement. The labels, severities and the report itself are kept.
 */
function withoutQuotes(consultation: HistoryConsultation): HistoryConsultation {
  const { lifestyle } = consultation.assessment;
  const risks = lifestyle.risks.map((r) => (r.detail.startsWith('Said:') ? { ...r, detail: '' } : r));
  return { ...consultation, assessment: { ...consultation.assessment, lifestyle: { ...lifestyle, risks } } };
}

/**
 * Saves a finished consultation with the scan it followed. If that scan was
 * never saved (or has been deleted, or belongs to someone else), it is saved
 * now, dated when it was taken (`scannedAt`) when that is known.
 */
export async function recordConsultation(
  store: HistoryStore,
  entryId: string | null,
  userKey: string,
  metrics: SkinMetrics,
  consultation: HistoryConsultation,
  scannedAt?: number
): Promise<HistoryEntry> {
  const scan = entryId ? await store.get(entryId) : null;
  const target =
    scan?.userKey === userKey ? scan : await store.addScan(userKey, metrics, scannedAt ?? consultation.completedAt);
  return (await store.attachConsultation(target.id, withoutQuotes(consultation))) ?? target;
}

// ── In-memory store (tests, and a stand-in where the browser can't store data) ──

export class MemoryHistoryStore implements HistoryStore {
  private entries = new Map<string, HistoryEntry>();

  async addScan(userKey: string, metrics: SkinMetrics, at?: number): Promise<HistoryEntry> {
    const entry = newEntry(userKey, metrics, at);
    this.entries.set(entry.id, structuredClone(entry));
    return entry;
  }

  async attachConsultation(id: string, consultation: HistoryConsultation): Promise<HistoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const updated = { ...entry, consultation: structuredClone(consultation) };
    this.entries.set(id, updated);
    return structuredClone(updated);
  }

  async list(userKey: string): Promise<HistoryEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.userKey === userKey)
      .sort(newestFirst)
      .map((e) => structuredClone(e));
  }

  async get(id: string): Promise<HistoryEntry | null> {
    const entry = this.entries.get(id);
    return entry ? structuredClone(entry) : null;
  }

  async remove(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async clear(userKey: string): Promise<void> {
    for (const [id, entry] of this.entries) if (entry.userKey === userKey) this.entries.delete(id);
  }
}

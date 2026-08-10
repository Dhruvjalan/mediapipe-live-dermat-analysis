/**
 * AyurGenX Skin History & Trend Analytics Service
 */

export interface HistoricalScan {
  id: string;
  date: string;
  health: number;
  hydration: number;
  melanin: number;
  erythema: number;
  wrinkles: number;
  acne: number;
  texture: number;
}

export class SkinHistoryService {
  private static STORAGE_KEY = 'ayurgenx_scan_history';

  public static saveScan(metrics: any): void {
    if (!metrics || metrics.health === undefined) return;
    const history = this.getHistory();

    const newScan: HistoricalScan = {
      id: 'scan_' + Date.now(),
      date: new Date().toISOString(),
      health: Math.round(metrics.health || 0),
      hydration: Math.round(metrics.hydration || 0),
      melanin: Math.round(metrics.melanin || 0),
      erythema: Math.round(metrics.erythema || 0),
      wrinkles: Math.round(metrics.wrinkles || 0),
      acne: Math.round(metrics.acne || 0),
      texture: Math.round(metrics.texture || 0),
    };

    history.unshift(newScan);
    // Retain maximum of 15 historical records for privacy and storage efficiency
    if (history.length > 15) history.pop();

    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(history));
  }

  public static getHistory(): HistoricalScan[] {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      return [];
    }
  }

  public static clearHistory(): void {
    localStorage.removeItem(this.STORAGE_KEY);
  }
}

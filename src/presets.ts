export type Performance = 'light' | 'standard' | 'fresh';

export interface PerformanceParams {
  /** 画面が変わっているときの撮影間隔(ms) */
  baseMs: number;
  /** 画面が変わらない間、間隔を延ばす上限(ms) */
  maxMs: number;
  /** 撮影する画質(1 = 等倍) */
  quality: number;
}

export const PERFORMANCE_PRESETS: Record<Performance, PerformanceParams> = {
  light: { baseMs: 4000, maxMs: 12000, quality: 0.5 },
  standard: { baseMs: 2000, maxMs: 6000, quality: 0.75 },
  fresh: { baseMs: 1000, maxMs: 3000, quality: 1 },
};

export const DEFAULT_PERFORMANCE: Performance = 'standard';

export function isPerformance(value: unknown): value is Performance {
  return value === 'light' || value === 'standard' || value === 'fresh';
}

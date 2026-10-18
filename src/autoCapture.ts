import type { NativeImage } from 'electron';
import activeWindow = require('active-win');
import type { PerformanceParams } from './presets';

/** 前面アプリを確認する間隔(ms) */
const POLL_MS = 500;
/** この秒数、マウスもキーも動かなければ、撮影と確認を止める */
const IDLE_STOP_S = 5;
/** 縮小画像の差がこの割合(%)以上なら「画面が変わった」とみなす */
const CHANGE_PCT = 0.5;
const SIG_WIDTH = 64;
const SIG_HEIGHT = 36;
/** 変化がないとき、間隔に掛ける倍率 */
const BACKOFF = 2;

export function matchesTarget(
  win: { title?: string; owner?: { name?: string } } | undefined,
  targets: string[],
): boolean {
  if (!win) return false;
  const haystack = [win.owner?.name, win.title].filter(Boolean).join('\n').toLowerCase();
  return targets.some((t) => t && haystack.includes(t.toLowerCase()));
}

function signature(image: NativeImage): Buffer {
  return image.resize({ width: SIG_WIDTH, height: SIG_HEIGHT, quality: 'good' }).toBitmap();
}

/** 2つの縮小画像の差(0〜100%)。アルファは見ない。 */
export function diffPercent(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return 100;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    count += 3;
  }
  return (sum / (count * 255)) * 100;
}

export interface SwitchCaptureOptions {
  /** 画面を撮る。quality は 1 が等倍。 */
  grab: (quality: number) => Promise<NativeImage | null>;
  /** 対象アプリに切り替わった瞬間に、直前の画面を受け取る(音やフラッシュは出さない) */
  onSwitch: (image: NativeImage) => void;
  getTargets: () => string[];
  getParams: () => PerformanceParams;
  /** マウス・キーの無操作時間(秒) */
  getIdleSeconds: () => number;
}

/**
 * 対象アプリが前面でない間、直前の画面を1枚だけメモリに持つ。
 * - 無操作が続いたら、撮影も前面アプリの確認も止める
 * - 画面が変わらない間は、撮影の間隔を延ばす
 * 画像はメモリ上のみで、ディスクには書かない。
 */
export class SwitchCapture {
  private timer: NodeJS.Timeout | null = null;
  private frame: NativeImage | null = null;
  private lastSignature: Buffer | null = null;
  private frontIsTarget = false;
  private polling = false;
  private capturing = false;
  private interval = 0;
  private nextCaptureAt = 0;

  constructor(private readonly options: SwitchCaptureOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.frame = null;
    this.lastSignature = null;
    this.frontIsTarget = false;
    this.interval = 0;
    this.nextCaptureAt = 0;
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    if (this.options.getIdleSeconds() >= IDLE_STOP_S) return;
    this.polling = true;
    try {
      const isTarget = matchesTarget(await activeWindow(), this.options.getTargets());
      const wasTarget = this.frontIsTarget;
      this.frontIsTarget = isTarget;

      if (isTarget) {
        if (!wasTarget && this.frame) {
          const image = this.frame;
          this.frame = null;
          this.options.onSwitch(image);
        }
        return;
      }

      if (!this.capturing && Date.now() >= this.nextCaptureAt) {
        void this.capture();
      }
    } catch (err) {
      console.error('auto capture poll failed:', err);
    } finally {
      this.polling = false;
    }
  }

  private async capture(): Promise<void> {
    this.capturing = true;
    try {
      const params = this.options.getParams();
      const image = await this.options.grab(params.quality);
      if (!image) {
        this.nextCaptureAt = Date.now() + params.baseMs;
        return;
      }

      const sig = signature(image);
      const changed = !this.lastSignature || diffPercent(sig, this.lastSignature) >= CHANGE_PCT;
      if (changed) {
        this.lastSignature = sig;
        this.interval = params.baseMs;
      } else {
        this.interval = Math.min(Math.max(this.interval, params.baseMs) * BACKOFF, params.maxMs);
      }

      // 撮影中に対象アプリへ切り替わっていたら、そのフレームは捨てる。
      // 変化がなくても、保持するフレームが空なら入れておく(切り替え後の取りこぼし防止)。
      if (!this.frontIsTarget && this.timer && (changed || !this.frame)) this.frame = image;

      this.nextCaptureAt = Date.now() + this.interval;
    } catch (err) {
      console.error('auto capture failed:', err);
    } finally {
      this.capturing = false;
    }
  }
}

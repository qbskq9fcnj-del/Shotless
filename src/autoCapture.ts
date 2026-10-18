import type { NativeImage } from 'electron';
import activeWindow = require('active-win');

const POLL_MS = 300;
const CAPTURE_MS = 1000;

export function matchesTarget(
  win: { title?: string; owner?: { name?: string } } | undefined,
  targets: string[],
): boolean {
  if (!win) return false;
  const haystack = [win.owner?.name, win.title].filter(Boolean).join('\n').toLowerCase();
  return targets.some((t) => t && haystack.includes(t.toLowerCase()));
}

/**
 * 対象アプリが前面でない間、直前の画面を1枚だけメモリに持つ。
 * 対象アプリに切り替わった瞬間に、そのフレームを onSwitch に渡す(音やフラッシュは出さない)。
 * 画像はメモリ上のみで、ディスクには書かない。
 */
export class SwitchCapture {
  private timer: NodeJS.Timeout | null = null;
  private frame: NativeImage | null = null;
  private frontIsTarget = false;
  private polling = false;
  private capturing = false;
  private lastCaptureAt = 0;

  constructor(
    private readonly grab: () => Promise<NativeImage | null>,
    private readonly onSwitch: (image: NativeImage) => void,
    private readonly getTargets: () => string[],
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.frame = null;
    this.frontIsTarget = false;
  }

  private async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const isTarget = matchesTarget(await activeWindow(), this.getTargets());
      const wasTarget = this.frontIsTarget;
      this.frontIsTarget = isTarget;

      if (isTarget) {
        if (!wasTarget && this.frame) {
          const image = this.frame;
          this.frame = null;
          this.onSwitch(image);
        }
        return;
      }

      if (!this.capturing && Date.now() - this.lastCaptureAt >= CAPTURE_MS) {
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
      const image = await this.grab();
      this.lastCaptureAt = Date.now();
      // 撮影中に対象アプリへ切り替わっていたら、そのフレームは捨てる
      if (image && !this.frontIsTarget && this.timer) this.frame = image;
    } catch (err) {
      console.error('auto capture failed:', err);
    } finally {
      this.capturing = false;
    }
  }
}

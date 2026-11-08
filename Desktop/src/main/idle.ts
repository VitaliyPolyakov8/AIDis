import { powerMonitor } from 'electron';

const CHECK_MS = 15_000;

/**
 * Automatic Away: Windows' own "time since the last keyboard/mouse input" (powerMonitor), checked
 * every 15 s, plus the lock screen. Only a yes/no "idle" leaves this module. Stopped when the
 * setting is off.
 */
export class IdleMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private thresholdSec = 600;
  private idle = false;
  private locked = false;
  private readonly onChange: (idle: boolean) => void;
  private readonly onLock = () => {
    this.locked = true;
    this.check();
  };
  private readonly onUnlock = () => {
    this.locked = false;
    this.check();
  };

  constructor(onChange: (idle: boolean) => void) {
    this.onChange = onChange;
  }

  configure(enabled: boolean, minutes: number): void {
    this.thresholdSec = minutes * 60;
    if (!enabled) {
      this.stop();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => this.check(), CHECK_MS);
      powerMonitor.on('lock-screen', this.onLock);
      powerMonitor.on('unlock-screen', this.onUnlock);
    }
    this.check();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      powerMonitor.off('lock-screen', this.onLock);
      powerMonitor.off('unlock-screen', this.onUnlock);
    }
    this.timer = null;
    this.locked = false;
    this.set(false);
  }

  private check(): void {
    this.set(this.locked || powerMonitor.getSystemIdleTime() >= this.thresholdSec);
  }

  private set(idle: boolean): void {
    if (idle === this.idle) return;
    this.idle = idle;
    this.onChange(idle);
  }
}

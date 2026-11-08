import os from 'node:os';
import { app } from 'electron';
import { logger } from './logger';

/**
 * 0.5.2: while the user streams, every AIDis process (browser, GPU = capture copy + NVENC, video
 * capture utility, renderers) runs at "above normal" priority, and goes back to normal when the
 * stream ends.
 *
 * Why: a game keeps every core busy, and the capture-to-encoder pipeline then waits for CPU time.
 * Measured on this project's FPS harness (1080p screen capture, NVENC, 16 busy threads standing in
 * for a game): 39 FPS at normal priority, 56-57 FPS above normal (59 without load). Chromium's own
 * "don't background the renderer" switches made no difference there (39 vs 39). Above normal is
 * one step only: never "high" / "realtime", which could starve the game or the system.
 */
const RAISED = os.constants.priority.PRIORITY_ABOVE_NORMAL;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;
/** New processes (a stream pop-out, a restarted GPU process) are picked up this often. */
const REAPPLY_MS = 10_000;

export class StreamPriority {
  private active = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly raised = new Set<number>();
  private warned = false;

  set(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.apply();
      this.timer = setInterval(() => this.apply(), REAPPLY_MS);
      logger.info('stream', `Process priority above normal while streaming (${this.raised.size} processes)`);
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.restore();
      logger.info('stream', 'Process priority back to normal');
    }
  }

  private apply(): void {
    for (const metric of app.getAppMetrics()) {
      if (this.raised.has(metric.pid)) continue;
      try {
        os.setPriority(metric.pid, RAISED);
        this.raised.add(metric.pid);
      } catch (error) {
        if (!this.warned) logger.warn('stream', `Could not raise the priority of the ${metric.type} process: ${error instanceof Error ? error.message : 'error'}`);
        this.warned = true;
      }
    }
  }

  private restore(): void {
    for (const pid of this.raised) {
      try {
        os.setPriority(pid, NORMAL);
      } catch {
        /* the process is gone */
      }
    }
    this.raised.clear();
  }
}

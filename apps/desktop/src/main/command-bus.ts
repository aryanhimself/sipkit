/**
 * Delivers {@link DesktopCommand}s to the renderer, queueing them until the
 * renderer has said it is ready (e.g. a `tel:` link that launched the app
 * arrives before the window has loaded).
 */
import type { DesktopCommand } from '../shared/ipc';

export const MAX_QUEUED_COMMANDS = 20;

export class CommandBus {
  private queue: DesktopCommand[] = [];
  private isReady = false;

  constructor(private readonly deliver: (command: DesktopCommand) => void) {}

  send(command: DesktopCommand): void {
    if (this.isReady) {
      this.deliver(command);
      return;
    }
    // Only the latest dial matters; drop older queued dials.
    if (command.type === 'dial') this.queue = this.queue.filter((c) => c.type !== 'dial');
    this.queue.push(command);
    if (this.queue.length > MAX_QUEUED_COMMANDS) this.queue.shift();
  }

  /** The renderer (re)loaded and subscribed: flush the queue. */
  ready(): void {
    this.isReady = true;
    const pending = this.queue;
    this.queue = [];
    for (const command of pending) this.deliver(command);
  }

  /** The renderer is gone (reload / crash): queue again until the next ready(). */
  reset(): void {
    this.isReady = false;
  }

  get pending(): readonly DesktopCommand[] {
    return this.queue;
  }
}

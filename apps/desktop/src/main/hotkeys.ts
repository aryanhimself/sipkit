/**
 * Registers the configured global hotkeys with Electron `globalShortcut`
 * (V2-DESK-03). They fire while the app is in the background. Each press calls
 * `onAction(action)`, which the main process forwards to the renderer as a
 * {@link DesktopCommand}.
 */
import { planHotkeys, type HotkeyAction, type HotkeySettings } from '../shared/hotkeys';
import type { HotkeyRegistrationResult } from '../shared/ipc';

/** The subset of Electron's `globalShortcut` we use (injectable for tests). */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export class HotkeyManager {
  private active: string[] = [];

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onAction: (action: HotkeyAction) => void,
  ) {}

  /** Replace all registrations with `settings`. Returns what worked and what did not. */
  apply(settings: Partial<HotkeySettings>): HotkeyRegistrationResult {
    this.clear();
    const plan = planHotkeys(settings);
    const result: HotkeyRegistrationResult = { registered: [], problems: [...plan.problems] };
    for (const { action, accelerator } of plan.bindings) {
      let ok = false;
      try {
        ok = this.registry.register(accelerator, () => this.onAction(action));
      } catch {
        ok = false;
      }
      if (ok) {
        this.active.push(accelerator);
        result.registered.push({ action, accelerator });
      } else {
        // Another application owns the shortcut (register() returns false silently).
        result.problems.push({ action, accelerator, error: 'unavailable' });
      }
    }
    return result;
  }

  /** Simulate a key press (used by the e2e hook and the tray). */
  trigger(action: HotkeyAction): void {
    this.onAction(action);
  }

  clear(): void {
    for (const accelerator of this.active) {
      try {
        this.registry.unregister(accelerator);
      } catch {
        /* already gone */
      }
    }
    this.active = [];
  }
}

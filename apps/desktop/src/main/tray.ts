/**
 * Tray icon with the softphone status (registered / DND / ringing / in call)
 * and a small menu (V2-DESK-01).
 */
import { Menu, nativeImage, Tray, type NativeImage } from 'electron';
import type { DesktopMessageKey } from '../shared/i18n';
import { TRAY_COLORS, type TrayStatus } from '../shared/status';
import { circleIcon } from './png';

const BASE_COLOR: [number, number, number] = [30, 41, 59];

export function trayImage(status: TrayStatus): NativeImage {
  const image = nativeImage.createFromBuffer(circleIcon(16, BASE_COLOR, TRAY_COLORS[status]), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: circleIcon(32, BASE_COLOR, TRAY_COLORS[status]) });
  return image;
}

export interface TrayActions {
  show(): void;
  toggleDnd(): void;
  openSettings(): void;
  quit(): void;
}

export class TrayController {
  private tray: Tray | null = null;
  private status: TrayStatus = 'offline';

  constructor(
    private readonly appName: string,
    private t: (key: DesktopMessageKey, params?: Record<string, string>) => string,
    private readonly actions: TrayActions,
  ) {}

  create(): void {
    this.tray = new Tray(trayImage(this.status));
    this.tray.on('click', () => this.actions.show());
    this.render();
  }

  get current(): TrayStatus {
    return this.status;
  }

  setStatus(status: TrayStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.tray?.setImage(trayImage(status));
    this.render();
  }

  setTranslator(t: (key: DesktopMessageKey, params?: Record<string, string>) => string): void {
    this.t = t;
    this.render();
  }

  private render(): void {
    if (!this.tray) return;
    const statusLabel = this.t(`tray.status.${this.status}` as DesktopMessageKey);
    this.tray.setToolTip(this.t('tray.tooltip', { app: this.appName, status: statusLabel }));
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        { label: this.t('tray.show'), click: () => this.actions.show() },
        {
          label: this.t('tray.dnd'),
          type: 'checkbox',
          checked: this.status === 'dnd',
          enabled: this.status !== 'offline' && this.status !== 'connecting',
          click: () => this.actions.toggleDnd(),
        },
        { label: this.t('tray.settings'), click: () => this.actions.openSettings() },
        { type: 'separator' },
        { label: this.t('tray.quit'), click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

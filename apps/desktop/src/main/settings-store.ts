/**
 * Local settings store: `<userData>/settings.json`, written atomically
 * (temp file + rename). No secrets in here; see credentials.ts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, sanitizeSettings, type DesktopSettings } from '../shared/settings';

export class SettingsStore {
  private current: DesktopSettings;

  constructor(private readonly file: string) {
    this.current = this.read();
  }

  private read(): DesktopSettings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): DesktopSettings {
    return structuredClone(this.current);
  }

  /** Merge a (possibly untrusted) partial update, persist it and return the result. */
  update(patch: unknown): DesktopSettings {
    this.current = sanitizeSettings(patch, this.current);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.file);
    return this.get();
  }
}

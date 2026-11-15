/**
 * SIP password storage (V2-DESK-01).
 *
 * The password is encrypted with Electron `safeStorage`, whose key lives in the
 * OS keychain (macOS Keychain, Windows DPAPI, libsecret/kwallet on Linux), and
 * the ciphertext is written to `<userData>/credentials.bin`. When encryption is
 * not available (e.g. Linux without a keyring) the password is kept in memory
 * for the session only: it is never written to disk in plain text.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The subset of Electron's `safeStorage` we use (injectable for tests). */
export interface KeyStore {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Test-only key store (SIPKIT_DESKTOP_TEST=1): reversible, never use for real secrets. */
export function memoryKeyStore(): KeyStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`test:${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^test:/, ''),
  };
}

export const MAX_PASSWORD_LENGTH = 512;

export class CredentialStore {
  private sessionOnly: string | null = null;

  constructor(
    private readonly file: string,
    private readonly keys: KeyStore,
  ) {}

  get encryptionAvailable(): boolean {
    try {
      return this.keys.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  has(): boolean {
    return this.sessionOnly !== null || existsSync(this.file);
  }

  /** Returns whether the password was persisted (false = kept for this session only). */
  save(password: string): { stored: boolean } {
    if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error('Invalid password');
    }
    if (!this.encryptionAvailable) {
      this.sessionOnly = password;
      this.removeFile();
      return { stored: false };
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, this.keys.encryptString(password), { mode: 0o600 });
    this.sessionOnly = null;
    return { stored: true };
  }

  get(): string | null {
    if (this.sessionOnly !== null) return this.sessionOnly;
    if (!existsSync(this.file) || !this.encryptionAvailable) return null;
    try {
      return this.keys.decryptString(readFileSync(this.file));
    } catch {
      // Keychain entry gone / different user: treat as missing so setup asks again.
      return null;
    }
  }

  clear(): void {
    this.sessionOnly = null;
    this.removeFile();
  }

  private removeFile(): void {
    rmSync(this.file, { force: true });
  }
}

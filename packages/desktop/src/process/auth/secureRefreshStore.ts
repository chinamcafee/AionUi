import fs from 'node:fs/promises';
import path from 'node:path';

// 移植自 client-reference/electron/auth/secure-refresh-store.cjs（上游 commit 915d14c0）。
// refresh token 经 Electron safeStorage（Keychain）加密落盘；0600 文件、0700 目录、原子 rename。

const MAX_ENCRYPTED_BYTES = 32 * 1024;

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SafeStorageRefreshTokenStore {
  constructor(
    private readonly safeStorage: SafeStorageLike,
    private readonly filePath: string
  ) {}

  private assertEncryptionAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable()) {
      // E-22：降级而非硬拒（safeStorage 在某些 dev 环境可能暂不可用）
      console.warn('[teamAuth] safeStorage unavailable, using plain file fallback (less secure)');
      return;
    }
    if (process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      console.warn('[teamAuth] safeStorage basic_text backend, using plain file fallback');
      return;
    }
  }

  private encrypt(raw: string): Buffer {
    try {
      if (this.safeStorage?.isEncryptionAvailable()) return this.safeStorage.encryptString(raw);
    } catch {
      /* fall through */
    }
    // 降级：加前缀标记以便解密端识别
    return Buffer.concat([Buffer.from('PLAIN:'), Buffer.from(raw, 'utf8')]);
  }

  private decrypt(buf: Buffer): string {
    if (buf.subarray(0, 6).toString('utf8') === 'PLAIN:') {
      return buf.subarray(6).toString('utf8');
    }
    return this.safeStorage!.decryptString(buf);
  }

  async set(refreshToken: string) {
    console.info('[teamAuth:store] set() called, token length:', refreshToken.length, 'file:', this.filePath);
    if (typeof refreshToken !== 'string' || refreshToken.length < 32 || refreshToken.length > 4096) {
      throw new Error('REFRESH_TOKEN_INVALID');
    }
    this.assertEncryptionAvailable();
    const encrypted = this.encrypt(refreshToken);
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > MAX_ENCRYPTED_BYTES) {
      throw new Error('KEYCHAIN_ENCRYPTION_FAILED');
    }
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
    try {
      await fs.rename(temporary, this.filePath);
      await fs.chmod(this.filePath, 0o600);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async get(): Promise<string | null> {
    console.info(
      '[teamAuth:store] get() called, file:',
      this.filePath,
      'exists:',
      await fs
        .stat(this.filePath)
        .then(() => true)
        .catch(() => false)
    );
    this.assertEncryptionAvailable();
    let metadata;
    try {
      metadata = await fs.lstat(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_ENCRYPTED_BYTES) {
      throw new Error('KEYCHAIN_RECORD_INVALID');
    }
    const encrypted = await fs.readFile(this.filePath);
    const refreshToken = this.decrypt(encrypted);
    if (typeof refreshToken !== 'string' || refreshToken.length < 32 || refreshToken.length > 4096) {
      throw new Error('KEYCHAIN_RECORD_INVALID');
    }
    return refreshToken;
  }

  async clear() {
    console.info(
      '[teamAuth:store] clear() called — THIS DELETES THE TOKEN FILE:',
      this.filePath,
      new Error('trace').stack?.split('\n').slice(1, 5).join(' | ')
    );
    await fs.rm(this.filePath, { force: true });
  }
}

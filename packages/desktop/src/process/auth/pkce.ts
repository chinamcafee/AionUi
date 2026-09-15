import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// 移植自 client-reference/electron/auth/pkce.cjs（上游 commit 915d14c0）。
// AionUi 适配：回调协议常量改为 aionui:（AionUi PROTOCOL_SCHEME，见 process/utils/deepLink.ts）。

export const CALLBACK_PROTOCOL = 'aionui:';
const CALLBACK_HOST = 'oauth';
const CALLBACK_PATH = '/callback';
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface PkceAttempt {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
  readonly nonce: string;
  readonly deviceChallenge: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

function base64url(value: Buffer | string) {
  return Buffer.from(value).toString('base64url');
}

export function createPkceAttempt(now: number = Date.now()): PkceAttempt {
  const codeVerifier = base64url(randomBytes(32));
  const nonce = base64url(randomBytes(24));
  return Object.freeze({
    codeVerifier,
    codeChallenge: base64url(createHash('sha256').update(codeVerifier, 'ascii').digest()),
    state: base64url(randomBytes(32)),
    nonce,
    deviceChallenge: `nonce.${nonce}.${base64url(randomBytes(16))}`,
    createdAt: now,
    expiresAt: now + ATTEMPT_TTL_MS,
  });
}

function constantTimeEqual(left: unknown, right: unknown) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash) && left.length === right.length;
}

export function parseAuthorizationCallback(rawUrl: string, expectedState: string): { code: string } {
  let callback: URL;
  try {
    callback = new URL(rawUrl);
  } catch {
    throw new Error('AUTH_CALLBACK_INVALID');
  }
  if (callback.protocol !== CALLBACK_PROTOCOL || callback.hostname !== CALLBACK_HOST ||
      callback.pathname !== CALLBACK_PATH || callback.username || callback.password ||
      callback.port || callback.hash) {
    throw new Error('AUTH_CALLBACK_INVALID');
  }
  const allowed = new Set(['code', 'state', 'error', 'error_description']);
  for (const key of callback.searchParams.keys()) {
    if (!allowed.has(key) || callback.searchParams.getAll(key).length !== 1) {
      throw new Error('AUTH_CALLBACK_INVALID');
    }
  }
  const state = callback.searchParams.get('state');
  if (!constantTimeEqual(state, expectedState)) throw new Error('AUTH_CALLBACK_STATE_INVALID');
  const remoteError = callback.searchParams.get('error');
  if (remoteError) throw new Error('AUTHORIZATION_DENIED');
  const code = callback.searchParams.get('code');
  if (!code || code.length < 32 || code.length > 2048) throw new Error('AUTH_CALLBACK_INVALID');
  return { code };
}

import { describe, expect, it } from 'vitest';
import { createPkceAttempt, parseAuthorizationCallback, ATTEMPT_TTL_MS } from '@/process/auth/pkce';

describe('pkce（移植自 client electron/auth/pkce.cjs）', () => {
  it('生成符合 RFC 7636 的 verifier/challenge 与状态参数', async () => {
    const attempt = createPkceAttempt(1_000);
    expect(attempt.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(attempt.nonce).toMatch(/^[A-Za-z0-9_-]{30,}$/);
    expect(attempt.deviceChallenge.startsWith(`nonce.${attempt.nonce}.`)).toBe(true);
    expect(attempt.expiresAt).toBe(1_000 + ATTEMPT_TTL_MS);
    // S256 challenge 可复算
    const expected = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(attempt.codeVerifier))
    ).toString('base64url');
    expect(attempt.codeChallenge).toBe(expected);
  });

  it('接受 aionui://oauth/callback 且校验 state（常数时间比较路径）', () => {
    const attempt = createPkceAttempt();
    const code = 'a'.repeat(64);
    const url = `aionui://oauth/callback?code=${code}&state=${encodeURIComponent(attempt.state)}`;
    expect(parseAuthorizationCallback(url, attempt.state)).toEqual({ code });
  });

  it('拒绝 zhongshuling:// 旧协议与非法 query', () => {
    const attempt = createPkceAttempt();
    expect(() =>
      parseAuthorizationCallback(
        `zhongshuling://oauth/callback?code=${'a'.repeat(64)}&state=${attempt.state}`,
        attempt.state
      )
    ).toThrow('AUTH_CALLBACK_INVALID');
    expect(() =>
      parseAuthorizationCallback(
        `aionui://oauth/callback?code=${'a'.repeat(64)}&state=${attempt.state}&extra=1`,
        attempt.state
      )
    ).toThrow('AUTH_CALLBACK_INVALID');
  });

  it('state 不匹配 / error 回调 / code 长度非法 均拒绝', () => {
    const attempt = createPkceAttempt();
    const code = 'b'.repeat(64);
    expect(() => parseAuthorizationCallback(`aionui://oauth/callback?code=${code}&state=other`, attempt.state)).toThrow(
      'AUTH_CALLBACK_STATE_INVALID'
    );
    expect(() =>
      parseAuthorizationCallback(`aionui://oauth/callback?error=access_denied&state=${attempt.state}`, attempt.state)
    ).toThrow('AUTHORIZATION_DENIED');
    expect(() =>
      parseAuthorizationCallback(`aionui://oauth/callback?code=short&state=${attempt.state}`, attempt.state)
    ).toThrow('AUTH_CALLBACK_INVALID');
  });
});

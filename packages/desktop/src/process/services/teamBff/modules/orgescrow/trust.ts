import fs from 'node:fs';
import { decode, hash } from './protocol';
import { getSecret, setSecret } from '../personalSync/secretVault';

export type EscrowIdentity = {
  baseUrl: string;
  tenantId: string;
  tenantMemberId: string;
  userId: string;
  deviceId: string;
};
/** The anchor is provisioned out of band. HTTP responses cannot enroll new roots. */
export function deploymentAnchor(identity: EscrowIdentity): Buffer {
  const path = process.env.AION_ESCROW_TRUST_ANCHORS_FILE;
  if (!path) throw new Error('ESCROW_TRUST_ANCHOR_MISMATCH');
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let anchors: Record<string, Record<string, string>>;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536 || (process.platform !== 'win32' && (stat.mode & 0o022) !== 0))
      throw new Error('ESCROW_TRUST_ANCHOR_MISMATCH');
    anchors = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as Record<string, Record<string, string>>;
  } finally {
    fs.closeSync(descriptor);
  }
  const raw = anchors[new URL(identity.baseUrl).origin]?.[identity.tenantId];
  return decode(raw, 32);
}
export function cacheKey(identity: EscrowIdentity, purpose: string): string {
  if (!/^[a-z0-9:-]{1,60}$/.test(purpose)) throw new Error('ESCROW_CACHE_SCOPE_INVALID');
  return `escrow:${hash(JSON.stringify([new URL(identity.baseUrl).origin, identity.tenantId, identity.userId, identity.deviceId, 1]))}:${purpose}`;
}
export function readPending<T>(identity: EscrowIdentity, purpose: string): T | null {
  const raw = getSecret(cacheKey(identity, purpose));
  return raw ? (JSON.parse(raw) as T) : null;
}
export function writePending(identity: EscrowIdentity, purpose: string, value: unknown): void {
  setSecret(cacheKey(identity, purpose), JSON.stringify(value));
}

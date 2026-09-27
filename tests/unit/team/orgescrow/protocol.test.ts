import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonical,
  decode,
  hash,
  open,
  seal,
  signStatement,
  verifyStatement,
  type Scope,
} from '../../../../packages/desktop/src/process/services/teamBff/modules/orgescrow/protocol';

const scope: Scope = {
  protocolVersion: 1,
  purpose: 'org',
  tenantId: '00000000-0000-4000-8000-000000000001',
  tenantMemberId: '00000000-0000-4000-8000-000000000002',
  memberKeyVersion: 1,
  orgKeyVersion: 1,
  encryptionFingerprint: hash('x'),
  signingFingerprint: hash('s'),
  rootKeysetDigest: `sha256:${hash('root')}`,
};
describe('escrow protocol', () => {
  it('rejects ambiguous encodings, unsafe counters and invalid Unicode', () => {
    expect(() => decode('AA==', 1)).toThrow();
    expect(() => canonical({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => canonical({ value: '\ud800' })).toThrow();
  });
  it('binds ciphertext to tenant and every key version', () => {
    const pair = generateKeyPairSync('x25519');
    const key = randomBytes(32);
    const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const envelope = seal(key, raw, scope);
    expect(open(pair.privateKey, envelope, scope)).toEqual(key);
    expect(() => open(pair.privateKey, envelope, { ...scope, memberKeyVersion: 2 })).toThrow();
    expect(() => seal(key, Buffer.alloc(32), scope)).toThrow();
  });
  it('rejects cross-purpose signatures', () => {
    const pair = generateKeyPairSync('ed25519');
    const raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signature = signStatement(pair.privateKey, 'enroll', scope);
    expect(() => verifyStatement(raw, 'enroll', scope, signature)).not.toThrow();
    expect(() => verifyStatement(raw, 'finish', scope, signature)).toThrow();
  });
});

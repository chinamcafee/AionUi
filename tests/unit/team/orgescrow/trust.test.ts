import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALGORITHM,
  hash,
  signStatement,
  verifyManifest,
  type Manifest,
} from '../../../../packages/desktop/src/process/services/teamBff/modules/orgescrow/protocol';
describe('deployment trust', () => {
  it('rejects a valid signature from an unpinned authority and version rollback', () => {
    const anchor = generateKeyPairSync('ed25519');
    const attacker = generateKeyPairSync('ed25519');
    const encryption = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const signing = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const manifest: Manifest = {
      protocolVersion: 1,
      tenantId: '00000000-0000-4000-8000-000000000001',
      orgKeyVersion: 2,
      keyId: 'test',
      algorithm: ALGORITHM,
      encryptionPublicKey: encryption.toString('base64url'),
      signingPublicKey: signing.toString('base64url'),
      encryptionFingerprint: hash(encryption),
      signingFingerprint: hash(signing),
      issuedAt: '2026-09-22T00:00:00Z',
    };
    const signed = { manifest, signature: signStatement(anchor.privateKey, 'manifest', manifest) };
    const pinned = anchor.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    expect(verifyManifest(signed, pinned, manifest.tenantId, 1)).toEqual(manifest);
    expect(() =>
      verifyManifest(
        { manifest, signature: signStatement(attacker.privateKey, 'manifest', manifest) },
        pinned,
        manifest.tenantId,
        1
      )
    ).toThrow();
    expect(() => verifyManifest(signed, pinned, manifest.tenantId, 3)).toThrow();
  });
});

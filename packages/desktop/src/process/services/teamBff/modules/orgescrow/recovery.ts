import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';
import {
  canonical,
  decode,
  hash,
  open,
  signStatement,
  verifyManifest,
  verifyStatement,
  type SignedManifest,
  type SignedResult,
  type ResultStatement,
} from './protocol';

export type RecoveryKdf = { name: 'scrypt'; N: 65536; r: 8; p: 1; keyLen: 32; salt: string };
export type ProofStatement = {
  tenantId: string;
  tenantMemberId: string;
  deviceId: string;
  operationId: string;
  operationHash: string;
  purpose: string;
  nonce: string;
  expiresAt: string;
};
export type ExpectedResult = Omit<ResultStatement, 'envelopes' | 'executionId' | 'resultExpiresAt'> & {
  rootKeysetDigest: string;
  requiredKeyVersions: number[];
};
/** Validate every identity/version before opening even one envelope. */
export function verifyAndOpenResult(
  result: SignedResult,
  expected: ExpectedResult,
  manifests: SignedManifest[],
  anchor: Buffer,
  targetPrivate: KeyObject
): Map<number, Buffer> {
  const st = result.statement;
  const signer = manifests.find((m) => m.manifest.orgKeyVersion === expected.orgKeyVersion);
  if (!signer) throw new Error('ESCROW_KEY_UNAVAILABLE');
  const trusted = verifyManifest(signer, anchor, expected.tenantId, expected.orgKeyVersion);
  if (trusted.keyId !== st.keyId) throw new Error('ESCROW_TRUST_ANCHOR_MISMATCH');
  verifyStatement(decode(trusted.signingPublicKey, 32), 'result', st, result.signature);
  const { rootKeysetDigest: _root, requiredKeyVersions: versions, ...scope } = expected;
  for (const key of Object.keys(scope) as Array<keyof typeof scope>)
    if (st[key] !== scope[key]) throw new Error('REKEY_DEVICE_MISMATCH');
  if (
    !Number.isFinite(Date.parse(st.resultExpiresAt)) ||
    Date.parse(st.resultExpiresAt) <= Date.now() ||
    st.envelopes.length !== versions.length ||
    versions.length < 1 ||
    versions.length > 100
  )
    throw new Error('REKEY_REQUEST_EXPIRED');
  const output = new Map<number, Buffer>();
  try {
    for (let index = 0; index < versions.length; index++) {
      const item = st.envelopes[index];
      const source = manifests.find((m) => m.manifest.orgKeyVersion === item.scope.orgKeyVersion);
      if (!source) throw new Error('ESCROW_KEY_UNAVAILABLE');
      const org = verifyManifest(source, anchor, expected.tenantId, 1);
      if (
        item.memberKeyVersion !== versions[index] ||
        (index > 0 && versions[index] <= versions[index - 1]) ||
        item.envelopeHash !== hash(canonical(item.envelope)) ||
        item.scope.purpose !== 'result' ||
        item.scope.tenantId !== expected.tenantId ||
        item.scope.tenantMemberId !== expected.tenantMemberId ||
        item.scope.targetDeviceId !== expected.targetDeviceId ||
        item.scope.operationId !== expected.operationId ||
        item.scope.executionId !== st.executionId ||
        item.scope.rootKeysetDigest !== expected.rootKeysetDigest ||
        item.scope.memberKeyVersion !== item.memberKeyVersion ||
        item.scope.targetEncryptionFingerprint !== expected.targetEncryptionFingerprint ||
        item.scope.targetSigningFingerprint !== expected.targetSigningFingerprint ||
        item.scope.encryptionFingerprint !== org.encryptionFingerprint ||
        item.scope.signingFingerprint !== org.signingFingerprint
      )
        throw new Error('ESCROW_ENVELOPE_INVALID');
      output.set(item.memberKeyVersion, open(targetPrivate, item.envelope, item.scope));
    }
    return output;
  } catch (error) {
    for (const key of output.values()) key.fill(0);
    throw error;
  }
}
export function compareEnrollmentKeys(recovered: Map<number, Buffer>, local: Map<number, Buffer>): void {
  if (recovered.size !== local.size) throw new Error('ESCROW_COVERAGE_INCOMPLETE');
  for (const [version, key] of recovered) {
    const original = local.get(version);
    if (!original || original.length !== 32 || !timingSafeEqual(original, key))
      throw new Error('ESCROW_SELF_CHECK_FAILED');
  }
}
export function createRecoveryPackage(keys: Map<number, Buffer>): {
  recoveryCode: string;
  recoveryPublicKey: string;
  recoveryFingerprint: string;
  recoveryKdf: RecoveryKdf;
  encryptedRecoveryPackage: string;
  recoveryPackageHash: string;
  privateKey: KeyObject;
} {
  if (
    keys.size < 1 ||
    keys.size > 100 ||
    [...keys].some(([version, key]) => !Number.isSafeInteger(version) || version < 1 || key.length !== 32)
  )
    throw new Error('ESCROW_COVERAGE_INCOMPLETE');
  const recovery = generateKeyPairSync('ed25519');
  const publicRaw = recovery.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const code = randomBytes(32);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf: RecoveryKdf = { name: 'scrypt', N: 65536, r: 8, p: 1, keyLen: 32, salt: salt.toString('base64url') };
  const key = scryptSync(code, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      keyring: [...keys]
        .sort(([a], [b]) => a - b)
        .map(([keyVersion, umk]) => ({ keyVersion, umk: umk.toString('base64url') })),
      recoveryEd25519PrivateKey: recovery.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    })
  );
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('zsl:personal-sync:recovery-package:v1'));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wire = Buffer.from(
      JSON.stringify({
        version: 1,
        kdf: { name: 'scrypt', N: 65536, r: 8, p: 1, keyLen: 32 },
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      })
    );
    return {
      recoveryCode: code.toString('base64url'),
      recoveryPublicKey: publicRaw.toString('base64url'),
      recoveryFingerprint: hash(publicRaw),
      recoveryKdf: kdf,
      encryptedRecoveryPackage: wire.toString('base64url'),
      recoveryPackageHash: `sha256:${hash(wire)}`,
      privateKey: recovery.privateKey,
    };
  } finally {
    plaintext.fill(0);
    key.fill(0);
    code.fill(0);
  }
}
export function signProof(
  proof: ProofStatement,
  privateKey: KeyObject,
  expected: {
    tenantId: string;
    memberId: string;
    deviceId: string;
    operationId: string;
    purpose: string;
    operationHash: string;
  }
) {
  if (
    proof.tenantId !== expected.tenantId ||
    proof.tenantMemberId !== expected.memberId ||
    proof.deviceId !== expected.deviceId ||
    proof.operationId !== expected.operationId ||
    proof.purpose !== expected.purpose ||
    proof.operationHash !== expected.operationHash ||
    !Number.isFinite(Date.parse(proof.expiresAt)) ||
    Date.parse(proof.expiresAt) <= Date.now() ||
    Date.parse(proof.expiresAt) > Date.now() + 301000
  )
    throw new Error('REKEY_DEVICE_MISMATCH');
  decode(proof.nonce, 32);
  return { statement: proof, signature: signStatement(privateKey, 'device-proof', proof) };
}

/** Recover the signing key for a renewed finish proof without changing the saved code. */
export function recoverySigningKey(code: string, kdf: RecoveryKdf, encoded: string): KeyObject {
  if (kdf.name !== 'scrypt' || kdf.N !== 65536 || kdf.r !== 8 || kdf.p !== 1 || kdf.keyLen !== 32)
    throw new Error('RECOVERY_PACKAGE_KDF_UNSUPPORTED');
  const key = scryptSync(decode(code, 32), decode(kdf.salt, 16), 32, {
    N: 65536,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  try {
    const pkg = JSON.parse(decode(encoded, -1).toString('utf8')) as { iv: string; tag: string; ciphertext: string };
    const d = createDecipheriv('aes-256-gcm', key, decode(pkg.iv, 12));
    d.setAAD(Buffer.from('zsl:personal-sync:recovery-package:v1'));
    d.setAuthTag(decode(pkg.tag, 16));
    const plain = Buffer.concat([d.update(decode(pkg.ciphertext, -1)), d.final()]);
    try {
      const opened = JSON.parse(plain.toString('utf8')) as { recoveryEd25519PrivateKey: string };
      return createPrivateKey({ key: decode(opened.recoveryEd25519PrivateKey, -1), format: 'der', type: 'pkcs8' });
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const ALGORITHM = 'X25519-HKDF-SHA256-AES-256-GCM' as const;
export type Scope = {
  protocolVersion: 1;
  purpose: 'org' | 'result';
  tenantId: string;
  tenantMemberId: string;
  memberKeyVersion: number;
  orgKeyVersion: number;
  encryptionFingerprint: string;
  signingFingerprint: string;
  rootKeysetDigest: string;
  operationId?: string;
  executionId?: string;
  targetDeviceId?: string;
  targetEncryptionFingerprint?: string;
  targetSigningFingerprint?: string;
};
export type Envelope = {
  version: 1;
  algorithm: typeof ALGORITHM;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};
export type Manifest = {
  protocolVersion: 1;
  tenantId: string;
  orgKeyVersion: number;
  keyId: string;
  algorithm: typeof ALGORITHM;
  encryptionPublicKey: string;
  signingPublicKey: string;
  encryptionFingerprint: string;
  signingFingerprint: string;
  issuedAt: string;
};
export type SignedManifest = { manifest: Manifest; signature: string };
export type ResultEnvelope = { memberKeyVersion: number; scope: Scope; envelope: Envelope; envelopeHash: string };
export type ResultStatement = {
  protocolVersion: 1;
  operationId: string;
  executionId: string;
  purpose: 'recovery' | 'enrollment';
  tenantId: string;
  tenantMemberId: string;
  targetDeviceId: string;
  targetEncryptionFingerprint: string;
  targetSigningFingerprint: string;
  keyId: string;
  orgKeyVersion: number;
  policyVersion: number;
  rootVersion: number;
  recoveryEpoch: number;
  tenantRecoveryEpoch: number;
  operationHash: string;
  resultExpiresAt: string;
  envelopes: ResultEnvelope[];
};
export type SignedResult = { statement: ResultStatement; signature: string };
const domains = new Set([
  'manifest',
  'init-v2',
  'enroll',
  'request',
  'approval-snapshot',
  'result',
  'ack',
  'finish',
  'key-change',
  'device-proof',
]);
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (): never => {
  throw new Error('ESCROW_ENVELOPE_INVALID');
};
export function hash(raw: Uint8Array | string): string {
  return createHash('sha256').update(raw).digest('hex');
}
export function decode(value: string, size: number): Buffer {
  if (typeof value !== 'string' || value.length > 2 * 1048576 || !/^[A-Za-z0-9_-]*$/.test(value)) return fail();
  const raw = Buffer.from(value, 'base64url');
  if (raw.toString('base64url') !== value || (size >= 0 && raw.length !== size)) return fail();
  return raw;
}
/** RFC 8785 profile with safe integer counters; no floating-point input. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > 32) return fail();
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) return fail();
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return fail();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${canonical(key, depth + 1)}:${canonical(object[key], depth + 1)}`)
      .join(',')}}`;
  }
  return fail();
}
export function signingBytes(domain: string, statement: unknown): Buffer {
  if (!domains.has(domain)) return fail();
  const raw = canonical(statement);
  if (Buffer.byteLength(raw) > 1048576) return fail();
  return Buffer.from(`zsl:org-escrow:${domain}:v1\n${hash(raw)}`);
}
export function signStatement(privateKey: KeyObject, domain: string, statement: unknown): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') return fail();
  return sign(null, signingBytes(domain, statement), privateKey).toString('base64url');
}
export function publicKey(raw: Buffer, algorithm: 'x25519' | 'ed25519'): KeyObject {
  if (raw.length !== 32) return fail();
  const prefix = algorithm === 'x25519' ? '302a300506032b656e032100' : '302a300506032b6570032100';
  return createPublicKey({ key: Buffer.concat([Buffer.from(prefix, 'hex'), raw]), format: 'der', type: 'spki' });
}
export function verifyStatement(rawPublic: Buffer, domain: string, statement: unknown, signature: string): void {
  if (!verify(null, signingBytes(domain, statement), publicKey(rawPublic, 'ed25519'), decode(signature, 64))) fail();
}
function exactFields(value: object, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
export function validateScope(scope: Scope): void {
  exactFields(scope, [
    'protocolVersion',
    'purpose',
    'tenantId',
    'tenantMemberId',
    'memberKeyVersion',
    'orgKeyVersion',
    'encryptionFingerprint',
    'signingFingerprint',
    'rootKeysetDigest',
    'operationId',
    'executionId',
    'targetDeviceId',
    'targetEncryptionFingerprint',
    'targetSigningFingerprint',
  ]);
  if (
    scope.protocolVersion !== 1 ||
    !uuidPattern.test(scope.tenantId) ||
    !uuidPattern.test(scope.tenantMemberId) ||
    !Number.isSafeInteger(scope.memberKeyVersion) ||
    scope.memberKeyVersion < 1 ||
    !Number.isSafeInteger(scope.orgKeyVersion) ||
    scope.orgKeyVersion < 1 ||
    ![scope.encryptionFingerprint, scope.signingFingerprint].every((v) => digestPattern.test(v)) ||
    !/^sha256:[0-9a-f]{64}$/.test(scope.rootKeysetDigest)
  )
    fail();
  if (scope.purpose === 'result') {
    if (
      ![scope.operationId, scope.executionId, scope.targetDeviceId].every(
        (v) => typeof v === 'string' && uuidPattern.test(v)
      ) ||
      ![scope.targetEncryptionFingerprint, scope.targetSigningFingerprint].every(
        (v) => typeof v === 'string' && digestPattern.test(v)
      )
    )
      fail();
  } else if (
    scope.purpose !== 'org' ||
    ['operationId', 'executionId', 'targetDeviceId', 'targetEncryptionFingerprint', 'targetSigningFingerprint'].some(
      (k) => k in scope
    )
  )
    fail();
}
function derive(privateKey: KeyObject, recipient: Buffer, salt: Buffer, purpose: Scope['purpose']): Buffer {
  if (privateKey.asymmetricKeyType !== 'x25519') return fail();
  const shared = diffieHellman({ privateKey, publicKey: publicKey(recipient, 'x25519') });
  try {
    if (shared.every((n) => n === 0)) return fail();
    return Buffer.from(hkdfSync('sha256', shared, salt, `zsl-org-escrow-${purpose}-v1`, 32));
  } finally {
    shared.fill(0);
  }
}
export function seal(umk: Buffer, recipient: Buffer, scope: Scope): Envelope {
  validateScope(scope);
  if (umk.length !== 32 || recipient.length !== 32) return fail();
  const ephemeral = generateKeyPairSync('x25519');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(ephemeral.privateKey, recipient, salt, scope.purpose);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(canonical(scope)));
    const ciphertext = Buffer.concat([cipher.update(umk), cipher.final()]);
    return {
      version: 1,
      algorithm: ALGORITHM,
      ephemeralPublicKey: ephemeral.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
      salt: salt.toString('base64url'),
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  } finally {
    key.fill(0);
  }
}
export function open(privateKey: KeyObject, envelope: Envelope, scope: Scope): Buffer {
  validateScope(scope);
  exactFields(envelope, ['version', 'algorithm', 'ephemeralPublicKey', 'salt', 'iv', 'tag', 'ciphertext']);
  if (envelope.version !== 1 || envelope.algorithm !== ALGORITHM) return fail();
  const key = derive(privateKey, decode(envelope.ephemeralPublicKey, 32), decode(envelope.salt, 16), scope.purpose);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
    decipher.setAAD(Buffer.from(canonical(scope)));
    decipher.setAuthTag(decode(envelope.tag, 16));
    return Buffer.concat([decipher.update(decode(envelope.ciphertext, 32)), decipher.final()]);
  } finally {
    key.fill(0);
  }
}
export function verifyManifest(
  signed: SignedManifest,
  anchor: Buffer,
  tenantId: string,
  minimumVersion: number
): Manifest {
  exactFields(signed, ['manifest', 'signature']);
  const m = signed.manifest;
  exactFields(m, [
    'protocolVersion',
    'tenantId',
    'orgKeyVersion',
    'keyId',
    'algorithm',
    'encryptionPublicKey',
    'signingPublicKey',
    'encryptionFingerprint',
    'signingFingerprint',
    'issuedAt',
  ]);
  if (
    m.protocolVersion !== 1 ||
    m.tenantId !== tenantId ||
    !uuidPattern.test(tenantId) ||
    !Number.isSafeInteger(m.orgKeyVersion) ||
    m.orgKeyVersion < Math.max(1, minimumVersion) ||
    m.algorithm !== ALGORITHM ||
    !m.keyId ||
    m.keyId.length > 128 ||
    hash(decode(m.encryptionPublicKey, 32)) !== m.encryptionFingerprint ||
    hash(decode(m.signingPublicKey, 32)) !== m.signingFingerprint ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.issuedAt) ||
    !Number.isFinite(Date.parse(m.issuedAt))
  )
    return fail();
  verifyStatement(anchor, 'manifest', m, signed.signature);
  return m;
}
export function importPrivate(value: string): KeyObject {
  return createPrivateKey({ key: decode(value, -1), format: 'der', type: 'pkcs8' });
}

/** Reject ambiguous JSON before JSON.parse can discard duplicate fields. */
export function parseStrictJSON(raw: string): unknown {
  if (Buffer.byteLength(raw) > 1048576) return fail();
  let at = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(raw[at] ?? '!')) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === '\\') {
        at += 2;
        continue;
      }
      if (raw[at++] === '"') {
        const value = JSON.parse(raw.slice(start, at)) as string;
        canonical(value);
        return value;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return fail();
    ws();
    const char = raw[at];
    if (char === '"') return string();
    if (char === '{') {
      at++;
      ws();
      const out: Record<string, unknown> = {};
      const keys = new Set<string>();
      if (raw[at] === '}') {
        at++;
        return out;
      }
      while (at < raw.length) {
        ws();
        if (raw[at] !== '"') return fail();
        const key = string();
        if (keys.has(key)) return fail();
        keys.add(key);
        ws();
        if (raw[at++] !== ':') return fail();
        Object.defineProperty(out, key, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        ws();
        const next = raw[at++];
        if (next === '}') return out;
        if (next !== ',') return fail();
      }
      return fail();
    }
    if (char === '[') {
      at++;
      ws();
      const out: unknown[] = [];
      if (raw[at] === ']') {
        at++;
        return out;
      }
      while (at < raw.length) {
        out.push(value(depth + 1));
        ws();
        const next = raw[at++];
        if (next === ']') return out;
        if (next !== ',') return fail();
      }
      return fail();
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const)
      if (raw.startsWith(token, at)) {
        at += token.length;
        return result;
      }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(raw.slice(at));
    if (!match) return fail();
    at += match[0].length;
    const n = Number(match[0]);
    if (!Number.isSafeInteger(n)) return fail();
    return n;
  };
  const parsed = value(0);
  ws();
  if (at !== raw.length) return fail();
  return parsed;
}

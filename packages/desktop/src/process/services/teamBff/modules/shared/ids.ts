const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function encode(value: bigint, length: number): string {
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD[Number(value & 31n)] + output;
    value >>= 5n;
  }
  return output;
}

export function newUlid(now = Date.now()): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return ulidFromEntropy(now, bytes);
}

export function ulidFromEntropy(now: number, bytes: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new Error('ULID_TIMESTAMP_INVALID');
  if (bytes.byteLength !== 10) throw new Error('ULID_ENTROPY_INVALID');
  let randomness = 0n;
  for (const byte of bytes) randomness = (randomness << 8n) | BigInt(byte);
  return `${encode(BigInt(now), 10)}${encode(randomness, 16)}`;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

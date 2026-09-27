import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCipheriv, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  bindPersonalSyncScope,
  clearPersonalSyncScope,
  getSecret,
  setSecret,
  unlockSecretVault,
} from '@/process/services/teamBff/modules/personalSync/secretVault';
import { loadOrCreateDeviceIdentity } from '@/process/services/teamBff/modules/personalSync/crypto';
import type { PersonalSyncHttp } from '@/process/services/teamBff/modules/personalSync/http';
import { writePending } from '@/process/services/teamBff/modules/orgescrow/trust';
import { EscrowClient } from '@/process/services/teamBff/modules/orgescrow/client';
import {
  ALGORITHM,
  canonical,
  decode,
  hash,
  open,
  seal,
  signStatement,
  verifyStatement,
  parseStrictJSON,
  type Scope,
  type SignedResult,
  type SignedManifest,
} from '@/process/services/teamBff/modules/orgescrow/protocol';
import { createRecoveryPackage, recoverySigningKey } from '@/process/services/teamBff/modules/orgescrow/recovery';
import { newUlid } from '@/process/services/teamBff/modules/shared/ids';

const tenantId = '00000000-0000-4000-8000-000000000001',
  memberId = '00000000-0000-4000-8000-000000000002';
const identity = {
  baseUrl: 'https://team.example.com',
  tenantId,
  tenantMemberId: memberId,
  userId: '00000000-0000-4000-8000-000000000003',
  deviceId: '00000000-0000-4000-8000-000000000004',
};
const digest = 'sha256:' + hash('stable root');
const b64hash = (value: unknown) => Buffer.from(hash(canonical(value)), 'hex').toString('base64url');
function rawKey(key: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}
describe('Escrow main-process recovery orchestration', () => {
  let runtime: AccountRuntimeManager;
  let directory: string;
  let oldAnchor: string | undefined;
  beforeEach(async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'escrow-client-'));
    runtime = new AccountRuntimeManager(directory);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId, tenantMemberId: memberId, activeTeamId: null });
    unlockSecretVault(randomBytes(32).toString('base64url'));
    bindPersonalSyncScope(identity);
    oldAnchor = process.env.AION_ESCROW_TRUST_ANCHORS_FILE;
  });
  afterEach(async () => {
    clearPersonalSyncScope();
    await runtime.deactivate();
    rmSync(directory, { recursive: true, force: true });
    if (oldAnchor === undefined) delete process.env.AION_ESCROW_TRUST_ANCHORS_FILE;
    else process.env.AION_ESCROW_TRUST_ANCHORS_FILE = oldAnchor;
  });
  it('keeps the initial code in the encrypted vault until saved and never returns it again after acknowledgement', () => {
    writePending(identity, 'initial-code', 'initial-code');
    const client = new EscrowClient(
      {
        signal: () => new AbortController().signal,
        request: async () => {
          throw new Error('No network expected');
        },
      },
      identity
    );
    expect(client.recoveryCode()).toEqual({ recoveryCode: 'initial-code' });
    client.acknowledgeRecoveryCode();
    expect(() => client.recoveryCode()).toThrow('REKEY_RESULT_NOT_READY');
  });
  it('does not expose or acknowledge a new code before data restore is verified', () => {
    writePending(identity, 'recovery', { recoveryCode: 'new-code', stage: 'restoring' });
    const client = new EscrowClient(
      {
        signal: () => new AbortController().signal,
        request: async () => {
          throw new Error('No network expected');
        },
      },
      identity
    );
    expect(() => client.recoveryCode()).toThrow('REKEY_RESULT_NOT_READY');
    expect(() => client.acknowledgeRecoveryCode()).toThrow('REKEY_RESTORE_INCOMPLETE');
  });
  it('resumes a lost finish response, rejects event gaps and restores historical-key data without a Team or push', async () => {
    const anchor = generateKeyPairSync('ed25519'),
      orgX = generateKeyPairSync('x25519'),
      orgEd = generateKeyPairSync('ed25519');
    const x = rawKey(orgX.publicKey),
      ed = rawKey(orgEd.publicKey);
    const manifest = {
      protocolVersion: 1 as const,
      tenantId,
      orgKeyVersion: 1,
      keyId: 'fixture',
      algorithm: ALGORITHM,
      encryptionPublicKey: x.toString('base64url'),
      signingPublicKey: ed.toString('base64url'),
      encryptionFingerprint: hash(x),
      signingFingerprint: hash(ed),
      issuedAt: '2026-09-22T00:00:00Z',
    };
    const signed: SignedManifest = { manifest, signature: signStatement(anchor.privateKey, 'manifest', manifest) };
    const anchorFile = path.join(directory, 'public-anchors.json');
    writeFileSync(
      anchorFile,
      JSON.stringify({ [identity.baseUrl]: { [tenantId]: rawKey(anchor.publicKey).toString('base64url') } }),
      { mode: 0o600 }
    );
    process.env.AION_ESCROW_TRUST_ANCHORS_FILE = anchorFile;
    const keys = new Map([
      [1, randomBytes(32)],
      [2, randomBytes(32)],
    ]);
    const sources = [...keys].map(([version, key]) => {
      const scope: Scope = {
        protocolVersion: 1,
        purpose: 'org',
        tenantId,
        tenantMemberId: memberId,
        memberKeyVersion: version,
        orgKeyVersion: 1,
        encryptionFingerprint: hash(x),
        signingFingerprint: hash(ed),
        rootKeysetDigest: digest,
      };
      const envelope = seal(key, x, scope);
      return { scope, envelope, envelopeHash: hash(canonical(envelope)) };
    });
    const policy = {
      tenantId,
      tenantMemberId: memberId,
      state: 'enrolling',
      version: 3,
      disclosureVersion: 1,
      activeOrgKeyVersion: 1,
      rootVersion: 2,
      recoveryEpoch: 1,
      tenantRecoveryEpoch: 1,
      requiredKeyVersions: [1, 2],
      coverage: 'verified',
      notificationReady: true,
      keys: [{ signedManifest: signed, status: 'current' }],
    };
    const device = loadOrCreateDeviceIdentity();
    const operationId = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    let statement: Record<string, unknown> = {};
    let result: SignedResult;
    let status = 'challenged';
    let finishCount = 0;
    let gap = true;
    const calls: string[] = [];
    const eventId = newUlid(),
      entityId = newUlid();
    const now = Date.now();
    const payload = {
      id: entityId,
      category: 'fact',
      title: 'restored historical memory',
      content: 'only encrypted in transit',
      source: 'manual',
      scope: 'chat',
      pinned: false,
      tenantId,
      tenantMemberId: memberId,
      contextTeamId: null,
      version: 1,
      hlc: `${now}:000001`,
      deletedAt: null,
      importance: 0.5,
      forgetAfter: null,
      createdAt: now,
      updatedAt: now,
    };
    const event = {
      eventId,
      originDeviceId: randomUUID(),
      entityType: 'personalMemory',
      entityId,
      operation: 'upsert',
      baseVersion: 0,
      entityVersion: 1,
      parentEventId: null,
      hlc: payload.hlc,
      keyVersion: 2,
      idempotencyKey: randomUUID(),
    };
    const aad = Buffer.from(JSON.stringify({ tenantId, tenantMemberId: memberId, ...event }));
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keys.get(2)!, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64url');
    const http: PersonalSyncHttp = {
      base: new URL(identity.baseUrl),
      fetcher: fetch,
      signal: () => runtime.signal(),
      request: async (route, init = {}) => {
        calls.push(route);
        const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        let data: unknown;
        if (route.endsWith('/org-escrow')) data = policy;
        else if (route.endsWith('/rekey-challenges')) {
          statement = {
            protocolVersion: 1,
            operationId,
            tenantId,
            tenantMemberId: memberId,
            deviceId: identity.deviceId,
            idempotencyKey: body.idempotencyKey,
            encryptionFingerprint: hash(device.x25519PublicRaw),
            signingFingerprint: hash(device.ed25519PublicRaw),
            policyVersion: 3,
            rootVersion: 2,
            recoveryEpoch: 1,
            tenantRecoveryEpoch: 1,
            credentialVersion: 1,
            credentialCounter: 1,
            rootKeysetDigest: digest,
            requiredKeyVersions: [1, 2],
            sources,
            challengeHash: hash(decode(nonce, 32)),
            challengeExpiresAt: new Date(Date.now() + 600000).toISOString(),
          };
          data = { statement, challenge: nonce, displayCode: String(statement.challengeHash).slice(0, 8) };
        } else if (route.endsWith('/rekey-requests')) {
          verifyStatement(device.ed25519PublicRaw, 'request', statement, String(body.signature));
          status = 'result_ready';
          data = { id: operationId, status, version: 4 };
          const executionId = randomUUID();
          const envelopes = sources.map((src) => {
            const umk = open(orgX.privateKey, src.envelope, src.scope);
            const scope: Scope = {
              ...src.scope,
              purpose: 'result',
              operationId,
              executionId,
              targetDeviceId: identity.deviceId,
              targetEncryptionFingerprint: hash(device.x25519PublicRaw),
              targetSigningFingerprint: hash(device.ed25519PublicRaw),
            };
            const envelope = seal(umk, device.x25519PublicRaw, scope);
            umk.fill(0);
            return {
              memberKeyVersion: scope.memberKeyVersion,
              scope,
              envelope,
              envelopeHash: hash(canonical(envelope)),
            };
          });
          const resultStatement = {
            protocolVersion: 1 as const,
            operationId,
            executionId,
            purpose: 'recovery' as const,
            tenantId,
            tenantMemberId: memberId,
            targetDeviceId: identity.deviceId,
            targetEncryptionFingerprint: hash(device.x25519PublicRaw),
            targetSigningFingerprint: hash(device.ed25519PublicRaw),
            keyId: 'fixture',
            orgKeyVersion: 1,
            policyVersion: 3,
            rootVersion: 2,
            recoveryEpoch: 1,
            tenantRecoveryEpoch: 1,
            operationHash: hash(canonical(statement)),
            resultExpiresAt: new Date(Date.now() + 86400000).toISOString(),
            envelopes,
          };
          result = {
            statement: resultStatement,
            signature: signStatement(orgEd.privateKey, 'result', resultStatement),
          };
        } else if (route.endsWith('/key-envelopes'))
          data = {
            keysetDigest: digest,
            currentKeyVersion: 1,
            envelopes: result.statement.envelopes.map((e) => ({
              keyVersion: e.memberKeyVersion,
              wrappedKey: Buffer.from(JSON.stringify({ version: 2, scope: e.scope, envelope: e.envelope })).toString(
                'base64url'
              ),
            })),
          };
        else if (route.endsWith('/device-proof-challenges'))
          data = {
            tenantId,
            tenantMemberId: memberId,
            deviceId: identity.deviceId,
            operationId,
            operationHash: b64hash(statement),
            purpose: body.purpose,
            nonce: randomBytes(32).toString('base64url'),
            expiresAt: new Date(Date.now() + 300000).toISOString(),
          };
        else if (route.endsWith(':result')) data = result;
        else if (route.endsWith(':finish')) {
          finishCount++;
          const st = body.statement as Record<string, unknown>;
          verifyStatement(device.ed25519PublicRaw, 'finish', st, String(body.deviceSignature));
          verifyStatement(decode(String(st.recoveryPublicKey), 32), 'finish', st, String(body.recoverySignature));
          status = 'completed';
          throw new Error('SIMULATED_RESPONSE_LOST');
        } else if (route.endsWith(operationId)) data = { id: operationId, status, version: 5, statement };
        else if (route.includes('/events?')) {
          const after = Number(new URL('https://test' + route).searchParams.get('after'));
          data = {
            events: after
              ? []
              : [
                  {
                    ...event,
                    nonce: iv.toString('base64url'),
                    ciphertext,
                    aadHash: Buffer.from(hash(aad), 'hex').toString('base64url'),
                    serverSeq: gap ? 2 : 1,
                  },
                ],
            currentCursor: gap ? 2 : 1,
            hasMore: false,
          };
        } else if (route.endsWith('/cursors:ack')) data = { cursor: body.cursor };
        else if (route.endsWith(':restore')) {
          verifyStatement(
            device.ed25519PublicRaw,
            'ack',
            { cursor: body.cursor, proof: body.proof },
            String(body.signature)
          );
          data = { verified: true };
        } else throw new Error('UNEXPECTED_REQUEST ' + route);
        return { status: 200, data: data as Record<string, unknown> };
      },
    };
    const first = new EscrowClient(http, identity);
    await first.requestRecovery();
    await expect(first.resumeRecovery()).rejects.toThrow('SIMULATED_RESPONSE_LOST');
    expect(getSecret('personal-sync:org-restoring')).toBe(operationId);
    const restarted = new EscrowClient(http, identity);
    await expect(restarted.resumeRecovery()).rejects.toThrow('PERSONAL_SYNC_SEQUENCE_GAP');
    expect(finishCount).toBe(1);
    gap = false;
    await expect(restarted.resumeRecovery()).resolves.toMatchObject({ status: 'verified', applied: 1, cursor: 1 });
    expect(getSecret('personal-sync:org-restoring')).toBe('');
    expect(getSecret('personal-sync:umk:v1')).toBe(keys.get(1)!.toString('base64url'));
    expect(getSecret('personal-sync:umk:v2')).toBe(keys.get(2)!.toString('base64url'));
    const rows = await runtime
      .database('memory')
      .execute({ sql: 'SELECT title FROM memories WHERE id=?', args: [entityId] });
    expect(rows.rows[0]?.title).toBe(payload.title);
    expect(calls.some((p) => p.endsWith('events:push'))).toBe(false);
    expect(JSON.stringify(await restarted.view())).not.toContain(restarted.recoveryCode().recoveryCode);
    expect(JSON.stringify(await restarted.view())).not.toContain('sources');
    expect(restarted.recoveryCode().recoveryCode).toHaveLength(43);
    restarted.acknowledgeRecoveryCode();
    expect(() => restarted.recoveryCode()).toThrow();
  });
  it('rejects duplicate JSON keys, unsafe counters, invalid Unicode and cross-origin vault reuse', () => {
    for (const raw of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '{"n":9007199254740992}',
      '{"x":"\\ud800"}',
      '{"n":1e2}',
    ])
      expect(() => parseStrictJSON(raw)).toThrow();
    expect(parseStrictJSON('{"x":"a\\\\b", "n":2}')).toEqual({ x: 'a\\b', n: 2 });
    setSecret('personal-sync:umk:v1', 'secret-test');
    bindPersonalSyncScope({ ...identity, baseUrl: 'https://other.example.com' });
    expect(getSecret('personal-sync:umk:v1')).toBe('');
    bindPersonalSyncScope(identity);
    expect(getSecret('personal-sync:umk:v1')).toBe('secret-test');
  });
  it('keeps all historical keys in the replacement recovery package and renews its signing proof', () => {
    const replacement = createRecoveryPackage(
      new Map([
        [1, randomBytes(32)],
        [4, randomBytes(32)],
      ])
    );
    const signer = recoverySigningKey(
      replacement.recoveryCode,
      replacement.recoveryKdf,
      replacement.encryptedRecoveryPackage
    );
    const statement = { operationId: randomUUID() };
    expect(() =>
      verifyStatement(
        decode(replacement.recoveryPublicKey, 32),
        'finish',
        statement,
        signStatement(signer, 'finish', statement)
      )
    ).not.toThrow();
    expect(() =>
      recoverySigningKey(
        randomBytes(32).toString('base64url'),
        replacement.recoveryKdf,
        replacement.encryptedRecoveryPackage
      )
    ).toThrow();
  });
});

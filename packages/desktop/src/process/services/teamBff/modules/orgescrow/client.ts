import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PersonalSyncHttp } from '../personalSync/http';
import { createPersonalSyncTransport } from '../personalSync/transport';
import { PersonalSyncAdminClient } from '../personalSync/adminClient';
import {
  loadOrCreateDeviceIdentity,
  openPersonalSyncDeviceEnvelope,
  createPersonalSyncInitialization,
  createPersonalSyncInitializationV2,
  confirmPersonalSyncInitialization,
  storedKeysetDigest,
} from '../personalSync/crypto';
import { getSecret, setSecret } from '../personalSync/secretVault';
import { pullPersonalSyncInbox } from '../personalSync/store';
import {
  canonical,
  hash,
  decode,
  seal,
  parseStrictJSON,
  verifyManifest,
  signStatement,
  type SignedManifest,
  type SignedResult,
  type Scope,
  type Envelope,
} from './protocol';
import {
  compareEnrollmentKeys,
  createRecoveryPackage,
  recoverySigningKey,
  verifyAndOpenResult,
  signProof,
  type ProofStatement,
  type ExpectedResult,
} from './recovery';
import { deploymentAnchor, readPending, writePending, type EscrowIdentity } from './trust';

type Source = { scope: Scope; envelope: Envelope; envelopeHash: string };
type EnrollmentStatement = {
  protocolVersion: 1;
  tenantId: string;
  tenantMemberId: string;
  deviceId: string;
  idempotencyKey: string;
  policyVersion: number;
  disclosureVersion: number;
  orgKeyVersion: number;
  rootKeysetDigest: string;
  consent: true;
  envelopes: Source[];
};
type EnrollmentInput = { statement: EnrollmentStatement; signature: string };
type Policy = {
  tenantId: string;
  tenantMemberId: string;
  state: string;
  version: number;
  disclosureVersion: number;
  activeOrgKeyVersion: number | null;
  rootVersion: number;
  recoveryEpoch: number;
  tenantRecoveryEpoch: number;
  requiredKeyVersions: number[];
  coverage: string;
  notificationReady: boolean;
  keys: { signedManifest: SignedManifest; status: string }[];
};
type RecoveryStatement = {
  protocolVersion: 1;
  operationId: string;
  tenantId: string;
  tenantMemberId: string;
  deviceId: string;
  idempotencyKey: string;
  encryptionFingerprint: string;
  signingFingerprint: string;
  policyVersion: number;
  rootVersion: number;
  recoveryEpoch: number;
  tenantRecoveryEpoch: number;
  credentialVersion: number;
  credentialCounter: number;
  rootKeysetDigest: string;
  requiredKeyVersions: number[];
  sources: Source[];
  challengeHash: string;
  challengeExpiresAt: string;
};
type Challenge = { statement: RecoveryStatement; challenge: string; displayCode: string };
type Status = { id: string; status: string; version: number; errorCode?: string; resultHash?: string };
type FinishStatement = {
  protocolVersion: 1;
  operationId: string;
  tenantId: string;
  tenantMemberId: string;
  deviceId: string;
  resultHash: string;
  oldCounter: number;
  newCounter: number;
  rootKeysetDigest: string;
  recoveryPublicKey: string;
  recoveryFingerprint: string;
  recoveryKdf: ReturnType<typeof createRecoveryPackage>['recoveryKdf'];
  encryptedRecoveryPackage: string;
  recoveryPackageHash: string;
  requiredKeyVersions: number[];
  proof: ProofStatement;
};
type Finish = {
  statement: FinishStatement;
  deviceSignature: string;
  recoverySignature: string;
  proofSignature: string;
};
type PendingRecovery = {
  idempotencyKey: string;
  challenge?: Challenge;
  finish?: Finish;
  recoveryCode?: string;
  stage?: string;
};
const b64hash = (v: unknown) => Buffer.from(hash(canonical(v)), 'hex').toString('base64url');
const safeStatus = ({ id, status, version, errorCode, resultHash }: Status): Status => ({
  id,
  status,
  version,
  errorCode,
  resultHash,
});
const clearKeys = (keys: Map<number, Buffer>) => {
  for (const key of keys.values()) key.fill(0);
};
/** Main-process orchestration. Only the safe view returned by view() reaches UI. */
export class EscrowClient {
  constructor(
    private readonly http: PersonalSyncHttp,
    readonly identity: EscrowIdentity
  ) {}
  private assertActive() {
    if (this.http.signal().aborted) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    this.assertActive();
    const result = await this.http.request(
      '/api/v1/' + path,
      body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    this.assertActive();
    return result.data as T;
  }
  async policy(): Promise<Policy> {
    const p = await this.request<Policy>('personal-sync/org-escrow');
    if (p.tenantId !== this.identity.tenantId || p.tenantMemberId !== this.identity.tenantMemberId)
      throw new Error('ESCROW_CACHE_SCOPE_INVALID');
    return p;
  }
  private manifests(p: Policy) {
    const anchor = deploymentAnchor(this.identity);
    const known = readPending<number>(this.identity, 'highest-key-version') ?? 1;
    for (const k of p.keys) verifyManifest(k.signedManifest, anchor, this.identity.tenantId, 1);
    if (p.activeOrgKeyVersion === null || p.activeOrgKeyVersion < known)
      throw new Error('ESCROW_TRUST_ANCHOR_MISMATCH');
    const active = p.keys.find(
      (k) => k.status === 'current' && k.signedManifest.manifest.orgKeyVersion === p.activeOrgKeyVersion
    );
    if (!active) throw new Error('ESCROW_KEY_UNAVAILABLE');
    verifyManifest(active.signedManifest, anchor, this.identity.tenantId, known);
    writePending(this.identity, 'highest-key-version', p.activeOrgKeyVersion);
    return {
      anchor,
      all: p.keys.filter((k) => ['current', 'decrypt_only'].includes(k.status)).map((k) => k.signedManifest),
      current: active.signedManifest.manifest,
    };
  }
  async view() {
    const p = await this.policy();
    const pending = readPending<PendingRecovery>(this.identity, 'recovery');
    const enrollment = readPending<{ input: EnrollmentInput; id?: string }>(this.identity, 'enrollment');
    let recovery: Status | null = null;
    let registration: Status | null = null;
    if (pending?.challenge)
      recovery = await this.request<Status>('personal-sync/rekey-requests/' + pending.challenge.statement.operationId);
    if (enrollment && !enrollment.id) registration = { id: '', status: 'readback_pending', version: 0 };
    if (enrollment?.id) registration = await this.request<Status>('personal-sync/escrow-enrollments/' + enrollment.id);
    return {
      state: p.state,
      version: p.version,
      disclosureVersion: p.disclosureVersion,
      coverage: p.coverage,
      notificationReady: p.notificationReady,
      recovery: recovery ? safeStatus(recovery) : null,
      registration: registration ? safeStatus(registration) : null,
      stage: pending?.stage ?? null,
      displayCode: pending?.challenge?.displayCode ?? null,
      hasRecoveryCode: !!pending?.recoveryCode || !!readPending<string>(this.identity, 'initial-code'),
      codeReady: pending?.recoveryCode
        ? pending.stage === 'verified'
        : !!readPending<string>(this.identity, 'initial-code'),
    };
  }
  async loadKeyring(): Promise<{ keys: Map<number, Buffer>; digest: string }> {
    const response = await this.request<{
      keysetDigest: string;
      currentKeyVersion?: number;
      envelopes: { keyVersion: number; wrappedKey: string }[];
    }>('personal-sync/key-envelopes');
    if (
      !/^sha256:[0-9a-f]{64}$/.test(response.keysetDigest) ||
      response.envelopes.length < 1 ||
      response.envelopes.length > 100
    )
      throw new Error('ESCROW_COVERAGE_INCOMPLETE');
    const keys = new Map<number, Buffer>();
    const device = loadOrCreateDeviceIdentity();
    try {
      for (const item of response.envelopes) {
        if (!Number.isSafeInteger(item.keyVersion) || item.keyVersion < 1 || keys.has(item.keyVersion))
          throw new Error('ESCROW_COVERAGE_INCOMPLETE');
        const wire = parseStrictJSON(Buffer.from(item.wrappedKey, 'base64url').toString('utf8')) as {
          version: number;
          scope?: Scope;
        };
        if (wire.version === 2) {
          const scope = wire.scope;
          if (
            !scope ||
            scope.purpose !== 'result' ||
            scope.tenantId !== this.identity.tenantId ||
            scope.tenantMemberId !== this.identity.tenantMemberId ||
            scope.targetDeviceId !== this.identity.deviceId ||
            scope.memberKeyVersion !== item.keyVersion ||
            scope.rootKeysetDigest !== response.keysetDigest ||
            scope.targetEncryptionFingerprint !== hash(device.x25519PublicRaw) ||
            scope.targetSigningFingerprint !== hash(device.ed25519PublicRaw)
          )
            throw new Error('ESCROW_ENVELOPE_INVALID');
        }
        const key = openPersonalSyncDeviceEnvelope(item.wrappedKey, device.x25519Private);
        const local = getSecret(`personal-sync:umk:v${item.keyVersion}`);
        if (local && !timingSafeEqual(decode(local, 32), key)) throw new Error('ESCROW_SELF_CHECK_FAILED');
        keys.set(item.keyVersion, key);
      }
      for (const [v, key] of keys) setSecret(`personal-sync:umk:v${v}`, key.toString('base64url'));
      if (response.currentKeyVersion !== undefined) {
        if (!keys.has(response.currentKeyVersion)) throw new Error('ESCROW_COVERAGE_INCOMPLETE');
        setSecret('personal-sync:current-key-version', String(response.currentKeyVersion));
      }
      setSecret('personal-sync:keyset-digest', response.keysetDigest);
      return { keys, digest: response.keysetDigest };
    } catch (e) {
      clearKeys(keys);
      throw e;
    }
  }
  private enrollment(p: Policy, keys: Map<number, Buffer>, digest: string): EnrollmentInput {
    const saved = readPending<{ input: EnrollmentInput; id?: string }>(this.identity, 'enrollment');
    if (saved) {
      if (saved.input.statement.policyVersion !== p.version) throw new Error('ESCROW_POLICY_CHANGED');
      return saved.input;
    }
    const { current } = this.manifests(p);
    const envelopes = [...keys]
      .sort(([a], [b]) => a - b)
      .map(([version, key]) => {
        const scope: Scope = {
          protocolVersion: 1,
          purpose: 'org',
          tenantId: this.identity.tenantId,
          tenantMemberId: this.identity.tenantMemberId,
          memberKeyVersion: version,
          orgKeyVersion: current.orgKeyVersion,
          encryptionFingerprint: current.encryptionFingerprint,
          signingFingerprint: current.signingFingerprint,
          rootKeysetDigest: digest,
        };
        const envelope = seal(key, decode(current.encryptionPublicKey, 32), scope);
        return { scope, envelope, envelopeHash: hash(canonical(envelope)) };
      });
    const statement: EnrollmentStatement = {
      protocolVersion: 1,
      tenantId: this.identity.tenantId,
      tenantMemberId: this.identity.tenantMemberId,
      deviceId: this.identity.deviceId,
      idempotencyKey: randomUUID(),
      policyVersion: p.version,
      disclosureVersion: p.disclosureVersion,
      orgKeyVersion: current.orgKeyVersion,
      rootKeysetDigest: digest,
      consent: true,
      envelopes,
    };
    const input = {
      statement,
      signature: signStatement(loadOrCreateDeviceIdentity().ed25519Private, 'enroll', statement),
    };
    writePending(this.identity, 'enrollment', { input });
    return input;
  }
  async initialize(consent: boolean) {
    const p = await this.policy();
    if (p.state === 'suspended') throw new Error('ESCROW_SUSPENDED');
    if (p.state !== 'disabled' && !consent) throw new Error('ESCROW_CONSENT_REQUIRED');
    let input: EnrollmentInput | null = null;
    if (p.state !== 'disabled') {
      const base = createPersonalSyncInitialization();
      const key = decode(getSecret('personal-sync:umk:v1'), 32);
      try {
        input = this.enrollment(p, new Map([[1, key]]), base.request.keysetDigest);
      } finally {
        key.fill(0);
      }
      setSecret('personal-sync:org-verification-pending', 'true');
    }
    const { request, recoveryCode } = createPersonalSyncInitializationV2(input);
    const response = await new PersonalSyncAdminClient(this.http).initialize(request);
    writePending(this.identity, 'initial-code', recoveryCode);
    confirmPersonalSyncInitialization(response.keysetDigest);
    // The same enrollment is already inserted atomically by init-v2; this is an idempotent read-back.
    if (input) {
      const registration = await this.request<Status>('personal-sync/escrow-enrollments', input);
      writePending(this.identity, 'enrollment', { input, id: registration.id });
    }
    return { recoveryCode, keysetDigest: response.keysetDigest, replayed: response.replayed };
  }
  async enroll(consent: boolean) {
    const previous = readPending<{ input: EnrollmentInput; id?: string }>(this.identity, 'enrollment');
    if (previous?.id) {
      const status = await this.request<Status>('personal-sync/escrow-enrollments/' + previous.id);
      if (['failed', 'expired', 'cancelled', 'verified'].includes(status.status))
        writePending(this.identity, 'enrollment', null);
    }
    if (!consent) throw new Error('ESCROW_CONSENT_REQUIRED');
    const p = await this.policy();
    const { keys, digest } = await this.loadKeyring();
    try {
      const input = this.enrollment(p, keys, digest);
      const response = await this.request<Status>('personal-sync/escrow-enrollments', input);
      writePending(this.identity, 'enrollment', { input, id: response.id });
      return response;
    } finally {
      clearKeys(keys);
    }
  }
  private async proof(id: string, purpose: string, operationHash: string) {
    const proof = await this.request<ProofStatement>('personal-sync/device-proof-challenges', {
      operationId: id,
      purpose,
    });
    return signProof(proof, loadOrCreateDeviceIdentity().ed25519Private, {
      tenantId: this.identity.tenantId,
      memberId: this.identity.tenantMemberId,
      deviceId: this.identity.deviceId,
      operationId: id,
      purpose,
      operationHash,
    });
  }
  async confirmEnrollment() {
    const saved = readPending<{ input: EnrollmentInput; id?: string }>(this.identity, 'enrollment');
    if (saved && !saved.id) {
      const registration = await this.request<Status>('personal-sync/escrow-enrollments', saved.input);
      saved.id = registration.id;
      writePending(this.identity, 'enrollment', saved);
    }
    if (!saved?.id) throw new Error('ESCROW_VERIFICATION_REQUIRED');
    const state = await this.request<Status>('personal-sync/escrow-enrollments/' + saved.id);
    if (state.status === 'verified') {
      setSecret('personal-sync:org-verification-pending', '');
      writePending(this.identity, 'enrollment', null);
      return state;
    }
    const p = await this.policy();
    const manifests = this.manifests(p);
    const proof = await this.proof(saved.id, 'enrollment-result', b64hash(saved.input.statement));
    const result = await this.request<SignedResult>(`personal-sync/escrow-enrollments/${saved.id}:result`, proof);
    const device = loadOrCreateDeviceIdentity();
    const st = saved.input.statement;
    const expected: ExpectedResult = {
      protocolVersion: 1,
      operationId: saved.id,
      purpose: 'enrollment',
      tenantId: this.identity.tenantId,
      tenantMemberId: this.identity.tenantMemberId,
      targetDeviceId: this.identity.deviceId,
      targetEncryptionFingerprint: hash(device.x25519PublicRaw),
      targetSigningFingerprint: hash(device.ed25519PublicRaw),
      keyId: manifests.current.keyId,
      orgKeyVersion: st.orgKeyVersion,
      policyVersion: st.policyVersion,
      rootVersion: p.rootVersion,
      recoveryEpoch: p.recoveryEpoch,
      tenantRecoveryEpoch: p.tenantRecoveryEpoch,
      operationHash: hash(canonical(st)),
      rootKeysetDigest: st.rootKeysetDigest,
      requiredKeyVersions: st.envelopes.map((e) => e.scope.memberKeyVersion),
    };
    const recovered = verifyAndOpenResult(result, expected, manifests.all, manifests.anchor, device.x25519Private);
    const { keys } = await this.loadKeyring();
    try {
      compareEnrollmentKeys(recovered, keys);
      // Authenticate a known scoped ciphertext with every returned UMK.
      for (const [version, key] of keys) {
        const nonce = randomBytes(12);
        const plain = Buffer.from(
          canonical({ tenantId: this.identity.tenantId, memberId: this.identity.tenantMemberId, version })
        );
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
        const decipher = createDecipheriv('aes-256-gcm', recovered.get(version)!, nonce);
        decipher.setAuthTag(cipher.getAuthTag());
        const opened = Buffer.concat([decipher.update(sealed), decipher.final()]);
        if (!timingSafeEqual(opened, plain)) throw new Error('ESCROW_SELF_CHECK_FAILED');
        opened.fill(0);
      }
      const statement = {
        enrollmentId: saved.id,
        tenantId: this.identity.tenantId,
        tenantMemberId: this.identity.tenantMemberId,
        deviceId: this.identity.deviceId,
        resultHash: b64hash(result),
        manifestHash: b64hash(st),
        verifiedKeyVersions: expected.requiredKeyVersions,
        knownCipherVerified: true,
      };
      const response = await this.request<Status>(`personal-sync/escrow-enrollments/${saved.id}:confirm`, {
        statement,
        signature: signStatement(device.ed25519Private, 'ack', statement),
      });
      setSecret('personal-sync:org-verification-pending', '');
      writePending(this.identity, 'enrollment', null);
      return response;
    } finally {
      clearKeys(keys);
      clearKeys(recovered);
    }
  }
  async requestRecovery() {
    const p = await this.policy();
    const manifests = this.manifests(p);
    let saved = readPending<PendingRecovery>(this.identity, 'recovery');
    if (saved?.challenge) {
      const status = await this.request<Status>(
        'personal-sync/rekey-requests/' + saved.challenge.statement.operationId
      );
      if (['failed', 'expired', 'cancelled', 'rejected'].includes(status.status) && !saved.recoveryCode) {
        writePending(this.identity, 'recovery', null);
        saved = null;
      }
    }
    if (!saved) {
      saved = { idempotencyKey: randomUUID() };
      writePending(this.identity, 'recovery', saved);
    }
    const device = loadOrCreateDeviceIdentity();
    if (!saved.challenge) {
      const c = await this.request<Challenge>('personal-sync/rekey-challenges', {
        idempotencyKey: saved.idempotencyKey,
        encryptionPublicKey: device.x25519PublicRaw.toString('base64url'),
        signingPublicKey: device.ed25519PublicRaw.toString('base64url'),
      });
      const st = c.statement;
      if (
        st.tenantId !== this.identity.tenantId ||
        st.tenantMemberId !== this.identity.tenantMemberId ||
        st.deviceId !== this.identity.deviceId ||
        st.idempotencyKey !== saved.idempotencyKey ||
        st.policyVersion !== p.version ||
        st.encryptionFingerprint !== hash(device.x25519PublicRaw) ||
        st.signingFingerprint !== hash(device.ed25519PublicRaw) ||
        st.challengeHash !== hash(decode(c.challenge, 32)) ||
        !Number.isFinite(Date.parse(st.challengeExpiresAt)) ||
        Date.parse(st.challengeExpiresAt) <= Date.now() ||
        st.sources.length !== st.requiredKeyVersions.length ||
        st.sources.length < 1 ||
        st.sources.length > 100
      )
        throw new Error('ESCROW_ENVELOPE_INVALID');
      for (let i = 0; i < st.sources.length; i++) {
        const src = st.sources[i];
        const m = manifests.all.find((m) => m.manifest.orgKeyVersion === src.scope.orgKeyVersion)?.manifest;
        if (
          !m ||
          src.scope.tenantId !== st.tenantId ||
          src.scope.tenantMemberId !== st.tenantMemberId ||
          src.scope.rootKeysetDigest !== st.rootKeysetDigest ||
          src.scope.memberKeyVersion !== st.requiredKeyVersions[i] ||
          src.scope.encryptionFingerprint !== m.encryptionFingerprint ||
          src.scope.signingFingerprint !== m.signingFingerprint ||
          hash(canonical(src.envelope)) !== src.envelopeHash
        )
          throw new Error('ESCROW_ENVELOPE_INVALID');
      }
      c.displayCode = st.challengeHash.slice(0, 8);
      saved.challenge = c;
      saved.stage = 'awaiting_approvals';
      writePending(this.identity, 'recovery', saved);
    }
    const c = saved.challenge;
    return safeStatus(
      await this.request<Status>('personal-sync/rekey-requests', {
        operationId: c.statement.operationId,
        challenge: c.challenge,
        signature: signStatement(device.ed25519Private, 'request', c.statement),
      })
    );
  }
  async cancelRecovery() {
    const saved = readPending<PendingRecovery>(this.identity, 'recovery');
    if (!saved?.challenge) return;
    const id = saved.challenge.statement.operationId;
    const state = await this.request<Status>('personal-sync/rekey-requests/' + id);
    await this.request(`personal-sync/rekey-requests/${id}:cancel`, { expectedVersion: state.version });
    writePending(this.identity, 'recovery', null);
  }
  async resumeRecovery() {
    let saved = readPending<PendingRecovery>(this.identity, 'recovery');
    if (!saved?.challenge) throw new Error('REKEY_RESULT_NOT_READY');
    const st = saved.challenge.statement;
    const id = st.operationId;
    const status = await this.request<Status>('personal-sync/rekey-requests/' + id);
    if (saved.stage === 'verified') return { status: 'verified' };
    if (!['result_ready', 'completed'].includes(status.status)) return safeStatus(status);
    const device = loadOrCreateDeviceIdentity();
    if (status.status === 'result_ready' && !saved.finish) {
      const p = await this.policy();
      const manifests = this.manifests(p);
      const proof = await this.proof(id, 'result', b64hash(st));
      const result = await this.request<SignedResult>(`personal-sync/rekey-requests/${id}:result`, proof);
      const expected: ExpectedResult = {
        protocolVersion: 1,
        operationId: id,
        purpose: 'recovery',
        tenantId: st.tenantId,
        tenantMemberId: st.tenantMemberId,
        targetDeviceId: st.deviceId,
        targetEncryptionFingerprint: st.encryptionFingerprint,
        targetSigningFingerprint: st.signingFingerprint,
        keyId: manifests.current.keyId,
        orgKeyVersion: manifests.current.orgKeyVersion,
        policyVersion: st.policyVersion,
        rootVersion: st.rootVersion,
        recoveryEpoch: st.recoveryEpoch,
        tenantRecoveryEpoch: st.tenantRecoveryEpoch,
        operationHash: hash(canonical(st)),
        rootKeysetDigest: st.rootKeysetDigest,
        requiredKeyVersions: st.requiredKeyVersions,
      };
      const keys = verifyAndOpenResult(result, expected, manifests.all, manifests.anchor, device.x25519Private);
      try {
        const recovery = createRecoveryPackage(keys);
        const finishProof = await this.proof(id, 'finish', b64hash(st));
        const statement: FinishStatement = {
          protocolVersion: 1,
          operationId: id,
          tenantId: st.tenantId,
          tenantMemberId: st.tenantMemberId,
          deviceId: st.deviceId,
          resultHash: b64hash(result),
          oldCounter: st.credentialCounter,
          newCounter: st.credentialCounter + 1,
          rootKeysetDigest: st.rootKeysetDigest,
          recoveryPublicKey: recovery.recoveryPublicKey,
          recoveryFingerprint: recovery.recoveryFingerprint,
          recoveryKdf: recovery.recoveryKdf,
          encryptedRecoveryPackage: recovery.encryptedRecoveryPackage,
          recoveryPackageHash: recovery.recoveryPackageHash,
          requiredKeyVersions: st.requiredKeyVersions,
          proof: finishProof.statement,
        };
        saved.finish = {
          statement,
          deviceSignature: signStatement(device.ed25519Private, 'finish', statement),
          recoverySignature: signStatement(recovery.privateKey, 'finish', statement),
          proofSignature: finishProof.signature,
        };
        saved.recoveryCode = recovery.recoveryCode;
        saved.stage = 'finishing';
        writePending(this.identity, 'recovery', saved);
        setSecret('personal-sync:org-restoring', id);
        for (const [v, key] of keys) setSecret(`personal-sync:umk:v${v}`, key.toString('base64url'));
      } finally {
        clearKeys(keys);
      }
    }
    if (
      status.status === 'result_ready' &&
      saved.finish &&
      Date.parse(saved.finish.statement.proof.expiresAt) <= Date.now() + 1000
    ) {
      if (!saved.recoveryCode) throw new Error('REKEY_RECOVERY_CODE_MISSING');
      const key = recoverySigningKey(
        saved.recoveryCode,
        saved.finish.statement.recoveryKdf,
        saved.finish.statement.encryptedRecoveryPackage
      );
      const proof = await this.proof(id, 'finish', b64hash(st));
      const statement = { ...saved.finish.statement, proof: proof.statement };
      saved.finish = {
        statement,
        deviceSignature: signStatement(device.ed25519Private, 'finish', statement),
        recoverySignature: signStatement(key, 'finish', statement),
        proofSignature: proof.signature,
      };
      writePending(this.identity, 'recovery', saved);
    }
    if (status.status !== 'completed') {
      if (!saved.finish) throw new Error('REKEY_RESULT_NOT_READY');
      await this.request<Status>(`personal-sync/rekey-requests/${id}:finish`, saved.finish);
    }
    if (!saved.recoveryCode) throw new Error('REKEY_RECOVERY_CODE_MISSING');
    setSecret('personal-sync:keyset-digest', st.rootKeysetDigest);
    setSecret('personal-sync:org-restoring', id);
    saved.stage = 'restoring';
    writePending(this.identity, 'recovery', saved);
    const ring = await this.loadKeyring();
    clearKeys(ring.keys);
    const restored = await pullPersonalSyncInbox(createPersonalSyncTransport(this.http));
    const proof = await this.proof(id, 'restore', b64hash(st));
    const statement = { cursor: restored.cursor, proof: proof.statement };
    await this.request(`personal-sync/rekey-requests/${id}:restore`, {
      ...statement,
      signature: signStatement(device.ed25519Private, 'ack', statement),
      proofSignature: proof.signature,
    });
    saved.stage = 'verified';
    writePending(this.identity, 'recovery', saved);
    setSecret('personal-sync:org-restoring', '');
    return { status: 'verified', cursor: restored.cursor, applied: restored.applied };
  }
  recoveryCode() {
    const saved = readPending<PendingRecovery>(this.identity, 'recovery');
    const initial = readPending<string>(this.identity, 'initial-code');
    if (initial && !saved?.recoveryCode) return { recoveryCode: initial };
    if (!saved?.recoveryCode || saved.stage !== 'verified') throw new Error('REKEY_RESULT_NOT_READY');
    return { recoveryCode: saved.recoveryCode };
  }
  acknowledgeRecoveryCode() {
    const saved = readPending<PendingRecovery>(this.identity, 'recovery');
    if (!saved?.recoveryCode && readPending<string>(this.identity, 'initial-code')) {
      writePending(this.identity, 'initial-code', null);
      return { acknowledged: true };
    }
    if (!saved || saved.stage !== 'verified') throw new Error('REKEY_RESTORE_INCOMPLETE');
    writePending(this.identity, 'recovery', null);
    writePending(this.identity, 'initial-code', null);
    return { acknowledged: true };
  }
}

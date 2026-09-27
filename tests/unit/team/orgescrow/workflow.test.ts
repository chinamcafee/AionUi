import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EscrowClient } from '@/process/services/teamBff/modules/orgescrow/client';
import {
  advanceEscrowBackup,
  enableEscrowBackup,
  hasAutomaticBackupConsent,
} from '@/process/services/teamBff/modules/orgescrow/workflow';
const cache = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/process/services/teamBff/modules/orgescrow/trust', () => ({
  readPending: (_identity: unknown, key: string) => cache.get(key),
  writePending: (_identity: unknown, key: string, value: unknown) => cache.set(key, value),
}));
const base = {
  state: 'enrolling',
  version: 2,
  disclosureVersion: 1,
  coverage: 'missing',
  notificationReady: true,
  recovery: null,
  registration: null,
  stage: null,
  displayCode: null,
  hasRecoveryCode: false,
  codeReady: false,
};
function fixture(view: Partial<Awaited<ReturnType<EscrowClient['view']>>> = {}) {
  return {
    identity: {
      baseUrl: 'https://fixture.invalid',
      tenantId: 'tenant',
      tenantMemberId: 'member',
      userId: 'user',
      deviceId: 'device',
    },
    view: vi.fn().mockResolvedValue({ ...base, ...view }),
    initialize: vi.fn().mockResolvedValue({ recoveryCode: 'secret', keysetDigest: 'digest', replayed: false }),
    enroll: vi.fn().mockResolvedValue({ id: 'e', status: 'queued', version: 1 }),
    confirmEnrollment: vi.fn().mockResolvedValue({ id: 'e', status: 'verified', version: 2 }),
    resumeRecovery: vi.fn().mockResolvedValue({ status: 'verified', cursor: 0, applied: 0 }),
  };
}
describe('automatic backup escrow workflow', () => {
  beforeEach(() => cache.clear());
  it('treats the explicit enable action as consent and initializes without a second prompt', async () => {
    const client = fixture();
    await enableEscrowBackup(client, false);
    expect(client.initialize).toHaveBeenCalledWith(true);
    expect(hasAutomaticBackupConsent(client)).toBe(true);
    expect(client.enroll).not.toHaveBeenCalled();
  });
  it('enrolls existing backups without replacing their root keys', async () => {
    const client = fixture();
    await enableEscrowBackup(client, true);
    expect(client.enroll).toHaveBeenCalledWith(true);
    expect(client.initialize).not.toHaveBeenCalled();
  });
  it.each([{ state: 'disabled' }, { state: 'suspended' }, { notificationReady: false }])(
    'does not claim enabled when prerequisites are absent: %j',
    async (view) => {
      const client = fixture(view);
      await expect(enableEscrowBackup(client, false)).rejects.toThrow();
      expect(client.initialize).not.toHaveBeenCalled();
      expect(hasAutomaticBackupConsent(client)).toBe(false);
    }
  );
  it('does not persist consent when registration fails', async () => {
    const client = fixture();
    client.enroll.mockRejectedValue(new Error('offline'));
    await expect(enableEscrowBackup(client, true)).rejects.toThrow('offline');
    expect(hasAutomaticBackupConsent(client)).toBe(false);
  });
  it('automatically verifies a ready enrollment', async () => {
    const client = fixture({ registration: { id: 'e', status: 'result_ready', version: 1 } });
    await advanceEscrowBackup(client);
    expect(client.confirmEnrollment).toHaveBeenCalledOnce();
  });
  it('waits for execution after approval without resubmitting a request', async () => {
    const client = fixture({ recovery: { id: 'r', status: 'approved', version: 1 } });
    await advanceEscrowBackup(client);
    expect(client.resumeRecovery).not.toHaveBeenCalled();
    expect(client.initialize).not.toHaveBeenCalled();
  });
  it.each(['result_ready', 'completed'])(
    'automatically resumes %s recovery including a lost finish response',
    async (status) => {
      const client = fixture({ recovery: { id: 'r', status, version: 1 } });
      await advanceEscrowBackup(client);
      expect(client.resumeRecovery).toHaveBeenCalledOnce();
    }
  );
  it('does not repeat a verified recovery on later polls', async () => {
    const client = fixture({ recovery: { id: 'r', status: 'completed', version: 1 }, stage: 'verified' });
    await advanceEscrowBackup(client);
    await advanceEscrowBackup(client);
    expect(client.resumeRecovery).not.toHaveBeenCalled();
  });
});

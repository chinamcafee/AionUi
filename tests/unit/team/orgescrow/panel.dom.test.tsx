import React from 'react';
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ status: vi.fn(), action: vi.fn(), tenants: vi.fn() }));
vi.mock('@/renderer/api/teamClient', () => ({
  teamApi: { orgEscrowStatus: mocks.status, orgEscrowAction: mocks.action, tenants: mocks.tenants },
}));
vi.mock('@/renderer/hooks/context/TeamAuthContext', () => ({
  useTeamAuth: () => ({ bootstrap: { tenant: { id: 't' } } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import OrgEscrowPanel from '@/renderer/pages/settings/MemoryBackupSettings/OrgEscrowPanel';
const ready = {
  state: 'enabled',
  coverage: 'verified',
  notificationReady: true,
  recovery: { id: 'op1', status: 'completed' },
  stage: 'verified',
  codeReady: true,
  hasRecoveryCode: true,
};
describe('backup recovery status and one-time code', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.tenants.mockResolvedValue([]);
    mocks.action.mockResolvedValue({ recoveryCode: 'one-time-code' });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  async function mount() {
    render(<OrgEscrowPanel onChanged={async () => {}} />);
    await act(async () => {});
  }
  it('automatically opens a verified code once and consumes it only on saved acknowledgement', async () => {
    mocks.status.mockResolvedValue(ready);
    await mount();
    expect(screen.getAllByText('one-time-code').length).toBeGreaterThan(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(mocks.action.mock.calls.filter(([action]) => action === 'recovery-code')).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText('team.orgEscrow.saved'));
    });
    expect(mocks.action).toHaveBeenCalledWith('acknowledge-code');
  });
  it('polls approval without exposing a code until full verification completes', async () => {
    mocks.status.mockResolvedValue({ ...ready, codeReady: false, stage: 'restoring' });
    await mount();
    expect(mocks.action).not.toHaveBeenCalled();
    mocks.status.mockResolvedValue(ready);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mocks.action).toHaveBeenCalledWith('recovery-code');
  });
  it('retains the modal when acknowledging fails', async () => {
    mocks.status.mockResolvedValue(ready);
    await mount();
    mocks.action.mockRejectedValue(new Error('offline'));
    await act(async () => {
      fireEvent.click(screen.getByText('team.orgEscrow.saved'));
    });
    expect(screen.getAllByText('one-time-code').length).toBeGreaterThan(0);
    expect(screen.getByText('team.orgEscrow.error')).toBeTruthy();
  });
  it('does not fetch or display a secret from a response arriving after unmount', async () => {
    let resolve!: (value: typeof ready) => void;
    mocks.status.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    const view = render(<OrgEscrowPanel onChanged={async () => {}} />);
    view.unmount();
    await act(async () => {
      resolve(ready);
    });
    expect(mocks.action).not.toHaveBeenCalled();
  });
});

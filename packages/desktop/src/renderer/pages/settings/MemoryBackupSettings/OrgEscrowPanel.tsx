import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Select, Typography } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { teamApi, type OrgEscrowView } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';

const terminal = ['failed', 'expired', 'cancelled', 'rejected'];
/** Status is polled here; key verification and resumable recovery run in the main process. */
export default function OrgEscrowPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const auth = useTeamAuth();
  const { t } = useTranslation();
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [view, setView] = useState<OrgEscrowView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const active = useRef(false);
  const inFlight = useRef(false);
  const shown = useRef('');
  const refresh = useCallback(async () => {
    const next = await teamApi.orgEscrowStatus();
    if (!active.current) return;
    setView(next);
    setError(next.progressError ?? '');
    const id = next.recovery?.id ?? 'initial';
    if (next.codeReady && next.hasRecoveryCode && shown.current !== id) {
      const result = await teamApi.orgEscrowAction('recovery-code');
      if (!active.current) return;
      if (result.recoveryCode) {
        shown.current = id;
        setCode(result.recoveryCode);
      }
    }
  }, []);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    void teamApi
      .tenants()
      .then((v) => {
        if (active.current) setTenants(v);
      })
      .catch(() => {});
    const poll = async () => {
      if (!inFlight.current) {
        inFlight.current = true;
        try {
          await refresh();
          await onChanged();
        } catch (e) {
          if (active.current && (e as Error).message !== 'ESCROW_OPERATION_BUSY') setError((e as Error).message);
        } finally {
          inFlight.current = false;
        }
      }
      if (active.current) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => {
      active.current = false;
      clearTimeout(timer);
    };
  }, [refresh, onChanged]);
  const perform = async (action: 'request' | 'cancel' | 'acknowledge-code') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await teamApi.orgEscrowAction(action);
      if (!active.current) return;
      if (action === 'acknowledge-code') setCode('');
      await refresh();
      await onChanged();
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section className='mt-16px mb-16px p-16px rd-8px border border-border-2 flex flex-col gap-12px'>
      <Typography.Title heading={6}>{t('team.orgEscrow.title')}</Typography.Title>
      {tenants.length > 1 && (
        <Select
          aria-label={t('team.orgEscrow.title')}
          value={auth.bootstrap?.tenant?.id}
          disabled={busy || !!code}
          options={tenants.map((v) => ({ label: v.name, value: v.id }))}
          onChange={(value) => {
            setBusy(true);
            void teamApi
              .switchTenant(value)
              .then(() => auth.refresh())
              .then(onChanged)
              .catch((e) => {
                if (active.current) setError((e as Error).message);
              })
              .finally(() => {
                if (active.current) setBusy(false);
              });
          }}
        />
      )}
      <Alert type='warning' content={t('team.orgEscrow.autoDisclosure')} />
      {error && <Alert type='error' content={t('team.orgEscrow.error', { code: error })} />}
      {view && (
        <>
          <Typography.Text>
            {t(
              view.state === 'disabled'
                ? 'team.orgEscrow.disabled'
                : view.state === 'suspended'
                  ? 'team.orgEscrow.suspended'
                  : 'team.orgEscrow.active'
            )}
          </Typography.Text>
          {(view.recovery || view.registration) && (
            <Alert
              type={view.stage === 'verified' ? 'success' : 'info'}
              content={
                <>
                  {t(view.stage === 'verified' ? 'team.orgEscrow.restored' : 'team.orgEscrow.waiting')}
                  <Typography.Paragraph>
                    {t('team.orgEscrow.statusLabel', {
                      status: t(
                        `team.orgEscrow.status.${view.recovery?.status ?? view.registration?.status}` as 'team.orgEscrow.status.pending'
                      ),
                    })}
                  </Typography.Paragraph>
                  {view.displayCode && <Typography.Paragraph code>{view.displayCode}</Typography.Paragraph>}
                </>
              }
            />
          )}
          <div className='flex flex-wrap gap-8px'>
            {(!view.recovery || terminal.includes(view.recovery.status)) && (
              <Button
                disabled={
                  busy ||
                  view.coverage !== 'verified' ||
                  !view.notificationReady ||
                  !['enrolling', 'enabled'].includes(view.state)
                }
                loading={busy}
                onClick={() => void perform('request')}
              >
                {t('team.orgEscrow.request')}
              </Button>
            )}
            {view.recovery &&
              ![...terminal, 'completed', 'executing', 'execution_unknown', 'result_ready'].includes(
                view.recovery.status
              ) && (
                <Button disabled={busy} onClick={() => void perform('cancel')}>
                  {t('team.orgEscrow.cancel')}
                </Button>
              )}
          </div>
        </>
      )}
      <Modal
        visible={!!code}
        title={t('team.orgEscrow.showCode')}
        maskClosable={false}
        escToExit={false}
        closable={false}
        footer={
          <Button type='primary' loading={busy} onClick={() => void perform('acknowledge-code')}>
            {t('team.orgEscrow.saved')}
          </Button>
        }
      >
        <Typography.Paragraph>{t('team.orgEscrow.saveHint')}</Typography.Paragraph>
        <Typography.Paragraph className='break-all select-all' copyable>
          {code}
        </Typography.Paragraph>
      </Modal>
    </section>
  );
}

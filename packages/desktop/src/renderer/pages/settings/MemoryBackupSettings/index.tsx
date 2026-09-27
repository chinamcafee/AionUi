// AionUi 新增：个人记忆备份设置页（E2EE 云备份）。
// 与「团队平台 / 知识库设置」同房式风格：SettingsPageWrapper + SettingsPageHeader + 分节 PreferenceRow。
// 渲染层只经 BFF /teamapi/personal-sync/*；密钥、令牌与 team-server 调用全部在主进程。

import { useTranslation } from 'react-i18next';
import OrgEscrowPanel from './OrgEscrowPanel';
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Input, Message, Modal, Skeleton, Switch, Tag, Typography } from '@arco-design/web-react';
import { Copy, Devices, Shield, Time } from '@icon-park/react';
import { useNavigate } from 'react-router-dom';
import {
  teamApi,
  teamBffBaseUrl,
  TeamApiError,
  type TeamPersonalSyncDevice,
  type TeamPersonalSyncDeviceState,
  type TeamPersonalSyncPairing,
  type TeamPersonalSyncStatus,
} from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';

const DEVICE_STATUS_LABEL: Record<TeamPersonalSyncDevice['status'], { text: string; color: string }> = {
  trusted: { text: '受信设备', color: 'green' },
  pending_pairing: { text: '等待批准', color: 'orange' },
  revoked: { text: '已撤销', color: 'red' },
};

const TRIGGER_LABEL: Record<string, string> = {
  manual: '手动',
  startup: '应用启动',
  periodic: '周期性',
  debounce: '记忆变更',
  'max-wait': '延迟冲刷',
  resume: '系统恢复',
  online: '网络恢复',
  'account-switch': '账号切换',
};

/** 错误码 → 可读信息（含恢复路径，避免只抛裸错误码）。 */
const ERROR_MESSAGE: Record<string, string> = {
  SYNC_ALREADY_INITIALIZED: '云端已初始化：请在下方使用恢复码接入本设备',
  DEVICE_NOT_TRUSTED: '本设备尚未受信任：请用恢复码完成接入，或在受信设备上批准配对',
  SESSION_INVALID: '团队登录已失效，请重新登录后重试',
  ACCOUNT_RUNTIME_REQUIRED: '请先使用团队账号登录',
  RECOVERY_CODE_INVALID: '恢复码不正确或已失效（每次恢复后旧码立即作废）',
  PAIRING_NOT_FOUND: '配对不存在或已过期，请重新发起配对',
  PAIRING_ALREADY_PENDING: '本设备已有待批准的配对',
  KEYSET_INCOMPLETE: '本地密钥版本不完整，无法为该设备封装密钥',
  SYNC_QUOTA_EXCEEDED: '单次同步批次超限，稍后将自动分批重试',
  OBJECT_STORE_UNAVAILABLE: '对象存储暂不可用，请稍后重试',
  PERSONAL_SYNC_NOT_INITIALIZED: '请先启用加密备份',
  TEAM_BFF_UNAVAILABLE: '团队网关未运行，请确认已在团队平台设置中启用',
  TEAM_BFF_HTTP_404: '团队网关缺少该接口：主进程可能尚未加载新版本，请重启 AionUI',
  TEAM_BFF_HTTP_500: '团队网关内部错误，请查看主进程日志后重试',
  TEAM_BFF_HTTP_503: '团队网关暂不可用，请稍后重试',
};

export function formatSyncTime(value: number | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function errorCode(error: unknown): string {
  const code = error instanceof TeamApiError ? error.code : ((error as Error)?.message ?? 'UNKNOWN_ERROR');
  const friendly = ERROR_MESSAGE[code];
  return friendly ? `${friendly}（${code}）` : code;
}

/** 43 位恢复码的一次性展示（复制 + 强提示）。 */
const RecoveryCodeModal: React.FC<{ code: string | null; onClose: () => void }> = ({ code, onClose }) => (
  <Modal
    title='恢复码（仅显示一次）'
    visible={!!code}
    footer={
      <Button
        type='primary'
        icon={<Copy theme='outline' size='14' />}
        onClick={() => {
          if (!code) {
            onClose();
            return;
          }
          // 复制成功后关闭；复制失败（权限/剪贴板不可用）保留弹窗，便于手动选择复制
          navigator.clipboard
            .writeText(code)
            .then(() => {
              Message.success('恢复码已复制到剪贴板');
              onClose();
            })
            .catch(() => Message.error('复制失败，请手动选择上方文本复制后关闭'));
        }}
      >
        复制并关闭
      </Button>
    }
    onCancel={onClose}
    maskClosable={false}
  >
    <Typography.Paragraph style={{ marginBottom: 12 }}>
      用于在新设备接入或密钥丢失时恢复云端记忆。请立即存入密码管理器，<strong>关闭后无法再次查看</strong>。
    </Typography.Paragraph>
    <div
      className='rd-8px px-12px py-12px text-13px font-mono break-all select-all'
      style={{ background: 'var(--color-fill-2)' }}
    >
      {code}
    </div>
  </Modal>
);

const MemoryBackupSettingsContent: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { view, bootstrap } = useTeamAuth();
  const bffEnabled = Boolean(teamBffBaseUrl());
  const authenticated = ['authenticated', 'team_required', 'tenant_required'].includes(view.phase);

  const [status, setStatus] = useState<TeamPersonalSyncStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [devices, setDevices] = useState<TeamPersonalSyncDeviceState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState('');
  const [pairing, setPairing] = useState<TeamPersonalSyncPairing | null>(null);
  const [pairingIdDraft, setPairingIdDraft] = useState('');
  const [pairingCodeDraft, setPairingCodeDraft] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await teamApi.personalSyncStatus());
      setLoadError(null);
    } catch (error) {
      const code = errorCode(error);
      setLoadError(code);
      Message.error(`加载备份状态失败：${code}`);
    }
    try {
      setDevices(await teamApi.personalSyncDevices());
    } catch {
      // 设备列表依赖 team-server 在线；离线时保留本地状态视图
      setDevices(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) void load();
  }, [authenticated, load, bootstrap?.tenant?.id]);

  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, successText?: string) => {
      setBusy(key);
      try {
        await action();
        if (successText) Message.success(successText);
        await load();
      } catch (error) {
        Message.error(`${errorCode(error)}`);
      } finally {
        setBusy(null);
      }
    },
    [load]
  );

  if (!bffEnabled || !authenticated) {
    return (
      <SettingsPageWrapper contentClassName='max-w-640px'>
        <SettingsPageHeader title='个人记忆备份' description={t('team.orgEscrow.backupDescription')} />
        <section className='mt-16px px-[12px] md:px-[32px] py-24px bg-2 rd-16px'>
          <Empty description={bffEnabled ? '请先在登录页使用团队账号登录后使用个人记忆备份' : '请先启用团队功能'} />
          <div className='mt-12px flex justify-center'>
            <Button type='primary' onClick={() => void navigate('/settings/team')}>
              前往团队平台设置
            </Button>
          </div>
        </section>
      </SettingsPageWrapper>
    );
  }

  if (!status) {
    return (
      <SettingsPageWrapper contentClassName='max-w-640px'>
        <SettingsPageHeader title='个人记忆备份' description={t('team.orgEscrow.backupDescription')} />
        {loadError ? (
          <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
            <Alert
              type='error'
              content={`无法加载备份状态：${loadError}`}
              action={
                <Button size='small' type='primary' loading={loading} onClick={() => void load()}>
                  重试
                </Button>
              }
            />
          </section>
        ) : (
          <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
            <Skeleton text={{ rows: 4 }} animation />
          </section>
        )}
      </SettingsPageWrapper>
    );
  }

  const initialized = status.initialized;
  const remoteDevices = devices?.devices ?? status.remote?.devices ?? [];
  const currentDevice = remoteDevices.find((device) => device.id === status.deviceId);
  const rootStatus = devices?.rootStatus ?? status.remote?.rootStatus ?? 'uninitialized';

  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <SettingsPageHeader
        title='个人记忆备份'
        description={t('team.orgEscrow.backupDescription')}
        actions={
          <>
            <Button icon={<Time />} loading={busy === 'refresh' || loading} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              type='primary'
              icon={<Shield />}
              disabled={!initialized}
              loading={busy === 'sync-now'}
              onClick={() => void run('sync-now', () => teamApi.personalSyncNow(), '已完成一次备份同步')}
            >
              立即备份
            </Button>
          </>
        }
      />

      <OrgEscrowPanel key={`${bootstrap?.user.id}:${bootstrap?.tenant?.id}`} onChanged={load} />
      {status.lastError && (
        <Alert
          type='error'
          className='mt-16px'
          content={`最近一次备份失败：${status.lastError}（将在下次自动备份时重试）`}
        />
      )}

      <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
        <div className='flex flex-col divide-y divide-border-2'>
          <PreferenceRow label='加密状态' description='启用后生成独立的账户密钥与恢复码，记忆内容在本机加密后上传'>
            <Tag color={initialized ? 'green' : rootStatus === 'locked' ? 'orange' : 'gray'}>
              {initialized ? '已启用' : rootStatus === 'locked' ? '密钥不可用' : '未启用'}
            </Tag>
          </PreferenceRow>
          <PreferenceRow label={t('team.orgEscrow.autoLabel')} description={t('team.orgEscrow.autoDisclosure')}>
            <Switch
              checked={status.autoEnabled}
              disabled={!!busy}
              onChange={(checked) => void run('auto', () => teamApi.personalSyncSetAuto(checked))}
            />
          </PreferenceRow>
          <PreferenceRow label='最近备份'>
            <span className='text-13px text-t-primary'>
              {formatSyncTime(status.lastSyncAt)}
              {status.lastTrigger ? (
                <span className='ms-8px text-12px text-t-tertiary'>
                  {TRIGGER_LABEL[status.lastTrigger] ?? status.lastTrigger}
                </span>
              ) : null}
              {status.syncing ? <span className='ms-8px text-12px text-primary-6'>备份中…</span> : null}
            </span>
          </PreferenceRow>
          <PreferenceRow label='待上传事件' description='本地已记录、等待推送到云端的记忆变更'>
            <span className='text-13px text-t-primary'>{status.pendingEvents} 条</span>
          </PreferenceRow>
          <PreferenceRow label='云端游标' description='已合并到的云端事件位置（多设备一致性依据）'>
            <span className='text-13px text-t-primary'>#{status.cursor}</span>
          </PreferenceRow>
          <PreferenceRow
            label='云端快照'
            description='记忆量较大时自动生成加密快照（也可手动创建），用于云端压缩后的快速恢复'
          >
            <span className='flex items-center gap-8px'>
              <span className='text-13px text-t-primary'>#{status.lastSnapshotSeq}</span>
              <Button
                size='small'
                disabled={!initialized}
                loading={busy === 'snapshot'}
                onClick={() => void run('snapshot', () => teamApi.personalSyncCreateSnapshot(), '已创建云端快照')}
              >
                创建快照
              </Button>
            </span>
          </PreferenceRow>
        </div>
      </section>

      <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
        <div className='mb-4px flex items-center justify-between'>
          <Typography.Title heading={6} style={{ margin: 0 }}>
            云端设备
          </Typography.Title>
          <Button
            size='small'
            icon={<Devices />}
            loading={busy === 'devices'}
            onClick={() => void run('devices', () => teamApi.personalSyncDevices())}
          >
            刷新设备
          </Button>
        </div>
        {!initialized ? (
          <Typography.Text type='secondary'>启用加密备份后可查看并管理各设备。</Typography.Text>
        ) : remoteDevices.length === 0 ? (
          <Typography.Text type='secondary'>暂无设备信息（team-server 离线时显示本地缓存）。</Typography.Text>
        ) : (
          <div className='flex flex-col divide-y divide-border-2'>
            {remoteDevices.map((device) => {
              const label = DEVICE_STATUS_LABEL[device.status];
              return (
                <PreferenceRow
                  key={device.id}
                  label={device.displayName || device.id.slice(0, 8)}
                  description={`最后拉取：${formatSyncTime(typeof device.lastPullAt === 'number' ? device.lastPullAt : null)}`}
                >
                  <span className='flex items-center gap-8px'>
                    {device.id === status.deviceId && <Tag color='arcoblue'>当前设备</Tag>}
                    <Tag color={label.color}>{label.text}</Tag>
                    {device.id !== status.deviceId && device.status !== 'revoked' && (
                      <Button
                        size='small'
                        status='danger'
                        type='text'
                        loading={busy === `revoke-${device.id}`}
                        onClick={() =>
                          Modal.confirm({
                            title: '撤销该设备？',
                            content: '撤销后该设备将无法再解密云端记忆，需重新用恢复码接入。',
                            okButtonProps: { status: 'danger' },
                            onOk: () =>
                              run(
                                `revoke-${device.id}`,
                                () => teamApi.personalSyncRevokeDevice(device.id),
                                '设备已撤销'
                              ),
                          })
                        }
                      >
                        撤销
                      </Button>
                    )}
                  </span>
                </PreferenceRow>
              );
            })}
          </div>
        )}
        {initialized && currentDevice?.status === 'pending_pairing' && (
          <Alert
            className='mt-12px'
            type='warning'
            content='本设备已在等待批准。请在受信设备上批准，或直接使用下方恢复码完成接入。'
          />
        )}
      </section>

      <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
        <Typography.Title heading={6} style={{ marginTop: 0 }}>
          恢复与接入
        </Typography.Title>
        {!initialized ? (
          <Alert type='info' content={t('team.orgEscrow.enableHint')} />
        ) : (
          <div className='flex flex-col divide-y divide-border-2'>
            <PreferenceRow
              label='用恢复码恢复'
              description='在新设备或密钥丢失时使用：用恢复码解封云端密钥并轮换凭据，完成后将显示新的恢复码'
            >
              <span className='flex items-center gap-8px'>
                <Input
                  style={{ width: 260 }}
                  placeholder='粘贴 43 位恢复码'
                  value={recoveryDraft}
                  onChange={setRecoveryDraft}
                />
                <Button
                  loading={busy === 'recover'}
                  disabled={!/^[A-Za-z0-9_-]{43}$/.test(recoveryDraft.trim())}
                  onClick={() =>
                    Modal.confirm({
                      title: '用恢复码恢复本设备？',
                      content: '将解封云端密钥并轮换恢复凭据，旧恢复码随即失效。',
                      onOk: async () => {
                        setBusy('recover');
                        try {
                          const result = await teamApi.personalSyncRecover(recoveryDraft.trim());
                          setRecoveryCode(result.newRecoveryCode);
                          setRecoveryDraft('');
                          await load();
                        } catch (error) {
                          Message.error(`恢复失败：${errorCode(error)}`);
                        } finally {
                          setBusy(null);
                        }
                      },
                    })
                  }
                >
                  恢复并轮换
                </Button>
              </span>
            </PreferenceRow>

            <PreferenceRow
              label='将本设备加入同步'
              description='生成配对请求供受信设备批准；批准后需用恢复码完成本设备密钥接入'
            >
              <span className='flex items-center gap-8px'>
                <Button
                  loading={busy === 'pairing'}
                  onClick={() =>
                    void (async () => {
                      setBusy('pairing');
                      try {
                        setPairing(await teamApi.personalSyncCreatePairing());
                      } catch (error) {
                        Message.error(`发起配对失败：${errorCode(error)}`);
                      } finally {
                        setBusy(null);
                      }
                    })()
                  }
                >
                  发起配对
                </Button>
                {pairing && (
                  <Typography.Text type='secondary' className='text-12px'>
                    配对 ID <span className='font-mono select-all'>{pairing.id}</span> · 显示码{' '}
                    <span className='font-mono'>{pairing.displayCode}</span>
                  </Typography.Text>
                )}
              </span>
            </PreferenceRow>

            <PreferenceRow label='批准其他设备' description='输入另一台设备发起配对时展示的配对 ID 与 8 位显示码'>
              <span className='flex items-center gap-8px'>
                <Input
                  style={{ width: 220 }}
                  placeholder='配对 ID'
                  value={pairingIdDraft}
                  onChange={setPairingIdDraft}
                />
                <Input
                  style={{ width: 96 }}
                  placeholder='8 位显示码'
                  value={pairingCodeDraft}
                  onChange={setPairingCodeDraft}
                />
                <Button
                  loading={busy === 'approve'}
                  disabled={
                    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                      pairingIdDraft.trim()
                    ) || !/^\d{8}$/.test(pairingCodeDraft.trim())
                  }
                  onClick={() =>
                    void run(
                      'approve',
                      () => teamApi.personalSyncApprovePairing(pairingIdDraft.trim(), pairingCodeDraft.trim()),
                      '已批准该设备（请在对方设备上用恢复码完成接入）'
                    )
                  }
                >
                  批准
                </Button>
              </span>
            </PreferenceRow>
          </div>
        )}
      </section>

      <section className='mt-16px px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
        <div className='mb-4px flex items-center justify-between'>
          <Typography.Title heading={6} style={{ margin: 0 }}>
            同步冲突
          </Typography.Title>
          <Tag color={status.conflicts.length > 0 ? 'orange' : 'gray'}>{status.conflicts.length} 条</Tag>
        </div>
        {status.conflicts.length === 0 ? (
          <Typography.Text type='secondary'>多设备编辑同一记忆且无法自动合并时，会在此保留冲突副本。</Typography.Text>
        ) : (
          <div className='flex flex-col divide-y divide-border-2'>
            {status.conflicts.map((conflict) => (
              <PreferenceRow
                key={conflict.conflictCopyId}
                label={conflict.title ?? conflict.entityId}
                description={`冲突副本 ${conflict.conflictCopyId.slice(0, 8)} · ${formatSyncTime(conflict.createdAt)}`}
              >
                <Button size='small' type='text' onClick={() => void navigate('/memory')}>
                  去记忆页处理
                </Button>
              </PreferenceRow>
            ))}
          </div>
        )}
      </section>

      <RecoveryCodeModal code={recoveryCode} onClose={() => setRecoveryCode(null)} />
    </SettingsPageWrapper>
  );
};

const MemoryBackupSettings: React.FC = () => {
  const { bootstrap } = useTeamAuth();
  return <MemoryBackupSettingsContent key={`${bootstrap?.user.id}:${bootstrap?.tenant?.id}`} />;
};
export default MemoryBackupSettings;

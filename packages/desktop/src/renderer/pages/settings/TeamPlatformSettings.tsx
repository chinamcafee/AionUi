// AionUi 新增（T1.13）：团队平台连接设置页。Server URL / 功能开关 / 控制台外链。
// 配置经 __teamAuthBridge IPC 写入主进程（AionTeamPlatform/config.json），开关切换即时启停 BFF。
// UI：SettingsPageWrapper + SettingsPageHeader + 分区卡片（白底 + 细边框 + 浅灰标题带 + 行分隔线）+ PreferenceRow。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Input, Message, Select, Skeleton, Space, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { Attention, BookOne, Brain, Copy, Link, Peoples, Refresh, Toolkit } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchProviders } from '@renderer/hooks/agent/useModelProviderList';
import { hasSpecificModelCapability } from '@/common/utils/modelCapabilities';
import type { IProvider } from '@/common/config/storage';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import SettingsPageHeader from './components/SettingsPageHeader';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';
import { readCapabilityState } from '@/renderer/pages/settings/components/ModelCapabilitySwitches';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { teamApi, type TeamSoulView } from '@/renderer/api/teamClient';

interface TeamPlatformConfig {
  enabled: boolean;
  serverBaseUrl: string;
  clientId: string;
  authorizationPageUrl?: string;
  memoryModel?: {
    baseUrl: string;
    apiKey: string;
    model: string;
    name?: string;
  };
}

/**
 * 设置分区卡片：白底细边框外壳（层次由发丝边框 + 极轻投影建立），标题带浅灰底与正文区分，
 * 两区以发丝线衔接；功能区承载行式设置（divide 分隔线）或自定义内容，保持 12/16px 间距节奏。
 */
const SectionCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** 功能区内容：行式设置自带 12px 纵向内边距；自定义块可传入 bodyClassName 调整。 */
  bodyClassName?: string;
  children: React.ReactNode;
}> = ({ icon, title, description, action, bodyClassName, children }) => (
  <section className='overflow-hidden rd-16px border border-3 bg-base shadow-sm'>
    <header className='flex items-start justify-between gap-12px border-b border-3 bg-2 px-[12px] md:px-[32px] py-12px'>
      <div className='flex min-w-0 items-start gap-10px'>
        <span className='mt-1px flex h-28px w-28px shrink-0 items-center justify-center rd-8px bg-primary-1 text-primary-6'>
          {icon}
        </span>
        <div className='min-w-0'>
          <div className='text-14px font-600 text-t-primary leading-20px'>{title}</div>
          {description ? <div className='mt-3px text-12px text-t-tertiary leading-18px'>{description}</div> : null}
        </div>
      </div>
      {action ? <div className='shrink-0 flex items-center gap-8px'>{action}</div> : null}
    </header>
    <div className={classNames('bg-base px-[12px] md:px-[32px]', bodyClassName ?? 'py-4px')}>{children}</div>
  </section>
);

const TeamPlatformSettings: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<TeamPlatformConfig | null>(null);
  const [serverUrl, setServerUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [authPageUrl, setAuthPageUrl] = useState('');
  const [memoryModel, setMemoryModel] = useState<NonNullable<TeamPlatformConfig['memoryModel']> | null>(null);
  const [providers, setProviders] = useState<IProvider[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const navigate = useNavigate();
  const { view, bootstrap, logout } = useTeamAuth();

  useEffect(() => {
    void window.__teamAuthBridge
      ?.getConfig()
      .then((value) => {
        setConfig(value);
        setServerUrl(value.serverBaseUrl);
        setAuthPageUrl(value.authorizationPageUrl ?? '');
        if (value.memoryModel) setMemoryModel({ name: '记忆模型', ...value.memoryModel });
      })
      .catch(() => setConfig({ enabled: false, serverBaseUrl: 'http://127.0.0.1:30180', clientId: 'aionui-desktop' }));

    void fetchProviders()
      .then((list) => {
        // 记忆整理需要 API Key 的 OpenAI 兼容端点；无 Key 的内置渠道（如 Google Auth）不参与
        setProviders(list.filter((p) => p.base_url && p.api_key && (p.models?.length ?? 0) > 0));
      })
      .catch(() => setProviders([]));
  }, []);

  const persist = useCallback(async (patch: Partial<TeamPlatformConfig>) => {
    setSaving(true);
    try {
      const next = await window.__teamAuthBridge!.setConfig(patch);
      setConfig(next);
      Message.success('团队平台配置已保存（重启应用或刷新后完全生效）');
    } catch (error) {
      Message.error(`保存失败：${(error as Error)?.message ?? error}`);
    } finally {
      setSaving(false);
    }
  }, []);

  const adminConsoleUrl = config ? `${config.serverBaseUrl.replace(/\/$/, '')}` : '';

  const loginButton = (
    <Button
      type='primary'
      loading={loginBusy}
      disabled={!config?.enabled}
      onClick={() => {
        setLoginBusy(true);
        void teamApi
          .beginLogin()
          .catch((error) => Message.error(`发起登录失败：${String(error)}`))
          .finally(() => setLoginBusy(false));
      }}
    >
      使用团队账号登录
    </Button>
  );

  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <SettingsPageHeader
        title={t('settings.teamPlatform', { defaultValue: '团队平台' })}
        description='企业账号 / 团队记忆 / 知识库的接入配置；保存后重启应用或刷新即可完全生效。'
      />

      <div className='mt-16px space-y-16px'>
        {/* 接入 */}
        <SectionCard
          icon={<Link theme='outline' size='16' />}
          title={t('settings.teamPlatformSections.access.title', { defaultValue: '接入' })}
          description={t('settings.teamPlatformSections.access.description', {
            defaultValue: '本地团队网关与 team-server 连接；默认关闭，不影响本地账号使用。',
          })}
          action={
            <Tag color={config?.enabled ? (view.phase === 'authenticated' ? 'green' : 'arcoblue') : 'gray'}>
              {config?.enabled
                ? view.phase === 'authenticated'
                  ? t('settings.teamPlatformSections.access.gatewayRunning', { defaultValue: '网关运行中' })
                  : t('settings.teamPlatformSections.access.gatewayIdle', { defaultValue: '已启用 · 未登录' })
                : t('settings.teamPlatformSections.access.gatewayOff', { defaultValue: '未启用' })}
            </Tag>
          }
        >
          <div className='flex flex-col divide-y divide-3'>
            <PreferenceRow
              label='启用团队功能'
              description='开启后将在本地启动团队网关（127.0.0.1:4118），并可在登录页使用团队账号登录。默认关闭，不影响本地账号。'
            >
              <Switch
                checked={config?.enabled ?? false}
                loading={saving}
                disabled={!config}
                onChange={(enabled) => void persist({ enabled })}
              />
            </PreferenceRow>
            <PreferenceRow
              label='team-server 地址'
              description='本地开发栈见 AionProjects/AionTeamPlatform/deploy/README-local.md；生产请使用 https:// 地址。'
            >
              <Space size={8}>
                <Input
                  style={{ width: 300 }}
                  value={serverUrl}
                  placeholder='http://127.0.0.1:30180'
                  onChange={setServerUrl}
                />
                <Button
                  type='primary'
                  loading={saving}
                  disabled={!serverUrl.trim()}
                  onClick={() => void persist({ serverBaseUrl: serverUrl.trim().replace(/\/$/, '') || '/' })}
                >
                  保存
                </Button>
              </Space>
            </PreferenceRow>
          </div>
        </SectionCard>

        {/* 团队账号 */}
        <SectionCard
          icon={<Peoples theme='outline' size='16' />}
          title={t('settings.teamPlatformSections.account.title', { defaultValue: '团队账号' })}
          description={t('settings.teamPlatformSections.account.description', {
            defaultValue: 'OAuth 授权在系统浏览器完成，确认后自动返回 AionUi。',
          })}
          action={
            view.phase === 'authenticated' ? (
              <Tag color='green'>{t('settings.teamPlatformSections.account.signedIn', { defaultValue: '已登录' })}</Tag>
            ) : view.phase === 'signed_out' || view.phase === 'offline' || view.phase === 'disabled' ? (
              <Tag>{t('settings.teamPlatformSections.account.signedOut', { defaultValue: '未登录' })}</Tag>
            ) : (
              <Tag color='orange'>
                {t('settings.teamPlatformSections.account.inProgress', { defaultValue: '流程进行中' })} · {view.phase}
              </Tag>
            )
          }
        >
          {view.phase === 'authenticated' ? (
            <div className='flex flex-col gap-12px py-16px'>
              <div className='flex flex-wrap items-center gap-12px rd-12px border border-3 bg-1 px-14px py-12px'>
                <span className='flex h-40px w-40px shrink-0 items-center justify-center rd-999px bg-primary-1 text-15px font-600 text-primary-6'>
                  {(bootstrap?.user?.displayName ?? bootstrap?.user?.email ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <div className='min-w-0 flex-1'>
                  <div className='truncate text-14px font-500 text-t-primary'>
                    {bootstrap?.user?.displayName ?? bootstrap?.user?.email}
                  </div>
                  <div className='truncate text-12px text-t-tertiary'>{bootstrap?.user?.email}</div>
                </div>
                <Space size={8} wrap>
                  {bootstrap?.tenant && bootstrap?.activeTeam && (
                    <Tag color='arcoblue'>
                      {bootstrap.tenant.name} / {bootstrap.activeTeam.name}
                    </Tag>
                  )}
                  {bootstrap?.activeTeam?.roleCode && <Tag color='gray'>{bootstrap.activeTeam.roleCode}</Tag>}
                </Space>
              </div>
              <div className='flex flex-wrap items-center gap-8px'>
                <Button
                  onClick={() => {
                    if (bootstrap?.tenant && bootstrap.teams.length > 0) {
                      void teamApi.switchTeam(
                        bootstrap.tenant.id,
                        bootstrap.teams[0].id === bootstrap.activeTeam?.id && bootstrap.teams[1]
                          ? bootstrap.teams[1].id
                          : bootstrap.teams[0].id
                      );
                    }
                  }}
                  disabled={!bootstrap || bootstrap.teams.length < 2}
                >
                  切换团队
                </Button>
                <Button status='danger' onClick={() => void logout()}>
                  退出团队账号
                </Button>
              </div>
            </div>
          ) : view.phase === 'signed_out' || view.phase === 'offline' || view.phase === 'disabled' ? (
            <div className='flex flex-col items-start gap-12px rd-12px border border-dashed border-arco-3 bg-1 px-14px py-16px my-16px'>
              <span className='text-13px text-t-secondary'>
                {t('settings.teamPlatformSections.account.loginHint', {
                  defaultValue: '尚未登录团队账号；需先在团队控制台完成平台初始化并创建账号。',
                })}
              </span>
              {loginButton}
            </div>
          ) : (
            <div className='my-16px flex items-center justify-between gap-12px rd-12px border border-3 bg-1 px-14px py-12px'>
              <span className='text-13px text-t-secondary'>
                {t('settings.teamPlatformSections.account.waitingHint', {
                  defaultValue: '正在等待浏览器完成授权；长时间无响应可重新发起（将生成新的授权请求）。',
                })}
              </span>
              <Button
                loading={loginBusy}
                onClick={() => {
                  setLoginBusy(true);
                  void teamApi
                    .beginLogin()
                    .catch((error) => Message.error(`发起登录失败：${String(error)}`))
                    .finally(() => setLoginBusy(false));
                }}
              >
                重新发起登录
              </Button>
            </div>
          )}
        </SectionCard>

        {/* 团队 Soul（团队统一 Agent 设定，只读） */}
        <TeamSoulSection authenticated={view.phase === 'authenticated'} />

        {/* 记忆模型 */}
        <SectionCard
          icon={<Brain theme='outline' size='16' />}
          title={t('settings.teamPlatformSections.model.title', { defaultValue: '记忆模型' })}
          description={t('settings.teamPlatformSections.model.description', {
            defaultValue: '记忆抽取与语义整理所需的 OpenAI 兼容端点；未绑定时自动抽取跳过、检索退化为词法匹配。',
          })}
          action={
            memoryModel ? (
              <Tooltip content={`${memoryModel.baseUrl}`}>
                <Tag color='arcoblue'>{`${memoryModel.name ?? ''} / ${memoryModel.model}`.trim()}</Tag>
              </Tooltip>
            ) : (
              <Tag color='gray'>{t('settings.teamPlatformSections.model.unbound', { defaultValue: '未绑定' })}</Tag>
            )
          }
        >
          {(() => {
            // 记忆抽取/整理需要文本生成模型：嵌入模型不进入候选——用户在模型页显式标记为嵌入，
            // 或模型名命中嵌入规则（embed/bge-/gte-/voyage- 等）都排除，与知识引擎模型配置同一套判定。
            const options = providers.flatMap((p) =>
              (p.models ?? [])
                .filter(
                  (m) => !readCapabilityState(p, m).embedding && hasSpecificModelCapability(p, m, 'embedding') !== true
                )
                .map((m) => ({
                  label: `${p.name} / ${m}`,
                  value: `${p.id}::${m}`,
                }))
            );
            // 当前绑定对应的选项（provider baseUrl + model 双重匹配），命中则回显真实模型名
            const boundOption = memoryModel
              ? options.find((o) => {
                  const separator = o.value.indexOf('::');
                  const providerId = o.value.slice(0, separator);
                  const model = o.value.slice(separator + 2);
                  const provider = providers.find((pp) => pp.id === providerId);
                  return provider?.base_url === memoryModel.baseUrl && model === memoryModel.model;
                })
              : undefined;
            if (options.length === 0) {
              return (
                <div className='my-16px flex flex-col items-center gap-12px rd-12px border border-dashed border-arco-3 bg-1 py-20px'>
                  <Empty
                    description={t('settings.teamPlatformSections.model.emptyText', {
                      defaultValue: 'AI 核心中还没有可用于记忆抽取的文本模型（嵌入模型不可选）。',
                    })}
                  />
                  <Button
                    type='primary'
                    onClick={() => {
                      void navigate('/settings/model');
                    }}
                  >
                    去「模型」页配置
                  </Button>
                </div>
              );
            }
            return (
              <div className='flex flex-col divide-y divide-3'>
                <PreferenceRow
                  label='记忆抽取 / 整理模型'
                  description='从「模型」页已配置的模型中选取；保存后用于后续记忆抽取与整理。'
                >
                  <Space size={8}>
                    <Select
                      style={{ width: 280 }}
                      placeholder='选择模型'
                      options={options}
                      value={selectedModel || boundOption?.value}
                      onChange={(v) => setSelectedModel(String(v))}
                    />
                    <Button
                      type='primary'
                      loading={saving}
                      disabled={!selectedModel}
                      onClick={() => {
                        const [providerId, model] = selectedModel.split('::');
                        const provider = providers.find((p) => p.id === providerId);
                        if (!provider || !model) return;
                        void persist({
                          memoryModel: {
                            baseUrl: provider.base_url,
                            apiKey: provider.api_key,
                            model,
                            name: provider.name,
                          },
                        }).then(() => {
                          setMemoryModel({
                            baseUrl: provider.base_url,
                            apiKey: provider.api_key,
                            model,
                            name: provider.name,
                          });
                          setSelectedModel('');
                        });
                      }}
                    >
                      保存记忆模型
                    </Button>
                  </Space>
                </PreferenceRow>
              </div>
            );
          })()}
        </SectionCard>

        {/* 授权与入口 */}
        <SectionCard
          icon={<Toolkit theme='outline' size='16' />}
          title={t('settings.teamPlatformSections.entry.title', { defaultValue: '授权与入口' })}
          description={t('settings.teamPlatformSections.entry.description', {
            defaultValue: '浏览器授权页与团队管理控制台入口。',
          })}
        >
          <div className='flex flex-col divide-y divide-3'>
            <PreferenceRow
              label='授权确认页地址（team-admin）'
              description='OAuth 授权在 team-admin 控制台页面确认（非 team-server API）。本地栈默认 30190；修改后重启应用生效。'
            >
              <Space size={8}>
                <Input
                  style={{ width: 300 }}
                  value={authPageUrl}
                  placeholder='http://127.0.0.1:30190/electron/authorize'
                  onChange={setAuthPageUrl}
                />
                <Button
                  type='primary'
                  loading={saving}
                  onClick={() => void persist({ authorizationPageUrl: authPageUrl.trim() || undefined })}
                >
                  保存
                </Button>
              </Space>
            </PreferenceRow>
            <PreferenceRow
              label='团队管理控制台'
              description='成员/角色/审批/知识库管理在 Web 控制台（team-admin）中进行。'
            >
              <Button
                disabled={!adminConsoleUrl}
                onClick={() => void window.open(`${adminConsoleUrl}/admin`, '_blank', 'noopener,noreferrer')}
              >
                打开团队控制台
              </Button>
            </PreferenceRow>
          </div>
        </SectionCard>
      </div>
    </SettingsPageWrapper>
  );
};

/** 团队 Soul：只读展示团队统一发布的 Agent 设定（主进程验签通过后才展示）。 */
const TeamSoulSection: React.FC<{ authenticated: boolean }> = ({ authenticated }) => {
  const { t } = useTranslation();
  const [soul, setSoul] = useState<TeamSoulView | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try {
      const result = await teamApi.getTeamSoul(refresh);
      setSoul(result.soul);
      setReason(result.reason);
    } catch (error) {
      setSoul(null);
      setReason(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authenticated) void load(false);
    else {
      setSoul(null);
      setReason(null);
    }
  }, [authenticated, load]);

  if (!authenticated) return null;
  const reasonText = () => {
    if (reason === 'SOUL_NOT_FOUND') {
      return t('settings.teamSoul.notPublished', { defaultValue: '团队尚未发布 Agent Soul。' });
    }
    if (reason === 'SOUL_UNAVAILABLE' || reason === 'SOUL_POLICY_VERSION_UNAVAILABLE') {
      return t('settings.teamSoul.unavailable', { defaultValue: '暂时无法读取团队 Soul（未选择团队或服务不可达）。' });
    }
    return t('settings.teamSoul.invalid', {
      defaultValue: '团队 Soul 未通过验签，已忽略（{{code}}）。',
      code: reason ?? '',
    });
  };
  const isNotFound = reason === 'SOUL_NOT_FOUND';

  return (
    <SectionCard
      icon={<BookOne theme='outline' size='16' />}
      title={t('settings.teamSoul.title', { defaultValue: '团队 Soul' })}
      description={t('settings.teamSoul.description', {
        defaultValue: '团队统一设置的 Agent 设定：由团队管理员在控制台发布，本机只读；验签通过后随每次提问注入。',
      })}
      action={
        <Tooltip content={t('settings.teamSoul.refresh', { defaultValue: '刷新' })}>
          <Button
            size='small'
            type='text'
            icon={<Refresh theme='outline' size='14' />}
            aria-label={t('settings.teamSoul.refresh', { defaultValue: '刷新' })}
            loading={loading}
            onClick={() => void load(true)}
          />
        </Tooltip>
      }
    >
      {loading && !soul ? (
        <div className='flex flex-col gap-8px py-16px' role='status'>
          <Skeleton text={{ rows: 3, width: ['42%', '86%', '72%'] }} animation />
        </div>
      ) : soul ? (
        <div className='flex flex-col gap-10px py-16px'>
          <Space size={8} wrap>
            <Tag color='arcoblue'>{soul.versionNo != null ? `v${soul.versionNo}` : `#${soul.soulVersion}`}</Tag>
            <Tooltip
              content={
                soul.fromCache
                  ? t('settings.teamSoul.fromCacheHint', {
                      defaultValue: '来自本机缓存，已按当前团队策略版本重新验签；点击刷新可强制回源。',
                    })
                  : t('settings.teamSoul.freshHint', { defaultValue: '刚与团队服务端同步完成' })
              }
            >
              <Tag color={soul.fromCache ? 'gray' : 'green'}>
                {soul.fromCache
                  ? t('settings.teamSoul.fromCache', { defaultValue: '本机缓存（已验签）' })
                  : t('settings.teamSoul.fresh', { defaultValue: '刚从团队服务端同步' })}
              </Tag>
            </Tooltip>
            <span className='text-12px text-t-tertiary tabular-nums'>
              {t('settings.teamSoul.meta', {
                defaultValue: '策略版本 {{policy}} · 内容 {{hash}}',
                policy: soul.teamPolicyVersion,
                hash: soul.contentHash.slice(0, 12),
              })}
              {soul.publishedAt ? ` · ${new Date(soul.publishedAt).toLocaleString()}` : ''}
            </span>
          </Space>
          <div
            className='max-h-260px overflow-auto rd-12px border border-3 bg-1 px-14px py-12px text-13px leading-22px whitespace-pre-wrap break-words select-text'
            data-testid='team-soul-content'
          >
            {soul.content}
          </div>
          <div className='flex items-center justify-between gap-12px border-t border-3 pt-12px'>
            <span className='text-12px text-t-tertiary'>
              {t('settings.teamSoul.readonlyHint', {
                defaultValue: '内容以团队控制台发布为准，此处不可编辑。',
              })}
            </span>
            <Button
              size='small'
              icon={<Copy theme='outline' size='14' />}
              onClick={() => {
                navigator.clipboard
                  .writeText(soul.content)
                  .then(() => Message.success(t('settings.teamSoul.copied', { defaultValue: 'Soul 内容已复制' })))
                  .catch(() => Message.error(t('settings.teamSoul.copyFailed', { defaultValue: '复制失败' })));
              }}
            >
              {t('settings.teamSoul.copy', { defaultValue: '复制内容' })}
            </Button>
          </div>
        </div>
      ) : (
        <div className='my-16px flex items-start gap-12px rd-12px border border-dashed border-arco-3 bg-1 px-14px py-14px'>
          <span className='mt-1px shrink-0 text-t-tertiary'>
            <Attention theme='outline' size='16' />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='text-13px text-t-secondary'>{reasonText()}</div>
            <div className='mt-4px text-12px text-t-tertiary'>
              {isNotFound
                ? t('settings.teamSoul.publishHint', {
                    defaultValue: '可由团队管理员在控制台「Agent Soul」页编写并发布；发布后点右上角刷新即可同步。',
                  })
                : t('settings.teamSoul.retryHint', {
                    defaultValue: '可稍后点右上角刷新重试；本地已验签的缓存仍会在有效期内继续生效。',
                  })}
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
};

export default TeamPlatformSettings;

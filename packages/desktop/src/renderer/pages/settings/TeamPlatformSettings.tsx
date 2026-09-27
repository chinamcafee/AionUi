// AionUi 新增（T1.13）：团队平台连接设置页。Server URL / 功能开关 / 控制台外链。
// 配置经 __teamAuthBridge IPC 写入主进程（AionTeamPlatform/config.json），开关切换即时启停 BFF。
// UI 采用设置区房式风格：SettingsPageWrapper + SettingsPageHeader + bg-2 分节容器 + PreferenceRow 行。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Empty, Input, Message, Select, Space, Switch, Tag } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { fetchProviders } from '@renderer/hooks/agent/useModelProviderList';
import type { IProvider } from '@/common/config/storage';
import SettingsPageWrapper from './components/SettingsPageWrapper';
import SettingsPageHeader from './components/SettingsPageHeader';
import PreferenceRow from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/PreferenceRow';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { teamApi } from '@/renderer/api/teamClient';

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
        <section className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
          <div className='flex flex-col divide-y divide-border-2'>
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
                  loading={saving}
                  disabled={!serverUrl.trim()}
                  onClick={() => void persist({ serverBaseUrl: serverUrl.trim().replace(/\/$/, '') || '/' })}
                >
                  保存
                </Button>
              </Space>
            </PreferenceRow>
          </div>
        </section>

        {/* 团队账号 */}
        <section className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
          <div className='flex flex-col divide-y divide-border-2'>
            <PreferenceRow label='登录状态' description='OAuth 授权在系统浏览器完成，确认后自动返回 AionUi。'>
              {view.phase === 'authenticated' ? (
                <Space size={8} wrap>
                  <Tag color='green'>已登录：{bootstrap?.user?.displayName ?? bootstrap?.user?.email}</Tag>
                  {bootstrap?.tenant && bootstrap?.activeTeam && (
                    <Tag color='arcoblue'>
                      {bootstrap.tenant.name} / {bootstrap.activeTeam.name}
                    </Tag>
                  )}
                </Space>
              ) : view.phase === 'signed_out' || view.phase === 'offline' || view.phase === 'disabled' ? (
                <Tag>未登录</Tag>
              ) : (
                <Tag color='orange'>流程进行中：{view.phase}…</Tag>
              )}
            </PreferenceRow>
            <PreferenceRow
              label='账号操作'
              description='需先在团队控制台完成平台初始化并创建账号；长时间无响应可重新发起（将生成新的授权请求）。'
            >
              {view.phase === 'authenticated' ? (
                <Space size={8} wrap>
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
                </Space>
              ) : view.phase === 'signed_out' || view.phase === 'offline' || view.phase === 'disabled' ? (
                loginButton
              ) : (
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
              )}
            </PreferenceRow>
          </div>
        </section>

        {/* 记忆模型 */}
        <section className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px space-y-12px'>
          <div className='text-14px text-t-primary'>记忆模型</div>
          {(() => {
            const options = providers.flatMap((p) =>
              (p.models ?? []).map((m) => ({
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
            const boundLabel = memoryModel ? `${memoryModel.name ?? ''} / ${memoryModel.model}`.trim() : '';
            if (options.length === 0) {
              return (
                <div className='py-16px flex flex-col items-center gap-12px'>
                  <Empty description='AI 核心中还没有可用模型' />
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
              <div className='flex flex-col divide-y divide-border-2'>
                <PreferenceRow
                  label='记忆抽取 / 整理模型'
                  description={
                    memoryModel
                      ? `当前绑定：${boundLabel}（${memoryModel.baseUrl}）。未绑定时记忆自动抽取跳过、检索退化为词法匹配。`
                      : '从「模型」页已配置的模型中选取；未绑定时记忆自动抽取跳过、检索退化为词法匹配。'
                  }
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
        </section>

        {/* 授权与入口 */}
        <section className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
          <div className='flex flex-col divide-y divide-border-2'>
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
        </section>
      </div>
    </SettingsPageWrapper>
  );
};

export default TeamPlatformSettings;

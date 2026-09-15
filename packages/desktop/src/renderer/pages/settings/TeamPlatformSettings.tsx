// AionUi 新增（T1.13）：团队平台连接设置页。Server URL / 功能开关 / 控制台外链。
// 配置经 __teamAuthBridge IPC 写入主进程（AionTeamPlatform/config.json），开关切换即时启停 BFF。

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, Input, Message, Select, Space, Switch, Tag, Typography } from '@arco-design/web-react';
import { useNavigate } from 'react-router-dom';
import { fetchProviders } from '@renderer/hooks/agent/useModelProviderList';
import type { IProvider } from '@/common/config/storage';
import SettingsPageWrapper from './components/SettingsPageWrapper';
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

  return (
    <SettingsPageWrapper contentClassName='max-w-640px'>
      <Card title='团队平台（企业账号 / 团队记忆 / 知识库）'>
        <Space direction='vertical' size='large' style={{ width: '100%' }}>
          <div>
            <Typography.Title heading={6}>启用团队功能</Typography.Title>
            <Typography.Text type='secondary'>
              开启后将在本地启动团队网关（127.0.0.1:4118），并可在登录页使用团队账号登录。默认关闭，不影响本地账号。
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Switch
                checked={config?.enabled ?? false}
                loading={saving}
                disabled={!config}
                onChange={(enabled) => void persist({ enabled })}
              />
            </div>
          </div>

          <div>
            <Typography.Title heading={6}>team-server 地址</Typography.Title>
            <Space>
              <Input
                style={{ width: 360 }}
                value={serverUrl}
                placeholder='http://127.0.0.1:30180'
                onChange={setServerUrl}
              />
              <Button
                type='primary'
                loading={saving}
                onClick={() => void persist({ serverBaseUrl: serverUrl.trim().replace(/\/$/, '') || '/' })}
              >
                保存
              </Button>
            </Space>
            <Typography.Text type='secondary' style={{ display: 'block', marginTop: 4 }}>
              本地开发栈见 AionProjects/AionTeamPlatform/deploy/README-local.md；生产请使用 https:// 地址。
            </Typography.Text>
          </div>

          <div>
            <Typography.Title heading={6}>团队账号</Typography.Title>
            <Space size={12} style={{ marginTop: 8 }} wrap>
              {view.phase === 'signed_out' || view.phase === 'offline' || view.phase === 'disabled' ? (
                <>
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
                  <Typography.Text type='secondary'>
                    将在系统浏览器完成 OAuth 授权，确认后自动返回 AionUi（需先在团队控制台完成平台初始化并创建账号）。
                  </Typography.Text>
                </>
              ) : view.phase === 'authenticated' ? (
                <>
                  <Tag color='green'>已登录：{bootstrap?.user?.displayName ?? bootstrap?.user?.email}</Tag>
                  {bootstrap?.tenant && bootstrap?.activeTeam && (
                    <Tag color='arcoblue'>{bootstrap.tenant.name} / {bootstrap.activeTeam.name}</Tag>
                  )}
                  <Button
                    onClick={() => {
                      if (bootstrap?.tenant && bootstrap.teams.length > 0) {
                        void teamApi.switchTeam(bootstrap.tenant!.id, bootstrap.teams[0].id === bootstrap.activeTeam?.id && bootstrap.teams[1] ? bootstrap.teams[1].id : bootstrap.teams[0].id);
                      }
                    }}
                    disabled={!bootstrap || bootstrap.teams.length < 2}
                  >
                    切换团队
                  </Button>
                  <Button status='danger' onClick={() => void logout()}>退出团队账号</Button>
                </>
              ) : (
                <>
                  <Tag color='orange'>登录流程进行中：{view.phase}…（长时间无响应可重新发起，将生成新的授权请求）</Tag>
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
                </>
              )}
            </Space>
          </div>

          <div>
            <Typography.Title heading={6}>记忆模型（从「模型」页已配置的模型中选取）</Typography.Title>
            {(() => {
              const options = providers.flatMap((p) =>
                (p.models ?? []).map((m) => ({
                  label: `${p.name} / ${m}`,
                  value: `${p.id}::${m}`,
                })),
              );
              // 当前绑定对应的选项（provider baseUrl + model 双重匹配），命中则回显真实模型名
              const boundOption = memoryModel
                ? options.find((o) => {
                    const separator = o.value.indexOf('::');
                    const providerId = o.value.slice(0, separator);
                    const model = o.value.slice(separator + 2);
                    const provider = providers.find((pp) => pp.id === providerId);
                    return provider?.base_url === memoryModel!.baseUrl && model === memoryModel!.model;
                  })
                : undefined;
              const boundLabel = memoryModel ? `${memoryModel.name ?? ''} / ${memoryModel.model}`.trim() : '';
              if (options.length === 0) {
                return (
                  <Empty description='AI 核心中还没有可用模型'>
                    <Button
                      type='primary'
                      onClick={() => {
                        void navigate('/settings/model');
                      }}
                    >
                      去「模型」页配置
                    </Button>
                  </Empty>
                );
              }
              return (
                <Space direction='vertical' size='small' style={{ width: '100%' }}>
                  <Space wrap>
                    <Select
                      style={{ width: 320 }}
                      placeholder='选择用于记忆抽取/整理的模型'
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
                          setMemoryModel({ baseUrl: provider.base_url, apiKey: provider.api_key, model, name: provider.name });
                          setSelectedModel('');
                        });
                      }}
                    >
                      保存记忆模型
                    </Button>
                  </Space>
                  {memoryModel && (
                    <Typography.Text type='secondary'>
                      当前绑定：{boundLabel}（{memoryModel.baseUrl}）。未绑定时记忆自动抽取跳过、检索退化为词法匹配。
                    </Typography.Text>
                  )}
                </Space>
              );
            })()}
          </div>

          <div>
            <Typography.Title heading={6}>授权确认页地址（team-admin）</Typography.Title>
            <Space>
              <Input
                style={{ width: 360 }}
                value={authPageUrl}
                placeholder='http://127.0.0.1:30190/electron/authorize'
                onChange={setAuthPageUrl}
              />
              <Button
                loading={saving}
                onClick={() =>
                  void persist({ authorizationPageUrl: authPageUrl.trim() || undefined })
                }
              >
                保存
              </Button>
            </Space>
            <Typography.Text type='secondary' style={{ display: 'block', marginTop: 4 }}>
              OAuth 授权在 team-admin 控制台页面确认（非 team-server API）。本地栈默认 30190；修改后重启应用生效。
            </Typography.Text>
          </div>

          <div>
            <Typography.Title heading={6}>团队管理控制台</Typography.Title>
            <Typography.Text type='secondary'>成员/角色/审批/知识库管理在 Web 控制台（team-admin）中进行。</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Button
                disabled={!adminConsoleUrl}
                onClick={() => void window.open(`${adminConsoleUrl}/admin`, '_blank', 'noopener,noreferrer')}
              >
                打开团队控制台
              </Button>
            </div>
          </div>
        </Space>
      </Card>
    </SettingsPageWrapper>
  );
};

export default TeamPlatformSettings;

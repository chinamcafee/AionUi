// 团队平台设置页（美化后）结构回归：分区头部、账号卡、团队 Soul 三态、模型空态。

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTeamSoul: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  fetchProviders: vi.fn(),
  beginLogin: vi.fn(),
  switchTeam: vi.fn(),
}));

vi.mock('@/renderer/api/teamClient', () => ({
  teamApi: {
    getTeamSoul: mocks.getTeamSoul,
    beginLogin: mocks.beginLogin,
    switchTeam: mocks.switchTeam,
  },
}));
vi.mock('@renderer/hooks/agent/useModelProviderList', () => ({ fetchProviders: mocks.fetchProviders }));
vi.mock('@/renderer/hooks/context/TeamAuthContext', () => ({
  useTeamAuth: () => ({
    view: { phase: 'authenticated' },
    bootstrap: {
      user: { displayName: 'Owner', email: 'owner@example.com' },
      tenant: { id: 'tenant-1', name: '测试组织' },
      activeTeam: { id: 'team-1', name: '研发团队', roleCode: 'owner' },
      teams: [{ id: 'team-1' }],
    },
    logout: vi.fn(),
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'zh-CN' },
  }),
}));
// 包装组件依赖扩展 IPC（useExtI18n/useExtensionSettingsTabs），测试只关注页面本体
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import TeamPlatformSettings from '@/renderer/pages/settings/TeamPlatformSettings';

const soul = {
  versionId: 'version-1',
  versionNo: 2,
  soulVersion: 2,
  teamPolicyVersion: 4,
  contentHash: 'a'.repeat(64),
  content: '你是团队助手。',
  publishedAt: '2026-09-27T10:00:00Z',
  expiresAt: '2026-09-28T10:00:00Z',
  fromCache: false,
};

async function mount() {
  render(
    <MemoryRouter>
      <TeamPlatformSettings />
    </MemoryRouter>
  );
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getConfig.mockResolvedValue({
    enabled: true,
    serverBaseUrl: 'http://127.0.0.1:30180',
    clientId: 'aionui-desktop',
  });
  mocks.setConfig.mockResolvedValue({
    enabled: true,
    serverBaseUrl: 'http://127.0.0.1:30180',
    clientId: 'aionui-desktop',
  });
  mocks.fetchProviders.mockResolvedValue([]);
  mocks.getTeamSoul.mockResolvedValue({ soul, reason: null });
  Object.assign(window, { __teamAuthBridge: { getConfig: mocks.getConfig, setConfig: mocks.setConfig } });
});

afterEach(() => {
  cleanup();
});

describe('团队平台设置页', () => {
  it('渲染统一的分区头部与账号信息卡', async () => {
    await mount();
    for (const title of ['接入', '团队账号', '团队 Soul', '记忆模型', '授权与入口']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByText('owner@example.com')).toBeTruthy();
    expect(screen.getByText('测试组织 / 研发团队')).toBeTruthy();
    expect(screen.getByText('网关运行中')).toBeTruthy();
  });

  it('展示已发布 Soul 的版本/来源与正文，并提供复制', async () => {
    await mount();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('刚从团队服务端同步')).toBeTruthy();
    expect(screen.getByTestId('team-soul-content').textContent).toContain('你是团队助手。');
    expect(screen.getByText('复制内容')).toBeTruthy();
  });

  it('未发布时展示引导空态', async () => {
    mocks.getTeamSoul.mockResolvedValue({ soul: null, reason: 'SOUL_NOT_FOUND' });
    await mount();
    expect(screen.getByText('团队尚未发布 Agent Soul。')).toBeTruthy();
    expect(screen.getByText(/Agent Soul」页编写并发布/)).toBeTruthy();
  });

  it('无可用模型时给出模型页引导', async () => {
    await mount();
    expect(screen.getByText(/还没有可用于记忆抽取的文本模型/)).toBeTruthy();
  });

  it('记忆模型下拉排除嵌入模型（名称规则）', async () => {
    mocks.fetchProviders.mockResolvedValue([
      {
        id: 'p1',
        name: 'DeepSeek',
        base_url: 'https://api.deepseek.com',
        api_key: 'k',
        models: ['deepseek-chat', 'doubao-embedding-large'],
      },
    ]);
    await mount();
    expect(screen.queryByText(/还没有可用于记忆抽取的文本模型/)).toBeNull();
    const selectView = document.querySelector('.arco-select-view');
    expect(selectView).toBeTruthy();
    fireEvent.click(selectView as HTMLElement);
    expect(await screen.findByText('DeepSeek / deepseek-chat')).toBeTruthy();
    expect(screen.queryByText('DeepSeek / doubao-embedding-large')).toBeNull();
  });

  it('用户在模型页显式标记为嵌入的模型同样被排除', async () => {
    mocks.fetchProviders.mockResolvedValue([
      {
        id: 'p2',
        name: '自定义',
        base_url: 'https://example.com/v1',
        api_key: 'k',
        models: ['my-embedder'],
        model_settings: { 'my-embedder': { is_embedding: true } },
      },
    ]);
    await mount();
    expect(screen.getByText(/还没有可用于记忆抽取的文本模型/)).toBeTruthy();
  });
});

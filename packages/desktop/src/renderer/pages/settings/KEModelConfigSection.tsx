// E-26 S3：知识引擎模型配置——四角色选择器（对话/文本抽取/图片抽取/嵌入），
// 候选项从 AionUI 已配置的模型中按能力过滤；选中后写入 KE-v2 model-endpoints 并激活。
// 与 KE-v2 Web 的 ModelConfig 共用同一套 API（web-operations: models.*）。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Message, Select, Space, Spin, Tag, Typography } from '@arco-design/web-react';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { fetchProviders } from '@renderer/hooks/agent/useModelProviderList';
import { readCapabilityState } from '@renderer/pages/settings/components/ModelCapabilitySwitches';
import type { IProvider } from '@/common/config/storage';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';

type KERole = 'chat' | 'grag' | 'vision' | 'embedding';

const ROLE_META: Record<KERole, { label: string; desc: string; requiredCaps: string[] }> = {
  chat: { label: '对话模型', desc: '智能问答答案合成', requiredCaps: ['text'] },
  grag: { label: '文本抽取模型', desc: '文档实体/关系抽取', requiredCaps: ['text'] },
  vision: { label: '图片抽取模型', desc: '图片理解 + 图文抽取', requiredCaps: ['vision'] },
  embedding: { label: '嵌入模型', desc: '文档嵌入检索', requiredCaps: ['embedding'] },
};

const ROLE_ORDER: KERole[] = ['chat', 'grag', 'vision', 'embedding'];

interface KEModelEndpoint {
  id: string;
  role: string;
  name: string;
  baseUrl: string;
  model: string;
  dim: number | null;
  active: boolean;
}

export const KEModelConfigSection: React.FC = () => {
  const teamEnabled = Boolean(teamBffBaseUrl());
  const [endpoints, setEndpoints] = useState<KEModelEndpoint[]>([]);
  const [providers, setProviders] = useState<IProvider[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<KERole | null>(null);

  const reload = useCallback(async () => {
    if (!teamEnabled) return;
    setLoading(true);
    try {
      const [eps, provs] = await Promise.all([teamApi.listKEModEndpoints(), fetchProviders().catch(() => [])]);
      setEndpoints(Array.isArray(eps) ? (eps as KEModelEndpoint[]) : []);
      setProviders(provs);
    } catch (error) {
      Message.error(`加载知识引擎模型失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally {
      setLoading(false);
    }
  }, [teamEnabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 按角色过滤 AionUI 模型（能力匹配）
  const modelOptions = useMemo(() => {
    const options: Record<KERole, Array<{ label: string; value: string }>> = {
      chat: [],
      grag: [],
      vision: [],
      embedding: [],
    };
    for (const provider of providers) {
      if (!provider.base_url || !provider.api_key) continue;
      for (const model of provider.models ?? []) {
        // 逐模型能力判定，与模型列表 tag / 配置模型弹窗共用同一读取逻辑
        const capState = readCapabilityState(provider, model);
        const hasVision = capState.vision;
        const hasEmbedding = capState.embedding || /embed|bge-|e5-|gte-/i.test(model);
        const label = `${provider.name} / ${model}`;
        const value = JSON.stringify({
          providerId: provider.id,
          model,
          baseUrl: provider.base_url,
          apiKey: provider.api_key,
          name: provider.name,
        });
        if (hasEmbedding) {
          options.embedding.push({ label, value });
          continue;
        }
        if (hasVision) {
          options.vision.push({ label, value });
        }
        options.chat.push({ label, value });
        options.grag.push({ label, value });
      }
    }
    return options;
  }, [providers]);

  const assignModel = useCallback(
    async (role: KERole, value: string) => {
      if (!value) return;
      setSaving(role);
      try {
        const parsed = JSON.parse(value) as {
          providerId: string;
          model: string;
          baseUrl: string;
          apiKey: string;
          name: string;
        };
        // 查找该角色是否已有激活端点
        const existing = endpoints.find((ep) => ep.role === role && ep.active);
        const input = {
          role,
          name: parsed.name,
          baseUrl: parsed.baseUrl,
          model: parsed.model,
          apiKey: parsed.apiKey,
          ...(role === 'embedding' ? { dim: 2048 } : {}),
        };
        let endpointId: string;
        if (existing) {
          await teamApi.updateKEModEndpoint(existing.id, input);
          endpointId = existing.id;
        } else {
          const created = (await teamApi.createKEModEndpoint(input)) as { id: string };
          endpointId = created.id;
        }
        await teamApi.activateKEModEndpoint(endpointId);
        Message.success(`${ROLE_META[role].label}已配置并激活：${parsed.model}`);
        await reload();
      } catch (error) {
        Message.error(`配置失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
      } finally {
        setSaving(null);
      }
    },
    [endpoints, reload]
  );

  if (!teamEnabled) {
    return (
      <Card title='知识引擎模型配置'>
        <Typography.Text type='secondary'>请先启用团队功能（设置 → 团队平台）</Typography.Text>
      </Card>
    );
  }

  return (
    <Card
      title='知识引擎模型配置'
      extra={
        <Button size='small' onClick={() => void reload()}>
          刷新
        </Button>
      }
    >
      <Typography.Text type='secondary' style={{ display: 'block', marginBottom: 12 }}>
        配置知识引擎的四个模型角色。候选项来自「模型」页已配置的模型（按能力自动过滤）。配置后与 KE-v2 Web 端同步生效。
      </Typography.Text>
      {loading ? (
        <Spin />
      ) : (
        <Space direction='vertical' size='large' style={{ width: '100%' }}>
          {ROLE_ORDER.map((role) => {
            const meta = ROLE_META[role];
            const activeEp = endpoints.find((ep) => ep.role === role && ep.active);
            return (
              <div key={role} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <div style={{ width: 200, flexShrink: 0 }}>
                  <Typography.Text bold>{meta.label}</Typography.Text>
                  <Typography.Text type='secondary' size='small' style={{ display: 'block' }}>
                    {meta.desc}
                  </Typography.Text>
                </div>
                <Select
                  style={{ flex: 1 }}
                  placeholder={`选择${meta.label}（${meta.requiredCaps.join('/')}能力的模型）`}
                  options={modelOptions[role]}
                  value={activeEp ? JSON.stringify({ model: activeEp.model }) : undefined}
                  loading={saving === role}
                  onChange={(v) => void assignModel(role, String(v))}
                  showSearch
                  allowClear
                />
                {activeEp && (
                  <Tag color='green' size='small'>
                    当前: {activeEp.name} / {activeEp.model}
                  </Tag>
                )}
              </div>
            );
          })}
        </Space>
      )}
    </Card>
  );
};

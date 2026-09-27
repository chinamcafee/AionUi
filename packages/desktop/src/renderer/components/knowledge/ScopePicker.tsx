// AionUi 移植（T4.5）：知识范围选择器（源 client components/knowledge/KnowledgeScopePicker.tsx）。
// 差异：lucide+Tailwind 弹层 → Arco Popover + Select multiple；数据契约一致
// （/teamapi/knowledge/organizers → { groups, tags }，选中 groupIds/tagIds 传给检索注入）。

import React, { useCallback, useEffect, useState } from 'react';
import { Popover, Select, Space, Spin, Tag, Typography } from '@arco-design/web-react';
import { IconFilter } from '@arco-design/web-react/icon';
import { teamBffBaseUrl } from '@/renderer/api/teamClient';

export interface KnowledgeOrganizerFilter {
  groupIds: string[];
  tagIds: string[];
}

interface OrganizerItem {
  id: string;
  name: string;
  description?: string;
  color: string;
  documentCount: number;
}

export const KnowledgeScopePicker: React.FC<{
  value: KnowledgeOrganizerFilter;
  onChange: (value: KnowledgeOrganizerFilter) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const [groups, setGroups] = useState<OrganizerItem[]>([]);
  const [tags, setTags] = useState<OrganizerItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const selectedCount = value.groupIds.length + value.tagIds.length;

  const load = useCallback(async (signal: AbortSignal) => {
    const base = teamBffBaseUrl();
    if (!base) throw new Error('TEAM_BFF_UNAVAILABLE');
    const response = await fetch(`${base}/teamapi/knowledge/organizers`, { cache: 'no-store', signal });
    const payload = (await response.json()) as {
      data?: { groups?: OrganizerItem[]; tags?: OrganizerItem[] };
      error?: { code?: string };
    };
    if (!response.ok || !Array.isArray(payload.data?.groups) || !Array.isArray(payload.data?.tags)) {
      throw new Error(payload.error?.code ?? 'ORGANIZER_RESPONSE_INVALID');
    }
    return payload.data;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    load(controller.signal)
      .then((data) => {
        setGroups(data.groups!);
        setTags(data.tags!);
      })
      .catch((reason: unknown) => {
        if ((reason as Error)?.name !== 'AbortError') setError('分组与标签暂时无法加载');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [load]);

  const toOptions = (items: OrganizerItem[]) =>
    items.map((item) => ({ label: `${item.name}（${item.documentCount}）`, value: item.id }));

  const content = (
    <Space direction='vertical' size='small' style={{ width: 280 }}>
      {loading ? (
        <Spin />
      ) : error ? (
        <Typography.Text type='error'>{error}</Typography.Text>
      ) : (
        <>
          <Typography.Text type='secondary' size='small'>
            分组
          </Typography.Text>
          <Select
            size='small'
            mode='multiple'
            allowClear
            placeholder='限定检索的分组'
            options={toOptions(groups)}
            value={value.groupIds}
            onChange={(groupIds) => onChange({ ...value, groupIds: groupIds as string[] })}
          />
          <Typography.Text type='secondary' size='small'>
            标签
          </Typography.Text>
          <Select
            size='small'
            mode='multiple'
            allowClear
            placeholder='限定检索的标签'
            options={toOptions(tags)}
            value={value.tagIds}
            onChange={(tagIds) => onChange({ ...value, tagIds: tagIds as string[] })}
          />
        </>
      )}
    </Space>
  );

  return (
    <Popover trigger='click' content={content}>
      <Space size={4} style={{ cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}>
        <IconFilter />
        <Typography.Text size='small'>知识范围</Typography.Text>
        {selectedCount > 0 && (
          <Tag size='small' color='arcoblue'>
            {selectedCount}
          </Tag>
        )}
      </Space>
    </Popover>
  );
};

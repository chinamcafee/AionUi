// E-23 K9：知识图谱 Tab——reagraph 3D 力导图 + 实体/关系/社区详情列表 + 重建。
// 对齐 KE-v2 KnowledgeGraph 功能；UI 用 Arco。

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Collapse, Empty, Input, Message, Popconfirm,
  Space, Spin, Statistic, Tag, Typography,
} from '@arco-design/web-react';
import { IconRefresh, IconSearch } from '@arco-design/web-react/icon';
import { GraphCanvas } from 'reagraph';
import { teamApi, TeamApiError } from '@/renderer/api/teamClient';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import type { GraphSubgraph, GraphStats, GraphReport, TeamGraphSummary, GraphNode, GraphLink } from './types';

const TYPE_COLORS: Record<string, string> = {
  organization: '#626ea3', person: '#e86e6e', concept: '#4caf7d', technology: '#d4a72c',
  event: '#9b59b6', product: '#3498db', metric: '#e67e22', process: '#1abc9c',
};
const FALLBACK_COLOR = '#95a5a6';
const COMMUNITY_PALETTE = ['#626ea3', '#e86e6e', '#4caf7d', '#d4a72c', '#9b59b6', '#3498db', '#e67e22', '#1abc9c', '#e74c3c', '#34495e'];

// ── 3D 图谱 ──
const Graph3D: React.FC<{ subgraph: GraphSubgraph; filter: string }> = ({ subgraph, filter }) => {
  const { nodes, links, communities } = subgraph;

  const communityColorMap = useMemo(() => {
    const map = new Map<string, string>();
    communities.forEach((c, i) => map.set(c.id, COMMUNITY_PALETTE[i % COMMUNITY_PALETTE.length]));
    return map;
  }, [communities]);

  const { rNodes, rLinks, matchedIds } = useMemo(() => {
    const degreeMap = new Map<string, number>();
    links.forEach((l) => {
      degreeMap.set(l.from, (degreeMap.get(l.from) ?? 0) + 1);
      degreeMap.set(l.to, (degreeMap.get(l.to) ?? 0) + 1);
    });
    const matched = new Set<string>();
    if (filter.trim()) {
      const q = filter.toLowerCase();
      nodes.forEach((n) => { if (n.title.toLowerCase().includes(q)) { matched.add(n.id); links.forEach((l) => { if (l.from === n.id) matched.add(l.to); if (l.to === n.id) matched.add(l.from); }); } });
    }
    const rn = nodes.map((n) => ({
      id: n.id, label: n.title,
      size: Math.min(6 + (degreeMap.get(n.id) ?? 0) * 1.5, 24),
      color: (n.communityIds?.[0] && communityColorMap.get(n.communityIds[0])) ?? TYPE_COLORS[n.type] ?? FALLBACK_COLOR,
      labelVisible: (degreeMap.get(n.id) ?? 0) > 3 && (!filter.trim() || matched.has(n.id)),
      data: { cluster: n.communityIds?.[0] ?? n.type },
    }));
    const sortedLinks = [...links].sort((a, b) => b.weight - a.weight).slice(0, 500);
    const rl = sortedLinks.map((l, i) => ({
      id: `link-${i}`, source: l.from, target: l.to,
      size: Math.max(0.5, l.weight / 5),
    }));
    return { rNodes: rn, rLinks: rl, matchedIds: matched };
  }, [nodes, links, filter, communityColorMap]);

  if (nodes.length === 0) return <Empty description='暂无图谱数据' />;

  return (
    <div style={{ height: 480, borderRadius: 8, border: '1px solid var(--color-border-2)', overflow: 'hidden' }}>
      <GraphCanvas
        nodes={rNodes} edges={rLinks}
        layoutType='forceDirected2d' draggable
        clusterAttribute='cluster'
        labelFont='12px sans-serif'
      />
    </div>
  );
};

// ── 详情列表 ──
const DetailsPanel: React.FC<{ subgraph: GraphSubgraph; reports: GraphReport[] }> = ({ subgraph, reports }) => (
  <Space direction='vertical' size='large' style={{ width: '100%' }}>
    <Collapse bordered={false}>
      <Collapse.Item name='entities' header={`实体（${subgraph.nodes.length}）`}>
        {subgraph.nodes.slice(0, 50).map((n) => (
          <div key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: TYPE_COLORS[n.type] ?? FALLBACK_COLOR }} />
            <Typography.Text bold size='small'>{n.title}</Typography.Text>
            <Tag size='small'>{n.type}</Tag>
            {n.degree && <Tag size='small' color='arcoblue'>度 {n.degree}</Tag>}
            {n.description && <Typography.Text type='secondary' size='small'>{n.description.slice(0, 80)}</Typography.Text>}
          </div>
        ))}
      </Collapse.Item>
      <Collapse.Item name='relations' header={`关系（${subgraph.links.length}）`}>
        {subgraph.links.slice(0, 100).map((l, i) => (
          <div key={i} style={{ padding: '3px 0', fontSize: 13 }}>
            <Typography.Text size='small'>
              {subgraph.nodes.find((n) => n.id === l.from)?.title ?? l.from}
              <span style={{ color: 'var(--color-primary-6)' }}> →{l.weight.toFixed(1)}→ </span>
              {subgraph.nodes.find((n) => n.id === l.to)?.title ?? l.to}
            </Typography.Text>
            {l.description && <Typography.Text type='secondary' size='small' style={{ marginLeft: 8 }}>{l.description.slice(0, 60)}</Typography.Text>}
          </div>
        ))}
      </Collapse.Item>
      <Collapse.Item name='communities' header={`社区（${subgraph.communities.length}）`}>
        {subgraph.communities.map((c) => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <Tag size='small' color='arcoblue'>{c.id.slice(0, 8)}</Tag>
            <Typography.Text size='small'>{c.title}</Typography.Text>
            {c.size != null && <Tag size='small'>{c.size} 成员</Tag>}
            {c.level != null && <Tag size='small' color='purple'>L{c.level}</Tag>}
          </div>
        ))}
      </Collapse.Item>
      <Collapse.Item name='reports' header={`社区报告（${reports.length}）`}>
        {reports.map((r) => (
          <Card key={r.id} size='small' style={{ marginBottom: 8 }}>
            <Space size={6}>
              <Typography.Text bold size='small'>{r.title}</Typography.Text>
              {r.rank != null && <Tag size='small' color='gold'>#{r.rank}</Tag>}
            </Space>
            {r.summary && <Typography.Paragraph size='small' style={{ marginBottom: 0, marginTop: 4 }}>{r.summary}</Typography.Paragraph>}
          </Card>
        ))}
        {reports.length === 0 && <Empty description='暂无报告' />}
      </Collapse.Item>
    </Collapse>
  </Space>
);

export const GraphTab: React.FC = () => {
  const { view, hasPermission } = useTeamAuth();
  const [subgraph, setSubgraph] = useState<GraphSubgraph | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [summary, setSummary] = useState<TeamGraphSummary | null>(null);
  const [reports, setReports] = useState<GraphReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [rebuilding, setRebuilding] = useState(false);
  const [view3D, setView3D] = useState(true);
  const canRebuild = hasPermission('knowledge.rebuild');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [graph, statsResult, reportsResult, summaryResult] = await Promise.allSettled([
        teamApi.getGraph({ limit: 200 }),
        teamApi.getGraphStats(),
        teamApi.getGraphReports(),
        teamApi.getGraphSummary(),
      ]);
      if (graph.status === 'fulfilled') setSubgraph(graph.value as GraphSubgraph);
      if (statsResult.status === 'fulfilled') setStats(statsResult.value as GraphStats);
      if (reportsResult.status === 'fulfilled') setReports(((reportsResult.value as { reports?: GraphReport[] })?.reports ?? []) as GraphReport[]);
      if (summaryResult.status === 'fulfilled') setSummary(summaryResult.value as TeamGraphSummary);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rebuild = useCallback(async () => {
    setRebuilding(true);
    try {
      await teamApi.rebuildGraph();
      Message.success('图谱重建已启动');
      setTimeout(() => void load(), 3000);
    } catch (error) {
      Message.error(`重建失败：${error instanceof TeamApiError ? error.code : '未知错误'}`);
    } finally { setRebuilding(false); }
  }, [load]);

  if (view.phase !== 'authenticated') return <Empty description='请先登录团队账号' />;

  return (
    <Space direction='vertical' size='large' style={{ width: '100%' }}>
      <Card title='知识图谱' extra={(
        <Space>
          <Input size='small' style={{ width: 160 }} prefix={<IconSearch />} placeholder='过滤实体' value={filter} onChange={setFilter} allowClear />
          <Button size='small' onClick={() => setView3D(v => !v)}>{view3D ? '详情列表' : '3D 图谱'}</Button>
          <Button size='small' icon={<IconRefresh />} onClick={() => void load()}>刷新</Button>
          {canRebuild && (
            <Popconfirm title='确认重建图谱？' onOk={() => void rebuild()}>
              <Button size='small' type='primary' loading={rebuilding}>重建</Button>
            </Popconfirm>
          )}
        </Space>
      )}>
        {loading ? <div style={{ textAlign: 'center', padding: 48 }}><Spin tip='加载图谱数据…' /></div> : (
          <Space direction='vertical' size='large' style={{ width: '100%' }}>
            {stats && (
              <Space size='large'>
                <Statistic title='实体' value={stats.entities} />
                <Statistic title='关系' value={stats.relationships} />
                <Statistic title='社区' value={stats.communities} />
                <Statistic title='报告' value={stats.reports} />
                {summary && <Statistic title='文档' value={summary.documents ?? 0} />}
              </Space>
            )}
            {view3D && subgraph ? <Graph3D subgraph={subgraph} filter={filter} /> : subgraph ? <DetailsPanel subgraph={subgraph} reports={reports} /> : <Empty description='暂无图谱数据' />}
          </Space>
        )}
      </Card>
    </Space>
  );
};

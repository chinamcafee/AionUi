// 2026-09-29：整理链路的分类支撑——create_category 解析/应用、categoryId 校验与引用降级
// （docs/team/05-记忆分类体系-技术评估报告.md §3.4、决策 D2/D3/D5）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  createMemory,
  findMemoryCategoryByName,
  getMemory,
  listMemories,
} from '@/process/services/teamBff/modules/memory/memory-store';
import {
  applyConsolidationOperations,
  MAX_NEW_CATEGORIES_PER_RUN,
  parseConsolidationPlan,
  type ConsolidationCategoryContext,
  type ConsolidationOperation,
} from '@/process/services/teamBff/modules/memory/memory-service';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';

const CONTEXT: ConsolidationCategoryContext = {
  ids: new Set(['preference', 'fact', 'requirement', 'event']),
  names: new Set(['偏好习惯', '个人事实']),
};

describe('parseConsolidationPlan：分类与新建分类操作', () => {
  it('create_category：解析说明、计划内/现存放内重名跳过、单次上限', () => {
    const raw = JSON.stringify({
      summary: 's',
      operations: [
        { type: 'create_category', name: ' 工作流程 ', description: '与工作推进相关', reason: 'r' },
        { type: 'create_category', name: '工作流程', reason: '计划内重复' },
        { type: 'create_category', name: '个人事实', reason: '与现存放内重名' },
        ...Array.from({ length: 12 }, (_, index) => ({
          type: 'create_category',
          name: `新分类${index}`,
          reason: 'r',
        })),
      ],
    });
    const plan = parseConsolidationPlan(raw, [], {}, CONTEXT);
    const creates = plan.operations.filter((op) => op.type === 'create_category');
    expect(creates).toHaveLength(MAX_NEW_CATEGORIES_PER_RUN);
    expect(creates[0]).toMatchObject({ name: '工作流程', description: '与工作推进相关' });
    expect(creates.some((op) => op.type === 'create_category' && op.name === '个人事实')).toBe(false);
  });

  it('merge/update 指派：现存 id 生效、未知 id 忽略、categoryName 仅限本次新建、null=未分类', () => {
    const raw = JSON.stringify({
      summary: 's',
      operations: [
        { type: 'update', id: 'm1', title: 't1', categoryId: 'fact', reason: 'r' },
        { type: 'update', id: 'm2', title: 't2', categoryId: 'ghost', reason: 'r' },
        { type: 'update', id: 'm3', categoryId: 'ghost', reason: 'r' },
        { type: 'update', id: 'm4', categoryId: null, reason: 'r' },
        { type: 'create_category', name: '新域', reason: 'r' },
        { type: 'update', id: 'm5', categoryName: '新域', reason: 'r' },
        { type: 'update', id: 'm6', title: 't6', categoryName: '并未新建的名字', reason: 'r' },
        {
          type: 'merge',
          targetId: 'm7',
          sourceIds: ['m8'],
          title: '合并标题',
          content: '合并内容',
          categoryName: '新域',
          reason: 'r',
        },
      ],
    });
    const plan = parseConsolidationPlan(raw, ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], {}, CONTEXT);
    const byId = (id: string) => plan.operations.find((op) => op.id === id);
    expect(byId('m1')).toMatchObject({ categoryId: 'fact' });
    expect(byId('m2')?.categoryId).toBeUndefined();
    expect(byId('m3')).toBeUndefined(); // 仅有未知分类、无其他有效字段 → 丢弃
    expect(byId('m4')).toMatchObject({ categoryId: null });
    expect(byId('m5')).toMatchObject({ categoryName: '新域' });
    expect(byId('m6')?.categoryName).toBeUndefined();
    const merge = byId('merge-m7-m8');
    expect(merge).toMatchObject({ type: 'merge', categoryName: '新域' });
    expect(merge?.targetBaseVersion).toBeUndefined();
  });
});

describe('applyConsolidationOperations：新建分类落库与指派解析', () => {
  let root: string;
  let runtime: AccountRuntimeManager;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'aionui-memory-consolidate-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
  });

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('先建分类再应用 merge 指派；已存在同名分类时复用不重复建', async () => {
    const a = await createMemory({ title: 'A', content: 'a', scope: 'chat' });
    const b = await createMemory({ title: 'B', content: 'b', scope: 'chat' });
    const ops: ConsolidationOperation[] = [
      { id: 'create-category-工作', type: 'create_category', name: '工作', description: '工作相关', reason: 'r' },
      {
        id: 'merge-ab',
        type: 'merge',
        targetId: a.id,
        targetBaseVersion: a.version,
        sourceIds: [b.id],
        sourceBaseVersions: { [b.id]: b.version },
        title: 'AB',
        content: 'ab',
        categoryName: '工作',
        reason: 'r',
      },
    ];
    const applied = await applyConsolidationOperations(ops);
    expect(applied).toBe(2);
    const work = await findMemoryCategoryByName('工作');
    expect(work?.source).toBe('consolidated');
    const merged = await getMemory(a.id);
    expect(merged?.title).toBe('AB');
    expect(merged?.categoryId).toBe(work?.id);
    expect((await listMemories()).some((memory) => memory.id === b.id)).toBe(false);

    // 再次应用同名 create：复用既有分类，不重复建
    const again = await applyConsolidationOperations([
      { id: 'create-category-工作', type: 'create_category', name: '工作', reason: 'r' },
    ]);
    expect(again).toBe(0);
  });

  it('未包含 create 操作时，categoryName 引用降级为「不改分类」；categoryId=null 落未分类', async () => {
    const c = await createMemory({ title: 'C', content: 'c', categoryId: 'fact', scope: 'chat' });
    const applied = await applyConsolidationOperations([
      {
        id: 'u1',
        type: 'update',
        targetId: c.id,
        baseVersion: c.version,
        title: 'C2',
        categoryName: '不存在',
        reason: 'r',
      },
    ]);
    expect(applied).toBe(1);
    const afterUpdate = await getMemory(c.id);
    expect(afterUpdate?.title).toBe('C2');
    expect(afterUpdate?.categoryId).toBe('fact');

    const appliedUncategorized = await applyConsolidationOperations([
      { id: 'u2', type: 'update', targetId: c.id, baseVersion: afterUpdate!.version, categoryId: null, reason: 'r' },
    ]);
    expect(appliedUncategorized).toBe(1);
    expect((await getMemory(c.id))?.categoryId).toBeNull();
  });
});

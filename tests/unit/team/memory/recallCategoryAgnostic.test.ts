// 2026-09-29：召回与分类解耦的回归验证（报告 §1.1/§3.6）——
// 分类仅作归档维度：召回不按分类过滤、分类不进嵌入文本与渲染行。
// 用同一关键词、不同分类（含未分类）的记忆验证「跨分类相似关键词」仍被召回。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import { createMemory, createMemoryCategory } from '@/process/services/teamBff/modules/memory/memory-store';
import { retrieveHybridMemories } from '@/process/services/teamBff/modules/memory/memory-search';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';

describe('召回与分类解耦（分类不参与过滤/排序）', () => {
  let runtime: AccountRuntimeManager;

  beforeEach(async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-memory-recall-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
  });

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('跨分类相似关键词全部命中（含未分类），命中文本不含分类信息', async () => {
    const category = await createMemoryCategory({ name: '研发流程' });
    const inCategory = await createMemory({
      title: '部署流程 A',
      content: '发布前需要做灰度验证',
      categoryId: category.id,
      scope: 'chat',
    });
    const inSeedCategory = await createMemory({
      title: '部署流程 B',
      content: '灰度验证通过后再全量发布',
      categoryId: 'requirement',
      scope: 'chat',
    });
    const uncategorized = await createMemory({
      title: '部署流程 C',
      content: '灰度验证记录要留档',
      scope: 'chat',
    });

    const hits = await retrieveHybridMemories('灰度验证', 'chat', 8);
    const hitIds = hits.map((hit) => hit.memory.id);
    expect(hitIds).toContain(inCategory.id);
    expect(hitIds).toContain(inSeedCategory.id);
    expect(hitIds).toContain(uncategorized.id);
    // 分类名不进入命中文本（嵌入文本为 title+content）
    for (const hit of hits) {
      expect(`${hit.memory.title}\n${hit.memory.content}`).not.toContain('研发流程');
    }
  });
});

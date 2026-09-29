// M2（T2.11）：个人记忆 store 移植验证。上游模块以单例 accountRuntime 访问，
// 测试内 bind 到临时 AccountRuntimeManager，验证 CRUD/乐观锁/scope/多账号隔离。
// 2026-09-29：分类体系（可管理分类 + 归档式删除 + 引用迁移，docs/team/05-记忆分类体系-技术评估报告.md）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import {
  archiveMemoryCategory,
  createMemory,
  createMemoryCategory,
  deleteMemory,
  findMemoryCategoryByName,
  getMemory,
  listMemories,
  listMemoryCategories,
  updateMemory,
  updateMemoryCategory,
  UNCATEGORIZED_FILTER,
  type MemoryEntry,
} from '@/process/services/teamBff/modules/memory/memory-store';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';

async function activateAccount(root: string, tenantMemberId = M1) {
  const runtime = new AccountRuntimeManager(root);
  bindAccountRuntime(runtime);
  await runtime.activate({ tenantId: T1, tenantMemberId, activeTeamId: TEAM_A });
  return runtime;
}

let previousRuntime: AccountRuntimeManager | null = null;
/** 换库前先 deactivate：触发 memory-store 的 cacheInvalidator（initialization/clocks 清空），避免跨库复用旧建表标记。 */
async function retire(runtime: AccountRuntimeManager) {
  previousRuntime = runtime;
  await runtime.deactivate();
}

describe('memory-store（移植自 client server/memory-store.ts）', () => {
  let root: string;
  let runtime: AccountRuntimeManager;

  beforeEach(async () => {
    if (previousRuntime) {
      await previousRuntime.deactivate();
      previousRuntime = null;
    }
    root = mkdtempSync(path.join(tmpdir(), 'aionui-memory-test-'));
    runtime = await activateAccount(root);
  });

  afterEach(async () => {
    await retire(runtime);
  });

  it('种子分类：新账号初始化即有 4 个内置分类（id 沿用旧枚举值）', async () => {
    const categories = await listMemoryCategories();
    expect(categories.map((category) => category.id)).toEqual(['preference', 'fact', 'requirement', 'event']);
    expect(categories.map((category) => category.name)).toEqual(['偏好习惯', '个人事实', '要求约束', '重要事件']);
    expect(categories.every((category) => category.archivedAt === null && category.source === 'manual')).toBe(true);
  });

  it('创建/列表/搜索：createMemory 返回条目，listMemories 按分类/未分类/scope/关键词过滤', async () => {
    const created = await createMemory({
      title: '偏好：深色主题',
      content: '用户偏好深色界面',
      categoryId: 'preference',
      scope: 'chat',
    });
    expect(created.title).toBe('偏好：深色主题');
    expect(created.categoryId).toBe('preference');
    await createMemory({
      title: '事实：常用语言',
      content: '用户主要使用 TypeScript',
      categoryName: '个人事实',
      scope: 'code',
    });
    const uncategorized = await createMemory({ title: '未归档条目', content: '还没有分类', scope: 'chat' });
    expect(uncategorized.categoryId).toBeNull();

    const all = await listMemories();
    expect(all.length).toBeGreaterThanOrEqual(3);
    const preferences = await listMemories('preference');
    expect(preferences.length).toBe(1);
    expect(preferences.every((m) => m.categoryId === 'preference')).toBe(true);
    const facts = await listMemories('fact');
    expect(facts.some((m) => m.title.includes('常用语言'))).toBe(true);
    const uncategorizedOnly = await listMemories(UNCATEGORIZED_FILTER);
    expect(uncategorizedOnly.map((m) => m.id)).toEqual([uncategorized.id]);
    const codeOnly = await listMemories(undefined, undefined, 'code');
    expect(codeOnly.every((m) => m.scope === 'code')).toBe(true);
    const hit = await listMemories(undefined, 'TypeScript');
    expect(hit.some((m) => m.title.includes('常用语言'))).toBe(true);
  });

  it('分类 CRUD：名称长度/重名校验、改名、名称大小写归一查找', async () => {
    const created = await createMemoryCategory({ name: '工作流程', description: '与工作推进相关的流程' });
    expect(created.name).toBe('工作流程');
    await expect(createMemoryCategory({ name: '工作流程' })).rejects.toThrow('CATEGORY_NAME_DUPLICATE');
    await expect(createMemoryCategory({ name: '这个名字明显超过了二十个字符的上限啦真的超了' })).rejects.toThrow(
      'CATEGORY_NAME_INVALID'
    );
    const renamed = await updateMemoryCategory(created.id, { name: '  工作 流程  ' }, created.version);
    expect(renamed.name).toBe('工作 流程');
    const found = await findMemoryCategoryByName('工作 流程');
    expect(found?.id).toBe(created.id);
    await expect(updateMemoryCategory(created.id, { name: '个人事实' }, renamed.version)).rejects.toThrow(
      'CATEGORY_NAME_DUPLICATE'
    );
  });

  it('归档式删除（D3）：引用记忆先迁往目标分类或未分类，记忆版本 +1，分类从活跃列表消失', async () => {
    const temp = await createMemoryCategory({ name: '临时分类' });
    const moved = await createMemory({ title: '将迁移', content: 'a', categoryId: temp.id, scope: 'chat' });
    const kept = await createMemory({ title: '将未分类', content: 'b', categoryId: temp.id, scope: 'chat' });

    const result = await archiveMemoryCategory(temp.id, temp.version, 'fact');
    expect(result.reassigned).toBe(2);

    const movedAfter = await getMemory(moved.id);
    expect(movedAfter?.categoryId).toBe('fact');
    expect(movedAfter?.version).toBe(moved.version + 1);
    expect((await getMemory(kept.id))?.categoryId).toBe('fact');

    expect((await listMemoryCategories()).some((category) => category.id === temp.id)).toBe(false);
    const withArchived = await listMemoryCategories({ includeArchived: true });
    expect(withArchived.find((category) => category.id === temp.id)?.archivedAt).not.toBeNull();
    // 归档后名称释放：可再次创建同名分类
    const recreated = await createMemoryCategory({ name: '临时分类' });
    expect(recreated.id).not.toBe(temp.id);

    // 归档时选择「未分类」目标：引用记忆落未分类
    const dangling = await createMemory({
      title: '落未分类',
      content: 'c',
      categoryId: recreated.id,
      scope: 'chat',
    });
    const result2 = await archiveMemoryCategory(recreated.id, recreated.version, null);
    expect(result2.reassigned).toBe(1);
    expect((await getMemory(dangling.id))?.categoryId).toBeNull();
    const uncategorized = await listMemories(UNCATEGORIZED_FILTER);
    expect(uncategorized.map((m) => m.id)).toEqual([dangling.id]);
  });

  it('分类引用校验：未知分类 id 拒绝写入/更新', async () => {
    await expect(createMemory({ title: 'x', content: 'y', categoryId: 'not-exist', scope: 'chat' })).rejects.toThrow(
      'CATEGORY_NOT_FOUND'
    );
    const created = await createMemory({ title: 'x', content: 'y', scope: 'chat' });
    await expect(updateMemory(created.id, { categoryId: 'not-exist' }, created.version)).rejects.toThrow(
      'CATEGORY_NOT_FOUND'
    );
  });

  it('更新带乐观锁：baseVersion 缺失/过期报冲突，正确版本更新成功', async () => {
    const created = (await createMemory({
      title: '要求',
      content: '回答需简洁',
      categoryId: 'requirement',
      scope: 'chat',
    })) as MemoryEntry;
    await expect(updateMemory(created.id, { title: '要求 v2' })).rejects.toThrow('MEMORY_BASE_VERSION_REQUIRED');
    await expect(
      updateMemory(created.id, { title: '要求 v2' }, (created as unknown as { version: number }).version + 5)
    ).rejects.toThrow(/VERSION|CONFLICT/);
    const updated = (await updateMemory(
      created.id,
      { title: '要求 v2', content: '回答需简洁并给出示例' },
      (created as unknown as { version: number }).version
    )) as MemoryEntry;
    expect(updated.title).toBe('要求 v2');
  });

  it('删除同样校验 baseVersion；删除后列表不含该条', async () => {
    const created = (await createMemory({
      title: '待删',
      content: 'x',
      categoryId: 'fact',
      scope: 'chat',
    })) as MemoryEntry;
    await expect(deleteMemory(created.id)).rejects.toThrow();
    await deleteMemory(created.id, (created as unknown as { version: number }).version);
    const all = await listMemories();
    expect(all.some((m) => m.id === created.id)).toBe(false);
  });

  it('多账号隔离：另一成员的库看不到 A 的记忆与分类', async () => {
    const category = await createMemoryCategory({ name: 'A 的专属分类' });
    (await createMemory({
      title: 'A 的秘密',
      content: '只属于 A',
      categoryId: category.id,
      scope: 'chat',
    })) as MemoryEntry;
    await retire(runtime);
    const runtimeB = await activateAccount(root, '018f0000-0000-7000-8000-00000000000b');
    const empty = await listMemories();
    expect(empty.some((m) => m.title === 'A 的秘密')).toBe(false);
    const categoriesB = await listMemoryCategories();
    expect(categoriesB.some((item) => item.name === 'A 的专属分类')).toBe(false);
    await retire(runtimeB);
  });
});

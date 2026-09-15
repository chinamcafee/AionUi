// M2（T2.11）：个人记忆 store 移植验证。上游模块以单例 accountRuntime 访问，
// 测试内 bind 到临时 AccountRuntimeManager，验证 CRUD/乐观锁/scope/多账号隔离。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import { createMemory, deleteMemory, listMemories, updateMemory, type MemoryEntry } from '@/process/services/teamBff/modules/memory/memory-store';

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

  it('创建/列表/搜索：createMemory 返回条目，listMemories 按 category/scope/关键词过滤', async () => {
    const created = await createMemory({ title: '偏好：深色主题', content: '用户偏好深色界面', category: 'preference', scope: 'chat' }) as MemoryEntry;
    expect(created.title).toBe('偏好：深色主题');
    await createMemory({ title: '事实：常用语言', content: '用户主要使用 TypeScript', category: 'fact', scope: 'code' }) as MemoryEntry;

    const all = await listMemories();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const preferences = await listMemories('preference');
    expect(preferences.every((m) => m.category === 'preference')).toBe(true);
    const codeOnly = await listMemories(undefined, undefined, 'code');
    expect(codeOnly.every((m) => m.scope === 'code')).toBe(true);
    const hit = await listMemories(undefined, 'TypeScript');
    expect(hit.some((m) => m.title.includes('常用语言'))).toBe(true);
  });

  it('更新带乐观锁：baseVersion 缺失/过期报冲突，正确版本更新成功', async () => {
    const created = await createMemory({ title: '要求', content: '回答需简洁', category: 'requirement', scope: 'chat' }) as MemoryEntry;
    await expect(updateMemory(created.id, { title: '要求 v2' })).rejects.toThrow('MEMORY_BASE_VERSION_REQUIRED');
    await expect(updateMemory(created.id, { title: '要求 v2' }, (created as unknown as { version: number }).version + 5))
      .rejects.toThrow(/VERSION|CONFLICT/);
    const updated = await updateMemory(created.id, { title: '要求 v2', content: '回答需简洁并给出示例' }, (created as unknown as { version: number }).version) as MemoryEntry;
    expect(updated.title).toBe('要求 v2');
  });

  it('删除同样校验 baseVersion；删除后列表不含该条', async () => {
    const created = await createMemory({ title: '待删', content: 'x', category: 'fact', scope: 'chat' }) as MemoryEntry;
    await expect(deleteMemory(created.id)).rejects.toThrow();
    await deleteMemory(created.id, (created as unknown as { version: number }).version);
    const all = await listMemories();
    expect(all.some((m) => m.id === created.id)).toBe(false);
  });

  it('多账号隔离：另一成员的库看不到 A 的记忆', async () => {
    await createMemory({ title: 'A 的秘密', content: '只属于 A', category: 'fact', scope: 'chat' }) as MemoryEntry;
    await retire(runtime);
    const runtimeB = await activateAccount(root, '018f0000-0000-7000-8000-00000000000b');
    const empty = await listMemories();
    expect(empty.some((m) => m.title === 'A 的秘密')).toBe(false);
    await retire(runtimeB);
  });
});

// 2026-09-29：旧库（category 枚举列）→ 分类体系（category_id）迁移验证。
// 用户本地 memory.db 为改造前结构：初始化必须完成「加列 → 回填 → 删旧索引/旧列」，且回填后
// 旧枚举值与种子分类 id 对齐（语义不丢）。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { bindAccountRuntime } from '@/process/services/teamBff/modules/memory/account-runtime';
import { listMemories, listMemoryCategories } from '@/process/services/teamBff/modules/memory/memory-store';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';

describe('memory-store 旧库迁移（category → category_id）', () => {
  let runtime: AccountRuntimeManager;

  afterEach(async () => {
    await runtime.deactivate();
  });

  it('旧 schema 库初始化后保留记忆、回填分类 id 并移除旧列', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aionui-memory-migrate-'));
    runtime = new AccountRuntimeManager(root);
    bindAccountRuntime(runtime);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });

    // 手工建「改造前」表结构与一条旧记忆（模拟用户本地库）
    const database = runtime.database('memory');
    const now = Date.now();
    await database.execute(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL DEFAULT 'fact',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT DEFAULT 'manual',
        scope TEXT NOT NULL DEFAULT 'chat',
        pinned INTEGER NOT NULL DEFAULT 0,
        tenant_id TEXT,
        tenant_member_id TEXT,
        context_team_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        hlc TEXT,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    await database.execute(`CREATE INDEX idx_memories_category ON memories (category)`);
    await database.execute({
      sql: `INSERT INTO memories(id,category,title,content,source,scope,pinned,tenant_id,tenant_member_id,
        context_team_id,version,hlc,deleted_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,0,?,?,NULL,1,?,NULL,?,?)`,
      args: ['legacy-1', 'requirement', '旧记忆', '旧内容', 'manual', 'chat', T1, M1, `${String(now).padStart(13, '0')}:000000`, now, now],
    });

    // 首次经 store 访问触发初始化 → 迁移
    const memories = await listMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].categoryId).toBe('requirement');
    expect(memories[0].title).toBe('旧记忆');

    // 旧列已移除（对旧列名的查询应失败）
    await expect(database.execute('SELECT category FROM memories')).rejects.toThrow();

    // 种子分类就绪，且新分类可按 id 过滤
    const categories = await listMemoryCategories();
    expect(categories).toHaveLength(4);
    const requirements = await listMemories('requirement');
    expect(requirements.map((memory) => memory.id)).toEqual(['legacy-1']);
  });
});

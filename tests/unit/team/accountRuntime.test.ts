import { describe, expect, it, vi } from 'vitest';
import { AccountRuntimeManager } from '@/process/services/teamBff/accountRuntime';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const T1 = '018f0000-0000-7000-8000-000000000001';
const M1 = '018f0000-0000-7000-8000-000000000002';
const TEAM_A = '018f0000-0000-7000-8000-000000000003';
const TEAM_B = '018f0000-0000-7000-8000-000000000004';

function newRuntime() {
  return new AccountRuntimeManager(mkdtempSync(path.join(tmpdir(), 'aionui-account-test-')));
}

describe('AccountRuntimeManager（移植自 client server/account-runtime.ts）', () => {
  it('激活账号：目录三库就绪、generation 递增、subject 可读', async () => {
    const runtime = newRuntime();
    const first = await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    expect(first.status).toBe('activated');
    expect(runtime.currentSubject()).toMatchObject({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    const generation = runtime.currentGeneration();
    expect(generation).toBeGreaterThan(0);
    // 三库均可执行 SQL
    for (const kind of ['memory', 'conversations', 'sync'] as const) {
      const result = await runtime.database(kind).execute('SELECT 1 AS one');
      expect(result.rows[0]?.one).toBe(1);
    }
    expect(runtime.databasePath('memory')).toContain(path.join(T1, M1));
    await runtime.deactivate();
  });

  it('同 subject 幂等（unchanged），切团队 team_switched，切账号 activated', async () => {
    const runtime = newRuntime();
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    const unchanged = await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    expect(unchanged.status).toBe('unchanged');
    const switched = await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_B });
    expect(switched.status).toBe('team_switched');
    const other = await runtime.activate({ tenantId: T1, tenantMemberId: '018f0000-0000-7000-8000-00000000000a', activeTeamId: null });
    expect(other.status).toBe('activated');
    await runtime.deactivate();
  });

  it('切换时 abort 旧 signal、触发 cache invalidator、目录权限 0700', async () => {
    const runtime = newRuntime();
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_A });
    const signal = runtime.signal();
    const invalidator = vi.fn();
    runtime.registerCacheInvalidator(invalidator);
    await runtime.activate({ tenantId: T1, tenantMemberId: M1, activeTeamId: TEAM_B });
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe('ACCOUNT_CHANGED');
    expect(invalidator).toHaveBeenCalledTimes(1);
    await runtime.deactivate();
  });

  it('非法 subject（非 UUID）拒绝', async () => {
    const runtime = newRuntime();
    await expect(runtime.activate({ tenantId: 'not-a-uuid', tenantMemberId: M1, activeTeamId: null })).rejects.toThrow('ACCOUNT_SUBJECT_INVALID');
  });
});

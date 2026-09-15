// 移植自 client-reference/server/account-runtime.ts（上游 commit 915d14c0）。
// AionUi 适配：root 由注入提供（Electron userData 下的 aionui-team-accounts），替代 env 单例导出；
// 其余逻辑（0700 私有目录、三库 WAL、generation 失效器、串行化切换）保持一致，便于对照审计。

import { createClient, type Client } from '@libsql/client';
import { mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AccountDatabaseKind = 'memory' | 'conversations' | 'sync';

export interface AccountSubject {
  tenantId: string;
  tenantMemberId: string;
  activeTeamId: string | null;
}

interface ActiveAccountRuntime {
  subject: Readonly<AccountSubject>;
  directory: string;
  generation: number;
  controller: AbortController;
  databases: Record<AccountDatabaseKind, Client>;
}

type LifecycleHook = () => void | Promise<void>;

function validateSubject(input: AccountSubject): Readonly<AccountSubject> {
  if (!input || !UUID_PATTERN.test(input.tenantId) || !UUID_PATTERN.test(input.tenantMemberId) ||
      (input.activeTeamId !== null && !UUID_PATTERN.test(input.activeTeamId))) {
    throw new Error('ACCOUNT_SUBJECT_INVALID');
  }
  return Object.freeze({
    tenantId: input.tenantId,
    tenantMemberId: input.tenantMemberId,
    activeTeamId: input.activeTeamId,
  });
}

async function ensurePrivateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ACCOUNT_DIRECTORY_INVALID');
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('ACCOUNT_DIRECTORY_PERMISSIONS_INVALID');
}

function sameMember(left: AccountSubject, right: AccountSubject) {
  return left.tenantId === right.tenantId && left.tenantMemberId === right.tenantMemberId;
}

function sameSubject(left: AccountSubject, right: AccountSubject) {
  return sameMember(left, right) && left.activeTeamId === right.activeTeamId;
}

export class AccountRuntimeManager {
  private active: ActiveAccountRuntime | null = null;
  private generation = 0;
  private transition: Promise<unknown> = Promise.resolve();
  private readonly beforeCloseHooks = new Set<LifecycleHook>();
  private readonly cacheInvalidators = new Set<LifecycleHook>();

  constructor(private readonly accountRoot: string) {}

  registerBeforeClose(hook: LifecycleHook) {
    this.beforeCloseHooks.add(hook);
    return () => this.beforeCloseHooks.delete(hook);
  }

  registerCacheInvalidator(hook: LifecycleHook) {
    this.cacheInvalidators.add(hook);
    return () => this.cacheInvalidators.delete(hook);
  }

  currentSubject() {
    return this.active?.subject ?? null;
  }

  currentGeneration() {
    return this.active?.generation ?? 0;
  }

  currentDirectory() {
    return this.active?.directory ?? null;
  }

  signal() {
    if (!this.active) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
    return this.active.controller.signal;
  }

  database(kind: AccountDatabaseKind) {
    if (!this.active) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
    return this.active.databases[kind];
  }

  databasePath(kind: AccountDatabaseKind) {
    const directory = this.currentDirectory();
    if (!directory) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
    return path.join(directory, `${kind}.db`);
  }

  activate(input: AccountSubject) {
    return this.serialize(() => this.activateSerial(validateSubject(input)));
  }

  deactivate() {
    return this.serialize(async () => {
      if (!this.active) return { status: 'inactive' as const, generation: this.generation };
      await this.stopActive('account_deactivated');
      return { status: 'inactive' as const, generation: this.generation };
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.catch(() => undefined).then(operation);
    this.transition = next;
    return next;
  }

  private async activateSerial(subject: Readonly<AccountSubject>) {
    if (this.active && sameSubject(this.active.subject, subject)) {
      return { status: 'unchanged' as const, generation: this.active.generation, directory: this.active.directory };
    }
    const teamSwitch = !!this.active && sameMember(this.active.subject, subject);
    if (this.active) await this.stopActive('account_changed');
    const directory = path.join(this.accountRoot, subject.tenantId, subject.tenantMemberId);
    await ensurePrivateDirectory(this.accountRoot);
    await ensurePrivateDirectory(path.join(this.accountRoot, subject.tenantId));
    await ensurePrivateDirectory(directory);
    await ensurePrivateDirectory(path.join(directory, 'cache'));
    const databases = {} as Record<AccountDatabaseKind, Client>;
    try {
      for (const kind of ['memory', 'conversations', 'sync'] as const) {
        const database = createClient({ url: `file:${path.join(directory, `${kind}.db`)}` });
        await database.execute('PRAGMA journal_mode=WAL');
        databases[kind] = database;
      }
    } catch (error) {
      await Promise.all(Object.values(databases).map((database) => Promise.resolve(database.close()).catch(() => {})));
      throw error;
    }
    this.generation += 1;
    this.active = {
      subject, directory, generation: this.generation,
      controller: new AbortController(), databases,
    };
    return { status: teamSwitch ? 'team_switched' as const : 'activated' as const, generation: this.active.generation, directory };
  }

  private async stopActive(reason: string) {
    const previous = this.active;
    if (!previous) return;
    this.active = null;
    previous.controller.abort(new Error(reason === 'account_changed' ? 'ACCOUNT_CHANGED' : 'ACCOUNT_DEACTIVATED'));
    let hookError: unknown = null;
    try {
      await this.runHooks(this.cacheInvalidators);
    } catch (error) {
      hookError = error;
    }
    try {
      await this.runHooks(this.beforeCloseHooks);
    } catch (error) {
      hookError ??= error;
    }
    await Promise.all(Object.values(previous.databases).map((database) => Promise.resolve(database.close()).catch(() => {})));
    this.generation += 1;
    if (hookError) throw hookError;
  }

  private async runHooks(hooks: Set<LifecycleHook>) {
    let firstError: unknown = null;
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
}

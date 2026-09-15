// AionUi 适配 shim：上游记忆模块以 `import { accountRuntime } from './account-runtime.js'`
// 引用模块级单例；AionUi 侧 AccountRuntimeManager 实例由 mainIntegration 构造（root=userData）。
// 这里以 Proxy 惰性转发到被绑定实例，保持上游模块零改动。
//
// 加载期语义：memory-store 等模块在顶层调用 registerCacheInvalidator/registerBeforeClose
// （绑定可能尚未发生）。register* 的钩子保存在常驻注册表，并在**每次** bindAccountRuntime 时
// 注册到新实例（AionUi 侧实例可被重建，例如测试与服务重启）；其余方法未绑定时调用即抛
// ACCOUNT_RUNTIME_REQUIRED（与上游单例缺失时的行为一致）。

import type { AccountRuntimeManager } from '../../accountRuntime';
export type { AccountSubject, AccountDatabaseKind } from '../../accountRuntime';

type LifecycleHook = () => void | Promise<void>;

let bound: AccountRuntimeManager | null = null;
const cacheInvalidators = new Set<LifecycleHook>();
const beforeCloseHooks = new Set<LifecycleHook>();

export function bindAccountRuntime(instance: AccountRuntimeManager) {
  bound = instance;
  for (const hook of cacheInvalidators) instance.registerCacheInvalidator(hook);
  for (const hook of beforeCloseHooks) instance.registerBeforeClose(hook);
}

export const accountRuntime: AccountRuntimeManager = new Proxy({} as AccountRuntimeManager, {
  get(_target, property, receiver) {
    if (!bound) {
      if (property === 'registerCacheInvalidator') {
        return (hook: LifecycleHook) => {
          cacheInvalidators.add(hook);
          return () => cacheInvalidators.delete(hook);
        };
      }
      if (property === 'registerBeforeClose') {
        return (hook: LifecycleHook) => {
          beforeCloseHooks.add(hook);
          return () => beforeCloseHooks.delete(hook);
        };
      }
      return () => {
        throw new Error('ACCOUNT_RUNTIME_REQUIRED');
      };
    }
    const value = Reflect.get(bound, property, receiver);
    return typeof value === 'function' ? value.bind(bound) : value;
  },
});

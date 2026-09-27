// AionUi 新增：个人记忆写路径 → 云备份调度器的脏标记钩子（移植自 client 的 markDirty 触发模型）。
// 独立成文件以避免 memory-store ↔ personalSync/service 的循环依赖：记忆写路径只 import 本文件，
// 调度器在 activate 时注册真实 handler。未注册（未登录/未启用）时静默忽略。

let handler: (() => void) | null = null;

export function setPersonalSyncDirtyHandler(next: (() => void) | null) {
  handler = next;
}

export function markPersonalSyncDirty() {
  try {
    handler?.();
  } catch {
    // 备份调度失败不得影响记忆写路径
  }
}

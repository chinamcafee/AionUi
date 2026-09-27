// AionUi（对齐 client 决策 Q2）：会话「知识库」开关的本地持久化。
// 语义与 zhongshuling client 的 kbEnabled 一致：ON → 本轮对话可检索团队知识库；
// OFF → 不检索知识库，问题原样发给 LLM。区别是该 client 按 sessionId 持久化，
// 而新会话页尚无会话，这里存为「新会话默认值」，随创建会话时的注入行为生效。

import { useCallback, useEffect, useState } from 'react';

export const KNOWLEDGE_TOGGLE_KEY = 'aionui.team.knowledgeEnabled';
const KNOWLEDGE_TOGGLE_EVENT = 'aionui.team.knowledgeEnabled.changed';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 默认开启（与 client 一致：登录后知识库能力默认可用，用户可显式关闭）。 */
export function isKnowledgeEnabled(): boolean {
  const raw = storage()?.getItem(KNOWLEDGE_TOGGLE_KEY);
  return raw === null || raw === undefined ? true : raw !== 'false';
}

export function setKnowledgeEnabled(value: boolean): void {
  storage()?.setItem(KNOWLEDGE_TOGGLE_KEY, value ? 'true' : 'false');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(KNOWLEDGE_TOGGLE_EVENT, { detail: value }));
  }
}

export function useKnowledgeEnabled(): [boolean, (value: boolean) => void] {
  const [enabled, setEnabled] = useState(isKnowledgeEnabled);

  useEffect(() => {
    const sync = () => setEnabled(isKnowledgeEnabled());
    window.addEventListener(KNOWLEDGE_TOGGLE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(KNOWLEDGE_TOGGLE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const update = useCallback((value: boolean) => setKnowledgeEnabled(value), []);
  return [enabled, update];
}

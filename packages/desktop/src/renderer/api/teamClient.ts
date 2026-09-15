// AionUi 新增：Team BFF API client（T1.14）。
// 独立于 AionCore 的 /api 前缀（httpBridge），走 http://127.0.0.1:<__teamBffPort>/teamapi/*；
// 信封 { data } / { error: { code } } 与 BFF app.ts 对齐。

export interface TeamApiEnvelopeError {
  code: string;
}

declare global {
  interface Window {
    __teamBffPort?: number;
    __teamAuthBridge?: {
      getConfig: () => Promise<{ enabled: boolean; serverBaseUrl: string; clientId: string }>;
      setConfig: (patch: { enabled?: boolean; serverBaseUrl?: string; clientId?: string }) => Promise<{ enabled: boolean; serverBaseUrl: string; clientId: string }>;
      beginLogin: () => Promise<unknown>;
      logout: () => Promise<unknown>;
      getStatus: () => Promise<unknown>;
      switchTeam: (tenantId: string, teamId: string) => Promise<unknown>;
      onStatus: (callback: (view: unknown) => void) => () => void;
    };
  }
}

export function teamBffBaseUrl(): string | null {
  const port = typeof window !== 'undefined' ? window.__teamBffPort : 0;
  return port ? `http://127.0.0.1:${port}` : null;
}

export class TeamApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const base = teamBffBaseUrl();
  if (!base) throw new TeamApiError('TEAM_BFF_UNAVAILABLE');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    // 网络层失败（BFF 重启中/瞬断）：转成可读错误码，避免 UI 出现裸 "Failed to fetch"
    throw new TeamApiError('TEAM_BFF_UNAVAILABLE');
  }
  let payload: { data?: unknown; error?: { code?: string } | string } & Record<string, unknown> = {};
  try {
    payload = await response.json();
  } catch {
    throw new TeamApiError('TEAM_BFF_RESPONSE_INVALID');
  }
  // BFF 存在两种响应契约：信封 {data} / {error:{code}}（auth/session/knowledge/agent-tools）
  // 与上游 client 直传的裸形状 {memories} / {state} / {candidate,...}（memory/team-memory 模块）。
  // 兼容两者：有 data 键取信封，否则整体返回；错误码兼容裸字符串。
  if (!response.ok || payload.error) {
    const code = typeof payload.error === 'string'
      ? payload.error
      : payload.error?.code ?? `TEAM_BFF_HTTP_${response.status}`;
    throw new TeamApiError(code);
  }
  return ('data' in payload ? payload.data : payload) as T;
}

export const teamApi = {
  healthz: () => request<{ ok: boolean }>('/healthz'),
  config: () => request<{ enabled: boolean; serverBaseUrl: string; clientId: string }>('/teamapi/config'),
  authStatus: () => request<unknown>('/teamapi/auth/status'),
  beginLogin: () => request<unknown>('/teamapi/auth/login', { method: 'POST' }),
  logout: () => request<unknown>('/teamapi/auth/logout', { method: 'POST' }),
  bootstrap: () => request<unknown>('/teamapi/session/bootstrap'),
  switchTeam: (tenantId: string, teamId: string) =>
    request<unknown>('/teamapi/session/switch-team', {
      method: 'POST',
      body: JSON.stringify({ tenantId, teamId }),
    }),
  assembleContext: (query: string, options: { scope?: string; conversationMode?: string; includeKnowledge?: boolean; knowledgeOrganizerFilter?: unknown } = {}) =>
    request<{ rendered: string | null; degraded: string[] }>('/teamapi/context/assemble', {
      method: 'POST',
      body: JSON.stringify({ query, ...options }),
    }),
  extractMemory: (userInput: string, assistantText: string) =>
    request<{ status: string; reason?: string; memoryId?: string }>('/teamapi/memories/extract', {
      method: 'POST',
      body: JSON.stringify({ userInput, assistantText }),
    }),
  listMemories: (params: { category?: string; search?: string; scope?: string } = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
    return request<{ memories: TeamMemoryEntry[] }>(`/teamapi/memories${query ? `?${query}` : ''}`);
  },
  createMemory: (input: { title: string; content: string; category?: string; scope?: string }) =>
    request<TeamMemoryEntry>('/teamapi/memories', { method: 'POST', body: JSON.stringify(input) }),
  updateMemory: (id: string, patch: Record<string, unknown>, baseVersion: number) =>
    request<{ updated: boolean; memory: TeamMemoryEntry }>(`/teamapi/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...patch, baseVersion }),
    }),
  deleteMemory: (id: string, baseVersion: number) =>
    request<{ deleted: boolean }>(`/teamapi/memories/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ baseVersion }),
    }),
  consolidateMemories: (scope: 'all' | 'chat' | 'code' = 'all', mode: 'auto' | 'review' = 'auto') =>
    request<TeamConsolidateResult>('/teamapi/memories/consolidate', { method: 'POST', body: JSON.stringify({ scope, mode }) }),
  applyConsolidation: (operations: unknown[]) =>
    request<{ appliedCount: number }>('/teamapi/memories/consolidate/apply', {
      method: 'POST', body: JSON.stringify({ operations }),
    }),
  checkMemorySimilarity: (input: { title: string; content: string; category?: string; scope?: string }) =>
    request<{ level: string; existingId?: string; existingVersion?: number; mergedTitle?: string; mergedContent?: string }>(
      '/teamapi/memories/check', { method: 'POST', body: JSON.stringify(input) },
    ),
  mergeMemoryPair: (input: { sourceId: string; targetId: string; mergedTitle: string; mergedContent: string; category?: string }) =>
    request<{ appliedCount: number }>('/teamapi/memories/merge-pair', {
      method: 'POST', body: JSON.stringify(input),
    }),
  listTeamMemories: (memoryScope?: 'chat' | 'code') =>
    fetchRaw<{ memories: TeamMemoryCandidate[] }>(`/teamapi/team-memories${memoryScope ? `?memoryScope=${memoryScope}` : ''}`),
  createTeamMemory: (input: {
    title: string; content: string; category: string; memoryScope: 'chat' | 'code'; tags: string[]; personalMemoryId?: string;
  }) =>
    request<{ candidate: TeamMemoryCandidate; submitted: unknown | null; warning?: string }>('/teamapi/team-memories', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  teamMemoryInvalidation: () =>
    request<{ connected: boolean; dirty: boolean; latestRevision: number; observedRevision: number }>('/teamapi/team-memory-invalidation'),

  // ── E-23：知识库四能力 ──
  listKnowledgeDocs: () => request<unknown[]>('/teamapi/knowledge/docs'),
  saveKnowledgeDoc: (input: { id?: string; title: string; content: string }) =>
    request<{ docId: string; status: string; isNew: boolean }>('/teamapi/knowledge/docs', {
      method: 'POST', body: JSON.stringify(input),
    }),
  getKnowledgeDoc: (id: string) => request<{ id: string; title: string; content: string }>(`/teamapi/knowledge/docs/${id}`),
  deleteKnowledgeDoc: (id: string) => request<{ ok: boolean }>(`/teamapi/knowledge/docs/${id}`, { method: 'DELETE' }),
  createOrganizer: (kind: 'groups' | 'tags', input: { name: string; description?: string; color?: string }) =>
    request<unknown>(`/teamapi/knowledge/organizers/${kind}`, { method: 'POST', body: JSON.stringify(input) }),
  updateOrganizer: (kind: 'groups' | 'tags', id: string, patch: Record<string, unknown>) =>
    request<unknown>(`/teamapi/knowledge/organizers/${kind}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteOrganizer: (kind: 'groups' | 'tags', id: string, expectedVersion?: number) =>
    request<unknown>(`/teamapi/knowledge/organizers/${kind}/${id}`, {
      method: 'DELETE', body: JSON.stringify({ expectedVersion }),
    }),
  searchOrganizerDocuments: (params: { query?: string; docType?: string; groupId?: string; tagId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]).toString();
    return request<unknown[]>(`/teamapi/knowledge/organizers/documents${query ? `?${query}` : ''}`);
  },
  replaceAssignments: (docId: string, groupIds: string[], tagIds: string[]) =>
    request<unknown>(`/teamapi/knowledge/organizers/documents/${docId}/assignments`, {
      method: 'PUT', body: JSON.stringify({ groupIds, tagIds }),
    }),
  getGraph: (params: { entity?: string; depth?: number; limit?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]) as [string, string][]).toString();
    return request<unknown>(`/teamapi/knowledge/graph${query ? `?${query}` : ''}`);
  },
  getGraphStats: () => request<unknown>('/teamapi/knowledge/graph/stats'),
  getGraphReports: () => request<{ reports: unknown[] }>('/teamapi/knowledge/graph/reports'),
  getGraphSummary: () => request<unknown>('/teamapi/knowledge/graph/summary'),
  rebuildGraph: () => request<unknown>('/teamapi/knowledge/graph/rebuild', { method: 'POST' }),
  patchDocumentVisibility: (documentId: string, visibility: 'personal' | 'team', expectedVersion?: number) =>
    request<unknown>(`/teamapi/knowledge/documents/${documentId}/visibility`, {
      method: 'PATCH', body: JSON.stringify({ visibility, expectedVersion }),
    }),
};

export interface TeamConsolidationOperation {
  id: string;
  type: 'merge' | 'update' | 'delete';
  targetId: string;
  sourceIds?: string[];
  title?: string;
  content?: string;
  category?: string;
  reason: string;
}

export interface TeamConsolidateResult {
  status: string;
  summary: string;
  beforeCount: number;
  afterCount: number | null;
  modelName: string | null;
  mode: string;
  operations: TeamConsolidationOperation[];
  appliedCount: number;
  details: string[];
}

export interface TeamMemoryCandidate {
  id: string;
  title: string;
  content?: string;
  category?: string;
  memoryScope?: 'chat' | 'code';
  workflowStatus?: string;
  tags?: string[];
  versions?: unknown[];
  [key: string]: unknown;
}

/** 团队记忆响应为非信封形状（{ memories } / { candidate } 直出），单独的裸解析 */
async function fetchRaw<T>(path: string, init?: RequestInit): Promise<T> {
  const base = teamBffBaseUrl();
  if (!base) throw new TeamApiError('TEAM_BFF_UNAVAILABLE');
  const response = await fetch(`${base}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload = await response.json().catch(() => ({}) as Record<string, unknown>);
  if (!response.ok) throw new TeamApiError(payload?.error ?? `TEAM_BFF_HTTP_${response.status}`);
  return payload as T;
}

export interface TeamMemoryEntry {
  id: string;
  category: 'preference' | 'fact' | 'requirement' | 'event';
  title: string;
  content: string;
  scope: 'chat' | 'code';
  pinned: boolean;
  version: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
}

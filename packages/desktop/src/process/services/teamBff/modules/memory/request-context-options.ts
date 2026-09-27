export const AGENT_REQUEST_KEYS = Object.freeze({
  userInput: 'LATEST_USER_INPUT',
  sessionMode: 'SESSION_MODE',
  knowledgeEnabled: 'KB_ENABLED',
  knowledgeOrganizerFilter: 'KB_ORGANIZER_FILTER',
  projectPath: 'PROJECT_PATH',
  permissionLevel: 'PERMISSION_LEVEL',
});

export interface KnowledgeOrganizerFilter {
  groupIds: string[];
  tagIds: string[];
}

export interface AgentRequestOptions {
  userInput: string;
  sessionMode: 'chat' | 'coding';
  knowledgeEnabled: boolean;
  knowledgeOrganizerFilter: KnowledgeOrganizerFilter;
  projectPath: string | null;
  permissionLevel: 'sandbox' | 'full';
}

export function normalizeAgentRequestOptions(input: {
  userInput?: unknown;
  sessionMode?: unknown;
  knowledgeEnabled?: unknown;
  knowledgeOrganizerFilter?: unknown;
  projectPath?: unknown;
  permissionLevel?: unknown;
}): AgentRequestOptions {
  const knowledgeOrganizerFilter = normalizeKnowledgeOrganizerFilter(input.knowledgeOrganizerFilter);
  return Object.freeze({
    userInput: typeof input.userInput === 'string' ? input.userInput : '',
    sessionMode: input.sessionMode === 'coding' ? 'coding' : 'chat',
    knowledgeEnabled: input.knowledgeEnabled === true,
    knowledgeOrganizerFilter,
    projectPath: typeof input.projectPath === 'string' && input.projectPath.trim() ? input.projectPath.trim() : null,
    permissionLevel: input.permissionLevel === 'full' ? 'full' : 'sandbox',
  });
}

export function normalizeKnowledgeOrganizerFilter(value: unknown): KnowledgeOrganizerFilter {
  if (value === undefined || value === null) {
    return Object.freeze({
      groupIds: Object.freeze([]) as unknown as string[],
      tagIds: Object.freeze([]) as unknown as string[],
    });
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('KNOWLEDGE_FILTER_INVALID');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'groupIds' && key !== 'tagIds')) {
    throw new Error('KNOWLEDGE_FILTER_INVALID');
  }
  const normalizeIds = (input: unknown, limit: number) => {
    if (!Array.isArray(input)) throw new Error('KNOWLEDGE_FILTER_INVALID');
    const ids = [
      ...new Set(
        input.map((item) => {
          if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item)) {
            throw new Error('KNOWLEDGE_FILTER_INVALID');
          }
          return item;
        })
      ),
    ];
    if (ids.length > limit) throw new Error('KNOWLEDGE_FILTER_INVALID');
    return Object.freeze(ids) as unknown as string[];
  };
  return Object.freeze({
    groupIds: normalizeIds(record.groupIds ?? [], 20),
    tagIds: normalizeIds(record.tagIds ?? [], 50),
  });
}

export function readAgentRequestOptions(requestContext: unknown): AgentRequestOptions {
  const context = requestContext as { get?: (key: string) => unknown } | null;
  return normalizeAgentRequestOptions({
    userInput: context?.get?.(AGENT_REQUEST_KEYS.userInput),
    sessionMode: context?.get?.(AGENT_REQUEST_KEYS.sessionMode),
    knowledgeEnabled: context?.get?.(AGENT_REQUEST_KEYS.knowledgeEnabled),
    knowledgeOrganizerFilter: context?.get?.(AGENT_REQUEST_KEYS.knowledgeOrganizerFilter),
    projectPath: context?.get?.(AGENT_REQUEST_KEYS.projectPath),
    permissionLevel: context?.get?.(AGENT_REQUEST_KEYS.permissionLevel),
  });
}

export function agentRequestContextEntries(options: AgentRequestOptions): Array<[string, unknown]> {
  return [
    [AGENT_REQUEST_KEYS.userInput, options.userInput],
    [AGENT_REQUEST_KEYS.sessionMode, options.sessionMode],
    [AGENT_REQUEST_KEYS.knowledgeEnabled, options.knowledgeEnabled],
    [AGENT_REQUEST_KEYS.knowledgeOrganizerFilter, options.knowledgeOrganizerFilter],
    [AGENT_REQUEST_KEYS.projectPath, options.projectPath],
    [AGENT_REQUEST_KEYS.permissionLevel, options.permissionLevel],
  ];
}

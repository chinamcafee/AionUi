import { useCallback, useEffect, useMemo, useState } from 'react';
import { ipcBridge } from '@/common';
import type { IMcpServer } from '@/common/config/storage';
import { ensureBackendMcpCatalog } from './catalog';
import { useTeamAuth } from '@/renderer/hooks/context/TeamAuthContext';
import { KNOWLEDGE_MCP_SERVER_ID } from '@/renderer/services/knowledge/knowledgeMcp';

/**
 * MCP server state hook.
 * Combines backend-managed user servers with extension-contributed servers.
 */
export const useMcpServers = () => {
  const [mcpServers, setMcpServers] = useState<IMcpServer[]>([]);
  const [extensionMcpServers, setExtensionMcpServers] = useState<IMcpServer[]>([]);
  const [isMcpServersLoading, setIsMcpServersLoading] = useState(true);
  const { view: teamView } = useTeamAuth();

  // 团队知识内置 server（T5.2/T5.4）：仅团队会话认证且开关开启时合并；
  // scope 限制说明见 docs/workLog/T5.1（MCP 直连不区分个人/团队可见性，默认通道为 Tool Gateway）。
  const teamKnowledgeServer = useMemo(() => {
    if (teamView.phase !== 'authenticated') return null;
    return buildTeamKnowledgeMcpServer();
  }, [teamView.phase]);

  useEffect(() => {
    void ensureBackendMcpCatalog()
      .then(({ allServers }) => {
        setMcpServers(allServers);
      })
      .catch((error) => {
        console.error('[useMcpServers] Failed to load MCP catalog:', error);
        setMcpServers([]);
      })
      .finally(() => {
        setIsMcpServersLoading(false);
      });

    void ipcBridge.extensions.getMcpServers;

    void ipcBridge.extensions.getMcpServers
      .invoke()
      .then((extServers) => {
        if (!extServers || extServers.length === 0) {
          setExtensionMcpServers([]);
          return;
        }

        const converted: IMcpServer[] = extServers.map((server) => ({
          id: String(server.id || ''),
          name: String(server.name || ''),
          description: server.description as string | undefined,
          enabled: server.enabled !== false,
          transport: server.transport as IMcpServer['transport'],
          created_at: (server.created_at as number) || Date.now(),
          updated_at: (server.updated_at as number) || Date.now(),
          original_json: String(server.original_json || '{}'),
          builtin: false,
        }));
        setExtensionMcpServers(converted);
      })
      .catch((error) => {
        console.error('[useMcpServers] Failed to load extension MCP servers:', error);
        setExtensionMcpServers([]);
      });
  }, []);

  const saveMcpServers = useCallback((serversOrUpdater: IMcpServer[] | ((prev: IMcpServer[]) => IMcpServer[])) => {
    setMcpServers((prevServers) =>
      typeof serversOrUpdater === 'function' ? serversOrUpdater(prevServers) : serversOrUpdater
    );
    return Promise.resolve();
  }, []);

  return {
    mcpServers,
    isMcpServersLoading,
    allMcpServers: teamKnowledgeServer
      ? [teamKnowledgeServer, ...mcpServers, ...extensionMcpServers]
      : [...mcpServers, ...extensionMcpServers],
    extensionMcpServers,
    setMcpServers,
    saveMcpServers,
  };
};

function buildTeamKnowledgeMcpServer(): IMcpServer {
  const mcpUrl = localStorage.getItem('aionui.team.knowledgeMcpUrl') || 'http://127.0.0.1:30143/mcp';
  const now = Date.now();
  return {
    id: KNOWLEDGE_MCP_SERVER_ID,
    name: '团队知识库（内置）',
    description:
      'knowledge.query/synthesize/global_search 等 6 工具。注意：MCP 通道不区分个人/团队知识可见性（自托管单用户场景使用）；默认推荐经 Agent 工具网关调用。',
    enabled: true,
    transport: { type: 'streamable_http', url: mcpUrl },
    created_at: now,
    updated_at: now,
    original_json: JSON.stringify({ transport: { type: 'streamable_http', url: mcpUrl } }),
    builtin: true,
  };
}

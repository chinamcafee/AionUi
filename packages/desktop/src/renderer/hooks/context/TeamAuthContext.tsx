// AionUi 新增：团队会话 Context（T1.10）。移植 client/src/auth/AuthSessionProvider + session-view 的状态机。
// 视图：signed_out / authorizing / exchanging / authenticated / tenant_required / team_required /
//       membership_suspended / offline / error。BFF 未启用时 featureEnabled=false，全部操作安全降级。

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { teamApi, teamBffBaseUrl, TeamApiError } from '@/renderer/api/teamClient';

export interface TeamSessionTeam {
  id: string;
  name: string;
  teamMembershipId: string;
  roleCode: string;
  status: string;
}

export interface TeamSessionBootstrap {
  state: 'tenant_required' | 'team_required' | 'membership_suspended' | 'ready';
  user: { id: string; email: string; displayName: string; avatarUrl: string | null };
  tenant: { id: string; name: string; tenantMemberId: string; tenantRole: string } | null;
  activeTeam: TeamSessionTeam | null;
  teams: TeamSessionTeam[];
  permissions: string[];
  tenantCapabilities?: string[];
  versions: Record<string, number>;
  features: Record<string, boolean>;
}

export type TeamSessionView =
  | { phase: 'disabled' }
  | { phase: 'signed_out' }
  | { phase: 'authorizing' }
  | { phase: 'exchanging' }
  | { phase: 'authenticated'; bootstrap: TeamSessionBootstrap }
  | { phase: 'tenant_required'; bootstrap: TeamSessionBootstrap }
  | { phase: 'team_required'; bootstrap: TeamSessionBootstrap }
  | { phase: 'membership_suspended'; bootstrap: TeamSessionBootstrap }
  | { phase: 'offline' }
  | { phase: 'error'; errorCode: string };

interface TeamAuthContextValue {
  featureEnabled: boolean;
  view: TeamSessionView;
  bootstrap: TeamSessionBootstrap | null;
  hasPermission: (code: string) => boolean;
  beginLogin: () => Promise<void>;
  logout: () => Promise<void>;
  switchTeam: (tenantId: string, teamId: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const TeamAuthContext = createContext<TeamAuthContextValue | undefined>(undefined);

function deriveView(raw: any): TeamSessionView {
  if (!raw || typeof raw !== 'object') return { phase: 'error', errorCode: 'TEAM_VIEW_INVALID' };
  const bootstrap = raw.bootstrap ?? null;
  const authPhase = raw.authPhase ?? 'signed_out';
  if (authPhase === 'authenticated' && bootstrap) {
    switch (bootstrap.state) {
      case 'ready':
        return { phase: 'authenticated', bootstrap };
      case 'tenant_required':
        return { phase: 'tenant_required', bootstrap };
      case 'team_required':
        return { phase: 'team_required', bootstrap };
      case 'membership_suspended':
        return { phase: 'membership_suspended', bootstrap };
    }
  }
  if (authPhase === 'authorizing') return { phase: 'authorizing' };
  if (authPhase === 'exchanging') return { phase: 'exchanging' };
  if (authPhase === 'refresh_available') return { phase: 'signed_out' };
  if (authPhase === 'error') return { phase: 'error', errorCode: raw.errorCode ?? 'AUTH_ERROR' };
  return { phase: 'signed_out' };
}

export const TeamAuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [featureEnabled, setFeatureEnabled] = useState<boolean>(() => !!teamBffBaseUrl());
  const [view, setView] = useState<TeamSessionView>({ phase: 'signed_out' });
  const [bootstrap, setBootstrap] = useState<TeamSessionBootstrap | null>(null);

  useEffect(() => {
    if (!featureEnabled) return;
    const unsubscribe = window.__teamAuthBridge?.onStatus?.((raw: any) => {
      setView(deriveView(raw));
      setBootstrap(raw?.bootstrap ?? null);
    });
    void teamApi
      .authStatus()
      .then((raw) => {
        setView(deriveView(raw));
        setBootstrap((raw as any)?.bootstrap ?? null);
      })
      .catch(() => setView({ phase: 'offline' }));
    return () => unsubscribe?.();
  }, [featureEnabled]);

  const refresh = useCallback(async () => {
    if (!featureEnabled) return;
    try {
      const raw = await teamApi.authStatus();
      setView(deriveView(raw));
      setBootstrap((raw as any)?.bootstrap ?? null);
    } catch {
      setView({ phase: 'offline' });
    }
  }, [featureEnabled]);

  const beginLogin = useCallback(async () => {
    try {
      await teamApi.beginLogin();
      setView({ phase: 'authorizing' });
    } catch (error) {
      setView({ phase: 'error', errorCode: error instanceof TeamApiError ? error.code : 'AUTH_BROWSER_OPEN_FAILED' });
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await teamApi.logout();
    } finally {
      setBootstrap(null);
      setView({ phase: 'signed_out' });
    }
  }, []);

  const switchTeam = useCallback(async (tenantId: string, teamId: string) => {
    const raw = await teamApi.switchTeam(tenantId, teamId);
    setView(deriveView({ authPhase: 'authenticated', bootstrap: raw }));
    setBootstrap(raw as TeamSessionBootstrap);
  }, []);

  const hasPermission = useCallback(
    (code: string) => view.phase === 'authenticated' && bootstrap?.permissions.includes(code) === true,
    [view, bootstrap]
  );

  const value = useMemo<TeamAuthContextValue>(
    () => ({ featureEnabled, view, bootstrap, hasPermission, beginLogin, logout, switchTeam, refresh }),
    [featureEnabled, view, bootstrap, hasPermission, beginLogin, logout, switchTeam, refresh]
  );

  return <TeamAuthContext.Provider value={value}>{children}</TeamAuthContext.Provider>;
};

export function useTeamAuth(): TeamAuthContextValue {
  const context = useContext(TeamAuthContext);
  if (!context) throw new Error('useTeamAuth must be used within a TeamAuthProvider');
  return context;
}

/** Optional read for components that may render outside the provider (e.g. isolated dom tests). */
export function useTeamAuthOptional(): TeamAuthContextValue | null {
  return useContext(TeamAuthContext);
}

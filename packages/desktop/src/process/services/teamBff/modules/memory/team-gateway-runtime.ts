// AionUi 适配 shim：上游模块以模块函数（callTeamGateway/currentTeamGatewayScope）访问网关单例；
// AionUi 侧为 TeamGatewayRuntime 类实例（由 teamBffService 构造）。与 account-runtime.ts 同一模式。

import type { TeamGatewayRuntime } from '../../gatewayRuntime';

let bound: TeamGatewayRuntime | null = null;

export function bindTeamGateway(instance: TeamGatewayRuntime) {
  bound = instance;
}

function requireGateway(): TeamGatewayRuntime {
  if (!bound) throw new Error('TEAM_GATEWAY_UNAVAILABLE');
  return bound;
}

export async function fetchTeamGateway(pathname: string, init?: RequestInit): Promise<Response> {
  return requireGateway().fetchTeamGateway(pathname, init);
}

export async function callTeamGateway(pathname: string, init?: RequestInit): Promise<unknown> {
  return requireGateway().callTeamGateway(pathname, init);
}

export function currentTeamGatewayScope(): { tenantId: string; teamId: string } {
  return requireGateway().currentTeamGatewayScope();
}

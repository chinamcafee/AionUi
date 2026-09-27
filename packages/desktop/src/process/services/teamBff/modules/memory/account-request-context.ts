import { buildAccountResourceId, type AccountResourceSubject } from '../shared/account-resource.js';
import { accountRuntime, type AccountSubject } from './account-runtime.js';

export const VERIFIED_ACCOUNT_KEYS = Object.freeze({
  tenantId: 'VERIFIED_TENANT_ID',
  tenantMemberId: 'VERIFIED_TENANT_MEMBER_ID',
  activeTeamId: 'VERIFIED_ACTIVE_TEAM_ID',
  resourceId: 'VERIFIED_RESOURCE_ID',
});

export interface VerifiedAccountContext extends AccountResourceSubject {
  resourceId: string;
}

export function deriveVerifiedAccountContext(
  subject: Readonly<AccountSubject> | null,
  claimedResourceId?: unknown
): Readonly<VerifiedAccountContext> {
  if (!subject) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  if (!subject.activeTeamId) throw new Error('ACTIVE_TEAM_REQUIRED');
  const accountSubject = {
    tenantId: subject.tenantId,
    tenantMemberId: subject.tenantMemberId,
    activeTeamId: subject.activeTeamId,
  };
  const resourceId = buildAccountResourceId(accountSubject);
  if (
    claimedResourceId !== undefined &&
    claimedResourceId !== null &&
    claimedResourceId !== '' &&
    claimedResourceId !== resourceId
  ) {
    throw new Error('RESOURCE_CONTEXT_MISMATCH');
  }
  return Object.freeze({ ...accountSubject, resourceId });
}

export function currentVerifiedAccountContext(claimedResourceId?: unknown) {
  return deriveVerifiedAccountContext(accountRuntime.currentSubject(), claimedResourceId);
}

export function verifiedAccountContextEntries(context: VerifiedAccountContext): Array<[string, unknown]> {
  return [
    [VERIFIED_ACCOUNT_KEYS.tenantId, context.tenantId],
    [VERIFIED_ACCOUNT_KEYS.tenantMemberId, context.tenantMemberId],
    [VERIFIED_ACCOUNT_KEYS.activeTeamId, context.activeTeamId],
    [VERIFIED_ACCOUNT_KEYS.resourceId, context.resourceId],
  ];
}

/** Backup ownership is tenant membership scoped and does not require a Team. */
export function currentPersonalBackupContext() {
  const subject = accountRuntime.currentSubject();
  if (!subject) throw new Error('ACCOUNT_RUNTIME_REQUIRED');
  return Object.freeze({ tenantId: subject.tenantId, tenantMemberId: subject.tenantMemberId });
}

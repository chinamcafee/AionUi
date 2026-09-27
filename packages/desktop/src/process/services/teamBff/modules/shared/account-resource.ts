export interface AccountResourceSubject {
  tenantId: string;
  tenantMemberId: string;
  activeTeamId: string;
}

const RESOURCE_PATTERN = /^t:([^:]+):tm:([^:]+):team:([^:]+)$/;

export function buildAccountResourceId(subject: AccountResourceSubject): string {
  if (
    !subject.tenantId ||
    !subject.tenantMemberId ||
    !subject.activeTeamId ||
    [subject.tenantId, subject.tenantMemberId, subject.activeTeamId].some((value) => value.includes(':'))
  ) {
    throw new Error('ACCOUNT_RESOURCE_SUBJECT_INVALID');
  }
  return `t:${subject.tenantId}:tm:${subject.tenantMemberId}:team:${subject.activeTeamId}`;
}

export function parseAccountResourceId(resourceId: string): AccountResourceSubject | null {
  const match = RESOURCE_PATTERN.exec(resourceId);
  if (!match) return null;
  return { tenantId: match[1], tenantMemberId: match[2], activeTeamId: match[3] };
}

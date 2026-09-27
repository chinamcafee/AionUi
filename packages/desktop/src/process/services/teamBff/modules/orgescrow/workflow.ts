import type { EscrowClient } from './client';
import { readPending, writePending } from './trust';

type Client = Pick<
  EscrowClient,
  'identity' | 'view' | 'initialize' | 'enroll' | 'confirmEnrollment' | 'resumeRecovery'
>;
const terminal = ['failed', 'expired', 'cancelled', 'rejected'];

/** An explicit switch action is the consent event; historical preferences are not consent. */
export async function enableEscrowBackup(client: Client, initialized: boolean) {
  const view = await client.view();
  if (!['enrolling', 'enabled'].includes(view.state)) throw new Error('ESCROW_NOT_READY');
  if (!view.notificationReady) throw new Error('ESCROW_NOTIFICATION_NOT_READY');
  if (view.recovery && !terminal.includes(view.recovery.status) && view.stage !== 'verified')
    throw new Error('ESCROW_OPERATION_BUSY');
  if (!initialized) await client.initialize(true);
  else if (view.coverage !== 'verified') await client.enroll(true);
  writePending(client.identity, 'auto-consent', {
    policyVersion: view.version,
    disclosureVersion: view.disclosureVersion,
  });
}

/** Resume durable work without generating new consent, requests or approval votes. */
export async function advanceEscrowBackup(client: Client) {
  let view = await client.view();
  if (view.registration && ['result_ready', 'verified', 'readback_pending'].includes(view.registration.status)) {
    await client.confirmEnrollment();
    view = await client.view();
  }
  if (view.recovery && ['result_ready', 'completed'].includes(view.recovery.status) && view.stage !== 'verified') {
    await client.resumeRecovery();
    view = await client.view();
  }
  return view;
}

export function hasAutomaticBackupConsent(client: Pick<Client, 'identity'>) {
  return !!readPending(client.identity, 'auto-consent');
}

// AionUi 新增：个人记忆云备份的 BFF 路由（/teamapi/personal-sync/*）。
// 渲染进程不持有令牌：同步引擎、vault、team-server 调用全部落在主进程；
// 未登录（账户运行时未激活）时统一 409 ACCOUNT_RUNTIME_REQUIRED（与记忆路由同款门控）。

import { Hono, type Context } from 'hono';
import { accountRuntime } from '../memory/account-runtime.js';
import * as service from './service.js';

function errorBody(code: string) {
  return { error: { code } };
}

function statusFor(code: string): 400 | 401 | 403 | 404 | 409 | 502 | 503 {
  if (code === 'SESSION_INVALID') return 401;
  if (code === 'DEVICE_NOT_TRUSTED' || code === 'TENANT_MEMBER_FORBIDDEN' || code === 'DEVICE_SESSION_MISMATCH')
    return 403;
  if (code === 'PAIRING_NOT_FOUND' || code === 'RECOVERY_CHALLENGE_NOT_FOUND' || code === 'SYNC_OBJECT_NOT_FOUND')
    return 404;
  if (code.endsWith('_INVALID') || code === 'RECOVERY_CODE_INVALID' || code === 'VALIDATION_ERROR') return 400;
  if (code === 'OBJECT_STORE_UNAVAILABLE' || code === 'PERSONAL_SYNC_UPSTREAM_FAILED') return 503;
  if (code.startsWith('PERSONAL_SYNC_RESPONSE')) return 502;
  return 409;
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function createPersonalSyncRoutes() {
  const app = new Hono();

  app.use('/personal-sync/*', async (c, next) => {
    let active = false;
    try {
      active = accountRuntime.currentSubject() !== null;
    } catch {
      active = false;
    }
    if (!active) {
      c.header('Cache-Control', 'no-store');
      return c.json(errorBody('ACCOUNT_RUNTIME_REQUIRED'), 409);
    }
    await next();
  });

  const guarded = async (c: Context, action: () => Promise<unknown>): Promise<Response> => {
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({ data: await action() });
    } catch (error) {
      const candidate = (error as Error)?.message ?? '';
      const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : 'PERSONAL_SYNC_FAILED';
      return c.json(errorBody(code), statusFor(code));
    }
  };

  app.get('/personal-sync/status', (c) =>
    guarded(c, async () => ({
      ...(await service.getPersonalSyncStatus()),
      conflicts: await service.readPersonalSyncConflictViews(),
    }))
  );

  app.post('/personal-sync/sync-now', (c) =>
    guarded(c, async () => {
      const result = await service.runPersonalSync('manual');
      return { ...result, status: await service.getPersonalSyncStatus() };
    })
  );

  app.post('/personal-sync/preferences', async (c) => {
    const body = (await readJsonBody(c)) as { autoEnabled?: unknown } | null;
    if (typeof body?.autoEnabled !== 'boolean') {
      c.header('Cache-Control', 'no-store');
      return c.json(errorBody('PERSONAL_SYNC_PREFERENCE_INVALID'), 400);
    }
    return guarded(c, async () => {
      await service.setPersonalSyncAutoEnabled(body.autoEnabled as boolean);
      return { autoEnabled: body.autoEnabled };
    });
  });

  app.post('/personal-sync/initialize', async (c) => {
    const body = (await readJsonBody(c)) as { consent?: unknown } | null;
    return guarded(c, () => service.initializePersonalSyncRoot(body?.consent === true));
  });
  app.get('/personal-sync/org-escrow', (c) => guarded(c, () => service.organizationEscrowAction('status')));
  app.post('/personal-sync/org-escrow/:action', async (c) => {
    const body = (await readJsonBody(c)) as { consent?: unknown } | null;
    return guarded(c, () => service.organizationEscrowAction(c.req.param('action'), body?.consent === true));
  });

  app.get('/personal-sync/devices', (c) => guarded(c, () => service.refreshPersonalSyncDevices()));

  app.delete('/personal-sync/devices/:deviceId', (c) =>
    guarded(c, () => service.revokePersonalSyncDeviceById(c.req.param('deviceId')))
  );

  app.post('/personal-sync/pairing', (c) => guarded(c, () => service.createPersonalSyncPairingForThisDevice()));

  app.post('/personal-sync/pairing/approve', async (c) => {
    const body = (await readJsonBody(c)) as { pairingId?: unknown; displayCode?: unknown } | null;
    const pairingId = typeof body?.pairingId === 'string' ? body.pairingId : '';
    const displayCode = typeof body?.displayCode === 'string' ? body.displayCode : '';
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pairingId) ||
      !/^\d{8}$/.test(displayCode)
    ) {
      c.header('Cache-Control', 'no-store');
      return c.json(errorBody('PERSONAL_SYNC_PAIRING_INVALID'), 400);
    }
    return guarded(c, () => service.approvePersonalSyncPairingById(pairingId, displayCode));
  });

  app.post('/personal-sync/recovery', async (c) => {
    const body = (await readJsonBody(c)) as { recoveryCode?: unknown } | null;
    const recoveryCode = typeof body?.recoveryCode === 'string' ? body.recoveryCode.trim() : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(recoveryCode)) {
      c.header('Cache-Control', 'no-store');
      return c.json(errorBody('RECOVERY_CODE_INVALID'), 400);
    }
    return guarded(c, () => service.recoverPersonalSyncWithCode(recoveryCode));
  });

  app.post('/personal-sync/snapshots', (c) => guarded(c, () => service.createPersonalSyncSnapshotNow()));

  return app;
}

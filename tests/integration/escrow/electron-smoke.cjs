// Run with the real Electron binary, never ELECTRON_RUN_AS_NODE.
const { app, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aion-escrow-electron-'));
app.setPath('userData', directory);
app.disableHardwareAcceleration();
app
  .whenReady()
  .then(async () => {
    require('tsx/cjs');
    const base = path.resolve('packages/desktop/src/process/services/teamBff');
    const { AccountRuntimeManager } = require(path.join(base, 'accountRuntime.ts'));
    const { bindAccountRuntime } = require(path.join(base, 'modules/memory/account-runtime.ts'));
    const service = require(path.join(base, 'modules/personalSync/service.ts'));
    const vault = require(path.join(base, 'modules/personalSync/secretVault.ts'));
    const crypto = require(path.join(base, 'modules/orgescrow/protocol.ts'));
    const recovery = require(path.join(base, 'modules/orgescrow/recovery.ts'));
    const runtime = new AccountRuntimeManager(directory);
    bindAccountRuntime(runtime);
    const tenant = '00000000-0000-4000-8000-000000000001';
    const member = '00000000-0000-4000-8000-000000000002';
    try {
      assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS safeStorage unavailable');
      await runtime.activate({ tenantId: tenant, tenantMemberId: member, activeTeamId: null });
      const keyFile = path.join(directory, 'vault-key');
      service.configurePersonalSync({ vaultKeyFilePath: keyFile, safeStorage });
      const identity = {
        baseUrl: 'https://fixture.invalid',
        tenantId: tenant,
        userId: '00000000-0000-4000-8000-000000000003',
        deviceId: '00000000-0000-4000-8000-000000000004',
        getAccessToken: async () => {
          throw new Error('No network allowed in Electron smoke');
        },
      };
      await service.activatePersonalSync(identity);
      const marker = randomBytes(32).toString('base64url');
      vault.setSecret('personal-sync:umk:v1', marker);
      assert.equal(vault.getSecret('personal-sync:umk:v1'), marker);
      assert.match(safeStorage.decryptString(fs.readFileSync(keyFile)), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(fs.readFileSync(keyFile).subarray(0, 6).toString() === 'PLAIN:', false);
      assert.equal(
        fs.readFileSync(path.join(runtime.currentDirectory(), 'secrets.vault'), 'utf8').includes(marker),
        false
      );
      const keys = new Map([
        [1, randomBytes(32)],
        [4, randomBytes(32)],
      ]);
      const pkg = recovery.createRecoveryPackage(keys);
      const signer = recovery.recoverySigningKey(pkg.recoveryCode, pkg.recoveryKdf, pkg.encryptedRecoveryPackage);
      const statement = { protocolVersion: 1, tenantId: tenant };
      crypto.verifyStatement(
        crypto.decode(pkg.recoveryPublicKey, 32),
        'finish',
        statement,
        crypto.signStatement(signer, 'finish', statement)
      );
      vault.bindPersonalSyncScope({ ...identity, baseUrl: 'https://other.invalid' });
      assert.equal(vault.getSecret('personal-sync:umk:v1'), '');
      process.stdout.write(
        JSON.stringify({
          electron: process.versions.electron,
          osSafeStorage: true,
          noActiveTeam: true,
          encryptedVault: true,
          historicalKeyring: true,
          crossOriginIsolation: true,
        }) + '\n'
      );
    } finally {
      service.deactivatePersonalSync();
      await runtime.deactivate();
      fs.rmSync(directory, { recursive: true, force: true });
    }
    app.exit(0);
  })
  .catch(() => {
    process.stderr.write('ESCROW_ELECTRON_SMOKE_FAILED\n');
    app.exit(1);
  });

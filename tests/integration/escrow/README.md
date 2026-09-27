# Electron escrow runtime smoke

From the AionUi root, run the installed Electron executable with `tests/integration/escrow/electron-smoke.cjs`. On macOS:

```sh
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/integration/escrow/electron-smoke.cjs
```

The test uses a temporary userData/account directory, actual OS safeStorage, actual LibSQL and the production main-process modules. It checks no-Team activation, encrypted vault persistence, origin isolation and the recovery package containing historical keys. It never calls a remote service and never logs keys. It is a runtime smoke test, not the packaged application's complete two-person recovery acceptance test. Do not set ELECTRON_RUN_AS_NODE.

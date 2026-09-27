#!/usr/bin/env node
/**
 * Dev launcher: build the local AionCore debug binary, then start
 * electron-vite dev with AIONUI_BACKEND_BIN pointing at it.
 *
 * `cargo build` is incremental — when no AionCore source changed it returns
 * in about a second without recompiling, so this doubles as the
 * "rebuild only on changes" check.
 *
 * Environment variables:
 *   AIONCORE_REPO_DIR    AionCore repo path (default: sibling ../AionCore)
 *   AIONCORE_SKIP_BUILD  "1" skips cargo build and reuses the existing binary
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const repoRoot = path.resolve(__dirname, '..');
const aionCoreRepo = path.resolve(process.env.AIONCORE_REPO_DIR || path.join(repoRoot, '..', 'AionCore'));
const isWindows = process.platform === 'win32';
const binaryName = isWindows ? 'aioncore.exe' : 'aioncore';
const binaryPath = path.join(aionCoreRepo, 'target', 'debug', binaryName);

const log = (...args) => console.log('[dev:aioncore]', ...args);
const fail = (message) => {
  console.error('[dev:aioncore] ERROR:', message);
  process.exit(1);
};

if (!fs.existsSync(path.join(aionCoreRepo, 'Cargo.toml'))) {
  fail(`AionCore repo not found at "${aionCoreRepo}". Set AIONCORE_REPO_DIR or clone AionCore next to AionUi.`);
}

if (process.env.AIONCORE_SKIP_BUILD === '1') {
  log('AIONCORE_SKIP_BUILD=1 — skipping cargo build, reusing existing binary');
} else {
  log(`cargo build (debug) in ${aionCoreRepo} — incremental, no source change means no recompile`);
  const build = spawnSync(isWindows ? 'cargo.exe' : 'cargo', ['build', '--bin', 'aioncore'], {
    cwd: aionCoreRepo,
    stdio: 'inherit',
  });
  if (build.error) {
    fail(`failed to run cargo: ${build.error.message}`);
  }
  if (build.status !== 0) {
    fail(`cargo build failed (exit code ${build.status}) — fix the AionCore build first`);
  }
}

if (!fs.existsSync(binaryPath)) {
  fail(`aioncore binary not found at "${binaryPath}". Run again without AIONCORE_SKIP_BUILD to build it.`);
}

log(`backend binary: ${binaryPath}`);

// electron-vite's package.json "exports" does not expose ./bin, so resolve the
// bin file by direct path instead of require.resolve on the subpath.
const electronViteBin = path.join(repoRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
if (!fs.existsSync(electronViteBin)) {
  fail(`electron-vite not found at "${electronViteBin}" — run bun/npm install first`);
}
const child = spawn(
  process.execPath,
  [electronViteBin, 'dev', '--config', 'packages/desktop/electron.vite.config.ts'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, AIONUI_BACKEND_BIN: binaryPath },
  }
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));

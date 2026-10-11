// Test entry point for `npm test`.
//
// Ensures playwright-core is importable (it never downloads browsers; the
// Chromium binary is resolved at launch time — see tests/helpers/browser.mjs),
// then runs the browser regression suite plus the existing Pages Function
// unit tests.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// This host is NixOS with no browser-capable system libraries, so the
// ms-playwright downloads cannot run. A nix-built Chromium resolves all its
// dependencies inside the store; the out-link lives in the workspace.
function ensureNixChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return;
  if (existsSync(path.join(REPO_ROOT, 'tests', '.chromium', 'bin', 'chromium'))) return;

  const nix = spawnSync('nix', ['build', 'nixpkgs#chromium', '--out-link', 'tests/.chromium'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (nix.status !== 0) {
    console.error(
      'No usable Chromium found and the nix build failed. Install one with:\n'
      + '  nix build nixpkgs#chromium --out-link tests/.chromium\n'
      + 'or point PLAYWRIGHT_CHROMIUM at an existing chromium binary.',
    );
    process.exit(1);
  }
}

async function ensurePlaywrightCore() {
  try {
    await import('playwright-core');
    return;
  } catch {
    // Fresh checkout without node_modules — install pinned dev deps.
  }
  console.log('Installing test dependencies (playwright-core)...');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (install.status !== 0) {
    throw new Error(`npm install failed with exit code ${install.status}`);
  }
  await import('playwright-core');
}

let failed = false;

try {
  await ensurePlaywrightCore();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

ensureNixChromium();

const browser = spawnSync(
  process.execPath,
  [
    '--test',
    '--test-concurrency=3',
    // Node does not scan a bare directory argument here (v24 runs it as an
    // entry point and fails with MODULE_NOT_FOUND), so list the files.
    ...readdirSync(path.join(REPO_ROOT, 'tests', 'e2e'))
      .filter((name) => name.endsWith('.test.mjs'))
      .sort()
      .map((name) => path.join('tests', 'e2e', name)),
  ],
  { cwd: REPO_ROOT, stdio: 'inherit' },
);
failed ||= browser.status !== 0;

const functions = spawnSync(process.execPath, [path.join('functions', 'test-og-injection.js')], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
failed ||= functions.status !== 0;

process.exit(failed ? 1 : 0);

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));

// `nix build nixpkgs#chromium --out-link tests/.chromium` (run.mjs does this
// automatically when no browser is found) links a Chromium whose shared
// libraries are all resolved inside the Nix store, which is the only way a
// browser runs on this NixOS host — the ms-playwright downloads depend on
// system glib/NSS that does not exist here.
function nixChromiumExecutable() {
  for (const candidate of [
    path.join(TESTS_ROOT, '..', '.chromium', 'bin', 'chromium'),
    path.join(TESTS_ROOT, '..', '.chromium', 'bin', 'chrome'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function playwrightCacheExecutable() {
  const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (!existsSync(cacheRoot)) return undefined;

  const revisions = readdirSync(cacheRoot)
    .map((name) => name.match(/^chromium-(\d+)$/))
    .filter(Boolean)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  for (const [, revision] of revisions) {
    for (const dir of ['chrome-linux64', 'chrome-linux']) {
      const candidate = path.join(cacheRoot, `chromium-${revision}`, dir, 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function systemChromiumExecutable() {
  for (const candidate of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Launches the real Chromium the tests run against. playwright-core never
// downloads browsers, so resolution goes: explicit PLAYWRIGHT_CHROMIUM
// override, the workspace nix build, the playwright browser cache, then a
// system Chromium. When nothing is found, playwright-core's own registry
// lookup gets a chance.
export async function launchBrowser() {
  const { chromium } = await import('playwright-core');
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM
    ?? nixChromiumExecutable()
    ?? playwrightCacheExecutable()
    ?? systemChromiumExecutable();

  try {
    return await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
  } catch (error) {
    if (!executablePath) throw error;
    // The pinned binary may be stale on this machine; let playwright-core
    // resolve from its own registry before giving up.
    return chromium.launch({ headless: true });
  }
}

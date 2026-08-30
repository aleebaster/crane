import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { log } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  ensureNSTRunning,
  launchProfileForWallet,
  closeNSTProfile,
  isNSTRunning,
  NSTBrowserLaunchResult,
  NSTProfileManager,
  NSTProfileMapping,
  FingerprintRotator,
  FingerprintRotationConfig,
  ProfileStrategy,
  launchNSTProfile,
  connectToNSTProfile,
} from './nstbrowser';
import { ProfilePool } from './profile-pool';
import { ProxyConfig, testProxy } from './proxy';

// ─── Config Types ───────────────────────────────────────────────────────────

export interface BrowserConfig {
  userDataDir: string;
  profileDirectory: string;
  headless: boolean;
  chromePath?: string;
  useNSTbrowser?: boolean;
  createProfilesOnDemand?: boolean;
  profileStrategy?: ProfileStrategy;
  nstProfiles?: NSTProfileMapping[];
  fingerprintRotation?: Partial<FingerprintRotationConfig>;
  proxy?: ProxyConfig;
}

export interface BrowserLaunchResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileId?: string;
}

// ─── Active NST state ───────────────────────────────────────────────────────

let activeNSTProfileId: string | null = null;
let profileManager: NSTProfileManager | null = null;
let fingerprintRotator: FingerprintRotator | null = null;
let profilePool: ProfilePool | null = null;

// ─── Chrome helpers (unchanged) ─────────────────────────────────────────────

function findChromePath(): string | undefined {
  const { platform } = process;
  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function validateProfile(userDataDir: string, profileDirectory: string): void {
  if (!fs.existsSync(userDataDir)) {
    throw new Error(
      `Chrome User Data directory not found: ${userDataDir}\n` +
      `Make sure Google Chrome is installed.`
    );
  }

  const profileDir = path.join(userDataDir, profileDirectory);
  if (!fs.existsSync(profileDir)) {
    throw new Error(
      `Chrome profile "${profileDirectory}" not found at: ${profileDir}\n` +
      `Create this profile in Chrome first: Menu > Profiles > Add Profile`
    );
  }
}

function getValidPage(context: BrowserContext): Page {
  const pages = context.pages();
  for (const p of pages) {
    if (!p.isClosed()) {
      return p;
    }
  }
  return pages[pages.length - 1];
}

async function waitForCDP(port: number, timeoutMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`CDP not ready on port ${port} after ${timeoutMs}ms`);
}

function launchChromeViaPowerShell(chromePath: string, userDataDir: string, profileDirectory: string, port: number): void {
  const psScript = `
Start-Process -FilePath '${chromePath}' -ArgumentList @(
  '--remote-debugging-port=${port}',
  '--user-data-dir=${userDataDir}',
  '--profile-directory=${profileDirectory}',
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  'about:blank'
) -PassThru | Out-Null
`;

  execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    encoding: 'utf-8',
    timeout: 10000,
    stdio: 'pipe',
  });
}

// ─── Chrome CDP Launch (existing) ───────────────────────────────────────────

async function launchChromeCDP(config: BrowserConfig): Promise<BrowserLaunchResult> {
  const chromePath = config.chromePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Set CHROME_PATH in .env or config.json'
    );
  }

  log(`Chrome executable: ${chromePath}`);
  log(`Chrome User Data: ${config.userDataDir}`);
  log(`Bot Chrome profile: ${config.profileDirectory}`);
  log('User Default profile will not be used');

  validateProfile(config.userDataDir, config.profileDirectory);

  const port = 9222 + Math.floor(Math.random() * 1000);
  log(`Using CDP port: ${port}`);

  log('Launching Chrome...');
  launchChromeViaPowerShell(chromePath, config.userDataDir, config.profileDirectory, port);

  log('Waiting for Chrome CDP...');
  await waitForCDP(port, 15000);
  log('Chrome CDP ready');

  log('Connecting via CDP...');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  log('Connected to Chrome via CDP');

  const context = browser.contexts()[0] || await browser.newContext();
  const page = getValidPage(context);

  log(`Initial page URL: ${page.url()}`);

  return { browser, context, page };
}

// ─── NSTbrowser Launch (with profile management) ────────────────────────────

async function launchNSTbrowser(config: BrowserConfig): Promise<BrowserLaunchResult> {
  log('NSTbrowser mode enabled');

  const nstRunning = await isNSTRunning();
  if (!nstRunning) {
    log('Starting NSTbrowser...');
    await ensureNSTRunning();
  }

  // Initialize profile manager if configured
  if (config.nstProfiles && config.nstProfiles.length > 0) {
    const strategy = config.profileStrategy || 'round_robin';
    profileManager = new NSTProfileManager(config.nstProfiles, strategy);
    log(`[NST] ProfileManager: ${profileManager.profileCount} profiles, strategy=${strategy}`);

    // Initialize profile pool
    const profileIds = config.nstProfiles.map((p) => p.id);
    profilePool = new ProfilePool(profileIds);
    log(`[NST] ProfilePool: ${profilePool.totalCount} profiles`);

    // Initialize fingerprint rotator
    fingerprintRotator = new FingerprintRotator(config.fingerprintRotation);
    log(`[NST] FingerprintRotator: pool=${fingerprintRotator.poolSize}`);
  }

  // Test proxy if configured
  if (config.proxy?.enabled) {
    log(`[NST] Proxy configured: ${config.proxy.type}://${config.proxy.host}:${config.proxy.port}`);
    const proxyIp = await testProxy(config.proxy);
    if (proxyIp) {
      log(`[NST] Proxy working, outbound IP: ${proxyIp}`);
    } else {
      log('[NST] WARNING: Proxy test failed, continuing without proxy');
    }
  }

  // Use a dummy address for initial launch; actual wallet address used later
  const result = await launchProfileForWallet(
    'initial',
    config.createProfilesOnDemand !== false,
    config.proxy?.enabled ? config.proxy : undefined
  );

  activeNSTProfileId = result.profileId;

  return {
    browser: result.browser,
    context: result.context,
    page: result.page,
    profileId: result.profileId,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function launchBrowser(config: BrowserConfig): Promise<BrowserLaunchResult> {
  if (config.useNSTbrowser) {
    return launchNSTbrowser(config);
  }
  return launchChromeCDP(config);
}

/**
 * Launch a specific wallet's NST profile with fingerprint rotation.
 * Use this for per-wallet processing in multi-profile mode.
 */
export async function launchWalletProfile(
  address: string
): Promise<NSTBrowserLaunchResult | null> {
  if (!profileManager || !fingerprintRotator || !profilePool) {
    return null;
  }

  const profileId = profileManager.getProfileForWallet(address);
  if (!profileId) {
    log(`[NST] No profile found for ${address.substring(0, 10)}...`);
    return null;
  }

  // Acquire from pool (waits if all busy)
  const acquired = profilePool.acquireProfile(profileId, address);
  if (!acquired) {
    log(`[NST] Profile ${profileId} is busy, waiting...`);
    const available = await profilePool.waitForAvailable(30000);
    if (!available) {
      log('[NST] No profiles available after timeout');
      return null;
    }
    profilePool.acquireProfile(available, address);
  }

  // Get rotated fingerprint
  const fingerprint = fingerprintRotator.getNextFingerprint(profileId);
  log(`[NST] Using fingerprint for ${profileId}: ${fingerprint.userAgent?.substring(0, 50)}...`);

  // Launch profile
  const wsEndpoint = await launchNSTProfile(profileId);
  const browser = await connectToNSTProfile(wsEndpoint);

  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

  const pages = context.pages();
  const page =
    pages.length > 0 && !pages[0].isClosed()
      ? pages[0]
      : await context.newPage();

  return { browser, context, page, profileId };
}

/**
 * Release a wallet profile back to the pool.
 */
export function releaseWalletProfile(profileId: string): void {
  if (profilePool) {
    profilePool.releaseProfile(profileId);
  }
  if (profileManager) {
    profileManager.markProfileUsed(profileId);
  }
}

/**
 * Get the profile manager instance.
 */
export function getProfileManager(): NSTProfileManager | null {
  return profileManager;
}

/**
 * Get the fingerprint rotator instance.
 */
export function getFingerprintRotator(): FingerprintRotator | null {
  return fingerprintRotator;
}

/**
 * Get the profile pool instance.
 */
export function getProfilePool(): ProfilePool | null {
  return profilePool;
}

export async function closeBrowser(
  browser: Browser | null,
  _config?: BrowserConfig
): Promise<void> {
  try {
    if (activeNSTProfileId) {
      await closeNSTProfile(activeNSTProfileId);
      activeNSTProfileId = null;
    }
    if (profilePool) {
      profilePool.resetAll();
    }
    if (browser) {
      await browser.close();
    }
  } catch (error) {
    console.error('[Browser] Error during close:', error);
  }
}

export async function checkNSTStatus(): Promise<boolean> {
  try {
    return await isNSTRunning();
  } catch {
    return false;
  }
}

export function resetActiveNSTProfile(): void {
  activeNSTProfileId = null;
  profileManager = null;
  fingerprintRotator = null;
  profilePool = null;
}

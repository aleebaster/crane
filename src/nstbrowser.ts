import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { log } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Configuration ──────────────────────────────────────────────────────────

const NST_API_BASE = 'http://localhost:8848/api/v1';
const NST_EXECUTABLE = 'C:\\Users\\andre\\OneDrive\\Desktop\\Nstbrowser.lnk';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface NSTFingerprint {
  userAgent: string;
  platform: string;
  language: string;
  timezone: string;
  screenResolution: string;
  webglVendor: string;
  webglRenderer: string;
}

export interface NSTProfile {
  id: string;
  name: string;
  fingerprint: NSTFingerprint;
}

export interface NSTProfileConfig {
  name: string;
  fingerprint?: Partial<NSTFingerprint>;
  storage?: {
    localStorage?: Record<string, string>;
    cookies?: Array<{ name: string; value: string; domain: string }>;
  };
}

export interface NSTBrowserLaunchResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileId: string;
}

// ─── NST Status ─────────────────────────────────────────────────────────────

/**
 * Check if NSTbrowser API is reachable.
 */
export async function isNSTRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${NST_API_BASE}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure NSTbrowser is running, start it if not.
 */
export async function ensureNSTRunning(): Promise<void> {
  if (await isNSTRunning()) {
    log('NSTbrowser is already running');
    return;
  }

  log('NSTbrowser is not running. Attempting to start...');

  try {
    await execAsync(`start "" "${NST_EXECUTABLE}"`);
    log('NSTbrowser started. Waiting for API...');

    const maxAttempts = 30;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isNSTRunning()) {
        log('NSTbrowser API is ready');
        return;
      }
    }

    throw new Error('NSTbrowser API did not become ready within 30 seconds');
  } catch (error) {
    console.error('[NST] Failed to start NSTbrowser:', error);
    console.error('[NST] Please start NSTbrowser manually and try again');
    throw error;
  }
}

// ─── Profile Management ─────────────────────────────────────────────────────

/**
 * Create a new browser profile in NSTbrowser.
 */
export async function createNSTProfile(config: NSTProfileConfig): Promise<string> {
  const defaultFingerprint: NSTFingerprint = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32',
    language: 'en-US,en;q=0.9',
    timezone: 'America/New_York',
    screenResolution: '1920x1080',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer:
      'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };

  const body = {
    name: config.name,
    browserType: 'chromium',
    fingerprint: {
      ...defaultFingerprint,
      ...config.fingerprint,
    },
    storage: config.storage || {
      localStorage: {},
      cookies: [],
    },
  };

  const res = await fetch(`${NST_API_BASE}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create NST profile: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const profileId = (data.profileId || data.id) as string;
  log(`NST profile created: ${profileId} (${config.name})`);
  return profileId;
}

/**
 * Launch a profile and return the WebSocket endpoint for CDP connection.
 */
export async function launchNSTProfile(profileId: string): Promise<string> {
  const res = await fetch(`${NST_API_BASE}/profiles/${profileId}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ headless: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to launch NST profile ${profileId}: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const wsEndpoint = (data.wsEndpoint || data.webSocketDebuggerUrl) as string;
  log(`NST profile ${profileId} launched: ${wsEndpoint}`);
  return wsEndpoint;
}

/**
 * Close a running profile.
 */
export async function closeNSTProfile(profileId: string): Promise<void> {
  try {
    const res = await fetch(`${NST_API_BASE}/profiles/${profileId}/close`, {
      method: 'POST',
    });
    if (res.ok) {
      log(`NST profile ${profileId} closed`);
    }
  } catch (error) {
    console.error(`[NST] Failed to close profile ${profileId}:`, error);
  }
}

/**
 * Delete a profile permanently.
 */
export async function deleteNSTProfile(profileId: string): Promise<void> {
  try {
    const res = await fetch(`${NST_API_BASE}/profiles/${profileId}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      log(`NST profile ${profileId} deleted`);
    }
  } catch (error) {
    console.error(`[NST] Failed to delete profile ${profileId}:`, error);
  }
}

/**
 * List all profiles in NSTbrowser.
 */
export async function listNSTProfiles(): Promise<NSTProfile[]> {
  try {
    const res = await fetch(`${NST_API_BASE}/profiles`);
    if (!res.ok) return [];
    const data = (await res.json()) as { profiles?: NSTProfile[] };
    return data.profiles || [];
  } catch (error) {
    console.error('[NST] Failed to list profiles:', error);
    return [];
  }
}

// ─── CDP Connection ─────────────────────────────────────────────────────────

/**
 * Connect to a launched NSTbrowser profile via Playwright CDP.
 */
export async function connectToNSTProfile(wsEndpoint: string): Promise<Browser> {
  const browser = await chromium.connectOverCDP(wsEndpoint);
  log('Connected to NST profile via CDP');
  return browser;
}

// ─── Full Lifecycle ─────────────────────────────────────────────────────────

/**
 * Create, launch, and connect to a new NSTbrowser profile.
 * Returns everything needed to interact with the browser.
 */
export async function launchProfileForWallet(
  address: string,
  createOnDemand: boolean = true
): Promise<NSTBrowserLaunchResult> {
  await ensureNSTRunning();

  // Look for existing profile by address prefix
  const profiles = await listNSTProfiles();
  const shortAddr = address.substring(0, 10);
  const existing = profiles.find((p) => p.name.includes(shortAddr));

  let profileId: string;

  if (existing) {
    profileId = existing.id;
    log(`Reusing NST profile ${profileId} for ${shortAddr}...`);
  } else if (createOnDemand) {
    const profileName = `wallet_${shortAddr}`;
    profileId = await createNSTProfile({
      name: profileName,
      fingerprint: generateUniqueFingerprint(),
    });
    log(`Created new NST profile ${profileId} for ${shortAddr}...`);
  } else {
    throw new Error(`No NST profile found for address starting with ${shortAddr}`);
  }

  // Launch the profile
  const wsEndpoint = await launchNSTProfile(profileId);

  // Connect via CDP
  const browser = await connectToNSTProfile(wsEndpoint);

  // Get or create context
  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

  // Get or create page
  const pages = context.pages();
  const page =
    pages.length > 0 && !pages[0].isClosed()
      ? pages[0]
      : await context.newPage();

  return { browser, context, page, profileId };
}

// ─── Fingerprint Generation ─────────────────────────────────────────────────

/**
 * Generate a random fingerprint for a new profile.
 */
export function generateUniqueFingerprint(): Partial<NSTFingerprint> {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  ];

  const timezones = [
    'America/New_York',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
    'Australia/Sydney',
  ];

  const languages = [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9',
    'fr-FR,fr;q=0.9',
    'de-DE,de;q=0.9',
    'es-ES,es;q=0.9',
  ];

  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  return {
    userAgent: pick(userAgents),
    timezone: pick(timezones),
    language: pick(languages),
    screenResolution: '1920x1080',
  };
}

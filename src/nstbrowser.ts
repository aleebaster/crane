import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { log } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ─── Configuration ──────────────────────────────────────────────────────────

const NST_API_BASE = 'http://localhost:8848/api/v2';
const NST_EXECUTABLE = 'C:\\Users\\andre\\OneDrive\\Desktop\\Nstbrowser.lnk';

/**
 * Get the NSTbrowser API key from environment.
 * Generate one in NSTbrowser Client: Settings > API Keys
 */
function getApiKey(): string {
  const key = process.env.NST_API_KEY;
  if (!key) {
    throw new Error(
      'NST_API_KEY is not set. Generate an API key in NSTbrowser Client:\n' +
      '  1. Open NSTbrowser\n' +
      '  2. Go to Settings > API Keys\n' +
      '  3. Create a new key and copy it\n' +
      '  4. Set it in .env: NST_API_KEY=your_key_here'
    );
  }
  return key;
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': getApiKey(),
  };
}

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
  proxy?: string;
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
    const res = await fetch(`${NST_API_BASE}/browsers`, {
      method: 'GET',
      headers: { 'x-api-key': process.env.NST_API_KEY || '' },
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

// ─── Profile Management (API v2) ───────────────────────────────────────────

/**
 * Create a new browser profile in NSTbrowser.
 * API: POST /api/v2/profiles
 */
export async function createNSTProfile(config: NSTProfileConfig): Promise<string> {
  const body = {
    name: config.name,
    platform: 'Windows',
    kernelMilestone: '140',
    fingerprint: {
      flags: {
        audio: 'Noise',
        battery: 'Masked',
        canvas: 'Noise',
        clientRect: 'Noise',
        fonts: 'Masked',
        geolocation: 'Custom',
        geolocationPopup: 'Prompt',
        gpu: 'Allow',
        localization: 'Custom',
        screen: 'Custom',
        speech: 'Masked',
        timezone: 'Custom',
        webgl: 'Noise',
        webrtc: 'Custom',
      },
      userAgent: config.fingerprint?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      localization: {
        language: config.fingerprint?.language || 'en-US',
        languages: ['en-US', 'en'],
        timezone: config.fingerprint?.timezone || 'America/New_York',
      },
      screen: {
        width: 1920,
        height: 1080,
      },
      deviceMemory: 8,
      hardwareConcurrency: 16,
    },
  };

  if (config.proxy) {
    (body as Record<string, unknown>).proxy = config.proxy;
  }

  const res = await fetch(`${NST_API_BASE}/profiles`, {
    method: 'POST',
    headers: authHeaders(),
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
 * Launch a profile via the browser API and return CDP WebSocket endpoint.
 * API: POST /api/v2/browsers/
 */
export async function launchNSTProfile(profileId: string): Promise<string> {
  // First, start the browser via the Browsers API
  const startRes = await fetch(`${NST_API_BASE}/browsers/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      profileId,
      headless: false,
    }),
  });

  if (!startRes.ok) {
    const text = await startRes.text();
    throw new Error(`Failed to start NST browser for profile ${profileId}: ${startRes.status} ${text}`);
  }

  const startData = (await startRes.json()) as Record<string, unknown>;
  const browserId = startData.id as string;

  log(`NST browser started: ${browserId}`);

  // Get the debugger WebSocket URL
  const debugRes = await fetch(`${NST_API_BASE}/browsers/${browserId}/debugger`, {
    method: 'GET',
    headers: { 'x-api-key': getApiKey() },
  });

  if (!debugRes.ok) {
    const text = await debugRes.text();
    throw new Error(`Failed to get debugger for browser ${browserId}: ${debugRes.status} ${text}`);
  }

  const debugData = (await debugRes.json()) as Record<string, unknown>;
  const wsEndpoint = (debugData.wsUrl || debugData.webSocketDebuggerUrl || debugData.url) as string;

  log(`NST profile ${profileId} launched: ${wsEndpoint}`);
  return wsEndpoint;
}

/**
 * Close a running browser instance.
 * API: DELETE /api/v2/browsers/{id}
 */
export async function closeNSTProfile(profileId: string): Promise<void> {
  try {
    // Find the browser by profile ID and close it
    const listRes = await fetch(`${NST_API_BASE}/browsers`, {
      method: 'GET',
      headers: { 'x-api-key': getApiKey() },
    });
    if (!listRes.ok) return;

    const listData = (await listRes.json()) as { browsers?: Array<{ id: string; profileId: string }> };
    const browsers = listData.browsers || [];
    const browser = browsers.find((b) => b.profileId === profileId);

    if (browser) {
      const res = await fetch(`${NST_API_BASE}/browsers/${browser.id}`, {
        method: 'DELETE',
        headers: { 'x-api-key': getApiKey() },
      });
      if (res.ok) {
        log(`NST profile ${profileId} closed`);
      }
    }
  } catch (error) {
    console.error(`[NST] Failed to close profile ${profileId}:`, error);
  }
}

/**
 * Delete a profile permanently.
 * API: DELETE /api/v2/profiles/{id}
 */
export async function deleteNSTProfile(profileId: string): Promise<void> {
  try {
    const res = await fetch(`${NST_API_BASE}/profiles/${profileId}`, {
      method: 'DELETE',
      headers: { 'x-api-key': getApiKey() },
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
 * API: GET /api/v2/profiles
 */
export async function listNSTProfiles(): Promise<NSTProfile[]> {
  try {
    const res = await fetch(`${NST_API_BASE}/profiles`, {
      method: 'GET',
      headers: { 'x-api-key': getApiKey() },
    });
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
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
    'en-US',
    'en-GB',
    'fr-FR',
    'de-DE',
    'es-ES',
  ];

  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  return {
    userAgent: pick(userAgents),
    timezone: pick(timezones),
    language: pick(languages),
    screenResolution: '1920x1080',
  };
}

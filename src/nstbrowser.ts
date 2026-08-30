import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { log } from './logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProxyConfig, getNSTProxyPayload } from './proxy';

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
  proxy?: string | ProxyConfig;
}

export interface NSTBrowserLaunchResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  profileId: string;
}

// ─── Profile Manager Types ──────────────────────────────────────────────────

export type ProfileStrategy = 'round_robin' | 'least_used' | 'dedicated';

export interface NSTProfileMapping {
  id: string;
  name: string;
  wallets: string[];
}

export interface NSTDistribution {
  profileId: string;
  walletAddresses: string[];
  currentIndex: number;
  lastUsed: Date;
  requestCount: number;
}

// ─── Fingerprint Rotation Types ─────────────────────────────────────────────

export type RotationStrategy = 'per_request' | 'after_attempts' | 'never';

export interface FingerprintRotationConfig {
  enabled: boolean;
  rotationStrategy: RotationStrategy;
  attemptsBeforeRotation: number;
  maxFingerprints: number;
}

// ─── NST Status ─────────────────────────────────────────────────────────────

/**
 * Check if NSTbrowser API is reachable.
 */
export async function isNSTRunning(): Promise<boolean> {
  try {
    log(`[NST] Checking API at ${NST_API_BASE}/browsers...`);
    const res = await fetch(`${NST_API_BASE}/browsers`, {
      method: 'GET',
      headers: { 'x-api-key': process.env.NST_API_KEY || '' },
      signal: AbortSignal.timeout(5000),
    });
    log(`[NST] API check status: ${res.status}`);
    return res.ok;
  } catch (error) {
    log(`[NST] API check failed: ${error instanceof Error ? error.message : error}`);
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
  log(`[NST] Creating profile: ${config.name}`);
  log(`[NST] API endpoint: ${NST_API_BASE}/profiles`);

  const body: Record<string, unknown> = {
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
    if (typeof config.proxy === 'string') {
      body.proxy = config.proxy;
      log(`[NST] Using proxy (string): ${config.proxy}`);
    } else {
      body.proxy = getNSTProxyPayload(config.proxy);
      log(`[NST] Using proxy: ${config.proxy.type}://${config.proxy.host}:${config.proxy.port}`);
    }
  }

  log(`[NST] Sending request...`);
  const res = await fetch(`${NST_API_BASE}/profiles`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  log(`[NST] Response status: ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const text = await res.text();
    log(`[NST] Error response body: ${text}`);
    throw new Error(`Failed to create NST profile: ${res.status} ${text}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  log(`[NST] Response data: ${JSON.stringify(data)}`);

  const profileId = (data.profileId || data.id) as string;
  if (!profileId) {
    log(`[NST] WARNING: No profileId or id in response`);
    log(`[NST] Available keys: ${Object.keys(data).join(', ')}`);
  }
  log(`[NST] Profile created: ${profileId} (${config.name})`);
  return profileId;
}

/**
 * Launch a profile via the browser API and return CDP WebSocket endpoint.
 * API: POST /api/v2/browsers/
 */
export async function launchNSTProfile(profileId: string, proxy?: ProxyConfig): Promise<string> {
  log(`[NST] Launching profile: ${profileId}`);
  log(`[NST] API endpoint: ${NST_API_BASE}/browsers/`);

  const launchBody: Record<string, unknown> = {
    profileId,
    headless: false,
  };
  if (proxy) {
    launchBody.proxy = getNSTProxyPayload(proxy);
    log(`[NST] Using proxy: ${proxy.type}://${proxy.host}:${proxy.port}`);
  }

  log(`[NST] Sending launch request...`);
  const startRes = await fetch(`${NST_API_BASE}/browsers/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(launchBody),
  });

  log(`[NST] Launch response status: ${startRes.status} ${startRes.statusText}`);

  if (!startRes.ok) {
    const text = await startRes.text();
    log(`[NST] Launch error body: ${text}`);
    throw new Error(`Failed to start NST browser for profile ${profileId}: ${startRes.status} ${text}`);
  }

  const startData = (await startRes.json()) as Record<string, unknown>;
  log(`[NST] Launch response: ${JSON.stringify(startData)}`);

  const browserId = startData.id as string;
  if (!browserId) {
    log(`[NST] WARNING: No browser id in launch response`);
    log(`[NST] Available keys: ${Object.keys(startData).join(', ')}`);
  }
  log(`[NST] Browser started: ${browserId}`);

  log(`[NST] Getting debugger endpoint...`);
  const debugRes = await fetch(`${NST_API_BASE}/browsers/${browserId}/debugger`, {
    method: 'GET',
    headers: { 'x-api-key': getApiKey() },
  });

  log(`[NST] Debugger response status: ${debugRes.status}`);

  if (!debugRes.ok) {
    const text = await debugRes.text();
    log(`[NST] Debugger error body: ${text}`);
    throw new Error(`Failed to get debugger for browser ${browserId}: ${debugRes.status} ${text}`);
  }

  const debugData = (await debugRes.json()) as Record<string, unknown>;
  log(`[NST] Debugger response: ${JSON.stringify(debugData)}`);

  const wsEndpoint = (debugData.wsUrl || debugData.webSocketDebuggerUrl || debugData.url) as string;
  if (!wsEndpoint) {
    log(`[NST] WARNING: No WebSocket endpoint in debugger response`);
    log(`[NST] Available keys: ${Object.keys(debugData).join(', ')}`);
  }

  log(`[NST] Profile ${profileId} launched: ${wsEndpoint}`);
  return wsEndpoint;
}

/**
 * Close a running browser instance.
 */
export async function closeNSTProfile(profileId: string): Promise<void> {
  try {
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
 */
export async function listNSTProfiles(): Promise<NSTProfile[]> {
  try {
    log(`[NST] Listing profiles at ${NST_API_BASE}/profiles...`);
    const res = await fetch(`${NST_API_BASE}/profiles`, {
      method: 'GET',
      headers: { 'x-api-key': getApiKey() },
    });
    log(`[NST] List profiles status: ${res.status}`);
    if (!res.ok) {
      const text = await res.text();
      log(`[NST] List profiles error: ${text}`);
      return [];
    }
    const data = (await res.json()) as { profiles?: NSTProfile[] };
    log(`[NST] Found ${(data.profiles || []).length} profiles`);
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
  createOnDemand: boolean = true,
  proxy?: ProxyConfig
): Promise<NSTBrowserLaunchResult> {
  await ensureNSTRunning();

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
      proxy,
    });
    log(`Created new NST profile ${profileId} for ${shortAddr}...`);
  } else {
    throw new Error(`No NST profile found for address starting with ${shortAddr}`);
  }

  const wsEndpoint = await launchNSTProfile(profileId, proxy);
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

// ─── NSTProfileManager ──────────────────────────────────────────────────────

/**
 * Manages distribution of wallets across NSTbrowser profiles.
 * Supports round_robin, least_used, and dedicated strategies.
 */
export class NSTProfileManager {
  private profiles: NSTDistribution[] = [];
  private strategy: ProfileStrategy;

  constructor(profileConfigs: NSTProfileMapping[], strategy: ProfileStrategy = 'round_robin') {
    this.strategy = strategy;
    this.profiles = profileConfigs.map((p) => ({
      profileId: p.id,
      walletAddresses: p.wallets,
      currentIndex: 0,
      lastUsed: new Date(0),
      requestCount: 0,
    }));

    log(`[NST] ProfileManager initialized: ${this.profiles.length} profiles, strategy=${strategy}`);
  }

  /**
   * Get the NST profile ID for a given wallet address.
   * Returns null if no mapping found and no fallback available.
   */
  getProfileForWallet(address: string): string | null {
    // Direct mapping: check if address is assigned to a profile
    for (const profile of this.profiles) {
      if (profile.walletAddresses.includes(address)) {
        return profile.profileId;
      }
    }

    // No direct mapping — use strategy fallback
    return this.getNextAvailableProfile();
  }

  /**
   * Mark a profile as used after a request completes.
   */
  markProfileUsed(profileId: string): void {
    const profile = this.profiles.find((p) => p.profileId === profileId);
    if (profile) {
      profile.requestCount++;
      profile.lastUsed = new Date();
    }
  }

  /**
   * Check if a profile exists and is usable.
   */
  isProfileAvailable(profileId: string): boolean {
    return this.profiles.some((p) => p.profileId === profileId);
  }

  /**
   * Get stats for all profiles.
   */
  getStats(): Array<{ profileId: string; wallets: number; requests: number; lastUsed: Date }> {
    return this.profiles.map((p) => ({
      profileId: p.profileId,
      wallets: p.walletAddresses.length,
      requests: p.requestCount,
      lastUsed: p.lastUsed,
    }));
  }

  /**
   * Get all wallet addresses across all profiles.
   */
  getAllWallets(): string[] {
    return this.profiles.flatMap((p) => p.walletAddresses);
  }

  /**
   * Get the number of managed profiles.
   */
  get profileCount(): number {
    return this.profiles.length;
  }

  private getNextAvailableProfile(): string | null {
    if (this.profiles.length === 0) return null;

    switch (this.strategy) {
      case 'round_robin':
        return this.roundRobin();
      case 'least_used':
        return this.leastUsed();
      case 'dedicated':
        return this.getLeastLoaded();
      default:
        return this.roundRobin();
    }
  }

  private roundRobin(): string {
    const sorted = [...this.profiles].sort((a, b) => a.requestCount - b.requestCount);
    const selected = sorted[0];
    return selected.profileId;
  }

  private leastUsed(): string {
    const sorted = [...this.profiles].sort((a, b) => a.requestCount - b.requestCount);
    return sorted[0].profileId;
  }

  private getLeastLoaded(): string {
    const sorted = [...this.profiles].sort(
      (a, b) => a.walletAddresses.length - b.walletAddresses.length
    );
    return sorted[0].profileId;
  }
}

// ─── FingerprintRotator ─────────────────────────────────────────────────────

/**
 * Generates and rotates browser fingerprints across profiles.
 * Supports per-request, after-attempts, and never rotation strategies.
 */
export class FingerprintRotator {
  private currentIndex = 0;
  private fingerprints: Array<Partial<NSTFingerprint>> = [];
  private config: FingerprintRotationConfig;
  private profileUsage: Map<string, number> = new Map();

  constructor(config?: Partial<FingerprintRotationConfig>) {
    this.config = {
      enabled: true,
      rotationStrategy: 'per_request',
      attemptsBeforeRotation: 3,
      maxFingerprints: 10,
      ...config,
    };
    this.generateFingerprintPool();
    log(`[NST] FingerprintRotator: strategy=${this.config.rotationStrategy}, pool=${this.fingerprints.length}`);
  }

  /**
   * Get the next fingerprint for a given profile.
   */
  getNextFingerprint(profileId: string): Partial<NSTFingerprint> {
    if (!this.config.enabled || this.config.rotationStrategy === 'never') {
      return this.fingerprints[0];
    }

    const attempts = this.profileUsage.get(profileId) || 0;
    let shouldRotate = false;

    switch (this.config.rotationStrategy) {
      case 'per_request':
        shouldRotate = true;
        break;
      case 'after_attempts':
        shouldRotate = attempts >= this.config.attemptsBeforeRotation;
        break;
    }

    if (shouldRotate) {
      this.currentIndex = (this.currentIndex + 1) % this.fingerprints.length;
    }

    this.profileUsage.set(profileId, attempts + 1);
    return this.fingerprints[this.currentIndex];
  }

  /**
   * Reset usage counter for a profile.
   */
  resetProfileUsage(profileId: string): void {
    this.profileUsage.set(profileId, 0);
  }

  /**
   * Get the current fingerprint pool size.
   */
  get poolSize(): number {
    return this.fingerprints.length;
  }

  private generateFingerprintPool(): void {
    const generators = [
      this.generateWindowsFingerprint,
      this.generateMacFingerprint,
      this.generateLinuxFingerprint,
    ];

    for (let i = 0; i < this.config.maxFingerprints; i++) {
      const generator = generators[i % generators.length];
      this.fingerprints.push(generator());
    }
  }

  private generateWindowsFingerprint(): Partial<NSTFingerprint> {
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    return {
      userAgent: pick([
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
      ]),
      platform: 'Win32',
      language: pick(['en-US', 'en-GB', 'fr-FR', 'de-DE']),
      timezone: pick(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris']),
      screenResolution: pick(['1920x1080', '1366x768', '1536x864', '1440x900']),
      webglVendor: 'Google Inc. (Intel)',
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
  }

  private generateMacFingerprint(): Partial<NSTFingerprint> {
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    return {
      userAgent: pick([
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      ]),
      platform: 'MacIntel',
      language: pick(['en-US', 'en-GB', 'ja-JP']),
      timezone: pick(['America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo']),
      screenResolution: pick(['1920x1080', '1440x900', '1680x1050']),
      webglVendor: 'Google Inc. (Apple)',
      webglRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)',
    };
  }

  private generateLinuxFingerprint(): Partial<NSTFingerprint> {
    const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

    return {
      userAgent: pick([
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      ]),
      platform: 'Linux x86_64',
      language: pick(['en-US', 'en-GB', 'de-DE']),
      timezone: pick(['Europe/London', 'Europe/Paris', 'America/New_York']),
      screenResolution: pick(['1920x1080', '1366x768', '1600x900']),
      webglVendor: 'Google Inc. (Intel)',
      webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
  }
}

// ─── Fingerprint Generation (standalone) ────────────────────────────────────

/**
 * Generate a random fingerprint for a new profile.
 */
export function generateUniqueFingerprint(): Partial<NSTFingerprint> {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

  return {
    userAgent: pick([
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
    ]),
    timezone: pick([
      'America/New_York',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Asia/Tokyo',
      'Australia/Sydney',
    ]),
    language: pick(['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES']),
    screenResolution: '1920x1080',
  };
}

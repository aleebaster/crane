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

  const raw = (await res.json()) as Record<string, unknown>;
  log(`[NST] Response data: ${JSON.stringify(raw).substring(0, 300)}`);

  // NST API v2 wraps responses in { data: { ... } }
  const data = (raw.data || raw) as Record<string, unknown>;
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
 * API: POST /api/v2/browsers/{profileId}
 *
 * Retries up to LAUNCH_MAX_RETRIES times with backoff for transient errors.
 * Throws NSTProfileLaunchError for permanent failures (403, 400).
 */
export async function launchNSTProfile(profileId: string, _proxy?: ProxyConfig): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= LAUNCH_MAX_RETRIES; attempt++) {
    try {
      log(`[NST] Launching profile ${profileId} (attempt ${attempt}/${LAUNCH_MAX_RETRIES})...`);

      const startRes = await fetch(`${NST_API_BASE}/browsers/${profileId}`, {
        method: 'POST',
        headers: authHeaders(),
      });

      log(`[NST] Launch response: ${startRes.status} ${startRes.statusText}`);

      if (!startRes.ok) {
        const text = await startRes.text();
        log(`[NST] Launch error body: ${text}`);

        const err = new NSTProfileLaunchError(profileId, startRes.status, text);
        if (err.isPlanLimit) {
          log(`[NST] Plan limit reached for ${profileId} (code 6001) — skipping`);
          throw err;
        }
        if (err.isPermanent) {
          throw err;
        }
        lastError = err;
        if (attempt < LAUNCH_MAX_RETRIES) {
          const delay = LAUNCH_RETRY_DELAYS_MS[attempt - 1] || 10000;
          log(`[NST] Transient error, retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }

      const startRaw = (await startRes.json()) as Record<string, unknown>;
      const startData = (startRaw.data || startRaw) as Record<string, unknown>;
      const wsEndpoint = (startData.webSocketDebuggerUrl || startData.wsUrl || startData.url) as string;

      if (!wsEndpoint) {
        throw new Error(`No WebSocket endpoint returned for profile ${profileId}`);
      }

      log(`[NST] Profile ${profileId} launched: ${wsEndpoint}`);
      return wsEndpoint;
    } catch (error) {
      if (error instanceof NSTProfileLaunchError && error.isPermanent) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < LAUNCH_MAX_RETRIES) {
        const delay = LAUNCH_RETRY_DELAYS_MS[attempt - 1] || 10000;
        log(`[NST] Launch attempt ${attempt} failed: ${lastError.message}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError || new Error(`Failed to launch profile ${profileId} after ${LAUNCH_MAX_RETRIES} attempts`);
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
    const allProfiles: NSTProfile[] = [];
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      log(`[NST] Listing profiles (page ${page})...`);
      const res = await fetch(`${NST_API_BASE}/profiles?page=${page}&limit=50`, {
        method: 'GET',
        headers: { 'x-api-key': getApiKey() },
      });
      log(`[NST] List profiles status: ${res.status}`);

      if (!res.ok) {
        const text = await res.text();
        log(`[NST] List profiles error: ${text}`);
        break;
      }

      const raw = (await res.json()) as Record<string, unknown>;
      // NST API v2: { data: { docs: [...], hasNextPage, nextPage, ... } }
      const inner = (raw.data || raw) as Record<string, unknown>;
      const docs = (inner.docs || inner.profiles || inner.list || []) as Array<Record<string, unknown>>;

      for (const doc of docs) {
        const params = doc.parameters as Record<string, unknown> | undefined;
        const fp = (params?.fingerprint || doc.fingerprint || {}) as NSTFingerprint;
        allProfiles.push({
          id: (doc.profileId || doc.id || doc._id) as string,
          name: (doc.name || 'unnamed') as string,
          fingerprint: fp,
        });
      }

      hasNext = inner.hasNextPage === true;
      if (hasNext && inner.nextPage) {
        page = inner.nextPage as number;
      } else {
        hasNext = false;
      }
    }

    log(`[NST] Found ${allProfiles.length} profiles total`);
    return allProfiles;
  } catch (error) {
    console.error('[NST] Failed to list profiles:', error);
    return [];
  }
}

// ─── Profile Lookup ────────────────────────────────────────────────────────

/**
 * Get a single profile by its ID.
 * NST API v2 doesn't have a GET /profiles/{id} endpoint,
 * so we fetch the list and filter.
 */
export async function getProfileById(profileId: string): Promise<NSTProfile | null> {
  try {
    log(`[NST] Looking up profile: ${profileId}`);

    // Search through paginated profile list
    let page = 1;
    let hasNext = true;

    while (hasNext) {
      const res = await fetch(`${NST_API_BASE}/profiles?page=${page}&limit=50`, {
        method: 'GET',
        headers: { 'x-api-key': getApiKey() },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) break;

      const raw = (await res.json()) as Record<string, unknown>;
      const inner = (raw.data || raw) as Record<string, unknown>;
      const docs = (inner.docs || inner.profiles || inner.list || []) as Array<Record<string, unknown>>;

      for (const doc of docs) {
        const id = (doc.profileId || doc.id || doc._id) as string;
        if (id === profileId) {
          const params = doc.parameters as Record<string, unknown> | undefined;
          const fp = (params?.fingerprint || doc.fingerprint || {}) as NSTFingerprint;
          const profile: NSTProfile = {
            id,
            name: (doc.name || 'unnamed') as string,
            fingerprint: fp,
          };
          log(`[NST] Profile found: ${profile.name} (${profileId})`);
          return profile;
        }
      }

      hasNext = inner.hasNextPage === true;
      if (hasNext && inner.nextPage) {
        page = inner.nextPage as number;
      } else {
        hasNext = false;
      }
    }

    log(`[NST] Profile ${profileId} not found in any page`);
    return null;
  } catch (error) {
    log(`[NST] Failed to get profile ${profileId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Ensure a profile exists in NSTbrowser. Creates it if missing.
 */
export async function ensureProfileExists(
  profileId: string,
  profileName: string,
  proxy?: ProxyConfig
): Promise<void> {
  const existing = await getProfileById(profileId);
  if (!existing) {
    log(`[NST] Profile ${profileId} not found, creating...`);
    const newId = await createNSTProfile({
      name: profileName,
      fingerprint: generateUniqueFingerprint(),
      proxy,
    });
    log(`[NST] Created profile ${newId} as replacement for ${profileId}`);
  } else {
    log(`[NST] Profile ${profileId} exists: ${existing.name}`);
  }
}

// ─── Proxy Auto-Fix ───────────────────────────────────────────────────────

/**
 * Update a profile's proxy settings via NST API.
 * API: PUT /api/v2/profiles/{profileId}/proxy
 * This fixes broken proxy groups ("savedProxyGroup") by setting direct proxy.
 */
export async function updateProfileProxy(
  profileId: string,
  proxyUrl: string,
): Promise<boolean> {
  try {
    log(`[NST] Updating proxy for profile ${profileId}...`);
    const res = await fetch(`${NST_API_BASE}/profiles/${profileId}/proxy`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ url: proxyUrl }),
    });
    const raw = (await res.json()) as Record<string, unknown>;
    const ok = !raw.err;
    if (ok) {
      log(`[NST] Proxy updated for ${profileId}`);
    } else {
      log(`[NST] Proxy update failed: ${raw.msg}`);
    }
    return ok;
  } catch (error) {
    log(`[NST] Proxy update error: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * Fix broken profiles by updating their proxy config.
 * Profiles with "savedProxyGroup" setting referencing non-existent groups
 * need to be switched to direct proxy via the API.
 */
export async function fixBrokenProfiles(
  profiles: NSTProfileMapping[],
  proxyUrl: string,
): Promise<void> {
  log(`[NST] Checking ${profiles.length} profiles for broken proxy config...`);

  // Fetch all profiles from API to check their proxyConfig
  const allProfiles = await listNSTProfiles();

  for (const profile of profiles) {
    const apiProfile = allProfiles.find(p => p.id === profile.id);
    if (!apiProfile) {
      log(`[NST]   ${profile.name}: not found in NSTbrowser`);
      continue;
    }

    // Check if profile needs proxy fix by looking at proxyConfig from raw API
    // We can't access proxyConfig through listNSTProfiles, so we fetch raw
    try {
      const res = await fetch(`${NST_API_BASE}/profiles?page=1&limit=50`, {
        method: 'GET',
        headers: { 'x-api-key': getApiKey() },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const raw = (await res.json()) as Record<string, unknown>;
      const inner = (raw.data || raw) as Record<string, unknown>;
      const docs = (inner.docs || []) as Array<Record<string, unknown>>;

      const doc = docs.find(d => (d.profileId || d.id) === profile.id);
      if (!doc) continue;

      const proxyConfig = (doc.proxyConfig || {}) as Record<string, unknown>;
      const setting = proxyConfig.setting as string;

      if (setting === 'savedProxyGroup' || !setting) {
        log(`[NST]   ${profile.name}: broken proxy (setting=${setting || 'null'}), fixing...`);
        await updateProfileProxy(profile.id, proxyUrl);
      } else {
        log(`[NST]   ${profile.name}: proxy OK (setting=${setting})`);
      }
    } catch {
      // Skip on error — validation will catch it later
    }
  }
}

// ─── Profile Verification ─────────────────────────────────────────────────

/**
 * Verify which profiles can actually be launched.
 * Some profiles may fail with 403 if their proxy config is broken.
 * Returns only the profiles that successfully launch.
 */
export async function verifyProfiles(
  profileConfigs: NSTProfileMapping[]
): Promise<NSTProfileMapping[]> {
  log(`[NST] Verifying ${profileConfigs.length} profiles can launch...`);
  const working: NSTProfileMapping[] = [];

  for (const profile of profileConfigs) {
    try {
      log(`[NST] Testing launch for ${profile.name} (${profile.id.substring(0, 8)}...)`);
      const wsEndpoint = await launchNSTProfile(profile.id);
      if (wsEndpoint) {
        log(`[NST]   ✅ ${profile.name} — launchable`);
        working.push(profile);

        // Close the test instance immediately
        await closeNSTProfile(profile.id);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('403')) {
        log(`[NST]   ❌ ${profile.name} — 403 (broken proxy config)`);
      } else {
        log(`[NST]   ⚠️ ${profile.name} — ${msg.substring(0, 100)}`);
      }
    }
  }

  log(`[NST] Verification complete: ${working.length}/${profileConfigs.length} profiles launchable`);
  return working;
}

// ─── Retry Configuration ─────────────────────────────────────────────────

const LAUNCH_MAX_RETRIES = 3;
const LAUNCH_RETRY_DELAYS_MS = [2000, 5000, 10000];

/**
 * Error classification for NSTbrowser launch failures.
 * - PLAN_LIMIT: account exceeded launch quota (code 6001). Permanent.
 * - PROXY_ERROR: broken proxy configuration (403 with proxy body). Permanent.
 * - PERMANENT: other permanent failures (400 without proxy body, etc.).
 * - TRANSIENT: temporary errors worth retrying (5xx, network, etc.).
 */
export type NSTErrorReason = 'PLAN_LIMIT' | 'PROXY_ERROR' | 'PERMANENT' | 'TRANSIENT';

/**
 * Error thrown when an NSTbrowser profile fails to launch.
 * Parses the API response body to extract NST error codes.
 */
export class NSTProfileLaunchError extends Error {
  /** NST API error code (e.g. 6001 for plan limit). 0 if not present. */
  public readonly nstCode: number;
  /** Classified reason for the failure. */
  public readonly reason: NSTErrorReason;

  constructor(
    public readonly profileId: string,
    public readonly httpStatus: number,
    public readonly apiMessage: string,
  ) {
    super(`Profile ${profileId} launch failed: HTTP ${httpStatus} — ${apiMessage}`);
    this.name = 'NSTProfileLaunchError';

    // Parse NST error code from response body
    this.nstCode = this.parseNstCode(apiMessage);
    this.reason = this.classifyReason();
  }

  /** Whether retries would help. */
  get isPermanent(): boolean {
    return this.reason !== 'TRANSIENT';
  }

  /** Whether this is a plan-limit error (code 6001). */
  get isPlanLimit(): boolean {
    return this.nstCode === 6001;
  }

  private parseNstCode(body: string): number {
    try {
      const parsed = JSON.parse(body);
      return parsed?.code || 0;
    } catch {
      return 0;
    }
  }

  private classifyReason(): NSTErrorReason {
    // Code 6001 = plan limit (permanent, not retryable)
    if (this.nstCode === 6001) return 'PLAN_LIMIT';
    // 403 = proxy configuration error (permanent)
    if (this.httpStatus === 403) return 'PROXY_ERROR';
    // Other 4xx = permanent
    if (this.httpStatus >= 400 && this.httpStatus < 500) return 'PERMANENT';
    // 5xx or network = transient
    return 'TRANSIENT';
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

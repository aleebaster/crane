import { Browser, BrowserContext, Page } from 'playwright-core';
import { log, logError } from './logger';
import {
  BrowserConfig,
  launchBrowser,
  launchIsolatedProfile,
  closeIsolatedProfile,
  checkNSTStatus,
} from './browser';
import {
  ensureNSTRunning,
  isNSTRunning,
  closeNSTProfile,
  NSTProfileLaunchError,
  NSTProfileMapping,
  launchNSTProfile,
  fixBrokenProfiles,
  connectToNSTProfile,
} from './nstbrowser';
import { FaucetConfig, processWallet, resetForNextWallet, isValidSignetAddress } from './faucet';
import { WalletResult } from './faucet';
import { checkCloudflareTurnstile, CloudflareVerificationResult } from './cloudflare';
import * as fs from 'fs';
import * as path from 'path';
import {
  HistoryData,
  RequestRecord,
  CycleRecord,
  loadHistory,
  saveHistory,
  addSession,
  addCycle,
  addRequest,
  maskAddress,
} from './history';
import {
  calculateNextRequestTime,
  calculateAdaptiveCooldown,
  parseRateLimitMessage,
  parseErrorForNextAllowed,
  waitWithCountdown,
  formatDuration,
  WaitDecision,
} from './scheduler';

export const MAX_WALLETS = 50;

export interface Config {
  wallets: string[];
  browser: BrowserConfig;
  faucet: FaucetConfig;
}

const DEFAULT_CONFIG: Config = {
  wallets: [],
  browser: {
    userDataDir: 'C:\\Users\\andre\\AppData\\Local\\Google\\Chrome\\User Data',
    profileDirectory: 'Profile 2',
    headless: false,
  },
  faucet: {
    url: 'https://signet257.bublina.eu.org/',
    walletTimeoutMs: 300000,
  },
};

// ─── Profile Result Tracking ─────────────────────────────────────────────

interface ProfileResult {
  profileIndex: number;
  profileId: string;
  profileName: string;
  status: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  errorMessage?: string;
  walletResults: WalletResult[];
  walletSuccess: number;
  walletFailed: number;
  walletSkipped: number;
}

// ─── Config Loading ──────────────────────────────────────────────────────

function createDefaultConfig(configPath: string): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
}

export function loadConfig(configPath: string): Config {
  if (!fs.existsSync(configPath)) {
    log(`Config not found at ${configPath}`);
    createDefaultConfig(configPath);
    log(`Created default config at ${configPath}`);
    log('Please edit the config file to add your wallet addresses, then run again.');
    throw new Error(`Config created at ${configPath}. Please edit it with your wallet addresses and run again.`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as Config;

  if (!config.wallets || !Array.isArray(config.wallets) || config.wallets.length === 0) {
    throw new Error('Config must contain a non-empty "wallets" array');
  }

  if (config.wallets.length > MAX_WALLETS) {
    throw new Error(`Maximum ${MAX_WALLETS} wallets supported, got ${config.wallets.length}`);
  }

  for (let i = 0; i < config.wallets.length; i++) {
    const addr = config.wallets[i].trim();
    if (!isValidSignetAddress(addr)) {
      throw new Error(`Invalid Signet address at index ${i}: ${addr}`);
    }
    config.wallets[i] = addr;
  }

  config.browser = { ...DEFAULT_CONFIG.browser, ...config.browser };
  config.faucet = { ...DEFAULT_CONFIG.faucet, ...config.faucet };

  if (process.env.CHROME_PATH) {
    config.browser.chromePath = process.env.CHROME_PATH;
  }
  if (process.env.WALLET_TIMEOUT_MS) {
    config.faucet.walletTimeoutMs = parseInt(process.env.WALLET_TIMEOUT_MS, 10);
  }

  return config;
}

// ─── Wallet Mapping & Validation ─────────────────────────────────────────

/**
 * Build deterministic mapping: 50 wallets → 10 profiles × 5 wallets.
 * Config already defines this via nstProfiles[].wallets.
 * This function validates and returns the mapping.
 */
function buildWalletMapping(config: Config): NSTProfileMapping[] {
  const profiles = config.browser.nstProfiles;
  if (!profiles || profiles.length === 0) {
    throw new Error('No NST profiles configured. Set browser.nstProfiles in config.');
  }

  // Validate: every wallet in config.wallets must appear in exactly one profile
  const allAssignedWallets = new Set<string>();
  const allProfileWallets: string[] = [];

  for (const profile of profiles) {
    for (const w of profile.wallets) {
      if (allAssignedWallets.has(w)) {
        throw new Error(`Wallet ${w} is assigned to multiple profiles!`);
      }
      allAssignedWallets.add(w);
      allProfileWallets.push(w);
    }
  }

  // Check unassigned wallets
  const unassigned = config.wallets.filter(w => !allAssignedWallets.has(w));
  if (unassigned.length > 0) {
    throw new Error(
      `${unassigned.length} wallet(s) not assigned to any profile: ${unassigned.map(w => w.substring(0, 10)).join(', ')}. ` +
      `Assign them to profiles in config.nst.json.`
    );
  }

  // Check extra wallets in profiles
  const configWalletSet = new Set(config.wallets);
  const extraInProfiles = allProfileWallets.filter(w => !configWalletSet.has(w));
  if (extraInProfiles.length > 0) {
    log(`[NST] WARNING: ${extraInProfiles.length} wallet(s) in profiles not found in config.wallets — they will be skipped`);
  }

  return profiles;
}

function logWalletMapping(profiles: NSTProfileMapping[]): void {
  console.log('\n============================================================');
  console.log('NST WALLET MAPPING');
  console.log('============================================================');

  let totalWallets = 0;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const start = totalWallets;
    totalWallets += p.wallets.length;
    console.log(`[NST] Profile ${i + 1} (${p.name.substring(0, 12)}) → wallets ${start}-${totalWallets - 1} [${p.id.substring(0, 8)}...]`);
  }

  console.log('');
  console.log('[NST] Wallet allocation:');
  console.log(`[NST]   Total wallets: ${totalWallets}`);
  console.log(`[NST]   Profiles: ${profiles.length}`);

  const allWallets = profiles.flatMap(p => p.wallets);
  const uniqueWallets = new Set(allWallets);
  const duplicates = allWallets.length - uniqueWallets.size;

  console.log(`[NST]   Wallets per profile: ${profiles.map(p => p.wallets.length).join(', ')}`);
  console.log(`[NST]   Assigned: ${allWallets.length}`);
  console.log(`[NST]   Unique: ${uniqueWallets.size}`);
  console.log(`[NST]   Duplicates: ${duplicates}`);
  console.log('============================================================\n');

  if (duplicates > 0) {
    throw new Error(`${duplicates} duplicate wallet(s) found across profiles!`);
  }
}

// ─── Profile Validation ──────────────────────────────────────────────────

interface ProfileValidationResult {
  profile: NSTProfileMapping;
  launchable: boolean;
  ip?: string;
  errorMessage?: string;
}

/**
 * Detect the public IP of a launched profile by navigating to an IP detection service.
 */
async function detectProfileIP(page: Page): Promise<string> {
  try {
    const response = await page.goto('https://api.ipify.org?format=json', {
      waitUntil: 'load',
      timeout: 15000,
    });
    if (response && response.ok()) {
      const body = await response.text();
      const data = JSON.parse(body);
      return data.ip || 'unknown';
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

async function validateProfiles(profiles: NSTProfileMapping[]): Promise<NSTProfileMapping[]> {
  console.log('\n============================================================');
  console.log('NST PROFILE VALIDATION');
  console.log('============================================================');

  const results: ProfileValidationResult[] = [];

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    process.stdout.write(`Profile ${i + 1} (${profile.name}) ... `);

    try {
      const wsEndpoint = await launchNSTProfile(profile.id);
      if (wsEndpoint) {
        // Connect and detect IP
        const browser = await connectToNSTProfile(wsEndpoint);
        const contexts = browser.contexts();
        const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
        const pages = context.pages();
        const page = pages.length > 0 && !pages[0].isClosed() ? pages[0] : await context.newPage();

        const ip = await detectProfileIP(page);
        console.log(`SUCCESS (IP: ${ip})`);
        results.push({ profile, launchable: true, ip });

        // Clean up
        await browser.close();
        await closeNSTProfile(profile.id);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (error instanceof NSTProfileLaunchError) {
        console.log(`FAILED (HTTP ${error.httpStatus})`);
        results.push({ profile, launchable: false, errorMessage: `HTTP ${error.httpStatus}` });
      } else if (msg.includes('403')) {
        console.log('FAILED (403)');
        results.push({ profile, launchable: false, errorMessage: '403' });
      } else if (msg.includes('plan limits')) {
        console.log('FAILED (plan limits)');
        results.push({ profile, launchable: false, errorMessage: 'NSTbrowser plan limit exceeded' });
      } else {
        console.log(`FAILED (${msg.substring(0, 60)})`);
        results.push({ profile, launchable: false, errorMessage: msg.substring(0, 100) });
      }
    }
  }

  // Summary
  const launchable = results.filter(r => r.launchable).map(r => r.profile);
  const failed = results.filter(r => !r.launchable);
  const ips = results.filter(r => r.ip && r.ip !== 'unknown').map(r => r.ip!);
  const uniqueIps = new Set(ips);

  console.log('');
  console.log(`Launchable: ${launchable.length}/${profiles.length}`);
  console.log(`Failed: ${failed.length}/${profiles.length}`);

  if (ips.length > 0) {
    console.log(`\nIP addresses detected:`);
    for (const r of results.filter(r => r.ip)) {
      const icon = r.launchable ? '✅' : '❌';
      console.log(`  ${icon} ${r.profile.name}: ${r.ip}`);
    }
    if (ips.length !== uniqueIps.size) {
      console.log(`\n⚠️  Duplicate IPs detected:`);
      for (const ip of uniqueIps) {
        const profiles_with_ip = results.filter(r => r.ip === ip).map(r => r.profile.name);
        if (profiles_with_ip.length > 1) {
          console.log(`  ${ip} → ${profiles_with_ip.join(', ')}`);
        }
      }
    }
  }

  console.log('============================================================\n');

  return launchable;
}

// ─── Navigation ──────────────────────────────────────────────────────────

async function navigateToFaucet(page: Page, faucetUrl: string): Promise<void> {
  log(`Navigating to: ${faucetUrl}`);
  await page.goto(faucetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  log(`Navigation completed — URL: ${page.url()}`);

  if (page.url() === 'about:blank') {
    throw new Error('Navigation failed: page is still about:blank');
  }

  log('Waiting for faucet form...');
  try {
    await page.waitForSelector('#address', {
      state: 'visible',
      timeout: 300000,
    });
    log('Faucet form detected');
  } catch {
    log('Faucet form not detected after 5 minutes, waiting for manual Cloudflare...');
    await page.waitForSelector('#address', {
      state: 'visible',
      timeout: 300000,
    });
    log('Faucet form detected after Cloudflare');
  }
}

// ─── Profile Processing ──────────────────────────────────────────────────

/**
 * Process all wallets for a single profile.
 * Returns wallet results. Errors are caught per-wallet — one wallet failure
 * does NOT stop the remaining wallets.
 */
async function processProfileWallets(
  page: Page,
  wallets: string[],
  profileIndex: number,
  profileName: string,
  config: Config,
  history: HistoryData,
  cycleNumber: number,
): Promise<{ walletResults: WalletResult[]; walletSuccess: number; walletFailed: number; walletSkipped: number }> {
  const walletResults: WalletResult[] = [];
  let walletSuccess = 0;
  let walletFailed = 0;
  let walletSkipped = 0;

  for (let wi = 0; wi < wallets.length; wi++) {
    const address = wallets[wi];
    const shortAddr = address.substring(0, 10);

    // Check history: skip already-completed wallets
    const alreadyCompleted = history.requests.some(
      r => r.address === maskAddress(address) && r.result === 'COMPLETED'
    );
    if (alreadyCompleted) {
      log(`[NST] Profile ${profileIndex + 1} | Wallet ${wi + 1}/${wallets.length} | ${shortAddr}... | SKIPPED (already completed)`);
      walletSkipped++;
      continue;
    }

    log('----------------------------------------');
    log(`[NST] Profile ${profileIndex + 1} | Wallet ${wi + 1}/${wallets.length}`);
    log(`[NST] Address: ${shortAddr}...`);
    log('[NST] Processing faucet request...');

    try {
      const lastRequest = history.requests.length > 0 ? history.requests[history.requests.length - 1] : null;
      const waitDecision = calculateNextRequestTime(history);

      if (waitDecision.waitMs > 0) {
        log(`[NST] Cooldown: ${Math.round(waitDecision.waitMs / 1000)}s — ${waitDecision.reason}`);
        await waitWithCountdown(waitDecision.waitMs, waitDecision.reason);
      }

      // Cloudflare check
      const cfResult = await checkCloudflareTurnstile(page);
      if (!cfResult.verified) {
        log('Waiting for Cloudflare verification...');
        const maxWait = 300_000;
        const waitStart = Date.now();
        while (Date.now() - waitStart < maxWait) {
          const recheck = await checkCloudflareTurnstile(page);
          if (recheck.verified) break;
          await page.waitForTimeout(2000);
        }
      }

      if (wi > 0) {
        await resetForNextWallet(page);
      }

      const result = await processWallet(
        page,
        address,
        wi,
        wallets.length,
        config.faucet.walletTimeoutMs,
        cycleNumber,
      );

      walletResults.push(result);

      if (result.state === 'COMPLETED') {
        walletSuccess++;
        log(`[NST] Profile ${profileIndex + 1} | Wallet ${wi + 1}/${wallets.length} | SUCCESS`);
      } else {
        walletFailed++;
        log(`[NST] Profile ${profileIndex + 1} | Wallet ${wi + 1}/${wallets.length} | ${result.state}`);
      }

      // Record in history
      const rateLimitInfo = result.errorText ? parseRateLimitMessage(result.errorText) : null;
      let nextAllowedAt = result.nextAllowedAt;
      if (result.state === 'ERROR' && result.errorText) {
        const parsedNextAllowed = parseErrorForNextAllowed(result.errorText);
        if (parsedNextAllowed) nextAllowedAt = parsedNextAllowed;
      }

      const requestRecord: RequestRecord = {
        cycleNumber,
        walletIndex: wi,
        address: maskAddress(address),
        startedAt: result.startedAt.toISOString(),
        cloudflareDetectedAt: null,
        cloudflarePassedAt: null,
        cloudflareDurationMs: cfResult.durationMs,
        submitAt: result.submitAt?.toISOString() || null,
        resultAt: result.resultAt?.toISOString() || null,
        requestDurationMs: result.requestDurationMs,
        cooldownDurationMs: null,
        result: result.state,
        errorText: result.errorText,
        nextAllowedAt: nextAllowedAt?.toISOString() || null,
        txid: result.txid || null,
      };
      addRequest(history, requestRecord);
      saveHistory(history);
    } catch (walletError) {
      walletFailed++;
      const msg = walletError instanceof Error ? walletError.message : String(walletError);
      log(`[NST] Profile ${profileIndex + 1} | Wallet ${wi + 1}/${wallets.length} | FAILED`);
      log(`[NST]   Reason: ${msg}`);
      logError('Wallet processing error', walletError);

      // Record the failure
      const failRecord: RequestRecord = {
        cycleNumber,
        walletIndex: wi,
        address: maskAddress(address),
        startedAt: new Date().toISOString(),
        cloudflareDetectedAt: null,
        cloudflarePassedAt: null,
        cloudflareDurationMs: null,
        submitAt: null,
        resultAt: new Date().toISOString(),
        requestDurationMs: null,
        cooldownDurationMs: null,
        result: 'ERROR',
        errorText: msg,
        nextAllowedAt: null,
        txid: null,
      };
      addRequest(history, failRecord);
      saveHistory(history);
    }
  }

  return { walletResults, walletSuccess, walletFailed, walletSkipped };
}

// ─── Report ──────────────────────────────────────────────────────────────

function printFinalReport(profileResults: ProfileResult[], totalDurationMs: number): void {
  console.log('\n============================================================');
  console.log('FINAL NST REPORT');
  console.log('============================================================');
  console.log('');

  const profileSuccess = profileResults.filter(r => r.status === 'SUCCESS').length;
  const profileFailed = profileResults.filter(r => r.status === 'FAILED').length;
  const profileSkipped = profileResults.filter(r => r.status === 'SKIPPED').length;

  const totalWalletSuccess = profileResults.reduce((s, r) => s + r.walletSuccess, 0);
  const totalWalletFailed = profileResults.reduce((s, r) => s + r.walletFailed, 0);
  const totalWalletSkipped = profileResults.reduce((s, r) => s + r.walletSkipped, 0);
  const totalAssigned = profileResults.reduce((s, r) => s + r.walletResults.length + r.walletSkipped, 0);

  console.log('Profiles:');
  console.log(`  SUCCESS: ${profileSuccess}`);
  console.log(`  FAILED:  ${profileFailed}`);
  console.log(`  SKIPPED: ${profileSkipped}`);
  console.log('');

  console.log('Wallets:');
  console.log(`  SUCCESS: ${totalWalletSuccess}`);
  console.log(`  FAILED:  ${totalWalletFailed}`);
  console.log(`  SKIPPED: ${totalWalletSkipped}`);
  console.log('');

  for (const r of profileResults) {
    const total = r.walletSuccess + r.walletFailed + r.walletSkipped;
    const statusIcon = r.status === 'SUCCESS' ? '✅' : r.status === 'FAILED' ? '❌' : '⏭️';
    if (r.status === 'FAILED') {
      console.log(`${statusIcon} Profile ${r.profileIndex + 1} (${r.profileName}): ${r.status} — ${r.errorMessage || 'unknown'}`);
    } else {
      console.log(`${statusIcon} Profile ${r.profileIndex + 1} (${r.profileName}): ${r.walletSuccess}/${total} wallets`);
    }
  }

  console.log('');
  console.log('Total:');
  console.log(`  Assigned:   ${totalAssigned}`);
  console.log(`  Processed:  ${totalWalletSuccess + totalWalletFailed}`);
  console.log(`  Successful: ${totalWalletSuccess}`);
  console.log(`  Failed:     ${totalWalletFailed}`);
  console.log(`  Skipped:    ${totalWalletSkipped}`);
  console.log(`  Duration:   ${formatDuration(totalDurationMs)}`);
  console.log('============================================================\n');
}

// ─── Main Run ────────────────────────────────────────────────────────────

export async function run(configPath: string = 'config/config.json'): Promise<void> {
  const totalStartTime = Date.now();

  log('Crane started');

  const config = loadConfig(configPath);
  log(`Loaded ${config.wallets.length} wallet(s)`);

  const history = loadHistory();
  addSession(history);
  saveHistory(history);

  let shouldStop = false;

  const shutdownHandler = () => {
    log('Shutdown signal received, stopping gracefully...');
    shouldStop = true;
    process.removeListener('SIGINT', shutdownHandler);
    process.removeListener('SIGTERM', shutdownHandler);
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  try {
    // ─── NST Mode: Profile-based processing ──────────────────────────
    if (config.browser.useNSTbrowser) {
      await ensureNSTRunning();

      // Build and validate wallet mapping
      const profiles = buildWalletMapping(config);
      logWalletMapping(profiles);

      // Auto-fix broken proxy configs before validation
      if (config.browser.proxy?.enabled) {
        const proxyUrl = `http://${config.browser.proxy.username}:${config.browser.proxy.password}@${config.browser.proxy.host}:${config.browser.proxy.port}`;
        await fixBrokenProfiles(profiles, proxyUrl);
      }

      // Validate all profiles can launch
      const launchableProfiles = await validateProfiles(profiles);

      if (launchableProfiles.length === 0) {
        console.log('\n❌ No profiles could be launched. Fix proxy config in NSTbrowser and try again.');
        console.log('For each broken profile: profile settings → Proxy → set to "No proxy" or fix proxy group.\n');
        return;
      }

      console.log(`\n============================================================`);
      console.log(`NST FAUCET RUN`);
      console.log(`============================================================`);
      console.log(`Profiles: ${launchableProfiles.length} launchable / ${profiles.length} total`);
      console.log(`Wallets: ${config.wallets.length}`);
      console.log(`Wallets/profile: ${launchableProfiles.map(p => p.wallets.length).join(', ')}`);
      console.log(`============================================================\n`);

      const profileResults: ProfileResult[] = [];
      let cycleNumber = 1;

      // Process each profile sequentially — fully isolated lifecycle
      for (let pi = 0; pi < profiles.length; pi++) {
        if (shouldStop) break;

        const profile = profiles[pi];
        const isLaunchable = launchableProfiles.some(lp => lp.id === profile.id);

        if (!isLaunchable) {
          log(`[NST] Profile ${pi + 1} (${profile.name}) — SKIPPED (not launchable)`);
          profileResults.push({
            profileIndex: pi,
            profileId: profile.id,
            profileName: profile.name,
            status: 'SKIPPED',
            errorMessage: 'Profile failed validation (403/broken proxy)',
            walletResults: [],
            walletSuccess: 0,
            walletFailed: 0,
            walletSkipped: profile.wallets.length,
          });
          continue;
        }

        log(`\n[NST] ═══ Profile ${pi + 1}/${profiles.length}: ${profile.name} ═══`);
        log(`[NST] ID: ${profile.id}`);
        log(`[NST] Wallets: ${profile.wallets.length}`);

        let browser: Browser | null = null;
        let page: Page | null = null;

        try {
          // Launch isolated profile session
          const session = await launchIsolatedProfile(profile.id);
          browser = session.browser;
          page = session.page;

          // Navigate to faucet
          await navigateToFaucet(page, config.faucet.url);

          // Process this profile's wallets
          const walletOutcome = await processProfileWallets(
            page,
            profile.wallets,
            pi,
            profile.name,
            config,
            history,
            cycleNumber,
          );

          profileResults.push({
            profileIndex: pi,
            profileId: profile.id,
            profileName: profile.name,
            status: 'SUCCESS',
            walletResults: walletOutcome.walletResults,
            walletSuccess: walletOutcome.walletSuccess,
            walletFailed: walletOutcome.walletFailed,
            walletSkipped: walletOutcome.walletSkipped,
          });
        } catch (profileError) {
          const msg = profileError instanceof Error ? profileError.message : String(profileError);
          log(`[NST] Profile ${pi + 1} (${profile.name}) — FAILED: ${msg}`);
          logError(`Profile ${pi + 1} error`, profileError);

          profileResults.push({
            profileIndex: pi,
            profileId: profile.id,
            profileName: profile.name,
            status: 'FAILED',
            errorMessage: msg.substring(0, 200),
            walletResults: [],
            walletSuccess: 0,
            walletFailed: profile.wallets.length,
            walletSkipped: 0,
          });
        } finally {
          // ALWAYS close the isolated session — even on error
          await closeIsolatedProfile(browser, profile.id);
          log(`[NST] Profile ${pi + 1} session closed`);
        }

        cycleNumber++;
      }

      // Final report
      const totalDuration = Date.now() - totalStartTime;
      printFinalReport(profileResults, totalDuration);

    } else {
      // ─── Chrome CDP Mode: original behavior ────────────────────────
      const launchResult = await launchBrowser(config.browser);
      let browser = launchResult.browser;
      let context = launchResult.context;
      let page = launchResult.page;

      await navigateToFaucet(page, config.faucet.url);

      log('Starting wallet processing');

      let cycleNumber = 1;

      while (!shouldStop) {
        const cycleStartMs = Date.now();
        log('========================================');
        log(`Starting Cycle ${cycleNumber}`);
        log(`Wallets: ${config.wallets.length}`);
        log('========================================');

        const cycleResults: WalletResult[] = [];

        for (let i = 0; i < config.wallets.length; i++) {
          if (shouldStop) break;

          const address = config.wallets[i];

          const lastRequest = history.requests.length > 0 ? history.requests[history.requests.length - 1] : null;
          const waitDecision = calculateNextRequestTime(history);

          log('----------------------------------------');
          log(`Cycle ${cycleNumber} | Wallet ${i + 1}/${config.wallets.length}`);

          if (waitDecision.waitMs > 0) {
            await waitWithCountdown(waitDecision.waitMs, waitDecision.reason);
          }

          if (shouldStop) break;

          const cfResult = await checkCloudflareTurnstile(page);
          if (!cfResult.verified) {
            const maxWait = 300_000;
            const waitStart = Date.now();
            while (Date.now() - waitStart < maxWait) {
              const recheck = await checkCloudflareTurnstile(page);
              if (recheck.verified) break;
              await page.waitForTimeout(2000);
            }
          }

          if (i > 0) {
            await resetForNextWallet(page);
          }

          const result = await processWallet(
            page,
            address,
            i,
            config.wallets.length,
            config.faucet.walletTimeoutMs,
            cycleNumber,
          );

          cycleResults.push(result);

          let nextAllowedAt = result.nextAllowedAt;
          if (result.state === 'ERROR' && result.errorText) {
            const parsedNextAllowed = parseErrorForNextAllowed(result.errorText);
            if (parsedNextAllowed) nextAllowedAt = parsedNextAllowed;
          }

          const requestRecord: RequestRecord = {
            cycleNumber,
            walletIndex: i,
            address: maskAddress(address),
            startedAt: result.startedAt.toISOString(),
            cloudflareDetectedAt: null,
            cloudflarePassedAt: null,
            cloudflareDurationMs: cfResult.durationMs,
            submitAt: result.submitAt?.toISOString() || null,
            resultAt: result.resultAt?.toISOString() || null,
            requestDurationMs: result.requestDurationMs,
            cooldownDurationMs: waitDecision.currentCooldownMs,
            result: result.state,
            errorText: result.errorText,
            nextAllowedAt: nextAllowedAt?.toISOString() || null,
            txid: result.txid || null,
          };
          addRequest(history, requestRecord);
          saveHistory(history);
        }

        if (!shouldStop) {
          const completed = cycleResults.filter((r) => r.state === 'COMPLETED').length;
          const errors = cycleResults.filter((r) => r.state === 'ERROR').length;
          const timeouts = cycleResults.filter((r) => r.state === 'TIMEOUT').length;
          const cycleDurationMs = Date.now() - cycleStartMs;

          console.log('\n========================================');
          console.log(`Cycle ${cycleNumber} completed`);
          console.log(`Successful: ${completed}`);
          console.log(`Errors: ${errors}`);
          console.log(`Timeout: ${timeouts}`);
          console.log(`Duration: ${formatDuration(cycleDurationMs)}`);
          console.log('========================================\n');

          const cycleRecord: CycleRecord = {
            cycleNumber,
            startedAt: new Date(cycleStartMs).toISOString(),
            completedAt: new Date().toISOString(),
            totalWallets: cycleResults.length,
            successful: completed,
            errors,
            timeouts,
            durationMs: cycleDurationMs,
          };
          addCycle(history, cycleRecord);
          saveHistory(history);

          const nextWait = calculateNextRequestTime(history);
          if (nextWait.waitMs > 0) {
            log(`Waiting ${formatDuration(nextWait.waitMs)} before next cycle`);
            await waitWithCountdown(nextWait.waitMs, nextWait.reason);
          }

          cycleNumber++;
        }
      }
    }
  } catch (error) {
    logError('Fatal error', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', shutdownHandler);
    process.removeListener('SIGTERM', shutdownHandler);

    saveHistory(history);
    log('Graceful shutdown complete');
  }
}

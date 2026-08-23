import { Browser, BrowserContext, Page } from 'playwright-core';
import { log, logError } from './logger';
import { BrowserConfig, launchBrowser } from './browser';
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
import { calculateNextRequestTime, waitWithCountdown, formatDuration } from './scheduler';

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

async function navigateToFaucet(page: Page, faucetUrl: string): Promise<void> {
  log(`Navigating to: ${faucetUrl}`);
  await page.goto(faucetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  log(`Navigation completed`);
  log(`Current URL: ${page.url()}`);

  if (page.url() === 'about:blank') {
    throw new Error(
      'Navigation failed: page is still about:blank\n' +
      'Wallet processing will not start'
    );
  }

  log('Waiting for faucet form...');
  try {
    await page.waitForSelector('#address', {
      state: 'visible',
      timeout: 300000,
    });
    log('Faucet form detected');
  } catch {
    log('Faucet form not detected after 5 minutes');
    log('Checking if Cloudflare verification is needed...');
    log('Please complete Cloudflare verification manually in the browser');
    await page.waitForSelector('#address', {
      state: 'visible',
      timeout: 300000,
    });
    log('Faucet form detected after Cloudflare');
  }
}

function printCycleSummary(results: WalletResult[], cycleNumber: number, cycleStartMs: number): void {
  const completed = results.filter((r) => r.state === 'COMPLETED').length;
  const errors = results.filter((r) => r.state === 'ERROR').length;
  const timeouts = results.filter((r) => r.state === 'TIMEOUT').length;
  const cycleDurationMs = Date.now() - cycleStartMs;

  console.log('\n========================================');
  console.log(`Cycle ${cycleNumber} completed`);
  console.log(`Successful: ${completed}`);
  console.log(`Errors: ${errors}`);
  console.log(`Timeout: ${timeouts}`);
  console.log(`Cycle duration: ${formatDuration(cycleDurationMs)}`);
  console.log('========================================\n');
}

function saveResults(results: WalletResult[], outputPath: string, cycleNumber: number): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = results.map((r) => ({
    cycle: r.cycleNumber,
    walletIndex: r.address,
    address: r.address,
    state: r.state,
    message: r.message,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt.toISOString(),
    durationMs: r.completedAt.getTime() - r.startedAt.getTime(),
    cloudflareDurationMs: r.cloudflareDurationMs,
    requestDurationMs: r.requestDurationMs,
  }));

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  log(`Results saved to ${outputPath}`);
}

export async function run(configPath: string = 'config/config.json'): Promise<void> {
  log('Crane started');

  const config = loadConfig(configPath);
  log(`Loaded ${config.wallets.length} wallet(s)`);

  const history = loadHistory();
  addSession(history);
  saveHistory(history);

  let context: BrowserContext | null = null;
  let browser: Browser | null = null;
  let shouldStop = false;

  const shutdownHandler = async () => {
    log('Shutdown signal received, stopping gracefully...');
    shouldStop = true;
    process.removeListener('SIGINT', shutdownHandler);
    process.removeListener('SIGTERM', shutdownHandler);
  };

  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);

  try {
    const launchResult = await launchBrowser(config.browser);
    browser = launchResult.browser;
    context = launchResult.context;
    const page = launchResult.page;

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

        log('----------------------------------------');
        log(`Cycle ${cycleNumber} | Wallet ${i + 1}/${config.wallets.length}`);
        log('Checking Cloudflare verification...');

        const waitDecision = calculateNextRequestTime(history);

        if (waitDecision.waitMs > 0) {
          log(`Calculated next request wait: ${Math.round(waitDecision.waitMs / 1000)} seconds`);
          log(`Reason: ${waitDecision.reason}`);
        } else {
          log('Calculated next request wait: 0 seconds');
        }

        log('----------------------------------------');

        if (waitDecision.waitMs > 0) {
          await waitWithCountdown(waitDecision.waitMs, waitDecision.reason);
        }

        if (shouldStop) break;

        const cfResult = await checkCloudflareTurnstile(page);
        if (!cfResult.verified) {
          log('Waiting for Cloudflare verification...');
          const maxWait = 300_000;
          const waitStart = Date.now();
          while (Date.now() - waitStart < maxWait) {
            const recheck = await checkCloudflareTurnstile(page);
            if (recheck.verified) {
              break;
            }
            await page.waitForTimeout(2000);
          }
        }

        if (i > 0) {
          await resetForNextWallet(page);
        }

        log('Submitting wallet...');

        const result = await processWallet(
          page,
          address,
          i,
          config.wallets.length,
          config.faucet.walletTimeoutMs,
          cycleNumber
        );

        cycleResults.push(result);

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
          cooldownDurationMs: null,
          result: result.state,
          errorText: result.errorText,
          nextAllowedAt: result.nextAllowedAt?.toISOString() || null,
        };
        addRequest(history, requestRecord);
        saveHistory(history);
      }

      if (!shouldStop) {
        printCycleSummary(cycleResults, cycleNumber, cycleStartMs);

        const cycleRecord: CycleRecord = {
          cycleNumber,
          startedAt: new Date(cycleStartMs).toISOString(),
          completedAt: new Date().toISOString(),
          totalWallets: cycleResults.length,
          successful: cycleResults.filter(r => r.state === 'COMPLETED').length,
          errors: cycleResults.filter(r => r.state === 'ERROR').length,
          timeouts: cycleResults.filter(r => r.state === 'TIMEOUT').length,
          durationMs: Date.now() - cycleStartMs,
        };
        addCycle(history, cycleRecord);
        saveHistory(history);

        const resultsPath = path.join('data', 'results.json');
        saveResults(cycleResults, resultsPath, cycleNumber);

        log('Saving cycle results...');
        log('Calculating next cycle start time...');

        const nextWait = calculateNextRequestTime(history);
        if (nextWait.waitMs > 0) {
          log(`Waiting ${formatDuration(nextWait.waitMs)} before next cycle`);
          log(`Reason: ${nextWait.reason}`);
          await waitWithCountdown(nextWait.waitMs, nextWait.reason);
        }

        cycleNumber++;
      }
    }
  } catch (error) {
    logError('Fatal error', error);
    throw error;
  } finally {
    process.removeListener('SIGINT', shutdownHandler);
    process.removeListener('SIGTERM', shutdownHandler);

    if (context) {
      await context.close();
    }

    saveHistory(history);

    log('Graceful shutdown complete');
    log('Browser session preserved (Chrome still running)');
  }
}

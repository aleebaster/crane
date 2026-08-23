import { BrowserContext, Page } from 'playwright-core';
import { log, logError } from './logger';
import { BrowserConfig, launchBrowser } from './browser';
import { FaucetConfig, processWallet, resetForNextWallet, navigateToPage, isValidSignetAddress } from './faucet';
import { WalletResult } from './faucet';
import * as fs from 'fs';
import * as path from 'path';

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

function printSummary(results: WalletResult[]): void {
  const completed = results.filter((r) => r.state === 'COMPLETED').length;
  const errors = results.filter((r) => r.state === 'ERROR').length;
  const timeouts = results.filter((r) => r.state === 'TIMEOUT').length;

  console.log('\n===== SUMMARY =====');
  console.log(`\nTotal wallets: ${results.length}`);
  console.log(`Completed: ${completed}`);
  console.log(`Timeout: ${timeouts}`);
  console.log(`Failed: ${errors}\n`);

  results.forEach((r, i) => {
    const addr = r.address.length > 20
      ? `${r.address.slice(0, 8)}...${r.address.slice(-8)}`
      : r.address;
    const duration = Math.round((r.completedAt.getTime() - r.startedAt.getTime()) / 1000);
    console.log(`Wallet ${i + 1}: ${r.state} (${duration}s) ${addr}`);
    if (r.message) {
      console.log(`  Message: ${r.message}`);
    }
  });

  console.log('');
}

function saveResults(results: WalletResult[], outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const output = results.map((r) => ({
    address: r.address,
    state: r.state,
    message: r.message,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt.toISOString(),
    durationMs: r.completedAt.getTime() - r.startedAt.getTime(),
  }));

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  log(`Results saved to ${outputPath}`);
}

export async function run(configPath: string = 'config/config.json'): Promise<void> {
  log('Crane started');

  const config = loadConfig(configPath);
  log(`Loaded ${config.wallets.length} wallet(s)`);

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  const results: WalletResult[] = [];

  try {
    context = await launchBrowser(config.browser);
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    await navigateToPage(page, config.faucet.url);

    for (let i = 0; i < config.wallets.length; i++) {
      const address = config.wallets[i];

      if (i > 0) {
        await resetForNextWallet(page);
      }

      const result = await processWallet(
        page,
        address,
        i,
        config.wallets.length,
        config.faucet.walletTimeoutMs
      );

      results.push(result);
    }
  } catch (error) {
    logError('Fatal error', error);
  } finally {
    if (context) {
      await context.close();
    }
  }

  printSummary(results);

  const resultsPath = path.join('data', 'results.json');
  saveResults(results, resultsPath);

  log('Crane finished');
}

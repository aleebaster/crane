import { BrowserContext, Page } from 'playwright-core';
import { log, logError, truncateAddress } from './logger';
import { PageFaucetState, waitForFinalState, resetPageState } from './state-detector';

export interface FaucetConfig {
  url: string;
  walletTimeoutMs: number;
}

export interface WalletResult {
  address: string;
  state: 'COMPLETED' | 'ERROR' | 'TIMEOUT';
  message: string;
  startedAt: Date;
  completedAt: Date;
}

const SELECTORS = {
  addressInput: '#address',
  sendButton: '#sendButton',
  errorDiv: '#faucet_err',
  form: '#myform',
} as const;

const BITCOIN_ADDRESS_REGEX = /^(04[0-9a-fA-F]{128}|0[0-9a-fA-F]{64}|tb1(pfees9rn5nz|[0-9a-fA-HJ-NP-Z-ac-hj-np-z]{59}|[0-9a-fA-HJ-NP-Z-ac-hj-np-z]{39})|[mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/;

export function isValidSignetAddress(address: string): boolean {
  return BITCOIN_ADDRESS_REGEX.test(address);
}

export async function navigateToPage(page: Page, faucetUrl: string): Promise<void> {
  log(`Navigating to ${faucetUrl}`);
  await page.goto(faucetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('Page loaded');

  const cloudflareReady = await detectCloudflareState(page);
  if (!cloudflareReady) {
    log('Cloudflare verification detected. Waiting for user to complete...');
    await waitForCloudflare(page);
  } else {
    log('No Cloudflare challenge or already passed');
  }
}

async function detectCloudflareState(page: Page): Promise<boolean> {
  try {
    const hasChallenge = await page.evaluate(() => {
      const errDiv = document.getElementById('faucet_err');
      const sendButton = document.getElementById('sendButton');
      if (!errDiv || !sendButton) return false;
      const btnText = (sendButton.textContent || '').trim();
      const btnDisabled = (sendButton as any).disabled;
      if (!btnDisabled && btnText.includes('Press (ENTER)')) return true;
      return false;
    });
    return hasChallenge;
  } catch {
    return false;
  }
}

async function waitForCloudflare(page: Page): Promise<void> {
  const maxWait = 300_000;
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < maxWait) {
    const ready = await detectCloudflareState(page);
    if (ready) {
      log('Cloudflare check passed');
      return;
    }
    await page.waitForTimeout(pollInterval);
  }

  log('Cloudflare wait timed out after 5 minutes');
  throw new Error('Cloudflare verification timed out');
}

export async function submitAddress(page: Page, address: string): Promise<void> {
  log(`Submitting address: ${truncateAddress(address)}`);

  const input = page.locator(SELECTORS.addressInput);
  await input.click();
  await input.fill(address);

  const initialState = await getCurrentPageState(page);
  if (initialState === PageFaucetState.PROCESSING) {
    log('Page already in processing state, waiting...');
  }

  const sendButton = page.locator(SELECTORS.sendButton);
  await sendButton.click();

  log('Address submitted');
}

async function getCurrentPageState(page: Page): Promise<PageFaucetState> {
  return page.evaluate(() => {
    const errDiv = document.getElementById('faucet_err');
    const sendButton = document.getElementById('sendButton');
    if (!errDiv) return 'IDLE';
    const text = (errDiv.textContent || '').trim();
    const cssClass = errDiv.className || '';
    const innerHTML = errDiv.innerHTML || '';
    if (cssClass.includes('is-success')) return 'SUCCESS';
    if (/\berror\b/i.test(text) || /\berror\b/i.test(innerHTML) || cssClass.includes('is-danger')) return 'ERROR';
    if (text === '- processing -') return 'PROCESSING';
    if (sendButton) {
      const btnDisabled = (sendButton as any).disabled;
      const btnText = (sendButton.textContent || '').trim();
      if (!btnDisabled && btnText.includes('Press (ENTER)')) return 'CLOUDFLARE_READY';
    }
    return 'IDLE';
  }) as unknown as Promise<PageFaucetState>;
}

export async function processWallet(
  page: Page,
  address: string,
  walletIndex: number,
  totalWallets: number,
  timeoutMs: number
): Promise<WalletResult> {
  const startedAt = new Date();
  const walletLabel = `Wallet ${walletIndex + 1}/${totalWallets}`;

  log(`${walletLabel}: submitting (${truncateAddress(address)})`);

  const beforeSubmitState = await getCurrentPageState(page);

  await submitAddress(page, address);

  await page.waitForTimeout(500);

  log(`${walletLabel}: processing`);

  const result = await waitForFinalState(page, timeoutMs);
  const completedAt = new Date();

  let walletState: 'COMPLETED' | 'ERROR' | 'TIMEOUT';
  let message: string;

  switch (result.state) {
    case PageFaucetState.SUCCESS:
      walletState = 'COMPLETED';
      message = result.text;
      break;
    case PageFaucetState.ERROR:
      walletState = 'ERROR';
      message = result.text;
      break;
    default:
      walletState = 'TIMEOUT';
      message = `Timed out after ${timeoutMs}ms. Last state: ${result.state}, text: "${result.text}"`;
      break;
  }

  log(`${walletLabel}: ${walletState} - ${message}`);

  return {
    address,
    state: walletState,
    message,
    startedAt,
    completedAt,
  };
}

export async function resetForNextWallet(page: Page): Promise<void> {
  log('Resetting page for next wallet...');

  const input = page.locator(SELECTORS.addressInput);
  await input.click({ clickCount: 3 });
  await input.fill('');

  await page.evaluate(() => {
    const errDiv = document.getElementById('faucet_err');
    if (errDiv) {
      errDiv.className = '';
      errDiv.innerHTML = '';
    }
  });

  await page.waitForTimeout(1000);
  log('Page reset complete');
}

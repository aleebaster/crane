import { log } from './logger';

export type WalletState = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR' | 'TIMEOUT';

export interface WalletResult {
  address: string;
  state: WalletState;
  message?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export enum PageFaucetState {
  IDLE = 'IDLE',
  CLOUDFLARE_PENDING = 'CLOUDFLARE_PENDING',
  CLOUDFLARE_READY = 'CLOUDFLARE_READY',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

export interface PageStateResult {
  state: PageFaucetState;
  text: string;
  cssClass: string;
}

const SELECTORS = {
  errorDiv: '#faucet_err',
  addressInput: '#address',
  sendButton: '#sendButton',
  cftsWidget: '#cftsWidget',
} as const;

function containsErrorText(text: string): boolean {
  return /\berror\b/i.test(text);
}

export function detectPageState(document: {
  getElementById: (id: string) => {
    textContent: string | null;
    innerHTML: string;
    className: string;
    style: { cssText: string };
    disabled?: boolean;
  } | null;
}): PageStateResult {
  const errDiv = document.getElementById(SELECTORS.errorDiv);
  const sendButton = document.getElementById(SELECTORS.sendButton);

  if (!errDiv) {
    return { state: PageFaucetState.IDLE, text: '', cssClass: '' };
  }

  const text = (errDiv.textContent || '').trim();
  const cssClass = errDiv.className || '';
  const innerHTML = errDiv.innerHTML || '';

  if (cssClass.includes('is-success')) {
    return { state: PageFaucetState.SUCCESS, text, cssClass };
  }

  if (containsErrorText(text) || containsErrorText(innerHTML) || cssClass.includes('is-danger')) {
    return { state: PageFaucetState.ERROR, text, cssClass };
  }

  if (text === '- processing -') {
    return { state: PageFaucetState.PROCESSING, text, cssClass };
  }

  if (sendButton) {
    const btnDisabled = (sendButton as any).disabled;
    const btnText = (sendButton.textContent || '').trim();
    if (!btnDisabled && btnText.includes('Press (ENTER)')) {
      return { state: PageFaucetState.CLOUDFLARE_READY, text, cssClass };
    }
    if (btnDisabled && btnText.includes('Please wait')) {
      return { state: PageFaucetState.CLOUDFLARE_PENDING, text, cssClass };
    }
  }

  if (text === '' && cssClass === '') {
    return { state: PageFaucetState.CLOUDFLARE_PENDING, text, cssClass };
  }

  return { state: PageFaucetState.IDLE, text, cssClass };
}

export async function waitForFinalState(
  page: { evaluate: (fn: (...args: any[]) => any, ...args: any[]) => Promise<any>; waitForFunction: (fn: (...args: any[]) => any, options?: any) => Promise<any> },
  timeoutMs: number
): Promise<PageStateResult> {
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  const getState = (): Promise<PageStateResult> => {
    return page.evaluate(() => {
      const errDiv = document.getElementById('faucet_err');
      const sendButton = document.getElementById('sendButton');

      if (!errDiv) {
        return { state: 'IDLE', text: '', cssClass: '' };
      }

      const text = (errDiv.textContent || '').trim();
      const cssClass = errDiv.className || '';
      const innerHTML = errDiv.innerHTML || '';

      if (cssClass.includes('is-success')) {
        return { state: 'SUCCESS', text, cssClass };
      }

      if (/\berror\b/i.test(text) || /\berror\b/i.test(innerHTML) || cssClass.includes('is-danger')) {
        return { state: 'ERROR', text, cssClass };
      }

      if (text === '- processing -') {
        return { state: 'PROCESSING', text, cssClass };
      }

      if (sendButton) {
        const btnDisabled = (sendButton as any).disabled;
        const btnText = (sendButton.textContent || '').trim();
        if (!btnDisabled && btnText.includes('Press (ENTER)')) {
          return { state: 'CLOUDFLARE_READY', text, cssClass };
        }
        if (btnDisabled && btnText.includes('Please wait')) {
          return { state: 'CLOUDFLARE_PENDING', text, cssClass };
        }
      }

      if (text === '' && cssClass === '') {
        return { state: 'CLOUDFLARE_PENDING', text, cssClass };
      }

      return { state: 'IDLE', text, cssClass };
    });
  };

  const isTerminal = (s: PageFaucetState): boolean =>
    s === PageFaucetState.ERROR || s === PageFaucetState.SUCCESS;

  let lastState = await getState();
  if (isTerminal(lastState.state)) {
    return lastState;
  }

  try {
    await page.waitForFunction(
      () => {
        const errDiv = document.getElementById('faucet_err');
        if (!errDiv) return false;
        const text = (errDiv.textContent || '').trim();
        const cssClass = errDiv.className || '';
        const innerHTML = errDiv.innerHTML || '';

        if (cssClass.includes('is-success')) return true;
        if (/\berror\b/i.test(text) || /\berror\b/i.test(innerHTML) || cssClass.includes('is-danger')) return true;
        return false;
      },
      { timeout: timeoutMs }
    );
  } catch {
    log('TIMEOUT waiting for final state');
  }

  lastState = await getState();
  return lastState;
}

export function resetPageState(): { state: PageFaucetState; text: string; cssClass: string } {
  return { state: PageFaucetState.IDLE, text: '', cssClass: '' };
}

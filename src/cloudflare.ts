import { Page } from 'playwright-core';
import { log } from './logger';

export interface CloudflareVerificationResult {
  verified: boolean;
  reason: string;
  durationMs: number | null;
}

const TURNSTILE_SELECTORS = {
  widget: '#cf-turnstile-wrapper, .cf-turnstile, [data-sitekey]',
  checkbox: 'input[type="checkbox"], .cf-turnstile-checkbox',
  success: '.cf-turnstile-verified, .cf-turnstile-success, [data-verified="true"]',
  challenge: '.cf-turnstile-challenge, .cf-turnstile-widget',
} as const;

const SUCCESS_PATTERNS = [
  /success/i,
  /verified/i,
  /completed/i,
  /passed/i,
  /успіх/i,
  /пройдено/i,
] as const;

export async function checkCloudflareTurnstile(page: Page): Promise<CloudflareVerificationResult> {
  const startTime = Date.now();

  log('Checking Cloudflare verification before request...');

  const widgetExists = await page.evaluate(() => {
    const widget = document.querySelector(
      '#cf-turnstile-wrapper, .cf-turnstile, [data-sitekey]'
    );
    return widget !== null;
  });

  if (!widgetExists) {
    log('No Cloudflare Turnstile widget detected');
    return {
      verified: true,
      reason: 'No Cloudflare widget present',
      durationMs: null,
    };
  }

  log('Cloudflare widget detected');

  const verificationState = await page.evaluate(() => {
    const successEl = document.querySelector(
      '.cf-turnstile-verified, .cf-turnstile-success, [data-verified="true"]'
    );
    if (successEl) {
      const text = (successEl.textContent || '').trim();
      return { verified: true, text };
    }

    const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
    if (widget) {
      const text = (widget.textContent || '').trim();
      const hasSuccess = /success|verified|completed|passed/i.test(text);
      if (hasSuccess) {
        return { verified: true, text };
      }

      const ariaLabel = widget.getAttribute('aria-label') || '';
      if (/success|verified|completed/i.test(ariaLabel)) {
        return { verified: true, text: ariaLabel };
      }
    }

    const successText = document.body.innerText;
    for (const pattern of [/success/i, /verified/i, /completed/i]) {
      if (pattern.test(successText)) {
        const match = successText.match(new RegExp(`.{0,50}${pattern.source}.{0,50}`, 'i'));
        if (match) {
          return { verified: true, text: match[0].trim() };
        }
      }
    }

    return { verified: false, text: '' };
  });

  if (verificationState.verified) {
    log('Verification is complete');
    log('Green checkmark / success state detected');
    log('Continuing with faucet request');
    return {
      verified: true,
      reason: 'Success state detected',
      durationMs: Date.now() - startTime,
    };
  }

  log('Verification is not complete');

  const checkboxAvailable = await page.evaluate(() => {
    const checkbox = document.querySelector(
      'input[type="checkbox"], .cf-turnstile-checkbox'
    );
    if (!checkbox) return false;

    const style = window.getComputedStyle(checkbox);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });

  if (checkboxAvailable) {
    log('Checkbox is available');
    log('Attempting normal widget interaction...');

    try {
      await page.click(
        'input[type="checkbox"], .cf-turnstile-checkbox',
        { timeout: 5000 }
      );
      log('Checkbox clicked, waiting for verification result...');
    } catch (error) {
      log('Failed to click checkbox, will wait for manual verification');
    }
  } else {
    log('Checkbox not available for normal interaction');
  }

  const maxWait = 300_000;
  const pollInterval = 2000;
  const waitStart = Date.now();

  while (Date.now() - waitStart < maxWait) {
    const currentState = await page.evaluate(() => {
      const successEl = document.querySelector(
        '.cf-turnstile-verified, .cf-turnstile-success, [data-verified="true"]'
      );
      if (successEl) {
        return { verified: true, text: (successEl.textContent || '').trim() };
      }

      const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
      if (widget) {
        const text = (widget.textContent || '').trim();
        if (/success|verified|completed|passed/i.test(text)) {
          return { verified: true, text };
        }
      }

      return { verified: false, text: '' };
    });

    if (currentState.verified) {
      log('Cloudflare verification confirmed');
      log('Success state detected');
      log('Proceeding with wallet request');
      return {
        verified: true,
        reason: 'Verification completed',
        durationMs: Date.now() - startTime,
      };
    }

    if (Date.now() - waitStart > 10000 && Date.now() - waitStart % 30000 < pollInterval) {
      log('Cloudflare requires user interaction');
      log('Waiting for manual verification...');
    }

    await page.waitForTimeout(pollInterval);
  }

  log('Cloudflare verification timed out after 5 minutes');
  log('Verification completed by user');
  return {
    verified: false,
    reason: 'Verification timed out',
    durationMs: Date.now() - startTime,
  };
}

export async function waitForCloudflareReady(page: Page, timeoutMs: number = 300000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 2000;

  while (Date.now() - startTime < timeoutMs) {
    const result = await checkCloudflareTurnstile(page);
    if (result.verified) {
      return true;
    }
    await page.waitForTimeout(pollInterval);
  }

  return false;
}

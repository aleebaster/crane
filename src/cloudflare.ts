import { Page } from 'playwright-core';
import { log } from './logger';

export interface CloudflareVerificationResult {
  verified: boolean;
  reason: string;
  durationMs: number | null;
  widgetFound: boolean;
  tokenPresent: boolean;
}

export async function checkCloudflareTurnstile(page: Page): Promise<CloudflareVerificationResult> {
  const startTime = Date.now();

  log('Checking Cloudflare verification...');

  const analysis = await page.evaluate(() => {
    const result = {
      cftsWidget: false,
      tokenInput: false,
      tokenValue: '',
      iframeCount: 0,
      cloudflareIframeCount: 0,
      hasSuccessText: false,
      successText: '',
    };

    const cftsWidget = document.getElementById('cftsWidget');
    if (cftsWidget) {
      result.cftsWidget = true;
    }

    const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
    if (tokenInput) {
      result.tokenInput = true;
      result.tokenValue = (tokenInput as HTMLInputElement).value || '';
    }

    result.iframeCount = document.querySelectorAll('iframe').length;
    result.cloudflareIframeCount = Array.from(document.querySelectorAll('iframe')).filter(f => {
      const src = f.src || '';
      return src.includes('cloudflare') || src.includes('challenges.cloudflare');
    }).length;

    const bodyText = document.body.innerText || '';

    if (/успіх|success|verified|completed/i.test(bodyText)) {
      result.hasSuccessText = true;
      const match = bodyText.match(/(успіх|success|verified|completed)/i);
      if (match) {
        result.successText = match[1];
      }
    }

    return result;
  });

  log(`#cftsWidget: ${analysis.cftsWidget ? 'FOUND' : 'NOT FOUND'}`);
  log(`Turnstile token: ${analysis.tokenInput && analysis.tokenValue.length > 10 ? 'PRESENT' : 'EMPTY'}`);

  if (!analysis.cftsWidget && !analysis.tokenInput) {
    log('Cloudflare state: NOT_PRESENT');
    return {
      verified: true,
      reason: 'No Cloudflare widget present',
      durationMs: null,
      widgetFound: false,
      tokenPresent: false,
    };
  }

  if (analysis.tokenInput && analysis.tokenValue.length > 10) {
    log('Cloudflare state: VERIFIED');
    if (analysis.hasSuccessText) {
      log(`Green checkmark detected`);
      log(`Success text detected: ${analysis.successText}`);
    }
    return {
      verified: true,
      reason: 'Token present and verified',
      durationMs: Date.now() - startTime,
      widgetFound: true,
      tokenPresent: true,
    };
  }

  log('Cloudflare state: UNVERIFIED');
  log('Waiting for verification to complete...');

  const maxWait = 300_000;
  const pollInterval = 2000;
  const waitStart = Date.now();

  while (Date.now() - waitStart < maxWait) {
    const currentState = await page.evaluate(() => {
      const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
      const tokenValue = tokenInput ? (tokenInput as HTMLInputElement).value || '' : '';

      const bodyText = document.body.innerText || '';
      const hasSuccess = /успіх|success|verified|completed/i.test(bodyText);
      let successText = '';
      if (hasSuccess) {
        const match = bodyText.match(/(успіх|success|verified|completed)/i);
        if (match) successText = match[1];
      }

      return {
        verified: tokenValue.length > 10 || hasSuccess,
        tokenPresent: tokenValue.length > 10,
        hasSuccessText: hasSuccess,
        successText,
      };
    });

    if (currentState.verified) {
      log('Cloudflare verification confirmed');
      log('Current verification state: VERIFIED');
      if (currentState.hasSuccessText) {
        log(`Success text detected: ${currentState.successText}`);
      }
      return {
        verified: true,
        reason: 'Verification completed',
        durationMs: Date.now() - startTime,
        widgetFound: true,
        tokenPresent: currentState.tokenPresent,
      };
    }

    if (Date.now() - waitStart > 10000 && (Date.now() - waitStart) % 30000 < pollInterval) {
      log('Cloudflare requires user interaction');
      log('Waiting for manual verification...');
    }

    await page.waitForTimeout(pollInterval);
  }

  log('Cloudflare verification timed out after 5 minutes');
  return {
    verified: false,
    reason: 'Verification timed out',
    durationMs: Date.now() - startTime,
    widgetFound: true,
    tokenPresent: false,
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

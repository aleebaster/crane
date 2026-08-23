import { log } from './logger';
import {
  HistoryData,
  RequestRecord,
  getRecentRequests,
  getLastRequest,
} from './history';

export interface WaitDecision {
  waitMs: number;
  reason: string;
  nextAllowedAt: Date | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  currentCooldownMs: number;
  cooldownSource: 'FAUCET_RULE' | 'RATE_LIMIT' | 'ADAPTIVE_BACKOFF' | 'BASELINE';
  faucetResponseMs: number | null;
  faucetCooldownMs: number | null;
}

export type CooldownSource = 'FAUCET_RULE' | 'RATE_LIMIT' | 'ADAPTIVE_BACKOFF' | 'BASELINE';

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /please slow down/i,
  /wait.*(?:\d+)\s*(?:sec|min|hour)/i,
  /try again.*(?:\d+)\s*(?:sec|min|hour)/i,
  /cooldown.*(?:\d+)/i,
  /error.*429/i,
  /429/i,
] as const;

const WAIT_TIME_PATTERNS = [
  /wait\s+(\d+)\s*sec/i,
  /try again in\s+(\d+)\s*sec/i,
  /cooldown\s+(\d+)\s*sec/i,
  /(\d+)\s*seconds/i,
  /(\d+)\s*minutes/i,
] as const;

const BASE_COOLDOWN_MS = 5000;
const MAX_COOLDOWN_MS = 300000;
const BACKOFF_MULTIPLIER = 1.5;
const RECOVERY_FACTOR = 0.8;

export function parseRateLimitMessage(errorText: string): { isRateLimit: boolean; waitSeconds: number | null } {
  const isRateLimit = RATE_LIMIT_PATTERNS.some(p => p.test(errorText));

  if (!isRateLimit) {
    return { isRateLimit: false, waitSeconds: null };
  }

  for (const pattern of WAIT_TIME_PATTERNS) {
    const match = errorText.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (pattern.source.includes('minutes')) {
        return { isRateLimit: true, waitSeconds: value * 60 };
      }
      return { isRateLimit: true, waitSeconds: value };
    }
  }

  return { isRateLimit: true, waitSeconds: null };
}

export function calculateAdaptiveCooldown(history: HistoryData): {
  cooldownMs: number;
  source: CooldownSource;
  faucetResponseMs: number | null;
  faucetCooldownMs: number | null;
} {
  const recent = getRecentRequests(history, 20);

  if (recent.length === 0) {
    return {
      cooldownMs: BASE_COOLDOWN_MS,
      source: 'BASELINE',
      faucetResponseMs: null,
      faucetCooldownMs: null,
    };
  }

  const lastRequest = recent[recent.length - 1];
  const lastSubmitAt = lastRequest.submitAt ? new Date(lastRequest.submitAt).getTime() : null;
  const lastResultAt = lastRequest.resultAt ? new Date(lastRequest.resultAt).getTime() : null;
  const faucetResponseMs = lastSubmitAt && lastResultAt ? lastResultAt - lastSubmitAt : null;

  if (lastRequest.nextAllowedAt) {
    const nextAllowed = new Date(lastRequest.nextAllowedAt).getTime();
    const now = Date.now();
    if (nextAllowed > now) {
      return {
        cooldownMs: nextAllowed - (lastResultAt || now),
        source: 'FAUCET_RULE',
        faucetResponseMs,
        faucetCooldownMs: nextAllowed - (lastResultAt || now),
      };
    }
  }

  if (lastRequest.result === 'ERROR') {
    const rateLimitInfo = lastRequest.errorText
      ? parseRateLimitMessage(lastRequest.errorText)
      : { isRateLimit: false, waitSeconds: null };

    if (rateLimitInfo.isRateLimit && rateLimitInfo.waitSeconds) {
      return {
        cooldownMs: rateLimitInfo.waitSeconds * 1000,
        source: 'RATE_LIMIT',
        faucetResponseMs,
        faucetCooldownMs: rateLimitInfo.waitSeconds * 1000,
      };
    }

    let consecutiveErrors = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].result === 'ERROR') {
        consecutiveErrors++;
      } else {
        break;
      }
    }

    if (consecutiveErrors > 0) {
      const backoffMs = Math.min(
        BASE_COOLDOWN_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveErrors),
        MAX_COOLDOWN_MS
      );
      return {
        cooldownMs: backoffMs,
        source: 'ADAPTIVE_BACKOFF',
        faucetResponseMs,
        faucetCooldownMs: null,
      };
    }
  }

  if (lastRequest.result === 'COMPLETED') {
    let consecutiveSuccesses = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].result === 'COMPLETED') {
        consecutiveSuccesses++;
      } else {
        break;
      }
    }

    let lastBackoffMs = BASE_COOLDOWN_MS;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].result === 'ERROR') {
        const errorText = recent[i].errorText;
        const rateLimitInfo = errorText
          ? parseRateLimitMessage(errorText)
          : { isRateLimit: false, waitSeconds: null };

        if (rateLimitInfo.isRateLimit && rateLimitInfo.waitSeconds) {
          lastBackoffMs = rateLimitInfo.waitSeconds * 1000;
        } else {
          const errorIndex = recent.length - 1 - i;
          lastBackoffMs = Math.min(
            BASE_COOLDOWN_MS * Math.pow(BACKOFF_MULTIPLIER, errorIndex + 1),
            MAX_COOLDOWN_MS
          );
        }
        break;
      }
    }

    if (lastBackoffMs > BASE_COOLDOWN_MS) {
      const recoveredMs = Math.max(
        BASE_COOLDOWN_MS,
        lastBackoffMs * Math.pow(RECOVERY_FACTOR, consecutiveSuccesses)
      );
      return {
        cooldownMs: recoveredMs,
        source: 'ADAPTIVE_BACKOFF',
        faucetResponseMs,
        faucetCooldownMs: null,
      };
    }
  }

  return {
    cooldownMs: BASE_COOLDOWN_MS,
    source: 'BASELINE',
    faucetResponseMs,
    faucetCooldownMs: null,
  };
}

export function calculateNextRequestTime(history: HistoryData): WaitDecision {
  const now = new Date();
  const lastRequest = getLastRequest(history);

  if (!lastRequest) {
    return {
      waitMs: 0,
      reason: 'No history available, proceeding immediately',
      nextAllowedAt: null,
      confidence: 'none',
      currentCooldownMs: BASE_COOLDOWN_MS,
      cooldownSource: 'BASELINE',
      faucetResponseMs: null,
      faucetCooldownMs: null,
    };
  }

  const lastResultAt = lastRequest.resultAt ? new Date(lastRequest.resultAt).getTime() : null;

  const lastAllowedAt = lastRequest.nextAllowedAt ? new Date(lastRequest.nextAllowedAt) : null;
  if (lastAllowedAt && lastAllowedAt.getTime() > now.getTime()) {
    const waitMs = lastAllowedAt.getTime() - now.getTime();
    return {
      waitMs,
      reason: `Site indicates next allowed request at ${lastAllowedAt.toISOString()}`,
      nextAllowedAt: lastAllowedAt,
      confidence: 'high',
      currentCooldownMs: lastAllowedAt.getTime() - (lastResultAt || now.getTime()),
      cooldownSource: 'FAUCET_RULE',
      faucetResponseMs: lastRequest.requestDurationMs,
      faucetCooldownMs: lastAllowedAt.getTime() - (lastResultAt || now.getTime()),
    };
  }

  const adaptive = calculateAdaptiveCooldown(history);
  const timeSinceLastRequest = lastResultAt ? now.getTime() - lastResultAt : Infinity;

  if (timeSinceLastRequest >= adaptive.cooldownMs) {
    return {
      waitMs: 0,
      reason: `Cooldown expired (${Math.round(adaptive.cooldownMs / 1000)}s)`,
      nextAllowedAt: null,
      confidence: 'medium',
      currentCooldownMs: adaptive.cooldownMs,
      cooldownSource: adaptive.source,
      faucetResponseMs: adaptive.faucetResponseMs,
      faucetCooldownMs: adaptive.faucetCooldownMs,
    };
  }

  const waitMs = adaptive.cooldownMs - timeSinceLastRequest;
  const nextAllowed = new Date(now.getTime() + waitMs);

  return {
    waitMs,
    reason: `Adaptive cooldown: ${Math.round(adaptive.cooldownMs / 1000)}s (elapsed: ${Math.round(timeSinceLastRequest / 1000)}s)`,
    nextAllowedAt: nextAllowed,
    confidence: 'medium',
    currentCooldownMs: adaptive.cooldownMs,
    cooldownSource: adaptive.source,
    faucetResponseMs: adaptive.faucetResponseMs,
    faucetCooldownMs: adaptive.faucetCooldownMs,
  };
}

export function parseErrorForNextAllowed(errorText: string): Date | null {
  const now = new Date();

  for (const pattern of WAIT_TIME_PATTERNS) {
    const match = errorText.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (pattern.source.includes('minutes')) {
        return new Date(now.getTime() + value * 60 * 1000);
      }
      return new Date(now.getTime() + value * 1000);
    }
  }

  return null;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export async function waitWithCountdown(
  waitMs: number,
  reason: string,
  onTick?: (remainingMs: number) => void
): Promise<boolean> {
  if (waitMs <= 0) return true;

  log(`Waiting ${formatDuration(waitMs)} before next request`);
  log(`Reason: ${reason}`);

  const startTime = Date.now();
  const endTime = startTime + waitMs;
  let lastLogTime = 0;

  while (Date.now() < endTime) {
    const remaining = endTime - Date.now();
    const elapsed = Date.now() - startTime;

    if (elapsed - lastLogTime >= 30000) {
      log(`Next request in ${formatCountdown(remaining)}`);
      lastLogTime = elapsed;
    }

    if (onTick) onTick(remaining);

    const sleepMs = Math.min(1000, remaining);
    await new Promise(resolve => setTimeout(resolve, sleepMs));
  }

  return true;
}

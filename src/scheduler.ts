import { log } from './logger';
import {
  HistoryData,
  RequestRecord,
  getRecentRequests,
  getLastSuccessfulRequest,
  getLastRequest,
} from './history';

export interface WaitDecision {
  waitMs: number;
  reason: string;
  nextAllowedAt: Date | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  currentCooldownMs: number;
}

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
const MIN_COOLDOWN_MS = 2000;
const MAX_COOLDOWN_MS = 300000;
const BACKOFF_MULTIPLIER = 1.5;
const SUCCESS_REDUCTION_FACTOR = 0.9;
const CONSECUTIVE_SUCCESS_THRESHOLD = 5;

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

export function calculateAdaptiveCooldown(history: HistoryData): number {
  const recent = getRecentRequests(history, 20);

  if (recent.length === 0) {
    return BASE_COOLDOWN_MS;
  }

  let consecutiveSuccesses = 0;
  let consecutiveErrors = 0;
  let lastErrorIndex = -1;

  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].result === 'COMPLETED') {
      if (consecutiveErrors === 0) {
        consecutiveSuccesses++;
      }
    } else if (recent[i].result === 'ERROR') {
      if (consecutiveSuccesses === 0) {
        consecutiveErrors++;
        lastErrorIndex = i;
      }
    }
  }

  const lastRequest = recent[recent.length - 1];
  let cooldownMs = BASE_COOLDOWN_MS;

  if (lastRequest.result === 'ERROR') {
    const errorRecord = lastRequest;
    const rateLimitInfo = errorRecord.errorText
      ? parseRateLimitMessage(errorRecord.errorText)
      : { isRateLimit: false, waitSeconds: null };

    if (rateLimitInfo.isRateLimit && rateLimitInfo.waitSeconds) {
      cooldownMs = rateLimitInfo.waitSeconds * 1000;
      log(`Rate limit detected, using specified wait: ${rateLimitInfo.waitSeconds}s`);
    } else if (consecutiveErrors > 0) {
      cooldownMs = Math.min(
        BASE_COOLDOWN_MS * Math.pow(BACKOFF_MULTIPLIER, consecutiveErrors),
        MAX_COOLDOWN_MS
      );
      log(`Consecutive errors: ${consecutiveErrors}, cooldown: ${Math.round(cooldownMs / 1000)}s`);
    }
  } else if (lastRequest.result === 'COMPLETED') {
    if (consecutiveSuccesses >= CONSECUTIVE_SUCCESS_THRESHOLD) {
      cooldownMs = Math.max(
        MIN_COOLDOWN_MS,
        BASE_COOLDOWN_MS * Math.pow(SUCCESS_REDUCTION_FACTOR, consecutiveSuccesses - CONSECUTIVE_SUCCESS_THRESHOLD)
      );
      log(`Consecutive successes: ${consecutiveSuccesses}, reduced cooldown: ${Math.round(cooldownMs / 1000)}s`);
    } else {
      cooldownMs = BASE_COOLDOWN_MS;
    }
  }

  const lastAllowedAt = lastRequest.nextAllowedAt ? new Date(lastRequest.nextAllowedAt) : null;
  if (lastAllowedAt && lastAllowedAt.getTime() > Date.now()) {
    cooldownMs = Math.max(cooldownMs, lastAllowedAt.getTime() - Date.now());
  }

  return Math.min(Math.max(cooldownMs, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS);
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
    };
  }

  const lastSubmitAt = lastRequest.submitAt ? new Date(lastRequest.submitAt) : null;
  const lastResultAt = lastRequest.resultAt ? new Date(lastRequest.resultAt) : null;

  const lastAllowedAt = lastRequest.nextAllowedAt ? new Date(lastRequest.nextAllowedAt) : null;
  if (lastAllowedAt && lastAllowedAt.getTime() > now.getTime()) {
    const waitMs = lastAllowedAt.getTime() - now.getTime();
    return {
      waitMs,
      reason: `Site indicates next allowed request at ${lastAllowedAt.toISOString()}`,
      nextAllowedAt: lastAllowedAt,
      confidence: 'high',
      currentCooldownMs: lastAllowedAt.getTime() - (lastResultAt?.getTime() || now.getTime()),
    };
  }

  const adaptiveCooldown = calculateAdaptiveCooldown(history);
  const timeSinceLastRequest = lastResultAt ? now.getTime() - lastResultAt.getTime() : Infinity;

  if (timeSinceLastRequest >= adaptiveCooldown) {
    return {
      waitMs: 0,
      reason: `Cooldown expired (${Math.round(adaptiveCooldown / 1000)}s)`,
      nextAllowedAt: null,
      confidence: 'medium',
      currentCooldownMs: adaptiveCooldown,
    };
  }

  const waitMs = adaptiveCooldown - timeSinceLastRequest;
  const nextAllowed = new Date(now.getTime() + waitMs);

  return {
    waitMs,
    reason: `Adaptive cooldown: ${Math.round(adaptiveCooldown / 1000)}s (elapsed: ${Math.round(timeSinceLastRequest / 1000)}s)`,
    nextAllowedAt: nextAllowed,
    confidence: 'medium',
    currentCooldownMs: adaptiveCooldown,
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

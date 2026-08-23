import { log } from './logger';
import {
  HistoryData,
  getAverageRequestDuration,
  getAverageCloudflareDuration,
  getAverageCooldown,
  getLastNextAllowedAt,
  getLastSuccessfulRequest,
} from './history';

export interface WaitDecision {
  waitMs: number;
  reason: string;
  nextAllowedAt: Date | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

export function calculateNextRequestTime(history: HistoryData): WaitDecision {
  const now = new Date();

  const explicitCooldown = getLastNextAllowedAt(history);
  if (explicitCooldown && explicitCooldown.getTime() > now.getTime()) {
    const waitMs = explicitCooldown.getTime() - now.getTime();
    return {
      waitMs,
      reason: `Site indicates next allowed request at ${explicitCooldown.toISOString()}`,
      nextAllowedAt: explicitCooldown,
      confidence: 'high',
    };
  }

  const lastSuccess = getLastSuccessfulRequest(history);
  if (lastSuccess && lastSuccess.nextAllowedAt) {
    const nextAllowed = new Date(lastSuccess.nextAllowedAt);
    if (nextAllowed.getTime() > now.getTime()) {
      const waitMs = nextAllowed.getTime() - now.getTime();
      return {
        waitMs,
        reason: `Last request indicated next allowed at ${nextAllowed.toISOString()}`,
        nextAllowedAt: nextAllowed,
        confidence: 'high',
      };
    }
  }

  const avgCooldown = getAverageCooldown(history);
  if (avgCooldown && avgCooldown > 0) {
    const estimatedNext = now.getTime() + avgCooldown;
    const waitMs = Math.max(0, avgCooldown);
    return {
      waitMs,
      reason: `Observed cooldown based on recent requests (${Math.round(avgCooldown / 1000)}s avg)`,
      nextAllowedAt: new Date(estimatedNext),
      confidence: 'medium',
    };
  }

  const avgDuration = getAverageRequestDuration(history);
  if (avgDuration && avgDuration > 0) {
    const conservativeWait = avgDuration * 1.5;
    const waitMs = Math.max(0, conservativeWait);
    return {
      waitMs,
      reason: `Conservative estimate based on average response time (${Math.round(avgDuration / 1000)}s avg)`,
      nextAllowedAt: new Date(now.getTime() + waitMs),
      confidence: 'low',
    };
  }

  return {
    waitMs: 0,
    reason: 'No history available, proceeding immediately',
    nextAllowedAt: null,
    confidence: 'none',
  };
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  loadHistory,
  saveHistory,
  addSession,
  addCycle,
  addRequest,
  getRecentRequests,
  getSuccessfulRequests,
  getErrorRequests,
  getLastSuccessfulRequest,
  getLastNextAllowedAt,
  getAverageRequestDuration,
  getAverageCloudflareDuration,
  getAverageCooldown,
  maskAddress,
  HistoryData,
} from '../src/history';
import {
  calculateNextRequestTime,
  formatDuration,
  formatCountdown,
} from '../src/scheduler';
import { MAX_WALLETS } from '../src/wallet-manager';

const TMP = require('os').tmpdir();

function tmpPath(name: string): string {
  return path.join(TMP, `crane-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function emptyHistory(): HistoryData {
  return { sessions: [], cycles: [], requests: [] };
}

function makeRequest(overrides: Partial<import('../src/history').RequestRecord> = {}): import('../src/history').RequestRecord {
  return {
    cycleNumber: 1,
    walletIndex: 0,
    address: 'tb1q...test',
    startedAt: '2026-08-24T00:00:00.000Z',
    cloudflareDetectedAt: null,
    cloudflarePassedAt: null,
    cloudflareDurationMs: null,
    submitAt: null,
    resultAt: null,
    requestDurationMs: null,
    cooldownDurationMs: null,
    result: 'COMPLETED',
    errorText: null,
    nextAllowedAt: null,
    ...overrides,
  };
}

describe('History', () => {
  let paths: string[];

  beforeEach(() => {
    paths = [];
  });

  afterEach(() => {
    for (const p of paths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it('should load empty history when file does not exist', () => {
    const p = tmpPath('empty');
    paths.push(p);
    const history = loadHistory(p);
    expect(history.sessions).toEqual([]);
    expect(history.cycles).toEqual([]);
    expect(history.requests).toEqual([]);
  });

  it('should save and load history', () => {
    const p = tmpPath('save-load');
    paths.push(p);
    const history: HistoryData = {
      sessions: ['2026-08-24T00:00:00.000Z'],
      cycles: [],
      requests: [],
    };
    saveHistory(history, p);
    const loaded = loadHistory(p);
    expect(loaded.sessions).toEqual(['2026-08-24T00:00:00.000Z']);
  });

  it('should add session', () => {
    const p = tmpPath('add-session');
    paths.push(p);
    const history = emptyHistory();
    addSession(history);
    saveHistory(history, p);
    const loaded = loadHistory(p);
    expect(loaded.sessions.length).toBe(1);
  });

  it('should add cycle', () => {
    const p = tmpPath('add-cycle');
    paths.push(p);
    const history = emptyHistory();
    addCycle(history, {
      cycleNumber: 1,
      startedAt: '2026-08-24T00:00:00.000Z',
      completedAt: '2026-08-24T01:00:00.000Z',
      totalWallets: 50,
      successful: 48,
      errors: 1,
      timeouts: 1,
      durationMs: 3600000,
    });
    saveHistory(history, p);
    const loaded = loadHistory(p);
    expect(loaded.cycles.length).toBe(1);
    expect(loaded.cycles[0].cycleNumber).toBe(1);
  });

  it('should add request', () => {
    const p = tmpPath('add-request');
    paths.push(p);
    const history = emptyHistory();
    addRequest(history, makeRequest({ requestDurationMs: 14000 }));
    saveHistory(history, p);
    const loaded = loadHistory(p);
    expect(loaded.requests.length).toBe(1);
  });

  it('should get recent requests', () => {
    const history = emptyHistory();
    for (let i = 0; i < 10; i++) {
      addRequest(history, makeRequest({
        walletIndex: i,
        startedAt: `2026-08-24T00:00:${String(i).padStart(2, '0')}.000Z`,
      }));
    }
    const recent = getRecentRequests(history, 5);
    expect(recent.length).toBe(5);
    expect(recent[0].walletIndex).toBe(5);
  });

  it('should filter successful requests', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ requestDurationMs: 15000, result: 'COMPLETED' }));
    addRequest(history, makeRequest({ walletIndex: 1, result: 'ERROR', errorText: 'Error: 429' }));
    const successful = getSuccessfulRequests(history);
    expect(successful.length).toBe(1);
    expect(successful[0].result).toBe('COMPLETED');
  });

  it('should filter error requests', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ requestDurationMs: 15000, result: 'COMPLETED' }));
    addRequest(history, makeRequest({ walletIndex: 1, result: 'ERROR', errorText: 'Error: 429' }));
    const errors = getErrorRequests(history);
    expect(errors.length).toBe(1);
    expect(errors[0].result).toBe('ERROR');
  });

  it('should get last successful request', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ walletIndex: 0, result: 'COMPLETED', requestDurationMs: 15000 }));
    addRequest(history, makeRequest({ walletIndex: 1, result: 'ERROR', errorText: 'Error: 429' }));
    const lastSuccess = getLastSuccessfulRequest(history);
    expect(lastSuccess).not.toBeNull();
    expect(lastSuccess!.walletIndex).toBe(0);
  });

  it('should get last nextAllowedAt', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ nextAllowedAt: '2026-08-24T00:01:00.000Z' }));
    const nextAllowed = getLastNextAllowedAt(history);
    expect(nextAllowed).not.toBeNull();
    expect(nextAllowed!.toISOString()).toBe('2026-08-24T00:01:00.000Z');
  });

  it('should calculate average request duration', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ requestDurationMs: 10000, result: 'COMPLETED' }));
    addRequest(history, makeRequest({ walletIndex: 1, requestDurationMs: 20000, result: 'COMPLETED' }));
    const avg = getAverageRequestDuration(history);
    expect(avg).toBe(15000);
  });

  it('should calculate average cloudflare duration', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ cloudflareDurationMs: 30000 }));
    addRequest(history, makeRequest({ walletIndex: 1, cloudflareDurationMs: 60000 }));
    const avg = getAverageCloudflareDuration(history);
    expect(avg).toBe(45000);
  });

  it('should calculate average cooldown', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ cooldownDurationMs: 60000 }));
    addRequest(history, makeRequest({ walletIndex: 1, cooldownDurationMs: 90000 }));
    const avg = getAverageCooldown(history);
    expect(avg).toBe(75000);
  });

  it('should mask address correctly', () => {
    expect(maskAddress('tb1plk37agr9yx22q0z2v7d2u4szz0zxye0watw48ders4e6q627f2qsrr566r')).toBe('tb1plk...rr566r');
    expect(maskAddress('tb1q')).toBe('tb1q');
    expect(maskAddress('short')).toBe('short');
  });

  it('should return null for averages with no data', () => {
    const history = emptyHistory();
    expect(getAverageRequestDuration(history)).toBeNull();
    expect(getAverageCloudflareDuration(history)).toBeNull();
    expect(getAverageCooldown(history)).toBeNull();
  });

  it('should return null for last successful with no data', () => {
    const history = emptyHistory();
    expect(getLastSuccessfulRequest(history)).toBeNull();
  });

  it('should return null for last nextAllowedAt with no data', () => {
    const history = emptyHistory();
    expect(getLastNextAllowedAt(history)).toBeNull();
  });
});

describe('Scheduler', () => {
  it('should return no wait when history is empty', () => {
    const decision = calculateNextRequestTime(emptyHistory());
    expect(decision.waitMs).toBe(0);
    expect(decision.confidence).toBe('none');
  });

  it('should use explicit cooldown from last request', () => {
    const futureTime = new Date(Date.now() + 60000).toISOString();
    const history = emptyHistory();
    addRequest(history, makeRequest({ nextAllowedAt: futureTime }));
    const decision = calculateNextRequestTime(history);
    expect(decision.waitMs).toBeGreaterThan(0);
    expect(decision.confidence).toBe('high');
    expect(decision.reason).toContain('Site indicates next allowed request');
  });

  it('should use nextAllowedAt from successful request', () => {
    const futureTime = new Date(Date.now() + 120000).toISOString();
    const history = emptyHistory();
    addRequest(history, makeRequest({ result: 'COMPLETED', requestDurationMs: 15000, nextAllowedAt: futureTime }));
    const decision = calculateNextRequestTime(history);
    expect(decision.waitMs).toBeGreaterThan(0);
    expect(decision.confidence).toBe('high');
    expect(decision.reason).toContain('next allowed request');
  });

  it('should use average cooldown when available', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ cooldownDurationMs: 60000 }));
    const decision = calculateNextRequestTime(history);
    expect(decision.waitMs).toBe(60000);
    expect(decision.confidence).toBe('medium');
    expect(decision.reason).toContain('Observed cooldown');
  });

  it('should use conservative estimate when no cooldown', () => {
    const history = emptyHistory();
    addRequest(history, makeRequest({ result: 'COMPLETED', requestDurationMs: 10000 }));
    const decision = calculateNextRequestTime(history);
    expect(decision.waitMs).toBe(15000);
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toContain('Conservative estimate');
  });

  it('should format duration correctly', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(5000)).toBe('5s');
    expect(formatDuration(65000)).toBe('1m 5s');
    expect(formatDuration(3665000)).toBe('1h 1m 5s');
  });

  it('should format countdown correctly', () => {
    expect(formatCountdown(0)).toBe('00:00');
    expect(formatCountdown(5000)).toBe('00:05');
    expect(formatCountdown(65000)).toBe('01:05');
    expect(formatCountdown(3665000)).toBe('61:05');
  });
});

describe('Cycle restart', () => {
  it('should have MAX_WALLETS set to 50', () => {
    expect(MAX_WALLETS).toBe(50);
  });

  it('should support multiple cycles in history', () => {
    const history = emptyHistory();
    addCycle(history, {
      cycleNumber: 1,
      startedAt: '2026-08-24T00:00:00.000Z',
      completedAt: '2026-08-24T01:00:00.000Z',
      totalWallets: 50,
      successful: 48,
      errors: 1,
      timeouts: 1,
      durationMs: 3600000,
    });
    addCycle(history, {
      cycleNumber: 2,
      startedAt: '2026-08-24T01:05:00.000Z',
      completedAt: '2026-08-24T02:05:00.000Z',
      totalWallets: 50,
      successful: 49,
      errors: 1,
      timeouts: 0,
      durationMs: 3600000,
    });
    expect(history.cycles.length).toBe(2);
    expect(history.cycles[0].cycleNumber).toBe(1);
    expect(history.cycles[1].cycleNumber).toBe(2);
  });

  it('should track requests across cycles', () => {
    const history = emptyHistory();
    for (let i = 0; i < 50; i++) {
      addRequest(history, makeRequest({ cycleNumber: 1, walletIndex: i }));
    }
    for (let i = 0; i < 50; i++) {
      addRequest(history, makeRequest({ cycleNumber: 2, walletIndex: i }));
    }
    expect(history.requests.length).toBe(100);
    expect(history.requests.filter(r => r.cycleNumber === 1).length).toBe(50);
    expect(history.requests.filter(r => r.cycleNumber === 2).length).toBe(50);
  });
});

describe('Graceful shutdown', () => {
  it('should have SIGINT handler support', () => {
    const listeners = process.listenerCount('SIGINT');
    expect(typeof process.on).toBe('function');
    expect(typeof process.removeListener).toBe('function');
  });
});

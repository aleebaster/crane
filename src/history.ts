import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export interface RequestRecord {
  cycleNumber: number;
  walletIndex: number;
  address: string;
  startedAt: string;
  cloudflareDetectedAt: string | null;
  cloudflarePassedAt: string | null;
  cloudflareDurationMs: number | null;
  submitAt: string | null;
  resultAt: string | null;
  requestDurationMs: number | null;
  cooldownDurationMs: number | null;
  result: 'COMPLETED' | 'ERROR' | 'TIMEOUT';
  errorText: string | null;
  nextAllowedAt: string | null;
  txid: string | null;
}

export interface CycleRecord {
  cycleNumber: number;
  startedAt: string;
  completedAt: string | null;
  totalWallets: number;
  successful: number;
  errors: number;
  timeouts: number;
  durationMs: number | null;
}

export interface HistoryData {
  sessions: string[];
  cycles: CycleRecord[];
  requests: RequestRecord[];
}

const HISTORY_PATH = path.join('data', 'request-history.json');

function ensureDataDir(): void {
  const dir = path.dirname(HISTORY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadHistory(filePath?: string): HistoryData {
  const historyPath = filePath || HISTORY_PATH;
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(historyPath)) {
    return { sessions: [], cycles: [], requests: [] };
  }
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    return JSON.parse(raw) as HistoryData;
  } catch {
    return { sessions: [], cycles: [], requests: [] };
  }
}

export function saveHistory(data: HistoryData, filePath?: string): void {
  const historyPath = filePath || HISTORY_PATH;
  const dir = path.dirname(historyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(historyPath, JSON.stringify(data, null, 2), 'utf-8');
}

export function addSession(data: HistoryData): void {
  data.sessions.push(new Date().toISOString());
}

export function addCycle(data: HistoryData, cycle: CycleRecord): void {
  data.cycles.push(cycle);
}

export function addRequest(data: HistoryData, request: RequestRecord): void {
  data.requests.push(request);
}

export function getRecentRequests(data: HistoryData, count: number): RequestRecord[] {
  return data.requests.slice(-count);
}

export function getSuccessfulRequests(data: HistoryData): RequestRecord[] {
  return data.requests.filter(r => r.result === 'COMPLETED' && r.requestDurationMs !== null);
}

export function getErrorRequests(data: HistoryData): RequestRecord[] {
  return data.requests.filter(r => r.result === 'ERROR');
}

export function getLastSuccessfulRequest(data: HistoryData): RequestRecord | null {
  const successful = getSuccessfulRequests(data);
  return successful.length > 0 ? successful[successful.length - 1] : null;
}

export function getLastRequest(data: HistoryData): RequestRecord | null {
  return data.requests.length > 0 ? data.requests[data.requests.length - 1] : null;
}

export function getLastNextAllowedAt(data: HistoryData): Date | null {
  const recent = data.requests.slice(-10);
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].nextAllowedAt) {
      return new Date(recent[i].nextAllowedAt!);
    }
  }
  return null;
}

export function getAverageRequestDuration(data: HistoryData): number | null {
  const successful = getSuccessfulRequests(data);
  if (successful.length === 0) return null;
  const total = successful.reduce((sum, r) => sum + (r.requestDurationMs || 0), 0);
  return total / successful.length;
}

export function getAverageCloudflareDuration(data: HistoryData): number | null {
  const withCF = data.requests.filter(r => r.cloudflareDurationMs !== null);
  if (withCF.length === 0) return null;
  const total = withCF.reduce((sum, r) => sum + r.cloudflareDurationMs!, 0);
  return total / withCF.length;
}

export function getAverageCooldown(data: HistoryData): number | null {
  const withCooldown = data.requests.filter(r => r.cooldownDurationMs !== null);
  if (withCooldown.length === 0) return null;
  const total = withCooldown.reduce((sum, r) => sum + r.cooldownDurationMs!, 0);
  return total / withCooldown.length;
}

export function maskAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

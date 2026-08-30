import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ProxyConfig,
  getProxyUrl,
  getPlaywrightProxy,
  getNSTProxyPayload,
  getNSTProxyString,
  parseProxyUrl,
  testProxy,
} from '../src/proxy';

// ─── Mock logger ────────────────────────────────────────────────────────────

vi.mock('../src/logger', () => ({
  log: vi.fn(),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const socks5Proxy: ProxyConfig = {
  enabled: true,
  type: 'socks5',
  host: 'res.proxy-seller.com',
  port: 10000,
  username: '8b98d75fb6266769',
  password: 'ofKnrzR5ASyb3kYx',
};

const httpProxy: ProxyConfig = {
  enabled: true,
  type: 'http',
  host: 'proxy.example.com',
  port: 8080,
};

const authProxy: ProxyConfig = {
  enabled: true,
  type: 'socks5',
  host: 'proxy.test.com',
  port: 1080,
  username: 'user',
  password: 'pass',
};

// ─── getProxyUrl ────────────────────────────────────────────────────────────

describe('getProxyUrl', () => {
  it('should build SOCKS5 URL with auth', () => {
    const url = getProxyUrl(socks5Proxy);
    expect(url).toBe('socks5://8b98d75fb6266769:ofKnrzR5ASyb3kYx@res.proxy-seller.com:10000');
  });

  it('should build HTTP URL without auth', () => {
    const url = getProxyUrl(httpProxy);
    expect(url).toBe('http://proxy.example.com:8080');
  });

  it('should build URL with auth', () => {
    const url = getProxyUrl(authProxy);
    expect(url).toBe('socks5://user:pass@proxy.test.com:1080');
  });

  it('should handle empty username', () => {
    const url = getProxyUrl({
      enabled: true,
      type: 'socks5',
      host: 'h',
      port: 1080,
      username: '',
      password: 'pass',
    });
    expect(url).toBe('socks5://h:1080');
  });

  it('should handle socks4 type', () => {
    const url = getProxyUrl({
      enabled: true,
      type: 'socks4',
      host: 'h',
      port: 1080,
    });
    expect(url).toBe('socks4://h:1080');
  });
});

// ─── getPlaywrightProxy ─────────────────────────────────────────────────────

describe('getPlaywrightProxy', () => {
  it('should return server URL without auth in server field', () => {
    const result = getPlaywrightProxy(socks5Proxy);
    expect(result.server).toBe('socks5://res.proxy-seller.com:10000');
  });

  it('should include username and password separately', () => {
    const result = getPlaywrightProxy(socks5Proxy);
    expect(result.username).toBe('8b98d75fb6266769');
    expect(result.password).toBe('ofKnrzR5ASyb3kYx');
  });

  it('should return undefined for username/password when not set', () => {
    const result = getPlaywrightProxy(httpProxy);
    expect(result.username).toBeUndefined();
    expect(result.password).toBeUndefined();
  });
});

// ─── getNSTProxyPayload ─────────────────────────────────────────────────────

describe('getNSTProxyPayload', () => {
  it('should return NST-compatible proxy object', () => {
    const payload = getNSTProxyPayload(socks5Proxy);
    expect(payload).toEqual({
      type: 'socks5',
      host: 'res.proxy-seller.com',
      port: 10000,
      username: '8b98d75fb6266769',
      password: 'ofKnrzR5ASyb3kYx',
    });
  });

  it('should omit username/password when not set', () => {
    const payload = getNSTProxyPayload(httpProxy);
    expect(payload.username).toBeUndefined();
    expect(payload.password).toBeUndefined();
  });
});

// ─── getNSTProxyString ──────────────────────────────────────────────────────

describe('getNSTProxyString', () => {
  it('should return full proxy URL string', () => {
    const result = getNSTProxyString(socks5Proxy);
    expect(result).toBe('socks5://8b98d75fb6266769:ofKnrzR5ASyb3kYx@res.proxy-seller.com:10000');
  });
});

// ─── parseProxyUrl ──────────────────────────────────────────────────────────

describe('parseProxyUrl', () => {
  it('should parse socks5 URL with auth', () => {
    const result = parseProxyUrl('socks5://user:pass@proxy.com:1080');
    expect(result).toEqual({
      enabled: true,
      type: 'socks5',
      host: 'proxy.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('should parse http URL without auth', () => {
    const result = parseProxyUrl('http://proxy.com:8080');
    expect(result).toEqual({
      enabled: true,
      type: 'http',
      host: 'proxy.com',
      port: 8080,
      username: undefined,
      password: undefined,
    });
  });

  it('should parse socks4 URL', () => {
    const result = parseProxyUrl('socks4://proxy.com:1080');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('socks4');
  });

  it('should return null for invalid URL', () => {
    expect(parseProxyUrl('not-a-url')).toBeNull();
  });

  it('should return null for unsupported protocol', () => {
    expect(parseProxyUrl('ftp://proxy.com:21')).toBeNull();
  });

  it('should default port to 80 for http', () => {
    const result = parseProxyUrl('http://proxy.com');
    expect(result!.port).toBe(80);
  });

  it('should default port to 443 for https', () => {
    const result = parseProxyUrl('https://proxy.com');
    expect(result!.port).toBe(443);
  });

  it('should round-trip: parse then build', () => {
    const original = 'socks5://user:pass@host:1080';
    const parsed = parseProxyUrl(original)!;
    const rebuilt = getProxyUrl(parsed);
    expect(rebuilt).toBe(original);
  });
});

// ─── testProxy ──────────────────────────────────────────────────────────────

const mockUndiciFetch = vi.fn();

vi.mock('undici', () => ({
  ProxyAgent: vi.fn(),
  fetch: (...args: unknown[]) => mockUndiciFetch(...args),
}));

describe('testProxy', () => {
  beforeEach(() => {
    mockUndiciFetch.mockReset();
  });

  it('should return IP on success', async () => {
    mockUndiciFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ip: '1.2.3.4' }),
    });

    const ip = await testProxy(socks5Proxy);
    expect(ip).toBe('1.2.3.4');
  });

  it('should return null on fetch failure', async () => {
    mockUndiciFetch.mockRejectedValue(new Error('Connection refused'));

    const ip = await testProxy(socks5Proxy);
    expect(ip).toBeNull();
  });

  it('should return null on non-OK response', async () => {
    mockUndiciFetch.mockResolvedValue({ ok: false, status: 403 });

    const ip = await testProxy(socks5Proxy);
    expect(ip).toBeNull();
  });
});

// ─── ProxyConfig type checks ────────────────────────────────────────────────

describe('ProxyConfig type', () => {
  it('should accept all proxy types', () => {
    const types: ProxyConfig['type'][] = ['http', 'https', 'socks5', 'socks4'];
    for (const type of types) {
      const proxy: ProxyConfig = { enabled: true, type, host: 'h', port: 1080 };
      expect(proxy.type).toBe(type);
    }
  });

  it('should support optional auth fields', () => {
    const proxy: ProxyConfig = {
      enabled: true,
      type: 'socks5',
      host: 'h',
      port: 1080,
    };
    expect(proxy.username).toBeUndefined();
    expect(proxy.password).toBeUndefined();
  });
});

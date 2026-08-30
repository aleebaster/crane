import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isNSTRunning,
  generateUniqueFingerprint,
  createNSTProfile,
  launchNSTProfile,
  closeNSTProfile,
  deleteNSTProfile,
  listNSTProfiles,
  NSTFingerprint,
  NSTProfileConfig,
} from '../src/nstbrowser';

// ─── Mock fetch globally ────────────────────────────────────────────────────

const originalFetch = global.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    return handler(urlStr, init);
  }) as typeof fetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, text = 'error'): Response {
  return new Response(text, { status });
}

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Set a dummy API key for all tests
  vi.stubEnv('NST_API_KEY', 'test-api-key-123');
});

// ─── isNSTRunning ───────────────────────────────────────────────────────────

describe('isNSTRunning', () => {
  it('should return true when API responds OK', async () => {
    mockFetch(() => jsonResponse({ browsers: [] }));
    const running = await isNSTRunning();
    expect(running).toBe(true);
  });

  it('should return false when API is unreachable', async () => {
    mockFetch(() => { throw new Error('ECONNREFUSED'); });
    const running = await isNSTRunning();
    expect(running).toBe(false);
  });

  it('should return false when API returns error', async () => {
    mockFetch(() => errorResponse(401, 'Unauthorized'));
    const running = await isNSTRunning();
    expect(running).toBe(false);
  });
});

// ─── generateUniqueFingerprint ──────────────────────────────────────────────

describe('generateUniqueFingerprint', () => {
  it('should return an object with required fields', () => {
    const fp = generateUniqueFingerprint();
    expect(fp.userAgent).toBeDefined();
    expect(fp.timezone).toBeDefined();
    expect(fp.language).toBeDefined();
    expect(fp.screenResolution).toBeDefined();
  });

  it('should return valid screen resolution', () => {
    const fp = generateUniqueFingerprint();
    expect(fp.screenResolution).toBe('1920x1080');
  });

  it('should generate different fingerprints on multiple calls', () => {
    const fps = Array.from({ length: 20 }, () => generateUniqueFingerprint());
    const uas = new Set(fps.map((f) => f.userAgent));
    const tzs = new Set(fps.map((f) => f.timezone));
    expect(uas.size).toBeGreaterThan(1);
    expect(tzs.size).toBeGreaterThan(1);
  });
});

// ─── createNSTProfile ──────────────────────────────────────────────────────

describe('createNSTProfile', () => {
  it('should create a profile and return its ID', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.name).toBe('test-wallet');
      expect(body.platform).toBe('Windows');
      expect(body.fingerprint).toBeDefined();
      expect(body.fingerprint.flags).toBeDefined();
      return jsonResponse({ profileId: 'abc-123', id: 'abc-123' });
    });

    const id = await createNSTProfile({ name: 'test-wallet' });
    expect(id).toBe('abc-123');
  });

  it('should include x-api-key header', async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch((_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ profileId: 'key-test' });
    });

    await createNSTProfile({ name: 'key-test' });
    expect(capturedHeaders['x-api-key']).toBe('test-api-key-123');
  });

  it('should include custom fingerprint fields', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.fingerprint.localization.timezone).toBe('Europe/Kyiv');
      return jsonResponse({ profileId: 'custom-1' });
    });

    const id = await createNSTProfile({
      name: 'custom-tz',
      fingerprint: { timezone: 'Europe/Kyiv' },
    });
    expect(id).toBe('custom-1');
  });

  it('should throw on API error', async () => {
    mockFetch(() => errorResponse(500, 'Internal Server Error'));

    await expect(
      createNSTProfile({ name: 'fail' })
    ).rejects.toThrow('Failed to create NST profile');
  });

  it('should include proxy when provided', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.proxy).toBe('http://user:pass@proxy:8080');
      return jsonResponse({ profileId: 'proxy-1' });
    });

    const id = await createNSTProfile({
      name: 'with-proxy',
      proxy: 'http://user:pass@proxy:8080',
    });
    expect(id).toBe('proxy-1');
  });
});

// ─── launchNSTProfile ───────────────────────────────────────────────────────

describe('launchNSTProfile', () => {
  it('should start browser and return WebSocket endpoint', async () => {
    mockFetch((url, init) => {
      if (url.includes('/browsers/') && url.includes('/debugger')) {
        return jsonResponse({ wsUrl: 'ws://127.0.0.1:9223/devtools/browser/abc' });
      }
      // POST /browsers/ to start
      return jsonResponse({ id: 'browser-1', profileId: 'profile-1' });
    });

    const ws = await launchNSTProfile('profile-1');
    expect(ws).toContain('ws://');
  });

  it('should throw on launch failure', async () => {
    mockFetch(() => errorResponse(404, 'Profile not found'));

    await expect(launchNSTProfile('missing')).rejects.toThrow('Failed to start NST browser');
  });
});

// ─── closeNSTProfile ────────────────────────────────────────────────────────

describe('closeNSTProfile', () => {
  it('should close without error', async () => {
    mockFetch(() =>
      jsonResponse({ browsers: [{ id: 'b1', profileId: 'profile-1' }] })
    );
    await expect(closeNSTProfile('profile-1')).resolves.toBeUndefined();
  });

  it('should not throw on close failure', async () => {
    mockFetch(() => errorResponse(500));
    await expect(closeNSTProfile('profile-1')).resolves.toBeUndefined();
  });
});

// ─── deleteNSTProfile ───────────────────────────────────────────────────────

describe('deleteNSTProfile', () => {
  it('should delete without error', async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    await expect(deleteNSTProfile('profile-1')).resolves.toBeUndefined();
  });

  it('should not throw on delete failure', async () => {
    mockFetch(() => errorResponse(500));
    await expect(deleteNSTProfile('profile-1')).resolves.toBeUndefined();
  });
});

// ─── listNSTProfiles ────────────────────────────────────────────────────────

describe('listNSTProfiles', () => {
  it('should return array of profiles', async () => {
    mockFetch(() =>
      jsonResponse({
        profiles: [
          { id: '1', name: 'wallet_abc', fingerprint: {} },
          { id: '2', name: 'wallet_def', fingerprint: {} },
        ],
      })
    );

    const profiles = await listNSTProfiles();
    expect(profiles.length).toBe(2);
    expect(profiles[0].name).toBe('wallet_abc');
  });

  it('should return empty array on error', async () => {
    mockFetch(() => errorResponse(500));
    const profiles = await listNSTProfiles();
    expect(profiles).toEqual([]);
  });

  it('should handle empty response', async () => {
    mockFetch(() => jsonResponse({}));
    const profiles = await listNSTProfiles();
    expect(profiles).toEqual([]);
  });

  it('should pass x-api-key header', async () => {
    let capturedHeaders: Record<string, string> = {};
    mockFetch((_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ profiles: [] });
    });

    await listNSTProfiles();
    expect(capturedHeaders['x-api-key']).toBe('test-api-key-123');
  });
});

// ─── Type checks ────────────────────────────────────────────────────────────

describe('NST types', () => {
  it('NSTFingerprint should have all required fields', () => {
    const fp: NSTFingerprint = {
      userAgent: 'ua',
      platform: 'Win32',
      language: 'en',
      timezone: 'UTC',
      screenResolution: '1920x1080',
      webglVendor: 'vendor',
      webglRenderer: 'renderer',
    };
    expect(fp.userAgent).toBe('ua');
  });

  it('NSTProfileConfig should accept partial fingerprint', () => {
    const config: NSTProfileConfig = {
      name: 'test',
      fingerprint: { timezone: 'UTC' },
    };
    expect(config.fingerprint?.timezone).toBe('UTC');
  });

  it('NSTProfileConfig should accept proxy', () => {
    const config: NSTProfileConfig = {
      name: 'proxied',
      proxy: 'http://proxy:8080',
    };
    expect(config.proxy).toBe('http://proxy:8080');
  });
});

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
});

// ─── isNSTRunning ───────────────────────────────────────────────────────────

describe('isNSTRunning', () => {
  it('should return true when API responds OK', async () => {
    mockFetch(() => jsonResponse({ status: 'ok' }));
    const running = await isNSTRunning();
    expect(running).toBe(true);
  });

  it('should return false when API is unreachable', async () => {
    mockFetch(() => { throw new Error('ECONNREFUSED'); });
    const running = await isNSTRunning();
    expect(running).toBe(false);
  });

  it('should return false when API returns error', async () => {
    mockFetch(() => errorResponse(500));
    const running = await isNSTRunning();
    // fetch with non-OK response should still return false in isNSTRunning
    // because the actual check is res.ok
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
    // Generate many fingerprints; at least some should differ
    const fps = Array.from({ length: 20 }, () => generateUniqueFingerprint());
    const uas = new Set(fps.map((f) => f.userAgent));
    const tzs = new Set(fps.map((f) => f.timezone));
    // With random selection from arrays of 4/6 items, 20 samples
    // should produce at least 2 unique values
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
      expect(body.browserType).toBe('chromium');
      expect(body.fingerprint).toBeDefined();
      expect(body.fingerprint.userAgent).toBeDefined();
      return jsonResponse({ profileId: 'abc-123', id: 'abc-123' });
    });

    const id = await createNSTProfile({ name: 'test-wallet' });
    expect(id).toBe('abc-123');
  });

  it('should include custom fingerprint fields', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.fingerprint.timezone).toBe('Europe/Kyiv');
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

  it('should include storage in request body', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse(init?.body as string);
      expect(body.storage.cookies).toEqual([
        { name: 'cf_clearance', value: 'xyz', domain: '.example.com' },
      ]);
      return jsonResponse({ profileId: 'with-storage' });
    });

    const id = await createNSTProfile({
      name: 'with-storage',
      storage: {
        cookies: [{ name: 'cf_clearance', value: 'xyz', domain: '.example.com' }],
      },
    });
    expect(id).toBe('with-storage');
  });
});

// ─── launchNSTProfile ───────────────────────────────────────────────────────

describe('launchNSTProfile', () => {
  it('should return WebSocket endpoint', async () => {
    mockFetch(() =>
      jsonResponse({ wsEndpoint: 'ws://127.0.0.1:9223/devtools/browser/abc' })
    );

    const ws = await launchNSTProfile('profile-1');
    expect(ws).toContain('ws://');
  });

  it('should throw on launch failure', async () => {
    mockFetch(() => errorResponse(404, 'Profile not found'));

    await expect(launchNSTProfile('missing')).rejects.toThrow('Failed to launch NST profile');
  });
});

// ─── closeNSTProfile ────────────────────────────────────────────────────────

describe('closeNSTProfile', () => {
  it('should close without error', async () => {
    mockFetch(() => jsonResponse({ success: true }));
    // Should not throw
    await expect(closeNSTProfile('profile-1')).resolves.toBeUndefined();
  });

  it('should not throw on close failure', async () => {
    mockFetch(() => errorResponse(500));
    // Should not throw
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
});

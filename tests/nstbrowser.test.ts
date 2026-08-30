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
  NSTProfileLaunchError,
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
      // NST API v2: POST /browsers/{profileId} returns webSocketDebuggerUrl directly
      return jsonResponse({
        data: {
          profileId: 'profile-1',
          port: 9223,
          webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser/abc',
        },
      });
    });

    const ws = await launchNSTProfile('profile-1');
    expect(ws).toContain('ws://');
  });

  it('should throw on launch failure', async () => {
    mockFetch(() => errorResponse(404, 'Profile not found'));

    // Retry logic: 404 is transient, so it retries 3 times with backoff (2s+5s=7s)
    await expect(launchNSTProfile('missing')).rejects.toThrow();
  }, 15000);

  it('should throw immediately on 403 (permanent failure)', async () => {
    mockFetch(() => errorResponse(403, 'request profile failed with code: 403'));

    await expect(launchNSTProfile('broken')).rejects.toThrow('403');
  });

  it('should throw immediately on code 6001 (plan limit) without retry', async () => {
    mockFetch(() => errorResponse(400, JSON.stringify({
      data: null, err: true, msg: 'exceeded plan limits', code: 6001
    })));

    try {
      await launchNSTProfile('limited');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NSTProfileLaunchError);
      const e = error as NSTProfileLaunchError;
      expect(e.nstCode).toBe(6001);
      expect(e.isPlanLimit).toBe(true);
      expect(e.isPermanent).toBe(true);
      expect(e.reason).toBe('PLAN_LIMIT');
    }
  });

  it('should classify 403 as PROXY_ERROR', async () => {
    mockFetch(() => errorResponse(403, 'request profile failed with code: 403'));

    try {
      await launchNSTProfile('proxy-broken');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NSTProfileLaunchError);
      const e = error as NSTProfileLaunchError;
      expect(e.reason).toBe('PROXY_ERROR');
      expect(e.isPermanent).toBe(true);
      expect(e.isPlanLimit).toBe(false);
    }
  });

  it('should classify 500 as TRANSIENT', async () => {
    mockFetch(() => errorResponse(500, 'Internal Server Error'));

    try {
      await launchNSTProfile('server-error');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NSTProfileLaunchError);
      const e = error as NSTProfileLaunchError;
      expect(e.reason).toBe('TRANSIENT');
      expect(e.isPermanent).toBe(false);
    }
  }, 15000);

  it('should not call proxy auto-fix when error is 6001', async () => {
    // This test verifies the error classification, not the fixBrokenProfiles function.
    // If isPlanLimit is true, the caller should skip proxy fix.
    const error = new NSTProfileLaunchError('test', 400,
      JSON.stringify({ data: null, err: true, msg: 'exceeded plan limits', code: 6001 })
    );
    expect(error.isPlanLimit).toBe(true);
    expect(error.reason).toBe('PLAN_LIMIT');
    // A caller checking isPlanLimit would skip proxy fix
    const shouldSkipProxyFix = error.isPlanLimit;
    expect(shouldSkipProxyFix).toBe(true);
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
    // NST API v2 returns paginated: { data: { docs: [...], hasNextPage: false } }
    mockFetch(() =>
      jsonResponse({
        data: {
          docs: [
            { profileId: '1', name: 'wallet_abc', parameters: { fingerprint: {} } },
            { profileId: '2', name: 'wallet_def', parameters: { fingerprint: {} } },
          ],
          hasNextPage: false,
        },
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
    mockFetch(() => jsonResponse({ data: { docs: [], hasNextPage: false } }));
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

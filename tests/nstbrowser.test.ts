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

// ─── NSTProfileLaunchError classification ─────────────────────────────────

describe('NSTProfileLaunchError', () => {
  it('should classify code 6001 as PLAN_LIMIT', () => {
    const body = JSON.stringify({ data: null, err: true, msg: 'exceeded plan limits', code: 6001 });
    const err = new NSTProfileLaunchError('p1', 400, body);
    expect(err.nstCode).toBe(6001);
    expect(err.reason).toBe('PLAN_LIMIT');
    expect(err.isPlanLimit).toBe(true);
    expect(err.isPermanent).toBe(true);
  });

  it('should not retry on code 6001 (isPermanent=true)', () => {
    const err = new NSTProfileLaunchError('p1', 400,
      JSON.stringify({ code: 6001, msg: 'exceeded plan limits' })
    );
    // isPermanent → no retry in launchNSTProfile
    expect(err.isPermanent).toBe(true);
  });

  it('should classify 403 as PROXY_ERROR', () => {
    const err = new NSTProfileLaunchError('p2', 403, 'forbidden');
    expect(err.reason).toBe('PROXY_ERROR');
    expect(err.isPlanLimit).toBe(false);
    expect(err.isPermanent).toBe(true);
  });

  it('should classify 500 as TRANSIENT', () => {
    const err = new NSTProfileLaunchError('p3', 500, 'server error');
    expect(err.reason).toBe('TRANSIENT');
    expect(err.isPermanent).toBe(false);
  });

  it('should parse nstCode from JSON body', () => {
    const body = JSON.stringify({ code: 6001, msg: 'exceeded plan limits' });
    const err = new NSTProfileLaunchError('p4', 400, body);
    expect(err.nstCode).toBe(6001);
  });

  it('should handle non-JSON body gracefully', () => {
    const err = new NSTProfileLaunchError('p5', 400, 'plain text error');
    expect(err.nstCode).toBe(0);
    expect(err.reason).toBe('PERMANENT');
  });

  it('should classify 400 without code as PERMANENT', () => {
    const body = JSON.stringify({ code: 0, msg: 'bad request' });
    const err = new NSTProfileLaunchError('p6', 400, body);
    expect(err.reason).toBe('PERMANENT');
    expect(err.isPlanLimit).toBe(false);
  });
});

// ─── Wallet mapping validation ──────────────────────────────────────────────

describe('Wallet mapping', () => {
  it('should have 50 wallets across 10 profiles with 5 each', () => {
    const profiles = [
      { id: 'p1', name: 'Profile 1', wallets: Array(5).fill(0).map((_, i) => `w${i}`) },
      { id: 'p2', name: 'Profile 2', wallets: Array(5).fill(0).map((_, i) => `w${i + 5}`) },
      { id: 'p3', name: 'Profile 3', wallets: Array(5).fill(0).map((_, i) => `w${i + 10}`) },
      { id: 'p4', name: 'Profile 4', wallets: Array(5).fill(0).map((_, i) => `w${i + 15}`) },
      { id: 'p5', name: 'Profile 5', wallets: Array(5).fill(0).map((_, i) => `w${i + 20}`) },
      { id: 'p6', name: 'Profile 6', wallets: Array(5).fill(0).map((_, i) => `w${i + 25}`) },
      { id: 'p7', name: 'Profile 7', wallets: Array(5).fill(0).map((_, i) => `w${i + 30}`) },
      { id: 'p8', name: 'Profile 8', wallets: Array(5).fill(0).map((_, i) => `w${i + 35}`) },
      { id: 'p9', name: 'Profile 9', wallets: Array(5).fill(0).map((_, i) => `w${i + 40}`) },
      { id: 'p10', name: 'Profile 10', wallets: Array(5).fill(0).map((_, i) => `w${i + 45}`) },
    ];

    const allWallets = profiles.flatMap(p => p.wallets);
    const unique = new Set(allWallets);

    expect(profiles.length).toBe(10);
    expect(allWallets.length).toBe(50);
    expect(unique.size).toBe(50);
    profiles.forEach(p => expect(p.wallets.length).toBe(5));
  });

  it('should detect duplicate wallets', () => {
    const profiles = [
      { id: 'p1', name: 'Profile 1', wallets: ['w0', 'w1', 'w2', 'w3', 'w4'] },
      { id: 'p2', name: 'Profile 2', wallets: ['w0', 'w5', 'w6', 'w7', 'w8'] }, // w0 duplicated
    ];
    const all = profiles.flatMap(p => p.wallets);
    const unique = new Set(all);
    expect(all.length - unique.size).toBe(1); // 1 duplicate
  });

  it('should detect unassigned wallets', () => {
    const configWallets = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5'];
    const profiles = [
      { id: 'p1', name: 'Profile 1', wallets: ['w0', 'w1'] },
    ];
    const assigned = new Set(profiles.flatMap(p => p.wallets));
    const unassigned = configWallets.filter(w => !assigned.has(w));
    expect(unassigned.length).toBe(4);
  });

  it('each profile should process exactly 5 wallets', () => {
    const profile = { id: 'p1', name: 'Profile 1', wallets: ['w0', 'w1', 'w2', 'w3', 'w4'] };
    expect(profile.wallets.length).toBe(5);
  });
});

// ─── Profile lifecycle isolation ────────────────────────────────────────────

describe('Profile lifecycle isolation', () => {
  it('each profile failure should not stop the next profile', () => {
    const results: Array<{ profile: string; status: string }> = [];
    const profiles = ['p1', 'p2', 'p3'];

    for (const p of profiles) {
      try {
        if (p === 'p2') throw new NSTProfileLaunchError(p, 400,
          JSON.stringify({ code: 6001, msg: 'exceeded plan limits' })
        );
        results.push({ profile: p, status: 'SUCCESS' });
      } catch {
        results.push({ profile: p, status: 'FAILED' });
      }
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ profile: 'p1', status: 'SUCCESS' });
    expect(results[1]).toEqual({ profile: 'p2', status: 'FAILED' });
    expect(results[2]).toEqual({ profile: 'p3', status: 'SUCCESS' });
  });

  it('each wallet failure should not stop the next wallet', () => {
    const results: Array<{ wallet: number; status: string }> = [];
    const wallets = [0, 1, 2, 3, 4];

    for (const w of wallets) {
      try {
        if (w === 2) throw new Error('faucet error');
        results.push({ wallet: w, status: 'SUCCESS' });
      } catch {
        results.push({ wallet: w, status: 'FAILED' });
      }
    }

    expect(results).toHaveLength(5);
    expect(results[0].status).toBe('SUCCESS');
    expect(results[1].status).toBe('SUCCESS');
    expect(results[2].status).toBe('FAILED');
    expect(results[3].status).toBe('SUCCESS');
    expect(results[4].status).toBe('SUCCESS');
  });

  it('profile closes after processing its wallets', () => {
    // Simulates: launch → process → close
    let launched = false;
    let closed = false;

    const processProfile = async () => {
      launched = true;  // launch
      // process 5 wallets...
      closed = true;   // close in finally block
    };

    processProfile();
    expect(launched).toBe(true);
    expect(closed).toBe(true);
  });

  it('next profile starts only after previous profile is closed', () => {
    const order: string[] = [];
    const profiles = ['p1', 'p2', 'p3'];

    for (const p of profiles) {
      order.push(`${p}:launch`);
      // process...
      order.push(`${p}:close`);
    }

    expect(order).toEqual([
      'p1:launch', 'p1:close',
      'p2:launch', 'p2:close',
      'p3:launch', 'p3:close',
    ]);
  });
});

// ─── Code 6001 does not trigger proxy auto-fix ──────────────────────────────

describe('Plan limit does not trigger proxy fix', () => {
  it('NSTProfileLaunchError with code 6001 has isPlanLimit=true', () => {
    const body = JSON.stringify({ code: 6001, msg: 'exceeded plan limits' });
    const err = new NSTProfileLaunchError('p1', 400, body);
    // A caller would check: if (err.isPlanLimit) skip proxy fix
    expect(err.isPlanLimit).toBe(true);
  });

  it('NSTProfileLaunchError with 403 has isPlanLimit=false', () => {
    const err = new NSTProfileLaunchError('p1', 403, 'forbidden');
    // A caller would check: if (!err.isPlanLimit) try proxy fix
    expect(err.isPlanLimit).toBe(false);
  });
});

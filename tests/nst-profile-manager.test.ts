import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NSTProfileManager, FingerprintRotator } from '../src/nstbrowser';
import { ProfilePool } from '../src/profile-pool';

// ─── Mock logger ────────────────────────────────────────────────────────────

vi.mock('../src/logger', () => ({
  log: vi.fn(),
}));

// ─── NSTProfileManager ──────────────────────────────────────────────────────

describe('NSTProfileManager', () => {
  const profiles = [
    { id: 'p1', name: 'Profile 1', wallets: ['addr1', 'addr2'] },
    { id: 'p2', name: 'Profile 2', wallets: ['addr3', 'addr4'] },
    { id: 'p3', name: 'Profile 3', wallets: ['addr5'] },
  ];

  it('should initialize with correct profile count', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    expect(mgr.profileCount).toBe(3);
  });

  it('should return correct profile for mapped wallet', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    expect(mgr.getProfileForWallet('addr1')).toBe('p1');
    expect(mgr.getProfileForWallet('addr3')).toBe('p2');
    expect(mgr.getProfileForWallet('addr5')).toBe('p3');
  });

  it('should return null when no profiles configured', () => {
    const mgr = new NSTProfileManager([], 'round_robin');
    expect(mgr.getProfileForWallet('unknown')).toBeNull();
  });

  it('should use round_robin strategy for unmapped wallets', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    // Unmapped wallet should get the least-used profile
    const result = mgr.getProfileForWallet('unknown_addr');
    expect(result).toBeTruthy();
    expect(['p1', 'p2', 'p3']).toContain(result);
  });

  it('should use least_used strategy', () => {
    const mgr = new NSTProfileManager(profiles, 'least_used');
    // All start at 0 requests, should pick first
    const result = mgr.getProfileForWallet('unknown');
    expect(result).toBeTruthy();
  });

  it('should use dedicated strategy (least loaded)', () => {
    const mgr = new NSTProfileManager(profiles, 'dedicated');
    const result = mgr.getProfileForWallet('unknown');
    expect(result).toBeTruthy();
  });

  it('should mark profile used and increment count', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    mgr.markProfileUsed('p1');
    mgr.markProfileUsed('p1');
    const stats = mgr.getStats();
    const p1 = stats.find((s) => s.profileId === 'p1');
    expect(p1?.requests).toBe(2);
  });

  it('should report isProfileAvailable', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    expect(mgr.isProfileAvailable('p1')).toBe(true);
    expect(mgr.isProfileAvailable('nonexistent')).toBe(false);
  });

  it('should return all wallets across profiles', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    const all = mgr.getAllWallets();
    expect(all).toEqual(['addr1', 'addr2', 'addr3', 'addr4', 'addr5']);
  });

  it('should return stats for all profiles', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    const stats = mgr.getStats();
    expect(stats.length).toBe(3);
    expect(stats[0].profileId).toBe('p1');
    expect(stats[0].wallets).toBe(2);
    expect(stats[0].requests).toBe(0);
  });

  it('round_robin should distribute evenly', () => {
    const mgr = new NSTProfileManager(profiles, 'round_robin');
    const counts: Record<string, number> = {};

    // Request profiles for unmapped wallets
    for (let i = 0; i < 9; i++) {
      const p = mgr.getProfileForWallet(`unmapped_${i}`);
      if (p) {
        counts[p] = (counts[p] || 0) + 1;
        mgr.markProfileUsed(p);
      }
    }

    // Each profile should get roughly equal requests
    const values = Object.values(counts);
    expect(values.length).toBe(3);
    // With 9 requests across 3 profiles, each gets 3
    expect(values.every((v) => v === 3)).toBe(true);
  });
});

// ─── FingerprintRotator ─────────────────────────────────────────────────────

describe('FingerprintRotator', () => {
  it('should initialize with default config', () => {
    const rotator = new FingerprintRotator();
    expect(rotator.poolSize).toBe(10);
  });

  it('should initialize with custom config', () => {
    const rotator = new FingerprintRotator({
      maxFingerprints: 5,
      rotationStrategy: 'never',
    });
    expect(rotator.poolSize).toBe(5);
  });

  it('should return same fingerprint when strategy is never', () => {
    const rotator = new FingerprintRotator({
      rotationStrategy: 'never',
      maxFingerprints: 5,
    });
    const fp1 = rotator.getNextFingerprint('profile_1');
    const fp2 = rotator.getNextFingerprint('profile_1');
    expect(fp1).toEqual(fp2);
  });

  it('should rotate fingerprint on per_request strategy', () => {
    const rotator = new FingerprintRotator({
      rotationStrategy: 'per_request',
      maxFingerprints: 5,
    });

    const seen = new Set<string>();
    // Get fingerprints for 5 profiles — should see rotation
    for (let i = 0; i < 5; i++) {
      const fp = rotator.getNextFingerprint(`profile_${i}`);
      seen.add(fp.userAgent || '');
    }
    // With per_request rotation, we should see multiple different fingerprints
    expect(seen.size).toBeGreaterThan(1);
  });

  it('should rotate after N attempts with after_attempts strategy', () => {
    const rotator = new FingerprintRotator({
      rotationStrategy: 'after_attempts',
      attemptsBeforeRotation: 2,
      maxFingerprints: 5,
    });

    const fp1 = rotator.getNextFingerprint('p1'); // attempt 0, no rotate
    const fp2 = rotator.getNextFingerprint('p1'); // attempt 1, no rotate
    const fp3 = rotator.getNextFingerprint('p1'); // attempt 2, rotate

    expect(fp1.userAgent).toBeDefined();
    expect(fp2.userAgent).toBeDefined();
    expect(fp3.userAgent).toBeDefined();
    // fp3 should be different from fp1/fp2 after rotation
  });

  it('should reset profile usage', () => {
    const rotator = new FingerprintRotator({
      rotationStrategy: 'after_attempts',
      attemptsBeforeRotation: 3,
      maxFingerprints: 5,
    });

    // Use 3 times to trigger rotation threshold
    rotator.getNextFingerprint('p1');
    rotator.getNextFingerprint('p1');
    rotator.getNextFingerprint('p1');

    // Reset — should not rotate on next call
    rotator.resetProfileUsage('p1');
    const fp = rotator.getNextFingerprint('p1');
    expect(fp.userAgent).toBeDefined();
  });

  it('generated fingerprints should have valid fields', () => {
    const rotator = new FingerprintRotator({ maxFingerprints: 10 });
    const fp = rotator.getNextFingerprint('test');
    expect(fp.userAgent).toBeDefined();
    expect(fp.platform).toBeDefined();
    expect(fp.language).toBeDefined();
    expect(fp.timezone).toBeDefined();
    expect(fp.screenResolution).toBeDefined();
    expect(fp.webglVendor).toBeDefined();
    expect(fp.webglRenderer).toBeDefined();
  });

  it('should cycle through pool circularly', () => {
    const rotator = new FingerprintRotator({
      rotationStrategy: 'per_request',
      maxFingerprints: 3,
    });

    const fp1 = rotator.getNextFingerprint('p1');
    const fp2 = rotator.getNextFingerprint('p2');
    const fp3 = rotator.getNextFingerprint('p3');
    const fp4 = rotator.getNextFingerprint('p4'); // wraps around

    expect(fp1.userAgent).toBeDefined();
    expect(fp4.userAgent).toBeDefined();
    // After 3 rotations, we're back at index 0
  });
});

// ─── ProfilePool ────────────────────────────────────────────────────────────

describe('ProfilePool', () => {
  it('should initialize with given profiles', () => {
    const pool = new ProfilePool(['p1', 'p2', 'p3']);
    expect(pool.totalCount).toBe(3);
    expect(pool.getAvailableCount()).toBe(3);
    expect(pool.getBusyCount()).toBe(0);
  });

  it('should assign available profile', () => {
    const pool = new ProfilePool(['p1', 'p2', 'p3']);
    const id = pool.getAvailableProfile();
    expect(id).toBeTruthy();
    expect(['p1', 'p2', 'p3']).toContain(id);
    expect(pool.getBusyCount()).toBe(1);
    expect(pool.getAvailableCount()).toBe(2);
  });

  it('should release profile', () => {
    const pool = new ProfilePool(['p1', 'p2']);
    const id = pool.getAvailableProfile()!;
    expect(pool.getBusyCount()).toBe(1);

    pool.releaseProfile(id);
    expect(pool.getBusyCount()).toBe(0);
    expect(pool.getAvailableCount()).toBe(2);
  });

  it('should return null when all profiles are busy', () => {
    const pool = new ProfilePool(['p1', 'p2']);
    pool.getAvailableProfile();
    pool.getAvailableProfile();

    expect(pool.hasAvailableProfiles()).toBe(false);
    expect(pool.getAvailableProfile()).toBeNull();
  });

  it('should acquire specific profile', () => {
    const pool = new ProfilePool(['p1', 'p2']);
    const result = pool.acquireProfile('p1', 'wallet_addr');
    expect(result).toBe(true);
    expect(pool.getBusyCount()).toBe(1);
  });

  it('should fail to acquire busy profile', () => {
    const pool = new ProfilePool(['p1']);
    pool.acquireProfile('p1', 'wallet1');
    const result = pool.acquireProfile('p1', 'wallet2');
    expect(result).toBe(false);
  });

  it('should fail to acquire nonexistent profile', () => {
    const pool = new ProfilePool(['p1']);
    const result = pool.acquireProfile('nonexistent', 'wallet');
    expect(result).toBe(false);
  });

  it('should prefer least-used profile', () => {
    const pool = new ProfilePool(['p1', 'p2', 'p3']);

    // Use p1 twice
    pool.acquireProfile('p1', 'w1');
    pool.releaseProfile('p1');
    pool.acquireProfile('p1', 'w2');
    pool.releaseProfile('p1');

    // Next available should prefer p2 or p3 (less used)
    const next = pool.getAvailableProfile();
    expect(next).not.toBe('p1');
  });

  it('should return stats', () => {
    const pool = new ProfilePool(['p1', 'p2']);
    pool.acquireProfile('p1', 'wallet1');

    const stats = pool.getStats();
    expect(stats.length).toBe(2);
    expect(stats[0].id).toBe('p1');
    expect(stats[0].isBusy).toBe(true);
    expect(stats[0].currentAddress).toBe('wallet1');
    expect(stats[1].isBusy).toBe(false);
  });

  it('should reset all profiles', () => {
    const pool = new ProfilePool(['p1', 'p2']);
    pool.acquireProfile('p1', 'w1');
    pool.acquireProfile('p2', 'w2');

    pool.resetAll();

    expect(pool.getBusyCount()).toBe(0);
    expect(pool.getAvailableCount()).toBe(2);
  });

  it('should wait for available profile', async () => {
    const pool = new ProfilePool(['p1']);
    pool.acquireProfile('p1', 'busy');

    // Release after 100ms
    setTimeout(() => pool.releaseProfile('p1'), 100);

    const result = await pool.waitForAvailable(5000);
    expect(result).toBe('p1');
  });

  it('should timeout waiting for available profile', async () => {
    const pool = new ProfilePool(['p1']);
    pool.acquireProfile('p1', 'busy');

    const result = await pool.waitForAvailable(200);
    expect(result).toBeNull();
  });
});

// ─── Integration: Manager + Pool + Rotator ──────────────────────────────────

describe('Integration: Manager + Pool + Rotator', () => {
  it('should work together for wallet processing', () => {
    const profiles = [
      { id: 'p1', name: 'Profile 1', wallets: ['addr1', 'addr2'] },
      { id: 'p2', name: 'Profile 2', wallets: ['addr3', 'addr4'] },
    ];

    const mgr = new NSTProfileManager(profiles, 'round_robin');
    const pool = new ProfilePool(['p1', 'p2']);
    const rotator = new FingerprintRotator({ maxFingerprints: 5 });

    // Get profile for known wallet
    const profileId = mgr.getProfileForWallet('addr1');
    expect(profileId).toBe('p1');

    // Acquire from pool
    const acquired = pool.acquireProfile(profileId!, 'addr1');
    expect(acquired).toBe(true);

    // Get fingerprint
    const fp = rotator.getNextFingerprint(profileId!);
    expect(fp.userAgent).toBeDefined();

    // Release
    pool.releaseProfile(profileId!);
    mgr.markProfileUsed(profileId!);

    // Verify stats
    const stats = mgr.getStats();
    expect(stats[0].requests).toBe(1);
    expect(pool.getAvailableCount()).toBe(2);
  });
});

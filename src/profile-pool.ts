import { log } from './logger';

/**
 * Represents a single profile in the pool with its runtime state.
 */
export interface PooledProfile {
  id: string;
  isBusy: boolean;
  currentAddress: string | null;
  lastUsed: Date;
  consecutiveRequests: number;
}

/**
 * Manages a pool of NSTbrowser profiles for concurrent usage.
 * Tracks which profiles are busy, distributes load evenly, and
 * prevents the same profile from being used by two wallets simultaneously.
 */
export class ProfilePool {
  private pool: Map<string, PooledProfile> = new Map();

  constructor(profileIds: string[]) {
    for (const id of profileIds) {
      this.pool.set(id, {
        id,
        isBusy: false,
        currentAddress: null,
        lastUsed: new Date(0),
        consecutiveRequests: 0,
      });
    }
    log(`[Pool] Initialized with ${profileIds.length} profiles`);
  }

  /**
   * Get an available (non-busy) profile, preferring the least recently used.
   * Returns null if all profiles are busy.
   */
  getAvailableProfile(): string | null {
    const available = Array.from(this.pool.values())
      .filter((p) => !p.isBusy)
      .sort((a, b) => a.consecutiveRequests - b.consecutiveRequests);

    if (available.length === 0) return null;

    const selected = available[0];
    selected.isBusy = true;
    selected.consecutiveRequests++;
    selected.lastUsed = new Date();

    log(`[Pool] Assigned profile ${selected.id} (${available.length} were available)`);
    return selected.id;
  }

  /**
   * Acquire a specific profile by ID. Returns false if already busy.
   */
  acquireProfile(profileId: string, address: string): boolean {
    const profile = this.pool.get(profileId);
    if (!profile || profile.isBusy) return false;

    profile.isBusy = true;
    profile.currentAddress = address;
    profile.consecutiveRequests++;
    profile.lastUsed = new Date();

    log(`[Pool] Acquired profile ${profileId} for ${address.substring(0, 10)}...`);
    return true;
  }

  /**
   * Release a profile back to the pool after processing is done.
   */
  releaseProfile(profileId: string): void {
    const profile = this.pool.get(profileId);
    if (profile) {
      profile.isBusy = false;
      profile.currentAddress = null;
      log(`[Pool] Released profile ${profileId}`);
    }
  }

  /**
   * Check if any profiles are available.
   */
  hasAvailableProfiles(): boolean {
    return Array.from(this.pool.values()).some((p) => !p.isBusy);
  }

  /**
   * Get count of available profiles.
   */
  getAvailableCount(): number {
    return Array.from(this.pool.values()).filter((p) => !p.isBusy).length;
  }

  /**
   * Get count of busy profiles.
   */
  getBusyCount(): number {
    return Array.from(this.pool.values()).filter((p) => p.isBusy).length;
  }

  /**
   * Get total profile count.
   */
  get totalCount(): number {
    return this.pool.size;
  }

  /**
   * Get stats for all profiles.
   */
  getStats(): Array<{
    id: string;
    isBusy: boolean;
    currentAddress: string | null;
    consecutiveRequests: number;
    lastUsed: Date;
  }> {
    return Array.from(this.pool.values()).map((p) => ({
      id: p.id,
      isBusy: p.isBusy,
      currentAddress: p.currentAddress,
      consecutiveRequests: p.consecutiveRequests,
      lastUsed: p.lastUsed,
    }));
  }

  /**
   * Reset all profiles to idle state.
   */
  resetAll(): void {
    for (const profile of this.pool.values()) {
      profile.isBusy = false;
      profile.currentAddress = null;
      profile.consecutiveRequests = 0;
    }
    log('[Pool] All profiles reset');
  }

  /**
   * Wait for any profile to become available.
   * Returns the first available profile ID, or null on timeout.
   */
  async waitForAvailable(timeoutMs: number = 30000): Promise<string | null> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const available = this.getAvailableProfile();
      if (available) return available;
      await new Promise((r) => setTimeout(r, 500));
    }

    log('[Pool] Timeout waiting for available profile');
    return null;
  }
}

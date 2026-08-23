import { describe, it, expect } from 'vitest';
import { checkCloudflareTurnstile, CloudflareVerificationResult } from '../src/cloudflare';

describe('Cloudflare Turnstile', () => {
  it('should export checkCloudflareTurnstile function', () => {
    expect(typeof checkCloudflareTurnstile).toBe('function');
  });

  it('should export CloudflareVerificationResult interface', () => {
    const result: CloudflareVerificationResult = {
      verified: true,
      reason: 'test',
      durationMs: 1000,
    };
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('test');
    expect(result.durationMs).toBe(1000);
  });

  it('should handle null durationMs', () => {
    const result: CloudflareVerificationResult = {
      verified: true,
      reason: 'no widget',
      durationMs: null,
    };
    expect(result.durationMs).toBeNull();
  });

  it('should support false verified state', () => {
    const result: CloudflareVerificationResult = {
      verified: false,
      reason: 'not verified',
      durationMs: 5000,
    };
    expect(result.verified).toBe(false);
  });
});

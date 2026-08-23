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
      widgetFound: true,
      tokenPresent: true,
    };
    expect(result.verified).toBe(true);
    expect(result.reason).toBe('test');
    expect(result.durationMs).toBe(1000);
    expect(result.widgetFound).toBe(true);
    expect(result.tokenPresent).toBe(true);
  });

  it('should handle null durationMs', () => {
    const result: CloudflareVerificationResult = {
      verified: true,
      reason: 'no widget',
      durationMs: null,
      widgetFound: false,
      tokenPresent: false,
    };
    expect(result.durationMs).toBeNull();
  });

  it('should support false verified state', () => {
    const result: CloudflareVerificationResult = {
      verified: false,
      reason: 'not verified',
      durationMs: 5000,
      widgetFound: true,
      tokenPresent: false,
    };
    expect(result.verified).toBe(false);
  });

  it('should support widget found but no token', () => {
    const result: CloudflareVerificationResult = {
      verified: false,
      reason: 'waiting for verification',
      durationMs: null,
      widgetFound: true,
      tokenPresent: false,
    };
    expect(result.widgetFound).toBe(true);
    expect(result.tokenPresent).toBe(false);
  });
});

import { log } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks4';

export interface ProxyConfig {
  enabled: boolean;
  type: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyRotationConfig {
  enabled: boolean;
  rotationStrategy: 'per_request' | 'per_session' | 'per_profile';
  proxyList?: ProxyConfig[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a full proxy URL including auth.
 * socks5://user:pass@host:port
 */
export function getProxyUrl(proxy: ProxyConfig): string {
  const auth =
    proxy.username && proxy.password
      ? `${proxy.username}:${proxy.password}@`
      : '';
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

/**
 * Return a Playwright-compatible proxy object for `browser.newContext()`.
 */
export function getPlaywrightProxy(
  proxy: ProxyConfig
): { server: string; username?: string; password?: string } {
  return {
    server: `${proxy.type}://${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: proxy.password,
  };
}

/**
 * Return the proxy object shape expected by NSTbrowser API v2.
 */
export function getNSTProxyPayload(
  proxy: ProxyConfig
): { type: string; host: string; port: number; username?: string; password?: string } {
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
  };
}

/**
 * Build the full proxy URL string for NSTbrowser profile creation.
 * Format: socks5://user:pass@host:port
 */
export function getNSTProxyString(proxy: ProxyConfig): string {
  return getProxyUrl(proxy);
}

/**
 * Test proxy connectivity by fetching the public IP through it.
 * Returns the outbound IP address on success, null on failure.
 */
export async function testProxy(proxy: ProxyConfig): Promise<string | null> {
  const proxyUrl = getProxyUrl(proxy);
  log(`[Proxy] Testing connection via ${proxy.host}:${proxy.port}...`);

  try {
    // Use undici ProxyAgent for proxy support
    const { ProxyAgent, fetch: undiciFetch } = await import('undici');
    const dispatcher = new ProxyAgent(proxyUrl);

    const res = await undiciFetch('https://api.ipify.org?format=json', {
      dispatcher,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      log(`[Proxy] HTTP ${res.status} from ipify`);
      return null;
    }

    const data = (await res.json()) as { ip: string };
    log(`[Proxy] Connected via proxy. IP: ${data.ip}`);
    return data.ip;
  } catch (error) {
    log(`[Proxy] Connection failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Parse a proxy URL string into a ProxyConfig object.
 * Supports: socks5://user:pass@host:port, http://host:port, etc.
 */
export function parseProxyUrl(url: string): ProxyConfig | null {
  try {
    const parsed = new URL(url);
    const type = parsed.protocol.replace(':', '') as ProxyProtocol;

    if (!['http', 'https', 'socks5', 'socks4'].includes(type)) {
      return null;
    }

    return {
      enabled: true,
      type,
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : (type === 'https' ? 443 : 80),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch {
    return null;
  }
}

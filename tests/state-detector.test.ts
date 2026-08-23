import { describe, it, expect } from 'vitest';
import { detectPageState, PageFaucetState, WalletState } from '../src/state-detector';
import { loadConfig, MAX_WALLETS } from '../src/wallet-manager';

function makeDocument(errDiv: any, sendButton?: any) {
  return {
    getElementById: (id: string) => {
      if (id === '#faucet_err' || id === 'faucet_err') return errDiv;
      if (id === '#sendButton' || id === 'sendButton') return sendButton || null;
      return null;
    },
  };
}

describe('detectPageState', () => {
  it('should return IDLE when error div is missing', () => {
    const doc = makeDocument(null);
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.IDLE);
  });

  it('should return SUCCESS when class contains is-success', () => {
    const doc = makeDocument({
      textContent: 'Sent 1000 sats to tb1p...',
      innerHTML: 'Sent 1000 sats to tb1p...',
      className: 'notification is-success',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.SUCCESS);
    expect(result.text).toContain('Sent');
  });

  it('should detect error text case-insensitive: "error"', () => {
    const doc = makeDocument({
      textContent: 'Error: Please slow down',
      innerHTML: 'Error: Please slow down',
      className: 'notification is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should detect error text case-insensitive: "ERROR"', () => {
    const doc = makeDocument({
      textContent: 'ERROR',
      innerHTML: 'ERROR',
      className: 'notification is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should detect error text case-insensitive: "Error"', () => {
    const doc = makeDocument({
      textContent: 'Error: something went wrong',
      innerHTML: 'Error: something went wrong',
      className: 'notification is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should detect error via CSS class is-danger even without error text', () => {
    const doc = makeDocument({
      textContent: 'Please slow down',
      innerHTML: 'Please slow down',
      className: 'notification is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should detect error in innerHTML with mixed case', () => {
    const doc = makeDocument({
      textContent: 'Something',
      innerHTML: '<span>Error occurred</span>',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should return PROCESSING when text is "- processing -"', () => {
    const doc = makeDocument({
      textContent: '- processing -',
      innerHTML: '- processing -',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.PROCESSING);
  });

  it('should return CLOUDFLARE_PENDING for empty state without sendButton', () => {
    const doc = makeDocument({
      textContent: '',
      innerHTML: '',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.CLOUDFLARE_PENDING);
  });

  it('should detect CLOUDFLARE_READY when button is enabled with correct text', () => {
    const doc = makeDocument(
      {
        textContent: '',
        innerHTML: '',
        className: '',
        style: { cssText: '' },
      },
      {
        textContent: 'Press (ENTER) to receive',
        className: '',
        disabled: false,
        style: { cssText: '' },
      }
    );
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.CLOUDFLARE_READY);
  });

  it('should detect CLOUDFLARE_PENDING when button is disabled with Please wait', () => {
    const doc = makeDocument(
      {
        textContent: '',
        innerHTML: '',
        className: '',
        style: { cssText: '' },
      },
      {
        textContent: '^^ Please wait ^^',
        className: '',
        disabled: true,
        style: { cssText: '' },
      }
    );
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.CLOUDFLARE_PENDING);
  });

  it('should not treat non-error text as error', () => {
    const doc = makeDocument({
      textContent: '- processing -',
      innerHTML: '- processing -',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).not.toBe(PageFaucetState.ERROR);
  });

  it('should detect error even when text does not contain "error" but class is is-danger', () => {
    const doc = makeDocument({
      textContent: '400: Please slow down',
      innerHTML: '400: Please slow down',
      className: 'notification is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });
});

describe('WalletState enum', () => {
  it('should have all expected states', () => {
    const states: WalletState[] = ['PENDING', 'PROCESSING', 'COMPLETED', 'ERROR', 'TIMEOUT'];
    expect(states).toContain('PENDING');
    expect(states).toContain('PROCESSING');
    expect(states).toContain('COMPLETED');
    expect(states).toContain('ERROR');
    expect(states).toContain('TIMEOUT');
  });
});

describe('PageFaucetState enum', () => {
  it('should have all expected states', () => {
    expect(PageFaucetState.IDLE).toBe('IDLE');
    expect(PageFaucetState.CLOUDFLARE_PENDING).toBe('CLOUDFLARE_PENDING');
    expect(PageFaucetState.CLOUDFLARE_READY).toBe('CLOUDFLARE_READY');
    expect(PageFaucetState.PROCESSING).toBe('PROCESSING');
    expect(PageFaucetState.SUCCESS).toBe('SUCCESS');
    expect(PageFaucetState.ERROR).toBe('ERROR');
  });
});

describe('Edge cases for state detection', () => {
  it('should handle whitespace-only text as not error', () => {
    const doc = makeDocument({
      textContent: '   ',
      innerHTML: '   ',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).not.toBe(PageFaucetState.ERROR);
  });

  it('should handle error with lowercase "error" in innerHTML', () => {
    const doc = makeDocument({
      textContent: 'ok',
      innerHTML: '<div>some error happened</div>',
      className: '',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.ERROR);
  });

  it('should prioritize SUCCESS over ERROR', () => {
    const doc = makeDocument({
      textContent: 'Error: but also success',
      innerHTML: 'Error: but also success',
      className: 'notification is-success is-danger',
      style: { cssText: '' },
    });
    const result = detectPageState(doc as any);
    expect(result.state).toBe(PageFaucetState.SUCCESS);
  });
});

describe('Wallet limit validation', () => {
  const validAddress = 'tb1plk37agr9yx22q0z2v7d2u4szz0zxye0watw48ders4e6q627f2qsrr566r';
  const tmpDir = require('os').tmpdir();

  function makeConfigPath(count: number): string {
    const wallets = Array.from({ length: count }, () => validAddress);
    const config = {
      wallets,
      browser: { userDataDir: '/tmp', profileDirectory: 'Profile 2', headless: false },
      faucet: { url: 'https://example.com', walletTimeoutMs: 60000 },
    };
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(tmpDir, `crane-test-config-${count}.json`);
    fs.writeFileSync(filePath, JSON.stringify(config), 'utf-8');
    return filePath;
  }

  it('should accept 1 wallet', () => {
    const configPath = makeConfigPath(1);
    const config = loadConfig(configPath);
    expect(config.wallets.length).toBe(1);
  });

  it('should accept 10 wallets', () => {
    const configPath = makeConfigPath(10);
    const config = loadConfig(configPath);
    expect(config.wallets.length).toBe(10);
  });

  it('should accept 49 wallets', () => {
    const configPath = makeConfigPath(49);
    const config = loadConfig(configPath);
    expect(config.wallets.length).toBe(49);
  });

  it('should accept 50 wallets', () => {
    const configPath = makeConfigPath(50);
    const config = loadConfig(configPath);
    expect(config.wallets.length).toBe(50);
  });

  it('should reject 51 wallets', () => {
    const configPath = makeConfigPath(51);
    expect(() => loadConfig(configPath)).toThrow(`Maximum ${MAX_WALLETS} wallets supported`);
  });

  it('should reject empty wallets array', () => {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(tmpDir, 'crane-test-config-empty.json');
    fs.writeFileSync(filePath, JSON.stringify({
      wallets: [],
      browser: { userDataDir: '/tmp', profileDirectory: 'Profile 2', headless: false },
      faucet: { url: 'https://example.com', walletTimeoutMs: 60000 },
    }), 'utf-8');
    expect(() => loadConfig(filePath)).toThrow('non-empty');
  });

  it('should have MAX_WALLETS set to 50', () => {
    expect(MAX_WALLETS).toBe(50);
  });
});

import { chromium, BrowserContext } from 'playwright-core';
import { log, logError } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface BrowserConfig {
  userDataDir: string;
  profileDirectory: string;
  headless: boolean;
  chromePath?: string;
}

function findChromePath(): string | undefined {
  const { platform } = process;
  if (platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  const linuxPaths = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
  ];
  for (const p of linuxPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function isChromeRunning(): boolean {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      const output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return output.toLowerCase().includes('chrome.exe');
    }
    if (platform === 'darwin') {
      const output = execSync('pgrep -x "Google Chrome"', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return output.trim().length > 0;
    }
    const output = execSync('pgrep -x chrome', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function checkLockFiles(userDataDir: string, profileDirectory: string): { locked: boolean; reason: string } {
  const profileDir = path.join(userDataDir, profileDirectory);
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

  for (const lockFile of lockFiles) {
    const lockPath = path.join(profileDir, lockFile);
    if (fs.existsSync(lockPath)) {
      return {
        locked: true,
        reason: `Lock file exists: ${lockPath}`,
      };
    }
  }

  const mainLockPath = path.join(userDataDir, 'SingletonLock');
  if (fs.existsSync(mainLockPath)) {
    return {
      locked: true,
      reason: `Main lock file exists: ${mainLockPath}`,
    };
  }

  return { locked: false, reason: '' };
}

export async function launchBrowser(config: BrowserConfig): Promise<BrowserContext> {
  const chromePath = config.chromePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Set CHROME_PATH in .env or config.json'
    );
  }

  log(`Chrome executable: ${chromePath}`);
  log(`User Data Dir: ${config.userDataDir}`);
  log(`Profile: ${config.profileDirectory}`);

  log('Checking whether Chrome is already running...');
  const chromeRunning = isChromeRunning();
  if (chromeRunning) {
    log('Chrome processes detected. Checking profile lock...');
    const lockCheck = checkLockFiles(config.userDataDir, config.profileDirectory);
    if (lockCheck.locked) {
      throw new Error(
        `Chrome Profile "${config.profileDirectory}" is currently in use.\n` +
        `Reason: ${lockCheck.reason}\n` +
        `Close all Google Chrome windows and try again.`
      );
    }
    log('No profile lock found, proceeding with launch...');
  } else {
    log('No Chrome processes found');
  }

  log('Launching Chrome...');
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.userDataDir, {
      headless: config.headless,
      executablePath: chromePath,
      args: [
        `--profile-directory=${config.profileDirectory}`,
      ],
      viewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--disable-extensions'],
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to launch Chrome Profile "${config.profileDirectory}".\n` +
      `Chrome executable: ${chromePath}\n` +
      `User Data Dir: ${config.userDataDir}\n` +
      `Error: ${msg}\n\n` +
      `Make sure Chrome is fully closed before running the bot.`
    );
  }

  log('Chrome launched successfully');
  log('Persistent context created');

  return context;
}

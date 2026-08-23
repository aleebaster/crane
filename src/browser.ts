import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { log } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface BrowserConfig {
  userDataDir: string;
  profileDirectory: string;
  headless: boolean;
  chromePath?: string;
}

export interface BrowserLaunchResult {
  browser: Browser;
  context: BrowserContext;
  page: Page;
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

function validateProfile(userDataDir: string, profileDirectory: string): void {
  if (!fs.existsSync(userDataDir)) {
    throw new Error(
      `Chrome User Data directory not found: ${userDataDir}\n` +
      `Make sure Google Chrome is installed.`
    );
  }

  const profileDir = path.join(userDataDir, profileDirectory);
  if (!fs.existsSync(profileDir)) {
    throw new Error(
      `Chrome profile "${profileDirectory}" not found at: ${profileDir}\n` +
      `Create this profile in Chrome first: Menu > Profiles > Add Profile`
    );
  }
}

function getValidPage(context: BrowserContext): Page {
  const pages = context.pages();
  for (const p of pages) {
    if (!p.isClosed()) {
      return p;
    }
  }
  return pages[pages.length - 1];
}

async function waitForCDP(port: number, timeoutMs: number = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`CDP not ready on port ${port} after ${timeoutMs}ms`);
}

function launchChromeViaPowerShell(chromePath: string, userDataDir: string, profileDirectory: string, port: number): void {
  const psScript = `
Start-Process -FilePath '${chromePath}' -ArgumentList @(
  '--remote-debugging-port=${port}',
  '--user-data-dir=${userDataDir}',
  '--profile-directory=${profileDirectory}',
  '--no-first-run',
  '--no-default-browser-check',
  '--new-window',
  'about:blank'
) -PassThru | Out-Null
`;

  execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
    encoding: 'utf-8',
    timeout: 10000,
    stdio: 'pipe',
  });
}

export async function launchBrowser(config: BrowserConfig): Promise<BrowserLaunchResult> {
  const chromePath = config.chromePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Set CHROME_PATH in .env or config.json'
    );
  }

  log(`Chrome executable: ${chromePath}`);
  log(`Chrome User Data: ${config.userDataDir}`);
  log(`Bot Chrome profile: ${config.profileDirectory}`);
  log('User Default profile will not be used');

  validateProfile(config.userDataDir, config.profileDirectory);

  const port = 9222 + Math.floor(Math.random() * 1000);
  log(`Using CDP port: ${port}`);

  log('Launching Chrome...');
  launchChromeViaPowerShell(chromePath, config.userDataDir, config.profileDirectory, port);

  log('Waiting for Chrome CDP...');
  await waitForCDP(port, 15000);
  log('Chrome CDP ready');

  log('Connecting via CDP...');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  log('Connected to Chrome via CDP');

  const context = browser.contexts()[0] || await browser.newContext();
  const page = getValidPage(context);

  log(`Initial page URL: ${page.url()}`);

  return { browser, context, page };
}

import { chromium, BrowserContext } from 'playwright-core';
import { log, logError } from './logger';

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
    const fs = require('fs');
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }
  if (platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  const fs = require('fs');
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

export async function launchBrowser(config: BrowserConfig): Promise<BrowserContext> {
  const chromePath = config.chromePath || findChromePath();
  if (!chromePath) {
    throw new Error(
      'Chrome not found. Set CHROME_PATH in .env or config.json'
    );
  }

  log(`Launching Chrome from: ${chromePath}`);
  log(`Profile: ${config.userDataDir}\\${config.profileDirectory}`);

  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless: config.headless,
    executablePath: chromePath,
    channel: undefined,
    args: [
      `--profile-directory=${config.profileDirectory}`,
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  log('Chrome Profile 2 connected');
  return context;
}

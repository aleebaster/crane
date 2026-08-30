/**
 * NSTbrowser API Diagnostic Script
 *
 * Run with: npx tsx test-nst-api.ts
 *
 * This script tests:
 * 1. API connectivity
 * 2. Profile listing
 * 3. Profile creation
 * 4. Profile launch
 * 5. CDP connection
 */

import * as dotenv from 'dotenv';
dotenv.config();

const NST_API_BASE = 'http://localhost:8848/api/v2';
const API_KEY = process.env.NST_API_KEY || '';

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
  };
}

async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('='.repeat(60));
  try {
    await fn();
    console.log(`  ✅ ${name} — PASSED`);
    return true;
  } catch (error) {
    console.error(`  ❌ ${name} — FAILED`);
    console.error(`  Error: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

async function main() {
  console.log('NSTbrowser API Diagnostic');
  console.log(`API Base: ${NST_API_BASE}`);
  console.log(`API Key: ${API_KEY ? API_KEY.substring(0, 8) + '...' : '(NOT SET)'}`);

  if (!API_KEY) {
    console.error('\n⚠️  NST_API_KEY is not set!');
    console.error('Set it in .env or as environment variable:');
    console.error('  export NST_API_KEY=your_key_here');
    console.error('\nGenerate a key in NSTbrowser Client > Settings > API Keys');
    process.exit(1);
  }

  const results: boolean[] = [];

  // Step 1: Check API status
  results.push(await step('1. API Connectivity', async () => {
    const res = await fetch(`${NST_API_BASE}/browsers`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
      signal: AbortSignal.timeout(5000),
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    if (!res.ok) {
      const text = await res.text();
      console.log(`  Body: ${text}`);
      throw new Error(`API returned ${res.status}`);
    }
    const data = await res.json();
    console.log(`  Response: ${JSON.stringify(data).substring(0, 200)}`);
  }));

  // Step 2: List profiles
  let profileIds: string[] = [];
  results.push(await step('2. List Profiles', async () => {
    const res = await fetch(`${NST_API_BASE}/profiles`, {
      method: 'GET',
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    console.log(`  Status: ${res.status}`);
    if (!res.ok) {
      const text = await res.text();
      console.log(`  Body: ${text}`);
      throw new Error(`List profiles returned ${res.status}`);
    }
    const raw = await res.json() as Record<string, unknown>;
    const inner = (raw.data || raw) as Record<string, unknown>;
    const profiles = ((inner.profiles || inner.list) || []) as Array<{ id: string; name: string }>;
    console.log(`  Found ${profiles.length} profiles:`);
    for (const p of profiles) {
      console.log(`    - ${p.id}: ${p.name}`);
      profileIds.push(p.id);
    }
  }));

  // Step 3: Create a test profile
  let testProfileId: string | null = null;
  results.push(await step('3. Create Test Profile', async () => {
    const body = {
      name: `diagnostic_test_${Date.now()}`,
      platform: 'Windows',
      kernelMilestone: '140',
      fingerprint: {
        flags: {
          audio: 'Noise',
          canvas: 'Noise',
          clientRect: 'Noise',
          localization: 'Custom',
          screen: 'Custom',
          timezone: 'Custom',
          webgl: 'Noise',
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        localization: {
          language: 'en-US',
          languages: ['en-US', 'en'],
          timezone: 'America/New_York',
        },
        screen: { width: 1920, height: 1080 },
        deviceMemory: 8,
        hardwareConcurrency: 16,
      },
    };

    console.log(`  POST ${NST_API_BASE}/profiles`);
    console.log(`  Body: ${JSON.stringify(body).substring(0, 200)}...`);

    const res = await fetch(`${NST_API_BASE}/profiles`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);

    const text = await res.text();
    console.log(`  Response: ${text.substring(0, 500)}`);

    if (!res.ok) {
      throw new Error(`Create profile returned ${res.status}: ${text}`);
    }

    const raw = JSON.parse(text);
    const inner = raw.data || raw;
    testProfileId = inner.profileId || inner.id;
    console.log(`  Created profile ID: ${testProfileId}`);
  }));

  // Step 4: Launch the test profile
  let browserId: string | null = null;
  if (testProfileId) {
    results.push(await step('4. Launch Test Profile', async () => {
      console.log(`  POST ${NST_API_BASE}/browsers/${testProfileId}`);

      const res = await fetch(`${NST_API_BASE}/browsers/${testProfileId}`, {
        method: 'POST',
        headers: headers(),
      });
      console.log(`  Status: ${res.status} ${res.statusText}`);

      const text = await res.text();
      console.log(`  Response: ${text.substring(0, 500)}`);

      if (!res.ok) {
        throw new Error(`Launch returned ${res.status}: ${text}`);
      }

      const raw = JSON.parse(text);
      const inner = raw.data || raw;
      browserId = inner.id || inner.browserId;
      console.log(`  Browser ID: ${browserId}`);
    }));
  }

  // Step 5: Get debugger endpoint (from launch response)
  // The launch response already contains webSocketDebuggerUrl
  // If not, try the debugger endpoint
  if (testProfileId) {
    results.push(await step('5. Verify Debugger Endpoint', async () => {
      // The launch response should have webSocketDebuggerUrl
      // Let's also try the dedicated debugger endpoint
      console.log(`  GET ${NST_API_BASE}/browsers/${testProfileId}/debugger`);

      const res = await fetch(`${NST_API_BASE}/browsers/${testProfileId}/debugger`, {
        method: 'GET',
        headers: { 'x-api-key': API_KEY },
      });
      console.log(`  Status: ${res.status}`);

      const text = await res.text();
      console.log(`  Response: ${text.substring(0, 500)}`);

      if (!res.ok) {
        throw new Error(`Debugger returned ${res.status}: ${text}`);
      }

      const raw = JSON.parse(text);
      const inner = raw.data || raw;
      const wsUrl = inner.wsUrl || inner.webSocketDebuggerUrl || inner.url || inner.webSocketUrl;
      console.log(`  WebSocket URL: ${wsUrl}`);
    }));
  }

  // Step 6: Cleanup - delete test profile
  if (testProfileId) {
    results.push(await step('6. Cleanup: Delete Test Profile', async () => {
      console.log(`  DELETE ${NST_API_BASE}/profiles/${testProfileId}`);

      const res = await fetch(`${NST_API_BASE}/profiles/${testProfileId}`, {
        method: 'DELETE',
        headers: { 'x-api-key': API_KEY },
      });
      console.log(`  Status: ${res.status}`);
    }));
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`  ${passed}/${total} steps passed`);

  if (passed === total) {
    console.log('\n  ✅ All checks passed! NSTbrowser API is working correctly.');
  } else {
    console.log('\n  ❌ Some checks failed. See errors above.');
    console.log('\n  Common issues:');
    console.log('  1. NSTbrowser is not running — start it manually');
    console.log('  2. API key is invalid — regenerate in Settings > API Keys');
    console.log('  3. Port 8848 is blocked — check firewall');
    console.log('  4. API version mismatch — ensure using v2 endpoints');
  }

  process.exit(passed === total ? 0 : 1);
}

main();

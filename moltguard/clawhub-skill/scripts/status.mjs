#!/usr/bin/env node
/**
 * MoltGuard status check
 * Reads local credentials and optionally queries the API for account status.
 *
 * Usage: node status.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDS_FILE = join(homedir(), '.openclaw/credentials/moltguard/credentials.json');
const CORE_URL = 'https://www.openguardrails.com/core';

async function main() {
  if (!existsSync(CREDS_FILE)) {
    console.log('MoltGuard Status\n');
    console.log('- Status:   not registered');
    console.log('\nLocal protections (injection redaction, shell escape blocking) are active.');
    console.log('Run activate.mjs to register and enable cloud behavioral detection.');
    process.exit(0);
  }

  let creds;
  try {
    creds = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
  } catch {
    console.error('Error: Could not read credentials file at', CREDS_FILE);
    process.exit(1);
  }

  if (!creds?.apiKey) {
    console.error('Error: credentials.json is missing apiKey');
    process.exit(1);
  }

  // Try to fetch live account status
  let accountStatus = 'registered (pending email verification)';
  let email = null;

  try {
    const res = await fetch(`${CORE_URL}/api/v1/account`, {
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.status === 'active') {
        accountStatus = 'active';
        email = data.email ?? null;
      }
    }
  } catch {
    accountStatus = 'registered (API unreachable — local protections still active)';
  }

  console.log('MoltGuard Status\n');
  console.log(`- Agent ID: ${creds.agentId}`);
  console.log(`- API Key:  ${creds.apiKey.slice(0, 16)}...`);
  if (email) console.log(`- Email:    ${email}`);
  console.log(`- Status:   ${accountStatus}`);
  console.log(`- Platform: ${CORE_URL}`);

  if (accountStatus !== 'active' && creds.claimUrl) {
    console.log('\nTo activate cloud detection:');
    console.log(`  1. Visit: ${creds.claimUrl}`);
    console.log('  2. Enter your email to complete activation.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * MoltGuard activation
 * Registers a new agent with OpenGuardrails Core and displays claim instructions.
 * If already registered, shows existing credentials and claim URL.
 *
 * Usage: node activate.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CREDS_DIR = join(homedir(), '.openclaw/credentials/moltguard');
const CREDS_FILE = join(CREDS_DIR, 'credentials.json');
const CORE_URL = 'https://www.openguardrails.com/core';
const AGENT_NAME = 'OpenClaw Agent';

async function main() {
  // Already registered — show existing claim URL
  if (existsSync(CREDS_FILE)) {
    let creds;
    try {
      creds = JSON.parse(readFileSync(CREDS_FILE, 'utf-8'));
    } catch {
      // Fall through to re-register if file is corrupt
    }

    if (creds?.apiKey) {
      console.log('MoltGuard is already registered.\n');
      console.log(`- Agent ID: ${creds.agentId}`);
      console.log(`- API Key:  ${creds.apiKey.slice(0, 16)}...`);

      if (creds.claimUrl) {
        console.log('\nIf not yet activated, claim your agent:');
        console.log(`  1. Visit: ${creds.claimUrl}`);
        console.log('  2. Enter your email to complete activation.');
        console.log('\nOnce activated, cloud behavioral detection will begin automatically.');
      } else {
        console.log('\nRun status.mjs to check activation status.');
      }
      return;
    }
  }

  // Register new agent
  console.log('Registering MoltGuard with OpenGuardrails...\n');

  let res;
  try {
    res = await fetch(`${CORE_URL}/api/v1/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: AGENT_NAME, description: '' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Error: Could not reach OpenGuardrails API:', err.message);
    console.error('Check your network connection or try again later.');
    process.exit(1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`Error: Registration failed (${res.status} ${res.statusText})${text ? ': ' + text : ''}`);
    process.exit(1);
  }

  const json = await res.json();
  if (!json.success || !json.agent) {
    console.error('Error: Registration error:', json.error ?? 'unknown response');
    process.exit(1);
  }

  const creds = {
    apiKey: json.agent.api_key,
    agentId: json.agent.id,
    claimUrl: json.activate_url,
  };

  mkdirSync(CREDS_DIR, { recursive: true });
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2), 'utf-8');

  console.log('MoltGuard: Claim Your Agent\n');
  console.log(`Agent ID: ${creds.agentId}\n`);
  console.log('Complete these steps to activate cloud behavioral detection:\n');
  console.log(`  1. Visit: ${creds.claimUrl}`);
  console.log('  2. Enter your email — this becomes your account login.\n');
  console.log('After claiming you get 30,000 free detections.');
  console.log(`Platform: ${CORE_URL}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

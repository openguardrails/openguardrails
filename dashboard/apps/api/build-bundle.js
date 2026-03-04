#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { copyFileSync, rmSync, mkdirSync, cpSync } from 'fs';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bundleDir = resolve(__dirname, 'bundle');

// Clean and recreate bundle directory
try {
  rmSync(bundleDir, { recursive: true, force: true });
} catch {}
mkdirSync(bundleDir, { recursive: true });

// Build with TypeScript first
execSync('pnpm tsc', { stdio: 'inherit', cwd: __dirname });

// Bundle with ncc
execSync(
  'pnpm ncc build dist/index.js -o bundle --external better-sqlite3 --external pg --external mysql2 --source-map',
  { stdio: 'inherit', cwd: __dirname }
);

// Copy bundle-specific package.json
copyFileSync(
  resolve(__dirname, 'bundle-package.json'),
  resolve(__dirname, 'bundle/package.json')
);

// Copy database migrations (required for auto-migration on startup)
const migrationsSource = resolve(__dirname, '../../packages/db/drizzle');
const migrationsTarget = resolve(__dirname, 'bundle/drizzle');
cpSync(migrationsSource, migrationsTarget, { recursive: true });

console.log('✓ Bundle created at bundle/index.js');
console.log('✓ Migrations copied to bundle/drizzle/');

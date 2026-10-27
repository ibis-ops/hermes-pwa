#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const packs = JSON.parse(output);
const pack = packs[0];
if (!pack || !Array.isArray(pack.files)) {
  throw new Error('npm pack --dry-run did not return a package file list');
}

const files = pack.files.map((entry) => entry.path).sort();
const forbidden = files.filter((path) => {
  return (
    path.includes('__pycache__/') ||
    path.endsWith('.pyc') ||
    path.includes('.pytest_cache/') ||
    path.includes('coverage/') ||
    path.includes('node_modules/') ||
    path.startsWith('dashboard/tests/') ||
    path.includes('/source/') ||
    path.endsWith('.map') ||
    path === 'docs/AUDIT.md' ||
    path === 'docs/THIRD_PARTY_CLIENT.md' ||
    path.endsWith('.log') ||
    path.endsWith('.tmp')
  );
});

const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'plugin.yaml',
  '__init__.py',
  'push_common.py',
  // plugin_api.py imports these at load; a package without them cannot start.
  'local_files.py',
  'agent_history.py',
  'obsidian_activity.py',
  'pwa_speech.py',
  'bot_graph.py',
  'pwa_router.py',
  'obsidian_sync.py',
  'plugin_copies.py',
  'dashboard/manifest.json',
  'dashboard/plugin_api.py',
  'dashboard/dist/index.js',
  'dashboard/dist/style.css',
  'dashboard/dist/mobile/index.html',
  'dashboard/dist/mobile/manifest.json',
  'dashboard/dist/mobile/service-worker.js',
  'scripts/install-plugin.mjs',
  'scripts/verify-pack.mjs',
  'scripts/check-version-consistency.mjs',
];

const missing = required.filter((path) => !files.includes(path));
if (forbidden.length || missing.length) {
  if (forbidden.length) {
    console.error('Forbidden files in npm package:');
    for (const path of forbidden) console.error(`- ${path}`);
  }
  if (missing.length) {
    console.error('Required files missing from npm package:');
    for (const path of missing) console.error(`- ${path}`);
  }
  process.exit(1);
}

console.log(`✅ npm package payload verified: ${pack.name}@${pack.version}, ${files.length} files, ${pack.unpackedSize} bytes unpacked`);

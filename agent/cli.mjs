#!/usr/bin/env node
// claude-usage: sets up your own Supabase backend, installs the agent and pairs the iPhone app.
//
//   node cli.mjs setup     interactive wizard (flags below skip the prompts)
//   node cli.mjs qr        show the pairing QR code again
//   node cli.mjs status    show the state of agent, config and data
//   node cli.mjs uninstall [--purge]   remove the agent (--purge also deletes config and secret key)
import os from 'node:os';
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import {
  LABEL, LOG, PLIST, INTERVAL_SECONDS, CONFIG_FILE,
  applySchema, deleteSecret, fetchLatest, installLaunchd, isLaunchdLoaded,
  readConfigFile, readSecret, removeLaunchd, restHeaders, saveSecret, writeConfigFile,
} from './lib.mjs';
import { readActiveBlock, sendSnapshot, toPayload } from './collect.mjs';

const { positionals, values: flags } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    'secret-key': { type: 'string' },
    'publishable-key': { type: 'string' },
    'db-url': { type: 'string' },
    device: { type: 'string' },
    'skip-schema': { type: 'boolean' },
    'skip-verify': { type: 'boolean' },
    'skip-snapshot': { type: 'boolean' },
    'no-launchd': { type: 'boolean' },
    purge: { type: 'boolean' },
  },
});

const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m!\x1b[0m ${msg}`);
const fail = (msg) => { console.error(`\x1b[31m✖\x1b[0m ${msg}`); process.exit(1); };

// ---- Prompts -------------------------------------------------------------------------------

let muted = false;
const output = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
let rl;

async function ask(question, { hidden = false, fallback = '' } = {}) {
  rl ??= readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
  const suffix = fallback && !hidden ? ` [${fallback}]` : '';
  const pending = rl.question(`${question}${suffix}: `);
  muted = hidden;
  const answer = (await pending).trim();
  muted = false;
  if (hidden) process.stdout.write('\n');
  return answer || fallback;
}

// ---- Pairing QR ----------------------------------------------------------------------------

// The iPhone app expects {"url": "...", "key": "..."}.
async function printPairingQr(url, publishableKey) {
  const payload = JSON.stringify({ url, key: publishableKey });
  console.log('\nScan this in the Claude Usage app on your iPhone:\n');
  console.log(await QRCode.toString(payload, { type: 'terminal', small: true }));
  console.log('Or enter manually in the app:');
  console.log(`  URL:             ${url}`);
  console.log(`  Publishable key: ${publishableKey}\n`);
}

// ---- Validation ----------------------------------------------------------------------------

function projectRef(url) {
  return /^https:\/\/([a-z0-9]+)\.supabase\.(co|in)/i.exec(url)?.[1] ?? null;
}

async function checkSecretKey(url, secretKey) {
  const res = await fetch(`${url}/rest/v1/usage_snapshots?limit=1`, {
    headers: restHeaders(secretKey),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`secret key check failed (HTTP ${res.status}): ${await res.text()}`);
}

// PostgREST reloads its schema cache asynchronously after DDL. Right after the schema is applied it can
// still answer PGRST205 (table) or PGRST202 (function) for a few seconds, so those errors are retried.
async function withSchemaCacheRetry(check) {
  const attempts = 10;
  for (let i = 1; ; i++) {
    try {
      return await check();
    } catch (err) {
      const stale = /PGRST20[25]/.test(err.message);
      if (!stale || i === attempts) throw err;
      if (i === 1) console.log('  Waiting for Supabase to pick up the new schema...');
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function verifyBackend({ url, secretKey, publishableKey }) {
  await withSchemaCacheRetry(() => checkSecretKey(url, secretKey));
  try {
    await withSchemaCacheRetry(() => fetchLatest(url, publishableKey));
  } catch (err) {
    throw new Error(`publishable key check failed: ${err.message}`);
  }
}

// ---- Commands ------------------------------------------------------------------------------

async function setup() {
  const existing = (await readConfigFile()) ?? {};
  console.log('Claude Usage setup. Values come from your Supabase project (Settings -> Data API -> API Keys -> Connect dialog (Direct tab -> chose Session pooler as Connection Method)).\n');

  const url = (flags.url ?? (await ask('Supabase project URL', { fallback: existing.url }))).replace(/\/+$/, '');
  const secretKey = flags['secret-key'] ?? (await ask('Secret key (sb_secret_...)', { hidden: true }));
  const publishableKey = flags['publishable-key'] ?? (await ask('Publishable key (sb_publishable_...)', { fallback: existing.publishableKey }));
  const dbUrl = flags['skip-schema']
    ? null
    : flags['db-url'] ?? (await ask('Postgres connection string (pooler URI, used once to create tables)', { hidden: true }));
  const device = flags.device ?? (await ask('Device name', { fallback: existing.device ?? os.hostname() }));
  rl?.close();

  if (!/^https:\/\//.test(url)) fail('The project URL must start with https://');
  if (!secretKey) fail('The secret key is required');
  if (!publishableKey) fail('The publishable key is required');
  if (dbUrl !== null && !/^postgres(ql)?:\/\//.test(dbUrl)) fail('The connection string must start with postgresql://');

  const ref = projectRef(url);
  if (dbUrl && ref && !dbUrl.includes(ref)) {
    warn(`The connection string does not mention project "${ref}". Make sure both belong to the same project.`);
  }

  if (dbUrl) {
    try {
      const result = await applySchema(dbUrl);
      ok(result.action === 'up-to-date'
        ? `Schema already up to date (version ${result.version})`
        : `Schema ${result.action} (version ${result.version})`);
    } catch (err) {
      fail(`Could not apply the schema: ${err.message}\n  Tip: use the "Session pooler" URI from Supabase -> Connect; the direct host is IPv6-only on many networks.`);
    }
  } else {
    warn('Skipped the schema (--skip-schema)');
  }

  if (!flags['skip-verify']) {
    try {
      await verifyBackend({ url, secretKey, publishableKey });
      ok('Both keys work against your project');
    } catch (err) {
      fail(err.message);
    }
  }

  await saveSecret(secretKey);
  await writeConfigFile({ url, publishableKey, device });
  ok(`Config saved (${CONFIG_FILE}); secret key stored in the macOS Keychain`);

  if (!flags['no-launchd']) {
    await installLaunchd();
    ok(`Agent installed in launchd (every ${INTERVAL_SECONDS} s, log: ${LOG})`);
  }

  if (!flags['skip-snapshot']) {
    try {
      const payload = toPayload(await readActiveBlock(), device);
      await sendSnapshot({ url, secretKey }, payload);
      ok(`First snapshot sent (cost $${payload.cost_usd}, ${payload.total_tokens} tokens)`);
    } catch (err) {
      warn(`First snapshot failed: ${err.message} (the agent will retry on its own)`);
    }
  }

  await printPairingQr(url, publishableKey);
}

async function showQr() {
  const config = await readConfigFile();
  if (!config?.url || !config?.publishableKey) fail('Not configured. Run: node cli.mjs setup');
  await printPairingQr(config.url, config.publishableKey);
}

function age(date) {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

async function status() {
  const config = await readConfigFile();
  if (!config) fail('Not configured. Run: node cli.mjs setup');
  console.log(`Project:     ${config.url}`);
  console.log(`Device:      ${config.device}`);
  console.log(`Secret key:  ${(await readSecret()) ? 'in Keychain' : '\x1b[31mmissing from Keychain\x1b[0m'}`);
  console.log(`Agent:       ${(await isLaunchdLoaded()) ? `loaded (${LABEL})` : '\x1b[31mnot loaded\x1b[0m'}`);

  try {
    const row = await fetchLatest(config.url, config.publishableKey);
    if (!row) console.log('Last data:   none yet');
    else {
      const captured = new Date(row.captured_at);
      const stale = Date.now() - captured.getTime() > 15 * 60_000;
      console.log(`Last data:   ${age(captured)}${stale ? ' \x1b[33m(stale)\x1b[0m' : ''}, ` +
        `${row.is_active ? 'active window' : 'no active window'}, $${row.cost_usd}, ${row.total_tokens} tokens`);
    }
  } catch (err) {
    console.log(`Last data:   \x1b[31mcould not read (${err.message})\x1b[0m`);
  }

  try {
    const lines = (await fs.readFile(LOG, 'utf8')).trim().split('\n');
    console.log(`Log tail:    ${lines.at(-1)}`);
  } catch {}
}

async function uninstall() {
  await removeLaunchd();
  ok(`Agent removed (${PLIST})`);
  if (flags.purge) {
    await deleteSecret();
    await fs.rm(CONFIG_FILE, { force: true });
    ok('Config and secret key deleted');
  } else {
    console.log('Config and secret key were kept. Use --purge to delete them too.');
  }
  console.log('Your Supabase data is untouched.');
}

const commands = { setup, qr: showQr, status, uninstall };
const command = commands[positionals[0]];
if (!command) {
  console.log('Usage: node cli.mjs <setup | qr | status | uninstall [--purge]>');
  process.exit(positionals[0] ? 1 : 0);
}
await command();

// Shared helpers for the CLI (cli.mjs) and the scheduled agent (send-usage.mjs).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_FILE = path.join(AGENT_DIR, '..', 'supabase', 'schema.sql');

export const LABEL = 'com.claudeusage.agent';
export const INTERVAL_SECONDS = 120;
// CLAUDE_USAGE_CONFIG_DIR is for tests.
export const CONFIG_DIR = process.env.CLAUDE_USAGE_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'claude-usage');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const LOG = path.join(os.homedir(), 'Library', 'Logs', 'claude-usage-agent.log');

// The secret key lives in the macOS Keychain, everything else in config.json.
// The service name can be overridden for tests.
const KEYCHAIN_SERVICE = process.env.CLAUDE_USAGE_KEYCHAIN_SERVICE ?? 'claude-usage';
const KEYCHAIN_ACCOUNT = 'secret-key';

// ---- Keychain ------------------------------------------------------------------------------

export async function saveSecret(secret) {
  // -U updates the item if it already exists. The value is briefly visible in the process list.
  await run('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', secret]);
}

export async function readSecret() {
  try {
    const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function deleteSecret() {
  await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]).catch(() => {});
}

// ---- Config --------------------------------------------------------------------------------

// config.json: { url, publishableKey, device }
export async function readConfigFile() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeConfigFile(config) {
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// Full config for the agent. SUPABASE_URL / SUPABASE_SECRET_KEY / DEVICE_NAME env vars win (handy for development).
export async function loadConfig() {
  const file = (await readConfigFile()) ?? {};
  const url = process.env.SUPABASE_URL ?? file.url;
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? (await readSecret());
  if (!url || !secretKey) {
    throw new Error('Not configured. Run: node agent/cli.mjs setup');
  }
  return {
    url: url.replace(/\/+$/, ''),
    secretKey,
    publishableKey: file.publishableKey ?? null,
    device: process.env.DEVICE_NAME ?? file.device ?? os.hostname(),
  };
}

// ---- Supabase REST -------------------------------------------------------------------------

export function restHeaders(key) {
  return {
    apikey: key,
    // Legacy JWT keys also need the Authorization header; new sb_* keys must not send it.
    ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }),
    'Content-Type': 'application/json',
  };
}

export async function fetchLatest(url, key) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/rest/v1/rpc/latest_usage`, {
    method: 'POST',
    headers: restHeaders(key),
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json())[0] ?? null;
}

// ---- Schema --------------------------------------------------------------------------------

// Applies supabase/schema.sql through a direct Postgres connection (DDL is not possible via REST).
// Returns { action: 'installed' | 'upgraded' | 'up-to-date', version, from }.
export async function applySchema(dbUrl) {
  const { default: pg } = await import('pg');
  const sql = await fs.readFile(SCHEMA_FILE, 'utf8');
  const target = Number(/^-- schema-version: (\d+)/m.exec(sql)?.[1]);
  if (!target) throw new Error(`${SCHEMA_FILE} has no "-- schema-version: N" header`);

  const client = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    let current = 0;
    const exists = await client.query(`select to_regclass('public.usage_schema_version') as t`);
    if (exists.rows[0].t) {
      current = (await client.query('select max(version) as v from public.usage_schema_version')).rows[0].v ?? 0;
    }
    if (current >= target) return { action: 'up-to-date', version: current, from: current };

    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    return { action: current === 0 ? 'installed' : 'upgraded', version: target, from: current };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ---- launchd -------------------------------------------------------------------------------

export function renderPlist() {
  const script = path.join(AGENT_DIR, 'send-usage.mjs');
  const nodeDir = path.dirname(process.execPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${script}</string>
  </array>
  <key>WorkingDirectory</key><string>${AGENT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>${INTERVAL_SECONDS}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
}

const domain = () => `gui/${process.getuid()}`;

export async function installLaunchd() {
  await fs.mkdir(path.dirname(PLIST), { recursive: true });
  await fs.mkdir(path.dirname(LOG), { recursive: true });
  await fs.writeFile(PLIST, renderPlist());
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  await run('launchctl', ['bootstrap', domain(), PLIST]);
}

export async function removeLaunchd() {
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  await fs.rm(PLIST, { force: true });
}

export async function isLaunchdLoaded() {
  try {
    await run('launchctl', ['print', `${domain()}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

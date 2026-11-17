// Agent: reads the active 5h block from ccusage and sends a snapshot to Supabase.
// Usage: node --env-file=.env send-usage.mjs [--dry-run]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const run = promisify(execFile);
const dryRun = process.argv.includes('--dry-run');

const { SUPABASE_URL, SUPABASE_SECRET_KEY, DEVICE_NAME } = process.env;
if (!dryRun && (!SUPABASE_URL || !SUPABASE_SECRET_KEY)) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env');
  process.exit(1);
}

async function readActiveBlock() {
  const { stdout } = await run('npx', ['-y', 'ccusage@latest', 'blocks', '--active', '--json'], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  const data = JSON.parse(stdout);
  return (data.blocks ?? []).find((b) => b.isActive) ?? null;
}

function toPayload(block) {
  const device = DEVICE_NAME || os.hostname();
  if (!block) {
    return { device, total_tokens: 0, cost_usd: 0, is_active: false, raw: null };
  }
  return {
    device,
    block_start: block.startTime,
    block_end: block.endTime,
    total_tokens: block.totalTokens ?? 0,
    cost_usd: block.costUSD ?? 0,
    is_active: true,
    raw: block,
  };
}

async function send(payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usage_snapshots`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      ...(SUPABASE_SECRET_KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${SUPABASE_SECRET_KEY}` }),
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

try {
  const payload = toPayload(await readActiveBlock());
  if (dryRun) {
    const { raw, ...rest } = payload;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    await send(payload);
    console.log(`${new Date().toISOString()} ok cost=${payload.cost_usd} tokens=${payload.total_tokens}`);
  }
} catch (err) {
  // A failure (e.g. no network) does not stop the schedule: launchd will run the script again.
  console.error(`${new Date().toISOString()} error: ${err.message}`);
  process.exit(1);
}

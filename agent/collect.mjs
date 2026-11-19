// Reads the active ccusage block and sends it to Supabase.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { restHeaders } from './lib.mjs';

const run = promisify(execFile);

export async function readActiveBlock() {
  const { stdout } = await run('npx', ['-y', 'ccusage@latest', 'blocks', '--active', '--json'], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  const data = JSON.parse(stdout);
  return (data.blocks ?? []).find((b) => b.isActive) ?? null;
}

export function toPayload(block, device) {
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

export async function sendSnapshot(config, payload) {
  const res = await fetch(`${config.url}/rest/v1/usage_snapshots`, {
    method: 'POST',
    headers: { ...restHeaders(config.secretKey), Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

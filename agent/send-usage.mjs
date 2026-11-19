// Agent run by launchd every 120 s: reads the active 5h block from ccusage and sends a snapshot to Supabase.
// Configuration comes from `claude-usage setup` (~/.config/claude-usage + Keychain).
// Usage: node send-usage.mjs [--dry-run]
import os from 'node:os';
import { loadConfig } from './lib.mjs';
import { readActiveBlock, toPayload, sendSnapshot } from './collect.mjs';

const dryRun = process.argv.includes('--dry-run');

try {
  if (dryRun) {
    const { raw, ...rest } = toPayload(await readActiveBlock(), process.env.DEVICE_NAME || os.hostname());
    console.log(JSON.stringify(rest, null, 2));
  } else {
    const config = await loadConfig();
    const payload = toPayload(await readActiveBlock(), config.device);
    await sendSnapshot(config, payload);
    console.log(`${new Date().toISOString()} ok cost=${payload.cost_usd} tokens=${payload.total_tokens}`);
  }
} catch (err) {
  // A failure (e.g. no network) does not stop the schedule: launchd will run the script again.
  console.error(`${new Date().toISOString()} error: ${err.message}`);
  process.exit(1);
}

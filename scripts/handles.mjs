// Who has been using the site, from the scan log.
//   npm run handles                 all handles, most recent first
//   npm run handles -- --days 7     only the last 7 days
//   npm run handles -- --csv        machine-readable
// Needs the Blob token: run `vercel env pull` once (writes .env.local), or set BLOB_READ_WRITE_TOKEN.
import { list } from '@vercel/blob';
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const val = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };

function token() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  if (existsSync('.env.local')) {
    const m = readFileSync('.env.local', 'utf8').match(/^BLOB_READ_WRITE_TOKEN=("?)(.+?)\1\s*$/m);
    if (m) return m[2];
  }
  return null;
}

const tok = token();
if (!tok) {
  console.error('No Blob token found. Run `vercel env pull` in this folder, or set BLOB_READ_WRITE_TOKEN.');
  process.exitCode = 1;
} else {
  const days = Number(val('days', 0));
  const since = days ? Date.now() - days * 86400e3 : 0;

  const byHandle = new Map();
  let total = 0, cursor;
  do {
    const page = await list({ prefix: 'scans/', cursor, limit: 1000, token: tok });
    for (const b of page.blobs) {
      const at = b.uploadedAt.getTime();
      if (at < since) continue;
      const handle = b.pathname.split('/')[1]; // scans/<handle>/<time>-<suffix>
      if (!handle) continue;
      const e = byHandle.get(handle) || { handle, scans: 0, first: at, last: at };
      e.scans++; e.first = Math.min(e.first, at); e.last = Math.max(e.last, at);
      byHandle.set(handle, e);
      total++;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  const rows = [...byHandle.values()].sort((a, b) => b.last - a.last);
  const fmt = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  if (flag('csv')) {
    console.log('handle,scans,first_seen,last_seen');
    rows.forEach((r) => console.log(`${r.handle},${r.scans},${new Date(r.first).toISOString()},${new Date(r.last).toISOString()}`));
  } else {
    const dayAgo = Date.now() - 86400e3;
    console.log(`${total} scans · ${rows.length} unique handles${days ? ` · last ${days} days` : ''} · ${rows.filter((r) => r.last > dayAgo).length} active in the last 24h\n`);
    if (!rows.length) console.log('Nothing logged yet.');
    for (const r of rows) console.log(`@${r.handle.padEnd(16)} ${String(r.scans).padStart(3)} scan${r.scans === 1 ? ' ' : 's'}   last ${fmt(r.last)}${r.scans > 1 ? `   first ${fmt(r.first)}` : ''}`);
  }
}

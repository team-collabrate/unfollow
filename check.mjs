// Live check of the data layer, no browser needed:
//   node check.mjs <handle|x.com url> [--cap N] [--gap MS] [--show N]
import { createRequire } from 'node:module';
const Core = createRequire(import.meta.url)('./core.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i === -1 ? def : Number(args[i + 1]); };
const handle = Core.parseHandle(args.find((a) => !a.startsWith('--') && isNaN(Number(a))) || '');
const counters = () => `requests=${Core.stats.requests} retries=${Core.stats.retries} status counts=${JSON.stringify(Core.stats.byStatus)}`;

async function main() {
  const cap = opt('cap', Core.DEFAULTS.followerCap);
  const show = opt('show', 25);
  const t0 = Date.now();
  const last = {};
  try {
    const r = await Core.scan(handle, {
      followerCap: cap, followingCap: cap, gapMs: opt('gap', Core.DEFAULTS.gapMs),
      onProgress: (p) => {
        const step = Math.floor(p.count / 500);
        if (last[p.kind] !== step) { last[p.kind] = step; console.error(`  ${p.kind.padEnd(9)} ${p.count}/${p.expected}  (${p.pages} pages, ${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
      },
    });
    const secs = (Date.now() - t0) / 1000;
    const d = Core.diff(r.following, r.followers);
    const uniq = (a) => new Set(a.map((u) => u.id)).size;

    console.log(`\n@${r.user.handle}  ·  scan took ${secs.toFixed(1)}s`);
    console.log(`followers: got ${r.followers.length} of ${r.advertised.followers} advertised (${(r.completeness.followers * 100).toFixed(1)}%), ${r.pages.followers} pages, unique ids ${uniq(r.followers)}`);
    console.log(`following: got ${r.following.length} of ${r.advertised.following} advertised (${(r.completeness.following * 100).toFixed(1)}%), ${r.pages.following} pages, unique ids ${uniq(r.following)}`);
    console.log(`approximate=${r.approximate} · ${counters()}`);
    console.log(`\nnot following back: ${d.notFollowingBack.length}   fans (follow you, you don't): ${d.fans.length}   mutuals: ${d.mutuals.length}`);
    d.notFollowingBack.slice(0, show).forEach((u) => console.log(`  @${u.handle.padEnd(16)} ${String(u.followers ?? '?').padStart(10)} followers${u.verified ? '  ✓' : ''}`));
    if (d.notFollowingBack.length > show) console.log(`  ... and ${d.notFollowingBack.length - show} more`);
  } catch (e) {
    console.error(e instanceof Core.UserError ? `UserError: ${e.message}` : e);
    console.error(counters());
    process.exitCode = 2; // not process.exit(): on Windows that can crash Node while fetch sockets are closing
  }
}

if (handle) await main();
else { console.error('usage: node check.mjs <handle|x.com url> [--cap N] [--gap MS] [--show N]'); process.exitCode = 1; }

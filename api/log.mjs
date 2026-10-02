// Notes that a handle was scanned, so the site owner can see how it's used. Disclosed on the page.
// Records ONLY the handle and the time (the blob's upload time). No IP, no user agent, no cookies.
// Each scan is one tiny private blob whose path carries the handle, so reading the log needs only a listing.
import { put } from '@vercel/blob';

const HANDLE = /^[A-Za-z0-9_]{1,15}$/; // X's own handle rules

// Best-effort brake on one visitor flooding the log. Lives in this instance's memory only, nothing is stored.
const hits = new Map();
const LIMIT = 20, WINDOW_MS = 60_000;
function limited(key) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear(); // never let the map grow without bound
  return recent.length > LIMIT;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();

  // Same-site only: a browser always sends Origin on a POST. This is a speed bump for casual abuse, not a lock.
  let originHost = '';
  try { originHost = new URL(req.headers.origin).host; } catch (e) { /* missing or malformed */ }
  if (!originHost || originHost !== req.headers.host) return res.status(403).end();

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return res.status(429).end();

  const handle = typeof req.body?.handle === 'string' ? req.body.handle : '';
  if (!HANDLE.test(handle)) return res.status(400).end();

  try {
    await put(`scans/${handle.toLowerCase()}/${Date.now()}`, '1', {
      access: 'private',
      addRandomSuffix: true, // two scans in the same millisecond must not collide
      contentType: 'text/plain',
    });
    return res.status(204).end();
  } catch (e) {
    console.error('scan log failed:', e?.message);
    return res.status(500).end();
  }
}

/* Unfollow Check: data fetching and set arithmetic.
   Reads follower/following lists from FxTwitter (a free, unofficial X mirror that sends CORS headers), so
   everything runs in the visitor's browser with no backend. Also runs unchanged in Node 18+ (see check.mjs). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // One place to point at a different data source (e.g. your own caching proxy) if FxTwitter ever blocks you.
  const API_BASE = 'https://api.fxtwitter.com';

  const DEFAULTS = {
    followerCap: 5000,   // refuse bigger accounts up front: ~50 followers per request, ~2 s each
    followingCap: 5000,
    gapMs: 300,          // minimum pause between page requests on one list
    minComplete: 0.95,   // below this fraction of the advertised count, retry once from the last cursor
    approxBelow: 0.98,   // below this, the results are labelled approximate
    maxPages: 400,       // hard stop for a runaway cursor
  };

  class UserError extends Error {}
  class CancelError extends Error { constructor() { super('cancelled'); } }
  // A scan that died partway. `resume` holds the pages already collected; pass it back as opts.resume.
  class ScanError extends UserError { constructor(msg, resume) { super(msg); this.resume = resume; } }
  class HttpError extends Error {
    constructor(status, retryAfter) { super('HTTP ' + status); this.status = status; this.retryAfter = retryAfter; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lower = (s) => (s || '').toLowerCase();

  // Request counters, so a script can see how hard the source pushed back (check.mjs prints them).
  const stats = { requests: 0, byStatus: {}, retries: 0 };

  /* ---------- input ---------- */

  function parseHandle(raw) {
    let s = (raw || '').trim();
    const m = s.match(/(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i);
    if (m) s = m[1];
    s = s.replace(/^@/, '');
    return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
  }

  /* ---------- network ---------- */

  // FxTwitter sometimes answers 404 or an empty page for things that exist, so retry with backoff.
  // Only a 404 on every attempt is reported as "not found". A 429 waits for Retry-After when given.
  async function getJSON(url, { tries = 4, needResults = false } = {}) {
    let lastErr, only404 = true;
    for (let i = 0; i < tries; i++) {
      if (i) {
        stats.retries++;
        const wait = lastErr instanceof HttpError && lastErr.status === 429 && lastErr.retryAfter
          ? Math.min(lastErr.retryAfter * 1000, 15000) : 700 * i;
        await sleep(wait);
      }
      try {
        stats.requests++;
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        stats.byStatus[res.status] = (stats.byStatus[res.status] || 0) + 1;
        if (!res.ok) throw new HttpError(res.status, Number(res.headers.get('retry-after')) || 0);
        const data = await res.json();
        if (needResults && !(data.results && data.results.length)) throw new Error('empty page');
        only404 = false;
        return data;
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) only404 = false;
        lastErr = e;
      }
    }
    if (only404) return { notFound: true };
    throw lastErr;
  }

  async function fetchProfile(handle) {
    let data;
    try { data = await getJSON(`${API_BASE}/2/profile/${handle}`, { tries: 3 }); }
    catch (e) { throw new UserError('X data is buggin’ right now. Try again in a minute.'); }
    if (data.notFound || !data.user) throw new UserError(`Can't find @${handle} on X. Check the spelling?`);
    if (data.user.protected) throw new UserError(`@${data.user.screen_name} is private, so the lists are locked. Can't peek.`);
    return data.user;
  }

  // Keep only what the page shows, so a 5,000-row list stays small in memory and in storage.
  const slim = (u) => ({
    id: u.id,
    handle: u.screen_name,
    name: u.name || u.screen_name,
    avatar: u.avatar_url || null,
    followers: Number.isFinite(u.followers) ? u.followers : null,
    verified: !!u.verification?.verified,
  });

  /* ---------- paging one list ---------- */

  // Follows the cursor until the list ends. `state` is returned so a later call can resume where this one
  // stopped: { rows: Map(id -> user), cursor, pages, ended, error }.
  async function fetchList(handle, kind, { state, expected = 0, onProgress = () => {}, isCancelled = () => false, gapMs = DEFAULTS.gapMs, maxPages = DEFAULTS.maxPages } = {}) {
    const st = state || { rows: new Map(), cursor: null, pages: 0, ended: false, error: null, cancelled: false };
    if (st.ended && !st.error) return st; // a finished list on resume: nothing to do
    st.error = null;
    st.cancelled = false;
    const seenCursors = new Set();

    while (st.pages < maxPages) {
      if (isCancelled()) { st.cancelled = true; break; }
      const url = `${API_BASE}/2/profile/${handle}/${kind}` + (st.cursor ? `?cursor=${encodeURIComponent(st.cursor)}` : '');
      let data;
      try {
        // Empty pages are retried because the API sometimes returns a false one. Once we already hold the
        // advertised number of people, one empty page is enough to call it the end, which saves seconds.
        // Short bursts of false 404s happen, so a page we still need gets a longer retry window (~4 s).
        data = await getJSON(url, { tries: expected && st.rows.size >= expected ? 1 : 4, needResults: true });
      } catch (e) {
        // Empty pages in a row are how this API says "no more". Anything else is a real failure.
        if (e.message === 'empty page') st.ended = true; else st.error = e;
        break;
      }
      // getJSON reports "404 on every attempt" as { notFound } instead of throwing. For a list that's the API
      // misfiring (the profile already exists), so treat it as a failure the scan can resume from.
      // (If we already hold everyone advertised, a 404 on the "is there more?" check just means the end.)
      if (data.notFound) {
        if (expected && st.rows.size >= expected) st.ended = true; else st.error = new Error('list returned 404');
        break;
      }
      st.pages++;
      for (const u of data.results) if (u.id && !st.rows.has(u.id)) st.rows.set(u.id, slim(u));
      onProgress({ kind, count: st.rows.size, pages: st.pages });

      const next = data.cursor?.bottom;
      if (!next || seenCursors.has(next) || next === st.cursor) { st.ended = true; break; }
      seenCursors.add(next);
      st.cursor = next;
      await sleep(gapMs);
    }
    return st;
  }

  /* ---------- the whole scan ---------- */

  function completeness(got, expected) {
    return expected > 0 ? Math.min(1, got / expected) : 1;
  }

  // Fetches both lists in parallel, retries a short list once from where it stopped, and returns both.
  async function scan(handle, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const user = await fetchProfile(handle);

    if (user.followers > o.followerCap) {
      throw new UserError(`@${user.screen_name} has ${user.followers.toLocaleString('en-US')} followers. That's too big for us, we max out at ${o.followerCap.toLocaleString('en-US')} (every ~50 followers is a request).`);
    }
    if (user.following > o.followingCap) {
      throw new UserError(`@${user.screen_name} follows ${user.following.toLocaleString('en-US')} accounts. That's too many for us, we max out at ${o.followingCap.toLocaleString('en-US')}.`);
    }

    o.onProfile?.({ ...slim(user), following: user.following });

    const run = async (kind, expected) => {
      const base = { expected, gapMs: o.gapMs, maxPages: o.maxPages, isCancelled: o.isCancelled, state: o.resume?.[kind], onProgress: (p) => o.onProgress?.({ ...p, expected }) };
      let st = await fetchList(user.screen_name, kind, base);
      if (!st.error && !st.cancelled && completeness(st.rows.size, expected) < o.minComplete) {
        st.ended = false; // short list: ask again from the last cursor once before giving up
        st = await fetchList(user.screen_name, kind, { ...base, state: st });
      }
      return st;
    };

    const [fers, fing] = await Promise.all([run('followers', user.followers), run('following', user.following)]);
    if (fers.cancelled || fing.cancelled) throw new CancelError();
    if (fers.error || fing.error) {
      // Hand back what was collected so "try again" resumes instead of starting over.
      throw new ScanError('X data ghosted us mid-scan. Your progress is saved, so trying again picks up right where we left off.', { followers: fers, following: fing });
    }

    const followers = [...fers.rows.values()];
    const following = [...fing.rows.values()];
    const cf = completeness(followers.length, user.followers), cg = completeness(following.length, user.following);
    return {
      user: slim(user),
      followers,
      following,
      advertised: { followers: user.followers, following: user.following },
      completeness: { followers: cf, following: cg },
      // A person or two is always missing (suspended accounts still count in the advertised totals).
      approximate: cf < o.approxBelow || cg < o.approxBelow,
      takenAt: Date.now(),
      pages: { followers: fers.pages, following: fing.pages },
    };
  }

  /* ---------- set arithmetic (all keyed on the stable user id) ---------- */

  function diff(following, followers) {
    const followerIds = new Set(followers.map((u) => u.id));
    const followingIds = new Set(following.map((u) => u.id));
    return {
      notFollowingBack: following.filter((u) => !followerIds.has(u.id)),
      fans: followers.filter((u) => !followingIds.has(u.id)),
      mutuals: following.filter((u) => followerIds.has(u.id)),
    };
  }

  // Followers you had last time that are gone now; `stillFollowing` flags the ones you follow back.
  function unfollowers(prevFollowers, nowFollowers, nowFollowing) {
    const nowIds = new Set(nowFollowers.map((u) => u.id));
    const followingIds = new Set(nowFollowing.map((u) => u.id));
    return prevFollowers.filter((u) => !nowIds.has(u.id)).map((u) => ({ ...u, stillFollowing: followingIds.has(u.id) }));
  }

  // Someone who "unfollowed you" may just have deleted or been suspended: they vanish from the list the
  // same way. Look the few candidates up and mark the ones whose profile no longer exists.
  async function markGone(users, { concurrency = 3 } = {}) {
    const queue = [...users];
    const worker = async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        try { u.gone = !!(await getJSON(`${API_BASE}/2/profile/${u.handle}`, { tries: 3 })).notFound; } catch (e) { /* unknown: leave unmarked */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return users;
  }

  return { API_BASE, DEFAULTS, UserError, ScanError, CancelError, stats, parseHandle, getJSON, fetchProfile, fetchList, scan, diff, unfollowers, markGone, completeness };
});

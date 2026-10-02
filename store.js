/* Saved scans, kept in this browser's IndexedDB. Each scan is a snapshot of who follows you and who you
   follow, so the next scan can tell who left. Nothing here leaves the browser, and the page still works
   (without history) if storage is blocked, e.g. in a private window. */
(function () {
  'use strict';

  const DB_NAME = 'unfollow-check', STORE = 'snapshots';
  const KEEP = 5;            // newest scans kept per handle
  const MAX_ROWS = 20000;    // sanity cap per list when importing

  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const s = req.result.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('handle', 'handle');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      });
    }
    return dbp;
  }

  const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const finished = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

  // Every call degrades to "no history" instead of throwing, so the scan itself never depends on storage.
  async function safe(fn, fallback) {
    try { return await fn(await open()); } catch (e) { api.ok = false; return fallback; }
  }

  const keyOf = (s) => `${s.handle}|${s.takenAt}`;

  /* ---------- reading and writing ---------- */

  // Newest first.
  const history = (handle) => safe(async (db) => {
    const rows = await wrap(db.transaction(STORE).objectStore(STORE).index('handle').getAll(handle.toLowerCase()));
    return rows.sort((a, b) => b.takenAt - a.takenAt);
  }, []);

  const save = (snap) => safe(async (db) => {
    const s = { ...snap, handle: snap.handle.toLowerCase(), key: keyOf({ handle: snap.handle.toLowerCase(), takenAt: snap.takenAt }) };
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    os.put(s);
    // Keep only the newest few for this handle.
    const all = (await wrap(os.index('handle').getAll(s.handle))).sort((a, b) => b.takenAt - a.takenAt);
    for (const old of all.slice(KEEP)) os.delete(old.key);
    await finished(tx);
    return true;
  }, false);

  const all = () => safe(async (db) => wrap(db.transaction(STORE).objectStore(STORE).getAll()), []);

  const clear = () => safe(async (db) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await finished(tx);
    return true;
  }, false);

  /* ---------- backup files (untrusted input: rebuild every field, trust nothing) ---------- */

  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const avatarOk = (v) => (typeof v === 'string' && /^https:\/\/pbs\.twimg\.com\//.test(v) ? v.slice(0, 300) : null);

  function cleanUser(u) {
    if (!u || typeof u !== 'object') return null;
    const id = str(String(u.id ?? ''), 30), handle = str(u.handle, 15);
    if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
    return {
      id, handle,
      name: str(u.name, 100) || handle,
      avatar: avatarOk(u.avatar),
      followers: Number.isFinite(u.followers) ? u.followers : null,
      verified: u.verified === true,
    };
  }

  function sanitize(x) {
    if (!x || typeof x !== 'object') return null;
    const handle = str(x.handle, 15).toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle) || !Number.isFinite(x.takenAt)) return null;
    if (!Array.isArray(x.followers) || !Array.isArray(x.following)) return null;
    if (x.followers.length > MAX_ROWS || x.following.length > MAX_ROWS) return null;
    const user = cleanUser(x.user);
    if (!user) return null;
    const num = (v) => (Number.isFinite(v) ? v : 1);
    return {
      handle,
      takenAt: x.takenAt,
      user,
      followers: x.followers.map(cleanUser).filter(Boolean),
      following: x.following.map(cleanUser).filter(Boolean),
      advertised: { followers: num(x.advertised?.followers), following: num(x.advertised?.following) },
      completeness: { followers: num(x.completeness?.followers), following: num(x.completeness?.following) },
      approximate: x.approximate === true,
    };
  }

  async function exportJSON() {
    return JSON.stringify({ app: 'unfollow-check', version: 1, snapshots: await all() });
  }

  // Returns how many scans were imported. Bad entries are skipped, not fatal.
  async function importJSON(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('That file isn’t valid JSON.'); }
    if (!data || data.app !== 'unfollow-check' || !Array.isArray(data.snapshots)) throw new Error('That doesn’t look like an Unfollow Check backup.');
    let n = 0;
    for (const raw of data.snapshots.slice(0, 200)) {
      const s = sanitize(raw);
      if (s && (await save(s))) n++;
    }
    return n;
  }

  const api = { ok: true, history, save, all, clear, exportJSON, importJSON, sanitize };
  window.Store = api;
})();

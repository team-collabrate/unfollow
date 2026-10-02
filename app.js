/* Unfollow Check: wires the form to the data layer (core.js) and saved scans (store.js). */
(function () {
  'use strict';

  const { Core, Store } = window;
  const CACHE_MS = 3600e3;     // a scan under an hour old is reused instead of re-fetched
  const PAGE = 100;            // rows drawn per "show more"
  const BIG = 100000;          // "hide accounts over" threshold
  const SEC_PER_PAGE = 2.4;    // measured: ~2.3 s per page with both lists running in parallel
  const PER_PAGE = 50;         // measured: ~50 people per page

  const $ = (s) => document.querySelector(s);
  const form = $('#form'), input = $('#handle'), go = $('#go'), statusEl = $('#status');
  const progress = $('#progress'), result = $('#result');
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const when = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const view = { snap: null, prev: null, lists: {}, tab: 'notBack', shown: PAGE, handle: null };
  let resume = null;      // pages collected by a scan that died, so "Try again" continues
  let cancelled = false;
  let runId = 0;          // lets a stale background job notice it has been replaced

  /* ---------- small helpers ---------- */

  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  };
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };

  function setStatus(msg, { error = false, action = null } = {}) {
    statusEl.className = 'status' + (error ? ' error' : '');
    statusEl.textContent = msg;
    if (action) statusEl.append(el('button', { className: 'link inline', type: 'button', textContent: action.label, onclick: action.fn }));
  }

  function setBusy(b) {
    go.disabled = b;
    input.disabled = b;
    go.textContent = b ? 'Cooking…' : 'Expose them';
  }

  /* ---------- progress ---------- */

  function showProgress(user) {
    const pages = Math.max(Math.ceil(user.followers / PER_PAGE), Math.ceil(user.following / PER_PAGE));
    const secs = Math.round(pages * SEC_PER_PAGE);
    $('#eta').textContent = secs < 10 ? 'Quick one, just a few seconds.'
      : secs < 90 ? `About ${Math.round(secs / 5) * 5} seconds. Hang tight.` : `About ${Math.round(secs / 60)} minutes. Go touch grass, we got you.`;
    progress.hidden = false;
    progress.scrollIntoView({ behavior: 'smooth', block: 'center' }); // don't leave it below the fold
  }

  function onProgress(p) {
    const pct = p.expected ? Math.min(100, (p.count / p.expected) * 100) : 100;
    const kind = p.kind === 'followers' ? 'Followers' : 'Following';
    $('#bar' + kind).style.width = Math.max(3, pct) + '%';
    $('#num' + kind).textContent = `${p.count.toLocaleString('en-US')} / ${p.expected.toLocaleString('en-US')}`;
  }

  /* ---------- results ---------- */

  function buildLists(snap, prev) {
    const d = Core.diff(snap.following, snap.followers);
    const lists = { notBack: d.notFollowingBack, fans: d.fans, mutuals: d.mutuals, unfollowed: null };
    if (prev) lists.unfollowed = Core.unfollowers(prev.followers, snap.followers, snap.following);
    return lists;
  }

  // Static, trusted icon paths (Lucide-style, 24px grid). Never built from user data.
  const ICONS = {
    notBack: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5M22 8l-5 5"/>',
    unfollowed: '<path d="M9 10h.01M15 10h.01"/><path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>',
    fans: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
    mutuals: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  };
  const svg = (paths, cls) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    s.innerHTML = paths;
    return s;
  };

  const TABS = [
    { id: 'notBack', label: 'Ain’t following back', hint: 'you follow them, they don’t' },
    { id: 'unfollowed', label: 'Ghosted you', hint: '' },
    { id: 'fans', label: 'Stans', hint: 'follow you, you don’t follow back' },
    { id: 'mutuals', label: 'Mutuals', hint: 'locked in both ways' },
  ];

  // `animate` plays the entrance only when results first appear or the tab changes, so typing in the
  // search box doesn't replay it on every keystroke.
  function renderTiles(animate = false) {
    const box = $('#tiles');
    box.textContent = '';
    TABS.forEach((t, i) => {
      const list = view.lists[t.id];
      const off = list === null;
      const hint = t.id === 'unfollowed'
        ? (off ? 'run it again later to catch these' : `since ${when.format(view.prev.takenAt)}`)
        : t.hint;
      const b = el('button', { className: 'tile' + (animate ? ' enter' : ''), type: 'button', disabled: off },
        svg(ICONS[t.id], 'ico'), el('b', { textContent: off ? '–' : list.length.toLocaleString('en-US') }), t.label, el('small', { textContent: hint }));
      b.style.setProperty('--i', i);
      b.setAttribute('aria-pressed', String(view.tab === t.id));
      b.onclick = () => { view.tab = t.id; view.shown = PAGE; renderTiles(); renderList(true); };
      box.append(b);
    });
  }

  function filtered() {
    const hideBig = $('#hideBig').checked, hideVerified = $('#hideVerified').checked;
    const still = view.tab === 'unfollowed' && $('#stillOnly').checked;
    const q = $('#q').value.trim().toLowerCase().replace(/^@/, '');
    const rows = (view.lists[view.tab] || []).filter((u) =>
      !(hideBig && (u.followers ?? 0) > BIG) && !(hideVerified && u.verified) && !(still && !u.stillFollowing) &&
      (!q || `${u.handle} ${u.name}`.toLowerCase().includes(q)));
    const sort = $('#sort').value;
    if (sort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
    else {
      const f = (u) => u.followers ?? -1;
      rows.sort((a, b) => (sort === 'followers-asc' ? f(a) - f(b) : f(b) - f(a)));
    }
    return rows;
  }

  function row(u, i, animate) {
    const img = el('img', { alt: '', loading: 'lazy', width: 48, height: 48, referrerPolicy: 'no-referrer' });
    if (u.avatar) {
      // The lists carry X's tiny "_normal" avatar; ask for the sharper one and fall back if it's missing.
      const sharp = u.avatar.replace(/_normal(\.\w+)$/, '_bigger$1');
      img.onerror = () => { img.onerror = null; if (img.src !== u.avatar) img.src = u.avatar; };
      img.src = sharp;
    }
    const name = el('span', { className: 'name', textContent: u.name });
    // The leading space keeps the name and its tag from running together for screen readers.
    if (u.verified) name.append(' ', el('span', { className: 'tag v', textContent: 'verified' }));
    if (view.tab === 'unfollowed') {
      if (u.gone) name.append(' ', el('span', { className: 'tag gone', textContent: 'gone (deleted or suspended)' }));
      else if (u.stillFollowing) name.append(' ', el('span', { className: 'tag still', textContent: 'you still follow' }));
    }
    const link = el('a', { className: 'open', href: `https://x.com/${encodeURIComponent(u.handle)}`, target: '_blank', rel: 'noopener' }, 'Open', svg('<path d="M7 17 17 7"/><path d="M7 7h10v10"/>'));
    link.setAttribute('aria-label', `Open @${u.handle} on X`);
    const li = el('li', { className: 'row' + (animate && i < 14 ? ' enter' : '') }, img,
      el('div', {}, name, el('span', { className: 'sub', textContent: '@' + u.handle })),
      el('div', { className: 'side' }, el('span', { textContent: u.followers == null ? '' : compact.format(u.followers) + ' followers' }), link));
    li.style.setProperty('--i', i);
    return li;
  }

  function renderList(animate = false) {
    $('#stillWrap').hidden = view.tab !== 'unfollowed';
    const rows = filtered();
    const total = (view.lists[view.tab] || []).length;
    const list = $('#list');
    list.textContent = '';
    list.append(...rows.slice(0, view.shown).map((u, i) => row(u, i, animate)));
    $('#more').hidden = rows.length <= view.shown;
    $('#count').textContent = rows.length === total ? `${total.toLocaleString('en-US')} accounts`
      : `${rows.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} match your filters`;
    if (!rows.length) list.append(el('li', { className: 'count', textContent: view.tab === 'unfollowed' && !total ? 'Nobody ghosted you since the last scan. W.' : 'Nothing here. The void is empty.' }));
  }

  function warnings(snap, prev) {
    const msgs = [];
    if (snap.approximate) {
      const pct = (n) => Math.round(n * 100) + '%';
      msgs.push(`X only gave us ${pct(snap.completeness.followers)} of your followers and ${pct(snap.completeness.following)} of who you follow, so a few results might be sus. Run it again to fill the gap.`);
    }
    if (prev?.approximate) msgs.push('The earlier scan was missing some people, so “Ghosted you” might list a few who didn’t actually leave.');
    return msgs;
  }

  function show(snap, prev, { cached = false } = {}) {
    view.snap = snap; view.prev = prev; view.lists = buildLists(snap, prev); view.shown = PAGE;
    if (view.tab === 'unfollowed' && !view.lists.unfollowed) view.tab = 'notBack';
    $('#who').textContent = `@${snap.user.handle}`;
    $('#meta').textContent = `${snap.followers.length.toLocaleString('en-US')} followers · ${snap.following.length.toLocaleString('en-US')} following · scanned ${ago(snap.takenAt)}${cached ? ' (saved)' : ''}`;
    const w = warnings(snap, prev);
    $('#warn').hidden = !w.length;
    $('#warn').textContent = w.join(' ');
    progress.hidden = true;
    result.hidden = false;
    document.body.classList.add('has-result'); // collapses the hero so the results get the room
    renderTiles(true);
    renderList(true);
    checkGone(view.lists.unfollowed);
    input.value = snap.user.handle;
    history.replaceState(null, '', '?u=' + encodeURIComponent(snap.user.handle));
  }

  // Background: people who "unfollowed" might just be deleted or suspended. Mark them once known.
  async function checkGone(list) {
    if (!list || !list.length) return;
    const id = ++runId;
    await Core.markGone(list.slice(0, 40));
    if (id === runId && view.lists.unfollowed === list) { renderTiles(); renderList(); }
  }

  /* ---------- main flow ---------- */

  // Compare against a scan at least an hour older when there is one, so a quick rescan still shows who
  // left since yesterday. Otherwise use the nearest earlier scan.
  function pickPrev(hist, takenAt) {
    const older = hist.filter((s) => s.takenAt < takenAt);
    return older.find((s) => takenAt - s.takenAt >= CACHE_MS) || older[0] || null;
  }

  async function run(handle, { force = false } = {}) {
    cancelled = false;
    view.handle = handle;
    setBusy(true);
    result.hidden = true;
    document.body.classList.remove('has-result');
    ['Followers', 'Following'].forEach((k) => { $('#bar' + k).style.width = '3%'; $('#num' + k).textContent = '0'; });
    setStatus(`Pulling up @${handle}…`);
    try {
      const hist = await Store.history(handle);
      const latest = hist[0] || null;
      if (!force && !resume && latest && Date.now() - latest.takenAt < CACHE_MS) {
        setStatus('');
        return show(latest, pickPrev(hist, latest.takenAt), { cached: true });
      }

      const r = await Core.scan(handle, {
        resume,
        isCancelled: () => cancelled,
        onProfile: (u) => { setStatus(`Reading @${u.handle}’s lists…`); showProgress(u); },
        onProgress,
      });
      resume = null;
      const snap = { ...r, handle: r.user.handle.toLowerCase() };
      await Store.save(snap);
      setStatus('');
      show(snap, pickPrev(hist, snap.takenAt));
    } catch (e) {
      progress.hidden = true;
      if (e instanceof Core.CancelError) {
        setStatus('Cancelled.');
      } else if (e instanceof Core.ScanError) {
        resume = e.resume;
        setStatus(e.message, { error: true, action: { label: 'Try again', fn: () => run(handle) } });
      } else if (e instanceof Core.UserError) {
        resume = null;
        setStatus(e.message, { error: true });
      } else {
        console.error(e);
        resume = null;
        setStatus('Something broke on our end. Try again in a minute.', { error: true });
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------- events ---------- */

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const handle = Core.parseHandle(input.value);
    if (!handle) return setStatus('That ain’t a real X handle. Try something like @jack.', { error: true });
    if (view.handle && view.handle.toLowerCase() !== handle.toLowerCase()) resume = null; // a different account
    run(handle);
  });

  $('#cancel').addEventListener('click', () => { cancelled = true; setStatus('Cancelling…'); });
  $('#rescan').addEventListener('click', () => { resume = null; run(view.snap.user.handle, { force: true }); });
  $('#more').addEventListener('click', () => { view.shown += PAGE; renderList(); });

  let t;
  for (const id of ['#q', '#sort', '#hideBig', '#hideVerified', '#stillOnly']) {
    $(id).addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { view.shown = PAGE; renderList(); }, 120); });
  }

  /* ---------- saved data ---------- */

  const dataMsg = (m) => { $('#dataMsg').textContent = m; };

  $('#exportBtn').addEventListener('click', async () => {
    const text = await Store.exportJSON();
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: 'unfollow-check-backup.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    dataMsg('Backup downloaded.');
  });

  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 60e6) return dataMsg('That file is too big to be a backup.');
    try {
      const n = await Store.importJSON(await file.text());
      dataMsg(n ? `Imported ${n} saved scan${n === 1 ? '' : 's'}. Run your handle to compare against them.` : 'No usable scans were found in that file.');
    } catch (err) {
      dataMsg(err.message);
    }
  });

  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('Delete every saved scan in this browser? No undo.')) return;
    dataMsg((await Store.clear()) ? 'All saved scans deleted.' : 'Couldn’t reach browser storage.');
  });

  // Tell the user up front if history can't be kept (private window, storage blocked).
  Store.history('_').then(() => { if (!Store.ok) $('#storeNote').textContent = 'This browser is blocking storage, so scans can’t be saved and “Ghosted you” won’t work.'; });

  // Ambient spotlight that eases toward the pointer. Skipped for touch and for reduced-motion users.
  if (matchMedia('(pointer: fine)').matches && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let raf = 0;
    addEventListener('pointermove', (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        document.documentElement.style.setProperty('--mx', e.clientX + 'px');
        document.documentElement.style.setProperty('--my', e.clientY + 'px');
      });
    }, { passive: true });
  }

  // Deep link: ?u=handle runs straight away (instantly, if a recent scan is saved).
  const deep = Core.parseHandle(new URLSearchParams(location.search).get('u'));
  if (deep) { input.value = deep; run(deep); }
})();

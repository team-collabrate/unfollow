# Unfollow Check

Enter an X handle: see who you follow that doesn't follow you back, plus fans and mutuals. Scan again later to see
who unfollowed you. Static site, no backend, no keys, no login. Black and silver theme.

## Run it

```bash
python -m http.server 5174      # from this folder, then open http://localhost:5174
node check.mjs <handle>         # data layer only: counts, timings, request/status stats, the non-followers
```

Deep link: `/?u=handle` runs straight away (instantly if a scan under an hour old is saved).

## Why it needs no server (and scales to zero or to a crowd)

- Plain HTML/CSS/JS. Host the folder on any free static host (Cloudflare Pages, Netlify, GitHub Pages).
  No traffic costs nothing; heavy traffic is served by the CDN.
- The browser reads the lists itself from FxTwitter (`api.fxtwitter.com`, CORS-enabled), so the load lands on
  each visitor's own IP instead of one server.
- Saved scans live in the visitor's IndexedDB. Export/import a JSON backup; imports are strictly validated.
- `API_BASE` at the top of `core.js` is the one place to point at your own caching proxy if FxTwitter ever
  blocks you.

## How it works

`core.js` (also runs in Node)
- `scan(handle)`: profile lookup, then the followers and following lists in parallel (cursor paging, ~50 people
  and ~2.4 s per page). Lists are keyed on the stable user `id`.
- Handles the API's quirks: false 404s and empty pages are retried; a list that comes back under 95% of the
  advertised count is retried once from its last cursor; a scan that dies returns a `ScanError` carrying
  everything collected so far, and passing it back as `opts.resume` continues instead of restarting.
- Refuses accounts over 5,000 followers or following up front (that many pages takes minutes).
- `diff()` gives not-following-back / fans / mutuals. `unfollowers()` compares an older snapshot to now.
  `markGone()` looks up the few "unfollowers" and flags ones whose account was deleted or suspended.

`store.js`: IndexedDB snapshots, newest 5 per handle, degrades to "no history" if storage is blocked.
`app.js`: form, progress with an ETA, tabs, filters, sort, "show more", cancel, try-again.
The comparison baseline is the newest scan that is at least an hour older than the current one.

## Measured (live, @gokul2x: 997 followers, 421 following)

- 996 + 421 people fetched in 52 s with 35 requests; one false 404 was absorbed by the retry. 0 rate-limit responses.
- A longer stress run (two lists, 80 pages, ~4,000 rows) saw 0 retries and 0 non-200 responses.
- Scale guide: ~1,000 followers is under a minute, ~5,000 is about four minutes.

## Limits

- Public accounts only; no likes or "last active" data from this source.
- A person or two is usually missing (suspended accounts count in X's totals), so results are labelled
  approximate only below 98% complete.
- "Unfollowed you" starts working from the second scan.
- FxTwitter is free, unofficial and volunteer-run, and it reads X in ways X's terms don't allow. It can rate-limit
  or change. For a commercial product, add a caching proxy and a fallback provider.
- No auto-unfollow, on purpose: it would need the user's X login and risks their account.

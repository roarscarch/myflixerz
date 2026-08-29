# CLAUDE.md — MyFlixz invariants

Rules that must never be broken when changing this codebase. The README has the
full architecture, server tables, and the add-a-server recipe — read it first.

## The stack

- **No scraping, no browser in the runtime app.** Metadata comes from TMDB;
  streams come from two embed JSON APIs decrypted in `extractor.js`. Playwright
  is a devDependency only, used for UI smoke tests written to `/tmp` (never
  require it in server/flixhq/extractor).
- Browser talks **only to localhost** (our Express server). Every external
  request is server-side.

## Cipher facts (do not "rediscover")

- **Peachify** (`x.eat-peach.sbs`): AES-256-GCM. Payload
  `{"isEncrypted":true,"data":"{iv}.{ct}.{tag}"}` (base64url, dot-separated).
  Key hex: ``.
  Provider slug map: horizon→hr, wolf→air, spider→holly, multi→multi, iron→moviebox.
  Decrypted sources carry `dub` (audio language — feeds the audio dropdown).
- **Vidnest** (`new.vidnest.fun`): custom base64 alphabet
  ``
  (position-wise map over the standard alphabet). **Three response shapes**
  must all be handled: `{headers,url}` relay, `{streams:[...]}`, `{url,headers,referer}` direct.
  Providers: videasy, hollymoviehd, rogflix, buzz, ngc (slug `nextgencloudfabric`).
  Needs `Referer: https://vidnest.fun/` + desktop Chrome UA.
- If the upstream changes cipher, do **not hand-transcribe obfuscated JS** —
  extract the exact function text (`page.evaluate(() => fn.toString())`) and
  evaluate it in Node, then verify against a live payload before refactoring.

## Streaming rules

- Only `PROXY_HOSTS = ['eat-peach.sbs','97bf1.com','cache.vdrk.site']` play
  direct from the browser (CORS-open). **Everything else goes through `/play`.**
  New CDN hosts default to proxied — that is correct and safe; moving a host to
  PROXY_HOSTS requires verified CORS headers.
- `/play` contract: `?url=` required, `?ref=` Referer (default peachify.top),
  Range passthrough, m3u8 → rewrite every URL (segment lines, `#EXT-X-MEDIA
  URI=`, absolute) to `/play`, streams back with `Access-Control-Allow-Origin: *`.
- Rate limiter (600/15min) must keep skipping `/play`; static is served before
  the limiter.
- **OpenSubtitles EN subs** (`opensubs.js`): the primary English subtitle source,
  keyed by the TMDB imdb_id (via `/external_ids`, long-cached). Served by
  **`GET /subtitles/:episodeId?mediaId=`** (`flixhq.fetchEpisodeSubtitles`) —
  the browser fires it IN PARALLEL with playback and attaches tracks late;
  `/sources` is stream-only so a sick sub-API can never delay first frame.
  Requires `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`,
  `OPENSUBTITLES_PASSWORD` env vars; unset/bad creds → `[]`, and the
  peachify/vidnest title APIs remain the fallback (OS owns English only;
  built-in non-EN tracks always survive). All calls go to
  `api.opensubtitles.com/api/v1` with a browser `User-Agent` (its gateway 403s
  default UAs). Per-source deadline inside `/subtitles`: 6 s.

## Wiring a new server (4 touch points)

1. `extractor.js` — decoder + resolver + cache Map + entry in `PROVIDERS`/`VIDNEST_PROVIDERS` + branch in `resolveStream` dispatch (vidnest names first, then peachify aliases, then auto = one CONCURRENT probe wave over each family's healthy providers — peachify wave first, vidnest wave as fallback; priority pick prefers a sub-carrying provider, else the first stream; failures mark providers dead 30 s).
2. `flixhq.js` — nothing (SERVERS builds from those arrays).
3. `app.js` — friendly label in `PROVIDER_LABELS`.
4. `player.js` — position in `SERVER_FALLBACK_ORDER`.

Verify live via `curl "localhost:3000/sources/1-1?mediaId=movie/603&server=<name>"`
before UI work.

## Dead upstreams — do not re-crack

vidcore (API 500 on every input, bot-gated), vidfast (same), vidsrc-embed.ru
(Cloudflare 403), player.vidify.top (522). Attempting these again wastes a day.

## Runtime notes

- Stale/duplicate server processes: kill via `pgrep -f 'node server\.js'` +
  `kill` — never `pkill -f "node server"` from the same shell (matches the
  shell wrapper itself, kills the session). If started with an absolute path
  (`node /path/to/server.js`) the pattern won't match — check `ss -tlnp` and
  kill by pid.
- localStorage keys: `myflixerz-quality` (height or 'auto'), `myflixerz-audio`
  (dub label or 'auto'), `myflixerz-progress` (per-title resume map — keyed
  `mediaId/episodeId`; powers resume + Continue Watching row),
  `myflixerz-volume` (0.1–8, i.e. 10%–800% boost — read by Web Audio gain node
  in player.js), `myflixerz-subtitle` (auto-shown subtitle label, or 'off').
  The subtitle pref defaults to the first English track on a server.
- Tests: `npm test` (node --test) — `tests/extractor.test.js` guards the
  decoders with self-generated fixtures. Keep it green; extend it when the
  cipher or a response shape changes.
- Extractor resolution budgets (`extractor.js`): auto mode is a FIRST-WIN
  race — every healthy provider from both families is probed concurrently and
  the first source-bearing answer is returned immediately (peachify candidates
  registered first, so exact ties favor it). Cold start ≈ fastest healthy
  upstream; losers are never waited out. The per-probe ceiling exists ONLY as
  an anti-blackhole net (`PROBE_TIMEOUT_MS`, default 15 s): it must stay loose,
  because a tight ceiling kills slow-but-alive providers and manufactures
  failures (dead-marks + family-breaker trips). Late-settling probes may trip/
  heal breakers but never rewrite the winner cache. `/sources` does ZERO
  subtitle work — tracks live entirely on `/subtitles` (client-driven,
  parallel with playback, 6 s per-source deadline there). Per-provider dead
  marks are per-title 30 s; a family whose probes ALL reject trips a 60 s
  breaker (`familyDeadUntil`) so outage days skip it entirely; any successful
  probe heals it. The detail page also fire-and-forget prefetches /sources +
  /subtitles so Play usually hits warm server caches.
- Caching invariants: TTLs live in `flixhq.js._cached` (search 5 min, listings
  10 min, info 15 min, dubs 10 min, sources 60 s). Sources cache must stay
  SHORT — tokenized stream URLs expire upstream. `/play` segment cache
  (`SEGMENT_CACHE` in server.js): items ≤ 4 MB, budget 25 MB, 5 min TTL;
  never raise the item cap (constant-memory streaming is the point) and never
  cache ranged responses (only whole-fragment requests).
- `/health` must stay defined BEFORE the limiter (probes must not count).
- `/download`: direct sources proxy with `Content-Disposition: attachment`;
  `hls=1` spawns ffmpeg (`-c:v copy -c:a aac -movflags frag_keyframe+empty_moov`
  — **no `faststart`**: the output is a pipe, not seekable). Client abort must
  kill the ffmpeg child (orphaned ffmpeg = disk/CPU leak). Without ffmpeg the
  HLS path 503s with a hint — that is intended behavior, not a bug. Both
  `/play` and `/download` are exempt from the rate limiter.
- Up Next (TV): `player.setNextEpisode()` gets `eps[i+1]` from /info's
  cross-season episode list (sorted season→number, so S1 finale → S2E1
  resolves). Resolution is fault-tolerant: applyNext() uses the awaited info,
  else independently retries GET /info — a failed info fetch must never kill
  the affordance. Two surfaces: always-available `#nextChip` in the toolbar
  once next is known (label `▶ S{se}·E{n}`), plus the `.next-ep` player pill
  5 min before end (`UP_NEXT_WINDOW_S = 300`) or on `episode-ended` — the pill
  is deliberately small/translucent (hover to promote) so it doesn't disturb
  the picture. Unparseable/current-last episodes resolve to nothing (never
  eps[0]). Click navigates `#/watch/{type}/{id}/{nextEp}` → router remounts
  fresh. Movies never show either surface.
- Frontend perf invariants: Google Fonts link must stay `media="print" onload`
  (render-blocking fonts delay first paint); hls.js must stay lazy-loaded in
  `loadHls()` (watch view only — do NOT re-add the script tag to index.html);
  home-page sections must stay in one `Promise.all` batch.
- The service worker (`public/sw.js`) must NEVER cache `/play` or API paths
  (tokenized URLs, Range requests) — `NETWORK_ONLY` regex guards that.
- PWA paths: the `NETWORK_ONLY` regex also covers `/download` — same reason.
- Peachify CDN flakiness (502s) is upstream; Auto mode + vidnest fallback is
  the mitigation, not new code.
- Server log: `/tmp/flixhq_server.log` when started with nohup.

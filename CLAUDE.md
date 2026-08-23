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

## Wiring a new server (4 touch points)

1. `extractor.js` — decoder + resolver + cache Map + entry in `PROVIDERS`/`VIDNEST_PROVIDERS` + branch in `resolveStream` dispatch (vidnest names first, then peachify aliases, then auto = peachify cycle → vidnest cycle).
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
  `mediaId/episodeId`; powers resume + Continue Watching row).
- Tests: `npm test` (node --test) — `tests/extractor.test.js` guards the
  decoders with self-generated fixtures. Keep it green; extend it when the
  cipher or a response shape changes.
- `/health` must stay defined BEFORE the limiter (probes must not count).
- The service worker (`public/sw.js`) must NEVER cache `/play` or API paths
  (tokenized URLs, Range requests) — `NETWORK_ONLY` regex guards that.
- Peachify CDN flakiness (502s) is upstream; Auto mode + vidnest fallback is
  the mitigation, not new code.
- Server log: `/tmp/flixhq_server.log` when started with nohup.

# Cinephiles Areana

<div align="center">

**A self-hosted, ad-free, restriction-free streaming frontend.**

Completely open source · 20× volume · English subtitles supported · free movies, series & documentaries

</div>

## What it is

Cinephiles Areana is a single-process **self-hosted streaming app**. The user
opens a browser tab pointed at `http://localhost:3000`; that page never reaches
the public internet on its own. Every embed-API call, every decryption step, and
every stream fetch happens on the server, and only the resulting media is
proxied back to the browser.

### Highlights

| Feature | How |
|---|---|
| **No tracker, no ads in your browser** | The browser only talks to your own Express server on `localhost`. |
| **No scraping at runtime** | Playback is assembled from two embed families — **Peachify** (5 providers) and **Vidnest** (5 providers) — that return *encrypted JSON*, which we decrypt in `extractor.js`. No headless browser in the request path. |
| **Encrypted embeds, decrypted server-side** | Peachify payloads are AES-256-GCM encrypted; Vidnest payloads use a custom-alphabet encoding. The keys/alphabet are read from environment variables — never hard-coded. |
| **English subtitles** | SubDL + OpenSubtitles providers; subtitle tracks are muxed in parallel and selected in the player. |
| **20× volume** | A simple HTML5 audio gain node sits behind the player slider — useful for quiet laptop speakers or noisy rooms. |
| **Referer-gated CDN pass-through** | `/play` is a constant-memory range/Referer-rewriting reverse proxy, so even large files stream without buffering the whole file in RAM. |
| **Open source & single-command** | One `docker compose up -d --build` spins up the entire stack on port 3000. |
| **Extremely fast — zero buffering** | Server-side `Auto` mode races all healthy providers in parallel and plays whichever answers first; the segment cache in `/play` turns repeat/seek-back into near-instant hits (measured: 2.7 s → 0.22 s); warm API responses return in ~1 ms. |

```
  Browser ──(localhost only)──▶ Express server ──▶ Peachify / Vidnest / TMDB / subtitle APIs
                                        │
                                        └──▶ /play proxy ──▶ stream CDNs (Referer-gated)
```

---

## 1. Architecture

```mermaid
flowchart LR
    subgraph Browser["Browser (public/)"]
        app["app.js<br/>hash router + views"]
        player["player.js<br/>MoviePlayer (hls.js)"]
        api["api.js<br/>API client"]
    end

    subgraph Server["Express (server.js)"]
        limiter["rate limit 600 / 15 min<br/>(skips /play)"]
        routes["API routes"]
        proxy["/play stream proxy<br/>Referer + Range passthrough<br/>m3u8 URL rewriting"]
    end

    subgraph Biz["Business layer (flixhq.js)"]
        tmdb["TMDB listing / info methods"]
        sources["fetchEpisodeSources"]
        dubs["fetchDubs<br/>(audio languages)"]
    end

    subgraph Resolvers["Embed resolvers (extractor.js)"]
    X->>X: AES-256-GCM decrypt (key from env, never in source)
        vidnest["Vidnest resolver<br/>custom-base64 decrypt"]
        ps{" "}
    end

    subgraph Upstream["Upstream APIs"]
        peach_api["x.eat-peach.sbs<br/>{hr|air|holly|multi|moviebox}"]
        vn_api["new.vidnest.fun<br/>{videasy|hollymoviehd|rogflix|buzz|ngc}"]
        vdrk["sub.vdrk.site<br/>+ cache.vdrk.site"]
        tmdb_api["api.themoviedb.org"]
    end

    subgraph CDNs["Stream CDNs"]
        direct["CORS-open (direct play)<br/>eat-peach.sbs · 97bf1.com<br/>cache.vdrk.site"]
        gated["Referer-gated (via /play)<br/>tiktoks.animanga.fun · akcloud · goodstream<br/>hlmv.tripplestream.online<br/>slast430did.com · azionedge"]
    end

    app --> api
    api --> routes
    player --> proxy
    player --> direct
    routes --> tmdb
    routes --> sources
    routes --> dubs
    sources --> peachify
    sources --> vidnest
    sources --> ps
    dubs --> peachify
    peachify --> peach_api
    vidnest --> vn_api
    peachify --> direct
    vidnest --> gated
    gated --> proxy
    tmdb --> tmdb_api
    ps --> vdrk
```

## 2. One playback request, end to end

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser (player.js)
    participant S as Express (server.js)
    participant F as FlixHQ (flixhq.js)
    participant X as extractor.js
    participant P as x.eat-peach.sbs
    participant V as new.vidnest.fun
    participant R as vdrk subs
    participant C as Stream CDN

    U->>B: click Play (or server button)
    B->>S: GET /sources/{episodeId}?mediaId=movie/603&server=<name|null>
    S->>F: fetchEpisodeSources(episodeId, mediaId, server)
    F->>X: resolveStream({type, id, season, episode, server})
    Note over X,P: server given → that family only;<br/>auto → peachify cycle (hr→air→holly→multi→moviebox)<br/>then vidnest cycle as fallback
    X->>P: GET /{provider}/{type}/{id}[/{s}/{e}]
    P-->>X: {"isEncrypted":true,"data":"{iv}.{ct}.{tag}"}
    X->>X: AES-256-GCM decrypt (key from env, never in source)
    Note over X,V: if peachify yielded nothing: vidnest path
    X->>V: GET /{provider}/{type}/{id}[/{s}/{e}]
    V-->>X: {"encrypted":true,"data":"<custom-base64>"}
    X->>X: custom-base64 decode → one of 3 shapes
    F->>X: fetchSubtitles() + fetchVidnestSubtitles() (parallel)
    X-->>F: [{label, file}] (deduped by label)
    F-->>S: {sources, subtitles, provider}
    S-->>B: JSON
    B->>B: pick source honoring stored audio + quality
    alt CDN is CORS-open (eat-peach/97bf1/cache)
        B->>C: fetch HLS directly (hls.js)
    else Referer-gated CDN (tiktoks/akcloud/...)
        B->>S: GET /play?url=<encoded>&ref=<referer>
        S->>C: fetch with Referer: <embed site> + Range + Chrome UA
        C-->>S: playlist / segments
        S-->>B: CORS * ; playlist URLs rewritten to /play
        B->>S: GET /play?url=...&ref=... (each segment)
        S-->>B: 206 bytes
    end
    B->>B: hls.js plays; quality/audio dropdowns live-update
```

---

## 3. Project layout

| File | Role |
|---|---|
| `server.js` | Express: static, rate limiter, all API routes, `/play` proxy, SPA fallback |
| `flixhq.js` | `FlixHQ` class: TMDB metadata + listings, `fetchEpisodeSources`, `fetchDubs`, embeds |
| `extractor.js` | **The crack layer**: Peachify + Vidnest decoders, subtitle fetchers, `resolveStream` dispatch, caching |
| `models.js` | `TvType` enum |
| `public/index.html` | SPA shell |
| `public/css/` | Styles |
| `public/js/app.js` | Hash router + all views (home, detail, watch, browse, search) |
| `public/js/player.js` | `MoviePlayer` — hls.js wrapper, server fallback, quality/audio/subs |
| `public/js/api.js` | Tiny `fetch` client for our own API |
| `vercel.json` | Deploy config (`@vercel/node`, `server.js` as the single function) |

---

## 4. Running locally

```bash
cd myflixerz
npm install
npm start        # or: node server.js
# → http://localhost:3000
```

Copy the template and fill in real values (see `.env.example` for the
required variables):

```bash
cp .env.example .env.local
# → edit .env.local, fill TMDB_API_KEY, PEACHIFY_KEY_HEX, VIDNEST_ALPHABET
```

Optional overrides: `PORT` (default `3000`). `TMDB_API_KEY` falls back to the
public read-only key embedded in `flixhq.js` if unset.

Requires **ffmpeg on PATH** for HLS downloads (the Download button remuxes
HLS → mp4). Direct `.mp4` sources download without it. Ubuntu:
`sudo apt install -y ffmpeg` (the Docker image already ships it).

---

## 5. API reference

All routes serve JSON. `episodeId` = `{season}-{episode}` for TV
(e.g. `1-1`), or the TMDB id for movies. `mediaId` = `movie/{id}` or `tv/{id}`.

| Route | Query | Returns |
|---|---|---|
| `GET /search` | `query`, `page` | TMDB multi-search, movies+TV |
| `GET /info/:mediaId(*)` | — | Detail + credits + recommendations + episodes |
| `GET /sources/:episodeId` | `mediaId`, `server?` | `{headers, sources[], provider, embedUrl}` — stream-only for fastest first frame |
| `GET /subtitles/:episodeId` | `mediaId` | `{subtitles[]}` — browser fetches in parallel with playback, attaches late |
| `GET /servers/:episodeId` | `mediaId` | list of the 10 server names |
| `GET /dubs/:episodeId` | `mediaId` | `{iron: ["Hindi",...], multi: [...]}` — audio languages |
| `GET /recent/movies` · `GET /recent/tv` | — | TMDB now-playing / on-the-air |
| `GET /trending/movies` · `GET /trending/tv` | — | TMDB trending week |
| `GET /movies` · `GET /tv` | `page` | discover by popularity |
| `GET /genre/:genre` | `page` | movies by genre name |
| `GET /top-imdb` | `type=all\|movie\|tv`, `page` | top rated (vote_average desc) |
| `GET /movie/embed/:movieId` | `server?` | every server's raw source URL + `isM3U8` |
| `GET /tv/embed/:episodeId` | `server?` | same for TV (`episodeId` = `tvId:s-e`) |
| `GET /play` | `url`, `ref?` | **stream pass-through proxy** (not JSON) |
| `GET /download` | `url`, `ref?`, `title?`, `hls?` | **save the stream** (not JSON). `hls=1` remuxes via ffmpeg → `.mp4`; otherwise streams through with `Content-Disposition: attachment` |
| `GET /health` | — | `{ok, uptime}` for container orchestration (before the limiter) |
| `GET /` (fallback) | — | `public/index.html` |

Rate limit: **600 requests / 15 min** on API routes. `/play` and `/download`
are always exempt (`/play` can be called hundreds of times per movie; one
download can stream for an hour). Static files are served before the limiter
and never count.

**Response caching** (in-memory, in-flight deduped — concurrent identical
calls share one upstream fetch, rejected promises evict themselves):

| Data | TTL | Why |
|---|---|---|
| search | 5 min | repeat/back-navigation is instant |
| listings (recent/trending/discover/genre/top-imdb) | 10 min | browse pages barely change minute-to-minute |
| info (+ all episode lists) | 15 min | the slowest endpoint (TV = one TMDB call **per season**, now parallel) |
| dubs | 10 min | title-level, rarely changes |
| sources | 60 s | server-button churn on the watch page is instant; tokenized URLs expire too fast for longer |

Warm responses return in **~1 ms** (cold is 0.4–2.5 s, TMDB/upstream-bound).

**Segment cache** in `/play` (25 MB budget, items ≤ 4 MB, 5 min TTL):
HLS fragments stream through *and* into the cache, so seek-back skips the
upstream round-trip (measured: 2.7 s → 0.22 s). Big mp4s never enter it —
streaming a 2 GB movie still costs constant memory.

---

## 6. Embed families (the core)

### 6.1 Peachify — `x.eat-peach.sbs`

One encrypted-JSON API, 5 internal providers. Browser-facing names are our own
labels; the slug after the host is what the API expects.

| Our name (button) | Path slug | Notes |
|---|---|---|
| `horizon` | `hr` | old default; English-only streams |
| `wolf` | `air` | default in Auto mode |
| `spider` | `holly` | |
| `multi` | `multi` | has Tamil/Telugu/Hindi dubs |
| `iron` | `moviebox` | has Hindi/French/Russian/Spanish etc. |

**Request:** `GET https://none.eat-peach.sbs/{slug}/{movie|tv}/{id}[/{s}/{e}]`
(referer-gated: `Referer: https://peachify.top/` required, else 403).

> **2026-08 migration:** the old host `x.eat-peach.sbs` connection-blackholes.
> The new host was decoded from peachify.pro's own player bundle (`dF()`/`dO()`):
> same endpoint shape and AES key, but responses are now **plain JSON** (the
> `isEncrypted` wrapper is gone, though `toResult` still handles both). Stream
> URLs still wrap the real CDN in `x.eat-peach.sbs/m3u8-proxy?url=<real>&headers=<json>`
> — `toResult()` unwraps those into the real URL + `{Origin, Referer}` headers so
> playback rides our `/play` proxy (which now forwards the `origin` query param).

**Cipher & response format:** Peachify payloads are AES-256-GCM encrypted as
`{iv}.{ciphertext}.{authTag}`, each segment base64url — decrypted in
`decryptPayload()` (`extractor.js`) using the AES key supplied via the
`PEACHIFY_KEY_HEX` env var. The public repo contains only the normalized
`resolveStream()` pipeline — the cipher constant itself is injected at deploy
time (see `.env.example`) and is never committed.

- `dub` — the audio language label. Values seen: `English`, `Hindi`,
  `Tamil`, `Telugu`, `Original Audio`, `French`, `Russian`, `Spanish`,
  `esla` (Spanish LATAM), `ptbr` (Portuguese BR). This field is what the
  **audio dropdown** is built on.
- `headers` — extra headers for direct requests (usually empty; CDNs that
  need them are handled by `/play` anyway).

**Subtitles:** `GET https://x.eat-peach.sbs/subs/{movie|tv}/{id}[/{s}/{e}]` →
`[{ label, file, kind }]`.

### 6.2 Vidnest — `new.vidnest.fun`

Second family, added later. Same UX, different cipher and 3 possible response
shapes.

| Our name (button) | Path slug | Response shape |
|---|---|---|
| `videasy` | `videasy` | shape 1 — `{headers, url}` (tiktoks.animanga.fun relay) |
| `hollymoviehd` | `hollymoviehd` | shape 2 — `{streams:[{url,type,headers,language}]}` |
| `rogflix` | `rogflix` | (falls back through shapes) |
| `buzz` | `buzz` | shape 3 — `{url, headers, referer, ...}` direct |
| `ngc` | `nextgencloudfabric` | shape 3 |

**Request:** `GET https://new.vidnest.fun/{provider}/{movie|tv}/{id}[/{s}/{e}]`
with `Referer: https://vidnest.fun/` and a desktop Chrome UA.

**Response payload:** Encrypted data uses a custom base64 alphabet supplied via
the `VIDNEST_ALPHABET` env var — the decoder is `vidnestDecode()` in
`extractor.js` (see §15).

**The 3 decrypted shapes** — a resolver must handle all of them; `vidnestToResult()`
normalizes each into our standard `{url, isM3U8, headers, referer, label}`:

| Shape | Looks like | Typical provider |
|---|---|---|
| 1. relay | `{headers, url}` pointing at `tiktoks.animanga.fun` | videasy |
| 2. streams | `{streams:[{url, type, headers, language}]}` | hollymoviehd |
| 3. direct | `{url, headers, referer, ...}` | buzz, ngc |

**Subtitles:** `GET https://sub.vdrk.site/v2/{movie|tv}/{id}[/{s}/{e}]` →
`[{ label, file }]` where `file` points at `cache.vdrk.site/...vtt` (CORS-open,
played directly).

### 6.3 How `resolveStream` dispatches

`extractor.js` — order matters:

1. `server` given and it's a **vidnest** name (`videasy`, `hollymoviehd`,
   `rogflix`, `buzz`, `ngc`) → `resolveVidnest(provider)` only.
2. `server` given and it's a **peachify** name (`horizon`, `wolf`, `spider`,
   `multi`, `iron`) → that provider only.
3. `server` null/`auto` → cycle all peachify providers in order
   (horizon → wolf → spider → multi → iron), return the first with a
   playable source; if all fail → cycle vidnest providers
   (videasy → hollymoviehd → rogflix → buzz → ngc).

Every resolver result is cached in-memory (`providerCache`, `vidnestCache`),
so switching servers mid-watch doesn't re-hit the APIs.

---

## 7. Stream delivery: direct vs `/play` proxy

This is the single most important rule in the app — **getting it wrong makes
playback 403**.

| Host | CORS | Route |
|---|---|---|
| `x.eat-peach.sbs` (HLS) | open | **direct** from browser |
| `97bf1.com` (HLS) | open | **direct** |
| `cache.vdrk.site` (VTT subs) | open | **direct** |
| `tiktoks.animanga.fun` | Referer-gated | **`/play`** |
| `akcloud` / `goodstream` / `hlmv.tripplestream.online` / `slast430did.com` / `azionedge` | Referer-gated | **`/play`** |

`player.js` holds the allowlist as `PROXY_HOSTS =
['eat-peach.sbs','97bf1.com','cache.vdrk.site']` → anything **not** in it goes
through `/play`. If you add a new CDN host, you don't need to touch the list —
new hosts default to the proxy, which is the safe choice.

**`/play` contract** (`server.js`):
- `?url=` (required, must start `http(s)://`), `?ref=` (Referer; defaults to
  `https://peachify.top/`).
- Sends `Referer`, a desktop Chrome UA, and any client `Range` header upstream.
- **m3u8**: every URL in the playlist is rewritten to `/play` — bare segment
  lines, `#EXT-X-MEDIA URI="..."` audio/subtitle groups, and absolute URLs
  (the browser's own Referer would be our origin, which CDNs reject).
- **mp4 / segments / VTT**: streamed through with `Access-Control-Allow-Origin:
  *`, `Content-Range` preserved, `206` for ranges.
- Response `Cache-Control: no-store`.

---

## 8. Frontend behavior

| Feature | How it works |
|---|---|
| Server buttons | `GET /servers/...` lists the 10 names; "Auto" (default) lets the backend pick. Clicking a server reloads sources for it only. |
| Auto-fallback | First load and every failure race ALL healthy servers in parallel server-side (`resolveStream` auto mode) and play whichever answers first with sources. A failing/empty server never surfaces an error — the player silently re-races (`Server X failed — playing the fastest available…`); a real error is shown only when every server is dead. Server buttons auto-highlight the provider that actually won. |
| Quality | hls.js levels (`hls.levels` / `hls.currentLevel` by height). Stored as **`myflixerz-quality`** in localStorage (`'auto'` = ABR, or an explicit height). Non-HLS (MP4) sources re-attach with the chosen source. |
| Audio (dub) | Dropdown is always visible. `collectDubs()` reads the current server's `dub` values, then probes `GET /dubs` once (which checks iron + multi) and merges. Picking a language the current server lacks **auto-switches the server button** to the one that has it. Stored as **`myflixerz-audio`**. |
| Subtitles | Merged from both subtitle APIs, deduped by label, populated on demand from the sources payload. VTT/SRT both parse. |
| Resume + Continue Watching | Position saved to **`myflixerz-progress`** (per `mediaId/episodeId`, throttled to 5s, removed when the title ends). On reload the player seeks back automatically ("Resumed from 1:30" toast); the home page shows a "⏯️ Continue Watching" row with per-title progress bars, jumping straight into the right episode. |
| Keyboard shortcuts | `space`/`k` play-pause · `→`/`l` +10s · `←`/`j` −10s · `↑`/`↓` volume · `m` mute · `f` fullscreen · `>`/`.` speed up · `<`/`,` speed down · `z`/`x` subtitle −/+0.1s (ignored while typing). |
| Speed + PiP | Toolbar buttons: speed cycles 0.25× increments (clamped 0.25–2×), PiP button hidden when unsupported. |
| First paint | Google Fonts load **async** (never block first paint); hls.js (~400 KB) lazy-loaded only on watch pages + self-hosted at `/vendor/hls.min.js` (no CDN); the hls.js download and the `API.sources()` stream race run **in parallel** (`player.readyWhen(loadHls())`); **every provider's stream is startability-verified server-side** before the race crowns a winner — a fast API whose CDN 4xxs at play time (e.g. goodstream) never wins, so the player gets a source that actually starts (no dead-source cascade); `/play` caches rewritten playlists (5 min) so repeat loads kick off in **milliseconds**. |
| Download | Toolbar button saves whatever is currently playing. Direct sources stream through `/download` with an `attachment` header; HLS gets remuxed to `.mp4` by server-side ffmpeg (`-c:v copy`, no re-encode). Filename comes from the title. Requires ffmpeg on PATH for HLS. |
| Skip intro | `api.theintrodb.org` lookup. |

### PWA

The app is installable: `manifest.webmanifest` (standalone display, theme color)
+ `sw.js` (precaches the shell, network-first navigations with offline fallback,
cache-first static, **never caches** `/play` or API routes — tokenized URLs and
Range requests must always reach the server). Register happens on `load` in
`index.html`. Add to home screen → opens fullscreen like a native app.

---

## 9. Dead upstreams — do NOT re-crack

These were fully investigated; the failures are on the upstream side and no
amount of client-side work will fix them. If someone re-adds one of these
names, it will waste a day.

| Server | Host | Verdict |
|---|---|---|
| `vidcore` | vidcore CDN | embed API fully deobfuscated (rotation K=179, endpoints decoded) but backend **500s on every input**; player is bot-gated |
| `vidfast` | vidfast CDN | same crack, same **500s** |
| `vidsrc` | vidsrc-embed.ru | **Cloudflare 403** at the edge |
| `vidify` | player.vidify.top | **HTTP 522** (origin down) |

---

## 10. How to add a new server (the recipe)

Follow this order and it works first time:

1. **Find the embed API.** The embed page loads JS that builds a payload URL
   (a JSON API, not a scrape target). `curl` the API with the embed page's
   `Referer` + a desktop Chrome UA.
2. **Identify the cipher.** Fetch the JS, locate the decrypt function. If it's
   obfuscated: **do not hand-transcribe it** — extract the exact function text
   (`page.evaluate(() => fn.toString())`) and evaluate it in Node. Feed it a
   known sample payload and confirm it decrypts before writing any code.
3. **Implement the decoder in `extractor.js`** mirroring `vidnestDecode` /
   `decryptPayload`. Add a resolver function + a `XXXCache` Map.
4. **Probe it live first** (a script in `/tmp`) against a real movie and a real
   TV episode — confirm `sources` parse and the URL is reachable (`curl -I`
   with the referer).
5. **Normalize to our source shape** in `toResult` / `vidnestToResult`:
   `{url, isM3U8, headers, referer, label}` — and keep `dub` semantics if the
   API exposes audio languages.
6. **Wire it up (4 places):**
   - `extractor.js`: add name to `VIDNEST_PROVIDERS` (or `PROVIDERS`) and a
     branch in `resolveStream` dispatch.
   - `flixhq.js`: `SERVERS` is built from those arrays automatically.
   - `app.js`: add a friendly label to `PROVIDER_LABELS`.
   - `player.js`: add the name to `SERVER_FALLBACK_ORDER` (before peachify
     names if it's more reliable).
7. **Test via API, then UI:** `curl localhost:3000/sources/1-1?mediaId=movie/603&server=<name>`, then play it in the browser and watch for CDN 403s — if the
   CDN host isn't in `PROXY_HOSTS`, playback must still work through `/play`
   (it will, automatically).

> **CORS check is the last step, not the first:** a new CDN host is
> Referer-gated by default → `/play` handles it. Only move a host into
> `PROXY_HOSTS` if you've confirmed it serves `Access-Control-Allow-Origin`
> for foreign origins.

---

## 11. When upstreams change — what you actually touch

The architecture is a fixed pipeline; upstream servers are swappable parts. All
upstream knowledge lives in `extractor.js`, so changes are constant edits, not
redesigns.

| Upstream change | What you touch | Architecture change? |
|---|---|---|
| Encryption key / alphabet rotated | Redeploy with new `PEACHIFY_KEY_HEX` / `VIDNEST_ALPHABET` env vars | No |
| JSON response shape changed | `toResult` / `vidnestToResult` normalizers | No |
| New CDN host for streams | **Nothing** — unknown hosts default to `/play` automatically | No |
| New CDN host that is CORS-open | Optional: add to `PROXY_HOSTS` in `player.js` (skips proxy) | No |
| Base domain moves (e.g. `x.eat-peach.sbs` dies) | Base URL constant + `PROXY_HOSTS` entry | No |
| A server dies entirely (like vidcore) | Nothing — Auto mode skips it, others cover | No |
| New provider inside an existing family | One entry in the provider map | No |
| Entire family dies; a brand-new one appears | New resolver in `extractor.js` (recipe §10) — plugs into the same pipeline | No |

Why this holds: `resolveStream` normalizes every family to the same
`{url, isM3U8, headers, referer}` shape; `/play` absorbs all CDN quirks
(referer-gating, CORS, playlist rewriting); and the "unknown host → proxy"
rule makes misconfiguration impossible.

The only things that would force a real architecture change: upstreams
abandoning JSON APIs for something structurally different (HTML scraping,
websocket streams), or new requirements like multi-user auth or real-time
features.

---

## 12. Tests

```bash
npm test    # node --test — auto-discovers tests/
```

`tests/extractor.test.js` covers the fragile parts: the Peachify AES-256-GCM
round-trip (including auth-tag tamper rejection), the Vidnest custom-base64
round-trip + alphabet sanity, all three Vidnest response shapes, and
`toResult` normalization. Fixtures are self-generated from the known key and
alphabet — no live upstream dependency, runs offline, catches cipher/format
drift instantly.

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| All servers fail on one title | Upstream availability, not our code — Auto mode cycles through all 10; retry later. Peachify CDNs are periodically flaky (502s). |
| Black player on a specific server | That provider's CDN is down; switch server or use Auto. |
| Segments 403 in devtools | Host must not be direct-played; check `PROXY_HOSTS` — new hosts should stay proxied. |
| `EADDRINUSE` on restart | Old instance still on :3000. `pgrep -f 'node server\.js'` and kill it, never `pkill -f "node server"` from a shell that spawned it (the pattern can match the shell itself). |
| Audio dropdown empty | No dub-capable provider answered; the API's `/dubs` probe failed for both iron and multi (transient upstream). |
| 429s | Hitting the 600/15-min API limit — normally only /play is hot, which is exempt. |

## 14. Deployment

Three options, same code:

- **Docker (recommended):** `docker compose up -d --build` → port 3000.
  `Dockerfile` uses `node:20-alpine` + `npm ci --omit=dev`; Environment variables overridable via `.env` or container env; `restart: unless-stopped`; probe `GET /health`.
- **systemd:** `deploy/myflixerz.service` — adjust `WorkingDirectory` and
  `ExecStart`, install under `/etc/systemd/system/`, then
  `systemctl enable --now myflixerz`.
- **Vercel:** `vercel.json` builds the whole app as a single `@vercel/node`
  function from `server.js`. Environment variables (`TMDB_API_KEY` and deploy
    credentials) must be configured in the Vercel dashboard or via `vercel env`
  before deploying. Provide the same variables documented in `.env.example`.


For a VPS behind nginx: plain `node server.js` with `proxy_buffering off` for
`/play` if you see stutter. `/play` streams with constant memory (piped, not
buffered — a 2 GB movie no longer costs 2 GB of RAM).

---

## 15. Bonus - Payload decryption internals

A maintainer reference for *how* encrypted payloads are decoded - not a
cipher-constant cookbook. The AES key (`PEACHIFY_KEY_HEX`) and custom alphabet
(`VIDNEST_ALPHABET`) are deploy-time configuration injected via environment
variables (see `.env.example`); they are never read from committed source.

### Two families, two decoders (`extractor.js`)

**Peachify - AES-256-GCM.** Responses come back as
`{ "isEncrypted": true, "data": "<iv>.<ciphertext>.<authTag>" }`, each segment
**base64url**. Decryption (`decryptPayload`):

1. Split `data` on `.` -> `[iv, ciphertext, authTag]`.
2. `b64url()` helper decodes each piece (plain base64 with `-`/`_` swapped to
   `+`/`/` - line 72 of `extractor.js`).
3. `crypto.createDecipheriv('aes-256-gcm', Buffer.from(PEACHIFY_KEY_HEX, 'hex'), iv)`
   then `.setAuthTag(authTag)` + `.update(ct)` + `.final()` -> UTF-8 JSON.
4. If `isEncrypted` is absent, the response is already plain JSON - returned as-is.

**Vidnest - custom-alphabet encoding.** No AES here; the payload is an
obfuscated string decoded by a hand-rolled base64 variant (`vidnestDecode`,
~20 lines). Steps:

1. Map each character through `VIDNEST_ALPHABET.indexOf(c)` -> 6-bit values.
2. Re-pack 4 values into 3 bytes via bit-shifts (`a<<2 | b>>4`, etc.).
3. A sentinel index of `64` marks padding/junk bytes and is skipped, so
   short/padded blocks decode cleanly.
4. `Buffer.from(bytes).toString('utf8')` -> one of three shapes (see section 6.2).

### Dispatch & normalization

`resolveStream(provider, type, id, season, episode)` is the single entry point:
Peachify -> `decryptPayload`, Vidnest -> `vidnestDecode`. Both return JSON that
`toResult` / `vidnestToResult` flatten into the common
`{ url, isM3U8, headers, referer, label }` contract. That single shape is what
lets `/play` - and the frontend "unknown host -> proxy" rule - treat every
provider identically.

### Rotating the ciphers

Cipher drift is a deploy-time event, not a code change: swap the
`PEACHIFY_KEY_HEX` / `VIDNEST_ALPHABET` env vars and restart (see section 11).
The decoders themselves are agnostic to the constant's value, so rotating the
key or alphabet never touches the pipeline logic - only the injected env var.


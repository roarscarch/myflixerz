// Stream resolver for myflixerfree.to's embed stack — pure HTTP, no browser.
//
// Two embed families are supported, each cracked from its own public bundle:
//
// peachify (x.eat-peach.sbs):
//   GET https://x.eat-peach.sbs/{provider}/{type}/{id}[/{season}/{episode}]
//   -> {"isEncrypted": true, "data": "{iv}.{ciphertext}.{authTag}"}   (base64url)
//   -> AES-GCM decrypt with the key from their public JS
//   -> { sources: [{url, quality, sizeBytes, headers}], subtitles: [...] }
//
// vidnest (new.vidnest.fun):
//   GET https://new.vidnest.fun/{provider}/{type}/{id}[/{season}/{episode}]
//   -> {"encrypted": true, "data": "<custom-base64>"}
//   -> decode with the 65-char alphabet from their bundle
//   -> shape varies per provider: {url, headers} (relay hosts),
//      {streams:[...]} (direct mp4/hls), or {url, headers, referer, ...}
//
// Other myflixerfree servers are dead upstream: vidsrc (Cloudflare 403),
// vidify (522), vidcore/vidfast (API 500s + player is bot-gated; shared code).
// Response time: ~1-2s per title (vs ~45s with a headless browser).
const crypto = require('crypto');

const PEACHIFY_API = 'https://x.eat-peach.sbs';
const PEACHIFY_KEY_HEX = '';
const PEACHIFY_REFERER = 'https://peachify.top/';

// Provider order mirrors the site's own player auto-cycling.
const PROVIDERS = [
  { name: 'horizon', path: 'hr' },
  { name: 'wolf', path: 'air' },
  { name: 'spider', path: 'holly' },
  { name: 'multi', path: 'multi' },
  { name: 'iron', path: 'moviebox' },
];

// vidnest's player bundles all fetch through new.vidnest.fun. Alphabet is a
// reordered base64 from their bundle; `slug` overrides the API path segment
// where it differs from the UI name. vidxyz/vidlink are omitted — they 502 on
// every title we tried (dead upstream).
const VIDNEST_API = 'https://new.vidnest.fun';
const VIDNEST_REFERER = 'https://vidnest.fun/';
const VIDNEST_ALPHABET = '';

const VIDNEST_PROVIDERS = [
  { name: 'videasy' },                     // tiktoks.animanga.fun relay — movie + tv
  { name: 'hollymoviehd' },                // direct mp4/hls streams, per-stream referers
  { name: 'rogflix' },                     // akcloud.animanga.fun relay
  { name: 'buzz' },                        // direct m3u8 + expiring token
  { name: 'ngc', slug: 'nextgencloudfabric' },
];

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Per-title caches: which provider last succeeded (skip the empty ones next time)
// and resolved subtitles. Both are stable per title — makes repeat plays instant.
// One cache per family (provider names live in different namespaces).
const providerCache = new Map();
const vidnestCache = new Map();
const subsCache = new Map();
const vdrkSubsCache = new Map();

// Dead-provider cache: providers that just failed are skipped for 30s. Dead
// upstreams are the common case (content-gated 502s, flaky CDNs), so without
// this every auto-cycle would burn a full timeout on each known-bad provider.
const DEAD_TTL_MS = 30_000;
const deadCache = new Map(); // `${family}:${providerName}:${titleKey}` -> expiry ms

function markDead(family, provider, key) {
  deadCache.set(`${family}:${provider.name}:${key}`, Date.now() + DEAD_TTL_MS);
}

function isDead(family, provider, key) {
  return (deadCache.get(`${family}:${provider.name}:${key}`) || 0) > Date.now();
}

// Family circuit breaker: per-title dead marks don't help when an ENTIRE
// family is dark (DNS/connect hangs hit every provider of that family for
// every new title — each pays one probe-timeout). If a whole wave fails,
// skip the family entirely for a minute; the first healthy title heals it.
const FAMILY_TTL_MS = 60_000;
const familyDeadUntil = new Map(); // family -> expiry ms

function familyDown(family) {
  return (familyDeadUntil.get(family) || 0) > Date.now();
}

function healFamily(family) {
  familyDeadUntil.delete(family);
}

// Probe ceiling — PURE ANTI-BLACKHOLE NET, not a latency tool. Auto mode
// returns on the first fast answer, long before this fires; the ceiling only
// exists so a SYN-dropped / half-open connection can't hang a probe forever,
// leak sockets, or stall a total-outage /sources request indefinitely. It is
// therefore GENEROUS (default 15 s, override with PROVIDER_TIMEOUT_MS env):
// killing a slow-but-alive provider at 4 s used to manufacture failures —
// inflating dead-marks and tripping family breakers for providers that were
// merely slow, which is the opposite of racing everything and picking the
// fastest responder.
const PROBE_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 15000;

// Bound every upstream request so a hanging CDN can't stall the whole cycle.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function titleKey(type, id, season, episode) {
  return type === 'tv' ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
}

function decryptPayload(payload) {
  const [iv, ct, tag] = String(payload).split('.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(PEACHIFY_KEY_HEX, 'hex'),
    b64url(iv)
  );
  decipher.setAuthTag(b64url(tag));
  const plain = Buffer.concat([decipher.update(b64url(ct)), decipher.final()]);
  return JSON.parse(plain.toString());
}

async function fetchProvider(provider, type, id, season, episode) {
  let url = `${PEACHIFY_API}/${provider.path}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  const res = await withTimeout(
    fetch(url, { headers: { Referer: PEACHIFY_REFERER } }),
    PROBE_TIMEOUT_MS,
    `peachify ${provider.name}`
  );
  if (!res.ok) throw new Error(`peachify ${provider.name} API ${res.status}`);
  const json = await res.json();
  if (json.isEncrypted) return decryptPayload(json.data);
  return json;
}

async function fetchSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (subsCache.has(key)) return subsCache.get(key);
  try {
    let url = `${PEACHIFY_API}/subs/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    // bounded like every other upstream call — an unbounded hang here would
    // stall the whole /sources response even after the stream resolved. 3s:
    // subs are ENRICHMENT (video plays fine without them) and must never gate
    // playback past the 4s provider-probe ceiling.
    const res = await withTimeout(
      fetch(url, { headers: { Referer: PEACHIFY_REFERER } }),
      3000,
      'peachify subs'
    );
    // Normalize to a stable shape so the player's loadSubtitle always gets a
    // url (raw entries with only `file`/`src` used to flow through with an
    // undefined url — one reason subs showed as "available" but never played).
    const raw = res.ok ? await res.json() : [];
    const subs = (Array.isArray(raw) ? raw : [])
      .map((s) => ({
        url: s.url || s.file || s.src,
        label: s.label || s.language || s.lang || 'Unknown',
        lang: s.lang || s.language || null,
      }))
      .filter((s) => s.url);
    subsCache.set(key, subs);
    return subs;
  } catch (e) {
    return [];
  }
}

// ---- vidnest ----

function vidnestDecode(data) {
  const l = [...String(data)].map((c) => VIDNEST_ALPHABET.indexOf(c));
  const bytes = [];
  for (let o = 0; o + 3 < l.length; o += 4) {
    const a = l[o], b = l[o + 1], c = l[o + 2], d = l[o + 3];
    if (a < 0 || a > 63) break; // padding/junk at the tail
    bytes.push((a << 2) | (b >> 4));
    if (c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d !== 64) bytes.push(((c & 3) << 6) | d);
  }
  return Buffer.from(bytes).toString('utf8');
}

async function fetchVidnestProvider(provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${VIDNEST_API}/${slug}/${type}/${id}`;
  if (type === 'tv') url += `/${season}/${episode}`;
  const res = await withTimeout(
    fetch(url, {
      headers: { Referer: VIDNEST_REFERER, 'User-Agent': STREAM_UA },
    }),
    PROBE_TIMEOUT_MS,
    `vidnest ${provider.name}`
  );
  if (res.status === 502 || res.status === 404) {
    throw new Error(`vidnest ${provider.name}: no source (${res.status})`);
  }
  if (!res.ok) throw new Error(`vidnest ${provider.name} API ${res.status}`);
  const json = await res.json();
  if (!json.data) throw new Error(`vidnest ${provider.name}: unexpected response`);
  return JSON.parse(vidnestDecode(json.data));
}

function vidnestToResult(provider, data) {
  // Decrypted payloads come in three shapes:
  //   {url, headers}                    — animanga relay hosts (videasy, rogflix)
  //   {streams: [{url,type,headers,language}]} — direct mp4/hls (hollymoviehd)
  //   {url, headers, referer, ...}      — direct CDNs (buzz, ngc)
  const items = Array.isArray(data.streams)
    ? data.streams
    : [{ url: data.url, type: data.hls, headers: data.headers, referer: data.referer, label: data.label }];

  const sources = items
    .map((s) => {
      const url = s.url || s.file;
      if (!url) return null;
      return {
        url,
        quality: s.quality || s.resolution || s.label || 'auto',
        isM3U8: s.type === 'hls' || /\.m3u8($|\?)|streamsvr|\/hls\//i.test(url),
        headers: s.headers || null,
        referer: (s.headers && s.headers.Referer) || s.referer || null,
        lang: s.language || null,
      };
    })
    .filter(Boolean);

  return { provider: provider.name, sources, subtitles: [] };
}

async function resolveVidnest({ type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (server) {
    const p = VIDNEST_PROVIDERS.find((x) => x.name === String(server).toLowerCase());
    if (!p) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(p, await fetchVidnestProvider(p, type, id, season, episode));
  }

  // auto: last-known-good provider first, then the rest (some are content-gated
  // and 502 per-title, so cycling matters). Recently-failed providers are skipped.
  const key = titleKey(type, id, season, episode);
  const cached = vidnestCache.get(key);
  const baseOrder = cached
    ? [cached, ...VIDNEST_PROVIDERS.filter((p) => p.name !== cached.name)]
    : VIDNEST_PROVIDERS;
  const order = baseOrder.filter((p) => !isDead('vidnest', p, key));

  // Probe concurrently (same reasoning as the peachify wave): a serial pass
  // over five 6s-timeout endpoints stacked into ~30s on flaky days. First
  // provider in priority order that yields streams wins; failures mark dead.
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) =>
      fetchVidnestProvider(p, type, id, season, episode).then((d) => vidnestToResult(p, d))
    )
  );
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const s = settled[i];
    if (s.status === 'rejected') {
      lastError = s.reason;
      markDead('vidnest', p, key);
      continue;
    }
    if (!s.value.sources.length) continue;
    vidnestCache.set(key, p.name);
    return s.value;
  }
  throw new Error(`No vidnest source found${lastError ? ` (${lastError.message})` : ''}`);
}

// vidnest's subtitles come from a separate API (sub.vdrk.site) serving VTT
// files per language on cache.vdrk.site (CORS-open, playable directly).
async function fetchVidnestSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (vdrkSubsCache.has(key)) return vdrkSubsCache.get(key);
  try {
    let url = `https://sub.vdrk.site/v2/${type}/${id}`;
    if (type === 'tv') url += `/${season}/${episode}`;
    // bounded like every other upstream call; 3s budget — see peachify subs note
    const res = await withTimeout(fetch(url), 3000, 'vidnest subs');
    const list = res.ok ? await res.json() : [];
    const subs = list
      .map((s) => ({ url: s.file || s.url, label: s.label, lang: s.label || null }))
      .filter((s) => s.url);
    vdrkSubsCache.set(key, subs);
    return subs;
  } catch (e) {
    return [];
  }
}

// ---- auto resolution: FIRST-WIN RACE ----
// Every healthy provider from BOTH families is probed at once; the first one
// to return sources WINS immediately — we never wait for the losers. Cold
// start therefore ≈ the fastest healthy upstream (~sub-second), not the 4s
// probe-timeout corpse of some other hanging family. Dead-marks and the
// family breaker run as side effects on every probe, so bookkeeping stays
// correct even for probes still in flight after a winner was taken: a late
// failure counts toward tripping its family breaker, a late success heals it.
async function autoRace(pOrder, vOrder, key, opts) {
  const cand = [];
  // peachify first: exact-arrival ties resolve to it (registered sooner),
  // preserving brand preference wherever speed doesn't differ.
  for (const p of pOrder) cand.push(['peachify', p]);
  for (const p of vOrder) cand.push(['vidnest', p]);

  return await new Promise((resolve) => {
    let left = cand.length;
    if (!left) return resolve({ won: false, lastErr: {} });
    let done = false;
    const lastErr = {};
    const fails = { peachify: 0, vidnest: 0 };
    const totals = { peachify: pOrder.length, vidnest: vOrder.length };
    const finish = (out) => {
      if (!done) {
        done = true;
        resolve(out);
      }
    };
    for (const [fam, p] of cand) {
      (fam === 'peachify'
        ? fetchProvider(p, opts.type, opts.id, opts.season, opts.episode).then((d) =>
            toResult(p, d)
          )
        : fetchVidnestProvider(p, opts.type, opts.id, opts.season, opts.episode).then((d) =>
            vidnestToResult(p, d)
          )
      )
        .then((result) => {
          healFamily(fam); // any HTTP answer means the family is alive
          return { ok: true, fam, p, result };
        })
        .catch((e) => {
          markDead(fam, p, key);
          fails[fam]++;
          lastErr[fam] = e && e.message;
          // whole family rejected (hangs/5xx/DNS) → trip: next titles skip us
          if (fails[fam] === totals[fam]) {
            familyDeadUntil.set(fam, Date.now() + FAMILY_TTL_MS);
          }
          return { ok: false };
        })
        .then((r) => {
          left--;
          // Only the caller-VISIBLE winner records last-known-good: a probe
          // settling after someone else already won must not rewrite the
          // cache with a provider nobody actually played.
          if (r.ok && r.result.sources.length && !done) {
            (fam === 'peachify' ? providerCache : vidnestCache).set(key, r.p.name);
            finish({ won: true, result: r.result });
          } else if (!left && !done) {
            finish({ won: false, lastErr }); // every probe failed or was empty
          }
        });
    }
  });
}

/**
 * Resolve a playable stream for a title using peachify's provider APIs.
 * @param {object} opts { type: 'movie'|'tv', id, season?, episode?,
 *                        server?: provider name to force, e.g. 'multi' }
 * @returns {Promise<{provider, sources: [{url,quality,sizeBytes,isM3U8,headers?}],
 *                    subtitles: [...]}>}
 */
async function resolveStream({ type, id, season, episode, server }) {
  if (type !== 'movie' && type !== 'tv') throw new Error('type must be movie or tv');
  if (server) {
    const name = String(server).toLowerCase();
    // vidnest family first (names don't collide with peachify's)
    const vid = VIDNEST_PROVIDERS.find((x) => x.name === name);
    if (vid) return resolveVidnest({ type, id, season, episode, server: name });

    const p = PROVIDERS.find((x) => x.name === name || x.path === name);
    if (!p) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(p, type, id, season, episode);
    return toResult(p, data, type, id, season, episode);
  }

  // auto: launch every healthy provider across BOTH families simultaneously
  // and take the FIRST source-bearing answer. Historical note: this used to be
  // a serial cycle (~30s worst case), then two waited-out waves (still paid a
  // hanging family's full 4s probe on cold titles). Racing to first success
  // makes cold start ≈ fastest healthy upstream instead of the slowest loser.
  // familyDown gates keep a tripped breaker from launching probes at all.
  const key = titleKey(type, id, season, episode);
  const pc = providerCache.get(key);
  const pOrder = (
    pc ? [pc, ...PROVIDERS.filter((p) => p.name !== pc.name)] : PROVIDERS
  ).filter((p) => !familyDown('peachify') && !isDead('peachify', p, key));
  const vc = vidnestCache.get(key);
  const vOrder = (
    vc ? [vc, ...VIDNEST_PROVIDERS.filter((p) => p.name !== vc.name)] : VIDNEST_PROVIDERS
  ).filter((p) => !familyDown('vidnest') && !isDead('vidnest', p, key));

  const out = await autoRace(pOrder, vOrder, key, { type, id, season, episode });
  if (out.won) return out.result;

  const pe = out.lastErr.peachify || 'no healthy provider';
  const ve = out.lastErr.vidnest || 'no healthy provider';
  throw new Error(`No source found on any provider (peachify: ${pe}; vidnest: ${ve})`);
}

function toResult(provider, data, type, id, season, episode) {
  const sources = (data.sources || [])
    .map((s) => ({
      url: s.url || s.src || s.file,
      quality: s.quality || s.resolution || s.height || 'auto',
      sizeBytes: s.sizeBytes || s.size || null,
      dub: s.dub || null,
      isM3U8: /\.m3u8($|\?)|m3u8-proxy/i.test(s.url || ''),
      headers: s.headers || null,
    }))
    .filter((s) => s.url);

  const subtitles = (data.subtitles || []).map((s) => ({
    url: s.url || s.file || s.src,
    label: s.label || s.language || s.lang || 'Unknown',
    lang: s.lang || s.language || null,
    format: s.format || null,
    encoding: s.encoding || null,
  })).filter((s) => s.url);

  return { provider: provider.name, sources, subtitles };
}

module.exports = {
  resolveStream,
  fetchSubtitles,
  resolveVidnest,
  fetchVidnestSubtitles,
  PROVIDERS,
  VIDNEST_PROVIDERS,
  PEACHIFY_KEY_HEX,
  PEACHIFY_API,
  // internals — exported for the test suite (tests/extractor.test.js)
  decryptPayload,
  vidnestDecode,
  vidnestToResult,
  toResult,
  VIDNEST_ALPHABET,
};

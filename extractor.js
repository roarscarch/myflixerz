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
  const res = await fetch(url, { headers: { Referer: PEACHIFY_REFERER } });
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
    const res = await fetch(url, { headers: { Referer: PEACHIFY_REFERER } });
    const subs = res.ok ? await res.json() : [];
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
  const res = await fetch(url, {
    headers: { Referer: VIDNEST_REFERER, 'User-Agent': STREAM_UA },
  });
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
  // and 502 per-title, so cycling matters)
  const key = titleKey(type, id, season, episode);
  const cached = vidnestCache.get(key);
  const order = cached
    ? [cached, ...VIDNEST_PROVIDERS.filter((p) => p.name !== cached.name)]
    : VIDNEST_PROVIDERS;

  let lastError = null;
  for (const p of order) {
    try {
      const result = vidnestToResult(p, await fetchVidnestProvider(p, type, id, season, episode));
      if (result.sources.length) {
        vidnestCache.set(key, p.name);
        return result;
      }
    } catch (e) {
      lastError = e;
    }
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
    const res = await fetch(url);
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

  // auto: try the last-known-good peachify provider first, then cycle the rest
  // (mirrors the site's player, minus re-requesting empty providers). If every
  // peachify provider comes up empty, fall back to the vidnest family.
  const key = titleKey(type, id, season, episode);
  const cached = providerCache.get(key);
  const order = cached
    ? [cached, ...PROVIDERS.filter((p) => p.name !== cached.name)]
    : PROVIDERS;

  let lastError = null;
  for (const p of order) {
    try {
      const data = await fetchProvider(p, type, id, season, episode);
      const result = toResult(p, data, type, id, season, episode);
      if (result.sources.length) {
        providerCache.set(key, p.name);
        return result;
      }
    } catch (e) {
      lastError = e;
    }
  }

  try {
    return await resolveVidnest({ type, id, season, episode });
  } catch (e) {
    throw new Error(
      `No source found on any provider${lastError ? ` (${lastError.message})` : ''}; vidnest: ${e.message}`
    );
  }
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
};

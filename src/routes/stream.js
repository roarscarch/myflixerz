// src/routes/stream.js — /play proxy with O(1) LRU segment cache & connection reuse
//
// Some source CDNs enforce a Referer or lack CORS for foreign origins. This
// endpoint fetches server-side (with the embed site's referer) and streams back
// with CORS + Range support, rewriting relative HLS segment URLs so the whole
// playlist plays through us. Direct-play URLs (x.eat-peach.sbs proxies) are
// CORS-open and skip this.
const { Router } = require('express');
const { Readable } = require('stream');

// High-performance O(1) LRU cache for proxied media segments.
// HLS fragments (2-10s video, 0.5-4MB) hit memory on seek-back instead of upstream.
// Map preserves insertion order, so deleting and setting moves keys to MRU,
// and map.keys().next().value yields the true LRU in O(1).
const SEGMENT_CACHE = new Map(); // key → { data, type, ts }
const SEGMENT_CACHE_BUDGET = 25 * 1024 * 1024;
const SEGMENT_CACHE_MAX_ITEM = 4 * 1024 * 1024;
const SEGMENT_CACHE_TTL = 5 * 60 * 1000;
let segmentCacheBytes = 0;

function getCachedSegment(key) {
  const hit = SEGMENT_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > SEGMENT_CACHE_TTL) {
    segmentCacheBytes -= hit.data.length;
    SEGMENT_CACHE.delete(key);
    return null;
  }
  // Refresh LRU position
  SEGMENT_CACHE.delete(key);
  SEGMENT_CACHE.set(key, hit);
  return hit;
}

function cacheSegment(key, data, type) {
  if (!data || data.length > SEGMENT_CACHE_MAX_ITEM) return;
  if (SEGMENT_CACHE.has(key)) {
    segmentCacheBytes -= SEGMENT_CACHE.get(key).data.length;
    SEGMENT_CACHE.delete(key);
  }
  // O(1) eviction of oldest items
  while (SEGMENT_CACHE.size && segmentCacheBytes + data.length > SEGMENT_CACHE_BUDGET) {
    const oldestKey = SEGMENT_CACHE.keys().next().value;
    if (!oldestKey) break;
    segmentCacheBytes -= SEGMENT_CACHE.get(oldestKey).data.length;
    SEGMENT_CACHE.delete(oldestKey);
  }
  SEGMENT_CACHE.set(key, { data, type, ts: Date.now() });
  segmentCacheBytes += data.length;
}

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Playlist cache: HLS master/variant playlists are small and mostly stable
// (tokens renew hourly), so cache the REWRITTEN text per URL for a few minutes.
// The startability probe + hls.js both fetch the same master — the second fetch
// is served instantly, making "source selected → first frame" much faster.
const PLAYLIST_CACHE = new Map(); // req.originalUrl -> { text, ts }
const PLAYLIST_CACHE_TTL = 5 * 60 * 1000;
const PLAYLIST_CACHE_MAX = 300;
function getCachedPlaylist(key) {
  const hit = PLAYLIST_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > PLAYLIST_CACHE_TTL) {
    PLAYLIST_CACHE.delete(key);
    return null;
  }
  return hit.text;
}

module.exports = function streamRoutes() {
  const router = Router();

  router.get('/play', async (req, res) => {
    const { url, ref, origin } = req.query;
    if (!url) return res.status(400).json({ error: 'url query parameter is required' });
    const referer = ref || 'https://peachify.top/';
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });

    try {
      const range = req.headers.range;

      // Check LRU segment cache for un-ranged requests (HLS fragments)
      if (!range) {
        const hit = getCachedSegment(req.originalUrl);
        if (hit) {
          return res.set({
            'Content-Type': hit.type,
            'Content-Length': hit.data.length,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          }).send(hit.data);
        }
      }

      // Cached rewritten playlist (master/variant) — serve BEFORE the upstream
      // fetch so a repeat request never pays the CDN round-trip again.
      const cachedPlaylist = getCachedPlaylist(req.originalUrl);
      if (cachedPlaylist) {
        return res.set({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
        }).send(cachedPlaylist);
      }

      const upstream = await fetch(url, {
        headers: {
          Referer: referer,
          'User-Agent': STREAM_UA,
          // Some CDNs (peachify's nextgencloudfabric-backed streams) check the
          // Origin header as well as Referer — pass it through when given.
          ...(origin ? { Origin: origin } : {}),
          ...(range ? { Range: range } : {}),
        },
      });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });
      }

      const ct = upstream.headers.get('content-type') || 'application/octet-stream';
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Content-Type': ct,
        'Cache-Control': 'no-store',
      });
      if (upstream.headers.get('content-range')) res.set('Content-Range', upstream.headers.get('content-range'));

      if (ct.includes('mpegurl') || ct.includes('m3u8')) {
        // Rewrite every media URL in the playlist to go through /play
        const text = await upstream.text();
        const toPlay = (u) => {
          try {
            const abs = new URL(u, url).href;
            const params = new URLSearchParams({ ref: referer });
            if (origin) params.set('origin', origin);
            params.set('url', abs);
            return `/play?${params.toString()}`;
          } catch (e) {
            return null;
          }
        };
        const rewritten = text
          .split('\n')
          .map((line) => {
            const t = line.trim();
            if (!t) return line;
            if (t.startsWith('#')) {
              if (t.startsWith('#EXT-X-MEDIA')) {
                return line.replace(/URI="([^"]+)"/g, (m, u) => {
                  const r = toPlay(u);
                  return r ? `URI="${r}"` : m;
                });
              }
              return line;
            }
            return toPlay(t) || line;
          })
          .join('\n');
        // bound the cache
        if (PLAYLIST_CACHE.size >= PLAYLIST_CACHE_MAX) {
          const oldest = PLAYLIST_CACHE.keys().next().value;
          if (oldest) PLAYLIST_CACHE.delete(oldest);
        }
        PLAYLIST_CACHE.set(req.originalUrl, { text: rewritten, ts: Date.now() });
        res.send(rewritten);
      } else {
        // mp4 / segments / subtitles: stream through (piped, constant memory)
        if (upstream.status === 206) res.status(206);
        const cl = upstream.headers.get('content-length');
        if (cl) res.set('Content-Length', cl);

        await new Promise((resolve, reject) => {
          const body = Readable.fromWeb(upstream.body);
          body.on('error', (e) => {
            res.destroy();
            reject(e);
          });
          res.on('close', resolve);

          // Tee small un-ranged responses (segments) into LRU cache as they flow
          if (!range && cl && Number(cl) > 0 && Number(cl) <= SEGMENT_CACHE_MAX_ITEM) {
            const chunks = [];
            let total = 0;
            body.on('data', (c) => {
              total += c.length;
              if (total <= SEGMENT_CACHE_MAX_ITEM) chunks.push(c);
              else chunks.length = 0;
            });
            body.on('end', () => {
              if (chunks.length && total <= SEGMENT_CACHE_MAX_ITEM) {
                cacheSegment(req.originalUrl, Buffer.concat(chunks), ct);
              }
            });
          }
          body.pipe(res);
        });
      }
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
    }
  });

  return router;
};

module.exports.STREAM_UA = STREAM_UA;

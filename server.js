const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Readable } = require('stream');
const { spawn } = require('child_process');

// Bounded cache for proxied media segments: HLS fragments (2-10s of video,
// usually 0.5-4MB) re-fetched on seek-back hit here instead of the upstream.
// Big files (mp4) exceed MAX_ITEM and never enter it, so streaming a 2GB movie
// still costs constant memory. 5-min TTL — tokenized URLs expire upstream.
const SEGMENT_CACHE = new Map(); // req.originalUrl → { data, type, ts }
const SEGMENT_CACHE_BUDGET = 25 * 1024 * 1024;
const SEGMENT_CACHE_MAX_ITEM = 4 * 1024 * 1024;
const SEGMENT_CACHE_TTL = 5 * 60 * 1000;
let segmentCacheBytes = 0;
function cacheSegment(key, data, type) {
  if (data.length > SEGMENT_CACHE_MAX_ITEM) return;
  if (SEGMENT_CACHE.has(key)) segmentCacheBytes -= SEGMENT_CACHE.get(key).data.length;
  while (SEGMENT_CACHE.size && segmentCacheBytes + data.length > SEGMENT_CACHE_BUDGET) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [k, v] of SEGMENT_CACHE) {
      if (v.ts < oldestTs) {
        oldestTs = v.ts;
        oldestKey = k;
      }
    }
    if (!oldestKey) break;
    segmentCacheBytes -= SEGMENT_CACHE.get(oldestKey).data.length;
    SEGMENT_CACHE.delete(oldestKey);
  }
  SEGMENT_CACHE.set(key, { data, type, ts: Date.now() });
  segmentCacheBytes += data.length;
}
const FlixHQ = require('./flixhq');
const Render = require('./public/js/render.js'); // shared with app.js — markup never drifts

const app = express();
const flixhq = new FlixHQ();
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Rate limiting — API metadata calls only. Static files and /play (which
// streams HLS segments — hundreds per movie) must never count against it.
// /download also streams for minutes at a time; one download must not burn
// the API quota.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  skip: (req) => req.path.startsWith('/play') || req.path.startsWith('/download'),
});

app.use(cors());
app.use(compression()); // gzip/brotli on every response (JSON, HTML, static)
app.use(express.json());

// Health check for container orchestration — defined before the limiter so
// probes never count against the API quota.
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
});

// ---- SSR: pre-render the home view into the shell (instant first paint) ----
// The rows + the movies-grid page 1 are fetched in-process (cached, parallel)
// and injected into the HTML, so the landing page paints with zero client JS
// and zero round-trips. Served before static/limiter like /health. Any
// failure falls through to the plain client-rendered page — SSR is an
// enhancement, never a gate.
const norm = (d) => (Array.isArray(d) ? d : (d && d.results) || []);
app.get('/', async (req, res, next) => {
  try {
    const [trendingMovies, trendingTv, imdb75, recent, topRated, browseMovies] = await Promise.all([
      flixhq.fetchTrendingMovies(),
      flixhq.fetchTrendingTvShows(),
      flixhq.fetchTopIMDB('movie', 1, 7.5),
      flixhq.fetchRecentMovies(),
      flixhq.fetchTopIMDB('all', 1),
      flixhq.fetchMoviesByPage(1),
    ]);
    const homeHtml = Render.homeView({
      trendingMovies: norm(trendingMovies),
      trendingTv: norm(trendingTv),
      imdb75: norm(imdb75),
      recent: norm(recent),
      topRated: norm(topRated),
    });
    const initial = JSON.stringify({ browse: { movies: norm(browseMovies), imdb75: norm(imdb75) } });
    const html = INDEX_HTML
      .replace('<main id="view"></main>', `<main id="view" data-ssr-home>${homeHtml}</main>`)
      .replace('</body>', `<script>window.__INITIAL__ = ${initial};</script></body>`);
    res.set('Cache-Control', 'no-cache').type('html').send(html);
  } catch (e) {
    console.warn('SSR failed — serving client-rendered page:', e.message);
    next();
  }
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '7d', // versioned assets (?v=N) are immutable; harmless for the rest
    setHeaders(res, filePath) {
      // sw.js must revalidate every load (stale SW = stale caches forever);
      // index.html is revalidated so new ?v= references reach browsers fast
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);
app.use(limiter);

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Search endpoint
app.get('/search', async (req, res) => {
  try {
    const { query, page = 1 } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required' });
    }
    const results = await flixhq.search(query, parseInt(page));
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Media info endpoint with better error handling
app.get('/info/:mediaId(*)', async (req, res) => {
  try {
    const { mediaId } = req.params;
    if (!mediaId) {
      return res.status(400).json({ error: 'Media ID is required' });
    }
    
    // Validate mediaId format
    if (!mediaId.match(/^(movie|tv)\/[\w-]+$/)) {
      return res.status(400).json({ error: 'Invalid media ID format' });
    }

    const info = await flixhq.fetchMediaInfo(mediaId);
    if (!info) {
      return res.status(404).json({ error: 'Media not found' });
    }
    res.json(info);
  } catch (error) {
    if (error.message.includes('404')) {
      res.status(404).json({ error: 'Media not found' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Episode sources endpoint with validation
app.get('/sources/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { mediaId, server } = req.query;
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId query parameter is required' });
    }
    if (!episodeId) {
      return res.status(400).json({ error: 'Episode ID is required' });
    }
    const sources = await flixhq.fetchEpisodeSources(episodeId, mediaId, server);
    if (!sources) {
      return res.status(404).json({ error: 'Sources not found' });
    }
    res.json(sources);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Episode servers endpoint with validation
app.get('/servers/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { mediaId } = req.query;
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId query parameter is required' });
    }
    if (!episodeId) {
      return res.status(400).json({ error: 'Episode ID is required' });
    }
    const servers = await flixhq.fetchEpisodeServers(episodeId, mediaId);
    if (!servers || servers.length === 0) {
      return res.status(404).json({ error: 'No servers found' });
    }
    res.json(servers);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Subtitle tracks only — a SEPARATE endpoint so /sources stays stream-only and
// answers as fast as possible. The browser fires both in parallel and attaches
// tracks whenever these arrive (even several seconds after playback started).
app.get('/subtitles/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { mediaId } = req.query;
    if (!mediaId) return res.status(400).json({ error: 'mediaId query parameter is required' });
    if (!episodeId) return res.status(400).json({ error: 'Episode ID is required' });
    const subtitles = await flixhq.fetchEpisodeSubtitles(episodeId, mediaId);
    res.json({ subtitles });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Audio languages across dub-capable servers (populates the audio dropdown)
app.get('/dubs/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { mediaId } = req.query;
    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId query parameter is required' });
    }
    const dubs = await flixhq.fetchDubs(episodeId, mediaId);
    res.json(dubs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent movies endpoint
app.get('/recent/movies', async (req, res) => {
  try {
    const movies = await flixhq.fetchRecentMovies();
    res.json(movies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Recent TV shows endpoint
app.get('/recent/tv', async (req, res) => {
  try {
    const tvShows = await flixhq.fetchRecentTvShows();
    res.json(tvShows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trending movies endpoint
app.get('/trending/movies', async (req, res) => {
  try {
    const movies = await flixhq.fetchTrendingMovies();
    res.json(movies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trending TV shows endpoint
app.get('/trending/tv', async (req, res) => {
  try {
    const tvShows = await flixhq.fetchTrendingTvShows();
    res.json(tvShows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Movies by page endpoint
app.get('/movies', async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const movies = await flixhq.fetchMoviesByPage(parseInt(page));
    res.json(movies);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TV shows by page endpoint
app.get('/tv', async (req, res) => {
  try {
    const { page = 1 } = req.query;
    const tvShows = await flixhq.fetchTvShowsByPage(parseInt(page));
    res.json(tvShows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Genre endpoint
app.get('/genre/:genre', async (req, res) => {
  try {
    const { genre } = req.params;
    const { page = 1 } = req.query;
    const results = await flixhq.fetchByGenre(genre, parseInt(page));
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Top IMDB endpoint
app.get('/top-imdb', async (req, res) => {
  try {
    const { type = 'all', page = 1, minVote } = req.query;
    const results = await flixhq.fetchTopIMDB(type, parseInt(page), minVote ? parseFloat(minVote) : undefined);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Movie embed links endpoint
app.get('/movie/embed/:movieId', async (req, res) => {
  try {
    const { movieId } = req.params;
    const links = await flixhq.fetchMovieEmbedLinks(movieId);
    res.json(links);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// TV episode embed links endpoint
app.get('/tv/embed/:episodeId', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const links = await flixhq.fetchTvEpisodeEmbedLinks(episodeId);
    res.json(links);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add this new endpoint before the existing movie embed links endpoint
app.get('/movie/embed/:movieId/server', async (req, res) => {
  try {
    const { movieId } = req.params;
    const { server } = req.query;

    if (!server) {
      return res.status(400).json({ 
        error: 'Server parameter is required' 
      });
    }

    const source = await flixhq.fetchMovieEmbedLinks(movieId, server);
    res.json(source);
  } catch (err) {
    console.error('Error in movie server endpoint:', err);
    res.status(err.message.includes('not found') ? 404 : 500).json({ 
      error: err.message 
    });
  }
});

// Add this new endpoint before the existing TV episode embed links endpoint
app.get('/tv/embed/:episodeId/server', async (req, res) => {
  try {
    const { episodeId } = req.params;
    const { server } = req.query;

    if (!server) {
      return res.status(400).json({
        error: 'Server parameter is required'
      });
    }

    const source = await flixhq.fetchTvEpisodeEmbedLinks(episodeId, server);
    res.json(source);
  } catch (err) {
    console.error('Error in TV episode server endpoint:', err);
    res.status(err.message.includes('not found') ? 404 : 500).json({
      error: err.message
    });
  }
});

// ---- stream pass-through proxy ----
// Some source CDNs enforce a Referer or lack CORS for foreign origins. This
// endpoint fetches server-side (with the embed site's referer) and streams back
// with CORS + Range support, rewriting relative HLS segment URLs so the whole
// playlist plays through us. Direct-play URLs (x.eat-peach.sbs proxies) are
// CORS-open and skip this.
const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

app.get('/play', async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });
  const referer = ref || 'https://peachify.top/';
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });

  try {
    const range = req.headers.range;
    const upstream = await fetch(url, {
      headers: {
        Referer: referer,
        'User-Agent': STREAM_UA,
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
      // Rewrite every media URL in the playlist to go through /play:
      //  - bare relative lines (segment .ts, level .m3u8)
      //  - URI="..." inside #EXT-X-MEDIA lines (audio/subtitle groups)
      //  - absolute URLs too (they need our referer header; the browser's
      //    referer would be our origin, which CDNs may reject)
      const text = await upstream.text();
      const toPlay = (u) => {
        try {
          const abs = new URL(u, url).href;
          return `/play?ref=${encodeURIComponent(referer)}&url=${encodeURIComponent(abs)}`;
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
      res.send(rewritten);
    } else {
      // mp4 / segments / subtitles: stream through (piped, constant memory —
      // buffering a 2GB movie into RAM would OOM a small server)
      const range = req.headers.range;
      // HLS segments are fetched without Range — serve cached copies locally
      // (seek-back becomes instant, no upstream round-trip)
      if (!range) {
        const hit = SEGMENT_CACHE.get(req.originalUrl);
        if (hit && Date.now() - hit.ts < SEGMENT_CACHE_TTL) {
          return res.set({
            'Content-Type': hit.type,
            'Content-Length': hit.data.length,
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
          }).send(hit.data);
        }
      }
      if (upstream.status === 206) res.status(206);
      const cl = upstream.headers.get('content-length');
      if (cl) res.set('Content-Length', cl);
      await new Promise((resolve, reject) => {
        const body = Readable.fromWeb(upstream.body);
        body.on('error', (e) => {
          res.destroy();
          reject(e);
        });
        res.on('close', resolve); // normal finish or client abort — either way done
        // tee small un-ranged responses (segments) into the cache as they flow
        if (!range && cl && Number(cl) > 0 && Number(cl) <= SEGMENT_CACHE_MAX_ITEM) {
          const chunks = [];
          let total = 0;
          body.on('data', (c) => {
            total += c.length;
            if (total <= SEGMENT_CACHE_MAX_ITEM) chunks.push(c);
            else chunks.length = 0; // grew past the cap — stop caching
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
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
});

// Download endpoint — saves the current stream to disk.
//  - direct sources, no subs: streamed through (constant memory, no ffmpeg)
//  - anything with subs= (or hls=1): remuxed by ffmpeg into a playable .mp4 —
//    video copied (never re-encoded), audio re-encoded to AAC for HLS (copied
//    for direct sources), subtitle tracks converted to mp4 text (mov_text),
//    fragmented moov so a partial file is still playable.
// `subs` = "url|label" pairs, comma-separated. If a subtitle input fails,
// the download retries once without subs rather than dying.
app.get('/download', (req, res) => {
  const { url, ref, title, hls, subs } = req.query;
  if (!url) return res.status(400).json({ error: 'url query parameter is required' });
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });
  const referer = ref || 'https://peachify.top/';
  const base = String(title || 'cinephiles-download')
    .replace(/[^\w\- ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'cinephiles-download';
  const tracks = String(subs || '')
    .split(',')
    .map((t, i) => {
      const [u, ...rest] = t.split('|');
      if (!u || !/^https?:\/\//i.test(u)) return null;
      return { url: u, label: rest.join('|').slice(0, 60) || `Subtitle ${i + 1}` };
    })
    .filter(Boolean)
    .slice(0, 12); // cap the track count — no point muxing 50 languages
  const remux = hls === '1' || tracks.length > 0;

  res.set({
    'Content-Disposition': `attachment; filename="${base}.${remux ? 'mp4' : (path.extname(new URL(url).pathname).replace(/[^a-z0-9]/gi, '') || 'mp4')}"`,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });

  if (!remux) {
    // direct source, no subs: stream through like /play, flagged as a download
    fetch(url, { headers: { Referer: referer, 'User-Agent': STREAM_UA } })
      .then((up) => {
        if (!up.ok && up.status !== 206) return res.status(up.status).json({ error: `Upstream ${up.status}` });
        res.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
        const cl = up.headers.get('content-length');
        if (cl) res.set('Content-Length', cl);
        return new Promise((resolve, reject) => {
          const body = Readable.fromWeb(up.body);
          body.on('error', (e) => {
            res.destroy();
            reject(e);
          });
          res.on('close', resolve);
          body.pipe(res);
        });
      })
      .catch((e) => {
        if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
      });
    return;
  }

  res.set('Content-Type', 'video/mp4');
  const headers = `Referer: ${referer}\r\nUser-Agent: ${STREAM_UA}\r\n`;
  const buildArgs = (includeSubs) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-headers', headers, '-i', url];
    if (includeSubs) for (const t of tracks) args.push('-i', t.url);
    args.push('-map', '0:v:0', '-map', '0:a?');
    if (includeSubs) tracks.forEach((_, i) => args.push('-map', `${i + 1}:0`));
    args.push('-c:v', 'copy', '-c:a', hls === '1' ? 'aac' : 'copy');
    if (includeSubs) {
      args.push('-c:s', 'mov_text');
      tracks.forEach((t, i) => args.push(`-metadata:s:s:${i}`, `title=${t.label}`));
    }
    args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
    return args;
  };

  let stderr = '';
  let aborted = false;
  let ff = null;

  const start = (includeSubs) => {
    ff = spawn('ffmpeg', buildArgs(includeSubs), { stdio: ['ignore', 'pipe', 'pipe'] });
    stderr = '';
    ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2048)));
    ff.stdout.on('error', () => {});
    ff.on('error', (e) => {
      // ENOENT = ffmpeg not installed
      if (res.headersSent) return;
      res.status(e.code === 'ENOENT' ? 503 : 502).json({
        error:
          e.code === 'ENOENT'
            ? 'ffmpeg is not installed on this server — downloads with subtitles need it (sudo apt install ffmpeg)'
            : `ffmpeg failed to start: ${e.message}`,
      });
    });
    ff.on('close', (code) => {
      if (aborted) return;
      if (res.headersSent) return res.end();
      // failed before producing output: if subtitle inputs were involved,
      // one of them is probably dead — retry once without them
      if (includeSubs) return start(false);
      res.status(502).json({ error: `ffmpeg exited before producing output (code ${code}): ${stderr.slice(-400)}` });
    });
    ff.stdout.pipe(res);
  };

  res.on('close', () => {
    aborted = true;
    if (ff && !ff.killed) ff.kill();
  });
  start(tracks.length > 0);
});

// SPA fallback: unknown GETs serve the frontend
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3000;
// Vercel serverless: @vercel/node needs the app exported. Locally we listen
// with Express directly; the lambda bridge uses the export instead.
module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}
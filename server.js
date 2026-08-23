const express = require('express');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Readable } = require('stream');
const FlixHQ = require('./flixhq');

const app = express();
const flixhq = new FlixHQ();

// Rate limiting — API metadata calls only. Static files and /play (which
// streams HLS segments — hundreds per movie) must never count against it.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  skip: (req) => req.path.startsWith('/play'),
});

app.use(cors());
app.use(express.json());

// Health check for container orchestration — defined before the limiter so
// probes never count against the API quota.
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
});

app.use(express.static(path.join(__dirname, 'public')));
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
    const { type = 'all', page = 1 } = req.query;
    const results = await flixhq.fetchTopIMDB(type, parseInt(page));
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
        body.pipe(res);
      });
    }
  } catch (e) {
    res.status(502).json({ error: `Proxy error: ${e.message}` });
  }
});

// SPA fallback: unknown GETs serve the frontend
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
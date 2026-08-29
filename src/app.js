// src/app.js — Express application setup, SSR, middleware & route mounting
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const TMDBService = require('./services/tmdb');
const Render = require('../public/js/render.js');

const mediaRoutes = require('./routes/media');
const browseRoutes = require('./routes/browse');
const embedRoutes = require('./routes/embed');
const streamRoutes = require('./routes/stream');
const downloadRoutes = require('./routes/download');

const app = express();
const tmdb = new TMDBService();

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
} catch (e) {
  console.warn('Could not load index.html during initialization:', e.message);
}

// 1. Core middlewares
app.use(cors());
app.use(compression());
app.use(express.json());

// 2. Health check (exempt from rate limiter and logging overhead)
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), ts: Date.now() });
});

// 3. SSR: pre-render the home view for instant first paint
const norm = (d) => (Array.isArray(d) ? d : (d && d.results) || []);
app.get('/', async (req, res, next) => {
  try {
    if (!INDEX_HTML) {
      INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    }
    const [trendingMovies, trendingTv, imdb75, recent, topRated, browseMovies] = await Promise.all([
      tmdb.fetchTrendingMovies(),
      tmdb.fetchTrendingTvShows(),
      tmdb.fetchTopIMDB('movie', 1, 7.5),
      tmdb.fetchRecentMovies(),
      tmdb.fetchTopIMDB('all', 1),
      tmdb.fetchMoviesByPage(1),
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
    console.warn('SSR fallback to client rendering:', e.message);
    next();
  }
});

// 4. Static files with caching rules
app.use(
  express.static(PUBLIC_DIR, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// 5. Rate limiting for metadata API calls
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  skip: (req) => req.path.startsWith('/play') || req.path.startsWith('/download'),
});
app.use(limiter);

// 6. Request logging
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  }
  next();
});

// 7. Mount routes
app.use(mediaRoutes(tmdb));
app.use(browseRoutes(tmdb));
app.use(embedRoutes(tmdb));
app.use(streamRoutes());
app.use(downloadRoutes());

// 8. SPA fallback
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  next();
});

// 9. Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Something broke!' });
  }
});

module.exports = app;

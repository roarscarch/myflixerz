// src/routes/media.js — /search, /info, /sources, /subtitles, /servers, /dubs
const { Router } = require('express');

module.exports = function mediaRoutes(tmdb) {
  const router = Router();

  // Search endpoint
  router.get('/search', async (req, res) => {
    try {
      const { query, page = 1 } = req.query;
      if (!query) {
        return res.status(400).json({ error: 'Query parameter is required' });
      }
      const results = await tmdb.search(query, parseInt(page));
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Media info endpoint with better error handling
  router.get('/info/:mediaId(*)', async (req, res) => {
    try {
      const { mediaId } = req.params;
      if (!mediaId) {
        return res.status(400).json({ error: 'Media ID is required' });
      }
      
      // Validate mediaId format
      if (!mediaId.match(/^(movie|tv)\/[\w-]+$/)) {
        return res.status(400).json({ error: 'Invalid media ID format' });
      }

      const info = await tmdb.fetchMediaInfo(mediaId);
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
  router.get('/sources/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId, server, skip } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      if (!episodeId) {
        return res.status(400).json({ error: 'Episode ID is required' });
      }
      const skipList = skip ? String(skip).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const sources = await tmdb.fetchEpisodeSources(episodeId, mediaId, server, skipList);
      if (!sources) {
        return res.status(404).json({ error: 'Sources not found' });
      }
      res.json(sources);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Episode servers endpoint with validation
  router.get('/servers/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      if (!episodeId) {
        return res.status(400).json({ error: 'Episode ID is required' });
      }
      const servers = await tmdb.fetchEpisodeServers(episodeId, mediaId);
      if (!servers || servers.length === 0) {
        return res.status(404).json({ error: 'No servers found' });
      }
      res.json(servers);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Serve unzipped & WebVTT-converted SubDL subtitles
  router.get('/subtitles/subdl', async (req, res) => {
    try {
      const { zip, ep } = req.query;
      if (!zip) return res.status(400).json({ error: 'zip parameter is required' });
      const { fetchSubdlVtt } = require('../services/subtitles');
      const vtt = await fetchSubdlVtt(zip, ep);
      res.set({
        'Content-Type': 'text/vtt; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400',
      });
      res.send(vtt);
    } catch (error) {
      res.status(502).json({ error: `Subtitle fetch error: ${error.message}` });
    }
  });

  // Subtitle tracks only — a SEPARATE endpoint so /sources stays stream-only and
  // answers as fast as possible. The browser fires both in parallel and attaches
  // tracks whenever these arrive (even several seconds after playback started).
  router.get('/subtitles/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) return res.status(400).json({ error: 'mediaId query parameter is required' });
      if (!episodeId) return res.status(400).json({ error: 'Episode ID is required' });
      const subtitles = await tmdb.fetchEpisodeSubtitles(episodeId, mediaId);
      res.json({ subtitles });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Audio languages across dub-capable servers (populates the audio dropdown)
  router.get('/dubs/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { mediaId } = req.query;
      if (!mediaId) {
        return res.status(400).json({ error: 'mediaId query parameter is required' });
      }
      const dubs = await tmdb.fetchDubs(episodeId, mediaId);
      res.json(dubs);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};

// src/routes/embed.js — /movie/embed/*, /tv/embed/*
const { Router } = require('express');

module.exports = function embedRoutes(tmdb) {
  const router = Router();

  // Movie embed links endpoint
  router.get('/movie/embed/:movieId', async (req, res) => {
    try {
      const { movieId } = req.params;
      const links = await tmdb.fetchMovieEmbedLinks(movieId);
      res.json(links);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // TV episode embed links endpoint
  router.get('/tv/embed/:episodeId', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const links = await tmdb.fetchTvEpisodeEmbedLinks(episodeId);
      res.json(links);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Movie embed links with server selection
  router.get('/movie/embed/:movieId/server', async (req, res) => {
    try {
      const { movieId } = req.params;
      const { server } = req.query;

      if (!server) {
        return res.status(400).json({ 
          error: 'Server parameter is required' 
        });
      }

      const source = await tmdb.fetchMovieEmbedLinks(movieId, server);
      res.json(source);
    } catch (err) {
      console.error('Error in movie server endpoint:', err);
      res.status(err.message.includes('not found') ? 404 : 500).json({ 
        error: err.message 
      });
    }
  });

  // TV episode embed links with server selection
  router.get('/tv/embed/:episodeId/server', async (req, res) => {
    try {
      const { episodeId } = req.params;
      const { server } = req.query;

      if (!server) {
        return res.status(400).json({
          error: 'Server parameter is required'
        });
      }

      const source = await tmdb.fetchTvEpisodeEmbedLinks(episodeId, server);
      res.json(source);
    } catch (err) {
      console.error('Error in TV episode server endpoint:', err);
      res.status(err.message.includes('not found') ? 404 : 500).json({
        error: err.message
      });
    }
  });

  return router;
};

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const FlixHQ = require('./flixhq');

const app = express();
const flixhq = new FlixHQ();

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});

app.use(cors());
app.use(express.json());
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); 
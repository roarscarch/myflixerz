const axios = require('axios');
const { TvType } = require('../utils/constants');
const { resolveStream, fetchSubtitles, fetchVidnestSubtitles, PROVIDERS, VIDNEST_PROVIDERS } = require('./extractor');
const { fetchEnglishSubtitles } = require('./subtitles'); // primary English subtitle source

// Public TMDB key used by myflixerfree.to (override via TMDB_API_KEY env).
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

// Stream servers = peachify's internal providers (Horizon/Wolf/Spider/Multi/Iron)
// plus vidnest's (Videasy/HollyMovie/Rogflix/Buzz/NGC). Each is a direct JSON
// API — no scraping, no browser. resolveStream dispatches by name.
const SERVERS = [...PROVIDERS, ...VIDNEST_PROVIDERS];

// Subtitle lookups are ENRICHMENT, never a playback gate: race them against a
// short deadline and serve whatever landed ([] on overrun). The underlying
// fetches stay bounded (extractor) so sockets don't linger either.
function withDeadline(promise, ms) {
  let t;
  const cap = new Promise((resolve) => {
    t = setTimeout(() => resolve([]), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(t));
}

class FlixHQ {
  constructor() {
    this.name = 'MyFlixHQ';
    this.baseUrl = 'https://myflixerfree.to';
    this.tmdb = axios.create({ baseURL: TMDB_BASE, params: { api_key: TMDB_API_KEY } });
    this._genresCache = null;
    this._cache = new Map(); // { key → { exp, promise } } TTL cache, in-flight dedupe
  }

  // ---- helpers ----

  /**
   * TTL cache with in-flight dedupe: concurrent identical calls share one
   * upstream fetch; repeat calls within ttlMs resolve instantly. Rejected
   * promises evict themselves so errors don't get stuck in the cache.
   */
  _cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit) {
      if (hit.exp > now) return hit.promise;
      this._cache.delete(key);
    }
    const p = Promise.resolve()
      .then(fn)
      .then((v) => {
        this._cache.set(key, { exp: Date.now() + ttlMs, promise: Promise.resolve(v) });
        return v;
      })
      .catch((e) => {
        this._cache.delete(key);
        throw e;
      });
    this._cache.set(key, { exp: now + ttlMs, promise: p });
    if (this._cache.size > 600) {
      const t = Date.now();
      for (const [k, v] of this._cache) if (v.exp < t) this._cache.delete(k);
    }
    return p;
  }

  // TMDB imdb_id for a title — used by the OpenSubtitles subtitle search.
  // Long cache: an imdb id is stable for the life of the title.
  _imdbId(type, id) {
    return this._cached(`imdb:${type}:${id}`, 7 * 24 * 60 * 60 * 1000, async () => {
      try {
        const { data } = await this.tmdb.get(`/${type}/${id}/external_ids`);
        return data.imdb_id || null;
      } catch (e) {
        return null;
      }
    });
  }

  _img(path) {
    return path ? `${IMAGE_BASE}${path}` : null;
  }

  _playerUrl(type, id, title, season, episode) {
    const params = new URLSearchParams({ id, type, title: title || 'Watch Now' });
    if (type === 'tv' && season && episode) {
      params.set('season', season);
      params.set('episode', episode);
    }
    return `${this.baseUrl}/player?${params.toString()}`;
  }

  _item(id, tmdbItem, type) {
    const title = tmdbItem.title || tmdbItem.name;
    return {
      id: `${type}/${tmdbItem.id}`,
      title,
      url: this._playerUrl(type, tmdbItem.id, title),
      image: this._img(tmdbItem.poster_path || tmdbItem.backdrop_path),
      releaseDate: (tmdbItem.release_date || tmdbItem.first_air_date || '').split('-')[0] || undefined,
      type: type === 'movie' ? TvType.MOVIE : TvType.TVSERIES,
      rating: tmdbItem.vote_average || 0, // 0–10 score — powers the ★ chip on cards
    };
  }

  async _genres() {
    if (!this._genresCache) {
      const [{ data: movies }, { data: tv }] = await Promise.all([
        this.tmdb.get('/genre/movie/list'),
        this.tmdb.get('/genre/tv/list'),
      ]);
      const map = {};
      [...movies.genres, ...tv.genres].forEach((g) => {
        map[g.name.toLowerCase()] = g.id;
      });
      this._genresCache = map;
    }
    return this._genresCache;
  }

  async _discover(type, page, extra = {}) {
    // 10 min TTL — browse pages rarely change minute-to-minute
    const key = `discover:${type}:${page}:${JSON.stringify(extra)}`;
    return this._cached(key, 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get(`/discover/${type}`, {
        params: { page, sort_by: 'popularity.desc', ...extra },
      });
      return {
        currentPage: data.page,
        hasNextPage: data.page < data.total_pages,
        results: data.results.map((r) => this._item(type, r, type)),
      };
    });
  }

  // ---- search ----

  async search(query, page = 1) {
    // 5 min TTL — search feels instant on repeat/back-navigation
    return this._cached(`search:${query}:${page}`, 5 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/search/multi', {
        params: { query, page, include_adult: 'false' },
      });
      const results = data.results
        .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
        .map((r) => this._item(r.media_type, r, r.media_type));
      return { currentPage: data.page, hasNextPage: data.page < data.total_pages, results };
    });
  }

  // ---- media info ----

  async fetchMediaInfo(mediaId) {
    // 15 min TTL — info pages + their episode lists are the slowest endpoint
    // (TV does one request per season); caching makes repeat visits instant.
    return this._cached(`info:${mediaId}`, 15 * 60 * 1000, async () => {
      const [type, id] = mediaId.split('/');
      if (type !== 'movie' && type !== 'tv') throw new Error('Invalid media ID format');

      const { data } = await this.tmdb.get(`/${type}/${id}`, {
        params: { append_to_response: 'credits,recommendations,videos' },
      });

      const title = data.title || data.name;
      const info = {
        id: `${type}/${data.id}`,
        title,
        url: this._playerUrl(type, data.id, title),
        cover: this._img(data.backdrop_path),
        image: this._img(data.poster_path),
        description: data.overview,
        type: type === 'movie' ? TvType.MOVIE : TvType.TVSERIES,
        releaseDate: data.release_date || data.first_air_date,
        genres: (data.genres || []).map((g) => g.name),
        casts: (data.credits?.cast || []).slice(0, 15).map((c) => c.name),
        production: (data.production_companies || []).slice(0, 3).map((c) => c.name),
        country: (data.production_countries || []).map((c) => c.name),
        duration: type === 'movie' ? `${data.runtime || 0} min` : undefined,
        rating: data.vote_average || 0,
        recommendations: (data.recommendations?.results || []).slice(0, 12).map((r) => this._item(type, r, type)),
      };

      // episodes for TV — ALL seasons fetched in parallel (was sequential:
      // 8 seasons = 8 round-trips ≈ 2.5s; now ≈ one round-trip)
      if (type === 'tv') {
        const seasonCount = Math.min(data.number_of_seasons || 0, 10);
        const seasonResults = await Promise.all(
          Array.from({ length: seasonCount }, (_, i) =>
            this.tmdb
              .get(`/tv/${id}/season/${i + 1}`)
              .then((r) => r.data.episodes || [])
              .catch(() => null) // season with no episodes — skip, keep the rest
          )
        );
        info.episodes = [];
        seasonResults.forEach((eps, i) => {
          if (!eps) return;
          const s = i + 1;
          for (const ep of eps) {
            info.episodes.push({
              id: `${s}-${ep.episode_number}`,
              title: ep.name,
              number: ep.episode_number,
              season: s,
              url: this._playerUrl('tv', data.id, title, s, ep.episode_number),
            });
          }
        });
      } else {
        info.episodes = [{ id, title, number: 1, season: 1, url: this._playerUrl('movie', data.id, title) }];
      }

      return info;
    });
  }

  // ---- servers & sources ----

  async fetchEpisodeServers() {
    return SERVERS.map((s) => ({ name: s.name }));
  }

  async fetchEpisodeSources(episodeId, mediaId, server = null) {
    // 60s TTL: server-button churn on the watch page is instant, while token
    // expiries are still too short for anything longer. resolveStream already
    // negative-caches dead providers, so a stale hit that 404s just falls
    // through to the auto-cycle.
    return this._cached(`sources:${episodeId}:${mediaId}:${server || 'auto'}`, 60 * 1000, () => this._episodeSources(episodeId, mediaId, server));
  }

  // Shared mediaId/episodeId parsing for the sources and subtitles endpoints.
  _parseMedia(episodeId, mediaId) {
    const [type, id] = String(mediaId).split('/');
    if (!type || !id) throw new Error('mediaId must be movie/{id} or tv/{id}');

    let season = 1;
    let episode = 1;
    if (type === 'tv') {
      const m = String(episodeId || '').match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (String(episodeId).includes('-')) {
        [season, episode] = String(episodeId).split('-');
      }
    }
    return { type, id, season, episode };
  }

  // Merge OpenSubtitles-first English with the built-in family tracks, deduped.
  _mergeSubtitles(osSubs, subs, vsubs) {
    const isEn = (s) => /english|\beng\b|\ben\b/i.test(`${s.label || ''} ${s.lang || ''}`);
    const builtIn = [...subs, ...vsubs]; // peachify + vidnest title-level subs
    const merged = osSubs.length
      ? [...osSubs, ...builtIn.filter((s) => !isEn(s))] // OS owns EN; keep non-EN
      : builtIn; // OS empty/unconfigured → existing family sources
    const seen = new Set();
    return merged.filter((s) => {
      const k = s.label || s.lang || 'unknown';
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * Subtitle tracks ONLY. The browser fires this IN PARALLEL with playback and
   * attaches tracks whenever it lands — so unlike /sources there is no reason
   * to be stingy: generous-but-bounded budget, never blocking first frame.
   */
  async fetchEpisodeSubtitles(episodeId, mediaId) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const budgetMs = 6000;
    const imdbP = this._imdbId(type, id);
    const [subs, vsubs, osSubs] = await Promise.all([
      withDeadline(fetchSubtitles(type, id, season, episode), budgetMs),
      withDeadline(fetchVidnestSubtitles(type, id, season, episode), budgetMs),
      withDeadline(
        imdbP.then((imdbId) =>
          imdbId ? fetchEnglishSubtitles({ type, imdbId, season, episode }) : []
        ),
        budgetMs
      ),
    ]);
    return this._mergeSubtitles(osSubs, subs, vsubs);
  }

  async _episodeSources(episodeId, mediaId, server = null) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);

    // FIRST FRAME IS THE ONLY CONTRACT ON THIS PATH. Zero subtitle work — not
    // even deadline-raced. Tracks are decoration the browser pulls separately
    // from GET /subtitles (fetchEpisodeSubtitles) and attaches after playback
    // starts, so even a fully dead subtitle API cannot delay one frame here.
    const stream = await resolveStream({ type, id, season, episode, server });

    const embedUrl = this._playerUrl(type, id, '', season, episode);
    return {
      headers: { Referer: 'https://peachify.top/' },
      sources: stream.sources,
      subtitles: [], // intentionally empty — tracks come from /subtitles
      provider: stream.provider,
      server: stream.provider,
      embedUrl,
    };
  }

  async fetchMovieEmbedLinks(movieId, serverName = null) {
    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream({ type: 'movie', id: movieId, server: s.name });
        results.push({
          server: s.name,
          url: stream.sources[0]?.url || null,
          isM3U8: stream.sources[0]?.isM3U8 ?? false,
        });
      } catch (e) {
        console.error(`[embed] ${s.name} failed for ${movieId}:`, e.message);
      }
    }
    return { id: movieId, sources: results };
  }

  async fetchTvEpisodeEmbedLinks(episodeId, serverName = null) {
    // episodeId format: {season}-{episode}?{tvId} -> tvId comes from mediaId query in server.js;
    // here we parse "tvId:s-e" when passed directly.
    const [tvId, se] = episodeId.includes(':') ? episodeId.split(':') : [null, episodeId];
    if (!tvId) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const m = se.match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('episodeId must be tvId:s{e} e.g. 1396:1-3');
    const [, season, episode] = m;

    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream({ type: 'tv', id: tvId, season, episode, server: s.name });
        results.push({
          server: s.name,
          url: stream.sources[0]?.url || null,
          isM3U8: stream.sources[0]?.isM3U8 ?? false,
        });
      } catch (e) {
        console.error(`[embed] ${s.name} failed for tv ${tvId} ${se}:`, e.message);
      }
    }
    return { id: episodeId, sources: results };
  }

  // Audio languages across the dub-capable peachify servers (iron/multi serve
  // the same title in Original Audio/Hindi/French/... variants). Lets the audio
  // dropdown offer a language even when the current server has only one track.
  async fetchDubs(episodeId, mediaId) {
    // 10 min TTL — the dub list is title-level, doesn't change often
    return this._cached(`dubs:${episodeId}:${mediaId}`, 10 * 60 * 1000, () => this._fetchDubs(episodeId, mediaId));
  }

  async _fetchDubs(episodeId, mediaId) {
    const [type, id] = mediaId.split('/');
    if (!type || !id) throw new Error('mediaId must be movie/{id} or tv/{id}');

    let season = 1;
    let episode = 1;
    if (type === 'tv') {
      const m = String(episodeId || '').match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (episodeId.includes('-')) {
        [season, episode] = episodeId.split('-');
      }
    }

    const out = {};
    await Promise.all(
      ['iron', 'multi'].map(async (server) => {
        try {
          const res = await resolveStream({ type, id, season, episode, server });
          out[server] = [...new Set(res.sources.map((s) => s.dub).filter(Boolean))];
        } catch (e) {
          out[server] = [];
        }
      })
    );
    return out;
  }

  // ---- listings ----

  async fetchRecentMovies() {
    // 10 min TTL — home-page sections resolve instantly on revisit
    return this._cached('recent:movies', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/movie/now_playing');
      return data.results.slice(0, 20).map((r) => this._item('movie', r, 'movie'));
    });
  }

  async fetchRecentTvShows() {
    return this._cached('recent:tv', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/tv/on_the_air');
      return data.results.slice(0, 20).map((r) => this._item('tv', r, 'tv'));
    });
  }

  async fetchTrendingMovies() {
    return this._cached('trending:movies', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/trending/movie/week');
      return data.results.slice(0, 20).map((r) => this._item('movie', r, 'movie'));
    });
  }

  async fetchTrendingTvShows() {
    return this._cached('trending:tv', 10 * 60 * 1000, async () => {
      const { data } = await this.tmdb.get('/trending/tv/week');
      return data.results.slice(0, 20).map((r) => this._item('tv', r, 'tv'));
    });
  }

  async fetchMoviesByPage(page = 1) {
    return this._discover('movie', page);
  }

  async fetchTvShowsByPage(page = 1) {
    return this._discover('tv', page);
  }

  async fetchByGenre(genre, page = 1) {
    const genres = await this._genres();
    const id = genres[String(genre).toLowerCase()];
    if (!id) throw new Error(`Genre '${genre}' not found`);
    return this._discover('movie', page, { with_genres: id });
  }

  async fetchTopIMDB(type = 'all', page = 1, minVote) {
    if (type === 'all') {
      // merge movie + tv pages (page 1 of each)
      const [movies, tv] = await Promise.all([
        this._discover('movie', 1, { sort_by: 'vote_average.desc', 'vote_count.gte': 500 }),
        this._discover('tv', 1, { sort_by: 'vote_average.desc', 'vote_count.gte': 500 }),
      ]);
      return {
        currentPage: page,
        hasNextPage: false,
        results: [...movies.results, ...tv.results].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 40),
      };
    }
    if (type !== 'movie' && type !== 'tv') throw new Error("type must be 'movie', 'tv' or 'all'");
    const params = { sort_by: 'vote_average.desc', 'vote_count.gte': 500 };
    if (minVote) params['vote_average.gte'] = minVote; // e.g. 7.5 → "IMDb 7.5+" list
    return this._discover(type, page, params);
  }
}

module.exports = FlixHQ;

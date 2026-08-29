// Thin client for the MyFlixz API.
const API = (() => {
  async function get(path) {
    const res = await fetch(path);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch (e) {}
      throw new Error(msg);
    }
    return res.json();
  }

  return {
    get,
    search: (q, page = 1) => get(`/search?query=${encodeURIComponent(q)}&page=${page}`),
    info: (mediaId) => get(`/info/${mediaId}`),
    sources: (mediaId, episodeId = '1-1', server = null) => {
      const p = new URLSearchParams({ mediaId });
      if (server) p.set('server', server);
      return get(`/sources/${episodeId}?${p}`);
    },
    // subtitle tracks — fired in parallel with sources(); result attaches late
    subtitles: (mediaId, episodeId = '1-1') =>
      get(`/subtitles/${episodeId}?${new URLSearchParams({ mediaId })}`),
    servers: () => get('/servers/1-1?mediaId=movie/1'),
    dubs: (mediaId, episodeId = '1-1') => get(`/dubs/${episodeId}?mediaId=${mediaId}`),
    row: (kind) => get(`/${kind}`),
    browse: (kind, page = 1) => get(`/${kind}?page=${page}`),
    genre: (genre, page = 1) => get(`/genre/${encodeURIComponent(genre)}?page=${page}`),
    topImdb: (type = 'all', page = 1) => get(`/top-imdb?type=${type}&page=${page}`),
    imdb75: (page = 1) => get(`/top-imdb?type=movie&page=${page}&minVote=7.5`),
  };
})();

// Upgrade TMDB image size (our API returns w500).
function hiRes(path) {
  return path ? path.replace('/w500/', '/original/') : null;
}

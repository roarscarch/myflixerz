// Enums
const TvType = {
  MOVIE: 'MOVIE',
  TVSERIES: 'TVSERIES'
};

const StreamingServers = {
  MixDrop: 'MixDrop',
  VidCloud: 'VidCloud',
  UpCloud: 'UpCloud'
};

// Base class for movie parsers
class MovieParser {
  constructor() {
    this.name = '';
    this.baseUrl = '';
    this.logo = '';
    this.classPath = '';
    this.supportedTypes = new Set();
  }

  async search(query, page = 1) {
    throw new Error('Method not implemented');
  }

  async fetchMediaInfo(mediaId) {
    throw new Error('Method not implemented');
  }

  async fetchEpisodeSources(episodeId, mediaId, server) {
    throw new Error('Method not implemented');
  }

  async fetchEpisodeServers(episodeId, mediaId) {
    throw new Error('Method not implemented');
  }
}

module.exports = {
  TvType,
  StreamingServers,
  MovieParser
}; 
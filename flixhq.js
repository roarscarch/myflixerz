const cheerio = require('cheerio');
const axios = require('axios');
const { MovieParser, TvType, StreamingServers } = require('./models');
const { MixDrop, VidCloud, VideoExtractor } = require('./extractors');

class FlixHQ extends MovieParser {
  constructor() {
    super();
    this.name = 'MyFlixHQ';
    this.baseUrl = 'https://myflixerz.to';
    this.logo = 'https://myflixerz.to/images/logo.png';
    this.classPath = 'MOVIES.MyFlixHQ';
    this.supportedTypes = new Set([TvType.MOVIE, TvType.TVSERIES]);
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
    });
  }

  async search(query, page = 1) {
    const searchResult = {
      currentPage: page,
      hasNextPage: false,
      results: []
    };

    try {
      const { data } = await this.client.get(
        `${this.baseUrl}/search/${query.replace(/[\W_]+/g, '-')}?page=${page}`
      );

      const $ = cheerio.load(data);
      const navSelector = '.pagination';

      searchResult.hasNextPage =
        $(navSelector).length > 0 ? !$(navSelector).children().last().hasClass('active') : false;

      $('.flw-item').each((i, el) => {
        const releaseDate = $(el).find('.fd-infor .fdi-item:first-child').text();
        searchResult.results.push({
          id: $(el).find('.film-poster-ahref').attr('href')?.slice(1),
          title: $(el).find('.film-name a').attr('title'),
          url: `${this.baseUrl}${$(el).find('.film-poster-ahref').attr('href')}`,
          image: $(el).find('.film-poster-img').attr('data-src'),
          releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
          seasons: releaseDate.includes('SS') ? parseInt(releaseDate.split('SS')[1]) : undefined,
          type:
            $(el).find('.fd-infor .fdi-type').text().toLowerCase() === 'movie'
              ? TvType.MOVIE
              : TvType.TVSERIES
        });
      });

      return searchResult;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchMediaInfo(mediaId) {
    if (!mediaId.startsWith(this.baseUrl)) {
      mediaId = `${this.baseUrl}/${mediaId}`;
    }

    const movieInfo = {
      id: mediaId.split('to/').pop(),
      title: '',
      url: mediaId
    };

    try {
      const { data } = await this.client.get(mediaId);
      const $ = cheerio.load(data);
      const recommendationsArray = [];

      $('.film_list-wrap .flw-item').each((i, el) => {
        recommendationsArray.push({
          id: $(el).find('.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('.film-name > a').attr('title'),
          image: $(el).find('.film-poster > img').attr('data-src'),
          duration: $(el).find('.fd-infor .fdi-duration').text().trim() || null,
          type: $(el).find('.fd-infor .fdi-type').text().toLowerCase().includes('tv') ? TvType.TVSERIES : TvType.MOVIE
        });
      });

      const uid = $('.detail_page-watch').attr('data-id');
      movieInfo.cover = $('.film-poster-img').attr('src');
      movieInfo.title = $('.heading-name').text().trim();
      movieInfo.image = $('.film-poster-img').attr('src');
      movieInfo.description = $('.description').text().trim();
      movieInfo.type = mediaId.includes('/movie/') ? TvType.MOVIE : TvType.TVSERIES;

      const metaData = {};
      $('.elements .row-line').each((i, el) => {
        const label = $(el).find('.type').text().trim().toLowerCase();
        const value = $(el).find('.value').text().trim();
        metaData[label] = value;
      });

      movieInfo.releaseDate = metaData['released:'] || metaData['release:'] || '';
      movieInfo.genres = $('.row-line:contains("Genre") a')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      movieInfo.casts = $('.row-line:contains("Cast") a')
        .map((i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      movieInfo.production = $('.row-line:contains("Production") a').text().trim();
      movieInfo.country = $('.row-line:contains("Country") a').text().trim();
      movieInfo.duration = $('.elements .row-line:contains("Duration") .value').text().trim();
      movieInfo.rating = parseFloat($('.elements .row-line:contains("IMDb") .value').text().trim()) || 0;
      movieInfo.recommendations = recommendationsArray;

      if (movieInfo.type === TvType.TVSERIES) {
        const { data: seasonData } = await this.client.get(`${this.baseUrl}/ajax/season/list/${uid}`);
        const $$ = cheerio.load(seasonData);
        const seasonsIds = $$('.dropdown-menu a')
          .map((i, el) => $(el).attr('data-id'))
          .get();

        movieInfo.episodes = [];
        let season = 1;
        for (const id of seasonsIds) {
          const { data: episodeData } = await this.client.get(`${this.baseUrl}/ajax/season/episodes/${id}`);
          const $$$ = cheerio.load(episodeData);

          $$$('.nav > li').each((i, el) => {
            const episode = {
              id: $$$(el).find('a').attr('data-id'),
              title: $$$(el).find('a').attr('title'),
              number: parseInt($$$(el).find('a').attr('title')?.match(/Eps (\d+)/)?.[1] || '0'),
              season: season,
              url: `${this.baseUrl}/ajax/episode/servers/${$$$(el).find('a').attr('data-id')}`
            };
            movieInfo.episodes.push(episode);
          });
          season++;
        }
      } else {
        movieInfo.episodes = [{
          id: uid,
          title: movieInfo.title,
          url: `${this.baseUrl}/ajax/movie/servers/${uid}`
        }];
      }

      return movieInfo;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchEpisodeSources(episodeId, mediaId, server = StreamingServers.UpCloud) {
    if (episodeId.startsWith('http')) {
      const serverUrl = new URL(episodeId);
      switch (server) {
        case StreamingServers.MixDrop:
          return {
            headers: { Referer: serverUrl.href },
            sources: await new MixDrop(this.proxyConfig, this.adapter).extract(serverUrl)
          };
        case StreamingServers.VidCloud:
          return {
            headers: { Referer: serverUrl.href },
            ...(await new VidCloud(this.proxyConfig, this.adapter).extract(serverUrl, true, this.baseUrl))
          };
        case StreamingServers.UpCloud:
          return {
            headers: { Referer: serverUrl.href },
            ...(await new VidCloud(this.proxyConfig, this.adapter).extract(serverUrl, undefined, this.baseUrl))
          };
        default:
          return {
            headers: { Referer: serverUrl.href },
            sources: await new MixDrop(this.proxyConfig, this.adapter).extract(serverUrl)
          };
      }
    }

    try {
      const servers = await this.fetchEpisodeServers(episodeId, mediaId);
      const i = servers.findIndex(s => s.name === server);

      if (i === -1) {
        throw new Error(`Server ${server} not found`);
      }

      const { data } = await this.client.get(
        `${this.baseUrl}/ajax/sources/${servers[i].url.split('.').slice(-1).shift()}`
      );

      const serverUrl = new URL(data.link);
      return await this.fetchEpisodeSources(serverUrl.href, mediaId, server);
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchEpisodeServers(episodeId, mediaId) {
    if (!episodeId.startsWith(this.baseUrl + '/ajax') && !mediaId.includes('movie'))
      episodeId = `${this.baseUrl}/ajax/episode/servers/${episodeId}`;
    else
      episodeId = `${this.baseUrl}/ajax/movie/servers/${episodeId}`;

    try {
      const { data } = await this.client.get(episodeId);
      const $ = cheerio.load(data);

      return $('.nav li').map((i, el) => ({
        name: $(el).find('a').attr('title')?.toLowerCase(),
        url: `${this.baseUrl}/${mediaId}.${$(el).find('a').attr('data-id')}`.replace(
          mediaId.includes('movie') ? /\/movie\// : /\/tv\//,
          mediaId.includes('movie') ? '/watch-movie/' : '/watch-tv/'
        )
      })).get();
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchRecentMovies() {
    try {
      const { data } = await this.client.get('/home');
      const $ = cheerio.load(data);

      const movies = $('section.block_area:contains("Latest Movies") > div:nth-child(2) > div:nth-child(1) > div.flw-item')
        .map((i, el) => {
          const releaseDate = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
          const duration = $(el).find('div.film-detail > div.fd-infor > span.fdi-duration').text();
          return {
            id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
            title: $(el).find('div.film-detail > h3.film-name > a').attr('title'),
            url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
            image: $(el).find('div.film-poster > img').attr('data-src'),
            releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
            duration: duration || undefined,
            type: TvType.MOVIE,
          };
        })
        .get();

      return movies;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchRecentTvShows() {
    try {
      const { data } = await this.client.get('/home');
      const $ = cheerio.load(data);

      const tvshows = $('section.block_area:contains("Latest TV Shows") > div:nth-child(2) > div:nth-child(1) > div.flw-item')
        .map((i, el) => ({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h3.film-name > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          season: $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text(),
          latestEpisode: $(el).find('div.film-detail > div.fd-infor > span:nth-child(3)').text() || undefined,
          type: TvType.TVSERIES,
        }))
        .get();

      return tvshows;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchTrendingMovies() {
    try {
      const { data } = await this.client.get('/home');
      const $ = cheerio.load(data);

      const movies = $('div#trending-movies div.film_list-wrap div.flw-item')
        .map((i, el) => {
          const releaseDate = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
          const duration = $(el).find('div.film-detail > div.fd-infor > span.fdi-duration').text();
          return {
            id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
            title: $(el).find('div.film-detail > h3.film-name > a').attr('title'),
            url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
            image: $(el).find('div.film-poster > img').attr('data-src'),
            releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
            duration: duration || undefined,
            type: TvType.MOVIE,
          };
        })
        .get();

      return movies;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchTrendingTvShows() {
    try {
      const { data } = await this.client.get('/home');
      const $ = cheerio.load(data);

      const tvshows = $('div#trending-tv div.film_list-wrap div.flw-item')
        .map((i, el) => ({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h3.film-name > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          season: $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text(),
          latestEpisode: $(el).find('div.film-detail > div.fd-infor > span:nth-child(3)').text() || undefined,
          type: TvType.TVSERIES,
        }))
        .get();

      return tvshows;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchMoviesByPage(page = 1) {
    try {
      const { data } = await this.client.get(`/movie?page=${page}`);
      const $ = cheerio.load(data);

      const results = {
        currentPage: page,
        hasNextPage: false,
        results: [],
      };

      const navSelector = 'div.pre-pagination:nth-child(3) > nav:nth-child(1) > ul:nth-child(1)';
      results.hasNextPage = $(navSelector).length > 0 
        ? !$(navSelector).children().last().hasClass('active') 
        : false;

      $('div.film_list-wrap > div.flw-item').each((i, el) => {
        const releaseDate = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
        const duration = $(el).find('div.film-detail > div.fd-infor > span.fdi-duration').text();
        
        results.results.push({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h2 > a, div.film-detail > h3 > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
          duration: duration || undefined,
          type: TvType.MOVIE,
        });
      });

      return results;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchTvShowsByPage(page = 1) {
    try {
      const { data } = await this.client.get(`/tv-show?page=${page}`);
      const $ = cheerio.load(data);

      const results = {
        currentPage: page,
        hasNextPage: false,
        results: [],
      };

      const navSelector = 'div.pre-pagination:nth-child(3) > nav:nth-child(1) > ul:nth-child(1)';
      results.hasNextPage = $(navSelector).length > 0 
        ? !$(navSelector).children().last().hasClass('active') 
        : false;

      $('div.film_list-wrap > div.flw-item').each((i, el) => {
        const season = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
        const latestEpisode = $(el).find('div.film-detail > div.fd-infor > span:nth-child(3)').text();
        
        results.results.push({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h2 > a, div.film-detail > h3 > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          season: season,
          latestEpisode: latestEpisode || undefined,
          type: TvType.TVSERIES,
        });
      });

      return results;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchByGenre(genre, page = 1) {
    try {
      const { data } = await this.client.get(`/genre/${genre}?page=${page}`);
      const $ = cheerio.load(data);

      const results = {
        currentPage: page,
        hasNextPage: false,
        results: [],
      };

      const navSelector = 'div.pre-pagination:nth-child(3) > nav:nth-child(1) > ul:nth-child(1)';
      results.hasNextPage = $(navSelector).length > 0 
        ? !$(navSelector).children().last().hasClass('active') 
        : false;

      $('div.film_list-wrap > div.flw-item').each((i, el) => {
        const type = $(el).find('div.film-detail > div.fd-infor > span.float-right').text();
        const releaseDate = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
        const duration = $(el).find('div.film-detail > div.fd-infor > span.fdi-duration').text();
        const latestEpisode = type === 'TV' ? $(el).find('div.film-detail > div.fd-infor > span:nth-child(3)').text() : undefined;
        
        results.results.push({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h2 > a, div.film-detail > h3 > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
          duration: duration || undefined,
          latestEpisode,
          type: type === 'TV' ? TvType.TVSERIES : TvType.MOVIE,
        });
      });

      return results;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchTopIMDB(type = 'all', page = 1) {
    try {
      const { data } = await this.client.get(`/top-imdb?type=${type}&page=${page}`);
      const $ = cheerio.load(data);

      const results = {
        currentPage: page,
        hasNextPage: false,
        results: [],
      };

      const navSelector = 'div.pre-pagination:nth-child(3) > nav:nth-child(1) > ul:nth-child(1)';
      results.hasNextPage = $(navSelector).length > 0 
        ? !$(navSelector).children().last().hasClass('active') 
        : false;

      $('div.film_list-wrap > div.flw-item').each((i, el) => {
        const type = $(el).find('div.film-detail > div.fd-infor > span.float-right').text();
        const releaseDate = $(el).find('div.film-detail > div.fd-infor > span:nth-child(1)').text();
        const duration = $(el).find('div.film-detail > div.fd-infor > span.fdi-duration').text();
        const rating = $(el).find('div.film-detail > div.fd-infor > span.float-right').prev().text();
        const latestEpisode = type === 'TV' ? $(el).find('div.film-detail > div.fd-infor > span:nth-child(3)').text() : undefined;
        
        results.results.push({
          id: $(el).find('div.film-poster > a').attr('href')?.slice(1),
          title: $(el).find('div.film-detail > h2 > a, div.film-detail > h3 > a').attr('title'),
          url: `${this.baseUrl}${$(el).find('div.film-poster > a').attr('href')}`,
          image: $(el).find('div.film-poster > img').attr('data-src'),
          releaseDate: isNaN(parseInt(releaseDate)) ? undefined : releaseDate,
          duration: duration || undefined,
          rating: rating || undefined,
          latestEpisode,
          type: type === 'TV' ? TvType.TVSERIES : TvType.MOVIE,
        });
      });

      return results;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async extractDirectLinks(embedUrl) {
    try {
      const videoExtractor = new VideoExtractor();
      const data = await videoExtractor.extract(embedUrl, 'https://myflixerz.to');

      if (!data.sources || !data.sources[0]) {
        throw new Error('No sources found');
      }

      return {
        url: data.sources[0].file,
        isM3U8: data.sources[0].type === 'hls',
        quality: 'auto',
        subtitles: data.tracks || []
      };
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchMovieEmbedLinks(movieId, serverName = null) {
    try {
      const { data: serverData } = await this.client.get(`${this.baseUrl}/ajax/episode/list/${movieId}`);
      const $ = cheerio.load(serverData);

      // If serverName is provided, only fetch that specific server
      if (serverName) {
        const serverElement = $('.nav-item a').filter((i, el) => {
          return $(el).find('span').text().toLowerCase() === serverName.toLowerCase();
        });

        if (serverElement.length === 0) {
          throw new Error(`Server "${serverName}" not found`);
        }

        const serverId = serverElement.attr('data-id');
        if (!serverId) {
          throw new Error(`No source ID found for server "${serverName}"`);
        }

        const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
        if (!sourceData || !sourceData.link) {
          throw new Error(`No source link found for server "${serverName}"`);
        }

        const embedUrl = sourceData.link;
        const directSource = await this.extractDirectLinks(embedUrl);
        
        return {
          id: movieId,
          server: serverName,
          ...directSource
        };
      }

      // If no serverName provided, fetch all servers (original behavior)
      const sources = [];
      const serverPromises = $('.nav-item a').map(async (i, el) => {
        const serverId = $(el).attr('data-id');
        const serverName = $(el).find('span').text();
        
        if (serverId) {
          try {
            const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
            
            if (sourceData && sourceData.link) {
              const embedUrl = sourceData.link;
              try {
                const directSource = await this.extractDirectLinks(embedUrl);
                if (directSource) {
                  sources.push({
                    server: serverName,
                    ...directSource
                  });
                }
              } catch (err) {
                console.error(`Failed to extract direct link from ${serverName}:`, err);
              }
            }
          } catch (err) {
            console.error(`Failed to fetch source data from server ${serverId}:`, err);
          }
        }
      }).get();

      await Promise.all(serverPromises);

      return {
        id: movieId,
        sources: sources
      };
    } catch (err) {
      console.error('Error in fetchMovieEmbedLinks:', err);
      throw new Error(`Failed to fetch movie embed links: ${err.message}`);
    }
  }

  async fetchTvEpisodeEmbedLinks(episodeId, serverName = null) {
    try {
      const { data: serverData } = await this.client.get(`${this.baseUrl}/ajax/episode/servers/${episodeId}`);
      const $ = cheerio.load(serverData);

      // If serverName is provided, only fetch that specific server
      if (serverName) {
        const serverElement = $('.nav-item a').filter((i, el) => {
          return $(el).find('span').text().toLowerCase() === serverName.toLowerCase();
        });

        if (serverElement.length === 0) {
          throw new Error(`Server "${serverName}" not found`);
        }

        const serverId = serverElement.attr('data-id');
        if (!serverId) {
          throw new Error(`No source ID found for server "${serverName}"`);
        }

        const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
        if (!sourceData || !sourceData.link) {
          throw new Error(`No source link found for server "${serverName}"`);
        }

        const embedUrl = sourceData.link;
        const directSource = await this.extractDirectLinks(embedUrl);
        
        return {
          id: episodeId,
          server: serverName,
          ...directSource
        };
      }

      // If no serverName provided, fetch all servers (original behavior)
      const sources = [];
      const serverPromises = $('.nav-item a').map(async (i, el) => {
        const serverId = $(el).attr('data-id');
        const serverName = $(el).find('span').text();
        
        if (serverId) {
          try {
            const { data: sourceData } = await this.client.get(`${this.baseUrl}/ajax/episode/sources/${serverId}`);
            
            if (sourceData && sourceData.link) {
              const embedUrl = sourceData.link;
              try {
                const directSource = await this.extractDirectLinks(embedUrl);
                if (directSource) {
                  sources.push({
                    server: serverName,
                    ...directSource
                  });
                }
              } catch (err) {
                console.error(`Failed to extract direct link from ${serverName}:`, err);
              }
            }
          } catch (err) {
            console.error(`Failed to fetch source data from server ${serverId}:`, err);
          }
        }
      }).get();

      await Promise.all(serverPromises);

      return {
        id: episodeId,
        sources: sources
      };
    } catch (err) {
      console.error('Error in fetchTvEpisodeEmbedLinks:', err);
      throw new Error(`Failed to fetch episode embed links: ${err.message}`);
    }
  }
}

module.exports = FlixHQ; 
# MyFlixHQ API

A Node.js API for scraping and serving movie/TV show data from MyFlixerz.to. This API provides various endpoints to fetch movies, TV shows, search content, and get streaming sources.

## Features

- Search movies and TV shows
- Fetch movie/TV show details
- Get streaming sources and embed links
- Browse recent and trending content
- Paginated movie and TV show listings
- Genre-based browsing
- Top IMDB ratings
- Rate limiting protection
- CORS enabled
- Ready for Vercel deployment

## Installation

```bash
npm install
```

## Local Development

Start the server locally:

```bash
npm start
```

The server will run on port 3000 by default (configurable via PORT environment variable).

## Deployment

### Deploy to Vercel

1. Install Vercel CLI:
```bash
npm install -g vercel
```

2. Login to Vercel:
```bash
vercel login
```

3. Deploy:
```bash
vercel
```

For production deployment:
```bash
vercel --prod
```

The API will be deployed to a URL like: `https://your-project-name.vercel.app`

### Environment Variables

No environment variables are required for basic deployment. However, you can configure:
- `PORT` - Port number for local development (default: 3000)

### Project Structure

```
├── server.js           # Main server file
├── flixhq.js          # FlixHQ scraper implementation
├── models.js          # Data models and types
├── extractors.js      # Video source extractors
├── vercel.json        # Vercel deployment configuration
├── package.json       # Project dependencies and scripts
└── README.md          # Documentation
```

## API Endpoints

### Search
- `GET /search?query={searchTerm}&page={pageNumber}`
  - Search for movies and TV shows
  - Required: query parameter
  - Optional: page parameter (default: 1)

### Media Info
- `GET /info/{mediaId}`
  - Get detailed information about a movie or TV show
  - mediaId format: `movie/xyz` or `tv/xyz`

### Sources & Servers
- `GET /sources/{episodeId}?mediaId={mediaId}&server={serverName}`
  - Get streaming sources for an episode/movie
  - Required: episodeId, mediaId
  - Optional: server (default: UpCloud)

- `GET /servers/{episodeId}?mediaId={mediaId}`
  - Get available streaming servers
  - Required: episodeId, mediaId

### Recent Content
- `GET /recent/movies`
  - Get recently added movies
- `GET /recent/tv`
  - Get recently added TV shows

### Trending Content
- `GET /trending/movies`
  - Get trending movies
- `GET /trending/tv`
  - Get trending TV shows

### Paginated Listings
- `GET /movies?page={pageNumber}`
  - Get movies list with pagination
  - Optional: page parameter (default: 1)

- `GET /tv?page={pageNumber}`
  - Get TV shows list with pagination
  - Optional: page parameter (default: 1)

### Genre & IMDB
- `GET /genre/{genreName}?page={pageNumber}`
  - Get content by genre
  - Required: genreName
  - Optional: page parameter (default: 1)

- `GET /top-imdb?type={contentType}&page={pageNumber}`
  - Get top IMDB rated content
  - Optional: type parameter (default: 'all', options: 'movie', 'tv', 'all')
  - Optional: page parameter (default: 1)

### Embed Links
- `GET /movie/embed/{movieId}`
  - Get movie embed links with multiple server options

- `GET /tv/embed/{episodeId}`
  - Get TV episode embed links with multiple server options

## Response Formats

### Media Info Response
```json
{
  "id": "string",
  "title": "string",
  "url": "string",
  "cover": "string",
  "image": "string",
  "description": "string",
  "type": "MOVIE | TVSERIES",
  "releaseDate": "string",
  "genres": ["string"],
  "casts": ["string"],
  "production": "string",
  "country": "string",
  "duration": "string",
  "rating": number,
  "recommendations": [
    {
      "id": "string",
      "title": "string",
      "image": "string",
      "type": "MOVIE | TVSERIES"
    }
  ],
  "episodes": [
    {
      "id": "string",
      "title": "string",
      "number": number,
      "season": number,
      "url": "string"
    }
  ]
}
```

### Sources Response
```json
{
  "headers": {
    "Referer": "string"
  },
  "sources": [
    {
      "url": "string",
      "quality": "string",
      "isM3U8": boolean
    }
  ],
  "subtitles": [
    {
      "url": "string",
      "lang": "string"
    }
  ]
}
```

## Rate Limiting

The API implements rate limiting with the following defaults:
- 100 requests per 15 minutes per IP address

## Error Handling

The API returns appropriate HTTP status codes:
- 200: Success
- 400: Bad Request (missing or invalid parameters)
- 404: Not Found
- 429: Too Many Requests (rate limit exceeded)
- 500: Internal Server Error

Error responses include a JSON object with an error message:
```json
{
  "error": "Error message description"
}
```

## Dependencies

- express
- cors
- express-rate-limit
- axios
- cheerio

## License

MIT License 
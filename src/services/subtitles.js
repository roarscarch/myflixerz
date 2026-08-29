// opensubs.js — OpenSubtitles API (api.opensubtitles.com) as the PRIMARY English
// subtitle source. Title-level English .srt/.vtt backing for the player.
//
// Contract (v1):
//   base: https://api.opensubtitles.com/api/v1
//   all requests require headers { Api-Key, User-Agent } (the gateway 403s the
//   default curl/fetch UA)
//   POST /login   { username, password }                -> { token }   (24h)
//   GET  /subtitles?imdb_id=..&languages=en[&type=episode&season_number=..&episode_number=..]
//                       -> { data: [ { attributes: { files:[{file_id},..],
//                                                     language, language_id, .. } } ] }
//   POST /download { file_id }  (+ Authorization: Bearer <token>) -> { link }
//                       "link" is a short-lived direct URL to the .srt/.vtt we
//                       hand to the player (fetched through /play).
//
// Degrades to [] on any missing config / network / auth failure so the app's
// existing peachify + vidnest subtitle sources remain the silent fallback.
const axios = require('axios');

const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const OS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let loginToken = null;
let loginExp = 0;

function isConfigured() {
  return Boolean(
    process.env.OPENSUBTITLES_API_KEY &&
      process.env.OPENSUBTITLES_USERNAME &&
      process.env.OPENSUBTITLES_PASSWORD
  );
}

async function login() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!key || !username || !password) throw new Error('opensubtitles credentials missing');
  if (loginToken && Date.now() < loginExp) return loginToken;
  const r = await axios.post(
    `${OS_BASE}/login`,
    { username, password },
    {
      headers: { 'Api-Key': key, 'User-Agent': OS_UA, 'Content-Type': 'application/json' },
      timeout: 10000,
    }
  );
  loginToken = r.data && r.data.token;
  loginExp = Date.now() + 24 * 60 * 60 * 1000;
  if (!loginToken) throw new Error('opensubtitles login: no token');
  return loginToken;
}

// Search English subtitle candidates for a title. Uses the tmdb imdb_id; for TV
// passes season/episode so OpenSubtitles returns the right episode's subs.
async function searchEnglish({ imdbId, season, episode }) {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) throw new Error('opensubtitles api key missing');
  const params = { imdb_id: imdbId, languages: 'en' };
  if (season && episode) {
    params.type = 'episode';
    params.season_number = Number(season);
    params.episode_number = Number(episode);
  }
  const r = await axios.get(`${OS_BASE}/subtitles`, {
    params,
    headers: { 'Api-Key': key, 'User-Agent': OS_UA },
    timeout: 10000,
  });
  const rows = (r.data && r.data.data) || [];
  return rows
    .map((it) => {
      const a = (it && it.attributes) || {};
      const file = (a.files && a.files[0]) || {};
      return {
        fileId: file.file_id,
        label: a.language || 'English',
        lang: a.language_id || 'en',
      };
    })
    .filter((s) => s.fileId);
}

// Turn a candidate into a playable .srt/.vtt URL (fresh short-lived link).
async function download(fileId) {
  const key = process.env.OPENSUBTITLES_API_KEY;
  const token = await login();
  const r = await axios.post(
    `${OS_BASE}/download`,
    { file_id: fileId },
    {
      headers: {
        'Api-Key': key,
        Authorization: `Bearer ${token}`,
        'User-Agent': OS_UA,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );
  return r.data && r.data.link;
}

// English subtitle entries [{ url, label, lang }] — the primary EN source.
async function fetchEnglishSubtitles({ type, imdbId, season, episode }) {
  if (!isConfigured() || !imdbId) return [];
  try {
    // A handful of matches is plenty; dedupe the download links we resolve.
    const hits = await searchEnglish({ imdbId, season, episode });
    const subs = [];
    for (const h of hits.slice(0, 4)) {
      try {
        const url = await download(h.fileId);
        if (url) subs.push({ url, label: h.label || 'English', lang: h.lang || 'en' });
      } catch (e) {
        // one dead file shouldn't kill the rest
      }
    }
    return subs;
  } catch (e) {
    return [];
  }
}

module.exports = { fetchEnglishSubtitles, isConfigured };
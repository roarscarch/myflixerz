// src/services/subtitles.js — Subtitle provider service (SubDL + OpenSubtitles fallback)
const zlib = require('zlib');
const { httpClient } = require('../utils/http');

// SubDL API configuration (primary fast provider)
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || 'subdl_rTvrEn_gykfHvxfGL-SF3mNdLzAT8zdPBPTtCX2oDXI';
const SUBDL_BASE = 'https://api.subdl.com/api/v1';
const SUBDL_DL_BASE = 'https://dl.subdl.com';

// OpenSubtitles API configuration (secondary fallback)
const OS_BASE = 'https://api.opensubtitles.com/api/v1';
const OS_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let loginToken = null;
let loginExp = 0;

// In-memory cache for converted VTT strings: zipPath+episode -> vttText
const VTT_CACHE = new Map();
const VTT_CACHE_MAX = 200;

function isConfigured() {
  return Boolean(SUBDL_API_KEY || (process.env.OPENSUBTITLES_API_KEY && process.env.OPENSUBTITLES_USERNAME));
}

// Convert standard SRT timestamps (00:00:55,681) to WebVTT format (00:00:55.681)
function srtToVtt(srt) {
  if (!srt) return '';
  if (srt.startsWith('WEBVTT')) return srt;
  const cleaned = srt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const vttTimestamps = cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${vttTimestamps.trim()}\n`;
}

// Zero-dependency pure-Node zip extractor to read .srt/.vtt files directly from memory
function extractSrtFromZip(buffer, episode) {
  let offset = 0;
  const entries = [];
  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Local file header signature
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const filename = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buffer.subarray(dataStart, dataStart + compSize);

    if (filename.endsWith('.srt') || filename.endsWith('.vtt')) {
      entries.push({ filename, method, data });
    }
    offset = dataStart + compSize;
  }
  if (!entries.length) return null;

  // If TV episode specified, look for matching episode number (e.g. "01", "E01", "Episode 1")
  let chosen = entries[0];
  if (episode) {
    const epNum = Number(episode);
    const epPadded = epNum < 10 ? `0${epNum}` : String(epNum);
    const match = entries.find((e) => {
      const fn = e.filename.toLowerCase();
      return (
        fn.includes(`e${epPadded}`) ||
        fn.includes(`episode ${epNum}`) ||
        fn.includes(`ep${epNum}`) ||
        fn.includes(` ${epPadded} `) ||
        fn.startsWith(epPadded)
      );
    });
    if (match) chosen = match;
  }

  let content = '';
  if (chosen.method === 0) {
    content = chosen.data.toString('utf8');
  } else if (chosen.method === 8) {
    content = zlib.inflateRawSync(chosen.data).toString('utf8');
  }
  return { filename: chosen.filename, content };
}

// Fetch zip from SubDL and convert to WebVTT in memory
async function fetchSubdlVtt(zipUrlPath, episode) {
  const cacheKey = `${zipUrlPath}::${episode || ''}`;
  if (VTT_CACHE.has(cacheKey)) return VTT_CACHE.get(cacheKey);

  const fullUrl = `${SUBDL_DL_BASE}${zipUrlPath}`;
  const res = await httpClient.get(fullUrl, { responseType: 'arraybuffer', timeout: 10000 });
  const buffer = Buffer.from(res.data);
  const extracted = extractSrtFromZip(buffer, episode);
  if (!extracted || !extracted.content) throw new Error('Could not extract subtitle from zip archive');

  const vtt = srtToVtt(extracted.content);
  if (VTT_CACHE.size >= VTT_CACHE_MAX) {
    const firstKey = VTT_CACHE.keys().next().value;
    if (firstKey) VTT_CACHE.delete(firstKey);
  }
  VTT_CACHE.set(cacheKey, vtt);
  return vtt;
}

// ---- SubDL Search ----
async function searchSubdl({ type, imdbId, season, episode }) {
  if (!SUBDL_API_KEY || !imdbId) return [];
  try {
    const params = {
      api_key: SUBDL_API_KEY,
      imdb_id: imdbId,
      languages: 'en',
    };
    if (type === 'tv' && season && episode) {
      params.season_number = Number(season);
      params.episode_number = Number(episode);
    }
    const res = await httpClient.get(`${SUBDL_BASE}/subtitles`, { params, timeout: 6000 });
    const list = (res.data && res.data.subtitles) || [];
    return list
      .slice(0, 4)
      .map((item) => ({
        url: `/subtitles/subdl?zip=${encodeURIComponent(item.url)}&ep=${type === 'tv' ? episode || '' : ''}`,
        label: item.release_name || item.name || 'English (SubDL)',
        lang: 'en',
      }))
      .filter((s) => s.url);
  } catch (e) {
    return [];
  }
}

// ---- OpenSubtitles Search (fallback) ----
async function loginOpenSubs() {
  const key = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!key || !username || !password) throw new Error('opensubtitles credentials missing');
  if (loginToken && Date.now() < loginExp) return loginToken;
  const r = await httpClient.post(
    `${OS_BASE}/login`,
    { username, password },
    {
      headers: { 'Api-Key': key, 'User-Agent': OS_UA, 'Content-Type': 'application/json' },
    }
  );
  loginToken = r.data && r.data.token;
  loginExp = Date.now() + 24 * 60 * 60 * 1000;
  return loginToken;
}

async function searchOpenSubs({ type, imdbId, season, episode }) {
  const key = process.env.OPENSUBTITLES_API_KEY;
  if (!key) return [];
  try {
    const params = { imdb_id: imdbId, languages: 'en' };
    if (type === 'tv' && season && episode) {
      params.type = 'episode';
      params.season_number = Number(season);
      params.episode_number = Number(episode);
    }
    const r = await httpClient.get(`${OS_BASE}/subtitles`, {
      params,
      headers: { 'Api-Key': key, 'User-Agent': OS_UA },
      timeout: 6000,
    });
    const rows = (r.data && r.data.data) || [];
    const hits = rows
      .map((it) => {
        const a = (it && it.attributes) || {};
        const file = (a.files && a.files[0]) || {};
        return { fileId: file.file_id, label: a.language || 'English', lang: a.language_id || 'en' };
      })
      .filter((s) => s.fileId);

    const token = await loginOpenSubs();
    const subs = [];
    for (const h of hits.slice(0, 2)) {
      try {
        const dRes = await httpClient.post(
          `${OS_BASE}/download`,
          { file_id: h.fileId },
          {
            headers: {
              'Api-Key': key,
              Authorization: `Bearer ${token}`,
              'User-Agent': OS_UA,
              'Content-Type': 'application/json',
            },
          }
        );
        if (dRes.data && dRes.data.link) {
          subs.push({ url: dRes.data.link, label: h.label || 'English (OpenSubtitles)', lang: h.lang || 'en' });
        }
      } catch (e) {}
    }
    return subs;
  } catch (e) {
    return [];
  }
}

// Master subtitle resolution: SubDL first, then OpenSubtitles
async function fetchEnglishSubtitles({ type, imdbId, season, episode }) {
  if (!imdbId) return [];

  // Try SubDL first (fast & reliable)
  const subdlHits = await searchSubdl({ type, imdbId, season, episode });
  if (subdlHits.length > 0) {
    return subdlHits;
  }

  // Fallback to OpenSubtitles if configured
  return searchOpenSubs({ type, imdbId, season, episode });
}

module.exports = {
  fetchEnglishSubtitles,
  fetchSubdlVtt,
  srtToVtt,
  extractSrtFromZip,
  isConfigured,
};
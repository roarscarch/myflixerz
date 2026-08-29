// src/routes/download.js — /download endpoint
//
// Saves the current stream to disk:
//  - direct sources, no subs: streamed through (constant memory, no ffmpeg)
//  - anything with subs= (or hls=1): remuxed by ffmpeg into a playable .mp4 —
//    video copied (never re-encoded), audio re-encoded to AAC for HLS (copied
//    for direct sources), subtitle tracks converted to mp4 text (mov_text),
//    fragmented moov so a partial file is still playable.
// `subs` = "url|label" pairs, comma-separated. If a subtitle input fails,
// the download retries once without subs rather than dying.
const { Router } = require('express');
const path = require('path');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { STREAM_UA } = require('./stream');

module.exports = function downloadRoutes() {
  const router = Router();

  router.get('/download', (req, res) => {
    const { url, ref, title, hls, subs } = req.query;
    if (!url) return res.status(400).json({ error: 'url query parameter is required' });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid url' });
    const referer = ref || 'https://peachify.top/';
    const base = String(title || 'cinephiles-download')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'cinephiles-download';
    const tracks = String(subs || '')
      .split(',')
      .map((t, i) => {
        const [u, ...rest] = t.split('|');
        if (!u || !/^https?:\/\//i.test(u)) return null;
        return { url: u, label: rest.join('|').slice(0, 60) || `Subtitle ${i + 1}` };
      })
      .filter(Boolean)
      .slice(0, 12); // cap the track count — no point muxing 50 languages
    const remux = hls === '1' || tracks.length > 0;

    res.set({
      'Content-Disposition': `attachment; filename="${base}.${remux ? 'mp4' : (path.extname(new URL(url).pathname).replace(/[^a-z0-9]/gi, '') || 'mp4')}"`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });

    if (!remux) {
      // direct source, no subs: stream through like /play, flagged as a download
      fetch(url, { headers: { Referer: referer, 'User-Agent': STREAM_UA } })
        .then((up) => {
          if (!up.ok && up.status !== 206) return res.status(up.status).json({ error: `Upstream ${up.status}` });
          res.set('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
          const cl = up.headers.get('content-length');
          if (cl) res.set('Content-Length', cl);
          return new Promise((resolve, reject) => {
            const body = Readable.fromWeb(up.body);
            body.on('error', (e) => {
              res.destroy();
              reject(e);
            });
            res.on('close', resolve);
            body.pipe(res);
          });
        })
        .catch((e) => {
          if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
        });
      return;
    }

    res.set('Content-Type', 'video/mp4');
    const headers = `Referer: ${referer}\r\nUser-Agent: ${STREAM_UA}\r\n`;
    const buildArgs = (includeSubs) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-headers', headers, '-i', url];
      if (includeSubs) for (const t of tracks) args.push('-i', t.url);
      args.push('-map', '0:v:0', '-map', '0:a?');
      if (includeSubs) tracks.forEach((_, i) => args.push('-map', `${i + 1}:0`));
      args.push('-c:v', 'copy', '-c:a', hls === '1' ? 'aac' : 'copy');
      if (includeSubs) {
        args.push('-c:s', 'mov_text');
        tracks.forEach((t, i) => args.push(`-metadata:s:s:${i}`, `title=${t.label}`));
      }
      args.push('-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
      return args;
    };

    let stderr = '';
    let aborted = false;
    let ff = null;

    const start = (includeSubs) => {
      ff = spawn('ffmpeg', buildArgs(includeSubs), { stdio: ['ignore', 'pipe', 'pipe'] });
      stderr = '';
      ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2048)));
      ff.stdout.on('error', () => {});
      ff.on('error', (e) => {
        // ENOENT = ffmpeg not installed
        if (res.headersSent) return;
        res.status(e.code === 'ENOENT' ? 503 : 502).json({
          error:
            e.code === 'ENOENT'
              ? 'ffmpeg is not installed on this server — downloads with subtitles need it (sudo apt install ffmpeg)'
              : `ffmpeg failed to start: ${e.message}`,
        });
      });
      ff.on('close', (code) => {
        if (aborted) return;
        if (res.headersSent) return res.end();
        // failed before producing output: if subtitle inputs were involved,
        // one of them is probably dead — retry once without them
        if (includeSubs) return start(false);
        res.status(502).json({ error: `ffmpeg exited before producing output (code ${code}): ${stderr.slice(-400)}` });
      });
      ff.stdout.pipe(res);
    };

    res.on('close', () => {
      aborted = true;
      if (ff && !ff.killed) ff.kill();
    });
    start(tracks.length > 0);
  });

  return router;
};

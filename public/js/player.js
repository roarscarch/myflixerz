// Video player: hls.js playback, subtitle tracks, server switching, skip-intro.
const Player = (() => {
  // CORS-open hosts play directly; everything else goes through /play.
  // When every source on a server dies mid-playback, advance through the server
  // list automatically (vidnest first — its API is the most reliable right now).
  const SERVER_FALLBACK_ORDER = ['videasy', 'hollymoviehd', 'rogflix', 'buzz', 'ngc', 'horizon', 'wolf', 'spider', 'multi', 'iron'];
  const PROXY_HOSTS = ['eat-peach.sbs', '97bf1.com', 'cache.vdrk.site'];
  const PROVIDER_LABELS = {
    horizon: 'Horizon', wolf: 'Wolf', spider: 'Spider', multi: 'Multi', iron: 'Iron',
    videasy: 'Videasy', hollymoviehd: 'HollyMovie', rogflix: 'Rogflix', buzz: 'Buzz', ngc: 'NGC',
  };

  function isDirect(url) {
    try {
      return PROXY_HOSTS.some((h) => new URL(url).hostname.endsWith(h));
    } catch (e) {
      return false;
    }
  }

  // Direct CDN URLs need our /play proxy (referer + CORS); CORS-open hosts play
  // direct. Some vidnest sources carry their own referer (goodstream etc.) —
  // pass it through so the CDN doesn't reject the segment requests.
  function playableUrl(url, referer) {
    return isDirect(url) ? url : `/play?ref=${encodeURIComponent(referer || 'https://peachify.top/')}&url=${encodeURIComponent(url)}`;
  }

  function pickBest(sources) {
    if (!sources || !sources.length) return null;
    const ranked = [...sources].sort((a, b) => {
      const q = (s) => {
        const v = parseInt(s.quality || '0', 10);
        return Number.isFinite(v) ? v : 0;
      };
      return q(b) - q(a) || (b.isM3U8 ? 1 : 0) - (a.isM3U8 ? 1 : 0);
    });
    return ranked[0];
  }

  // ---- subtitle helpers ----
  // Subtitle CDNs (e.g. kaoline.workers.dev) rate-limit bursts and send no CORS
  // headers, so we load ONE track at a time, on demand, through /play.

  function srtToVtt(srt) {
    return (
      'WEBVTT\n\n' +
      srt
        .replace(/\r/g, '')
        .replace(/(\d{2}:\d{2}:\d{2})[,.](\d{3})/g, '$1.$2')
        .replace(/^\d+\n(?=\d{2}:)/gm, '')
    );
  }

  function parseVtt(text) {
    const cues = [];
    const blockRe = /(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\s*\n|\n\d{2}:\d{2}:\d{2}|$)/g;
    const toSec = (t) => t.split(':').reduce((a, v) => a * 60 + parseFloat(v), 0);
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      try {
        cues.push(new VTTCue(toSec(m[1]), toSec(m[2]), m[3].trim()));
      } catch (e) {}
    }
    return cues;
  }

  function isSrt(url) {
    return /\.srt($|\?)|format=srt/i.test(url);
  }

  // ---- main player ----
  class MoviePlayer {
    constructor(shell) {
      this.shell = shell;
      this.video = shell.querySelector('video');
      this.hls = null;
      this.sources = null;
      this.mediaId = null;
      this.episodeId = '1-1';
      this.currentIndex = 0;
      this.server = null;
      this.ready = false;
      this._intro = null;
      this._introFired = false;

      this.video.addEventListener('timeupdate', () => this._checkIntro());
    }

    load({ mediaId, episodeId = '1-1', title, server = null }) {
      this.mediaId = mediaId;
      this.episodeId = episodeId;
      this.server = server;
      this.quality = localStorage.getItem('myflixerz-quality') || 'auto';
      this.audio = localStorage.getItem('myflixerz-audio') || 'auto';
      this._triedServers = null;
      this._intro = null;
      this._introFired = false;
      this.showLoading('Finding streams…');
      API.sources(mediaId, episodeId, server)
        .then((res) => {
          this.sources = res.sources || [];
          this.subtitles = res.subtitles || [];
          this.provider = res.provider;
          this.shell.dispatchEvent(
            new CustomEvent('sources-ready', { detail: { provider: res.provider, subtitles: this.subtitles } })
          );
          this._fetchIntro();
          this._play();
        })
        .catch((e) => this.showError(e.message));
    }

    _play() {
      if (!this.sources.length) return this.showError('No playable sources found.');
      // respect the stored audio choice (dub) when this server carries it
      let src = null;
      if (this.audio !== 'auto') src = this.sources.find((s) => s.dub === this.audio) || null;
      if (!src) src = pickBest(this.sources);
      this.currentIndex = this.sources.indexOf(src);
      this._attach(src);
    }

    /** User picks an audio language (dub label) — re-attaches the matching source. */
    setAudio(value) {
      this.audio = value;
      localStorage.setItem('myflixerz-audio', value);
      if (value === 'auto') return this._play();
      const src = (this.sources || []).find((s) => s.dub === value);
      if (src) {
        this.currentIndex = this.sources.indexOf(src);
        this._attach(src);
      } else {
        this._play();
      }
    }

    _attach(src) {
      const url = playableUrl(src.url, src.referer);
      this.hideLoading();

      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      if (this.video.src) {
        this.video.removeAttribute('src');
        this.video.load();
      }

      if (src.isM3U8 && window.Hls && Hls.isSupported()) {
        // Short retries so dead sources fail fast and _fallbackNext/_autoAdvance kick in
        this.hls = new Hls({
          enableWorker: true,
          maxBufferLength: 40,
          fragLoadingMaxRetry: 2,
          fragLoadingRetryDelay: 1000,
          levelLoadingMaxRetry: 2,
          levelLoadingRetryDelay: 1000,
        });
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          // expose the manifest's quality levels, re-apply the stored choice
          const heights = [...new Set((this.hls.levels || []).map((l) => l.height).filter(Boolean))];
          this._emitQuality(heights);
          if (this.quality !== 'auto') {
            const idx = (this.hls.levels || []).findIndex((l) => String(l.height) === String(this.quality));
            if (idx >= 0) this.hls.currentLevel = idx;
          }
          this.video.play().catch(() => {});
        });
        this.hls.on(Hls.Events.ERROR, (ev, data) => {
          if (data.fatal) {
            this.hls.destroy();
            this.hls = null;
            this._fallbackNext();
          }
        });
      } else {
        this.video.src = url;
        this.video.play().catch(() => {});
        this.video.addEventListener('error', () => this._fallbackNext(), { once: true });
        // no manifest — quality menu comes from the source labels instead
        const qs = [...new Set((this.sources || []).map((s) => s.quality).filter((q) => q && q !== 'auto'))];
        this._emitQuality(qs);
      }

      // subtitles load on demand via loadSubtitle() — no eager fetches
      [...(this.video.textTracks || [])].forEach((t) => (t.mode = 'hidden'));
    }

    _fallbackNext() {
      this.currentIndex += 1;
      if (this.currentIndex < this.sources.length) {
        this.showLoading('Source failed — trying another…');
        this._attach(this.sources[this.currentIndex]);
      } else {
        this._autoAdvance();
      }
    }

    _emitQuality(levels) {
      this.shell.dispatchEvent(new CustomEvent('quality-ready', { detail: { levels } }));
    }

    /** User picks a quality: 'auto' (ABR) or a height like 1080. Persisted. */
    setQuality(value) {
      this.quality = value;
      localStorage.setItem('myflixerz-quality', value);
      if (this.hls) {
        if (value === 'auto') {
          this.hls.currentLevel = -1;
          return;
        }
        const idx = (this.hls.levels || []).findIndex((l) => String(l.height) === String(value));
        if (idx >= 0) this.hls.currentLevel = idx;
      } else if (this.sources && this.sources.length > 1) {
        // non-HLS: re-attach the source that carries the chosen quality
        const src = this.sources.find((s) => String(s.quality) === String(value));
        if (src) {
          this.currentIndex = this.sources.indexOf(src);
          this._attach(src);
        }
      }
    }

    // All streams on the current server died — silently move to the next server
    // (each server re-resolves its own sources). Bounded by _triedServers.
    _autoAdvance() {
      if (!this._triedServers) this._triedServers = new Set(this.server ? [this.server] : []);
      const idx = SERVER_FALLBACK_ORDER.indexOf(this.server);
      for (let i = idx === -1 ? 0 : idx + 1; i < SERVER_FALLBACK_ORDER.length; i++) {
        const next = SERVER_FALLBACK_ORDER[i];
        if (this._triedServers.has(next)) continue;
        this._triedServers.add(next);
        this.switchServer(next);
        return;
      }
      this.showError('All servers failed. Try another server.');
    }

    async switchServer(name) {
      this.server = name;
      this.currentIndex = 0;
      this.showLoading(`Connecting to ${PROVIDER_LABELS[name] || name}…`);
      try {
        const res = await API.sources(this.mediaId, this.episodeId, name);
        this.sources = res.sources || [];
        this.subtitles = res.subtitles || [];
        this.provider = res.provider;
        this.shell.dispatchEvent(
          new CustomEvent('sources-ready', { detail: { provider: res.provider, subtitles: this.subtitles } })
        );
        this._play();
      } catch (e) {
        this.showError(e.message);
      }
    }

    _fetchIntro() {
      const id = this.mediaId.split('/')[1];
      fetch(`https://api.theintrodb.org/v2/media?tmdb_id=${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const intro = (d.intro || [])[0];
          if (intro && intro.end_ms) this._intro = intro;
        })
        .catch(() => {});
    }

    /** Load one subtitle track on demand (called when the user picks it). */
    loadSubtitle(url, label) {
      if (!url) {
        [...(this.video.textTracks || [])].forEach((t) => (t.mode = 'hidden'));
        return;
      }
      const track = this.video.addTextTrack('subtitles', label || 'Subtitle', 'en');
      track.mode = 'hidden';
      track.addEventListener('cuechange', () => {}); // keep track alive for some engines
      fetch(playableUrl(url))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subtitle fetch failed'))))
        .then((text) => {
          const vtt = isSrt(url) ? srtToVtt(text) : text;
          parseVtt(vtt).forEach((c) => track.addCue(c));
          [...(this.video.textTracks || [])].forEach((t) => (t !== track ? (t.mode = 'hidden') : null));
          track.mode = 'showing';
        })
        .catch((e) => console.warn('subtitle:', e.message));
    }

    _checkIntro() {
      if (!this._intro || this._introFired) return;
      const end = (this._intro.end_ms || 0) / 1000;
      if (this.video.currentTime >= Math.max(0, end - 8) && this.video.currentTime < end) {
        this._introFired = true;
        const btn = this.shell.querySelector('.skip-intro');
        btn.classList.add('show');
        btn.onclick = () => {
          this.video.currentTime = end;
          btn.classList.remove('show');
        };
      }
    }

    showLoading(msg) {
      this.shell.querySelector('.player-loading').hidden = false;
      this.shell.querySelector('.player-loading .pl-text').textContent = msg || 'Loading…';
      this.shell.querySelector('.player-error').hidden = true;
    }
    hideLoading() {
      this.shell.querySelector('.player-loading').hidden = true;
    }
    showError(msg) {
      this.hideLoading();
      const el = this.shell.querySelector('.player-error');
      el.hidden = false;
      el.querySelector('.pe-msg').textContent = msg;
    }
  }

  return { MoviePlayer, PROVIDER_LABELS };
})();

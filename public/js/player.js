// Video player: hls.js playback, subtitle tracks, server switching, skip-intro.
const Player = (() => {
  // CORS-open hosts play directly in the browser (verified probing for
  // Access-Control-Allow-Origin + no Referer/Origin gating); everything else
  // goes through /play. When every source on a server dies mid-playback,
  // advance through the server list automatically (vidnest first — its API is
  // the most reliable right now).
  const CORS_OPEN_HOSTS = [
    'eat-peach.sbs',             // (legacy)
    '97bf1.com',                 // buzz
    'cache.vdrk.site',           // vidnest subtitles
    'sparkvid.workers.dev',      // vidxyz
    'remoteconsultinggroup.site' // wolf/ngc — ACAO: *, plays headerless
  ];
  const PROVIDER_LABELS = {
    horizon: 'Horizon', wolf: 'Wolf', spider: 'Spider', multi: 'Multi', iron: 'Iron',
    videasy: 'Videasy', hollymoviehd: 'HollyMovie', rogflix: 'Rogflix', buzz: 'Buzz', ngc: 'NGC', vidxyz: 'VidXYZ',
  };

  // Fallback race budget per title load. Each failed provider is added to a
  // skip list and the remainder is re-raced — every attempt is a FRESH server,
  // so we converge on a working one (or a clear error) instead of looping.
  const MAX_RACE_ATTEMPTS = 8;

  // Direct CDN URLs on CORS-open hosts play browser-direct (no /play hop);
  // so do progressive MP4s with their own sign-token auth (a <video src>
  // element has no CORS constraints and can't be Referer-gated by us anyway —
  // if the source demands headers we must proxy). Everything else rides /play.
  function isDirect(url, src) {
    try {
      const u = new URL(url);
      if (CORS_OPEN_HOSTS.some((h) => u.hostname.endsWith(h))) return true;
      if (src && !src.isM3U8 && !src.referer && !src.origin && /\.(mp4|mkv|webm|m4v)($|\?)/i.test(u.pathname + u.search)) return true;
    } catch (e) {
      return false;
    }
    return false;
  }

  // Direct CDNs need our /play proxy (referer + CORS); CORS-open hosts play
  // direct. Some vidnest sources carry their own referer (goodstream etc.) —
  // pass it through so the CDN doesn't reject the segment requests.
  function playableUrl(url, referer, origin, src) {
    // Local API routes (e.g. /subtitles/subdl?zip=…) are same-origin — fetch
    // them directly. /play only proxies absolute http(s) URLs and would 400.
    if (url.startsWith('/')) return url;
    if (isDirect(url, src)) return url;
    const params = new URLSearchParams({ ref: referer || 'https://peachify.top/' });
    if (origin) params.set('origin', origin);
    params.set('url', url);
    return `/play?${params.toString()}`;
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
  const PROGRESS_KEY = 'myflixerz-progress'; // { [mediaId/episodeId]: {pos,dur,title,type,image,t} }
  const RESUME_MIN = 30; // seconds before we offer a resume
  const UP_NEXT_WINDOW_S = 300; // reveal "Next episode" 5 min before the end

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
      this.resumePos = 0;
      this._pendingResume = false;
      this._started = false;
      this._lastSave = 0;
      // Next-episode affordance: supplied by the watch view (TV only).
      this.nextEpisodeId = null;
      this._upNextShown = false;
      // Volume boost beyond 100% (Web Audio). video.volume is capped at 1.0, so
      // once the gain graph is live we hold video.volume=1 and let a GainNode
      // own loudness (up to 2000%). A DynamicsCompressor (near-limiter) clamps
      // boosted peaks so we don't clip — that's what the ✓ boost experiment does.
      this._volume = Math.min(20, Math.max(0.1, Number(localStorage.getItem('myflixerz-volume') || '1')));
      this._audioGraph = null; // AudioContext
      this._audioGain = null; // GainNode (dangerously owns loudness > 1)
      this._subtitle = null; // {url,label} — feeds the Download button
      // Subtitle sync state: _subBaseCues holds the RAW cue times from the
      // subtitle file; _subOffset (seconds) and _subScale (fps correction) are
      // applied at add-time so tweaks re-render instantly without refetching.
      this._subBaseCues = null;
      this._subOffset = 0;
      this._subScale = 1;
      this._subAutoDone = false; // auto fps-guess runs once per loaded track
      this._failedSubs = new Set(); // subtitle URLs that errored — never re-picked
      this.video.volume = this._volume > 1 ? 1 : Math.max(0, Math.min(1, this._volume));
      // fps auto-resync needs video.duration — retry when metadata lands
      this.video.addEventListener('loadedmetadata', () => this._maybeAutoSync());
      // a stream that genuinely starts playing means the session is healthy —
      // reset the fallback budget so a real mid-play death can re-race later
      this.video.addEventListener('playing', () => {
        this._racedProviders = new Set();
        this._raceAttempts = 0;
      });

      this.video.addEventListener('timeupdate', () => {
        this._checkIntro();
        this._checkUpNext();
        this._saveProgress(false);
      });
      this.video.addEventListener('ended', () => {
        this._saveProgress(true);
        // surfaced even without the pre-end window firing (short clips, seek-to-end)
        this.shell.dispatchEvent(new CustomEvent('episode-ended'));
      });
      // Web Audio needs a user gesture to start (autoplay policies). We lazily
      // build the gain graph on the first play / any pointer/key interaction.
      this.video.addEventListener('play', () => this._ensureAudioGraph());
      this.shell.addEventListener('pointerdown', () => this._ensureAudioGraph());
      this.shell.addEventListener('keydown', () => this._ensureAudioGraph());
      this.video.addEventListener('play', () => this.shell.dispatchEvent(new CustomEvent('play-state', { detail: { playing: true } })));
      this.video.addEventListener('pause', () => this.shell.dispatchEvent(new CustomEvent('play-state', { detail: { playing: false } })));

      // keyboard shortcuts (skip when typing in a field)
      shell.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.matches('input,select,textarea') || t.isContentEditable)) return;
        switch (e.key) {
          case ' ':
          case 'k':
            this.togglePlay();
            e.preventDefault();
            break;
          case 'ArrowRight':
          case 'l':
            this.video.currentTime = Math.min(this.video.duration || Infinity, this.video.currentTime + 10);
            e.preventDefault();
            break;
          case 'ArrowLeft':
          case 'j':
            this.video.currentTime = Math.max(0, this.video.currentTime - 10);
            e.preventDefault();
            break;
          case 'ArrowUp':
            this.setVolume(this._volume + 0.1);
            e.preventDefault();
            break;
          case 'ArrowDown':
            this.setVolume(this._volume - 0.1);
            e.preventDefault();
            break;
          case 'm':
            this.video.muted = !this.video.muted;
            e.preventDefault();
            break;
          case 'f':
            this.toggleFullscreen();
            e.preventDefault();
            break;
          case '>':
          case '.':
            this.changeSpeed(0.25);
            e.preventDefault();
            break;
          case '<':
          case ',':
            this.changeSpeed(-0.25);
            e.preventDefault();
            break;
          case 'z': // subtitle sync: 0.1s earlier
            this.setSubtitleOffset((this._subOffset || 0) - 0.1);
            e.preventDefault();
            break;
          case 'x': // subtitle sync: 0.1s later
            this.setSubtitleOffset((this._subOffset || 0) + 0.1);
            e.preventDefault();
            break;
        }
      });
    }

    /**
     * Route wires the hls.js script promise here so the player can hold it and
     * finish attaching only once the stream AND the player library are ready.
     */
    readyWhen(hlsPromise) {
      this._hlsReady = Promise.resolve(hlsPromise).catch(() => {});
    }

    load({ mediaId, episodeId = '1-1', title, server = null, image = '' }) {
      this.mediaId = mediaId;
      this.episodeId = episodeId;
      this.server = server;
      this._title = title || '';
      this._image = image;
      this.quality = localStorage.getItem('myflixerz-quality') || 'auto';
      this.audio = localStorage.getItem('myflixerz-audio') || 'auto';
      this._racedProviders = new Set(); // servers already raced & failed — skipped on re-race
      this._raceAttempts = 0; // bounded fallback budget per title (no infinite re-racing)
      this._intro = null;
      this._introFired = false;
      this._started = false;
      this._lastSave = 0;
      this._upNextShown = false; // fresh episode → pre-end window re-arms
      this.resumePos = 0;
      // subtitle sync resets per title/episode (each release syncs differently);
      // the watch view re-applies the stored per-title offset right after load()
      this._subBaseCues = null;
      this._subOffset = 0;
      this._subScale = 1;
      this._subAutoDone = false;
      this._failedSubs = new Set(); // fresh title → forget past subtitle failures
      // where we left off on THIS title+episode (resume on first successful attach)
      try {
        const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        this.resumePos = (map[`${mediaId}/${episodeId}`] || {}).pos || 0;
      } catch (e) {
        this.resumePos = 0;
      }
      this._pendingResume = this.resumePos > RESUME_MIN;
      this.showLoading('Finding streams…');
      API.sources(mediaId, episodeId, server)
        .then(async (res) => {
          // the hls.js script loads in parallel with this sources fetch —
          // by the time streams arrive it's almost always already on the page
          if (this._hlsReady) await this._hlsReady;
          this.sources = res.sources || [];
          this.provider = res.provider;
          // NOTE: no subtitle work here — /sources is stream-only by contract.
          // Tracks arrive later via setSubtitles() (fired from GET /subtitles).
          this.shell.dispatchEvent(
            new CustomEvent('sources-ready', { detail: { provider: res.provider } })
          );
          this._fetchIntro();
          this._play();
        })
        .catch((e) => this.showError(e.message));
    }

    _play() {
      if (!this.sources.length) return this._autoAdvance(this.provider); // empty server → race the rest
      this._started = true;
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

    // ---- volume boost beyond 100% (Web Audio) ----
    // video.volume tops out at 1.0 (100%). To go louder we route the element
    // through an audio graph: mediaElement → GainNode → DynamicsCompressor
    // (used as a near-limiter so boosted peaks never clip) → destination.
    // Once the graph is live, video.volume is held at 1 and the GainNode owns
    // loudness (1 = 100%, 2 = 200%, 4 = 400%).
    _ensureAudioGraph() {
      if (this._audioGain) {
        if (this._audioGraph && this._audioGraph.state === 'suspended') {
          this._audioGraph.resume().catch(() => {});
        }
        this._audioGain.gain.value = this._volume; // keep in sync
        return;
      }
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      try {
        const ctx = new Ctor();
        const source = ctx.createMediaElementSource(this.video);
        const gainNode = ctx.createGain();
        const limiterNode = ctx.createDynamicsCompressor();
        // Near-limiter: threshold near 0 dB, hard ratio, fast attack, slow
        // release — clamps boosted peaks instead of letting them crackle.
        limiterNode.threshold.value = -1;
        limiterNode.knee.value = 0;
        limiterNode.ratio.value = 16;
        limiterNode.attack.value = 0.002;
        limiterNode.release.value = 0.1;
        gainNode.connect(limiterNode);
        limiterNode.connect(ctx.destination);
        source.connect(gainNode);
        gainNode.gain.value = this._volume;
        this._audioGraph = ctx;
        this._audioGain = gainNode;
        this.video.volume = 1; // gain node now owns loudness (allows > 100%)
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      } catch (e) {
        // Web Audio unavailable — fall back to native volume (capped at 100%).
      }
    }

    /** Set volume in [0.1, 20] (10%–2000%). 1 = 100%, 2 = 200%, 4 = 400%, 20 = 2000%. */
    setVolume(v) {
      this._volume = Math.max(0.1, Math.min(20, Number(v) || 0.1));
      localStorage.setItem('myflixerz-volume', String(this._volume));
      if (this._audioGain) {
        this.video.volume = 1;
        this._audioGain.gain.value = this._volume;
      } else {
        // graph not live yet (no gesture): native element caps at 100%
        this.video.volume = Math.max(0, Math.min(1, this._volume));
      }
      this.shell.dispatchEvent(new CustomEvent('volume-change', { detail: { volume: this._volume } }));
    }

    getVolume() {
      return this._volume;
    }

    _attach(src) {
      this._currentSource = src;
      this._attachId = (this._attachId || 0) + 1;
      const attachId = this._attachId; // stale handlers from older attaches are ignored
      const url = playableUrl(src.url, src.referer, src.origin);
      this.hideLoading();

      // mid-playback re-attach (server switch, dead source, audio/quality
      // change): carry the current position over so the new stream resumes
      // here instead of restarting from 0. Skipped on the initial load — no
      // source yet (currentTime 0) or an already-pending localStorage resume.
      if (
        this._started &&
        !this._pendingResume &&
        this.video &&
        isFinite(this.video.currentTime) &&
        this.video.currentTime > RESUME_MIN
      ) {
        this.resumePos = this.video.currentTime;
        this._pendingResume = true;
      }

      // seek to the carried position once the (re)attached source reports a
      // real duration — fires once per _attach call
      this.video.addEventListener(
        'loadedmetadata',
        () => {
          if (!this._pendingResume || !this.video.duration) return;
          if (this.resumePos < this.video.duration - RESUME_MIN) {
            this.video.currentTime = this.resumePos;
            this.shell.dispatchEvent(new CustomEvent('progress-resumed', { detail: { pos: this.resumePos } }));
          }
          this._pendingResume = false;
        },
        { once: true }
      );

      if (this.hls) {
        this.hls.destroy();
        this.hls = null;
      }
      if (this.video.src) {
        this.video.removeAttribute('src');
        this.video.load();
      }

      if (src.isM3U8 && window.Hls && Hls.isSupported()) {
        // High-performance HLS config: Worker-offloaded demuxing, start prefetch, and generous back-buffer
        this.hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          backBufferLength: 90,
          maxBufferLength: 35,
          maxMaxBufferLength: 60,
          maxBufferHole: 0.5,
          startFragPrefetch: true,
          highBufferWatchdogPeriod: 2,
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
          if (attachId !== this._attachId) return; // ignore stale attach errors
          if (data.fatal) {
            this.hls.destroy();
            this.hls = null;
            this._fallbackNext();
          }
        });
      } else {
        this.video.src = url;
        this.video.play().catch(() => {});
        this.video.addEventListener('error', () => {
          if (attachId === this._attachId) this._fallbackNext();
        }, { once: true });
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
        this._autoAdvance(this.provider);
      }
    }

    // Watch-position persistence (powers resume + the Continue Watching row).
    // Throttled to one write per 5s; entry is removed once the title is over.
    _saveProgress(ended) {
      if (!this.mediaId || !this._started) return;
      const now = Date.now();
      if (!ended && this._lastSave && now - this._lastSave < 5000) return;
      this._lastSave = now;
      try {
        const map = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}');
        const key = `${this.mediaId}/${this.episodeId}`;
        const pos = this.video.currentTime || 0;
        const dur = this.video.duration || 0;
        if (ended || (dur && pos / dur > 0.95)) {
          delete map[key];
        } else if (pos > 5) {
          map[key] = { pos, dur, title: this._title, type: this.mediaId.split('/')[0], image: this._image, episodeId: this.episodeId, t: now };
        }
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
      } catch (e) {}
    }

    // ---- playback controls (keyboard + toolbar) ----
    togglePlay() {
      if (this.video.paused) this.video.play().catch(() => {});
      else this.video.pause();
    }

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else this.shell.requestFullscreen && this.shell.requestFullscreen().catch(() => {});
    }

    togglePip() {
      if (!this.video.requestPictureInPicture) return;
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else this.video.requestPictureInPicture().catch(() => {});
    }

    /** Nudge playback speed by `delta` (0.25), clamped to [0.25, 2]. */
    changeSpeed(delta) {
      const rate = Math.round((this.video.playbackRate + delta) * 100) / 100;
      this.video.playbackRate = Math.min(2, Math.max(0.25, rate));
      this.shell.dispatchEvent(new CustomEvent('speed-change', { detail: { rate: this.video.playbackRate } }));
    }

    /** /download URL for the currently attached source ('' if none loaded). */
    downloadUrl() {
      const src = this._currentSource;
      if (!src) return '';
      const p = new URLSearchParams({ url: src.url, title: this._title || 'cinephiles-download' });
      if (src.referer) p.set('ref', src.referer);
      if (src.isM3U8) p.set('hls', '1');
      // chosen quality: download exactly that variant playlist, not the
      // highest the master would give us
      if (src.isM3U8 && this.hls && this.quality !== 'auto') {
        const level = (this.hls.levels || []).find((l) => String(l.height) === String(this.quality));
        if (level && level.url) {
          try {
            new URL(level.url); // absolute
            p.set('url', level.url);
          } catch {
            /* relative — keep the master */
          }
        }
      }
      // subtitles: the selected track, or ALL available when none is picked
      const subs = this._subtitle ? [this._subtitle] : (this.subtitles || []);
      if (subs.length) p.set('subs', subs.map((s) => `${s.url}|${s.label || s.lang || ''}`).join(','));
      return `/download?${p.toString()}`;
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

    /**
     * A server failed — NEVER hang on the error. Re-race the REMAINING servers
     * (failed ones are skipped server-side) so we converge on a working server
     * instead of re-picking the same broken one forever. Bounded by
     * _raceAttempts: if every available provider has been raced and failed,
     * that's a real outage and worth an actual error message.
     */
    _autoAdvance(failedProvider) {
      if (!this._racedProviders) this._racedProviders = new Set();
      if (failedProvider) this._racedProviders.add(failedProvider);
      if (this._raceAttempts >= MAX_RACE_ATTEMPTS) {
        return this.showError('All servers failed. Try again later.');
      }
      this._raceAttempts += 1;
      const skip = [...this._racedProviders];
      const who = PROVIDER_LABELS[this.provider || this.server] || this.provider || this.server || 'a server';
      this.showLoading(
        skip.length
          ? `${who} failed — trying the next available server…`
          : 'Racing all servers — playing the fastest…'
      );
      this.switchServer(null, skip);
    }

    async switchServer(name, skip = []) {
      this.server = name;
      this.currentIndex = 0;
      this.showLoading(
        name
          ? `Connecting to ${PROVIDER_LABELS[name] || name}…`
          : skip.length
          ? 'Racing remaining servers — playing the fastest…'
          : 'Racing all servers — playing the fastest…'
      );
      try {
        const res = await API.sources(this.mediaId, this.episodeId, name, skip);
        // hls.js loads in parallel with this fetch; attach only when it's ready
        if (this._hlsReady) await this._hlsReady;
        this.sources = res.sources || [];
        this.provider = res.provider; // subtitle list is title-level & already loaded
        this.shell.dispatchEvent(
          new CustomEvent('sources-ready', { detail: { provider: res.provider } })
        );
        this._play();
      } catch (e) {
        // never surface the raw error while other servers may exist
        this._autoAdvance(name || this.provider);
      }
    }

    /**
     * Attach a freshly fetched subtitle list (arrives after playback started).
     * Re-emits so the watch view can populate the picker + auto-show English.
     */
    setSubtitles(list) {
      this.subtitles = Array.isArray(list) ? list : [];
      this.shell.dispatchEvent(
        new CustomEvent('subtitles-ready', { detail: { subtitles: this.subtitles } })
      );
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
      this._subtitle = url ? { url, label: label || '' } : null; // feeds the Download button
      // TextTracks aren't DOM children and can't be removed via removeChild, so
      // clear + hide every existing track (cues) so they never stack with the new one.
      [...(this.video.textTracks || [])].forEach((t) => {
        t.mode = 'hidden';
        const cues = t.cues;
        if (cues) for (let i = cues.length - 1; i >= 0; i--) cues.remove(cues[i]);
      });
      this._subTrack = null;
      this._subBaseCues = null; // new file → fresh raw cues, reset the fps guess
      this._subScale = 1;
      if (!url) {
        [...(this.video.textTracks || [])].forEach((t) => (t.mode = 'hidden'));
        return;
      }
      const track = this.video.addTextTrack('subtitles', label || 'Subtitle', 'en');
      this._subTrack = track;
      track.mode = 'hidden';
      track.addEventListener('cuechange', () => {}); // keep track alive for some engines
      // Subs often live on a CDN that wants the stream's Referer (and no CORS),
      // so fetch them through /play like the media — using the CURRENT source's
      // referer, not the default. This is what makes "subtitles are there but
      // won't show" actually display.
      const src = this._currentSource || (this.sources && this.sources[0]);
      const ref = src && src.referer;
      fetch(playableUrl(url, ref, src && src.origin))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subtitle fetch failed'))))
        .then((text) => {
          const vtt = isSrt(url) ? srtToVtt(text) : text;
          // stash the RAW cue times — offset/scale are applied in _addSubCues
          // so sync tweaks re-render instantly without refetching the file
          this._subBaseCues = parseVtt(vtt).map((c) => ({ start: c.startTime, end: c.endTime, text: c.text }));
          this._addSubCues(track);
          this._maybeAutoSync();
          [...(this.video.textTracks || [])].forEach((t) => (t !== track ? (t.mode = 'hidden') : null));
          track.mode = 'showing';
        })
        .catch((e) => {
          console.warn('subtitle:', e.message);
          this._failedSubs.add(url); // never auto-pick this track again
          this.shell.dispatchEvent(new CustomEvent('subtitle-error', { detail: { label: label || '' } }));
        });
    }

    /** Re-render the active track's cues with the current offset + fps scale. */
    _addSubCues(track) {
      if (!track || !this._subBaseCues) return;
      if (track.cues) for (let i = track.cues.length - 1; i >= 0; i--) track.cues[i].remove();
      const off = this._subOffset || 0;
      const scale = this._subScale || 1;
      for (const c of this._subBaseCues) {
        try {
          track.addCue(new VTTCue(Math.max(0, c.start * scale + off), Math.max(0.05, c.end * scale + off), c.text));
        } catch (e) {}
      }
    }

    /**
     * AUTO fps resync (runs once per loaded track). Subs timed for a different
     * framerate drift — e.g. a 23.976fps-timed SRT on a 25fps PAL stream makes
     * the video run 4.17% short, so cues overshoot increasingly. If
     * (last cue end / video duration) matches a known fps ratio within 1.5%,
     * rescale all cue times. Subs that end EARLY are normal (credits), so we
     * only ever act when they overshoot.
     */
    _maybeAutoSync() {
      if (this._subAutoDone || !this._subBaseCues || !this._subBaseCues.length) return;
      const d = this.video.duration;
      if (!Number.isFinite(d) || d < 600) return; // need a real runtime to judge
      const last = this._subBaseCues[this._subBaseCues.length - 1].end;
      if (!(last > d)) return;
      const ratio = last / d;
      const KNOWN = [25 / 23.976, 24 / 23.976, 25 / 24, 29.97 / 23.976, 30 / 23.976, 50 / 23.976];
      const hit = KNOWN.find((r) => Math.abs(ratio - r) / r < 0.015);
      if (!hit) return;
      this._subScale = 1 / hit;
      this._subAutoDone = true;
      this._addSubCues(this._subTrack);
    }

    /**
     * Shift subtitle timing by `sec` seconds (+ = subs show later). Re-renders
     * the active track instantly; emits 'subtitle-sync' so the watch view can
     * update the UI and persist per title+episode.
     */
    setSubtitleOffset(sec) {
      this._subOffset = Math.round((Number(sec) || 0) * 10) / 10; // 0.1s resolution
      this._addSubCues(this._subTrack);
      this.shell.dispatchEvent(new CustomEvent('subtitle-sync', { detail: { offset: this._subOffset } }));
    }

    /** True if a subtitle on this server is (or contains) English. */
    _isEnglishSub(s) {
      return /english|\beng\b|\ben\b|\beng subs?\b/i.test(`${s.label || ''} ${s.lang || ''}`);
    }

    /**
     * Smart default subtitle: return the subtitle to auto-show right now.
     *  - no subtitles -> null (Off)
     *  - stored pref 'off' -> null
     *  - stored pref is a label still present -> that one
     *  - otherwise the first English subtitle, else the first one
     */
    autoSubtitle() {
      // skip tracks that already failed to load this session — never re-pick one
      const subs = (this.subtitles || []).filter((s) => !(this._failedSubs && this._failedSubs.has(s.url)));
      if (!subs.length) return null;
      const pref = localStorage.getItem('myflixerz-subtitle') || '';
      if (pref === 'off') return null;
      const kept = pref ? subs.find((s) => s.label === pref) : null;
      if (kept) return kept;
      return subs.find((s) => this._isEnglishSub(s)) || subs[0];
    }

    /**
     * Netflix-style pre-end window: reveal "Next episode" shortly before the
     * current one finishes (once per episode).
     */
    _checkUpNext() {
      if (!this.nextEpisodeId || this._upNextShown) return;
      const d = this.video.duration;
      if (!Number.isFinite(d) || !d) return;
      const remaining = d - this.video.currentTime;
      if (remaining > 0 && remaining <= UP_NEXT_WINDOW_S) {
        this._upNextShown = true;
        this.shell.dispatchEvent(new CustomEvent('up-next'));
      }
    }

    /** Watch view supplies the next episode id (TV only); null hides everything. */
    setNextEpisode(episodeId) {
      this.nextEpisodeId = episodeId || null;
      this._upNextShown = false;
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

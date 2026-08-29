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
      // own loudness (up to 800%). A DynamicsCompressor (near-limiter) clamps
      // boosted peaks so we don't clip — that's what the ✓ boost experiment does.
      this._volume = Math.min(8, Math.max(0.1, Number(localStorage.getItem('myflixerz-volume') || '1')));
      this._audioGraph = null; // AudioContext
      this._audioGain = null; // GainNode (dangerously owns loudness > 1)
      this._subtitle = null; // {url,label} — feeds the Download button
      this.video.volume = this._volume > 1 ? 1 : Math.max(0, Math.min(1, this._volume));

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
        }
      });
    }

    load({ mediaId, episodeId = '1-1', title, server = null, image = '' }) {
      this.mediaId = mediaId;
      this.episodeId = episodeId;
      this.server = server;
      this._title = title || '';
      this._image = image;
      this.quality = localStorage.getItem('myflixerz-quality') || 'auto';
      this.audio = localStorage.getItem('myflixerz-audio') || 'auto';
      this._triedServers = null;
      this._intro = null;
      this._introFired = false;
      this._started = false;
      this._lastSave = 0;
      this._upNextShown = false; // fresh episode → pre-end window re-arms
      this.resumePos = 0;
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
        .then((res) => {
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
      if (!this.sources.length) return this.showError('No playable sources found.');
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

    /** Set volume in [0.1, 8] (10%–800%). 1 = 100%, 2 = 200%, 4 = 400%, 8 = 800%. */
    setVolume(v) {
      this._volume = Math.max(0.1, Math.min(8, Number(v) || 0.1));
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
      const url = playableUrl(src.url, src.referer);
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

    // All streams on the current server died — move to the next server with a
    // visible notice (each server re-resolves its own sources). Bounded by
    // _triedServers so we never loop forever.
    _autoAdvance() {
      this.showLoading(`Server ${PROVIDER_LABELS[this.server] || this.server || '?'} failed — trying next…`);
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
        this.provider = res.provider; // subtitle list is title-level & already loaded
        this.shell.dispatchEvent(
          new CustomEvent('sources-ready', { detail: { provider: res.provider } })
        );
        this._play();
      } catch (e) {
        this.showError(e.message);
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
      fetch(playableUrl(url, ref))
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subtitle fetch failed'))))
        .then((text) => {
          const vtt = isSrt(url) ? srtToVtt(text) : text;
          parseVtt(vtt).forEach((c) => track.addCue(c));
          [...(this.video.textTracks || [])].forEach((t) => (t !== track ? (t.mode = 'hidden') : null));
          track.mode = 'showing';
        })
        .catch((e) => {
          console.warn('subtitle:', e.message);
          this.shell.dispatchEvent(new CustomEvent('subtitle-error', { detail: { label: label || '' } }));
        });
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
      const subs = this.subtitles || [];
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

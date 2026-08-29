// MyFlixz frontend: hash router, search, views.
(() => {
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const navLinks = document.getElementById('navLinks');
  const searchInput = document.getElementById('navSearch');
  const searchDropdown = document.getElementById('searchDropdown');

  const GENRES = ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War'];
  // Markup helpers live in render.js — shared with the server's SSR pass so
  // pre-rendered HTML and client-rendered HTML can never drift apart.
  const { card, grid, skeletonRow, rowWithArrows, escapeHtml, homeView } = Render;

  // ---------------- helpers ----------------
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function toastMsg(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.hidden = true), 2600);
  }

  // hls.js (~400KB) loads only when a watch page opens; browse/search pages
  // never pay for it. Cached by the service worker after first use.
  let hlsPromise = null;
  function loadHls() {
    if (window.Hls) return Promise.resolve();
    if (!hlsPromise) {
      hlsPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js';
        s.onload = () => resolve();
        s.onerror = () => {
          hlsPromise = null; // allow retry
          reject(new Error('hls.js failed to load'));
        };
        document.head.appendChild(s);
      });
    }
    return hlsPromise;
  }

  function scrollTop() {
    window.scrollTo({ top: 0 });
  }

  // ---- continue watching (from saved watch positions) ----
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function continueWatchingItems() {
    try {
      const map = JSON.parse(localStorage.getItem('myflixerz-progress') || '{}');
      return Object.entries(map)
        .filter(([, e]) => e.pos > 30 && (!e.dur || e.dur - e.pos > 15))
        .map(([key, e]) => {
          const [type, id] = key.split('/');
          return {
            id: `${type}/${id}`,
            href: type === 'tv' ? `#/watch/${type}/${id}/${e.episodeId || '1-1'}` : `#/watch/${type}/${id}`,
            title: e.title || 'Continue watching',
            image: e.image || '',
            releaseDate: '',
            type,
            progress: e.dur ? Math.round((e.pos / e.dur) * 100) : 0,
            _t: e.t || 0,
          };
        })
        .sort((a, b) => b._t - a._t)
        .slice(0, 10);
    } catch (e) {
      return [];
    }
  }

  const prefetched = new Set();
  function prefetchMedia(href) {
    if (!href || prefetched.has(href)) return;
    prefetched.add(href);
    const m = href.match(/^#\/(movie|tv)\/(\d+)/);
    if (m) {
      const mediaId = `${m[1]}/${m[2]}`;
      API.info(mediaId).catch(() => {});
      API.sources(mediaId, '1-1').catch(() => {});
    }
  }

  function bindCards(scope) {
    scope.querySelectorAll('.card[data-href]').forEach((c) => {
      c.addEventListener('click', () => (location.hash = c.dataset.href));
      c.addEventListener('mouseenter', () => prefetchMedia(c.dataset.href), { passive: true, once: true });
      c.addEventListener('touchstart', () => prefetchMedia(c.dataset.href), { passive: true, once: true });
    });
  }

  function bindRowArrows(scope) {
    scope.querySelectorAll('.row-wrap').forEach((wrap) => {
      const row = wrap.querySelector('.row');
      const prev = wrap.querySelector('.prev');
      const next = wrap.querySelector('.next');
      prev.addEventListener('click', () => row.scrollBy({ left: -560, behavior: 'smooth' }));
      next.addEventListener('click', () => row.scrollBy({ left: 560, behavior: 'smooth' }));
    });
  }

  // ---------------- search dropdown ----------------
  let searchTimer = null;
  let searchAbort = null;

  async function runSearch(q) {
    clearTimeout(searchTimer);
    searchAbort?.abort();
    if (!q) {
      searchDropdown.classList.remove('open');
      return;
    }
    searchTimer = setTimeout(async () => {
      searchDropdown.classList.add('open');
      searchDropdown.innerHTML = '<div class="sd-loading">Searching…</div>';
      const ac = (searchAbort = new AbortController());
      try {
        const res = await fetch(`/search?query=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        if (ac.signal.aborted) return;
        const items = (data.results || []).slice(0, 6);
        if (!items.length) {
          searchDropdown.innerHTML = '<div class="sd-empty">No results for "' + escapeHtml(q) + '"</div>';
          return;
        }
        searchDropdown.innerHTML = items
          .map((it) => {
            const [type, id] = it.id.split('/');
            return `
              <div class="sd-item" data-href="#/${type}/${id}">
                ${it.image ? `<img class="sd-poster" src="${it.image}" alt="" loading="lazy"/>` : `<div class="sd-poster"></div>`}
                <div class="sd-info">
                  <div class="sd-title">${escapeHtml(it.title)}</div>
                  <div class="sd-meta">${it.releaseDate ? it.releaseDate + ' · ' : ''}${TYPE_LABEL[type]}</div>
                </div>
                <span class="sd-type ${type}">${TYPE_LABEL[type]}</span>
              </div>`;
          })
          .join('') +
          `<div class="sd-item" data-href="#/search?q=${encodeURIComponent(q)}">
             <div class="sd-info"><div class="sd-title" style="color:var(--accent)">See all results for “${escapeHtml(q)}”</div></div>
           </div>`;
        searchDropdown.querySelectorAll('.sd-item').forEach((it) =>
          it.addEventListener('click', () => {
            location.hash = it.dataset.href;
            closeSearch();
          })
        );
      } catch (e) {
        if (!ac.signal.aborted) searchDropdown.classList.remove('open');
      }
    }, 220);
  }

  function closeSearch() {
    searchDropdown.classList.remove('open');
  }

  // ---------------- nav ----------------
  function setActiveNav(route) {
    navLinks.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.nav === route));
  }

  function openMobileSearch() {
    const box = document.getElementById('searchBox');
    box.classList.toggle('mobile-open');
    box.classList.toggle('hidden');
    if (box.classList.contains('mobile-open')) searchInput.focus();
  }

  document.getElementById('searchToggle').addEventListener('click', openMobileSearch);
  searchInput.addEventListener('input', () => runSearch(searchInput.value));
  searchInput.addEventListener('focus', () => searchInput.value && runSearch(searchInput.value));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) {
      location.hash = `#/search?q=${encodeURIComponent(searchInput.value.trim())}`;
      closeSearch();
      document.getElementById('searchBox').classList.remove('mobile-open', 'hidden');
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) closeSearch();
  });

  // ---------------- views ----------------
  const views = {};

  // ---- home ----
  views.home = async () => {
    scrollTop();
    setActiveNav(null);
    // The server pre-renders this view into the HTML (data-ssr-home on
    // <main>) — the rows are already painted, so skip the template and the
    // four fetches. The attribute is consumed once: navigating away and back
    // falls through to the normal fetch path (server-side cache makes that
    // cheap anyway).
    const ssr = view.hasAttribute('data-ssr-home');
    if (!ssr) view.innerHTML = homeView(null);
    view.removeAttribute('data-ssr-home');

    const heroInput = document.getElementById('heroSearch');
    const heroBtn = document.getElementById('heroSearchBtn');
    if (heroInput && heroBtn) {
      const go = () => {
        if (heroInput.value.trim()) location.hash = `#/search?q=${encodeURIComponent(heroInput.value.trim())}`;
      };
      heroBtn.addEventListener('click', go);
      heroInput.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      heroInput.addEventListener('input', () => runSearch(heroInput.value));
    }

    // Continue Watching row from saved positions (hidden when nothing is in progress)
    const cwItems = continueWatchingItems();
    if (cwItems.length) {
      const cw = view.querySelector('#cwSection');
      cw.hidden = false;
      cw.querySelector('.row-wrap').outerHTML = rowWithArrows(cwItems.map(card).join(''));
    }

    if (ssr) {
      // rows already painted server-side — wire everything up once, no fetches
      bindRowArrows(view);
      bindCards(view);
      return;
    }

    // fetch path: bind the Continue Watching row (the four data rows get
    // replaced + rebound below once their data arrives)
    if (cwItems.length) {
      bindRowArrows(view);
      bindCards(view);
    }

    const sections = [
      ['/trending/movies', 'trending-movies'],
      ['/trending/tv', 'trending-tv'],
      ['/top-imdb?type=movie&minVote=7.5', 'imdb75'],
      ['/recent/movies', 'now-playing'],
      ['/top-imdb?type=all', 'top-rated'],
    ];
    // all four rows fetch in parallel (was sequential: 4 round-trips in a row);
    // one failure degrades to an empty row instead of stalling the rest
    const results = await Promise.all(
      sections.map(async ([ep]) => {
        try {
          const data = await API.get(ep);
          return Array.isArray(data) ? data : data.results || [];
        } catch (e) {
          console.warn(ep, e);
          return [];
        }
      })
    );
    sections.forEach(([, sel], i) => {
      const items = results[i];
      const sectionEl = view.querySelectorAll('.section[data-row]')[i];
      sectionEl.querySelector('.row-wrap').outerHTML = rowWithArrows(
        items.slice(0, 14).map(card).join('')
      );
      bindRowArrows(view);
      bindCards(view);
    });
  };

  // ---- browse ----
  views.browse = async (params) => {
    const kind = params.kind; // movies | tv-shows | top-rated | genre
    const genre = params.genre || null;
    scrollTop();
    setActiveNav(kind === 'movies' ? 'movies' : kind === 'tv-shows' ? 'tv' : kind === 'imdb75' ? 'imdb75' : 'top');

    let title = 'Movies', sub = 'All movies';
    if (kind === 'tv-shows') { title = 'TV Shows'; sub = 'All TV shows'; }
    if (kind === 'top-rated') { title = 'Top Rated'; sub = 'The best of the best'; }
    if (kind === 'imdb75') { title = 'IMDb 7.5+ Movies'; sub = 'Critically loved films, all in one place — no searching needed'; }
    if (genre) { title = genre; sub = 'Movies in this genre'; }

    view.innerHTML = `
      <div class="page-head">
        <h1>${escapeHtml(title)}</h1><p>${escapeHtml(sub)}</p>
        ${kind === 'movies' || kind === 'genre' ? `<div class="chips">${GENRES.map((g) => `<a class="chip ${genre === g ? 'active' : ''}" href="#/genre/${g}">${g}</a>`).join('')}</div>` : ''}
      </div>
      <div class="section" id="browseGrid">
        <div class="grid">${'<div class="skel" style="aspect-ratio:2/3"></div>'.repeat(18)}</div>
        <button class="load-more" id="loadMore">Load more</button>
      </div>`;

    const gridEl = view.querySelector('#browseGrid .grid');
    const loadBtn = view.querySelector('#loadMore');
    let page = 1;
    let hasNext = true;

    async function loadPage() {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading…';
      try {
        // Page 1 of the movies grid ships inside the HTML (__INITIAL__, set
        // by the server alongside the home SSR) — the grid paints without a
        // round-trip. One-shot: consumed once, later pages fetch normally.
        let data = null;
        // Page-1 results ship inside the HTML (__INITIAL__, set by the server
        // alongside the home SSR) — the grid paints without a round-trip.
        // One-shot per kind: consumed once, later pages fetch normally.
        const init = window.__INITIAL__ && window.__INITIAL__.browse && window.__INITIAL__.browse[kind];
        if (page === 1 && init) {
          data = { results: init, hasNextPage: true };
          delete window.__INITIAL__.browse[kind];
        } else {
          data = kind === 'genre'
            ? await API.genre(genre, page)
            : kind === 'top-rated'
              ? await API.topImdb('all', page)
              : kind === 'imdb75'
                ? await API.imdb75(page)
                : await API.browse(kind === 'tv-shows' ? 'tv' : 'movies', page);
        }
        const items = data.results || [];
        hasNext = !!data.hasNextPage;
        if (page === 1) gridEl.innerHTML = ''; // drop the skeleton placeholders
        gridEl.insertAdjacentHTML('beforeend', items.map(card).join(''));
        bindCards(view);
        page++;
      } catch (e) {
        toastMsg('Failed to load: ' + e.message);
      }
      if (!hasNext) loadBtn.style.display = 'none';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load more';
    }
    loadBtn.addEventListener('click', loadPage);
    loadPage();
  };

  // ---- search results ----
  views.search = async (params) => {
    const q = params.q || '';
    scrollTop();
    setActiveNav(null);
    view.innerHTML = `
      <div class="page-head">
        <h1>Results for “${escapeHtml(q)}”</h1><p>Movies &amp; TV shows</p>
      </div>
      <div class="section">
        <div class="grid" id="searchGrid">${'<div class="skel" style="aspect-ratio:2/3"></div>'.repeat(12)}</div>
        <button class="load-more" id="loadMore" style="display:none">Load more</button>
        <div class="empty" id="noResults" hidden><div class="big">🔍</div><h3>No results found</h3><p>Try a different title or spelling.</p></div>
      </div>`;

    const gridEl = view.querySelector('#searchGrid');
    let page = 1, hasNext = true;
    const loadBtn = view.querySelector('#loadMore');
    const noResults = view.querySelector('#noResults');

    async function loadPage() {
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading…';
      try {
        const data = await API.search(q, page);
        const items = data.results || [];
        hasNext = !!data.hasNextPage;
        if (!items.length && page === 1) {
          gridEl.innerHTML = '';
          noResults.hidden = false;
        } else {
          if (page === 1) gridEl.innerHTML = ''; // drop the skeleton placeholders
          gridEl.insertAdjacentHTML('beforeend', items.map(card).join(''));
          bindCards(view);
        }
        page++;
      } catch (e) {
        toastMsg('Search failed: ' + e.message);
      }
      loadBtn.style.display = hasNext ? 'block' : 'none';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load more';
    }
    loadBtn.addEventListener('click', loadPage);
    loadPage();
  };

  // ---- detail ----
  views.detail = async (params) => {
    const type = params.type;
    const id = params.id;
    const mediaId = `${type}/${id}`;
    scrollTop();
    setActiveNav(type === 'movie' ? 'movies' : 'tv');
    view.innerHTML = `
      <div class="detail-hero">
        <div class="detail-bg" id="bg"></div>
        <div class="detail-main">
          <div class="detail-poster skel"></div>
          <div class="detail-info">
            <h1><span class="skel" style="display:inline-block;height:34px;width:340px;max-width:80%"></span></h1>
            <div class="detail-meta"><span class="skel" style="height:24px;width:160px"></span></div>
            <div class="skel" style="height:14px;margin:6px 0;width:100%"></div>
            <div class="skel" style="height:14px;margin:6px 0;width:90%"></div>
            <div class="skel" style="height:14px;margin:6px 0;width:70%"></div>
          </div>
        </div>
      </div>`;

    // Fire-and-forget prefetch while the user reads this page: by the time
    // Play is clicked the server's short-TTL caches usually hold the resolved
    // stream (+ subtitle tracks), so playback attaches near-instantly. Both
    // calls are deduped/bounded server-side; failures are irrelevant here.
    API.sources(mediaId).catch(() => {});
    API.subtitles(mediaId).catch(() => {});

    let info;
    try {
      info = await API.info(mediaId);
    } catch (e) {
      view.innerHTML = `<div class="empty"><div class="big">😕</div><h3>Couldn't load this title</h3><p>${escapeHtml(e.message)}</p><a class="chip" style="display:inline-block;margin-top:16px" href="#/">Back home</a></div>`;
      return;
    }

    const hero = view.querySelector('.detail-bg');
    if (info.cover) hero.style.backgroundImage = `url(${hiRes(info.cover)})`;
    const recs = info.recommendations || [];
    const episodes = info.episodes || [];

    view.innerHTML = `
      <div class="detail-hero">
        <div class="detail-bg" style="background-image:url(${hiRes(info.cover) || ''})"></div>
        <div class="detail-main">
          <div class="detail-poster">${info.image ? `<img src="${info.image}" alt="${escapeHtml(info.title)}"/>` : ''}</div>
          <div class="detail-info">
            <h1>${escapeHtml(info.title)}</h1>
            <div class="detail-meta">
              <span class="chip-static rating">★ ${Number(info.rating || 0).toFixed(1)}</span>
              <span class="chip-static">${escapeHtml(info.releaseDate || '')}</span>
              ${info.duration ? `<span class="chip-static">${escapeHtml(info.duration)}</span>` : ''}
              <span class="chip-static hd">HD</span>
              ${(info.genres || []).map((g) => `<span class="chip-static">${escapeHtml(g)}</span>`).join('')}
            </div>
            <p class="detail-desc">${escapeHtml(info.description || 'No description available.')}</p>
            <div class="play-actions">
              <button class="btn btn-primary" id="playBtn">Watch now</button>
            </div>
          </div>
        </div>
      </div>
      <div class="section">
        ${type === 'tv' ? `
          <div class="season-bar">
            <h3>Episodes</h3>
            <select class="season-select" id="seasonSelect"></select>
          </div>
          <div class="episodes" id="episodes"></div>
        ` : ''}
      </div>
      ${recs.length ? `
      <div class="section">
        <div class="section-head"><h2>More like this</h2></div>
        ${rowWithArrows(recs.map(card).join(''))}
      </div>` : ''}`;

    bindRowArrows(view);
    bindCards(view);

    // play button → watch page
    const playBtn = view.querySelector('#playBtn');
    playBtn.addEventListener('click', () => {
      if (type === 'movie') {
        location.hash = `#/watch/movie/${id}`;
      } else {
        const ep = episodes[0];
        location.hash = ep ? `#/watch/tv/${id}/${ep.id}` : `#/watch/tv/${id}/1-1`;
      }
    });

    // episodes
    if (type === 'tv' && episodes.length) {
      const seasons = [...new Set(episodes.map((e) => e.season))].sort((a, b) => a - b);
      const select = view.querySelector('#seasonSelect');
      select.innerHTML = seasons.map((s) => `<option value="${s}">Season ${s}</option>`).join('');
      const epGrid = view.querySelector('#episodes');

      function renderSeason(s) {
        epGrid.innerHTML = episodes
          .filter((e) => e.season === s)
          .map(
            (e) => `
            <div class="episode" data-href="#/watch/tv/${id}/${e.id}">
              <div class="ep-thumb" style="background:linear-gradient(135deg,var(--surface-2),var(--surface))"></div>
              <div class="ep-body">
                <div class="ep-title">${e.number}. ${escapeHtml(e.title || 'Episode ' + e.number)}</div>
                <div class="ep-num">S${e.season} · E${e.number}</div>
              </div>
            </div>`
          )
          .join('');
        epGrid.querySelectorAll('.episode').forEach((x) =>
          x.addEventListener('click', () => (location.hash = x.dataset.href))
        );
      }
      select.addEventListener('change', () => renderSeason(parseInt(select.value)));
      renderSeason(seasons[0]);
    }
  };

  // ---- watch ----
  views.watch = async (params) => {
    const type = params.type;
    const id = params.id;
    const episodeId = params.episodeId || '1-1';
    const mediaId = `${type}/${id}`;
    scrollTop();
    setActiveNav(null);

    let info = null;
    try {
      info = await API.info(mediaId);
    } catch (e) {}

    const title = info ? info.title : type === 'movie' ? 'Movie' : 'TV Show';
    const epLabel = type === 'tv' && episodeId.includes('-')
      ? `S${episodeId.split('-')[0]} · E${episodeId.split('-')[1]}`
      : '';

    view.innerHTML = `
      <div class="watch">
        <div class="watch-head">
          <a class="back" href="#/${type}/${id}">← Back to details</a>
          <h1>${escapeHtml(title)}</h1>
          <span class="sub">${epLabel}</span>
        </div>
        <div class="player-shell">
          <video controls autoplay playsinline></video>
          <div class="player-loading">
            <div class="spinner"></div>
            <div class="pl-text">Finding streams…</div>
          </div>
          <div class="player-error" hidden><div style="font-size:2rem">⚠️</div><div class="pe-msg"></div></div>
          <button class="skip-intro">Skip intro</button>
          <button class="next-ep">▶ Next episode</button>
        </div>
        <div class="player-bar" id="serverBar"></div>
        <div class="watch-head" style="margin-top:20px">
          <button class="subs-select ctl-btn" id="nextChip" hidden title="Play the next episode">▶ Next episode</button>
          <select class="subs-select" id="audioSelect" hidden>
            <option value="auto">Audio: Auto</option>
          </select>
          <select class="subs-select" id="qualitySelect" hidden>
            <option value="auto">Quality: Auto</option>
          </select>
          <select class="subs-select" id="subsSelect">
            <option value="">Subtitles: Off</option>
          </select>
          <button class="subs-select ctl-btn" id="speedBtn" title="Playback speed (shortcuts: > / <)">Speed: 1x</button>
          <button class="subs-select ctl-btn" id="pipBtn" title="Picture in picture">⧉ PiP</button>
          <button class="subs-select ctl-btn" id="downloadBtn" title="Download this video">↓ Download</button>
          <span class="vol-wrap">
            <button class="subs-select ctl-btn" id="volBtn" title="Volume (shortcuts: ↑ / ↓)">🔊 100%</button>
            <div class="vol-pop" id="volPop" hidden>
              <input id="volRange" type="range" min="10" max="800" value="100" step="5" />
              <span id="volLabel">100%</span>
            </div>
          </span>
          <span class="sub" id="providerInfo"></span>
        </div>
      </div>`;

    // server buttons
    const bar = view.querySelector('#serverBar');
    try {
      const servers = await API.servers();
      const labels = Player.PROVIDER_LABELS;
      bar.innerHTML =
        `<button class="server-btn active" data-server="">Auto</button>` +
        servers
          .map((s) => `<button class="server-btn" data-server="${s.name}">${labels[s.name] || s.name}</button>`)
          .join('');
      bar.querySelectorAll('.server-btn').forEach((b) =>
        b.addEventListener('click', () => {
          bar.querySelectorAll('.server-btn').forEach((x) => x.classList.remove('active'));
          b.classList.add('active', 'loading');
          player.switchServer(b.dataset.server).finally(() => b.classList.remove('loading'));
        })
      );
    } catch (e) {}

    // player (hls.js lazy-loaded — only the watch page needs it)
    await loadHls().catch(() => {});
    const shell = view.querySelector('.player-shell');
    const player = new Player.MoviePlayer(shell);
    const subsSelect = view.querySelector('#subsSelect');

    // toolbar: speed + PiP + download + resume notice
    const speedBtn = view.querySelector('#speedBtn');
    const pipBtn = view.querySelector('#pipBtn');
    const downloadBtn = view.querySelector('#downloadBtn');
    if (!document.pictureInPictureEnabled || !document.createElement('video').requestPictureInPicture) {
      pipBtn.hidden = true;
    }
    shell.addEventListener('speed-change', (e) => {
      const r = Math.round(e.detail.rate * 100) / 100;
      speedBtn.textContent = `Speed: ${r}x`;
    });
    speedBtn.addEventListener('click', () => player.changeSpeed(0.25));
    pipBtn.addEventListener('click', () => player.togglePip());
    downloadBtn.addEventListener('click', () => {
      const href = player.downloadUrl();
      if (!href) return toastMsg('No stream loaded yet.');
      const a = document.createElement('a');
      a.href = href;
      a.download = ''; // same-origin → filename comes from Content-Disposition
      document.body.appendChild(a);
      a.click();
      a.remove();
      toastMsg('Download started — check your Downloads folder.');
    });
    // volume boost (>100% via Web Audio gain). Button shows the live %, popup
    // has a 10–400% slider; the player routes through gain+limiter.
    const volBtn = view.querySelector('#volBtn');
    const volPop = view.querySelector('#volPop');
    const volRange = view.querySelector('#volRange');
    const volLabel = view.querySelector('#volLabel');
    const syncVol = (v) => {
      const pct = Math.round(v * 100);
      volRange.value = pct;
      volLabel.textContent = pct + '%';
      volBtn.textContent = (pct > 150 ? '🔊' : pct > 100 ? '🔉' : '🔈') + ' ' + pct + '%';
      volBtn.title = `Volume ${pct}% (boost beyond 100%; shortcut: ↑ / ↓)`;
    };
    volBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      volPop.hidden = !volPop.hidden;
    });
    volRange.addEventListener('input', () => player.setVolume(Number(volRange.value) / 100));
    player.shell.addEventListener('volume-change', (e) => syncVol(e.detail.volume));
    document.addEventListener('click', (e) => {
      if (!volPop.contains(e.target) && !volBtn.contains(e.target)) volPop.hidden = true;
    });
    syncVol(player.getVolume());
    shell.addEventListener('progress-resumed', (e) => toastMsg(`Resumed from ${fmtTime(e.detail.pos)}`));
    // Subtitle UI lives on the 'subtitles-ready' event: tracks arrive on their
    // OWN timeline (GET /subtitles → player.setSubtitles) — potentially well
    // after first frame. sources-ready only refreshes the count/label and
    // reapplies the pick after a server switch.
    function refreshSubtitleUI() {
      const subs = player.subtitles || [];
      subsSelect.innerHTML = '<option value="">Subtitles: Off</option>' +
        subs.map((s, i) => `<option value="${i}">${escapeHtml(s.label || s.lang || 'Subtitle ' + (i + 1))}</option>`).join('');
      subsSelect.disabled = subs.length === 0;
      // Smart subtitles: auto-show the stored choice, else the English track
      // (autoSubtitle returns null for 'off' or when no subs exist).
      const auto = player.autoSubtitle();
      const autoIdx = auto ? subs.indexOf(auto) : -1;
      subsSelect.value = autoIdx >= 0 ? String(autoIdx) : '';
      player.loadSubtitle(auto ? auto.url : '', auto ? auto.label : '');
      if (auto && !localStorage.getItem('myflixerz-subtitle')) {
        localStorage.setItem('myflixerz-subtitle', auto.label); // remember across views
      }
    }
    shell.addEventListener('subtitles-ready', () => refreshSubtitleUI());
    shell.addEventListener('sources-ready', (e) => {
      const labels = Player.PROVIDER_LABELS;
      const p = e.detail.provider;
      const n = (player.subtitles || []).length;
      document.getElementById('providerInfo').textContent =
        p ? `Server: ${labels[p] || p}${n ? ` · ${n} subtitle${n === 1 ? '' : 's'}` : ''}` : '';
      if ((player.subtitles || []).length) refreshSubtitleUI(); // server switch → reapply
      collectDubs();
    });
    subsSelect.addEventListener('change', () => {
      const i = subsSelect.value;
      const sub = i === '' ? null : (player.subtitles || [])[parseInt(i, 10)];
      player.loadSubtitle(sub ? sub.url : '', sub ? sub.label : '');
      localStorage.setItem('myflixerz-subtitle', sub ? sub.label : 'off'); // Off = remember "no subs"
    });
    shell.addEventListener('subtitle-error', (e) => toastMsg(`Subtitle failed to load${e.detail.label ? ': ' + e.detail.label : ''} `));
    // audio dropdown — lists every dub across the dub-capable servers, not just
    // the current one. Picking a language that lives on another server switches
    // to it automatically. Resolution-suffixed labels (English-Hindi-1080p)
    // mean the language is merged into the stream — no choice needed, skip.
    const DUB_LABELS = { esla: 'Spanish (LATAM)', ptbr: 'Portuguese (BR)' };
    const audioSelect = view.querySelector('#audioSelect');
    const dubOwner = {}; // dub -> server name
    let audioProbeDone = false;

    function renderAudioSelect() {
      const dubs = Object.keys(dubOwner);
      if (!dubs.length) {
        audioSelect.hidden = true;
        return;
      }
      audioSelect.hidden = false;
      audioSelect.innerHTML =
        '<option value="auto">Audio: Auto</option>' +
        dubs.map((d) => `<option value="${d}">${DUB_LABELS[d] || d}</option>`).join('');
      audioSelect.value = dubOwner[player.audio] ? player.audio : 'auto';
    }

    async function collectDubs() {
      const clean = (d) => Boolean(d) && !/\d{3,4}p$/i.test(d);
      (player.sources || []).forEach((s) => {
        if (clean(s.dub) && !dubOwner[s.dub]) dubOwner[s.dub] = player.server || player.provider;
      });
      if (!audioProbeDone) {
        audioProbeDone = true;
        try {
          const res = await API.dubs(mediaId, episodeId);
          for (const [server, list] of Object.entries(res)) {
            (list || []).forEach((d) => {
              if (clean(d) && !dubOwner[d]) dubOwner[d] = server;
            });
          }
        } catch (e) {}
      }
      renderAudioSelect();
    }

    audioSelect.addEventListener('change', (e) => {
      const value = e.target.value;
      if (!value || value === 'auto') {
        player.setAudio('auto');
        return;
      }
      const owner = dubOwner[value];
      const current = player.server || player.provider;
      if (owner && owner !== current) {
        // language lives on another server — switch, then apply it
        bar.querySelectorAll('.server-btn').forEach((x) => x.classList.toggle('active', x.dataset.server === owner));
        player
          .switchServer(owner)
          .then(() => {
            player.setAudio(value);
            audioSelect.value = value;
          })
          .catch(() => {
            audioSelect.value = 'auto';
            renderAudioSelect();
          });
        return;
      }
      player.setAudio(value);
      audioSelect.value = value;
    });

    // quality picker — populated when the manifest/sources load; the player
    // re-applies the stored choice (localStorage) on every new manifest
    const qualitySelect = view.querySelector('#qualitySelect');
    qualitySelect.addEventListener('change', () => player.setQuality(qualitySelect.value));
    shell.addEventListener('quality-ready', (e) => {
      const levels = (e.detail.levels || []).map(String);
      if (!levels.length) {
        qualitySelect.hidden = true;
        return;
      }
      qualitySelect.hidden = false;
      qualitySelect.innerHTML =
        '<option value="auto">Quality: Auto</option>' +
        levels.map((h) => `<option value="${h}">${h}p</option>`).join('');
      qualitySelect.value = levels.includes(String(player.quality)) ? player.quality : 'auto';
    });
    // Subtitle enrichment fired NOW, in parallel with player.load — it rides
    // its own endpoint and attaches whenever it lands (never blocks play).
    API.subtitles(mediaId, episodeId)
      .then((res) => player.setSubtitles(res && res.subtitles))
      .catch(() => {}); // silent — zero tracks is a fine outcome

    // ---- next episode (TV): click straight into the next one, no detail-page
    // round trip. Cross-season-aware (S1 finale → S2E1). ROBUSTNESS: never
    // depends on the single awaited /info attempt above — if it failed (fresh
    // server, blip), we retry independently here; both paths share one apply().
    const nextBtn = view.querySelector('.next-ep');
    const nextChip = view.querySelector('#nextChip');
    const applyNext = (epsRaw) => {
      if (!Array.isArray(epsRaw) || !epsRaw.length || !nextBtn) return false;
      // normalize whatever episodeId shape arrives ('2-10', 's2e10', '2/e10')
      const norm = (v) => {
        const m = String(v).match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
        return m ? [Number(m[1]), Number(m[2])] : null;
      };
      const eps = [...epsRaw].sort((a, b) => a.season - b.season || a.number - b.number);
      // exact id match first, structured fallback (NEVER default to eps[0])
      let i = eps.findIndex((e) => String(e.id) === String(episodeId));
      if (i < 0) {
        const cur = norm(episodeId);
        if (!cur) return false;
        i = eps.findIndex((e) => e.season === cur[0] && e.number === cur[1]);
      }
      if (i < 0) return false;
      const nxt = eps[i + 1];
      if (!nxt) return false; // last episode — nothing to offer
      player.setNextEpisode(nxt.id);
      const go = () => { location.hash = `#/watch/${type}/${id}/${nxt.id}`; };
      nextBtn.onclick = go;
      nextChip.onclick = go;
      nextChip.hidden = false;
      nextChip.textContent = `▶ S${nxt.season} · E${nxt.number}`;
      return true;
    };
    const wirePillReveal = () => {
      if (!nextBtn) return;
      const reveal = () => { if (player.nextEpisodeId) nextBtn.classList.add('show'); };
      shell.addEventListener('up-next', reveal);
      shell.addEventListener('episode-ended', reveal);
    };
    wirePillReveal();
    if (type === 'tv') {
      if (!applyNext(info && info.episodes)) {
        API.info(mediaId)
          .then((inf) => applyNext(inf && inf.episodes))
          .catch(() => {}); // silent: last-episode/no-data hides the affordance
      }
    }

    player.load({ mediaId, episodeId, title, image: info ? info.image : '' });
  };

  // ---------------- router ----------------
  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, query] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = Object.fromEntries(new URLSearchParams(query || ''));
    return { parts, params };
  }

  async function route() {
    const { parts, params } = parseHash();
    // The SSR home markup only survives until the first navigation — any
    // other view replaces it, so the flag must not outlive that render
    // (otherwise a later home visit would skip its template and query DOM
    // that no longer exists).
    if (parts.length) view.removeAttribute('data-ssr-home');
    if (!parts.length) return views.home();
    switch (parts[0]) {
      case 'movie':
      case 'tv':
        if (parts[1]) return views.detail({ type: parts[0], id: parts[1] });
        break;
      case 'watch':
        if (parts[1] && parts[2]) return views.watch({ type: parts[1], id: parts[2], episodeId: parts[3] || '1-1' });
        break;
      case 'movies':
        return views.browse({ kind: 'movies' });
      case 'tv-shows':
        return views.browse({ kind: 'tv-shows' });
      case 'top-rated':
        return views.browse({ kind: 'top-rated' });
      case 'imdb75':
        return views.browse({ kind: 'imdb75' });
      case 'genre':
        if (parts[1]) return views.browse({ kind: 'genre', genre: parts[1] });
        break;
      case 'search':
        if (params.q) return views.search({ q: params.q });
        break;
    }
    views.home();
  }

  window.addEventListener('hashchange', route);
  route();
})();

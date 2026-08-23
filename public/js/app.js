// MyFlixz frontend: hash router, search, views.
(() => {
  const view = document.getElementById('view');
  const toast = document.getElementById('toast');
  const navLinks = document.getElementById('navLinks');
  const searchInput = document.getElementById('navSearch');
  const searchDropdown = document.getElementById('searchDropdown');

  const GENRES = ['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Thriller', 'War'];
  const TYPE_LABEL = { movie: 'Movie', tv: 'TV' };

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

  function scrollTop() {
    window.scrollTo({ top: 0 });
  }

  function card(item) {
    const [type] = String(item.id || '').split('/');
    const url = item.href || `#/${type}/${item.id.split('/')[1]}`;
    const year = item.releaseDate || item.year || '';
    const badge = type === 'tv' ? 'tv' : 'movie';
    return el(`
      <div class="card" data-href="${url}">
        <div class="poster-wrap">
          <span class="card-badge ${badge}">${TYPE_LABEL[type] || ''}</span>
          ${item.image ? `<img src="${item.image}" alt="${escapeHtml(item.title)}" loading="lazy" />` : ''}
          ${item.progress ? `<div class="card-progress"><i style="width:${item.progress}%"></i></div>` : ''}
          <div class="card-hover">
            <div class="ch-title">${escapeHtml(item.title)}</div>
            <div class="ch-meta">${year ? year + ' · ' : ''}${TYPE_LABEL[type] || ''}</div>
            <span class="ch-play">${item.progress ? '▶ Continue' : '▶ Watch now'}</span>
          </div>
        </div>
        <div class="card-title">${escapeHtml(item.title)}</div>
        <div class="card-year">${year}</div>
      </div>
    `);
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

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function skeletonRow() {
    let cards = '';
    for (let i = 0; i < 8; i++) cards += `<div class="card"><div class="skel poster-wrap"></div><div class="skel" style="height:14px;margin-top:8px"></div></div>`;
    return cards;
  }

  function grid(items) {
    return `<div class="grid">${items.map(card).map((c) => c.outerHTML).join('')}</div>`;
  }

  function bindCards(scope) {
    scope.querySelectorAll('.card[data-href]').forEach((c) => {
      c.addEventListener('click', () => (location.hash = c.dataset.href));
    });
  }

  function rowWithArrows(content) {
    return `
      <div class="row-wrap" style="position:relative">
        <button class="row-arrow prev">‹</button>
        <div class="row">${content}</div>
        <button class="row-arrow next">›</button>
      </div>`;
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
    view.innerHTML = `
      <section class="hero">
        <h1>Watch <span class="grad">anything</span>,<br/>anywhere. Instantly.</h1>
        <p>Millions of movies and TV shows. No sign-up, no limits — just press play.</p>
        <div class="hero-search">
          <input id="heroSearch" type="text" placeholder="Search for a movie or show…" autocomplete="off" spellcheck="false" />
          <button id="heroSearchBtn">Search</button>
        </div>
      </section>
      <section class="section" id="cwSection" hidden>
        <div class="section-head"><h2>⏯️ Continue Watching</h2></div>
        ${rowWithArrows('')}
      </section>
      <section class="section" data-row>
        <div class="section-head"><h2>🔥 Trending Movies</h2><a class="see-all" href="#/movies">See all</a></div>
        ${rowWithArrows(skeletonRow())}
      </section>
      <section class="section" data-row>
        <div class="section-head"><h2>📺 Trending TV Shows</h2><a class="see-all" href="#/tv-shows">See all</a></div>
        ${rowWithArrows(skeletonRow())}
      </section>
      <section class="section" data-row>
        <div class="section-head"><h2>🆕 Now Playing</h2><a class="see-all" href="#/movies">See all</a></div>
        ${rowWithArrows(skeletonRow())}
      </section>
      <section class="section" data-row>
        <div class="section-head"><h2>⭐ Top Rated</h2><a class="see-all" href="#/top-rated">See all</a></div>
        ${rowWithArrows(skeletonRow())}
      </section>`;

    const heroInput = document.getElementById('heroSearch');
    const heroBtn = document.getElementById('heroSearchBtn');
    const go = () => {
      if (heroInput.value.trim()) location.hash = `#/search?q=${encodeURIComponent(heroInput.value.trim())}`;
    };
    heroBtn.addEventListener('click', go);
    heroInput.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    heroInput.addEventListener('input', () => runSearch(heroInput.value));

    // Continue Watching row from saved positions (hidden when nothing is in progress)
    const cwItems = continueWatchingItems();
    if (cwItems.length) {
      const cw = view.querySelector('#cwSection');
      cw.hidden = false;
      cw.querySelector('.row-wrap').outerHTML = rowWithArrows(
        cwItems.map((i) => card(i).outerHTML).join('')
      );
      bindRowArrows(view);
      bindCards(view);
    }

    const sections = [
      ['/trending/movies', 'trending-movies'],
      ['/trending/tv', 'trending-tv'],
      ['/recent/movies', 'now-playing'],
      ['/top-imdb?type=all', 'top-rated'],
    ];
    for (let i = 0; i < sections.length; i++) {
      const [ep] = sections[i];
      try {
        const data = await API.get(ep);
        const items = Array.isArray(data) ? data : data.results || [];
        const sectionEl = view.querySelectorAll('.section[data-row]')[i];
        sectionEl.querySelector('.row-wrap').outerHTML = rowWithArrows(
          items.slice(0, 14).map((i) => card(i).outerHTML).join('')
        );
        bindRowArrows(view);
        bindCards(view);
      } catch (e) {
        console.warn(ep, e);
      }
    }
  };

  // ---- browse ----
  views.browse = async (params) => {
    const kind = params.kind; // movies | tv-shows | top-rated | genre
    const genre = params.genre || null;
    scrollTop();
    setActiveNav(kind === 'movies' ? 'movies' : kind === 'tv-shows' ? 'tv' : 'top');

    let title = 'Movies', sub = 'All movies';
    if (kind === 'tv-shows') { title = 'TV Shows'; sub = 'All TV shows'; }
    if (kind === 'top-rated') { title = 'Top Rated'; sub = 'The best of the best'; }
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
        const data = kind === 'genre'
          ? await API.genre(genre, page)
          : kind === 'top-rated'
            ? await API.topImdb('all', page)
            : await API.browse(kind === 'tv-shows' ? 'tv' : 'movies', page);
        const items = data.results || [];
        hasNext = !!data.hasNextPage;
        gridEl.insertAdjacentHTML('beforeend', items.map((i) => card(i).outerHTML).join(''));
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
          gridEl.insertAdjacentHTML('beforeend', items.map((i) => card(i).outerHTML).join(''));
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
              <button class="btn btn-primary" id="playBtn">▶ Watch now</button>
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
        ${rowWithArrows(recs.map((i) => card(i).outerHTML).join(''))}
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
        </div>
        <div class="player-bar" id="serverBar"></div>
        <div class="watch-head" style="margin-top:20px">
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

    // player
    const shell = view.querySelector('.player-shell');
    const player = new Player.MoviePlayer(shell);
    const subsSelect = view.querySelector('#subsSelect');

    // toolbar: speed + PiP + resume notice
    const speedBtn = view.querySelector('#speedBtn');
    const pipBtn = view.querySelector('#pipBtn');
    if (!document.pictureInPictureEnabled || !document.createElement('video').requestPictureInPicture) {
      pipBtn.hidden = true;
    }
    shell.addEventListener('speed-change', (e) => {
      const r = Math.round(e.detail.rate * 100) / 100;
      speedBtn.textContent = `Speed: ${r}x`;
    });
    speedBtn.addEventListener('click', () => player.changeSpeed(0.25));
    pipBtn.addEventListener('click', () => player.togglePip());
    shell.addEventListener('progress-resumed', (e) => toastMsg(`Resumed from ${fmtTime(e.detail.pos)}`));
    shell.addEventListener('sources-ready', (e) => {
      const labels = Player.PROVIDER_LABELS;
      const p = e.detail.provider;
      document.getElementById('providerInfo').textContent = p ? `Server: ${labels[p] || p} · ${e.detail.subtitles.length} subtitles available` : '';
      // populate subtitle picker (lazy: content loads only when selected)
      const subs = e.detail.subtitles || [];
      subsSelect.innerHTML = '<option value="">Subtitles: Off</option>' +
        subs.map((s, i) => `<option value="${i}">${escapeHtml(s.label || s.lang || 'Subtitle ' + (i + 1))}</option>`).join('');
      subsSelect.disabled = subs.length === 0;
      collectDubs();
    });
    subsSelect.addEventListener('change', () => {
      const i = subsSelect.value;
      const sub = i === '' ? null : (player.subtitles || [])[parseInt(i, 10)];
      player.loadSubtitle(sub ? sub.url : '', sub ? sub.label : '');
    });
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

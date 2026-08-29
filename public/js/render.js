// render.js — the ONLY place card/row/home markup lives.
//
// Shared by two runtimes:
//   - browser: plain script tag → window.Render (loaded before app.js)
//   - server: `require('./public/js/render.js')` → used by the '/' SSR route
//     to pre-render the home page into the HTML (instant first paint).
//
// Every function returns HTML strings — no DOM, so it runs identically in
// Node and the browser. If you change card markup here, both sides change.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Render = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TYPE_LABEL = { movie: 'Movie', tv: 'TV' };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function card(item) {
    const [type] = String(item.id || '').split('/');
    const url = item.href || `#/${type}/${item.id.split('/')[1]}`;
    const year = item.releaseDate || item.year || '';
    const badge = type === 'tv' ? 'tv' : 'movie';
    return `
      <div class="card" data-href="${url}">
        <div class="poster-wrap">
          <span class="card-badge ${badge}">${TYPE_LABEL[type] || ''}</span>
          ${item.image ? `<img src="${esc(item.image)}" alt="${esc(item.title)}" loading="lazy" />` : ''}
          ${item.rating ? `<span class="card-rating">★ ${Number(item.rating).toFixed(1)}</span>` : ''}
          ${item.progress ? `<div class="card-progress"><i style="width:${item.progress}%"></i></div>` : ''}
          <div class="card-hover">
            <div class="ch-title">${esc(item.title)}</div>
            <div class="ch-meta">${year ? esc(year) + ' · ' : ''}${TYPE_LABEL[type] || ''}</div>
            <span class="ch-play">${item.progress ? 'Continue' : 'Watch now'}</span>
          </div>
        </div>
        <div class="card-title">${esc(item.title)}</div>
        <div class="card-year">${esc(year)}</div>
      </div>`;
  }

  function grid(items) {
    return `<div class="grid">${items.map(card).join('')}</div>`;
  }

  function skeletonRow(count) {
    let cards = '';
    for (let i = 0; i < (count || 8); i++) cards += `<div class="card"><div class="skel poster-wrap"></div><div class="skel" style="height:14px;margin-top:8px"></div></div>`;
    return cards;
  }

  function rowWithArrows(content) {
    return `
      <div class="row-wrap" style="position:relative">
        <button class="row-arrow prev">‹</button>
        <div class="row">${content}</div>
        <button class="row-arrow next">›</button>
      </div>`;
  }

  // The full home view: (hidden) Continue Watching section + 5 rows. No hero —
  // the landing opens straight on content; search lives in the nav bar.
  // `rows` = { trendingMovies?, trendingTv?, imdb75?, recent?, topRated? } —
  // each an array of items (server: real data; client: null → skeleton shimmer).
  function homeView(rows) {
    const row = (items, title, href) => `
      <section class="section" data-row>
        <div class="section-head"><h2>${title}</h2><a class="see-all" href="${href}">See all</a></div>
        ${rowWithArrows(items ? items.slice(0, 14).map(card).join('') : skeletonRow())}
      </section>`;
    return `
      <section class="section" id="cwSection" hidden>
        <div class="section-head"><h2>Continue Watching</h2></div>
        ${rowWithArrows('')}
      </section>
      ${row(rows && rows.trendingMovies, 'Trending Movies', '#/movies')}
      ${row(rows && rows.trendingTv, 'Trending TV Shows', '#/tv-shows')}
      ${row(rows && rows.imdb75, 'IMDb 7.5+ Movies', '#/imdb75')}
      ${row(rows && rows.recent, 'Now Playing', '#/movies')}
      ${row(rows && rows.topRated, 'Top Rated', '#/top-rated')}`;
  }

  return { TYPE_LABEL, esc, escapeHtml: esc, card, grid, skeletonRow, rowWithArrows, homeView };
});

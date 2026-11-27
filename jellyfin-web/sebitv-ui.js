(() => {
  if (window.__SEBITV_LOADED__) return;
  window.__SEBITV_LOADED__ = true;

  const cfg = window.SEBITV_CONFIG || {};
  const API_BASE = cfg.publicUrl
    ? cfg.publicUrl.replace(/\/+$/, '')
    : `${window.location.protocol}//${window.location.hostname}:${cfg.port || '8099'}`;

  const state = {
    overlayOpen: false,
    currentView: 'discover', // 'discover' | 'detail' | 'downloads' | 'settings'
    detailKey: null, // { mediaType, tmdbId, selectedSeason }
    activeDownloadsCount: 0,
    pollTimer: null,
    homeInjectedContainer: null,
    lastHash: '',
  };

  async function api(path, options = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.error || `HTTP ${res.status}`;
      if (!path.startsWith('/api/logs')) {
        uiLog('api.error', `Fallo llamando a ${path}: ${errMsg}`, { path, status: res.status }, 'ERROR');
      }
      throw new Error(errMsg);
    }
    return data;
  }

  function uiLog(action, message, context = null, level = 'INFO') {
    fetch(`${API_BASE}/api/logs/ui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, action, message, context }),
    }).catch(() => {});
  }

  window.addEventListener('error', (ev) => {
    if (String(ev.filename || '').startsWith('blob:')) return;
    uiLog('window.error', ev.message || 'Error JS en cliente', {
      filename: ev.filename,
      lineno: ev.lineno,
    }, 'ERROR');
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const msg = String(ev.reason?.message || ev.reason || 'Promesa rechazada');
    if (msg === '[object Response]' || msg.includes('AbortError')) return;
    uiLog('window.unhandledrejection', msg, null, 'ERROR');
  });

  function esc(str = '') {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatSpeed(bytesPerSec = 0) {
    if (!bytesPerSec || bytesPerSec <= 0) return '';
    if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
    return `${Math.round(bytesPerSec / 1024)} KB/s`;
  }

  function posterPlaceholder(title = '') {
    const initials = esc((title || '?').slice(0, 2).toUpperCase());
    return `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#181c22"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#5b6778" font-family="sans-serif" font-size="48">${initials}</text></svg>`
    )}`;
  }

  function renderCardHtml(card) {
    const img = card.posterUrl || posterPlaceholder(card.title);
    const isReady = card.localStatus === 'available';
    const typeLabel = card.isAnime ? '🇯🇵 Anime' : card.mediaType === 'movie' ? '🎬 Película' : '📺 Serie';
    return `
      <div class="sebitv-card" data-sebi-card="1" data-type="${esc(card.mediaType)}" data-tmdb="${esc(card.tmdbId)}">
        <img class="sebitv-card-poster" loading="lazy" src="${esc(img)}" alt="${esc(card.title)}">
        <span class="sebitv-card-tag">${typeLabel}</span>
        ${isReady ? '<span class="sebitv-card-ready">▶ LISTO</span>' : ''}
        <div class="sebitv-card-body">
          <div class="sebitv-card-title" title="${esc(card.title)}">${esc(card.title)}</div>
          <div class="sebitv-card-sub">${card.year || '—'} ${card.rating ? `• ★ ${card.rating}` : ''}</div>
        </div>
      </div>
    `;
  }

  /* =========================================================================
     1. Barra flotante permanente en Jellyfin (Web + PC + Android/iOS)
     ========================================================================= */
  function mountFloatingBar() {
    if (document.getElementById('sebitv-fab')) return;
    const bar = document.createElement('div');
    bar.id = 'sebitv-fab';
    bar.className = 'sebitv-fab-bar';
    bar.innerHTML = `
      <button class="sebitv-pill-btn" id="sebitv-open-catalog" title="Explorar todo el catálogo de Películas, Series y Anime">
        <span>🔎 Catálogo</span>
      </button>
      <button class="sebitv-pill-btn secondary" id="sebitv-open-downloads" title="Ver descargas en curso">
        <span>⬇</span>
        <span id="sebitv-dl-count" class="sebitv-badge-count" style="display:none">0</span>
      </button>
      <button class="sebitv-pill-btn secondary" id="sebitv-open-prefs" title="Preferencias de Idioma, Subtítulos y Calidad de Vídeo">
        <span>👤</span>
      </button>
      <button class="sebitv-pill-btn secondary" id="sebitv-open-settings" title="Estado y ajustes de SebiTV">
        <span>⚙</span>
      </button>
    `;
    document.body.appendChild(bar);

    document.getElementById('sebitv-open-catalog').addEventListener('click', () => openOverlay('discover'));
    document.getElementById('sebitv-open-downloads').addEventListener('click', () => openOverlay('downloads'));
    document.getElementById('sebitv-open-prefs').addEventListener('click', () => openOverlay('preferences'));
    document.getElementById('sebitv-open-settings').addEventListener('click', () => openOverlay('settings'));
  }

  /* =========================================================================
     2. Modal / Panel Principal (Catálogo, Ficha Detallada, Descargas, Ajustes)
     ========================================================================= */
  function ensureOverlayElement() {
    let el = document.getElementById('sebitv-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sebitv-overlay';
      el.className = 'sebitv-overlay';
      el.style.display = 'none';
      el.addEventListener('click', (ev) => {
        if (ev.target === el) closeOverlay();
      });
      document.body.appendChild(el);
    }
    return el;
  }

  function closeOverlay() {
    state.overlayOpen = false;
    const el = document.getElementById('sebitv-overlay');
    if (el) el.style.display = 'none';
    if ((window.location.hash || '').includes('/details')) {
      document.querySelectorAll('.sebitv-native-banner').forEach((b) => b.remove());
      injectNativeDetailPageControls();
    }
  }

  async function openOverlay(view = 'discover', detailParams = null) {
    state.overlayOpen = true;
    state.currentView = view;
    if (detailParams) state.detailKey = detailParams;

    const overlay = ensureOverlayElement();
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="sebitv-modal">
        <div class="sebitv-modal-header" style="flex-wrap:wrap;">
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-home">Catálogo</button>
          <input type="search" class="sebitv-search-input" id="sebitv-global-search" placeholder="Buscar película, serie o anime en todo el catálogo...">
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-dl">⬇ Descargas</button>
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-prefs">👤 Preferencias</button>
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-logs">📋 Logs</button>
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-cfg">⚙</button>
          <button class="sebitv-pill-btn danger" id="sebitv-close-modal">✕</button>
        </div>
        <div class="sebitv-modal-content" id="sebitv-modal-body">
          <p style="color:var(--sebi-muted)">Cargando...</p>
        </div>
      </div>
    `;

    document.getElementById('sebitv-close-modal').onclick = closeOverlay;
    document.getElementById('sebitv-nav-home').onclick = () => renderDiscoverInModal();
    document.getElementById('sebitv-nav-dl').onclick = () => renderDownloadsInModal();
    document.getElementById('sebitv-nav-prefs').onclick = () => renderPreferencesInModal();
    document.getElementById('sebitv-nav-logs').onclick = () => renderLogsInModal();
    document.getElementById('sebitv-nav-cfg').onclick = () => renderSettingsInModal();

    const searchInput = document.getElementById('sebitv-global-search');
    let debounce = null;
    const triggerModalSearch = () => {
      const q = searchInput.value.trim();
      if (q.length >= 2) {
        uiLog('ui.search', `Búsqueda en catálogo: "${q}"`, { query: q });
        renderSearchInModal(q);
      } else if (q.length === 0) renderDiscoverInModal();
    };
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(triggerModalSearch, 350);
    });
    searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        clearTimeout(debounce);
        triggerModalSearch();
      }
    });

    if (view === 'discover') await renderDiscoverInModal();
    else if (view === 'detail' && state.detailKey) {
      await renderItemDetailInModal(state.detailKey.mediaType, state.detailKey.tmdbId, state.detailKey.selectedSeason);
    } else if (view === 'downloads') await renderDownloadsInModal();
    else if (view === 'preferences') await renderPreferencesInModal();
    else if (view === 'logs') await renderLogsInModal();
    else if (view === 'settings') await renderSettingsInModal();
  }

  function bindCardClicks(container) {
    container.querySelectorAll('[data-sebi-card="1"]').forEach((el) => {
      el.addEventListener('click', () => {
        const mediaType = el.getAttribute('data-type');
        const tmdbId = Number(el.getAttribute('data-tmdb'));
        const cardTitle = el.querySelector('.sebitv-card-title')?.textContent || '';
        uiLog('ui.open_item', `Entró en ficha: "${cardTitle}" (${mediaType} #${tmdbId})`, {
          mediaType,
          tmdbId,
          title: cardTitle,
        });
        state.currentView = 'detail';
        state.detailKey = { mediaType, tmdbId, selectedSeason: null };
        if (!state.overlayOpen) {
          openOverlay('detail', state.detailKey);
        } else {
          renderItemDetailInModal(mediaType, tmdbId, null);
        }
      });
    });
  }

  async function renderDiscoverInModal() {
    state.currentView = 'discover';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const data = await api('/api/discover');
      if (!data.configured) {
        body.innerHTML = `
          <div style="text-align:center;padding:30px 10px;">
            <h3>Activa tu Catálogo Global Gratuito (TMDB)</h3>
            <p style="color:var(--sebi-muted);max-width:560px;margin:10px auto 20px;">
              ${esc(data.message)}
            </p>
            <button class="sebitv-pill-btn" id="sebitv-goto-cfg">Configurar TMDB API Key ahora</button>
          </div>
        `;
        document.getElementById('sebitv-goto-cfg').onclick = () => renderSettingsInModal();
        return;
      }

      body.innerHTML = (data.sections || [])
        .map(
          (sec) => `
          <div>
            <div class="sebitv-section-title">${esc(sec.title)}</div>
            <div class="sebitv-carousel">
              ${sec.items.map(renderCardHtml).join('')}
            </div>
          </div>
        `
        )
        .join('');
      bindCardClicks(body);
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">Error cargando catálogo: ${esc(err.message)}</p>`;
    }
  }

  async function renderSearchInModal(query) {
    state.currentView = 'search';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    body.innerHTML = `<p style="color:var(--sebi-muted)">Buscando "${esc(query)}"...</p>`;
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
      if (!data.items || data.items.length === 0) {
        body.innerHTML = `<p style="color:var(--sebi-muted)">Sin resultados para "${esc(query)}".</p>`;
        return;
      }
      body.innerHTML = `
        <div class="sebitv-section-title">Resultados para "${esc(query)}"</div>
        <div class="sebitv-grid">
          ${data.items.map(renderCardHtml).join('')}
        </div>
      `;
      bindCardClicks(body);
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">Error en búsqueda: ${esc(err.message)}</p>`;
    }
  }

  function navigateToJellyfinItem(jellyfinId, { autoPlay = false } = {}) {
    closeOverlay();
    const currentHash = window.location.hash || '';
    const alreadyOnTarget = currentHash.includes(`id=${jellyfinId}`);
    const oldActivePage = alreadyOnTarget
      ? null
      : document.querySelector('.page.itemDetailPage:not(.hide), #itemDetailPage:not(.hide)');

    const prefix = currentHash.startsWith('#!/') ? '#!/' : '#/';
    window.location.hash = `${prefix}details?id=${encodeURIComponent(jellyfinId)}`;

    if (autoPlay) {
      let attempts = 0;
      setTimeout(() => {
        const tryClickPlay = setInterval(() => {
          attempts++;
          const visiblePages = [
            ...document.querySelectorAll('.page.itemDetailPage:not(.hide), #itemDetailPage:not(.hide)'),
          ].filter((p) => p !== oldActivePage && p.offsetParent !== null);

          for (const page of visiblePages) {
            const btns = [...page.querySelectorAll('button.btnPlay')].filter((b) => b.offsetParent !== null);
            if (btns.length > 0) {
              clearInterval(tryClickPlay);
              btns[0].click();
              return;
            }
          }

          if (attempts >= 24) {
            clearInterval(tryClickPlay);
          }
        }, 250);
      }, alreadyOnTarget ? 100 : 400);
    }
  }

  async function syncBrowserJellyfinToken() {
    try {
      let token = window.ApiClient?.accessToken?.() || window.ApiClient?._serverInfo?.AccessToken || null;
      let userId = window.ApiClient?.getCurrentUserId?.() || window.ApiClient?._serverInfo?.UserId || '';
      if (!token) {
        const raw = localStorage.getItem('jellyfin_credentials');
        if (raw) {
          const parsed = JSON.parse(raw);
          const srv = (parsed.Servers || []).find((s) => s.AccessToken);
          if (srv) {
            token = srv.AccessToken;
            userId = srv.UserId || '';
          }
        }
      }
      if (token && !state.tokenSynced) {
        const res = await api('/api/jellyfin-auth', {
          method: 'POST',
          body: JSON.stringify({ accessToken: token, userId }),
        });
        if (res.ok) state.tokenSynced = true;
      }
    } catch {
      // Silenciar hasta que el usuario inicie sesión en Jellyfin
    }
  }

  /* =========================================================================
     3. Ficha Detallada: Sin botón Play hasta que esté 100% descargado
     ========================================================================= */
  async function renderItemDetailInModal(mediaType, tmdbId, preferredSeason = null, silentRefresh = false) {
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    if (!silentRefresh) {
      body.innerHTML = '<p style="color:var(--sebi-muted)">Cargando ficha completa y capítulos...</p>';
    }

    try {
      const { registered, item } = await api(`/api/catalog/${mediaType}/${tmdbId}`);
      const seasons = item.seasons || [];
      const defaultSeason =
        preferredSeason !== null && preferredSeason !== undefined
          ? preferredSeason
          : state.detailKey?.selectedSeason ?? (seasons.find((s) => s.seasonNumber > 0 || s.season_number > 0)?.season_number ?? seasons[0]?.seasonNumber ?? 1);

      state.detailKey = { mediaType, tmdbId, selectedSeason: Number(defaultSeason) };

      const poster = item.poster_url || item.posterUrl || posterPlaceholder(item.title);
      const backdrop = item.backdrop_url || item.backdropUrl || '';
      const hasSpecials = seasons.some((s) => (s.season_number ?? s.seasonNumber) === 0);

      let heroButtonsHtml = '';
      if (mediaType === 'movie') {
        if (item.status === 'available') {
          // ¡SOLO SALE PLAY CUANDO ESTÁ DESCARGADO AL 100%!
          heroButtonsHtml = `
            <button class="sebitv-pill-btn play-ready" id="sebitv-play-movie">▶ Play</button>
            <button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-pin-movie">
              ${item.pinned ? '📌 Fijada (No borrar)' : '📌 Fijar película'}
            </button>
            <button class="sebitv-pill-btn danger" id="sebitv-del-movie">🗑 Desinstalar vídeo</button>
          `;
        } else if (item.status === 'downloading' || item.status === 'searching' || item.status === 'processing') {
          heroButtonsHtml = `
            <div class="sebitv-progress-box">
              <div style="font-size:12px;font-weight:700;">⏳ ${esc(item.status_message || item.status)} (${Math.floor(
                item.progress || 0
              )}%) ${formatSpeed(item.download_speed)}</div>
              <div class="sebitv-progress-bar-bg">
                <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, item.progress || 5)}%"></div>
              </div>
            </div>
            <button class="sebitv-pill-btn danger" id="sebitv-del-movie" title="Cancelar descarga">✕ Cancelar</button>
          `;
        } else {
          // NO descargada -> SOLO botón Descargar (SIN botón Play)
          heroButtonsHtml = `
            <button class="sebitv-pill-btn" id="sebitv-dl-movie">⬇ Descargar Película</button>
            <button class="sebitv-pill-btn secondary" id="sebitv-pick-movie-torrent">🔍 Elegir torrent</button>
            ${
              item.status === 'error'
                ? `<div style="width:100%;color:var(--sebi-red);font-size:12px;margin-top:4px;">⚠ ${esc(
                    item.status_message || ''
                  )}</div>`
                : ''
            }
          `;
        }
      } else {
        // SERIE O ANIME
        heroButtonsHtml = `
          ${
            !registered
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-reg-series">➕ Añadir ficha a mi Biblioteca Jellyfin</button>`
              : item.jellyfin_id
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-open-jf-series">📺 Ver ficha en Biblioteca Jellyfin</button>`
              : ''
          }
          <button class="sebitv-pill-btn" id="sebitv-dl-all-series">⬇ Descargar Serie Completa</button>
          ${
            hasSpecials
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-dl-ovas">⬇ Descargar OVAs / Especiales</button>`
              : ''
          }
          ${
            registered
              ? `<button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-pin-series">
                  ${item.pinned ? '📌 Serie Fijada' : '📌 Fijar Serie'}
                </button>`
              : ''
          }
        `;
      }

      let seasonsSectionHtml = '';
      if (mediaType === 'tv') {
        const curSeasonNum = Number(state.detailKey.selectedSeason);
        const curSeasonObj = seasons.find((s) => Number(s.season_number ?? s.seasonNumber) === curSeasonNum);
        const seasonPinned = Boolean(curSeasonObj?.pinned);
        const epsInSeason = (item.episodes || []).filter(
          (e) => Number(e.season_number ?? e.seasonNumber) === curSeasonNum
        );

        seasonsSectionHtml = `
          <div class="sebitv-season-tabs">
            ${seasons
              .map((s) => {
                const sNum = Number(s.season_number ?? s.seasonNumber);
                return `<button class="sebitv-season-tab ${sNum === curSeasonNum ? 'active' : ''}" data-season-tab="${sNum}">
                  ${esc(s.title)} (${s.episode_count ?? s.episodeCount ?? 0})
                </button>`;
              })
              .join('')}
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
            <div style="font-size:13px;color:var(--sebi-muted)">
              Ventana automática activa: al reproducir un capítulo se descarga el siguiente (<strong>+1</strong>), se conserva el anterior (<strong>-1</strong>) y se desinstalan los más antiguos no fijados.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="sebitv-pill-btn" id="sebitv-dl-cur-season">
                ⬇ Descargar ${curSeasonNum === 0 ? 'OVAs / Especiales' : `Temporada ${curSeasonNum}`}
              </button>
              ${
                registered
                  ? `<button class="sebitv-pill-btn ${seasonPinned ? 'pinned' : 'secondary'}" id="sebitv-pin-cur-season">
                      ${seasonPinned ? '📌 Temporada Fijada' : '📌 Fijar Temporada'}
                    </button>`
                  : ''
              }
            </div>
          </div>

          <div id="sebitv-candidate-picker-slot"></div>

          <div>
            ${epsInSeason
              .map((ep) => {
                const epNum = ep.episode_number ?? ep.episodeNumber;
                const sNum = ep.season_number ?? ep.seasonNumber;
                const code = `S${String(sNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}`;
                const thumb = ep.still_url || ep.stillUrl || backdrop || poster;
                let actionHtml = '';

                if (ep.status === 'available') {
                  // SOLO CUANDO ESTÁ DESCARGADO APARECE EL BOTÓN PLAY
                  actionHtml = `
                    <button class="sebitv-pill-btn play-ready" data-ep-play="1" data-epid="${ep.id}" data-jfid="${esc(
                      ep.jellyfin_episode_id || item.jellyfin_id || ''
                    )}">▶ Play</button>
                    <button class="sebitv-pill-btn ${ep.pinned ? 'pinned' : 'secondary'}" data-ep-pin="${ep.id}" data-pinned="${
                      ep.ownPinned ? '1' : '0'
                    }" title="Fijar para no borrar automáticamente">📌</button>
                    <button class="sebitv-pill-btn danger" data-ep-del="${ep.id}" title="Desinstalar archivo del disco">🗑</button>
                  `;
                } else if (ep.status === 'downloading' || ep.status === 'searching' || ep.status === 'processing') {
                  actionHtml = `
                    <div class="sebitv-progress-box">
                      <div style="font-size:11px;font-weight:700;">⏳ ${Math.floor(ep.progress || 0)}% ${formatSpeed(
                        ep.download_speed
                      )}</div>
                      <div style="font-size:10px;color:var(--sebi-muted);">${esc(ep.status_message || ep.status)}</div>
                      <div class="sebitv-progress-bar-bg">
                        <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, ep.progress || 6)}%"></div>
                      </div>
                    </div>
                    <button class="sebitv-pill-btn danger" data-ep-del="${ep.id}" title="Cancelar descarga">✕</button>
                  `;
                } else {
                  // Capítulo NO descargado -> NO hay botón Play, solo botón Descargar
                  actionHtml = `
                    <button class="sebitv-pill-btn" data-ep-dl="1" data-epid="${ep.id || ''}" data-s="${sNum}" data-e="${epNum}">
                      ⬇ Descargar
                    </button>
                    ${
                      ep.id
                        ? `<button class="sebitv-pill-btn secondary" data-ep-pick="${ep.id}" title="Elegir torrent manualmente">🔍</button>`
                        : ''
                    }
                  `;
                }

                return `
                  <div class="sebitv-episode-row">
                    <img class="sebitv-ep-thumb" loading="lazy" src="${esc(thumb)}" alt="${esc(ep.title)}">
                    <div class="sebitv-ep-info">
                      <div class="sebitv-ep-title">
                        <span style="color:var(--sebi-accent)">${code}</span> — ${esc(ep.title)}
                        ${ep.watched ? '<span style="color:var(--sebi-green);margin-left:6px;">✔ Visto</span>' : ''}
                      </div>
                      <div class="sebitv-ep-desc">${esc(ep.overview || 'Sin descripción disponible.')}</div>
                      ${
                        ep.status === 'error' && ep.status_message
                          ? `<div style="color:var(--sebi-red);font-size:11px;margin-top:4px;">⚠ ${esc(ep.status_message)}</div>`
                          : ''
                      }
                    </div>
                    <div class="sebitv-ep-actions">${actionHtml}</div>
                  </div>
                `;
              })
              .join('')}
          </div>
        `;
      } else {
        seasonsSectionHtml = `<div id="sebitv-candidate-picker-slot" style="margin-top:16px;"></div>`;
      }

      const relatedMovies = Array.isArray(item.relatedMovies) ? item.relatedMovies : [];
      const relatedMoviesHtml =
        mediaType === 'tv' && relatedMovies.length > 0
          ? `
            <div style="margin:18px 0 12px;">
              <div class="sebitv-section-title" style="margin-top:0;">🎬 Películas de esta Saga</div>
              <div class="sebitv-carousel">
                ${relatedMovies.map((m) => renderCardHtml(m)).join('')}
              </div>
            </div>
          `
          : '';

      body.innerHTML = `
        <div class="sebitv-hero" style="${backdrop ? `background-image:url('${esc(backdrop)}')` : ''}">
          <img class="sebitv-hero-poster" src="${esc(poster)}" alt="${esc(item.title)}">
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--sebi-accent);margin-bottom:4px;">
              ${esc(item.languageRule || '')}
            </div>
            <h2 style="margin:0 0 6px;font-size:1.65rem;">${esc(item.title)} ${item.year ? `(${item.year})` : ''}</h2>
            <p style="color:var(--sebi-muted);font-size:13px;line-height:1.5;max-width:720px;">
              ${esc(item.overview || 'Sin sinopsis en español.')}
            </p>
            <div class="sebitv-hero-actions">${heroButtonsHtml}</div>
          </div>
        </div>
        ${relatedMoviesHtml}
        ${seasonsSectionHtml}
      `;
      bindCardClicks(body);

      // Enlazar eventos de Película
      const dlMovBtn = document.getElementById('sebitv-dl-movie');
      if (dlMovBtn) {
        dlMovBtn.onclick = async () => {
          uiLog('ui.click_download_movie', `Pulsó Descargar Película: "${item.title}"`, { tmdbId, title: item.title });
          dlMovBtn.disabled = true;
          dlMovBtn.textContent = '⏳ Buscando...';
          await api('/api/download/movie', { method: 'POST', body: JSON.stringify({ tmdbId }) });
          await renderItemDetailInModal(mediaType, tmdbId, null, true);
        };
      }
      const pickMovBtn = document.getElementById('sebitv-pick-movie-torrent');
      if (pickMovBtn) {
        pickMovBtn.onclick = () => {
          uiLog('ui.open_picker_movie', `Abrió selector manual de torrent: "${item.title}"`, { tmdbId });
          showCandidatePicker('movie', tmdbId, null);
        };
      }
      const playMovBtn = document.getElementById('sebitv-play-movie');
      if (playMovBtn) {
        playMovBtn.onclick = async () => {
          uiLog('ui.click_play_movie', `Pulsó Play en Película: "${item.title}"`, { tmdbId, itemId: item.id });
          playMovBtn.disabled = true;
          playMovBtn.textContent = '⏳ Abriendo...';
          await syncBrowserJellyfinToken();
          const res = await api('/api/play-target', {
            method: 'POST',
            body: JSON.stringify({ mediaType: 'movie', itemId: item.id }),
          });
          if (res.jellyfinId) {
            uiLog('ui.play_movie_ok', `Abriendo reproductor Jellyfin para película "${item.title}"`, {
              jellyfinId: res.jellyfinId,
            });
            navigateToJellyfinItem(res.jellyfinId, { autoPlay: true });
          } else {
            uiLog('ui.play_movie_pending', `Película "${item.title}" aún indexándose en Jellyfin`, { itemId: item.id }, 'WARN');
            playMovBtn.disabled = false;
            playMovBtn.textContent = '⏳ Indexando en Jellyfin (pulsa en 3s)';
          }
        };
      }
      const pinMovBtn = document.getElementById('sebitv-pin-movie');
      if (pinMovBtn) {
        pinMovBtn.onclick = async () => {
          await api('/api/pin', {
            method: 'POST',
            body: JSON.stringify({ targetType: 'item', id: item.id, pinned: !item.pinned }),
          });
          await renderItemDetailInModal(mediaType, tmdbId, null, true);
        };
      }
      const delMovBtn = document.getElementById('sebitv-del-movie');
      if (delMovBtn) {
        delMovBtn.onclick = async () => {
          await api(`/api/media/movie/${item.id}`, { method: 'DELETE' });
          await renderItemDetailInModal(mediaType, tmdbId, null, true);
        };
      }

      // Enlazar eventos de Serie / Anime
      const regBtn = document.getElementById('sebitv-reg-series');
      if (regBtn) {
        regBtn.onclick = async () => {
          regBtn.disabled = true;
          regBtn.textContent = '➕ Creando ficha en Jellyfin...';
          await api('/api/library/register', { method: 'POST', body: JSON.stringify({ mediaType: 'tv', tmdbId }) });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      }
      const openJfBtn = document.getElementById('sebitv-open-jf-series');
      if (openJfBtn && item.jellyfin_id) {
        openJfBtn.onclick = () => navigateToJellyfinItem(item.jellyfin_id);
      }
      const dlAllBtn = document.getElementById('sebitv-dl-all-series');
      if (dlAllBtn) {
        dlAllBtn.onclick = async () => {
          dlAllBtn.disabled = true;
          dlAllBtn.textContent = '⏳ Encolando serie...';
          await api('/api/download/series', {
            method: 'POST',
            body: JSON.stringify({ tmdbId, itemId: item.id || null, includeSpecials: true }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      }
      const dlOvasBtn = document.getElementById('sebitv-dl-ovas');
      if (dlOvasBtn) {
        dlOvasBtn.onclick = async () => {
          await api('/api/download/season', {
            method: 'POST',
            body: JSON.stringify({ tmdbId, itemId: item.id || null, seasonNumber: 0 }),
          });
          await renderItemDetailInModal('tv', tmdbId, 0, true);
        };
      }
      const pinSeriesBtn = document.getElementById('sebitv-pin-series');
      if (pinSeriesBtn && item.id) {
        pinSeriesBtn.onclick = async () => {
          await api('/api/pin', {
            method: 'POST',
            body: JSON.stringify({ targetType: 'item', id: item.id, pinned: !item.pinned }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      }

      body.querySelectorAll('[data-season-tab]').forEach((tab) => {
        tab.onclick = () => {
          const sNum = Number(tab.getAttribute('data-season-tab'));
          uiLog('ui.select_season', `Seleccionó Temporada ${sNum} en "${item.title}"`, {
            tmdbId,
            title: item.title,
            seasonNumber: sNum,
          });
          renderItemDetailInModal('tv', tmdbId, sNum, true);
        };
      });

      const dlCurSeasonBtn = document.getElementById('sebitv-dl-cur-season');
      if (dlCurSeasonBtn) {
        dlCurSeasonBtn.onclick = async () => {
          uiLog('ui.click_download_season', `Pulsó Descargar Temporada ${state.detailKey.selectedSeason} de "${item.title}"`, {
            tmdbId,
            title: item.title,
            seasonNumber: state.detailKey.selectedSeason,
          });
          dlCurSeasonBtn.disabled = true;
          dlCurSeasonBtn.textContent = '⏳ Encolando temporada...';
          await api('/api/download/season', {
            method: 'POST',
            body: JSON.stringify({
              tmdbId,
              itemId: item.id || null,
              seasonNumber: state.detailKey.selectedSeason,
            }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      }

      const pinCurSeasonBtn = document.getElementById('sebitv-pin-cur-season');
      if (pinCurSeasonBtn && item.id) {
        const curS = seasons.find(
          (s) => Number(s.season_number ?? s.seasonNumber) === Number(state.detailKey.selectedSeason)
        );
        pinCurSeasonBtn.onclick = async () => {
          await api('/api/pin', {
            method: 'POST',
            body: JSON.stringify({
              targetType: 'season',
              id: item.id,
              seasonNumber: state.detailKey.selectedSeason,
              pinned: !curS?.pinned,
            }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      }

      body.querySelectorAll('[data-ep-dl="1"]').forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = '⏳ Buscando...';
          const episodeId = btn.getAttribute('data-epid') ? Number(btn.getAttribute('data-epid')) : null;
          const seasonNumber = Number(btn.getAttribute('data-s'));
          const episodeNumber = Number(btn.getAttribute('data-e'));
          uiLog(
            'ui.click_download_episode',
            `Pulsó Descargar en "${item.title}" Temporada ${seasonNumber} Capítulo ${episodeNumber}`,
            {
              tmdbId,
              title: item.title,
              seasonNumber,
              episodeNumber,
              episodeId,
            }
          );
          await api('/api/download/episode', {
            method: 'POST',
            body: JSON.stringify({ episodeId, tmdbId, seasonNumber, episodeNumber }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      });

      body.querySelectorAll('[data-ep-pick]').forEach((btn) => {
        btn.onclick = () => {
          const epId = Number(btn.getAttribute('data-ep-pick'));
          uiLog('ui.open_picker_episode', `Abrió selector manual de torrent en "${item.title}"`, { tmdbId, episodeId: epId });
          showCandidatePicker('episode', tmdbId, epId);
        };
      });

      body.querySelectorAll('[data-ep-play="1"]').forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = '⏳ Abriendo...';
          await syncBrowserJellyfinToken();
          const epId = Number(btn.getAttribute('data-epid'));
          uiLog('ui.click_play_episode', `Pulsó Play en capítulo #${epId} de "${item.title}"`, {
            tmdbId,
            title: item.title,
            itemId: item.id,
            episodeId: epId,
          });
          const res = await api('/api/play-target', {
            method: 'POST',
            body: JSON.stringify({ mediaType: 'tv', itemId: item.id, episodeId: epId }),
          });
          if (res.jellyfinId) {
            uiLog('ui.play_episode_ok', `Abriendo reproductor Jellyfin para capítulo #${epId} ("${item.title}")`, {
              episodeId: epId,
              jellyfinId: res.jellyfinId,
            });
            navigateToJellyfinItem(res.jellyfinId, { autoPlay: true });
          } else if (res.seriesJellyfinId) {
            uiLog('ui.play_episode_fallback_series', `Capítulo #${epId} aún sin ID directo; abriendo ficha de serie`, {
              episodeId: epId,
              seriesJellyfinId: res.seriesJellyfinId,
            }, 'WARN');
            navigateToJellyfinItem(res.seriesJellyfinId, { autoPlay: false });
          } else {
            uiLog('ui.play_episode_pending', `Jellyfin aún está indexando el archivo del capítulo #${epId}`, {
              episodeId: epId,
              itemId: item.id,
            }, 'WARN');
            btn.disabled = false;
            btn.textContent = '⏳ Indexando en Jellyfin (pulsa en 3s)';
          }
        };
      });

      body.querySelectorAll('[data-ep-pin]').forEach((btn) => {
        btn.onclick = async () => {
          const epId = Number(btn.getAttribute('data-ep-pin'));
          const isPinned = btn.getAttribute('data-pinned') === '1';
          await api('/api/pin', {
            method: 'POST',
            body: JSON.stringify({ targetType: 'episode', id: epId, pinned: !isPinned }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      });

      body.querySelectorAll('[data-ep-del]').forEach((btn) => {
        btn.onclick = async () => {
          const epId = Number(btn.getAttribute('data-ep-del'));
          await api(`/api/media/episode/${epId}`, { method: 'DELETE' });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      });
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">Error cargando detalles: ${esc(err.message)}</p>`;
    }
  }

  function formatBytesHuman(bytes = 0, fallbackStr = '') {
    if (fallbackStr && String(fallbackStr).trim()) return String(fallbackStr).trim();
    if (!bytes || bytes <= 0) return '';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function cleanCandidateLabels(c) {
    if (c.displayTitle) {
      return { displayTitle: c.displayTitle, subFileTitle: c.subFileTitle || '' };
    }
    const stripped = String(c.title || '').replace(/^Torrentio[^—]*—\s*/i, '').trim();
    const parts = stripped
      .split(/\s*\|\s*/)
      .map((s) => s.trim())
      .filter((s) => s && !/^(?:👤|💾|⚙️)/.test(s));
    return {
      displayTitle: parts[0] || stripped,
      subFileTitle: parts.length > 1 && parts[1] !== parts[0] ? parts[1] : '',
    };
  }

  function cleanTrackerLabel(source = '') {
    return String(source || 'DHT').replace(/^imdb:/i, '').replace(/^knaben:/i, 'Knaben · ');
  }

  async function showCandidatePicker(kind, tmdbId, episodeId) {
    const slot = document.getElementById('sebitv-candidate-picker-slot');
    if (!slot) return;
    slot.innerHTML = `
      <div class="sebitv-lupa-panel" style="padding:18px;display:flex;align-items:center;gap:12px;">
        <span style="font-size:20px;">🔎</span>
        <div>
          <div style="font-weight:700;font-size:14px;">Explorando versiones en todos los idiomas y calidades...</div>
          <div style="color:var(--sebi-muted);font-size:12px;">Consultando trackers simultáneamente (4K, 1080p, 720p, Castellano, Japonés, VOSE, Multi-Audio)</div>
        </div>
      </div>
    `;
    slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const endpoint =
        kind === 'movie'
          ? `/api/candidates/movie/${tmdbId}?allLanguages=1`
          : `/api/candidates/episode/${episodeId}?allLanguages=1`;
      const { candidates } = await api(endpoint);
      if (!candidates || candidates.length === 0) {
        slot.innerHTML = `<div class="sebitv-native-banner" style="border-color:var(--sebi-red)">No se encontraron torrents con semillas activas en ningún idioma para este título.</div>`;
        return;
      }

      const langFilters = [
        { id: 'all', label: 'Todos' },
        { id: 'Castellano', label: '🇪🇸 Castellano' },
        { id: 'Latino', label: '🇲🇽 Latino' },
        { id: 'Japonés', label: '🇯🇵 Japonés' },
        { id: 'Inglés', label: '🇬🇧 Inglés' },
        { id: 'Sub Español', label: '💬 Sub Español' },
        { id: 'MultiSub', label: '💬 MultiSub' },
        { id: 'Multi-Audio', label: '🌐 Multi-Audio' },
      ];

      const qualityFilters = [
        { id: 'all', label: 'Todas' },
        { id: '4K', label: '💎 4K UHD' },
        { id: '1080p', label: '🎯 1080p' },
        { id: '720p', label: '⚡ 720p' },
        { id: 'SD', label: '📦 SD' },
      ];

      const resRank = { '4K': 4, '1080p': 3, '720p': 2, SD: 1 };
      const lupaState = {
        lang: 'all',
        quality: 'all',
        sortBy: 'score',
        query: '',
      };

      const matchesLang = (c, langId) =>
        langId === 'all' ||
        (c.languageBadges || []).some((b) => b.toLowerCase().includes(langId.toLowerCase()));

      const matchesQuality = (c, qId) =>
        qId === 'all' || String(c.resolution || 'SD').toUpperCase() === qId.toUpperCase();

      const matchesQuery = (c, qText) => {
        if (!qText) return true;
        const hay = `${c.title || ''} ${(c.codecTags || []).join(' ')} ${(c.languageBadges || []).join(' ')} ${
          c.source || ''
        }`.toLowerCase();
        return qText
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .every((tok) => hay.includes(tok));
      };

      slot.innerHTML = `
        <div class="sebitv-lupa-panel">
          <div class="sebitv-lupa-header">
            <div>
              <div class="sebitv-lupa-title">
                <span>🔍 Explorador de Versiones</span>
                <span class="sebitv-lupa-counter" id="sebitv-lupa-counter"></span>
              </div>
              <div class="sebitv-lupa-subtitle">
                Filtra por resolución o idioma y ordena por rapidez (semillas) o peso antes de descargar.
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="sebitv-pill-btn secondary" id="sebitv-reset-lupa" style="display:none;padding:6px 12px;font-size:12px;">↺ Limpiar filtros</button>
              <button class="sebitv-pill-btn danger" id="sebitv-close-lupa" style="padding:6px 12px;font-size:12px;">Cerrar ✕</button>
            </div>
          </div>

          <div class="sebitv-lupa-toolbar">
            <div class="sebitv-lupa-search-row">
              <div class="sebitv-lupa-sort-wrap">
                <label for="sebitv-lupa-sort">Ordenar por</label>
                <select id="sebitv-lupa-sort" class="sebitv-select sebitv-lupa-sort-select">
                  <option value="score">⭐ Recomendado (Equilibrio ideal)</option>
                  <option value="seeders_desc">🌱 Más semillas (Descarga más rápida)</option>
                  <option value="res_desc">💎 Mayor resolución (4K → SD)</option>
                  <option value="size_asc">⚡ Menor tamaño (Más ligero)</option>
                  <option value="size_desc">🎬 Mayor tamaño (Máximo bitrate)</option>
                </select>
              </div>
              <div class="sebitv-lupa-query-wrap">
                <label for="sebitv-lupa-query">Filtro rápido</label>
                <input type="search" id="sebitv-lupa-query" class="sebitv-lupa-query-input" placeholder="Buscar códec (HEVC, x265, AV1, HDR), grupo o tracker...">
              </div>
            </div>

            <div class="sebitv-lupa-filter-group">
              <span class="sebitv-lupa-filter-label">Calidad</span>
              <div class="sebitv-lupa-pills" id="sebitv-lupa-quality-pills"></div>
            </div>

            <div class="sebitv-lupa-filter-group">
              <span class="sebitv-lupa-filter-label">Idioma</span>
              <div class="sebitv-lupa-pills" id="sebitv-lupa-lang-pills"></div>
            </div>
          </div>

          <div class="sebitv-lupa-list" id="sebitv-lupa-list"></div>
        </div>
      `;

      const counterEl = slot.querySelector('#sebitv-lupa-counter');
      const resetBtn = slot.querySelector('#sebitv-reset-lupa');
      const closeBtn = slot.querySelector('#sebitv-close-lupa');
      const sortEl = slot.querySelector('#sebitv-lupa-sort');
      const queryEl = slot.querySelector('#sebitv-lupa-query');
      const qualityPillsEl = slot.querySelector('#sebitv-lupa-quality-pills');
      const langPillsEl = slot.querySelector('#sebitv-lupa-lang-pills');
      const listEl = slot.querySelector('#sebitv-lupa-list');

      const updateResults = () => {
        // Calcular contadores dinámicos para que el usuario vea qué hay disponible antes de pulsar
        const qualityPool = candidates.filter(
          (c) => matchesLang(c, lupaState.lang) && matchesQuery(c, lupaState.query)
        );
        const langPool = candidates.filter(
          (c) => matchesQuality(c, lupaState.quality) && matchesQuery(c, lupaState.query)
        );

        qualityPillsEl.innerHTML = qualityFilters
          .map((qf) => {
            const count = qf.id === 'all' ? qualityPool.length : qualityPool.filter((c) => matchesQuality(c, qf.id)).length;
            const active = lupaState.quality === qf.id;
            const emptyCls = count === 0 && !active ? 'is-empty' : '';
            return `<button type="button" class="sebitv-filter-chip ${active ? 'active' : ''} ${emptyCls}" data-q-filter="${esc(
              qf.id
            )}"><span>${esc(qf.label)}</span><span class="sebitv-chip-num">${count}</span></button>`;
          })
          .join('');

        langPillsEl.innerHTML = langFilters
          .map((lf) => {
            const count = lf.id === 'all' ? langPool.length : langPool.filter((c) => matchesLang(c, lf.id)).length;
            if (lf.id === 'Multi-Audio' && count === 0 && lupaState.lang !== lf.id) return '';
            const active = lupaState.lang === lf.id;
            const emptyCls = count === 0 && !active ? 'is-empty' : '';
            return `<button type="button" class="sebitv-filter-chip ${active ? 'active' : ''} ${emptyCls}" data-l-filter="${esc(
              lf.id
            )}"><span>${esc(lf.label)}</span><span class="sebitv-chip-num">${count}</span></button>`;
          })
          .join('');

        const filtered = candidates.filter(
          (c) =>
            matchesLang(c, lupaState.lang) &&
            matchesQuality(c, lupaState.quality) &&
            matchesQuery(c, lupaState.query)
        );

        const sorted = [...filtered].sort((a, b) => {
          if (lupaState.sortBy === 'seeders_desc') return (b.seeders || 0) - (a.seeders || 0) || b.score - a.score;
          if (lupaState.sortBy === 'res_desc') {
            const rDiff = (resRank[b.resolution] || 1) - (resRank[a.resolution] || 1);
            return rDiff !== 0 ? rDiff : (b.seeders || 0) - (a.seeders || 0);
          }
          if (lupaState.sortBy === 'size_asc') {
            const sa = a.sizeBytes > 0 ? a.sizeBytes : Number.MAX_SAFE_INTEGER;
            const sb = b.sizeBytes > 0 ? b.sizeBytes : Number.MAX_SAFE_INTEGER;
            return sa - sb || (b.seeders || 0) - (a.seeders || 0);
          }
          if (lupaState.sortBy === 'size_desc') {
            return (b.sizeBytes || 0) - (a.sizeBytes || 0) || (b.seeders || 0) - (a.seeders || 0);
          }
          return b.score - a.score;
        });

        const hasActiveFilter =
          lupaState.lang !== 'all' || lupaState.quality !== 'all' || Boolean(lupaState.query.trim());
        resetBtn.style.display = hasActiveFilter ? 'inline-flex' : 'none';
        counterEl.textContent = `${sorted.length} de ${candidates.length} opciones`;

        if (sorted.length === 0) {
          listEl.innerHTML = `
            <div class="sebitv-lupa-empty">
              <div style="font-size:24px;margin-bottom:6px;">🕵️</div>
              <div style="font-weight:600;color:var(--sebi-text);margin-bottom:4px;">Ninguna versión coincide con estos filtros</div>
              <div>Prueba cambiando la calidad, eligiendo "Todos" en idioma o limpiando la búsqueda.</div>
            </div>
          `;
        } else {
          listEl.innerHTML = sorted
            .slice(0, 80)
            .map((c, idx) => {
              const origIdx = candidates.indexOf(c);
              const { displayTitle, subFileTitle } = cleanCandidateLabels(c);
              const res = String(c.resolution || 'SD');
              const resCls =
                res === '4K' ? 'res-4k' : res === '1080p' ? 'res-1080p' : res === '720p' ? 'res-720p' : 'res-sd';
              const seeds = Number(c.seeders || 0);
              const seedCls = seeds >= 20 ? 'seeds-high' : seeds >= 5 ? 'seeds-mid' : 'seeds-low';
              const seedDot = seeds >= 20 ? '🟢' : seeds >= 5 ? '🟡' : '🟠';
              const sizeLabel = formatBytesHuman(c.sizeBytes, c.sizeStr);
              const trackerLabel = cleanTrackerLabel(c.source);
              const isTopPick = lupaState.sortBy === 'score' && idx === 0 && !hasActiveFilter;

              return `
                <div class="sebitv-lupa-card ${isTopPick ? 'is-top' : ''}">
                  <div class="sebitv-res-badge ${resCls}">
                    <span class="sebitv-res-main">${esc(res)}</span>
                    <span class="sebitv-res-sub">${
                      res === '4K' ? 'UHD' : res === '1080p' ? 'Full HD' : res === '720p' ? 'HD' : 'Estándar'
                    }</span>
                  </div>

                  <div class="sebitv-lupa-card-body">
                    <div class="sebitv-lupa-card-title" title="${esc(c.title)}">
                      ${isTopPick ? '<span class="sebitv-top-tag">⭐ Recomendada</span>' : ''}
                      <span>${esc(displayTitle)}</span>
                    </div>
                    ${
                      subFileTitle
                        ? `<div class="sebitv-lupa-subfile" title="${esc(subFileTitle)}">📄 ${esc(subFileTitle)}</div>`
                        : ''
                    }
                    <div class="sebitv-lupa-badges-row">
                      ${(c.languageBadges || [])
                        .map((b) => {
                          const isCast = b.includes('Castellano');
                          return `<span class="sebitv-lang-chip ${isCast ? 'is-castellano' : ''}">${esc(b)}</span>`;
                        })
                        .join('')}
                      ${(c.codecTags || [])
                        .map(
                          (tag) =>
                            `<span class="sebitv-tech-chip ${tag === 'BDRemux' ? 'is-heavy' : ''}">${esc(tag)}</span>`
                        )
                        .join('')}
                    </div>
                    <div class="sebitv-lupa-meta-row">
                      <span class="sebitv-meta-pill ${seedCls}">${seedDot} ${seeds} ${
                        seeds === 1 ? 'semilla' : 'semillas'
                      }</span>
                      ${sizeLabel ? `<span class="sebitv-meta-pill">💾 ${esc(sizeLabel)}</span>` : ''}
                      <span class="sebitv-meta-pill">🏷 ${esc(trackerLabel)}</span>
                      ${
                        c.isPack
                          ? `<span class="sebitv-meta-pill is-pack">📦 Pack (baja solo este archivo)</span>`
                          : ''
                      }
                    </div>
                  </div>

                  <div class="sebitv-lupa-card-action">
                    <button class="sebitv-pill-btn" data-pick-idx="${origIdx}">⬇ Descargar</button>
                  </div>
                </div>
              `;
            })
            .join('');
        }

        qualityPillsEl.querySelectorAll('[data-q-filter]').forEach((btn) => {
          btn.onclick = () => {
            const clicked = btn.getAttribute('data-q-filter');
            lupaState.quality = lupaState.quality === clicked && clicked !== 'all' ? 'all' : clicked;
            updateResults();
          };
        });

        langPillsEl.querySelectorAll('[data-l-filter]').forEach((btn) => {
          btn.onclick = () => {
            const clicked = btn.getAttribute('data-l-filter');
            lupaState.lang = lupaState.lang === clicked && clicked !== 'all' ? 'all' : clicked;
            updateResults();
          };
        });

        listEl.querySelectorAll('[data-pick-idx]').forEach((b) => {
          b.onclick = async () => {
            const chosen = candidates[Number(b.getAttribute('data-pick-idx'))];
            uiLog('ui.lupa_select_candidate', `Eligió manualmente desde Lupa: "${chosen.displayTitle || chosen.title}"`, {
              kind,
              tmdbId,
              episodeId,
              resolution: chosen.resolution,
              languages: chosen.languageBadges,
              source: chosen.source,
            });
            b.disabled = true;
            b.textContent = '⏳ Añadiendo...';
            if (kind === 'movie') {
              await api('/api/download/movie', {
                method: 'POST',
                body: JSON.stringify({ tmdbId, candidate: chosen }),
              });
              await renderItemDetailInModal('movie', tmdbId, null, true);
            } else {
              await api('/api/download/episode', {
                method: 'POST',
                body: JSON.stringify({ episodeId, candidate: chosen }),
              });
              await renderItemDetailInModal('tv', tmdbId, state.detailKey?.selectedSeason, true);
            }
          };
        });
      };

      closeBtn.onclick = () => {
        slot.innerHTML = '';
      };
      resetBtn.onclick = () => {
        lupaState.lang = 'all';
        lupaState.quality = 'all';
        lupaState.sortBy = 'score';
        lupaState.query = '';
        sortEl.value = 'score';
        queryEl.value = '';
        updateResults();
      };
      sortEl.onchange = () => {
        lupaState.sortBy = sortEl.value;
        updateResults();
      };
      queryEl.oninput = () => {
        lupaState.query = queryEl.value;
        updateResults();
      };

      updateResults();
    } catch (err) {
      slot.innerHTML = `<div class="sebitv-native-banner" style="color:var(--sebi-red)">${esc(err.message)}</div>`;
    }
  }

  /* =========================================================================
     4. Vista de Cola de Descargas Activas y Vista de Ajustes / Salud
     ========================================================================= */
  async function renderDownloadsInModal() {
    state.currentView = 'downloads';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const { active } = await api('/api/downloads/active');
      if (!active || active.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:32px;color:var(--sebi-muted);">
            No hay ninguna descarga en curso en este momento.
          </div>
        `;
        return;
      }
      body.innerHTML = `
        <div class="sebitv-section-title">Descargas en Curso (${active.length})</div>
        ${active
          .map(
            (d) => `
          <div class="sebitv-episode-row" style="cursor:pointer" data-dl-open="${esc(
            d.kind === 'movie' ? 'movie' : 'tv'
          )}" data-tmdb="${esc(d.tmdbId || '')}">
            <div class="sebitv-ep-info">
              <div class="sebitv-ep-title">${esc(d.title)}</div>
              <div class="sebitv-ep-desc">${esc(d.subtitle || '')} — ${esc(d.statusMessage || d.status)}</div>
            </div>
            <div class="sebitv-progress-box">
              <div style="font-size:12px;font-weight:700;">${Math.round(d.progress || 0)}% ${formatSpeed(
                d.downloadSpeed
              )}</div>
              <div class="sebitv-progress-bar-bg">
                <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, d.progress || 5)}%"></div>
              </div>
            </div>
          </div>
        `
          )
          .join('')}
      `;
      body.querySelectorAll('[data-dl-open]').forEach((row) => {
        row.onclick = () => {
          const tmdbId = Number(row.getAttribute('data-tmdb'));
          const kind = row.getAttribute('data-dl-open');
          if (tmdbId) renderItemDetailInModal(kind, tmdbId, null);
        };
      });
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">${esc(err.message)}</p>`;
    }
  }

  async function renderPreferencesInModal() {
    state.currentView = 'preferences';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;

    const audioOpts = [
      { v: 'ja', l: '🇯🇵 Japonés (Audio Original Anime)' },
      { v: 'es-ES', l: '🇪🇸 Español de España (Castellano)' },
      { v: 'es-419', l: '🇲🇽 Español Latino' },
      { v: 'en', l: '🇬🇧 Inglés (Versión Original)' },
      { v: 'any', l: '🔓 Cualquier idioma disponible' },
      { v: 'none', l: '— Ninguno (No aceptar otro)' },
    ];

    const subOpts = [
      { v: 'off', l: '🚫 Desactivados (Sin subtítulos)' },
      { v: 'es-ES', l: '🇪🇸 Español de España (Castellano)' },
      { v: 'es-419', l: '🇲🇽 Español Latino' },
      { v: 'en', l: '🇬🇧 Inglés' },
      { v: 'any', l: '🔓 Cualquiera / Opcional' },
      { v: 'none', l: '— Ninguno (No aceptar otro)' },
    ];

    const qualityOpts = [
      { v: 'best', l: '✨ Mejor resolución posible (4K UHD > 1080p > 720p)' },
      { v: '4k', l: '💎 4K UHD (2160p)' },
      { v: '1080p', l: '🎯 1080p Full HD (Recomendado: calidad / espacio)' },
      { v: '720p', l: '⚡ 720p HD (Ligero y rápido, ahorra espacio)' },
      { v: 'sd', l: '📦 SD / 480p (Mínimo espacio en disco)' },
    ];

    const buildSelect = (id, list, currentVal, disallowNone = false) => `
      <select class="sebitv-select" id="${id}">
        ${list
          .filter((o) => !(disallowNone && o.v === 'none'))
          .map((o) => `<option value="${esc(o.v)}" ${o.v === currentVal ? 'selected' : ''}>${esc(o.l)}</option>`)
          .join('')}
      </select>
    `;

    try {
      const { preferences } = await api('/api/preferences');
      const an = preferences.anime || {};
      const rg = preferences.regular || {};

      body.innerHTML = `
        <div class="sebitv-section-title">Preferencias de Calidad de Vídeo, Idioma y Subtítulos</div>
        <p style="color:var(--sebi-muted);font-size:13px;margin-top:-4px;margin-bottom:16px;">
          El botón <strong>⬇ Descargar</strong> elige automáticamente el idioma, subtítulo y resolución que configures aquí para cada categoría. Si en un título puntual quieres elegir otra versión a mano, pulsa la <strong>🔍 Lupa</strong>.
        </p>

        <div class="sebitv-pref-grid">
          <div class="sebitv-pref-card">
            <h3 style="margin:0 0 12px;color:var(--sebi-accent);">🇯🇵 Anime (Series, OVAs y Películas de Anime)</h3>
            <div class="sebitv-pref-quality-box">
              <div class="sebitv-form-group" style="margin-bottom:8px;">
                <label>🎬 Calidad de Vídeo Preferida</label>
                ${buildSelect('pref-an-quality', qualityOpts, an.videoQuality || '1080p', true)}
              </div>
              <label class="sebitv-checkbox-label">
                <input type="checkbox" id="pref-an-q-fallback" ${an.allowQualityFallback !== false ? 'checked' : ''}>
                <span>Permitir otra resolución de respaldo si no existe la elegida en mi idioma</span>
              </label>
            </div>
            <div class="sebitv-form-group">
              <label>Audio Primario (1ª opción)</label>
              ${buildSelect('pref-an-aud1', audioOpts, an.audioPrimary, true)}
            </div>
            <div class="sebitv-form-group">
              <label>Audio Secundario (2ª opción si no existe el primario)</label>
              ${buildSelect('pref-an-aud2', audioOpts, an.audioSecondary)}
            </div>
            <div class="sebitv-form-group">
              <label>Otros Audios aceptados (3ª opción)</label>
              ${buildSelect('pref-an-aud3', audioOpts, an.audioOther)}
            </div>
            <hr style="border:none;border-top:1px solid var(--sebi-border);margin:14px 0;">
            <div class="sebitv-form-group">
              <label>Subtítulo Primario (1ª opción)</label>
              ${buildSelect('pref-an-sub1', subOpts, an.subPrimary, true)}
            </div>
            <div class="sebitv-form-group">
              <label>Subtítulo Secundario (2ª opción)</label>
              ${buildSelect('pref-an-sub2', subOpts, an.subSecondary)}
            </div>
            <div class="sebitv-form-group">
              <label>Otros Subtítulos aceptados (3ª opción)</label>
              ${buildSelect('pref-an-sub3', subOpts, an.subOther)}
            </div>
            <label class="sebitv-checkbox-label" style="margin-top:8px;">
              <input type="checkbox" id="pref-an-dub-nosub" ${an.allowSpanishAudioWithoutSubs ? 'checked' : ''}>
              <span>Si el episodio ya viene doblado con Audio Español Castellano, aceptarlo sin exigir subtítulos</span>
            </label>
          </div>

          <div class="sebitv-pref-card">
            <h3 style="margin:0 0 12px;color:var(--sebi-green);">🎬 Series y Películas Comerciales (No-Anime)</h3>
            <div class="sebitv-pref-quality-box">
              <div class="sebitv-form-group" style="margin-bottom:8px;">
                <label>🎬 Calidad de Vídeo Preferida</label>
                ${buildSelect('pref-rg-quality', qualityOpts, rg.videoQuality || '1080p', true)}
              </div>
              <label class="sebitv-checkbox-label">
                <input type="checkbox" id="pref-rg-q-fallback" ${rg.allowQualityFallback !== false ? 'checked' : ''}>
                <span>Permitir otra resolución de respaldo si no existe la elegida en mi idioma</span>
              </label>
            </div>
            <div class="sebitv-form-group">
              <label>Audio Primario (1ª opción)</label>
              ${buildSelect('pref-rg-aud1', audioOpts, rg.audioPrimary, true)}
            </div>
            <div class="sebitv-form-group">
              <label>Audio Secundario (2ª opción)</label>
              ${buildSelect('pref-rg-aud2', audioOpts, rg.audioSecondary)}
            </div>
            <div class="sebitv-form-group">
              <label>Otros Audios aceptados (3ª opción)</label>
              ${buildSelect('pref-rg-aud3', audioOpts, rg.audioOther)}
            </div>
            <hr style="border:none;border-top:1px solid var(--sebi-border);margin:14px 0;">
            <div class="sebitv-form-group">
              <label>Subtítulo Primario (1ª opción)</label>
              ${buildSelect('pref-rg-sub1', subOpts, rg.subPrimary, true)}
            </div>
            <div class="sebitv-form-group">
              <label>Subtítulo Secundario (2ª opción)</label>
              ${buildSelect('pref-rg-sub2', subOpts, rg.subSecondary)}
            </div>
            <div class="sebitv-form-group">
              <label>Otros Subtítulos aceptados (3ª opción)</label>
              ${buildSelect('pref-rg-sub3', subOpts, rg.subOther)}
            </div>
          </div>
        </div>

        <button class="sebitv-pill-btn" id="sebitv-save-prefs">Guardar Preferencias</button>
        <span id="sebitv-prefs-msg" style="margin-left:12px;font-size:13px;color:var(--sebi-green);"></span>
      `;

      document.getElementById('sebitv-save-prefs').onclick = async () => {
        const payload = {
          anime: {
            videoQuality: document.getElementById('pref-an-quality').value,
            allowQualityFallback: document.getElementById('pref-an-q-fallback').checked,
            audioPrimary: document.getElementById('pref-an-aud1').value,
            audioSecondary: document.getElementById('pref-an-aud2').value,
            audioOther: document.getElementById('pref-an-aud3').value,
            subPrimary: document.getElementById('pref-an-sub1').value,
            subSecondary: document.getElementById('pref-an-sub2').value,
            subOther: document.getElementById('pref-an-sub3').value,
            allowSpanishAudioWithoutSubs: document.getElementById('pref-an-dub-nosub').checked,
          },
          regular: {
            videoQuality: document.getElementById('pref-rg-quality').value,
            allowQualityFallback: document.getElementById('pref-rg-q-fallback').checked,
            audioPrimary: document.getElementById('pref-rg-aud1').value,
            audioSecondary: document.getElementById('pref-rg-aud2').value,
            audioOther: document.getElementById('pref-rg-aud3').value,
            subPrimary: document.getElementById('pref-rg-sub1').value,
            subSecondary: document.getElementById('pref-rg-sub2').value,
            subOther: document.getElementById('pref-rg-sub3').value,
            allowSpanishAudioWithoutSubs: true,
          },
        };
        await api('/api/preferences', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('sebitv-prefs-msg').textContent = '✔ Preferencias de idioma y calidad guardadas';
      };
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">${esc(err.message)}</p>`;
    }
  }

  async function renderLogsInModal(filterLevel = '') {
    state.currentView = 'logs';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const qs = filterLevel ? `?limit=250&level=${encodeURIComponent(filterLevel)}` : '?limit=250';
      const data = await api(`/api/logs${qs}`);
      const logs = data.logs || [];

      const badgeStyle = (lvl) => {
        if (lvl === 'ERROR') return 'background:#ff6b6b;color:#1a0505;';
        if (lvl === 'WARNING') return 'background:#feca57;color:#1f1600;';
        if (lvl === 'SUCCESS') return 'background:#2ecc71;color:#052111;';
        if (lvl === 'USER') return 'background:#00d2d3;color:#022224;';
        return 'background:#54a0ff;color:#041830;';
      };

      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          <div>
            <div class="sebitv-section-title" style="margin:0;">Registro Visual de Eventos y Errores</div>
            <div style="font-size:11px;color:var(--sebi-muted);margin-top:3px;">
              Archivo: <code>${esc(data.logFilePath || '/config/logs/sebitv.log')}</code> • Raw: <code>${esc(
                API_BASE
              )}/api/logs/raw</code>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn ${!filterLevel ? '' : 'secondary'}" data-lvl="">Todos</button>
            <button class="sebitv-pill-btn ${filterLevel === 'USER' ? '' : 'secondary'}" data-lvl="USER">[USER]</button>
            <button class="sebitv-pill-btn ${filterLevel === 'INFO' ? '' : 'secondary'}" data-lvl="INFO">[INFO]</button>
            <button class="sebitv-pill-btn ${filterLevel === 'SUCCESS' ? '' : 'secondary'}" data-lvl="SUCCESS">[SUCCESS]</button>
            <button class="sebitv-pill-btn ${filterLevel === 'WARNING' ? '' : 'secondary'}" data-lvl="WARNING">[WARNING]</button>
            <button class="sebitv-pill-btn ${filterLevel === 'ERROR' ? '' : 'secondary'}" data-lvl="ERROR">[ERROR]</button>
            <button class="sebitv-pill-btn secondary" id="sebitv-log-refresh">↻</button>
          </div>
        </div>
        <div style="background:#0b0d11;border:1px solid var(--sebi-border);border-radius:12px;padding:12px;max-height:64vh;overflow-y:auto;font-family:monospace;font-size:12px;">
          ${
            logs.length === 0
              ? '<div style="color:var(--sebi-muted);padding:16px;text-align:center;">Sin eventos registrados para este filtro.</div>'
              : logs
                  .map((l) => {
                    const timeStr = (l.ts || '').replace('T', ' ').slice(0, 19);
                    return `
                      <div class="sebitv-log-entry lvl-${esc(l.level)}">
                        <div>
                          <span style="color:#8c98a8;">${esc(timeStr)}</span>
                          <span class="sebitv-log-badge" style="${badgeStyle(l.level)}">[${esc(l.level)}]</span>
                          <span style="color:#00a4dc;font-weight:700;">[${esc(l.source)}:${esc(l.action)}]</span>
                          <span style="color:#f5f6fa;margin-left:4px;">${esc(l.message)}</span>
                        </div>
                        ${
                          l.context
                            ? `<div style="color:#9aa4b2;margin-top:5px;padding-left:10px;font-size:11px;opacity:0.9;">↳ ${esc(
                                JSON.stringify(l.context)
                              )}</div>`
                            : ''
                        }
                      </div>
                    `;
                  })
                  .join('')
          }
        </div>
      `;

      body.querySelectorAll('[data-lvl]').forEach((b) => {
        b.onclick = () => renderLogsInModal(b.getAttribute('data-lvl'));
      });
      document.getElementById('sebitv-log-refresh').onclick = () => renderLogsInModal(filterLevel);
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">${esc(err.message)}</p>`;
    }
  }

  async function renderSettingsInModal() {
    state.currentView = 'settings';
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const [health, settings] = await Promise.all([api('/api/health'), api('/api/settings')]);
      body.innerHTML = `
        <div class="sebitv-section-title">Estado de Servicios (SebiTV)</div>
        <div style="margin-bottom:18px;">
          <span class="sebitv-status-chip">${health.tmdbConfigured ? '🟢' : '🔴'} Catálogo TMDB</span>
          <span class="sebitv-status-chip">${health.jellyfin?.ok ? '🟢' : '🔴'} Jellyfin ${esc(
            health.jellyfin?.version || ''
          )} ${health.jellyfin?.authenticated ? '(Autenticado)' : '(Falta usuario/pass en .env)'}</span>
          <span class="sebitv-status-chip">${health.qbittorrent?.ok ? '🟢' : '🔴'} qBittorrent ${esc(
            health.qbittorrent?.version || ''
          )}</span>
          <span class="sebitv-status-chip">${health.nyaaEnabled ? '🟢' : '⚪'} Nyaa Anime MultiSub</span>
          <span class="sebitv-status-chip">${
            health.extStatus?.ok === true ? '🟢' : health.extStatus?.blockedByChallenge ? '🟡' : '⚪'
          } ext.to (${esc(health.extStatus?.message || 'Listo')})</span>
          ${
            health.disk
              ? `<span class="sebitv-status-chip">💾 Disco libre: <strong>${health.disk.freeGb} GB</strong> / ${health.disk.totalGb} GB (${health.disk.usedPct}% usado)</span>`
              : ''
          }
        </div>

        <div class="sebitv-section-title">Ajustes Rápidos</div>
        <div class="sebitv-form-group">
          <label>TMDB API Key (Gratuita — para ver todo el catálogo mundial en español)</label>
          <input type="text" id="sebitv-cfg-tmdb" placeholder="${
            settings.tmdbConfigured ? `Configurada (${settings.tmdbApiKeyMasked}) — escribe para reemplazar` : 'Pega aquí tu API Key o Read Token de themoviedb.org'
          }">
        </div>
        <div class="sebitv-form-group">
          <label>Cookie de sesión de ext.to (Opcional, solo si Cloudflare pide verificación a la IP del servidor)</label>
          <input type="text" id="sebitv-cfg-cookie" placeholder="${
            settings.extCookieConfigured ? 'Cookie guardada — escribe para actualizar' : 'cf_clearance=...; PHPSESSID=...'
          }">
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <div class="sebitv-form-group" style="flex:1;min-width:160px;">
            <label>Capítulos a conservar hacia atrás (N - X)</label>
            <input type="number" min="0" max="10" id="sebitv-cfg-behind" value="${settings.windowBehind}">
          </div>
          <div class="sebitv-form-group" style="flex:1;min-width:160px;">
            <label>Capítulos a pre-descargar por delante (N + X)</label>
            <input type="number" min="0" max="10" id="sebitv-cfg-ahead" value="${settings.windowAhead}">
          </div>
        </div>
        <button class="sebitv-pill-btn" id="sebitv-cfg-save">Guardar Ajustes</button>
        <span id="sebitv-cfg-msg" style="margin-left:12px;font-size:13px;color:var(--sebi-green);"></span>
      `;

      document.getElementById('sebitv-cfg-save').onclick = async () => {
        const payload = {
          windowBehind: Number(document.getElementById('sebitv-cfg-behind').value),
          windowAhead: Number(document.getElementById('sebitv-cfg-ahead').value),
        };
        const tmdbVal = document.getElementById('sebitv-cfg-tmdb').value.trim();
        const cookieVal = document.getElementById('sebitv-cfg-cookie').value.trim();
        if (tmdbVal) payload.tmdbApiKey = tmdbVal;
        if (cookieVal) {
          payload.extCookie = cookieVal;
          payload.extUserAgent = navigator.userAgent;
        }

        await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('sebitv-cfg-msg').textContent = '✔ Ajustes guardados';
        injectHomeDiscoverRows(true);
      };
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">${esc(err.message)}</p>`;
    }
  }

  /* =========================================================================
     5. Inyección directa dentro de páginas nativas de Jellyfin (Inicio, Búsqueda y Series)
     ========================================================================= */
  async function injectHomeDiscoverRows(force = false) {
    const hash = window.location.hash || '';
    const isHome = hash === '' || hash.includes('/home') || hash.includes('home.html');
    if (!isHome) return;

    const homeTab =
      document.querySelector('.homeSectionsContainer') ||
      document.querySelector('#indexPage .sections') ||
      document.querySelector('.page:not(.hide) .sections');
    if (!homeTab) return;

    let wrapper = document.getElementById('sebitv-home-discover');
    if (wrapper && wrapper.dataset.loaded === '1' && !force) return;
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = 'sebitv-home-discover';
      wrapper.className = 'sebitv-home-wrapper';
      homeTab.parentNode.insertBefore(wrapper, homeTab.nextSibling);
    }

    try {
      const data = await api('/api/discover');
      if (!data.configured) {
        wrapper.innerHTML = `
          <div class="sebitv-native-banner">
            <div>
              <strong>SebiTV listo:</strong> Falta añadir tu <code>TMDB_API_KEY</code> gratuita para mostrar todo el catálogo de Películas, Series y Anime aquí mismo.
            </div>
            <button class="sebitv-pill-btn" id="sebitv-banner-cfg">Configurar TMDB</button>
          </div>
        `;
        wrapper.dataset.loaded = '1';
        const b = document.getElementById('sebitv-banner-cfg');
        if (b) b.onclick = () => openOverlay('settings');
        return;
      }

      wrapper.innerHTML = (data.sections || [])
        .map(
          (sec) => `
          <div>
            <div class="sebitv-section-title">${esc(sec.title)}</div>
            <div class="sebitv-carousel">
              ${sec.items.map(renderCardHtml).join('')}
            </div>
          </div>
        `
        )
        .join('');
      if ((data.sections || []).length > 0) wrapper.dataset.loaded = '1';
      bindCardClicks(wrapper);
    } catch {
      delete wrapper.dataset.loaded;
    }
  }

  function hookNativeJellyfinSearch() {
    const searchInput = document.querySelector('#searchTextInput, input[type="search"].emby-input');
    if (!searchInput || searchInput.dataset.sebitvHooked === '1') return;
    searchInput.dataset.sebitvHooked = '1';

    let timer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = searchInput.value.trim();
        let box = document.getElementById('sebitv-native-search-results');
        const page = document.querySelector('#searchPage, .searchResults, .page:not(.hide)');
        if (!page) return;
        if (!box) {
          box = document.createElement('div');
          box.id = 'sebitv-native-search-results';
          box.className = 'sebitv-home-wrapper';
          page.appendChild(box);
        }
        if (q.length < 2) {
          box.innerHTML = '';
          return;
        }
        try {
          const { items } = await api(`/api/search?q=${encodeURIComponent(q)}`);
          if (!items?.length) {
            box.innerHTML = '';
            return;
          }
          box.innerHTML = `
            <div class="sebitv-section-title">Catálogo Global para Descargar ("${esc(q)}")</div>
            <div class="sebitv-grid">${items.map(renderCardHtml).join('')}</div>
          `;
          bindCardClicks(box);
        } catch {
          // Ignorar
        }
      }, 400);
    });
  }

  /**
   * Cuando el usuario entra a una Serie, Temporada o Capítulo faltante dentro de su biblioteca
   * nativa de Jellyfin (#!/details?id=...), inyecta el botón Descargar donde Jellyfin oculta Play.
   */
  async function injectNativeDetailPageControls() {
    const hash = window.location.hash || '';
    const idMatch = hash.match(/[?&]id=([a-zA-Z0-9]+)/);
    if (!idMatch) return;
    const jellyfinId = idMatch[1];

    const detailContainer = [
      ...document.querySelectorAll(
        '#itemDetailPage:not(.hide) .detailPageContent, .itemDetailPage:not(.hide) .detailPagePrimaryContent'
      ),
    ].find((el) => el.offsetParent !== null);
    if (!detailContainer) return;

    const existingBanner = detailContainer.querySelector('.sebitv-native-banner');
    if (existingBanner && existingBanner.dataset.jfid === jellyfinId) return;
    if (state.injectingDetailId === jellyfinId) return;
    state.injectingDetailId = jellyfinId;
    detailContainer.querySelectorAll('.sebitv-native-banner').forEach((b) => b.remove());

    try {
      const bridge = await api(`/api/jellyfin-bridge?jellyfinId=${encodeURIComponent(jellyfinId)}`);
      if (!bridge.matched || !bridge.item) return;

      detailContainer.querySelectorAll('.sebitv-native-banner').forEach((b) => b.remove());
      const banner = document.createElement('div');
      banner.className = 'sebitv-native-banner';
      banner.dataset.jfid = jellyfinId;

      const item = bridge.item;

      if (bridge.jellyfinType === 'Episode') {
        const ep = (item.episodes || []).find(
          (e) => e.season_number === bridge.seasonNumber && e.episode_number === bridge.episodeNumber
        );
        if (!ep) return;

        if (ep.status === 'available' && !bridge.isVirtualInJellyfin) {
          banner.innerHTML = `
            <div><strong>SebiTV:</strong> Capítulo descargado y listo (${esc(item.languageRule)}).</div>
            <div style="display:flex;gap:8px;">
              <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">Gestionar capítulos</button>
              <button class="sebitv-pill-btn danger" id="sebitv-nat-del-ep">🗑 Desinstalar capítulo</button>
            </div>
          `;
        } else if (ep.status === 'downloading' || ep.status === 'searching' || ep.status === 'processing') {
          banner.innerHTML = `
            <div><strong>⏳ Descargando capítulo:</strong> ${Math.round(ep.progress || 0)}% — ${esc(
              ep.status_message || ep.status
            )}. El botón Play aparecerá al llegar al 100 %.</div>
            <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">Ver progreso</button>
          `;
        } else {
          banner.innerHTML = `
            <div><strong>Capítulo no descargado:</strong> Descárgalo ahora para activar el botón Play.</div>
            <div style="display:flex;gap:8px;">
              <button class="sebitv-pill-btn" id="sebitv-nat-dl-ep">⬇ Descargar Capítulo</button>
              <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">Ver toda la serie</button>
            </div>
          `;
        }

        detailContainer.prepend(banner);

        const dlBtn = banner.querySelector('#sebitv-nat-dl-ep');
        if (dlBtn) {
          dlBtn.onclick = async () => {
            dlBtn.disabled = true;
            dlBtn.textContent = '⏳ Iniciando descarga...';
            await api('/api/download/episode', { method: 'POST', body: JSON.stringify({ episodeId: ep.id }) });
            existingBanner?.remove();
            openOverlay('detail', {
              mediaType: 'tv',
              tmdbId: item.tmdb_id,
              selectedSeason: ep.season_number,
            });
          };
        }
        const delBtn = banner.querySelector('#sebitv-nat-del-ep');
        if (delBtn) {
          delBtn.onclick = async () => {
            await api(`/api/media/episode/${ep.id}`, { method: 'DELETE' });
            window.location.reload();
          };
        }
        const mgrBtn = banner.querySelector('#sebitv-nat-manage');
        if (mgrBtn) {
          mgrBtn.onclick = () =>
            openOverlay('detail', {
              mediaType: 'tv',
              tmdbId: item.tmdb_id,
              selectedSeason: ep.season_number,
            });
        }
      } else if (bridge.jellyfinType === 'Series' || bridge.jellyfinType === 'Season') {
        banner.innerHTML = `
          <div>
            <strong>SebiTV (${esc(item.languageRule)}):</strong> Descarga capítulos sueltos, temporadas o OVAs.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn" id="sebitv-nat-open-episodes">⬇ Gestionar y Descargar Capítulos</button>
          </div>
        `;
        detailContainer.prepend(banner);
        banner.querySelector('#sebitv-nat-open-episodes').onclick = () =>
          openOverlay('detail', {
            mediaType: 'tv',
            tmdbId: item.tmdb_id,
            selectedSeason: bridge.seasonNumber ?? null,
          });
      } else if (bridge.jellyfinType === 'Movie') {
        banner.innerHTML = `
          <div>
            <strong>SebiTV (${esc(item.languageRule)}):</strong> Película descargada en tu servidor.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-nat-pin-mov">
              ${item.pinned ? '📌 Película Fijada' : '📌 Fijar Película'}
            </button>
            <button class="sebitv-pill-btn danger" id="sebitv-nat-del-mov">🗑 Desinstalar Película</button>
          </div>
        `;
        detailContainer.prepend(banner);
        banner.querySelector('#sebitv-nat-pin-mov').onclick = async () => {
          await api('/api/pin', {
            method: 'POST',
            body: JSON.stringify({ targetType: 'item', id: item.id, pinned: !item.pinned }),
          });
          window.location.reload();
        };
        banner.querySelector('#sebitv-nat-del-mov').onclick = async () => {
          await api(`/api/media/movie/${item.id}`, { method: 'DELETE' });
          window.location.hash = '#/home';
        };
      }
    } catch {
      // Ignorar errores transitorios
    } finally {
      if (state.injectingDetailId === jellyfinId) {
        state.injectingDetailId = null;
      }
    }
  }

  /* =========================================================================
     6. Bucle de refresco en vivo (Actualiza % de descarga y aparición del Play)
     ========================================================================= */
  async function backgroundPoll() {
    try {
      await syncBrowserJellyfinToken();
      const { active } = await api('/api/downloads/active');
      const count = active?.length || 0;
      const prevCount = state.activeDownloadsCount;
      state.activeDownloadsCount = count;

      const badge = document.getElementById('sebitv-dl-count');
      if (badge) {
        badge.style.display = count > 0 ? 'inline-block' : 'none';
        badge.textContent = String(count);
      }

      if (state.overlayOpen) {
        if (state.currentView === 'downloads') {
          await renderDownloadsInModal();
        } else if (
          state.currentView === 'detail' &&
          state.detailKey &&
          (count > 0 || prevCount > 0) &&
          !document.getElementById('sebitv-close-lupa')
        ) {
          await renderItemDetailInModal(
            state.detailKey.mediaType,
            state.detailKey.tmdbId,
            state.detailKey.selectedSeason,
            true
          );
        }
      } else {
        const hash = window.location.hash || '';
        if (hash.includes('/details')) {
          if (prevCount > 0 && count === 0) {
            window.location.reload();
          } else {
            injectNativeDetailPageControls();
          }
        }
      }
    } catch {
      // Silenciar si el backend aún está iniciando
    }
  }

  function onRouteOrDomChange() {
    mountFloatingBar();
    injectHomeDiscoverRows(false);
    hookNativeJellyfinSearch();
    injectNativeDetailPageControls();
  }

  window.addEventListener('hashchange', () => {
    setTimeout(onRouteOrDomChange, 300);
  });

  const observer = new MutationObserver(() => {
    if (window.location.hash !== state.lastHash) {
      state.lastHash = window.location.hash;
      setTimeout(onRouteOrDomChange, 350);
    }
    hookNativeJellyfinSearch();
  });

  function boot() {
    mountFloatingBar();
    syncBrowserJellyfinToken();
    setTimeout(onRouteOrDomChange, 900);
    observer.observe(document.body, { childList: true, subtree: true });
    state.pollTimer = setInterval(backgroundPoll, 3500);
    backgroundPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

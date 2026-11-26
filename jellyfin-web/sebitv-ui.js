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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

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
      <button class="sebitv-pill-btn secondary" id="sebitv-open-settings" title="Estado y ajustes de SebiTV">
        <span>⚙</span>
      </button>
    `;
    document.body.appendChild(bar);

    document.getElementById('sebitv-open-catalog').addEventListener('click', () => openOverlay('discover'));
    document.getElementById('sebitv-open-downloads').addEventListener('click', () => openOverlay('downloads'));
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
  }

  async function openOverlay(view = 'discover', detailParams = null) {
    state.overlayOpen = true;
    state.currentView = view;
    if (detailParams) state.detailKey = detailParams;

    const overlay = ensureOverlayElement();
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="sebitv-modal">
        <div class="sebitv-modal-header">
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-home">Catálogo</button>
          <input type="search" class="sebitv-search-input" id="sebitv-global-search" placeholder="Buscar película, serie o anime en todo el catálogo...">
          <button class="sebitv-pill-btn secondary" id="sebitv-nav-dl">⬇ Descargas</button>
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
    document.getElementById('sebitv-nav-cfg').onclick = () => renderSettingsInModal();

    const searchInput = document.getElementById('sebitv-global-search');
    let debounce = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        const q = searchInput.value.trim();
        if (q.length >= 2) renderSearchInModal(q);
        else if (q.length === 0) renderDiscoverInModal();
      }, 350);
    });

    if (view === 'discover') await renderDiscoverInModal();
    else if (view === 'detail' && state.detailKey) {
      await renderItemDetailInModal(state.detailKey.mediaType, state.detailKey.tmdbId, state.detailKey.selectedSeason);
    } else if (view === 'downloads') await renderDownloadsInModal();
    else if (view === 'settings') await renderSettingsInModal();
  }

  function bindCardClicks(container) {
    container.querySelectorAll('[data-sebi-card="1"]').forEach((el) => {
      el.addEventListener('click', () => {
        const mediaType = el.getAttribute('data-type');
        const tmdbId = Number(el.getAttribute('data-tmdb'));
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
    // Jellyfin 12.4 usa "#/details?id=..." mientras que versiones antiguas usaban "#!/details?id=..."
    const prefix = (window.location.hash || '').startsWith('#!/') ? '#!/' : '#/';
    window.location.hash = `${prefix}details?id=${encodeURIComponent(jellyfinId)}`;

    if (autoPlay) {
      let attempts = 0;
      const tryClickPlay = setInterval(() => {
        attempts++;
        const playBtn = document.querySelector(
          '#itemDetailPage:not(.hide) .mainDetailButtons .btnPlay, .itemDetailPage:not(.hide) .btnPlay, .detailPagePrimaryContainer .btnPlay'
        );
        if (playBtn) {
          clearInterval(tryClickPlay);
          playBtn.click();
        } else if (attempts >= 20) {
          clearInterval(tryClickPlay);
        }
      }, 250);
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
              <div style="font-size:12px;font-weight:700;">⏳ ${esc(item.status_message || item.status)} (${Math.round(
                item.progress || 0
              )}%) ${formatSpeed(item.download_speed)}</div>
              <div class="sebitv-progress-bar-bg">
                <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, item.progress || 5)}%"></div>
              </div>
            </div>
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
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-dl-ovas">⬇ Descargar OVAs / Películas</button>`
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
                      <div style="font-size:11px;font-weight:700;">⏳ ${Math.round(ep.progress || 0)}% ${formatSpeed(
                        ep.download_speed
                      )}</div>
                      <div style="font-size:10px;color:var(--sebi-muted);">${esc(ep.status_message || ep.status)}</div>
                      <div class="sebitv-progress-bar-bg">
                        <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, ep.progress || 6)}%"></div>
                      </div>
                    </div>
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
        ${seasonsSectionHtml}
      `;

      // Enlazar eventos de Película
      const dlMovBtn = document.getElementById('sebitv-dl-movie');
      if (dlMovBtn) {
        dlMovBtn.onclick = async () => {
          dlMovBtn.disabled = true;
          dlMovBtn.textContent = '⏳ Buscando...';
          await api('/api/download/movie', { method: 'POST', body: JSON.stringify({ tmdbId }) });
          await renderItemDetailInModal(mediaType, tmdbId, null, true);
        };
      }
      const pickMovBtn = document.getElementById('sebitv-pick-movie-torrent');
      if (pickMovBtn) {
        pickMovBtn.onclick = () => showCandidatePicker('movie', tmdbId, null);
      }
      const playMovBtn = document.getElementById('sebitv-play-movie');
      if (playMovBtn) {
        playMovBtn.onclick = async () => {
          playMovBtn.disabled = true;
          playMovBtn.textContent = '⏳ Abriendo...';
          await syncBrowserJellyfinToken();
          const res = await api('/api/play-target', {
            method: 'POST',
            body: JSON.stringify({ mediaType: 'movie', itemId: item.id }),
          });
          if (res.jellyfinId) {
            navigateToJellyfinItem(res.jellyfinId, { autoPlay: true });
          } else {
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
          renderItemDetailInModal('tv', tmdbId, sNum, true);
        };
      });

      const dlCurSeasonBtn = document.getElementById('sebitv-dl-cur-season');
      if (dlCurSeasonBtn) {
        dlCurSeasonBtn.onclick = async () => {
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
          await api('/api/download/episode', {
            method: 'POST',
            body: JSON.stringify({ episodeId, tmdbId, seasonNumber, episodeNumber }),
          });
          await renderItemDetailInModal('tv', tmdbId, state.detailKey.selectedSeason, true);
        };
      });

      body.querySelectorAll('[data-ep-pick]').forEach((btn) => {
        btn.onclick = () => showCandidatePicker('episode', tmdbId, Number(btn.getAttribute('data-ep-pick')));
      });

      body.querySelectorAll('[data-ep-play="1"]').forEach((btn) => {
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = '⏳ Abriendo...';
          await syncBrowserJellyfinToken();
          const epId = Number(btn.getAttribute('data-epid'));
          const res = await api('/api/play-target', {
            method: 'POST',
            body: JSON.stringify({ mediaType: 'tv', itemId: item.id, episodeId: epId }),
          });
          if (res.jellyfinId) {
            navigateToJellyfinItem(res.jellyfinId, { autoPlay: true });
          } else if (res.seriesJellyfinId) {
            navigateToJellyfinItem(res.seriesJellyfinId, { autoPlay: false });
          } else {
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

  async function showCandidatePicker(kind, tmdbId, episodeId) {
    const slot = document.getElementById('sebitv-candidate-picker-slot');
    if (!slot) return;
    slot.innerHTML = `<div class="sebitv-native-banner">🔎 Buscando torrents compatibles con tu regla de idioma...</div>`;
    try {
      const endpoint =
        kind === 'movie' ? `/api/candidates/movie/${tmdbId}` : `/api/candidates/episode/${episodeId}`;
      const { candidates } = await api(endpoint);
      if (!candidates || candidates.length === 0) {
        slot.innerHTML = `<div class="sebitv-native-banner" style="border-color:var(--sebi-red)">No se encontraron torrents válidos para tu filtro de idioma.</div>`;
        return;
      }
      slot.innerHTML = `
        <div style="background:var(--sebi-surface);border:1px solid var(--sebi-accent);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-weight:700;margin-bottom:8px;">Elegir torrent manualmente (${candidates.length} compatibles)</div>
          ${candidates
            .slice(0, 8)
            .map(
              (c, idx) => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--sebi-border);font-size:12px;">
                <div style="min-width:0;flex:1;">
                  <div style="font-weight:600;word-break:break-word;">${esc(c.title)}</div>
                  <div style="color:var(--sebi-muted);">${esc(c.source)} • ${esc(c.sizeStr || '')} • 🌱 ${
                    c.seeders
                  } semillas ${c.isPack ? '• 📦 Pack Temporada (descarga selectiva)' : ''}</div>
                </div>
                <button class="sebitv-pill-btn" data-pick-idx="${idx}">⬇ Usar</button>
              </div>
            `
            )
            .join('')}
        </div>
      `;
      slot.querySelectorAll('[data-pick-idx]').forEach((b) => {
        b.onclick = async () => {
          const chosen = candidates[Number(b.getAttribute('data-pick-idx'))];
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
        if (cookieVal) payload.extCookie = cookieVal;

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
    if (wrapper && !force) return;
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
      bindCardClicks(wrapper);
    } catch {
      // Silenciar si el contenedor está reiniciando
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

    const detailContainer = document.querySelector(
      '#itemDetailPage:not(.hide) .detailPageContent, .itemDetailPage:not(.hide) .detailPagePrimaryContent'
    );
    if (!detailContainer) return;

    const existingBanner = detailContainer.querySelector('.sebitv-native-banner');
    if (existingBanner && existingBanner.dataset.jfid === jellyfinId) return;
    if (existingBanner) existingBanner.remove();

    try {
      const bridge = await api(`/api/jellyfin-bridge?jellyfinId=${encodeURIComponent(jellyfinId)}`);
      if (!bridge.matched || !bridge.item) return;

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
      }
    } catch {
      // Ignorar errores transitorios
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
        } else if (state.currentView === 'detail' && state.detailKey && (count > 0 || prevCount > 0)) {
          await renderItemDetailInModal(
            state.detailKey.mediaType,
            state.detailKey.tmdbId,
            state.detailKey.selectedSeason,
            true
          );
        }
      } else if (prevCount > 0 && count === 0) {
        // Acaba de terminar una descarga mientras el usuario mira una página nativa de Jellyfin -> refrescar vista
        const hash = window.location.hash || '';
        if (hash.includes('/details')) {
          window.location.reload();
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

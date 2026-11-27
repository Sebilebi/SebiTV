(() => {
  if (window.__SEBITV_LOADED__) return;
  window.__SEBITV_LOADED__ = true;

  const cfg = window.SEBITV_CONFIG || {};
  const API_BASE = cfg.publicUrl
    ? cfg.publicUrl.replace(/\/+$/, '')
    : `${window.location.protocol}//${window.location.hostname}:${cfg.port || '8099'}`;

  const state = {
    overlayOpen: false,
    currentView: 'discover', // 'discover' | 'detail' | 'downloads' | 'preferences' | 'logs' | 'settings'
    detailKey: null, // { mediaType, tmdbId, selectedSeason }
    activeDownloadsCount: 0,
    pollTimer: null,
    lastHash: '',
  };

  /* Diccionario de iconos vectoriales Material Design (estilo nativo Jellyfin, sin emojis) */
  const SVG_PATHS = {
    explore: 'M12 2a10 10 0 1 0 10 10A10.01 10.01 0 0 0 12 2zm3.8 6.2-2.6 6-6 2.6 2.6-6 6-2.6zM12 13.1a1.1 1.1 0 1 0-1.1-1.1 1.1 1.1 0 0 0 1.1 1.1z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    play: 'M8 5v14l11-7z',
    pin: 'M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    tune: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    settings: 'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.74 8.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 15.6 12 3.6 3.6 0 0 1 12 15.6z',
    logs: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 14H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A5.99 5.99 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    spinner: 'M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z',
    star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    movie: 'M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z',
    tv: 'M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 1.99-.9 1.99-2L23 5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z',
    audio: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    subtitles: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z',
    hd: 'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm2-6h4c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1h-4V9zm1.5 4.5h2v-3h-2v3z',
    storage: 'M2 20h20v-4H2v4zm2-3h2v2H4v-2zM2 4v4h20V4H2zm4 3H4V5h2v2zm-4 7h20v-4H2v4zm2-3h2v2H4v-2z',
    layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
    file: 'M6 2c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
  };

  function ico(name, extraCls = '') {
    const d = SVG_PATHS[name] || SVG_PATHS.explore;
    return `<svg class="sebitv-ico ${extraCls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  }

  function cleanEmojiText(str = '') {
    return String(str)
      .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function formatBadgeLabel(rawBadge = '') {
    const s = String(rawBadge);
    if (s.includes('Castellano')) return 'ES · Castellano';
    if (s.includes('Latino')) return 'LAT · Latino';
    if (s.includes('Japonés')) return 'JP · Japonés';
    if (s.includes('Inglés')) return 'EN · Inglés';
    if (s.includes('Francés')) return 'FR · Francés';
    if (s.includes('Italiano')) return 'IT · Italiano';
    if (s.includes('Alemán')) return 'DE · Alemán';
    if (s.includes('Portugués')) return 'PT · Portugués';
    if (s.includes('Ruso')) return 'RU · Ruso';
    if (s.includes('MultiSub (incl. ES)')) return 'SUB · MultiSub (ES)';
    if (s.includes('MultiSub')) return 'SUB · MultiSub';
    if (s.includes('Sub Español')) return 'SUB · Español';
    if (s.includes('Sub Inglés')) return 'SUB · Inglés';
    if (s.includes('Multi-Audio')) return 'Multi-Audio';
    return cleanEmojiText(s) || 'Sin especificar';
  }

  function renderRulePillsHtml(ruleStr = '') {
    if (!ruleStr) return '';
    return String(ruleStr)
      .split('•')
      .map((part, idx) => {
        const clean = cleanEmojiText(part);
        if (!clean) return '';
        const iconName = idx === 0 ? 'audio' : idx === 1 ? 'subtitles' : 'hd';
        return `<span class="sebitv-rule-pill">${ico(iconName, 'sm')}<span>${esc(clean)}</span></span>`;
      })
      .join('');
  }

  /* =========================================================================
     Detección en tiempo real de reproducción de vídeo en Jellyfin (Web/Desktop/Móvil)
     ========================================================================= */
  function isVideoPlaybackActive() {
    const hash = window.location.hash || '';
    if (/#!?\/video/i.test(hash)) return true;
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    const osd = document.querySelector(
      '#videoOsdPage:not(.hide), .videoOsdPage:not(.hide), .videoPlayerContainer, .upNextDialog:not(.hide)'
    );
    if (osd) return true;
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      if (v.closest('.hide')) continue;
      const cs = window.getComputedStyle(v);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (v.classList.contains('htmlvideoplayer') || Boolean(v.currentSrc || v.src) || !v.paused) {
        return true;
      }
    }
    return false;
  }

  function syncHudVisibility() {
    const playing = isVideoPlaybackActive();
    const fab = document.getElementById('sebitv-fab');
    if (fab) {
      fab.classList.toggle('is-hidden-video', playing);
    }
    const hBtn = document.getElementById('sebitv-header-trigger');
    if (hBtn) {
      hBtn.style.display = playing ? 'none' : '';
    }
    if (playing && state.overlayOpen) {
      closeOverlay();
    }
  }

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
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#18181b"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#52525b" font-family="sans-serif" font-size="48">${initials}</text></svg>`
    )}`;
  }

  function renderCardHtml(card) {
    const img = card.posterUrl || posterPlaceholder(card.title);
    const isReady = card.localStatus === 'available';
    const typeLabel = card.isAnime ? 'Anime' : card.mediaType === 'movie' ? 'Película' : 'Serie';
    return `
      <div class="sebitv-card" data-sebi-card="1" data-type="${esc(card.mediaType)}" data-tmdb="${esc(card.tmdbId)}">
        <div class="sebitv-card-poster-wrap">
          <img class="sebitv-card-poster" loading="lazy" src="${esc(img)}" alt="${esc(card.title)}">
          <span class="sebitv-card-tag">${typeLabel}</span>
          ${isReady ? `<span class="sebitv-card-ready" title="Disponible para reproducir">${ico('check', 'sm')}</span>` : ''}
        </div>
        <div class="sebitv-card-body">
          <div class="sebitv-card-title" title="${esc(card.title)}">${esc(card.title)}</div>
          <div class="sebitv-card-sub">
            <span>${card.year || '—'}</span>
            ${card.rating ? `<span>•</span><span style="display:inline-flex;align-items:center;gap:2px;color:#f59e0b;">${ico('star', 'sm')}${card.rating}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  /* =========================================================================
     1. Dock minimalista + Botón integrado en cabecera nativa de Jellyfin
     ========================================================================= */
  function mountFloatingBar() {
    if (!document.getElementById('sebitv-fab')) {
      const bar = document.createElement('div');
      bar.id = 'sebitv-fab';
      bar.className = 'sebitv-fab-bar';
      bar.innerHTML = `
        <button class="sebitv-dock-btn primary" id="sebitv-open-catalog" title="Explorar catálogo global de Películas, Series y Anime">
          ${ico('explore')}
          <span>Catálogo</span>
        </button>
        <div class="sebitv-dock-divider"></div>
        <button class="sebitv-dock-btn" id="sebitv-open-downloads" title="Descargas en curso">
          ${ico('download')}
          <span id="sebitv-dl-count" class="sebitv-badge-count" style="display:none">0</span>
        </button>
        <button class="sebitv-dock-btn" id="sebitv-open-prefs" title="Preferencias de Calidad, Idioma y Subtítulos">
          ${ico('tune')}
        </button>
        <button class="sebitv-dock-btn" id="sebitv-open-settings" title="Estado de servicios y ajustes">
          ${ico('settings')}
        </button>
      `;
      document.body.appendChild(bar);

      document.getElementById('sebitv-open-catalog').addEventListener('click', () => openOverlay('discover'));
      document.getElementById('sebitv-open-downloads').addEventListener('click', () => openOverlay('downloads'));
      document.getElementById('sebitv-open-prefs').addEventListener('click', () => openOverlay('preferences'));
      document.getElementById('sebitv-open-settings').addEventListener('click', () => openOverlay('settings'));
    }

    // Integrar también acceso directo limpio en la barra superior VISIBLE de Jellyfin (MUI 12.4 primero, ignorando .skinHeader oculta)
    const headerRight = (() => {
      const muiToolbars = [...document.querySelectorAll('.MuiAppBar-root .MuiToolbar-root')].filter(
        (el) => el.offsetParent !== null
      );
      if (muiToolbars.length > 0) {
        const boxes = [...muiToolbars[0].children];
        if (boxes.length >= 2) return boxes[boxes.length - 1];
      }
      return [...document.querySelectorAll('.skinHeader .headerRight')].find((el) => el.offsetParent !== null) || null;
    })();
    const existingTrigger = document.getElementById('sebitv-header-trigger');
    if (existingTrigger && headerRight && !headerRight.contains(existingTrigger)) {
      existingTrigger.remove();
    }
    if (headerRight && !document.getElementById('sebitv-header-trigger')) {
      const hBtn = document.createElement('button');
      hBtn.type = 'button';
      hBtn.id = 'sebitv-header-trigger';
      hBtn.className = 'sebitv-header-btn';
      hBtn.title = 'Abrir catálogo bajo demanda SebiTV';
      hBtn.innerHTML = `${ico('explore', 'sm')}<span>Catálogo</span>`;
      hBtn.addEventListener('click', () => openOverlay('discover'));
      headerRight.prepend(hBtn);
    }

    syncHudVisibility();
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

  function updateActiveNavTab(viewName) {
    document.querySelectorAll('.sebitv-nav-tab[data-nav]').forEach((btn) => {
      const target = btn.getAttribute('data-nav');
      const isAct = target === viewName || (viewName === 'detail' && target === 'discover') || (viewName === 'search' && target === 'discover');
      btn.classList.toggle('active', isAct);
    });
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
        <div class="sebitv-modal-header">
          <div class="sebitv-nav-tabs">
            <button class="sebitv-nav-tab" id="sebitv-nav-home" data-nav="discover">
              ${ico('explore', 'sm')}<span>Catálogo</span>
            </button>
            <button class="sebitv-nav-tab" id="sebitv-nav-dl" data-nav="downloads">
              ${ico('download', 'sm')}<span>Descargas</span>
              ${state.activeDownloadsCount > 0 ? `<span class="sebitv-badge-count">${state.activeDownloadsCount}</span>` : ''}
            </button>
            <button class="sebitv-nav-tab" id="sebitv-nav-prefs" data-nav="preferences">
              ${ico('tune', 'sm')}<span>Preferencias</span>
            </button>
            <button class="sebitv-nav-tab" id="sebitv-nav-logs" data-nav="logs">
              ${ico('logs', 'sm')}<span>Logs</span>
            </button>
            <button class="sebitv-nav-tab" id="sebitv-nav-cfg" data-nav="settings" title="Ajustes">
              ${ico('settings', 'sm')}<span>Ajustes</span>
            </button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end;min-width:220px;">
            <div class="sebitv-search-wrap">
              <span class="sebitv-search-ico">${ico('search', 'sm')}</span>
              <input type="search" class="sebitv-search-input" id="sebitv-global-search" placeholder="Buscar película, serie o anime...">
            </div>
            <button class="sebitv-close-icon-btn" id="sebitv-close-modal" title="Cerrar">${ico('close', 'lg')}</button>
          </div>
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
    updateActiveNavTab('discover');
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
            <button class="sebitv-pill-btn" id="sebitv-goto-cfg">${ico('settings', 'sm')}<span>Configurar TMDB API Key</span></button>
          </div>
        `;
        document.getElementById('sebitv-goto-cfg').onclick = () => renderSettingsInModal();
        return;
      }

      body.innerHTML = (data.sections || [])
        .map(
          (sec) => `
          <div>
            <div class="sebitv-section-title">${esc(cleanEmojiText(sec.title) || sec.title)}</div>
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
    updateActiveNavTab('search');
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
              setTimeout(syncHudVisibility, 120);
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
    state.currentView = 'detail';
    updateActiveNavTab('detail');
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
          heroButtonsHtml = `
            <button class="sebitv-pill-btn play-ready" id="sebitv-play-movie">${ico('play')}<span>Play</span></button>
            <button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-pin-movie">
              ${ico('pin', 'sm')}<span>${item.pinned ? 'Fijada (No borrar)' : 'Fijar película'}</span>
            </button>
            <button class="sebitv-pill-btn danger" id="sebitv-del-movie">${ico('trash', 'sm')}<span>Desinstalar vídeo</span></button>
          `;
        } else if (item.status === 'downloading' || item.status === 'searching' || item.status === 'processing') {
          heroButtonsHtml = `
            <div class="sebitv-progress-box">
              <div style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;">
                ${ico('spinner', 'sm sebitv-spin')}
                <span>${esc(item.status_message || item.status)} (${Math.floor(item.progress || 0)}%) ${formatSpeed(item.download_speed)}</span>
              </div>
              <div class="sebitv-progress-bar-bg">
                <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, item.progress || 5)}%"></div>
              </div>
            </div>
            <button class="sebitv-pill-btn danger" id="sebitv-del-movie" title="Cancelar descarga">${ico('close', 'sm')}<span>Cancelar</span></button>
          `;
        } else {
          heroButtonsHtml = `
            <button class="sebitv-pill-btn" id="sebitv-dl-movie">${ico('download', 'sm')}<span>Descargar Película</span></button>
            <button class="sebitv-pill-btn secondary" id="sebitv-pick-movie-torrent">${ico('search', 'sm')}<span>Elegir versión</span></button>
            ${
              item.status === 'error'
                ? `<div style="width:100%;color:var(--sebi-red);font-size:12px;margin-top:6px;display:flex;align-items:center;gap:6px;">${ico(
                    'warning',
                    'sm'
                  )}<span>${esc(item.status_message || '')}</span></div>`
                : ''
            }
          `;
        }
      } else {
        heroButtonsHtml = `
          ${
            !registered
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-reg-series">${ico('add', 'sm')}<span>Añadir a Biblioteca</span></button>`
              : item.jellyfin_id
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-open-jf-series">${ico('open', 'sm')}<span>Ver en Jellyfin</span></button>`
              : ''
          }
          <button class="sebitv-pill-btn" id="sebitv-dl-all-series">${ico('download', 'sm')}<span>Descargar Serie Completa</span></button>
          ${
            hasSpecials
              ? `<button class="sebitv-pill-btn secondary" id="sebitv-dl-ovas">${ico('download', 'sm')}<span>Descargar OVAs / Especiales</span></button>`
              : ''
          }
          ${
            registered
              ? `<button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-pin-series">
                  ${ico('pin', 'sm')}<span>${item.pinned ? 'Serie Fijada' : 'Fijar Serie'}</span>
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
            <div style="font-size:12.5px;color:var(--sebi-muted)">
              Ventana automática activa: al reproducir un capítulo pre-descarga el siguiente (<strong>+1</strong>), conserva el anterior (<strong>-1</strong>) y limpia los antiguos no fijados.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="sebitv-pill-btn" id="sebitv-dl-cur-season">
                ${ico('download', 'sm')}<span>Descargar ${curSeasonNum === 0 ? 'OVAs / Especiales' : `Temporada ${curSeasonNum}`}</span>
              </button>
              ${
                registered
                  ? `<button class="sebitv-pill-btn ${seasonPinned ? 'pinned' : 'secondary'}" id="sebitv-pin-cur-season">
                      ${ico('pin', 'sm')}<span>${seasonPinned ? 'Temporada Fijada' : 'Fijar Temporada'}</span>
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
                  actionHtml = `
                    <button class="sebitv-pill-btn play-ready" data-ep-play="1" data-epid="${ep.id}" data-jfid="${esc(
                      ep.jellyfin_episode_id || item.jellyfin_id || ''
                    )}">${ico('play')}<span>Play</span></button>
                    <button class="sebitv-pill-btn icon-only ${ep.pinned ? 'pinned' : 'secondary'}" data-ep-pin="${ep.id}" data-pinned="${
                      ep.ownPinned ? '1' : '0'
                    }" title="Fijar para no borrar automáticamente">${ico('pin', 'sm')}</button>
                    <button class="sebitv-pill-btn icon-only danger" data-ep-del="${ep.id}" title="Desinstalar archivo del disco">${ico('trash', 'sm')}</button>
                  `;
                } else if (ep.status === 'downloading' || ep.status === 'searching' || ep.status === 'processing') {
                  actionHtml = `
                    <div class="sebitv-progress-box">
                      <div style="font-size:11.5px;font-weight:600;display:flex;align-items:center;gap:5px;">
                        ${ico('spinner', 'sm sebitv-spin')}
                        <span>${Math.floor(ep.progress || 0)}% ${formatSpeed(ep.download_speed)}</span>
                      </div>
                      <div style="font-size:10.5px;color:var(--sebi-muted);margin-top:2px;">${esc(ep.status_message || ep.status)}</div>
                      <div class="sebitv-progress-bar-bg">
                        <div class="sebitv-progress-bar-fill" style="width:${Math.min(100, ep.progress || 6)}%"></div>
                      </div>
                    </div>
                    <button class="sebitv-pill-btn icon-only danger" data-ep-del="${ep.id}" title="Cancelar descarga">${ico('close', 'sm')}</button>
                  `;
                } else {
                  actionHtml = `
                    <button class="sebitv-pill-btn" data-ep-dl="1" data-epid="${ep.id || ''}" data-s="${sNum}" data-e="${epNum}">
                      ${ico('download', 'sm')}<span>Descargar</span>
                    </button>
                    ${
                      ep.id
                        ? `<button class="sebitv-pill-btn icon-only secondary" data-ep-pick="${ep.id}" title="Explorar versiones e idiomas">${ico('search', 'sm')}</button>`
                        : ''
                    }
                  `;
                }

                return `
                  <div class="sebitv-episode-row">
                    <img class="sebitv-ep-thumb" loading="lazy" src="${esc(thumb)}" alt="${esc(ep.title)}">
                    <div class="sebitv-ep-info">
                      <div class="sebitv-ep-title">
                        <span class="sebitv-ep-code">${code}</span>
                        <span>${esc(ep.title)}</span>
                        ${ep.watched ? `<span class="sebitv-watched-tag">${ico('check', 'sm')}<span>Visto</span></span>` : ''}
                      </div>
                      <div class="sebitv-ep-desc">${esc(ep.overview || 'Sin descripción disponible.')}</div>
                      ${
                        ep.status === 'error' && ep.status_message
                          ? `<div style="color:var(--sebi-red);font-size:11.5px;margin-top:4px;display:flex;align-items:center;gap:5px;">${ico(
                              'warning',
                              'sm'
                            )}<span>${esc(ep.status_message)}</span></div>`
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
              <div class="sebitv-section-title" style="margin-top:0;">${ico('movie')}<span>Películas de esta Saga</span></div>
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
            <div class="sebitv-rule-pills">
              ${renderRulePillsHtml(item.languageRule || '')}
            </div>
            <h2 style="margin:0 0 6px;font-size:1.65rem;font-weight:600;">${esc(item.title)} ${item.year ? `<span style="font-weight:400;color:var(--sebi-muted);">(${item.year})</span>` : ''}</h2>
            <p style="color:var(--sebi-muted);font-size:13px;line-height:1.55;max-width:720px;margin:0;">
              ${esc(item.overview || 'Sin sinopsis en español.')}
            </p>
            <div class="sebitv-hero-actions">${heroButtonsHtml}</div>
          </div>
        </div>
        ${relatedMoviesHtml}
        ${seasonsSectionHtml}
      `;
      bindCardClicks(body);

      const dlMovBtn = document.getElementById('sebitv-dl-movie');
      if (dlMovBtn) {
        dlMovBtn.onclick = async () => {
          uiLog('ui.click_download_movie', `Pulsó Descargar Película: "${item.title}"`, { tmdbId, title: item.title });
          dlMovBtn.disabled = true;
          dlMovBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Buscando...</span>`;
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
          playMovBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Abriendo...</span>`;
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
            playMovBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Indexando en Jellyfin (pulsa en 3s)</span>`;
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

      const regBtn = document.getElementById('sebitv-reg-series');
      if (regBtn) {
        regBtn.onclick = async () => {
          regBtn.disabled = true;
          regBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Creando ficha...</span>`;
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
          dlAllBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Encolando serie...</span>`;
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
          dlCurSeasonBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Encolando temporada...</span>`;
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
          btn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Buscando...</span>`;
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
          btn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Abriendo...</span>`;
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
            btn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Indexando (pulsa en 3s)</span>`;
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
        <span style="color:var(--sebi-accent);display:flex;">${ico('spinner', 'lg sebitv-spin')}</span>
        <div>
          <div style="font-weight:600;font-size:14px;">Explorando versiones en todos los idiomas y calidades...</div>
          <div style="color:var(--sebi-muted);font-size:12px;">Consultando indexadores simultáneamente (4K, 1080p, 720p, Castellano, Japonés, VOSE, Multi-Audio)</div>
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
        slot.innerHTML = `<div class="sebitv-native-banner" style="border-left-color:var(--sebi-red)">No se encontraron torrents con semillas activas en ningún idioma para este título.</div>`;
        return;
      }

      const langFilters = [
        { id: 'all', label: 'Todos' },
        { id: 'Castellano', label: 'Castellano' },
        { id: 'Latino', label: 'Latino' },
        { id: 'Japonés', label: 'Japonés' },
        { id: 'Inglés', label: 'Inglés' },
        { id: 'Sub Español', label: 'Sub Español' },
        { id: 'MultiSub', label: 'MultiSub' },
        { id: 'Multi-Audio', label: 'Multi-Audio' },
      ];

      const qualityFilters = [
        { id: 'all', label: 'Todas' },
        { id: '4K', label: '4K UHD' },
        { id: '1080p', label: '1080p' },
        { id: '720p', label: '720p' },
        { id: 'SD', label: 'SD' },
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
                ${ico('search')}
                <span>Explorador de Versiones</span>
                <span class="sebitv-lupa-counter" id="sebitv-lupa-counter"></span>
              </div>
              <div class="sebitv-lupa-subtitle">
                Filtra por resolución o idioma y ordena por disponibilidad (semillas) o tamaño antes de descargar.
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="sebitv-pill-btn secondary" id="sebitv-reset-lupa" style="display:none;height:32px;padding:0 10px;font-size:12px;">
                ${ico('refresh', 'sm')}<span>Limpiar filtros</span>
              </button>
              <button class="sebitv-pill-btn secondary" id="sebitv-close-lupa" style="height:32px;padding:0 10px;font-size:12px;">
                ${ico('close', 'sm')}<span>Cerrar</span>
              </button>
            </div>
          </div>

          <div class="sebitv-lupa-toolbar">
            <div class="sebitv-lupa-search-row">
              <div class="sebitv-lupa-sort-wrap">
                <label for="sebitv-lupa-sort">Ordenar por</label>
                <select id="sebitv-lupa-sort" class="sebitv-select sebitv-lupa-sort-select">
                  <option value="score">Recomendado (Equilibrio ideal)</option>
                  <option value="seeders_desc">Más semillas (Descarga más rápida)</option>
                  <option value="res_desc">Mayor resolución (4K a SD)</option>
                  <option value="size_asc">Menor tamaño (Más ligero)</option>
                  <option value="size_desc">Mayor tamaño (Máximo bitrate)</option>
                </select>
              </div>
              <div class="sebitv-lupa-query-wrap">
                <label for="sebitv-lupa-query">Filtro rápido</label>
                <input type="search" id="sebitv-lupa-query" class="sebitv-lupa-query-input" placeholder="Buscar códec (HEVC, x265, AV1, HDR), grupo o indexador...">
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
              <div style="margin-bottom:6px;color:var(--sebi-muted);">${ico('search', 'lg')}</div>
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
              const seedDotCls = seeds >= 20 ? 'ok' : seeds >= 5 ? 'warn' : 'err';
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
                      ${isTopPick ? `<span class="sebitv-top-tag">${ico('star', 'sm')}<span>Recomendada</span></span>` : ''}
                      <span>${esc(displayTitle)}</span>
                    </div>
                    ${
                      subFileTitle
                        ? `<div class="sebitv-lupa-subfile" title="${esc(subFileTitle)}">${ico('file', 'sm')}<span>${esc(subFileTitle)}</span></div>`
                        : ''
                    }
                    <div class="sebitv-lupa-badges-row">
                      ${(c.languageBadges || [])
                        .map((b) => {
                          const isCast = b.includes('Castellano');
                          return `<span class="sebitv-lang-chip ${isCast ? 'is-castellano' : ''}">${esc(formatBadgeLabel(b))}</span>`;
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
                      <span class="sebitv-meta-pill ${seedCls}">
                        <span class="sebitv-dot ${seedDotCls}"></span>
                        <span>${seeds} ${seeds === 1 ? 'semilla' : 'semillas'}</span>
                      </span>
                      ${sizeLabel ? `<span class="sebitv-meta-pill">${ico('storage', 'sm')}<span>${esc(sizeLabel)}</span></span>` : ''}
                      <span class="sebitv-meta-pill">${ico('layers', 'sm')}<span>${esc(trackerLabel)}</span></span>
                      ${
                        c.isPack
                          ? `<span class="sebitv-meta-pill is-pack">Pack selectivo</span>`
                          : ''
                      }
                    </div>
                  </div>

                  <div class="sebitv-lupa-card-action">
                    <button class="sebitv-pill-btn" data-pick-idx="${origIdx}">${ico('download', 'sm')}<span>Descargar</span></button>
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
            b.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Añadiendo...</span>`;
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
     4. Vista de Cola de Descargas Activas, Preferencias, Logs y Ajustes
     ========================================================================= */
  async function renderDownloadsInModal() {
    state.currentView = 'downloads';
    updateActiveNavTab('downloads');
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const { active } = await api('/api/downloads/active');
      if (!active || active.length === 0) {
        body.innerHTML = `
          <div style="text-align:center;padding:42px 20px;color:var(--sebi-muted);">
            <div style="margin-bottom:8px;opacity:0.5;">${ico('download', 'lg')}</div>
            <div>No hay ninguna descarga en curso en este momento.</div>
          </div>
        `;
        return;
      }
      body.innerHTML = `
        <div class="sebitv-section-title">${ico('download')}<span>Descargas en Curso (${active.length})</span></div>
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
              <div style="font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;">
                ${ico('spinner', 'sm sebitv-spin')}
                <span>${Math.round(d.progress || 0)}% ${formatSpeed(d.downloadSpeed)}</span>
              </div>
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
    updateActiveNavTab('preferences');
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;

    const audioOpts = [
      { v: 'ja', l: 'Japonés (Audio Original Anime)' },
      { v: 'es-ES', l: 'Español de España (Castellano)' },
      { v: 'es-419', l: 'Español Latino' },
      { v: 'en', l: 'Inglés (Versión Original)' },
      { v: 'any', l: 'Cualquier idioma disponible' },
      { v: 'none', l: 'Ninguno (No aceptar otro)' },
    ];

    const subOpts = [
      { v: 'off', l: 'Desactivados (Sin subtítulos)' },
      { v: 'es-ES', l: 'Español de España (Castellano)' },
      { v: 'es-419', l: 'Español Latino' },
      { v: 'en', l: 'Inglés' },
      { v: 'any', l: 'Cualquiera / Opcional' },
      { v: 'none', l: 'Ninguno (No aceptar otro)' },
    ];

    const qualityOpts = [
      { v: 'best', l: 'Mejor resolución posible (4K UHD > 1080p > 720p)' },
      { v: '4k', l: '4K UHD (2160p)' },
      { v: '1080p', l: '1080p Full HD (Recomendado: calidad / espacio)' },
      { v: '720p', l: '720p HD (Ligero y rápido, ahorra espacio)' },
      { v: 'sd', l: 'SD / 480p (Mínimo espacio en disco)' },
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
        <div class="sebitv-section-title" style="margin-top:4px;">${ico('tune')}<span>Preferencias de Calidad, Idioma y Subtítulos</span></div>
        <p style="color:var(--sebi-muted);font-size:13px;margin-top:-4px;margin-bottom:16px;">
          El botón <strong>Descargar</strong> aplica automáticamente el idioma, subtítulo y resolución configurados aquí para cada categoría. Para escoger una copia puntual manualmente, utiliza el botón de <strong>Explorador de Versiones</strong>.
        </p>

        <div class="sebitv-pref-grid">
          <div class="sebitv-pref-card">
            <h3 class="sebitv-pref-card-header" style="color:var(--sebi-accent);">${ico('tv')}<span>Anime (Series, OVAs y Películas de Anime)</span></h3>
            <div class="sebitv-pref-quality-box">
              <div class="sebitv-form-group" style="margin-bottom:8px;">
                <label>Calidad de Vídeo Preferida</label>
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
            <h3 class="sebitv-pref-card-header" style="color:var(--sebi-green);">${ico('movie')}<span>Series y Películas Comerciales (No-Anime)</span></h3>
            <div class="sebitv-pref-quality-box">
              <div class="sebitv-form-group" style="margin-bottom:8px;">
                <label>Calidad de Vídeo Preferida</label>
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

        <div style="display:flex;align-items:center;gap:12px;">
          <button class="sebitv-pill-btn" id="sebitv-save-prefs">${ico('check', 'sm')}<span>Guardar Preferencias</span></button>
          <span id="sebitv-prefs-msg" style="font-size:13px;color:var(--sebi-green);"></span>
        </div>
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
        document.getElementById('sebitv-prefs-msg').innerHTML = `${ico('check', 'sm')} Preferencias guardadas correctamente`;
      };
    } catch (err) {
      body.innerHTML = `<p style="color:var(--sebi-red)">${esc(err.message)}</p>`;
    }
  }

  async function renderLogsInModal(filterLevel = '') {
    state.currentView = 'logs';
    updateActiveNavTab('logs');
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const qs = filterLevel ? `?limit=250&level=${encodeURIComponent(filterLevel)}` : '?limit=250';
      const data = await api(`/api/logs${qs}`);
      const logs = data.logs || [];

      const badgeStyle = (lvl) => {
        if (lvl === 'ERROR') return 'background:#ef4444;color:#fff;';
        if (lvl === 'WARNING') return 'background:#f59e0b;color:#111;';
        if (lvl === 'SUCCESS') return 'background:#38c172;color:#052111;';
        if (lvl === 'USER') return 'background:#00d2d3;color:#022224;';
        return 'background:#3b82f6;color:#fff;';
      };

      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px;">
          <div>
            <div class="sebitv-section-title" style="margin:0;">${ico('logs')}<span>Registro de Eventos y Diagnóstico</span></div>
            <div style="font-size:11px;color:var(--sebi-muted);margin-top:3px;">
              Archivo: <code>${esc(data.logFilePath || '/config/logs/sebitv.log')}</code> • Raw: <code>${esc(
                API_BASE
              )}/api/logs/raw</code>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn ${!filterLevel ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="">Todos</button>
            <button class="sebitv-pill-btn ${filterLevel === 'USER' ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="USER">USER</button>
            <button class="sebitv-pill-btn ${filterLevel === 'INFO' ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="INFO">INFO</button>
            <button class="sebitv-pill-btn ${filterLevel === 'SUCCESS' ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="SUCCESS">SUCCESS</button>
            <button class="sebitv-pill-btn ${filterLevel === 'WARNING' ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="WARNING">WARNING</button>
            <button class="sebitv-pill-btn ${filterLevel === 'ERROR' ? '' : 'secondary'}" style="height:32px;padding:0 10px;font-size:12px;" data-lvl="ERROR">ERROR</button>
            <button class="sebitv-pill-btn icon-only secondary" style="width:32px;height:32px;" id="sebitv-log-refresh" title="Actualizar">${ico('refresh', 'sm')}</button>
          </div>
        </div>
        <div style="background:#0c0c0e;border:1px solid var(--sebi-border);border-radius:8px;padding:12px;max-height:64vh;overflow-y:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;">
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
                          <span class="sebitv-log-badge" style="${badgeStyle(l.level)}">${esc(l.level)}</span>
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
    updateActiveNavTab('settings');
    const body = document.getElementById('sebitv-modal-body');
    if (!body) return;
    try {
      const [health, settings] = await Promise.all([api('/api/health'), api('/api/settings')]);
      const dot = (kind) => `<span class="sebitv-dot ${kind}"></span>`;
      body.innerHTML = `
        <div class="sebitv-section-title" style="margin-top:4px;">${ico('settings')}<span>Estado de Servicios</span></div>
        <div style="margin-bottom:20px;">
          <span class="sebitv-status-chip">${dot(health.tmdbConfigured ? 'ok' : 'err')}<span>Catálogo TMDB</span></span>
          <span class="sebitv-status-chip">${dot(health.jellyfin?.ok ? 'ok' : 'err')}<span>Jellyfin ${esc(
            health.jellyfin?.version || ''
          )} ${health.jellyfin?.authenticated ? '(Autenticado)' : '(Sin autenticar)'}</span></span>
          <span class="sebitv-status-chip">${dot(health.qbittorrent?.ok ? 'ok' : 'err')}<span>qBittorrent ${esc(
            health.qbittorrent?.version || ''
          )}</span></span>
          <span class="sebitv-status-chip">${dot(health.nyaaEnabled ? 'ok' : '')}<span>Nyaa Anime MultiSub</span></span>
          <span class="sebitv-status-chip">${dot(
            health.extStatus?.ok === true ? 'ok' : health.extStatus?.blockedByChallenge ? 'warn' : ''
          )}<span>ext.to (${esc(health.extStatus?.message || 'Listo')})</span></span>
          ${
            health.disk
              ? `<span class="sebitv-status-chip">${ico('storage', 'sm')}<span>Disco libre: <strong>${health.disk.freeGb} GB</strong> / ${health.disk.totalGb} GB (${health.disk.usedPct}% usado)</span></span>`
              : ''
          }
        </div>

        <div class="sebitv-section-title">Ajustes del Servidor</div>
        <div class="sebitv-form-group">
          <label>TMDB API Key (Gratuita — catálogo mundial en español)</label>
          <input type="text" id="sebitv-cfg-tmdb" placeholder="${
            settings.tmdbConfigured ? `Configurada (${settings.tmdbApiKeyMasked}) — escribe para reemplazar` : 'Pega aquí tu API Key o Read Token de themoviedb.org'
          }">
        </div>
        <div class="sebitv-form-group">
          <label>Cookie de sesión de ext.to (Opcional, si Cloudflare solicita verificación)</label>
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
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="sebitv-pill-btn" id="sebitv-cfg-save">${ico('check', 'sm')}<span>Guardar Ajustes</span></button>
          <span id="sebitv-cfg-msg" style="font-size:13px;color:var(--sebi-green);"></span>
        </div>
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
        document.getElementById('sebitv-cfg-msg').innerHTML = `${ico('check', 'sm')} Ajustes guardados`;
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
              <strong>SebiTV listo:</strong> Añade tu <code>TMDB_API_KEY</code> gratuita para explorar todo el catálogo mundial aquí mismo.
            </div>
            <button class="sebitv-pill-btn" id="sebitv-banner-cfg">${ico('settings', 'sm')}<span>Configurar TMDB</span></button>
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
            <div class="sebitv-section-title">${esc(cleanEmojiText(sec.title) || sec.title)}</div>
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
            <div class="sebitv-section-title">${ico('explore')}<span>Catálogo Global para Descargar ("${esc(q)}")</span></div>
            <div class="sebitv-grid">${items.map(renderCardHtml).join('')}</div>
          `;
          bindCardClicks(box);
        } catch {
          // Ignorar
        }
      }, 400);
    });
  }

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
      const cleanRule = cleanEmojiText(item.languageRule || '');

      if (bridge.jellyfinType === 'Episode') {
        const ep = (item.episodes || []).find(
          (e) => e.season_number === bridge.seasonNumber && e.episode_number === bridge.episodeNumber
        );
        if (!ep) return;

        if (ep.status === 'available' && !bridge.isVirtualInJellyfin) {
          banner.innerHTML = `
            <div><strong>SebiTV:</strong> Capítulo descargado y disponible (${esc(cleanRule)}).</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">${ico('tv', 'sm')}<span>Gestionar capítulos</span></button>
              <button class="sebitv-pill-btn danger" id="sebitv-nat-del-ep">${ico('trash', 'sm')}<span>Desinstalar capítulo</span></button>
            </div>
          `;
        } else if (ep.status === 'downloading' || ep.status === 'searching' || ep.status === 'processing') {
          banner.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;">
              ${ico('spinner', 'sm sebitv-spin')}
              <span><strong>Descargando capítulo:</strong> ${Math.round(ep.progress || 0)}% — ${esc(
                ep.status_message || ep.status
              )}.</span>
            </div>
            <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">Ver progreso</button>
          `;
        } else {
          banner.innerHTML = `
            <div><strong>Capítulo bajo demanda:</strong> Descárgalo para activar la reproducción.</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <button class="sebitv-pill-btn" id="sebitv-nat-dl-ep">${ico('download', 'sm')}<span>Descargar Capítulo</span></button>
              <button class="sebitv-pill-btn secondary" id="sebitv-nat-manage">Ver toda la serie</button>
            </div>
          `;
        }

        detailContainer.prepend(banner);

        const dlBtn = banner.querySelector('#sebitv-nat-dl-ep');
        if (dlBtn) {
          dlBtn.onclick = async () => {
            dlBtn.disabled = true;
            dlBtn.innerHTML = `${ico('spinner', 'sm sebitv-spin')}<span>Iniciando descarga...</span>`;
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
            <strong>SebiTV (${esc(cleanRule)}):</strong> Descarga capítulos sueltos, temporadas completas u OVAs.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn" id="sebitv-nat-open-episodes">${ico('download', 'sm')}<span>Gestionar y Descargar Capítulos</span></button>
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
            <strong>SebiTV (${esc(cleanRule)}):</strong> Película disponible en tu servidor.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="sebitv-pill-btn ${item.pinned ? 'pinned' : 'secondary'}" id="sebitv-nat-pin-mov">
              ${ico('pin', 'sm')}<span>${item.pinned ? 'Película Fijada' : 'Fijar Película'}</span>
            </button>
            <button class="sebitv-pill-btn danger" id="sebitv-nat-del-mov">${ico('trash', 'sm')}<span>Desinstalar Película</span></button>
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
     6. Bucle de refresco en vivo y eventos de ciclo de vida del reproductor
     ========================================================================= */
  async function backgroundPoll() {
    syncHudVisibility();
    try {
      await syncBrowserJellyfinToken();
      const { active } = await api('/api/downloads/active');
      const count = active?.length || 0;
      const prevCount = state.activeDownloadsCount;
      state.activeDownloadsCount = count;

      const badge = document.getElementById('sebitv-dl-count');
      if (badge) {
        badge.style.display = count > 0 ? 'inline-flex' : 'none';
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
    syncHudVisibility();
    injectHomeDiscoverRows(false);
    hookNativeJellyfinSearch();
    injectNativeDetailPageControls();
  }

  window.addEventListener('hashchange', () => {
    syncHudVisibility();
    setTimeout(onRouteOrDomChange, 250);
  });

  window.addEventListener('popstate', syncHudVisibility);
  document.addEventListener('fullscreenchange', syncHudVisibility);
  document.addEventListener('webkitfullscreenchange', syncHudVisibility);
  document.addEventListener('play', syncHudVisibility, true);
  document.addEventListener('playing', syncHudVisibility, true);
  document.addEventListener('emptied', () => setTimeout(syncHudVisibility, 80), true);
  document.addEventListener('ended', () => setTimeout(syncHudVisibility, 80), true);

  const observer = new MutationObserver(() => {
    syncHudVisibility();
    if (window.location.hash !== state.lastHash) {
      state.lastHash = window.location.hash;
      setTimeout(onRouteOrDomChange, 280);
    }
    hookNativeJellyfinSearch();
  });

  function boot() {
    mountFloatingBar();
    syncBrowserJellyfinToken();
    setTimeout(onRouteOrDomChange, 800);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    state.pollTimer = setInterval(backgroundPoll, 3500);
    backgroundPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

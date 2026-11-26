import fs from 'node:fs';
import path from 'node:path';
import {
  sanitizeFileName,
  writeTvShowSkeleton,
  writeMovieNfo,
  probeMediaStreams,
  evaluateMediaStreams,
  applyMkvTrackDefaults,
  fetchExternalSpanishSubtitle,
  hardlinkOrCopy,
} from './media.js';
import {
  scoreAndFilterCandidates,
  selectEpisodeFileFromTorrent,
  selectMovieFileFromTorrent,
} from './scorer.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Calcula los índices de la ventana deslizante [idx - behind .. idx + ahead]
 * y cuáles deben pre-descargarse vs borrarse.
 */
export function computeSlidingWindowActions(regularEpisodes, currentEpisodeId, { behind = 1, ahead = 1, isPinnedFn }) {
  const ordered = [...regularEpisodes].sort(
    (a, b) => a.season_number - b.season_number || a.episode_number - b.episode_number
  );
  const idx = ordered.findIndex((e) => e.id === currentEpisodeId);
  if (idx < 0) return { prefetch: [], prune: [], keepIds: new Set() };

  const minKeep = Math.max(0, idx - behind);
  const maxKeep = Math.min(ordered.length - 1, idx + ahead);

  const keepIds = new Set();
  for (let i = minKeep; i <= maxKeep; i++) {
    keepIds.add(ordered[i].id);
  }

  const prefetch = [];
  for (let i = idx + 1; i <= maxKeep; i++) {
    const ep = ordered[i];
    if (ep.status === 'missing') {
      prefetch.push(ep);
    }
  }

  const prune = [];
  for (let i = 0; i < ordered.length; i++) {
    // Borrar los capítulos anteriores a (N - behind), p.ej. cuando vas por el 5 y behind=1, borra 1, 2 y 3
    if (i < minKeep) {
      const ep = ordered[i];
      if (ep.status === 'available' && !isPinnedFn(ep)) {
        prune.push(ep);
      }
    }
  }

  return { prefetch, prune, keepIds };
}

export class SebiEngine {
  constructor({ getConfig, db, catalog, indexers, qbit, jellyfin }) {
    this.getConfig = getConfig;
    this.db = db;
    this.catalog = catalog;
    this.indexers = indexers;
    this.qbit = qbit;
    this.jellyfin = jellyfin;
    this.tickRunning = false;
    this.timer = null;
    this.activeSessionEpisodeIds = new Set();
  }

  start() {
    if (this.timer) return;
    const run = async () => {
      if (this.tickRunning) return;
      this.tickRunning = true;
      try {
        await this.tick();
      } catch (err) {
        console.error('[SebiTV Engine] Error en ciclo periódico:', err.message);
      } finally {
        this.tickRunning = false;
      }
    };
    run();
    this.timer = setInterval(run, this.getConfig().pollIntervalSeconds * 1000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    await this.jellyfin.ensureBootstrap();
    await this.syncActiveDownloads();
    await this.enforceSlidingWindowFromSessions();
    await this.cleanupExpiredMovies();
  }

  #computeFolderPath(details) {
    const cfg = this.getConfig();
    const safeTitle = sanitizeFileName(details.title);
    const folderLabel = details.year ? `${safeTitle} (${details.year})` : safeTitle;
    if (details.mediaType === 'movie') {
      return path.join(cfg.mediaRoot, 'movies', folderLabel);
    }
    return path.join(cfg.mediaRoot, details.isAnime ? 'anime' : 'series', folderLabel);
  }

  /**
   * Registra una película, serie o anime en SebiTV y (si es serie/anime) crea su esqueleto
   * virtual en Jellyfin para que salgan todas las temporadas, capítulos y OVAs SIN botón Play.
   */
  async ensureRegistered(mediaType, tmdbId, { forceRefresh = false } = {}) {
    const existing = this.db.getCatalogItemByTmdb(Number(tmdbId), mediaType);
    if (existing && !forceRefresh) {
      if (!existing.jellyfin_id) {
        const jf = await this.jellyfin.findItemByTmdb(existing.tmdb_id, existing.media_type);
        if (jf?.Id) {
          this.db.updateMovieDownloadState(existing.id, { jellyfinId: jf.Id });
          existing.jellyfin_id = jf.Id;
        }
      }
      return this.getRichCatalogItem(existing.id);
    }

    const details = await this.catalog.getFullDetails(mediaType, Number(tmdbId));
    const folderPath = this.#computeFolderPath(details);

    const savedItem = this.db.upsertCatalogItem({
      ...details,
      folderPath,
    });

    if (details.mediaType === 'tv') {
      for (const s of details.seasons) {
        this.db.upsertSeason({ itemId: savedItem.id, ...s });
      }
      for (const ep of details.episodes) {
        this.db.upsertEpisode({ itemId: savedItem.id, ...ep });
      }

      writeTvShowSkeleton(folderPath, details);
      await this.jellyfin.notifyMediaUpdated(folderPath, 'Created');
      await this.jellyfin.refreshLibraries();

      const jf = await this.jellyfin.findItemByTmdb(details.tmdbId, 'tv');
      if (jf?.Id) {
        this.db.updateMovieDownloadState(savedItem.id, { jellyfinId: jf.Id });
      }
    }

    return this.getRichCatalogItem(savedItem.id);
  }

  async getRichCatalogItem(itemId) {
    const item = this.db.getCatalogItemById(itemId);
    if (!item) return null;

    if (!item.jellyfin_id) {
      const jf = await this.jellyfin.findItemByTmdb(item.tmdb_id, item.media_type);
      if (jf?.Id) {
        this.db.updateMovieDownloadState(item.id, { jellyfinId: jf.Id });
        item.jellyfin_id = jf.Id;
      }
    }

    const seasons = item.media_type === 'tv' ? this.db.getSeasonsByItem(item.id) : [];
    const episodes = item.media_type === 'tv' ? this.db.getEpisodesByItem(item.id) : [];

    return {
      ...item,
      isAnime: Boolean(item.is_anime),
      pinned: Boolean(item.pinned),
      searchTitles: JSON.parse(item.search_titles_json || '[]'),
      languageRule: item.is_anime
        ? '🇯🇵 Audio Japonés + Sub Español (Castellano > Latino)'
        : '🇪🇸 Audio Español Castellano (Sin subtítulos)',
      seasons: seasons.map((s) => ({ ...s, pinned: Boolean(s.pinned) })),
      episodes: episodes.map((e) => ({
        ...e,
        isSpecial: Boolean(e.is_special),
        pinned: this.db.isEpisodeEffectivelyPinned(e),
        ownPinned: Boolean(e.pinned),
        watched: Boolean(e.watched),
      })),
    };
  }

  async searchEpisodeCandidates(item, ep) {
    const cfg = this.getConfig();
    const titles = JSON.parse(item.search_titles_json || '[]');
    if (titles.length === 0) titles.push(item.title);
    const s2 = pad2(ep.season_number);
    const e2 = pad2(ep.episode_number);

    const tasks = [];
    const imdbTaggedResults = [];

    if (item.is_anime) {
      const primary = titles[0];
      const epNumPad = pad2(ep.abs_number || ep.episode_number);
      // 1. Nyaa + ext.to Anime: Erai-raws / MultiSub + Fansub Español
      tasks.push(this.indexers.searchNyaa(`Erai-raws ${primary} ${epNumPad}`));
      tasks.push(this.indexers.searchNyaa(`${primary} ${epNumPad} Multi`));
      tasks.push(this.indexers.searchNyaaNonEnglish(`${primary} ${epNumPad}`));
      tasks.push(this.indexers.searchExt({ query: `${primary} ${epNumPad}`, category: 7 }));
      tasks.push(this.indexers.searchExt({ query: `${primary} S${s2}E${e2}`, category: 7 }));
      // También buscar pack de temporada por si los episodios sueltos antiguos no tienen semillas
      tasks.push(this.indexers.searchNyaa(`${primary} Batch`));
      tasks.push(this.indexers.searchExt({ query: `${primary} Season ${ep.season_number}`, category: 7 }));
      tasks.push(this.indexers.searchProwlarr(`${primary} ${epNumPad}`, [5070]));
    } else {
      const esTitle = item.title;
      const origTitle = item.original_title || esTitle;
      if (item.imdb_id) {
        tasks.push(
          this.indexers
            .searchExt({ query: `S${s2}E${e2} Castellano`, category: 2, imdbId: item.imdb_id })
            .then((r) => {
              imdbTaggedResults.push(...r);
              return [];
            })
        );
        tasks.push(
          this.indexers
            .searchExt({ query: 'Castellano', category: 2, imdbId: item.imdb_id })
            .then((r) => {
              imdbTaggedResults.push(...r);
              return [];
            })
        );
      }
      tasks.push(this.indexers.searchExt({ query: `${esTitle} S${s2}E${e2} Castellano`, category: 2 }));
      tasks.push(this.indexers.searchExt({ query: `${esTitle} ${ep.season_number}x${e2} Castellano`, category: 2 }));
      tasks.push(
        this.indexers.searchExt({
          query: `${esTitle} Cap ${ep.season_number}${e2}`,
          category: 2,
        })
      );
      tasks.push(
        this.indexers.searchExt({
          query: `${esTitle} Temporada ${ep.season_number} Castellano`,
          category: 2,
        })
      );
      if (origTitle !== esTitle) {
        tasks.push(this.indexers.searchExt({ query: `${origTitle} S${s2}E${e2} Castellano`, category: 2 }));
        tasks.push(this.indexers.searchKnaben(`${origTitle} S${s2}E${e2} Castellano`));
      }
      // Respaldo automático sin captcha (Knaben + Apibay + Prowlarr) si ext.to activa Cloudflare
      tasks.push(this.indexers.searchKnaben(`${esTitle} S${s2}E${e2} Castellano`));
      tasks.push(this.indexers.searchKnaben(`${esTitle} ${ep.season_number}x${e2} Castellano`));
      tasks.push(this.indexers.searchKnaben(`${esTitle} S${s2} Castellano`));
      tasks.push(this.indexers.searchApibay(`${esTitle} ${ep.season_number}x${e2} Castellano`));
      tasks.push(this.indexers.searchApibay(`${esTitle} S${s2}E${e2} Castellano`));
      tasks.push(this.indexers.searchProwlarr(`${esTitle} S${s2}E${e2} Castellano`, [5000]));
    }

    const batches = await Promise.all(tasks);
    const allNormal = batches.flat();

    const rejectedHashes = JSON.parse(ep.rejected_hashes_json || '[]');
    const allowExternalSubFallback = Boolean(cfg.subdlApiKey);

    const scoredNormal = scoreAndFilterCandidates(allNormal, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'tv',
      acceptedTitles: titles,
      seasonNumber: ep.season_number,
      episodeNumber: ep.episode_number,
      absNumber: ep.abs_number,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: false,
    });

    const scoredImdb = scoreAndFilterCandidates(imdbTaggedResults, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'tv',
      acceptedTitles: titles,
      seasonNumber: ep.season_number,
      episodeNumber: ep.episode_number,
      absNumber: ep.abs_number,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: true,
    });

    // Deduplicar por infoHash o detailUrl o título
    const seen = new Set();
    const merged = [];
    for (const c of [...scoredImdb, ...scoredNormal].sort((a, b) => b.score - a.score)) {
      const key = c.infoHash || c.extId || c.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    return merged;
  }

  async searchMovieCandidates(item) {
    const cfg = this.getConfig();
    const titles = JSON.parse(item.search_titles_json || '[]');
    if (titles.length === 0) titles.push(item.title);

    const tasks = [];
    const imdbTagged = [];

    if (item.is_anime) {
      const primary = titles[0];
      tasks.push(this.indexers.searchNyaa(`${primary} Multi`));
      tasks.push(this.indexers.searchNyaaNonEnglish(primary));
      tasks.push(this.indexers.searchExt({ query: `${primary} MultiSub`, category: 7 }));
      tasks.push(this.indexers.searchExt({ query: primary, category: 7 }));
      tasks.push(this.indexers.searchProwlarr(primary, [2000, 5070]));
    } else {
      if (item.imdb_id) {
        tasks.push(
          this.indexers
            .searchExt({ query: 'Castellano', category: 1, imdbId: item.imdb_id })
            .then((r) => {
              imdbTagged.push(...r);
              return [];
            })
        );
      }
      tasks.push(
        this.indexers.searchExt({
          query: `${item.title} ${item.year || ''} Castellano`.trim(),
          category: 1,
        })
      );
      tasks.push(this.indexers.searchExt({ query: `${item.title} Castellano`, category: 1 }));
      if (item.original_title && item.original_title !== item.title) {
        tasks.push(this.indexers.searchExt({ query: `${item.original_title} Castellano`, category: 1 }));
        tasks.push(this.indexers.searchKnaben(`${item.original_title} Castellano`));
      }
      tasks.push(this.indexers.searchKnaben(`${item.title} ${item.year || ''} Castellano`.trim()));
      tasks.push(this.indexers.searchKnaben(`${item.title} Castellano`));
      tasks.push(this.indexers.searchApibay(`${item.title} Castellano`));
      tasks.push(this.indexers.searchProwlarr(`${item.title} Castellano`, [2000]));
    }

    const batches = await Promise.all(tasks);
    const allNormal = batches.flat();
    const allowExternalSubFallback = Boolean(cfg.subdlApiKey);

    const scoredNormal = scoreAndFilterCandidates(allNormal, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'movie',
      acceptedTitles: titles,
      year: item.year,
      allowExternalSubFallback,
      matchedByImdb: false,
    });

    const scoredImdb = scoreAndFilterCandidates(imdbTagged, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'movie',
      acceptedTitles: titles,
      year: item.year,
      allowExternalSubFallback,
      matchedByImdb: true,
    });

    const seen = new Set();
    const merged = [];
    for (const c of [...scoredImdb, ...scoredNormal].sort((a, b) => b.score - a.score)) {
      const key = c.infoHash || c.extId || c.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }
    return merged;
  }

  /**
   * Recalcula qué índices de archivo dentro de un torrent pack compartido deben estar activos en qBittorrent
   */
  async #syncPackPriorities(torrentHash) {
    const files = await this.qbit.getTorrentFiles(torrentHash);
    if (files.length <= 1) return;

    const rows = this.db.db
      .prepare(
        `SELECT torrent_file_index FROM episodes
         WHERE torrent_hash = ? AND status IN ('downloading', 'processing')
           AND torrent_file_index IS NOT NULL`
      )
      .all(torrentHash);

    // También conservar activos los ya disponibles que sigan dentro de la ventana para no corromper piezas frontera
    const availRows = this.db.db
      .prepare(
        `SELECT torrent_file_index FROM episodes
         WHERE torrent_hash = ? AND status = 'available'
           AND torrent_file_index IS NOT NULL`
      )
      .all(torrentHash);

    const needed = [
      ...new Set(
        [...rows, ...availRows]
          .map((r) => r.torrent_file_index)
          .filter((idx) => Number.isInteger(idx))
      ),
    ];
    const allIndices = files.map((f) => f.index);
    await this.qbit.selectOnlyNeededFiles(torrentHash, allIndices, needed);
  }

  async requestEpisodeDownload(episodeId, { pin = false, manualCandidate = null } = {}) {
    const ep = this.db.getEpisodeById(Number(episodeId));
    if (!ep) throw new Error('Episodio no encontrado en SebiTV.');
    if (ep.status === 'available' || ep.status === 'downloading' || ep.status === 'processing') {
      if (pin) this.db.updateEpisodeState(ep.id, { pinned: true });
      return this.db.getEpisodeById(ep.id);
    }

    const item = this.db.getCatalogItemById(ep.item_id);
    this.db.updateEpisodeState(ep.id, {
      status: 'searching',
      statusMessage: 'Buscando torrent en idioma requerido...',
      progress: 0,
      ...(pin ? { pinned: true } : {}),
    });

    // 1. ¿Existe ya un Pack de esta misma serie/temporada cargado en otro capítulo que contenga este episodio?
    if (!manualCandidate) {
      const siblingPack = this.db.db
        .prepare(
          `SELECT DISTINCT torrent_hash FROM episodes
           WHERE item_id = ? AND torrent_is_pack = 1 AND torrent_hash IS NOT NULL`
        )
        .all(item.id);

      for (const row of siblingPack) {
        try {
          const files = await this.qbit.getTorrentFiles(row.torrent_hash);
          const matchedFile = selectEpisodeFileFromTorrent(files, {
            seasonNumber: ep.season_number,
            episodeNumber: ep.episode_number,
            absNumber: ep.abs_number,
            isAnime: Boolean(item.is_anime),
          });
          if (matchedFile) {
            this.db.updateEpisodeState(ep.id, {
              status: 'downloading',
              statusMessage: 'Activado desde pack de temporada',
              torrentHash: row.torrent_hash,
              torrentFileIndex: matchedFile.index,
              torrentIsPack: true,
            });
            await this.#syncPackPriorities(row.torrent_hash);
            return this.db.getEpisodeById(ep.id);
          }
        } catch {
          // Si ese pack ya no existe en qBittorrent, buscar normalmente
        }
      }
    }

    const candidates = manualCandidate
      ? [manualCandidate]
      : await this.searchEpisodeCandidates(item, ep);

    if (candidates.length === 0) {
      const msg = item.is_anime
        ? 'No se encontraron torrents con subtítulos en Español (Castellano o Latino).'
        : 'No se encontraron torrents con audio en Español Castellano.';
      this.db.updateEpisodeState(ep.id, { status: 'error', statusMessage: msg });
      return this.db.getEpisodeById(ep.id);
    }

    let lastErr = null;
    for (const cand of candidates.slice(0, 4)) {
      try {
        const resolved = await this.indexers.resolvePlayablePayload(cand);
        if (!resolved.infoHash && !resolved.magnet && !resolved.torrentUrl) {
          continue;
        }

        await this.qbit.addTorrent({
          magnet: resolved.magnet,
          torrentUrl: resolved.torrentUrl,
          savePath: '/data/downloads',
        });

        const hash = resolved.infoHash;
        if (!hash) throw new Error('No se pudo determinar el infoHash del torrent añadido.');

        const files = await this.qbit.waitForFilesMetadata(hash, 45000);
        if (files.length === 0) {
          await this.qbit.deleteTorrent(hash, true);
          throw new Error('Tiempo agotado descargando metadatos del magnet (sin semillas activas).');
        }

        const targetFile = selectEpisodeFileFromTorrent(files, {
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          absNumber: ep.abs_number,
          isAnime: Boolean(item.is_anime),
        });

        if (!targetFile) {
          await this.qbit.deleteTorrent(hash, true);
          throw new Error('El torrent no contiene un archivo de vídeo correspondiente a este capítulo.');
        }

        const isPack = files.filter((f) => /\.(mkv|mp4|avi|webm|m4v|ts)$/i.test(f.name)).length > 1;

        this.db.updateEpisodeState(ep.id, {
          status: 'downloading',
          statusMessage: `Descargando (${cand.source})`,
          torrentHash: hash,
          torrentFileIndex: targetFile.index,
          torrentIsPack: isPack,
          progress: Math.round((targetFile.progress || 0) * 100),
        });

        if (isPack) {
          await this.#syncPackPriorities(hash);
        } else {
          await this.qbit.selectOnlyNeededFiles(
            hash,
            files.map((f) => f.index),
            [targetFile.index]
          );
        }

        return this.db.getEpisodeById(ep.id);
      } catch (err) {
        lastErr = err;
      }
    }

    this.db.updateEpisodeState(ep.id, {
      status: 'error',
      statusMessage: lastErr?.message || 'Error iniciando descarga en qBittorrent.',
    });
    return this.db.getEpisodeById(ep.id);
  }

  async requestSeasonDownload(itemId, seasonNumber) {
    this.db.setPinSeason(Number(itemId), Number(seasonNumber), true);
    const episodes = this.db
      .getEpisodesByItem(Number(itemId))
      .filter((e) => e.season_number === Number(seasonNumber) && e.status === 'missing');

    // Lanzar en segundo plano secuencialmente para que si el Cap 1 abre un Pack de Temporada,
    // los capítulos 2..N reutilicen el mismo pack al instante sin añadir 12 torrents distintos.
    (async () => {
      for (const ep of episodes) {
        try {
          await this.requestEpisodeDownload(ep.id, { pin: true });
        } catch (err) {
          console.error(`[SebiTV] Error en descarga de temporada Ep ${ep.id}:`, err.message);
        }
      }
    })();

    return this.getRichCatalogItem(Number(itemId));
  }

  async requestSeriesDownload(itemId, { includeSpecials = true } = {}) {
    this.db.setPinItem(Number(itemId), true);
    const episodes = this.db
      .getEpisodesByItem(Number(itemId))
      .filter((e) => (includeSpecials || !e.is_special) && e.status === 'missing');

    (async () => {
      for (const ep of episodes) {
        try {
          await this.requestEpisodeDownload(ep.id, { pin: true });
        } catch (err) {
          console.error(`[SebiTV] Error en descarga de serie Ep ${ep.id}:`, err.message);
        }
      }
    })();

    return this.getRichCatalogItem(Number(itemId));
  }

  async requestMovieDownload(tmdbId, { pin = false, manualCandidate = null } = {}) {
    const rich = await this.ensureRegistered('movie', Number(tmdbId));
    const item = this.db.getCatalogItemById(rich.id);
    if (item.status === 'available' || item.status === 'downloading' || item.status === 'processing') {
      if (pin) this.db.updateMovieDownloadState(item.id, { pinned: true });
      return this.getRichCatalogItem(item.id);
    }

    this.db.updateMovieDownloadState(item.id, {
      status: 'searching',
      statusMessage: 'Buscando película en idioma requerido...',
      progress: 0,
      ...(pin ? { pinned: true } : {}),
    });

    const candidates = manualCandidate
      ? [manualCandidate]
      : await this.searchMovieCandidates(item);

    if (candidates.length === 0) {
      const msg = item.is_anime
        ? 'No se encontraron torrents con subtítulos en Español (Castellano o Latino).'
        : 'No se encontraron torrents en Español Castellano.';
      this.db.updateMovieDownloadState(item.id, { status: 'error', statusMessage: msg });
      return this.getRichCatalogItem(item.id);
    }

    let lastErr = null;
    for (const cand of candidates.slice(0, 4)) {
      try {
        const resolved = await this.indexers.resolvePlayablePayload(cand);
        await this.qbit.addTorrent({
          magnet: resolved.magnet,
          torrentUrl: resolved.torrentUrl,
          savePath: '/data/downloads',
        });

        const hash = resolved.infoHash;
        const files = await this.qbit.waitForFilesMetadata(hash, 45000);
        const movieFile = selectMovieFileFromTorrent(files);
        if (!movieFile) {
          await this.qbit.deleteTorrent(hash, true);
          throw new Error('El torrent no contiene un archivo de película válido.');
        }

        await this.qbit.selectOnlyNeededFiles(
          hash,
          files.map((f) => f.index),
          [movieFile.index]
        );

        this.db.updateMovieDownloadState(item.id, {
          status: 'downloading',
          statusMessage: `Descargando (${cand.source})`,
          torrentHash: hash,
          progress: Math.round((movieFile.progress || 0) * 100),
        });
        return this.getRichCatalogItem(item.id);
      } catch (err) {
        lastErr = err;
      }
    }

    this.db.updateMovieDownloadState(item.id, {
      status: 'error',
      statusMessage: lastErr?.message || 'Error iniciando descarga de película.',
    });
    return this.getRichCatalogItem(item.id);
  }

  async syncActiveDownloads() {
    const cfg = this.getConfig();
    const activeEps = this.db.getActiveEpisodeDownloads().filter((e) => e.status === 'downloading' && e.torrent_hash);
    const activeMovies = this.db
      .getActiveMovieDownloads()
      .filter((m) => m.status === 'downloading' && m.torrent_hash);

    if (activeEps.length === 0 && activeMovies.length === 0) return;

    const hashes = [
      ...new Set([...activeEps.map((e) => e.torrent_hash), ...activeMovies.map((m) => m.torrent_hash)]),
    ];
    let torrents = [];
    try {
      torrents = await this.qbit.getTorrents(hashes);
    } catch {
      return;
    }
    const torrentMap = new Map(torrents.map((t) => [t.hash.toLowerCase(), t]));

    // 1. Actualizar episodios en descarga
    for (const ep of activeEps) {
      const tor = torrentMap.get(ep.torrent_hash.toLowerCase());
      if (!tor) continue;

      let files = [];
      try {
        files = await this.qbit.getTorrentFiles(ep.torrent_hash);
      } catch {
        continue;
      }
      const targetFile =
        files.find((f) => f.index === ep.torrent_file_index) || files[0];
      if (!targetFile) continue;

      const pct = Math.min(100, Math.round((targetFile.progress || 0) * 1000) / 10);
      this.db.updateEpisodeState(ep.id, {
        progress: pct,
        downloadSpeed: tor.dlspeed || 0,
        statusMessage: `Descargando ${pct.toFixed(0)}%`,
      });

      if ((targetFile.progress || 0) >= 1) {
        await this.#finalizeEpisodeDownload(ep, targetFile, cfg);
      }
    }

    // 2. Actualizar películas en descarga
    for (const movie of activeMovies) {
      const tor = torrentMap.get(movie.torrent_hash.toLowerCase());
      if (!tor) continue;

      let files = [];
      try {
        files = await this.qbit.getTorrentFiles(movie.torrent_hash);
      } catch {
        continue;
      }
      const movieFile = selectMovieFileFromTorrent(files);
      if (!movieFile) continue;

      const pct = Math.min(100, Math.round((movieFile.progress || 0) * 1000) / 10);
      this.db.updateMovieDownloadState(movie.id, {
        progress: pct,
        downloadSpeed: tor.dlspeed || 0,
        statusMessage: `Descargando ${pct.toFixed(0)}%`,
      });

      if ((movieFile.progress || 0) >= 1) {
        await this.#finalizeMovieDownload(movie, movieFile, cfg);
      }
    }
  }

  async #finalizeEpisodeDownload(ep, targetFile, cfg) {
    const item = this.db.getCatalogItemById(ep.item_id);
    this.db.updateEpisodeState(ep.id, {
      status: 'processing',
      statusMessage: 'Verificando pistas de audio y subtítulos...',
    });

    const srcPath = path.join(cfg.downloadsRoot, targetFile.name);
    if (!fs.existsSync(srcPath)) {
      this.db.updateEpisodeState(ep.id, {
        status: 'error',
        statusMessage: `Archivo descargado no encontrado en ${srcPath}`,
      });
      return;
    }

    let streams = [];
    try {
      streams = await probeMediaStreams(srcPath);
    } catch {
      // Si ffprobe no está en entorno local de test, asumir válido
      streams = [];
    }

    const ext = path.extname(srcPath) || '.mkv';
    const seasonFolder =
      ep.season_number === 0 ? 'Season 00' : `Season ${pad2(ep.season_number)}`;
    const safeShow = sanitizeFileName(item.title);
    const destFileName = `${safeShow} - S${pad2(ep.season_number)}E${pad2(ep.episode_number)}${ext}`;
    const destPath = path.join(item.folder_path, seasonFolder, destFileName);

    let evalResult = { valid: true, totalAudioTracks: 0, totalSubTracks: 0 };
    if (streams.length > 0) {
      evalResult = evaluateMediaStreams(streams, { isAnime: Boolean(item.is_anime) });
      if (!evalResult.valid && evalResult.needsExternalSub && cfg.subdlApiKey) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const extSub = await fetchExternalSpanishSubtitle({
          subdlApiKey: cfg.subdlApiKey,
          imdbId: item.imdb_id,
          tmdbId: item.tmdb_id,
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          destVideoPath: destPath,
        });
        if (extSub) {
          evalResult = { ...evalResult, valid: true, subKind: 'external-es' };
        }
      }

      if (!evalResult.valid) {
        // Rechazar torrent que incumple idioma/subtítulos y probar automáticamente el siguiente candidato
        const rejected = JSON.parse(ep.rejected_hashes_json || '[]');
        if (ep.torrent_hash) rejected.push(ep.torrent_hash.toLowerCase());
        const hashToClean = ep.torrent_hash;

        this.db.updateEpisodeState(ep.id, {
          status: 'missing',
          statusMessage: evalResult.reason,
          torrentHash: null,
          torrentFileIndex: null,
          rejectedHashesJson: JSON.stringify(rejected),
        });

        if (hashToClean && this.db.countOtherEpisodesUsingHash(hashToClean, ep.id) === 0) {
          await this.qbit.deleteTorrent(hashToClean, true).catch(() => {});
        }
        await this.requestEpisodeDownload(ep.id, { pin: Boolean(ep.pinned) });
        return;
      }
    }

    hardlinkOrCopy(srcPath, destPath);
    if (streams.length > 0) {
      await applyMkvTrackDefaults(destPath, evalResult);
    }

    this.db.updateEpisodeState(ep.id, {
      status: 'available',
      statusMessage: 'Disponible en Jellyfin',
      progress: 100,
      downloadSpeed: 0,
      filePath: destPath,
    });

    await this.jellyfin.notifyMediaUpdated(destPath, 'Created');
    if (item.jellyfin_id) {
      await this.jellyfin.refreshItem(item.jellyfin_id);
    } else {
      await this.jellyfin.refreshLibraries();
    }
  }

  async #finalizeMovieDownload(movie, movieFile, cfg) {
    this.db.updateMovieDownloadState(movie.id, {
      status: 'processing',
      statusMessage: 'Verificando audio y subtítulos...',
    });

    const srcPath = path.join(cfg.downloadsRoot, movieFile.name);
    if (!fs.existsSync(srcPath)) {
      this.db.updateMovieDownloadState(movie.id, {
        status: 'error',
        statusMessage: `Archivo no encontrado en ${srcPath}`,
      });
      return;
    }

    let streams = [];
    try {
      streams = await probeMediaStreams(srcPath);
    } catch {
      streams = [];
    }

    const ext = path.extname(srcPath) || '.mkv';
    const safeTitle = sanitizeFileName(movie.title);
    const label = movie.year ? `${safeTitle} (${movie.year})` : safeTitle;
    const destPath = path.join(movie.folder_path, `${label}${ext}`);

    if (streams.length > 0) {
      let evalResult = evaluateMediaStreams(streams, { isAnime: Boolean(movie.is_anime) });
      if (!evalResult.valid && evalResult.needsExternalSub && cfg.subdlApiKey) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const extSub = await fetchExternalSpanishSubtitle({
          subdlApiKey: cfg.subdlApiKey,
          imdbId: movie.imdb_id,
          tmdbId: movie.tmdb_id,
          destVideoPath: destPath,
        });
        if (extSub) evalResult = { ...evalResult, valid: true };
      }

      if (!evalResult.valid) {
        const hashToClean = movie.torrent_hash;
        this.db.updateMovieDownloadState(movie.id, {
          status: 'error',
          statusMessage: evalResult.reason,
          torrentHash: null,
        });
        if (hashToClean) await this.qbit.deleteTorrent(hashToClean, true).catch(() => {});
        return;
      }

      writeMovieNfo(movie.folder_path, {
        tmdbId: movie.tmdb_id,
        imdbId: movie.imdb_id,
        title: movie.title,
        originalTitle: movie.original_title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.poster_url,
      });
      hardlinkOrCopy(srcPath, destPath);
      await applyMkvTrackDefaults(destPath, evalResult);
    } else {
      writeMovieNfo(movie.folder_path, {
        tmdbId: movie.tmdb_id,
        imdbId: movie.imdb_id,
        title: movie.title,
        originalTitle: movie.original_title,
        year: movie.year,
        overview: movie.overview,
        posterUrl: movie.poster_url,
      });
      hardlinkOrCopy(srcPath, destPath);
    }

    this.db.updateMovieDownloadState(movie.id, {
      status: 'available',
      statusMessage: 'Disponible en Jellyfin',
      progress: 100,
      downloadSpeed: 0,
      filePath: destPath,
    });

    await this.jellyfin.notifyMediaUpdated(destPath, 'Created');
    await this.jellyfin.refreshLibraries();
    const jf = await this.jellyfin.findItemByTmdb(movie.tmdb_id, 'movie');
    if (jf?.Id) {
      this.db.updateMovieDownloadState(movie.id, { jellyfinId: jf.Id });
    }
  }

  /**
   * Elimina el archivo físico y libera el espacio real en qBittorrent, manteniendo
   * intacto el capítulo virtual en Jellyfin (sin botón Play y con botón Descargar).
   */
  async deleteEpisodeMedia(episodeId) {
    const cfg = this.getConfig();
    const ep = this.db.getEpisodeById(Number(episodeId));
    if (!ep) return null;
    const item = this.db.getCatalogItemById(ep.item_id);

    const oldFilePath = ep.file_path;
    const oldHash = ep.torrent_hash;
    const oldFileIdx = ep.torrent_file_index;

    if (oldFilePath && fs.existsSync(oldFilePath)) {
      fs.rmSync(oldFilePath, { force: true });
      // Limpiar también subtítulos externos asociados (.es.srt / .ass) si existen
      const dir = path.dirname(oldFilePath);
      const basePrefix = path.basename(oldFilePath, path.extname(oldFilePath));
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(basePrefix)) {
          fs.rmSync(path.join(dir, f), { force: true });
        }
      }
    }

    this.db.updateEpisodeState(ep.id, {
      status: 'missing',
      statusMessage: null,
      progress: 0,
      downloadSpeed: 0,
      torrentHash: ep.torrent_is_pack ? oldHash : null,
      filePath: null,
    });

    if (oldHash) {
      const othersCount = this.db.countOtherEpisodesUsingHash(oldHash, ep.id);
      if (othersCount === 0) {
        // Ningún otro capítulo necesita este torrent -> borrar torrent + datos descargados de qBittorrent
        this.db.db
          .prepare('UPDATE episodes SET torrent_hash = NULL, torrent_file_index = NULL WHERE torrent_hash = ?')
          .run(oldHash);
        await this.qbit.deleteTorrent(oldHash, true).catch(() => {});
      } else if (Number.isInteger(oldFileIdx)) {
        // Pack compartido con otros episodios de la ventana [N-1, N, N+1]: desactivar este archivo y liberar su copia en /downloads
        try {
          const files = await this.qbit.getTorrentFiles(oldHash);
          const fObj = files.find((f) => f.index === oldFileIdx);
          await this.#syncPackPriorities(oldHash);
          if (fObj) {
            const dlFilePath = path.join(cfg.downloadsRoot, fObj.name);
            if (fs.existsSync(dlFilePath)) {
              fs.rmSync(dlFilePath, { force: true });
            }
          }
        } catch {
          // Ignorar si ya no está en qBittorrent
        }
      }
    }

    if (oldFilePath) {
      await this.jellyfin.notifyMediaUpdated(oldFilePath, 'Deleted');
    }
    if (item?.jellyfin_id) {
      await this.jellyfin.refreshItem(item.jellyfin_id);
    }
    return this.db.getEpisodeById(ep.id);
  }

  async deleteMovieMedia(itemId) {
    const movie = this.db.getCatalogItemById(Number(itemId));
    if (!movie) return null;

    if (movie.torrent_hash) {
      await this.qbit.deleteTorrent(movie.torrent_hash, true).catch(() => {});
    }
    if (movie.folder_path && fs.existsSync(movie.folder_path)) {
      fs.rmSync(movie.folder_path, { recursive: true, force: true });
    }

    this.db.updateMovieDownloadState(movie.id, {
      status: 'virtual',
      statusMessage: null,
      progress: 0,
      downloadSpeed: 0,
      torrentHash: null,
      filePath: null,
      jellyfinId: null,
    });

    if (movie.file_path) {
      await this.jellyfin.notifyMediaUpdated(movie.file_path, 'Deleted');
    }
    await this.jellyfin.refreshLibraries();
    return this.getRichCatalogItem(movie.id);
  }

  /**
   * Ventana deslizante automática [N - WINDOW_BEHIND, N, N + WINDOW_AHEAD]:
   * - Mientras ves el Cap N, pre-descarga automáticamente el Cap N+1.
   * - Mantiene el Cap N-1 y el N.
   * - Desinstala automáticamente los capítulos <= N-2 (salvo que estén Fijados 📌).
   */
  async enforceSlidingWindowFromSessions() {
    const cfg = this.getConfig();
    const sessions = await this.jellyfin.getActiveSessions();
    const currentlyPlayingIds = new Set();

    for (const sess of sessions) {
      const now = sess.NowPlayingItem;
      if (!now) continue;

      if (now.Type === 'Movie') {
        const tmdbId = now.ProviderIds?.Tmdb;
        if (tmdbId) {
          const movie = this.db.getCatalogItemByTmdb(Number(tmdbId), 'movie');
          if (movie && !movie.watched_at) {
            this.db.updateMovieDownloadState(movie.id, { watchedAt: new Date().toISOString() });
          }
        }
        continue;
      }

      if (now.Type !== 'Episode') continue;

      let item = null;
      let currentEp = null;

      // 1. Coincidencia exacta por nombre de archivo en disco (inmune a diferencias de temporadas en Anime como Naruto)
      if (now.Path) {
        const playingFileName = now.Path.replace(/\\/g, '/').split('/').pop();
        if (playingFileName) {
          const epByFile = this.db.db
            .prepare('SELECT * FROM episodes WHERE file_path LIKE ? LIMIT 1')
            .get(`%${playingFileName}`);
          if (epByFile) {
            currentEp = epByFile;
            item = this.db.getCatalogItemById(epByFile.item_id);
          }
        }
      }

      // 2. Fallback por carpeta/título y coordenadas SxxExx
      if (!currentEp) {
        const seasonNum = now.ParentIndexNumber;
        const epNum = now.IndexNumber;
        if (seasonNum === undefined || epNum === undefined) continue;

        if (now.Path) {
          const parts = now.Path.replace(/\\/g, '/').split('/');
          const showFolder = parts.length >= 3 ? parts[parts.length - 3] : null;
          if (showFolder) {
            item = this.db.getCatalogItemByFolderName(showFolder);
          }
        }
        if (!item && now.SeriesName) {
          const allShows = this.db.listCatalogItems().filter((i) => i.media_type === 'tv');
          item = allShows.find((i) => i.title.toLowerCase() === now.SeriesName.toLowerCase()) || null;
        }
        if (!item) continue;
        currentEp = this.db.getEpisodeByCoords(item.id, Number(seasonNum), Number(epNum));
      }

      if (!item || !currentEp) continue;
      const seasonNum = currentEp.season_number;
      const epNum = currentEp.episode_number;

      currentlyPlayingIds.add(currentEp.id);
      if (!currentEp.watched) {
        this.db.updateEpisodeState(currentEp.id, { watched: true });
      }

      // Si el usuario está viendo un Especial/OVA (Season 00), no borrar capítulos de temporadas regulares
      if (currentEp.is_special) continue;

      const regularEps = this.db
        .getEpisodesByItem(item.id)
        .filter((e) => !e.is_special);

      const { prefetch, prune } = computeSlidingWindowActions(regularEps, currentEp.id, {
        behind: cfg.windowBehind,
        ahead: cfg.windowAhead,
        isPinnedFn: (e) => this.db.isEpisodeEffectivelyPinned(e),
      });

      for (const nextEp of prefetch) {
        console.log(
          `[SebiTV Ventana] Viendo ${item.title} S${pad2(seasonNum)}E${pad2(epNum)} -> Pre-descargando S${pad2(
            nextEp.season_number
          )}E${pad2(nextEp.episode_number)}`
        );
        await this.requestEpisodeDownload(nextEp.id, { pin: false }).catch((err) =>
          console.error('[SebiTV Ventana] Error pre-descargando siguiente capítulo:', err.message)
        );
      }

      for (const oldEp of prune) {
        if (currentlyPlayingIds.has(oldEp.id)) continue;
        console.log(
          `[SebiTV Ventana] Viendo ${item.title} S${pad2(seasonNum)}E${pad2(epNum)} -> Desinstalando capítulo antiguo S${pad2(
            oldEp.season_number
          )}E${pad2(oldEp.episode_number)}`
        );
        await this.deleteEpisodeMedia(oldEp.id).catch((err) =>
          console.error('[SebiTV Ventana] Error limpiando capítulo antiguo:', err.message)
        );
      }
    }

    this.activeSessionEpisodeIds = currentlyPlayingIds;
  }

  async cleanupExpiredMovies() {
    const cfg = this.getConfig();
    if (!cfg.movieRetentionHours || cfg.movieRetentionHours <= 0) return;

    const movies = this.db
      .listCatalogItems()
      .filter((m) => m.media_type === 'movie' && m.status === 'available' && !m.pinned && m.watched_at);

    const nowMs = Date.now();
    for (const m of movies) {
      const watchedMs = Date.parse(m.watched_at);
      if (Number.isFinite(watchedMs) && nowMs - watchedMs >= cfg.movieRetentionHours * 3600 * 1000) {
        console.log(`[SebiTV Limpieza] Limpiando película ya vista tras ${cfg.movieRetentionHours}h: ${m.title}`);
        await this.deleteMovieMedia(m.id).catch(() => {});
      }
    }
  }
}

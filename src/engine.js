import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
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
  cleanSearchQueryTitle,
} from './scorer.js';
import { getPreferences } from './preferences.js';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function englishOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
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
    this.stalledTracker = new Map();
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
    const needsSchemaUpgrade = existing && Number(existing.catalog_schema_ver || 1) < 3;
    if (existing && !forceRefresh && !needsSchemaUpgrade) {
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
    const folderPath = existing?.folder_path || this.#computeFolderPath(details);

    const savedItem = this.db.upsertCatalogItem({
      ...details,
      folderPath,
    });

    if (details.mediaType === 'tv') {
      const validSNums = new Set(details.seasons.map((s) => s.seasonNumber));
      if (!validSNums.has(0)) {
        this.db.db.prepare('DELETE FROM seasons WHERE item_id = ? AND season_number = 0').run(savedItem.id);
      }
      const validS0Eps = new Set(
        details.episodes.filter((e) => e.seasonNumber === 0).map((e) => e.episodeNumber)
      );
      const oldS0Eps = this.db
        .getEpisodesByItem(savedItem.id)
        .filter((e) => e.season_number === 0 && e.status === 'missing' && !e.pinned);
      for (const oldEp of oldS0Eps) {
        if (!validS0Eps.has(oldEp.episode_number)) {
          this.db.db.prepare('DELETE FROM episodes WHERE id = ?').run(oldEp.id);
        }
      }

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
      relatedMovies: JSON.parse(item.related_movies_json || '[]'),
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

  async searchEpisodeCandidates(item, ep, { allLanguages = false } = {}) {
    const cfg = this.getConfig();
    const preferences = getPreferences(this.db);
    const rawTitles = JSON.parse(item.search_titles_json || '[]');
    const titles = [...new Set([item.title, ...rawTitles].map(cleanSearchQueryTitle).filter(Boolean))];
    const s2 = pad2(ep.season_number);
    const e2 = pad2(ep.episode_number);
    const totalRegularSeasons = this.db
      .getSeasonsByItem(item.id)
      .filter((s) => s.season_number > 0).length;

    const tasks = [];
    const imdbTaggedResults = [];

    // 1. Indexador directo por IMDb ID + capítulo exacto (MejorTorrent, Wolfmax4k, Nyaa, 1337x, Cinecalidad...)
    if (item.imdb_id) {
      tasks.push(
        this.indexers
          .searchTorrentioByImdb({
            imdbId: item.imdb_id,
            mediaType: 'tv',
            seasonNumber: ep.season_number,
            episodeNumber: ep.episode_number,
          })
          .then((r) => {
            imdbTaggedResults.push(...r);
            return [];
          })
      );
    }

    if (item.is_anime) {
      const primary = cleanSearchQueryTitle(rawTitles[0] || item.title);
      const esTitle = cleanSearchQueryTitle(item.title);
      const epNumPad = pad2(ep.abs_number || ep.episode_number);
      const epNum3 = String(ep.abs_number || ep.episode_number).padStart(3, '0');

      if (ep.season_number === 0) {
        // Temporada 0 (OVAs y Especiales): buscar explícitamente OVA / Special / S00Exx
        tasks.push(this.indexers.searchNyaa(`${primary} OVA`));
        tasks.push(this.indexers.searchNyaa(`${primary} Special`));
        tasks.push(this.indexers.searchNyaa(`${primary} S00E${e2}`));
        tasks.push(this.indexers.searchNyaaNonEnglish(`${primary} OVA`));
        tasks.push(this.indexers.searchKnaben(`${primary} OVA`));
        tasks.push(this.indexers.searchExt({ query: `${primary} OVA`, category: 7 }));
      } else {
        tasks.push(this.indexers.searchNyaa(`Erai-raws ${primary} ${epNumPad}`));
        tasks.push(this.indexers.searchNyaa(`${primary} ${epNumPad} Multi`));
        tasks.push(this.indexers.searchNyaa(`${primary} ${epNum3}`));
        tasks.push(this.indexers.searchNyaaNonEnglish(`${primary} ${epNumPad}`));
        if (ep.season_number > 1) {
          const ord = englishOrdinal(ep.season_number);
          tasks.push(this.indexers.searchNyaa(`${primary} ${ord} Season ${e2}`));
          tasks.push(this.indexers.searchNyaa(`${primary} S${s2}E${e2}`));
        }
        tasks.push(this.indexers.searchNyaa(`${primary} Batch`));
        tasks.push(this.indexers.searchKnaben(`${primary} ${epNumPad}`));
        tasks.push(this.indexers.searchKnaben(`${esTitle} Castellano`));
        tasks.push(this.indexers.searchApibay(`${esTitle} Castellano`));
        tasks.push(this.indexers.searchExt({ query: `${primary} ${epNumPad}`, category: 7 }));
        tasks.push(this.indexers.searchExt({ query: `${primary} S${s2}E${e2}`, category: 7 }));
        tasks.push(this.indexers.searchExt({ query: `${esTitle} Castellano`, category: 2 }));
        tasks.push(this.indexers.searchProwlarr(`${primary} ${epNumPad}`, [5070, 5000]));
      }
    } else {
      const esTitle = cleanSearchQueryTitle(item.title);
      const origTitle = cleanSearchQueryTitle(item.original_title || esTitle);
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
      tasks.push(this.indexers.searchExt({ query: `${esTitle} Cap ${ep.season_number}${e2}`, category: 2 }));
      tasks.push(
        this.indexers.searchExt({ query: `${esTitle} Temporada ${ep.season_number} Castellano`, category: 2 })
      );
      if (origTitle !== esTitle) {
        tasks.push(this.indexers.searchExt({ query: `${origTitle} S${s2}E${e2} Castellano`, category: 2 }));
        tasks.push(this.indexers.searchKnaben(`${origTitle} S${s2}E${e2} Castellano`));
        if (allLanguages) {
          tasks.push(this.indexers.searchKnaben(`${origTitle} S${s2}E${e2}`));
        }
      }
      tasks.push(this.indexers.searchKnaben(`${esTitle} S${s2}E${e2} Castellano`));
      tasks.push(this.indexers.searchKnaben(`${esTitle} ${ep.season_number}x${e2} Castellano`));
      tasks.push(this.indexers.searchKnaben(`${esTitle} S${s2} Castellano`));
      tasks.push(this.indexers.searchApibay(`${esTitle} ${ep.season_number}x${e2} Castellano`));
      tasks.push(this.indexers.searchApibay(`${esTitle} S${s2}E${e2} Castellano`));
      tasks.push(this.indexers.searchProwlarr(`${esTitle} S${s2}E${e2} Castellano`, [5000]));
    }

    const batches = await Promise.all(tasks);
    const allNormal = batches.flat();

    const rejectedHashes = allLanguages ? [] : JSON.parse(ep.rejected_hashes_json || '[]');
    const allowExternalSubFallback = Boolean(cfg.subdlApiKey);
    const statsNormal = {
      raw: 0,
      noSeeds: 0,
      rejectedHash: 0,
      titleMismatch: 0,
      episodeOrYearMismatch: 0,
      languageRejected: 0,
      accepted: 0,
    };

    const scoredNormal = scoreAndFilterCandidates(allNormal, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'tv',
      acceptedTitles: titles,
      seasonNumber: ep.season_number,
      episodeNumber: ep.episode_number,
      absNumber: ep.abs_number,
      totalRegularSeasons,
      episodeTitle: ep.title,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: false,
      allLanguages,
      preferences,
      statsOut: statsNormal,
    });

    const scoredImdb = scoreAndFilterCandidates(imdbTaggedResults, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'tv',
      acceptedTitles: titles,
      seasonNumber: ep.season_number,
      episodeNumber: ep.episode_number,
      absNumber: ep.abs_number,
      totalRegularSeasons,
      episodeTitle: ep.title,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: true,
      allLanguages,
      preferences,
      statsOut: statsNormal,
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

    logger.info(
      'SCORER',
      allLanguages ? 'lupa.episode_candidates' : 'episode.candidates',
      `Búsqueda ${allLanguages ? '[LUPA MULTI-IDIOMA]' : '[PERFIL USUARIO]'} para "${item.title}" S${s2}E${e2}: ${
        merged.length
      } válidos de ${allNormal.length + imdbTaggedResults.length} brutos`,
      {
        show: item.title,
        tmdbId: item.tmdb_id,
        imdbId: item.imdb_id,
        isAnime: Boolean(item.is_anime),
        allLanguages,
        season: ep.season_number,
        episode: ep.episode_number,
        searchTitles: titles,
        filterStats: statsNormal,
        topCandidates: merged.slice(0, 5).map((c) => ({
          source: c.source,
          title: c.title,
          seeders: c.seeders,
          languages: c.languageBadges,
          score: c.score,
        })),
      }
    );

    return merged;
  }

  async searchMovieCandidates(item, { allLanguages = false } = {}) {
    const cfg = this.getConfig();
    const preferences = getPreferences(this.db);
    const rawTitles = JSON.parse(item.search_titles_json || '[]');
    const titles = [...new Set([item.title, ...rawTitles].map(cleanSearchQueryTitle).filter(Boolean))];

    const tasks = [];
    const imdbTagged = [];

    if (item.imdb_id) {
      tasks.push(
        this.indexers
          .searchTorrentioByImdb({ imdbId: item.imdb_id, mediaType: 'movie' })
          .then((r) => {
            imdbTagged.push(...r);
            return [];
          })
      );
    }

    if (item.is_anime) {
      const topAnimeTitles = titles.slice(0, 3);
      const esTitle = cleanSearchQueryTitle(item.title);
      for (const t of topAnimeTitles) {
        tasks.push(this.indexers.searchNyaa(t));
        tasks.push(this.indexers.searchNyaaNonEnglish(t));
      }
      tasks.push(this.indexers.searchKnaben(`${esTitle} Castellano`));
      tasks.push(this.indexers.searchExt({ query: `${topAnimeTitles[0]} MultiSub`, category: 7 }));
      tasks.push(this.indexers.searchExt({ query: `${esTitle} Castellano`, category: 1 }));
      tasks.push(this.indexers.searchProwlarr(topAnimeTitles[0], [2000, 5070]));
    } else {
      const esTitle = cleanSearchQueryTitle(item.title);
      const origTitle = cleanSearchQueryTitle(item.original_title || esTitle);
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
      tasks.push(this.indexers.searchExt({ query: `${esTitle} ${item.year || ''} Castellano`.trim(), category: 1 }));
      tasks.push(this.indexers.searchExt({ query: `${esTitle} Castellano`, category: 1 }));
      if (origTitle !== esTitle) {
        tasks.push(this.indexers.searchExt({ query: `${origTitle} Castellano`, category: 1 }));
        tasks.push(this.indexers.searchKnaben(`${origTitle} Castellano`));
        if (allLanguages) tasks.push(this.indexers.searchKnaben(`${origTitle} ${item.year || ''}`.trim()));
      }
      tasks.push(this.indexers.searchKnaben(`${esTitle} ${item.year || ''} Castellano`.trim()));
      tasks.push(this.indexers.searchKnaben(`${esTitle} Castellano`));
      tasks.push(this.indexers.searchApibay(`${esTitle} Castellano`));
      tasks.push(this.indexers.searchProwlarr(`${esTitle} Castellano`, [2000]));
    }

    const batches = await Promise.all(tasks);
    const allNormal = batches.flat();
    const rejectedHashes = allLanguages ? [] : JSON.parse(item.rejected_hashes_json || '[]');
    const allowExternalSubFallback = Boolean(cfg.subdlApiKey);
    const statsMovie = {
      raw: 0,
      noSeeds: 0,
      rejectedHash: 0,
      titleMismatch: 0,
      episodeOrYearMismatch: 0,
      languageRejected: 0,
      accepted: 0,
    };

    const scoredNormal = scoreAndFilterCandidates(allNormal, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'movie',
      acceptedTitles: titles,
      year: item.year,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: false,
      allLanguages,
      preferences,
      statsOut: statsMovie,
    });

    const scoredImdb = scoreAndFilterCandidates(imdbTagged, {
      isAnime: Boolean(item.is_anime),
      mediaType: 'movie',
      acceptedTitles: titles,
      year: item.year,
      rejectedHashes,
      allowExternalSubFallback,
      matchedByImdb: true,
      allLanguages,
      preferences,
      statsOut: statsMovie,
    });

    const seen = new Set();
    const merged = [];
    for (const c of [...scoredImdb, ...scoredNormal].sort((a, b) => b.score - a.score)) {
      const key = c.infoHash || c.extId || c.title;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(c);
    }

    logger.info(
      'SCORER',
      allLanguages ? 'lupa.movie_candidates' : 'movie.candidates',
      `Búsqueda ${allLanguages ? '[LUPA MULTI-IDIOMA]' : '[PERFIL USUARIO]'} para película "${item.title}": ${
        merged.length
      } válidos de ${allNormal.length + imdbTagged.length} brutos`,
      {
        movie: item.title,
        tmdbId: item.tmdb_id,
        imdbId: item.imdb_id,
        year: item.year,
        isAnime: Boolean(item.is_anime),
        allLanguages,
        searchTitles: titles,
        filterStats: statsMovie,
        topCandidates: merged.slice(0, 5).map((c) => ({
          source: c.source,
          title: c.title,
          seeders: c.seeders,
          languages: c.languageBadges,
          score: c.score,
        })),
      }
    );

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
    logger.info(
      'ENGINE',
      'episode.download.start',
      `Solicitud de descarga: "${item.title}" S${pad2(ep.season_number)}E${pad2(ep.episode_number)} (${ep.title})`,
      {
        itemId: item.id,
        tmdbId: item.tmdb_id,
        episodeId: ep.id,
        season: ep.season_number,
        episode: ep.episode_number,
        pin,
        manual: Boolean(manualCandidate),
      }
    );
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
      logger.warn('ENGINE', 'episode.no_candidates', `${item.title} S${pad2(ep.season_number)}E${pad2(ep.episode_number)}: ${msg}`, {
        itemId: item.id,
        tmdbId: item.tmdb_id,
        episodeId: ep.id,
        season: ep.season_number,
        episode: ep.episode_number,
      });
      this.db.updateEpisodeState(ep.id, { status: 'error', statusMessage: msg });
      return this.db.getEpisodeById(ep.id);
    }

    let lastErr = null;
    for (const cand of candidates.slice(0, 8)) {
      try {
        logger.info('QBIT', 'torrent.try_candidate', `Probando candidato "${cand.title}" (${cand.source}, ${cand.seeders} seeds)`, {
          episodeId: ep.id,
          source: cand.source,
          title: cand.title,
          seeders: cand.seeders,
          isPack: cand.isPack,
        });
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

        const files = await this.qbit.waitForFilesMetadata(hash, 14000);
        if (files.length === 0) {
          await this.qbit.deleteTorrent(hash, true);
          throw new Error('Tiempo agotado descargando metadatos del magnet (sin semillas activas).');
        }

        const targetFile = selectEpisodeFileFromTorrent(files, {
          seasonNumber: ep.season_number,
          episodeNumber: ep.episode_number,
          absNumber: ep.abs_number,
          isAnime: Boolean(item.is_anime),
          hintFileIndex: cand.hintFileIndex ?? null,
        });

        if (!targetFile) {
          logger.warn('QBIT', 'torrent.file_mismatch', `El torrent ${hash} no contiene archivo para S${pad2(ep.season_number)}E${pad2(ep.episode_number)}`, {
            episodeId: ep.id,
            hash,
            availableFiles: files.slice(0, 15).map((f) => f.name),
          });
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
          manualOverride: Boolean(manualCandidate),
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

        logger.info('QBIT', 'torrent.downloading', `Descarga iniciada en qBittorrent para "${item.title}" S${pad2(ep.season_number)}E${pad2(ep.episode_number)}`, {
          episodeId: ep.id,
          hash,
          selectedFile: targetFile.name,
          fileIndex: targetFile.index,
          isPack,
          totalFilesInTorrent: files.length,
        });

        return this.db.getEpisodeById(ep.id);
      } catch (err) {
        lastErr = err;
        logger.warn('QBIT', 'torrent.candidate_failed', `Candidato descartado "${cand.title}": ${err.message}`, {
          episodeId: ep.id,
          candidateTitle: cand.title,
          error: err.message,
        });
      }
    }

    const finalMsg = lastErr?.message || 'Error iniciando descarga en qBittorrent.';
    logger.error('ENGINE', 'episode.download.failed', `Fallo definitivo al iniciar descarga de "${item.title}" S${pad2(ep.season_number)}E${pad2(ep.episode_number)}: ${finalMsg}`, {
      itemId: item.id,
      episodeId: ep.id,
      season: ep.season_number,
      episode: ep.episode_number,
    });
    this.db.updateEpisodeState(ep.id, {
      status: 'error',
      statusMessage: finalMsg,
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
    for (const cand of candidates.slice(0, 8)) {
      try {
        logger.info('QBIT', 'movie.try_candidate', `Probando candidato película "${cand.title}" (${cand.source}, ${cand.seeders} seeds)`, {
          itemId: item.id,
          source: cand.source,
          title: cand.title,
          seeders: cand.seeders,
        });
        const resolved = await this.indexers.resolvePlayablePayload(cand);
        await this.qbit.addTorrent({
          magnet: resolved.magnet,
          torrentUrl: resolved.torrentUrl,
          savePath: '/data/downloads',
        });

        const hash = resolved.infoHash;
        const files = await this.qbit.waitForFilesMetadata(hash, 18000);
        if (files.length === 0) {
          await this.qbit.deleteTorrent(hash, true);
          throw new Error('Tiempo agotado descargando metadatos del magnet (sin semillas activas).');
        }
        const movieFile = selectMovieFileFromTorrent(files, cand.hintFileIndex ?? null);
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
          manualOverride: Boolean(manualCandidate),
          progress: Math.round((movieFile.progress || 0) * 100),
        });
        return this.getRichCatalogItem(item.id);
      } catch (err) {
        lastErr = err;
        logger.warn('QBIT', 'movie.candidate_failed', `Candidato película descartado "${cand.title}": ${err.message}`, {
          itemId: item.id,
          candidateTitle: cand.title,
          error: err.message,
        });
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

      const rawProg = targetFile.progress || 0;
      const pct = rawProg >= 1 ? 100 : Math.min(99.9, Math.floor(rawProg * 1000) / 10);
      const displayPct = rawProg >= 1 ? 100 : Math.min(99, Math.floor(rawProg * 100));

      const isSeedingState = ['uploading', 'stalledUP', 'queuedUP', 'pausedUP', 'checkingUP'].includes(tor.state);
      const stallKey = `ep:${ep.id}:${ep.torrent_hash}`;
      const isEffectivelyStalled = !isSeedingState && rawProg < 0.998 && (tor.dlspeed || 0) < 25 * 1024;
      if (isEffectivelyStalled) {
        if (!this.stalledTracker.has(stallKey)) this.stalledTracker.set(stallKey, Date.now());
      } else {
        this.stalledTracker.delete(stallKey);
      }
      const stalledElapsedMs = this.stalledTracker.has(stallKey)
        ? Date.now() - this.stalledTracker.get(stallKey)
        : 0;

      // Caso real en packs españoles (pctnew/wolfmax): pieza frontera de 4 MB compartida con un .txt no semillado (99.89%)
      const readyNearComplete =
        (isSeedingState && rawProg >= 0.998) || (rawProg >= 0.998 && (tor.dlspeed || 0) === 0);

      if (rawProg >= 1 || readyNearComplete) {
        this.stalledTracker.delete(stallKey);
        await this.#finalizeEpisodeDownload(ep, targetFile, cfg);
        continue;
      }

      // Si lleva >= 35s al <1% (<25 KB/s, incluso con 1 KB/s de ruido DHT) o >= 55s arrastrándose <25 KB/s, saltar al siguiente candidato
      const stallThresholdMs = rawProg < 0.01 ? 35000 : 55000;
      if (stalledElapsedMs >= stallThresholdMs && rawProg < 0.998) {
        this.stalledTracker.delete(stallKey);
        logger.warn('QBIT', 'torrent.stalled_switch', `Torrent estancado (${pct}% sin semillas activas). Cambiando al siguiente candidato...`, {
          episodeId: ep.id,
          hash: ep.torrent_hash,
        });
        const rejected = JSON.parse(ep.rejected_hashes_json || '[]');
        rejected.push(ep.torrent_hash.toLowerCase());
        const oldHash = ep.torrent_hash;
        this.db.updateEpisodeState(ep.id, {
          status: 'missing',
          torrentHash: null,
          torrentFileIndex: null,
          rejectedHashesJson: JSON.stringify(rejected),
        });
        if (this.db.countOtherEpisodesUsingHash(oldHash, ep.id) === 0) {
          await this.qbit.deleteTorrent(oldHash, true).catch(() => {});
        }
        await this.requestEpisodeDownload(ep.id, { pin: Boolean(ep.pinned) });
        continue;
      }

      this.db.updateEpisodeState(ep.id, {
        progress: pct,
        downloadSpeed: tor.dlspeed || 0,
        statusMessage: `Descargando ${displayPct}%`,
      });
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

      const rawProg = movieFile.progress || 0;
      const pct = rawProg >= 1 ? 100 : Math.min(99.9, Math.floor(rawProg * 1000) / 10);
      const isSeedingState = ['uploading', 'stalledUP', 'queuedUP', 'pausedUP', 'checkingUP'].includes(tor.state);
      const stallKey = `mov:${movie.id}:${movie.torrent_hash}`;
      const isEffectivelyStalled = !isSeedingState && rawProg < 0.998 && (tor.dlspeed || 0) < 25 * 1024;
      if (isEffectivelyStalled) {
        if (!this.stalledTracker.has(stallKey)) this.stalledTracker.set(stallKey, Date.now());
      } else {
        this.stalledTracker.delete(stallKey);
      }
      const stalledElapsedMs = this.stalledTracker.has(stallKey)
        ? Date.now() - this.stalledTracker.get(stallKey)
        : 0;

      const readyNearComplete =
        (isSeedingState && rawProg >= 0.998) || (rawProg >= 0.998 && (tor.dlspeed || 0) === 0);

      if (rawProg >= 1 || readyNearComplete) {
        this.stalledTracker.delete(stallKey);
        await this.#finalizeMovieDownload(movie, movieFile, cfg);
        continue;
      }

      const stallThresholdMs = rawProg < 0.01 ? 35000 : 55000;
      if (stalledElapsedMs >= stallThresholdMs && rawProg < 0.998) {
        this.stalledTracker.delete(stallKey);
        logger.warn('QBIT', 'movie.stalled_switch', `Película estancada (${pct}% sin semillas activas). Cambiando al siguiente candidato...`, {
          itemId: movie.id,
          hash: movie.torrent_hash,
        });
        const rejected = JSON.parse(movie.rejected_hashes_json || '[]');
        rejected.push(movie.torrent_hash.toLowerCase());
        const oldHash = movie.torrent_hash;
        this.db.updateMovieDownloadState(movie.id, {
          status: 'virtual',
          torrentHash: null,
          rejectedHashesJson: JSON.stringify(rejected),
        });
        await this.qbit.deleteTorrent(oldHash, true).catch(() => {});
        await this.requestMovieDownload(movie.tmdb_id, { pin: Boolean(movie.pinned) });
        continue;
      }

      this.db.updateMovieDownloadState(movie.id, {
        progress: pct,
        downloadSpeed: tor.dlspeed || 0,
        statusMessage: `Descargando ${Math.floor(rawProg * 100)}%`,
      });
    }
  }

  async #finalizeEpisodeDownload(ep, targetFile, cfg) {
    const item = this.db.getCatalogItemById(ep.item_id);
    logger.info(
      'MEDIA',
      'episode.finalize.start',
      `Descarga al 100%, validando audio y subtítulos: "${item.title}" S${pad2(ep.season_number)}E${pad2(
        ep.episode_number
      )}`,
      {
        episodeId: ep.id,
        file: targetFile.name,
      }
    );
    this.db.updateEpisodeState(ep.id, {
      status: 'processing',
      statusMessage: 'Verificando pistas de audio y subtítulos...',
    });

    const srcPath = path.join(cfg.downloadsRoot, targetFile.name);
    if (!fs.existsSync(srcPath)) {
      logger.error('MEDIA', 'episode.file_missing', `Archivo descargado no encontrado en ${srcPath}`, {
        episodeId: ep.id,
        srcPath,
      });
      this.db.updateEpisodeState(ep.id, {
        status: 'error',
        statusMessage: `Archivo descargado no encontrado en ${srcPath}`,
      });
      return;
    }

    let streams = [];
    try {
      streams = await probeMediaStreams(srcPath);
      if (!streams || !streams.some((s) => s.codec_type === 'video')) {
        throw new Error('El contenedor de vídeo no tiene pista de vídeo legible (cabecera incompleta).');
      }
    } catch (probeErr) {
      if (probeErr?.code !== 'ENOENT') {
        logger.warn(
          'MEDIA',
          'episode.corrupt_file',
          `Archivo descargado corrupto o con cabecera MKV incompleta (${probeErr.message}). Descartando torrent parcial y probando siguiente candidato...`,
          {
            episodeId: ep.id,
            rejectedHash: ep.torrent_hash,
            srcPath,
          }
        );
        const rejected = JSON.parse(ep.rejected_hashes_json || '[]');
        if (ep.torrent_hash) rejected.push(ep.torrent_hash.toLowerCase());
        const hashToClean = ep.torrent_hash;
        this.db.updateEpisodeState(ep.id, {
          status: 'missing',
          statusMessage: 'Torrent parcial descartado; probando alternativa...',
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
      streams = [];
    }

    const ext = path.extname(srcPath) || '.mkv';
    const seasonFolder =
      ep.season_number === 0 ? 'Season 00' : `Season ${pad2(ep.season_number)}`;
    const safeShow = sanitizeFileName(item.title);
    const destFileName = `${safeShow} - S${pad2(ep.season_number)}E${pad2(ep.episode_number)}${ext}`;
    const destPath = path.join(item.folder_path, seasonFolder, destFileName);

    const preferences = getPreferences(this.db);
    let evalResult = { valid: true, totalAudioTracks: 0, totalSubTracks: 0 };
    if (streams.length > 0) {
      evalResult = evaluateMediaStreams(streams, {
        isAnime: Boolean(item.is_anime),
        preferences,
        manualOverride: Boolean(ep.manual_override),
      });
      const detectedTracks = streams
        .filter((s) => s.codec_type === 'audio' || s.codec_type === 'subtitle')
        .map((s) => ({
          type: s.codec_type,
          lang: s.tags?.language || '',
          title: s.tags?.title || '',
        }));

      logger.info('MEDIA', 'episode.ffprobe', `Resultado ffprobe para S${pad2(ep.season_number)}E${pad2(ep.episode_number)}: valid=${evalResult.valid}`, {
        episodeId: ep.id,
        evalResult,
        detectedTracks,
      });

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
          logger.info('MEDIA', 'episode.external_sub_ok', `Subtítulo externo español descargado: ${extSub}`, {
            episodeId: ep.id,
          });
        }
      }

      if (!evalResult.valid) {
        // Rechazar torrent que incumple idioma/subtítulos y probar automáticamente el siguiente candidato
        logger.warn('MEDIA', 'episode.stream_rejected', `Torrent descartado tras ffprobe (${evalResult.reason}). Reintentando con siguiente candidato...`, {
          episodeId: ep.id,
          rejectedHash: ep.torrent_hash,
          reason: evalResult.reason,
        });
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

    logger.success('ENGINE', 'episode.available', `Capítulo listo para reproducir: ${destPath}`, {
      episodeId: ep.id,
      destPath,
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
      if (!streams || !streams.some((s) => s.codec_type === 'video')) {
        throw new Error('El contenedor de vídeo no tiene pista de vídeo legible (cabecera incompleta).');
      }
    } catch (probeErr) {
      if (probeErr?.code !== 'ENOENT') {
        logger.warn(
          'MEDIA',
          'movie.corrupt_file',
          `Película descargada corrupta o con cabecera incompleta (${probeErr.message}). Descartando y probando siguiente candidato...`,
          { itemId: movie.id, rejectedHash: movie.torrent_hash, srcPath }
        );
        const rejected = JSON.parse(movie.rejected_hashes_json || '[]');
        if (movie.torrent_hash) rejected.push(movie.torrent_hash.toLowerCase());
        const hashToClean = movie.torrent_hash;
        this.db.updateMovieDownloadState(movie.id, {
          status: 'virtual',
          statusMessage: 'Torrent parcial descartado; probando alternativa...',
          torrentHash: null,
          rejectedHashesJson: JSON.stringify(rejected),
        });
        if (hashToClean) await this.qbit.deleteTorrent(hashToClean, true).catch(() => {});
        await this.requestMovieDownload(movie.tmdb_id, { pin: Boolean(movie.pinned) });
        return;
      }
      streams = [];
    }

    const ext = path.extname(srcPath) || '.mkv';
    const safeTitle = sanitizeFileName(movie.title);
    const label = movie.year ? `${safeTitle} (${movie.year})` : safeTitle;
    const destPath = path.join(movie.folder_path, `${label}${ext}`);

    if (streams.length > 0) {
      const preferences = getPreferences(this.db);
      let evalResult = evaluateMediaStreams(streams, {
        isAnime: Boolean(movie.is_anime),
        preferences,
        manualOverride: Boolean(movie.manual_override),
      });
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
        logger.warn('MEDIA', 'movie.stream_rejected', `Película descartada tras ffprobe (${evalResult.reason}). Reintentando con siguiente candidato...`, {
          itemId: movie.id,
          rejectedHash: movie.torrent_hash,
          reason: evalResult.reason,
        });
        const rejected = JSON.parse(movie.rejected_hashes_json || '[]');
        if (movie.torrent_hash) rejected.push(movie.torrent_hash.toLowerCase());
        const hashToClean = movie.torrent_hash;
        this.db.updateMovieDownloadState(movie.id, {
          status: 'virtual',
          statusMessage: evalResult.reason,
          torrentHash: null,
          rejectedHashesJson: JSON.stringify(rejected),
        });
        if (hashToClean) await this.qbit.deleteTorrent(hashToClean, true).catch(() => {});
        await this.requestMovieDownload(movie.tmdb_id, { pin: Boolean(movie.pinned) });
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

    logger.success('ENGINE', 'movie.available', `Película lista para reproducir: ${destPath}`, {
      itemId: movie.id,
      destPath,
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
        logger.info(
          'WINDOW',
          'window.prefetch',
          `Viendo "${item.title}" S${pad2(seasonNum)}E${pad2(epNum)} -> Pre-descargando S${pad2(
            nextEp.season_number
          )}E${pad2(nextEp.episode_number)}`,
          { itemId: item.id, watchingEpId: currentEp.id, prefetchEpId: nextEp.id }
        );
        await this.requestEpisodeDownload(nextEp.id, { pin: false }).catch((err) =>
          logger.error('WINDOW', 'window.prefetch_error', `Error pre-descargando capítulo: ${err.message}`, {
            prefetchEpId: nextEp.id,
          })
        );
      }

      for (const oldEp of prune) {
        if (currentlyPlayingIds.has(oldEp.id)) continue;
        logger.info(
          'WINDOW',
          'window.prune',
          `Viendo "${item.title}" S${pad2(seasonNum)}E${pad2(epNum)} -> Desinstalando antiguo S${pad2(
            oldEp.season_number
          )}E${pad2(oldEp.episode_number)}`,
          { itemId: item.id, watchingEpId: currentEp.id, prunedEpId: oldEp.id }
        );
        await this.deleteEpisodeMedia(oldEp.id).catch((err) =>
          logger.error('WINDOW', 'window.prune_error', `Error limpiando capítulo antiguo: ${err.message}`, {
            prunedEpId: oldEp.id,
          })
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
        logger.info('WINDOW', 'movie.cleanup', `Limpiando película ya vista tras ${cfg.movieRetentionHours}h: ${m.title}`, {
          itemId: m.id,
        });
        await this.deleteMovieMedia(m.id).catch(() => {});
      }
    }
  }
}

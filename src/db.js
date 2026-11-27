import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class SebiDatabase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS catalog_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tmdb_id INTEGER NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
        is_anime INTEGER NOT NULL DEFAULT 0,
        anilist_id INTEGER,
        imdb_id TEXT,
        tvdb_id INTEGER,
        title TEXT NOT NULL,
        original_title TEXT,
        search_titles_json TEXT NOT NULL DEFAULT '[]',
        related_movies_json TEXT NOT NULL DEFAULT '[]',
        catalog_schema_ver INTEGER NOT NULL DEFAULT 2,
        year INTEGER,
        poster_url TEXT,
        backdrop_url TEXT,
        overview TEXT,
        folder_path TEXT NOT NULL,
        jellyfin_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'virtual',
        status_message TEXT,
        progress REAL NOT NULL DEFAULT 0,
        download_speed INTEGER NOT NULL DEFAULT 0,
        torrent_hash TEXT,
        rejected_hashes_json TEXT NOT NULL DEFAULT '[]',
        file_path TEXT,
        watched_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (tmdb_id, media_type)
      );

      CREATE TABLE IF NOT EXISTS seasons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        overview TEXT,
        poster_url TEXT,
        episode_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        UNIQUE (item_id, season_number)
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
        season_number INTEGER NOT NULL,
        episode_number INTEGER NOT NULL,
        abs_number INTEGER,
        is_special INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        overview TEXT,
        air_date TEXT,
        still_url TEXT,
        status TEXT NOT NULL DEFAULT 'missing',
        status_message TEXT,
        progress REAL NOT NULL DEFAULT 0,
        download_speed INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        torrent_hash TEXT,
        torrent_file_index INTEGER,
        torrent_is_pack INTEGER NOT NULL DEFAULT 0,
        rejected_hashes_json TEXT NOT NULL DEFAULT '[]',
        file_path TEXT,
        jellyfin_episode_id TEXT,
        watched INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (item_id, season_number, episode_number)
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_item_seq ON episodes(item_id, is_special, season_number, episode_number);
      CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
      CREATE INDEX IF NOT EXISTS idx_episodes_hash ON episodes(torrent_hash);

      CREATE TABLE IF NOT EXISTS event_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_logs_level ON event_logs(level, id DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_source ON event_logs(source, id DESC);
    `);

    // Migraciones suaves para bases de datos existentes
    for (const sql of [
      'ALTER TABLE episodes ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE catalog_items ADD COLUMN manual_override INTEGER NOT NULL DEFAULT 0',
      "ALTER TABLE catalog_items ADD COLUMN rejected_hashes_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE catalog_items ADD COLUMN related_movies_json TEXT NOT NULL DEFAULT '[]'",
      'ALTER TABLE catalog_items ADD COLUMN catalog_schema_ver INTEGER NOT NULL DEFAULT 1',
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        // Columna ya existente
      }
    }
  }

  insertEventLog({ ts, level, source, action, message, contextJson }) {
    this.db
      .prepare(
        `INSERT INTO event_logs (ts, level, source, action, message, context_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ts, level, source, action, message, contextJson ?? null);
  }

  queryEventLogs({ limit = 250, level = null, source = null, search = null } = {}) {
    const clauses = [];
    const params = [];
    if (level) {
      clauses.push('level = ?');
      params.push(String(level).toUpperCase());
    }
    if (source) {
      clauses.push('source = ?');
      params.push(String(source).toUpperCase());
    }
    if (search) {
      clauses.push('(message LIKE ? OR action LIKE ? OR context_json LIKE ?)');
      const pat = `%${search}%`;
      params.push(pat, pat, pat);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const safeLimit = Math.min(2000, Math.max(1, Number(limit) || 250));
    params.push(safeLimit);

    const rows = this.db
      .prepare(`SELECT * FROM event_logs ${whereSql} ORDER BY id DESC LIMIT ?`)
      .all(...params);

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      source: r.source,
      action: r.action,
      message: r.message,
      context: r.context_json ? JSON.parse(r.context_json) : null,
    }));
  }

  pruneEventLogs(keepMax = 5000) {
    this.db
      .prepare(
        `DELETE FROM event_logs
         WHERE id <= COALESCE((SELECT MAX(id) - ? FROM event_logs), 0)`
      )
      .run(keepMax);
  }

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : undefined;
  }

  setSetting(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value ?? ''));
  }

  getAllSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  upsertCatalogItem(item) {
    this.db
      .prepare(
        `INSERT INTO catalog_items (
          tmdb_id, media_type, is_anime, anilist_id, imdb_id, tvdb_id,
          title, original_title, search_titles_json, related_movies_json, catalog_schema_ver, year, poster_url, backdrop_url,
          overview, folder_path, jellyfin_id, pinned, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(tmdb_id, media_type) DO UPDATE SET
          is_anime = excluded.is_anime,
          anilist_id = COALESCE(excluded.anilist_id, catalog_items.anilist_id),
          imdb_id = COALESCE(excluded.imdb_id, catalog_items.imdb_id),
          tvdb_id = COALESCE(excluded.tvdb_id, catalog_items.tvdb_id),
          title = excluded.title,
          original_title = excluded.original_title,
          search_titles_json = excluded.search_titles_json,
          related_movies_json = excluded.related_movies_json,
          catalog_schema_ver = 2,
          year = excluded.year,
          poster_url = excluded.poster_url,
          backdrop_url = excluded.backdrop_url,
          overview = excluded.overview,
          folder_path = excluded.folder_path,
          jellyfin_id = COALESCE(excluded.jellyfin_id, catalog_items.jellyfin_id),
          updated_at = datetime('now')`
      )
      .run(
        item.tmdbId,
        item.mediaType,
        item.isAnime ? 1 : 0,
        item.anilistId ?? null,
        item.imdbId ?? null,
        item.tvdbId ?? null,
        item.title,
        item.originalTitle ?? null,
        JSON.stringify(item.searchTitles || []),
        JSON.stringify(item.relatedMovies || []),
        item.year ?? null,
        item.posterUrl ?? null,
        item.backdropUrl ?? null,
        item.overview ?? null,
        item.folderPath,
        item.jellyfinId ?? null,
        item.pinned ? 1 : 0
      );

    return this.getCatalogItemByTmdb(item.tmdbId, item.mediaType);
  }

  getCatalogItemById(id) {
    return this.db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(id);
  }

  getCatalogItemByTmdb(tmdbId, mediaType) {
    return this.db
      .prepare('SELECT * FROM catalog_items WHERE tmdb_id = ? AND media_type = ?')
      .get(tmdbId, mediaType);
  }

  getCatalogItemByFolderName(folderName) {
    return this.db
      .prepare('SELECT * FROM catalog_items WHERE folder_path LIKE ?')
      .get(`%${folderName}`);
  }

  listCatalogItems() {
    return this.db.prepare('SELECT * FROM catalog_items ORDER BY updated_at DESC').all();
  }

  updateMovieDownloadState(itemId, fields) {
    const sets = ["updated_at = datetime('now')"];
    const vals = [];
    const map = {
      status: 'status',
      statusMessage: 'status_message',
      progress: 'progress',
      downloadSpeed: 'download_speed',
      torrentHash: 'torrent_hash',
      filePath: 'file_path',
      jellyfinId: 'jellyfin_id',
      pinned: 'pinned',
      manualOverride: 'manual_override',
      rejectedHashesJson: 'rejected_hashes_json',
      watchedAt: 'watched_at',
    };
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(k === 'pinned' || k === 'manualOverride' ? (fields[k] ? 1 : 0) : fields[k]);
      }
    }
    vals.push(itemId);
    this.db.prepare(`UPDATE catalog_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  upsertSeason(season) {
    this.db
      .prepare(
        `INSERT INTO seasons (item_id, season_number, title, overview, poster_url, episode_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, season_number) DO UPDATE SET
           title = excluded.title,
           overview = excluded.overview,
           poster_url = excluded.poster_url,
           episode_count = excluded.episode_count`
      )
      .run(
        season.itemId,
        season.seasonNumber,
        season.title,
        season.overview ?? null,
        season.posterUrl ?? null,
        season.episodeCount ?? 0
      );
  }

  getSeasonsByItem(itemId) {
    return this.db
      .prepare('SELECT * FROM seasons WHERE item_id = ? ORDER BY CASE WHEN season_number = 0 THEN 9999 ELSE season_number END ASC')
      .all(itemId);
  }

  upsertEpisode(ep) {
    this.db
      .prepare(
        `INSERT INTO episodes (
          item_id, season_number, episode_number, abs_number, is_special,
          title, overview, air_date, still_url, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(item_id, season_number, episode_number) DO UPDATE SET
          abs_number = excluded.abs_number,
          is_special = excluded.is_special,
          title = excluded.title,
          overview = excluded.overview,
          air_date = excluded.air_date,
          still_url = excluded.still_url,
          updated_at = datetime('now')`
      )
      .run(
        ep.itemId,
        ep.seasonNumber,
        ep.episodeNumber,
        ep.absNumber ?? null,
        ep.seasonNumber === 0 ? 1 : 0,
        ep.title,
        ep.overview ?? null,
        ep.airDate ?? null,
        ep.stillUrl ?? null
      );
  }

  getEpisodesByItem(itemId) {
    return this.db
      .prepare('SELECT * FROM episodes WHERE item_id = ? ORDER BY season_number ASC, episode_number ASC')
      .all(itemId);
  }

  getEpisodeById(id) {
    return this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  }

  getEpisodeByCoords(itemId, seasonNumber, episodeNumber) {
    return this.db
      .prepare('SELECT * FROM episodes WHERE item_id = ? AND season_number = ? AND episode_number = ?')
      .get(itemId, seasonNumber, episodeNumber);
  }

  updateEpisodeState(episodeId, fields) {
    const sets = ["updated_at = datetime('now')"];
    const vals = [];
    const map = {
      status: 'status',
      statusMessage: 'status_message',
      progress: 'progress',
      downloadSpeed: 'download_speed',
      pinned: 'pinned',
      torrentHash: 'torrent_hash',
      torrentFileIndex: 'torrent_file_index',
      torrentIsPack: 'torrent_is_pack',
      rejectedHashesJson: 'rejected_hashes_json',
      filePath: 'file_path',
      jellyfinEpisodeId: 'jellyfin_episode_id',
      manualOverride: 'manual_override',
      watched: 'watched',
    };
    for (const [k, col] of Object.entries(map)) {
      if (fields[k] !== undefined) {
        sets.push(`${col} = ?`);
        if (k === 'pinned' || k === 'torrentIsPack' || k === 'watched' || k === 'manualOverride') {
          vals.push(fields[k] ? 1 : 0);
        } else {
          vals.push(fields[k]);
        }
      }
    }
    vals.push(episodeId);
    this.db.prepare(`UPDATE episodes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  setPinItem(itemId, pinned) {
    const val = pinned ? 1 : 0;
    this.db.prepare('UPDATE catalog_items SET pinned = ? WHERE id = ?').run(val, itemId);
    this.db.prepare('UPDATE seasons SET pinned = ? WHERE item_id = ?').run(val, itemId);
    this.db.prepare('UPDATE episodes SET pinned = ? WHERE item_id = ?').run(val, itemId);
  }

  setPinSeason(itemId, seasonNumber, pinned) {
    const val = pinned ? 1 : 0;
    this.db
      .prepare('UPDATE seasons SET pinned = ? WHERE item_id = ? AND season_number = ?')
      .run(val, itemId, seasonNumber);
    this.db
      .prepare('UPDATE episodes SET pinned = ? WHERE item_id = ? AND season_number = ?')
      .run(val, itemId, seasonNumber);
  }

  isEpisodeEffectivelyPinned(episodeRow) {
    if (!episodeRow) return false;
    if (episodeRow.pinned) return true;
    const item = this.getCatalogItemById(episodeRow.item_id);
    if (item?.pinned) return true;
    const season = this.db
      .prepare('SELECT pinned FROM seasons WHERE item_id = ? AND season_number = ?')
      .get(episodeRow.item_id, episodeRow.season_number);
    return Boolean(season?.pinned);
  }

  getActiveEpisodeDownloads() {
    return this.db
      .prepare("SELECT * FROM episodes WHERE status IN ('searching', 'downloading', 'processing')")
      .all();
  }

  getActiveMovieDownloads() {
    return this.db
      .prepare("SELECT * FROM catalog_items WHERE media_type = 'movie' AND status IN ('searching', 'downloading', 'processing')")
      .all();
  }

  countOtherEpisodesUsingHash(torrentHash, excludeEpisodeId) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM episodes
         WHERE torrent_hash = ? AND id != ?
           AND status IN ('downloading', 'processing', 'available')`
      )
      .get(torrentHash, excludeEpisodeId);
    return row?.cnt || 0;
  }

  close() {
    this.db.close();
  }
}

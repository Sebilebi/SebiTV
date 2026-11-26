import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeConfig } from './config.js';
import { SebiDatabase } from './db.js';
import { CatalogService } from './catalog.js';
import { IndexerHub } from './indexers.js';
import { QbitClient } from './qbit.js';
import { JellyfinClient } from './jellyfin.js';
import { SebiEngine } from './engine.js';

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function createSebiApp() {
  const bootCfg = resolveRuntimeConfig(null);
  const db = new SebiDatabase(bootCfg.dbPath);
  const getConfig = () => resolveRuntimeConfig(db);

  const catalog = new CatalogService(getConfig);
  const indexers = new IndexerHub(getConfig);
  const qbit = new QbitClient(getConfig);
  const jellyfin = new JellyfinClient(getConfig, db);
  const engine = new SebiEngine({ getConfig, db, catalog, indexers, qbit, jellyfin });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    try {
      // 0. Servir activos del plugin web en vivo sin caché para que nunca queden desactualizados en Jellyfin
      if (req.method === 'GET' && (pathname === '/ui/sebitv-ui.js' || pathname === '/ui/sebitv-ui.css')) {
        const fileName = pathname.endsWith('.css') ? 'sebitv-ui.css' : 'sebitv-ui.js';
        const contentType = pathname.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'application/javascript; charset=utf-8';
        const filePath = path.join(process.cwd(), 'jellyfin-web', fileName);
        const content = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(content);
        return;
      }

      // 1. Estado del sistema y espacio libre en disco
      if (req.method === 'GET' && pathname === '/api/health') {
        const cfg = getConfig();
        const [jfHealth, qbHealth] = await Promise.all([jellyfin.isHealthy(), qbit.isHealthy()]);
        let disk = null;
        try {
          const st = fs.statfsSync(cfg.mediaRoot);
          const totalBytes = Number(st.bsize) * Number(st.blocks);
          const freeBytes = Number(st.bsize) * Number(st.bavail);
          disk = {
            totalGb: Number((totalBytes / 1024 ** 3).toFixed(1)),
            freeGb: Number((freeBytes / 1024 ** 3).toFixed(1)),
            usedPct: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0,
          };
        } catch {
          disk = null;
        }

        sendJson(res, 200, {
          ok: true,
          tmdbConfigured: catalog.hasTmdbKey(),
          jellyfin: jfHealth,
          qbittorrent: qbHealth,
          extStatus: indexers.lastExtStatus,
          nyaaEnabled: cfg.nyaaEnabled,
          prowlarrConfigured: Boolean(cfg.prowlarrUrl && cfg.prowlarrApiKey),
          windowBehind: cfg.windowBehind,
          windowAhead: cfg.windowAhead,
          disk,
        });
        return;
      }

      // 1b. Sincronización automática del token de sesión desde el navegador Jellyfin (cero configuración manual)
      if (req.method === 'POST' && pathname === '/api/jellyfin-auth') {
        const { accessToken, userId } = await readJsonBody(req);
        const ok = await jellyfin.saveBrowserToken(accessToken, userId);
        if (ok) {
          await jellyfin.refreshLibraries();
        }
        sendJson(res, 200, { ok });
        return;
      }

      // 1c. Resolver ID exacto de reproducción en Jellyfin para un capítulo o película descargada
      if (req.method === 'POST' && pathname === '/api/play-target') {
        const { mediaType, itemId, episodeId } = await readJsonBody(req);
        jellyfin.bootstrapped = false;
        await jellyfin.ensureBootstrap();

        const item = db.getCatalogItemById(Number(itemId));
        if (!item) {
          sendJson(res, 404, { error: 'Elemento no encontrado' });
          return;
        }

        if (mediaType === 'movie') {
          let movJfId = item.jellyfin_id || null;
          if (!movJfId && item.file_path) {
            const byPath = await jellyfin.findPlayableItemByPath(item.file_path, { maxWaitMs: 12000 });
            if (byPath?.Id) {
              movJfId = byPath.Id;
              db.updateMovieDownloadState(item.id, { jellyfinId: movJfId });
            }
          }
          if (!movJfId) {
            const jf = await jellyfin.findItemByTmdb(item.tmdb_id, 'movie');
            if (jf?.Id) {
              movJfId = jf.Id;
              db.updateMovieDownloadState(item.id, { jellyfinId: movJfId });
            }
          }
          sendJson(res, 200, { jellyfinId: movJfId });
          return;
        }

        const ep = db.getEpisodeById(Number(episodeId));
        let epJfId = ep?.jellyfin_episode_id || null;

        // Primero buscar por la ruta exacta del archivo descargado en disco (/data/media/.../S04E220.mkv)
        if (!epJfId && ep?.file_path) {
          const byPath = await jellyfin.findPlayableItemByPath(ep.file_path, { maxWaitMs: 12000 });
          if (byPath?.Id) {
            epJfId = byPath.Id;
            db.updateEpisodeState(ep.id, { jellyfinEpisodeId: epJfId });
          }
        }

        if (!epJfId) {
          if (!item.jellyfin_id) {
            const jf = await jellyfin.findItemByTmdb(item.tmdb_id, 'tv');
            if (jf?.Id) {
              db.updateMovieDownloadState(item.id, { jellyfinId: jf.Id });
              item.jellyfin_id = jf.Id;
            }
          }
          if (item.jellyfin_id && ep) {
            await jellyfin.refreshItem(item.jellyfin_id);
            const jfEps = await jellyfin.getSeriesEpisodesInJellyfin(item.jellyfin_id);
            const match = jfEps.find(
              (e) =>
                Number(e.ParentIndexNumber) === Number(ep.season_number) &&
                Number(e.IndexNumber) === Number(ep.episode_number) &&
                e.LocationType !== 'Virtual'
            );
            if (match?.Id) {
              epJfId = match.Id;
              db.updateEpisodeState(ep.id, { jellyfinEpisodeId: epJfId });
            }
          }
        }

        sendJson(res, 200, {
          jellyfinId: epJfId || null,
          seriesJellyfinId: item.jellyfin_id || null,
        });
        return;
      }

      // 2. Ajustes dinámicos desde la propia interfaz de Jellyfin
      if (req.method === 'GET' && pathname === '/api/settings') {
        const cfg = getConfig();
        sendJson(res, 200, {
          tmdbConfigured: catalog.hasTmdbKey(),
          tmdbApiKeyMasked: cfg.tmdbApiKey ? `${cfg.tmdbApiKey.slice(0, 4)}...${cfg.tmdbApiKey.slice(-4)}` : '',
          extBaseUrl: cfg.extBaseUrl,
          extCookieConfigured: Boolean(cfg.extCookie),
          prowlarrUrl: cfg.prowlarrUrl,
          prowlarrConfigured: Boolean(cfg.prowlarrUrl && cfg.prowlarrApiKey),
          subdlConfigured: Boolean(cfg.subdlApiKey),
          windowBehind: cfg.windowBehind,
          windowAhead: cfg.windowAhead,
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const allowed = [
          'tmdbApiKey',
          'extCookie',
          'extBaseUrl',
          'prowlarrUrl',
          'prowlarrApiKey',
          'subdlApiKey',
          'windowBehind',
          'windowAhead',
        ];
        for (const k of allowed) {
          if (body[k] !== undefined) {
            db.setSetting(k, String(body[k]).trim());
          }
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // 3. Descubrimiento y Búsqueda Global dentro de Jellyfin
      if (req.method === 'GET' && pathname === '/api/discover') {
        const data = await catalog.getDiscoverHome();
        // Cruzar estado si alguno ya está en biblioteca/descargado
        const localMap = new Map(
          db.listCatalogItems().map((it) => [`${it.media_type}:${it.tmdb_id}`, it])
        );
        for (const sec of data.sections || []) {
          sec.items = sec.items.map((card) => {
            const loc = localMap.get(`${card.mediaType}:${card.tmdbId}`);
            return {
              ...card,
              localItemId: loc?.id || null,
              localStatus: loc?.status || null,
              jellyfinId: loc?.jellyfin_id || null,
            };
          });
        }
        sendJson(res, 200, data);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/search') {
        const q = url.searchParams.get('q') || '';
        const items = await catalog.searchCatalog(q);
        const localMap = new Map(
          db.listCatalogItems().map((it) => [`${it.media_type}:${it.tmdb_id}`, it])
        );
        sendJson(res, 200, {
          items: items.map((card) => {
            const loc = localMap.get(`${card.mediaType}:${card.tmdbId}`);
            return {
              ...card,
              localItemId: loc?.id || null,
              localStatus: loc?.status || null,
              jellyfinId: loc?.jellyfin_id || null,
            };
          }),
        });
        return;
      }

      // 4. Ficha completa de Película / Serie / Anime (con estado en tiempo real de cada capítulo)
      const catalogMatch = pathname.match(/^\/api\/catalog\/(movie|tv)\/(\d+)$/);
      if (req.method === 'GET' && catalogMatch) {
        const [, mediaType, tmdbIdStr] = catalogMatch;
        const tmdbId = Number(tmdbIdStr);
        const existing = db.getCatalogItemByTmdb(tmdbId, mediaType);
        if (existing) {
          sendJson(res, 200, { registered: true, item: await engine.getRichCatalogItem(existing.id) });
          return;
        }
        const remote = await catalog.getFullDetails(mediaType, tmdbId);
        sendJson(res, 200, {
          registered: false,
          item: {
            ...remote,
            pinned: false,
            status: 'virtual',
            progress: 0,
            episodes: (remote.episodes || []).map((e) => ({
              ...e,
              status: 'missing',
              progress: 0,
              pinned: false,
            })),
          },
        });
        return;
      }

      // 5. Registrar serie/anime en la biblioteca nativa de Jellyfin (sin vídeo = sin botón Play)
      if (req.method === 'POST' && pathname === '/api/library/register') {
        const { mediaType, tmdbId } = await readJsonBody(req);
        const rich = await engine.ensureRegistered(mediaType, Number(tmdbId));
        sendJson(res, 200, { ok: true, item: rich });
        return;
      }

      // 6. Resolver estado SebiTV a partir de un ID de elemento nativo de Jellyfin (para inyectar botones en páginas nativas)
      if (req.method === 'GET' && pathname === '/api/jellyfin-bridge') {
        const jfId = url.searchParams.get('jellyfinId') || '';
        const jfItem = await jellyfin.getItemDetails(jfId);
        if (!jfItem) {
          sendJson(res, 200, { matched: false });
          return;
        }

        const type = jfItem.Type; // 'Series' | 'Season' | 'Episode' | 'Movie'
        let item = null;

        if (jfItem.ProviderIds?.Tmdb && (type === 'Series' || type === 'Movie')) {
          item = db.getCatalogItemByTmdb(
            Number(jfItem.ProviderIds.Tmdb),
            type === 'Movie' ? 'movie' : 'tv'
          );
        }

        if (!item && jfItem.SeriesId) {
          const seriesJf = await jellyfin.getItemDetails(jfItem.SeriesId);
          if (seriesJf?.ProviderIds?.Tmdb) {
            item = db.getCatalogItemByTmdb(Number(seriesJf.ProviderIds.Tmdb), 'tv');
          }
          if (!item && seriesJf?.Path) {
            const folder = seriesJf.Path.replace(/\\/g, '/').split('/').pop();
            if (folder) item = db.getCatalogItemByFolderName(folder);
          }
        }

        if (!item && jfItem.Path) {
          const parts = jfItem.Path.replace(/\\/g, '/').split('/');
          for (const seg of parts.reverse()) {
            const candidate = db.getCatalogItemByFolderName(seg);
            if (candidate) {
              item = candidate;
              break;
            }
          }
        }

        if (!item) {
          sendJson(res, 200, { matched: false, jellyfinType: type });
          return;
        }

        const rich = await engine.getRichCatalogItem(item.id);
        let jfEpisodes = [];
        if (type === 'Series' || type === 'Season') {
          jfEpisodes = await jellyfin.getSeriesEpisodesInJellyfin(jfItem.SeriesId || jfItem.Id);
        }

        sendJson(res, 200, {
          matched: true,
          jellyfinType: type,
          seasonNumber: type === 'Season' ? jfItem.IndexNumber : jfItem.ParentIndexNumber ?? null,
          episodeNumber: type === 'Episode' ? jfItem.IndexNumber : null,
          isVirtualInJellyfin:
            jfItem.LocationType === 'Virtual' || !(jfItem.MediaSources && jfItem.MediaSources.length > 0),
          item: rich,
          jellyfinEpisodes: jfEpisodes.map((e) => ({
            jellyfinId: e.Id,
            seasonNumber: e.ParentIndexNumber,
            episodeNumber: e.IndexNumber,
            hasFile: e.LocationType !== 'Virtual' && Boolean(e.MediaSources?.length),
          })),
        });
        return;
      }

      // 7. Consultar candidatos manuales opcionales para un capítulo o película
      const epCandMatch = pathname.match(/^\/api\/candidates\/episode\/(\d+)$/);
      if (req.method === 'GET' && epCandMatch) {
        const ep = db.getEpisodeById(Number(epCandMatch[1]));
        if (!ep) {
          sendJson(res, 404, { error: 'Episodio no encontrado' });
          return;
        }
        const item = db.getCatalogItemById(ep.item_id);
        const candidates = await engine.searchEpisodeCandidates(item, ep);
        sendJson(res, 200, { candidates: candidates.slice(0, 20) });
        return;
      }

      const movCandMatch = pathname.match(/^\/api\/candidates\/movie\/(\d+)$/);
      if (req.method === 'GET' && movCandMatch) {
        const rich = await engine.ensureRegistered('movie', Number(movCandMatch[1]));
        const item = db.getCatalogItemById(rich.id);
        const candidates = await engine.searchMovieCandidates(item);
        sendJson(res, 200, { candidates: candidates.slice(0, 20) });
        return;
      }

      // 8. Acciones de Descarga (Capítulo individual, Temporada, Serie completa, OVAs, Película)
      if (req.method === 'POST' && pathname === '/api/download/episode') {
        const body = await readJsonBody(req);
        let episodeId = body.episodeId ? Number(body.episodeId) : null;

        if (!episodeId && body.tmdbId !== undefined) {
          const rich = await engine.ensureRegistered('tv', Number(body.tmdbId));
          const ep = db.getEpisodeByCoords(
            rich.id,
            Number(body.seasonNumber),
            Number(body.episodeNumber)
          );
          episodeId = ep?.id || null;
        }

        if (!episodeId) {
          sendJson(res, 400, { error: 'No se pudo localizar el episodio solicitado.' });
          return;
        }

        const updatedEp = await engine.requestEpisodeDownload(episodeId, {
          pin: Boolean(body.pin),
          manualCandidate: body.candidate || null,
        });
        sendJson(res, 200, { ok: true, episode: updatedEp, item: await engine.getRichCatalogItem(updatedEp.item_id) });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/download/season') {
        const { tmdbId, itemId, seasonNumber } = await readJsonBody(req);
        let targetItemId = itemId ? Number(itemId) : null;
        if (!targetItemId && tmdbId) {
          const rich = await engine.ensureRegistered('tv', Number(tmdbId));
          targetItemId = rich.id;
        }
        const rich = await engine.requestSeasonDownload(targetItemId, Number(seasonNumber));
        sendJson(res, 200, { ok: true, item: rich });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/download/series') {
        const { tmdbId, itemId, includeSpecials = true } = await readJsonBody(req);
        let targetItemId = itemId ? Number(itemId) : null;
        if (!targetItemId && tmdbId) {
          const rich = await engine.ensureRegistered('tv', Number(tmdbId));
          targetItemId = rich.id;
        }
        const rich = await engine.requestSeriesDownload(targetItemId, { includeSpecials });
        sendJson(res, 200, { ok: true, item: rich });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/download/movie') {
        const { tmdbId, pin = false, candidate = null } = await readJsonBody(req);
        const rich = await engine.requestMovieDownload(Number(tmdbId), { pin, manualCandidate: candidate });
        sendJson(res, 200, { ok: true, item: rich });
        return;
      }

      // 9. Fijar / Desfijar (📌 proteger de la limpieza automática de ventana deslizante)
      if (req.method === 'POST' && pathname === '/api/pin') {
        const { targetType, id, seasonNumber, pinned } = await readJsonBody(req);
        if (targetType === 'item') {
          db.setPinItem(Number(id), Boolean(pinned));
          sendJson(res, 200, { ok: true, item: await engine.getRichCatalogItem(Number(id)) });
          return;
        }
        if (targetType === 'season') {
          db.setPinSeason(Number(id), Number(seasonNumber), Boolean(pinned));
          sendJson(res, 200, { ok: true, item: await engine.getRichCatalogItem(Number(id)) });
          return;
        }
        if (targetType === 'episode') {
          db.updateEpisodeState(Number(id), { pinned: Boolean(pinned) });
          const ep = db.getEpisodeById(Number(id));
          sendJson(res, 200, { ok: true, item: await engine.getRichCatalogItem(ep.item_id) });
          return;
        }
      }

      // 10. Desinstalar vídeo manualmente (libera espacio manteniendo ficha en catálogo)
      const delEpMatch = pathname.match(/^\/api\/media\/episode\/(\d+)$/);
      if (req.method === 'DELETE' && delEpMatch) {
        const ep = await engine.deleteEpisodeMedia(Number(delEpMatch[1]));
        sendJson(res, 200, { ok: true, episode: ep, item: ep ? await engine.getRichCatalogItem(ep.item_id) : null });
        return;
      }

      const delMovMatch = pathname.match(/^\/api\/media\/movie\/(\d+)$/);
      if (req.method === 'DELETE' && delMovMatch) {
        const item = await engine.deleteMovieMedia(Number(delMovMatch[1]));
        sendJson(res, 200, { ok: true, item });
        return;
      }

      // 11. Cola activa de descargas en tiempo real
      if (req.method === 'GET' && pathname === '/api/downloads/active') {
        await engine.syncActiveDownloads();
        const eps = db.getActiveEpisodeDownloads().map((e) => {
          const it = db.getCatalogItemById(e.item_id);
          return {
            kind: 'episode',
            id: e.id,
            itemId: e.item_id,
            tmdbId: it?.tmdb_id,
            title: `${it?.title || 'Serie'} — S${String(e.season_number).padStart(2, '0')}E${String(
              e.episode_number
            ).padStart(2, '0')}`,
            subtitle: e.title,
            status: e.status,
            statusMessage: e.status_message,
            progress: e.progress,
            downloadSpeed: e.download_speed,
          };
        });
        const movies = db.getActiveMovieDownloads().map((m) => ({
          kind: 'movie',
          id: m.id,
          itemId: m.id,
          tmdbId: m.tmdb_id,
          title: m.title,
          subtitle: m.year ? String(m.year) : 'Película',
          status: m.status,
          statusMessage: m.status_message,
          progress: m.progress,
          downloadSpeed: m.download_speed,
        }));
        sendJson(res, 200, { active: [...eps, ...movies] });
        return;
      }

      sendJson(res, 404, { error: `Ruta no encontrada: ${pathname}` });
    } catch (err) {
      console.error(`[SebiTV HTTP] Error en ${req.method} ${pathname}:`, err);
      sendJson(res, 500, { error: err.message || 'Error interno en SebiTV' });
    }
  });

  return { server, db, engine, getConfig };
}

// Arranque directo si se invoca `node src/server.js`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('server.js')) {
  const { server, engine, getConfig } = createSebiApp();
  const cfg = getConfig();
  server.listen(cfg.port, '0.0.0.0', () => {
    console.log(`[SebiTV] Motor escuchando en http://0.0.0.0:${cfg.port}`);
    engine.start();
  });
}

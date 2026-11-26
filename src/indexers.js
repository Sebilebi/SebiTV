import { logger } from './logger.js';

function decodeHtmlEntities(str = '') {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&agrave;/gi, 'à')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

export function parseSizeToBytes(sizeStr = '') {
  const m = String(sizeStr).trim().match(/([\d.,]+)\s*(TiB|TB|GiB|GB|MiB|MB|KiB|KB|B)/i);
  if (!m) return 0;
  const val = Number.parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(val)) return 0;
  const unit = m[2].toUpperCase();
  const mult = {
    B: 1,
    KB: 1e3,
    KIB: 1024,
    MB: 1e6,
    MIB: 1024 ** 2,
    GB: 1e9,
    GIB: 1024 ** 3,
    TB: 1e12,
    TIB: 1024 ** 4,
  };
  return Math.round(val * (mult[unit] || 1));
}

export function extractInfoHashFromMagnet(magnet = '') {
  const m = String(magnet).match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/i);
  return m ? m[1].toLowerCase() : null;
}

const DEFAULT_PUBLIC_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://nyaa.tracker.wf:7777/announce',
];

export function buildMagnetFromHash(infoHash, dn = '', extraTrackers = []) {
  const hash = String(infoHash).toLowerCase();
  const allTr = [...new Set([...extraTrackers, ...DEFAULT_PUBLIC_TRACKERS])];
  const trQuery = allTr.map((t) => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(dn)}${trQuery}`;
}

/**
 * Parsea el HTML de búsqueda de escritorio de https://ext.to/browse/
 */
export function parseExtSearchHtml(html = '', baseUrl = 'https://ext.to') {
  const results = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbodyMatch) return results;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tbodyMatch[1])) !== null) {
    const rowHtml = rowMatch[1];

    const titleMatch = rowHtml.match(
      /<a[^>]*class="[^"]*torrent-title-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
    );
    if (!titleMatch) continue;

    const detailPath = decodeHtmlEntities(titleMatch[1]);
    const rawTitle = decodeHtmlEntities(titleMatch[2].replace(/<[^>]+>/g, '').trim());

    const dataIdMatch =
      rowHtml.match(/search-magnet-btn[^>]*data-id="(\d+)"/i) ||
      rowHtml.match(/data-id="(\d+)"[^>]*class="[^"]*search-magnet-btn/i) ||
      detailPath.match(/-(\d+)\/?$/);

    const extId = dataIdMatch ? dataIdMatch[1] : null;

    const cells = [];
    const tdRegex = /<td[^>]*hide-on-mob[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      cells.push(decodeHtmlEntities(tdMatch[1].replace(/<[^>]+>/g, '').trim()));
    }

    const sizeStr = cells[0] || '';
    const filesCount = Number.parseInt(cells[1] || '1', 10) || 1;
    const seeders = Number.parseInt((cells[3] || '0').replace(/\D+/g, ''), 10) || 0;
    const leechers = Number.parseInt((cells[4] || '0').replace(/\D+/g, ''), 10) || 0;

    results.push({
      source: 'ext.to',
      extId,
      detailUrl: detailPath.startsWith('http') ? detailPath : `${baseUrl}${detailPath}`,
      title: rawTitle,
      sizeBytes: parseSizeToBytes(sizeStr),
      sizeStr,
      filesCount,
      seeders,
      leechers,
      magnet: null,
      infoHash: null,
    });
  }

  return results;
}

/**
 * Parsea el feed RSS XML de https://nyaa.si/?page=rss
 */
export function parseNyaaRssXml(xml = '') {
  const results = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const tag = (name) => {
      const tm = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
      return tm ? decodeHtmlEntities(tm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()) : '';
    };

    const title = tag('title');
    const infoHash = tag('nyaa:infoHash').toLowerCase();
    const seeders = Number.parseInt(tag('nyaa:seeders') || '0', 10) || 0;
    const leechers = Number.parseInt(tag('nyaa:leechers') || '0', 10) || 0;
    const sizeStr = tag('nyaa:size');
    const link = tag('link');

    if (!title || !infoHash) continue;

    results.push({
      source: 'nyaa.si',
      extId: null,
      detailUrl: tag('guid') || link,
      title,
      sizeBytes: parseSizeToBytes(sizeStr),
      sizeStr,
      filesCount: 1,
      seeders,
      leechers,
      magnet: buildMagnetFromHash(infoHash, title),
      torrentUrl: link.endsWith('.torrent') ? link : null,
      infoHash,
    });
  }
  return results;
}

const TORRENTIO_PROVIDERS =
  'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,nyaasi,tokyotosho,anidex,mejortorrent,wolfmax4k,cinecalidad';

/**
 * Parsea la respuesta JSON de Torrentio (indexada exactamente por imdb_id y capítulo,
 * incluyendo trackers españoles como MejorTorrent, Wolfmax4k, DonTorrent y Nyaa).
 */
export function parseTorrentioStreams(streams = []) {
  const out = [];
  for (const st of streams) {
    const infoHash = (st.infoHash || '').toLowerCase();
    if (!infoHash) continue;

    const rawDesc = String(st.title || '');
    const rawName = String(st.name || '');
    const combinedText = `${rawName.replace(/\n/g, ' ')} — ${rawDesc.replace(/\n/g, ' | ')}`.trim();

    const seedMatch = rawDesc.match(/👤\s*(\d+)/);
    const sizeMatch = rawDesc.match(/💾\s*([\d.,]+\s*(?:TB|GB|MB|KB|GiB|MiB))/i);
    const trackerMatch = rawDesc.match(/⚙️\s*([^\n|]+)/);

    const seeders = seedMatch ? Number.parseInt(seedMatch[1], 10) : 1;
    const sizeStr = sizeMatch ? sizeMatch[1].trim() : '';
    const tracker = trackerMatch ? trackerMatch[1].trim() : 'dht';

    const extraTrackers = (st.sources || [])
      .filter((s) => s.startsWith('tracker:'))
      .map((s) => s.slice('tracker:'.length));

    out.push({
      source: `imdb:${tracker}`,
      extId: null,
      detailUrl: null,
      title: combinedText,
      sizeBytes: parseSizeToBytes(sizeStr),
      sizeStr,
      filesCount: 1,
      seeders: Math.max(seeders, 1), // Torrentio solo indexa torrents conocidos por infoHash
      leechers: 0,
      magnet: buildMagnetFromHash(infoHash, rawDesc.split('\n')[0] || infoHash, extraTrackers),
      infoHash,
      hintFileIndex: Number.isInteger(st.fileIdx) ? st.fileIdx : null,
      matchedExactImdbEpisode: true,
    });
  }
  return out;
}

export class IndexerHub {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.lastExtStatus = { ok: null, message: 'Sin probar' };
  }

  #extHeaders(extra = {}) {
    const cfg = this.getConfig();
    const headers = {
      'User-Agent': cfg.extUserAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      ...extra,
    };
    if (cfg.extCookie) {
      headers.Cookie = cfg.extCookie;
    }
    return headers;
  }

  async searchExt({ query, category = null, imdbId = null }) {
    const cfg = this.getConfig();
    const url = new URL(`${cfg.extBaseUrl}/browse/`);
    if (query) url.searchParams.set('q', query);
    if (category) url.searchParams.set('cat', String(category));
    if (imdbId) url.searchParams.set('imdb_id', imdbId);
    url.searchParams.set('sort', 'seeders');
    url.searchParams.set('order', 'desc');

    try {
      const res = await fetch(url, {
        headers: this.#extHeaders(),
        signal: AbortSignal.timeout(15000),
      });

      const body = await res.text();
      if (
        res.status === 403 ||
        res.headers.get('cf-mitigated') === 'challenge' ||
        /Just a moment\.\.\.|challenge-platform|cf-turnstile/i.test(body)
      ) {
        this.lastExtStatus = {
          ok: false,
          blockedByChallenge: true,
          message:
            'ext.to solicita verificación Cloudflare en esta IP (usando respaldos automáticos MejorTorrent/Wolfmax/Nyaa/Knaben).',
        };
        logger.warn('INDEXER', 'ext.challenge', `ext.to bloqueado por Cloudflare para "${query || imdbId}"`, {
          status: res.status,
          query,
          category,
          imdbId,
        });
        return [];
      }

      if (!res.ok) {
        this.lastExtStatus = { ok: false, message: `ext.to HTTP ${res.status}` };
        logger.warn('INDEXER', 'ext.http_error', `ext.to devolvió HTTP ${res.status}`, { query, category, imdbId });
        return [];
      }

      const parsed = parseExtSearchHtml(body, cfg.extBaseUrl);
      this.lastExtStatus = { ok: true, message: `Conectado (${parsed.length} resultados en última consulta)` };
      logger.info('INDEXER', 'ext.search', `ext.to devolvió ${parsed.length} resultados`, { query, category, imdbId });
      return parsed;
    } catch (err) {
      this.lastExtStatus = { ok: false, message: `Error conectando a ext.to: ${err.message}` };
      logger.error('INDEXER', 'ext.error', `Fallo consultando ext.to: ${err.message}`, { query, category, imdbId });
      return [];
    }
  }

  async resolveExtMagnet(candidate) {
    if (candidate.magnet) return candidate.magnet;
    if (!candidate.extId) throw new Error('El candidato de ext.to no tiene data-id para resolver magnet.');

    const cfg = this.getConfig();
    const res = await fetch(`${cfg.extBaseUrl}/ajax/getTorrentMagnet.php`, {
      method: 'POST',
      headers: this.#extHeaders({
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: candidate.detailUrl || `${cfg.extBaseUrl}/browse/`,
      }),
      body: new URLSearchParams({ id: String(candidate.extId) }).toString(),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      throw new Error(`No se pudo obtener magnet de ext.to (HTTP ${res.status})`);
    }
    const data = await res.json();
    if (!data?.magnet) {
      throw new Error('ext.to no devolvió un enlace magnet válido (posible sesión expirada).');
    }
    candidate.magnet = data.magnet;
    candidate.infoHash = extractInfoHashFromMagnet(data.magnet);
    return candidate.magnet;
  }

  /**
   * Consulta directa por IMDb ID (y capítulo exacto) en Torrentio multi-tracker
   * incluyendo trackers españoles (MejorTorrent, Wolfmax4k), Latino (Cinecalidad) y Anime (NyaaSi).
   */
  async searchTorrentioByImdb({ imdbId, mediaType, seasonNumber = null, episodeNumber = null }) {
    if (!imdbId || !imdbId.startsWith('tt')) return [];
    const kind = mediaType === 'movie' ? 'movie' : 'series';
    const target =
      kind === 'movie' ? imdbId : `${imdbId}:${Number(seasonNumber)}:${Number(episodeNumber)}`;
    const url = `https://torrentio.strem.fun/${TORRENTIO_PROVIDERS}/stream/${kind}/${encodeURIComponent(target)}.json`;

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.getConfig().extUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const parsed = parseTorrentioStreams(data?.streams || []);
      logger.info('INDEXER', 'imdb_streams.search', `Indexador IMDb (${target}) devolvió ${parsed.length} streams`, {
        target,
        count: parsed.length,
      });
      return parsed;
    } catch (err) {
      logger.warn('INDEXER', 'imdb_streams.error', `Fallo en indexador IMDb (${target}): ${err.message}`, { target });
      return [];
    }
  }

  async searchNyaa(query, subCategory = '1_2') {
    const cfg = this.getConfig();
    if (!cfg.nyaaEnabled) return [];
    const url = new URL(`${cfg.nyaaBaseUrl}/`);
    url.searchParams.set('page', 'rss');
    url.searchParams.set('c', subCategory);
    url.searchParams.set('f', '0');
    url.searchParams.set('s', 'seeders');
    url.searchParams.set('o', 'desc');
    url.searchParams.set('q', query);

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': cfg.extUserAgent },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return [];
      const parsed = parseNyaaRssXml(await res.text());
      logger.info('INDEXER', 'nyaa.search', `nyaa.si (${subCategory}) devolvió ${parsed.length} resultados`, { query });
      return parsed;
    } catch (err) {
      logger.warn('INDEXER', 'nyaa.error', `Fallo en nyaa.si (${subCategory}): ${err.message}`, { query });
      return [];
    }
  }

  async searchNyaaNonEnglish(query) {
    return this.searchNyaa(query, '1_3');
  }

  async searchProwlarr(query, categories = []) {
    const cfg = this.getConfig();
    if (!cfg.prowlarrUrl || !cfg.prowlarrApiKey) return [];
    const url = new URL(`${cfg.prowlarrUrl}/api/v1/search`);
    url.searchParams.set('query', query);
    url.searchParams.set('type', 'search');
    for (const c of categories) url.searchParams.append('categories', String(c));

    try {
      const res = await fetch(url, {
        headers: { 'X-Api-Key': cfg.prowlarrApiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) return [];
      const items = await res.json();
      return (items || [])
        .map((it) => {
          const magnet = it.magnetUrl || (it.downloadUrl?.startsWith('magnet:') ? it.downloadUrl : null);
          const torrentUrl = !magnet && it.downloadUrl ? it.downloadUrl : null;
          if (!magnet && !torrentUrl) return null;
          return {
            source: `prowlarr:${it.indexer || 'tracker'}`,
            extId: null,
            detailUrl: it.infoUrl || null,
            title: it.title || '',
            sizeBytes: it.size || 0,
            sizeStr: it.size ? `${(it.size / 1024 ** 3).toFixed(2)} GB` : '',
            filesCount: it.files || 1,
            seeders: it.seeders || 0,
            leechers: it.leechers || 0,
            magnet,
            torrentUrl,
            infoHash: (it.infoHash || extractInfoHashFromMagnet(magnet || '') || '').toLowerCase() || null,
          };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  async searchKnaben(query) {
    try {
      const res = await fetch('https://api.knaben.org/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query,
          order_by: 'seeders',
          size: 35,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return [];
      const data = await res.json();
      const hits = data?.hits || [];
      const out = hits
        .map((h) => {
          const hash = (h.hash || extractInfoHashFromMagnet(h.magnetUrl || '') || '').toLowerCase();
          const title = decodeHtmlEntities(h.title || '');
          if (!title || (!hash && !h.magnetUrl)) return null;
          const magnet = h.magnetUrl || buildMagnetFromHash(hash, title);
          const bytes = Number(h.bytes || 0);
          return {
            source: `knaben:${h.trackerId || 'dht'}`,
            extId: null,
            detailUrl: h.details || null,
            title,
            sizeBytes: bytes,
            sizeStr: bytes ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : '',
            filesCount: 1,
            seeders: Number(h.liveSeeders ?? h.seeders ?? 0),
            leechers: Number(h.livePeers ?? h.peers ?? 0),
            magnet,
            infoHash: hash || extractInfoHashFromMagnet(magnet),
          };
        })
        .filter(Boolean);
      logger.info('INDEXER', 'knaben.search', `Knaben devolvió ${out.length} resultados`, { query });
      return out;
    } catch (err) {
      logger.warn('INDEXER', 'knaben.error', `Fallo consultando Knaben: ${err.message}`, { query });
      return [];
    }
  }

  async searchApibay(query) {
    try {
      const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': this.getConfig().extUserAgent },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const items = await res.json();
      if (!Array.isArray(items)) return [];

      const out = items
        .filter((it) => it && it.info_hash && it.info_hash !== '0000000000000000000000000000000000000000')
        .map((it) => {
          const hash = String(it.info_hash).toLowerCase();
          const sizeBytes = Number.parseInt(it.size || '0', 10) || 0;
          return {
            source: 'apibay',
            extId: null,
            detailUrl: null,
            title: it.name || '',
            sizeBytes,
            sizeStr: sizeBytes ? `${(sizeBytes / 1024 ** 3).toFixed(2)} GB` : '',
            filesCount: Number.parseInt(it.num_files || '1', 10) || 1,
            seeders: Number.parseInt(it.seeders || '0', 10) || 0,
            leechers: Number.parseInt(it.leechers || '0', 10) || 0,
            magnet: buildMagnetFromHash(hash, it.name || ''),
            infoHash: hash,
          };
        });
      logger.info('INDEXER', 'apibay.search', `Apibay devolvió ${out.length} resultados`, { query });
      return out;
    } catch (err) {
      logger.warn('INDEXER', 'apibay.error', `Fallo consultando Apibay: ${err.message}`, { query });
      return [];
    }
  }

  async resolvePlayablePayload(candidate) {
    if (candidate.magnet) {
      return {
        magnet: candidate.magnet,
        infoHash: candidate.infoHash || extractInfoHashFromMagnet(candidate.magnet),
      };
    }
    if (candidate.source === 'ext.to' && candidate.extId) {
      const magnet = await this.resolveExtMagnet(candidate);
      return { magnet, infoHash: extractInfoHashFromMagnet(magnet) };
    }
    if (candidate.torrentUrl) {
      return { torrentUrl: candidate.torrentUrl, infoHash: candidate.infoHash };
    }
    throw new Error('No se pudo resolver magnet ni archivo .torrent del candidato seleccionado.');
  }
}

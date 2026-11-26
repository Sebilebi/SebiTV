const VIDEO_EXT_RE = /\.(mkv|mp4|avi|webm|m4v|ts)$/i;

const CAM_RE = /\b(hdcam|camrip|cam|ts-screener|hdts|telesync|telecine|workprint)\b/i;
const CASTELLANO_POS_RE =
  /\b(castellano|espa[ñn]ol(?:\s+de\s+espa[ñn]a)?|spanish|esp|es-es|spa\b|cast\b|dual[\s._-]*(?:esp|cast|spa)|multi[\s._-]*(?:esp|cast))\b/i;
const LATINO_ONLY_RE = /\b(latino|latam|es-la|es-419|audio[\s._-]*latino)\b/i;
const VOSE_ONLY_RE = /\b(vose|v\.o\.s\.e\.?|subtitulad[oa]|sub[\s._-]*esp)\b/i;

const ANIME_MULTISUB_RE =
  /\b(erai-raws|toonshub|nandesuka|multisub|multi-subs|multi[\s._-]*sub|multiple[\s._-]*subtitle|castellano|espa[ñn]ol|spanish|sub[\s._-]*esp)\b/i;
const ANIME_ENG_DUB_ONLY_RE = /\b(eng(?:lish)?[\s._-]*dub(?:[\s._-]*only)?|dubbed[\s._-]*only)\b/i;
const ANIME_RAW_RE = /\b(\[raw\]|raw-raws|\braw\b)\b/i;

function normalizeText(s = '') {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function matchesTitle(releaseTitle, acceptedTitles = []) {
  const normRelease = normalizeText(releaseTitle);
  for (const t of acceptedTitles) {
    const normTarget = normalizeText(t);
    if (!normTarget) continue;
    const words = normTarget.split(' ').filter((w) => w.length >= 2);
    if (words.length === 0) continue;
    if (normRelease.includes(normTarget)) return true;
    const matchedWords = words.filter((w) => normRelease.includes(w));
    if (words.length >= 2 && matchedWords.length >= Math.ceil(words.length * 0.75)) {
      return true;
    }
  }
  return false;
}

export function classifyEpisodeMatch(releaseTitle, { seasonNumber, episodeNumber, absNumber, isAnime }) {
  const s2 = pad2(seasonNumber);
  const e2 = pad2(episodeNumber);
  const e3 = String(episodeNumber).padStart(3, '0');

  // 1. Coincidencia exacta S01E05 o 1x05 o Cap.105 (típico DonTorrent Castellano: "Cap.105" = Temp 1 Ep 05)
  const exactPatterns = [
    new RegExp(`\\bs0*${seasonNumber}[\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`\\b0*${seasonNumber}x0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`\\btemporada\\s*0*${seasonNumber}[^\\d]+(?:cap(?:itulo)?|ep(?:isodio)?)\\s*0*${episodeNumber}(?!\\d)`, 'i'),
  ];
  if (seasonNumber > 0 && episodeNumber < 100) {
    // Formato español clásico "Cap.105" o "Cap 105" para Temporada 1 Cap 5
    exactPatterns.push(new RegExp(`\\bcap(?:itulo)?[\\s._-]*0*${seasonNumber}${e2}(?!\\d)`, 'i'));
  }

  for (const re of exactPatterns) {
    if (re.test(releaseTitle)) return { matched: true, isPack: false };
  }

  // 2. Formato Anime numeración directa "- 05 " / "[05]" / "E05"
  if (isAnime) {
    const candidates = new Set([episodeNumber]);
    if (absNumber) candidates.add(absNumber);

    // Si el release menciona explícitamente otra temporada distinta (ej. S02 / 2nd Season), no confundir "- 05" con S01E05
    const wrongSeasonMention =
      seasonNumber === 1 && /\b(s0*[2-9]|season\s*[2-9]|[2-9](?:nd|rd|th)\s+season|part\s*2)\b/i.test(releaseTitle);

    if (!wrongSeasonMention) {
      for (const num of candidates) {
        const n2 = pad2(num);
        const animeEpRe = new RegExp(
          `(?:\\s-\\s*|\\[|\\bep(?:isode)?[\\s._-]*)0*(?:${num}|${n2}|${e3})(?:v\\d)?(?:\\s|\\]|\\[|\\(|\\.)`,
          'i'
        );
        if (animeEpRe.test(releaseTitle)) {
          return { matched: true, isPack: false };
        }
      }
    }
  }

  // 3. ¿Es un Pack de Temporada o Serie Completa?
  const seasonPackPatterns = [
    new RegExp(`\\b(s${s2}|season\\s*0*${seasonNumber}|temporada\\s*0*${seasonNumber})\\b`, 'i'),
    /\b(complete|completa|batch|integrale|full\s*season)\b/i,
  ];
  const hasOtherEpisodeTag = /\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b/i.test(releaseTitle);
  const hasEpisodeRange = /\bs\d{1,2}e\d{1,2}\s*-\s*e?\d{1,3}\b|\b0*1\s*-\s*\d{2,3}\b/i.test(releaseTitle);

  if ((!hasOtherEpisodeTag || hasEpisodeRange) && seasonPackPatterns.some((re) => re.test(releaseTitle))) {
    // Verificar que no sea un pack de otra temporada concreta distinta
    const explicitSeason = releaseTitle.match(/\b(?:s0*(\d{1,2})|season\s*0*(\d{1,2})|temporada\s*0*(\d{1,2}))\b/i);
    const foundSeason = explicitSeason ? Number(explicitSeason[1] || explicitSeason[2] || explicitSeason[3]) : null;
    if (foundSeason === null || foundSeason === seasonNumber) {
      return { matched: true, isPack: true };
    }
  }

  return { matched: false, isPack: false };
}

function resolutionScore(title = '') {
  if (/\b(1080p|1920x1080|fhd)\b/i.test(title)) return 120;
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return 85; // 1080p priorizado frente a 4K para cuidar los 120 GB de disco
  if (/\b(720p|1280x720|hdrip|microhd|bdrip|bluray|web-dl|webrip)\b/i.test(title)) return 75;
  return 20;
}

/**
 * Puntúa y filtra candidatos según las reglas estrictas del usuario:
 * - Anime: Audio Japonés (o Dual) + Subtítulos Español (Castellano > Latino).
 * - No-Anime (Series y Películas): Audio Español Castellano obligatorio, sin VOSE ni Latino puro.
 */
export function scoreAndFilterCandidates(candidates, context) {
  const {
    isAnime,
    mediaType, // 'movie' | 'tv'
    acceptedTitles = [],
    year = null,
    seasonNumber = 1,
    episodeNumber = 1,
    absNumber = null,
    rejectedHashes = [],
    allowExternalSubFallback = false,
    matchedByImdb = false,
    statsOut = null,
  } = context;

  const stats = statsOut || {
    raw: 0,
    noSeeds: 0,
    rejectedHash: 0,
    titleMismatch: 0,
    episodeOrYearMismatch: 0,
    languageRejected: 0,
    accepted: 0,
  };

  const rejectedSet = new Set((rejectedHashes || []).map((h) => String(h).toLowerCase()));
  const scored = [];

  for (const cand of candidates) {
    stats.raw++;
    const title = cand.title || '';
    if (!title) continue;
    if ((cand.seeders || 0) <= 0) {
      stats.noSeeds++;
      continue;
    }
    if (cand.infoHash && rejectedSet.has(cand.infoHash.toLowerCase())) {
      stats.rejectedHash++;
      continue;
    }

    // Si no vino filtrado por IMDb exacto, validamos coincidencia de título
    if (!matchedByImdb && acceptedTitles.length > 0 && !matchesTitle(title, acceptedTitles)) {
      stats.titleMismatch++;
      continue;
    }

    let isPack = false;
    if (mediaType === 'tv') {
      const epCheck = classifyEpisodeMatch(title, { seasonNumber, episodeNumber, absNumber, isAnime });
      if (!epCheck.matched) {
        stats.episodeOrYearMismatch++;
        continue;
      }
      isPack = epCheck.isPack;
    } else if (year) {
      // En películas, si el torrent indica un año explícito muy distinto al de la película, descartar
      const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch && Math.abs(Number(yearMatch[1]) - year) > 1) {
        stats.episodeOrYearMismatch++;
        continue;
      }
    }

    let score = 0;

    if (isAnime) {
      if (ANIME_ENG_DUB_ONLY_RE.test(title)) {
        stats.languageRejected++;
        continue;
      }
      if (ANIME_RAW_RE.test(title) && !allowExternalSubFallback) {
        stats.languageRejected++;
        continue;
      }

      const hasMultiOrSpanishSub = ANIME_MULTISUB_RE.test(title);
      if (hasMultiOrSpanishSub) {
        score += 500;
        if (/\b(castellano|es-es)\b/i.test(title)) score += 80;
        if (/\b(erai-raws|toonshub)\b/i.test(title)) score += 90;
      } else if (allowExternalSubFallback) {
        // SubsPlease u otros en japonés con sub inglés solo si hay proveedor externo de subtítulos activo
        score += 80;
      } else {
        stats.languageRejected++;
        continue;
      }
    } else {
      // SERIES COMERCIALES Y PELÍCULAS NO-ANIME -> Audio Castellano obligatorio
      const hasCastellano = CASTELLANO_POS_RE.test(title) || /\bdontorrent\b/i.test(title);
      const hasLatino = LATINO_ONLY_RE.test(title) && !/\bcastellano\b/i.test(title);
      const isVoseOnly = VOSE_ONLY_RE.test(title) && !/\b(dual|castellano)\b/i.test(title);

      if (!hasCastellano || hasLatino || isVoseOnly) {
        stats.languageRejected++;
        continue;
      }

      score += 400;
      if (/\bcastellano\b/i.test(title)) score += 100; // Preferir explícitamente "Castellano" frente a "Spanish" ambiguo
    }

    if (CAM_RE.test(title)) score -= 350;

    score += resolutionScore(title);
    score += Math.round(Math.log2((cand.seeders || 1) + 1) * 28);

    // Preferir episodio individual frente a pack si ambos tienen buenas semillas;
    // pero si el pack tiene muchas semillas, sigue entrando limpio con descarga selectiva
    if (isPack) score -= 35;

    // Penalizar tamaños desproporcionados (>25 GB para una peli o >8 GB para un capítulo suelto) en disco de 120 GB
    if (!isPack && mediaType === 'tv' && cand.sizeBytes > 8 * 1024 ** 3) score -= 120;
    if (mediaType === 'movie' && cand.sizeBytes > 25 * 1024 ** 3) score -= 120;

    scored.push({
      ...cand,
      isPack,
      score,
    });
  }

  stats.accepted = scored.length;
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Selecciona el archivo exacto de vídeo dentro de un torrent (especialmente Packs de Temporada)
 */
export function selectEpisodeFileFromTorrent(files = [], { seasonNumber, episodeNumber, absNumber, isAnime }) {
  const videoFiles = files.filter(
    (f) => VIDEO_EXT_RE.test(f.name) && !/\b(sample|trailer|ncop|nced|creditless|pv)\b/i.test(f.name)
  );
  if (videoFiles.length === 0) return null;
  if (videoFiles.length === 1) return videoFiles[0];

  const s2 = pad2(seasonNumber);
  const e2 = pad2(episodeNumber);
  const e3 = String(episodeNumber).padStart(3, '0');

  const patterns = [
    new RegExp(`s0*${seasonNumber}[\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`0*${seasonNumber}x0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`cap(?:itulo)?[\\s._-]*0*${seasonNumber}${e2}(?!\\d)`, 'i'),
  ];

  for (const re of patterns) {
    const found = videoFiles.find((f) => re.test(f.name));
    if (found) return found;
  }

  // En packs de una sola temporada o Anime: buscar "- 05", "[05]", "E05", " 05."
  const nums = [episodeNumber];
  if (isAnime && absNumber && absNumber !== episodeNumber) nums.push(absNumber);

  for (const num of nums) {
    const n2 = pad2(num);
    const looseRe = new RegExp(
      `(?:^|[\\s._\\[-])(?:ep?[\\s._-]*)?0*(?:${num}|${n2}|${e3})(?:v\\d)?(?=[\\s._\\]\\(-]|\\.[a-z0-9]{2,4}$)`,
      'i'
    );
    const candidates = videoFiles.filter((f) => {
      const base = f.name.split('/').pop() || f.name;
      return looseRe.test(base);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Si hay varias carpetas (ej. Season 1 / Season 2), filtrar por temporada
      const inSeasonFolder = candidates.find((f) =>
        new RegExp(`(?:season|temporada|s)[\\s._-]*0*${seasonNumber}(?!\\d)`, 'i').test(f.name)
      );
      if (inSeasonFolder) return inSeasonFolder;
      return candidates.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    }
  }

  return null;
}

export function selectMovieFileFromTorrent(files = []) {
  const videoFiles = files.filter(
    (f) => VIDEO_EXT_RE.test(f.name) && !/\b(sample|trailer|extras?)\b/i.test(f.name)
  );
  if (videoFiles.length === 0) return null;
  return [...videoFiles].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

import { DEFAULT_PREFERENCES, inspectReleaseLanguages } from './preferences.js';

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|webm|m4v|ts)$/i;
const CAM_RE = /\b(hdcam|camrip|cam|ts-screener|hdts|telesync|telecine|workprint)\b/i;
const ANIME_RAW_RE = /\b(\[raw\]|raw-raws|\braw\b)\b/i;

// Sagas/secuelas que NO deben confundirse entre sí (ej. Dragon Ball Z != Dragon Ball DAIMA / Super / GT / Kai)
const SEQUEL_TOKENS = ['daima', 'super', 'gt', 'kai', 'shippuden', 'boruto', 'brotherhood', 'z'];

function normalizeText(s = '') {
  return String(s || '')
    .replace(/\[[^\]]*\]/g, ' ') // Ignorar etiquetas entre corchetes como "[Z-A]" al comparar el título de la obra
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function cleanSearchQueryTitle(title = '') {
  return String(title)
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .trim();
}

export function matchesTitle(releaseTitle, acceptedTitles = []) {
  const normRelease = normalizeText(releaseTitle);
  const releaseTokens = new Set(normRelease.split(' ').filter(Boolean));

  const allTargetNorms = acceptedTitles.map((t) => normalizeText(cleanSearchQueryTitle(t))).filter(Boolean);
  const allowedSequelTokens = new Set();
  for (const tn of allTargetNorms) {
    for (const tok of tn.split(' ')) {
      if (SEQUEL_TOKENS.includes(tok)) allowedSequelTokens.add(tok);
    }
  }

  for (const normTarget of allTargetNorms) {
    const words = normTarget.split(' ').filter((w) => w.length >= 2 || w === 'z');
    if (words.length === 0) continue;

    // Si el torrent incluye un marcador de secuela/saga distinta (ej. "daima", "kai", "shippuden") que NO pertenece a la serie buscada -> rechazar
    let hasConflictingSaga = false;
    for (const seqTok of SEQUEL_TOKENS) {
      if (releaseTokens.has(seqTok) && !allowedSequelTokens.has(seqTok)) {
        // Solo bloquear si comparten la raíz (ej. Dragon Ball -> DAIMA, Naruto -> Shippuden)
        hasConflictingSaga = true;
        break;
      }
    }
    if (hasConflictingSaga) continue;

    if (` ${normRelease} `.includes(` ${normTarget} `)) return true;

    const significantWords = words.filter((w) => w.length >= 3 || w === 'z');
    if (significantWords.length >= 2) {
      const allPresent = significantWords.every((w) => releaseTokens.has(w));
      if (allPresent) return true;
    }
  }
  return false;
}

function numberInRangePattern(releaseTitle, targetNum) {
  // Detecta rangos tipo "01-50", "001-291", "01_50", "Cap.101_113", "S01E01-S01E13"
  const rangeRegexes = [
    /\b0*(\d{1,4})\s*[-_~]\s*0*(\d{1,4})\b/g,
    /\bcap\.?\s*\d(\d{2})\s*[-_]\s*\d(\d{2})\b/gi,
  ];
  for (const re of rangeRegexes) {
    let m;
    while ((m = re.exec(releaseTitle)) !== null) {
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 500) {
        if (targetNum >= start && targetNum <= end) return true;
      }
    }
  }
  return false;
}

export function classifyEpisodeMatch(releaseTitle, { seasonNumber, episodeNumber, absNumber, isAnime }) {
  const s2 = pad2(seasonNumber);
  const e2 = pad2(episodeNumber);
  const e3 = String(episodeNumber).padStart(3, '0');

  // 1. Coincidencia exacta S01E05, 1x05 o Cap.105
  const exactPatterns = [
    new RegExp(`\\bs0*${seasonNumber}[\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`\\b0*${seasonNumber}x0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`\\btemporada\\s*0*${seasonNumber}[^\\d]+(?:cap(?:itulo)?|ep(?:isodio)?)\\s*0*${episodeNumber}(?!\\d)`, 'i'),
  ];
  if (seasonNumber > 0 && episodeNumber < 100) {
    exactPatterns.push(new RegExp(`\\bcap(?:itulo)?\\.?[\\s._-]*0*${seasonNumber}${e2}(?!\\d)`, 'i'));
  }

  // Si es un rango multi-episodio como "S01E01-S01E13" o "Cap.101_113", tratarlo como pack
  const isExplicitMultiEpPack =
    /\bs\d{1,2}e\d{1,2}\s*-\s*s?\d{0,2}e\d{1,3}\b/i.test(releaseTitle) ||
    /\bcap\.?\s*\d{1,4}\s*[-_]\s*\d{1,4}\b/i.test(releaseTitle);

  for (const re of exactPatterns) {
    if (re.test(releaseTitle)) {
      return { matched: true, isPack: isExplicitMultiEpPack };
    }
  }

  // 2. Formato Anime numeración directa ("- 05", "[05]", "DBZ 001 ", "Episode 05")
  if (isAnime) {
    // Evitar confundir Películas ("Movie 01", "Película 1") u OVAs con el episodio 1 de TV
    if (seasonNumber > 0 && /\b(movie|pel[ií]cula|ova|special|ost|soundtrack|audio\s+only|flac)\b/i.test(releaseTitle)) {
      return { matched: false, isPack: false };
    }

    const candidates = new Set([episodeNumber]);
    if (absNumber) candidates.add(absNumber);

    const wrongSeasonMention =
      seasonNumber === 1 && /\b(s0*[2-9]|season\s*[2-9]|[2-9](?:nd|rd|th)\s+season|part\s*2)\b/i.test(releaseTitle);

    if (!wrongSeasonMention) {
      for (const num of candidates) {
        const n2 = pad2(num);
        const n3 = String(num).padStart(3, '0');
        const animeEpRe = new RegExp(
          `(?:\\s-\\s*|\\[|\\bep(?:isode)?[\\s._-]*|\\s)(?:0*${num}|${n2}|${n3})(?:v\\d)?(?:\\s|\\]|\\[|\\(|\\.|$)`,
          'i'
        );
        if (animeEpRe.test(releaseTitle) && !/\b\d{4}\b/.test(String(num))) {
          return { matched: true, isPack: isExplicitMultiEpPack };
        }
        if (numberInRangePattern(releaseTitle, num)) {
          return { matched: true, isPack: true };
        }
      }
    }
  }

  // 3. ¿Es un Pack de Temporada o Serie Completa?
  const seasonPackPatterns = [
    new RegExp(`\\b(s${s2}|season\\s*0*${seasonNumber}|temporada\\s*0*${seasonNumber}|box\\s*0*${seasonNumber})\\b`, 'i'),
    /\b(complete|completa|batch|integrale|full\s*season)\b/i,
  ];
  const hasOtherEpisodeTag = /\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b/i.test(releaseTitle);

  if (
    (!hasOtherEpisodeTag || isExplicitMultiEpPack || numberInRangePattern(releaseTitle, episodeNumber)) &&
    seasonPackPatterns.some((re) => re.test(releaseTitle))
  ) {
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
  if (/\b(2160p|4k|uhd)\b/i.test(title)) return 85;
  if (/\b(720p|1280x720|hdrip|microhd|bdrip|bluray|web-dl|webrip)\b/i.test(title)) return 75;
  return 20;
}

function matchAudioPreferenceTier(langInfo, prefCode) {
  if (!prefCode || prefCode === 'none') return false;
  if (prefCode === 'any') return true;
  if (prefCode === 'es-ES') return langInfo.hasExplicitCastellano;
  if (prefCode === 'es-419') return langInfo.hasExplicitLatino;
  if (prefCode === 'ja') return langInfo.hasJapaneseAudio || (!langInfo.hasEngDubOnly && langInfo.hasMultiSub);
  if (prefCode === 'en') return langInfo.hasEnglishAudio;
  if (prefCode === 'multi') return langInfo.hasMultiAudio;
  return false;
}

function matchSubtitlePreferenceTier(langInfo, prefCode) {
  if (!prefCode || prefCode === 'none') return false;
  if (prefCode === 'off' || prefCode === 'any') return true;
  if (prefCode === 'es-ES' || prefCode === 'es-419') return langInfo.hasSpanishSub || langInfo.hasMultiSub;
  if (prefCode === 'en') return langInfo.hasEnglishSub || langInfo.hasMultiSub;
  return false;
}

/**
 * Puntúa y filtra candidatos según el Perfil de Preferencias del usuario
 * (o devuelve TODOS los idiomas etiquetados cuando `allLanguages: true` para la Lupa 🔍).
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
    allLanguages = false,
    preferences = DEFAULT_PREFERENCES,
    statsOut = null,
  } = context;

  const profile = isAnime
    ? { ...DEFAULT_PREFERENCES.anime, ...(preferences?.anime || {}) }
    : { ...DEFAULT_PREFERENCES.regular, ...(preferences?.regular || {}) };

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

    const isExactImdbStream = Boolean(cand.matchedExactImdbEpisode || matchedByImdb);

    if (!isExactImdbStream && acceptedTitles.length > 0 && !matchesTitle(title, acceptedTitles)) {
      stats.titleMismatch++;
      continue;
    }

    let isPack = false;
    if (mediaType === 'tv') {
      if (cand.matchedExactImdbEpisode) {
        isPack = Number.isInteger(cand.hintFileIndex);
      } else {
        const epCheck = classifyEpisodeMatch(title, { seasonNumber, episodeNumber, absNumber, isAnime });
        if (!epCheck.matched) {
          stats.episodeOrYearMismatch++;
          continue;
        }
        isPack = epCheck.isPack;
      }
    } else if (year && !isExactImdbStream) {
      const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
      if (yearMatch && Math.abs(Number(yearMatch[1]) - year) > 1) {
        stats.episodeOrYearMismatch++;
        continue;
      }
    }

    const langInfo = inspectReleaseLanguages(title);
    let score = 0;

    if (allLanguages) {
      // MODO LUPA 🔍: No descartar ningún idioma ni subtítulo; solo ordenar por calidad y semillas
      if (langInfo.hasExplicitCastellano) score += 150;
      if (langInfo.hasSpanishSub) score += 120;
    } else {
      // MODO DESCARGA AUTOMÁTICA: Aplicar estrictamente el Perfil de Preferencias (Primario > Secundario > Otros)
      if (isAnime && ANIME_RAW_RE.test(title) && !allowExternalSubFallback) {
        stats.languageRejected++;
        continue;
      }

      // En no-anime, si el usuario solo quiere Castellano (sin Latino ni VOSE), bloquear falsos positivos
      if (!isAnime && profile.audioPrimary === 'es-ES' && profile.audioSecondary === 'none') {
        if ((langInfo.hasExplicitLatino && !langInfo.hasExplicitCastellano) || langInfo.isVoseOnly) {
          stats.languageRejected++;
          continue;
        }
      }

      let audioTierScore = 0;
      let matchedAudioCode = null;
      if (matchAudioPreferenceTier(langInfo, profile.audioPrimary)) {
        audioTierScore = 500;
        matchedAudioCode = profile.audioPrimary;
      } else if (matchAudioPreferenceTier(langInfo, profile.audioSecondary)) {
        audioTierScore = 340;
        matchedAudioCode = profile.audioSecondary;
      } else if (matchAudioPreferenceTier(langInfo, profile.audioOther)) {
        audioTierScore = 180;
        matchedAudioCode = profile.audioOther;
      }

      if (audioTierScore === 0) {
        stats.languageRejected++;
        continue;
      }

      // Evaluar subtítulos requeridos según perfil
      const audioIsAlreadySpanish =
        (matchedAudioCode === 'es-ES' || langInfo.hasExplicitCastellano) && profile.allowSpanishAudioWithoutSubs;

      let subTierScore = 0;
      if (profile.subPrimary === 'off' || audioIsAlreadySpanish) {
        subTierScore = 200;
      } else if (matchSubtitlePreferenceTier(langInfo, profile.subPrimary)) {
        subTierScore = 300;
        if (/\b(erai-raws|toonshub|castellano|es-es)\b/i.test(title)) subTierScore += 80;
      } else if (matchSubtitlePreferenceTier(langInfo, profile.subSecondary)) {
        subTierScore = 200;
      } else if (matchSubtitlePreferenceTier(langInfo, profile.subOther)) {
        subTierScore = 100;
      } else if (allowExternalSubFallback) {
        subTierScore = 60;
      }

      if (subTierScore === 0) {
        stats.languageRejected++;
        continue;
      }

      score += audioTierScore + subTierScore;
    }

    if (CAM_RE.test(title)) score -= 350;

    score += resolutionScore(title);
    score += Math.round(Math.log2((cand.seeders || 1) + 1) * 28);

    if (isPack && !Number.isInteger(cand.hintFileIndex)) score -= 35;
    if (!isPack && mediaType === 'tv' && cand.sizeBytes > 8 * 1024 ** 3) score -= 120;
    if (mediaType === 'movie' && cand.sizeBytes > 25 * 1024 ** 3) score -= 120;

    scored.push({
      ...cand,
      isPack,
      score,
      resolution: langInfo.resolution,
      languageBadges: langInfo.badges,
    });
  }

  stats.accepted = scored.length;
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Selecciona el archivo exacto de vídeo dentro de un torrent (soportando hintFileIndex de Torrentio o Packs)
 */
export function selectEpisodeFileFromTorrent(
  files = [],
  { seasonNumber, episodeNumber, absNumber, isAnime, hintFileIndex = null }
) {
  const videoFiles = files.filter(
    (f) => VIDEO_EXT_RE.test(f.name) && !/\b(sample|trailer|ncop|nced|creditless|pv)\b/i.test(f.name)
  );
  if (videoFiles.length === 0) return null;
  if (videoFiles.length === 1) return videoFiles[0];

  if (Number.isInteger(hintFileIndex)) {
    const exactHint = files.find((f) => f.index === hintFileIndex && VIDEO_EXT_RE.test(f.name));
    if (exactHint) return exactHint;
  }

  const e2 = pad2(episodeNumber);
  const e3 = String(episodeNumber).padStart(3, '0');

  const patterns = [
    new RegExp(`s0*${seasonNumber}[\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`0*${seasonNumber}x0*${episodeNumber}(?!\\d)`, 'i'),
    new RegExp(`cap(?:itulo)?\\.?[\\s._-]*0*${seasonNumber}${e2}(?!\\d)`, 'i'),
  ];

  for (const re of patterns) {
    const found = videoFiles.find((f) => re.test(f.name));
    if (found) return found;
  }

  const nums = [episodeNumber];
  if (isAnime && absNumber && absNumber !== episodeNumber) nums.push(absNumber);

  for (const num of nums) {
    const n2 = pad2(num);
    const n3 = String(num).padStart(3, '0');
    const looseRe = new RegExp(
      `(?:^|[\\s._\\[-])(?:ep?[\\s._-]*)?(?:0*${num}|${n2}|${n3})(?:v\\d)?(?=[\\s._\\]\\(-]|\\.[a-z0-9]{2,4}$)`,
      'i'
    );
    const candidates = videoFiles.filter((f) => {
      const base = f.name.split('/').pop() || f.name;
      return looseRe.test(base);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const inSeasonFolder = candidates.find((f) =>
        new RegExp(`(?:season|temporada|s|box)[\\s._-]*0*${seasonNumber}(?!\\d)`, 'i').test(f.name)
      );
      if (inSeasonFolder) return inSeasonFolder;
      return candidates.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    }
  }

  return null;
}

export function selectMovieFileFromTorrent(files = [], hintFileIndex = null) {
  if (Number.isInteger(hintFileIndex)) {
    const exactHint = files.find((f) => f.index === hintFileIndex && VIDEO_EXT_RE.test(f.name));
    if (exactHint) return exactHint;
  }
  const videoFiles = files.filter(
    (f) => VIDEO_EXT_RE.test(f.name) && !/\b(sample|trailer|extras?)\b/i.test(f.name)
  );
  if (videoFiles.length === 0) return null;
  return [...videoFiles].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

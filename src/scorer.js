import { DEFAULT_PREFERENCES, inspectReleaseLanguages } from './preferences.js';

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|webm|m4v|ts)$/i;
const CAM_RE = /\b(hdcam|camrip|cam|ts-screener|hdts|telesync|telecine|workprint)\b/i;
const RAW_DISC_RE = /\b(bdmv|bdiso|dvd5|dvd9)\b|\.iso(?:\b|\s|\||$)/i;
const ANIME_RAW_RE = /\b(\[raw\]|raw-raws|\braw\b)\b/i;

// Sagas/secuelas/spin-offs que NO deben confundirse entre sí (ej. Dragon Ball Z != DAIMA/Kai, MHA != Vigilantes)
const SEQUEL_TOKENS = [
  'daima',
  'super',
  'gt',
  'kai',
  'shippuden',
  'boruto',
  'brotherhood',
  'vigilante',
  'vigilantes',
  'illegals',
  'z',
];

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
    const words = normTarget.split(' ').filter((w) => w.length >= 2 || w === 'z' || /^\d+$/.test(w));
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

    const significantWords = words.filter((w) => w.length >= 3 || w === 'z' || /^\d+$/.test(w));
    if (significantWords.length >= 2) {
      const allPresent = significantWords.every((w) => releaseTokens.has(w));
      if (allPresent) return true;
    }
  }
  return false;
}

function numberInRangePattern(releaseTitle, targetNum) {
  // Detecta rangos tipo "01-50", "001-291", "01_50", "Cap.101_113", "S01E01-S01E13"
  // Ignorar prefijos "Season 3 - 10" / "Part 2 - 08" para no confundir "Temporada - Episodio" con un rango 3..10
  const cleaned = String(releaseTitle || '').replace(
    /\b(?:season|temporada|part|parte|cour|box|vol(?:ume)?)\s*0*\d{1,2}(?=\s*[-_~])/gi,
    ' '
  );
  const rangeRegexes = [
    /\b0*(\d{1,4})\s*[-_~]\s*0*(\d{1,4})\b/g,
    /\bcap\.?\s*\d(\d{2})\s*[-_]\s*\d(\d{2})\b/gi,
  ];
  for (const re of rangeRegexes) {
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 500) {
        if (targetNum >= start && targetNum <= end) return true;
      }
    }
  }
  return false;
}

function extractExplicitSeasonInfo(releaseTitle = '', acceptedTitles = []) {
  const hasFinalSeason = /\b(final[\s._-]*season|the[\s._-]*final)\b/i.test(releaseTitle);

  const directPatterns = [
    /\bs0*(\d{1,2})(?:[\s._-]*e\d|\b)/i,
    /\b(?:season|temporada|box)\s*0*(\d{1,2})\b/i,
    /\b0*(\d{1,2})x\d{1,3}\b/i,
  ];
  for (const re of directPatterns) {
    const m = releaseTitle.match(re);
    if (m) return { explicitSeason: Number(m[1]), hasFinalSeason, hasArcNamedSubSeason: false };
  }

  // Ordinales en inglés ("2nd Season", "Second Season", "3rd Season", "Third Season"...)
  const wordOrdMap = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
  const ordMatch =
    releaseTitle.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i) ||
    releaseTitle.match(/\b(first|second|third|fourth|fifth|sixth)\s+season\b/i);

  if (ordMatch) {
    const rawVal = ordMatch[1].toLowerCase();
    const num = wordOrdMap[rawVal] || Number(rawVal);

    // Detectar si antes de "2nd Season" hay un subtítulo de arco ajeno al título raíz (ej. "Haikyuu!! To the Top 2nd Season" = S4 Parte 2, NO S2)
    if (acceptedTitles.length > 0 && num >= 2) {
      const baseWords = new Set();
      for (const t of acceptedTitles) {
        const cleanT = normalizeText(cleanSearchQueryTitle(t));
        const toks = cleanT.split(' ').filter(Boolean);
        if (toks.length <= 5) {
          for (const w of toks) baseWords.add(w);
        }
      }
      const prefixRaw = releaseTitle
        .slice(0, ordMatch.index)
        .replace(/^Torrentio[^—]*—\s*/i, '')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
      const prefixWords = normalizeText(prefixRaw)
        .split(' ')
        .filter(
          (w) =>
            w.length >= 3 &&
            !baseWords.has(w) &&
            !['the', 'tv', 'bd', 'web', 'ova', 'part', 'cour', 'season', 'series'].includes(w)
        );
      if (prefixWords.length >= 1) {
        return { explicitSeason: null, hasFinalSeason, hasArcNamedSubSeason: true };
      }
    }
    return { explicitSeason: num, hasFinalSeason, hasArcNamedSubSeason: false };
  }

  // Números romanos tras el título en Anime ("Mob Psycho 100 II - 05", "Overlord III - 08", "Overlord IV")
  const romanAllowedInBase = acceptedTitles.some((t) => /\b(ii|iii|iv|v)\b/i.test(t));
  if (!romanAllowedInBase) {
    const romanMap = { ii: 2, iii: 3, iv: 4, v: 5 };
    const romMatch = releaseTitle.match(/(?:^|\s)(II|III|IV|V)(?=\s*-\s*\d|\s*\[|\s*\(|\s+(?:s\d|ep?\d|1080p|720p|2160p|bd|web))/);
    if (romMatch) {
      return {
        explicitSeason: romanMap[romMatch[1].toLowerCase()] || null,
        hasFinalSeason,
        hasArcNamedSubSeason: false,
      };
    }
  }

  return { explicitSeason: null, hasFinalSeason, hasArcNamedSubSeason: false };
}

function matchesMovieDistinctiveSubtitle(releaseTitle, acceptedTitles = [], year = null) {
  if (year) {
    const ym = releaseTitle.match(/\b(19\d{2}|20\d{2})\b/);
    if (ym && Math.abs(Number(ym[1]) - year) <= 1) return true;
  }

  // Si la película pertenece a una saga y tiene subtítulo tras ":" o "-" (ej. "My Hero Academia: Dos héroes" / "Demon Slayer Mugen Train"),
  // exigir que coincida con alguno de los subtítulos distintivos cuando el torrent no indica año, evitando mezclar películas de la saga.
  const stopWords = new Set([
    'the',
    'movie',
    'pelicula',
    'film',
    'ova',
    'gekijouban',
    'de',
    'la',
    'el',
    'los',
    'las',
    'no',
    'to',
  ]);
  const franchiseWords = new Set();
  const subtitleTokenSets = [];

  for (const raw of acceptedTitles) {
    const cleaned = cleanSearchQueryTitle(raw);
    const parts = cleaned.split(/\s*(?::|-\s+|–\s+|\bthe\s+movie\b)\s*/i);
    if (parts.length >= 2) {
      for (const pw of normalizeText(parts[0]).split(' ')) {
        if (pw.length >= 3 && !stopWords.has(pw)) franchiseWords.add(pw);
      }
      const subNorm = normalizeText(parts.slice(1).join(' '));
      const toks = subNorm.split(' ').filter((w) => w.length >= 3 && !stopWords.has(w));
      if (toks.length > 0) subtitleTokenSets.push(toks);
    }
  }

  if (subtitleTokenSets.length === 0) return true;

  // Incluir también palabras distintivas (no pertenecientes a la raíz de la franquicia) de títulos alternativos sin ":"
  for (const raw of acceptedTitles) {
    const cleaned = cleanSearchQueryTitle(raw);
    if (!/\s*(?::|-\s+|–\s+|\bthe\s+movie\b)\s*/i.test(cleaned)) {
      const extraToks = normalizeText(cleaned)
        .split(' ')
        .filter((w) => w.length >= 3 && !stopWords.has(w) && !franchiseWords.has(w));
      if (extraToks.length > 0) subtitleTokenSets.push(extraToks);
    }
  }

  const relTokens = new Set(normalizeText(releaseTitle).split(' ').filter(Boolean));
  return subtitleTokenSets.some((toks) => toks.every((w) => relTokens.has(w)));
}

export function classifyEpisodeMatch(
  releaseTitle,
  {
    seasonNumber,
    episodeNumber,
    absNumber,
    isAnime,
    totalRegularSeasons = 0,
    episodeTitle = '',
    episodeYear = null,
    acceptedTitles = [],
  }
) {
  const s2 = pad2(seasonNumber);
  const e2 = pad2(episodeNumber);
  const { explicitSeason, hasFinalSeason, hasArcNamedSubSeason } = extractExplicitSeasonInfo(
    releaseTitle,
    acceptedTitles
  );

  // En Anime, grupos como Erai-raws usan "(2019)" o "(2025)" para indicar Temporada 2 o 3 sin escribir S02/S03:
  // si el título trae un año entre paréntesis distinto al año real de emisión de este capítulo/OVA, rechazar.
  if (isAnime && episodeYear && explicitSeason === null && !/\b(?:19|20)\d{2}\s*[-~]\s*(?:19|20)\d{2}\b/.test(releaseTitle)) {
    const parenYear = releaseTitle.match(/\((19\d{2}|20\d{2})\)/);
    if (parenYear && Math.abs(Number(parenYear[1]) - episodeYear) > 1) {
      return { matched: false, isPack: false };
    }
  }

  // 0. Temporada 0 (OVAs / Especiales): NUNCA confundir con temporadas regulares ni "Final Season"
  if (seasonNumber === 0) {
    if (/\bs0*0[\s._-]*e0*\d+\b|\b0x0*\d+\b/i.test(releaseTitle)) {
      const exactZero =
        new RegExp(`\\bs0*0[\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i').test(releaseTitle) ||
        new RegExp(`\\b0x0*${episodeNumber}(?!\\d)`, 'i').test(releaseTitle);
      return { matched: exactZero, isPack: false, exactOvaMatch: exactZero };
    }
    if ((explicitSeason !== null && explicitSeason > 0) || hasFinalSeason || hasArcNamedSubSeason) {
      return { matched: false, isPack: false };
    }
    const hasOvaMarker = /\b(ovas?|oads?|onas?|specials?|especiales?|sp\d*|jump[\s._-]*festa)\b/i.test(releaseTitle);
    if (!hasOvaMarker) return { matched: false, isPack: false };

    const ovaStop = new Set([
      'episodio',
      'episode',
      'especial',
      'special',
      'ova',
      'oad',
      'los',
      'las',
      'del',
      'una',
      'por',
      'con',
      'que',
      'the',
      'and',
      'for',
      'aparece',
      'appears',
    ]);
    const epTitleWords = normalizeText(episodeTitle)
      .split(' ')
      .filter((w) => w.length >= 3 && !ovaStop.has(w));
    const relWords = new Set(normalizeText(releaseTitle).split(' ').filter(Boolean));
    const matchedTitleWords = epTitleWords.filter((w) => relWords.has(w)).length;
    if (matchedTitleWords >= 2 || (epTitleWords.length >= 1 && matchedTitleWords >= 1)) {
      return { matched: true, isPack: false, exactOvaMatch: true };
    }

    const ovaNumMatch = releaseTitle.match(/\b(?:ova|oad|special|especial|sp)[\s._-]*0*(\d{1,2})\b/i);
    if (ovaNumMatch) {
      const ok = Number(ovaNumMatch[1]) === episodeNumber;
      return { matched: ok, isPack: false, exactOvaMatch: ok };
    }
    const dashNum = new RegExp(`(?:\\s-\\s*|\\[)0*${episodeNumber}(?:\\s|\\]|\\.|$)`, 'i').test(releaseTitle);
    if (dashNum) {
      return { matched: true, isPack: /\b(ovas|specials|batch|complete)\b/i.test(releaseTitle), exactOvaMatch: true };
    }
    if (episodeNumber === 1 && !/\b(mini|short|picture\s+drama)\b/i.test(episodeTitle)) {
      return { matched: true, isPack: /\b(ovas|specials|batch|complete)\b/i.test(releaseTitle), exactOvaMatch: false };
    }
    return { matched: false, isPack: false };
  }

  // Bloquear "To the Top 2nd Season" (arco de S4) cuando se pide S1/S2/S3
  if (hasArcNamedSubSeason && seasonNumber < totalRegularSeasons) {
    return { matched: false, isPack: false };
  }

  // Bloquear colisión entre temporadas distintas (ej. S01E06 vs "2nd Season - 06" o "Final Season - 06")
  if (explicitSeason !== null && explicitSeason !== seasonNumber) {
    return { matched: false, isPack: false };
  }
  if (hasFinalSeason && (seasonNumber === 1 || (totalRegularSeasons > 1 && seasonNumber < totalRegularSeasons))) {
    return { matched: false, isPack: false };
  }

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

  // 2. Formato Anime numeración directa ("- 05", "[05]", "DBZ 001 ", "4th Season - 10")
  if (isAnime) {
    // Evitar confundir Películas ("Movie 01", "Película 1") u OVAs con episodios de temporada regular
    if (/\b(movie|pel[ií]cula|ova|oad|special|ost|soundtrack|audio\s+only|flac)\b/i.test(releaseTitle)) {
      return { matched: false, isPack: false };
    }

    // En Temporada 1 de animes multitemporada sin S01 explícito: rechazar si lleva subtítulo de arco posterior antes del "- 10" (ej. "Dr. Stone Science Future - 10", "Haikyuu!! To the Top - 07")
    if (seasonNumber === 1 && totalRegularSeasons > 1 && explicitSeason === null && acceptedTitles.length > 0) {
      const dashSplit = releaseTitle
        .replace(/^Torrentio[^—]*—\s*/i, '')
        .split(/\s+-\s+\d{1,3}\b|\[\d{1,3}\]/)[0];
      if (dashSplit && dashSplit !== releaseTitle) {
        const baseWords = new Set();
        for (const t of acceptedTitles) {
          for (const w of normalizeText(cleanSearchQueryTitle(t)).split(' ')) {
            if (w) baseWords.add(w);
          }
        }
        const strippedPrefix = dashSplit.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
        const extraArcWords = normalizeText(strippedPrefix)
          .split(' ')
          .filter(
            (w) =>
              w.length >= 3 &&
              !/^\d+$/.test(w) &&
              !baseWords.has(w) &&
              ![
                'the',
                'tv',
                'bd',
                'web',
                'dvd',
                'remaster',
                'remastered',
                'uncensored',
                'animation',
                'anime',
                'complete',
                'batch',
              ].includes(w)
          );
        if (extraArcWords.length >= 1) {
          return { matched: false, isPack: false };
        }
      }
    }

    const candidates = new Set();
    // Solo usar episodeNumber relativo si es Temporada 1 o el torrent nombra explícitamente esa temporada (ej. "4th Season - 10")
    if (seasonNumber === 1 || explicitSeason === seasonNumber || (hasFinalSeason && seasonNumber === totalRegularSeasons)) {
      candidates.add(episodeNumber);
    }
    // Si el torrent NO menciona ninguna temporada específica (numeración continua estilo Naruto/One Piece), usar absNumber
    if (absNumber && explicitSeason === null && !hasFinalSeason) {
      candidates.add(absNumber);
    }

    const titleWithoutCrc = releaseTitle.replace(/\[[0-9a-f]{8}\]/gi, ' ');
    for (const num of candidates) {
      const n2 = pad2(num);
      const n3 = String(num).padStart(3, '0');
      const animeEpRe = new RegExp(
        `(?:\\s-\\s*|\\[|\\bep(?:isode)?[\\s._-]*|\\s)(?:0*${num}|${n2}|${n3})(?:v\\d)?(?:\\s|\\]|\\[|\\(|\\.|$)`,
        'i'
      );
      if (animeEpRe.test(titleWithoutCrc) && !/\b\d{4}\b/.test(String(num))) {
        return { matched: true, isPack: isExplicitMultiEpPack };
      }
      if (numberInRangePattern(titleWithoutCrc, num)) {
        return { matched: true, isPack: true };
      }
    }
  }

  // 3. ¿Es un Pack de Temporada o Serie Completa?
  const hasExplicitEpisodeRange = /\b0*\d{1,4}\s*[-_~]\s*0*\d{1,4}\b/.test(releaseTitle);
  const seasonPackPatterns = [
    new RegExp(`\\b(s${s2}|season\\s*0*${seasonNumber}|temporada\\s*0*${seasonNumber}|box\\s*0*${seasonNumber})\\b`, 'i'),
    /\b(complete|completa|batch|integrale|full\s*season)\b/i,
  ];
  const hasOtherEpisodeTag =
    /\bs\d{1,2}e\d{1,3}\b|\b\d{1,2}x\d{1,3}\b|\s-\s*\d{1,3}(?:v\d)?(?=\s|\[|\(|\.)|\bep(?:isode)?[\s._-]*\d{1,3}\b/i.test(
      releaseTitle
    );
  const isMultiSeasonCompletePack = /\bs0*1\s*[-~]\s*s?0*[2-9]\b|\bcomplete\s+series\b|\bserie\s+completa\b/i.test(
    releaseTitle
  );

  if (
    !hasExplicitEpisodeRange &&
    (!hasOtherEpisodeTag || isExplicitMultiEpPack) &&
    seasonPackPatterns.some((re) => re.test(releaseTitle))
  ) {
    if (explicitSeason === seasonNumber) {
      return { matched: true, isPack: true };
    }
    if (explicitSeason === null && (seasonNumber === 1 || isMultiSeasonCompletePack)) {
      return { matched: true, isPack: true };
    }
  }

  return { matched: false, isPack: false };
}

function qualityPreferenceScore(resolution = 'SD', seeders = 1, prefQuality = '1080p', { allLanguages = false, sizeBytes = 0 } = {}) {
  if (allLanguages) {
    if (resolution === '1080p') return 130;
    if (resolution === '4K') return seeders <= 3 ? 60 : 120;
    if (resolution === '720p') return 95;
    return 30;
  }

  const q = String(prefQuality || '1080p').toLowerCase();
  if (q === 'best') {
    if (resolution === '4K') return seeders <= 1 ? 185 : 310;
    if (resolution === '1080p') return 175;
    if (resolution === '720p') return 85;
    return 25;
  }
  if (q === '4k') {
    if (resolution === '4K') return 330;
    if (resolution === '1080p') return 165;
    if (resolution === '720p') return 80;
    return 20;
  }
  if (q === '720p') {
    let base = 55;
    if (resolution === '720p') base = 260;
    else if (resolution === '1080p') base = 110;
    else if (resolution === '4K') base = -70;
    if (sizeBytes > 0 && sizeBytes <= 3.5 * 1024 ** 3) base += 30;
    else if (sizeBytes > 8 * 1024 ** 3) base -= 80;
    return base;
  }
  if (q === 'sd') {
    if (resolution === 'SD') return 260;
    if (resolution === '720p') return 120;
    if (resolution === '1080p') return 45;
    return -110;
  }

  // Por defecto: '1080p' (Equilibrio ideal calidad / espacio en disco)
  if (resolution === '1080p') return seeders <= 1 ? 145 : 230;
  if (resolution === '720p') return 95;
  if (resolution === '4K') return seeders <= 3 ? 35 : 85;
  return 25;
}

function matchAudioPreferenceTier(langInfo, prefCode) {
  if (!prefCode || prefCode === 'none') return false;
  if (prefCode === 'any') return true;
  if (prefCode === 'es-ES') return langInfo.hasExplicitCastellano;
  if (prefCode === 'es-419') return langInfo.hasExplicitLatino;
  if (prefCode === 'ja') {
    return (
      langInfo.hasJapaneseAudio ||
      (!langInfo.hasEngDubOnly &&
        !langInfo.hasExplicitCastellano &&
        !langInfo.hasExplicitLatino &&
        (langInfo.hasMultiSub || langInfo.hasSpanishSub))
    );
  }
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
    totalRegularSeasons = 0,
    episodeTitle = '',
    episodeYear = null,
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
    qualityRejected: 0,
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
    const matchesDistinctiveAnchor = (() => {
      const relWords = new Set(normalizeText(title).split(' ').filter((w) => w.length >= 4));
      return acceptedTitles.some((at) => {
        const words = normalizeText(cleanSearchQueryTitle(at))
          .split(' ')
          .filter((w) => w.length >= 4);
        if (words.length === 0) return false;
        const longestWord = [...words].sort((a, b) => b.length - a.length)[0];
        return relWords.has(longestWord);
      });
    })();
    const isTrustedRegionalImdbTracker =
      isExactImdbStream &&
      /\b(mejortorrent|wolfmax|dontorrent|cinecalidad|nyaa)/i.test(String(cand.source || '')) &&
      matchesDistinctiveAnchor;

    if (!isTrustedRegionalImdbTracker && acceptedTitles.length > 0 && !matchesTitle(title, acceptedTitles)) {
      stats.titleMismatch++;
      continue;
    }

    let isPack = false;
    let exactOvaMatch = false;
    if (mediaType === 'tv') {
      if (cand.matchedExactImdbEpisode) {
        const { explicitSeason, hasFinalSeason, hasArcNamedSubSeason } = extractExplicitSeasonInfo(
          title,
          acceptedTitles
        );
        const parenYear =
          isAnime && episodeYear && explicitSeason === null && !/\b(?:19|20)\d{2}\s*[-~]\s*(?:19|20)\d{2}\b/.test(title)
            ? title.match(/\((19\d{2}|20\d{2})\)/)
            : null;
        if (
          (parenYear && Math.abs(Number(parenYear[1]) - episodeYear) > 1) ||
          (seasonNumber === 0 && ((explicitSeason !== null && explicitSeason > 0) || hasFinalSeason || hasArcNamedSubSeason)) ||
          (seasonNumber > 0 && hasArcNamedSubSeason && seasonNumber < totalRegularSeasons) ||
          (seasonNumber > 0 && explicitSeason !== null && explicitSeason !== seasonNumber) ||
          (seasonNumber > 0 &&
            hasFinalSeason &&
            (seasonNumber === 1 || (totalRegularSeasons > 1 && seasonNumber < totalRegularSeasons)))
        ) {
          stats.episodeOrYearMismatch++;
          continue;
        }
        if (seasonNumber === 0) {
          const epCheckZero = classifyEpisodeMatch(title, {
            seasonNumber: 0,
            episodeNumber,
            absNumber,
            isAnime,
            totalRegularSeasons,
            episodeTitle,
            episodeYear,
            acceptedTitles,
          });
          exactOvaMatch = Boolean(epCheckZero.exactOvaMatch);
        }
        isPack = Number.isInteger(cand.hintFileIndex);
      } else {
        const epCheck = classifyEpisodeMatch(title, {
          seasonNumber,
          episodeNumber,
          absNumber,
          isAnime,
          totalRegularSeasons,
          episodeTitle,
          episodeYear,
          acceptedTitles,
        });
        if (!epCheck.matched) {
          stats.episodeOrYearMismatch++;
          continue;
        }
        isPack = epCheck.isPack;
        exactOvaMatch = Boolean(epCheck.exactOvaMatch);
      }
    } else {
      // En películas: bloquear capítulos o temporadas de series ("S02", "2nd Season", "- 09 [1080p]", "Batch", "Mugen Train Arc") y archivos diminutos
      const hasExplicitMovieToken = /\b(movie|pel[ií]cula|film|gekijou?[\s-]*ban|theatrical)\b/i.test(title);
      const hasStandaloneAnimeEpisodeDash =
        !hasExplicitMovieToken &&
        /\s-\s*(?:0[1-9]|[1-9]\d{0,2})(?:v\d)?(?=\s*(?:\[|\(|\b(?:1080p|720p|2160p|cr\b|web|aac|avc|hevc)))/i.test(
          title
        );
      if (
        /\b(s0*[1-9]\d?(?:[\s._-]*e\d{1,3}|\b)|\d{1,2}x\d{1,3}|temporada\s*\d+|cap(?:itulo)?\.?\s*\d{2,4}|\bova\b|\boad\b|season\s*\d+|(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|final)\s+season|\bbatch\b|\bcompleta\b|\bmugen\s+train\s+arc\b)\b/i.test(
          title
        ) ||
        hasStandaloneAnimeEpisodeDash ||
        /\b0[1-9]\.(?:mp4|mkv|avi)\b/i.test(title) ||
        (!isAnime && cand.sizeBytes > 0 && cand.sizeBytes < 350_000_000)
      ) {
        stats.episodeOrYearMismatch++;
        continue;
      }

      if (year) {
        const yearMatch = title.match(/\b(19\d{2}|20\d{2})\b/);
        if (yearMatch && Math.abs(Number(yearMatch[1]) - year) > 1) {
          stats.episodeOrYearMismatch++;
          continue;
        }
      }

      const isSpanishRegionalMovieTracker =
        cand.matchedExactImdbEpisode && /\b(mejortorrent|wolfmax|dontorrent|cinecalidad)/i.test(String(cand.source || ''));
      if (!isSpanishRegionalMovieTracker && !matchesMovieDistinctiveSubtitle(title, acceptedTitles, year)) {
        stats.episodeOrYearMismatch++;
        continue;
      }
    }

    const langInfo = inspectReleaseLanguages(title);
    const prefQuality = String(profile.videoQuality || '1080p').toLowerCase();
    const allowQualityFallback = profile.allowQualityFallback !== false;
    let score = 0;

    if (allLanguages) {
      // MODO LUPA 🔍: No descartar ningún idioma, subtítulo ni resolución; devolver todas las opciones etiquetadas
      if (langInfo.hasExplicitCastellano) score += 150;
      if (langInfo.hasSpanishSub) score += 120;
      if (RAW_DISC_RE.test(title)) score -= 400;
    } else {
      // Descartar estructuras crudas de disco (BDMV / ISO / DVD5) que no son un archivo de vídeo reproducible directo
      if (RAW_DISC_RE.test(title)) {
        stats.episodeOrYearMismatch++;
        continue;
      }

      // MODO DESCARGA AUTOMÁTICA: Aplicar primero el Perfil de Idioma y Subtítulos (Primario > Secundario > Otros)
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
        audioTierScore = 650;
        if (profile.audioPrimary === 'es-ES' && langInfo.hasVerifiedCastellano) {
          audioTierScore += 120;
        }
        matchedAudioCode = profile.audioPrimary;
      } else if (matchAudioPreferenceTier(langInfo, profile.audioSecondary)) {
        audioTierScore = 380;
        matchedAudioCode = profile.audioSecondary;
      } else if (matchAudioPreferenceTier(langInfo, profile.audioOther)) {
        audioTierScore = 180;
        matchedAudioCode = profile.audioOther;
      }

      if (audioTierScore === 0) {
        stats.languageRejected++;
        continue;
      }

      // Evaluar subtítulos requeridos según perfil (solo eximir subtítulos si el audio elegido ya es Castellano)
      const audioIsAlreadySpanish = matchedAudioCode === 'es-ES' && profile.allowSpanishAudioWithoutSubs;

      let subTierScore = 0;
      if (profile.subPrimary === 'off' || audioIsAlreadySpanish) {
        subTierScore = 200;
      } else if (matchSubtitlePreferenceTier(langInfo, profile.subPrimary)) {
        const isGenericUnverifiedMultiSub =
          langInfo.hasMultiSub && !langInfo.hasVerifiedSpanishInMultiSub && !langInfo.isVoseOnly;
        subTierScore = langInfo.isCrunchyrollImplicitSub ? 225 : isGenericUnverifiedMultiSub ? 220 : 300;
        if (/\b(erai-raws|toonshub|castellano|es-es)\b/i.test(title)) subTierScore += 35;
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

      // Evaluar calidad estricta DESPUÉS de validar idioma/subtítulos para saber cuántas copias válidas en idioma se descartaron por resolución
      if (!allowQualityFallback && prefQuality !== 'best') {
        const expectedResMap = { '4k': '4K', '1080p': '1080p', '720p': '720p', sd: 'SD' };
        const expectedRes = expectedResMap[prefQuality];
        if (expectedRes && langInfo.resolution !== expectedRes) {
          stats.qualityRejected = (stats.qualityRejected || 0) + 1;
          continue;
        }
      }

      score += audioTierScore + subTierScore;
    }

    if (CAM_RE.test(title)) score -= 350;
    if (/anidex/i.test(String(cand.source || ''))) score -= 120;
    if (mediaType === 'tv' && seasonNumber === 0 && exactOvaMatch) score += 200;

    const wants4k = !allLanguages && (prefQuality === 'best' || prefQuality === '4k');
    score += qualityPreferenceScore(langInfo.resolution, cand.seeders || 1, prefQuality, {
      allLanguages,
      sizeBytes: cand.sizeBytes || 0,
    });
    score += Math.round(Math.log2((cand.seeders || 1) + 1) * 36);

    if (isPack && !Number.isInteger(cand.hintFileIndex)) score -= 35;
    if (mediaType === 'tv') {
      const isTvRemux = /\b(bdremux|uhdremux|remux|fullbluray|bd50|bd25)\b/i.test(title);
      const isSingleEpSize = !isPack || Number.isInteger(cand.hintFileIndex);
      if (isTvRemux || (isSingleEpSize && cand.sizeBytes > 12 * 1024 ** 3)) {
        score -= 320; // Evitar que un único capítulo BDRemux de 25-35 GB llene los 120 GB con la ventana [N-1, N, N+1]
      } else if (isSingleEpSize && cand.sizeBytes > (wants4k ? 9.5 : 5.5) * 1024 ** 3) {
        score -= 120;
      }
    }
    if (mediaType === 'movie') {
      const isRemux = /\b(bdremux|uhdremux|remux|fullbluray|bd50|bd25)\b/i.test(title);
      if (wants4k) {
        if (cand.sizeBytes > 42 * 1024 ** 3 || (/\b(fullbluray|bd50)\b/i.test(title) && cand.sizeBytes > 32 * 1024 ** 3)) {
          score -= 340;
        } else if (!isAnime && cand.sizeBytes >= 2 * 1024 ** 3 && cand.sizeBytes <= 28 * 1024 ** 3) {
          score += 65;
        }
      } else if (isRemux || cand.sizeBytes > 24 * 1024 ** 3) {
        score -= 340; // Proteger el disco de 120 GB frente a BDRemux de 35-60 GB salvo que sea la única copia
      } else if (cand.sizeBytes > 15 * 1024 ** 3) {
        score -= 140;
      } else if (!isAnime && cand.sizeBytes >= 1.4 * 1024 ** 3 && cand.sizeBytes <= 13 * 1024 ** 3) {
        score += 65; // Tamaño ideal 1080p / MicroHD / BluRay Rip rápido y nítido
      }
      if (isAnime && cand.sizeBytes >= 900 * 1024 ** 2 && cand.sizeBytes <= (wants4k ? 12 : 4.5) * 1024 ** 3) score += 40;
      if (isAnime && /\b(movie|gekijou?[\s-]*ban|theatrical)\b/i.test(title)) score += 55;
      if (isAnime && !wants4k && cand.sizeBytes > 5 * 1024 ** 3 && (cand.seeders || 0) < 15) score -= 45;
    }

    scored.push({
      ...cand,
      isPack,
      score,
      resolution: langInfo.resolution,
      codecTags: langInfo.codecTags,
      displayTitle: langInfo.displayTitle,
      subFileTitle: langInfo.subFileTitle,
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

  // En Temporada 0 (OVAs / Especiales / Extras): buscar dentro de subcarpetas Extras/Specials/OVAs sin confundir con capítulos regulares
  if (seasonNumber === 0) {
    const specialFiles = videoFiles.filter((f) =>
      /(?:^|\/)(?:extras?|specials?|ovas?|oads?)\/|\b(?:ova|oad|special|mini|sp)\b/i.test(f.name)
    );
    const s0Patterns = [
      new RegExp(`s0*[01][\\s._-]*e0*${episodeNumber}(?!\\d)`, 'i'),
      new RegExp(`(?:ova|oad|special|mini|sp|-)[\\s._-]*0*${episodeNumber}(?!\\d)`, 'i'),
    ];
    for (const re of s0Patterns) {
      const found = specialFiles.find((f) => re.test(f.name));
      if (found) return found;
    }
    return specialFiles.length === 1 && episodeNumber === 1 ? specialFiles[0] : null;
  }

  const seasonMarkerRe = new RegExp(
    `(?:\\bs0*${seasonNumber}(?:e|\\b)|\\b(?:season|temporada|box)[\\s._-]*0*${seasonNumber}\\b|\\b0*${seasonNumber}(?:st|nd|rd|th)\\s+season\\b)`,
    'i'
  );

  // En Temporadas > 1 de Anime: NUNCA elegir un "- 06.mkv" sin etiqueta de temporada (pertenecería a la Temporada 1);
  // probar primero absNumber (ej. 31) y solo usar episodeNumber relativo (6) si la carpeta/archivo menciona esa temporada.
  const searchEntries = [];
  if (isAnime && seasonNumber > 1) {
    if (absNumber && absNumber !== episodeNumber) {
      searchEntries.push({ num: absNumber, requireSeasonInPath: false });
    }
    searchEntries.push({ num: episodeNumber, requireSeasonInPath: true });
  } else {
    searchEntries.push({ num: episodeNumber, requireSeasonInPath: false });
    if (isAnime && absNumber && absNumber !== episodeNumber) {
      searchEntries.push({ num: absNumber, requireSeasonInPath: false });
    }
  }

  for (const { num, requireSeasonInPath } of searchEntries) {
    const n2 = pad2(num);
    const n3 = String(num).padStart(3, '0');
    const looseRe = new RegExp(
      `(?:^|[\\s._\\[-])(?:ep?[\\s._-]*)?(?:0*${num}|${n2}|${n3})(?:v\\d)?(?=[\\s._\\]\\(-]|\\.[a-z0-9]{2,4}$)`,
      'i'
    );
    const candidates = videoFiles.filter((f) => {
      if (requireSeasonInPath && !seasonMarkerRe.test(f.name)) return false;
      const base = f.name.split('/').pop() || f.name;
      return looseRe.test(base);
    });
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      const inSeasonFolder = candidates.find((f) => seasonMarkerRe.test(f.name));
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

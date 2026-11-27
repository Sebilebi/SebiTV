/**
 * Perfiles separados de preferencias de idioma, subtítulos y calidad de vídeo:
 * 1. Perfil Anime (Series, OVAs y Películas de Anime)
 * 2. Perfil Series y Películas (Cine comercial y series occidentales)
 */

const VALID_VIDEO_QUALITIES = new Set(['best', '4k', '1080p', '720p', 'sd']);

export const DEFAULT_PREFERENCES = {
  anime: {
    audioPrimary: 'ja', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any'
    audioSecondary: 'es-ES', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any' | 'none'
    audioOther: 'any', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any' | 'none'
    subPrimary: 'es-ES', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any'
    subSecondary: 'es-419', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any' | 'none'
    subOther: 'none', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any' | 'none'
    allowSpanishAudioWithoutSubs: true, // Si está doblado al Castellano (ej. Doraemon), no exigir subtítulos
    videoQuality: '1080p', // 'best' | '4k' | '1080p' | '720p' | 'sd'
    allowQualityFallback: true, // Si no existe esa resolución en el idioma elegido, aceptar otra calidad disponible
  },
  regular: {
    audioPrimary: 'es-ES',
    audioSecondary: 'none',
    audioOther: 'none',
    subPrimary: 'off',
    subSecondary: 'none',
    subOther: 'none',
    allowSpanishAudioWithoutSubs: true,
    videoQuality: '1080p',
    allowQualityFallback: true,
  },
};

function normalizeProfile(defaults, raw = {}) {
  const merged = { ...defaults, ...(raw || {}) };
  const q = String(merged.videoQuality || defaults.videoQuality || '1080p').toLowerCase();
  merged.videoQuality = VALID_VIDEO_QUALITIES.has(q) ? q : '1080p';
  merged.allowQualityFallback = merged.allowQualityFallback !== false;
  merged.allowSpanishAudioWithoutSubs = Boolean(merged.allowSpanishAudioWithoutSubs);
  return merged;
}

export function getPreferences(db) {
  const raw = db?.getSetting?.('languagePreferences');
  if (!raw) return structuredClone(DEFAULT_PREFERENCES);
  try {
    const parsed = JSON.parse(raw);
    return {
      anime: normalizeProfile(DEFAULT_PREFERENCES.anime, parsed.anime),
      regular: normalizeProfile(DEFAULT_PREFERENCES.regular, parsed.regular),
    };
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

export function savePreferences(db, incoming = {}) {
  const current = getPreferences(db);
  const next = {
    anime: normalizeProfile(current.anime, incoming.anime),
    regular: normalizeProfile(current.regular, incoming.regular),
  };
  db.setSetting('languagePreferences', JSON.stringify(next));
  return next;
}

export function summarizeProfileRule(preferences = DEFAULT_PREFERENCES, isAnime = false) {
  const prof = isAnime
    ? normalizeProfile(DEFAULT_PREFERENCES.anime, preferences?.anime)
    : normalizeProfile(DEFAULT_PREFERENCES.regular, preferences?.regular);

  const audioMap = {
    ja: '🇯🇵 Audio Japonés',
    'es-ES': '🇪🇸 Audio Castellano',
    'es-419': '🇲🇽 Audio Latino',
    en: '🇬🇧 Audio Inglés',
    any: '🔓 Cualquier audio',
  };
  const subMap = {
    off: '🚫 Sin subtítulos',
    'es-ES': '💬 Sub Español',
    'es-419': '💬 Sub Latino',
    en: '💬 Sub Inglés',
    any: '💬 Sub Opcional',
  };
  const strict = !prof.allowQualityFallback && prof.videoQuality !== 'best';
  const qualityMap = {
    best: '✨ Mejor resolución (4K > 1080p)',
    '4k': strict ? '💎 Solo 4K UHD' : '💎 Calidad 4K UHD',
    '1080p': strict ? '🎯 Solo 1080p' : '🎯 Calidad 1080p',
    '720p': strict ? '⚡ Solo 720p' : '⚡ Calidad 720p',
    sd: strict ? '📦 Solo SD' : '📦 Calidad SD',
  };

  return `${audioMap[prof.audioPrimary] || '🔊 Audio'} • ${subMap[prof.subPrimary] || '💬 Subs'} • ${
    qualityMap[prof.videoQuality] || '🎯 Calidad 1080p'
  }`;
}

function parseCleanCandidateNames(rawTitle = '') {
  const stripped = String(rawTitle || '').replace(/^Torrentio[^—]*—\s*/i, '').trim();
  const segments = stripped
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s &&
        !/^(?:👤|💾|⚙️)/.test(s) &&
        !/^(?:multi\s*subs?|dual\s*audio|[\u{1F1E6}-\u{1F1FF}\s/+•-]+)$/iu.test(s)
    );

  const displayTitle = segments[0] || stripped;
  const subFileTitle = segments.length > 1 && segments[1] !== displayTitle ? segments[1] : '';
  return { displayTitle, subFileTitle };
}

/**
 * Detecta qué audios, subtítulos y calidades anuncia el título/metadatos de un torrent
 * (usado tanto por el Scorer como por la Lupa 🔍 multi-idioma).
 */
export function inspectReleaseLanguages(rawTitle = '') {
  const t = String(rawTitle);

  const flagCount = (t.match(/[\u{1F1E6}-\u{1F1FF}]{2}/gu) || []).length;
  const hasEsFlag = t.includes('🇪🇸');
  const hasMxFlag = t.includes('🇲🇽');
  const hasJpFlag = t.includes('🇯🇵');
  const hasGbFlag = t.includes('🇬🇧') || t.includes('🇺🇸');
  const hasFrFlag = t.includes('🇫🇷');
  const hasItFlag = t.includes('🇮🇹');
  const hasDeFlag = t.includes('🇩🇪');
  const hasPtFlag = t.includes('🇵🇹') || t.includes('🇧🇷');
  const hasRuFlag = t.includes('🇷🇺');

  const filenamePart = t.split('|')[0] || t;
  const isMultiSubWithoutMultiAudio =
    /\b(multiple[\s._-]*subtitles?|multi[\s._-]*subs?|msubs?|erai-raws|subsplease|toonshub)\b/i.test(t) &&
    !/\b(multi[\s._-]*audio|dual[\s._-]*audio|castellano)\b/i.test(t);
  const isSpaSubTagInFilename =
    isMultiSubWithoutMultiAudio || /\b(?:spa|esp|spanish)[\s._-]*(?:[a-z0-9]+\s+){0,3}subs?\b/i.test(filenamePart);
  const hasFilenameSpaAudio =
    !isSpaSubTagInFilename && /\b(multi|dual|\bspa\b|\besp\b|spanish|castellano)\b/i.test(filenamePart);
  const isEnglishSceneWebDl =
    /\bwith\s+asl\b|-(?:kitsune|flux|ntb|ethel|successfulcrab|tepes|peculate|edith|fenix|rawr|cakes|ggwp|playweb)\b/i.test(
      t
    );

  const hasVerifiedCastellano =
    /\b(castellano|espa[ñn]ol\s+de\s+espa[ñn]a|es-es|dontorrent|mejortorrent|wolfmax\w*|atomohd|pctnew|newpct|pctmix|selecta[\s._-]*visi[oó]n|eth@n|bryan_122|mony2007)\b/i.test(
      t
    );

  // En releases internacionales en inglés o anime MultiSub (Erai-raws "[ENG][SPA-LA][SPA]"), Torrentio lista banderas de subtítulos, no audios doblados
  const flagsAreSubtitlesOnly =
    isMultiSubWithoutMultiAudio ||
    ((flagCount >= 4 || (hasGbFlag && flagCount >= 2) || isEnglishSceneWebDl) &&
      !/\b(multi[\s._-]*audio|dual[\s._-]*audio)\b/i.test(t) &&
      !hasFilenameSpaAudio &&
      !hasVerifiedCastellano);

  const isVoseOnly =
    /\b(vose|v\.o\.s\.e\.?|subtitulad[oa]|sub[\s._-]*esp(?:a[ñn]ol)?)\b/i.test(t) &&
    !/\b(dual|multi[\s._-]*audio|castellano\s+ac3|ac3.*castellano)\b/i.test(t) &&
    !hasVerifiedCastellano;

  const hasExplicitLatino =
    !isMultiSubWithoutMultiAudio &&
    (hasMxFlag ||
      /\b(latino|latam|es-la|es-419|spa-la|dual[\s._-]*lat|audio[\s._-]*latino|cinecalidad|pelisenhd|hackstore|megapeliculas\w*|somosmovies|yaske|dual[\s._-]*yg|dem3nt3|dmnt)\b/i.test(
        t
      ) ||
      /\.yg(?:\b|⭐|\s|$)/i.test(t));

  const hasBothSpaVariants =
    hasExplicitLatino && (hasVerifiedCastellano || (/\bspa-la\b/i.test(t) && /\[spa\]/i.test(t)));

  const hasExplicitCastellano =
    hasVerifiedCastellano ||
    hasBothSpaVariants ||
    /\baudio\s*:\s*[^\]|]*\b(?:es|esp|spa)\b/i.test(t) ||
    (hasEsFlag && !flagsAreSubtitlesOnly && !hasExplicitLatino) ||
    (!isVoseOnly &&
      !hasExplicitLatino &&
      !flagsAreSubtitlesOnly &&
      /\b(spanish|espa[ñn]ol|\besp\b|\bspa\b|dual[\s._-]*(?:esp|cast|spa))\b/i.test(t));

  const isFrenchOnlyMulti =
    (/\b(truefrench|vff|vfi|vostfr|tsundere[\s._-]*raws)\b/i.test(t) ||
      /-(?:kaf|amb3r|fw|serqph|ulysse|slay3r|franime)(?:\b|\.|\[|\s|\||$)/i.test(t)) &&
    !hasEsFlag &&
    !/\b(castellano|spanish|espa[ñn]ol|\bspa\b)\b/i.test(t);

  const isOtherNonSpanishMulti =
    (/\b(phdteam|v3sp4ev3r)\b/i.test(t) ||
      /\bita[\s._-]+eng\b/i.test(t) ||
      /-(?:afg|msd)(?:\b|\.|\[|\s|\||$)/i.test(t)) &&
    !hasEsFlag &&
    !/\b(castellano|spanish|espa[ñn]ol|\bspa\b)\b/i.test(t);

  const isCrunchyrollImplicitSub =
    !isFrenchOnlyMulti &&
    !isOtherNonSpanishMulti &&
    !/\b(eng(?:lish)?[\s._-]*subs?(?:[\s._-]*only)?|dubbed[\s._-]*only)\b/i.test(t) &&
    /\bcr[\s._-]*(?:web-?dl|webrip)\b/i.test(t) &&
    !/\b(erai-raws|toonshub|nandesuka|multisub|multi-subs|multi[\s._-]*subs?|multiple[\s._-]*subtitle)\b/i.test(t);

  const hasMultiSub =
    !isOtherNonSpanishMulti &&
    ((flagsAreSubtitlesOnly && hasEsFlag) ||
      isCrunchyrollImplicitSub ||
      /\b(erai-raws|toonshub|nandesuka|multisub|multi-subs|multi[\s._-]*subs?|multiple[\s._-]*subtitle|multi[\s._-]*language)\b/i.test(
        t
      ) ||
      (!isFrenchOnlyMulti && /(?<![-\w])multi(?![-\w])/i.test(t)));

  const hasVerifiedSpanishInMultiSub =
    hasMultiSub &&
    (hasEsFlag ||
      isCrunchyrollImplicitSub ||
      /\b(erai-raws|toonshub|judas|nandesuka|\bspa\b|\besp\b|spanish|castellano|espa[ñn]ol)\b/i.test(t));

  const hasSpanishSub =
    hasMultiSub ||
    isVoseOnly ||
    /\b(sub[\s._-]*(?:esp|spa|castellano|latino|espa[ñn]ol)|subs?[\s._-]*(?:es\b|es-en|spa\b)|\[sub\.?\s*espa[ñn]ol\])\b/i.test(
      t
    );

  const hasMultiAudio =
    !isFrenchOnlyMulti &&
    ((/\b(multi[\s._-]*audio|dual[\s._-]*audio|\bdual\b|\bmulti\b)\b/i.test(t) &&
      !/\b(multisub|multi-subs|multi[\s._-]*sub)\b/i.test(t)) ||
      (hasFilenameSpaAudio && flagCount >= 3 && !flagsAreSubtitlesOnly));

  const hasEngDubOnly = /\b(eng(?:lish)?[\s._-]*dub(?:[\s._-]*only)?|dubbed[\s._-]*only)\b/i.test(t);
  const hasJapaneseAudio =
    hasJpFlag ||
    /\b(japanese|japon[eé]s|\bjpn\b|\bjap\b|erai-raws|subsplease|toonshub)\b/i.test(t);

  const isKnownEnglishGroup =
    !hasEsFlag &&
    !hasJpFlag &&
    !hasExplicitCastellano &&
    !hasExplicitLatino &&
    (isEnglishSceneWebDl || /\b(yts|yify|galaxyrg\w*|galaxytv|psa|rarbg|qxr|vyndros|tigole|rmteam|megusta|ezx)\b/i.test(t));

  const hasEnglishAudio =
    !isMultiSubWithoutMultiAudio &&
    (hasGbFlag || hasEngDubOnly || isKnownEnglishGroup || /\b(english|\beng\b|truehd\s+eng|eac3.*eng)\b/i.test(t));

  const hasEnglishSub =
    hasMultiSub || /\b(subsplease|eng(?:lish)?[\s._-]*subs?|sub[\s._-]*eng|es-en)\b/i.test(t);

  const badges = [];
  if (hasExplicitCastellano) badges.push('🇪🇸 Castellano');
  if (hasExplicitLatino) badges.push('🇲🇽 Latino');
  if (hasJapaneseAudio) badges.push('🇯🇵 Japonés');
  if (hasEnglishAudio) badges.push('🇬🇧 Inglés');
  if (hasMultiAudio) badges.push('🌐 Multi-Audio');
  if (!flagsAreSubtitlesOnly) {
    if (isFrenchOnlyMulti || hasFrFlag || /\b(french|truefrench|vff|vf\b|vostfr)\b/i.test(t)) badges.push('🇫🇷 Francés');
    if (hasItFlag || /\b(\bita\b|italiano)\b/i.test(t)) badges.push('🇮🇹 Italiano');
    if (hasDeFlag || /\b(german|deutsch|\bger\b)\b/i.test(t)) badges.push('🇩🇪 Alemán');
    if (hasPtFlag) badges.push('🇧🇷 Portugués');
    if (hasRuFlag || /\b(\brus\b|russian)\b/i.test(t)) badges.push('🇷🇺 Ruso');
  }

  if (hasMultiSub) badges.push(hasVerifiedSpanishInMultiSub ? '💬 MultiSub (incl. ES)' : '💬 MultiSub');
  else if (hasSpanishSub) badges.push('💬 Sub Español');
  else if (hasEnglishSub) badges.push('💬 Sub Inglés');

  let resolution = 'SD';
  if (/\b(2160[pi]?|3840x2160)\b|\b4k(?:web-?rip|web-?dl|microhd|hdr\w*|uhd|bdremux|remux|\b)/i.test(t)) {
    resolution = '4K';
  } else if (
    /\b(1080[pi]|1920x1080|fhd)\b|(?:x26[45]|h\.?26[45]|hevc|avc|bluray|bdrip|bd|web-?dl|webrip|\[)[\s._-]*1080(?:\]|\b)/i.test(
      t
    )
  ) {
    resolution = '1080p';
  } else if (
    /\b(720[pi]|1280x720|hdrip|microhd)\b|(?:x26[45]|h\.?26[45]|hevc|bluray|bd|web-?dl|webrip|\[)[\s._-]*720(?:\]|\b)/i.test(
      t
    )
  ) {
    resolution = '720p';
  } else if (/\buhd\b/i.test(t)) {
    resolution = '4K';
  }

  const codecTags = [];
  if (/\bav1\b/i.test(t)) codecTags.push('AV1');
  else if (/\b(hevc|x265|h\.?265)\b/i.test(t)) codecTags.push('HEVC');
  else if (/\b(avc|x264|h\.?264)\b/i.test(t)) codecTags.push('H.264');

  if (/\b(dovi|dolby[\s._-]*vision|\bdv\b)\b/i.test(t)) codecTags.push('DV');
  if (/\b(hdr10\+?|hdr)\b/i.test(t)) codecTags.push('HDR');
  if (/\b10[\s._-]*bits?\b/i.test(t)) codecTags.push('10-bit');

  if (/\b(bdremux|uhdremux|remux)\b/i.test(t)) codecTags.push('BDRemux');
  else if (/\bmicrohd\b/i.test(t)) codecTags.push('MicroHD');
  else if (/\b(bluray|bdrip|brrip|\bbd\b)\b/i.test(t)) codecTags.push('BluRay');
  else if (/\b(web-dl|webdl|webrip|amzn|nf|dsnp|atvp|hmax)\b/i.test(t)) codecTags.push('WEB-DL');
  else if (/\bhdtv\b/i.test(t)) codecTags.push('HDTV');
  else if (/\bdvdrip\b/i.test(t)) codecTags.push('DVDRip');

  const { displayTitle, subFileTitle } = parseCleanCandidateNames(t);

  return {
    hasExplicitCastellano,
    hasVerifiedCastellano,
    hasExplicitLatino,
    hasJapaneseAudio,
    hasEnglishAudio,
    hasMultiAudio,
    hasEngDubOnly,
    hasMultiSub,
    hasVerifiedSpanishInMultiSub,
    isCrunchyrollImplicitSub,
    hasSpanishSub,
    hasEnglishSub,
    isVoseOnly,
    resolution,
    codecTags,
    displayTitle,
    subFileTitle,
    badges: badges.length > 0 ? badges : ['🌐 Idioma sin especificar'],
  };
}

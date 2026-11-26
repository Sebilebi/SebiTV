/**
 * Perfiles separados de preferencias de idioma y subtítulos:
 * 1. Perfil Anime (Series, OVAs y Películas de Anime)
 * 2. Perfil Series y Películas (Cine comercial y series occidentales)
 */

export const DEFAULT_PREFERENCES = {
  anime: {
    audioPrimary: 'ja', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any'
    audioSecondary: 'es-ES', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any' | 'none'
    audioOther: 'any', // 'ja' | 'es-ES' | 'es-419' | 'en' | 'any' | 'none'
    subPrimary: 'es-ES', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any'
    subSecondary: 'es-419', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any' | 'none'
    subOther: 'none', // 'es-ES' | 'es-419' | 'en' | 'off' | 'any' | 'none'
    allowSpanishAudioWithoutSubs: true, // Si está doblado al Castellano (ej. Doraemon), no exigir subtítulos
  },
  regular: {
    audioPrimary: 'es-ES',
    audioSecondary: 'none',
    audioOther: 'none',
    subPrimary: 'off',
    subSecondary: 'none',
    subOther: 'none',
    allowSpanishAudioWithoutSubs: true,
  },
};

export function getPreferences(db) {
  const raw = db?.getSetting?.('languagePreferences');
  if (!raw) return structuredClone(DEFAULT_PREFERENCES);
  try {
    const parsed = JSON.parse(raw);
    return {
      anime: { ...DEFAULT_PREFERENCES.anime, ...(parsed.anime || {}) },
      regular: { ...DEFAULT_PREFERENCES.regular, ...(parsed.regular || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_PREFERENCES);
  }
}

export function savePreferences(db, incoming = {}) {
  const current = getPreferences(db);
  const next = {
    anime: { ...current.anime, ...(incoming.anime || {}) },
    regular: { ...current.regular, ...(incoming.regular || {}) },
  };
  db.setSetting('languagePreferences', JSON.stringify(next));
  return next;
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

  const hasVerifiedCastellano =
    /\b(castellano|espa[ñn]ol\s+de\s+espa[ñn]a|es-es|dontorrent|mejortorrent|wolfmax\w*|atomohd|pctnew|newpct|pctmix|selecta[\s._-]*visi[oó]n|eth@n|bryan_122|mony2007)\b/i.test(
      t
    );

  // En releases AMZN/NF WEB-DL (ej. FLUX/Rapta), Torrentio lista 20+ banderas de subtítulos sin "Multi Audio"/"Dual Audio"
  const flagsAreSubtitlesOnly =
    flagCount >= 6 &&
    !/\b(multi[\s._-]*audio|dual[\s._-]*audio)\b/i.test(t) &&
    !hasVerifiedCastellano;

  const isVoseOnly =
    /\b(vose|v\.o\.s\.e\.?|subtitulad[oa]|sub[\s._-]*esp(?:a[ñn]ol)?)\b/i.test(t) &&
    !/\b(dual|multi[\s._-]*audio|castellano\s+ac3|ac3.*castellano)\b/i.test(t) &&
    !hasVerifiedCastellano;

  const hasExplicitLatino =
    hasMxFlag ||
    /\b(latino|latam|es-la|es-419|audio[\s._-]*latino|cinecalidad|dual[\s._-]*yg)\b/i.test(t) ||
    /\.yg(?:\b|⭐|\s|$)/i.test(t);

  const hasExplicitCastellano =
    hasVerifiedCastellano ||
    (hasEsFlag && !flagsAreSubtitlesOnly && !hasExplicitLatino) ||
    (!isVoseOnly &&
      !hasExplicitLatino &&
      !flagsAreSubtitlesOnly &&
      /\b(spanish|espa[ñn]ol|\besp\b|dual[\s._-]*(?:esp|cast|spa))\b/i.test(t));

  const isFrenchOnlyMulti = /\b(truefrench|vff|vfi|vostfr)\b/i.test(t) && !hasEsFlag && !/\b(castellano|spanish|espa[ñn]ol)\b/i.test(t);

  const hasMultiSub =
    (flagsAreSubtitlesOnly && hasEsFlag) ||
    /\b(erai-raws|toonshub|nandesuka|multisub|multi-subs|multi[\s._-]*subs?|multiple[\s._-]*subtitle|multi[\s._-]*language)\b/i.test(
      t
    ) ||
    (!isFrenchOnlyMulti && /(?<![-\w])multi(?![-\w])/i.test(t));

  const hasSpanishSub =
    hasMultiSub ||
    isVoseOnly ||
    /\b(sub[\s._-]*(?:esp|spa|castellano|latino|espa[ñn]ol)|subs?[\s._-]*(?:es\b|es-en|spa\b)|\[sub\.?\s*espa[ñn]ol\])\b/i.test(
      t
    );

  const hasMultiAudio =
    /\b(multi[\s._-]*audio|dual[\s._-]*audio|\bdual\b|\bmulti\b)\b/i.test(t) &&
    !/\b(multisub|multi-subs|multi[\s._-]*sub)\b/i.test(t);

  const hasEngDubOnly = /\b(eng(?:lish)?[\s._-]*dub(?:[\s._-]*only)?|dubbed[\s._-]*only)\b/i.test(t);
  const hasJapaneseAudio =
    hasJpFlag ||
    /\b(japanese|japon[eé]s|\bjpn\b|\bjap\b|erai-raws|subsplease|toonshub)\b/i.test(t);

  const hasEnglishAudio =
    hasGbFlag || hasEngDubOnly || /\b(english|\beng\b|truehd\s+eng|eac3.*eng)\b/i.test(t);

  const hasEnglishSub =
    hasMultiSub || /\b(subsplease|eng(?:lish)?[\s._-]*subs?|sub[\s._-]*eng|es-en)\b/i.test(t);

  const badges = [];
  if (hasExplicitCastellano) badges.push('🇪🇸 Castellano');
  if (hasExplicitLatino) badges.push('🇲🇽 Latino');
  if (hasJapaneseAudio) badges.push('🇯🇵 Japonés');
  if (hasEnglishAudio) badges.push('🇬🇧 Inglés');
  if (hasMultiAudio) badges.push('🌐 Multi-Audio');
  if (hasFrFlag || /\b(french|truefrench|vff|vf\b|vostfr)\b/i.test(t)) badges.push('🇫🇷 Francés');
  if (hasItFlag || /\b(\bita\b|italiano)\b/i.test(t)) badges.push('🇮🇹 Italiano');
  if (hasDeFlag || /\b(german|deutsch|\bger\b)\b/i.test(t)) badges.push('🇩🇪 Alemán');
  if (hasPtFlag) badges.push('🇧🇷 Portugués');
  if (hasRuFlag || /\b(\brus\b|russian)\b/i.test(t)) badges.push('🇷🇺 Ruso');

  if (hasMultiSub) badges.push('💬 MultiSub (incl. ES)');
  else if (hasSpanishSub) badges.push('💬 Sub Español');
  else if (hasEnglishSub) badges.push('💬 Sub Inglés');

  let resolution = 'SD';
  if (/\b(2160p|4k|uhd)\b/i.test(t)) resolution = '4K';
  else if (/\b(1080p|1920x1080|fhd)\b/i.test(t)) resolution = '1080p';
  else if (/\b(720p|1280x720)\b/i.test(t)) resolution = '720p';

  return {
    hasExplicitCastellano,
    hasVerifiedCastellano,
    hasExplicitLatino,
    hasJapaneseAudio,
    hasEnglishAudio,
    hasMultiAudio,
    hasEngDubOnly,
    hasMultiSub,
    hasSpanishSub,
    hasEnglishSub,
    isVoseOnly,
    resolution,
    badges: badges.length > 0 ? badges : ['🌐 Idioma sin especificar'],
  };
}

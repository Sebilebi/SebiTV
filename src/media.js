import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_PREFERENCES } from './preferences.js';

const execFileAsync = promisify(execFile);

export function sanitizeFileName(name = '') {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function langTag(stream) {
  return (stream?.tags?.language || stream?.tags?.LANGUAGE || '').toLowerCase().trim();
}

function titleTag(stream) {
  return (stream?.tags?.title || stream?.tags?.TITLE || '').toLowerCase().trim();
}

const isSpanishLang = (l) => ['spa', 'es', 'es-es', 'es-419', 'es-la', 'es-mx', 'castilian'].includes(l);
const isJapaneseLang = (l) => ['jpn', 'ja', 'jp'].includes(l);
const isEnglishLang = (l) => ['eng', 'en', 'en-us', 'en-gb'].includes(l);
const isLatinoLabel = (t, l) =>
  ['es-419', 'es-la', 'es-mx'].includes(l) || /\b(latin|latino|latam|419|la\b|mex)/i.test(t);
const isCastellanoLabel = (t, l) =>
  l === 'es-es' || /\b(castellano|castilian|espa[ñn]a|spain|european|es-es|esp\b)/i.test(t);

function findAudioStreamForCode(audioStreams, code) {
  if (!code || code === 'none') return -1;
  if (code === 'any') return audioStreams.length > 0 ? 0 : -1;
  if (code === 'ja') {
    return audioStreams.findIndex(
      (s) => isJapaneseLang(langTag(s)) || /\b(japanese|japon[eé]s|jpn)\b/i.test(titleTag(s))
    );
  }
  if (code === 'es-ES') {
    const idx = audioStreams.findIndex((s) => {
      const l = langTag(s);
      const t = titleTag(s);
      if (isLatinoLabel(t, l)) return false;
      return isSpanishLang(l) || isCastellanoLabel(t, l);
    });
    if (idx >= 0) return idx;
    // Rips españoles de 1 sola pista sin etiqueta de idioma
    if (
      audioStreams.length === 1 &&
      !['eng', 'en', 'jpn', 'ja', 'fre', 'fra', 'ger', 'deu', 'ita', 'por', 'rus'].includes(
        langTag(audioStreams[0])
      ) &&
      !isLatinoLabel(titleTag(audioStreams[0]), langTag(audioStreams[0]))
    ) {
      return 0;
    }
    return -1;
  }
  if (code === 'es-419') {
    const idx = audioStreams.findIndex((s) => isLatinoLabel(titleTag(s), langTag(s)));
    if (idx >= 0) return idx;
    return audioStreams.findIndex((s) => isSpanishLang(langTag(s)));
  }
  if (code === 'en') {
    return audioStreams.findIndex(
      (s) => isEnglishLang(langTag(s)) || /\b(english|ingl[eé]s)\b/i.test(titleTag(s))
    );
  }
  return -1;
}

function findSubtitleStreamForCode(subStreams, code) {
  if (!code || code === 'none' || code === 'off') return null;

  const fullSubs = subStreams
    .map((s, pos) => ({ s, pos, lang: langTag(s), title: titleTag(s) }))
    .filter(({ s, title }) => !s.disposition?.forced && !/\b(signs|songs|forced|forzado)\b/i.test(title));

  if (code === 'any') {
    return fullSubs[0] ? { ...fullSubs[0], subKind: fullSubs[0].lang || 'any' } : null;
  }

  const spanishSubs = fullSubs.filter(
    ({ lang, title }) =>
      isSpanishLang(lang) || /\b(spanish|espa[ñn]ol|castellano|castilian|latino)\b/i.test(title)
  );
  const hasExplicitLatino = spanishSubs.some(({ title, lang }) => isLatinoLabel(title, lang));

  if (code === 'es-ES') {
    let chosen = spanishSubs.find(({ title, lang }) => isCastellanoLabel(title, lang));
    if (!chosen && hasExplicitLatino) {
      chosen = spanishSubs.find(({ title, lang }) => !isLatinoLabel(title, lang));
    }
    if (!chosen && spanishSubs.length === 1 && !hasExplicitLatino) {
      chosen = spanishSubs[0];
    }
    return chosen ? { ...chosen, subKind: 'es-ES' } : null;
  }

  if (code === 'es-419') {
    const chosen =
      spanishSubs.find(({ title, lang }) => isLatinoLabel(title, lang)) || spanishSubs[0] || null;
    return chosen ? { ...chosen, subKind: 'es-419' } : null;
  }

  if (code === 'en') {
    const chosen = fullSubs.find(
      ({ lang, title }) => isEnglishLang(lang) || /\b(english|ingl[eé]s)\b/i.test(title)
    );
    return chosen ? { ...chosen, subKind: 'en' } : null;
  }

  return null;
}

/**
 * Analiza las pistas reales de audio y subtítulos con el Perfil de Preferencias del usuario
 * (o respeta cualquier pista si `manualOverride: true` al descargar desde la Lupa 🔍).
 */
export function evaluateMediaStreams(
  streams = [],
  { isAnime, preferences = DEFAULT_PREFERENCES, manualOverride = false }
) {
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const profile = isAnime
    ? { ...DEFAULT_PREFERENCES.anime, ...(preferences?.anime || {}) }
    : { ...DEFAULT_PREFERENCES.regular, ...(preferences?.regular || {}) };

  // Si el usuario eligió el torrent manualmente desde la Lupa 🔍, nunca rechazar por idioma
  if (manualOverride) {
    return {
      valid: true,
      manualOverride: true,
      preferredAudioTrackNumber: 1,
      preferredSubTrackNumber: subStreams.length > 0 ? 1 : null,
      disableAllFullSubs: false,
      totalAudioTracks: audioStreams.length,
      totalSubTracks: subStreams.length,
    };
  }

  // 1. Buscar mejor pista de audio según [Primario, Secundario, Otros]
  const audioTiers = [profile.audioPrimary, profile.audioSecondary, profile.audioOther];
  let chosenAudioPos = -1;
  let matchedAudioCode = null;

  for (const code of audioTiers) {
    const idx = findAudioStreamForCode(audioStreams, code);
    if (idx >= 0) {
      chosenAudioPos = idx;
      matchedAudioCode = code;
      break;
    }
  }

  if (chosenAudioPos < 0) {
    return {
      valid: false,
      needsExternalSub: false,
      reason: `El vídeo no contiene ninguna pista de audio compatible con tus preferencias (${audioTiers
        .filter((x) => x && x !== 'none')
        .join(' > ')}).`,
    };
  }

  // 2. Si los subtítulos están en 'off' -> desactivar todos los subtítulos completos
  if (profile.subPrimary === 'off') {
    return {
      valid: true,
      preferredAudioTrackNumber: chosenAudioPos + 1,
      preferredSubTrackNumber: null,
      disableAllFullSubs: true,
      totalAudioTracks: audioStreams.length,
      totalSubTracks: subStreams.length,
    };
  }

  // 3. Buscar mejor pista de subtítulos según [Primario, Secundario, Otros]
  const subTiers = [profile.subPrimary, profile.subSecondary, profile.subOther];
  let chosenSub = null;
  for (const code of subTiers) {
    if (code === 'off') {
      return {
        valid: true,
        preferredAudioTrackNumber: chosenAudioPos + 1,
        preferredSubTrackNumber: null,
        disableAllFullSubs: true,
        totalAudioTracks: audioStreams.length,
        totalSubTracks: subStreams.length,
      };
    }
    const found = findSubtitleStreamForCode(subStreams, code);
    if (found) {
      chosenSub = found;
      break;
    }
    if (code === 'any') {
      return {
        valid: true,
        subKind: 'none-optional',
        preferredAudioTrackNumber: chosenAudioPos + 1,
        preferredSubTrackNumber: null,
        disableAllFullSubs: false,
        totalAudioTracks: audioStreams.length,
        totalSubTracks: subStreams.length,
      };
    }
  }

  if (chosenSub) {
    return {
      valid: true,
      subKind: chosenSub.subKind,
      preferredAudioTrackNumber: chosenAudioPos + 1,
      preferredSubTrackNumber: chosenSub.pos + 1,
      disableAllFullSubs: false,
      totalAudioTracks: audioStreams.length,
      totalSubTracks: subStreams.length,
    };
  }

  // 4. Si no hay subtítulos requeridos, pero el vídeo ya tiene Audio Español Castellano y el perfil lo permite (ej. Doraemon doblado)
  const castAudioPos = findAudioStreamForCode(audioStreams, 'es-ES');
  if (profile.allowSpanishAudioWithoutSubs && (matchedAudioCode === 'es-ES' || castAudioPos >= 0)) {
    return {
      valid: true,
      subKind: 'dubbed-es-ES',
      preferredAudioTrackNumber: (castAudioPos >= 0 ? castAudioPos : chosenAudioPos) + 1,
      preferredSubTrackNumber: null,
      disableAllFullSubs: true,
      totalAudioTracks: audioStreams.length,
      totalSubTracks: subStreams.length,
    };
  }

  const wantsSpanishSub = subTiers.some((c) => c === 'es-ES' || c === 'es-419');
  return {
    valid: false,
    needsExternalSub: wantsSpanishSub,
    reason: `El archivo no incluye subtítulos compatibles con tus preferencias (${subTiers
      .filter((x) => x && x !== 'none')
      .join(' > ')}).`,
    preferredAudioTrackNumber: chosenAudioPos + 1,
    preferredSubTrackNumber: null,
  };
}

export async function probeMediaStreams(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_streams',
    filePath,
  ]);
  const parsed = JSON.parse(stdout || '{}');
  return parsed.streams || [];
}

export async function applyMkvTrackDefaults(filePath, evalResult) {
  if (!filePath.toLowerCase().endsWith('.mkv') || evalResult?.manualOverride) return;
  const args = [filePath];

  for (let i = 1; i <= (evalResult.totalAudioTracks || 0); i++) {
    const isDef = i === evalResult.preferredAudioTrackNumber ? '1' : '0';
    args.push('--edit', `track:a${i}`, '--set', `flag-default=${isDef}`);
  }

  for (let i = 1; i <= (evalResult.totalSubTracks || 0); i++) {
    if (evalResult.disableAllFullSubs) {
      args.push('--edit', `track:s${i}`, '--set', 'flag-default=0');
    } else {
      const isDef = i === evalResult.preferredSubTrackNumber ? '1' : '0';
      args.push('--edit', `track:s${i}`, '--set', `flag-default=${isDef}`);
    }
  }

  if (args.length <= 1) return;
  try {
    await execFileAsync('mkvpropedit', args);
  } catch {
    // Continuar si el contenedor no admite edición EBML
  }
}

export async function fetchExternalSpanishSubtitle({
  subdlApiKey,
  imdbId,
  tmdbId,
  seasonNumber,
  episodeNumber,
  destVideoPath,
}) {
  if (!subdlApiKey) return null;
  const url = new URL('https://api.subdl.com/api/v1/subtitles');
  url.searchParams.set('api_key', subdlApiKey);
  if (imdbId) url.searchParams.set('imdb_id', imdbId);
  else if (tmdbId) url.searchParams.set('tmdb_id', String(tmdbId));
  if (seasonNumber !== undefined && seasonNumber !== null) {
    url.searchParams.set('season_number', String(seasonNumber));
    url.searchParams.set('episode_number', String(episodeNumber));
    url.searchParams.set('type', 'tv');
  } else {
    url.searchParams.set('type', 'movie');
  }
  url.searchParams.set('languages', 'ES');

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const subs = data?.subtitles || [];
    if (subs.length === 0) return null;

    const sorted = [...subs].sort((a, b) => {
      const aCast = /castellano|espa[ñn]a|es-es/i.test(`${a.release_name || ''} ${a.comment || ''}`) ? 1 : 0;
      const bCast = /castellano|espa[ñn]a|es-es/i.test(`${b.release_name || ''} ${b.comment || ''}`) ? 1 : 0;
      return bCast - aCast;
    });

    const chosen = sorted[0];
    if (!chosen?.url) return null;
    const dlUrl = chosen.url.startsWith('http') ? chosen.url : `https://dl.subdl.com${chosen.url}`;
    const zipRes = await fetch(dlUrl, { signal: AbortSignal.timeout(15000) });
    if (!zipRes.ok) return null;
    const buf = Buffer.from(await zipRes.arrayBuffer());
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      const tmpZip = `${destVideoPath}.subtmp.zip`;
      fs.writeFileSync(tmpZip, buf);
      try {
        const { stdout } = await execFileAsync('unzip', ['-Z1', tmpZip]);
        const subEntry = stdout
          .split('\n')
          .map((l) => l.trim())
          .find((l) => /\.(srt|ass|ssa|vtt)$/i.test(l));
        if (!subEntry) return null;
        const ext = path.extname(subEntry).toLowerCase();
        const baseNoExt = destVideoPath.slice(0, destVideoPath.length - path.extname(destVideoPath).length);
        const finalSubPath = `${baseNoExt}.es.default${ext}`;
        const { stdout: subContent } = await execFileAsync('unzip', ['-p', tmpZip, subEntry], {
          encoding: 'buffer',
          maxBuffer: 20 * 1024 * 1024,
        });
        fs.writeFileSync(finalSubPath, subContent);
        return finalSubPath;
      } finally {
        fs.rmSync(tmpZip, { force: true });
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function writeTvShowSkeleton(seriesDir, details) {
  fs.mkdirSync(seriesDir, { recursive: true });
  const nfoPath = path.join(seriesDir, 'tvshow.nfo');
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<tvshow>',
    `  <title>${escapeXml(details.title)}</title>`,
    details.originalTitle ? `  <originaltitle>${escapeXml(details.originalTitle)}</originaltitle>` : '',
    details.year ? `  <year>${details.year}</year>` : '',
    details.overview ? `  <plot>${escapeXml(details.overview)}</plot>` : '',
    `  <tmdbid>${details.tmdbId}</tmdbid>`,
    details.imdbId ? `  <imdb_id>${escapeXml(details.imdbId)}</imdb_id>` : '',
    details.tvdbId ? `  <tvdbid>${details.tvdbId}</tvdbid>` : '',
    details.posterUrl ? `  <thumb aspect="poster">${escapeXml(details.posterUrl)}</thumb>` : '',
    details.backdropUrl ? `  <fanart><thumb>${escapeXml(details.backdropUrl)}</thumb></fanart>` : '',
    '</tvshow>',
  ].filter(Boolean);

  fs.writeFileSync(nfoPath, lines.join('\n'), 'utf8');

  for (const s of details.seasons || []) {
    const seasonFolder =
      s.seasonNumber === 0 ? 'Season 00' : `Season ${String(s.seasonNumber).padStart(2, '0')}`;
    fs.mkdirSync(path.join(seriesDir, seasonFolder), { recursive: true });
  }
}

export function writeMovieNfo(movieDir, details) {
  fs.mkdirSync(movieDir, { recursive: true });
  const nfoPath = path.join(movieDir, 'movie.nfo');
  const lines = [
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<movie>',
    `  <title>${escapeXml(details.title)}</title>`,
    details.originalTitle ? `  <originaltitle>${escapeXml(details.originalTitle)}</originaltitle>` : '',
    details.year ? `  <year>${details.year}</year>` : '',
    details.overview ? `  <plot>${escapeXml(details.overview)}</plot>` : '',
    `  <tmdbid>${details.tmdbId}</tmdbid>`,
    details.imdbId ? `  <imdbid>${escapeXml(details.imdbId)}</imdbid>` : '',
    details.posterUrl ? `  <thumb aspect="poster">${escapeXml(details.posterUrl)}</thumb>` : '',
    '</movie>',
  ].filter(Boolean);
  fs.writeFileSync(nfoPath, lines.join('\n'), 'utf8');
}

export function hardlinkOrCopy(srcPath, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (fs.existsSync(destPath)) {
    fs.rmSync(destPath, { force: true });
  }
  try {
    fs.linkSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
  }
}

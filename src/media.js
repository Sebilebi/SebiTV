import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

/**
 * Analiza las pistas reales de audio y subtítulos de un vídeo y decide si cumple
 * las reglas del usuario:
 * - Anime: Audio Japonés preferido + Subtítulos Español (Castellano > Latino) OBLIGATORIOS.
 * - No-Anime: Audio Español Castellano OBLIGATORIO y subtítulos desactivados.
 */
export function evaluateMediaStreams(streams = [], { isAnime }) {
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const subStreams = streams.filter((s) => s.codec_type === 'subtitle');

  const isSpanishLang = (l) => ['spa', 'es', 'es-es', 'es-419', 'es-la', 'es-mx', 'castilian'].includes(l);
  const isJapaneseLang = (l) => ['jpn', 'ja', 'jp'].includes(l);
  const isLatinoLabel = (t, l) =>
    ['es-419', 'es-la', 'es-mx'].includes(l) || /\b(latin|latino|latam|419|la\b|mex)/i.test(t);
  const isCastellanoLabel = (t, l) =>
    l === 'es-es' || /\b(castellano|castilian|espa[ñn]a|spain|european|es-es|esp\b)/i.test(t);

  if (isAnime) {
    // 1. Audio preferido: Japonés (o primer audio si solo hay uno sin etiqueta de idioma inglés exclusivo)
    const jpAudioIdx = audioStreams.findIndex(
      (s) => isJapaneseLang(langTag(s)) || /\b(japanese|japon[eé]s|jpn)\b/i.test(titleTag(s))
    );
    const esAudioIdx = audioStreams.findIndex(
      (s) => isSpanishLang(langTag(s)) || isCastellanoLabel(titleTag(s), langTag(s))
    );

    const chosenAudioPos = jpAudioIdx >= 0 ? jpAudioIdx : esAudioIdx >= 0 ? esAudioIdx : 0;

    // 2. Subtítulos obligatorios: 1º Español España (Castellano) -> 2º Español Latino
    // Detalle clave de Crunchyroll / Erai-raws: suelen incluir dos pistas 'spa':
    // una con title="Spanish (Latin America)" y otra con title="Spanish" o "Spanish (Spain)" (Castellano).
    const spanishSubs = subStreams
      .map((s, pos) => ({ s, pos, lang: langTag(s), title: titleTag(s) }))
      .filter(
        ({ lang, title }) =>
          isSpanishLang(lang) || /\b(spanish|espa[ñn]ol|castellano|castilian|latino)\b/i.test(title)
      )
      // Ignorar pistas que sean únicamente "Signs & Songs" / "Forzados" cuando buscamos diálogos completos
      .filter(({ s, title }) => !s.disposition?.forced && !/\b(signs|songs|forced|forzado)\b/i.test(title));

    const hasExplicitLatino = spanishSubs.some(({ title, lang }) => isLatinoLabel(title, lang));

    // Prioridad 1: Etiqueta explícita Castellano / España, O pista 'Spanish' genérica cuando coexiste con 'Latin America'
    let chosenSub = spanishSubs.find(({ title, lang }) => isCastellanoLabel(title, lang));
    if (!chosenSub && hasExplicitLatino) {
      chosenSub = spanishSubs.find(({ title, lang }) => !isLatinoLabel(title, lang));
    }

    let subKind = null;
    if (chosenSub) {
      subKind = 'es-ES';
    } else if (spanishSubs.length > 0) {
      // Prioridad 2: Español Latino o pista española única
      chosenSub = spanishSubs[0];
      subKind = isLatinoLabel(chosenSub.title, chosenSub.lang) ? 'es-419' : 'es';
    }

    if (!chosenSub) {
      return {
        valid: false,
        needsExternalSub: true,
        reason: 'El archivo de anime no incluye subtítulos completos en Español (ni Castellano ni Latino).',
        preferredAudioTrackNumber: chosenAudioPos + 1,
        preferredSubTrackNumber: null,
      };
    }

    return {
      valid: true,
      subKind,
      preferredAudioTrackNumber: chosenAudioPos + 1, // 1-indexed para mkvpropedit (audio:a1, a2...)
      preferredSubTrackNumber: chosenSub.pos + 1, // 1-indexed para mkvpropedit (sub:s1, s2...)
      disableAllFullSubs: false,
      totalAudioTracks: audioStreams.length,
      totalSubTracks: subStreams.length,
    };
  }

  // NO-ANIME (Series comerciales y Películas): Audio Castellano obligatorio y SIN subtítulos activos
  const castAudioPos = audioStreams.findIndex(({ tags, ...rest }) => {
    const s = { tags, ...rest };
    const l = langTag(s);
    const t = titleTag(s);
    if (isLatinoLabel(t, l)) return false;
    return isSpanishLang(l) || isCastellanoLabel(t, l);
  });

  // Si solo tiene 1 pista de audio sin etiqueta de idioma (frecuente en rips españoles AVI/MKV de DonTorrent), es válida
  const singleUnlabeledValid =
    audioStreams.length === 1 &&
    !['eng', 'en', 'jpn', 'ja', 'fre', 'fra', 'ger', 'deu', 'ita', 'por', 'rus'].includes(langTag(audioStreams[0])) &&
    !isLatinoLabel(titleTag(audioStreams[0]), langTag(audioStreams[0]));

  if (castAudioPos < 0 && !singleUnlabeledValid) {
    return {
      valid: false,
      needsExternalSub: false,
      reason: 'El vídeo no contiene pista de audio en Español Castellano.',
    };
  }

  return {
    valid: true,
    preferredAudioTrackNumber: (castAudioPos >= 0 ? castAudioPos : 0) + 1,
    preferredSubTrackNumber: null,
    disableAllFullSubs: true,
    totalAudioTracks: audioStreams.length,
    totalSubTracks: subStreams.length,
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

/**
 * Ajusta los flags default/forced dentro de un archivo .mkv en <0.5s sin recodificar vídeo.
 * IMPORTANTE: Solo se aplica sobre una copia si no comparte hardlink activo de subida, o bien
 * como mkvpropedit modifica cabeceras EBML in-place (~pocos bytes), lo ejecutamos únicamente si
 * el torrent no necesita seguir haciendo seed estricto, o dejamos intacto el bloque si falla.
 */
export async function applyMkvTrackDefaults(filePath, evalResult) {
  if (!filePath.toLowerCase().endsWith('.mkv')) return;
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
    // Si mkvpropedit no está disponible o el contenedor no es Matroska estándar, continuar sin romper
  }
}

/**
 * Búsqueda opcional de subtítulo externo (.es.srt) vía Subdl API si un anime no trae subtítulos internos
 */
export async function fetchExternalSpanishSubtitle({ subdlApiKey, imdbId, tmdbId, seasonNumber, episodeNumber, destVideoPath }) {
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

    // Preferir Castellano / España frente a Latino si aparece en el release_name/comment
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
    // Subdl entrega .zip; guardamos solo si es texto directo o informamos no comprimido
    const buf = Buffer.from(await zipRes.arrayBuffer());
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      // Extraer primer .srt/.ass de un archivo ZIP estándar usando unzip de Alpine
      const tmpZip = `${destVideoPath}.subtmp.zip`;
      const outDir = path.dirname(destVideoPath);
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
    details.tvdbId ? `  <tvdbid>${details.tvdbId}</tvdbId>`.replace('</tvdbId>', '</tvdbid>') : '',
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

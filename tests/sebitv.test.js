import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExtSearchHtml, parseNyaaRssXml, parseTorrentioStreams } from '../src/indexers.js';
import { scoreAndFilterCandidates, selectEpisodeFileFromTorrent } from '../src/scorer.js';
import { evaluateMediaStreams } from '../src/media.js';
import { computeSlidingWindowActions } from '../src/engine.js';
import { SebiDatabase } from '../src/db.js';
import { createSebiApp } from '../src/server.js';

test('Parser de ext.to y Nyaa extraen filas, tamaños, semillas e IDs correctamente', () => {
  const sampleExtHtml = `
    <table>
      <tbody>
        <tr>
          <td class="text-left">
            <div class="torrent-title-line">
              <a class="torrent-title-link" href="/juego-de-tronos-s01e01-castellano-1080p-149283/">Juego de Tronos S01E01 [Castellano] [1080p]</a>
              <div class="btn-blocks float-right">
                <a href="javascript:void(0);" class="dwn-btn search-magnet-btn" data-id="149283"></a>
              </div>
            </div>
          </td>
          <td class="nowrap-td hide-on-mob"><span>2.50 GB</span></td>
          <td class="hide-on-mob"><span>1</span></td>
          <td class="nowrap-td hide-on-mob"><span title="10 May 2026">2 weeks ago</span></td>
          <td class="hide-on-mob"><span class="text-success">48</span></td>
          <td class="hide-on-mob"><span class="text-danger">5</span></td>
          <td class="hide-on-mob"><a href="/juego-de-tronos-s01e01-castellano-1080p-149283/#technical"></a></td>
        </tr>
      </tbody>
    </table>
  `;

  const parsedExt = parseExtSearchHtml(sampleExtHtml, 'https://ext.to');
  assert.equal(parsedExt.length, 1);
  assert.equal(parsedExt[0].extId, '149283');
  assert.equal(parsedExt[0].seeders, 48);
  assert.equal(parsedExt[0].filesCount, 1);
  assert.ok(parsedExt[0].sizeBytes > 2_000_000_000);

  const sampleNyaaXml = `
    <rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa">
      <channel>
        <item>
          <title>[Erai-raws] Sousou no Frieren - 01 [1080p][Multiple Subtitle].mkv</title>
          <link>https://nyaa.si/download/12345.torrent</link>
          <guid>https://nyaa.si/view/12345</guid>
          <nyaa:seeders>620</nyaa:seeders>
          <nyaa:leechers>14</nyaa:leechers>
          <nyaa:infoHash>0123456789abcdef0123456789abcdef01234567</nyaa:infoHash>
          <nyaa:size>1.4 GiB</nyaa:size>
        </item>
      </channel>
    </rss>
  `;

  const parsedNyaa = parseNyaaRssXml(sampleNyaaXml);
  assert.equal(parsedNyaa.length, 1);
  assert.equal(parsedNyaa[0].seeders, 620);
  assert.ok(parsedNyaa[0].magnet.startsWith('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'));
});

test('Filtro de idiomas: Anime exige MultiSub/Español y Series comerciales exigen Castellano (rechazando Latino y VOSE)', () => {
  const animeCandidates = [
    { title: '[SubsPlease] Sousou no Frieren - 05 (1080p).mkv', seeders: 900, sizeBytes: 1.4e9 },
    { title: '[Erai-raws] Sousou no Frieren - 05 [1080p][Multiple Subtitle].mkv', seeders: 650, sizeBytes: 1.4e9 },
    { title: 'Frieren - S01E05 [English Dub Only] [1080p].mkv', seeders: 400, sizeBytes: 1.2e9 },
  ];

  const rankedAnime = scoreAndFilterCandidates(animeCandidates, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['Sousou no Frieren', 'Frieren'],
    seasonNumber: 1,
    episodeNumber: 5,
    allowExternalSubFallback: false,
  });

  assert.equal(rankedAnime.length, 1);
  assert.match(rankedAnime[0].title, /Erai-raws/);

  const seriesCandidates = [
    { title: 'Game of Thrones S01E01 1080p BluRay x265-ENG', seeders: 500, sizeBytes: 2e9 },
    { title: 'Juego de Tronos S01E01 Audio Latino 1080p', seeders: 300, sizeBytes: 2e9 },
    { title: 'Juego de Tronos S01E01 VOSE Sub Esp 1080p', seeders: 200, sizeBytes: 2e9 },
    { title: 'Juego de Tronos - Temporada 1 Cap.101 [Castellano] [1080p]', seeders: 45, sizeBytes: 2.1e9 },
  ];

  const rankedSeries = scoreAndFilterCandidates(seriesCandidates, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['Juego de Tronos', 'Game of Thrones'],
    seasonNumber: 1,
    episodeNumber: 1,
  });

  assert.equal(rankedSeries.length, 1);
  assert.match(rankedSeries[0].title, /Castellano/);
});

test('Selección de archivo individual dentro de Pack de Temporada ignora samples/openings y elige el capítulo exacto', () => {
  const packFiles = [
    { index: 0, name: 'Frieren S01/NCOP1.mkv', size: 90_000_000 },
    { index: 1, name: 'Frieren S01/[Erai-raws] Sousou no Frieren - 01 [1080p].mkv', size: 1_400_000_000 },
    { index: 2, name: 'Frieren S01/[Erai-raws] Sousou no Frieren - 05 [1080p].mkv', size: 1_420_000_000 },
    { index: 3, name: 'Frieren S01/Sample - 05.mkv', size: 20_000_000 },
  ];

  const chosen = selectEpisodeFileFromTorrent(packFiles, {
    seasonNumber: 1,
    episodeNumber: 5,
    absNumber: 5,
    isAnime: true,
  });
  assert.ok(chosen);
  assert.equal(chosen.index, 2);
});

test('Validador ffprobe (evaluateMediaStreams) prioriza Castellano > Latino en Anime y exige Audio Castellano sin subs en Series', () => {
  // 1. MKV de Crunchyroll / Erai-raws con Japonés + Inglés y ambos subtítulos españoles (Latino y España)
  const eraiStreams = [
    { codec_type: 'video' },
    { codec_type: 'audio', tags: { language: 'eng', title: 'English' } },
    { codec_type: 'audio', tags: { language: 'jpn', title: 'Japanese' } },
    { codec_type: 'subtitle', tags: { language: 'eng', title: 'English' } },
    { codec_type: 'subtitle', tags: { language: 'spa', title: 'Spanish (Latin America)' } },
    { codec_type: 'subtitle', tags: { language: 'spa', title: 'Spanish' } },
  ];

  const animeEval = evaluateMediaStreams(eraiStreams, { isAnime: true });
  assert.equal(animeEval.valid, true);
  assert.equal(animeEval.subKind, 'es-ES');
  assert.equal(animeEval.preferredAudioTrackNumber, 2); // Japonés
  assert.equal(animeEval.preferredSubTrackNumber, 3); // Español de España (no Latin America)

  // 2. Anime que solo tiene Español Latino -> válido como segundo fallback
  const latinoFallbackEval = evaluateMediaStreams(eraiStreams.slice(0, 5), { isAnime: true });
  assert.equal(latinoFallbackEval.valid, true);
  assert.equal(latinoFallbackEval.subKind, 'es-419');
  assert.equal(latinoFallbackEval.preferredSubTrackNumber, 2);

  // 3. Anime solo con subtítulo en inglés -> inválido ("no me sirve")
  const engOnlyAnimeEval = evaluateMediaStreams(eraiStreams.slice(0, 4), { isAnime: true });
  assert.equal(engOnlyAnimeEval.valid, false);

  // 4. Película comercial Dual (Inglés + Castellano + Subtítulos) -> activa Castellano y apaga subtítulos
  const movieDualStreams = [
    { codec_type: 'video' },
    { codec_type: 'audio', tags: { language: 'eng', title: 'English TrueHD' } },
    { codec_type: 'audio', tags: { language: 'spa', title: 'Castellano AC3' } },
    { codec_type: 'subtitle', tags: { language: 'spa', title: 'Completos Castellano' } },
  ];
  const movieEval = evaluateMediaStreams(movieDualStreams, { isAnime: false });
  assert.equal(movieEval.valid, true);
  assert.equal(movieEval.preferredAudioTrackNumber, 2);
  assert.equal(movieEval.disableAllFullSubs, true);

  // 5. Película solo en Español Latino -> rechazada para cine comercial
  const movieLatinoOnly = [
    { codec_type: 'video' },
    { codec_type: 'audio', tags: { language: 'spa', title: 'Español Latino' } },
  ];
  assert.equal(evaluateMediaStreams(movieLatinoOnly, { isAnime: false }).valid, false);
});

test('Ventana deslizante [N-1, N, N+1]: en el Cap 5 pre-descarga el 6, conserva el 4 y desinstala 1, 2 y 3 (respetando fijados)', () => {
  const episodes = [
    { id: 1, season_number: 1, episode_number: 1, status: 'available', pinned: 0 },
    { id: 2, season_number: 1, episode_number: 2, status: 'available', pinned: 1 }, // Fijado manualmente
    { id: 3, season_number: 1, episode_number: 3, status: 'available', pinned: 0 },
    { id: 4, season_number: 1, episode_number: 4, status: 'available', pinned: 0 },
    { id: 5, season_number: 1, episode_number: 5, status: 'available', pinned: 0 }, // Viendo ahora (Cap 5)
    { id: 6, season_number: 1, episode_number: 6, status: 'missing', pinned: 0 },
    { id: 7, season_number: 1, episode_number: 7, status: 'missing', pinned: 0 },
  ];

  const { prefetch, prune, keepIds } = computeSlidingWindowActions(episodes, 5, {
    behind: 1,
    ahead: 1,
    isPinnedFn: (e) => Boolean(e.pinned),
  });

  // Debe pre-descargar exclusivamente el Cap 6 (+1)
  assert.deepEqual(
    prefetch.map((e) => e.id),
    [6]
  );
  // Ventana conservada: [4, 5, 6]
  assert.deepEqual([...keepIds], [4, 5, 6]);
  // Del 3 hacia atrás: borra 1 y 3, pero respeta el 2 porque está fijado
  assert.deepEqual(
    prune.map((e) => e.id),
    [1, 3]
  );
});

test('Servidor API y SQLite arrancan y guardan ajustes dinámicos correctamente', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sebitv-test-'));
  process.env.DATA_DIR = path.join(tmpDir, 'config');
  process.env.MEDIA_ROOT = path.join(tmpDir, 'library');
  process.env.DOWNLOADS_ROOT = path.join(tmpDir, 'downloads');

  const { server, db, engine } = createSebiApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const saveRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowBehind: 1, windowAhead: 1, extBaseUrl: 'https://ext.to' }),
    });
    assert.equal(saveRes.status, 200);

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.windowBehind, 1);
    assert.equal(health.windowAhead, 1);

    // Verificar registro completo de eventos de UI y lectura por API / raw
    const logUiRes = await fetch(`${baseUrl}/api/logs/ui`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'INFO',
        action: 'ui.click_download_episode',
        message: 'Pulsó Descargar en "Naruto" Temporada 2 Capítulo 8',
        context: { tmdbId: 46260, seasonNumber: 2, episodeNumber: 8 },
      }),
    });
    assert.equal(logUiRes.status, 200);

    const logsRes = await fetch(`${baseUrl}/api/logs?limit=10`);
    const logsData = await logsRes.json();
    assert.ok(logsData.logs.some((l) => l.action === 'ui.click_download_episode'));

    const rawRes = await fetch(`${baseUrl}/api/logs/raw?lines=20`);
    const rawText = await rawRes.text();
    assert.match(rawText, /Temporada 2 Capítulo 8/);
    assert.match(rawText, /\[USER\]/);

    // Verificar guardado y lectura de perfiles separados de idioma (Anime vs Series/Películas)
    const prefSaveRes = await fetch(`${baseUrl}/api/preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anime: { audioPrimary: 'ja', audioSecondary: 'es-ES', subPrimary: 'es-ES', subSecondary: 'es-419' },
        regular: { audioPrimary: 'es-ES', audioSecondary: 'none', subPrimary: 'off' },
      }),
    });
    assert.equal(prefSaveRes.status, 200);
    const prefGet = await (await fetch(`${baseUrl}/api/preferences`)).json();
    assert.equal(prefGet.preferences.anime.audioPrimary, 'ja');
    assert.equal(prefGet.preferences.regular.subPrimary, 'off');
  } finally {
    engine.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Desambiguación de sagas (Dragon Ball Z != DAIMA/Kai), soporte 3 dígitos/rangos y modo Lupa Multi-Idioma', () => {
  const dbzPool = [
    { title: '[Z-A] Dragon Ball DAIMA - 01 [WEB] [1080p] [Sub. Español]', seeders: 10, sizeBytes: 1e9 },
    { title: 'Dragon Ball Z Kai S01E01 [MultiSub] [1080p]', seeders: 50, sizeBytes: 1e9 },
    { title: 'Dragon Ball Z 001 Remaster [V4 CC] (BDRip 1080p x265 Multi) - Ryujin', seeders: 186, sizeBytes: 2.5e9 },
  ];

  // En descarga normal: bloquea DAIMA y Kai, y acepta DBZ 001 Multi
  const normalFiltered = scoreAndFilterCandidates(dbzPool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['Dragon Ball Z', 'Bola de Dragón Z', 'Dragón Z'],
    seasonNumber: 1,
    episodeNumber: 1,
    absNumber: 1,
    allLanguages: false,
  });
  assert.equal(normalFiltered.length, 1);
  assert.match(normalFiltered[0].title, /Dragon Ball Z 001 Remaster/);

  // Doraemon clásico doblado al Castellano (rango Cap.101_113) es aceptado gracias a audioSecondary: 'es-ES'
  const doraPool = [
    {
      title: 'Doraemon - Temporada 1 [HDTV][S01E01-S01E13][[Cap.101_113]][Castellano]',
      seeders: 3,
      sizeBytes: 550e6,
    },
    { title: 'Doraemon (1979) - 01 [English Sub]', seeders: 18, sizeBytes: 300e6 },
  ];

  const doraAuto = scoreAndFilterCandidates(doraPool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['Doraemon (1979)', 'Doraemon'],
    seasonNumber: 1,
    episodeNumber: 1,
    allLanguages: false,
  });
  assert.equal(doraAuto.length, 1);
  assert.match(doraAuto[0].title, /Castellano/);

  // En modo Lupa Multi-Idioma (allLanguages: true): devuelve AMBOS idiomas etiquetados para que el usuario elija
  const doraLupa = scoreAndFilterCandidates(doraPool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['Doraemon (1979)', 'Doraemon'],
    seasonNumber: 1,
    episodeNumber: 1,
    allLanguages: true,
  });
  assert.equal(doraLupa.length, 2);
  assert.ok(doraLupa.some((c) => c.languageBadges.some((b) => b.includes('Inglés'))));
});

test('Series AMZN/NF (ej. Fallout / ESDLA): descarta falsos positivos MultiSub de 26 banderas, Dual.YG Latino y enlaces erróneos', () => {
  const falloutPool = [
    {
      source: 'imdb:ThePirateBay',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 1080p — Fallout S01E01 The End 1080p AMZN WEB-DL DDP5 1 Atmos H 264-FLUX | 👤 78 💾 4.64 GB ⚙️ ThePirateBay | 🇬🇧 / 🇯🇵 / 🇷🇺 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇰🇷 / 🇨🇳 / 🇫🇷 / 🇩🇪',
      seeders: 78,
      sizeBytes: 4.64e9,
    },
    {
      source: 'imdb:ThePirateBay',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 1080p — Fallout.2024.S01.COMPLETE.1080p.AMZN.WEB-DL.h264.Dual.YG⭐ | Fallout.S01E01.The.End.mkv | 👤 19 💾 1.7 GB ⚙️ ThePirateBay | Dual Audio / 🇪🇸',
      seeders: 19,
      sizeBytes: 1.7e9,
    },
    {
      source: 'imdb:1337x',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 1080p — Il.Rimpatriato.S01E01-10.DLMux.1080p.ITA.SPA.SUBS | Il Rimpatriato S01E01.mkv | 👤 5 💾 1.7 GB ⚙️ 1337x | 🇮🇹 / 🇪🇸',
      seeders: 5,
      sizeBytes: 1.7e9,
    },
    {
      source: 'imdb:Wolfmax4k',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — Fallout [HDTV 1080p][Cap.101] | 👤 3 💾 5.01 GB ⚙️ Wolfmax4k | 🇪🇸',
      seeders: 3,
      sizeBytes: 5.01e9,
    },
  ];

  const ranked = scoreAndFilterCandidates(falloutPool, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['Fallout'],
    seasonNumber: 1,
    episodeNumber: 1,
    allLanguages: false,
  });

  // Solo Wolfmax4k (Castellano real) pasa: FLUX (26 subs), Dual.YG (Latino) e Il Rimpatriato (otra serie) quedan descartados antes de descargar
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].source, /Wolfmax4k/);

  // Y las siglas españolas como "ESDLA" en MejorTorrent siguen pasando aunque abreviadas
  const esdlaPool = [
    {
      source: 'imdb:MejorTorrent',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 720p — ESDLA Los Anillos De Poder - Temporada 1 [HDTV 720p][Cap.101][AC3 5.1 Castellano] | 👤 22 💾 2.5 GB ⚙️ MejorTorrent | 🇪🇸',
      seeders: 22,
      sizeBytes: 2.5e9,
    },
  ];
  const rankedEsdla = scoreAndFilterCandidates(esdlaPool, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['El Señor de los Anillos: Los Anillos de Poder', 'The Lord of the Rings: The Rings of Power'],
    seasonNumber: 1,
    episodeNumber: 1,
    allLanguages: false,
  });
  assert.equal(rankedEsdla.length, 1);
});

test('v1.5.0: Anime multitemporada (S01 vs Final Season/Vigilantes/4th Season), OVAs S00, Películas de saga y MultiAudio SGF', () => {
  // 1. Torrentio con 👤 0 mantiene 0 semillas (no se convierte artificialmente en 1)
  const zeroSeedParsed = parseTorrentioStreams([
    {
      infoHash: '1111111111111111111111111111111111111111',
      name: 'Torrentio HDTV',
      title: 'Black.Mirror.3x04.HDTV.avi\n👤 0 💾 700 MB ⚙️ MejorTorrent | 🇪🇸',
    },
  ]);
  assert.equal(zeroSeedParsed[0].seeders, 0);

  // 2. My Hero Academia S01E06 NO debe confundirse con "Final Season - 06", "2nd Season - 06" ni "Vigilantes"
  const mhaS1Pool = [
    { title: '[Erai-raws] Boku no Hero Academia Final Season - 06 [1080p][MultiSub]', seeders: 45, sizeBytes: 1.3e9 },
    { title: '[Erai-raws] Boku no Hero Academia 2nd Season - 06 [1080p][MultiSub]', seeders: 30, sizeBytes: 1.3e9 },
    { title: '[Erai-raws] Vigilante: Boku no Hero Academia Illegals - 06 [1080p][MultiSub]', seeders: 35, sizeBytes: 1.3e9 },
    { title: '[Erai-raws] Boku no Hero Academia - 06 [1080p][Multiple Subtitle].mkv', seeders: 20, sizeBytes: 1.3e9 },
  ];
  const mhaS1Ranked = scoreAndFilterCandidates(mhaS1Pool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['My Hero Academia', 'Boku no Hero Academia'],
    seasonNumber: 1,
    episodeNumber: 6,
    absNumber: 6,
    totalRegularSeasons: 8,
  });
  assert.equal(mhaS1Ranked.length, 1);
  assert.equal(mhaS1Ranked[0].title, '[Erai-raws] Boku no Hero Academia - 06 [1080p][Multiple Subtitle].mkv');

  // 3. Temporada 4 Cap 10 (abs 73): rechaza "- 10" sin temporada, acepta "4th Season - 10"
  const mhaS4Pool = [
    { title: '[Erai-raws] Boku no Hero Academia - 10 [1080p][MultiSub]', seeders: 25, sizeBytes: 1.3e9 },
    { title: '[Erai-raws] Boku no Hero Academia 4th Season - 10 [1080p][MultiSub]', seeders: 15, sizeBytes: 1.3e9 },
  ];
  const mhaS4Ranked = scoreAndFilterCandidates(mhaS4Pool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['My Hero Academia', 'Boku no Hero Academia'],
    seasonNumber: 4,
    episodeNumber: 10,
    absNumber: 73,
    totalRegularSeasons: 8,
  });
  assert.equal(mhaS4Ranked.length, 1);
  assert.match(mhaS4Ranked[0].title, /4th Season - 10/);

  // 4. OVA S00E01: rechaza "Final Season - 01" y acepta OVA real
  const mhaOvaPool = [
    { title: '[Erai-raws] Boku no Hero Academia Final Season - 01 [1080p][MultiSub]', seeders: 50, sizeBytes: 1.3e9 },
    { title: '[Subs] Boku no Hero Academia OVA 01 - Save! Rescue Training! [1080p][MultiSub]', seeders: 12, sizeBytes: 800e6 },
  ];
  const mhaOvaRanked = scoreAndFilterCandidates(mhaOvaPool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['My Hero Academia', 'Boku no Hero Academia'],
    seasonNumber: 0,
    episodeNumber: 1,
    totalRegularSeasons: 8,
    episodeTitle: 'Save! Rescue Training!',
  });
  assert.equal(mhaOvaRanked.length, 1);
  assert.match(mhaOvaRanked[0].title, /OVA 01/);

  // 5. Películas de saga y comerciales: bloquea mezcla entre películas ("You're Next" en "Dos héroes") y episodios sueltos ("Hierro 08.mp4" en "Iron Man")
  const mhaMovie1Pool = [
    { title: "[Erai-raws] Boku no Hero Academia - You're Next - Movie [1080p][MultiSub]", seeders: 40, sizeBytes: 2e9 },
    { title: '[Erai-raws] My Hero Academia - Two Heroes [1080p][MultiSub]', seeders: 18, sizeBytes: 2.4e9 },
  ];
  const mhaMovie1Ranked = scoreAndFilterCandidates(mhaMovie1Pool, {
    isAnime: true,
    mediaType: 'movie',
    acceptedTitles: ['My Hero Academia: Dos héroes', 'My Hero Academia: Two Heroes', 'Boku no Hero Academia THE MOVIE: Futari no Hero'],
    year: 2018,
  });
  assert.equal(mhaMovie1Ranked.length, 1);
  assert.match(mhaMovie1Ranked[0].title, /Two Heroes/);

  const ironManPool = [
    {
      source: 'imdb:MejorTorrent',
      matchedExactImdbEpisode: true,
      title: 'Torrentio — Hierro 08.mp4 | 👤 5 💾 280 MB ⚙️ MejorTorrent | 🇪🇸',
      seeders: 5,
      sizeBytes: 280_000_000,
    },
    {
      source: 'imdb:Cinecalidad',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — Iron Man (2008) Dual Audio | 👤 15 💾 2.1 GB ⚙️ Cinecalidad | 🇪🇸',
      seeders: 15,
      sizeBytes: 2.1e9,
    },
    {
      source: 'imdb:MejorTorrent',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — Iron Man (2008) [BluRay 1080p][Castellano] | 👤 12 💾 3.4 GB ⚙️ MejorTorrent | 🇪🇸',
      seeders: 12,
      sizeBytes: 3.4e9,
    },
  ];
  const ironManRanked = scoreAndFilterCandidates(ironManPool, {
    isAnime: false,
    mediaType: 'movie',
    acceptedTitles: ['Iron Man'],
    year: 2008,
    allLanguages: false,
  });
  assert.equal(ironManRanked.length, 1);
  assert.match(ironManRanked[0].title, /Castellano/);

  // 6. The Boys S03E07 SGF Multi-Audio europeo con "Spa" + 6 banderas se reconoce como 🇪🇸 Castellano
  const boysPool = [
    {
      source: 'imdb:TorrentGalaxy',
      matchedExactImdbEpisode: true,
      hintFileIndex: 6,
      title:
        'Torrentio 4k — The.Boys.S03.Eng.Fre.Ger.Ita.Por.Spa.2160p.WEBMux.HEVC-SGF | The.Boys.S03E07.mkv | 👤 18 💾 14 GB ⚙️ TorrentGalaxy | 🇬🇧 / 🇮🇹 / 🇵🇹 / 🇪🇸 / 🇫🇷 / 🇩🇪',
      seeders: 18,
      sizeBytes: 14e9,
    },
  ];
  const boysRanked = scoreAndFilterCandidates(boysPool, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['The Boys'],
    seasonNumber: 3,
    episodeNumber: 7,
    allLanguages: false,
  });
  assert.equal(boysRanked.length, 1);
  assert.ok(boysRanked[0].languageBadges.includes('🇪🇸 Castellano'));

  // 7. v1.5.1: Bloquea FINAL.SEASON incluso cuando Torrentio lo enlaza por error bajo S01E06, y bloquea "El juego de la piramide" en "Juego de tronos"
  const imdbMislinkedPool = [
    {
      source: 'imdb:TorrentGalaxy',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — My.Hero.Academia.FINAL.SEASON.E06.MULTi.1080p.WEB.x264-AMB3R | 👤 20 💾 1.3 GB ⚙️ TorrentGalaxy | Multi Subs / 🇪🇸',
      seeders: 20,
      sizeBytes: 1.3e9,
    },
  ];
  const mhaImdbCheck = scoreAndFilterCandidates(imdbMislinkedPool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['My Hero Academia', 'Boku no Hero Academia'],
    seasonNumber: 1,
    episodeNumber: 6,
    totalRegularSeasons: 8,
  });
  assert.equal(mhaImdbCheck.length, 0);

  const gotMislinkedPool = [
    {
      source: 'imdb:Wolfmax4k',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — El juego de la piramide [HDTV 1080p][Cap.101] | 👤 10 💾 1.8 GB ⚙️ Wolfmax4k | 🇪🇸',
      seeders: 10,
      sizeBytes: 1.8e9,
    },
    {
      source: 'imdb:Wolfmax4k',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — Juego de Tronos [HDTV 1080p][Cap.101] | 👤 14 💾 3.7 GB ⚙️ Wolfmax4k | 🇪🇸',
      seeders: 14,
      sizeBytes: 3.7e9,
    },
  ];
  const gotCheck = scoreAndFilterCandidates(gotMislinkedPool, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['Juego de tronos', 'Game of Thrones'],
    seasonNumber: 1,
    episodeNumber: 1,
  });
  assert.equal(gotCheck.length, 1);
  assert.match(gotCheck[0].title, /Juego de Tronos/);

  // 8. v1.5.2: Película "Tren infinito" bloquea packs S02/Batch/Mugen Train Arc y prioriza 23 seeds (2.66 GB) sobre 7 seeds (5.31 GB);
  //    y en series comerciales prioriza 720p con 24 seeds sobre 4K pesado con 1 seed
  const mugenMoviePool = [
    {
      source: 'nyaa.si',
      title: 'Demon Slayer Kimetsu no Yaiba S02 MULTi 1080p WEB x264 AAC (Multi-Subs, Mugen Train Arc)',
      seeders: 46,
      sizeBytes: 4e9,
    },
    {
      source: 'nyaa.si',
      title: '[Judas] Kimetsu no Yaiba - Mugen Ressha-hen (Demon Slayer - Mugen Train Arc) [1080p][Multi-Subs] (Batch)',
      seeders: 32,
      sizeBytes: 3.5e9,
    },
    {
      source: 'imdb:NyaaSi',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — [Erai-raws] Kimetsu no Yaiba - Mugen Ressha Hen - Movie [BD][1080p][Multiple Subtitle] | 👤 7 💾 5.31 GB ⚙️ NyaaSi | Multi Subs',
      seeders: 7,
      sizeBytes: 5.31e9,
    },
    {
      source: 'imdb:NyaaSi',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — [Judas] Kimetsu no Yaiba (Demon Slayer) - Movie 01 - Mugen Train [1080p][Dual-Audio][Multi-Subs] (Movie) | 👤 23 💾 2.66 GB ⚙️ NyaaSi | Multi Subs',
      seeders: 23,
      sizeBytes: 2.66e9,
    },
  ];
  const mugenRanked = scoreAndFilterCandidates(mugenMoviePool, {
    isAnime: true,
    mediaType: 'movie',
    acceptedTitles: ['Guardianes de la Noche: Tren infinito', 'Kimetsu no Yaiba: Mugen Ressha-hen', 'Demon Slayer Mugen Train'],
    year: 2020,
  });
  assert.equal(mugenRanked.length, 2); // S02 y Batch quedan descartados
  assert.match(mugenRanked[0].title, /\[Judas\].*Movie 01/); // 23 seeds 2.66 GB gana al de 7 seeds 5.31 GB

  const slowHorsesPool = [
    {
      source: 'imdb:Wolfmax4k',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 4k — Slow horses [4k 2160p][Cap.303] | 👤 1 💾 7.82 GB ⚙️ Wolfmax4k | 🇪🇸',
      seeders: 1,
      sizeBytes: 7.82e9,
    },
    {
      source: 'imdb:MejorTorrent',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 720p — Slow Horses [HDTV 720p][Cap.303] | 👤 24 💾 1.29 GB ⚙️ MejorTorrent | 🇪🇸',
      seeders: 24,
      sizeBytes: 1.29e9,
    },
  ];
  const shRanked = scoreAndFilterCandidates(slowHorsesPool, {
    isAnime: false,
    mediaType: 'tv',
    acceptedTitles: ['Slow Horses'],
    seasonNumber: 3,
    episodeNumber: 3,
  });
  assert.match(shRanked[0].title, /720p/);

  // 9. v1.5.3: Ataque a los Titanes S02E06 (abs 31) bloquea el Batch de Temporada 1 "01 ~ 25" y elige S2 - 06;
  //    y Tren Infinito (Mugen Ressha-hen, 2020) bloquea Mugen-jou Hen (Infinity Castle, 2025) incluso desde imdb:NyaaSi
  const aotS2Pool = [
    {
      source: 'nyaa.si',
      title: '[Erai-raws] Shingeki no Kyojin - 01 ~ 25 [1080p][BATCH][Multiple Subtitle]',
      seeders: 19,
      sizeBytes: 12e9,
    },
    {
      source: 'imdb:NyaaSi',
      matchedExactImdbEpisode: true,
      title: 'Torrentio 1080p — [Erai-raws] Shingeki no Kyojin S2 - 01~12 [1080p][Multiple Subtitle] | [Erai-raws] Shingeki no Kyojin S2 - 06 [1080p].mkv | 👤 8 💾 1.09 GB ⚙️ NyaaSi | Multi Subs',
      seeders: 8,
      sizeBytes: 1.09e9,
    },
  ];
  const aotRanked = scoreAndFilterCandidates(aotS2Pool, {
    isAnime: true,
    mediaType: 'tv',
    acceptedTitles: ['Ataque a los Titanes', 'Shingeki no Kyojin', 'Attack on Titan'],
    seasonNumber: 2,
    episodeNumber: 6,
    absNumber: 31,
    totalRegularSeasons: 4,
  });
  assert.equal(aotRanked.length, 1);
  assert.match(aotRanked[0].title, /S2 - 06/);

  // Y dentro de un pack "01 ~ 25" sin etiqueta S02, selectEpisodeFileFromTorrent NO elige "- 06.mkv" para S02E06 (abs 31)
  const s1PackFiles = [
    { index: 0, name: '[Erai-raws] Shingeki no Kyojin - 01 ~ 25/[Erai-raws] Shingeki no Kyojin - 06 [1080p].mkv', size: 1e9 },
    { index: 1, name: '[Erai-raws] Shingeki no Kyojin - 01 ~ 25/[Erai-raws] Shingeki no Kyojin - 07 [1080p].mkv', size: 1e9 },
  ];
  assert.equal(
    selectEpisodeFileFromTorrent(s1PackFiles, { seasonNumber: 2, episodeNumber: 6, absNumber: 31, isAnime: true }),
    null
  );

  // Película Mugen Train (2020) rechaza Mugen-jou Hen (Infinity Castle) mal enlazado en imdb:NyaaSi
  const infinityCastleLeak = [
    {
      source: 'imdb:NyaaSi',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 1080p — [Judas] Gekijouban Kimetsu no Yaiba Mugen-jou Hen (Demon Slayer Infinity Castle) [1080p][Multi-Subs] (Movie) | 👤 69 💾 2.7 GB ⚙️ NyaaSi | Multi Subs',
      seeders: 69,
      sizeBytes: 2.7e9,
    },
    {
      source: 'imdb:NyaaSi',
      matchedExactImdbEpisode: true,
      title:
        'Torrentio 1080p — [Erai-raws] Kimetsu no Yaiba - Mugen Ressha Hen - Movie [BD][1080p][Multiple Subtitle].mkv | 👤 7 💾 5.31 GB ⚙️ NyaaSi | Multi Subs',
      seeders: 7,
      sizeBytes: 5.31e9,
    },
  ];
  const mugenClean = scoreAndFilterCandidates(infinityCastleLeak, {
    isAnime: true,
    mediaType: 'movie',
    acceptedTitles: ['Guardianes de la Noche: Tren infinito', 'Kimetsu no Yaiba: Mugen Ressha-hen', 'Demon Slayer: Mugen Train'],
    year: 2020,
  });
  assert.equal(mugenClean.length, 1);
  assert.match(mugenClean[0].title, /Mugen Ressha Hen/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExtSearchHtml, parseNyaaRssXml } from '../src/indexers.js';
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
  } finally {
    engine.stop();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const ANILIST_URL = 'https://graphql.anilist.co';

function isAnimeHeuristic({ genreIds = [], genres = [], originalLanguage = '', originCountry = [] }) {
  const hasAnimId = genreIds.includes(16) || genres.some((g) => g.id === 16 || /anim/i.test(g.name || ''));
  const isJp =
    originalLanguage === 'ja' ||
    (Array.isArray(originCountry) && originCountry.includes('JP'));
  return Boolean(hasAnimId && isJp);
}

function tmdbImage(pathPart, size = 'w500') {
  return pathPart ? `${TMDB_IMG}/${size}${pathPart}` : null;
}

export class CatalogService {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.discoverCache = { expiresAt: 0, payload: null };
  }

  hasTmdbKey() {
    const key = this.getConfig().tmdbApiKey;
    return Boolean(key && !key.startsWith('PON_AQUI'));
  }

  async #tmdbFetch(endpoint, params = {}) {
    const key = this.getConfig().tmdbApiKey;
    if (!key || key.startsWith('PON_AQUI')) {
      throw new Error('Falta configurar TMDB_API_KEY en SebiTV (.env o ajustes en Jellyfin).');
    }

    const url = new URL(`${TMDB_BASE}${endpoint}`);
    const headers = { Accept: 'application/json' };

    // Soporta tanto Token de Lectura v4 (JWT "eyJ...") como API Key clásica v3 (32 hex)
    if (key.length > 45 || key.startsWith('eyJ')) {
      headers.Authorization = `Bearer ${key}`;
    } else {
      url.searchParams.set('api_key', key);
    }

    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          if (attempt === 0 && [429, 500, 502, 503, 504].includes(res.status)) {
            await new Promise((r) => setTimeout(r, 600));
            continue;
          }
          throw new Error(`TMDB HTTP ${res.status}: ${await res.text()}`);
        }
        return res.json();
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    throw lastErr;
  }

  async queryAniListSearch(query, limit = 15) {
    const gql = `
      query ($search: String, $perPage: Int) {
        Page(page: 1, perPage: $perPage) {
          media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
            id
            title { romaji english native }
            synonyms
            seasonYear
            format
            episodes
            description(asHtml: false)
            coverImage { extraLarge large }
            bannerImage
          }
        }
      }
    `;
    try {
      const res = await fetch(ANILIST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: gql, variables: { search: query, perPage: limit } }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return [];
      const json = await res.json();
      return json?.data?.Page?.media || [];
    } catch {
      return [];
    }
  }

  #normalizeCard(raw, forcedMediaType = null) {
    const mediaType = forcedMediaType || raw.media_type;
    if (mediaType !== 'movie' && mediaType !== 'tv') return null;
    const title = raw.title || raw.name || 'Sin título';
    const originalTitle = raw.original_title || raw.original_name || title;
    const dateStr = raw.release_date || raw.first_air_date || '';
    const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) || null : null;
    const todayIso = new Date().toISOString().slice(0, 10);
    const isUnreleased = Boolean(dateStr && dateStr > todayIso);
    const isAnime = isAnimeHeuristic({
      genreIds: raw.genre_ids || [],
      genres: raw.genres || [],
      originalLanguage: raw.original_language,
      originCountry: raw.origin_country || [],
    });

    return {
      tmdbId: raw.id,
      mediaType,
      isAnime,
      isUnreleased,
      releaseDate: dateStr || null,
      title,
      originalTitle,
      year,
      rating: raw.vote_average ? Number(raw.vote_average.toFixed(1)) : null,
      overview: raw.overview || '',
      posterUrl: tmdbImage(raw.poster_path, 'w500'),
      backdropUrl: tmdbImage(raw.backdrop_path, 'w1280'),
      languageRule: isUnreleased
        ? `🗓 Estreno: ${dateStr}`
        : isAnime
        ? '🇯🇵 JP + Sub ES'
        : '🇪🇸 Castellano',
    };
  }

  async getDiscoverHome() {
    if (!this.hasTmdbKey()) {
      return {
        configured: false,
        sections: [],
        message: 'Configura tu TMDB_API_KEY gratuita para activar el catálogo completo de Películas, Series y Anime.',
      };
    }

    if (this.discoverCache.payload && Date.now() < this.discoverCache.expiresAt) {
      return structuredClone(this.discoverCache.payload);
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    const digitalMovieCutoffIso = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
    const settled = await Promise.allSettled([
      this.#tmdbFetch('/trending/all/week', { language: 'es-ES' }),
      this.#tmdbFetch('/discover/movie', {
        language: 'es-ES',
        region: 'US',
        sort_by: 'popularity.desc',
        with_release_type: '4|5|6', // Solo Digital, BluRay/Físico o TV
        'primary_release_date.lte': digitalMovieCutoffIso,
        'vote_count.gte': '280',
        include_adult: 'false',
        page: 1,
      }),
      this.#tmdbFetch('/discover/tv', {
        language: 'es-ES',
        sort_by: 'popularity.desc',
        'first_air_date.lte': todayIso,
        'vote_count.gte': '90',
        without_genres: '16',
        page: 1,
      }),
      this.#tmdbFetch('/discover/tv', {
        language: 'es-ES',
        sort_by: 'popularity.desc',
        'first_air_date.lte': todayIso,
        'vote_count.gte': '25',
        with_genres: '16',
        with_original_language: 'ja',
        page: 1,
      }),
    ]);

    const val = (idx) => (settled[idx].status === 'fulfilled' ? settled[idx].value : { results: [] });
    const isAlreadyReleased = (r, forcedType = null) => {
      const mType = forcedType || r?.media_type;
      const d = r?.release_date || r?.first_air_date || '';
      if (!d) return false;
      if (mType === 'movie' && d > digitalMovieCutoffIso) return false;
      if (mType !== 'movie' && d > todayIso) return false;
      const isAnim = (r.genre_ids || []).includes(16) && r.original_language === 'ja';
      const minVotes = mType === 'movie' ? (isAnim ? 40 : 280) : isAnim ? 20 : 90;
      return (r.vote_count || 0) >= minVotes;
    };
    const trendingAll = val(0);
    const popularMovies = val(1);
    const popularSeries = val(2);
    const popularAnime = val(3);

    const payload = {
      configured: true,
      sections: [
        {
          id: 'trending',
          title: 'En Tendencia Esta Semana',
          items: (trendingAll.results || [])
            .filter((r) => isAlreadyReleased(r))
            .map((r) => this.#normalizeCard(r))
            .filter(Boolean)
            .slice(0, 18),
        },
        {
          id: 'anime',
          title: 'Anime Popular (Japonés + Sub Español)',
          items: (popularAnime.results || [])
            .filter((r) => isAlreadyReleased(r, 'tv'))
            .map((r) => this.#normalizeCard(r, 'tv'))
            .filter(Boolean)
            .slice(0, 18),
        },
        {
          id: 'series',
          title: 'Series Populares (Audio Castellano)',
          items: (popularSeries.results || [])
            .filter((r) => isAlreadyReleased(r, 'tv'))
            .map((r) => this.#normalizeCard(r, 'tv'))
            .filter(Boolean)
            .slice(0, 18),
        },
        {
          id: 'movies',
          title: 'Películas Populares (Audio Castellano / Anime)',
          items: (popularMovies.results || [])
            .filter((r) => isAlreadyReleased(r, 'movie'))
            .map((r) => this.#normalizeCard(r, 'movie'))
            .filter(Boolean)
            .slice(0, 18),
        },
      ].filter((s) => s.items.length > 0),
    };

    if (payload.sections.length > 0) {
      this.discoverCache = { expiresAt: Date.now() + 10 * 60 * 1000, payload };
    }
    return structuredClone(payload);
  }

  async searchCatalog(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const [esSettled, enSettled] = await Promise.allSettled([
      this.#tmdbFetch('/search/multi', {
        language: 'es-ES',
        query: q,
        include_adult: 'false',
        page: 1,
      }),
      this.#tmdbFetch('/search/multi', {
        language: 'en-US',
        query: q,
        include_adult: 'false',
        page: 1,
      }),
    ]);

    const esResults = esSettled.status === 'fulfilled' ? esSettled.value.results || [] : [];
    const enResults = enSettled.status === 'fulfilled' ? enSettled.value.results || [] : [];

    const byKey = new Map();
    for (const r of esResults) {
      if (r.media_type === 'movie' || r.media_type === 'tv') {
        byKey.set(`${r.media_type}:${r.id}`, r);
      }
    }
    for (const r of enResults) {
      const key = `${r.media_type}:${r.id}`;
      if ((r.media_type === 'movie' || r.media_type === 'tv') && !byKey.has(key)) {
        byKey.set(key, r);
      }
    }

    const qNorm = q.toLowerCase();
    const mergedRaw = [...byKey.values()].sort((a, b) => {
      const aTitles = [a.title, a.name, a.original_title, a.original_name].filter(Boolean).map((s) => s.toLowerCase());
      const bTitles = [b.title, b.name, b.original_title, b.original_name].filter(Boolean).map((s) => s.toLowerCase());
      const aExact = aTitles.some((t) => t === qNorm || t === `${qNorm}.`) ? 1 : 0;
      const bExact = bTitles.some((t) => t === qNorm || t === `${qNorm}.`) ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      const aScore = (a.popularity || 0) * Math.log10((a.vote_count || 0) + 10);
      const bScore = (b.popularity || 0) * Math.log10((b.vote_count || 0) + 10);
      return bScore - aScore;
    });

    return mergedRaw
      .map((r) => this.#normalizeCard(r))
      .filter(Boolean)
      .slice(0, 30);
  }

  async getFullDetails(mediaType, tmdbId) {
    const type = mediaType === 'movie' ? 'movie' : 'tv';
    const data = await this.#tmdbFetch(`/${type}/${tmdbId}`, {
      language: 'es-ES',
      append_to_response: 'external_ids,alternative_titles',
    });

    // También pedimos el título inglés internacional para mejorar búsquedas de torrents
    let enTitle = null;
    try {
      const enData = await this.#tmdbFetch(`/${type}/${tmdbId}`, { language: 'en-US' });
      enTitle = enData.title || enData.name || null;
    } catch {
      // Ignorar si falla
    }

    const isAnime = isAnimeHeuristic({
      genres: data.genres || [],
      originalLanguage: data.original_language,
      originCountry: data.origin_country || (data.production_countries || []).map((c) => c.iso_3166_1),
    });

    const title = data.title || data.name || 'Sin título';
    const originalTitle = data.original_title || data.original_name || title;
    const dateStr = data.release_date || data.first_air_date || '';
    const year = dateStr ? Number.parseInt(dateStr.slice(0, 4), 10) || null : null;
    const imdbId = data.imdb_id || data.external_ids?.imdb_id || null;
    const tvdbId = data.external_ids?.tvdb_id || null;

    const searchTitleSet = new Set();
    const isTvSeasonSpecificAlias = (s = '') =>
      type === 'tv' &&
      /\b(final\s+season|\d+(?:st|nd|rd|th)\s+season|season\s*\d+|part\s*\d+|\bhen\b|\bvs\.?\b|to\s+the\s+top|stone\s+wars)\b/i.test(
        s
      );

    const pushClean = (val) => {
      if (val && typeof val === 'string' && val.trim().length >= 2) {
        const trimmed = val.trim();
        if (isTvSeasonSpecificAlias(trimmed)) return;
        // Aceptar únicamente alfabeto latino/ occidental (descartando kana/kanji/cirílico/hebreo/tailandés/árabe)
        if (/[a-zA-Z]/.test(trimmed) && /^[\p{Script=Latin}\d\s\p{P}\p{S}]+$/u.test(trimmed)) {
          searchTitleSet.add(trimmed);
        }
      }
    };

    pushClean(title);
    pushClean(enTitle);
    pushClean(originalTitle);

    const altList = data.alternative_titles?.titles || data.alternative_titles?.results || [];
    for (const alt of altList) {
      if (['ES', 'US', 'GB', 'JP'].includes(alt.iso_3166_1) && alt.title) {
        if (type === 'tv') {
          // En series, ignorar subtítulos específicos de arcos/especiales posteriores (ej. "Memories", "Shimetsu Kaiyuu")
          if (!/[:\-–]/.test(alt.title) && !/\b(memories|more|recap|special)\b/i.test(alt.title)) {
            pushClean(alt.title);
          }
        } else if (alt.title.trim().split(/\s+/).length >= 2) {
          // En películas, evitar alias sueltos de 1 palabra (ej. "Hierro" en Iron Man) que causan falsos positivos
          pushClean(alt.title);
        }
      }
    }

    // Si es anime, enriquecemos con los títulos Romaji e Inglés exactos de AniList respetando formato (TV vs MOVIE) y año
    let anilistId = null;
    if (isAnime) {
      const aniMatches = await this.queryAniListSearch(enTitle || title, 8);
      const validAni = aniMatches
        .filter((m) => {
          if (type === 'movie' && m.format !== 'MOVIE') return false;
          if (type === 'tv' && m.format === 'MOVIE') return false;
          if (year && m.seasonYear && Math.abs(m.seasonYear - year) > (type === 'movie' ? 1 : 2)) return false;
          return true;
        })
        .sort((a, b) => Math.abs((a.seasonYear || year || 0) - (year || 0)) - Math.abs((b.seasonYear || year || 0) - (year || 0)));
      const match = validAni[0] || null;
      if (match) {
        anilistId = match.id;
        // Para Anime, Romaji e Inglés van primero porque así nombran los releases Erai-raws y ToonsHub
        const animePriority = new Set();
        if (match.title?.romaji && !isTvSeasonSpecificAlias(match.title.romaji)) {
          animePriority.add(match.title.romaji.trim());
        }
        if (match.title?.english && !isTvSeasonSpecificAlias(match.title.english)) {
          animePriority.add(match.title.english.trim());
        }
        for (const s of match.synonyms || []) {
          if (/[äöüßőűąćęłńśźżčřšžơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđ]/i.test(s)) continue;
          if (type === 'tv' || s.trim().split(/\s+/).length >= 2) pushClean(s);
        }
        for (const existing of searchTitleSet) animePriority.add(existing);
        searchTitleSet.clear();
        for (const item of animePriority) searchTitleSet.add(item);
      }
    }

    if (searchTitleSet.size === 0) searchTitleSet.add(title);

    const seasons = [];
    const episodes = [];
    let relatedMovies = [];

    if (type === 'tv' && Array.isArray(data.seasons)) {
      const validSeasons = data.seasons.filter((s) => s.season_number >= 0 && (s.episode_count || 0) > 0);
      // Ordenamos temporadas regulares primero (1..N) para calcular numeración absoluta continua (útil en Anime)
      const sortedSeasons = [...validSeasons].sort((a, b) => {
        if (a.season_number === 0) return 1;
        if (b.season_number === 0) return -1;
        return a.season_number - b.season_number;
      });

      const todayIso = new Date().toISOString().slice(0, 10);
      let absCounter = 1;
      for (const s of sortedSeasons) {
        let seasonDetail = null;
        try {
          seasonDetail = await this.#tmdbFetch(`/tv/${tmdbId}/season/${s.season_number}`, { language: 'es-ES' });
        } catch {
          continue;
        }

        let rawEps = seasonDetail.episodes || [];

        if (s.season_number === 0) {
          // Rellenar títulos genéricos ("Episodio 5") con el nombre oficial en inglés/japonés
          const hasGeneric = rawEps.some((ep) => !ep.name || /^(?:episodio|episode)\s*\d+$/i.test(ep.name.trim()));
          if (hasGeneric) {
            try {
              const enSeason0 = await this.#tmdbFetch(`/tv/${tmdbId}/season/0`, { language: 'en-US' });
              const enMap = new Map((enSeason0.episodes || []).map((e) => [e.episode_number, e]));
              rawEps = rawEps.map((ep) => {
                const enEp = enMap.get(ep.episode_number);
                const needsName = !ep.name || /^(?:episodio|episode)\s*\d+$/i.test(ep.name.trim());
                return {
                  ...ep,
                  name: needsName && enEp?.name ? enEp.name : ep.name,
                  overview: ep.overview || enEp?.overview || '',
                };
              });
            } catch {
              // Ignorar fallback inglés
            }
          }

          // Filtrar clips promocionales/making-of de YouTube que ensucian Season 00
          rawEps = rawEps.filter((ep) => {
            const epName = String(ep.name || '');
            const epDesc = String(ep.overview || '');
            if (ep.air_date && ep.air_date > todayIso) return false;
            if (
              /\b(making[\s-]*of|behind\s+the|inside\s+the\s+episode|featurette|cast\s+interview|trailer|teaser|promo\b|preview\b|manner\s+movie|campaign)\b/i.test(
                `${epName} ${epDesc}`
              )
            ) {
              return false;
            }
            if (!isAnime && ep.runtime && ep.runtime > 0 && ep.runtime < 14) return false;
            return true;
          });

          if (rawEps.length === 0) continue;
        }

        const seasonTitle =
          s.season_number === 0
            ? isAnime
              ? 'OVAs y Especiales'
              : 'Especiales'
            : seasonDetail.name || s.name || `Temporada ${s.season_number}`;

        seasons.push({
          seasonNumber: s.season_number,
          title: seasonTitle,
          overview: seasonDetail.overview || s.overview || '',
          posterUrl: tmdbImage(seasonDetail.poster_path || s.poster_path, 'w342'),
          episodeCount: rawEps.length,
        });

        for (const ep of rawEps) {
          const isSpecial = s.season_number === 0;
          episodes.push({
            seasonNumber: s.season_number,
            episodeNumber: ep.episode_number,
            absNumber: isSpecial ? null : absCounter++,
            isSpecial,
            title: ep.name || `Episodio ${ep.episode_number}`,
            overview: ep.overview || '',
            airDate: ep.air_date || null,
            stillUrl: tmdbImage(ep.still_path, 'w300'),
          });
        }
      }

      // Buscar películas oficiales de la misma franquicia/saga (soportando títulos compuestos como "Kimetsu no Yaiba: Guardianes de la Noche")
      try {
        const normClean = (s = '') =>
          String(s)
            .replace(/\s*\(\d{4}\)\s*$/, '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const rootCandidates = new Set();
        for (const cand of [title, enTitle, ...searchTitleSet]) {
          if (!cand) continue;
          const base = cand.replace(/\s*\(\d{4}\)\s*$/, '').trim();
          const minWords = isAnime ? 1 : 2; // En series no-anime exigir >=2 palabras (evita "Chernobyl" -> películas ajenas)
          if (base.length >= 4 && base.split(/\s+/).length >= minWords) rootCandidates.add(base);
          for (const part of base.split(/\s*[:\-–]\s*/)) {
            if (part.trim().split(/\s+/).length >= 2 || (isAnime && part.trim().length >= 6)) {
              rootCandidates.add(part.trim());
            }
          }
        }

        const queries = [...rootCandidates].slice(0, 3);
        const searchBatches = await Promise.allSettled(
          queries.map((q) =>
            this.#tmdbFetch('/search/movie', {
              language: 'es-ES',
              query: q,
              include_adult: 'false',
              page: 1,
            })
          )
        );

        const normPhrases = [...rootCandidates].map(normClean).filter((p) => p.length >= 4);
        const seenMovieIds = new Set();
        const rawMovies = [];
        for (const b of searchBatches) {
          if (b.status === 'fulfilled') {
            for (const m of b.value.results || []) {
              if (!seenMovieIds.has(m.id)) {
                seenMovieIds.add(m.id);
                rawMovies.push(m);
              }
            }
          }
        }

        const showIsDoc = (data.genres || []).some((g) => g.id === 99);
        relatedMovies = rawMovies
          .filter((m) => {
            if (!m.poster_path) return false;
            if (!m.release_date || m.release_date > todayIso) return false;
            const movYear = Number.parseInt(m.release_date.slice(0, 4), 10) || 0;
            if (!isAnime && year && movYear > 0 && movYear < year) return false;
            if ((m.vote_count || 0) < (isAnime ? 10 : 25)) return false;
            if (!showIsDoc && (m.genre_ids || []).includes(99)) return false;
            if (
              /\b(fireplace|chimenea|yule\s+log|making[\s-]*of|behind\s+the\s+scenes|recap|resumen)\b/i.test(
                `${m.title || ''} ${m.original_title || ''}`
              )
            ) {
              return false;
            }
            if (isAnime && !isAnimeHeuristic({ genreIds: m.genre_ids || [], originalLanguage: m.original_language })) {
              return false;
            }
            const mt = ` ${normClean(`${m.title || ''} ${m.original_title || ''}`)} `;
            return normPhrases.some((ph) => mt.includes(` ${ph} `));
          })
          .slice(0, 8)
          .map((m) => this.#normalizeCard(m, 'movie'))
          .filter(Boolean);
      } catch {
        relatedMovies = [];
      }
    }

    return {
      tmdbId: data.id,
      mediaType: type,
      isAnime,
      anilistId,
      imdbId,
      tvdbId,
      title,
      originalTitle,
      enTitle,
      searchTitles: [...searchTitleSet].slice(0, 6),
      year,
      rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
      overview: data.overview || '',
      posterUrl: tmdbImage(data.poster_path, 'w500'),
      backdropUrl: tmdbImage(data.backdrop_path, 'w1280'),
      languageRule: isAnime
        ? '🇯🇵 Audio Japonés + Subtítulos Español (Castellano > Latino)'
        : '🇪🇸 Audio Español Castellano (Sin subtítulos)',
      seasons,
      episodes,
      relatedMovies,
    };
  }
}

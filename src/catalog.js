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

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`TMDB HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json();
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
      title,
      originalTitle,
      year,
      rating: raw.vote_average ? Number(raw.vote_average.toFixed(1)) : null,
      overview: raw.overview || '',
      posterUrl: tmdbImage(raw.poster_path, 'w500'),
      backdropUrl: tmdbImage(raw.backdrop_path, 'w1280'),
      languageRule: isAnime ? '🇯🇵 JP + Sub ES' : '🇪🇸 Castellano',
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

    const [trendingAll, popularMovies, popularSeries, popularAnime] = await Promise.all([
      this.#tmdbFetch('/trending/all/week', { language: 'es-ES' }),
      this.#tmdbFetch('/movie/popular', { language: 'es-ES', page: 1 }),
      this.#tmdbFetch('/discover/tv', {
        language: 'es-ES',
        sort_by: 'popularity.desc',
        without_genres: '16',
        page: 1,
      }),
      this.#tmdbFetch('/discover/tv', {
        language: 'es-ES',
        sort_by: 'popularity.desc',
        with_genres: '16',
        with_original_language: 'ja',
        page: 1,
      }),
    ]);

    return {
      configured: true,
      sections: [
        {
          id: 'trending',
          title: 'En Tendencia Esta Semana',
          items: (trendingAll.results || []).map((r) => this.#normalizeCard(r)).filter(Boolean).slice(0, 18),
        },
        {
          id: 'anime',
          title: 'Anime Popular (Japonés + Sub Español)',
          items: (popularAnime.results || []).map((r) => this.#normalizeCard(r, 'tv')).filter(Boolean).slice(0, 18),
        },
        {
          id: 'series',
          title: 'Series Populares (Audio Castellano)',
          items: (popularSeries.results || []).map((r) => this.#normalizeCard(r, 'tv')).filter(Boolean).slice(0, 18),
        },
        {
          id: 'movies',
          title: 'Películas Populares (Audio Castellano / Anime)',
          items: (popularMovies.results || []).map((r) => this.#normalizeCard(r, 'movie')).filter(Boolean).slice(0, 18),
        },
      ],
    };
  }

  async searchCatalog(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const data = await this.#tmdbFetch('/search/multi', {
      language: 'es-ES',
      query: q,
      include_adult: 'false',
      page: 1,
    });
    return (data.results || [])
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
    const pushClean = (val) => {
      if (val && typeof val === 'string' && val.trim().length >= 2) {
        // Descartar alfabetos puramente japoneses/chinos para trackers occidentales salvo que sea el único
        if (!/^[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s\d\p{P}]+$/u.test(val.trim())) {
          searchTitleSet.add(val.trim());
        }
      }
    };

    pushClean(title);
    pushClean(enTitle);
    pushClean(originalTitle);

    const altList = data.alternative_titles?.titles || data.alternative_titles?.results || [];
    for (const alt of altList) {
      if (['ES', 'US', 'GB', 'JP'].includes(alt.iso_3166_1)) {
        // Ignorar subtítulos específicos de arcos/temporadas posteriores (ej. "Jujutsu Kaisen: Shimetsu Kaiyuu - Zenpen")
        if (alt.title && !/[:\-–]/.test(alt.title)) {
          pushClean(alt.title);
        }
      }
    }

    // Si es anime, enriquecemos con los títulos Romaji e Inglés exactos de AniList (clave para Erai-raws / Nyaa / ext.to)
    let anilistId = null;
    if (isAnime) {
      const aniMatches = await this.queryAniListSearch(enTitle || title, 3);
      const match =
        aniMatches.find((m) => !year || !m.seasonYear || Math.abs(m.seasonYear - year) <= 1) || aniMatches[0];
      if (match) {
        anilistId = match.id;
        // Para Anime, Romaji e Inglés van primero porque así nombran los releases Erai-raws y ToonsHub
        const animePriority = new Set();
        if (match.title?.romaji) animePriority.add(match.title.romaji.trim());
        if (match.title?.english) animePriority.add(match.title.english.trim());
        for (const s of match.synonyms || []) pushClean(s);
        for (const existing of searchTitleSet) animePriority.add(existing);
        searchTitleSet.clear();
        for (const item of animePriority) searchTitleSet.add(item);
      }
    }

    if (searchTitleSet.size === 0) searchTitleSet.add(title);

    const seasons = [];
    const episodes = [];

    if (type === 'tv' && Array.isArray(data.seasons)) {
      const validSeasons = data.seasons.filter((s) => s.season_number >= 0 && (s.episode_count || 0) > 0);
      // Ordenamos temporadas regulares primero (1..N) para calcular numeración absoluta continua (útil en Anime)
      const sortedSeasons = [...validSeasons].sort((a, b) => {
        if (a.season_number === 0) return 1;
        if (b.season_number === 0) return -1;
        return a.season_number - b.season_number;
      });

      let absCounter = 1;
      for (const s of sortedSeasons) {
        let seasonDetail = null;
        try {
          seasonDetail = await this.#tmdbFetch(`/tv/${tmdbId}/season/${s.season_number}`, { language: 'es-ES' });
        } catch {
          continue;
        }
        const seasonTitle =
          s.season_number === 0
            ? 'Especiales / OVAs y Películas'
            : seasonDetail.name || s.name || `Temporada ${s.season_number}`;

        seasons.push({
          seasonNumber: s.season_number,
          title: seasonTitle,
          overview: seasonDetail.overview || s.overview || '',
          posterUrl: tmdbImage(seasonDetail.poster_path || s.poster_path, 'w342'),
          episodeCount: (seasonDetail.episodes || []).length,
        });

        for (const ep of seasonDetail.episodes || []) {
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
    };
  }
}

export class JellyfinClient {
  constructor(getConfig, db) {
    this.getConfig = getConfig;
    this.db = db;
    this.bootstrapped = false;
  }

  #authHeader(token = null) {
    const base = 'MediaBrowser Client="SebiTV", Device="SebiTV-Engine", DeviceId="sebitv-docker-engine", Version="1.0.0"';
    return token ? `${base}, Token="${token}"` : base;
  }

  async getToken() {
    const cfg = this.getConfig();
    if (cfg.jellyfinApiKey) return cfg.jellyfinApiKey;
    const saved = this.db.getSetting('jellyfinAccessToken');
    if (saved) return saved;
    return this.authenticateByPassword();
  }

  async authenticateByPassword() {
    const cfg = this.getConfig();
    if (!cfg.jellyfinUser || !cfg.jellyfinPass || cfg.jellyfinPass.startsWith('PON_AQUI')) {
      return null;
    }

    try {
      const res = await fetch(`${cfg.jellyfinUrl}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': this.#authHeader(),
        },
        body: JSON.stringify({
          Username: cfg.jellyfinUser,
          Pw: cfg.jellyfinPass,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data?.AccessToken) {
        this.db.setSetting('jellyfinAccessToken', data.AccessToken);
        if (data.User?.Id) {
          this.db.setSetting('jellyfinUserId', data.User.Id);
        }
        return data.AccessToken;
      }
    } catch {
      // Jellyfin puede estar terminando de arrancar
    }
    return null;
  }

  async #request(endpoint, { method = 'GET', json = undefined, retry = true } = {}) {
    const cfg = this.getConfig();
    const token = await this.getToken();
    if (!token) {
      throw new Error('Jellyfin aún no tiene credenciales configuradas (JELLYFIN_USER/JELLYFIN_PASS o JELLYFIN_API_KEY).');
    }

    const headers = {
      Accept: 'application/json',
      'X-Emby-Authorization': this.#authHeader(token),
      'X-Emby-Token': token,
    };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }

    const res = await fetch(`${cfg.jellyfinUrl}${endpoint}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(12000),
    });

    if (res.status === 401 && retry && !cfg.jellyfinApiKey) {
      this.db.setSetting('jellyfinAccessToken', '');
      await this.authenticateByPassword();
      return this.#request(endpoint, { method, json, retry: false });
    }

    if (!res.ok) {
      throw new Error(`Jellyfin API ${endpoint} devolvió HTTP ${res.status}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async isHealthy() {
    try {
      const cfg = this.getConfig();
      const pubRes = await fetch(`${cfg.jellyfinUrl}/System/Info/Public`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!pubRes.ok) return { ok: false, error: `HTTP ${pubRes.status}` };
      const pubInfo = await pubRes.json();
      const token = await this.getToken();
      return {
        ok: true,
        authenticated: Boolean(token),
        serverName: pubInfo.ServerName,
        version: pubInfo.Version,
      };
    } catch (err) {
      return { ok: false, authenticated: false, error: err.message };
    }
  }

  /**
   * Configura automáticamente en Jellyfin:
   * 1. Las 3 bibliotecas (Películas, Series, Anime) con metadatos en Español (ES)
   *    y "Missing Episode Fetcher" activado para mostrar capítulos sin botón Play cuando no hay archivo.
   * 2. "DisplayMissingEpisodes = true" en todos los perfiles de usuario.
   */
  async ensureBootstrap() {
    if (this.bootstrapped) return;
    const token = await this.getToken();
    if (!token) return;

    const cfg = this.getConfig();
    try {
      const virtualFolders = (await this.#request('/Library/VirtualFolders')) || [];
      const existingPaths = new Set();
      for (const vf of virtualFolders) {
        for (const loc of vf.Locations || []) existingPaths.add(loc);
      }

      const desiredLibraries = [
        {
          name: 'Películas',
          collectionType: 'movies',
          folderPath: `${cfg.jellyfinMediaRoot}/movies`,
          isTv: false,
        },
        {
          name: 'Series',
          collectionType: 'tvshows',
          folderPath: `${cfg.jellyfinMediaRoot}/series`,
          isTv: true,
        },
        {
          name: 'Anime',
          collectionType: 'tvshows',
          folderPath: `${cfg.jellyfinMediaRoot}/anime`,
          isTv: true,
        },
      ];

      for (const lib of desiredLibraries) {
        if (existingPaths.has(lib.folderPath)) continue;

        const libraryOptions = {
          EnableRealtimeMonitor: true,
          PreferredMetadataLanguage: 'es',
          MetadataCountryCode: 'ES',
          SaveLocalMetadata: false,
          TypeOptions: lib.isTv
            ? [
                {
                  Type: 'Series',
                  MetadataFetchers: ['TheMovieDb', 'The Open Movie Database', 'Missing Episode Fetcher'],
                  MetadataFetcherOrder: ['TheMovieDb', 'The Open Movie Database', 'Missing Episode Fetcher'],
                },
              ]
            : [],
        };

        const qs = new URLSearchParams({
          name: lib.name,
          collectionType: lib.collectionType,
          refreshLibrary: 'true',
        });

        await this.#request(`/Library/VirtualFolders?${qs.toString()}`, {
          method: 'POST',
          json: {
            Paths: [lib.folderPath],
            LibraryOptions: libraryOptions,
          },
        });
        console.log(`[SebiTV] Biblioteca Jellyfin creada automáticamente: ${lib.name} (${lib.folderPath})`);
      }

      // Activar DisplayMissingEpisodes=true en todos los usuarios para que vean los capítulos virtuales sin botón Play
      const users = (await this.#request('/Users')) || [];
      for (const u of users) {
        if (!u.Configuration?.DisplayMissingEpisodes) {
          await this.#request(`/Users/${u.Id}/Configuration`, {
            method: 'POST',
            json: {
              ...(u.Configuration || {}),
              DisplayMissingEpisodes: true,
              RememberAudioSelections: true,
              RememberSubtitleSelections: true,
            },
          });
        }
      }

      this.bootstrapped = true;
    } catch (err) {
      console.warn(`[SebiTV] Aviso en autoconfiguración de Jellyfin: ${err.message}`);
    }
  }

  toJellyfinPath(localMediaPath) {
    const cfg = this.getConfig();
    const normLocal = localMediaPath.replace(/\\/g, '/');
    const normRoot = cfg.mediaRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normLocal.startsWith(normRoot)) {
      return `${cfg.jellyfinMediaRoot.replace(/\/+$/, '')}${normLocal.slice(normRoot.length)}`;
    }
    return normLocal;
  }

  async notifyMediaUpdated(localMediaPath, updateType = 'Created') {
    try {
      const jfPath = this.toJellyfinPath(localMediaPath);
      await this.#request('/Library/Media/Updated', {
        method: 'POST',
        json: {
          Updates: [{ Path: jfPath, UpdateType: updateType }],
        },
      });
    } catch {
      try {
        await this.refreshLibraries();
      } catch {
        // Ignorar si Jellyfin no responde
      }
    }
  }

  async refreshLibraries() {
    try {
      await this.#request('/Library/Refresh', { method: 'POST' });
    } catch {
      // Ignorar
    }
  }

  async refreshItem(jellyfinItemId) {
    if (!jellyfinItemId) return;
    try {
      const qs = new URLSearchParams({
        Recursive: 'true',
        MetadataRefreshMode: 'Default',
        ImageRefreshMode: 'Default',
        ReplaceAllMetadata: 'false',
      });
      await this.#request(`/Items/${jellyfinItemId}/Refresh?${qs.toString()}`, { method: 'POST' });
    } catch {
      // Ignorar
    }
  }

  async getActiveSessions() {
    try {
      return (await this.#request('/Sessions')) || [];
    } catch {
      return [];
    }
  }

  async findItemByTmdb(tmdbId, mediaType) {
    try {
      const includeTypes = mediaType === 'movie' ? 'Movie' : 'Series';
      const qs = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: includeTypes,
        Fields: 'ProviderIds,Path',
      });
      const data = await this.#request(`/Items?${qs.toString()}`);
      const items = data?.Items || [];
      return (
        items.find((it) => String(it.ProviderIds?.Tmdb || '') === String(tmdbId)) || null
      );
    } catch {
      return null;
    }
  }

  async getItemDetails(jellyfinItemId) {
    try {
      const qs = new URLSearchParams({
        Fields: 'ProviderIds,Path,MediaSources,LocationType',
      });
      const data = await this.#request(`/Items?Ids=${encodeURIComponent(jellyfinItemId)}&${qs.toString()}`);
      return data?.Items?.[0] || null;
    } catch {
      return null;
    }
  }

  async getSeriesEpisodesInJellyfin(seriesJellyfinId) {
    if (!seriesJellyfinId) return [];
    try {
      const qs = new URLSearchParams({
        Fields: 'ProviderIds,Path,MediaSources,LocationType,UserData',
        EnableMissing: 'true',
      });
      const data = await this.#request(`/Shows/${encodeURIComponent(seriesJellyfinId)}/Episodes?${qs.toString()}`);
      return data?.Items || [];
    } catch {
      return [];
    }
  }
}

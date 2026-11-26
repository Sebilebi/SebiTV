const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class QbitClient {
  constructor(getConfig) {
    this.getConfig = getConfig;
    this.cookie = null;
  }

  async #login() {
    const cfg = this.getConfig();
    if (!cfg.qbitPass) return;
    const res = await fetch(`${cfg.qbitUrl}/api/v2/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: cfg.qbitUrl,
      },
      body: new URLSearchParams({
        username: cfg.qbitUser || 'admin',
        password: cfg.qbitPass,
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      this.cookie = setCookie.split(';')[0];
    }
  }

  async #request(endpoint, { method = 'GET', form = null, retryAuth = true } = {}) {
    const cfg = this.getConfig();
    const headers = { Referer: cfg.qbitUrl };
    if (this.cookie) headers.Cookie = this.cookie;

    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }

    const res = await fetch(`${cfg.qbitUrl}${endpoint}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(12000),
    });

    if (res.status === 403 && retryAuth && cfg.qbitPass) {
      await this.#login();
      return this.#request(endpoint, { method, form, retryAuth: false });
    }

    if (!res.ok) {
      throw new Error(`qBittorrent API ${endpoint} devolvió HTTP ${res.status}`);
    }
    return res;
  }

  async isHealthy() {
    try {
      const res = await this.#request('/api/v2/app/version');
      const ver = await res.text();
      return { ok: true, version: ver.trim() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async addTorrent({ magnet, torrentUrl, savePath = '/data/downloads', category = 'sebitv' }) {
    const urls = magnet || torrentUrl;
    if (!urls) throw new Error('Se requiere magnet o torrentUrl para añadir a qBittorrent.');

    try {
      await this.#request('/api/v2/torrents/add', {
        method: 'POST',
        form: {
          urls,
          savepath: savePath,
          category,
          sequentialDownload: 'false',
          firstLastPiecePrio: 'true',
        },
      });
    } catch (err) {
      // En qBittorrent v5.x, HTTP 409 significa que ese mismo infoHash ya está añadido en el cliente
      if (!String(err.message).includes('HTTP 409')) {
        throw err;
      }
    }
  }

  async getTorrents(hashes = null) {
    const query = hashes?.length ? `?hashes=${hashes.map((h) => h.toLowerCase()).join('|')}` : '';
    const res = await this.#request(`/api/v2/torrents/info${query}`);
    return res.json();
  }

  async getTorrentByHash(hash) {
    if (!hash) return null;
    const list = await this.getTorrents([hash]);
    return list[0] || null;
  }

  async getTorrentFiles(hash) {
    const res = await this.#request(`/api/v2/torrents/files?hash=${encodeURIComponent(hash.toLowerCase())}`);
    const files = await res.json();
    return (files || []).map((f, idx) => ({
      ...f,
      index: f.index !== undefined ? f.index : idx,
    }));
  }

  async waitForFilesMetadata(hash, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const files = await this.getTorrentFiles(hash);
        // Cuando un magnet aún descarga metadatos, files está vacío o solo muestra el hash
        if (files.length > 0 && files.some((f) => (f.size || 0) > 0)) {
          return files;
        }
      } catch {
        // Seguir esperando metadatos
      }
      await sleep(1500);
    }
    return [];
  }

  async setFilePriorities(hash, indices, priority) {
    if (!indices || indices.length === 0) return;
    await this.#request('/api/v2/torrents/filePrio', {
      method: 'POST',
      form: {
        hash: hash.toLowerCase(),
        id: indices.join('|'),
        priority: String(priority),
      },
    });
  }

  /**
   * Activa únicamente los índices deseados (prioridad 7 máxima) y desactiva el resto (prioridad 0)
   * si no están siendo usados por otro capítulo activo del mismo pack.
   */
  async selectOnlyNeededFiles(hash, allFileIndices, activeNeededIndices) {
    const neededSet = new Set(activeNeededIndices);
    const toDisable = allFileIndices.filter((idx) => !neededSet.has(idx));
    const toEnable = allFileIndices.filter((idx) => neededSet.has(idx));

    if (toDisable.length > 0) {
      await this.setFilePriorities(hash, toDisable, 0);
    }
    if (toEnable.length > 0) {
      await this.setFilePriorities(hash, toEnable, 7);
    }
  }

  async deleteTorrent(hash, deleteFiles = true) {
    if (!hash) return;
    await this.#request('/api/v2/torrents/delete', {
      method: 'POST',
      form: {
        hashes: hash.toLowerCase(),
        deleteFiles: deleteFiles ? 'true' : 'false',
      },
    });
  }
}

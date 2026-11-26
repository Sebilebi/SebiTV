import path from 'node:path';

export function getBaseConfig() {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data', 'config');
  const mediaRoot = process.env.MEDIA_ROOT || path.join(process.cwd(), 'data', 'library');
  const jellyfinMediaRoot = process.env.JELLYFIN_MEDIA_ROOT || '/data/media';
  const downloadsRoot = process.env.DOWNLOADS_ROOT || path.join(process.cwd(), 'data', 'downloads');

  return {
    port: Number.parseInt(process.env.SEBITV_PORT || '8099', 10),
    publicUrl: (process.env.SEBITV_PUBLIC_URL || '').trim(),
    dataDir,
    dbPath: path.join(dataDir, 'sebitv.db'),
    mediaRoot,
    jellyfinMediaRoot,
    downloadsRoot,
    tmdbApiKey: (process.env.TMDB_API_KEY || '').trim(),
    jellyfinUrl: (process.env.JELLYFIN_URL || 'http://jellyfin:8096').replace(/\/+$/, ''),
    jellyfinUser: (process.env.JELLYFIN_USER || '').trim(),
    jellyfinPass: process.env.JELLYFIN_PASS || '',
    jellyfinApiKey: (process.env.JELLYFIN_API_KEY || '').trim(),
    qbitUrl: (process.env.QBIT_URL || 'http://qbittorrent:8080').replace(/\/+$/, ''),
    qbitUser: (process.env.QBIT_USER || 'admin').trim(),
    qbitPass: process.env.QBIT_PASS || '',
    extBaseUrl: (process.env.EXT_BASE_URL || 'https://ext.to').replace(/\/+$/, ''),
    extCookie: (process.env.EXT_COOKIE || '').trim(),
    extUserAgent:
      process.env.EXT_USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    nyaaEnabled: (process.env.NYAA_ENABLED || 'true').toLowerCase() !== 'false',
    nyaaBaseUrl: (process.env.NYAA_BASE_URL || 'https://nyaa.si').replace(/\/+$/, ''),
    prowlarrUrl: (process.env.PROWLARR_URL || '').replace(/\/+$/, ''),
    prowlarrApiKey: (process.env.PROWLARR_API_KEY || '').trim(),
    subdlApiKey: (process.env.SUBDL_API_KEY || '').trim(),
    windowBehind: Math.max(0, Number.parseInt(process.env.WINDOW_BEHIND || '1', 10)),
    windowAhead: Math.max(0, Number.parseInt(process.env.WINDOW_AHEAD || '1', 10)),
    movieRetentionHours: Math.max(0, Number.parseInt(process.env.MOVIE_RETENTION_HOURS || '48', 10)),
    pollIntervalSeconds: Math.max(3, Number.parseInt(process.env.POLL_INTERVAL_SECONDS || '5', 10)),
  };
}

export function resolveRuntimeConfig(db) {
  const base = getBaseConfig();
  if (!db) return base;
  const overrides = db.getAllSettings();
  return {
    ...base,
    tmdbApiKey: overrides.tmdbApiKey || base.tmdbApiKey,
    extCookie: overrides.extCookie || base.extCookie,
    extUserAgent: overrides.extUserAgent || base.extUserAgent,
    extBaseUrl: (overrides.extBaseUrl || base.extBaseUrl).replace(/\/+$/, ''),
    prowlarrUrl: (overrides.prowlarrUrl || base.prowlarrUrl).replace(/\/+$/, ''),
    prowlarrApiKey: overrides.prowlarrApiKey || base.prowlarrApiKey,
    subdlApiKey: overrides.subdlApiKey || base.subdlApiKey,
    jellyfinApiKey: overrides.jellyfinApiKey || base.jellyfinApiKey,
    jellyfinUserId: overrides.jellyfinUserId || '',
    windowBehind: overrides.windowBehind !== undefined ? Number(overrides.windowBehind) : base.windowBehind,
    windowAhead: overrides.windowAhead !== undefined ? Number(overrides.windowAhead) : base.windowAhead,
  };
}

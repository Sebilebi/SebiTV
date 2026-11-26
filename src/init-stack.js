import fs from 'node:fs';
import path from 'node:path';

const DATA_ROOT = process.env.INIT_DATA_ROOT || '/data';
const PUID = Number.parseInt(process.env.PUID || '1000', 10);
const PGID = Number.parseInt(process.env.PGID || '1000', 10);
const SEBITV_PORT = process.env.SEBITV_PORT || '8099';
const SEBITV_PUBLIC_URL = process.env.SEBITV_PUBLIC_URL || '';

const dirs = [
  path.join(DATA_ROOT, 'library', 'movies'),
  path.join(DATA_ROOT, 'library', 'series'),
  path.join(DATA_ROOT, 'library', 'anime'),
  path.join(DATA_ROOT, 'downloads'),
  path.join(DATA_ROOT, 'appdata', 'sebitv', 'config'),
  path.join(DATA_ROOT, 'appdata', 'sebitv', 'jellyfin-plugin'),
  path.join(DATA_ROOT, 'appdata', 'qbittorrent', 'qBittorrent'),
  path.join(DATA_ROOT, 'appdata', 'jellyfin', 'config'),
  path.join(DATA_ROOT, 'appdata', 'jellyfin', 'cache'),
];

for (const dir of dirs) {
  fs.mkdirSync(dir, { recursive: true });
}

// 1. Pre-configurar qBittorrent para permitir control local desde SebiTV sin bloqueo de contraseña inicial
const qbitConfPath = path.join(DATA_ROOT, 'appdata', 'qbittorrent', 'qBittorrent', 'qBittorrent.conf');
if (!fs.existsSync(qbitConfPath)) {
  const qbitConf = [
    '[LegalNotice]',
    'Accepted=true',
    '',
    '[BitTorrent]',
    'Session\\DefaultSavePath=/data/downloads/',
    'Session\\TempPath=/data/downloads/incomplete/',
    'Session\\TempPathEnabled=false',
    'Session\\Preallocation=false',
    '',
    '[Preferences]',
    'Downloads\\SavePath=/data/downloads/',
    'WebUI\\Address=*',
    'WebUI\\Port=8080',
    'WebUI\\LocalHostAuth=false',
    'WebUI\\AuthSubnetWhitelistEnabled=true',
    'WebUI\\AuthSubnetWhitelist=172.16.0.0/12, 192.168.0.0/16, 10.0.0.0/8, 127.0.0.1/32',
    'WebUI\\CSRFProtection=false',
    'WebUI\\ClickjackingProtection=false',
    'WebUI\\HostHeaderValidation=false',
    '',
  ].join('\n');
  fs.writeFileSync(qbitConfPath, qbitConf, 'utf8');
  console.log('[SebiTV Init] Creado qBittorrent.conf inicial con acceso de red interna Docker.');
}

// 2. Copiar archivos del plugin web de Jellyfin normalizando saltos de línea LF
const pluginOutDir = path.join(DATA_ROOT, 'appdata', 'sebitv', 'jellyfin-plugin');
const appRoot = process.cwd();

const writeLf = (srcRel, dstName, mode = 0o644) => {
  const raw = fs.readFileSync(path.join(appRoot, srcRel), 'utf8').replace(/\r\n/g, '\n');
  const dst = path.join(pluginOutDir, dstName);
  fs.writeFileSync(dst, raw, { encoding: 'utf8', mode });
  fs.chmodSync(dst, mode);
};

writeLf('docker/jellyfin-entrypoint.sh', 'jellyfin-entrypoint.sh', 0o755);
writeLf('jellyfin-web/sebitv-ui.css', 'sebitv-ui.css', 0o644);
writeLf('jellyfin-web/sebitv-ui.js', 'sebitv-ui.js', 0o644);

const configJs = `window.SEBITV_CONFIG = {
  port: ${JSON.stringify(String(SEBITV_PORT))},
  publicUrl: ${JSON.stringify(String(SEBITV_PUBLIC_URL))}
};\n`;
fs.writeFileSync(path.join(pluginOutDir, 'sebitv-config.js'), configJs, 'utf8');

// 3. Ajustar permisos PUID:PGID para que los contenedores no-root escriban sin errores
const chownRecursive = (targetPath) => {
  try {
    fs.chownSync(targetPath, PUID, PGID);
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(targetPath)) {
        chownRecursive(path.join(targetPath, entry));
      }
    }
  } catch {
    // En entornos Windows de prueba chown puede no aplicar; en Linux Docker aplica a 1000:1000
  }
};

for (const sub of ['library', 'downloads', path.join('appdata', 'sebitv'), path.join('appdata', 'qbittorrent')]) {
  chownRecursive(path.join(DATA_ROOT, sub));
}

console.log('[SebiTV Init] Inicialización completada correctamente.');

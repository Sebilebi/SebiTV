#!/bin/sh
set -e

SRC_WEB="/jellyfin/jellyfin-web"
DST_WEB="/cache/jellyfin-web-sebitv"
PLUGIN_DIR="/sebitv-plugin"

echo "[SebiTV] Sincronizando interfaz Jellyfin Web en ${DST_WEB}..."
rm -rf "${DST_WEB}"
cp -r "${SRC_WEB}" "${DST_WEB}"

cp "${PLUGIN_DIR}/sebitv-config.js" "${DST_WEB}/sebitv-config.js"
cp "${PLUGIN_DIR}/sebitv-ui.css" "${DST_WEB}/sebitv-ui.css"
cp "${PLUGIN_DIR}/sebitv-ui.js" "${DST_WEB}/sebitv-ui.js"

# Cargador dinámico sin caché: descarga siempre la última versión de sebitv-ui desde el contenedor sebitv
cat << 'EOF' > "${DST_WEB}/sebitv-loader.js"
(function () {
  var cfg = window.SEBITV_CONFIG || {};
  var isDefaultPort = !window.location.port || window.location.port === '80' || window.location.port === '443';
  var base = cfg.publicUrl
    ? cfg.publicUrl.replace(/\/+$/, '')
    : isDefaultPort
      ? window.location.origin
      : (window.location.protocol + '//' + window.location.hostname + ':' + (cfg.port || '8099'));
  var ts = Date.now();
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = base + '/ui/sebitv-ui.css?v=' + ts;
  link.onerror = function () { link.href = 'sebitv-ui.css'; };
  document.head.appendChild(link);

  var s = document.createElement('script');
  s.src = base + '/ui/sebitv-ui.js?v=' + ts;
  s.defer = true;
  s.onerror = function () {
    var fb = document.createElement('script');
    fb.src = 'sebitv-ui.js';
    document.head.appendChild(fb);
  };
  document.head.appendChild(s);
})();
EOF

INDEX_FILE="${DST_WEB}/index.html"
if [ -f "${INDEX_FILE}" ]; then
  INJECT='<script src="sebitv-config.js"></script><script src="sebitv-loader.js" defer></script></body>'
  sed -i "s|</body>|${INJECT}|g" "${INDEX_FILE}"
  echo "[SebiTV] Cargador dinámico SebiTV inyectado correctamente en Jellyfin Web."
fi

exec /jellyfin/jellyfin "$@"

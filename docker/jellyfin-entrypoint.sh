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

INDEX_FILE="${DST_WEB}/index.html"
if [ -f "${INDEX_FILE}" ]; then
  INJECT='<link rel="stylesheet" href="sebitv-ui.css"><script src="sebitv-config.js"></script><script src="sebitv-ui.js" defer></script></body>'
  sed -i "s|</body>|${INJECT}|g" "${INDEX_FILE}"
  echo "[SebiTV] Plugin de interfaz inyectado correctamente en Jellyfin Web."
fi

exec /jellyfin/jellyfin "$@"

# SebiTV — Catálogo Total y Descarga Bajo Demanda dentro de Jellyfin

**SebiTV** convierte **Jellyfin** en tu única interfaz para descubrir, descargar y reproducir cualquier película, serie o anime con gestión automática de espacio en disco para tu servidor Proxmox (`d-media`).

---

## ¿Qué hace automáticamente?

1. **Todo desde Jellyfin (Web, App de Windows y Apps oficiales de Android e iOS):**
   * Añade el buscador y las filas del catálogo mundial directamente dentro de la pantalla de inicio y búsqueda de Jellyfin.
   * **Nunca sale el botón `▶ Play` hasta que el vídeo está 100 % descargado:** mientras no esté en disco, ves todas las temporadas, capítulos y OVAs con el botón **`⬇ Descargar`** (por capítulo suelto, temporada completa, OVAs o serie entera). En cuanto llega al 100 %, aparece automáticamente el botón **`▶ Play`**.
2. **Reglas estrictas de idioma y subtítulos (validadas con `ffprobe` y `mkvpropedit`):**
   * **Anime (Series, OVAs y Películas de anime):** Audio original en **Japonés** (o Dual con japonés activo por defecto) + **Subtítulos obligatorios en Español de España (Castellano)** y, si no existen en castellano, en **Español Latino**. Si un vídeo no tiene ninguno de los dos, se descarta automáticamente.
   * **Series comerciales y Películas no-anime (Juego de Tronos, Star Wars, etc.):** Audio obligatorio en **Español Castellano** y **subtítulos desactivados** por defecto (rechaza audio latino y VOSE).
3. **Ventana deslizante `[N-1, N, N+1]` para no llenar tus 120 GB de disco:**
   * Al darle a `▶ Play` al **Capítulo 1**, empieza a descargar automáticamente en segundo plano el **Capítulo 2**.
   * Cuando vas por el **Capítulo 5**, conservas listos para reproducir los capítulos **4 (`-1`), 5 (actual) y 6 (`+1`)**, y se desinstalan automáticamente del disco del **Capítulo 3 hacia atrás** (salvo los que marques con **`📌 Fijar`**). Los capítulos borrados siguen visibles en la temporada por si algún día quieres volver a bajarlos.
   * **Packs de Temporada inteligentes:** Si el mejor torrent en `ext.to` es una temporada entera de 24 capítulos, `SebiTV` ordena a `qBittorrent` descargar **únicamente el archivo del capítulo que necesitas**.

---

## ¿Para qué sirve la `TMDB_API_KEY` gratuita y cómo sacarla en 1 minuto?

En `ext.to` hay millones de nombres de archivos torrent en bruto (`Juego.de.Tronos.1x01.1080p.mkv`), sin pósters ordenados ni lista limpia de temporadas/capítulos/OVAs.
**TMDB (The Movie Database)** es la base de datos gratuita y oficial que usan Jellyfin, Kodi y Seerr para saber **qué películas, series, animes, temporadas, capítulos y OVAs existen en el mundo**, con sus títulos en español, carátulas y código IMDb para cruzarlos con `ext.to`.

1. Crea una cuenta gratuita e inicia sesión en: https://www.themoviedb.org/
2. Entra en **Ajustes → API**: https://www.themoviedb.org/settings/api
3. Pulsa **Solicitar una clave API (Developer)** (rellena uso personal / homelab) y copia tu **Clave de la API** o **Token de acceso de lectura**.
4. Pégala en `TMDB_API_KEY` en Dockhand **o directamente desde el botón `⚙` dentro de Jellyfin**.

---

## Despliegue en tu Proxmox (`d-media` — Dockhand `http://192.168.1.164:3000`)

Hemos sustituido `seerr`, `maintainerr` y `bazarr` (que no funcionaban sin Sonarr/Radarr y consumían ~500 MB de RAM) por un stack limpio y ligero con **`jellyfin` (con tu GPU NVIDIA intacta)** + **`qbittorrent`** + **`sebitv`**.

### Opción A (Recomendada): Desplegar desde Git en Dockhand
1. Sube este repositorio (`SebiTV`) a tu cuenta de GitHub (público o privado).
2. En **Dockhand** (`http://192.168.1.164:3000/stacks`), detén/elimina el antiguo `media-stack`.
3. Haz clic arriba a la derecha en **`Desde Git`**, pega la URL de tu repo `SebiTV` y añade tus variables de entorno (ver `.env.example`):
   * `TMDB_API_KEY=...`
   * `JELLYFIN_USER=Sebilebi`
   * `JELLYFIN_PASS=tu_contraseña_de_jellyfin`
4. Pulsa **Desplegar**.

### Opción B: Copiar carpeta directamente a la VM `d-media`
1. Sube el contenido de `SebiTV` a `/srv/media/appdata/sebitv-repo` en la VM `d-media` (`192.168.1.164`).
2. Copia `.env.example` a `.env`, rellena `TMDB_API_KEY`, `JELLYFIN_USER` y `JELLYFIN_PASS`, y ejecuta:
   ```bash
   cd /srv/media/appdata/sebitv-repo
   docker compose up -d --build
   ```
   *(Después puedes pulsar **`Adoptar`** en Dockhand para gestionarlo visualmente).*

---

## Puertos del nuevo Stack en `192.168.1.164`

* **Jellyfin (Única interfaz que necesitas usar):** `http://192.168.1.164:8096`
* **API interna de SebiTV (usada automáticamente por Jellyfin):** `http://192.168.1.164:8099/api/health`
* **qBittorrent WebUI (opcional, todo es automático):** `http://192.168.1.164:8080`

---

## Ejecutar pruebas locales

```bash
npm test
```

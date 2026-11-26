FROM node:24-alpine

# ffmpeg incluye ffprobe para validar pistas de audio/subtítulos reales
# mkvtoolnix incluye mkvpropedit para marcar pistas por defecto sin recodificar
RUN apk add --no-cache \
    ffmpeg \
    mkvtoolnix \
    tzdata

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY jellyfin-web ./jellyfin-web
COPY docker ./docker

ENV NODE_ENV=production \
    SEBITV_PORT=8099 \
    DATA_DIR=/config \
    MEDIA_ROOT=/data/media \
    DOWNLOADS_ROOT=/data/downloads

EXPOSE 8099

CMD ["node", "src/server.js"]

import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB por archivo antes de rotar

function normalizeLevel(raw = 'INFO') {
  const up = String(raw || 'INFO').toUpperCase().trim();
  if (up === 'WARN' || up === 'WARNING') return 'WARNING';
  if (up === 'ERR' || up === 'ERROR') return 'ERROR';
  if (up === 'OK' || up === 'SUCCESS') return 'SUCCESS';
  if (up === 'USER' || up === 'UI') return 'USER';
  return 'INFO';
}

class SebiLogger {
  constructor() {
    this.db = null;
    this.logFilePath = null;
    this.insertCount = 0;
  }

  init({ dataDir, db }) {
    this.db = db || null;
    if (dataDir) {
      const logsDir = path.join(dataDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      this.logFilePath = path.join(logsDir, 'sebitv.log');
    }
  }

  #rotateIfNeeded() {
    if (!this.logFilePath) return;
    try {
      if (fs.existsSync(this.logFilePath)) {
        const st = fs.statSync(this.logFilePath);
        if (st.size >= MAX_LOG_BYTES) {
          const backup = `${this.logFilePath}.1`;
          fs.rmSync(backup, { force: true });
          fs.renameSync(this.logFilePath, backup);
        }
      }
    } catch {
      // Ignorar errores de rotación
    }
  }

  log(level, source, action, message, context = null) {
    const ts = new Date().toISOString();
    const lvl = normalizeLevel(level);
    const src = String(source || 'APP').toUpperCase();
    const act = String(action || 'event');
    const msg = String(message || '');
    const ctxStr = context !== null && context !== undefined ? JSON.stringify(context) : null;

    const paddedTag = `[${lvl}]`.padEnd(9, ' ');
    const headerDivider =
      lvl === 'USER' || lvl === 'ERROR'
        ? '────────────────────────────────────────────────────────────────────────────────\n'
        : '';
    const ctxBlock = ctxStr ? `\n    ↳ Contexto: ${ctxStr}` : '';
    const formattedBlock = `${headerDivider}${paddedTag} ${ts.replace('T', ' ').slice(0, 23)} | [${src}:${act}] ${msg}${ctxBlock}`;

    if (lvl === 'ERROR') {
      console.error(formattedBlock);
    } else if (lvl === 'WARNING') {
      console.warn(formattedBlock);
    } else {
      console.log(formattedBlock);
    }

    if (this.logFilePath) {
      try {
        this.#rotateIfNeeded();
        fs.appendFileSync(this.logFilePath, `${formattedBlock}\n`, 'utf8');
      } catch {
        // Ignorar fallo de escritura en disco
      }
    }

    if (this.db) {
      try {
        this.db.insertEventLog({
          ts,
          level: lvl,
          source: src,
          action: act,
          message: msg,
          contextJson: ctxStr,
        });
        this.insertCount++;
        if (this.insertCount % 100 === 0) {
          this.db.pruneEventLogs(5000);
        }
      } catch {
        // Ignorar si la BD ya se cerró en un test
      }
    }
  }

  user(action, message, context = null) {
    this.log('USER', 'UI', action, message, context);
  }

  info(source, action, message, context = null) {
    this.log('INFO', source, action, message, context);
  }

  success(source, action, message, context = null) {
    this.log('SUCCESS', source, action, message, context);
  }

  warn(source, action, message, context = null) {
    this.log('WARNING', source, action, message, context);
  }

  error(source, action, message, context = null) {
    const cleanCtx =
      context instanceof Error
        ? { error: context.message, stack: context.stack }
        : context;
    this.log('ERROR', source, action, message, cleanCtx);
  }

  readTailLines(maxLines = 400) {
    if (!this.logFilePath || !fs.existsSync(this.logFilePath)) return '';
    try {
      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trimEnd().split('\n');
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }
}

export const logger = new SebiLogger();

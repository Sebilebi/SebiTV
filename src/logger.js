import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB por archivo antes de rotar

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
    const lvl = String(level || 'INFO').toUpperCase();
    const src = String(source || 'APP').toUpperCase();
    const act = String(action || 'event');
    const msg = String(message || '');
    const ctxStr = context !== null && context !== undefined ? JSON.stringify(context) : null;

    const line = `[${ts}] [${lvl}] [${src}] (${act}) ${msg}${ctxStr ? ` | ${ctxStr}` : ''}`;

    if (lvl === 'ERROR') {
      console.error(line);
    } else if (lvl === 'WARN') {
      console.warn(line);
    } else {
      console.log(line);
    }

    if (this.logFilePath) {
      try {
        this.#rotateIfNeeded();
        fs.appendFileSync(this.logFilePath, `${line}\n`, 'utf8');
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

  info(source, action, message, context = null) {
    this.log('INFO', source, action, message, context);
  }

  warn(source, action, message, context = null) {
    this.log('WARN', source, action, message, context);
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

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|sebitv|jellyfin|qbittorrent|.*\.local|.*\.lan|.*\.internal)$/i;

export function extractHostname(hostHeader = '') {
  const raw = String(hostHeader || '').trim();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end !== -1 ? raw.slice(0, end + 1).toLowerCase() : raw.toLowerCase();
  }
  return raw.split(':')[0].toLowerCase();
}

export function isExternalDomainRequest(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return true;
  const hostname = extractHostname(req.headers.host);
  if (!hostname) return false;
  return !PRIVATE_HOST_RE.test(hostname);
}

export function sendGhost404(res, setCookies = []) {
  const headers = {
    'Content-Length': '0',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };
  if (setCookies.length > 0) {
    headers['Set-Cookie'] = setCookies;
  }
  res.writeHead(404, headers);
  res.end();
}

function parseCookies(cookieHeader = '') {
  const out = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function b64urlEncode(bufOrStr) {
  return Buffer.from(bufOrStr).toString('base64url');
}

function signPayload(payloadObj, secret) {
  const data = b64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySignedPayload(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function httpJsonRequest(targetUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const reqHeaders = { ...headers };
    if (body !== null && reqHeaders['Content-Length'] === undefined) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 500, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timeout conectando con Authentik')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export class RemoteAuthGate {
  constructor(db, getConfig) {
    this.db = db;
    this.getConfig = getConfig;
    this.reverifyCache = new Map(); // jti -> timestamp ms
  }

  #getSecret() {
    let secret = this.db.getSetting('gateHmacSecret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      this.db.setSetting('gateHmacSecret', secret);
    }
    return secret;
  }

  #isSecureReq(req) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https' || Boolean(req.headers['cf-ray']);
  }

  #cookieFlags(req, maxAgeSec) {
    const parts = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
    if (this.#isSecureReq(req)) parts.push('Secure');
    return parts.join('; ');
  }

  #matchesRequiredGroup(groups, requiredGroup) {
    const reqGrp = String(requiredGroup || '').trim().toLowerCase();
    if (!reqGrp) return true;
    if (!Array.isArray(groups)) return false;
    return groups.some((g) => String(g || '').trim().toLowerCase() === reqGrp);
  }

  #resolveAuthentikEndpoints(cfg) {
    const authUrlStr = (cfg.authentikAuthorizeUrl || '').trim();
    if (!cfg.authentikClientId || !authUrlStr) return null;
    let authUrl;
    try {
      authUrl = new URL(authUrlStr);
    } catch {
      return null;
    }
    const internalOrigin = (cfg.authentikInternalUrl || `${authUrl.protocol}//${authUrl.host}`).replace(/\/+$/, '');
    return {
      authorizeUrl: authUrlStr,
      authorizeHost: authUrl.host,
      authorizeProto: authUrl.protocol.replace(':', ''),
      tokenUrl: `${internalOrigin}/application/o/token/`,
      userinfoUrl: `${internalOrigin}/application/o/userinfo/`,
    };
  }

  async #fetchUserinfo(endpoints, accessToken) {
    const res = await httpJsonRequest(endpoints.userinfoUrl, {
      method: 'GET',
      headers: {
        Host: endpoints.authorizeHost,
        'X-Forwarded-Proto': endpoints.authorizeProto,
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      timeoutMs: 5000,
    });
    if (res.status !== 200 || !res.json?.sub) return null;
    return res.json;
  }

  async handleCallback(req, res, url) {
    const cfg = this.getConfig();
    const endpoints = this.#resolveAuthentikEndpoints(cfg);
    if (!endpoints) {
      sendGhost404(res);
      return;
    }

    const secret = this.#getSecret();
    const cookies = parseCookies(req.headers.cookie);
    const statePayload = verifySignedPayload(cookies.__sebitv_state, secret);
    const clearStateCookie = `__sebitv_state=; ${this.#cookieFlags(req, 0)}`;
    const denyAndRedirect = (target = '/') => {
      const nxCookie = `__sebitv_nx=1; ${this.#cookieFlags(req, 5)}`;
      res.writeHead(302, {
        Location: target,
        'Set-Cookie': [clearStateCookie, nxCookie],
        'Cache-Control': 'no-store',
      });
      res.end();
    };

    const incomingState = url.searchParams.get('state') || '';
    if (!statePayload || statePayload.state !== incomingState) {
      sendGhost404(res, [clearStateCookie]);
      return;
    }

    const returnTo = statePayload.returnTo?.startsWith('/') ? statePayload.returnTo : '/';
    const oidcError = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (oidcError || !code) {
      denyAndRedirect(returnTo);
      return;
    }

    try {
      const proto = this.#isSecureReq(req) ? 'https' : 'http';
      const redirectUri = `${proto}://${req.headers.host}/_sebitv_auth/callback`;
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.authentikClientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: statePayload.verifier,
      });
      if (cfg.authentikClientSecret) {
        form.set('client_secret', cfg.authentikClientSecret);
      }

      const tokRes = await httpJsonRequest(endpoints.tokenUrl, {
        method: 'POST',
        headers: {
          Host: endpoints.authorizeHost,
          'X-Forwarded-Proto': endpoints.authorizeProto,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        timeoutMs: 6000,
      });

      const accessToken = tokRes.json?.access_token;
      if (tokRes.status !== 200 || !accessToken) {
        denyAndRedirect(returnTo);
        return;
      }

      const userinfo = await this.#fetchUserinfo(endpoints, accessToken);
      if (!userinfo || !this.#matchesRequiredGroup(userinfo.groups, cfg.authentikRequiredGroup)) {
        logger.warn('AUTH', 'remote.denied_group', 'Usuario autenticado en Authentik pero sin permiso/grupo SebiTV', {
          username: userinfo?.preferred_username || userinfo?.sub || 'unknown',
          groups: userinfo?.groups || [],
          requiredGroup: cfg.authentikRequiredGroup,
        });
        denyAndRedirect(returnTo);
        return;
      }

      const jti = crypto.randomBytes(12).toString('hex');
      const now = Date.now();
      const sessToken = signPayload(
        {
          jti,
          sub: userinfo.sub,
          username: userinfo.preferred_username || userinfo.name || userinfo.sub,
          accessToken,
          exp: now + 24 * 3600 * 1000,
        },
        secret
      );
      this.reverifyCache.set(jti, now);
      logger.success('AUTH', 'remote.allow', `Acceso remoto autorizado vía Authentik: ${userinfo.preferred_username || userinfo.sub}`);

      const sessCookie = `__sebitv_sess=${sessToken}; ${this.#cookieFlags(req, 86400)}`;
      const clearNx = `__sebitv_nx=; ${this.#cookieFlags(req, 0)}`;
      res.writeHead(302, {
        Location: returnTo,
        'Set-Cookie': [clearStateCookie, clearNx, sessCookie],
        'Cache-Control': 'no-store',
      });
      res.end();
    } catch (err) {
      logger.error('AUTH', 'remote.callback_error', `Error verificando sesión con Authentik: ${err.message}`);
      denyAndRedirect(returnTo);
    }
  }

  async checkHttpAccess(req, res, url) {
    if (url.pathname === '/_sebitv_auth/callback' && req.method === 'GET') {
      await this.handleCallback(req, res, url);
      return false;
    }

    const cfg = this.getConfig();
    const endpoints = this.#resolveAuthentikEndpoints(cfg);
    if (!endpoints) {
      sendGhost404(res);
      return false;
    }

    const secret = this.#getSecret();
    const cookies = parseCookies(req.headers.cookie);
    const sess = verifySignedPayload(cookies.__sebitv_sess, secret);

    if (sess?.accessToken) {
      const reverifyMs = Math.max(0, Number(cfg.authentikReverifySeconds ?? 15)) * 1000;
      const lastOk = this.reverifyCache.get(sess.jti) || 0;
      if (Date.now() - lastOk >= reverifyMs) {
        try {
          const userinfo = await this.#fetchUserinfo(endpoints, sess.accessToken);
          if (!userinfo || !this.#matchesRequiredGroup(userinfo.groups, cfg.authentikRequiredGroup)) {
            this.reverifyCache.delete(sess.jti);
            logger.warn('AUTH', 'remote.revoked', `Acceso remoto revocado en Authentik para ${sess.username || sess.sub}`);
            sendGhost404(res, [`__sebitv_sess=; ${this.#cookieFlags(req, 0)}`]);
            return false;
          }
          this.reverifyCache.set(sess.jti, Date.now());
        } catch {
          // Si hay un microcorte de red local puntual, permitir sesión firmada unos segundos; si caduca fallará
          if (!lastOk) {
            sendGhost404(res);
            return false;
          }
        }
      }
      return true;
    }

    // Sin sesión: solo iniciar comprobación silenciosa OIDC (prompt=none) en navegación HTML de navegador real
    const accept = String(req.headers.accept || '');
    const isHtmlNav = req.method === 'GET' && accept.includes('text/html') && !url.pathname.startsWith('/api/');
    if (!isHtmlNav || cookies.__sebitv_nx === '1') {
      sendGhost404(res);
      return false;
    }

    const state = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const proto = this.#isSecureReq(req) ? 'https' : 'http';
    const redirectUri = `${proto}://${req.headers.host}/_sebitv_auth/callback`;
    const stateToken = signPayload(
      {
        state,
        verifier,
        returnTo: `${url.pathname}${url.search}`,
        exp: Date.now() + 120_000,
      },
      secret
    );

    const authRedirect = new URL(endpoints.authorizeUrl);
    authRedirect.searchParams.set('client_id', cfg.authentikClientId);
    authRedirect.searchParams.set('response_type', 'code');
    authRedirect.searchParams.set('scope', 'openid profile groups');
    authRedirect.searchParams.set('prompt', 'none');
    authRedirect.searchParams.set('state', state);
    authRedirect.searchParams.set('redirect_uri', redirectUri);
    authRedirect.searchParams.set('code_challenge', challenge);
    authRedirect.searchParams.set('code_challenge_method', 'S256');

    res.writeHead(302, {
      Location: authRedirect.toString(),
      'Set-Cookie': `__sebitv_state=${stateToken}; ${this.#cookieFlags(req, 120)}`,
      'Cache-Control': 'no-store',
    });
    res.end();
    return false;
  }

  checkWebSocketAccess(req) {
    if (!isExternalDomainRequest(req)) return true;
    const cfg = this.getConfig();
    if (!this.#resolveAuthentikEndpoints(cfg)) return false;
    const cookies = parseCookies(req.headers.cookie);
    const sess = verifySignedPayload(cookies.__sebitv_sess, this.#getSecret());
    return Boolean(sess?.accessToken);
  }
}

function stripInternalCookies(cookieHeader = '') {
  if (!cookieHeader) return '';
  return String(cookieHeader)
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith('__sebitv_'))
    .join('; ');
}

export function proxyHttpToJellyfin(req, res, jellyfinUrl) {
  const target = new URL(jellyfinUrl);
  const lib = target.protocol === 'https:' ? https : http;
  const fwdHeaders = { ...req.headers };
  const cleanedCookie = stripInternalCookies(fwdHeaders.cookie);
  if (cleanedCookie) fwdHeaders.cookie = cleanedCookie;
  else delete fwdHeaders.cookie;

  fwdHeaders['x-forwarded-host'] = req.headers.host || '';
  fwdHeaders['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || (req.headers['cf-ray'] ? 'https' : 'http');
  if (req.headers['cf-connecting-ip']) {
    fwdHeaders['x-real-ip'] = req.headers['cf-connecting-ip'];
  }
  fwdHeaders.host = target.host;

  const upstream = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: req.url || '/',
      method: req.method,
      headers: fwdHeaders,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    res.end('Jellyfin no disponible temporalmente');
  });

  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
}

export function attachJellyfinWebSocketProxy(server, getConfig, gate) {
  server.on('upgrade', (req, clientSocket, head) => {
    if (!gate.checkWebSocketAccess(req)) {
      clientSocket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const cfg = getConfig();
    let target;
    try {
      target = new URL(cfg.jellyfinUrl);
    } catch {
      clientSocket.destroy();
      return;
    }

    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const upstreamSocket = net.connect(port, target.hostname, () => {
      const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/${req.httpVersion || '1.1'}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        if (k.toLowerCase() === 'host') {
          lines.push(`Host: ${target.host}`);
        } else if (k.toLowerCase() === 'cookie') {
          const clean = stripInternalCookies(v);
          if (clean) lines.push(`Cookie: ${clean}`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      lines.push('', '');
      upstreamSocket.write(lines.join('\r\n'));
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });

    upstreamSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstreamSocket.destroy());
  });
}

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, MerchantRepository, SupportTicketRepository } from '@youpi/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In production, reliably ensure environment variables from .env are loaded if not already provided
if (!process.env.BASE_PAYMENT_API_URL && typeof process.loadEnvFile === 'function') {
  try {
    const rootEnv = path.resolve(__dirname, '../../../.env');
    if (fs.existsSync(rootEnv)) {
      process.loadEnvFile(rootEnv);
    }
  } catch {}
}

export class AdminServer {
  /**
   * @param {{
   *   db?: import('@youpi/db').Database,
   *   apiBaseUrl?: string
   * }} options
   */
  constructor(options = {}) {
    this.db = options.db || getDatabase();
    this.apiBaseUrl = options.apiBaseUrl || process.env.BASE_PAYMENT_API_URL || 'http://localhost:6100';
    this.merchantRepo = new MerchantRepository(this.db);
    this.ticketRepo = new SupportTicketRepository(this.db);
    this.htmlTemplatePath = path.join(__dirname, 'views', 'admin.html');
    this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
  }

  /**
   * Resolve an upstream target for reverse proxying.
   *
   * Supports both deployment topologies:
   *  - Single host (all services on one machine): http://localhost:6100
   *  - Split hosts (Render / container platforms): https://service.onrender.com
   *
   * @param {string|undefined} baseUrl   Upstream base URL (may be undefined)
   * @param {number} fallbackPort        Port used when baseUrl is missing/invalid
   */
  resolveUpstream(baseUrl, fallbackPort) {
    const raw = String(baseUrl || '').trim() || `http://127.0.0.1:${fallbackPort}`;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = new URL(`http://127.0.0.1:${fallbackPort}`);
    }
    const isHttps = parsed.protocol === 'https:';
    const port = parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80);
    return {
      client: isHttps ? https : http,
      isHttps,
      hostname: parsed.hostname,
      port,
      hostHeader: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
    };
  }

  /**
   * Build the header set forwarded to an upstream service.
   * Strips hop-by-hop headers that must not be relayed across hosts.
   */
  buildProxyHeaders(incoming, target, extra = {}) {
    const {
      connection, keepAlive,
      'proxy-authenticate': _proxyAuthenticate,
      'proxy-authorization': _proxyAuthorization,
      te, trailer, transferEncoding, upgrade, 'transfer-encoding': _transferEncoding,
      ...forwardable
    } = incoming;
    return {
      ...forwardable,
      ...extra,
      host: target.hostHeader,
      'x-forwarded-host': incoming.host || '',
      'x-forwarded-proto': incoming['x-forwarded-proto'] || (target.isHttps ? 'https' : 'http')
    };
  }

  renderHtml() {
    try {
      this.template = fs.readFileSync(this.htmlTemplatePath, 'utf8');
    } catch {}

    let html = this.template;
    // Always use empty string '' so client fetch calls hit the merchant admin's own /api proxy!
    // This completely eliminates CORS errors, tunnel downtime 530s, and cross-origin failures.
    const clientApiBase = '';
    html = html.replaceAll('{{API_BASE_URL}}', clientApiBase);
    html = html.replaceAll('{{ANDROID_ENROLLMENT_SECRET}}', process.env.ANDROID_ENROLLMENT_SECRET || 'android_pairing_enrollment_secret_key_32_chars');
    return html;
  }

  /**
   * Optional HTTP Basic Auth gate for the merchant admin surface.
   *
   * The admin UI and its /api/* proxy expose privileged payment operations, so
   * a public deployment (Render, Fly, a VPS behind a domain) must not leave them
   * open. Enable it by setting ADMIN_BASIC_AUTH_USER and ADMIN_BASIC_AUTH_PASS.
   * When unset the server stays open, which preserves the local single-host flow.
   *
   * @returns {{ ok: true } | { ok: false }} Result of the credential check
   */
  checkBasicAuth(req) {
    const expectedUser = process.env.ADMIN_BASIC_AUTH_USER;
    const expectedPass = process.env.ADMIN_BASIC_AUTH_PASS;
    if (!expectedUser || !expectedPass) return { ok: true };

    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return { ok: false };

    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      return { ok: false };
    }

    const sep = decoded.indexOf(':');
    if (sep < 0) return { ok: false };
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);

    const a = Buffer.from(user);
    const b = Buffer.from(expectedUser);
    const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);

    const c = Buffer.from(pass);
    const d = Buffer.from(expectedPass);
    const passOk = c.length === d.length && crypto.timingSafeEqual(c, d);

    return { ok: userOk && passOk };
  }

  createServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      // Keep the health probe open so orchestrators can check liveness.
      if (pathname !== '/health' && !this.checkBasicAuth(req).ok) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="YOUPI Merchant Admin", charset="UTF-8"',
          'Content-Type': 'application/json'
        });
        res.end(JSON.stringify({ error: 'Unauthorized', message: 'Merchant admin requires authentication.' }));
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return;
      }

      // Health
      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'UP', service: 'merchant-admin' }));
        return;
      }

      // Admin Tickets API: GET /api/admin/tickets
      if (pathname === '/api/admin/tickets') {
        const merchants = this.merchantRepo.findAll();
        const mId = merchants[0]?.id || '00000000-0000-0000-0000-000000000001';
        const tickets = this.ticketRepo.findTicketsByMerchant(mId);

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(tickets));
        return;
      }

      // Merged Control Center Supervisor Proxy: /api/services/* and /api/logs/stream -> Control Center
      // Works both single-host (localhost:8090) and split-host (BASE_CONTROL_CENTER_URL).
      if (pathname.startsWith('/api/services') || pathname === '/api/logs/stream') {
        const cc = this.resolveUpstream(process.env.BASE_CONTROL_CENTER_URL, Number(process.env.CONTROL_CENTER_PORT || 8090));
        const proxyReq = cc.client.request({
          hostname: cc.hostname,
          port: cc.port,
          path: req.url,
          method: req.method,
          headers: this.buildProxyHeaders(req.headers, cc)
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Control center supervisor unavailable', details: err.message }));
          }
        });

        req.on('data', chunk => proxyReq.write(chunk));
        req.on('end', () => proxyReq.end());
        return;
      }

      // Transparent API Proxy: /api/* -> Payment Core REST API
      if (pathname.startsWith('/api/')) {
        // Resolve from BASE_PAYMENT_API_URL so this works when the payment API
        // runs on a different host (e.g. Render) instead of localhost.
        const target = this.resolveUpstream(this.apiBaseUrl, Number(process.env.PAYMENT_API_PORT || 6100));
        const defaultMerchant = this.merchantRepo.getDefault ? this.merchantRepo.getDefault() : (this.merchantRepo.findById('00000000-0000-0000-0000-000000000001') || this.merchantRepo.findAll()[0]);
        const defaultMerchantId = defaultMerchant?.id || '00000000-0000-0000-0000-000000000001';
        const proxyReq = target.client.request({
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: this.buildProxyHeaders(req.headers, target, {
            'x-merchant-id': req.headers['x-merchant-id'] || defaultMerchantId
          })
        }, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Gateway API unavailable', details: err.message }));
          }
        });

        req.pipe(proxyReq);
        return;
      }

      // Download Android Companion APK
      if (pathname === '/youpi-sms-gateway.apk' || pathname === '/api/v1/admin/sms-gateway/download-apk') {
        const apkCandidates = [
          path.resolve(__dirname, '../public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../payment-api/public/youpi-sms-gateway.apk'),
          path.resolve(__dirname, '../../android-observer-app/youpi-sms-gateway.apk')
        ];
        let apkPath = null;
        for (const p of apkCandidates) {
          if (fs.existsSync(p)) {
            apkPath = p;
            break;
          }
        }
        if (apkPath) {
          const stat = fs.statSync(apkPath);
          res.writeHead(200, {
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Disposition': 'attachment; filename="youpi-sms-gateway.apk"',
            'Content-Length': stat.size,
            'Access-Control-Allow-Origin': '*'
          });
          const stream = fs.createReadStream(apkPath);
          stream.pipe(res);
          return;
        }
      }

      // Dashboard View: GET / or GET /admin
      if (pathname === '/' || pathname === '/admin') {
        const html = this.renderHtml();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(html);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Admin Route Not Found');
    });
  }
}

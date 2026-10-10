import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { renderAgenda } from './admin.js';
import { createBot } from './bot.js';
import { cancelByToken, createBooking, getDates, getSlots, lookupByTokens, publicConfig } from './book.js';
import { markProcessed, openDb } from './db.js';
import { createDemo } from './demo.js';
import { runReminders, sendConfirmation } from './reminders.js';
import { dayOfWeek, nowLocal } from './time.js';
import { createWhatsApp, parseWebhook } from './whatsapp.js';

try {
  process.loadEnvFile();
} catch {
  // sem .env: usa variáveis do ambiente
}

const env = process.env;

// Funciona tanto na estrutura com pastas (src/) quanto com todos os arquivos soltos na mesma pasta
const here = new URL('.', import.meta.url);
const configUrl = existsSync(new URL('./config.json', here)) ? new URL('./config.json', here) : new URL('../config.json', here);
const ROOT = new URL('.', configUrl);
const config = JSON.parse(readFileSync(configUrl, 'utf8'));
const db = openDb(env.DB_FILE || './barbearia.db');

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const brand = COLOR_RE.test(config.theme?.brand ?? '') ? config.theme.brand : '#14284b';
const accent = COLOR_RE.test(config.theme?.accent ?? '') ? config.theme.accent : '#c8102e';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Envio de mensagens ----------

let sender;
if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
  sender = createWhatsApp({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID });
} else {
  console.warn('⚠️  WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID não definidos: as respostas só serão impressas no console.');
  const log = (to, what) => console.log(`[→ ${to}]`, what);
  sender = {
    sendText: async (to, body) => log(to, body),
    sendTemplate: async (to, name, _lang, params) => log(to, `modelo "${name}": ${params.join(' | ')}`),
    sendButtons: async (to, body, buttons) => log(to, `${body}\n${buttons.map((b) => `[${b.title}]`).join(' ')}`),
    sendList: async (to, body, _label, rows) => log(to, `${body}\n${rows.map((r) => `- ${r.title}`).join('\n')}`),
  };
}

const clock = () => nowLocal(config.timezone);
const bot = createBot({ db, config, sender, clock });

// Tela de demonstração do WhatsApp (DEMO_MODE=1): não usa o banco real nem a API da Meta
const demo = env.DEMO_MODE === '1' ? createDemo({ config, clock }) : null;

// Endereço público do site (usado no link de cancelamento enviado por WhatsApp)
const publicBase = () => {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/$/, '');
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return '';
};

// ---------- Utilidades HTTP ----------

const chains = new Map();
function enqueue(phone, job) {
  const prev = chains.get(phone) ?? Promise.resolve();
  const next = prev.then(job).catch((err) => console.error('Erro ao processar mensagem:', err));
  chains.set(phone, next);
  next.finally(() => {
    if (chains.get(phone) === next) chains.delete(phone);
  });
}

function validSignature(raw, header) {
  if (!env.WHATSAPP_APP_SECRET) return true; // apenas desenvolvimento
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw).digest('hex');
  const given = header.slice(7);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload grande demais'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const json = (res, status, body) =>
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v[v.length - 1] > 3_600_000) hits.delete(k);
  }
  return recent.length > max;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();

// ---------- Imagens (logo e fotos dos serviços) ----------

const IMG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|svg|gif)$/i;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' };

function imagePath(name) {
  if (!IMG_RE.test(name ?? '')) return null;
  const file = fileURLToPath(new URL(name, ROOT));
  return existsSync(file) ? file : null;
}

function findLogo() {
  const candidates = [config.logo, 'logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp', 'logo.svg'];
  const name = candidates.find((c) => c && imagePath(c));
  return name ? `/img/${name}` : null;
}

function serveImage(res, name) {
  const file = imagePath(name);
  if (!file) return res.writeHead(404).end();
  const ext = name.split('.').pop().toLowerCase();
  const headers = { 'Content-Type': MIME[ext], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (ext === 'svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  res.writeHead(200, headers).end(readFileSync(file));
}

// ---------- Página de agendamento ----------

const pageTemplate = readFileSync(new URL('./agendar.html', here), 'utf8');

function renderPage(req) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0];
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
  const base = publicBase() || `${proto}://${host}`;
  const logo = findLogo();
  const description = config.tagline || `Agende seu horário na ${config.shopName}`;
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(config.shopName)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    logo ? `<meta property="og:image" content="${escapeHtml(base + logo)}">` : '',
    logo ? `<link rel="apple-touch-icon" href="${escapeHtml(logo)}">` : '',
    logo ? `<link rel="icon" href="${escapeHtml(logo)}">` : '',
  ].join('\n');
  return pageTemplate
    .replaceAll('__SHOP_NAME__', escapeHtml(config.shopName))
    .replaceAll('__DESCRIPTION__', escapeHtml(description))
    .replaceAll('__BRAND__', brand)
    .replaceAll('__ACCENT__', accent)
    .replace('__OG__', og);
}

// ---------- API do agendamento por link ----------

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, 20_000)).toString('utf8'));
  } catch {
    return null;
  }
}

const STATUS = { not_found: 404, conflict: 409, limit: 409, too_late: 409 };
const sendResult = (res, r, ok) =>
  r.ok ? json(res, 200, ok(r)) : json(res, STATUS[r.error] ?? 400, { error: r.error, message: r.message });

async function handleApi(req, res, url) {
  const ip = clientIp(req);
  if (limited(`api:${ip}`, 240, 60_000)) {
    return json(res, 429, { error: 'rate', message: 'Muitas requisições. Aguarde um minuto.' });
  }
  const now = clock();
  const q = Object.fromEntries(url.searchParams);
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/config') {
    return json(res, 200, publicConfig(config, { logo: findLogo(), todayDow: dayOfWeek(now.date) }));
  }
  if (route === 'GET /api/dates') return sendResult(res, getDates(db, config, q, now), (r) => ({ dates: r.dates }));
  if (route === 'GET /api/slots') return sendResult(res, getSlots(db, config, q, now), (r) => ({ slots: r.slots }));

  if (req.method === 'POST') {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'json', message: 'Requisição inválida.' });

    if (route === 'POST /api/book') {
      if (limited(`book:${ip}`, 8, 3_600_000)) {
        return json(res, 429, { error: 'rate', message: 'Muitas tentativas. Tente novamente mais tarde.' });
      }
      const r = createBooking(db, config, body, now);
      if (r.ok) {
        sendConfirmation({ sender, config, appt: r.row, baseUrl: publicBase() }).catch((e) =>
          console.error('Erro ao enviar confirmação:', e),
        );
      }
      return sendResult(res, r, (x) => ({ appointment: x.appointment, token: x.token }));
    }
    if (route === 'POST /api/mine') return json(res, 200, { appointments: lookupByTokens(db, config, body.tokens, now) });
    if (route === 'POST /api/cancel') return sendResult(res, cancelByToken(db, config, body.token, now), () => ({}));
  }
  return json(res, 404, { error: 'not_found', message: 'Não encontrado.' });
}

// ---------- Servidor ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200).end('ok');
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/agendar')) {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' })
        .end(renderPage(req));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      serveImage(res, decodeURIComponent(url.pathname.slice(5)));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (demo && req.method === 'GET' && url.pathname === '/demo') {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(demo.html);
      return;
    }

    if (demo && req.method === 'POST' && url.pathname === '/demo/api') {
      let input;
      try {
        input = JSON.parse((await readBody(req, 10_000)).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"json inválido"}');
        return;
      }
      const { status, body } = await demo.respond(input);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      return;
    }

    // Verificação inicial do webhook pela Meta
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const ok =
        url.searchParams.get('hub.mode') === 'subscribe' &&
        env.WHATSAPP_VERIFY_TOKEN &&
        url.searchParams.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN;
      if (ok) res.writeHead(200, { 'Content-Type': 'text/plain' }).end(url.searchParams.get('hub.challenge'));
      else res.writeHead(403).end();
      return;
    }

    // Mensagens recebidas
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      if (!validSignature(raw, req.headers['x-hub-signature-256'])) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end(); // responde rápido; o processamento segue em segundo plano

      for (const { id, from, msg } of parseWebhook(JSON.parse(raw.toString('utf8')))) {
        if (!markProcessed(db, id)) continue; // reenvio da Meta
        enqueue(from, () => bot.handle(from, msg));
      }
      return;
    }

    // Agenda do dia para o barbeiro
    if (req.method === 'GET' && url.pathname === '/admin') {
      const token = url.searchParams.get('token') ?? '';
      const expected = env.ADMIN_TOKEN ?? '';
      const authorized =
        expected && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
      if (!authorized) {
        res.writeHead(401).end('Não autorizado');
        return;
      }
      const dateParam = url.searchParams.get('date');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? '') ? dateParam : nowLocal(config.timezone).date;
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(renderAgenda({ db, config, date, token }));
      return;
    }

    res.writeHead(404).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

// Lembretes: confere a cada minuto se algum precisa sair
if (config.reminders?.enabled) {
  const tick = () => runReminders({ db, config, sender, clock, baseUrl: publicBase() }).catch((e) => console.error(e));
  setTimeout(tick, 5_000).unref();
  setInterval(tick, 60_000).unref();
}

const port = Number(env.PORT) || 3000;
server.listen(port, () => {
  console.log(`💈 ${config.shopName} — servidor na porta ${port}`);
  console.log(`   Página de agendamento em http://localhost:${port}/`);
  if (demo) console.log(`   Demonstração do WhatsApp em http://localhost:${port}/demo`);
});

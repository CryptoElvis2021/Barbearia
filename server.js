import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { renderAgenda } from './admin.js';
import { createBot } from './bot.js';
import { markProcessed, openDb } from './db.js';
import { createDemo } from './demo.js';
import { nowLocal } from './time.js';
import { createWhatsApp, parseWebhook } from './whatsapp.js';

try {
  process.loadEnvFile();
} catch {
  // sem .env: usa variáveis do ambiente
}

const env = process.env;
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
const db = openDb(env.DB_FILE || './barbearia.db');

let sender;
if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
  sender = createWhatsApp({ token: env.WHATSAPP_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID });
} else {
  console.warn('⚠️  WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID não definidos: as respostas só serão impressas no console.');
  const log = (to, what) => console.log(`[→ ${to}]`, what);
  sender = {
    sendText: async (to, body) => log(to, body),
    sendButtons: async (to, body, buttons) => log(to, `${body}\n${buttons.map((b) => `[${b.title}]`).join(' ')}`),
    sendList: async (to, body, _label, rows) => log(to, `${body}\n${rows.map((r) => `- ${r.title}`).join('\n')}`),
  };
}

const clock = () => nowLocal(config.timezone);
const bot = createBot({ db, config, sender, clock });

// Tela de demonstração (DEMO_MODE=1): não usa o banco real nem a API da Meta
const demo = env.DEMO_MODE === '1' ? createDemo({ config, clock }) : null;

// Uma fila por cliente: mensagens do mesmo número são tratadas em ordem
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200).end('ok');
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

const port = Number(env.PORT) || 3000;
server.listen(port, () => {
  console.log(`💈 ${config.shopName} — servidor na porta ${port}`);
  if (demo) console.log(`   Demonstração em http://localhost:${port}/demo`);
});

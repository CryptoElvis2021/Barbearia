// Modo demonstração: uma tela estilo WhatsApp (/demo) que conversa com o bot de verdade,
// mas sem usar a API da Meta. Cada visitante ganha uma barbearia de teste isolada, em memória.
import { readFileSync } from 'node:fs';
import { createBot } from './bot.js';
import { openDb } from './db.js';

const MAX_SESSIONS = 200;
const SID_RE = /^[a-z0-9]{8,40}$/;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createDemo({ config, clock }) {
  const html = readFileSync(new URL('./demo.html', import.meta.url), 'utf8').replaceAll(
    '__SHOP_NAME__',
    escapeHtml(config.shopName),
  );
  const sessions = new Map();

  function sessionFor(sid) {
    let s = sessions.get(sid);
    if (s) return s;

    if (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      sessions.get(oldest).db.close();
      sessions.delete(oldest);
    }

    const db = openDb(':memory:');
    s = { db, outbox: [], chain: Promise.resolve() };
    const sender = {
      sendText: async (_to, body) => s.outbox.push({ kind: 'text', body }),
      sendButtons: async (_to, body, buttons) => s.outbox.push({ kind: 'buttons', body, buttons }),
      sendList: async (_to, body, label, rows) => s.outbox.push({ kind: 'list', body, label, rows }),
    };
    s.bot = createBot({ db, config, sender, clock });
    sessions.set(sid, s);
    return s;
  }

  // Devolve { status, body } pronto para virar resposta HTTP
  async function respond(input) {
    const { sid, text, replyId, title } = input ?? {};
    if (typeof sid !== 'string' || !SID_RE.test(sid)) return { status: 400, body: { error: 'sid inválido' } };

    let msg;
    if (typeof replyId === 'string' && replyId.length <= 100) {
      msg = { type: 'reply', id: replyId, title: String(title ?? '').slice(0, 60) };
    } else if (typeof text === 'string' && text.trim() && text.length <= 300) {
      msg = { type: 'text', text };
    } else {
      return { status: 400, body: { error: 'mensagem inválida' } };
    }

    const s = sessionFor(sid);
    const run = s.chain.then(async () => {
      s.outbox = [];
      await s.bot.handle(`demo-${sid}`, msg);
      return s.outbox;
    });
    s.chain = run.catch(() => {});
    return { status: 200, body: { messages: await run } };
  }

  return { html, respond };
}

// Cliente da WhatsApp Cloud API (envio) e leitura do webhook (recebimento).

const trunc = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Parâmetros de modelo não aceitam quebras de linha, tabs nem muitos espaços seguidos
const param = (s) => String(s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 1000) || '-';

export function createWhatsApp({ token, phoneNumberId, apiVersion = 'v21.0' }) {
  async function post(payload) {
    try {
      const res = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      });
      if (!res.ok) console.error('Erro ao enviar mensagem:', res.status, await res.text());
      return res.ok;
    } catch (err) {
      console.error('Falha de rede ao enviar mensagem:', err.message);
      return false;
    }
  }

  return {
    sendText: (to, body) => post({ to, type: 'text', text: { body } }),

    // Mensagem iniciada pela barbearia (fora da janela de 24h): exige modelo aprovado pela Meta
    sendTemplate: (to, name, language, params) =>
      post({
        to,
        type: 'template',
        template: {
          name,
          language: { code: language },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: param(p) })) }],
        },
      }),

    // Até 3 botões; título de até 20 caracteres
    sendButtons: (to, body, buttons) =>
      post({
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: trunc(b.title, 20) } })),
          },
        },
      }),

    // Até 10 linhas; título de até 24 e descrição de até 72 caracteres
    sendList: (to, body, buttonLabel, rows, sectionTitle = 'Opções') =>
      post({
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: {
            button: trunc(buttonLabel, 20),
            sections: [
              {
                title: trunc(sectionTitle, 24),
                rows: rows.slice(0, 10).map((r) => ({
                  id: r.id,
                  title: trunc(r.title, 24),
                  ...(r.description ? { description: trunc(r.description, 72) } : {}),
                })),
              },
            ],
          },
        },
      }),
  };
}

// Converte o payload do webhook em uma lista simples de mensagens recebidas
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        let msg = { type: 'other' };
        if (m.type === 'text') {
          msg = { type: 'text', text: m.text.body };
        } else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (r) msg = { type: 'reply', id: r.id, title: r.title };
        }
        out.push({ id: m.id, from: m.from, msg });
      }
    }
  }
  return out;
}

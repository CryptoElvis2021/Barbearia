import { addDays, fmtDate, brl, toHHMM } from './time.js';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Página simples com a agenda do dia para o barbeiro/dono
export function renderAgenda({ db, config, date, token }) {
  const rows = db
    .prepare(
      "SELECT * FROM appointments WHERE date = ? AND status = 'confirmed' ORDER BY start_min, barber_id",
    )
    .all(date);

  const t = encodeURIComponent(token);
  const sections = config.barbers
    .map((b) => {
      const mine = rows.filter((r) => r.barber_id === b.id);
      const body = mine.length
        ? mine
            .map(
              (r) => `<tr>
                <td><strong>${toHHMM(r.start_min)}–${toHHMM(r.end_min)}</strong></td>
                <td>${esc(r.customer_name)}<br><small>${esc(r.phone)}</small></td>
                <td>${esc(r.service_name)}</td>
                <td>${brl(r.price_cents)}</td>
              </tr>`,
            )
            .join('')
        : '<tr><td colspan="4"><em>Sem agendamentos</em></td></tr>';
      return `<h2>${esc(b.name)}</h2><table>${body}</table>`;
    })
    .join('');

  const total = rows.reduce((sum, r) => sum + r.price_cents, 0);

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agenda – ${esc(config.shopName)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:16px;color:#1c1c1c}
  nav{display:flex;justify-content:space-between;align-items:center;margin:12px 0}
  a{color:#0a6;text-decoration:none;font-weight:600}
  table{width:100%;border-collapse:collapse;margin-bottom:8px}
  td{padding:10px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
  small{color:#777}
  .total{color:#555}
</style></head><body>
<h1>${esc(config.shopName)}</h1>
<nav>
  <a href="/admin?token=${t}&date=${addDays(date, -1)}">← Anterior</a>
  <strong>${esc(fmtDate(date))} (${date})</strong>
  <a href="/admin?token=${t}&date=${addDays(date, 1)}">Próximo →</a>
</nav>
${sections}
<p class="total">${rows.length} agendamento(s) • previsto ${brl(total)}</p>
</body></html>`;
}

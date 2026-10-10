// Confirmação e lembretes por WhatsApp.
// Mensagens que a barbearia inicia (fora da janela de 24h) precisam de modelos aprovados pela Meta;
// veja o README. Sem modelo configurado em config.templates, enviamos texto comum.
import { addDays, brl, dayDiff, fmtDate, toHHMM, toMin } from './time.js';

const first = (name) => String(name).trim().split(' ')[0];
const barberName = (config, id) => config.barbers.find((b) => b.id === id)?.name ?? id;

const insert = (db, id, kind) =>
  db.prepare('INSERT OR IGNORE INTO reminders_sent (appointment_id, kind, at) VALUES (?, ?, ?)').run(id, kind, Date.now())
    .changes > 0;
const wasSent = (db, id, kind) =>
  !!db.prepare('SELECT 1 FROM reminders_sent WHERE appointment_id = ? AND kind = ?').get(id, kind);

// Quando o horário de um lembrete já passou no momento da reserva, ele não deve sair logo em seguida.
export function markPastReminders(db, config, appt, now) {
  const r = config.reminders;
  if (!r?.enabled) return;
  const daysUntil = dayDiff(now.date, appt.date);
  if (daysUntil < 1 || (daysUntil === 1 && now.minutes >= toMin(r.dayBefore.at))) insert(db, appt.id, 'vespera');
  if (daysUntil < 0 || (daysUntil === 0 && now.minutes >= toMin(r.sameDay.at))) insert(db, appt.id, 'hoje');
}

export function dueReminders(db, config, now) {
  const r = config.reminders;
  if (!r?.enabled) return [];
  const tomorrow = addDays(now.date, 1);
  const rows = db
    .prepare("SELECT * FROM appointments WHERE status = 'confirmed' AND date IN (?, ?) ORDER BY date, start_min")
    .all(now.date, tomorrow);

  const due = [];
  for (const a of rows) {
    if (a.date === tomorrow && now.minutes >= toMin(r.dayBefore.at) && !wasSent(db, a.id, 'vespera')) {
      due.push({ appt: a, kind: 'vespera' });
    }
    if (
      a.date === now.date &&
      now.minutes >= toMin(r.sameDay.at) &&
      a.start_min - now.minutes >= 60 &&
      !wasSent(db, a.id, 'hoje')
    ) {
      due.push({ appt: a, kind: 'hoje' });
    }
  }
  return due;
}

export const cancelLink = (baseUrl, appt) =>
  baseUrl && appt.cancel_token ? `${baseUrl}/?cancelar=${appt.cancel_token}` : '';

// kind: 'confirmacao' | 'vespera' | 'hoje'
export function buildMessage(config, appt, kind, baseUrl = '') {
  const name = first(appt.customer_name);
  const time = toHHMM(appt.start_min);
  const barber = barberName(config, appt.barber_id);
  const link = cancelLink(baseUrl, appt);
  const tail = link ? ` Para cancelar: ${link}` : '';
  const fallback = link || config.phone;

  if (kind === 'confirmacao') {
    return {
      text:
        `✅ ${name}, seu horário está confirmado!\n` +
        `✂️ ${appt.service_name} com ${barber}\n` +
        `📅 ${fmtDate(appt.date)} às ${time}\n` +
        `💰 ${brl(appt.price_cents)} (pago na barbearia)\n` +
        `📍 ${config.address}` +
        (link ? `\nPara cancelar: ${link}` : ''),
      params: [name, fmtDate(appt.date), time, appt.service_name, barber, brl(appt.price_cents), fallback],
    };
  }
  const when = kind === 'vespera' ? 'amanhã' : 'hoje';
  return {
    text:
      kind === 'vespera'
        ? `Olá, ${name}! Lembrete: você tem horário amanhã às ${time} na ${config.shopName} (${appt.service_name} com ${barber}).${tail}`
        : `Olá, ${name}! Hoje você tem horário às ${time} na ${config.shopName} (${appt.service_name} com ${barber}). Esperamos você!${tail}`,
    params: [name, time, config.shopName, `${appt.service_name} com ${barber}`, fallback],
    when,
  };
}

async function deliver(sender, config, appt, kind, baseUrl) {
  const msg = buildMessage(config, appt, kind, baseUrl);
  const template = config.templates?.[kind];
  if (template && sender.sendTemplate) {
    await sender.sendTemplate(appt.phone, template, config.templates.language ?? 'pt_BR', msg.params);
  } else {
    await sender.sendText(appt.phone, msg.text);
  }
}

export async function sendConfirmation({ sender, config, appt, baseUrl }) {
  if (!config.reminders?.enabled || config.reminders.confirmation === false) return;
  await deliver(sender, config, appt, 'confirmacao', baseUrl);
}

let running = false;

// Chamada a cada minuto. Marca como enviado antes de enviar: se algo falhar, não repete em loop.
export async function runReminders({ db, config, sender, clock, baseUrl = '' }) {
  if (running) return 0;
  running = true;
  let sent = 0;
  try {
    for (const { appt, kind } of dueReminders(db, config, clock())) {
      if (!insert(db, appt.id, kind)) continue;
      try {
        await deliver(sender, config, appt, kind, baseUrl);
        sent++;
      } catch (err) {
        console.error('Erro ao enviar lembrete:', err);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

// Lógica do agendamento pelo link (página web). Funções puras: recebem db, config e "agora".
import { availableDates, book, freeSlots, upcomingFor } from './availability.js';
import { getCustomer, saveCustomer } from './db.js';
import { normalizePhone } from './phone.js';
import { markPastReminders } from './reminders.js';
import { addDays, minutesUntil, toHHMM } from './time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[a-f0-9]{32}$/;
const PHOTO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpe?g|webp|svg|gif)$/i;

const fail = (error, message) => ({ ok: false, error, message });
const barberName = (config, id) => config.barbers.find((b) => b.id === id)?.name ?? id;

export function publicConfig(config, { logo, todayDow }) {
  const photo = (p) => (p && PHOTO_RE.test(p) ? `/img/${p}` : null);
  const item = (s) => ({
    id: s.id,
    name: s.name,
    description: s.description ?? '',
    durationMin: s.durationMin,
    priceCents: s.priceCents,
    photo: photo(s.photo),
  });
  return {
    shopName: config.shopName,
    tagline: config.tagline ?? '',
    address: config.address,
    phone: config.phone,
    whatsapp: String(config.whatsappNumber ?? '').replace(/\D/g, ''),
    logo,
    services: config.services.map(item),
    extras: (config.extras ?? []).map(item),
    barbers: config.barbers.map((b) => ({ id: b.id, name: b.name })),
    hours: config.hours,
    todayDow,
    daysAhead: config.daysAhead,
    cancelMinHours: config.cancelMinHours,
    remindersEnabled: !!config.reminders?.enabled,
  };
}

// Junta o serviço principal e os extras escolhidos em um único "serviço" (soma tempo e preço)
function resolveSelection(config, q) {
  const main = config.services.find((s) => s.id === q.service);
  if (!main) return null;

  const ids = String(q.extras ?? '').split(',').filter(Boolean);
  if (ids.length > 5) return null;
  const extras = [];
  for (const id of ids) {
    const e = (config.extras ?? []).find((x) => x.id === id);
    if (!e) return null;
    if (!extras.includes(e)) extras.push(e);
  }

  const barber = q.barber ?? 'any';
  if (barber !== 'any' && !config.barbers.some((b) => b.id === barber)) return null;

  const parts = [main, ...extras];
  return {
    barber,
    service: {
      id: parts.map((p) => p.id).join('+'),
      name: parts.map((p) => p.name).join(' + '),
      durationMin: parts.reduce((n, p) => n + p.durationMin, 0),
      priceCents: parts.reduce((n, p) => n + p.priceCents, 0),
    },
  };
}

const validDate = (config, now, date) =>
  DATE_RE.test(date ?? '') && date >= now.date && date <= addDays(now.date, config.daysAhead);

export function getDates(db, config, q, now) {
  const sel = resolveSelection(config, q);
  if (!sel) return fail('selection', 'Escolha o serviço e o barbeiro.');
  const dates = availableDates(db, config, sel.barber, sel.service.durationMin, now, 31);
  return { ok: true, dates };
}

export function getSlots(db, config, q, now) {
  const sel = resolveSelection(config, q);
  if (!sel) return fail('selection', 'Escolha o serviço e o barbeiro.');
  if (!validDate(config, now, q.date)) return fail('date', 'Data inválida.');
  const slots = freeSlots(db, config, q.date, sel.barber, sel.service.durationMin, now).map((s) => ({
    start: s.start,
    time: toHHMM(s.start),
    barber: barberName(config, s.barberId),
  }));
  return { ok: true, slots };
}

export function view(config, row, now) {
  const until = minutesUntil(now, row.date, row.start_min);
  return {
    id: row.id,
    service: row.service_name,
    barber: barberName(config, row.barber_id),
    date: row.date,
    time: toHHMM(row.start_min),
    endTime: toHHMM(row.end_min),
    priceCents: row.price_cents,
    status: row.status,
    isPast: until < 0,
    canCancel: row.status === 'confirmed' && until >= config.cancelMinHours * 60,
  };
}

export function createBooking(db, config, body, now) {
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 40 || /^\d+$/.test(name)) return fail('name', 'Informe seu nome.');

  const phone = normalizePhone(body?.phone);
  if (!phone) return fail('phone', 'Telefone inválido. Informe o DDD e o número.');

  const sel = resolveSelection(config, body ?? {});
  if (!sel) return fail('selection', 'Escolha o serviço e o barbeiro.');
  if (!validDate(config, now, body.date)) return fail('date', 'Escolha uma data válida.');
  if (!Number.isInteger(body.start)) return fail('time', 'Escolha um horário.');

  if (upcomingFor(db, phone, now).length >= config.maxActiveAppointments) {
    return fail('limit', `Você já tem ${config.maxActiveAppointments} horários marcados. Cancele um para marcar outro.`);
  }

  const slot = freeSlots(db, config, body.date, sel.barber, sel.service.durationMin, now).find(
    (s) => s.start === body.start,
  );
  if (!slot) return fail('conflict', 'Esse horário acabou de ser ocupado. Escolha outro.');

  const r = book(db, {
    phone,
    customerName: name,
    barberId: slot.barberId,
    service: sel.service,
    date: body.date,
    start: body.start,
    source: 'link',
  });
  if (!r.ok) return fail('conflict', 'Esse horário acabou de ser ocupado. Escolha outro.');

  if (!getCustomer(db, phone)) saveCustomer(db, phone, name);
  markPastReminders(db, config, { id: r.id, date: body.date, start_min: body.start }, now);

  const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(r.id);
  return { ok: true, appointment: view(config, row, now), token: r.token, row };
}

// "Meus horários": o aparelho guarda os links secretos (tokens) dos agendamentos feitos nele
export function lookupByTokens(db, config, tokens, now) {
  const list = [];
  for (const token of (Array.isArray(tokens) ? tokens : []).slice(0, 20)) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) continue;
    const row = db.prepare('SELECT * FROM appointments WHERE cancel_token = ?').get(token);
    if (row) list.push({ token, ...view(config, row, now) });
  }
  list.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return list;
}

export function cancelByToken(db, config, token, now) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return fail('not_found', 'Agendamento não encontrado.');
  const row = db.prepare("SELECT * FROM appointments WHERE cancel_token = ? AND status = 'confirmed'").get(token);
  if (!row) return fail('not_found', 'Esse agendamento não está mais ativo.');
  if (minutesUntil(now, row.date, row.start_min) < config.cancelMinHours * 60) {
    return fail('too_late', `Cancelamentos pelo link só com mais de ${config.cancelMinHours}h de antecedência. Ligue para ${config.phone}.`);
  }
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(row.id);
  return { ok: true };
}

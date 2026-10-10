import crypto from 'node:crypto';
import { canonPhone } from './phone.js';
import { addDays, dayOfWeek, toMin } from './time.js';

export const hoursFor = (config, date) => config.hours[String(dayOfWeek(date))] ?? null;

function slotsForBarber(db, config, barberId, date, durationMin, now) {
  if (date < now.date) return [];
  const h = hoursFor(config, date);
  if (!h) return [];

  const open = toMin(h.open);
  const close = toMin(h.close);
  const breaks = (h.breaks ?? []).map(([a, b]) => [toMin(a), toMin(b)]);
  const booked = db
    .prepare("SELECT start_min, end_min FROM appointments WHERE barber_id = ? AND date = ? AND status = 'confirmed'")
    .all(barberId, date)
    .map((r) => [r.start_min, r.end_min]);
  const blocked = [...breaks, ...booked];

  const out = [];
  for (let t = open; t + durationMin <= close; t += config.slotMinutes) {
    if (date === now.date && t < now.minutes + config.minLeadMinutes) continue;
    if (blocked.some(([s, e]) => s < t + durationMin && e > t)) continue;
    out.push(t);
  }
  return out;
}

// Horários livres do dia. Com barberId === 'any', une os barbeiros e
// devolve, para cada horário, o primeiro barbeiro disponível.
export function freeSlots(db, config, date, barberId, durationMin, now) {
  const ids = barberId === 'any' ? config.barbers.map((b) => b.id) : [barberId];
  const byStart = new Map();
  for (const id of ids) {
    for (const start of slotsForBarber(db, config, id, date, durationMin, now)) {
      if (!byStart.has(start)) byStart.set(start, id);
    }
  }
  return [...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([start, barber]) => ({ start, barberId: barber }));
}

export function availableDates(db, config, barberId, durationMin, now, limit = 9) {
  const out = [];
  for (let i = 0; i <= config.daysAhead && out.length < limit; i++) {
    const date = addDays(now.date, i);
    if (freeSlots(db, config, date, barberId, durationMin, now).length > 0) out.push(date);
  }
  return out;
}

// Reserva com checagem de conflito dentro de uma transação exclusiva,
// para que dois clientes não consigam pegar o mesmo horário.
export function book(db, { phone, customerName, barberId, service, date, start, source = 'whatsapp' }) {
  const end = start + service.durationMin;
  const token = crypto.randomBytes(16).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const clash = db
      .prepare(
        "SELECT 1 FROM appointments WHERE barber_id = ? AND date = ? AND status = 'confirmed' AND start_min < ? AND end_min > ?",
      )
      .get(barberId, date, end, start);
    if (clash) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'conflict' };
    }
    const r = db
      .prepare(
        `INSERT INTO appointments
         (phone, customer_name, barber_id, service_id, service_name, price_cents, date, start_min, end_min, cancel_token, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        canonPhone(phone),
        customerName,
        barberId,
        service.id,
        service.name,
        service.priceCents,
        date,
        start,
        end,
        token,
        source,
      );
    db.exec('COMMIT');
    return { ok: true, id: Number(r.lastInsertRowid), token };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function upcomingFor(db, phone, now) {
  return db
    .prepare(
      `SELECT * FROM appointments
       WHERE phone = ? AND status = 'confirmed' AND (date > ? OR (date = ? AND start_min >= ?))
       ORDER BY date, start_min LIMIT 10`,
    )
    .all(canonPhone(phone), now.date, now.date, now.minutes);
}

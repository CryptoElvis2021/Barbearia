import { DatabaseSync } from 'node:sqlite';
import { canonPhone } from './phone.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

function addColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS customers (
      phone      TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      phone         TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      barber_id     TEXT NOT NULL,
      service_id    TEXT NOT NULL,
      service_name  TEXT NOT NULL,
      price_cents   INTEGER NOT NULL,
      date          TEXT NOT NULL,
      start_min     INTEGER NOT NULL,
      end_min       INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'confirmed',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_appt_slot  ON appointments (barber_id, date, status);
    CREATE INDEX IF NOT EXISTS idx_appt_phone ON appointments (phone, status, date);

    CREATE TABLE IF NOT EXISTS sessions (
      phone      TEXT PRIMARY KEY,
      state      TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_messages (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders_sent (
      appointment_id INTEGER NOT NULL,
      kind           TEXT NOT NULL,
      at             INTEGER NOT NULL,
      PRIMARY KEY (appointment_id, kind)
    );
  `);

  // Migrações para bancos criados em versões anteriores
  addColumn(db, 'appointments', 'cancel_token', 'cancel_token TEXT');
  addColumn(db, 'appointments', 'source', "source TEXT NOT NULL DEFAULT 'whatsapp'");
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_appt_token ON appointments (cancel_token)');
  return db;
}

export function getSession(db, phone) {
  const row = db.prepare('SELECT state, data, updated_at FROM sessions WHERE phone = ?').get(canonPhone(phone));
  if (!row || Date.now() - row.updated_at > SESSION_TTL_MS) return { state: 'idle', data: {} };
  return { state: row.state, data: JSON.parse(row.data) };
}

export function saveSession(db, phone, { state, data }) {
  db.prepare(
    `INSERT INTO sessions (phone, state, data, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(canonPhone(phone), state, JSON.stringify(data), Date.now());
}

export const getCustomer = (db, phone) =>
  db.prepare('SELECT phone, name FROM customers WHERE phone = ?').get(canonPhone(phone));

export function saveCustomer(db, phone, name) {
  db.prepare(
    `INSERT INTO customers (phone, name) VALUES (?, ?)
     ON CONFLICT(phone) DO UPDATE SET name = excluded.name`,
  ).run(canonPhone(phone), name);
}

// true se a mensagem é nova; false se o WhatsApp reenviou uma já processada
export function markProcessed(db, id) {
  const r = db.prepare('INSERT OR IGNORE INTO processed_messages (id, at) VALUES (?, ?)').run(id, Date.now());
  if (Math.random() < 0.01) {
    db.prepare('DELETE FROM processed_messages WHERE at < ?').run(Date.now() - 7 * 86400000);
  }
  return r.changes > 0;
}

// Datas são strings 'YYYY-MM-DD' e horários são minutos desde 00:00,
// sempre no fuso da barbearia. Evita bugs de fuso com objetos Date.

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function nowLocal(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')),
  };
}

export const dayOfWeek = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export const toHHMM = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function fmtDate(date) {
  const [, m, d] = date.split('-');
  return `${DIAS[dayOfWeek(date)]} ${d}/${m}`;
}

export const brl = (cents) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Minutos entre "agora" e um horário de agendamento (negativo = já passou)
export function minutesUntil(now, date, startMin) {
  return dayDiff(now.date, date) * 1440 + (startMin - now.minutes);
}

export { DIAS };

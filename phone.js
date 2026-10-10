// Telefones brasileiros: o WhatsApp às vezes entrega o número sem o 9 extra
// (55 + DDD + 8 dígitos). Guardamos sempre a forma canônica com o 9.

export function canonPhone(p) {
  const s = String(p ?? '');
  if (!/^\d+$/.test(s)) return s; // ids que não são números (ex.: simulador) ficam como estão
  const m = /^55(\d{2})([6-9]\d{7})$/.exec(s);
  return m ? `55${m[1]}9${m[2]}` : s;
}

// Aceita "(35) 99888-7777", "35998887777", "+55 35 99888-7777"... Devolve null se inválido.
export function normalizePhone(input) {
  let d = String(input ?? '').replace(/\D/g, '');
  d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!/^55\d{10,11}$/.test(d)) return null;
  if (Number(d.slice(2, 4)) < 11) return null; // DDD inválido
  return canonPhone(d);
}

import { availableDates, book, freeSlots, hoursFor, upcomingFor } from './availability.js';
import { getCustomer, getSession, saveCustomer, saveSession } from './db.js';
import { canonPhone } from './phone.js';
import { markPastReminders } from './reminders.js';
import { brl, DIAS, fmtDate, minutesUntil, toHHMM } from './time.js';

const PAGE_SIZE = 8;

const normalize = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

export function createBot({ db, config, sender, clock }) {
  const services = Object.fromEntries(config.services.map((s) => [s.id, s]));
  const barbers = Object.fromEntries(config.barbers.map((b) => [b.id, b]));
  const barberName = (id) => barbers[id]?.name ?? id;

  const say = (to, text) => sender.sendText(to, text);

  // ---------- Telas ----------

  async function showMenu(to, ctx) {
    ctx.state = 'idle';
    ctx.data = {};
    const customer = getCustomer(db, to);
    const hello = customer ? `Olá, ${customer.name}! ` : 'Olá! ';
    await sender.sendButtons(to, `${hello}Bem-vindo à *${config.shopName}* 💈\nComo posso ajudar?`, [
      { id: 'menu:book', title: 'Agendar horário' },
      { id: 'menu:mine', title: 'Meus horários' },
      { id: 'menu:info', title: 'Endereço e horários' },
    ]);
  }

  async function showInfo(to, ctx) {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const lines = order.map((d) => {
      const h = config.hours[String(d)];
      return `${DIAS[d]}: ${h ? `${h.open} às ${h.close}` : 'fechado'}`;
    });
    await say(
      to,
      `*${config.shopName}*\n📍 ${config.address}\n📞 ${config.phone}\n\n*Horário de funcionamento*\n${lines.join('\n')}`,
    );
    await showMenu(to, ctx);
  }

  async function startBooking(to, ctx, now) {
    const active = upcomingFor(db, to, now).length;
    if (active >= config.maxActiveAppointments) {
      await say(
        to,
        `Você já tem ${active} horários marcados. Para marcar outro, cancele um deles em *Meus horários*.`,
      );
      return showMenu(to, ctx);
    }
    ctx.state = 'booking';
    ctx.data = {};
    await sender.sendList(
      to,
      'Qual serviço você quer fazer?',
      'Ver serviços',
      config.services.map((s) => ({
        id: `svc:${s.id}`,
        title: s.name,
        description: `${brl(s.priceCents)} • ${s.durationMin} min`,
      })),
      'Serviços',
    );
  }

  async function askBarber(to) {
    await sender.sendList(
      to,
      'Com qual barbeiro?',
      'Ver barbeiros',
      [
        { id: 'bar:any', title: 'Tanto faz', description: 'O primeiro horário disponível' },
        ...config.barbers.map((b) => ({ id: `bar:${b.id}`, title: b.name })),
      ],
      'Barbeiros',
    );
  }

  async function askDate(to, ctx, now) {
    const svc = services[ctx.data.serviceId];
    const dates = availableDates(db, config, ctx.data.barberId, svc.durationMin, now);
    if (dates.length === 0) {
      await say(to, 'Não há horários livres nos próximos dias com essa escolha. Tente outro barbeiro ou ligue para nós. 🙏');
      return showMenu(to, ctx);
    }
    await sender.sendList(
      to,
      'Para qual dia?',
      'Ver dias',
      dates.map((d) => ({ id: `date:${d}`, title: fmtDate(d), description: d === now.date ? 'Hoje' : undefined })),
      'Dias disponíveis',
    );
  }

  async function askTime(to, ctx, now) {
    const svc = services[ctx.data.serviceId];
    const slots = freeSlots(db, config, ctx.data.date, ctx.data.barberId, svc.durationMin, now);
    if (slots.length === 0) {
      await say(to, 'Esse dia acabou de lotar. Vamos escolher outro? 🙏');
      return askDate(to, ctx, now);
    }
    let page = ctx.data.page ?? 0;
    if (page * PAGE_SIZE >= slots.length) page = 0;
    ctx.data.page = page;

    const rows = slots.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((s) => ({
      id: `time:${s.start}`,
      title: toHHMM(s.start),
      description: ctx.data.barberId === 'any' ? barberName(s.barberId) : undefined,
    }));
    if ((page + 1) * PAGE_SIZE < slots.length) rows.push({ id: 'more', title: 'Mais horários' });
    rows.push({ id: 'back:date', title: 'Escolher outro dia' });

    await sender.sendList(to, `Horários livres em *${fmtDate(ctx.data.date)}*:`, 'Ver horários', rows, 'Horários');
  }

  async function askName(to, ctx) {
    ctx.state = 'awaiting_name';
    await say(to, 'Para finalizar, qual é o seu nome?');
  }

  async function askConfirm(to, ctx) {
    ctx.state = 'booking';
    const { serviceId, barberId, date, start } = ctx.data;
    const svc = services[serviceId];
    await sender.sendButtons(
      to,
      [
        '*Confirme seu agendamento*',
        `✂️ ${svc.name}`,
        `👤 Barbeiro: ${barberName(barberId)}`,
        `📅 ${fmtDate(date)} às ${toHHMM(start)}`,
        `💰 ${brl(svc.priceCents)} (pago na barbearia)`,
      ].join('\n'),
      [
        { id: 'ok', title: 'Confirmar' },
        { id: 'back:date', title: 'Mudar horário' },
        { id: 'menu:home', title: 'Desistir' },
      ],
    );
  }

  async function showMine(to, ctx, now) {
    const list = upcomingFor(db, to, now);
    if (list.length === 0) {
      await say(to, 'Você não tem horários marcados no momento.');
      return showMenu(to, ctx);
    }
    await sender.sendList(
      to,
      'Seus horários marcados. Toque em um para ver os detalhes ou cancelar.',
      'Ver horários',
      list.map((a) => ({
        id: `appt:${a.id}`,
        title: `${fmtDate(a.date)} às ${toHHMM(a.start_min)}`,
        description: `${a.service_name} • ${barberName(a.barber_id)}`,
      })),
      'Meus horários',
    );
  }

  // ---------- Ações ----------

  async function finishBooking(to, ctx, now) {
    const { serviceId, barberId, date, start } = ctx.data;
    const svc = services[serviceId];
    const customer = getCustomer(db, to);

    // Revalida: o horário pode ter sido ocupado enquanto o cliente decidia
    const stillFree = freeSlots(db, config, date, barberId, svc.durationMin, now).find((s) => s.start === start);
    const chosenBarber = stillFree?.barberId ?? barberId;
    const result = stillFree
      ? book(db, { phone: to, customerName: customer.name, barberId: chosenBarber, service: svc, date, start })
      : { ok: false };

    if (!result.ok) {
      await say(to, 'Poxa, esse horário acabou de ser ocupado por outro cliente. 😕 Vamos escolher outro?');
      ctx.data.start = undefined;
      ctx.data.page = 0;
      return askTime(to, ctx, now);
    }

    markPastReminders(db, config, { id: result.id, date, start_min: start }, now);

    await say(
      to,
      [
        `✅ *Agendamento confirmado!* (#${result.id})`,
        '',
        `✂️ ${svc.name} com ${barberName(chosenBarber)}`,
        `📅 ${fmtDate(date)} às ${toHHMM(start)}`,
        `💰 ${brl(svc.priceCents)} (pago na barbearia)`,
        `📍 ${config.address}`,
        '',
        'Para ver ou cancelar, digite *meus horários*. Até lá! 💈',
      ].join('\n'),
    );
    ctx.state = 'idle';
    ctx.data = {};
  }

  async function showAppointment(to, ctx, id) {
    const appt = db
      .prepare("SELECT * FROM appointments WHERE id = ? AND phone = ? AND status = 'confirmed'")
      .get(id, canonPhone(to));
    if (!appt) {
      await say(to, 'Não encontrei esse agendamento (talvez já tenha sido cancelado).');
      return showMenu(to, ctx);
    }
    await sender.sendButtons(
      to,
      [
        `*Agendamento #${appt.id}*`,
        `✂️ ${appt.service_name} com ${barberName(appt.barber_id)}`,
        `📅 ${fmtDate(appt.date)} às ${toHHMM(appt.start_min)}`,
        `💰 ${brl(appt.price_cents)}`,
      ].join('\n'),
      [
        { id: `cancel:${appt.id}`, title: 'Cancelar horário' },
        { id: 'menu:mine', title: 'Voltar' },
      ],
    );
  }

  async function askCancel(to, ctx, id, now) {
    const appt = db
      .prepare("SELECT * FROM appointments WHERE id = ? AND phone = ? AND status = 'confirmed'")
      .get(id, canonPhone(to));
    if (!appt) {
      await say(to, 'Não encontrei esse agendamento (talvez já tenha sido cancelado).');
      return showMenu(to, ctx);
    }
    if (minutesUntil(now, appt.date, appt.start_min) < config.cancelMinHours * 60) {
      await say(
        to,
        `Cancelamentos só pelo chat com mais de ${config.cancelMinHours}h de antecedência. Por favor, ligue para ${config.phone}.`,
      );
      return showMenu(to, ctx);
    }
    await sender.sendButtons(
      to,
      `Cancelar *${appt.service_name}* em ${fmtDate(appt.date)} às ${toHHMM(appt.start_min)}?`,
      [
        { id: `cancelyes:${appt.id}`, title: 'Sim, cancelar' },
        { id: 'menu:home', title: 'Manter' },
      ],
    );
  }

  async function doCancel(to, ctx, id, now) {
    const appt = db
      .prepare("SELECT * FROM appointments WHERE id = ? AND phone = ? AND status = 'confirmed'")
      .get(id, canonPhone(to));
    if (!appt) {
      await say(to, 'Esse agendamento já não está ativo.');
      return showMenu(to, ctx);
    }
    if (minutesUntil(now, appt.date, appt.start_min) < config.cancelMinHours * 60) {
      await say(to, `Já passou do prazo para cancelar pelo chat. Ligue para ${config.phone}.`);
      return showMenu(to, ctx);
    }
    db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appt.id);
    await say(to, 'Horário cancelado. ✅ Quando quiser marcar de novo, é só chamar!');
    await showMenu(to, ctx);
  }

  // ---------- Entrada ----------

  // Se o cliente tocar num botão antigo, falta contexto: recomeça com educação
  async function restart(to, ctx) {
    await say(to, 'Essa opção expirou. Vamos recomeçar. 🙂');
    return showMenu(to, ctx);
  }

  async function onReply(to, ctx, id, now) {
    const [action, ...rest] = id.split(':');
    const arg = rest.join(':');
    const d = ctx.data;

    switch (action) {
      case 'menu':
        if (arg === 'book') return startBooking(to, ctx, now);
        if (arg === 'mine') return showMine(to, ctx, now);
        if (arg === 'info') return showInfo(to, ctx);
        return showMenu(to, ctx);

      case 'svc':
        if (!services[arg]) return restart(to, ctx);
        d.serviceId = arg;
        return askBarber(to);

      case 'bar':
        if (!d.serviceId || (arg !== 'any' && !barbers[arg])) return restart(to, ctx);
        d.barberId = arg;
        return askDate(to, ctx, now);

      case 'date':
        if (!d.serviceId || !d.barberId) return restart(to, ctx);
        d.date = arg;
        d.page = 0;
        return askTime(to, ctx, now);

      case 'more':
        if (!d.date) return restart(to, ctx);
        d.page = (d.page ?? 0) + 1;
        return askTime(to, ctx, now);

      case 'time': {
        if (!d.serviceId || !d.barberId || !d.date) return restart(to, ctx);
        const start = Number(arg);
        const svc = services[d.serviceId];
        const slot = freeSlots(db, config, d.date, d.barberId, svc.durationMin, now).find((s) => s.start === start);
        if (!slot) {
          await say(to, 'Esse horário acabou de ser ocupado. Escolha outro, por favor.');
          return askTime(to, ctx, now);
        }
        d.start = start;
        d.barberId = d.barberId === 'any' ? slot.barberId : d.barberId;
        return getCustomer(db, to) ? askConfirm(to, ctx) : askName(to, ctx);
      }

      case 'back':
        if (!d.serviceId || !d.barberId) return restart(to, ctx);
        return askDate(to, ctx, now);

      case 'ok':
        if (d.start == null || !d.date || !getCustomer(db, to)) return restart(to, ctx);
        return finishBooking(to, ctx, now);

      case 'appt':
        return showAppointment(to, ctx, Number(arg));
      case 'cancel':
        return askCancel(to, ctx, Number(arg), now);
      case 'cancelyes':
        return doCancel(to, ctx, Number(arg), now);

      default:
        return restart(to, ctx);
    }
  }

  async function onText(to, ctx, text, now) {
    const t = normalize(text);

    if (ctx.state === 'awaiting_name' && !['menu', 'cancelar', 'inicio'].includes(t)) {
      const name = text.trim().replace(/\s+/g, ' ').slice(0, 40);
      if (name.length < 2 || /^\d+$/.test(name)) {
        return say(to, 'Não entendi. Pode me dizer só o seu nome? Ex.: Carlos');
      }
      saveCustomer(db, to, name);
      return askConfirm(to, ctx);
    }

    if (/(meus (horarios|agendamentos)|cancel|desmarc)/.test(t)) return showMine(to, ctx, now);
    if (/(agendar|marcar|reservar|quero (um )?horario)/.test(t)) return startBooking(to, ctx, now);
    if (/(endereco|onde fica|funcionamento|telefone|atendente|humano)/.test(t)) return showInfo(to, ctx);
    return showMenu(to, ctx);
  }

  async function handle(phone, msg) {
    const now = clock();
    const ctx = getSession(db, phone);
    try {
      if (msg.type === 'text') await onText(phone, ctx, msg.text, now);
      else if (msg.type === 'reply') await onReply(phone, ctx, msg.id, now);
      else {
        await say(phone, 'Só consigo entender texto e as opções do menu por aqui. Digite *menu* para começar. 🙂');
      }
    } finally {
      saveSession(db, phone, ctx);
    }
  }

  return { handle };
}

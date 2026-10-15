// Replay do dia: busca os eventos gravados (/api/events?day=) e reproduz a
// cidade num relógio virtual (C.now), reaproveitando o mesmo tratamento de
// eventos do modo ao vivo (C.applyEvent).

(() => {
  'use strict';

  const C = window.Cidade;
  const $ = (sel) => document.querySelector(sel);
  const SPEEDS = [1, 10, 60];
  const MAX_IDLE_GAP_MS = 2 * 60 * 1000; // pausas longas são puladas
  const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  const bar = $('#replay-bar');
  const btn = $('#btn-replay');
  const playBtn = $('#rp-play');
  const range = $('#rp-range');
  const timeEl = $('#rp-time');
  const daySel = $('#rp-day');
  const infoEl = $('#rp-info');

  let events = [];
  let idx = 0;
  let vt = 0;          // tempo virtual (ms)
  let t0 = 0, t1 = 0;  // primeiro e último evento do dia
  let playing = false;
  let speed = 10;
  let lastFrame = 0;
  let skipNote = 0;

  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmt = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function fillDays() {
    daySel.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const ts = Date.now() - i * 864e5;
      const o = document.createElement('option');
      o.value = dayKey(ts);
      o.textContent = i === 0 ? 'hoje' : i === 1 ? 'ontem' : `${WEEKDAYS[new Date(ts).getDay()]} ${new Date(ts).getDate()}`;
      daySel.appendChild(o);
    }
  }

  function applyUntil(ts, animated) {
    while (idx < events.length && events[idx].ts <= ts) {
      const ev = events[idx++];
      C.applyEvent(animated ? { ...ev } : { ...ev, replay: true });
      if (animated) C.lastEventAt = ev.ts;
    }
  }

  // Volta a cidade ao estado do instante `ts` (aplica tudo até lá sem animação).
  function seek(ts) {
    C.resetPeople();
    idx = 0;
    vt = ts;
    applyUntil(ts, false);
    C.lastEventAt = ts;
    renderBar();
  }

  function renderBar() {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? 'Pausar' : 'Reproduzir';
    range.min = String(t0);
    range.max = String(t1);
    range.value = String(vt);
    timeEl.textContent = events.length ? fmt(vt) : '--:--:--';
    document.querySelectorAll('#replay-bar [data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === speed));
    const done = idx;
    infoEl.textContent = events.length
      ? `${done}/${events.length} eventos${skipNote > Date.now() ? ' · ⏩ pulando pausa' : ''} · perfis mostram dados atuais`
      : 'Nenhum evento gravado neste dia.';
  }

  function tick(now) {
    if (!C.replaying) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    if (playing && events.length) {
      vt += dt * 1000 * speed;
      // Pula pausas longas sem nada acontecendo.
      if (idx < events.length && events[idx].ts - vt > MAX_IDLE_GAP_MS) {
        vt = events[idx].ts - 2000;
        skipNote = Date.now() + 1500;
      }
      applyUntil(vt, speed <= 10);
      if (vt >= t1) { vt = t1; playing = false; }
      renderBar();
    }
    requestAnimationFrame(tick);
  }

  // `at`: se informado, para pausado nesse instante (usado pela busca no histórico).
  async function load(day, at) {
    infoEl.textContent = 'Carregando…';
    try {
      const r = await fetch(`/api/events?day=${day}`);
      events = (await r.json()).filter((e) => e && e.ts).sort((a, b) => a.ts - b.ts);
    } catch (_) {
      events = [];
    }
    t0 = events.length ? events[0].ts : 0;
    t1 = events.length ? events[events.length - 1].ts : 0;
    playing = events.length > 0 && at == null;
    seek(at == null ? t0 : Math.max(t0, Math.min(t1, at)));
  }

  // Abre o replay pausado alguns segundos antes de `ts`, no dia `day`.
  async function startAt(day, ts) {
    if (!C.replaying) await start({ day, at: ts - 5000 });
    else {
      daySel.value = day;
      await load(day, ts - 5000);
    }
  }

  async function start(opts) {
    if (C.replaying) return;
    opts = opts || {};
    if (C.scene.type === 'interior') C.exitInterior();
    C.replaying = true;
    C.timeScale = Math.min(speed, 8);
    C.setClock(() => vt);
    document.body.classList.add('replaying');
    bar.hidden = false;
    btn.classList.add('on');
    fillDays();
    if (opts.day) daySel.value = opts.day;
    lastFrame = performance.now();
    requestAnimationFrame(tick);
    await load(daySel.value, opts.at);
    C.emit('replay', true);
  }

  function stop() {
    if (!C.replaying) return;
    playing = false;
    C.replaying = false;
    C.timeScale = 1;
    C.setClock(null);
    document.body.classList.remove('replaying');
    bar.hidden = true;
    btn.classList.remove('on');
    C.resetPeople();
    C.reconnect(); // hello + snapshot + últimos eventos: volta ao estado ao vivo
    C.emit('replay', false);
  }

  btn.addEventListener('click', () => (C.replaying ? stop() : start()));
  $('#rp-live').addEventListener('click', stop);
  playBtn.addEventListener('click', () => {
    if (!events.length) return;
    if (!playing && vt >= t1) seek(t0);
    playing = !playing;
    renderBar();
  });
  document.querySelectorAll('#replay-bar [data-speed]').forEach((b) => b.addEventListener('click', () => {
    speed = Number(b.dataset.speed);
    C.timeScale = Math.min(speed, 8);
    renderBar();
  }));
  range.addEventListener('input', () => {
    const target = Number(range.value);
    if (target < vt) seek(target);
    else { vt = target; applyUntil(vt, false); renderBar(); }
  });
  daySel.addEventListener('change', () => load(daySel.value));
  window.addEventListener('keydown', (e) => {
    if (!C.replaying || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
    if (e.key === ' ') { e.preventDefault(); playBtn.click(); }
  });

  C.replay = { start, stop, startAt, SPEEDS };
})();

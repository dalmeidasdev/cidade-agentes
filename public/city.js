// Cidade dos Agentes — núcleo: estado dos habitantes, conexão SSE, cena da
// cidade, troca de cenas (cidade ↔ interiores) e cliques no canvas.
//
// O "mundo" é desenhado num canvas pequeno (baixa resolução) e ampliado sem
// suavização, o que dá o visual de pixel art. Textos e balões são desenhados
// depois, já na resolução da tela, para ficarem nítidos.
//
// Os outros scripts (interiors.js, hud.js) conversam com este por window.Cidade.

(() => {
  'use strict';

  const C = (window.Cidade = window.Cidade || {});
  const { BUILDINGS, LAYOUT, COLS, buildingFor, folderName, cleanCommand } = C.defs;

  // Relógio da cidade: o real, ou o da reprodução durante o replay.
  let clockFn = null;
  C.now = () => (clockFn ? clockFn() : +new Date());
  C.setClock = (fn) => { clockFn = fn; };

  for (const b of Object.values(BUILDINGS)) {
    if (b.sprite) { b.img = new Image(); b.img.src = b.sprite; }
  }

  // ---------------------------------------------------------------------------
  // Barramento de eventos simples (para o HUD)
  // ---------------------------------------------------------------------------
  const listeners = {};
  C.on = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };
  C.emit = (name, ...args) => {
    for (const fn of listeners[name] || []) {
      try { fn(...args); } catch (err) { console.error(`erro em ouvinte de "${name}"`, err); }
    }
  };

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------
  const people = new Map();   // habitantes na tela; chave: session_id ou session_id/agent_id
  const profiles = new Map(); // perfis vindos do servidor (persistentes)
  const doneIds = new Set();  // tool_use_id cujo Post chegou antes do Pre
  C.people = people;
  C.profiles = profiles;
  C.buildingInfo = {};
  C.stats = {};
  C.selected = null;
  C.scene = { type: 'city' };
  C.lastEventAt = 0;

  const SLEEP_AFTER_MS = 15 * 60 * 1000;
  const QUIET_AFTER_MS = 60 * 1000;
  C.SLEEP_AFTER_MS = SLEEP_AFTER_MS;

  // Apelidos ficam no navegador (localStorage), por pasta para sessões principais.
  const nickCache = new Map();
  function nickKey(key) {
    const pr = profiles.get(key);
    if (pr && !pr.parent && pr.cwd) return 'cidade.nick:' + pr.cwd.toLowerCase();
    return 'cidade.nick:' + key;
  }
  C.getNickname = (key) => {
    const k = nickKey(key);
    if (!nickCache.has(k)) {
      let v = null;
      try { v = localStorage.getItem(k); } catch (_) {}
      nickCache.set(k, v);
    }
    return nickCache.get(k);
  };
  C.setNickname = (key, name) => {
    const k = nickKey(key);
    name = (name || '').trim().slice(0, 32) || null;
    nickCache.set(k, name);
    try { name ? localStorage.setItem(k, name) : localStorage.removeItem(k); } catch (_) {}
    C.emit('profile', profiles.get(key));
  };
  C.displayName = (key) => {
    const nick = C.getNickname(key);
    if (nick) return nick;
    const pr = profiles.get(key);
    if (pr) return pr.label;
    const p = people.get(key);
    return p ? p.label : key;
  };

  C.isSleeping = (p) => !p.path.length && !p.working && !p.alert && C.now() - p.lastSeen > SLEEP_AFTER_MS;

  C.stateOf = (key) => {
    const p = people.get(key);
    const pr = profiles.get(key);
    if (!p) {
      if (pr && pr.endedAt) return { icon: '👋', text: 'saiu da cidade', cls: 'gone' };
      return { icon: '❔', text: 'fora da cidade', cls: 'gone' };
    }
    const bname = (id) => (BUILDINGS[id] ? BUILDINGS[id].name : id);
    if (p.leaving) return { icon: '👋', text: 'indo embora', cls: 'gone' };
    if (p.alert) {
      const ex = C.explainAlert(key);
      return { icon: '❗', text: ex ? ex.verb : 'esperando você', cls: 'alert' };
    }
    if (p.working && p.path.length) return { icon: '🚶', text: `indo para ${bname(p.building)}`, cls: 'work' };
    if (p.working) {
      const run = p.working.since ? C.now() - p.working.since : 0;
      const t = run >= LONG_ACTION_MS ? ` · ⏱ ${fmtClock(run)}` : '';
      return { icon: '⚙️', text: `trabalhando: ${bname(p.building)}${t}`, cls: 'work' };
    }
    if (p.path.length) return { icon: '🚶', text: `a caminho: ${bname(p.building)}`, cls: 'idle' };
    if (C.isSleeping(p)) return { icon: '💤', text: 'dormindo', cls: 'sleep' };
    if (p.building === 'praca') return { icon: '☕', text: 'descansando no café', cls: 'idle' };
    return { icon: '🧍', text: `na ${bname(p.building)}`, cls: 'idle' };
  };

  // ---------------------------------------------------------------------------
  // Canvas e geometria
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('city');
  const ctx = canvas.getContext('2d');
  const world = document.createElement('canvas');
  const g = world.getContext('2d');
  let G = g; // contexto atual dos helpers de pixel (trocado ao desenhar avatares)

  let dpr = 1, cssW = 0, cssH = 0, areaW = 0, SCALE = 3, W = 0, H = 0;
  const geo = { rows: [], avenues: [], alleys: [], rects: {}, cellW: 0, trees: [], lamps: [] };
  C.geo = geo;

  const AVENUE_H = 18;
  const GAP = 8;
  const HOUSE_ROW_H = 30; // Rua dos Projetos: fileira de casinhas...
  const STREET_H = 12;    // ...e a rua estreita na frente delas
  const HOUSE_W = 24;

  function seeded(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    cssW = r.width; cssH = r.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const panelW = window.innerWidth >= 900 ? 340 : 0;
    areaW = Math.max(200, cssW - panelW);
    SCALE = areaW >= 1400 ? 4 : areaW >= 700 ? 3 : 2;
    W = Math.floor(areaW / SCALE);
    H = Math.floor(cssH / SCALE);
    world.width = W; world.height = H;
    C.view = { W, H, SCALE, areaW, cssH };

    const top = Math.ceil(56 / SCALE) + 4; // espaço para a barra superior do HUD
    const m = 4;
    const rowH = Math.floor((H - top - 2 * AVENUE_H - HOUSE_ROW_H - STREET_H - m) / 2);
    const cellW = (W - 2 * m) / COLS;
    geo.cellW = cellW;
    geo.top = top;
    geo.rows = [0, 1].map((i) => ({ y: top + i * (rowH + AVENUE_H), h: rowH }));
    geo.avenues = geo.rows.map((row) => ({ y: row.y + row.h, h: AVENUE_H, mid: row.y + row.h + AVENUE_H / 2 }));
    // Rua dos Projetos (vira a avenida de índice 2 para o roteamento)
    const houseY = geo.avenues[1].y + AVENUE_H;
    geo.houseRow = { y: houseY, h: HOUSE_ROW_H };
    geo.avenues.push({ y: houseY + HOUSE_ROW_H, h: STREET_H, mid: houseY + HOUSE_ROW_H + STREET_H / 2, street: true });
    geo.alleys = [];
    for (let k = 0; k <= COLS; k++) geo.alleys.push(Math.round(m + k * cellW));

    for (const L of LAYOUT) {
      const span = L.span || 1;
      const row = geo.rows[L.row];
      const x = Math.round(m + L.col * cellW + GAP / 2);
      const w = Math.round(cellW * span - GAP);
      const b = BUILDINGS[L.id];
      const h = b.park ? row.h - 6 : Math.max(30, Math.min(row.h - 18, Math.round(cellW * 0.7)));
      geo.rects[L.id] = { x, y: row.y + row.h - h, w, h, row: L.row };
    }

    // Decoração fixa: árvores na faixa de grama acima dos prédios e postes nas esquinas.
    const rnd = seeded(42);
    geo.trees = [];
    for (const L of LAYOUT) {
      if (BUILDINGS[L.id].park) continue;
      const r = geo.rects[L.id];
      const row = geo.rows[L.row];
      const free = r.y - row.y;
      if (free < 10) continue;
      const n = 2 + Math.floor(rnd() * 2);
      for (let i = 0; i < n; i++) {
        geo.trees.push({ x: r.x + 6 + rnd() * (r.w - 12), y: row.y + 6 + rnd() * Math.max(1, free - 8), s: 0.7 + rnd() * 0.5 });
      }
    }
    geo.trees.sort((a, b) => a.y - b.y);
    geo.lamps = [];
    for (const av of geo.avenues.slice(0, 2)) {
      for (const ax of geo.alleys) geo.lamps.push({ x: ax + GAP / 2 + 1, y: av.y + av.h + 1 });
    }
    layoutHouses();
    if (C.art) C.art.rebuild(); // chão e ruas em cache (public/art.js)

    // Reposiciona quem estava parado, para não ficar "fora do lugar".
    for (const p of people.values()) {
      if (!p.path.length && p.building && !p.leaving) {
        const s = spotFor(p.building, p.slot);
        p.x = s.x; p.y = s.y;
      }
    }
    C.emit('resize');
  }

  function doorOf(id) {
    const r = geo.rects[id];
    return { x: r.x + r.w / 2, y: r.y + r.h };
  }

  function spotFor(id, slot) {
    const r = geo.rects[id];
    if (BUILDINGS[id].park) {
      // Praça: habitantes espalhados pelo caminho de pedra, em fileiras.
      const perRow = Math.max(3, Math.floor((r.w - 70) / 14));
      const rowsFit = Math.max(1, Math.floor((r.h * 0.5) / 12));
      return {
        x: Math.round(r.x + 50 + (slot % perRow) * 14),
        y: Math.round(r.y + r.h * 0.45 + 10 + (Math.floor(slot / perRow) % rowsFit) * 12),
      };
    }
    // Prédios: fila na calçada, em frente à porta.
    const d = doorOf(id);
    const offs = [0, -10, 10, -20, 20, -30, 30];
    const ox = offs[slot % offs.length] * Math.min(1, r.w / 70);
    const av = geo.avenues[r.row];
    const lane = Math.floor(slot / offs.length) % 2;
    return { x: Math.round(d.x + ox), y: Math.round(av.y + 8 + lane * 8) };
  }

  // ---------------------------------------------------------------------------
  // Bairro: uma casa por projeto (pasta das sessões principais)
  // ---------------------------------------------------------------------------
  const projectKey = (cwd) => (cwd ? String(cwd).toLowerCase() : null);
  C.projectHue = (cwd) => hashHue(projectKey(cwd) || '?');

  // Projetos conhecidos: os salvos no servidor + os das sessões vivas (inclusive simuladas).
  function knownProjects() {
    const map = new Map();
    for (const pr of Object.values(C.projects || {})) map.set(projectKey(pr.cwd), { ...pr });
    for (const pr of profiles.values()) {
      if (pr.parent || !pr.cwd) continue;
      const k = projectKey(pr.cwd);
      const cur = map.get(k);
      if (!cur) map.set(k, { cwd: pr.cwd, label: folderName(pr.cwd), firstSeen: pr.firstSeen, lastSeen: pr.lastSeen, sessions: 1 });
      else cur.lastSeen = Math.max(cur.lastSeen || 0, pr.lastSeen || 0);
    }
    return [...map.values()];
  }

  function layoutHouses() {
    if (!geo.houseRow) return;
    const slotW = HOUSE_W + 10;
    const slots = Math.max(1, Math.floor((W - 16) / slotW));
    const all = knownProjects().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    const overflow = all.length > slots ? all.length - (slots - 1) : 0;
    const shown = (overflow ? all.slice(0, slots - 1) : all).sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
    const used = shown.length + (overflow ? 1 : 0);
    const x0 = Math.round((W - used * slotW) / 2);
    const hy = geo.houseRow.y + 6;
    const hh = HOUSE_ROW_H - 6;
    geo.houses = shown.map((pr, i) => {
      const x = x0 + i * slotW + (slotW - HOUSE_W) / 2;
      return {
        key: projectKey(pr.cwd), cwd: pr.cwd, label: pr.label || folderName(pr.cwd), hue: C.projectHue(pr.cwd),
        x, y: hy, w: HOUSE_W, h: hh, door: { x: x + HOUSE_W / 2, y: hy + hh },
      };
    });
    geo.houseOverflow = overflow ? { n: overflow, x: x0 + shown.length * slotW + slotW / 2, y: hy + hh } : null;
  }
  C.relayoutHouses = layoutHouses;

  function rootProfileOf(p) {
    return profiles.get(p.key.split('/')[0]);
  }
  function houseOf(p) {
    const root = rootProfileOf(p);
    const k = projectKey((root && root.cwd) || p.cwd);
    return k && geo.houses ? geo.houses.find((h) => h.key === k) || null : null;
  }
  function houseByCwd(cwd) {
    const k = projectKey(cwd);
    return k && geo.houses ? geo.houses.find((h) => h.key === k) || null : null;
  }
  C.houseOf = (key) => { const p = people.get(key); return p ? houseOf(p) : null; };

  function nearestAvenue(y) {
    let best = 0, dist = Infinity;
    geo.avenues.forEach((a, i) => {
      const d = Math.abs(a.mid - y);
      if (d < dist) { dist = d; best = i; }
    });
    return best;
  }

  function nearestAlley(x) {
    return geo.alleys.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
  }

  // Caminho em "L" pelas ruas: avenida atual → viela → avenida de destino → ponto final.
  function routeTo(p, target, targetAvenue) {
    const pts = [];
    const from = nearestAvenue(p.y);
    const yFrom = geo.avenues[from].mid;
    const yTo = geo.avenues[targetAvenue].mid;
    pts.push({ x: p.x, y: yFrom });
    if (from !== targetAvenue) {
      const ax = nearestAlley(p.x);
      pts.push({ x: ax, y: yFrom }, { x: ax, y: yTo });
    }
    pts.push({ x: target.x, y: yTo }, { x: target.x, y: target.y });
    return pts;
  }

  // ---------------------------------------------------------------------------
  // Habitantes
  // ---------------------------------------------------------------------------
  function hashHue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function makePerson(key, opts) {
    const hue = opts.hue != null ? opts.hue : hashHue(key);
    const p = {
      key,
      label: opts.label,
      small: !!opts.small,
      parent: opts.parent || null,
      hue,
      color: `hsl(${hue} 70% 55%)`,
      dark: `hsl(${hue} 60% 35%)`,
      hair: ['#3b2a1a', '#1d1d1d', '#a0522d', '#e0c068', '#6b4423'][hashHue(key + 'h') % 5],
      skin: ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'][hashHue(key + 's') % 5],
      x: opts.x, y: opts.y,
      cwd: opts.cwd || null,
      agentType: opts.agentType || null,
      path: [],
      building: null,
      slot: 0,
      working: null,
      lastAction: null,
      alert: null,
      bubble: null,
      leaving: false,
      alpha: 1,
      lastSeen: opts.lastSeen || C.now(),
      phase: Math.random() * 10,
    };
    people.set(key, p);
    return p;
  }

  function mainKey(ev) { return ev.session_id || 'desconhecida'; }

  function ensureMain(ev, instant) {
    const key = mainKey(ev);
    let p = people.get(key);
    if (!p) {
      const pr = profiles.get(key);
      // Sai de casa (se o projeto já tem casa no bairro); senão chega pela esquerda.
      if (!houseByCwd(ev.cwd) && !instant) layoutHouses();
      const home = houseByCwd(ev.cwd);
      const start = instant ? spotFor('prefeitura', 0) : home ? { x: home.door.x, y: home.door.y } : { x: -6, y: geo.avenues[0].mid };
      p = makePerson(key, { label: pr ? pr.label : folderName(ev.cwd), x: start.x, y: start.y, cwd: ev.cwd });
    }
    p.lastSeen = ev.replay && ev.ts ? ev.ts : C.now();
    return p;
  }

  function ensureAgent(ev, instant) {
    const parent = ensureMain(ev, instant);
    const key = `${mainKey(ev)}/${ev.agent_id}`;
    let p = people.get(key);
    if (!p) {
      const pr = profiles.get(key);
      p = makePerson(key, {
        label: pr ? pr.label : ev.agent_type || 'subagente',
        agentType: ev.agent_type || null,
        small: true,
        parent: parent.key,
        hue: (parent.hue + 25 + hashHue(key) % 300) % 360,
        x: parent.x + 4, y: parent.y,
      });
    }
    p.lastSeen = ev.replay && ev.ts ? ev.ts : C.now();
    return p;
  }

  function freeSlot(buildingId, who) {
    const used = new Set();
    for (const o of people.values()) {
      if (o !== who && o.building === buildingId && !o.leaving) used.add(o.slot);
    }
    let s = 0;
    while (used.has(s)) s++;
    return s;
  }

  function goTo(p, buildingId, instant) {
    if (p.leaving) return;
    if (p.building !== buildingId) {
      p.building = buildingId;
      p.slot = freeSlot(buildingId, p);
    }
    const target = spotFor(buildingId, p.slot);
    if (instant) {
      p.x = target.x; p.y = target.y; p.path = [];
      return;
    }
    if (Math.hypot(p.x - target.x, p.y - target.y) < 1) return;
    p.path = routeTo(p, target, geo.rects[buildingId].row);
  }

  function leave(p, instant) {
    if (instant) { people.delete(p.key); return; }
    p.leaving = true;
    p.building = null;
    p.working = null;
    p.alert = null;
    // Vai para a casa do projeto no bairro; sem casa, sai da cidade pela lateral.
    const home = houseOf(p);
    if (home) {
      p.path = routeTo(p, { x: home.door.x + (p.small ? 3 : 0), y: home.door.y + 2 }, 2);
      p.path.push({ x: home.door.x + (p.small ? 3 : 0), y: home.door.y - 1 });
      return;
    }
    const av = nearestAvenue(p.y);
    const exitX = p.small ? -12 : W + 12;
    p.path = [{ x: p.x, y: geo.avenues[av].mid }, { x: exitX, y: geo.avenues[av].mid }];
  }

  function say(p, text, ms) {
    p.bubble = { text, until: C.now() + (ms || 3000) };
  }

  function actionText(ev) {
    const tool = ev.tool_name || '?';
    const shortTool = tool.startsWith('mcp__') ? tool.split('__').slice(1).join('/') : tool;
    const summary = tool === 'Bash' ? cleanCommand(ev.summary) : ev.summary;
    return summary ? `${shortTool}: ${summary}` : shortTool;
  }
  C.actionText = actionText;

  // Limpa textos "Ferramenta: resumo" já prontos (histórico antigo dos prédios).
  C.cleanText = (text) => {
    const m = /^Bash: ([\s\S]*)$/.exec(text || '');
    return m ? `Bash: ${cleanCommand(m[1])}` : text;
  };

  // ---------------------------------------------------------------------------
  // Explicação dos alertas: o quê, onde e como responder
  // ---------------------------------------------------------------------------
  function translateMessage(msg) {
    if (!msg) return '';
    let m;
    if ((m = /^Claude needs your permission to use (.+)$/i.exec(msg))) return `Claude precisa da sua permissão para usar ${m[1]}`;
    if (/^Claude is waiting for your input/i.test(msg)) return 'Claude está esperando sua resposta';
    if (/^Claude needs your attention/i.test(msg)) return 'Claude precisa da sua atenção';
    return msg;
  }
  C.translateMessage = translateMessage;

  const ALERT_KINDS = {
    permission_prompt: {
      verb: 'pede permissão',
      how: [
        'Vá até a janela dessa sessão do Claude Code: a pergunta de permissão está na tela.',
        'Escolha com as setas + Enter (ou o número da opção): permitir uma vez, permitir sempre para esse tipo de ação, ou recusar e dizer o que fazer em vez disso.',
      ],
    },
    idle_prompt: {
      verb: 'terminou e espera sua próxima mensagem',
      how: [
        'Não há nada pendente: o Claude acabou o que estava fazendo.',
        'Digite a próxima instrução nessa sessão, ou encerre com /exit se não precisar mais dela.',
      ],
    },
    elicitation_dialog: {
      verb: 'precisa que você preencha um formulário',
      how: ['Um servidor MCP abriu um formulário nessa sessão.', 'Preencha os campos e confirme (ou cancele) por lá.'],
    },
    elicitation_url_dialog: {
      verb: 'pede para você abrir um link',
      how: ['Um servidor MCP precisa que você conclua algo no navegador (por exemplo, um login).', 'Abra o link mostrado nessa sessão e siga as instruções.'],
    },
    agent_needs_input: {
      verb: 'precisa da sua resposta',
      how: ['Um agente parou esperando uma resposta sua.', 'Responda na janela dessa sessão.'],
    },
  };
  const ALERT_DEFAULT = { verb: 'precisa de você', how: ['Vá até a janela dessa sessão do Claude Code e veja a mensagem na tela.'] };

  // Devolve { name, verb, short, what, where[], cwd, how[], raw, since } ou null.
  C.explainAlert = (key) => {
    const p = people.get(key);
    const pr = profiles.get(key);
    const alert = (p && p.alert) || (pr && pr.alert);
    if (!alert) return null;
    const kind = ALERT_KINDS[alert.type] || ALERT_DEFAULT;
    // A pergunta aparece sempre na janela da sessão principal.
    const rootKey = key.split('/')[0];
    const root = profiles.get(rootKey) || pr || {};
    const name = C.displayName(key);
    const translated = translateMessage(alert.text);
    let what;
    if (alert.type === 'permission_prompt' && alert.tool) {
      const viaSub = alert.toolKey && alert.toolKey !== key ? ` (pedido pelo subagente ${C.displayName(alert.toolKey)})` : '';
      what = `Quer usar ${alert.tool}${viaSub}`;
    } else {
      what = translated;
    }
    const where = [];
    where.push(root.terminal ? `No ${root.terminal}` : 'Na janela/terminal onde você abriu o Claude Code');
    if (rootKey !== key) where.push(`Sessão principal: ${C.displayName(rootKey)} (é um subagente dela)`);
    if (root.firstSeen) where.push(`Sessão ${String(root.session_id || rootKey).slice(0, 8)}, aberta às ${new Date(root.firstSeen).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
    return {
      name,
      verb: kind.verb,
      short: alert.type === 'permission_prompt' && alert.tool ? `${kind.verb}: ${alert.tool}` : kind.verb,
      what,
      where,
      cwd: root.cwd || null,
      how: kind.how,
      raw: alert.text !== translated ? alert.text : null,
      since: alert.ts || null,
    };
  };

  // Cria os habitantes a partir dos perfis salvos (cidade se reconstrói mesmo após reiniciar).
  function populateFromProfiles() {
    const list = [...profiles.values()].filter((pr) => !pr.endedAt);
    list.sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0));
    for (const pr of list) {
      if (people.has(pr.key)) continue;
      if (pr.parent && !people.has(pr.parent)) continue;
      const parent = pr.parent ? people.get(pr.parent) : null;
      const p = makePerson(pr.key, {
        label: pr.label,
        small: !!pr.parent,
        parent: pr.parent,
        hue: parent ? (parent.hue + 25 + hashHue(pr.key) % 300) % 360 : null,
        x: 0, y: 0,
        cwd: pr.cwd,
        lastSeen: pr.lastSeen,
      });
      goTo(p, BUILDINGS[pr.building] ? pr.building : 'prefeitura', true);
      if (pr.current) p.working = { tool: pr.current.tool, text: actionText({ tool_name: pr.current.tool, summary: pr.current.summary }), since: pr.current.since, id: pr.current.id || null };
      if (pr.alert) p.alert = pr.alert;
    }
  }

  // ---------------------------------------------------------------------------
  // Eventos dos hooks
  // ---------------------------------------------------------------------------
  function handle(ev) {
    const instant = !!ev.replay;
    const name = ev.hook_event_name;
    const who = ev.agent_id ? ensureAgent(ev, instant) : ensureMain(ev, instant);

    // Qualquer evento novo do agente significa que ele já não está travado esperando você.
    // Se o alerta era por causa de uma ferramenta de um subagente, o fim dela também libera.
    if (name !== 'Notification') {
      who.alert = null;
      const root = people.get(mainKey(ev));
      if (root && root.alert && root.alert.toolKey === who.key && /^PostToolUse/.test(name)) root.alert = null;
    }

    switch (name) {
      case 'SessionStart':
        goTo(who, 'prefeitura', instant);
        if (!instant) say(who, ev.source === 'resume' ? 'De volta!' : 'Olá, cidade!');
        break;

      case 'UserPromptSubmit':
        who.alert = null;
        who.working = null;
        goTo(who, 'prefeitura', instant);
        if (!instant && ev.summary) say(who, `📜 ${ev.summary}`, 4000);
        break;

      case 'PreToolUse':
        who.alert = null;
        goTo(who, buildingFor(ev.tool_name), instant);
        // Hooks são assíncronos: se o Post desta ferramenta já chegou, ela já acabou.
        if (ev.tool_use_id && doneIds.has(ev.tool_use_id)) {
          doneIds.delete(ev.tool_use_id);
          who.working = null;
          who.lastAction = { text: actionText(ev), failed: false, until: instant ? 0 : C.now() + 2500 };
        } else {
          who.working = { tool: ev.tool_name, text: actionText(ev), since: ev.ts || C.now(), id: ev.tool_use_id || null };
        }
        break;

      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const w = who.working;
        const id = ev.tool_use_id || null;
        if (name === 'PostToolUseFailure') recordFailure(ev);
        if (w && (!id || !w.id || w.id === id)) {
          who.lastAction = { text: w.text, failed: name === 'PostToolUseFailure', until: instant ? 0 : C.now() + 2500, ms: ev.duration_ms };
          who.working = null;
        } else if (id) {
          doneIds.add(id); // o Pre ainda não chegou
          if (doneIds.size > 500) doneIds.delete(doneIds.values().next().value);
        }
        break;
      }

      case 'SubagentStart':
        if (!instant) say(who, `Indo: ${ev.agent_type || 'subagente'}`, 2500);
        break;

      case 'SubagentStop':
        if (who.parent) {
          if (!instant) say(who, 'Pronto! 🏠', 1500);
          leave(who, instant);
        }
        break;

      case 'Notification': {
        if (!C.defs.isAlertNotification(ev.notification_type)) {
          if (!instant) say(who, `ℹ️ ${translateMessage(ev.message) || 'aviso'}`, 4000);
          break;
        }
        // Ferramenta pendente: a do próprio agente ou a mais recente de um subagente dele.
        let owner = who.working ? who : null;
        for (const o of people.values()) {
          if (o.parent === who.key && o.working && !o.leaving && (!owner || o.working.since > owner.working.since)) owner = o;
        }
        who.alert = {
          text: ev.message || 'Precisa de atenção',
          title: ev.title || null,
          type: ev.notification_type || null,
          tool: owner ? owner.working.text : null,
          toolKey: owner ? owner.key : null,
          ts: ev.ts || C.now(),
        };
        break;
      }

      case 'Stop':
        who.working = null;
        who.alert = null;
        goTo(who, 'praca', instant);
        break;

      case 'SessionEnd':
        for (const o of [...people.values()]) {
          if (o.parent === who.key) leave(o, instant);
        }
        if (instant) leave(who, true);
        else {
          say(who, 'Tchau! 👋', 2000);
          setTimeout(() => leave(who, false), 1200);
        }
        break;
    }
    C.emit('event', ev, who);
  }

  // ---------------------------------------------------------------------------
  // Conexão SSE (com reconexão automática)
  // ---------------------------------------------------------------------------
  let es = null;

  function connect() {
    if (es) es.close();
    es = new EventSource('/stream');
    es.onopen = () => C.emit('conn', true);
    const on = (name, fn) => es.addEventListener(name, (msg) => {
      try { fn(JSON.parse(msg.data)); } catch (err) { console.warn(`evento "${name}" ignorado`, err); }
    });
    on('hello', () => {
      if (!C.replaying) { people.clear(); doneIds.clear(); }
      profiles.clear();
      C.emit('reset');
    });
    on('snapshot', (s) => {
      for (const pr of Object.values(s.profiles || {})) profiles.set(pr.key, pr);
      C.buildingInfo = s.buildings || {};
      C.stats = s.stats || {};
      C.projects = s.projects || {};
      C.achievements = s.achievements || [];
      C.lifetime = s.lifetime || {};
      layoutHouses();
      if (!C.replaying) populateFromProfiles();
      C.emit('snapshot');
      C.emit('stats', C.stats);
    });
    on('project', (pr) => {
      const isNew = !C.projects[pr.cwd.toLowerCase()];
      C.projects[pr.cwd.toLowerCase()] = pr;
      if (isNew) layoutHouses();
      C.emit('project', pr);
    });
    // Cidade que cresce: contadores da vida toda. Compara níveis para avisar quando sobe.
    on('lifetime', (lt) => {
      const before = {};
      for (const L of LAYOUT) before[L.id] = C.defs.levelOf(L.id, C.lifetime).level;
      C.lifetime = lt;
      const ups = [];
      for (const L of LAYOUT) {
        const now = C.defs.levelOf(L.id, lt);
        if (now.level > before[L.id]) ups.push({ id: L.id, ...now });
      }
      if (ups.length && !C.replaying) C.emit('levelup', ups);
      C.emit('lifetime', lt);
    });
    on('achievement', (a) => {
      C.achievements = a.all || C.achievements;
      C.emit('achievement', a.unlocked || []);
    });
    on('profile', (pr) => {
      const isNewRoot = !pr.parent && !profiles.has(pr.key);
      profiles.set(pr.key, pr);
      if (isNewRoot && !houseByCwd(pr.cwd)) layoutHouses();
      const p = people.get(pr.key);
      if (p) p.label = pr.label;
      C.emit('profile', pr);
    });
    on('building', (b) => {
      C.buildingInfo[b.id] = b.info;
      C.emit('building', b.id);
    });
    on('agent', (ev) => {
      // Durante o replay a cidade mostra o passado; os eventos ao vivo só viram aviso.
      if (C.replaying) { if (!ev.replay) C.emit('live-event', ev); return; }
      if (!ev.replay) C.lastEventAt = C.now();
      handle(ev);
    });
    on('stats', (s) => { C.stats = s; C.emit('stats', s); });
    on('forget', ({ key }) => {
      for (const k of [...people.keys()]) if (k === key || k.startsWith(key + '/')) people.delete(k);
      for (const k of [...profiles.keys()]) if (k === key || k.startsWith(key + '/')) profiles.delete(k);
      if (C.selected && (C.selected === key || C.selected.startsWith(key + '/'))) C.select(null);
      C.emit('forget', key);
    });
    es.onerror = () => {
      C.emit('conn', false);
      // O navegador reconecta sozinho; se ele desistir (CLOSED), tentamos de novo.
      if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
    };
  }

  // Usado pelo replay (public/replay.js).
  C.replaying = false;
  C.projects = {};
  C.achievements = [];
  C.lifetime = {};
  C.applyEvent = (ev) => handle(ev);
  C.resetPeople = () => { people.clear(); doneIds.clear(); particles.length = 0; resetLife(); C.emit('reset-people'); };
  C.reconnect = () => connect();

  C.forget = (key) => fetch('/api/forget', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }),
  }).catch(() => {});

  // ---------------------------------------------------------------------------
  // Seleção e cenas
  // ---------------------------------------------------------------------------
  let transition = null; // { to, start, switched }

  C.select = (key) => {
    C.selected = key;
    C.emit('select', key);
  };

  function setScene(to) {
    if (transition) return;
    const same = to.type === C.scene.type && to.id === C.scene.id;
    if (same) return;
    transition = { to, start: performance.now(), switched: false };
  }
  C.enter = (id) => { if (BUILDINGS[id]) setScene({ type: 'interior', id }); };
  C.exitInterior = () => setScene({ type: 'city' });

  // "Ir até": volta para a cidade (ou entra no prédio onde o agente está) e seleciona.
  C.goToAgent = (key) => {
    const p = people.get(key);
    C.select(key);
    if (!p) return;
    if (C.scene.type === 'interior' && C.scene.id !== p.building) C.exitInterior();
    C.flash = { key, until: C.now() + 2500 };
  };

  // ---------------------------------------------------------------------------
  // Helpers de desenho em pixel
  // ---------------------------------------------------------------------------
  function px(x, y, w, h, c) {
    G.fillStyle = c;
    G.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  C.px = px;

  // Período do dia pelo relógio real.
  C.lightAt = (d) => {
    d = d || new Date(C.now());
    const h = d.getHours() + d.getMinutes() / 60;
    if (h >= 5 && h < 7) return { name: 'amanhecer', icon: '🌅', tint: 'rgba(255,160,90,.14)', lamps: h < 6 };
    if (h >= 7 && h < 17) return { name: 'dia', icon: '☀️', tint: null, lamps: false };
    if (h >= 17 && h < 19) return { name: 'entardecer', icon: '🌇', tint: 'rgba(255,110,90,.17)', lamps: h >= 18.3 };
    return { name: 'noite', icon: '🌙', tint: 'rgba(12,20,70,.48)', lamps: true };
  };

  // ---------------------------------------------------------------------------
  // Habitante (sprite ~16 px; subagentes ~12 px). Pés em (x, y).
  // `scale` inteiro: 1 na cidade, 2 nos interiores, maior nos avatares.
  // ---------------------------------------------------------------------------
  const OUTLINE = '#1d1a26';
  const PANTS = '#2f3448';
  const SHOES = '#1b1b22';

  function spriteDims(p) {
    return p.small
      ? { HW: 5, HH: 5, BW: 5, BH: 4, LH: 2 }
      : { HW: 6, HH: 6, BW: 6, BH: 5, LH: 3 };
  }

  function drawPersonAt(p, x, y, scale, t, walking) {
    const k = Math.max(1, Math.round(scale));
    const { HW, HH, BW, BH, LH } = spriteDims(p);
    x = Math.round(x); y = Math.round(y);
    const sleeping = C.isSleeping(p);
    const prevAlpha = G.globalAlpha;
    G.globalAlpha = prevAlpha * p.alpha * (sleeping ? 0.65 : 1);

    // direção e pose
    const next = p.path && p.path[0];
    if (next && Math.abs(next.x - p.x) > 0.3) p._dir = next.x < p.x ? -1 : 1;
    const dir = p._dir || 1;
    const back = walking && next && next.y < p.y - 0.3 && Math.abs(next.y - p.y) > Math.abs(next.x - p.x);
    const f = walking ? Math.floor(t * 9 + p.phase) % 4 : 0;           // 4 quadros de caminhada
    const working = p.working && !walking;
    const beat = Math.floor(t * 6 + p.phase) % 2;                        // ritmo do gesto de trabalho
    const bob = walking ? (f % 2) : 0;

    const bl = -Math.floor(BW / 2);
    const hl = -Math.floor(HW / 2);
    const by = -LH - BH - bob;   // topo do corpo (em unidades do sprite)
    const hy = by - HH;          // topo da cabeça
    // Retângulo em unidades do sprite, relativo aos pés.
    const R = (dx, dy, w, h, c) => px(x + dx * k, y + dy * k, w * k, h * k, c);

    // sombra no chão
    G.fillStyle = 'rgba(0,0,0,.28)';
    G.beginPath();
    G.ellipse(x, y, (BW / 2 + 1) * k, 1.3 * k, 0, 0, Math.PI * 2);
    G.fill();

    // partes (desenhadas duas vezes: primeiro o contorno, depois a cor)
    const lUp = f === 1 ? 1 : 0, rUp = f === 3 ? 1 : 0;
    const legW = 2;
    const legL = { dx: bl + (p.small ? 0 : 1), dy: -LH - lUp, w: legW, h: LH + lUp - (lUp ? 1 : 0) };
    const legR = { dx: bl + BW - legW - (p.small ? 0 : 1), dy: -LH - rUp, w: legW, h: LH + rUp - (rUp ? 1 : 0) };
    const armSwing = walking ? (f === 1 ? 1 : f === 3 ? -1 : 0) : 0;
    const armL = { dx: bl - 1, dy: by + 1 + Math.max(0, armSwing), w: 1, h: BH - 2 };
    let armR = { dx: bl + BW, dy: by + 1 + Math.max(0, -armSwing), w: 1, h: BH - 2 };
    if (working) armR = { dx: bl + BW, dy: by - (beat ? 1 : -1), w: 1, h: 3 }; // braço levantado no ritmo
    const body = { dx: bl, dy: by, w: BW, h: BH };
    const head = { dx: hl, dy: hy, w: HW, h: HH };
    const parts = [legL, legR, armL, armR, body, head];
    for (const q of parts) R(q.dx - 1, q.dy - 1, q.w + 2, q.h + 2, OUTLINE);

    // pernas e sapatos
    for (const q of [legL, legR]) {
      R(q.dx, q.dy, q.w, q.h, PANTS);
      R(q.dx, q.dy + q.h - 1, q.w, 1, SHOES);
    }
    // corpo: camisa com sombra lateral e cinto
    R(body.dx, body.dy, BW, BH, p.color);
    R(body.dx + (dir > 0 ? BW - 1 : 0), body.dy, 1, BH, p.dark);
    R(body.dx, body.dy, BW, 1, shadeLight(p));
    if (!p.small) R(body.dx, body.dy + BH - 1, BW, 1, '#3a2a1a');
    // braços: manga + mão
    for (const q of [armL, armR]) {
      R(q.dx, q.dy, 1, q.h, p.dark);
      R(q.dx, q.dy + q.h - 1, 1, 1, p.skin);
    }
    // cabeça
    R(head.dx, head.dy, HW, HH, p.skin);
    const hairDark = darkenHex(p.hair);
    if (back) {
      R(head.dx, head.dy, HW, HH - 1, p.hair);
      R(head.dx, head.dy + HH - 2, HW, 1, hairDark);
    } else {
      R(head.dx, head.dy, HW, 2, p.hair);
      R(head.dx + (dir > 0 ? 0 : HW - 1), head.dy, 1, 3, p.hair); // cabelo do lado de trás
      R(head.dx, head.dy, HW, 1, hairDark);
      // olhos (piscam a cada ~4 s); fechados ao dormir
      const blink = sleeping || ((t + p.phase * 3) % 4) < 0.13;
      const eyeY = head.dy + (p.small ? 2 : 3);
      const ex = walking || working ? (dir > 0 ? [hl + 2, hl + 4] : [hl, hl + 2]) : [hl + 1, hl + HW - 2];
      for (const e of ex) R(e, eyeY, 1, 1, blink ? darkenHex(p.skin) : '#1b1b22');
      if (!p.small && !walking) R(hl + Math.floor(HW / 2) - (dir > 0 ? 0 : 1), eyeY + 2, 1, 1, darkenHex(p.skin));
    }

    const geo2 = { x, k, R, hl, hy, HW, HH, bl, by, BW, BH, dir, sleeping, back };
    if (working) drawWorkTool(p, geo2, t, beat);
    drawAccessory(p, geo2);
    G.globalAlpha = prevAlpha;
    return y + hy * k - (accessoryOf(p) && typeof accessoryOf(p) === 'object' && accessoryOf(p).hat === 'cartola' ? 3 * k : 0);
  }

  const lightCache = new Map();
  function shadeLight(p) {
    if (!lightCache.has(p.hue)) lightCache.set(p.hue, `hsl(${p.hue} 75% 68%)`);
    return lightCache.get(p.hue);
  }
  const darkCache = new Map();
  function darkenHex(hex) {
    if (darkCache.has(hex)) return darkCache.get(hex);
    let out = hex;
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (m) {
      const n = parseInt(m[1], 16);
      const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * 0.72));
      out = `rgb(${c[0]},${c[1]},${c[2]})`;
    }
    darkCache.set(hex, out);
    return out;
  }

  // Gesto de trabalho conforme o prédio: martelo, livro, frasco, carta...
  function drawWorkTool(p, g2, t, beat) {
    const { R, bl, by, BW } = g2;
    const hx = bl + BW + 1;          // ao lado da mão direita
    const hy = by - (beat ? 1 : -1); // acompanha o braço
    switch (p.building) {
      case 'oficina': // martelo
        R(hx, hy - 2, 1, 3, '#7a5236');
        R(hx - 1, hy - 3, 3, 1, beat ? '#9aa3ad' : '#c7ccd6');
        break;
      case 'biblioteca': // livro aberto na frente do corpo
        R(bl, by + 1, BW, 2, '#f5f0e0');
        R(bl + Math.floor(BW / 2), by + 1, 1, 2, '#8b5a2b');
        if (beat) R(bl + 1, by + 1, 1, 1, '#c9b48a');
        break;
      case 'laboratorio': // frasco borbulhante
        R(hx, hy - 2, 1, 2, 'rgba(255,255,255,.85)');
        R(hx, hy, 1, 1, '#4dff88');
        break;
      case 'correios': // carta com selo
        R(hx - 1, hy - 2, 3, 2, '#fdf6e3');
        R(hx + 1, hy - 2, 1, 1, '#e34948');
        break;
      case 'prefeitura': // papéis
        R(hx, hy - 2, 2, 3, '#ffffff');
        break;
      case 'outros': // caixa
        R(bl, by, BW, 3, '#c49a6c');
        R(bl, by, BW, 1, '#d8b98c');
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Acessórios: subagentes pelo tipo; sessões principais com chapéu do projeto
  // ---------------------------------------------------------------------------
  function accessoryOf(p) {
    if (p._acc !== undefined) return p._acc;
    let acc = null;
    if (p.small) {
      const pr = profiles.get(p.key);
      const type = String((pr && pr.agent_type) || p.agentType || p.label || '').toLowerCase();
      acc = /explore/.test(type) ? 'lupa' : /plan/.test(type) ? 'prancheta' : /review/.test(type) ? 'oculos'
        : /test/.test(type) ? 'tubo' : /general/.test(type) ? 'mochila' : 'bone';
    } else {
      const root = profiles.get(p.key);
      const cwd = (root && root.cwd) || p.cwd;
      if (cwd) {
        const hue = C.projectHue(cwd);
        acc = { hat: ['bone', 'cartola', 'gorro', 'laco'][hashHue('hat' + projectKey(cwd)) % 4], color: `hsl(${hue} 60% 45%)`, light: `hsl(${hue} 70% 70%)` };
      }
    }
    // Só guarda quando já sabemos o tipo/projeto (o perfil pode chegar depois).
    if (acc) p._acc = acc;
    return acc;
  }

  function drawAccessory(p, g2) {
    const acc = accessoryOf(p);
    if (!acc) return;
    const { R, hl, hy, HW, bl, by, BW, BH, dir, sleeping, back } = g2;
    const handX = bl + BW + 1, handY = by + BH - 2;
    if (typeof acc === 'object') {
      const brimX = dir > 0 ? hl + HW : hl - 2;
      if (acc.hat === 'bone') {
        R(hl - 1, hy - 2, HW + 2, 1, OUTLINE);
        R(hl, hy - 1, HW, 1, acc.color);
        if (!back) R(brimX, hy - 1, 2, 1, acc.color);
      } else if (acc.hat === 'cartola') {
        R(hl - 2, hy - 1, HW + 4, 1, OUTLINE);
        R(hl - 1, hy - 5, HW + 2, 4, OUTLINE);
        R(hl, hy - 4, HW, 3, '#26232e');
        R(hl, hy - 2, HW, 1, acc.color);
      } else if (acc.hat === 'gorro') {
        R(hl - 1, hy - 3, HW + 2, 3, OUTLINE);
        R(hl, hy - 2, HW, 2, acc.color);
        R(hl, hy - 1, HW, 1, acc.light);
        R(-1, hy - 4, 2, 1, acc.light);
      } else if (acc.hat === 'laco') {
        const lx = dir > 0 ? hl - 1 : hl + HW - 2;
        R(lx, hy - 1, 3, 2, acc.color);
        R(lx + 1, hy - 1, 1, 2, acc.light);
      }
      return;
    }
    switch (acc) {
      case 'bone':
        R(hl - 1, hy - 1, HW + 2, 1, p.dark);
        if (!back) R(dir > 0 ? hl + HW : hl - 2, hy, 2, 1, p.dark);
        break;
      case 'lupa':
        R(handX, handY, 1, 2, '#7a5236');
        R(handX - 1, handY - 3, 3, 1, '#c7ccd6'); R(handX - 1, handY - 1, 3, 1, '#c7ccd6');
        R(handX - 1, handY - 2, 1, 1, '#c7ccd6'); R(handX + 1, handY - 2, 1, 1, '#c7ccd6');
        R(handX, handY - 2, 1, 1, 'rgba(160,220,255,.8)');
        break;
      case 'prancheta':
        R(handX, handY - 1, 2, 3, '#8b5a2b');
        R(handX, handY, 2, 1, '#fdf6e3');
        break;
      case 'oculos':
        if (!sleeping && !back) R(hl, hy + (p.small ? 2 : 3), HW, 1, '#111');
        R(hl - 1, hy - 1, HW + 2, 1, p.dark);
        break;
      case 'tubo':
        R(handX, handY - 2, 1, 3, 'rgba(255,255,255,.8)');
        R(handX, handY, 1, 1, '#4dff88');
        break;
      case 'mochila': {
        const mx = dir > 0 ? bl - 2 : bl + BW;
        R(mx, by + 1, 2, BH - 1, '#7a5236');
        R(mx, by + 1, 2, 1, '#5d3d29');
        break;
      }
    }
  }
  C.drawPersonAt = (gc, p, x, y, scale, t, walking) => {
    const prev = G;
    G = gc;
    try { return drawPersonAt(p, x, y, scale, t, walking); } finally { G = prev; }
  };

  // Avatar para o HUD: desenha o habitante num <canvas> pequeno.
  C.drawAvatar = (cv, key, t) => {
    const p = people.get(key) || ghostPerson(key);
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, cv.width, cv.height);
    const scale = Math.max(1, Math.floor((cv.height - 2) / (p.small ? 13 : 17)));
    C.drawPersonAt(c, { ...p, path: [], alpha: 1, working: null, alert: null, lastSeen: C.now() }, cv.width / 2, cv.height - scale, scale, t || 0, false);
  };
  const ghosts = new Map();
  function ghostPerson(key) {
    if (!ghosts.has(key)) {
      const pr = profiles.get(key);
      const hue = hashHue(key);
      ghosts.set(key, {
        key, small: !!(pr && pr.parent), hue, color: `hsl(${hue} 25% 55%)`, dark: `hsl(${hue} 20% 35%)`,
        hair: '#555', skin: '#c9b9a0', path: [], alpha: 1, phase: 0, lastSeen: C.now(),
      });
    }
    return ghosts.get(key);
  }

  // ---------------------------------------------------------------------------
  // Cena: cidade (baixa resolução)
  // ---------------------------------------------------------------------------
  const particles = [];
  const clouds = Array.from({ length: 4 }, (_, i) => ({ x: i * 120 + Math.random() * 60, y: 2 + Math.random() * 10, w: 18 + Math.random() * 16, v: 2 + Math.random() * 3 }));

  // Quem trabalha já mostra a ferramenta na mão (drawWorkTool); aqui só umas faíscas/poeirinha.
  function drawWorkEffects(p, hy, t) {
    if (!p.working || p.path.length) return;
    if (Math.random() < 0.05) {
      const c = p.building === 'oficina' ? '#ffd166' : p.building === 'laboratorio' ? '#7dff9a' : '#e6e6e6';
      particles.push({ x: Math.round(p.x) + (p.small ? 4 : 5), y: hy + 2, vx: (Math.random() - 0.5) * 6, vy: -5, life: 0.8, max: 0.8, c, size: 1 });
    }
  }

  function drawRing(x, y, color, t, strong) {
    const k = strong ? 1 + 0.25 * Math.sin(t * 6) : 1;
    G.strokeStyle = color;
    G.lineWidth = 1;
    G.beginPath();
    G.ellipse(x, y, 6 * k, 2.5 * k, 0, 0, Math.PI * 2);
    G.stroke();
  }

  function drawParticles(list, dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const q = list[i];
      q.life -= dt;
      if (q.life <= 0) { list.splice(i, 1); continue; }
      q.x += q.vx * dt; q.y += q.vy * dt;
      const k = q.life / q.max;
      G.globalAlpha = k * 0.8;
      const sz = q.size || 2 + (1 - k) * 3;
      px(q.x - sz / 2, q.y - sz / 2, sz, sz, q.c);
    }
    G.globalAlpha = 1;
  }
  C.drawParticles = (gc, list, dt) => { const prev = G; G = gc; drawParticles(list, dt); G = prev; };

  function drawClouds(dt) {
    for (const c of clouds) {
      c.x += c.v * dt;
      if (c.x > W + 40) { c.x = -c.w - 10; c.y = 2 + Math.random() * 10; }
      G.globalAlpha = 0.45;
      px(c.x, c.y + 2, c.w, 4, '#ffffff');
      px(c.x + 4, c.y, c.w - 10, 3, '#ffffff');
      G.globalAlpha = 1;
    }
  }

  function occupants(id) {
    let n = 0;
    for (const p of people.values()) if (p.building === id && !p.leaving && !p.path.length) n++;
    return n;
  }
  C.occupants = occupants;

  // ---------------------------------------------------------------------------
  // Vida na cidade: carros, pássaros, pombos, fogo nas falhas e chuva
  // ---------------------------------------------------------------------------
  const FIRE_MS = 20 * 1000;
  const RAIN_WINDOW_MS = 10 * 60 * 1000;
  const RAIN_FAILURES = 3;
  const CAR_COLORS = ['#e34948', '#3987e5', '#eda100', '#f5f5f5', '#2c2c3a', '#1baf7a', '#9085e9'];
  const life = { cars: [], birds: [], pigeons: [], fires: {}, failures: [], drops: [], rainLevel: 0, nextFlock: 0 };
  C.life = life;
  life.particles = particles; // art.js solta fumaça aqui
  life.clouds = clouds;       // art.js desenha a sombra das nuvens

  function recordFailure(ev) {
    const ts = ev.ts || C.now();
    life.fires[buildingFor(ev.tool_name)] = ts + FIRE_MS;
    life.failures.push(ts);
    if (life.failures.length > 50) life.failures.shift();
  }
  C.isOnFire = (id) => (life.fires[id] || 0) > C.now();
  function isRaining() {
    const now = C.now();
    const recent = life.failures.filter((ts) => ts <= now && now - ts < RAIN_WINDOW_MS);
    return recent.length >= RAIN_FAILURES;
  }
  C.isRaining = isRaining;

  function updateCars(dt) {
    let working = 0;
    for (const p of people.values()) if (p.working) working++;
    const target = Math.min(6, 1 + working);
    if (life.cars.length < target && Math.random() < dt * 0.6) {
      const av = geo.avenues[Math.random() < 0.5 ? 0 : 1];
      const dir = Math.random() < 0.5 ? 1 : -1;
      life.cars.push({ x: dir > 0 ? -12 : W + 12, y: av.mid + (dir > 0 ? 4 : -3), dir, speed: 22 + Math.random() * 14, color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] });
    }
    for (const c of life.cars) c.x += c.dir * c.speed * dt;
    life.cars = life.cars.filter((c) => c.x > -20 && c.x < W + 20);
  }

  function drawCar(c, night) {
    const x = Math.round(c.x) - 5, y = Math.round(c.y) - 3;
    px(x + 1, y + 4, 9, 1, 'rgba(0,0,0,.3)');
    px(x, y, 10, 4, c.color);
    px(x + 2, y - 2, 6, 2, c.color);
    px(x + (c.dir > 0 ? 5 : 3), y - 2, 2, 2, '#a8d4ff');
    px(x + 1, y + 3, 2, 1, '#111');
    px(x + 7, y + 3, 2, 1, '#111');
    px(c.dir > 0 ? x + 9 : x, y + 1, 1, 1, night ? '#fff6c8' : '#ffe9a8');
    px(c.dir > 0 ? x : x + 9, y + 1, 1, 1, '#c0392b');
  }

  function updateBirds(t, dt) {
    if (!life.nextFlock) life.nextFlock = t + 8;
    if (t > life.nextFlock) {
      const n = 4 + Math.floor(Math.random() * 3);
      const y0 = 6 + Math.random() * 20;
      for (let i = 0; i < n; i++) life.birds.push({ x: -10 - i * 5, y: y0 + Math.abs(i - n / 2) * 3, vx: 26 + Math.random() * 4, phase: Math.random() * 6 });
      life.nextFlock = t + 35 + Math.random() * 50;
    }
    for (const b of life.birds) b.x += b.vx * dt;
    life.birds = life.birds.filter((b) => b.x < W + 10);
  }

  function drawBirds(t) {
    for (const b of life.birds) {
      const up = Math.floor(t * 8 + b.phase) % 2;
      const x = Math.round(b.x), y = Math.round(b.y);
      px(x - 2, y - up, 1, 1, '#2c2c3a');
      px(x - 1, y + 1 - up, 1, 1, '#2c2c3a');
      px(x, y + 1, 1, 1, '#2c2c3a');
      px(x + 1, y + 1 - up, 1, 1, '#2c2c3a');
      px(x + 2, y - up, 1, 1, '#2c2c3a');
    }
  }

  function updatePigeons(t, dt) {
    const r = geo.rects.praca;
    if (!r) return;
    if (!life.pigeons.length || life.pigeons.rw !== r.w) {
      life.pigeons = Array.from({ length: 4 }, () => ({ x: r.x + 30 + Math.random() * (r.w - 50), y: r.y + r.h * 0.8 + Math.random() * (r.h * 0.15), tx: null, peck: Math.random() * 3 }));
      life.pigeons.rw = r.w;
    }
    for (const g2 of life.pigeons) {
      // Gente perto? Sai voando para outro canto da praça.
      for (const p of people.values()) {
        if (Math.hypot(p.x - g2.x, p.y - g2.y) < 7 && g2.tx == null) {
          g2.tx = r.x + 20 + Math.random() * (r.w - 40);
          g2.ty = r.y + r.h * 0.78 + Math.random() * (r.h * 0.18);
        }
      }
      if (g2.tx == null && Math.random() < dt * 0.05) { g2.tx = g2.x + (Math.random() - 0.5) * 20; g2.ty = g2.y; }
      if (g2.tx != null) {
        const dx = g2.tx - g2.x, dy = g2.ty - g2.y, d = Math.hypot(dx, dy);
        const v = (d > 8 ? 40 : 12) * dt;
        if (d <= v) { g2.x = g2.tx; g2.y = g2.ty; g2.tx = null; } else { g2.x += (dx / d) * v; g2.y += (dy / d) * v; }
        g2.flying = d > 8;
      } else g2.flying = false;
      g2.peck += dt;
    }
  }

  function drawPigeons(t) {
    for (const g2 of life.pigeons) {
      const x = Math.round(g2.x), y = Math.round(g2.y) - (g2.flying ? 3 : 0);
      const peck = !g2.flying && Math.floor(g2.peck * 2) % 3 === 0;
      px(x - 1, y - 2, 3, 2, '#8a8f99');
      px(x + (g2.tx != null && g2.tx < g2.x ? -2 : 2), y - (peck ? 1 : 3), 1, 1, '#5d636e');
      if (g2.flying) { px(x - 2, y - 3 - (Math.floor(t * 12) % 2), 1, 1, '#8a8f99'); px(x + 2, y - 3 - (Math.floor(t * 12) % 2), 1, 1, '#8a8f99'); }
    }
  }

  function drawFires(t) {
    for (const L of LAYOUT) {
      if (!C.isOnFire(L.id) || BUILDINGS[L.id].park) continue;
      const r = geo.rects[L.id];
      for (let i = 0; i < 5; i++) {
        const fx2 = r.x + r.w * (0.25 + i * 0.12);
        const h = 3 + Math.floor(Math.random() * 5);
        px(fx2 - 1, r.y - h + 2, 3, h, '#ff6a00');
        px(fx2, r.y - h + 3, 1, h - 2, '#ffd166');
      }
      if (Math.random() < 0.5) {
        particles.push({ x: r.x + r.w * (0.3 + Math.random() * 0.4), y: r.y - 4, vx: (Math.random() - 0.3) * 4, vy: -8 - Math.random() * 6, life: 2.5, max: 2.5, c: '#3b3b3b', size: 3 });
      }
    }
  }

  function updateAndDrawRain(dt) {
    const target = isRaining() ? 1 : 0;
    life.rainLevel += Math.sign(target - life.rainLevel) * Math.min(Math.abs(target - life.rainLevel), dt * 0.5);
    if (life.rainLevel <= 0.01) { life.drops.length = 0; return; }
    const want = Math.floor((W * H) / 220 * life.rainLevel);
    while (life.drops.length < want) life.drops.push({ x: Math.random() * (W + 40), y: Math.random() * H, v: 110 + Math.random() * 60 });
    if (life.drops.length > want) life.drops.length = want;
    G.fillStyle = `rgba(40,50,75,${0.22 * life.rainLevel})`;
    G.fillRect(0, 0, W, H);
    G.globalAlpha = 0.55 * life.rainLevel;
    for (const d of life.drops) {
      d.y += d.v * dt; d.x -= d.v * 0.25 * dt;
      if (d.y > H) { d.y = -4; d.x = Math.random() * (W + 40); }
      px(d.x, d.y, 1, 3, '#b8d4ff');
    }
    G.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Festa: fogos de artifício e confete (conquistas e prédios que crescem)
  // ---------------------------------------------------------------------------
  const FW_COLORS = ['#ff5c5c', '#ffd166', '#3ddc84', '#7ac8ff', '#e87ba4', '#9085e9', '#ffffff'];
  life.rockets = [];
  life.sparks = [];
  life.confetti = [];
  life.fwQueue = [];

  // intensity: 'big' (conquista) ou 'small' (prédio cresceu).
  C.celebrate = (intensity) => {
    if (C.replaying) return;
    const nowS = performance.now() / 1000;
    const n = intensity === 'big' ? 9 : 4;
    for (let i = 0; i < n; i++) life.fwQueue.push(nowS + i * (intensity === 'big' ? 0.45 : 0.6) + Math.random() * 0.2);
    if (intensity === 'big') {
      for (let i = 0; i < 140; i++) {
        life.confetti.push({ x: Math.random() * W, y: -Math.random() * H * 0.3, vy: 35 + Math.random() * 25, vx: (Math.random() - 0.5) * 6, ph: Math.random() * 6, c: FW_COLORS[i % FW_COLORS.length] });
      }
    }
  };

  function updateAndDrawFireworks(dt) {
    const nowS = performance.now() / 1000;
    // foguetes da fila (os muito atrasados — ex.: estava dentro de um prédio — são descartados)
    life.fwQueue = life.fwQueue.filter((at) => {
      if (at > nowS) return true;
      if (nowS - at < 8) {
        life.rockets.push({ x: 20 + Math.random() * (W - 40), y: H - 4, vy: -(80 + Math.random() * 30), ty: 12 + Math.random() * H * 0.3, c: FW_COLORS[Math.floor(Math.random() * FW_COLORS.length)] });
      }
      return false;
    });
    for (const r of life.rockets) {
      r.y += r.vy * dt;
      if (r.y <= r.ty) {
        r.done = true;
        const k = 28 + Math.floor(Math.random() * 14);
        for (let i = 0; i < k; i++) {
          const a = (i / k) * Math.PI * 2, v = 22 + Math.random() * 22;
          life.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.2 + Math.random() * 0.7, max: 1.9, c: Math.random() < 0.8 ? r.c : '#ffffff' });
        }
      }
    }
    life.rockets = life.rockets.filter((r) => !r.done);
    for (const s of life.sparks) { s.vy += 26 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.life -= dt; }
    life.sparks = life.sparks.filter((s) => s.life > 0);
    for (const c of life.confetti) { c.y += c.vy * dt; c.x += c.vx * dt + Math.sin(c.ph += dt * 4) * 0.3; }
    life.confetti = life.confetti.filter((c) => c.y < H + 4);

    if (!life.rockets.length && !life.sparks.length && !life.confetti.length) return;
    for (const c of life.confetti) px(c.x, c.y, Math.sin(c.ph) > 0 ? 2 : 1, Math.sin(c.ph) > 0 ? 1 : 2, c.c);
    G.globalCompositeOperation = 'lighter';
    for (const r of life.rockets) { px(r.x, r.y, 1, 2, '#ffe9a8'); px(r.x, r.y + 2, 1, 2, 'rgba(255,200,120,.5)'); }
    for (const s of life.sparks) {
      G.globalAlpha = Math.max(0, Math.min(1, s.life / 1.2));
      px(s.x, s.y, s.life > 1.2 ? 2 : 1, s.life > 1.2 ? 2 : 1, s.c);
    }
    G.globalAlpha = 1;
    G.globalCompositeOperation = 'source-over';
  }

  function resetLife() {
    life.rockets.length = 0;
    life.sparks.length = 0;
    life.confetti.length = 0;
    life.fwQueue.length = 0;
    life.fires = {};
    life.failures.length = 0;
    life.drops.length = 0;
    life.rainLevel = 0;
  }

  // Estado de cada projeto para as casas: alguém ativo? alguém esperando você?
  function houseStatus(h) {
    let active = 0, alert = false;
    for (const p of people.values()) {
      if (p.leaving || p.parent) continue;
      if (projectKey((rootProfileOf(p) || {}).cwd || p.cwd) !== h.key) continue;
      active++;
      if (p.alert) alert = true;
    }
    return { active, alert };
  }

  function drawCityWorld(t, dt) {
    const light = C.lightAt();
    const night = !!light.lamps;
    const active = new Set();
    for (const p of people.values()) if (p.working && !p.path.length && p.building) active.add(p.building);

    // Cenário (public/art.js): chão em cache, sombras, mobiliário, prédios, árvores, casas.
    const art = C.art;
    art.beginFrame(light);
    art.drawGround(g);
    art.drawPuddles(g, t);
    art.drawShadows(g, geo.houses);
    art.drawCloudShadows(g, t);
    art.drawTrees(g);
    art.drawFurniture(g, t, night);
    for (const L of LAYOUT) {
      art.drawBuilding(g, L.id, { t, active: active.has(L.id), night, level: C.defs.levelOf(L.id, C.lifetime).level });
    }
    art.drawHouses(g, geo.houses, houseStatus, t, night);
    G = g;
    drawFires(t);
    updatePigeons(t, dt);
    drawPigeons(t);
    updateCars(dt);
    for (const c of life.cars) {
      drawCar(c, night);
      art.addLight(c.x + c.dir * 9, c.y, 12, 0.7, '255,240,190');
    }
    for (const L of LAYOUT) if (C.isOnFire(L.id)) { const r = geo.rects[L.id]; art.addLight(r.x + r.w / 2, r.y, 26, 0.9, '255,140,60'); }

    const sorted = [...people.values()].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      if (p.key === C.selected) drawRing(p.x, p.y, '#ffd166', t, true);
      else if (hover && hover.kind === 'person' && hover.key === p.key) drawRing(p.x, p.y, '#ffffff', t, false);
      if (C.flash && C.flash.key === p.key && C.flash.until > C.now()) drawRing(p.x, p.y, '#ffffff', t * 3, true);
      p.headY = drawPersonAt(p, p.x, p.y, 1, t, p.path.length > 0);
      drawWorkEffects(p, p.headY, t);
    }
    drawParticles(particles, dt);
    drawClouds(dt);
    updateBirds(t, dt);
    drawBirds(t);
    updateAndDrawRain(dt);
    art.applyLighting(g, light);
    updateAndDrawFireworks(dt);
  }

  // ---------------------------------------------------------------------------
  // Camada de texto (alta resolução)
  // ---------------------------------------------------------------------------
  const FONT = '"Segoe UI", system-ui, sans-serif';

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function textBubble(x, y, text, style, maxChars) {
    maxChars = maxChars || 38;
    if (text.length > maxChars) text = text.slice(0, maxChars - 1) + '…';
    ctx.font = `600 12px ${FONT}`;
    const w = Math.ceil(ctx.measureText(text).width) + 14;
    const h = 22;
    let bx = Math.round(x - w / 2);
    bx = Math.max(4, Math.min(areaW - w - 4, bx));
    const by = Math.round(y - h - 8);
    ctx.fillStyle = style.bg;
    ctx.strokeStyle = style.border;
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, w, h, 5);
    ctx.fill(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, by + h); ctx.lineTo(x, by + h + 7); ctx.lineTo(x + 5, by + h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 5, by + h - 1); ctx.lineTo(x, by + h + 6); ctx.lineTo(x + 5, by + h - 1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = style.fg;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 7, by + h / 2 + 1);
  }

  function badge(x, y, emoji) {
    ctx.fillStyle = 'rgba(20,24,36,.8)';
    ctx.beginPath(); ctx.arc(x, y - 12, 10, 0, Math.PI * 2); ctx.fill();
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(emoji, x, y - 11);
  }

  // Ações longas: selo ⏱ com o tempo corrido (âmbar depois de 2 min).
  const LONG_ACTION_MS = 30 * 1000;
  const VERY_LONG_ACTION_MS = 2 * 60 * 1000;
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  }
  C.fmtClock = fmtClock;

  function timerPill(x, y, text, amber) {
    ctx.font = `bold 11px ${FONT}`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = amber ? 'rgba(255,170,60,.95)' : 'rgba(20,24,36,.85)';
    roundRect(ctx, x - w / 2, y - 22, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = amber ? '#3d2200' : '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y - 12.5);
  }

  function nameTag(p, x, y) {
    ctx.font = `${p.small ? '' : 'bold '}${p.small ? 10 : 11}px ${FONT}`;
    const text = C.displayName(p.key);
    const w = ctx.measureText(text).width + 8;
    const sel = p.key === C.selected;
    ctx.fillStyle = sel ? 'rgba(255,209,102,.95)' : 'rgba(20,24,36,.7)';
    roundRect(ctx, x - w / 2, y, w, p.small ? 14 : 15, 3);
    ctx.fill();
    ctx.fillStyle = sel ? '#1b2030' : p.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y + 1);
  }

  const BUBBLE = {
    work: { bg: '#ffffff', border: '#2b3245', fg: '#1b2030' },
    done: { bg: '#e8f7ec', border: '#3a8f55', fg: '#1d4d2c' },
    fail: { bg: '#ffe8e8', border: '#c0392b', fg: '#7a1d14' },
    talk: { bg: '#fffbe6', border: '#b38f00', fg: '#3d3000' },
    alert: { bg: '#ffd166', border: '#a35c00', fg: '#3d2200' },
    slow: { bg: '#ffe2bf', border: '#c46a00', fg: '#3d2200' },
  };

  // Balão/ícone sobre a cabeça. `full` = mostrar o texto completo.
  function personBubble(p, hx, hy, t, full) {
    const now = C.now();
    if (p.alert) {
      if (full) {
        const ex = C.explainAlert(p.key);
        textBubble(hx, hy, `❗ ${ex ? ex.short : p.alert.text}`, BUBBLE.alert, 60);
      }
      else if (Math.floor(t * 3) % 2 === 0) textBubble(hx, hy, '❗', BUBBLE.alert);
      else badge(hx, hy, '❗');
    } else if (p.bubble && p.bubble.until > now) {
      textBubble(hx, hy, p.bubble.text, BUBBLE.talk);
    } else if (p.working && !p.path.length) {
      const run = p.working.since ? now - p.working.since : 0;
      const long = run >= LONG_ACTION_MS;
      if (full || now - p.working.since < 3000) {
        textBubble(hx, hy, p.working.text + (long ? ` · ⏱ ${fmtClock(run)}` : ''), long && run >= VERY_LONG_ACTION_MS ? BUBBLE.slow : BUBBLE.work, full ? 64 : 42);
      } else if (long) timerPill(hx, hy, `⏱ ${fmtClock(run)}`, run >= VERY_LONG_ACTION_MS);
      else badge(hx, hy, '⚙️');
    } else if (p.working) {
      if (full) textBubble(hx, hy, '🚶 ' + p.working.tool, BUBBLE.work);
    } else if (p.lastAction && p.lastAction.until > now && full) {
      textBubble(hx, hy, (p.lastAction.failed ? '✗ ' : '✓ ') + p.lastAction.text, p.lastAction.failed ? BUBBLE.fail : BUBBLE.done);
    } else if (!p.path.length && C.isSleeping(p)) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold 12px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('z'.repeat((Math.floor(t * 1.5) % 3) + 1), hx + 10, hy - 6);
    } else if (!p.path.length && p.building === 'praca' && full) {
      badge(hx, hy, '☕');
    }
  }

  C.ui = { textBubble, badge, nameTag, personBubble, roundRect, BUBBLE, FONT, ctx: () => ctx };

  function drawCityOverlay(t) {
    const S = SCALE;
    // placas na fachada (texto nítido em alta resolução, desenhado pelo art.js)
    const hoverBuilding = hover && hover.kind === 'building' ? hover.id : null;
    C.art.drawSignText(ctx, S, occupants, hoverBuilding);
    // etiqueta completa (nome, ★, 👥, 🔥) só para o prédio sob o mouse
    for (const L of LAYOUT) {
      if (L.id !== hoverBuilding) continue;
      const b = BUILDINGS[L.id];
      const r = geo.rects[L.id];
      const cx = (r.x + r.w / 2) * S;
      const ty = (b.park ? r.y + 2 : r.y) * S - (L.id === 'prefeitura' || b.antenna ? 16 * S : 6);
      const n = occupants(L.id);
      const lvl = C.defs.levelOf(L.id, C.lifetime);
      const label = `${C.isOnFire(L.id) ? '🔥 ' : ''}${b.icon} ${lvl.name}${lvl.level ? ' ' + '★'.repeat(lvl.level) : ''}${n ? `  👥${n}` : ''}`;
      const isHover = hover && hover.kind === 'building' && hover.id === L.id;
      ctx.font = `bold 13px ${FONT}`;
      const w = ctx.measureText(label).width + 14;
      ctx.fillStyle = isHover ? 'rgba(255,209,102,.95)' : 'rgba(20,24,36,.75)';
      roundRect(ctx, cx - w / 2, ty - 20, w, 20, 4);
      ctx.fill();
      ctx.fillStyle = isHover ? '#1b2030' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, ty - 9.5);
      if (isHover) {
        ctx.strokeStyle = 'rgba(255,209,102,.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        roundRect(ctx, r.x * S - 3, r.y * S - 3, r.w * S + 6, r.h * S + 6, 4);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // plaquinhas das casas do bairro
    ctx.font = `600 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const h of geo.houses || []) {
      const isHover = hover && hover.kind === 'house' && hover.key === h.key;
      let label = h.label.length > 12 ? h.label.slice(0, 11) + '…' : h.label;
      const w = ctx.measureText(label).width + 8;
      const cx = (h.x + h.w / 2) * S, cy = (h.y - 4) * S;
      ctx.fillStyle = isHover ? 'rgba(255,209,102,.95)' : 'rgba(20,24,36,.7)';
      roundRect(ctx, cx - w / 2, cy - 7, w, 14, 3);
      ctx.fill();
      ctx.fillStyle = isHover ? '#1b2030' : `hsl(${h.hue} 70% 75%)`;
      ctx.fillText(label, cx, cy + 0.5);
    }
    if (geo.houseOverflow) {
      const o = geo.houseOverflow;
      ctx.fillStyle = '#3a2a1a';
      ctx.font = `bold 11px ${FONT}`;
      ctx.fillText(`+${o.n}`, o.x * S + 1, (o.y - 10.5) * S);
    }

    const list = [...people.values()];
    // linhas ligando subagentes aos pais
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    for (const p of list) {
      if (!p.parent) continue;
      const par = people.get(p.parent);
      if (!par) continue;
      ctx.strokeStyle = par.color;
      ctx.globalAlpha = 0.55 * p.alpha;
      ctx.beginPath();
      ctx.moveTo(p.x * S, (p.y - 6) * S);
      ctx.lineTo(par.x * S, (par.y - 9) * S);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (const p of list) {
      ctx.globalAlpha = p.alpha;
      nameTag(p, p.x * S, p.y * S + 3);
    }
    ctx.globalAlpha = 1;

    // balões: o selecionado e o que está sob o mouse por último (ficam por cima)
    const focus = (p) => p.key === C.selected || (hover && hover.kind === 'person' && hover.key === p.key);
    list.sort((a, b) => (focus(a) ? 1 : 0) - (focus(b) ? 1 : 0));
    for (const p of list) {
      personBubble(p, p.x * S, (p.headY != null ? p.headY : p.y - 10) * S, t, focus(p));
    }

    // dica sobre o prédio (ou casa) sob o mouse
    const hoverHouse = hover && hover.kind === 'house' ? (geo.houses || []).find((x) => x.key === hover.key) : null;
    if (mouse && ((hover && hover.kind === 'building') || hoverHouse)) {
      let tip;
      if (hoverHouse) {
        const st = houseStatus(hoverHouse);
        tip = `🏠 ${hoverHouse.label}${st.active ? ` · ${st.active} ${st.active === 1 ? 'sessão ativa' : 'sessões ativas'}` : ''}${st.alert ? ' · ❗ esperando você' : ''} — clique para ver o projeto`;
      } else {
        const b = BUILDINGS[hover.id];
        const n = occupants(hover.id);
        tip = `Clique para entrar ${b.park ? 'na' : 'em'} ${b.name}${n ? ` · ${n} lá dentro` : ''}`;
      }
      ctx.font = `600 12px ${FONT}`;
      const w = ctx.measureText(tip).width + 16;
      const tx = Math.min(areaW - w - 6, mouse.x + 14), ty = mouse.y + 18;
      ctx.fillStyle = 'rgba(20,24,36,.92)';
      roundRect(ctx, tx, ty, w, 24, 5);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(tip, tx + 8, ty + 12.5);
    }

    // cidade tranquila
    const now = C.now();
    if (people.size === 0 || now - C.lastEventAt > QUIET_AFTER_MS) {
      ctx.font = `600 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const msg = people.size === 0 ? 'Cidade vazia — aguardando agentes do Claude Code…' : `Cidade tranquila ${C.lightAt().icon}`;
      const w = ctx.measureText(msg).width + 24;
      const y = cssH - 34;
      ctx.fillStyle = 'rgba(20,24,36,.75)';
      roundRect(ctx, areaW / 2 - w / 2, y, w, 26, 6);
      ctx.fill();
      ctx.fillStyle = '#e8ebf2';
      ctx.fillText(msg, areaW / 2, y + 13.5);
    }
  }

  // ---------------------------------------------------------------------------
  // Mouse / teclado
  // ---------------------------------------------------------------------------
  let hover = null; // { kind: 'person', key } | { kind: 'building', id } | { kind: 'door' }
  let mouse = null;

  function hitTest(mx, my) {
    const wx = mx / SCALE, wy = my / SCALE;
    if (mx > areaW) return null;
    if (C.scene.type === 'interior') {
      return C.interiors ? C.interiors.hitTest(C.scene.id, wx, wy) : null;
    }
    let best = null, bestD = 9;
    for (const p of people.values()) {
      if (p.leaving) continue;
      const d = Math.hypot(p.x - wx, p.y - (p.small ? 6 : 8) - wy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) return { kind: 'person', key: best.key };
    for (const h of geo.houses || []) {
      if (wx >= h.x - 2 && wx <= h.x + h.w + 4 && wy >= h.y - 8 && wy <= h.y + h.h + 2) return { kind: 'house', key: h.key };
    }
    for (const L of LAYOUT) {
      const r = geo.rects[L.id];
      const pad = 4;
      if (wx >= r.x - pad && wx <= r.x + r.w + pad && wy >= r.y - 16 && wy <= r.y + r.h + 2) return { kind: 'building', id: L.id };
    }
    return null;
  }

  canvas.addEventListener('mousemove', (e) => {
    mouse = { x: e.offsetX, y: e.offsetY };
    hover = hitTest(e.offsetX, e.offsetY);
    canvas.style.cursor = hover ? 'pointer' : 'default';
    C.hover = hover;
  });
  canvas.addEventListener('mouseleave', () => { hover = null; mouse = null; C.hover = null; });
  canvas.addEventListener('click', (e) => {
    const h = hitTest(e.offsetX, e.offsetY);
    if (!h) { if (C.scene.type === 'city') C.select(null); return; }
    if (h.kind === 'person') C.select(h.key);
    else if (h.kind === 'building') C.enter(h.id);
    else if (h.kind === 'house') { const hs = (geo.houses || []).find((x) => x.key === h.key); if (hs && C.openProject) C.openProject(hs.cwd); }
    else if (h.kind === 'door') C.exitInterior();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || /INPUT|TEXTAREA/.test(document.activeElement && document.activeElement.tagName)) return;
    if (C.scene.type === 'interior') C.exitInterior();
    else C.select(null);
  });

  // ---------------------------------------------------------------------------
  // Laço principal
  // ---------------------------------------------------------------------------
  let lastT = performance.now();

  function update(dt) {
    for (const p of [...people.values()]) {
      const speed = (p.small ? 46 : 38) * (p.leaving ? 1.3 : 1) * (C.timeScale || 1);
      let budget = speed * dt;
      while (budget > 0 && p.path.length) {
        const n = p.path[0];
        const dx = n.x - p.x, dy = n.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d <= budget) { p.x = n.x; p.y = n.y; p.path.shift(); budget -= d; }
        else { p.x += (dx / d) * budget; p.y += (dy / d) * budget; budget = 0; }
      }
      if (p.leaving && !p.path.length) {
        p.alpha -= dt * 2;
        if (p.alpha <= 0) { people.delete(p.key); C.emit('gone', p.key); }
      }
    }
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const t = now / 1000;
    update(dt);

    // Transição com fade: escurece, troca a cena no meio, clareia.
    let fade = 0;
    if (transition) {
      const k = (now - transition.start) / 300;
      if (k >= 0.5 && !transition.switched) {
        transition.switched = true;
        C.scene = transition.to;
        hover = null;
        C.emit('scene', C.scene);
      }
      fade = k < 0.5 ? k * 2 : Math.max(0, 2 - k * 2);
      if (k >= 1) transition = null;
    }

    const interior = C.scene.type === 'interior' && C.interiors;
    if (interior) C.interiors.drawWorld(g, C.scene.id, t, dt);
    else drawCityWorld(t, dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1b2030';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(world, 0, 0, W * SCALE * dpr, H * SCALE * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    C.art.postFx(ctx, areaW, cssH, C.lightAt()); // vinheta + gradação de cor
    if (interior) C.interiors.drawOverlay(ctx, C.scene.id, t, hover);
    else drawCityOverlay(t);

    if (fade > 0) {
      ctx.fillStyle = `rgba(10,12,20,${fade})`;
      ctx.fillRect(0, 0, areaW, cssH);
    }
    requestAnimationFrame(frame);
  }

  C.start = () => {
    window.addEventListener('resize', resize);
    resize();
    connect();
    requestAnimationFrame(frame);
  };
})();

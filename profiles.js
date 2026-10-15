// Estado da cidade com persistência:
// - data/state.json: perfis, histórico dos prédios, projetos, contadores, conquistas;
// - data/events/AAAA-MM-DD.jsonl: todos os eventos do dia (para relatórios e replay).
// Sessões simuladas (test-events.js) aparecem ao vivo, mas não são gravadas no
// histórico nem contam para contadores, relatórios ou conquistas.

const fs = require('fs');
const path = require('path');
const { BUILDINGS, buildingFor, categoryOf, folderName, isAlertNotification, isSimulated } = require('./public/buildings.js');
const achievements = require('./achievements.js');

const SAVE_DEBOUNCE_MS = 2000;
const MAX_FILES = 15;
const MAX_HISTORY = 40;
const MAX_RECENT = 50;
const MAX_SLOWEST = 5;
const ENDED_TTL_MS = 24 * 3600 * 1000;
const IDLE_TTL_MS = 7 * 24 * 3600 * 1000;
const PROJECT_TTL_MS = 30 * 24 * 3600 * 1000;
const EVENTS_KEEP_DAYS = 30;
const FILE_OPS = { Read: 'leu', Edit: 'editou', Write: 'criou', MultiEdit: 'editou', NotebookEdit: 'editou' };

const dayKey = achievements.dayKey;
const today = () => dayKey(Date.now());

function freshStats() {
  return { day: today(), reads: 0, edits: 0, commands: 0, web: 0, subagents: 0, events: 0, actions: 0, failures: 0, toolMs: 0, waitedMs: 0 };
}

function freshBuildings() {
  const out = {};
  for (const id of Object.keys(BUILDINGS)) out[id] = { visitsToday: 0, history: [] };
  return out;
}

class Store {
  constructor(file) {
    this.file = file;
    this.eventsDir = path.join(path.dirname(file), 'events');
    this.profiles = {};
    this.buildings = freshBuildings();
    this.stats = freshStats();
    this.recent = [];
    this.projects = {};
    this.lifetime = achievements.freshLifetime();
    this.achievements = {};
    this.doneIds = new Set(); // tool_use_id cujo Post chegou antes do Pre
    this.pendingUnlocks = [];
    this.saveTimer = null;
    this.load();
    try { fs.mkdirSync(this.eventsDir, { recursive: true }); } catch (_) {}
    this.seedEvents();
    this.cleanupEvents();
  }

  // Na primeira vez com histórico em disco, aproveita o buffer de eventos já salvo.
  seedEvents() {
    let files = [];
    try { files = fs.readdirSync(this.eventsDir); } catch (_) { return; }
    if (files.some((f) => f.endsWith('.jsonl'))) return;
    const byDay = new Map();
    for (const ev of this.recent) {
      if (!ev.ts || isSimulated(ev.session_id)) continue;
      const d = dayKey(ev.ts);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(JSON.stringify(ev));
    }
    for (const [d, lines] of byDay) {
      try { fs.writeFileSync(this.eventsFile(d), lines.join('\n') + '\n'); } catch (_) {}
    }
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (_) {
      return; // primeira vez
    }
    try {
      const data = JSON.parse(raw);
      if (data.profiles && typeof data.profiles === 'object') this.profiles = data.profiles;
      if (data.buildings && typeof data.buildings === 'object') {
        for (const id of Object.keys(this.buildings)) {
          if (data.buildings[id]) this.buildings[id] = data.buildings[id];
        }
      }
      if (data.stats && data.stats.day) this.stats = { ...freshStats(), ...data.stats };
      if (Array.isArray(data.recent)) this.recent = data.recent.slice(-MAX_RECENT);
      if (data.projects && typeof data.projects === 'object') this.projects = data.projects;
      if (data.lifetime && typeof data.lifetime === 'object') this.lifetime = { ...achievements.freshLifetime(), ...data.lifetime };
      else if (data.stats) {
        // Primeira vez com conquistas: começa a vida toda com o que já foi contado hoje.
        for (const k of ['reads', 'edits', 'commands', 'subagents']) this.lifetime[k] = data.stats[k] || 0;
      }
      if (data.achievements && typeof data.achievements === 'object') this.achievements = data.achievements;
    } catch (err) {
      const bad = this.file + '.corrupt';
      try { fs.renameSync(this.file, bad); } catch (_) {}
      console.error(`Aviso: ${this.file} estava corrompido; movido para ${bad}. Começando do zero.`);
    }
    this.rollDay();
    this.prune();
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  saveNow() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        version: 2,
        profiles: this.profiles, buildings: this.buildings, stats: this.stats, recent: this.recent,
        projects: this.projects, lifetime: this.lifetime, achievements: this.achievements,
      }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('Não consegui salvar o estado:', err.message);
    }
  }

  // --- histórico de eventos em disco ---
  eventsFile(day) {
    return path.join(this.eventsDir, `${day}.jsonl`);
  }

  logEvent(ev) {
    fs.appendFile(this.eventsFile(dayKey(ev.ts)), JSON.stringify(ev) + '\n', () => {});
  }

  cleanupEvents() {
    const limit = dayKey(Date.now() - EVENTS_KEEP_DAYS * 24 * 3600 * 1000);
    let files = [];
    try { files = fs.readdirSync(this.eventsDir); } catch (_) { return; }
    for (const f of files) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < limit) fs.unlink(path.join(this.eventsDir, f), () => {});
    }
  }

  rollDay() {
    if (this.stats.day === today()) return;
    this.pendingUnlocks.push(...achievements.onDayEnd(this, this.stats));
    this.stats = freshStats();
    for (const b of Object.values(this.buildings)) b.visitsToday = 0;
    if (this.eventsDir) this.cleanupEvents();
  }

  prune() {
    const now = Date.now();
    for (const [key, p] of Object.entries(this.profiles)) {
      if ((p.endedAt && now - p.endedAt > ENDED_TTL_MS) || now - (p.lastSeen || 0) > IDLE_TTL_MS) {
        delete this.profiles[key];
      }
    }
    for (const p of Object.values(this.profiles)) {
      p.children = (p.children || []).filter((k) => this.profiles[k]);
    }
    for (const [k, pr] of Object.entries(this.projects)) {
      if (now - (pr.lastSeen || 0) > PROJECT_TTL_MS) delete this.projects[k];
    }
  }

  snapshot() {
    this.rollDay();
    return {
      profiles: this.profiles, buildings: this.buildings, stats: this.stats,
      projects: this.projects, achievements: achievements.list(this), lifetime: this.lifetime,
    };
  }

  achievementList() {
    return achievements.list(this);
  }

  forget(key) {
    const p = this.profiles[key];
    if (!p) return false;
    for (const child of p.children || []) delete this.profiles[child];
    if (p.parent && this.profiles[p.parent]) {
      this.profiles[p.parent].children = this.profiles[p.parent].children.filter((k) => k !== key);
    }
    delete this.profiles[key];
    // Some também do histórico dos prédios e do buffer de eventos.
    const mine = (k) => k === key || (k && k.startsWith(key + '/'));
    for (const b of Object.values(this.buildings)) b.history = b.history.filter((h) => !mine(h.key));
    this.recent = this.recent.filter((ev) => !mine(ev.session_id) && !mine(`${ev.session_id}/${ev.agent_id}`));
    this.scheduleSave();
    return true;
  }

  ensure(ev, key, isAgent) {
    // Eventos de subagente trazem agent_type do subagente; não deixa vazar para o pai.
    const agentType = isAgent || !ev.agent_id ? ev.agent_type || null : null;
    let p = this.profiles[key];
    if (!p) {
      const sid = ev.session_id || 'desconhecida';
      let label = isAgent ? ev.agent_type || 'subagente' : folderName(ev.cwd);
      if (!isAgent) {
        const clash = Object.values(this.profiles).some((o) => !o.parent && !o.endedAt && o.label === label);
        if (clash) label += ` #${sid.slice(0, 4)}`;
      }
      p = this.profiles[key] = {
        key,
        session_id: sid,
        agent_id: isAgent ? ev.agent_id : null,
        agent_type: agentType,
        parent: isAgent ? sid : null,
        children: [],
        label,
        cwd: ev.cwd || '',
        firstSeen: ev.ts,
        lastSeen: ev.ts,
        endedAt: null,
        state: 'prefeitura',
        building: 'prefeitura',
        current: null,
        alert: null,
        counts: { reads: 0, edits: 0, commands: 0, web: 0, delegations: 0, other: 0, prompts: 0, failures: 0, subagents: 0 },
        tools: {},
        files: [],
        lastPrompt: null,
      };
    }
    // Campos que perfis antigos (de versões anteriores) não tinham.
    if (!p.toolTime) p.toolTime = {};
    if (!p.slowest) p.slowest = [];
    if (p.waitedMs == null) { p.waitedMs = 0; p.waits = 0; }
    if (!p.cwd && ev.cwd) p.cwd = ev.cwd;
    if (ev.terminal) p.terminal = ev.terminal;
    if (agentType && !p.agent_type) p.agent_type = agentType;
    p.lastSeen = ev.ts;
    return p;
  }

  touchProject(main, ev, isNewSession) {
    const cwd = main.cwd;
    if (!cwd) return;
    const k = cwd.toLowerCase();
    const pr = this.projects[k] || (this.projects[k] = { cwd, label: folderName(cwd), firstSeen: ev.ts, lastSeen: ev.ts, sessions: 0 });
    pr.lastSeen = ev.ts;
    if (isNewSession) pr.sessions++;
  }

  // Encerra o alerta de um perfil e contabiliza quanto tempo ele esperou você.
  clearAlert(p, ev, sim) {
    if (!p.alert) return null;
    const ms = Math.max(0, ev.ts - (p.alert.ts || ev.ts));
    const out = { ms, type: p.alert.type };
    p.waitedMs = (p.waitedMs || 0) + ms;
    p.waits = (p.waits || 0) + 1;
    if (!sim) this.stats.waitedMs += ms;
    p.alert = null;
    if (p.state === 'esperando') p.state = 'parado';
    return out;
  }

  markDone(id) {
    this.doneIds.add(id);
    if (this.doneIds.size > 500) this.doneIds.delete(this.doneIds.values().next().value);
  }

  // Aplica um evento. Devolve { profiles: [...alterados], building, unlocked: [...] }.
  apply(ev) {
    const sim = isSimulated(ev.session_id);
    this.rollDay();
    this.recent.push(ev);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    if (!sim) {
      this.stats.events++;
      this.logEvent(ev);
    }

    const name = ev.hook_event_name;
    const sid = ev.session_id || 'desconhecida';
    const isNewSession = !this.profiles[sid];
    const main = this.ensure(ev, sid, false);
    const who = ev.agent_id ? this.ensure(ev, `${sid}/${ev.agent_id}`, true) : main;
    const changed = new Set([who]);
    let building = null;
    let cat = null;
    let waited = null;
    if (who !== main && !main.children.includes(who.key)) {
      main.children.push(who.key);
      changed.add(main);
    }
    if (!sim) this.touchProject(main, ev, isNewSession);
    if (name !== 'SessionEnd' && name !== 'SubagentStop') who.endedAt = null;

    // Qualquer evento novo do agente significa que ele já não está travado esperando você.
    // Se o alerta era por causa de uma ferramenta de um subagente, o fim dela também libera.
    if (name !== 'Notification') {
      waited = this.clearAlert(who, ev, sim);
      if (main !== who && main.alert && main.alert.toolKey === who.key && /^PostToolUse/.test(name)) {
        waited = this.clearAlert(main, ev, sim) || waited;
        changed.add(main);
      }
    }

    switch (name) {
      case 'SessionStart':
        who.state = 'prefeitura'; who.building = 'prefeitura'; who.current = null;
        break;
      case 'UserPromptSubmit':
        who.counts.prompts++;
        if (ev.summary) who.lastPrompt = { text: ev.summary, ts: ev.ts };
        who.state = 'prefeitura'; who.building = 'prefeitura'; who.current = null;
        break;
      case 'PreToolUse': {
        const tool = ev.tool_name || '?';
        cat = categoryOf(tool);
        who.counts[cat] = (who.counts[cat] || 0) + 1;
        who.tools[tool] = (who.tools[tool] || 0) + 1;
        const bid = buildingFor(tool);
        who.building = bid;
        // Se o Post desta ferramenta já chegou (hooks são assíncronos), ela já acabou.
        if (ev.tool_use_id && this.doneIds.has(ev.tool_use_id)) {
          this.doneIds.delete(ev.tool_use_id);
          who.current = null;
          who.state = 'parado';
        } else {
          who.current = { tool, summary: ev.summary || null, since: ev.ts, id: ev.tool_use_id || null };
          who.state = 'trabalhando';
        }
        if (FILE_OPS[tool] && ev.summary) {
          who.files = who.files.filter((f) => f.path !== ev.summary);
          who.files.unshift({ path: ev.summary, op: FILE_OPS[tool], ts: ev.ts });
          who.files.length = Math.min(who.files.length, MAX_FILES);
        }
        if (!sim) {
          this.stats.actions++;
          if (this.stats[cat] != null) this.stats[cat]++;
          const b = this.buildings[bid];
          b.visitsToday++;
          b.history.unshift({ ts: ev.ts, key: who.key, label: who.label, text: ev.summary ? `${tool}: ${ev.summary}` : tool });
          b.history.length = Math.min(b.history.length, MAX_HISTORY);
          building = { id: bid, info: b };
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const tool = ev.tool_name || '?';
        const id = ev.tool_use_id || null;
        const cur = who.current;
        if (cur && (!id || !cur.id || cur.id === id)) {
          who.current = null;
          if (who.state === 'trabalhando') who.state = 'parado';
        } else if (id && (!cur || cur.id !== id)) {
          this.markDone(id); // o Pre ainda não chegou
        }
        if (typeof ev.duration_ms === 'number' && ev.duration_ms >= 0) {
          who.toolTime[tool] = (who.toolTime[tool] || 0) + ev.duration_ms;
          if (!sim) this.stats.toolMs += ev.duration_ms;
          const text = ev.summary ? `${tool}: ${ev.summary}` : tool;
          who.slowest.push({ text, ms: ev.duration_ms, ts: ev.ts });
          who.slowest.sort((a, b) => b.ms - a.ms);
          who.slowest.length = Math.min(who.slowest.length, MAX_SLOWEST);
        }
        if (name === 'PostToolUseFailure') {
          who.counts.failures++;
          if (!sim) this.stats.failures++;
        }
        break;
      }
      case 'SubagentStart':
        if (who !== main) { main.counts.subagents++; changed.add(main); }
        if (!sim) this.stats.subagents++;
        who.state = 'parado';
        break;
      case 'SubagentStop':
        who.state = 'saiu'; who.endedAt = ev.ts; who.current = null; who.alert = null;
        break;
      case 'Notification': {
        if (!isAlertNotification(ev.notification_type)) {
          who.lastNotice = { text: ev.message || '', type: ev.notification_type || null, ts: ev.ts };
          break;
        }
        // Ferramenta que está esperando a permissão: a do próprio agente ou, se ele
        // não tem nenhuma em andamento, a mais recente de um dos seus subagentes.
        let owner = who.current ? who : null;
        for (const k of who.children || []) {
          const c = this.profiles[k];
          if (c && !c.endedAt && c.current && (!owner || c.current.since > owner.current.since)) owner = c;
        }
        who.state = 'esperando';
        who.alert = {
          text: ev.message || 'Precisa de atenção',
          title: ev.title || null,
          type: ev.notification_type || null,
          tool: owner ? (owner.current.summary ? `${owner.current.tool}: ${owner.current.summary}` : owner.current.tool) : null,
          toolKey: owner ? owner.key : null,
          ts: ev.ts,
        };
        break;
      }
      case 'Stop':
        who.state = 'cafe'; who.building = 'praca'; who.current = null;
        break;
      case 'SessionEnd':
        who.state = 'saiu'; who.endedAt = ev.ts; who.current = null; who.alert = null;
        for (const k of who.children) {
          const c = this.profiles[k];
          if (c && !c.endedAt) { c.endedAt = ev.ts; c.state = 'saiu'; changed.add(c); }
        }
        break;
    }

    const unlocked = this.pendingUnlocks.splice(0);
    const daysBefore = this.lifetime.days.length;
    if (!sim) unlocked.push(...achievements.track(this, ev, { who, cat, waited }));
    // Contadores que fazem a cidade crescer mudaram? (o navegador só precisa saber nesses casos)
    const lifetimeChanged = !sim && (['PreToolUse', 'SubagentStart', 'SessionStart'].includes(name) || this.lifetime.days.length !== daysBefore);
    this.scheduleSave();
    return { profiles: [...changed], building, unlocked, lifetimeChanged };
  }
}

module.exports = { Store, dayKey };

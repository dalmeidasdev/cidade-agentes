// Conquistas da cidade. Ficam em data/state.json (store.achievements) e usam
// contadores da vida toda (store.lifetime). Sessões simuladas não contam.
//
// Para criar uma conquista nova: acrescente uma entrada em DEFS. Com `stat` e
// `goal` ela é desbloqueada automaticamente quando o contador chega lá; sem
// eles, chame unlock() na regra correspondente em track().

const DAY_MS = 24 * 3600 * 1000;

const DEFS = [
  { id: 'fundacao', icon: '🎉', name: 'Fundação da cidade', desc: 'O primeiro evento real chegou à cidade' },
  { id: 'obras100', icon: '🔨', name: 'Mestre de obras', desc: '100 edições de arquivo', stat: 'edits', goal: 100 },
  { id: 'obras1000', icon: '🏗️', name: 'Construtora', desc: '1000 edições de arquivo', stat: 'edits', goal: 1000 },
  { id: 'livros500', icon: '📚', name: 'Devorador de livros', desc: '500 leituras e buscas', stat: 'reads', goal: 500 },
  { id: 'cientista200', icon: '🧪', name: 'Cientista maluco', desc: '200 comandos no terminal', stat: 'commands', goal: 200 },
  { id: 'correio50', icon: '📮', name: 'Correspondente', desc: '50 acessos à web ou a MCP', stat: 'web', goal: 50 },
  { id: 'creche', icon: '👶', name: 'Creche lotada', desc: '3 subagentes trabalhando ao mesmo tempo' },
  { id: 'metropole', icon: '🏙️', name: 'Metrópole', desc: '3 sessões ativas ao mesmo tempo' },
  { id: 'coruja', icon: '🦉', name: 'Coruja', desc: 'Agente trabalhando entre meia-noite e 4h' },
  { id: 'madrugador', icon: '🌅', name: 'Madrugador', desc: 'Agente trabalhando entre 4h e 6h' },
  { id: 'dialimpo', icon: '✅', name: 'Dia limpo', desc: 'Um dia inteiro com 50+ ações e nenhuma falha' },
  { id: 'sequencia5', icon: '🔥', name: 'Sequência', desc: '5 dias seguidos com atividade', stat: 'streak', goal: 5 },
  { id: 'rapido', icon: '⚡', name: 'Resposta rápida', desc: 'Responder a um pedido de permissão em menos de 10 s' },
  { id: 'paciencia', icon: '🐢', name: 'Paciência', desc: 'Uma ação que levou mais de 5 minutos' },
  { id: 'bairro', icon: '🏘️', name: 'Bairro cheio', desc: '5 projetos diferentes na mesma semana', stat: 'projectsWeek', goal: 5 },
];

function freshLifetime() {
  return { reads: 0, edits: 0, commands: 0, web: 0, other: 0, delegations: 0, subagents: 0, sessions: 0, days: [] };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Dias seguidos com atividade, terminando hoje (ou ontem, se hoje ainda não teve nada).
function streak(days, now) {
  const set = new Set(days);
  let d = new Date(now || Date.now());
  if (!set.has(dayKey(d.getTime()))) d = new Date(d.getTime() - DAY_MS);
  let n = 0;
  while (set.has(dayKey(d.getTime()))) { n++; d = new Date(d.getTime() - DAY_MS); }
  return n;
}

function statValue(store, stat) {
  const lt = store.lifetime;
  if (stat === 'streak') return streak(lt.days);
  if (stat === 'projectsWeek') {
    const since = Date.now() - 7 * DAY_MS;
    return Object.values(store.projects || {}).filter((p) => p.lastSeen >= since).length;
  }
  return lt[stat] || 0;
}

function view(store, def) {
  const got = store.achievements[def.id];
  return {
    id: def.id, icon: def.icon, name: def.name, desc: def.desc,
    goal: def.goal || null,
    progress: def.goal ? Math.min(statValue(store, def.stat), def.goal) : null,
    unlockedAt: got ? got.unlockedAt : null,
    by: got ? got.by : null,
    byLabel: got ? got.byLabel : null,
  };
}

function unlock(store, id, ts, who, out) {
  if (store.achievements[id]) return;
  store.achievements[id] = { unlockedAt: ts || Date.now(), by: who ? who.key : null, byLabel: who ? who.label : null };
  out.push(view(store, DEFS.find((d) => d.id === id)));
}

// Atualiza os contadores da vida toda e devolve as conquistas recém-desbloqueadas.
// ctx: { who, cat, waited: {ms, type} | null }
function track(store, ev, ctx) {
  const out = [];
  const lt = store.lifetime;
  const name = ev.hook_event_name;
  const who = ctx.who;

  const day = dayKey(ev.ts);
  if (!lt.days.includes(day)) {
    lt.days.push(day);
    if (lt.days.length > 60) lt.days.shift();
  }
  if (name === 'PreToolUse' && ctx.cat) lt[ctx.cat] = (lt[ctx.cat] || 0) + 1;
  if (name === 'SubagentStart') lt.subagents++;
  if (name === 'SessionStart') lt.sessions++;

  unlock(store, 'fundacao', ev.ts, who, out);

  for (const def of DEFS) {
    if (def.goal && statValue(store, def.stat) >= def.goal) unlock(store, def.id, ev.ts, who, out);
  }

  const live = Object.values(store.profiles).filter((p) => !p.endedAt && !String(p.session_id).startsWith('simulado-'));
  if (name === 'SubagentStart' && live.filter((p) => p.parent).length >= 3) unlock(store, 'creche', ev.ts, who, out);
  if (live.filter((p) => !p.parent && ev.ts - p.lastSeen < 30 * 60 * 1000).length >= 3) unlock(store, 'metropole', ev.ts, who, out);

  if (name === 'PreToolUse') {
    const h = new Date(ev.ts).getHours();
    if (h < 4) unlock(store, 'coruja', ev.ts, who, out);
    else if (h < 6) unlock(store, 'madrugador', ev.ts, who, out);
  }
  if (ctx.waited && ctx.waited.type === 'permission_prompt' && ctx.waited.ms < 10000) unlock(store, 'rapido', ev.ts, who, out);
  if (typeof ev.duration_ms === 'number' && ev.duration_ms >= 5 * 60 * 1000) unlock(store, 'paciencia', ev.ts, who, out);
  return out;
}

// Chamado na virada do dia com os números do dia que acabou.
function onDayEnd(store, stats) {
  const out = [];
  if ((stats.actions || 0) >= 50 && (stats.failures || 0) === 0) unlock(store, 'dialimpo', Date.now(), null, out);
  return out;
}

function list(store) {
  return DEFS.map((d) => view(store, d));
}

module.exports = { DEFS, freshLifetime, track, onDayEnd, list, streak, dayKey };

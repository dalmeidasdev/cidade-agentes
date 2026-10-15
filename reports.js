// Relatórios calculados a partir de data/events/AAAA-MM-DD.jsonl.
// Tudo local, sob demanda, com cache pela data de modificação do arquivo.

const fs = require('fs');
const path = require('path');
const { buildingFor, categoryOf, folderName, isAlertNotification } = require('./public/buildings.js');
const { dayKey } = require('./achievements.js');

const ACTIVE_GAP_MS = 5 * 60 * 1000; // intervalos maiores que isso não contam como tempo ativo
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CATS = ['reads', 'edits', 'commands', 'web', 'other'];

const cache = new Map(); // `${day}|${project}` -> { mtimeMs, report }

function readEvents(dir, day) {
  const file = path.join(dir, `${day}.jsonl`);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* linha cortada: ignora */ }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function mtime(dir, day) {
  try { return fs.statSync(path.join(dir, `${day}.jsonl`)).mtimeMs; } catch (_) { return 0; }
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, n).map(([k, v]) => ({ key: k, ...v }));
}

// project: caminho (cwd) do projeto para filtrar, ou vazio para todos.
function compute(events, day, project) {
  // Projeto de cada sessão = cwd do primeiro evento dela.
  const sessionCwd = new Map();
  for (const ev of events) if (ev.session_id && ev.cwd && !sessionCwd.has(ev.session_id)) sessionCwd.set(ev.session_id, ev.cwd);
  const want = project ? project.toLowerCase() : null;
  if (want) events = events.filter((ev) => (sessionCwd.get(ev.session_id) || '').toLowerCase() === want);

  const hours = Array.from({ length: 24 }, () => ({ reads: 0, edits: 0, commands: 0, web: 0, other: 0 }));
  const totals = { actions: 0, reads: 0, edits: 0, commands: 0, web: 0, other: 0, failures: 0, prompts: 0, subagents: 0, sessions: 0, activeMs: 0, waitedMs: 0, toolMs: 0 };
  const projects = new Map();
  const edited = new Map();
  const read = new Map();
  const failures = [];
  const slowest = [];
  const subTypes = new Map();
  const prompts = [];
  const lastTs = new Map();      // sessão -> último evento (tempo ativo)
  const pendingAlert = new Map(); // sessão -> ts do alerta
  const sessions = new Set();

  const projOf = (ev) => {
    const cwd = sessionCwd.get(ev.session_id) || ev.cwd || '';
    const k = cwd.toLowerCase();
    if (!projects.has(k)) projects.set(k, { cwd, label: folderName(cwd), actions: 0, reads: 0, edits: 0, commands: 0, web: 0, failures: 0, activeMs: 0, sessions: new Set() });
    return projects.get(k);
  };

  for (const ev of events) {
    const sid = ev.session_id || '?';
    const pr = projOf(ev);
    sessions.add(sid);
    pr.sessions.add(sid);

    const prev = lastTs.get(sid);
    if (prev != null && ev.ts - prev < ACTIVE_GAP_MS) { totals.activeMs += ev.ts - prev; pr.activeMs += ev.ts - prev; }
    lastTs.set(sid, ev.ts);

    const name = ev.hook_event_name;
    if (name === 'Notification') {
      if (isAlertNotification(ev.notification_type) && !pendingAlert.has(sid)) pendingAlert.set(sid, ev.ts);
      continue;
    }
    if (pendingAlert.has(sid)) { totals.waitedMs += ev.ts - pendingAlert.get(sid); pendingAlert.delete(sid); }

    if (name === 'PreToolUse') {
      const cat = CATS.includes(categoryOf(ev.tool_name)) ? categoryOf(ev.tool_name) : 'other';
      hours[new Date(ev.ts).getHours()][cat]++;
      totals.actions++; totals[cat]++;
      pr.actions++; if (pr[cat] != null) pr[cat]++;
      if (ev.summary && EDIT_TOOLS.has(ev.tool_name)) {
        const k = `${pr.label}|${ev.summary}`;
        edited.set(k, { path: ev.summary, project: pr.label, n: (edited.get(k) || { n: 0 }).n + 1 });
      } else if (ev.summary && ev.tool_name === 'Read') {
        const k = `${pr.label}|${ev.summary}`;
        read.set(k, { path: ev.summary, project: pr.label, n: (read.get(k) || { n: 0 }).n + 1 });
      }
    } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
      if (typeof ev.duration_ms === 'number') {
        totals.toolMs += ev.duration_ms;
        slowest.push({ ts: ev.ts, tool: ev.tool_name, summary: ev.summary || null, ms: ev.duration_ms, project: pr.label, building: buildingFor(ev.tool_name) });
      }
      if (name === 'PostToolUseFailure') {
        totals.failures++; pr.failures++;
        failures.push({ ts: ev.ts, tool: ev.tool_name, summary: ev.summary || null, error: ev.error || null, project: pr.label, interrupted: !!ev.is_interrupt });
      }
    } else if (name === 'UserPromptSubmit') {
      totals.prompts++;
      if (ev.summary) prompts.push({ ts: ev.ts, project: pr.label, text: ev.summary });
    } else if (name === 'SubagentStart') {
      totals.subagents++;
      const t = ev.agent_type || 'subagente';
      subTypes.set(t, (subTypes.get(t) || 0) + 1);
    }
  }
  totals.sessions = sessions.size;

  return {
    day,
    project: project || null,
    totals,
    hours,
    projects: [...projects.values()]
      .map((p) => ({ ...p, sessions: p.sessions.size }))
      .filter((p) => p.cwd)
      .sort((a, b) => b.activeMs - a.activeMs || b.actions - a.actions),
    topEdited: top(edited, 8),
    topRead: top(read, 8),
    failures: failures.reverse().slice(0, 30),
    slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, 8),
    subagentTypes: [...subTypes.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
    prompts: prompts.slice(-60),
  };
}

// Busca nos últimos `days` dias de eventos (do mais recente para o mais antigo).
// Procura no resumo da ação, ferramenta, projeto, erro, tipo de agente e mensagem.
const SEARCH_MAX = 100;
function search(dir, q, days) {
  q = String(q || '').trim().toLowerCase();
  if (q.length < 2) return { q, results: [], truncated: false };
  days = Math.max(1, Math.min(60, days || 30));
  const results = [];
  for (let i = 0; i < days && results.length < SEARCH_MAX; i++) {
    const day = dayKey(Date.now() - i * 24 * 3600 * 1000);
    const events = readEvents(dir, day);
    for (let j = events.length - 1; j >= 0 && results.length < SEARCH_MAX; j--) {
      const ev = events[j];
      const name = ev.hook_event_name;
      if (name === 'PostToolUse') continue; // o Pre correspondente já aparece
      const project = folderName(ev.cwd);
      const hay = [ev.summary, ev.tool_name, project, ev.error, ev.agent_type, ev.message].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
      let text;
      if (name === 'PreToolUse') text = ev.summary ? `${ev.tool_name}: ${ev.summary}` : ev.tool_name;
      else if (name === 'PostToolUseFailure') text = `falhou: ${ev.tool_name}${ev.summary ? `: ${ev.summary}` : ''}${ev.error ? ` — ${ev.error}` : ''}`;
      else if (name === 'UserPromptSubmit') text = `pedido: “${ev.summary || ''}”`;
      else if (name === 'Notification') text = `aviso: ${ev.message || ''}`;
      else if (name === 'SubagentStart') text = `chamou subagente ${ev.agent_type || ''}`;
      else text = name;
      results.push({ ts: ev.ts, day, session_id: ev.session_id, agent_id: ev.agent_id || null, agent_type: ev.agent_type || null, project, event: name, tool: ev.tool_name || null, text });
    }
  }
  return { q, results, truncated: results.length >= SEARCH_MAX };
}

function report(dir, day, project) {
  const key = `${day}|${(project || '').toLowerCase()}`;
  const m = mtime(dir, day);
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === m) return hit.report;
  const r = compute(readEvents(dir, day), day, project);
  cache.set(key, { mtimeMs: m, report: r });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return r;
}

// Últimos 7 dias (mais antigo primeiro), com os totais de cada um.
function week(dir, project) {
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const day = dayKey(Date.now() - i * 24 * 3600 * 1000);
    const r = report(dir, day, project);
    out.push({ day, ...r.totals });
  }
  return out;
}

module.exports = { report, week, readEvents, search };

// Aba "📊 Relatório": dia (ou um dos 6 anteriores), semana e conquistas.
// Os números vêm de /api/report e /api/week (calculados no servidor a partir de
// data/events/*.jsonl). Gráficos em HTML/CSS puro.
//
// Cores das categorias: paleta categórica de referência (tons para fundo escuro),
// validada contra o fundo do painel (#1e2332): leitura, edição, comando, web, outros.

(() => {
  'use strict';

  const C = window.Cidade;
  const { BUILDINGS } = C.defs;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const SERIES = [
    { key: 'reads', label: 'leituras', icon: '📚', color: '#3987e5' },
    { key: 'edits', label: 'edições', icon: '🔨', color: '#d95926' },
    { key: 'commands', label: 'comandos', icon: '🧪', color: '#199e70' },
    { key: 'web', label: 'web/MCP', icon: '📮', color: '#c98500' },
    { key: 'other', label: 'outros', icon: '🧰', color: '#d55181' },
  ];
  const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  const REFRESH_MS = 10000;

  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const fmtMs = (ms) => C.fmtMs(ms);
  const fmtHour = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  let day = null;           // dia selecionado (null = hoje)
  let project = null;       // filtro opcional por projeto (cwd)
  const cache = new Map();  // url -> { at, data }
  let pending = new Set();
  let lastContainer = null;

  function load(url, cb) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < REFRESH_MS) return hit.data;
    if (!pending.has(url)) {
      pending.add(url);
      // Falha também vai para o cache (com os dados antigos), para não tentar de novo sem parar.
      fetch(url).then((r) => r.json()).then((data) => {
        cache.set(url, { at: Date.now(), data });
      }).catch(() => {
        cache.set(url, { at: Date.now(), data: hit ? hit.data : null });
      }).finally(() => { pending.delete(url); cb(); });
    }
    return hit ? hit.data : null;
  }

  // ---------------------------------------------------------------------------
  // Tooltip único (fica fora do HTML que é redesenhado)
  // ---------------------------------------------------------------------------
  const tip = document.createElement('div');
  tip.id = 'viz-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  function bindTips(root) {
    root.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('mouseenter', () => { tip.innerHTML = el.dataset.tip; tip.hidden = false; });
      el.addEventListener('mousemove', (e) => {
        const w = tip.offsetWidth || 160;
        tip.style.left = `${Math.min(window.innerWidth - w - 8, e.clientX + 12)}px`;
        tip.style.top = `${e.clientY + 14}px`;
      });
      el.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
  }

  // ---------------------------------------------------------------------------
  // Peças
  // ---------------------------------------------------------------------------
  function daySelector(selected) {
    let html = '<div class="day-picker" role="tablist">';
    for (let i = 6; i >= 0; i--) {
      const ts = C.now() - i * 864e5;
      const k = dayKey(ts);
      const label = i === 0 ? 'hoje' : i === 1 ? 'ontem' : WEEKDAYS[new Date(ts).getDay()];
      html += `<button class="${k === selected ? 'on' : ''}" data-day="${k}" title="${new Date(ts).toLocaleDateString('pt-BR')}">${label}<small>${new Date(ts).getDate()}</small></button>`;
    }
    return html + '</div>';
  }

  function tiles(t) {
    const tile = (value, label, extra) => `<div class="stat ${extra || ''}"><b>${value}</b><span>${label}</span></div>`;
    return `<div class="stats">
      ${tile(t.actions, '⚙️ ações')}
      ${tile(fmtMs(t.activeMs), '⏱ tempo ativo')}
      ${tile(t.failures ? `✗ ${t.failures}` : '0', 'falhas', t.failures ? 'bad' : '')}
      ${tile(fmtMs(t.waitedMs), '⏳ esperando você')}
    </div>
    <p class="muted small-line">${SERIES.slice(0, 4).map((s) => `${s.icon} ${t[s.key]} ${s.label}`).join(' · ')} · 📜 ${t.prompts} pedidos · 👶 ${t.subagents} subagentes</p>`;
  }

  function hourChart(hours) {
    const totals = hours.map((h) => SERIES.reduce((n, s) => n + h[s.key], 0));
    const max = Math.max(1, ...totals);
    const nowH = new Date(C.now()).getHours();
    let cols = '';
    hours.forEach((h, i) => {
      const segs = SERIES.filter((s) => h[s.key]).map((s) =>
        `<span style="height:${(h[s.key] / max) * 100}%;background:${s.color}"></span>`).join('');
      const tipHtml = `<b>${i}h–${i + 1}h · ${totals[i]} ${totals[i] === 1 ? 'ação' : 'ações'}</b>` +
        SERIES.filter((s) => h[s.key]).map((s) => `<div><i style="background:${s.color}"></i>${s.label}: ${h[s.key]}</div>`).join('');
      cols += `<div class="hcol ${i === nowH && day === null ? 'now' : ''}" data-tip="${esc(tipHtml)}"><div class="stack">${segs}</div></div>`;
    });
    const legend = SERIES.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('');
    const rows = hours.map((h, i) => totals[i] ? `<tr><td>${i}h</td>${SERIES.map((s) => `<td>${h[s.key]}</td>`).join('')}<td>${totals[i]}</td></tr>` : '').join('');
    return `
      <div class="legend">${legend}</div>
      <div class="hours">${cols}</div>
      <div class="hours-axis"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      <details class="as-table"><summary>Ver como tabela</summary>
        <table><thead><tr><th>hora</th>${SERIES.map((s) => `<th>${s.label}</th>`).join('')}<th>total</th></tr></thead><tbody>${rows || '<tr><td colspan="7">sem ações</td></tr>'}</tbody></table>
      </details>`;
  }

  function projectRows(projects) {
    if (!projects.length) return '<p class="empty">Nenhum projeto com atividade.</p>';
    const max = Math.max(1, ...projects.map((p) => p.activeMs || 0));
    return '<div class="bars">' + projects.slice(0, 8).map((p) => `
      <button class="bar-row proj-row" data-project="${esc(p.cwd)}" data-tip="${esc(`<b>${esc(p.label)}</b><div>${esc(p.cwd)}</div><div>${p.actions} ações · ${p.edits} edições · ${p.commands} comandos · ${p.failures} falhas · ${p.sessions} sessões</div>`)}">
        <span class="bar-label">🏠 ${esc(p.label)}</span>
        <span class="bar"><span style="width:${((p.activeMs || 0) / max) * 100}%"></span></span>
        <span class="bar-n wide">${esc(fmtMs(p.activeMs))}</span>
      </button>`).join('') + '</div>';
  }

  function fileList(items, op) {
    if (!items.length) return '<p class="empty">Nenhum.</p>';
    return '<ul class="files">' + items.map((f) =>
      `<li><span class="op op-${op}">${f.n}×</span><span class="mono">${esc(f.path)}</span><time>${esc(f.project)}</time></li>`).join('') + '</ul>';
  }

  function weekChart(week) {
    const max = Math.max(1, ...week.map((d) => d.actions));
    const sel = day || dayKey(C.now());
    return '<div class="week">' + week.map((d) => {
      const date = new Date(`${d.day}T12:00:00`);
      const tipHtml = `<b>${date.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' })}</b>` +
        `<div>${d.actions} ações · ${fmtMs(d.activeMs)} ativo</div><div>${d.failures} falhas · ${d.sessions} sessões</div>`;
      return `<button class="wcol ${d.day === sel ? 'on' : ''}" data-day="${d.day}" data-tip="${esc(tipHtml)}">
        <span class="wval">${d.actions || ''}</span>
        <span class="wbar"><span style="height:${(d.actions / max) * 100}%"></span></span>
        <span class="wlabel">${WEEKDAYS[date.getDay()]}</span></button>`;
    }).join('') + '</div>';
  }

  function achievementGrid() {
    const list = C.achievements || [];
    if (!list.length) return '<p class="empty">Carregando…</p>';
    const got = list.filter((a) => a.unlockedAt).length;
    return `<p class="muted small-line">${got} de ${list.length} desbloqueadas</p><div class="medals">` + list.map((a) => {
      const prog = a.goal && !a.unlockedAt ? `<span class="mprog"><span style="width:${(a.progress / a.goal) * 100}%"></span></span><span class="mpn">${a.progress}/${a.goal}</span>` : '';
      const when = a.unlockedAt ? `<span class="mwhen">${new Date(a.unlockedAt).toLocaleDateString('pt-BR')}${a.byLabel ? ` · ${esc(a.byLabel)}` : ''}</span>` : '';
      return `<div class="medal ${a.unlockedAt ? 'got' : 'locked'}" data-tip="${esc(`<b>${a.icon} ${esc(a.name)}</b><div>${esc(a.desc)}</div>`)}">
        <span class="mi">${a.unlockedAt ? a.icon : '🔒'}</span><span class="mn">${esc(a.name)}</span>${when}${prog}</div>`;
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Resumo em texto (Markdown) — para copiar no daily/stand-up
  // ---------------------------------------------------------------------------
  let showSummary = false;
  let lastMd = '';
  let lastMdDay = '';

  function buildMarkdown(rep, sel) {
    const t = rep.totals;
    const hour = (ts) => fmtHour(ts);
    const act = (tool, summary) => C.actionText({ tool_name: tool, summary });
    const date = new Date(`${sel}T12:00:00`).toLocaleDateString('pt-BR');
    const L = [];
    L.push(`# Resumo de ${date}${project ? ` — ${C.defs.folderName(project)}` : ''}`, '');
    if (!t.actions && !t.prompts) {
      L.push('_Nenhuma atividade registrada neste dia._');
      return L.join('\n') + '\n';
    }
    L.push(`**Tempo ativo:** ${fmtMs(t.activeMs)} · **Ações:** ${t.actions} (${t.reads} leituras, ${t.edits} edições, ${t.commands} comandos, ${t.web} web) · **Falhas:** ${t.failures} · **Esperando você:** ${fmtMs(t.waitedMs)}`);
    if (t.subagents) L.push(`**Subagentes:** ${t.subagents} (${rep.subagentTypes.map((s) => `${s.type} ×${s.n}`).join(', ')})`);
    for (const p of rep.projects) {
      L.push('', `## ${p.label} — ${fmtMs(p.activeMs)}, ${p.actions} ações`);
      const prompts = (rep.prompts || []).filter((x) => x.project === p.label);
      if (prompts.length) L.push(`- **Pedidos:** ${prompts.map((x) => `“${x.text}”`).join(', ')}`);
      const edited = rep.topEdited.filter((f) => f.project === p.label);
      if (edited.length) L.push(`- **Editados:** ${edited.map((f) => `\`${f.path}\` (${f.n}×)`).join(', ')}`);
      const fails = rep.failures.filter((f) => f.project === p.label);
      if (fails.length) L.push(`- **Falhas:** ${fails.map((f) => `${act(f.tool, f.summary)} (${hour(f.ts)})${f.error ? ` — ${f.error}` : ''}`).join('; ')}`);
      if (p.sessions > 1) L.push(`- ${p.sessions} sessões`);
    }
    if (rep.slowest.length) {
      L.push('', '## Ações mais lentas');
      for (const s of rep.slowest.slice(0, 5)) L.push(`- ${fmtMs(s.ms)} — ${act(s.tool, s.summary)} (${s.project}, ${hour(s.ts)})`);
    }
    return L.join('\n') + '\n';
  }

  function summaryBlock(rep, sel) {
    if (!showSummary) return '<div class="actions"><button data-act="md">📝 Resumo em texto</button></div>';
    lastMd = buildMarkdown(rep, sel);
    lastMdDay = sel;
    return `<div class="md-box">
      <div class="actions"><button data-act="md-copy">📋 Copiar</button><button data-act="md-dl">💾 Baixar .md</button><button data-act="md">✕ Fechar</button></div>
      <pre class="md">${esc(lastMd)}</pre></div>`;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  function render(container) {
    lastContainer = container;
    const sel = day || dayKey(C.now());
    const q = project ? `&project=${encodeURIComponent(project)}` : '';
    const rerender = () => { if (lastContainer && !lastContainer.hidden) render(lastContainer); };
    const rep = load(`/api/report?day=${sel}${q}`, rerender);
    const week = load(`/api/week?day=${sel}${q}`, rerender);
    tip.hidden = true;

    let html = daySelector(sel);
    if (project) {
      html += `<div class="filter">Só o projeto <b>${esc(C.defs.folderName(project))}</b> <button class="mini" data-act="all">ver todos</button></div>`;
    }
    if (!rep) {
      container.innerHTML = html + '<p class="empty">Carregando relatório…</p>';
      bindCommon(container);
      return;
    }
    const t = rep.totals;
    html += summaryBlock(rep, sel);
    html += tiles(t);
    if (!t.actions && !t.prompts) html += '<p class="empty">Nenhuma atividade registrada neste dia.</p>';
    html += '<div class="section-title">Atividade por hora</div>' + hourChart(rep.hours);
    if (!project) html += '<div class="section-title">Tempo ativo por projeto</div>' + projectRows(rep.projects);
    if (week) html += '<div class="section-title">Últimos 7 dias</div>' + weekChart(week);
    if (rep.topEdited.length) html += '<div class="section-title">Arquivos mais editados</div>' + fileList(rep.topEdited, 'editou');
    if (rep.topRead.length) html += '<div class="section-title">Arquivos mais lidos</div>' + fileList(rep.topRead, 'leu');
    if (rep.slowest.length) {
      html += '<div class="section-title">Ações mais lentas</div><ul class="files">' + rep.slowest.map((s) =>
        `<li><span class="op op-slow">${esc(fmtMs(s.ms))}</span><span class="mono">${esc(BUILDINGS[s.building] ? BUILDINGS[s.building].icon : '')} ${esc(C.actionText({ tool_name: s.tool, summary: s.summary }))}</span><time>${esc(fmtHour(s.ts))}</time></li>`).join('') + '</ul>';
    }
    if (rep.failures.length) {
      html += '<div class="section-title">Falhas</div><ul class="files fails">' + rep.failures.map((f) =>
        `<li><span class="op op-fail">✗ ${esc(fmtHour(f.ts))}</span><span><span class="mono">${esc(C.actionText({ tool_name: f.tool, summary: f.summary }))}</span>${f.error ? `<div class="ferr">${esc(f.error)}</div>` : ''}${f.interrupted ? '<div class="ferr">interrompida</div>' : ''}</span><time>${esc(f.project)}</time></li>`).join('') + '</ul>';
    }
    if (rep.subagentTypes.length) {
      html += '<div class="section-title">Subagentes por tipo</div><div class="chips-row">' +
        rep.subagentTypes.map((s) => `<span class="chip">👶 ${esc(s.type)} · ${s.n}</span>`).join('') + '</div>';
    }
    html += '<div class="section-title">🏆 Conquistas</div>' + achievementGrid();
    container.innerHTML = html;
    bindCommon(container);
  }

  function bindCommon(container) {
    container.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
      day = b.dataset.day === dayKey(C.now()) ? null : b.dataset.day;
      render(container);
    }));
    container.querySelectorAll('[data-project]').forEach((b) => b.addEventListener('click', () => {
      if (C.openProject) C.openProject(b.dataset.project);
    }));
    const all = container.querySelector('[data-act="all"]');
    if (all) all.addEventListener('click', () => { project = null; render(container); });
    container.querySelectorAll('[data-act="md"]').forEach((b) => b.addEventListener('click', () => { showSummary = !showSummary; render(container); }));
    const copy = container.querySelector('[data-act="md-copy"]');
    if (copy) copy.addEventListener('click', () => {
      try { navigator.clipboard.writeText(lastMd); copy.textContent = '✓ copiado'; } catch (_) {}
    });
    const dl = container.querySelector('[data-act="md-dl"]');
    if (dl) dl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([lastMd], { type: 'text/markdown;charset=utf-8' }));
      a.download = `resumo-${lastMdDay}${project ? '-' + C.defs.folderName(project) : ''}.md`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    bindTips(container);
  }

  // Relatório de um projeto (usado pela vista Projeto no painel).
  function projectSummary(cwd, cb) {
    const q = `&project=${encodeURIComponent(cwd)}`;
    const today = load(`/api/report?day=${dayKey(C.now())}${q}`, cb);
    const week = load(`/api/week?day=${dayKey(C.now())}${q}`, cb);
    return { today, week };
  }

  C.report = {
    render, projectSummary, weekChart, bindTips, SERIES, buildMarkdown,
    setProject: (cwd) => { project = cwd || null; day = null; },
  };
})();

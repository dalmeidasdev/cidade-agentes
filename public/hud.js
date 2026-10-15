// HUD da Cidade dos Agentes: barra superior, painel com abas, perfis dos
// agentes, vista dos prédios, toasts, som e notificações do sistema.

(() => {
  'use strict';

  const C = window.Cidade;
  const { BUILDINGS, LAYOUT, titleFor } = C.defs;
  const $ = (sel) => document.querySelector(sel);

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function fmtTime(ts) {
    return ts ? new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  }
  function fmtDur(ms) {
    if (!(ms > 0)) return 'agora';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'agora';
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ${m % 60} min`;
    return `${Math.floor(h / 24)} d`;
  }
  // Duração curta e legível: "0,4 s", "12 s", "3 min 5 s", "1 h 2 min".
  function fmtMs(ms) {
    if (!(ms > 0)) return '0 s';
    if (ms < 1000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const shortTool = (t) => (t && t.startsWith('mcp__') ? t.split('__').slice(1).join('/') : t);
  C.fmtMs = fmtMs;

  function ago(ts) { return ts ? (C.now() - ts < 60000 ? 'agora' : `há ${fmtDur(C.now() - ts)}`) : ''; }

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };

  function personColor(key) {
    const p = C.people.get(key);
    if (p) return p.color;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 30% 60%)`;
  }

  // ---------------------------------------------------------------------------
  // Log de eventos (memória do navegador)
  // ---------------------------------------------------------------------------
  const MAX_LOG = 300;
  const log = []; // { ts, key, text, cls }

  function describe(ev) {
    switch (ev.hook_event_name) {
      case 'SessionStart': return ['chegou à cidade 🏛️'];
      case 'UserPromptSubmit': return [`recebeu um pedido${ev.summary ? ': “' + ev.summary + '”' : ''}`];
      case 'PreToolUse': return [C.actionText(ev)];
      case 'PostToolUseFailure': return [`falhou: ${C.actionText(ev)}`, 'fail'];
      case 'SubagentStart': return [`chamou subagente ${ev.agent_type || ''}`.trim()];
      case 'SubagentStop': return ['terminou e foi pra casa 🏠'];
      case 'Notification':
        return C.defs.isAlertNotification(ev.notification_type)
          ? [`❗ ${C.translateMessage(ev.message) || 'precisa de atenção'}`, 'warn']
          : [`ℹ️ ${C.translateMessage(ev.message) || 'aviso'}`];
      case 'Stop': return ['terminou, foi pro café ☕'];
      case 'SessionEnd': return ['se despediu 👋'];
      default: return null; // PostToolUse fica fora do log para não poluir
    }
  }

  // ---------------------------------------------------------------------------
  // Painel: abas e vistas de detalhe
  // ---------------------------------------------------------------------------
  let tab = store.get('cidade.tab', 'agents');
  let detail = null; // { type: 'profile', key } | { type: 'building', id }
  let eventsFilter = false;
  let editingName = false;

  const views = {
    agents: $('#view-agents'), events: $('#view-events'), today: $('#view-today'),
    profile: $('#view-profile'), building: $('#view-building'), project: $('#view-project'),
  };

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      store.set('cidade.tab', tab);
      if (C.selected) C.select(null);
      detail = null;
      showView();
    });
  });

  function showView() {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', !detail && b.dataset.tab === tab));
    for (const [name, el] of Object.entries(views)) {
      const visible = detail ? name === detail.type : name === tab;
      el.hidden = !visible;
    }
    render(true);
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(false); });
  }

  function render(force) {
    renderTopbar();
    if (editingName && !force) return; // não atrapalha quem está digitando
    if (detail && detail.type === 'profile') renderProfile(detail.key);
    else if (detail && detail.type === 'building') renderBuilding(detail.id);
    else if (detail && detail.type === 'project') renderProject(detail.cwd);
    else if (tab === 'agents') renderAgents();
    else if (tab === 'events') renderEvents();
    else renderToday(force);
  }

  // --- cartão de agente (usado na lista, no prédio e na família) ---
  function agentCard(key, opts) {
    opts = opts || {};
    const pr = C.profiles.get(key);
    const p = C.people.get(key);
    const st = C.stateOf(key);
    const title = titleFor(pr && pr.counts);
    const ex = p && p.alert ? C.explainAlert(key) : null;
    const action = ex ? ex.what : p && p.working ? p.working.text : pr && pr.current ? C.actionText({ tool_name: pr.current.tool, summary: pr.current.summary }) : '';
    const since = pr ? pr.firstSeen : null;
    return `
      <div class="card ${opts.sub ? 'sub' : ''} ${C.selected === key ? 'sel' : ''} st-${st.cls}" data-key="${esc(key)}" role="button" tabindex="0">
        <canvas class="avatar" data-avatar="${esc(key)}" width="34" height="42"></canvas>
        <div class="info">
          <div class="name"><span style="color:${personColor(key)}">${esc(C.displayName(key))}</span>
            ${pr && pr.parent ? '' : `<span class="title-chip">${title.icon} ${esc(title.name)}</span>`}</div>
          <div class="state">${st.icon} ${esc(st.text)}</div>
          ${action ? `<div class="action">${esc(action)}</div>` : ''}
        </div>
        <div class="meta">${since ? esc(fmtDur(C.now() - since)) : ''}</div>
      </div>`;
  }

  function bindCards(root) {
    root.querySelectorAll('.card[data-key]').forEach((el) => {
      const go = () => C.select(el.dataset.key);
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
    root.querySelectorAll('canvas[data-avatar]').forEach((cv) => C.drawAvatar(cv, cv.dataset.avatar));
    bindOpen(root);
  }

  // --- abrir pasta no Explorer / VS Code (o servidor só aceita pastas conhecidas) ---
  let canOpenCode = false;
  fetch('/api/open/capabilities').then((r) => r.json()).then((c) => { canOpenCode = !!c.code; scheduleRender(); }).catch(() => {});

  function openButtons(cwd) {
    if (!cwd) return '';
    return `<span class="open-btns"><button class="mini" data-open="explorer" data-cwd="${esc(cwd)}" title="Abrir no Explorador de Arquivos">📂 Abrir pasta</button>` +
      (canOpenCode ? `<button class="mini" data-open="code" data-cwd="${esc(cwd)}" title="Abrir a pasta no VS Code">🧑‍💻 VS Code</button>` : '') + '</span>';
  }

  function bindOpen(root) {
    root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await fetch('/api/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Cidade': '1' },
          body: JSON.stringify({ cwd: b.dataset.cwd, app: b.dataset.open }),
        });
        if (!r.ok) throw new Error(await r.text());
        b.textContent = b.dataset.open === 'code' ? '✓ abrindo no VS Code…' : '✓ abrindo…';
      } catch (err) {
        toast('open-err', `Não consegui abrir: ${esc(err.message || 'erro')}`, { ttl: 5000 });
      }
    }));
  }

  function renderAgents() {
    const all = [...C.profiles.values()];
    const active = all.filter((p) => !p.endedAt && !p.parent).sort((a, b) => b.lastSeen - a.lastSeen);
    const gone = all.filter((p) => p.endedAt && !p.parent).sort((a, b) => b.endedAt - a.endedAt);
    let html = '';
    if (!active.length) html += '<p class="empty">Nenhum agente na cidade agora. Abra uma sessão do Claude Code (ou rode <code>node test-events.js</code>).</p>';
    for (const pr of active) {
      html += agentCard(pr.key);
      for (const ck of pr.children || []) {
        const c = C.profiles.get(ck);
        if (c && !c.endedAt) html += agentCard(ck, { sub: true });
      }
    }
    if (gone.length) {
      html += `<div class="section-title">Saíram nas últimas 24 h (${gone.length})</div>`;
      for (const pr of gone.slice(0, 20)) html += agentCard(pr.key);
    }
    views.agents.innerHTML = html;
    bindCards(views.agents);
  }

  function logItem(e) {
    return `<li class="${e.cls || ''}" data-key="${esc(e.key)}">
      <time>${esc(fmtTime(e.ts))}</time>
      <span class="who" style="color:${personColor(e.key)}">${e.key.includes('/') ? '↳ ' : ''}${esc(C.displayName(e.key))}</span>
      <span class="what">${esc(e.text)}</span></li>`;
  }

  // --- busca no histórico (últimos 30 dias, no servidor) ---
  // O campo de busca é criado uma vez só: o log embaixo é redesenhado a cada evento
  // e não pode roubar o foco de quem está digitando.
  let evShell = null;
  let searchQ = '';
  let searchRes = null;
  let searchSeq = 0;
  let searchTimer = null;

  function ensureEventsShell() {
    if (evShell) return evShell;
    const wrap = document.createElement('div');
    wrap.className = 'search';
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = '🔎 Buscar nos últimos 30 dias (arquivo, comando, projeto, erro…)';
    input.autocomplete = 'off';
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(input.value), 300);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); input.value = ''; runSearch(''); } });
    wrap.appendChild(input);
    const body = document.createElement('div');
    views.events.innerHTML = '';
    views.events.appendChild(wrap);
    views.events.appendChild(body);
    evShell = { input, body };
    return evShell;
  }

  async function runSearch(q) {
    searchQ = q.trim();
    const seq = ++searchSeq;
    if (searchQ.length < 2) { searchRes = null; renderEvents(); return; }
    searchRes = { loading: true, results: [] };
    renderEvents();
    try {
      const r = await fetch(`/api/search?q=${encodeURIComponent(searchQ)}&days=30`);
      const data = await r.json();
      if (seq === searchSeq) { searchRes = data; renderEvents(); }
    } catch (_) {
      if (seq === searchSeq) { searchRes = { error: true, results: [] }; renderEvents(); }
    }
  }

  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function renderSearchResults() {
    const r = searchRes;
    if (r.loading) return '<p class="empty">Buscando…</p>';
    if (r.error) return '<p class="empty">Não consegui buscar (o servidor está no ar?).</p>';
    if (!r.results.length) return `<p class="empty">Nada encontrado para “${esc(searchQ)}” nos últimos 30 dias.</p>`;
    let html = `<p class="muted small-line">${r.results.length}${r.truncated ? '+' : ''} resultado(s) · clique para rever o momento no replay</p>`;
    let day = null;
    for (const it of r.results) {
      if (it.day !== day) {
        day = it.day;
        html += `<div class="section-title">${esc(new Date(`${day}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short' }))}</div><ul class="log">`;
      }
      html += `<li class="${it.event === 'PostToolUseFailure' ? 'fail' : ''}" data-day="${esc(it.day)}" data-ts="${it.ts}" title="Rever no replay">
        <time>${esc(fmtTime(it.ts))}</time><span class="who">${esc(it.agent_type ? `↳ ${it.agent_type}` : it.project)}</span>
        <span class="what">${highlight(C.cleanText(it.text), searchQ)}${it.agent_type ? ` <span class="muted">· ${esc(it.project)}</span>` : ''}</span></li>`;
    }
    return html + '</ul>';
  }

  function renderEvents() {
    const shell = ensureEventsShell();
    if (searchRes) {
      shell.body.innerHTML = renderSearchResults();
      shell.body.querySelectorAll('li[data-ts]').forEach((li) => li.addEventListener('click', () => {
        if (C.replay) C.replay.startAt(li.dataset.day, Number(li.dataset.ts));
      }));
      return;
    }
    const sel = C.selected;
    const items = eventsFilter && sel ? log.filter((e) => e.key === sel || e.key.startsWith(sel + '/')) : log;
    let html = '';
    if (sel) {
      html += `<div class="filter"><label><input type="checkbox" id="flt" ${eventsFilter ? 'checked' : ''}> Só <b>${esc(C.displayName(sel))}</b> e subagentes</label></div>`;
    }
    html += items.length ? `<ul class="log">${items.slice(0, 150).map(logItem).join('')}</ul>` : '<p class="empty">Aguardando eventos dos agentes…</p>';
    shell.body.innerHTML = html;
    const flt = shell.body.querySelector('#flt');
    if (flt) flt.addEventListener('change', () => { eventsFilter = flt.checked; renderEvents(); });
    shell.body.querySelectorAll('li[data-key]').forEach((li) => li.addEventListener('click', () => C.select(li.dataset.key)));
  }

  // Aba Relatório: desenhada por public/report.js. Como os números vêm do servidor,
  // não precisa redesenhar a cada evento; só ao abrir a aba ou a cada 10 s.
  let lastReportAt = 0;
  function renderToday(force) {
    if (!force && Date.now() - lastReportAt < 10000) return;
    lastReportAt = Date.now();
    C.report.render(views.today);
  }

  // --- perfil ---
  function renderProfile(key) {
    const pr = C.profiles.get(key);
    const p = C.people.get(key);
    if (!pr && !p) { closeDetail(); return; }
    const st = C.stateOf(key);
    const counts = (pr && pr.counts) || {};
    const title = titleFor(counts);
    const name = C.displayName(key);
    const folder = pr ? pr.label : p.label;
    const isSub = !!(pr ? pr.parent : p.parent);
    const runFor = p && p.working && p.working.since ? C.now() - p.working.since : 0;
    const action = p && p.working && !p.alert ? `⚙️ ${p.working.text}${runFor >= 1000 ? `  ·  rodando há ${C.fmtClock(runFor)}` : ''}` : '';
    const where = p && p.building && !p.leaving ? p.building : null;

    const COUNT_LABELS = [['reads', '📚', 'leituras'], ['edits', '🔨', 'edições'], ['commands', '🧪', 'comandos'], ['web', '📮', 'web/MCP'],
      ['delegations', '🏛️', 'delegações'], ['prompts', '📜', 'pedidos'], ['failures', '✗', 'falhas'], ['subagents', '👶', 'subagentes']];

    const tools = Object.entries((pr && pr.tools) || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const tmax = Math.max(1, ...tools.map((t) => t[1]));
    const timeline = log.filter((e) => e.key === key).slice(0, 15);

    let html = `
      <div class="detail-head">
        <button class="back" data-act="back">← ${C.scene.type === 'interior' ? 'Prédio' : 'Voltar'}</button>
        <span class="state-chip st-${st.cls}">${st.icon} ${esc(st.text)}</span>
      </div>
      <div class="profile-top">
        <canvas class="avatar big" data-avatar="${esc(key)}" width="72" height="88"></canvas>
        <div>
          <div class="pname" data-act="rename" title="Clique para dar um apelido">${esc(name)} <span class="pencil">✏️</span></div>
          ${name !== folder ? `<div class="muted">${esc(folder)}</div>` : ''}
          <div class="title-chip big">${isSub ? '👶 Subagente' : `${title.icon} ${esc(title.name)}`}</div>
        </div>
      </div>
      ${alertCard(key)}
      ${action ? `<div class="now">${esc(action)}</div>` : ''}
      <div class="actions">
        <button data-act="goto">📍 Ir até</button>
        ${where ? `<button data-act="enter">${BUILDINGS[where].icon} Entrar ${BUILDINGS[where].park ? 'na' : 'no prédio'}</button>` : ''}
        <button data-act="forget" class="danger" title="Remove este perfil da cidade">🗑 Esquecer</button>
      </div>
      <dl class="facts">
        ${pr && pr.cwd ? `<dt>Pasta</dt><dd class="mono">${esc(pr.cwd)}<div>${openButtons(pr.cwd)}</div></dd>` : ''}
        ${pr && pr.terminal ? `<dt>Roda no</dt><dd>${esc(pr.terminal)}</dd>` : ''}
        <dt>Tipo</dt><dd>${isSub ? `subagente <b>${esc(pr && pr.agent_type || p.label)}</b>` : 'sessão principal'}${!isSub && pr && pr.agent_type ? ` (${esc(pr.agent_type)})` : ''}</dd>
        ${pr ? `<dt>Sessão</dt><dd class="mono">${esc(pr.session_id.slice(0, 8))}… <button class="mini" data-act="copy">copiar</button></dd>` : ''}
        ${pr ? `<dt>Chegou</dt><dd>${esc(fmtTime(pr.firstSeen))} · ${esc(fmtDur((pr.endedAt || C.now()) - pr.firstSeen))} na cidade</dd>` : ''}
        ${pr ? `<dt>Último sinal</dt><dd>${esc(ago(pr.lastSeen))}</dd>` : ''}
        ${pr && pr.waits ? `<dt>Esperou você</dt><dd>${esc(fmtMs(pr.waitedMs))} no total, em ${pr.waits} ${pr.waits === 1 ? 'pedido' : 'pedidos'}</dd>` : ''}
      </dl>`;

    if (pr) {
      html += '<div class="section-title">Contadores</div><div class="counts">' +
        COUNT_LABELS.map(([k, i, l]) => `<div class="count ${counts[k] ? '' : 'zero'}"><b>${counts[k] || 0}</b><span>${i} ${l}</span></div>`).join('') + '</div>';
    }
    if (tools.length) {
      html += '<div class="section-title">Ferramentas mais usadas</div><div class="bars">' + tools.map(([t, n]) => {
        const b = BUILDINGS[C.defs.buildingFor(t)];
        return `<div class="bar-row"><span class="bar-label">${b.icon} ${esc(t.startsWith('mcp__') ? t.split('__').slice(1).join('/') : t)}</span>
          <span class="bar"><span style="width:${(n / tmax) * 100}%"></span></span><span class="bar-n">${n}</span></div>`;
      }).join('') + '</div>';
    }
    const toolTime = Object.entries((pr && pr.toolTime) || {}).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (toolTime.length) {
      const ttmax = Math.max(1, ...toolTime.map((t) => t[1]));
      html += '<div class="section-title">Tempo por ferramenta</div><div class="bars">' + toolTime.map(([t, ms]) => {
        const b = BUILDINGS[C.defs.buildingFor(t)];
        return `<div class="bar-row"><span class="bar-label">${b.icon} ${esc(shortTool(t))}</span>
          <span class="bar time"><span style="width:${(ms / ttmax) * 100}%"></span></span><span class="bar-n wide">${esc(fmtMs(ms))}</span></div>`;
      }).join('') + '</div>';
    }
    if (pr && pr.slowest && pr.slowest.length) {
      html += '<div class="section-title">Ações mais lentas</div><ul class="files">' + pr.slowest.map((s) =>
        `<li><span class="op op-slow">${esc(fmtMs(s.ms))}</span><span class="mono">${esc(C.cleanText(s.text))}</span><time>${esc(ago(s.ts))}</time></li>`).join('') + '</ul>';
    }
    const medals = (C.achievements || []).filter((a) => a.unlockedAt && a.by === key);
    if (medals.length) {
      html += '<div class="section-title">Conquistas deste agente</div><div class="medals small">' + medals.map((a) =>
        `<div class="medal got" title="${esc(a.desc)}"><span class="mi">${a.icon}</span><span class="mn">${esc(a.name)}</span></div>`).join('') + '</div>';
    }
    if (pr && pr.lastPrompt) {
      html += `<div class="section-title">Último pedido</div><blockquote>“${esc(pr.lastPrompt.text)}” <span class="muted">${esc(ago(pr.lastPrompt.ts))}</span></blockquote>`;
    }
    if (pr && pr.files && pr.files.length) {
      html += '<div class="section-title">Arquivos recentes</div><ul class="files">' + pr.files.slice(0, 10).map((f) =>
        `<li><span class="op op-${esc(f.op)}">${esc(f.op)}</span><span class="mono">${esc(f.path)}</span><time>${esc(ago(f.ts))}</time></li>`).join('') + '</ul>';
    }
    const family = [];
    if (pr && pr.parent) family.push(['Chamado por', pr.parent]);
    for (const ck of (pr && pr.children) || []) family.push(['Subagente', ck]);
    if (family.length) {
      html += '<div class="section-title">Família</div>' + family.map(([rel, k]) =>
        `<div class="rel">${esc(rel)}</div>${agentCard(k, { sub: rel === 'Subagente' })}`).join('');
    }
    if (timeline.length) {
      html += `<div class="section-title">Linha do tempo</div><ul class="log">${timeline.map(logItem).join('')}</ul>`;
    }

    views.profile.innerHTML = html;
    bindCards(views.profile);
    views.profile.querySelector('[data-act="back"]').addEventListener('click', () => C.select(null));
    views.profile.querySelector('[data-act="goto"]').addEventListener('click', () => C.goToAgent(key));
    const enterBtn = views.profile.querySelector('[data-act="enter"]');
    if (enterBtn) enterBtn.addEventListener('click', () => C.enter(where));
    views.profile.querySelector('[data-act="forget"]').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.confirm) { C.forget(key); C.select(null); return; }
      btn.dataset.confirm = '1';
      btn.textContent = 'Clique de novo para confirmar';
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.confirm; btn.textContent = '🗑 Esquecer'; } }, 3000);
    });
    const copy = views.profile.querySelector('[data-act="copy"]');
    if (copy) copy.addEventListener('click', () => {
      try { navigator.clipboard.writeText(pr.session_id); copy.textContent = 'copiado!'; } catch (_) {}
    });
    const copyCwd = views.profile.querySelector('[data-act="copy-cwd"]');
    if (copyCwd) copyCwd.addEventListener('click', () => {
      const ex = C.explainAlert(key);
      try { navigator.clipboard.writeText(ex && ex.cwd ? ex.cwd : ''); copyCwd.textContent = 'copiado!'; } catch (_) {}
    });
    const nameEl = views.profile.querySelector('[data-act="rename"]');
    nameEl.addEventListener('click', () => startRename(key, nameEl));
  }

  // Cartão "o quê / onde / como responder" de um alerta.
  function alertCard(key) {
    const ex = C.explainAlert(key);
    if (!ex) return '';
    const verb = ex.verb.charAt(0).toUpperCase() + ex.verb.slice(1);
    return `
      <div class="alert-card">
        <div class="ac-head">❗ ${esc(verb)}${ex.since ? ` <span class="ac-ago">· ${esc(ago(ex.since))}</span>` : ''}</div>
        <div class="ac-row"><span class="ac-k">O quê</span><div>${esc(ex.what)}</div></div>
        <div class="ac-row"><span class="ac-k">Onde</span><div>${ex.where.map(esc).join('<br>')}
          ${ex.cwd ? `<div class="ac-cwd">pasta <code>${esc(ex.cwd)}</code> <button class="mini" data-act="copy-cwd">copiar</button> ${openButtons(ex.cwd)}</div>` : ''}</div></div>
        <div class="ac-row"><span class="ac-k">Como</span><ol>${ex.how.map((h) => `<li>${esc(h)}</li>`).join('')}</ol></div>
        ${ex.raw ? `<div class="ac-raw">Mensagem original: “${esc(ex.raw)}”</div>` : ''}
      </div>`;
  }

  function startRename(key, el) {
    editingName = true;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = C.getNickname(key) || '';
    input.placeholder = (C.profiles.get(key) || {}).label || 'apelido';
    input.maxLength = 32;
    el.replaceWith(input);
    input.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      editingName = false;
      if (save) C.setNickname(key, input.value);
      render(true);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  // --- prédio ---
  function renderBuilding(id) {
    const b = BUILDINGS[id];
    const info = C.buildingInfo[id] || { visitsToday: 0, history: [] };
    const inside = C.interiors ? C.interiors.insiders(id) : [];
    const lvl = C.defs.levelOf(id, C.lifetime);
    const growth = lvl.next == null
      ? `Nível máximo — virou <b>${esc(lvl.name)}</b>`
      : `Nível ${lvl.level} · faltam <b>${lvl.missing}</b> ${esc(lvl.unit)} para o nível ${lvl.level + 1}`;
    let html = `
      <div class="detail-head"><button class="back" data-act="back">← Cidade</button></div>
      <div class="building-top"><span class="bicon">${b.icon}</span><div><div class="pname">${esc(lvl.name)}${lvl.level ? ` <span class="stars">${'★'.repeat(lvl.level)}</span>` : ''}</div><div class="muted">${esc(b.about || '')}</div></div></div>
      <div class="growth"><div>🏗️ ${growth}</div><span class="mprog"><span style="width:${Math.round(lvl.progress * 100)}%"></span></span>
        <div class="muted small-line">${lvl.value} ${esc(lvl.unit)} no total</div></div>
      <div class="stats two"><div class="stat"><b>${inside.length}</b><span>👥 lá dentro</span></div><div class="stat"><b>${info.visitsToday || 0}</b><span>🚪 visitas hoje</span></div></div>`;
    if (inside.length) html += '<div class="section-title">Quem está aqui</div>' + inside.map((p) => agentCard(p.key, { sub: p.small })).join('');
    html += '<div class="section-title">Histórico</div>';
    html += info.history && info.history.length
      ? `<ul class="log">${info.history.map((h) => logItem({ ts: h.ts, key: h.key, text: C.cleanText(h.text) })).join('')}</ul>`
      : '<p class="empty">Nada aconteceu aqui ainda.</p>';
    views.building.innerHTML = html;
    bindCards(views.building);
    views.building.querySelector('[data-act="back"]').addEventListener('click', () => C.exitInterior());
    views.building.querySelectorAll('li[data-key]').forEach((li) => li.addEventListener('click', () => C.select(li.dataset.key)));
  }

  // --- projeto (casa do bairro) ---
  function renderProject(cwd) {
    const k = cwd.toLowerCase();
    const proj = (C.projects || {})[k] || { cwd, label: C.defs.folderName(cwd) };
    const roots = [...C.profiles.values()].filter((p) => !p.parent && (p.cwd || '').toLowerCase() === k);
    const active = roots.filter((p) => !p.endedAt).sort((a, b) => b.lastSeen - a.lastSeen);
    const ended = roots.filter((p) => p.endedAt).sort((a, b) => b.endedAt - a.endedAt);
    const sum = C.report.projectSummary(cwd, scheduleRender);
    const hue = C.projectHue(cwd);
    let html = `
      <div class="detail-head"><button class="back" data-act="back">← Voltar</button></div>
      <div class="building-top"><span class="bicon" style="filter: hue-rotate(${hue}deg)">🏠</span><div>
        <div class="pname" style="color:hsl(${hue} 70% 75%)">${esc(proj.label)}</div>
        <div class="mono muted">${esc(cwd)} <button class="mini" data-act="copy-proj">copiar</button></div>
        <div>${openButtons(cwd)}</div></div></div>
      <dl class="facts">
        ${proj.firstSeen ? `<dt>Primeira visita</dt><dd>${esc(new Date(proj.firstSeen).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}</dd>` : ''}
        ${proj.sessions ? `<dt>Sessões</dt><dd>${proj.sessions} no total</dd>` : ''}
        ${proj.lastSeen ? `<dt>Último sinal</dt><dd>${esc(ago(proj.lastSeen))}</dd>` : ''}
      </dl>`;
    if (sum.today) {
      const t = sum.today.totals;
      html += `<div class="section-title">Hoje</div><div class="stats">
        <div class="stat"><b>${t.actions}</b><span>⚙️ ações</span></div>
        <div class="stat"><b>${esc(fmtMs(t.activeMs))}</b><span>⏱ tempo ativo</span></div>
        <div class="stat"><b>${t.edits}</b><span>🔨 edições</span></div>
        <div class="stat ${t.failures ? 'bad' : ''}"><b>${t.failures}</b><span>✗ falhas</span></div></div>`;
    } else html += '<p class="empty">Carregando números…</p>';
    if (sum.week) html += '<div class="section-title">Últimos 7 dias</div>' + C.report.weekChart(sum.week);
    html += '<div class="actions"><button data-act="full-report">📊 Relatório completo deste projeto</button></div>';
    html += `<div class="section-title">Sessões ativas (${active.length})</div>`;
    html += active.length ? active.map((p) => agentCard(p.key)).join('') : '<p class="empty">Ninguém trabalhando neste projeto agora.</p>';
    if (ended.length) html += `<div class="section-title">Saíram nas últimas 24 h</div>` + ended.slice(0, 8).map((p) => agentCard(p.key)).join('');
    views.project.innerHTML = html;
    bindCards(views.project);
    C.report.bindTips(views.project);
    views.project.querySelector('[data-act="back"]').addEventListener('click', () => closeDetail());
    const cp = views.project.querySelector('[data-act="copy-proj"]');
    cp.addEventListener('click', () => { try { navigator.clipboard.writeText(cwd); cp.textContent = 'copiado!'; } catch (_) {} });
    views.project.querySelector('[data-act="full-report"]').addEventListener('click', () => {
      C.report.setProject(cwd);
      tab = 'today';
      detail = null;
      showView();
    });
  }

  C.openProject = (cwd) => {
    if (C.selected) C.selected = null;
    detail = { type: 'project', cwd };
    showView();
  };

  function closeDetail() {
    detail = C.scene.type === 'interior' ? { type: 'building', id: C.scene.id } : null;
    showView();
  }

  // ---------------------------------------------------------------------------
  // Barra superior
  // ---------------------------------------------------------------------------
  const chipsEl = $('#chips');
  const backBtn = $('#btn-back');
  backBtn.addEventListener('click', () => C.exitInterior());

  function renderTopbar() {
    let total = 0, working = 0, waiting = 0, oldestAlert = Infinity;
    for (const p of C.people.values()) {
      if (p.leaving) continue;
      total++;
      if (p.working) working++;
      if (p.alert) { waiting++; oldestAlert = Math.min(oldestAlert, p.alert.ts || C.now()); }
    }
    const waitFor = waiting ? C.now() - oldestAlert : 0;
    chipsEl.innerHTML =
      `<span class="chip">👥 ${total} ${total === 1 ? 'agente' : 'agentes'}</span>` +
      `<span class="chip ${working ? 'on' : ''}">⚙️ ${working} trabalhando</span>` +
      (waiting ? `<button class="chip alert" id="chip-wait">❗ ${waiting} esperando você${waitFor >= 5000 ? ` · ⏳ ${esc(C.fmtClock(waitFor))}` : ''}</button>` : '');
    const w = $('#chip-wait');
    if (w) w.addEventListener('click', () => {
      const p = [...C.people.values()].find((x) => x.alert);
      if (p) C.goToAgent(p.key);
    });
    $('#tab-count').textContent = total ? String(total) : '';
    document.title = waiting ? `(${waiting}❗) Cidade dos Agentes` : 'Cidade dos Agentes';
  }

  function tickClock() {
    const light = C.lightAt();
    $('#clock').textContent = `${light.icon} ${new Date(C.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    $('#clock').title = `Período: ${light.name}`;
  }

  // ---------------------------------------------------------------------------
  // Alertas: toast, som e notificação do sistema
  // ---------------------------------------------------------------------------
  const toastsEl = $('#toasts');
  const toasts = new Map(); // key -> elemento

  function toast(key, html, opts) {
    opts = opts || {};
    dismissToast(key);
    const el = document.createElement('div');
    el.className = `toast ${opts.cls || ''}`;
    el.innerHTML = `<div class="toast-body">${html}</div><button class="toast-x" title="Fechar">×</button>`;
    el.querySelector('.toast-x').addEventListener('click', (e) => { e.stopPropagation(); dismissToast(key); });
    if (opts.onClick) el.addEventListener('click', opts.onClick);
    toastsEl.appendChild(el);
    toasts.set(key, el);
    setTimeout(() => { if (toasts.get(key) === el) dismissToast(key); }, opts.ttl || 20000);
  }
  function dismissToast(key) {
    const el = toasts.get(key);
    if (!el) return;
    toasts.delete(key);
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  }

  // Som (Web Audio, sem arquivo). O navegador só libera áudio depois de um clique.
  let soundOn = store.get('cidade.sound', '1') === '1';
  let audio = null;
  const soundBtn = $('#btn-sound');
  function renderSoundBtn() {
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.title = soundOn ? 'Som de alerta ligado (clique para silenciar)' : 'Som de alerta desligado';
    soundBtn.classList.toggle('off', !soundOn);
  }
  function unlockAudio() {
    if (audio) return;
    try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {}
  }
  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });
  function beep() {
    if (!soundOn || !audio) return;
    try {
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime;
      [[880, 0], [660, 0.14]].forEach(([f, dt]) => {
        const o = audio.createOscillator();
        const gn = audio.createGain();
        o.type = 'square';
        o.frequency.value = f;
        gn.gain.setValueAtTime(0.0001, t0 + dt);
        gn.gain.exponentialRampToValueAtTime(0.07, t0 + dt + 0.01);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.12);
        o.connect(gn).connect(audio.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.13);
      });
    } catch (_) {}
  }
  function chime() {
    if (!soundOn || !audio) return;
    try {
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime;
      [523, 659, 784, 1047].forEach((f, i) => {
        const o = audio.createOscillator();
        const gn = audio.createGain();
        o.type = 'triangle';
        o.frequency.value = f;
        const t = t0 + i * 0.09;
        gn.gain.setValueAtTime(0.0001, t);
        gn.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
        o.connect(gn).connect(audio.destination);
        o.start(t);
        o.stop(t + 0.26);
      });
    } catch (_) {}
  }

  soundBtn.addEventListener('click', () => {
    unlockAudio();
    soundOn = !soundOn;
    store.set('cidade.sound', soundOn ? '1' : '0');
    renderSoundBtn();
    if (soundOn) beep();
  });

  // Notificações do Windows (pela API de notificações do navegador).
  const notifBtn = $('#btn-notif');
  const notifSupported = 'Notification' in window;
  let notifOn = store.get('cidade.notif', '0') === '1';
  function renderNotifBtn() {
    const granted = notifSupported && Notification.permission === 'granted';
    const active = notifOn && granted;
    notifBtn.textContent = active ? '🔔' : '🔕';
    notifBtn.classList.toggle('off', !active);
    notifBtn.title = !notifSupported ? 'Este navegador não suporta notificações'
      : Notification.permission === 'denied' ? 'Notificações bloqueadas nas configurações do site'
      : active ? 'Notificações do Windows ligadas (só quando a aba está em segundo plano)' : 'Ligar notificações do Windows';
  }
  notifBtn.addEventListener('click', async () => {
    if (!notifSupported) return;
    if (Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch (_) {}
    }
    if (Notification.permission === 'denied') {
      toast('notif-info', 'As notificações estão bloqueadas para este site. Libere no cadeado da barra de endereço.', { ttl: 6000 });
      notifOn = false;
    } else if (Notification.permission === 'granted') {
      notifOn = !notifOn;
    }
    store.set('cidade.notif', notifOn ? '1' : '0');
    renderNotifBtn();
  });
  function systemNotify(key, title, body) {
    if (!notifSupported || !notifOn || Notification.permission !== 'granted' || !document.hidden) return;
    try {
      const n = new Notification(title, { body, tag: 'cidade-' + key, requireInteraction: true });
      n.onclick = () => { window.focus(); C.goToAgent(key); n.close(); };
    } catch (_) {}
  }

  function onAlert(ev, who) {
    if (!C.defs.isAlertNotification(ev.notification_type)) {
      // Aviso informativo (login concluído, agente terminou...): sem som, some rápido.
      toast('info-' + who.key, `ℹ️ <b style="color:${who.color}">${esc(C.displayName(who.key))}</b>: ${esc(C.translateMessage(ev.message) || 'aviso')}`, { ttl: 6000 });
      return;
    }
    const ex = C.explainAlert(who.key);
    if (!ex) return;
    const folder = ex.cwd ? C.defs.folderName(ex.cwd) : '';
    toast(who.key, `
      <div>❗ <b style="color:${who.color}">${esc(ex.name)}</b> ${esc(ex.verb)}</div>
      <div class="toast-what">${esc(ex.what)}</div>
      <div class="toast-where">📍 ${esc(ex.where[0])}${folder ? ` · pasta <b>${esc(folder)}</b>` : ''}</div>
      <div class="toast-how">Clique para ver como responder →</div>`, {
      cls: 'alert',
      ttl: 60000,
      onClick: () => { C.goToAgent(who.key); dismissToast(who.key); },
    });
    beep();
    systemNotify(who.key, `❗ ${ex.name} ${ex.verb}`, `${ex.what}\n📍 ${ex.where[0]}${ex.cwd ? ` — ${ex.cwd}` : ''}`);
  }

  // ---------------------------------------------------------------------------
  // Ligação com o núcleo
  // ---------------------------------------------------------------------------
  C.on('event', (ev, who) => {
    const d = describe(ev);
    if (d) {
      log.unshift({ ts: ev.ts || C.now(), key: who.key, text: d[0], cls: d[1] });
      if (log.length > MAX_LOG) log.length = MAX_LOG;
    }
    if (!ev.replay && !C.replaying && ev.hook_event_name === 'Notification') onAlert(ev, who);
    // O toast de alerta some assim que o agente sai do estado "esperando".
    for (const k of [...toasts.keys()]) {
      if (/^(info|medal|live|levelup|open)-/.test(k) || k === 'notif-info') continue;
      const p = C.people.get(k);
      if (!p || !p.alert) dismissToast(k);
    }
    scheduleRender();
  });
  C.on('reset', () => { log.length = 0; scheduleRender(); });

  // Durante o replay, um alerta ao vivo ainda precisa chegar até você.
  C.on('live-event', (ev) => {
    if (ev.hook_event_name !== 'Notification' || !C.defs.isAlertNotification(ev.notification_type)) return;
    const pr = C.profiles.get(ev.session_id);
    const name = pr ? C.displayName(pr.key) : C.defs.folderName(ev.cwd);
    toast('live-' + ev.session_id, `❗ <b>Ao vivo:</b> ${esc(name)} precisa de você<div class="toast-msg">${esc(C.translateMessage(ev.message))} — clique para voltar ao vivo</div>`, {
      cls: 'alert', ttl: 60000,
      onClick: () => { dismissToast('live-' + ev.session_id); if (C.replay) C.replay.stop(); },
    });
    beep();
    systemNotify(ev.session_id, `❗ ${name} precisa de você`, C.translateMessage(ev.message) || '');
  });

  // Conquista desbloqueada: toast dourado + um arpejo curto.
  C.on('achievement', (unlocked) => {
    for (const a of unlocked) {
      toast('medal-' + a.id, `🏆 <b>Conquista:</b> ${a.icon} ${esc(a.name)}${a.byLabel ? ` <span class="muted">· por ${esc(a.byLabel)}</span>` : ''}<div class="toast-msg">${esc(a.desc)}</div>`, {
        cls: 'medal-toast', ttl: 9000,
        onClick: () => { tab = 'today'; detail = null; if (C.selected) C.select(null); showView(); dismissToast('medal-' + a.id); },
      });
    }
    if (unlocked.length) { chime(); C.celebrate('big'); }
    renderToday(true);
  });

  // Prédio cresceu: toast + festa pequena.
  C.on('levelup', (ups) => {
    for (const u of ups) {
      const b = BUILDINGS[u.id];
      const msg = u.level >= 4 ? `virou <b>${esc(u.name)}</b>! ★★★★` : `agora é nível ${u.level} ${'★'.repeat(u.level)}`;
      toast('levelup-' + u.id, `🏗️ <b>${b.icon} ${esc(b.name)}</b> cresceu: ${msg}`, {
        cls: 'medal-toast', ttl: 8000,
        onClick: () => { dismissToast('levelup-' + u.id); C.enter(u.id); },
      });
    }
    chime();
    C.celebrate('small');
    scheduleRender();
  });
  for (const name of ['snapshot', 'profile', 'building', 'stats', 'forget', 'gone', 'lifetime']) C.on(name, scheduleRender);

  C.on('select', (key) => {
    if (key) detail = { type: 'profile', key };
    else closeDetail();
    showView();
  });
  C.on('scene', (scene) => {
    backBtn.hidden = scene.type !== 'interior';
    document.body.classList.toggle('in-interior', scene.type === 'interior');
    if (scene.type === 'interior') {
      if (!detail || detail.type !== 'profile') detail = { type: 'building', id: scene.id };
    } else if (detail && detail.type === 'building') {
      detail = null;
    }
    showView();
  });

  const connEl = $('#conn');
  C.on('conn', (on) => {
    connEl.classList.toggle('on', on);
    $('#conn-text').textContent = on ? 'ao vivo' : 'reconectando…';
  });

  // tempos relativos e avatares animados
  setInterval(() => { tickClock(); scheduleRender(); }, 5000);
  // Relógios que andam (espera no topo, "rodando há" no perfil) atualizam a cada segundo.
  setInterval(() => {
    tickClock();
    renderTopbar();
    if (detail && detail.type === 'profile') {
      const p = C.people.get(detail.key);
      if (p && (p.working || p.alert)) scheduleRender();
    }
  }, 1000);

  renderSoundBtn();
  renderNotifBtn();
  tickClock();
  showView();
})();

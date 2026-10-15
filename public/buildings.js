// Definições dos prédios, compartilhadas entre o navegador e o servidor.
// No navegador vira window.Cidade.defs; no Node, require('./public/buildings.js').
//
// Para adicionar um prédio novo: acrescente uma entrada em BUILDINGS, dê a ele
// uma posição em LAYOUT e (opcional) uma sala em public/interiors.js.
// `tools` lista nomes exatos de ferramenta; `match` casa por padrão.
// `sprite` (opcional) é uma imagem em public/ que substitui o desenho padrão.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.Cidade = root.Cidade || {}).defs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BUILDINGS = {
    prefeitura: {
      name: 'Prefeitura', icon: '🏛️', wall: '#d9c7a0', roof: '#9b4a3c', tools: ['Agent', 'Task'],
      about: 'Onde as sessões chegam, recebem pedidos e delegam trabalho para subagentes.',
    },
    biblioteca: {
      name: 'Biblioteca', icon: '📚', wall: '#7fa7c9', roof: '#3d5a80', tools: ['Read', 'Grep', 'Glob'],
      about: 'Leitura e busca de arquivos: Read, Grep, Glob.',
    },
    oficina: {
      name: 'Oficina', icon: '🔨', wall: '#c98b5a', roof: '#6b3f26', chimney: '#b9b9b9',
      tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      about: 'Criação e edição de arquivos: Edit, Write, MultiEdit, NotebookEdit.',
    },
    laboratorio: {
      name: 'Laboratório', icon: '🧪', wall: '#9fd3a8', roof: '#3f7d5a', chimney: '#7dff9a', tools: ['Bash'],
      about: 'Comandos de terminal: Bash.',
    },
    correios: {
      name: 'Correios/Porto', icon: '📮', wall: '#e8d36a', roof: '#2e5fa3', antenna: true,
      tools: ['WebFetch', 'WebSearch'], match: (n) => n.startsWith('mcp__'),
      about: 'Comunicação com o mundo lá fora: WebFetch, WebSearch e ferramentas MCP.',
    },
    outros: {
      name: 'Outros', icon: '🏚️', wall: '#b3a8c9', roof: '#5b4d7a', tools: [],
      about: 'Qualquer outra ferramenta (TodoWrite, ToolSearch, Skill…).',
    },
    praca: {
      name: 'Praça/Café', icon: '☕', park: true, tools: [],
      about: 'Agentes ociosos descansam aqui depois de terminar (Stop).',
    },
  };

  // Cidade que cresce: cada prédio sobe de nível conforme um contador da vida
  // toda (store.lifetime). `stat` pode ser um nome ou uma lista de nomes somados.
  const GROWTH_LEVELS = [0, 50, 200, 500, 1500];
  const GROWTH = {
    prefeitura: { stat: ['sessions', 'subagents'], unit: 'sessões e subagentes', big: 'Palácio da Cidade' },
    biblioteca: { stat: 'reads', unit: 'leituras', big: 'Grande Biblioteca' },
    oficina: { stat: 'edits', unit: 'edições', big: 'Fábrica' },
    laboratorio: { stat: 'commands', unit: 'comandos', big: 'Centro de Pesquisa' },
    correios: { stat: 'web', unit: 'acessos web/MCP', big: 'Porto Internacional' },
    outros: { stat: 'other', unit: 'outras ações', big: 'Armazém Geral' },
    praca: { stat: 'daysActive', unit: 'dias com atividade', big: 'Parque Central', levels: [0, 3, 10, 30, 90] },
  };

  function growthValue(id, lifetime) {
    const g = GROWTH[id];
    if (!g || !lifetime) return 0;
    if (g.stat === 'daysActive') return (lifetime.days || []).length;
    const stats = Array.isArray(g.stat) ? g.stat : [g.stat];
    return stats.reduce((n, s) => n + (lifetime[s] || 0), 0);
  }

  // Nível 0–4 do prédio, quanto falta para o próximo e o progresso (0–1).
  function levelOf(id, lifetime) {
    const g = GROWTH[id];
    const levels = (g && g.levels) || GROWTH_LEVELS;
    const v = growthValue(id, lifetime);
    let level = 0;
    while (level + 1 < levels.length && v >= levels[level + 1]) level++;
    const next = level + 1 < levels.length ? levels[level + 1] : null;
    const prev = levels[level];
    return {
      level, value: v, next,
      missing: next == null ? 0 : next - v,
      progress: next == null ? 1 : (v - prev) / (next - prev),
      unit: g ? g.unit : '',
      name: level >= 4 && g ? g.big : BUILDINGS[id].name,
    };
  }

  // Grade de 4 colunas × 2 linhas. `span` = quantas colunas o prédio ocupa.
  const COLS = 4;
  const LAYOUT = [
    { id: 'prefeitura', col: 0, row: 0 },
    { id: 'biblioteca', col: 1, row: 0 },
    { id: 'oficina', col: 2, row: 0 },
    { id: 'laboratorio', col: 3, row: 0 },
    { id: 'correios', col: 0, row: 1 },
    { id: 'outros', col: 1, row: 1 },
    { id: 'praca', col: 2, row: 1, span: 2 },
  ];

  function buildingFor(tool) {
    if (!tool) return 'outros';
    for (const id of Object.keys(BUILDINGS)) {
      const b = BUILDINGS[id];
      if (b.tools.includes(tool) || (b.match && b.match(tool))) return id;
    }
    return 'outros';
  }

  // Categoria usada nos contadores.
  const CATEGORY_BY_BUILDING = {
    biblioteca: 'reads', oficina: 'edits', laboratorio: 'commands', correios: 'web', prefeitura: 'delegations',
  };
  function categoryOf(tool) {
    return CATEGORY_BY_BUILDING[buildingFor(tool)] || 'other';
  }

  // Título do agente pela atividade dominante (sem gênero).
  const TITLES = [
    ['reads', '📚', 'Rato de biblioteca'],
    ['edits', '🔨', 'Mão na massa'],
    ['commands', '🧪', 'Cientista'],
    ['web', '📮', 'Pombo-correio'],
    ['delegations', '🏛️', 'Delegador'],
    ['other', '🧰', 'Faz-tudo'],
  ];
  function titleFor(counts) {
    counts = counts || {};
    let best = null, bestN = 0, total = 0;
    for (const [k, icon, name] of TITLES) {
      const n = counts[k] || 0;
      total += n;
      if (n > bestN) { bestN = n; best = { icon, name }; }
    }
    if (total < 3 || !best) return { icon: '🌱', name: 'Em formação' };
    return best;
  }

  // Tipos de Notification que exigem uma ação sua (viram ❗). Os demais
  // (auth_success, agent_completed, quota_*...) são só informativos.
  // Tipo ausente/desconhecido de versões antigas conta como alerta, por segurança.
  const ALERT_TYPES = ['permission_prompt', 'idle_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'];
  const INFO_TYPES = ['auth_success', 'agent_completed', 'elicitation_complete', 'elicitation_response',
    'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled'];
  function isAlertNotification(type) {
    return !type || ALERT_TYPES.includes(type) || !INFO_TYPES.includes(type);
  }

  // Resumo legível de um comando de terminal: tira os "cd pasta &&" do começo,
  // fica com a primeira linha útil e troca heredocs por "<<EOF (script)".
  // Funciona também com resumos antigos, que já vieram com as quebras de linha achatadas.
  function cleanCommand(cmd, max) {
    if (typeof cmd !== 'string') return cmd;
    max = max || 80;
    const CD = /^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)?\s*/;
    const lines = cmd.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
    while (lines.length > 1 && /^cd\s+("[^"]*"|'[^']*'|\S+)\s*$/.test(lines[0])) lines.shift();
    let s = lines[0] || '';
    while (CD.test(s) && s.replace(CD, '').length) s = s.replace(CD, '');
    const here = /<<-?\s*['"]?(\w+)['"]?/.exec(s);
    if (here) s = `${s.slice(0, here.index).trim()} <<${here[1]} (script)`;
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function folderName(cwd) {
    if (!cwd) return 'sessão';
    const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || String(cwd);
  }

  // Sessões criadas pelo test-events.js: aparecem ao vivo, mas não entram em
  // histórico, relatórios nem conquistas.
  function isSimulated(sessionId) {
    return typeof sessionId === 'string' && sessionId.startsWith('simulado-');
  }

  return { BUILDINGS, LAYOUT, COLS, buildingFor, categoryOf, titleFor, folderName, isAlertNotification, cleanCommand, isSimulated, GROWTH, levelOf };
});

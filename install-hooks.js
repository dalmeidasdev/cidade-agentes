// Instala/desinstala os hooks da Cidade dos Agentes no settings.json do Claude Code.
//
// Uso:
//   node install-hooks.js --global                 (%USERPROFILE%\.claude\settings.json)
//   node install-hooks.js --project <caminho>      (<caminho>\.claude\settings.json)
//   acrescente --uninstall para remover só o que este script adicionou.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  'Stop',
  'SessionEnd',
];

// Barras normais funcionam tanto no Git Bash quanto no PowerShell
// (o Claude Code no Windows pode executar o comando em qualquer um dos dois).
const HOOK_PATH = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
const COMMAND = `node "${HOOK_PATH}"`;

// Reconhece entradas nossas mesmo que a pasta do projeto tenha mudado de lugar.
function isOurHook(h) {
  return !!h && typeof h.command === 'string' && /cidade-agentes[\\/]+hook\.js/i.test(h.command);
}

function usage(msg) {
  if (msg) console.error(`Erro: ${msg}\n`);
  console.error('Uso:');
  console.error('  node install-hooks.js --global');
  console.error('  node install-hooks.js --project <caminho>');
  console.error('  node install-hooks.js --global --uninstall');
  console.error('  node install-hooks.js --project <caminho> --uninstall');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { uninstall: false, target: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--uninstall') opts.uninstall = true;
    else if (a === '--global') opts.target = path.join(os.homedir(), '.claude', 'settings.json');
    else if (a === '--project') {
      const dir = argv[++i];
      if (!dir) usage('--project precisa de um caminho');
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) usage(`pasta não encontrada: ${abs}`);
      opts.target = path.join(abs, '.claude', 'settings.json');
    } else if (a === '-h' || a === '--help') usage();
    else usage(`argumento desconhecido: ${a}`);
  }
  if (!opts.target) usage('informe --global ou --project <caminho>');
  return opts;
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return { settings: {}, existed: true };
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error(`Erro: ${file} não é um JSON válido (${err.message}).`);
    console.error('Nada foi alterado. Corrija o arquivo e tente de novo.');
    process.exit(1);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`Erro: ${file} não contém um objeto JSON. Nada foi alterado.`);
    process.exit(1);
  }
  return { settings, existed: true };
}

// Remove nossas entradas, preservando qualquer outro hook. Devolve quantas removeu.
function removeOurs(settings) {
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const before = group.hooks.length;
      const remaining = group.hooks.filter((h) => !isOurHook(h));
      removed += before - remaining.length;
      if (remaining.length === 0 && before > 0) continue; // grupo era só nosso
      kept.push(remaining.length === before ? group : { ...group, hooks: remaining });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

function addOurs(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  for (const event of EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    // Sem "matcher": vale para todas as ferramentas / tipos.
    // async: roda em segundo plano, sem nunca bloquear o Claude Code.
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: COMMAND, async: true, timeout: 5 }],
    });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const file = opts.target;
  const { settings, existed } = readSettings(file);

  const removed = removeOurs(settings);
  if (opts.uninstall) {
    if (removed === 0) {
      console.log(`Nenhum hook da Cidade dos Agentes encontrado em ${file}. Nada foi alterado.`);
      return;
    }
  } else {
    addOurs(settings);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existed) {
    fs.copyFileSync(file, file + '.bak');
    console.log(`Backup salvo em ${file}.bak`);
  }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);

  if (opts.uninstall) {
    console.log(`Removidos ${removed} hook(s) da Cidade dos Agentes de ${file}.`);
  } else {
    console.log(`Hooks instalados em ${file} para: ${EVENTS.join(', ')}`);
    console.log(`Comando: ${COMMAND}`);
    if (removed) console.log(`(${removed} entrada(s) antiga(s) foram substituídas)`);
    console.log('Reinicie as sessões do Claude Code (ou use /hooks) para carregar a configuração.');
  }
}

main();

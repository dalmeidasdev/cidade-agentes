// Hook do Claude Code: lê o evento do stdin e envia um resumo para a cidade.
// Regra de ouro: nunca atrapalhar o Claude Code. Qualquer erro => sai com 0, em silêncio.

const http = require('http');
const path = require('path');

let cleanCommand = (s, n) => truncate(s, n);
try { ({ cleanCommand } = require('./public/buildings.js')); } catch (_) {}

const PORT = parseInt(process.env.CIDADE_PORT, 10) || 4777;
const POST_TIMEOUT_MS = 500;

function done() {
  process.exit(0);
}

// Trava de segurança: nada neste script pode demorar mais que isso.
setTimeout(done, 1500).unref();
process.on('uncaughtException', done);
process.on('unhandledRejection', done);

function truncate(s, n) {
  if (typeof s !== 'string') return undefined;
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function shortPath(p, cwd) {
  if (typeof p !== 'string') return undefined;
  if (cwd) {
    const rel = path.relative(cwd, p);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) p = rel;
  }
  return truncate(p.replace(/\\/g, '/'), 80);
}

// Resumo curto do tool_input — nunca o conteúdo de arquivos.
function summarize(toolName, input, cwd) {
  if (!input || typeof input !== 'object') return undefined;
  const file = input.file_path || input.notebook_path || input.path;
  if (toolName === 'Bash') return typeof input.command === 'string' ? cleanCommand(input.command, 80) : undefined;
  if (toolName === 'Grep' || toolName === 'Glob') {
    const where = file ? ` em ${shortPath(file, cwd)}` : '';
    return truncate(`${input.pattern || ''}${where}`, 80);
  }
  if (file) return shortPath(file, cwd);
  if (input.url) return truncate(input.url, 80);
  if (input.query) return truncate(input.query, 80);
  if (input.subagent_type || input.description) {
    return truncate([input.subagent_type, input.description].filter(Boolean).join(': '), 80);
  }
  if (input.command) return truncate(input.command, 80);
  if (input.pattern) return truncate(input.pattern, 80);
  return undefined;
}

// Em qual programa a sessão está rodando, para a cidade dizer "onde" responder.
// O hook herda o ambiente do Claude Code, que herda o do terminal.
function detectTerminal() {
  const env = process.env;
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || '');
  if (/desktop/i.test(entry)) return 'app Claude Desktop';
  if (/vscode/i.test(entry)) return 'extensão do VS Code';
  if (/jetbrains/i.test(entry)) return 'plugin JetBrains';
  if (env.CURSOR_TRACE_ID) return 'terminal do Cursor';
  if (env.TERM_PROGRAM === 'vscode') return 'terminal do VS Code';
  if (/JetBrains/i.test(env.TERMINAL_EMULATOR || '')) return 'terminal da IDE JetBrains';
  if (env.WT_SESSION) return 'Windows Terminal';
  if (env.ConEmuPID) return 'ConEmu';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  return null;
}

function buildPayload(ev) {
  const out = {
    hook_event_name: ev.hook_event_name,
    session_id: ev.session_id,
    cwd: ev.cwd,
  };
  if (ev.agent_id) out.agent_id = ev.agent_id;
  if (ev.agent_type) out.agent_type = ev.agent_type;
  if (ev.tool_name) out.tool_name = ev.tool_name;
  if (typeof ev.tool_use_id === 'string') out.tool_use_id = ev.tool_use_id.slice(0, 80);
  if (typeof ev.duration_ms === 'number') out.duration_ms = ev.duration_ms;
  if (ev.hook_event_name === 'PostToolUseFailure') {
    if (typeof ev.error === 'string') out.error = truncate(ev.error, 100);
    if (ev.is_interrupt) out.is_interrupt = true;
  }
  const summary = summarize(ev.tool_name, ev.tool_input, ev.cwd);
  if (summary) out.summary = summary;

  // Pequenos extras úteis para a cidade (sempre curtos).
  if (ev.hook_event_name === 'Notification') {
    out.message = truncate(ev.message, 120);
    if (ev.title) out.title = truncate(ev.title, 60);
    if (ev.notification_type) out.notification_type = ev.notification_type;
  }
  const terminal = detectTerminal();
  if (terminal) out.terminal = terminal;
  if (ev.hook_event_name === 'UserPromptSubmit') out.summary = truncate(ev.prompt, 60);
  if (ev.hook_event_name === 'SessionStart' && ev.source) out.source = ev.source;
  if (ev.hook_event_name === 'SessionEnd' && ev.reason) out.reason = ev.reason;
  return out;
}

function send(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/event',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: POST_TIMEOUT_MS,
    },
    (res) => {
      res.resume();
      res.on('end', done);
      res.on('error', done);
    }
  );
  req.on('timeout', () => { req.destroy(); done(); });
  req.on('error', done);
  req.end(body);
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!ev || typeof ev.hook_event_name !== 'string') return done();
    send(buildPayload(ev));
  } catch (_) {
    done();
  }
});

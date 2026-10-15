// Simula três sessões do Claude Code (com subagentes; uma fica esperando
// permissão no final) para ver a cidade funcionando.
// Cada evento é entregue ao hook.js pelo stdin, exatamente como o Claude Code faz,
// então o teste cobre o caminho completo: hook.js -> server.js -> navegador.
//
// Uso:  node test-events.js            (roda o roteiro uma vez, ~45 s)
//       node test-events.js --loop     (repete até Ctrl+C)
//       node test-events.js --limpar   (remove as sessões falsas da cidade)

const { spawn } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'hook.js');
const LOOP = process.argv.includes('--loop');

// Ids "simulado-*": o servidor mostra essas sessões ao vivo, mas não as grava no
// histórico nem as conta em relatórios e conquistas.
const A = { session_id: 'simulado-aaaa-1111', cwd: 'C:\\Users\\usuario\\Projetos\\meu-site' };
const B = { session_id: 'simulado-bbbb-2222', cwd: 'C:\\Users\\usuario\\Projetos\\api-pagamentos' };
const D = { session_id: 'simulado-cccc-3333', cwd: 'C:\\Users\\usuario\\Projetos\\notebooks-dados' };
const subA = { agent_id: 'agent-explore-01', agent_type: 'Explore' };
const subB = { agent_id: 'agent-review-02', agent_type: 'code-reviewer' };

// Pre e Post da mesma ferramenta compartilham o tool_use_id, como no Claude Code.
let n = 0;
const openIds = new Map();
const idKey = (s, tool, extra) => `${s.session_id}|${(extra && extra.agent_id) || ''}|${tool}`;
const pre = (s, tool, input, extra) => {
  const id = `toolu_sim_${++n}`;
  openIds.set(idKey(s, tool, extra), id);
  return ['PreToolUse', s, { tool_name: tool, tool_input: input, tool_use_id: id, ...extra }];
};
const finish = (eventName) => (s, tool, extra, more) => [eventName, s, () => ({
  tool_name: tool, tool_input: {}, tool_use_id: openIds.get(idKey(s, tool, extra)),
  duration_ms: 150 + Math.round(Math.random() * 2500), ...extra, ...more,
})];
const post = finish('PostToolUse');
const fail = finish('PostToolUseFailure');

// [espera em ms antes do evento, [evento, sessão, campos extras]]
const SCRIPT = [
  [0, ['SessionStart', A, { source: 'startup' }]],
  [1200, ['UserPromptSubmit', A, { prompt: 'Adicione um formulário de contato na página inicial' }]],
  [1500, pre(A, 'Glob', { pattern: 'src/**/*.html' })],
  [1500, post(A, 'Glob')],
  [400, pre(A, 'Read', { file_path: 'C:\\Users\\usuario\\Projetos\\meu-site\\src\\index.html' })],
  [400, ['SessionStart', B, { source: 'startup' }]],
  [1600, post(A, 'Read')],
  [300, ['UserPromptSubmit', B, { prompt: 'Revise o módulo de reembolso e rode os testes' }]],
  [300, ['SessionStart', D, { source: 'startup' }]],
  [600, ['UserPromptSubmit', D, { prompt: 'Atualize o gráfico de vendas e pesquise a fórmula de sazonalidade' }]],
  [600, pre(A, 'Agent', { subagent_type: 'Explore', description: 'Achar estilos de formulário' })],
  [400, pre(D, 'WebSearch', { query: 'decomposição sazonal STL python' })],
  [500, ['SubagentStart', A, subA]],
  [800, pre(A, 'Grep', { pattern: 'form-control', path: 'src' }, subA)],
  [400, pre(B, 'Bash', { command: 'npm test -- --grep reembolso && echo "pronto" # um comando bem comprido para ver o corte' })],
  [1800, post(A, 'Grep', subA)],
  [300, pre(A, 'Read', { file_path: 'C:\\Users\\usuario\\Projetos\\meu-site\\src\\css\\forms.css' }, subA)],
  [1800, post(A, 'Read', subA)],
  [500, post(B, 'Bash')],
  [200, post(D, 'WebSearch')],
  [500, pre(D, 'NotebookEdit', { notebook_path: 'C:\\Users\\usuario\\Projetos\\notebooks-dados\\vendas.ipynb', new_source: '...' })],
  [300, ['SubagentStop', A, subA]],
  [300, post(A, 'Agent')],
  [600, pre(A, 'Edit', { file_path: 'C:\\Users\\usuario\\Projetos\\meu-site\\src\\index.html', old_string: '...', new_string: '...' })],
  [400, pre(B, 'Agent', { subagent_type: 'code-reviewer', description: 'Revisar reembolso' })],
  [400, ['SubagentStart', B, subB]],
  [700, pre(B, 'Read', { file_path: 'C:\\Users\\usuario\\Projetos\\api-pagamentos\\src\\refund.ts' }, subB)],
  [1500, post(A, 'Edit')],
  [400, pre(A, 'WebFetch', { url: 'https://developer.mozilla.org/pt-BR/docs/Web/HTML/Element/form', prompt: '...' })],
  [800, post(B, 'Read', subB)],
  [300, pre(B, 'mcp__github__list_pull_requests', { repo: 'usuario/api-pagamentos' }, subB)],
  [1500, post(A, 'WebFetch')],
  [300, ['Notification', A, { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }]],
  [2500, pre(A, 'Bash', { command: 'npx prettier --write src/index.html' })],
  [900, fail(B, 'mcp__github__list_pull_requests', subB, { error: 'MCP error: request timed out' })],
  [800, post(A, 'Bash')],
  [400, pre(B, 'TodoWrite', { todos: [] }, subB)],
  [1200, post(B, 'TodoWrite', subB)],
  [300, ['SubagentStop', B, subB]],
  [300, post(B, 'Agent')],
  [300, post(D, 'NotebookEdit')],
  [400, ['Notification', D, { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }]],
  [600, pre(A, 'Write',{ file_path: 'C:\\Users\\usuario\\Projetos\\meu-site\\src\\contato.js', content: 'NUNCA DEVE SER ENVIADO' })],
  [1500, post(A, 'Write')],
  [600, ['Stop', A, { stop_hook_active: false, last_assistant_message: 'Pronto!' }]],
  [1500, pre(B, 'Edit', { file_path: 'C:\\Users\\usuario\\Projetos\\api-pagamentos\\src\\refund.ts' })],
  [1800, post(B, 'Edit')],
  [500, ['Stop', B, { stop_hook_active: false }]],
  [4000, ['SessionEnd', B, { reason: 'prompt_input_exit' }]],
];

function runHook(eventName, session, extra) {
  const payload = {
    session_id: session.session_id,
    transcript_path: `C:\\Users\\usuario\\.claude\\projects\\fake\\${session.session_id}.jsonl`,
    cwd: session.cwd,
    permission_mode: 'default',
    hook_event_name: eventName,
    ...extra,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  do {
    for (const [wait, [eventName, session, lazyExtra]] of SCRIPT) {
      await sleep(wait);
      // Post/falha montam os campos na hora, para pegar o tool_use_id do Pre correspondente.
      const extra = typeof lazyExtra === 'function' ? lazyExtra() : lazyExtra;
      const label = path.basename(session.cwd.replace(/\\/g, '/'));
      const detail = extra && extra.tool_name ? ` ${extra.tool_name}` : '';
      const who = extra && extra.agent_type ? ` (${extra.agent_type})` : '';
      const { code, out } = await runHook(eventName, session, extra || {});
      const warn = code !== 0 || out ? `  [hook saiu com ${code}${out ? ', imprimiu algo!' : ''}]` : '';
      console.log(`${label}${who}: ${eventName}${detail}${warn}`);
    }
    if (LOOP) await sleep(3000);
  } while (LOOP);
  console.log('Roteiro concluído. Para tirar as sessões falsas da cidade: node test-events.js --limpar');
}

// Remove da cidade (e de data/state.json) as sessões inventadas por este script.
async function clean() {
  const http = require('http');
  const port = parseInt(process.env.CIDADE_PORT, 10) || 4777;
  for (const s of [A, B, D]) {
    await new Promise((resolve) => {
      const body = JSON.stringify({ key: s.session_id });
      const req = http.request({ host: '127.0.0.1', port, path: '/api/forget', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
        console.log(`${path.basename(s.cwd.replace(/\\/g, '/'))}: ${res.statusCode === 204 ? 'removida' : 'não estava na cidade'}`);
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', (err) => { console.error(`Servidor fora do ar? ${err.message}`); resolve(); });
      req.end(body);
    });
  }
}

if (process.argv.includes('--limpar')) clean();
else main();

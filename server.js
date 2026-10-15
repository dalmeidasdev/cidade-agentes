// Servidor da Cidade dos Agentes — só módulos nativos do Node.
// Recebe eventos dos hooks do Claude Code (POST /event), mantém perfis em
// data/state.json e transmite tudo para o navegador via Server-Sent Events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store, dayKey } = require('./profiles.js');
const reports = require('./reports.js');
const { isSimulated } = require('./public/buildings.js');

const PORT = parseInt(process.env.CIDADE_PORT, 10) || 4777;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024; // eventos são pequenos; recusa corpos enormes

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const store = new Store(path.join(__dirname, 'data', 'state.json'));
const clients = new Set();

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    clients.delete(res);
  }
}

function broadcast(event, data) {
  for (const res of clients) sseWrite(res, event, data);
}

// Lê um corpo JSON pequeno. cb(err, objeto).
function readJson(req, res, cb) {
  let size = 0;
  const chunks = [];
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      res.writeHead(413).end();
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    let obj;
    try {
      obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('JSON inválido');
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('esperado um objeto JSON');
      return;
    }
    cb(obj);
  });
  req.on('error', () => {});
}

function handleEvent(req, res) {
  readJson(req, res, (ev) => {
    if (typeof ev.hook_event_name !== 'string') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('evento inválido');
      return;
    }
    // Responde primeiro para o hook terminar o quanto antes.
    res.writeHead(204).end();

    ev.ts = Date.now();
    const { profiles, building, unlocked, lifetimeChanged } = store.apply(ev);
    // Perfis primeiro: o navegador usa o nome do perfil ao criar o habitante.
    for (const p of profiles) broadcast('profile', p);
    if (building) broadcast('building', building);
    broadcast('agent', ev);
    broadcast('stats', store.stats);
    if (!isSimulated(ev.session_id)) {
      const cwd = (store.profiles[ev.session_id] || {}).cwd;
      const pr = cwd && store.projects[cwd.toLowerCase()];
      if (pr) broadcast('project', pr);
    }
    if (unlocked.length) broadcast('achievement', { unlocked, all: store.achievementList() });
    if (lifetimeChanged) broadcast('lifetime', store.lifetime);
  });
}

function handleForget(req, res) {
  readJson(req, res, (body) => {
    const ok = typeof body.key === 'string' && store.forget(body.key);
    res.writeHead(ok ? 204 : 404).end();
    if (ok) broadcast('forget', { key: body.key });
  });
}

// Relatórios e histórico: /api/report?day=&project=, /api/week?project=, /api/events?day=
function handleApi(req, res) {
  const url = new URL(req.url, 'http://x');
  const day = url.searchParams.get('day') || dayKey(Date.now());
  const project = url.searchParams.get('project') || '';
  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(data));
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(400, { error: 'dia inválido (use AAAA-MM-DD)' });
  if (url.pathname === '/api/report') return json(200, reports.report(store.eventsDir, day, project));
  if (url.pathname === '/api/week') return json(200, reports.week(store.eventsDir, project));
  if (url.pathname === '/api/events') return json(200, reports.readEvents(store.eventsDir, day));
  if (url.pathname === '/api/search') {
    return json(200, reports.search(store.eventsDir, url.searchParams.get('q'), parseInt(url.searchParams.get('days'), 10) || 30));
  }
  json(404, { error: 'não encontrado' });
}

// ---------------------------------------------------------------------------
// Abrir pasta no Explorer ou no VS Code (só pastas que a cidade já conhece)
// ---------------------------------------------------------------------------
let vscodeCache;
function findVSCode() {
  if (vscodeCache !== undefined) return vscodeCache;
  const env = process.env;
  const candidates = [
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
  ];
  // Instalação em outro lugar: o "code.cmd" do PATH fica em <instalação>\bin.
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, 'code.cmd'))) candidates.push(path.join(dir, '..', 'Code.exe'));
  }
  vscodeCache = candidates.find((p) => p && fs.existsSync(p)) || null;
  return vscodeCache;
}

function knownFolder(cwd) {
  if (typeof cwd !== 'string' || !cwd) return null;
  const want = path.resolve(cwd).toLowerCase();
  const known = [
    ...Object.values(store.projects).map((p) => p.cwd),
    ...Object.values(store.profiles).map((p) => p.cwd),
  ].filter(Boolean);
  const hit = known.find((k) => path.resolve(k).toLowerCase() === want);
  if (!hit) return null;
  try { return fs.statSync(hit).isDirectory() ? path.resolve(hit) : null; } catch (_) { return null; }
}

function handleOpen(req, res) {
  // Cabeçalho próprio força o "preflight" de CORS (que não respondemos): outras
  // páginas abertas no navegador não conseguem chamar esta rota.
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  if (req.headers['x-cidade'] !== '1' || !okOrigin) {
    res.writeHead(403).end();
    req.resume();
    return;
  }
  readJson(req, res, (body) => {
    const dir = knownFolder(body.cwd);
    if (!dir) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('pasta desconhecida');
    let exe, args;
    if (body.app === 'code') {
      exe = findVSCode();
      if (!exe) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('VS Code não encontrado');
      args = [dir];
    } else {
      exe = 'explorer.exe';
      args = [dir];
    }
    // Sem shell e com argumentos separados: o caminho nunca é interpretado como comando.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // senão o Code.exe rodaria como Node
    try {
      const { spawn } = require('child_process');
      spawn(exe, args, { detached: true, stdio: 'ignore', env, shell: false }).on('error', () => {}).unref();
      res.writeHead(204).end();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('não consegui abrir');
    }
  });
}

function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  // "hello" avisa o cliente para limpar o estado; depois vêm o snapshot e o replay.
  sseWrite(res, 'hello', { serverTime: Date.now() });
  sseWrite(res, 'snapshot', store.snapshot());
  for (const ev of store.recent) sseWrite(res, 'agent', { ...ev, replay: true });
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (_) {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('não encontrado');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(data);
  });
}

const server = http.createServer((req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/event') return handleEvent(req, res);
    if (req.method === 'GET' && req.url === '/stream') return handleStream(req, res);
    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ...store.snapshot(), recent: store.recent }, null, 2));
    }
    if (req.method === 'POST' && req.url === '/api/forget') return handleForget(req, res);
    if (req.method === 'GET' && /^\/api\/(report|week|events|search)\b/.test(req.url)) return handleApi(req, res);
    if (req.method === 'GET' && req.url === '/api/open/capabilities') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ code: !!findVSCode() }));
    }
    if (req.method === 'POST' && req.url === '/api/open') return handleOpen(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
    res.writeHead(405).end();
  } catch (err) {
    console.error('Erro ao tratar requisição:', err);
    try { res.writeHead(500).end(); } catch (_) {}
  }
});

// Mantém conexões SSE vivas através de proxies/antivírus que fecham conexões ociosas.
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch (_) { clients.delete(res); }
  }
}, 15000).unref();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. Use outra: $env:CIDADE_PORT=5000; node server.js`);
  } else {
    console.error('Erro no servidor:', err);
  }
  process.exit(1);
});

process.on('uncaughtException', (err) => console.error('Erro inesperado (servidor continua):', err));

// Salva o estado ao fechar (Ctrl+C).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    store.saveNow();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Cidade dos Agentes rodando em http://localhost:${PORT}`);
});

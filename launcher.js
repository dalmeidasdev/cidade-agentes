// Liga a Cidade dos Agentes se ela ainda não estiver rodando, de forma
// independente de qualquer terminal (processo destacado, sem janela).
//
// Uso:  node launcher.js          (só garante que o servidor está de pé)
//       node launcher.js --open   (e abre a cidade no navegador)
//       --from=<origem>           (quem chamou: login, atalho... aparece no log)
//
// Toda execução deixa uma linha em data/server.log, inclusive quando a cidade
// já estava rodando: assim dá para conferir se o autostart rodou no login.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.CIDADE_PORT, 10) || 4777;
const URL_LOCAL = `http://localhost:${PORT}`;
const LOG = path.join(__dirname, 'data', 'server.log');
const MAX_LOG = 1024 * 1024;
const OPEN = process.argv.includes('--open');
const FROM = (process.argv.find((a) => a.startsWith('--from=')) || '').slice(7) || 'manual';

function isUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// Anota uma linha no log (que zera sozinho ao passar de 1 MB). Nunca falha.
function note(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    try { if (fs.statSync(LOG).size > MAX_LOG) fs.truncateSync(LOG, 0); } catch (_) { /* ainda não existe */ }
    fs.appendFileSync(LOG, `\n--- ${new Date().toLocaleString('pt-BR')}: launcher (${FROM}): ${msg} ---\n`);
  } catch (_) {}
}

function openBrowser() {
  spawn('cmd', ['/c', 'start', '', URL_LOCAL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  if (await isUp()) {
    note('já estava rodando');
    console.log(`A cidade já estava rodando em ${URL_LOCAL}`);
  } else {
    note('iniciando o servidor');
    const log = fs.openSync(LOG, 'a');
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
      env: process.env,
    });
    child.unref();
    let up = false;
    for (let i = 0; i < 25 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      up = await isUp();
    }
    if (!up) {
      note('servidor não respondeu em 5 s');
      console.error(`A cidade não subiu. Veja o log em ${LOG}`);
      process.exit(1);
    }
    console.log(`Cidade iniciada em ${URL_LOCAL} (processo ${child.pid}, log em data\\server.log)`);
  }
  if (OPEN) openBrowser();
}

main();

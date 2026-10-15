// Faz a Cidade dos Agentes ligar sozinha quando você entra no Windows.
// Cria um pequeno .vbs na pasta "Inicializar" do seu usuário, que roda o
// launcher.js sem abrir janela. Não usa admin, registro nem serviços.
//
// Uso:  node install-autostart.js              (instala e já liga a cidade)
//       node install-autostart.js --uninstall  (remove só o que este script criou)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const startup = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const target = path.join(startup, 'cidade-agentes.vbs');
const launcher = path.join(__dirname, 'launcher.js');

if (process.platform !== 'win32') {
  console.error('Este script é só para Windows.');
  process.exit(1);
}

if (process.argv.includes('--uninstall')) {
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
    console.log(`Removido: ${target}`);
    console.log('A cidade não vai mais ligar sozinha. (O servidor que está rodando agora continua até você fechá-lo.)');
  } else {
    console.log('Nada para remover: a cidade não estava configurada para iniciar com o Windows.');
  }
  process.exit(0);
}

// Em VBScript, aspas dentro de string são escritas dobradas ("").
const q = (s) => `""${s}""`;
const vbs = [
  "' Cidade dos Agentes: liga o servidor ao entrar no Windows, sem janela.",
  "' Criado por install-autostart.js. Para remover: node install-autostart.js --uninstall",
  'Set sh = CreateObject("WScript.Shell")',
  `sh.Run "${q(process.execPath)} ${q(launcher)} --from=login", 0, False`,
  '',
].join('\r\n');

fs.mkdirSync(startup, { recursive: true });
// UTF-16 com BOM: o Windows Script Host lê assim sem estragar caminhos com acento.
fs.writeFileSync(target, '﻿' + vbs, 'utf16le');
console.log(`Criado: ${target}`);
console.log('A cidade vai ligar sozinha nos próximos logins.');

// Liga agora também.
const r = spawnSync(process.execPath, [launcher], { stdio: 'inherit' });
process.exit(r.status || 0);

// Interiores dos prédios: cada prédio tem uma sala em pixel art com estações de
// trabalho, onde aparecem os agentes que estão lá dentro.
//
// Para dar uma sala a um prédio novo, acrescente uma entrada em THEMES com as
// cores e (opcional) as funções `decorate` (parede e fundo), `desk` (móvel
// na frente de cada estação), `tick` (efeitos animados) e `overlay` (textos).
// Prédios sem tema usam DEFAULT_THEME.

(() => {
  'use strict';

  const C = window.Cidade;
  const { BUILDINGS } = C.defs;
  const px = (...a) => C.px(...a);
  const PERSON_SCALE = 2;

  // ---------------------------------------------------------------------------
  // Geometria da sala
  // ---------------------------------------------------------------------------
  function roomGeo() {
    const { W, H } = C.view;
    const x0 = 6, x1 = W - 6, y0 = C.geo.top - 2, y1 = H - 6;
    const wallH = Math.round((y1 - y0) * 0.34);
    const floorY = y0 + wallH;
    const fw = x1 - x0, fh = y1 - floorY;
    const cols = 4, rows = 2;
    const stations = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        stations.push({ x: Math.round(x0 + fw * (c + 0.5) / cols), y: Math.round(floorY + fh * (0.36 + r * 0.36)) });
      }
    }
    const door = { x: Math.round((x0 + x1) / 2 - 11), y: y1 - 3, w: 22, h: 6 };
    return { x0, x1, y0, y1, wallH, floorY, fw, fh, stations, door };
  }

  // ---------------------------------------------------------------------------
  // Quem está dentro
  // ---------------------------------------------------------------------------
  const pos = new Map(); // key -> {x, y} dentro da sala atual
  let posFor = null;
  const fx = []; // partículas da sala

  function insiders(id) {
    const list = [];
    for (const p of C.people.values()) {
      if (p.building === id && !p.leaving && !p.path.length) list.push(p);
    }
    return list.sort((a, b) => a.slot - b.slot);
  }

  function placeInsiders(id, room, dt) {
    if (posFor !== id) { pos.clear(); fx.length = 0; posFor = id; }
    const list = insiders(id);
    const keep = new Set();
    list.forEach((p, i) => {
      keep.add(p.key);
      let target;
      if (i < room.stations.length) target = room.stations[i];
      else {
        const k = i - room.stations.length;
        target = { x: room.door.x - 20 - (k % 6) * 12, y: room.y1 - 12 - Math.floor(k / 6) * 4 };
      }
      let q = pos.get(p.key);
      if (!q) { q = { x: room.door.x + room.door.w / 2, y: room.y1 - 2 }; pos.set(p.key, q); }
      const dx = target.x - q.x, dy = target.y - q.y, d = Math.hypot(dx, dy);
      const step = 70 * dt;
      q.walking = d > 0.5;
      if (d <= step) { q.x = target.x; q.y = target.y; } else { q.x += (dx / d) * step; q.y += (dy / d) * step; }
      q.station = i < room.stations.length ? i : -1;
    });
    for (const k of [...pos.keys()]) if (!keep.has(k)) pos.delete(k);
    return list;
  }

  // ---------------------------------------------------------------------------
  // Peças reutilizáveis
  // ---------------------------------------------------------------------------
  function seeded(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  function windowOnWall(x, y, w, h, light) {
    px(x - 1, y - 1, w + 2, h + 2, '#5a4632');
    const sky = { dia: '#9ed4ff', amanhecer: '#ffc49b', entardecer: '#ff9f7a', noite: '#1d2a5a' }[light.name] || '#9ed4ff';
    px(x, y, w, h, sky);
    if (light.name === 'noite') { px(x + 3, y + 3, 1, 1, '#fff'); px(x + w - 5, y + 5, 1, 1, '#fff'); }
    if (C.isRaining && C.isRaining()) {
      px(x, y, w, h, 'rgba(40,50,75,.35)');
      const k = Math.floor(C.now() / 60);
      for (let i = 0; i < w; i += 3) px(x + i, y + ((i * 7 + k) % Math.max(1, h - 2)), 1, 2, '#b8d4ff');
    }
    px(x + w / 2 - 0.5, y, 1, h, '#5a4632');
    px(x, y + h / 2 - 0.5, w, 1, '#5a4632');
  }

  function plant(x, y) {
    px(x - 3, y - 5, 6, 5, '#a0522d');
    px(x - 4, y - 6, 8, 2, '#8b4513');
    px(x - 1, y - 12, 2, 7, '#2f7d3a');
    px(x - 5, y - 11, 4, 3, '#3e9a4a');
    px(x + 1, y - 14, 4, 3, '#3e9a4a');
    px(x - 3, y - 15, 3, 3, '#2f7d3a');
  }

  function woodDesk(x, y, top, front) {
    px(x - 14, y - 7, 28, 3, top);
    px(x - 14, y - 4, 28, 7, front);
    px(x - 13, y + 3, 2, 3, front);
    px(x + 11, y + 3, 2, 3, front);
    px(x - 14, y - 4, 28, 1, 'rgba(0,0,0,.2)');
  }

  // ---------------------------------------------------------------------------
  // Temas
  // ---------------------------------------------------------------------------
  const DEFAULT_THEME = {
    wall: '#cfc6b0', wallDark: '#a99f86', floorA: '#9c8f7a', floorB: '#8f826d',
    desk: (x, y) => woodDesk(x, y, '#a07850', '#7a5a3a'),
  };

  const THEMES = {
    prefeitura: {
      wall: '#efe3c4', wallDark: '#c9b48a', floorA: '#9c6b43', floorB: '#8a5d39',
      decorate(room, t, light) {
        const cx = (room.x0 + room.x1) / 2;
        // bandeira
        px(cx - 1, room.y0 + 6, 2, room.wallH - 12, '#6b6b6b');
        const wave = Math.sin(t * 3) > 0 ? 1 : 0;
        px(cx + 1, room.y0 + 7 + wave, 16, 10, '#2e9e5b');
        px(cx + 5, room.y0 + 9 + wave, 8, 6, '#f2d03b');
        px(cx + 8, room.y0 + 11 + wave, 2, 2, '#2e5fa3');
        // mural de avisos
        const bx = room.x0 + 14, by = room.y0 + 8, bw = Math.min(110, room.fw * 0.3), bh = room.wallH - 22;
        px(bx - 2, by - 2, bw + 4, bh + 4, '#6b4423');
        px(bx, by, bw, bh, '#c49a6c');
        px(bx + 4, by + 4, bw - 8, bh - 8, '#fdf6e3');
        px(bx + bw / 2 - 1, by + 2, 3, 3, '#c0392b');
        this.board = { x: bx + 4, y: by + 4, w: bw - 8, h: bh - 8 };
        // janelas e retrato
        windowOnWall(room.x1 - 70, room.y0 + 10, 22, 18, light);
        windowOnWall(room.x1 - 40, room.y0 + 10, 22, 18, light);
        // tapete vermelho até a porta
        px(cx - 10, room.floorY, 20, room.y1 - room.floorY, '#a83232');
        px(cx - 8, room.floorY, 1, room.y1 - room.floorY, '#e0b040');
        px(cx + 7, room.floorY, 1, room.y1 - room.floorY, '#e0b040');
        plant(room.x0 + 8, room.floorY + 10);
        plant(room.x1 - 8, room.floorY + 10);
      },
      desk: (x, y) => {
        woodDesk(x, y, '#7b4a2a', '#5a3520');
        px(x - 8, y - 9, 6, 2, '#fdf6e3');
        px(x + 4, y - 10, 2, 3, '#333');
      },
      overlay(c, room, S) {
        // último pedido recebido (de qualquer sessão) no mural
        let last = null;
        for (const pr of C.profiles.values()) {
          if (pr.lastPrompt && (!last || pr.lastPrompt.ts > last.ts)) last = { ...pr.lastPrompt, key: pr.key };
        }
        if (!this.board) return;
        const b = this.board;
        c.fillStyle = '#5a3520';
        c.font = `bold 12px ${C.ui.FONT}`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        c.fillText('📜 Último pedido', b.x * S + 6, b.y * S + 6);
        c.font = `12px ${C.ui.FONT}`;
        c.fillStyle = '#3a2a1a';
        const text = last ? `“${last.text}” — ${C.displayName(last.key)}` : 'Nenhum pedido ainda.';
        wrapText(c, text, b.x * S + 6, b.y * S + 24, b.w * S - 12, 16, Math.floor((b.h * S - 30) / 16));
      },
    },

    biblioteca: {
      wall: '#d8c9a8', wallDark: '#7a5a3a', floorA: '#7a4f2e', floorB: '#6c4527',
      decorate(room) {
        // estantes de ponta a ponta
        const rnd = seeded(11);
        const colors = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#2c3e50'];
        const shelfH = Math.floor((room.wallH - 10) / 3);
        px(room.x0 + 4, room.y0 + 4, room.fw - 8, room.wallH - 6, '#5a3a22');
        for (let s = 0; s < 3; s++) {
          const sy = room.y0 + 6 + s * shelfH;
          let x = room.x0 + 6;
          while (x < room.x1 - 8) {
            const bw = 2 + Math.floor(rnd() * 3), bh = shelfH - 4 - Math.floor(rnd() * 4);
            px(x, sy + (shelfH - 2 - bh), bw, bh, colors[Math.floor(rnd() * colors.length)]);
            if (bw > 2) px(x, sy + (shelfH - 2 - bh) + 2, bw, 1, 'rgba(255,255,255,.3)');
            x += bw + (rnd() < 0.1 ? 3 : 0);
          }
          px(room.x0 + 4, sy + shelfH - 2, room.fw - 8, 2, '#3e2716');
        }
        // escada
        const lx = room.x0 + room.fw * 0.7;
        px(lx, room.y0 + 4, 1, room.wallH, '#a0763f');
        px(lx + 7, room.y0 + 4, 1, room.wallH, '#a0763f');
        for (let y = room.y0 + 8; y < room.floorY; y += 6) px(lx, y, 8, 1, '#a0763f');
        // tapete
        px(room.x0 + 20, room.floorY + 8, room.fw - 40, room.fh - 24, 'rgba(120,30,40,.35)');
      },
      desk: (x, y, t, p) => {
        woodDesk(x, y, '#5a3a22', '#43301c');
        // abajur verde
        px(x + 7, y - 13, 1, 6, '#c9a227');
        px(x + 4, y - 15, 7, 3, '#1f7a3f');
        if (p) {
          px(x + 3, y - 8, 9, 1, 'rgba(255,240,160,.6)');
          // livro aberto
          px(x - 9, y - 9, 10, 3, '#fdf6e3');
          px(x - 4, y - 9, 1, 3, '#c9b48a');
        }
      },
    },

    oficina: {
      wall: '#b98f6a', wallDark: '#6e4b30', floorA: '#7c7f86', floorB: '#71747a',
      decorate(room) {
        // painel de ferramentas
        const bx = room.x0 + 12, by = room.y0 + 6, bw = room.fw - 24, bh = room.wallH - 14;
        px(bx, by, bw, bh, '#d8b98c');
        for (let y = by + 3; y < by + bh; y += 4) for (let x = bx + 3; x < bx + bw; x += 4) px(x, y, 1, 1, '#a8895f');
        const rnd = seeded(5);
        for (let x = bx + 8; x < bx + bw - 12; x += 18) {
          const kind = Math.floor(rnd() * 3);
          const y = by + 6 + rnd() * (bh - 22);
          if (kind === 0) { px(x, y, 2, 12, '#7a5a3a'); px(x - 3, y, 8, 4, '#555b66'); }          // martelo
          else if (kind === 1) { px(x, y + 2, 2, 12, '#9aa3ad'); px(x - 2, y, 6, 3, '#9aa3ad'); } // chave
          else { px(x - 2, y, 10, 5, '#c7ccd6'); px(x + 8, y + 1, 4, 3, '#7a5a3a'); }             // serrote
        }
        px(room.x1 - 26, room.floorY - 14, 14, 14, '#c0392b'); // armário
        px(room.x1 - 24, room.floorY - 8, 10, 1, '#7a1d14');
      },
      desk: (x, y, t, p) => {
        px(x - 15, y - 7, 30, 3, '#8b5a2b');
        px(x - 15, y - 4, 30, 6, '#5d3d29');
        px(x - 14, y + 2, 2, 4, '#3b3b46');
        px(x + 12, y + 2, 2, 4, '#3b3b46');
        px(x + 8, y - 11, 6, 4, '#555b66'); // morsa
        if (p) px(x - 10, y - 9, 8, 2, '#e8d9b5'); // prancheta
      },
      tick(room, list, t) {
        for (const p of list) {
          const q = pos.get(p.key);
          if (q && !q.walking && p.working && Math.random() < 0.35) {
            fx.push({ x: q.x + 6, y: q.y - 10, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 15, life: 0.4, max: 0.4, c: Math.random() < 0.5 ? '#ffd166' : '#ff8c42', size: 1 });
          }
        }
      },
    },

    laboratorio: {
      wall: '#dfeee6', wallDark: '#8fb8a2', floorA: '#e8ecef', floorB: '#d5dbe0',
      decorate(room) {
        // quadro-negro
        const bx = room.x0 + 10, by = room.y0 + 6, bw = Math.min(120, room.fw * 0.34), bh = room.wallH - 16;
        px(bx - 2, by - 2, bw + 4, bh + 4, '#8b5a2b');
        px(bx, by, bw, bh, '#24402f');
        this.board = { x: bx, y: by, w: bw, h: bh };
        // terminal na parede
        const tx = room.x1 - Math.min(170, room.fw * 0.45) - 10, tw = Math.min(170, room.fw * 0.45);
        px(tx - 3, by - 3, tw + 6, bh + 6, '#3b3b46');
        px(tx, by, tw, bh, '#0b1410');
        this.term = { x: tx, y: by, w: tw, h: bh };
        // prateleira de frascos
        const sx = bx + bw + 10, sw = tx - sx - 10;
        if (sw > 20) {
          px(sx, room.y0 + room.wallH * 0.55, sw, 2, '#8b5a2b');
          const colors = ['#7dff9a', '#ff7aa2', '#7ac8ff', '#ffe066'];
          for (let x = sx + 3, i = 0; x < sx + sw - 4; x += 7, i++) {
            px(x, room.y0 + room.wallH * 0.55 - 6, 4, 6, 'rgba(255,255,255,.6)');
            px(x, room.y0 + room.wallH * 0.55 - 3, 4, 3, colors[i % 4]);
          }
        }
      },
      desk: (x, y, t, p) => {
        px(x - 15, y - 7, 30, 3, '#f5f7f8');
        px(x - 15, y - 4, 30, 7, '#c7d1d8');
        px(x - 14, y + 3, 2, 3, '#8a96a0');
        px(x + 12, y + 3, 2, 3, '#8a96a0');
        // frascos
        px(x - 10, y - 13, 4, 6, 'rgba(255,255,255,.7)');
        px(x - 10, y - 10, 4, 3, p ? '#7dff9a' : '#5ab074');
        px(x + 6, y - 12, 5, 5, 'rgba(255,255,255,.7)');
        px(x + 6, y - 9, 5, 2, p ? '#ff7aa2' : '#b0607a');
      },
      tick(room, list) {
        for (const p of list) {
          const q = pos.get(p.key);
          if (q && !q.walking && p.working && Math.random() < 0.15) {
            fx.push({ x: q.x - 8 + Math.random() * 2, y: q.y - 13, vx: (Math.random() - 0.5) * 3, vy: -8, life: 1, max: 1, c: Math.random() < 0.5 ? '#7dff9a' : '#ff7aa2', size: 1 });
          }
        }
      },
      overlay(c, room, S, list, t) {
        if (this.board) {
          const b = this.board;
          c.fillStyle = 'rgba(240,240,230,.85)';
          c.font = `14px "Comic Sans MS", ${C.ui.FONT}`;
          c.textAlign = 'left';
          c.textBaseline = 'top';
          const lines = ['∂x/∂t = f(x)', 'O(n log n)', 'git push ≠ deploy', 'E = mc²'];
          lines.forEach((l, i) => { if ((i + 1) * 20 < b.h * S - 8) c.fillText(l, b.x * S + 8, b.y * S + 6 + i * 20); });
        }
        if (this.term) {
          const tr = this.term;
          const cmds = (C.buildingInfo.laboratorio && C.buildingInfo.laboratorio.history) || [];
          c.font = `12px Consolas, "Courier New", monospace`;
          c.textAlign = 'left';
          c.textBaseline = 'top';
          const maxLines = Math.floor((tr.h * S - 12) / 15);
          const maxChars = Math.floor((tr.w * S - 16) / 7);
          const lines = cmds.slice(0, maxLines - 1).reverse().map((h) => '$ ' + C.cleanText(h.text).replace(/^Bash: /, ''));
          lines.forEach((l, i) => {
            c.fillStyle = '#4dff88';
            c.fillText(l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l, tr.x * S + 8, tr.y * S + 6 + i * 15);
          });
          if (Math.floor(t * 2) % 2) {
            c.fillStyle = '#4dff88';
            c.fillRect(tr.x * S + 8, tr.y * S + 8 + lines.length * 15, 7, 12);
          }
        }
      },
    },

    correios: {
      wall: '#f3e7b0', wallDark: '#2e5fa3', floorA: '#c9b48a', floorB: '#bba57a',
      decorate(room, t) {
        // escaninhos
        const bx = room.x0 + 12, by = room.y0 + 6, cols = Math.floor((room.fw * 0.5) / 12), rows = Math.floor((room.wallH - 14) / 10);
        const rnd = seeded(3);
        px(bx - 2, by - 2, cols * 12 + 2, rows * 10 + 2, '#6b4423');
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            px(bx + c * 12, by + r * 10, 10, 8, '#3e2716');
            if (rnd() < 0.55) px(bx + c * 12 + 2, by + r * 10 + 3, 6, 5, rnd() < 0.5 ? '#fdf6e3' : '#e8d36a');
          }
        }
        // modem com luzes
        const mx = room.x1 - 46, my = room.y0 + 14;
        px(mx, my, 30, 10, '#2c2c3a');
        for (let i = 0; i < 5; i++) px(mx + 3 + i * 5, my + 3, 2, 2, Math.sin(t * 8 + i * 1.7) > 0 ? '#4dff88' : '#1d4d2c');
        px(mx + 26, my - 10, 1, 10, '#555');
        // relógio
        const cx = room.x1 - 70, cy = room.y0 + 18;
        px(cx - 6, cy - 6, 12, 12, '#fff');
        px(cx - 0.5, cy - 4, 1, 4, '#222');
        px(cx, cy, 3, 1, '#222');
      },
      desk: (x, y, t, p) => {
        px(x - 15, y - 7, 30, 3, '#2e5fa3');
        px(x - 15, y - 4, 30, 7, '#24497d');
        px(x - 15, y - 1, 30, 1, '#e8d36a');
        px(x + 6, y - 11, 5, 4, '#c0392b'); // carimbo
        if (p) px(x - 10, y - 10, 8, 4, '#fdf6e3');
      },
      tick(room, list) {
        for (const p of list) {
          const q = pos.get(p.key);
          if (q && !q.walking && p.working && Math.random() < 0.04) {
            fx.push({ x: q.x, y: q.y - 14, vx: 25 + Math.random() * 20, vy: -20 - Math.random() * 10, life: 1.6, max: 1.6, c: '#fdf6e3', size: 3 });
          }
        }
      },
    },

    outros: {
      wall: '#c7bfd6', wallDark: '#5b4d7a', floorA: '#8f8577', floorB: '#83796b',
      decorate(room) {
        const rnd = seeded(9);
        for (let x = room.x0 + 10; x < room.x1 - 20; x += 22) {
          const stack = 1 + Math.floor(rnd() * 3);
          for (let s = 0; s < stack; s++) {
            const y = room.floorY - 12 - s * 12;
            px(x, y, 18, 12, '#c49a6c');
            px(x, y, 18, 1, '#a07850');
            px(x + 8, y, 2, 12, '#a07850');
          }
        }
      },
      desk: (x, y) => {
        px(x - 12, y - 8, 24, 11, '#c49a6c');
        px(x - 12, y - 8, 24, 1, '#a07850');
        px(x - 1, y - 8, 2, 11, '#a07850');
      },
    },

    praca: {
      wall: '#f0dcc0', wallDark: '#8b5a2b', floorA: '#efe9df', floorB: '#3b3b46',
      decorate(room, t, light) {
        // balcão com máquina de café
        const cx = room.x1 - 80;
        px(cx, room.floorY - 18, 70, 18, '#8b5a2b');
        px(cx, room.floorY - 18, 70, 2, '#6b4423');
        px(cx + 8, room.floorY - 32, 18, 14, '#9aa3ad');
        px(cx + 12, room.floorY - 26, 10, 4, '#2c2c3a');
        if (Math.random() < 0.15) fx.push({ x: cx + 17, y: room.floorY - 34, vx: (Math.random() - 0.5) * 3, vy: -6, life: 1.4, max: 1.4, c: '#ffffff', size: 2 });
        // cardápio
        const bx = room.x0 + 14, by = room.y0 + 8, bw = Math.min(120, room.fw * 0.32), bh = room.wallH - 22;
        px(bx - 2, by - 2, bw + 4, bh + 4, '#6b4423');
        px(bx, by, bw, bh, '#2b2b2b');
        this.board = { x: bx, y: by, w: bw, h: bh };
        windowOnWall(room.x0 + bw + 30, room.y0 + 10, 26, 20, light);
        plant(room.x0 + 8, room.floorY + 10);
      },
      desk: (x, y, t, p) => {
        // mesa redonda de café (o agente fica "sentado" atrás)
        C.px(x - 9, y - 6, 18, 4, '#f5f5f5');
        C.px(x - 1, y - 2, 2, 6, '#555');
        C.px(x - 4, y + 4, 8, 1, '#555');
        if (p) {
          C.px(x + 2, y - 9, 3, 3, '#fff');
          if (Math.random() < 0.05) fx.push({ x: x + 3.5, y: y - 10, vx: 0, vy: -5, life: 1, max: 1, c: '#fff', size: 1 });
        }
      },
      overlay(c, room, S) {
        if (!this.board) return;
        const b = this.board;
        c.fillStyle = '#f5f0e0';
        c.font = `bold 13px "Comic Sans MS", ${C.ui.FONT}`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        const lines = ['☕ Cardápio', 'Espresso de cache', 'Latte sem tokens', 'Chá de contexto', 'Bolo de commit'];
        lines.forEach((l, i) => { if ((i + 1) * 18 < b.h * S - 6) c.fillText(l, b.x * S + 8, b.y * S + 6 + i * 18); });
      },
    },
  };

  function themeOf(id) { return THEMES[id] || DEFAULT_THEME; }

  function wrapText(c, text, x, y, maxW, lineH, maxLines) {
    const words = String(text).split(/\s+/);
    let line = '', n = 0;
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (c.measureText(test).width > maxW && line) {
        n++;
        if (n >= maxLines) { c.fillText(line + '…', x, y); return; }
        c.fillText(line, x, y);
        y += lineH;
        line = words[i];
      } else line = test;
    }
    if (line) c.fillText(line, x, y);
  }

  // ---------------------------------------------------------------------------
  // Desenho
  // ---------------------------------------------------------------------------
  let lastRoom = null;
  let lastList = [];

  function drawWorld(g, id, t, dt) {
    const room = roomGeo();
    const th = themeOf(id);
    const light = C.lightAt();
    lastRoom = room;

    px(0, 0, C.view.W, C.view.H, '#14171f');
    // parede
    px(room.x0, room.y0, room.fw, room.wallH, th.wall);
    px(room.x0, room.floorY - 8, room.fw, 8, th.wallDark);
    px(room.x0, room.floorY - 1, room.fw, 1, 'rgba(0,0,0,.35)');
    // piso xadrez
    const tile = 8;
    for (let y = room.floorY; y < room.y1; y += tile) {
      for (let x = room.x0; x < room.x1; x += tile) {
        const odd = ((x - room.x0) / tile + (y - room.floorY) / tile) % 2;
        px(x, y, Math.min(tile, room.x1 - x), Math.min(tile, room.y1 - y), odd ? th.floorB : th.floorA);
      }
    }
    px(room.x0, room.floorY, room.fw, 3, 'rgba(0,0,0,.15)');
    if (th.decorate) th.decorate(room, t, light);

    const list = placeInsiders(id, room, dt);
    lastList = list;

    // estações vazias atrás, pessoas e móveis na frente, ordenados por y
    const occupied = new Map();
    for (const p of list) {
      const q = pos.get(p.key);
      if (q && q.station >= 0 && !q.walking) occupied.set(q.station, p);
    }
    const draws = [];
    room.stations.forEach((s, i) => draws.push({ y: s.y + 0.5, fn: () => (th.desk || DEFAULT_THEME.desk)(s.x, s.y, t, occupied.get(i)) }));
    for (const p of list) {
      const q = pos.get(p.key);
      draws.push({
        y: q.y,
        fn: () => {
          if (p.key === C.selected) {
            g.strokeStyle = '#ffd166';
            g.lineWidth = 1;
            g.beginPath();
            g.ellipse(q.x, q.y, 10 + Math.sin(t * 6) * 1.5, 4, 0, 0, Math.PI * 2);
            g.stroke();
          }
          q.headY = C.drawPersonAt(g, p, q.x, q.y, PERSON_SCALE, t, q.walking);
        },
      });
    }
    draws.sort((a, b) => a.y - b.y).forEach((d) => d.fn());

    // porta (saída)
    const d = room.door;
    px(d.x - 2, room.y1 - 2, d.w + 4, 8, '#14171f');
    px(d.x, room.y1 - 6, d.w, 5, '#8b3a3a');
    px(d.x + 2, room.y1 - 5, d.w - 4, 3, '#a84a4a');

    if (th.tick) th.tick.call(th, room, list, t);
    C.drawParticles(g, fx, dt);
    if (light.name === 'noite') { g.fillStyle = 'rgba(12,20,70,.18)'; g.fillRect(0, 0, C.view.W, C.view.H); }
  }

  function drawOverlay(c, id, t, hover) {
    const room = lastRoom;
    if (!room) return;
    const S = C.view.SCALE;
    const th = themeOf(id);
    const b = BUILDINGS[id];
    if (th.overlay) th.overlay.call(th, c, room, S, lastList, t);

    // cabeçalho
    const info = C.buildingInfo[id] || {};
    const lvl = C.defs.levelOf(id, C.lifetime);
    const title = `${b.icon} ${lvl.name}${lvl.level ? '  ' + '★'.repeat(lvl.level) : ''}`;
    const sub = `${lastList.length} lá dentro · ${info.visitsToday || 0} visitas hoje · Esc ou a porta para sair`;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.font = `bold 16px ${C.ui.FONT}`;
    const w = Math.max(c.measureText(title).width, (c.font = `12px ${C.ui.FONT}`, c.measureText(sub).width)) + 24;
    c.fillStyle = 'rgba(20,24,36,.82)';
    C.ui.roundRect(c, 12, room.floorY * S - 52, w, 44, 6);
    c.fill();
    c.fillStyle = '#fff';
    c.font = `bold 16px ${C.ui.FONT}`;
    c.fillText(title, 24, room.floorY * S - 38);
    c.fillStyle = '#b8c0d4';
    c.font = `12px ${C.ui.FONT}`;
    c.fillText(sub, 24, room.floorY * S - 19);

    // placa de saída
    const isDoorHover = hover && hover.kind === 'door';
    c.font = `bold 12px ${C.ui.FONT}`;
    c.textAlign = 'center';
    const dx = (room.door.x + room.door.w / 2) * S;
    const label = '🚪 Voltar à cidade';
    const lw = c.measureText(label).width + 16;
    c.fillStyle = isDoorHover ? 'rgba(255,209,102,.95)' : 'rgba(20,24,36,.8)';
    C.ui.roundRect(c, dx - lw / 2, room.y1 * S - 44, lw, 22, 5);
    c.fill();
    c.fillStyle = isDoorHover ? '#1b2030' : '#fff';
    c.fillText(label, dx, room.y1 * S - 32);

    // nomes e balões
    for (const p of lastList) {
      const q = pos.get(p.key);
      if (!q) continue;
      C.ui.nameTag(p, q.x * S, q.y * S + 4);
    }
    for (const p of lastList) {
      const q = pos.get(p.key);
      if (!q || q.headY == null) continue;
      C.ui.personBubble(p, q.x * S, q.headY * S, t, true);
    }

    if (!lastList.length) {
      c.font = `600 14px ${C.ui.FONT}`;
      c.textAlign = 'center';
      c.fillStyle = 'rgba(20,24,36,.75)';
      const msg = 'Ninguém aqui agora.';
      const mw = c.measureText(msg).width + 24;
      C.ui.roundRect(c, C.view.areaW / 2 - mw / 2, (room.floorY + room.fh / 2) * S - 16, mw, 30, 6);
      c.fill();
      c.fillStyle = '#e8ebf2';
      c.fillText(msg, C.view.areaW / 2, (room.floorY + room.fh / 2) * S - 1);
    }
  }

  function hitTest(id, wx, wy) {
    const room = lastRoom;
    if (!room) return null;
    let best = null, bestD = 14;
    for (const p of lastList) {
      const q = pos.get(p.key);
      if (!q) continue;
      const d = Math.hypot(q.x - wx, q.y - 10 - wy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best) return { kind: 'person', key: best.key };
    const d = room.door;
    if (wx >= d.x - 30 && wx <= d.x + d.w + 30 && wy >= room.y1 - 18) return { kind: 'door' };
    return null;
  }

  C.interiors = { drawWorld, drawOverlay, hitTest, THEMES, insiders };
})();

// Arte da cidade: paleta, chão e ruas (em cache), prédios, casas, mobiliário,
// sombras e iluminação. O city.js decide O QUE acontece; este arquivo decide
// COMO fica bonito.
//
// Para mudar o visual:
//   - cores gerais: objeto PAL logo abaixo;
//   - cores de cada prédio: `wall`/`roof` em public/buildings.js;
//   - formato de cada prédio: as funções em DRAWERS (uma por prédio).

(() => {
  'use strict';

  const C = window.Cidade;
  const { BUILDINGS, LAYOUT } = C.defs;

  // ---------------------------------------------------------------------------
  // Paleta
  // ---------------------------------------------------------------------------
  const PAL = {
    outline: '#1d1a26',
    grass: ['#4c8644', '#5a9a4e', '#68aa59'],      // sombra, base, luz
    tuft: '#3d7337',
    flowers: ['#ff8fab', '#ffe066', '#ffffff', '#b8a4ff'],
    asphalt: ['#3d414a', '#464a54', '#50545f'],
    lane: '#e8c95a',
    zebra: '#e9e6dc',
    sidewalk: ['#9a9488', '#b7b1a4', '#cbc5b8'],   // junta, base, luz
    curb: '#7b766b',
    cobble: ['#6f6553', '#8c806b', '#a39680'],
    street: ['#9f8f72', '#b5a485', '#c6b698'],
    hedge: ['#2c6532', '#3b7e40', '#4d9650'],
    wood: ['#5d3d29', '#7a5236', '#9c6c48'],
    glassDay: '#5f8fb3', glassNight: '#27314a', glassLit: '#ffd98a', glassHi: '#b4dcf5',
    frame: '#efe7d3', sill: '#d4cab2',
    gold: '#f2c94c',
    shadow: 'rgba(14,22,38,.22)',
    lampOn: '#ffe9a8', lampOff: '#77707a', pole: '#3a3a46',
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  let G = null; // contexto atual
  function px(x, y, w, h, c) {
    G.fillStyle = c;
    G.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  const shadeCache = new Map();
  // f < 0 escurece, f > 0 clareia.
  function shade(hex, f) {
    const key = hex + f;
    if (shadeCache.has(key)) return shadeCache.get(key);
    let h = hex.replace('#', '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const n = parseInt(h, 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f));
    const out = `rgb(${ch[0]},${ch[1]},${ch[2]})`;
    shadeCache.set(key, out);
    return out;
  }

  function seeded(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Semicírculo (cúpulas) com contorno, linha a linha.
  function dome(cx, baseY, R, color, opts) {
    opts = opts || {};
    for (let dy = 0; dy <= R + 1; dy++) {
      const hw = Math.round(Math.sqrt(Math.max(0, (R + 1) * (R + 1) - dy * dy)));
      px(cx - hw, baseY - dy, hw * 2, 1, PAL.outline);
    }
    for (let dy = 0; dy <= R; dy++) {
      const hw = Math.round(Math.sqrt(Math.max(0, R * R - dy * dy)));
      if (opts.alpha) G.globalAlpha = opts.alpha;
      px(cx - hw, baseY - dy, hw, 1, shade(color, 0.12));
      px(cx, baseY - dy, hw, 1, shade(color, -0.12));
      G.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Luzes do quadro (usadas pelo mapa de luz à noite)
  // ---------------------------------------------------------------------------
  const lights = [];
  let lightsOn = false;
  function addLight(x, y, r, a, warm) {
    if (lightsOn) lights.push({ x, y, r, a: a == null ? 0.8 : a, warm: warm || '255,214,140' });
  }

  // ---------------------------------------------------------------------------
  // Camada estática (chão, ruas, calçadas, cercas vivas) — gerada no resize
  // ---------------------------------------------------------------------------
  let staticCv = null;
  let furniture = [];
  let puddles = [];
  let portWater = null;

  function rebuild() {
    const geo = C.geo;
    const { W, H } = C.view;
    staticCv = document.createElement('canvas');
    staticCv.width = W; staticCv.height = H;
    const prev = G;
    G = staticCv.getContext('2d');
    const rnd = seeded(1234);

    // grama com dithering, tufos e florzinhas
    px(0, 0, W, H, PAL.grass[1]);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = rnd();
        if (r < 0.07) px(x, y, 1, 1, PAL.grass[0]);
        else if (r < 0.12) px(x, y, 1, 1, PAL.grass[2]);
      }
    }
    for (let i = 0; i < (W * H) / 120; i++) {
      const x = rnd() * W, y = rnd() * H;
      px(x, y, 1, 2, PAL.tuft); px(x + 1, y - 1, 1, 2, PAL.tuft); px(x + 2, y, 1, 2, PAL.tuft);
    }
    for (let i = 0; i < (W * H) / 900; i++) px(rnd() * W, rnd() * H, 1, 1, PAL.flowers[i % PAL.flowers.length]);

    const last = geo.avenues[geo.avenues.length - 1];
    const yTop = geo.top, yBottom = last.y + last.h;

    // vielas de paralelepípedo
    for (const ax of geo.alleys) {
      const x0 = ax - 4;
      px(x0, yTop, 8, yBottom - yTop, PAL.cobble[0]);
      for (let y = yTop, row = 0; y < yBottom; y += 3, row++) {
        for (let x = x0 + (row % 2 ? 1 : 0); x < x0 + 8; x += 3) px(x, y, 2, 2, rnd() < 0.5 ? PAL.cobble[1] : PAL.cobble[2]);
      }
      px(x0 - 1, yTop, 1, yBottom - yTop, PAL.curb);
      px(x0 + 8, yTop, 1, yBottom - yTop, PAL.curb);
    }

    // avenidas: asfalto, calçadas com ladrilho e meio-fio, faixa, faixas de pedestre, bueiros
    for (const a of geo.avenues) {
      if (a.street) {
        px(0, a.y, W, a.h, PAL.street[0]);
        for (let y = a.y, row = 0; y < a.y + a.h; y += 3, row++) {
          for (let x = row % 2 ? 1 : 0; x < W; x += 4) px(x, y, 3, 2, rnd() < 0.5 ? PAL.street[1] : PAL.street[2]);
        }
        px(0, a.y, W, 1, PAL.curb);
        continue;
      }
      px(0, a.y, W, a.h, PAL.asphalt[1]);
      for (let i = 0; i < (W * a.h) / 14; i++) px(rnd() * W, a.y + 3 + rnd() * (a.h - 6), 1, 1, rnd() < 0.5 ? PAL.asphalt[0] : PAL.asphalt[2]);
      for (const sy of [a.y, a.y + a.h - 3]) {
        px(0, sy, W, 3, PAL.sidewalk[1]);
        px(0, sy, W, 1, PAL.sidewalk[2]);
        for (let x = (sy === a.y ? 0 : 2); x < W; x += 4) px(x, sy, 1, 3, PAL.sidewalk[0]);
      }
      px(0, a.y + 3, W, 1, PAL.curb);
      px(0, a.y + a.h - 4, W, 1, PAL.curb);
      for (let x = 0; x < W; x += 12) px(x, Math.round(a.mid), 6, 1, PAL.lane);
      for (const ax of geo.alleys) {
        px(ax - 5, a.y + 4, 10, a.h - 8, PAL.asphalt[1]);
        for (let x = ax - 4; x < ax + 4; x += 2) px(x, a.y + 5, 1, a.h - 10, PAL.zebra);
      }
      for (let i = 0; i < 3; i++) {
        const mx = 20 + rnd() * (W - 40);
        if (geo.alleys.some((ax) => Math.abs(ax - mx) < 10)) continue;
        px(mx - 1, a.y + a.h - 7, 3, 2, '#2c2f36'); px(mx, a.y + a.h - 7, 1, 2, '#5d616b');
      }
    }

    // cercas vivas na faixa de grama acima dos prédios
    for (const L of LAYOUT) {
      if (BUILDINGS[L.id].park) continue;
      const r = geo.rects[L.id];
      const row = geo.rows[L.row];
      if (r.y - row.y < 10) continue;
      for (let x = r.x - 2; x < r.x + r.w + 2; x += 3) {
        px(x, row.y + 1, 3, 3, PAL.hedge[1]);
        px(x, row.y + 1, 2, 1, PAL.hedge[2]);
        px(x, row.y + 3, 3, 1, PAL.hedge[0]);
      }
    }
    G = prev;

    // Água do porto: na faixa de grama acima do Correios (metade direita).
    portWater = null;
    const rc = geo.rects.correios;
    if (rc) {
      const row = geo.rows[rc.row];
      const free = rc.y - row.y;
      if (free >= 12) portWater = { x: rc.x + Math.round(rc.w * 0.45), y: row.y + 5, w: Math.round(rc.w * 0.55), h: free - 9 };
    }

    // mobiliário urbano (posições fixas)
    furniture = [];
    const fr = seeded(77);
    geo.avenues.slice(0, 2).forEach((a, ai) => {
      const sy = a.y + a.h - 1;
      geo.alleys.forEach((ax, k) => {
        if (k === 0 || k === geo.alleys.length - 1) return;
        furniture.push({ type: 'bench', x: ax + 7, y: sy });
        furniture.push({ type: 'bin', x: ax - 8, y: sy });
        if (k === (ai === 0 ? 1 : 3)) furniture.push({ type: 'semaforo', x: ax + 5, y: sy, phase: ai * 5 });
      });
      furniture.push({ type: 'hidrante', x: geo.alleys[0] + 7 + ai * 3, y: sy });
    });
    const rp = geo.rects.prefeitura;
    if (rp) furniture.push({ type: 'onibus', x: rp.x + Math.round(rp.w * 0.78), y: geo.avenues[0].y + geo.avenues[0].h - 1 });

    puddles = [];
    for (let i = 0; i < 10; i++) {
      const a = geo.avenues[Math.floor(fr() * 2)];
      puddles.push({ x: 10 + fr() * (W - 20), y: a.y + 5 + fr() * (a.h - 10), w: 5 + Math.floor(fr() * 6) });
    }
  }

  function drawGround(g) {
    if (!staticCv || staticCv.width !== C.view.W || staticCv.height !== C.view.H) rebuild();
    g.drawImage(staticCv, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Sol, sombras e nuvens
  // ---------------------------------------------------------------------------
  function sun() {
    const d = new Date(C.now());
    const h = d.getHours() + d.getMinutes() / 60;
    if (h < 6.5 || h > 18.5) return null;
    const k = (h - 12.5) / 6; // -1 (manhã) … 1 (fim de tarde)
    return { dx: -k, len: 0.3 + Math.abs(k) * 0.6 };
  }

  function drawShadows(g, houses) {
    const s = sun();
    if (!s) return;
    G = g;
    G.fillStyle = PAL.shadow;
    const shadowOf = (x, y, w, h) => {
      const off = s.dx * h * s.len;
      G.beginPath();
      G.moveTo(x, y + h);
      G.lineTo(x + w, y + h);
      G.lineTo(x + w + off, y + h - h * 0.45);
      G.lineTo(x + off, y + h - h * 0.45);
      G.closePath();
      G.fill();
    };
    for (const L of LAYOUT) {
      if (BUILDINGS[L.id].park) continue;
      const r = C.geo.rects[L.id];
      shadowOf(r.x, r.y, r.w, r.h);
    }
    for (const h of houses || []) shadowOf(h.x, h.y, h.w, h.h);
    for (const tr of C.geo.trees) {
      G.beginPath();
      G.ellipse(tr.x + s.dx * 5 * s.len, tr.y, 5 * tr.s + 1, 2, 0, 0, Math.PI * 2);
      G.fill();
    }
  }

  function drawCloudShadows(g, t) {
    if (!sun() || !C.life || !C.life.clouds) return;
    G = g;
    G.fillStyle = 'rgba(14,22,38,.07)';
    for (const c of C.life.clouds) {
      G.beginPath();
      G.ellipse(c.x + c.w / 2 + 12, c.y + C.view.H * 0.45, c.w * 0.9, c.w * 0.35, 0, 0, Math.PI * 2);
      G.fill();
    }
  }

  function drawPuddles(g, t) {
    const level = C.life ? C.life.rainLevel : 0;
    if (level <= 0.01) return;
    G = g;
    G.globalAlpha = 0.55 * level;
    for (const p of puddles) {
      px(p.x, p.y, p.w, 2, '#6f86a8');
      px(p.x + 1, p.y - 1, p.w - 2, 1, '#6f86a8');
      const shimmer = Math.floor(t * 3 + p.x) % p.w;
      px(p.x + shimmer, p.y, 1, 1, '#c9dcf5');
    }
    G.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Árvores, postes e mobiliário
  // ---------------------------------------------------------------------------
  function inPort(x, y) {
    const w = portWater;
    return w && x > w.x - 4 && x < w.x + w.w + 4 && y > w.y - 4 && y < w.y + w.h + 6;
  }

  function drawTree(tr, i) {
    const s = tr.s;
    const kind = i % 5 === 2 ? 'pine' : i % 5 === 4 ? 'flor' : 'round';
    px(tr.x - 1, tr.y - 3 * s, 2, 3 * s + 1, '#5d3d29');
    if (kind === 'pine') {
      const h = Math.round(10 * s);
      for (let k = 0; k < h; k++) {
        const hw = Math.round((k / h) * 4 * s) + 1;
        px(tr.x - hw - 1, tr.y - 3 * s - h + k, hw * 2 + 2, 1, PAL.outline);
      }
      for (let k = 0; k < h; k++) {
        const hw = Math.round((k / h) * 4 * s) + 1;
        px(tr.x - hw, tr.y - 3 * s - h + k, hw, 1, '#2f7a46');
        px(tr.x, tr.y - 3 * s - h + k, hw, 1, '#256338');
      }
      return;
    }
    const R = 5 * s;
    const top = kind === 'flor' ? '#e8a0b8' : '#3a8a44';
    const dark = kind === 'flor' ? '#c97c98' : '#2c6e36';
    const cy = tr.y - 6 * s;
    G.fillStyle = PAL.outline;
    G.beginPath(); G.arc(tr.x, cy, R + 1, 0, Math.PI * 2); G.fill();
    G.fillStyle = dark;
    G.beginPath(); G.arc(tr.x, cy, R, 0, Math.PI * 2); G.fill();
    G.fillStyle = top;
    G.beginPath(); G.arc(tr.x - 1, cy - 1, R - 1.2, 0, Math.PI * 2); G.fill();
    px(tr.x - 2 * s, cy - 3 * s, 2, 1, shade(top, 0.3));
    if (kind === 'flor') { px(tr.x + 1, cy - 1, 1, 1, '#fff'); px(tr.x - 3, cy + 1, 1, 1, '#fff'); }
  }

  function drawTrees(g) {
    G = g;
    C.geo.trees.forEach((tr, i) => { if (!inPort(tr.x, tr.y)) drawTree(tr, i); });
  }

  function drawLamp(l, on) {
    px(l.x, l.y - 10, 1, 10, PAL.pole);
    px(l.x - 1, l.y - 11, 3, 1, PAL.outline);
    px(l.x - 1, l.y - 10, 3, 2, on ? PAL.lampOn : PAL.lampOff);
    if (on) addLight(l.x, l.y - 6, 22, 0.95);
  }

  function drawFurniture(g, t, night) {
    G = g;
    for (const f of furniture) {
      const { x, y } = f;
      if (f.type === 'bench') {
        px(x - 1, y - 3, 7, 1, PAL.outline);
        px(x, y - 3, 5, 1, PAL.wood[2]);
        px(x, y - 2, 5, 1, PAL.wood[1]);
        px(x, y - 1, 1, 1, PAL.pole); px(x + 4, y - 1, 1, 1, PAL.pole);
      } else if (f.type === 'bin') {
        px(x - 1, y - 4, 4, 4, PAL.outline);
        px(x, y - 3, 2, 3, '#3f7f5a');
        px(x, y - 4, 2, 1, '#5a9a74');
      } else if (f.type === 'hidrante') {
        px(x - 1, y - 4, 3, 4, '#c0392b');
        px(x - 2, y - 3, 5, 1, '#c0392b');
        px(x, y - 5, 1, 1, '#e74c3c');
      } else if (f.type === 'semaforo') {
        px(x, y - 12, 1, 12, PAL.pole);
        px(x - 2, y - 17, 5, 7, PAL.outline);
        const cyc = (t + f.phase) % 12;
        const state = cyc < 6 ? 2 : cyc < 8 ? 1 : 0; // 0 vermelho, 1 amarelo, 2 verde
        px(x - 1, y - 16, 3, 1, state === 0 ? '#ff4d4d' : '#4a1f1f');
        px(x - 1, y - 14, 3, 1, state === 1 ? '#ffd166' : '#4a3f1f');
        px(x - 1, y - 12, 3, 1, state === 2 ? '#3ddc84' : '#1f4a2c');
        if (night) addLight(x, y - 14, 8, 0.6, state === 0 ? '255,90,90' : state === 1 ? '255,210,100' : '90,230,140');
      } else if (f.type === 'onibus') {
        px(x - 1, y - 11, 13, 1, PAL.outline);
        px(x, y - 10, 11, 1, '#2e5fa3');
        px(x, y - 9, 1, 9, PAL.pole); px(x + 10, y - 9, 1, 9, PAL.pole);
        G.globalAlpha = 0.45; px(x + 1, y - 9, 9, 6, '#b4dcf5'); G.globalAlpha = 1;
        px(x + 2, y - 3, 7, 1, PAL.wood[2]);
        px(x + 11, y - 13, 3, 3, '#ffd166');
        px(x + 12, y - 10, 1, 10, PAL.pole);
        if (night) addLight(x + 5, y - 7, 10, 0.6);
      }
    }
    for (const l of C.geo.lamps) drawLamp(l, night);
  }

  // ---------------------------------------------------------------------------
  // Peças dos prédios
  // ---------------------------------------------------------------------------
  // Caixa em vista 3/4: fachada + lateral direita mais escura + contorno.
  function box(r, wall, roofH) {
    const side = 4;
    const fy = r.y + roofH, fw = r.w - side, bottom = r.y + r.h;
    px(r.x - 1, fy - 1, r.w + 2, bottom - fy + 2, PAL.outline);
    px(r.x, fy, fw, bottom - fy, wall);
    px(r.x, fy, 1, bottom - fy, shade(wall, 0.2));
    px(r.x + fw, fy, side, bottom - fy, shade(wall, -0.22));
    px(r.x + fw, fy, 1, bottom - fy, shade(wall, -0.34));
    px(r.x, bottom - 2, r.w, 2, shade(wall, -0.3));
    return { side, fy, fw, bottom };
  }

  // Telhado com telhas: fileiras alternadas, cumeeira clara e beiral escuro.
  function shingles(x, y, w, h, color) {
    const dk = shade(color, -0.25);
    px(x - 1, y - 1, w + 2, h + 1, PAL.outline);
    px(x, y, w, h, color);
    for (let yy = 0; yy < h; yy += 2) {
      px(x, y + yy + 1, w, 1, dk);
      for (let xx = (yy / 2) % 2 ? 2 : 0; xx < w; xx += 4) px(x + xx, y + yy, 1, 1, dk);
    }
    px(x, y, w, 1, shade(color, 0.2));
    px(x + w - 4, y, 4, h, 'rgba(0,0,0,.18)'); // água do telhado do lado da sombra
    px(x, y + h - 1, w, 1, shade(color, -0.45));
  }

  // Janelas em grade na fachada (pula a porta e a placa).
  function windows(id, r, bx, opt) {
    const top = bx.fy + (opt.top || 4);
    const usable = bx.fw - 8;
    const cols = Math.max(2, Math.floor(usable / (opt.cw || 13)));
    const rows = Math.max(1, Math.floor((bx.bottom - top - 15) / 12) + 1);
    const ww = opt.ww || 5, wh = opt.wh || 6;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const wx = Math.round(r.x + 4 + cx * (usable / cols) + (usable / cols - ww) / 2);
        const wy = top + cy * 12;
        if (wy + wh > bx.bottom - 3) continue;
        const box2 = { x: wx - 1, y: wy - 1, w: ww + 2, h: wh + 4 };
        if ((opt.skip || []).some((s) => box2.x < s.x + s.w && box2.x + box2.w > s.x && box2.y < s.y + s.h && box2.y + box2.h > s.y)) continue;
        const litChance = (hash(id + cx + '-' + cy) % 100) / 100;
        const lit = opt.active || (opt.night && litChance < 0.65);
        windowAt(wx, wy, ww, wh, lit, opt);
      }
    }
  }

  function windowAt(wx, wy, ww, wh, lit, opt) {
    px(wx - 1, wy - 1, ww + 2, wh + 2, PAL.frame);
    const glass = lit ? (opt.litColor || PAL.glassLit) : opt.night ? PAL.glassNight : PAL.glassDay;
    px(wx, wy, ww, wh, glass);
    if (opt.arched) { px(wx, wy, 1, 1, PAL.frame); px(wx + ww - 1, wy, 1, 1, PAL.frame); }
    px(wx + Math.floor(ww / 2), wy, 1, wh, PAL.frame);
    if (!lit) px(wx + 1, wy + 1, 1, 2, PAL.glassHi);
    px(wx - 1, wy + wh, ww + 2, 1, PAL.sill);
    if (opt.level >= 1) {
      px(wx - 1, wy + wh + 1, ww + 2, 1, '#7a4b3a');
      px(wx, wy + wh, 1, 1, '#ff8fab'); px(wx + 2, wy + wh, 1, 1, '#ffe066'); px(wx + 4, wy + wh, 1, 1, '#ff8fab');
    }
    if (lit && opt.night) addLight(wx + ww / 2, wy + wh / 2, 9, 0.55, opt.litRGB);
  }

  function door(cx, bottom, opt) {
    const w = opt.w || 8, h = opt.h || 11;
    px(cx - w / 2 - 1, bottom - h - 1, w + 2, h + 1, PAL.outline);
    px(cx - w / 2, bottom - h, w, h, opt.color || '#4a3020');
    px(cx - w / 2 + 1, bottom - h + 1, w - 2, 1, shade(opt.color || '#4a3020', 0.2));
    if (!opt.rollup) px(cx + w / 2 - 2, bottom - h / 2, 1, 1, PAL.gold);
    else for (let y = bottom - h + 2; y < bottom; y += 2) px(cx - w / 2, y, w, 1, shade(opt.color, -0.2));
    px(cx - w / 2 - 2, bottom - 1, w + 4, 1, '#cfc7b4'); // degrau
    if (opt.awning) {
      const aw = w + 6, ay = bottom - h - 4;
      px(cx - aw / 2 - 1, ay - 1, aw + 2, 4, PAL.outline);
      for (let i = 0; i < aw; i++) px(cx - aw / 2 + i, ay, 1, 3, Math.floor(i / 2) % 2 ? opt.awning : '#f5f0e6');
    }
  }

  // Placa na fachada: a moldura é desenhada aqui; o texto vai na camada de alta resolução.
  const signs = {};
  function sign(id, r, bx, style) {
    const doorTop = bx.bottom - 11 - 4;
    const { w, h } = signSize(id, bx.fw - 6);
    return signAt(id, Math.round(r.x + bx.fw / 2 - w / 2), doorTop - h - 2, bx.fw - 6, style);
  }

  function signSize(id, maxW) {
    const S = C.view.SCALE;
    const lvl = C.defs.levelOf(id, C.lifetime);
    const wCss = lvl.name.length * 6.3 + (lvl.level ? lvl.level * 8 + 4 : 0) + 12;
    return { w: Math.min(maxW, Math.ceil(wCss / S)), h: Math.ceil(15 / S) + 2, lvl };
  }

  function signAt(id, x, y, maxW, style) {
    const { w, h, lvl } = signSize(id, maxW);
    const text = lvl.name;
    const stars = lvl.level;
    const face = style === 'metal' ? '#2f3e52' : style === 'pedra' ? '#e8e0cc' : '#e9d8b0';
    const edge = style === 'metal' ? '#9aa3ad' : style === 'pedra' ? '#b9ad92' : PAL.wood[1];
    px(x - 1, y - 1, w + 2, h + 2, PAL.outline);
    px(x, y, w, h, edge);
    px(x + 1, y + 1, w - 2, h - 2, face);
    signs[id] = { x, y, w, h, text, stars, dark: style === 'metal' };
    return { x: x - 2, y: y - 2, w: w + 4, h: h + 4 };
  }

  function eaveLights(r, y, t, night) {
    const colors = ['#ff5c5c', '#ffd166', '#3ddc84', '#7ac8ff'];
    for (let x = r.x + 1, i = 0; x < r.x + r.w - 1; x += 3, i++) {
      const on = !night || (Math.floor(t * 2) + i) % 3 !== 0;
      px(x, y + (i % 2), 1, 1, on ? colors[i % 4] : '#555');
      if (on && night && i % 3 === 0) addLight(x, y, 6, 0.4, '255,220,160');
    }
  }

  function goldTrim(r, y) {
    px(r.x - 2, y, r.w + 4, 1, PAL.gold);
  }

  function smoke(x, y, color, chance) {
    if (C.life && C.life.particles && Math.random() < chance) {
      C.life.particles.push({ x, y, vx: (Math.random() - 0.3) * 4, vy: -6 - Math.random() * 4, life: 2.2, max: 2.2, c: color });
    }
  }

  // ---------------------------------------------------------------------------
  // Um desenhista por prédio
  // ---------------------------------------------------------------------------
  const DRAWERS = {
    prefeitura(r, b, o) {
      const roofH = Math.max(8, Math.round(r.h * 0.24));
      const bx = box(r, b.wall, roofH);
      shingles(r.x - 1, r.y, r.w + 2, roofH, b.roof);
      // frontão triangular com relógio
      const cx = r.x + bx.fw / 2, ph = Math.min(roofH + 2, 10);
      for (let i = 0; i <= ph; i++) {
        const hw = Math.round((ph - i) * 1.7) + 1;
        px(cx - hw - 1, bx.fy - i - 1, hw * 2 + 2, 1, PAL.outline);
      }
      for (let i = 0; i < ph; i++) {
        const hw = Math.round((ph - i) * 1.7);
        px(cx - hw, bx.fy - i - 1, hw * 2, 1, shade(b.wall, 0.25));
      }
      px(cx - 2, bx.fy - ph + 2, 5, 5, '#fff');
      px(cx - 2, bx.fy - ph + 2, 5, 1, PAL.outline);
      const d = new Date(C.now());
      px(cx, bx.fy - ph + 3, 1, 2, '#222');
      const m = d.getMinutes();
      px(cx + (m < 30 ? 1 : -1), bx.fy - ph + 4, 1, 1, '#222');
      const skip = [sign('prefeitura', r, bx, 'pedra')];
      windows('prefeitura', r, bx, { ...o, skip: skip.concat([{ x: cx - 6, y: bx.bottom - 16, w: 12, h: 16 }]) });
      // colunas
      for (let i = 0; i < 4; i++) {
        const colX = r.x + 4 + i * ((bx.fw - 10) / 3);
        px(colX - 1, bx.fy + 1, 4, 1, '#ffffff');
        px(colX, bx.fy + 2, 2, bx.bottom - bx.fy - 5, '#f4efe2');
        px(colX + 1, bx.fy + 2, 1, bx.bottom - bx.fy - 5, '#d8cfb8');
        px(colX - 1, bx.bottom - 4, 4, 1, '#d8cfb8');
      }
      door(cx, bx.bottom - 2, { w: 9, h: 11, color: '#5a3520' });
      px(r.x + 6, bx.bottom - 2, bx.fw - 12, 1, '#e6dfcd');
      px(r.x + 4, bx.bottom - 1, bx.fw - 8, 1, '#d8cfb8');
      // bandeira
      const fx = cx + 1;
      px(fx, r.y - 13, 1, 13, '#555');
      const wave = Math.sin(o.t * 4) > 0 ? 1 : 0;
      px(fx + 1, r.y - 13 + wave, 7, 4, '#2e9e5b');
      px(fx + 3, r.y - 12 + wave, 3, 2, '#f2d03b');
      if (o.level >= 2) { // estátua na escadaria
        const sx = r.x + 3;
        px(sx, bx.bottom - 4, 4, 3, '#b9ad92');
        px(sx + 1, bx.bottom - 9, 2, 5, '#8fa39a');
        px(sx + 1, bx.bottom - 11, 2, 2, '#8fa39a');
      }
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
    },

    biblioteca(r, b, o) {
      const roofH = Math.max(8, Math.round(r.h * 0.22));
      const bx = box(r, b.wall, roofH);
      shingles(r.x - 1, r.y, r.w + 2, roofH, shade(b.roof, 0.1));
      // cúpula central sobre um tambor
      const cx = Math.round(r.x + bx.fw / 2), R = Math.max(6, Math.round(r.w * 0.15));
      const baseY = r.y + 2;
      px(cx - R - 1, baseY - 1, R * 2 + 2, 4, PAL.outline);
      px(cx - R, baseY, R * 2, 2, shade(b.wall, 0.2));
      dome(cx, baseY - 1, R, b.roof);
      px(cx - Math.round(R / 2), baseY - R + 2, 1, R - 2, shade(b.roof, -0.3));
      px(cx + Math.round(R / 2), baseY - R + 2, 1, R - 2, shade(b.roof, -0.3));
      px(cx, baseY - R - 4, 1, 3, PAL.gold);
      if (o.level >= 2) { // lanterna no topo da cúpula
        px(cx - 2, baseY - R - 5, 5, 3, PAL.outline);
        px(cx - 1, baseY - R - 4, 3, 2, o.night ? PAL.lampOn : '#f4efe2');
        if (o.night) addLight(cx, baseY - R - 3, 12, 0.7);
      }
      // faixa de lombadas logo abaixo do beiral
      const colors = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad'];
      for (let i = 0; i < Math.floor((bx.fw - 6) / 3); i++) px(r.x + 3 + i * 3, bx.fy + 1, 2, 3, colors[i % 5]);
      const skip = [sign('biblioteca', r, bx, 'madeira'), { x: cx - 6, y: bx.bottom - 16, w: 12, h: 16 }];
      windows('biblioteca', r, bx, { ...o, skip, top: 7, arched: true, wh: 7 });
      door(cx, bx.bottom - 1, { w: 8, h: 11, color: '#3d2a1a', awning: '#3d5a80' });
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
    },

    oficina(r, b, o) {
      const roofH = Math.max(9, Math.round(r.h * 0.26));
      const bx = box(r, b.wall, roofH);
      // telhado de fábrica em dente de serra, com claraboias
      const n = Math.max(3, Math.floor(r.w / 15)), tw = (r.w + 2) / n;
      px(r.x - 1, r.y - 1, r.w + 2, roofH + 1, PAL.outline);
      for (let i = 0; i < n; i++) {
        const x0 = r.x - 1 + i * tw;
        for (let yy = 0; yy < roofH; yy++) {
          const wdt = Math.max(1, Math.round(tw * (yy + 1) / roofH));
          px(x0 + tw - wdt, r.y + yy, wdt, 1, yy % 2 ? shade(b.roof, -0.15) : b.roof);
        }
        px(x0, r.y + 1, 2, roofH - 1, o.night ? (o.active ? PAL.glassLit : PAL.glassNight) : PAL.glassHi);
        if (o.night && o.active) addLight(x0 + 1, r.y + roofH / 2, 8, 0.5);
      }
      px(r.x - 1, r.y + roofH - 1, r.w + 2, 1, shade(b.roof, -0.45));
      // chaminé(s)
      const chx = r.x + r.w - 12;
      px(chx - 1, r.y - 7, 7, roofH + 6, PAL.outline);
      px(chx, r.y - 6, 5, roofH + 5, '#7a4b3a');
      px(chx, r.y - 6, 5, 1, '#5c372a');
      if (o.active) smoke(chx + 2.5, r.y - 8, b.chimney || '#b9b9b9', 0.25);
      if (o.level >= 2) {
        const c2 = r.x + 8;
        px(c2 - 1, r.y - 5, 6, roofH + 4, PAL.outline);
        px(c2, r.y - 4, 4, roofH + 3, '#6b3f2a');
        if (o.active) smoke(c2 + 2, r.y - 6, '#a9a9a9', 0.15);
      }
      const cx = Math.round(r.x + bx.fw / 2);
      const skip = [sign('oficina', r, bx, 'madeira'), { x: cx - 9, y: bx.bottom - 16, w: 18, h: 16 }];
      windows('oficina', r, bx, { ...o, skip, cw: 14 });
      door(cx, bx.bottom - 1, { w: 13, h: 11, color: '#8a8f98', rollup: true });
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
    },

    laboratorio(r, b, o) {
      const roofH = Math.max(7, Math.round(r.h * 0.18));
      const bx = box(r, b.wall, roofH);
      // laje com parapeito
      px(r.x - 1, r.y - 1, r.w + 2, roofH + 1, PAL.outline);
      px(r.x, r.y, r.w, roofH, '#9aa3ad');
      for (let x = r.x; x < r.x + r.w; x += 5) px(x, r.y + 1, 1, roofH - 2, '#8a939d');
      px(r.x, r.y, r.w, 1, '#c7ccd6');
      px(r.x, r.y + roofH - 1, r.w, 1, '#6b737d');
      // tubos de ventilação
      for (const vx of [r.x + 5, r.x + 11]) {
        px(vx - 1, r.y - 6, 4, 7, PAL.outline);
        px(vx, r.y - 5, 2, 6, '#c7ccd6');
        px(vx - 1, r.y - 7, 4, 2, '#8a939d');
        if (o.active) smoke(vx + 1, r.y - 8, b.chimney || '#7dff9a', 0.12);
      }
      // cúpula de vidro
      const cx = Math.round(r.x + r.w * 0.66), R = Math.max(6, Math.round(r.w * 0.14));
      dome(cx, r.y + 2, R, '#9fe3ff', { alpha: 0.75 });
      px(cx - Math.round(R / 2), r.y + 2 - R + 2, 1, 2, '#ffffff');
      px(cx, r.y + 2 - R, 1, R, '#c7ccd6');
      if (o.active) addLight(cx, r.y, 16, 0.7, '120,255,170');
      if (o.level >= 2) { // antena parabólica
        const ax = r.x + r.w - 8;
        px(ax, r.y - 6, 1, 6, '#8a939d');
        px(ax - 3, r.y - 9, 6, 1, '#e8ecef'); px(ax - 2, r.y - 8, 4, 1, '#c7ccd6');
      }
      const cxd = Math.round(r.x + bx.fw / 2);
      const skip = [sign('laboratorio', r, bx, 'metal'), { x: cxd - 6, y: bx.bottom - 16, w: 12, h: 16 }];
      windows('laboratorio', r, bx, { ...o, skip, litColor: o.active ? '#a8ffc4' : null, litRGB: o.active ? '140,255,180' : null });
      door(cxd, bx.bottom - 1, { w: 8, h: 11, color: '#d8dee4', awning: '#3f7d5a' });
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
    },

    correios(r, b, o) {
      const roofH = Math.max(8, Math.round(r.h * 0.22));
      const bx = box(r, b.wall, roofH);
      shingles(r.x - 1, r.y, r.w + 2, roofH, b.roof);
      // torre do relógio à esquerda, com a hora real
      const tx = r.x + 3, tw = 12, ttop = r.y - 15;
      px(tx - 1, ttop - 1, tw + 2, roofH + 17, PAL.outline);
      px(tx, ttop, tw, roofH + 15, shade(b.wall, 0.12));
      px(tx + tw - 2, ttop, 2, roofH + 15, shade(b.wall, -0.15));
      for (let i = 0; i < 5; i++) px(tx - 1 + i, ttop - 2 - i, tw + 2 - 2 * i, 1, i ? b.roof : PAL.outline);
      const ccx = tx + tw / 2, ccy = ttop + 6;
      G.fillStyle = PAL.outline; G.beginPath(); G.arc(ccx, ccy, 4.5, 0, Math.PI * 2); G.fill();
      G.fillStyle = '#fdf6e3'; G.beginPath(); G.arc(ccx, ccy, 3.6, 0, Math.PI * 2); G.fill();
      const d = new Date(C.now());
      const ha = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2, ma = d.getMinutes() / 60 * Math.PI * 2;
      G.strokeStyle = '#222'; G.lineWidth = 1;
      G.beginPath(); G.moveTo(ccx, ccy); G.lineTo(ccx + Math.sin(ha) * 2, ccy - Math.cos(ha) * 2); G.stroke();
      G.beginPath(); G.moveTo(ccx, ccy); G.lineTo(ccx + Math.sin(ma) * 3, ccy - Math.cos(ma) * 3); G.stroke();
      if (o.night) addLight(ccx, ccy, 10, 0.6);
      // antena no alto da torre
      const ax = ccx;
      px(ax, ttop - 13, 1, 8, '#666');
      px(ax - 3, ttop - 10, 7, 1, '#666');
      const blink = o.active ? Math.sin(o.t * 10) > 0 : Math.sin(o.t * 2) > 0.6;
      px(ax - 1, ttop - 15, 3, 2, blink ? '#ff4d4d' : '#702020');
      if (blink && o.night) addLight(ax, ttop - 14, 8, 0.6, '255,90,90');
      if (o.active) {
        const k = (o.t * 2) % 1;
        G.strokeStyle = `rgba(255,255,255,${1 - k})`;
        G.beginPath(); G.arc(ax + 0.5, ttop - 14, 3 + k * 8, Math.PI * 1.15, Math.PI * 1.85); G.stroke();
      }
      if (o.level >= 2) { // bandeirola na torre
        px(tx + tw + 1, ttop - 6, 1, 6, '#555');
        px(tx + tw + 2, ttop - 6 + (Math.sin(o.t * 4) > 0 ? 1 : 0), 5, 3, '#e8d36a');
      }
      const cx = Math.round(r.x + bx.fw / 2) + 4;
      const skip = [sign('correios', r, bx, 'madeira'), { x: cx - 6, y: bx.bottom - 16, w: 12, h: 16 }, { x: tx - 2, y: bx.fy, w: tw + 4, h: 10 }];
      windows('correios', r, bx, { ...o, skip });
      door(cx, bx.bottom - 1, { w: 8, h: 11, color: '#24497d', awning: '#2e5fa3' });
      // caixa de correio na calçada da porta
      px(cx + 8, bx.bottom - 6, 4, 5, PAL.outline);
      px(cx + 9, bx.bottom - 5, 2, 4, '#2e5fa3');
      px(cx + 9, bx.bottom - 4, 2, 1, '#e8d36a');
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
      drawPort(o.t, o.night);
    },

    outros(r, b, o) {
      const roofH = Math.max(6, Math.round(r.h * 0.16));
      const bx = box(r, b.wall, roofH);
      // parede de chapa ondulada
      for (let x = r.x + 1; x < r.x + bx.fw; x += 2) px(x, bx.fy, 1, bx.bottom - bx.fy - 2, shade(b.wall, -0.08));
      // telhado metálico baixo
      px(r.x - 2, r.y - 1, r.w + 4, roofH + 1, PAL.outline);
      px(r.x - 1, r.y, r.w + 2, roofH, '#8d93a6');
      for (let x = r.x; x < r.x + r.w; x += 3) px(x, r.y, 1, roofH, '#767c90');
      px(r.x - 1, r.y, r.w + 2, 1, '#b4b9c9');
      if (o.level >= 2) { // letreiro no telhado
        const lw = Math.round(r.w * 0.5), lx = Math.round(r.x + r.w * 0.25);
        px(lx, r.y - 8, 1, 8, '#555'); px(lx + lw - 1, r.y - 8, 1, 8, '#555');
        px(lx - 1, r.y - 13, lw + 2, 7, PAL.outline);
        px(lx, r.y - 12, lw, 5, '#5b4d7a');
        for (let x = lx + 2; x < lx + lw - 2; x += 3) px(x, r.y - 10, 2, 1, o.night ? '#ffd166' : '#e8e1f5');
        if (o.night) addLight(lx + lw / 2, r.y - 10, 12, 0.6);
      }
      const cx = Math.round(r.x + bx.fw / 2);
      const skip = [sign('outros', r, bx, 'madeira'), { x: cx - 9, y: bx.bottom - 16, w: 18, h: 16 }];
      windows('outros', r, bx, { ...o, skip, cw: 16, wh: 4 });
      door(cx, bx.bottom - 1, { w: 14, h: 11, color: '#6b6f7d', rollup: true });
      // caixotes
      for (const [dx, dy] of [[-16, 0], [-12, 0], [-14, -4]]) {
        const x = cx + dx, y = bx.bottom - 1 + dy;
        px(x - 1, y - 5, 6, 5, PAL.outline);
        px(x, y - 4, 4, 4, '#c49a6c');
        px(x, y - 4, 4, 1, '#d8b98c');
        px(x + 1, y - 4, 1, 4, '#a07850');
      }
      if (o.level >= 3) eaveLights(r, bx.fy, o.t, o.night);
      if (o.level >= 4) goldTrim(r, bx.fy - 1);
    },
  };

  // Água do porto com cais e barquinho.
  function drawPort(t, night) {
    const w = portWater;
    if (!w) return;
    px(w.x - 1, w.y - 1, w.w + 2, w.h + 2, '#2a5f8f');
    px(w.x, w.y, w.w, w.h, '#3d7cc9');
    for (let i = 0; i < 6; i++) {
      const wx = w.x + ((i * 13 + Math.floor(t * 6)) % w.w), wy = w.y + 1 + ((i * 5) % Math.max(1, w.h - 2));
      px(wx, wy, 2, 1, '#a8d4ff');
    }
    // cais de tábuas
    px(w.x - 1, w.y + w.h - 3, 10, 3, PAL.wood[1]);
    for (let x = w.x; x < w.x + 9; x += 2) px(x, w.y + w.h - 3, 1, 3, PAL.wood[0]);
    // barquinho balançando
    const bxp = w.x + Math.round(w.w * 0.6) + Math.round(Math.sin(t * 0.4) * 3);
    const byp = w.y + Math.round(w.h / 2) + (Math.sin(t * 2) > 0 ? 1 : 0);
    px(bxp - 5, byp, 11, 1, PAL.outline);
    px(bxp - 4, byp + 1, 9, 2, '#e34948');
    px(bxp - 3, byp + 3, 7, 1, PAL.outline);
    px(bxp, byp - 6, 1, 6, '#5d3d29');
    px(bxp + 1, byp - 6, 4, 4, '#f5f0e6');
    if (night) addLight(bxp, byp - 2, 8, 0.5);
  }

  function drawBuilding(g, id, o) {
    G = g;
    const b = BUILDINGS[id];
    const r = C.geo.rects[id];
    if (b.img && b.img.complete && b.img.naturalWidth) {
      g.imageSmoothingEnabled = false;
      g.drawImage(b.img, r.x, r.y, r.w, r.h);
      return;
    }
    if (b.park) return drawPark(r, o);
    const fn = DRAWERS[id];
    if (fn) fn(r, b, o);
    else { // prédio novo sem desenhista próprio: caixa padrão
      const roofH = Math.max(8, Math.round(r.h * 0.22));
      const bx = box(r, b.wall || '#cfc6b0', roofH);
      shingles(r.x - 1, r.y, r.w + 2, roofH, b.roof || '#7a5a3a');
      const cx = Math.round(r.x + bx.fw / 2);
      const skip = [sign(id, r, bx, 'madeira'), { x: cx - 6, y: bx.bottom - 16, w: 12, h: 16 }];
      windows(id, r, bx, { ...o, skip });
      door(cx, bx.bottom - 1, { w: 8, h: 11 });
    }
  }

  // ---------------------------------------------------------------------------
  // Praça/Café
  // ---------------------------------------------------------------------------
  function drawPark(r, o) {
    const lv = o.level || 0, t = o.t;
    // gramado com borda de cerca viva
    px(r.x, r.y, r.w, r.h, '#6fb35c');
    for (let x = r.x; x < r.x + r.w; x += 3) {
      if (Math.abs(x - (r.x + r.w / 2)) < 8) continue; // entrada
      px(x, r.y, 3, 3, PAL.hedge[1]); px(x, r.y, 2, 1, PAL.hedge[2]);
      px(x, r.y + r.h - 3, 3, 3, PAL.hedge[1]); px(x, r.y + r.h - 3, 2, 1, PAL.hedge[2]);
    }
    // caminho de pedra em losangos
    const py = Math.round(r.y + r.h * 0.45 - 4);
    px(r.x + 6, py - 1, r.w - 12, 20, '#b9ad92');
    px(r.x + 6, py, r.w - 12, 18, '#d8cba8');
    for (let y = py; y < py + 18; y += 4) {
      for (let x = r.x + 6 + ((y - py) / 4 % 2 ? 2 : 0); x < r.x + r.w - 6; x += 4) px(x, y, 1, 1, '#c9bc98');
    }
    // fonte (maior no nível 4)
    const fx = r.x + 22, fy = r.y + r.h * 0.3;
    const fr = lv >= 4 ? 11 : 9;
    G.fillStyle = PAL.outline; G.beginPath(); G.arc(fx, fy, fr + 1, 0, Math.PI * 2); G.fill();
    G.fillStyle = lv >= 4 ? '#c9b48a' : '#9aa3ad'; G.beginPath(); G.arc(fx, fy, fr, 0, Math.PI * 2); G.fill();
    G.fillStyle = '#4fa3e0'; G.beginPath(); G.arc(fx, fy, fr - 2, 0, Math.PI * 2); G.fill();
    G.fillStyle = '#7cc0f0'; G.beginPath(); G.arc(fx - 2, fy - 2, fr - 5, 0, Math.PI * 2); G.fill();
    const jet = 3 + Math.round(Math.sin(t * 5) * 1.5);
    px(fx - 0.5, fy - jet - 2, 1, jet + 2, '#e6f6ff');
    if (lv >= 4) { px(fx - 4.5, fy - jet, 1, jet, '#e6f6ff'); px(fx + 3.5, fy - jet, 1, jet, '#e6f6ff'); }
    // flores
    const rnd = seeded(7);
    for (let i = 0; i < (lv >= 1 ? 40 : 16); i++) {
      px(r.x + 4 + rnd() * (r.w - 8), r.y + r.h * 0.72 + rnd() * (r.h * 0.2), 1, 1, PAL.flowers[i % PAL.flowers.length]);
    }
    // árvores da praça
    [[r.x + 8, r.y + r.h - 10], [r.x + r.w - 10, r.y + 14], [r.x + r.w * 0.5, r.y + r.h - 12], [r.x + r.w - 26, r.y + r.h - 10]]
      .forEach(([tx, ty], i) => drawTree({ x: tx, y: ty, s: 1.1 }, i === 1 ? 4 : i));
    // quiosque do café com toldo listrado
    const kx = r.x + r.w - 30, ky = py - 3;
    px(kx - 1, ky - 9, 22, 10, PAL.outline);
    px(kx, ky - 8, 20, 9, '#8b5a2b');
    px(kx + 2, ky - 6, 16, 4, '#f0e0c0');
    for (let i = 0; i < 22; i++) px(kx - 1 + i, ky - 12, 1, 3, Math.floor(i / 2) % 2 ? '#c0392b' : '#f5f0e6');
    if (o.night) addLight(kx + 10, ky - 4, 14, 0.7);
    // mesas com guarda-sol
    const tables = Math.max(1, Math.floor((r.w - 70) / 30));
    for (let i = 0; i < tables; i++) {
      const tx = r.x + 46 + i * 30, ty = r.y + 14;
      px(tx - 7, ty - 7, 15, 1, PAL.outline);
      px(tx - 6, ty - 6, 13, 3, i % 2 ? '#e74c3c' : '#f5f5f5');
      px(tx - 4, ty - 8, 9, 2, i % 2 ? '#c0392b' : '#ddd');
      px(tx, ty - 3, 1, 7, '#555');
      px(tx - 3, ty + 3, 7, 2, PAL.wood[1]);
      px(tx - 5, ty + 3, 1, 2, PAL.wood[0]); px(tx + 5, ty + 3, 1, 2, PAL.wood[0]);
    }
    if (lv >= 2) { // coreto
      const cx = r.x + r.w * 0.72, cy = r.y + r.h - 8;
      px(cx - 10, cy - 3, 20, 4, PAL.outline);
      px(cx - 9, cy - 2, 18, 3, '#d8cba8');
      for (const ox of [-8, -3, 2, 7]) px(cx + ox, cy - 11, 1, 9, '#f5f5f5');
      for (let i = 0; i < 5; i++) px(cx - 10 + i, cy - 12 - i, 21 - 2 * i, 1, lv >= 4 ? PAL.gold : '#c0392b');
      if (o.night) addLight(cx, cy - 8, 14, 0.6);
    }
    // placa num poste na entrada de baixo
    const { w: sw, h: sh } = signSize('praca', r.w * 0.5);
    const sx = Math.round(r.x + r.w / 2 - sw / 2), sy = r.y + r.h - sh - 7;
    px(sx + 2, sy + sh, 1, 6, PAL.wood[0]); px(sx + sw - 3, sy + sh, 1, 6, PAL.wood[0]);
    signAt('praca', sx, sy, r.w * 0.5, 'madeira');
    if (lv >= 3) { // bancos e postes dentro da praça
      for (const bxp of [r.x + 40, r.x + r.w * 0.45]) {
        px(bxp, py + 20, 8, 2, PAL.wood[1]);
        px(bxp, py + 22, 1, 2, PAL.wood[0]); px(bxp + 7, py + 22, 1, 2, PAL.wood[0]);
      }
      for (const lx of [r.x + 34, r.x + r.w - 34]) drawLamp({ x: lx, y: py }, o.night);
    }
  }

  // ---------------------------------------------------------------------------
  // Casas do bairro
  // ---------------------------------------------------------------------------
  function drawHouses(g, houses, statusOf, t, night) {
    G = g;
    for (const h of houses || []) {
      const st = statusOf(h);
      const wall = `hsl(${h.hue} 40% 72%)`, wallD = `hsl(${h.hue} 32% 58%)`, roof = `hsl(${h.hue} 45% 38%)`, roofD = `hsl(${h.hue} 45% 28%)`;
      const roofH = 9, side = 3;
      // cerquinha branca
      for (let x = h.x - 4; x < h.x + h.w + 6; x += 2) px(x, h.door.y - 3, 1, 3, '#f5f0e6');
      px(h.x - 4, h.door.y - 2, h.w + 10, 1, '#f5f0e6');
      // corpo
      px(h.x - 1, h.y + roofH - 1, h.w + 2, h.h - roofH + 2, PAL.outline);
      px(h.x, h.y + roofH, h.w - side, h.h - roofH, wall);
      px(h.x + h.w - side, h.y + roofH, side, h.h - roofH, wallD);
      // telhado com telhas
      for (let i = 0; i < roofH; i++) {
        const inset = Math.round((roofH - i) * 1.1);
        px(h.x + inset - 3, h.y + i - 1, h.w - 2 * inset + 6, 1, PAL.outline);
      }
      for (let i = 0; i < roofH; i++) {
        const inset = Math.round((roofH - i) * 1.1);
        const w = h.w - 2 * inset + 4;
        px(h.x + inset - 2, h.y + i, w, 1, i % 2 ? roofD : roof);
        px(h.x + inset - 2 + w - 3, h.y + i, 3, 1, roofD);
      }
      // chaminé
      px(h.x + h.w - 8, h.y - 2, 4, 5, PAL.outline);
      px(h.x + h.w - 7, h.y - 1, 2, 4, roofD);
      if (st.active) smoke(h.x + h.w - 6, h.y - 3, '#d0d0d0', 0.04);
      // janelas com moldura
      const lit = st.active || (night && (hash(h.key) % 3 !== 0));
      for (const wx of [h.x + 3, h.x + h.w - side - 7]) {
        px(wx - 1, h.y + roofH + 2, 6, 6, PAL.frame);
        px(wx, h.y + roofH + 3, 4, 4, lit ? PAL.glassLit : night ? PAL.glassNight : PAL.glassDay);
        px(wx + 2, h.y + roofH + 3, 1, 4, PAL.frame);
        if (lit && night) addLight(wx + 2, h.y + roofH + 5, 9, 0.55);
      }
      // porta
      px(h.door.x - 4, h.door.y - 9, 8, 9, PAL.outline);
      px(h.door.x - 3, h.door.y - 8, 6, 8, '#5d3d29');
      px(h.door.x + 1, h.door.y - 4, 1, 1, PAL.gold);
      // caixa de correio: bandeirinha levantada se alguém do projeto espera você
      const mx = h.x + h.w + 3, my = h.door.y - 7;
      px(mx, my + 2, 1, 5, '#555');
      px(mx - 1, my - 1, 5, 4, PAL.outline);
      px(mx, my, 3, 2, '#2e5fa3');
      if (st.alert && Math.floor(t * 3) % 2 === 0) { px(mx + 3, my - 4, 1, 4, '#e34948'); px(mx + 4, my - 4, 2, 2, '#e34948'); }
    }
  }

  // ---------------------------------------------------------------------------
  // Iluminação: tint do período + mapa de luz à noite
  // ---------------------------------------------------------------------------
  let lightCv = null;
  function beginFrame(light) {
    lights.length = 0;
    lightsOn = !!light.lamps || light.name === 'noite';
  }

  function applyLighting(g, light) {
    const { W, H } = C.view;
    let dark = 0, tint = null;
    if (light.name === 'noite') dark = 0.6;
    else if (light.name === 'entardecer') { dark = light.lamps ? 0.3 : 0.08; tint = 'rgba(255,120,70,.14)'; }
    else if (light.name === 'amanhecer') { dark = light.lamps ? 0.28 : 0.08; tint = 'rgba(255,170,100,.12)'; }
    if (tint) { g.fillStyle = tint; g.fillRect(0, 0, W, H); }
    if (dark <= 0) return;
    if (!lightCv || lightCv.width !== W || lightCv.height !== H) {
      lightCv = document.createElement('canvas');
      lightCv.width = W; lightCv.height = H;
    }
    const lc = lightCv.getContext('2d');
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);
    lc.fillStyle = light.name === 'noite' ? `rgba(10,16,48,${dark})` : `rgba(40,24,60,${dark})`;
    lc.fillRect(0, 0, W, H);
    // buracos de luz suaves
    lc.globalCompositeOperation = 'destination-out';
    for (const L of lights) {
      const grd = lc.createRadialGradient(L.x, L.y, 0, L.x, L.y, L.r);
      grd.addColorStop(0, `rgba(0,0,0,${L.a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = grd;
      lc.fillRect(L.x - L.r, L.y - L.r, L.r * 2, L.r * 2);
    }
    lc.globalCompositeOperation = 'source-over';
    g.drawImage(lightCv, 0, 0);
    // brilho quente por cima
    g.globalCompositeOperation = 'lighter';
    for (const L of lights) {
      const r = L.r * 0.6;
      const grd = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, r);
      grd.addColorStop(0, `rgba(${L.warm},${0.22 * L.a})`);
      grd.addColorStop(1, `rgba(${L.warm},0)`);
      g.fillStyle = grd;
      g.fillRect(L.x - r, L.y - r, r * 2, r * 2);
    }
    g.globalCompositeOperation = 'source-over';
  }

  // Acabamento na camada de alta resolução: vinheta + gradação por período.
  function postFx(ctx, w, h, light) {
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, light.name === 'noite' ? 'rgba(0,0,10,.38)' : 'rgba(0,0,0,.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    if (light.name === 'entardecer' || light.name === 'amanhecer') {
      ctx.globalCompositeOperation = 'soft-light';
      ctx.fillStyle = light.name === 'entardecer' ? 'rgba(255,150,80,.25)' : 'rgba(255,190,140,.2)';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // Texto das placas de fachada (alta resolução).
  function drawSignText(ctx, S, occupantsOf, hoverId) {
    for (const [id, s] of Object.entries(signs)) {
      if (!C.geo.rects[id]) continue;
      const cx = (s.x + s.w / 2) * S, cy = (s.y + s.h / 2) * S;
      const maxW = (s.w - 2) * S;
      let size = 10;
      ctx.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`;
      const starTxt = s.stars ? ' ' + '★'.repeat(s.stars) : '';
      while (size > 7 && ctx.measureText(s.text + starTxt).width > maxW) {
        size--;
        ctx.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`;
      }
      const nameW = ctx.measureText(s.text).width;
      const totalW = ctx.measureText(s.text + starTxt).width;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = s.dark ? '#e8f4ff' : '#3a2614';
      ctx.fillText(s.text, cx - totalW / 2, cy + 0.5);
      if (starTxt) {
        ctx.fillStyle = s.dark ? '#ffd166' : '#b8860b';
        ctx.fillText(starTxt, cx - totalW / 2 + nameW, cy + 0.5);
      }
      const n = occupantsOf(id);
      if (n) {
        const bx = (s.x + s.w) * S + 2, by = s.y * S - 4;
        ctx.font = 'bold 10px "Segoe UI", system-ui, sans-serif';
        const t = `👥${n}`;
        const w = ctx.measureText(t).width + 8;
        ctx.fillStyle = 'rgba(20,24,36,.85)';
        C.ui.roundRect(ctx, bx - w / 2, by - 7, w, 14, 7);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(t, bx, by + 0.5);
      }
      if (hoverId === id) {
        ctx.strokeStyle = 'rgba(255,209,102,.95)';
        ctx.lineWidth = 2;
        ctx.strokeRect(s.x * S - 2, s.y * S - 2, s.w * S + 4, s.h * S + 4);
      }
    }
  }

  C.art = {
    PAL, shade, rebuild, drawGround, drawShadows, drawCloudShadows, drawPuddles, drawTrees, drawFurniture,
    drawBuilding, drawHouses, beginFrame, applyLighting, addLight, postFx, drawSignText, signs, DRAWERS,
  };
})();

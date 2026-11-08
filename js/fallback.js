// DV77 · the no-WebGL turntable: the same camera, drawn in SVG — a lacquer disc with a soft reflection, a brushed rim
// carrying the current name on a curved path, and the four flacons as glass silhouettes that ride the platter.
import { toQ } from './renderer.js';

const PR = 300, PH = 26, KS = 1.32, BR = 212;
const SHAPE = [
  { w: 76, h: 133, r: 12, cap: { w: 42, h: 36, y: 134, fill: 'url(#fbGold)', r: 4 } },
  { w: 98, h: 118, r: 49, cap: { w: 34, h: 66, y: 112, fill: '#0b0a0a', r: 6 } },
  { w: 98, h: 128, r: 6, cap: { w: 44, h: 44, y: 129, fill: '#121214', r: 22 } },
  { w: 84, h: 150, r: 18, cap: { w: 60, h: 38, y: 148, fill: '#5a3a22', r: 7 } },
];
const NS = 'http://www.w3.org/2000/svg';

export function createFallback(svg, products) {
  let W = 1, H = 1, sc = 1, cx = 0, cy = 0;
  const q = toQ([0, 0, 0]);
  const pt = (p) => { const v = toQ(p); return [cx + v[0] * sc, cy - v[1] * sc, v[2]]; };
  svg.innerHTML = `<defs>
    <linearGradient id="fbTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a221b"/><stop offset=".45" stop-color="#0d0b0a"/><stop offset="1" stop-color="#050404"/></linearGradient>
    <linearGradient id="fbRim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3a3632"/><stop offset=".35" stop-color="#b8aea0"/><stop offset=".55" stop-color="#e8dfd2"/><stop offset=".8" stop-color="#8d857a"/><stop offset="1" stop-color="#2e2b28"/></linearGradient>
    <linearGradient id="fbGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6dca2"/><stop offset=".5" stop-color="#b98a45"/><stop offset="1" stop-color="#6d4a1d"/></linearGradient>
    <linearGradient id="fbGlass" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".18" stop-color="#fff" stop-opacity=".05"/><stop offset=".8" stop-color="#fff" stop-opacity=".02"/><stop offset=".92" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity=".05"/></linearGradient>
    <filter id="fbBlur"><feGaussianBlur stdDeviation="3"/></filter>
    <clipPath id="fbClip"><path id="fbClipP"/></clipPath>
  </defs>
  <g id="fbBase"></g><g clip-path="url(#fbClip)"><g id="fbRefl" opacity=".28" filter="url(#fbBlur)"></g></g><g id="fbBottles"></g>
  <path id="fbArc" fill="none"/><text id="fbName" font-family="Cormorant Garamond, serif" font-weight="500" letter-spacing="6" fill="#4a3b26" stroke="rgba(255,248,235,.55)" stroke-width=".6" paint-order="stroke"><textPath href="#fbArc" startOffset="50%" text-anchor="middle"></textPath></text>`;
  const base = svg.querySelector('#fbBase'), refl = svg.querySelector('#fbRefl'), bottles = svg.querySelector('#fbBottles');
  const arc = svg.querySelector('#fbArc'), name = svg.querySelector('#fbName'), tp = name.firstChild;

  function ring(r, y, a0 = 0, a1 = Math.PI * 2, n = 72) { const out = []; for (let k = 0; k <= n; k++) { const a = a0 + (a1 - a0) * k / n; out.push(pt([r * Math.sin(a), y, r * Math.cos(a)])); } return out; }
  const path = (ps, close) => 'M' + ps.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + (close ? 'Z' : '');

  function resize(w, h) {
    W = w; H = h; svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    // fit like the WebGL camera does
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < 64; k++) { const a = k / 64 * Math.PI * 2; for (const [r, y] of [[PR, 0], [PR, -PH], [BR + 80, 248]]) { const v = toQ([r * Math.sin(a), y, r * Math.cos(a)]); x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); } }
    sc = Math.min(w * .96 / (x1 - x0), h * .94 / (y1 - y0)); cx = w / 2 - (x0 + x1) / 2 * sc; cy = h / 2 + (y0 + y1) / 2 * sc;
    const top = ring(PR, 0), bot = ring(PR, -PH, -Math.PI / 2, Math.PI / 2), topF = ring(PR, 0, -Math.PI / 2, Math.PI / 2);
    base.innerHTML = `<path d="${path(topF.concat(bot.reverse()), true)}" fill="url(#fbRim)"/>
      <path d="${path(top, true)}" fill="url(#fbTop)" stroke="rgba(255,240,220,.45)" stroke-width="1"/>`;
    svg.querySelector('#fbClipP').setAttribute('d', path(top, true));
    const mid = ring(PR + 1, -PH * .62, -.75, .75, 40); arc.setAttribute('d', path(mid));
    name.setAttribute('font-size', Math.max(9, PH * .6 * sc));
  }
  function boxes(theta) {
    return SHAPE.map((s, i) => {
      const a = theta + i * Math.PI / 2, c = [BR * Math.sin(a), 0, BR * Math.cos(a)];
      const b = pt(c), t = pt([c[0], (s.cap.y + s.cap.h) * KS, c[2]]); const w = s.w * KS * sc * (toQ([0, 0, 0])[2] / b[2]);
      return { x: b[0] - w / 2, y: t[1], w, h: b[1] - t[1], front: Math.cos(a), cx: b[0] };
    });
  }
  function draw(theta, cur, eng) {
    const order = [0, 1, 2, 3].map((i) => ({ i, z: Math.cos(theta + i * Math.PI / 2) })).sort((a, b) => a.z - b.z);
    let g = '', r = '';
    for (const { i } of order) {
      const s = SHAPE[i], a = theta + i * Math.PI / 2, c = [BR * Math.sin(a), 0, BR * Math.cos(a)];
      const b = pt(c), k = sc * KS * (q[2] / b[2]);
      const w = s.w * k, h = s.h * k, x = b[0] - w / 2, y = b[1] - h;
      const L = products[i].liq.map((v) => Math.round(v * 255)).join(',');
      const cw = s.cap.w * k, ch = s.cap.h * k, capY = b[1] - (s.cap.y + s.cap.h) * k;
      const one = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${s.r * k}" fill="rgba(${L},.82)" stroke="rgba(255,250,240,.35)" stroke-width="1"/>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${s.r * k}" fill="url(#fbGlass)"/>
        <rect x="${b[0] - cw / 2}" y="${capY}" width="${cw}" height="${ch}" rx="${s.cap.r * k}" fill="${s.cap.fill}" stroke="rgba(255,240,220,.25)" stroke-width="1"/>`;
      g += one;
      r += `<g transform="translate(0 ${2 * b[1]}) scale(1 -1)">${one}</g>`;
    }
    bottles.innerHTML = g; refl.innerHTML = r;
    tp.textContent = eng[cur] > 0 ? `${products[cur].a} ${products[cur].b}`.toUpperCase() : '';
  }
  return { resize, draw, boxes };
}

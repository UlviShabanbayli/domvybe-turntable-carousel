// DV77 TURNTABLE CAROUSEL · app: products, the platter's physics, engraving, tabs/keyboard/drag, bag, fallbacks.
import { createRenderer } from './renderer.js';
import { createFallback } from './fallback.js';

const P = [
  { a: 'Ambre', b: 'Nuit', kind: 'Eau de parfum · 50 ml', notes: 'Smoked amber, black tea and a trace of fig leaf. Warm, low and close to the skin.', price: 145, liq: [.86, .52, .18] },
  { a: 'Rose', b: 'Ardente', kind: 'Eau de parfum · 50 ml', notes: 'Damask rose over pink pepper and oud. A red-velvet evening in a bottle.', price: 160, liq: [.74, .26, .32] },
  { a: 'Vétiver', b: 'Vert', kind: 'Eau de parfum · 75 ml', notes: 'Haitian vetiver, cut grass and grapefruit zest. Bright, green, unhurried.', price: 130, liq: [.50, .62, .32] },
  { a: 'Eau', b: 'Marine', kind: 'Eau de toilette · 100 ml', notes: 'Sea salt, driftwood and cold bergamot. The shoreline at seven in the morning.', price: 125, liq: [.32, .50, .66] },
];
const N = P.length, Q = Math.PI / 2, LIMIT = 3, REST = -.1;   // the platter rests a few degrees off-axis (the concept's composition)
const KEY = 'dv77.bag';
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || qs.has('still');
const euro = (n) => '€' + n;
const mod = (a, n) => ((a % n) + n) % n;

// ---- storage: versioned keys, older ones wiped
function store() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('dv77') && k !== KEY) localStorage.removeItem(k); }
    const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}
const bag = store();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(bag)); } catch (e) {} };

// ---- state
const st = {
  cur: 0, theta: reduced ? REST : .62, target: REST, vel: 0,
  drag: null, eng: [0, 0, 0, 0], hot: [0, 0, 0, 0], engT: -1, glint: [0, 0], glintT: 0, idleT: 0,
  settled: false, fx: null, fb: null, running: false, last: 0, intro: !reduced,
};
const html = document.documentElement;
if (matchMedia('(hover: hover)').matches) html.classList.add('hover-ok');
const stage = $('stage'), canvas = $('gl'), tabsEl = $('tabs');

// ---- tabs over the bottles (real focusable controls)
const tabs = P.map((p, i) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'bt'; b.id = 'tab-' + i; b.setAttribute('role', 'tab');
  b.setAttribute('aria-controls', 'panel'); b.setAttribute('aria-label', `${p.a} ${p.b}, ${p.kind}, ${euro(p.price)}`);
  b.innerHTML = `<span class="tag" aria-hidden="true">${p.a} ${p.b}<em>${euro(p.price)}</em></span>`;
  b.addEventListener('click', (e) => { if (st.suppressClick) { e.preventDefault(); return; } pick(i); });
  b.addEventListener('keydown', onTabKey);
  tabsEl.appendChild(b); return b;
});
function syncTabs() {
  tabs.forEach((b, i) => { const on = i === st.cur; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  $('panel').setAttribute('aria-labelledby', 'tab-' + st.cur);
}
function onTabKey(e) {
  const i = tabs.indexOf(e.currentTarget); let j = null;
  if (e.key === 'ArrowRight') j = i + 1; else if (e.key === 'ArrowLeft') j = i - 1;
  else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = N - 1;
  if (j == null) return;
  e.preventDefault(); j = mod(j, N); pick(j); tabs[j].focus({ preventScroll: true });
}

// ---- copy
let swapTimer = 0;
function renderCopy(instant) {
  const p = P[st.cur];
  const els = [$('kicker'), $('name'), $('notes'), $('price')];
  const apply = () => {
    $('kicker').textContent = p.kind; $('name').innerHTML = `${p.a} <i>${p.b}</i>`; $('notes').textContent = p.notes; $('price').textContent = euro(p.price);
    els.forEach((e) => e.classList.remove('out'));
    syncAdd();
  };
  $('count').innerHTML = `<b>0${st.cur + 1}</b> <span>/ 0${N}</span>`;
  clearTimeout(swapTimer);
  if (instant || reduced) { apply(); return; }
  els.forEach((e) => { e.classList.add('swap'); e.classList.add('out'); });
  swapTimer = setTimeout(apply, 190);
}
function announce(t) { const l = $('live'); l.textContent = ''; setTimeout(() => { l.textContent = t; }, 30); }

// ---- the platter
function setCur(i, say = true) {
  i = mod(i, N); if (i === st.cur) return;
  st.cur = i; syncTabs(); renderCopy(); setMsg('');
  if (say) announce(`${P[i].a} ${P[i].b}, ${i + 1} of ${N}, ${euro(P[i].price)}`);
}
function turn(d) {
  if (!d) return;
  st.target -= d * Q; setCur(st.cur + d);
  if (reduced) { cut(); }
  wake();
}
function pick(i) {
  let d = mod(i - st.cur, N); if (d > N / 2) d -= N; if (d === 2 && st.cur % 2) d = -2;
  turn(d);
}
function cut() {
  // reduced motion: no spin — a short dip of the canvas, the platter jumps, the new image fades in
  st.theta = st.target; st.vel = 0;
  if (st.fx) { canvas.classList.add('dip'); setTimeout(() => canvas.classList.remove('dip'), 130); }
}
$('next').addEventListener('click', () => turn(1));
$('prev').addEventListener('click', () => turn(-1));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const a = document.activeElement;
  if (a && (a.classList.contains('bt') || a.matches('input, textarea, select, [contenteditable]'))) return;
  if (a && a !== document.body && !$('carousel').contains(a)) return;
  e.preventDefault(); turn(e.key === 'ArrowRight' ? 1 : -1);
});

// drag / swipe: grab the platter and spin it; momentum, then it snaps to the nearest bottle
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  st.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, th0: st.theta, moved: false, lx: e.clientX, lt: performance.now(), v: 0 };
});
stage.addEventListener('pointermove', (e) => {
  const d = st.drag; if (!d || e.pointerId !== d.id) return;
  const dx = e.clientX - d.x0;
  if (!d.moved) { if (Math.abs(dx) < 7 || Math.abs(dx) < Math.abs(e.clientY - d.y0)) return; d.moved = true; stage.classList.add('dragging'); try { stage.setPointerCapture(e.pointerId); } catch (_) {} }
  const R = radiusPx();
  st.theta = d.th0 + dx / R; st.target = st.theta; st.vel = 0;
  const now = performance.now(), dt = Math.max(1, now - d.lt);
  d.v = d.v * .6 + ((e.clientX - d.lx) / R / (dt / 1000)) * .4; d.lx = e.clientX; d.lt = now;
  setCur(Math.round(-(st.theta - REST) / Q), true);
  wake();
});
const endDrag = (e) => {
  const d = st.drag; if (!d || (e && e.pointerId !== d.id)) return;
  st.drag = null; stage.classList.remove('dragging');
  if (!d.moved) return;
  st.suppressClick = true; setTimeout(() => { st.suppressClick = false; }, 0);
  const v = Math.max(-9, Math.min(9, performance.now() - d.lt > 90 ? 0 : d.v));
  const k = Math.round(-(st.theta - REST + v * .22) / Q);
  st.target = -k * Q + REST; st.vel = reduced ? 0 : v; setCur(k, true);
  if (reduced) cut();
  wake();
};
stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('lostpointercapture', (e) => { if (e.target === stage) endDrag(e); });   // a child losing its implicit touch capture is not the end
function radiusPx() { if (st.fx) { const a = st.fx.toCss([300, 0, 0]), b = st.fx.toCss([-300, 0, 0]); return Math.max(60, Math.abs(a[0] - b[0]) / 2); } return Math.max(60, stage.clientWidth * .42); }

// ---- bag (success, error, disabled)
let addTimer = 0;
function syncAdd() {
  const n = bag[st.cur] || 0, full = n >= LIMIT, a = $('add');
  if (full) { a.setAttribute('aria-disabled', 'true'); $('addl').textContent = 'Limit reached'; }
  else { a.removeAttribute('aria-disabled'); if (!a.classList.contains('done')) $('addl').textContent = 'Add to bag'; }
}
function setMsg(t) { $('msg').textContent = t; }
function bagCount() { return Object.values(bag).reduce((s, v) => s + v, 0); }
function renderBag(bump) {
  $('bagn').textContent = bagCount();
  const list = $('baglist'); list.innerHTML = '';
  Object.entries(bag).forEach(([i, n]) => { if (!n) return; const p = P[i]; const li = document.createElement('li'); li.innerHTML = `<span>${p.a} ${p.b}</span><span>${n} × ${euro(p.price)}</span>`; list.appendChild(li); });
  const empty = !bagCount(); $('bagempty').hidden = !empty; $('bagclear').hidden = empty;
  if (bump) { const b = $('bagbtn'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
}
$('add').addEventListener('click', () => {
  const a = $('add'), p = P[st.cur], n = bag[st.cur] || 0;
  if (n >= LIMIT) {
    setMsg(`Limit of ${LIMIT} per fragrance — ${p.a} ${p.b} is already in your bag ${LIMIT} times.`);
    a.classList.remove('shake'); void a.offsetWidth; if (!reduced) a.classList.add('shake');
    return;
  }
  bag[st.cur] = n + 1; save(); setMsg('');
  a.classList.add('done'); $('addl').textContent = 'Added';
  renderBag(true); announce(`${p.a} ${p.b} added to your bag. ${bagCount()} items.`);
  clearTimeout(addTimer); addTimer = setTimeout(() => { a.classList.remove('done'); syncAdd(); }, 1500);
  syncAdd();
});
$('add').addEventListener('animationend', () => $('add').classList.remove('shake'));
const pop = $('bagpop'), bagbtn = $('bagbtn');
function openBag(on) { pop.hidden = !on; bagbtn.setAttribute('aria-expanded', on); if (on) $('bagclear').hidden || $('bagclear').focus({ preventScroll: true }); }
bagbtn.addEventListener('click', () => openBag(pop.hidden));
$('bagclear').addEventListener('click', () => { for (const k of Object.keys(bag)) delete bag[k]; save(); renderBag(); syncAdd(); setMsg(''); announce('Your bag is empty.'); bagbtn.focus(); openBag(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { openBag(false); bagbtn.focus(); } });
document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== bagbtn && !bagbtn.contains(e.target)) openBag(false); });

// ---- engraving on the rim
function rimState(now) {
  const ext = st.fx.rimExt();
  const rev = st.eng.map((e, i) => e <= 0 ? 0 : e >= 1 ? 1 : ext[i][0] + e * (ext[i][1] - ext[i][0]));
  let head = null;
  const e = st.eng[st.cur];
  if (st.engT >= 0 && e > 0 && e < 1) {
    const u = rev[st.cur], az = (u - .125) * Math.PI * 2 + st.theta;
    head = { p: [300 * Math.sin(az), -13.5, 300 * Math.cos(az)], i: .82 + .18 * Math.sin(now * .09) * Math.sin(now * .023) };
  }
  return { rev, hot: st.hot.slice(), head, glint: st.glint };
}
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ---- the loop: runs only while something moves, then sleeps
function wake() { if (!st.running) { st.running = true; st.last = performance.now(); requestAnimationFrame(loop); } }
function loop(now) {
  if (st.frozen) { st.running = false; return; }          // capture hook: hold the current frame
  const dt = Math.min((now - st.last) / 1000, 1 / 30); st.last = now;
  let busy = false;
  // spring (weighted platter: a small overshoot) — not while the hand is on it
  if (!st.drag) {
    const k = st.intro ? 26 : 62, c = st.intro ? 9.2 : 11.5;
    st.vel += ((st.target - st.theta) * k - st.vel * c) * dt; st.theta += st.vel * dt;
    if (Math.abs(st.target - st.theta) < 4e-4 && Math.abs(st.vel) < 4e-3) { st.theta = st.target; st.vel = 0; st.intro = false; }
    else busy = true;
  } else busy = true;
  const atRest = !st.drag && st.theta === st.target;
  // segments that have gone behind are polished off (out of sight); the front one is engraved once the platter rests
  for (let i = 0; i < N; i++) { if (Math.abs(wrapA(st.theta + i * Q)) > 2.2) { st.eng[i] = 0; st.hot[i] = 0; } }
  if (atRest && st.eng[st.cur] < 1 && st.engT < 0) { st.engT = 0; if (reduced) { st.eng[st.cur] = 1; st.engT = -1; } }
  if (st.engT >= 0) {
    if (!atRest) st.engT = -1;
    else {
      st.engT += dt; const dur = 1.55;
      const x = Math.min(1, st.engT / dur); st.eng[st.cur] = x < 1 ? .02 + .98 * (x * (2 - x) * .25 + x * .75) : 1; st.hot[st.cur] = 1;
      if (x >= 1) st.engT = -1;
      busy = true;
    }
  }
  for (let i = 0; i < N; i++) if (st.hot[i] > 0 && !(st.engT >= 0 && i === st.cur)) { st.hot[i] = Math.max(0, st.hot[i] - dt / 1.8); busy = true; }
  // idle: a soft light runs along the rim now and then
  st.glint = [0, 0];
  if (atRest && !reduced && !busy) {
    st.idleT += dt; const T = st.idleT % 9;
    if (st.idleT > 2.5 && T < 2.2) { const x = T / 2.2; st.glint = [-1.35 + 2.7 * x, Math.sin(x * Math.PI) * .55]; busy = true; }
    else if (st.idleT > 2.5) { /* sleep until the next sweep */ setTimeout(wake, (9 - T) * 1000 + 20); }
  } else st.idleT = Math.min(st.idleT, 0);
  if (!atRest) st.idleT = 0;
  layoutTabs();
  if (st.fx) {
    const more = st.fx.frame({ theta: st.theta, rim: rimState(now), rimActive: busy, instant: reduced }, dt);
    if (st.fx.busy()) busy = true;
    if (!st.ready && st.fx.stats.frames > 0) markReady();
  } else if (st.fb) st.fb.draw(st.theta, st.cur, st.eng);
  if (busy || st.drag) requestAnimationFrame(loop); else { st.running = false; if (!st.ready) markReady(); }
}
function markReady() { if (st.ready) return; st.ready = true; html.classList.add('ready'); readyRes(); }
let readyRes; const ready = new Promise((r) => { readyRes = r; });

// ---- tabs follow the bottles on screen
const tagW = [];
function layoutTabs() {
  const boxes = st.fx ? st.fx.bottleBoxes(st.theta) : st.fb ? st.fb.boxes(st.theta) : null; if (!boxes) return;
  boxes.forEach((bx, i) => {
    const b = tabs[i], w = Math.max(44, bx.w * .92), h = Math.max(44, bx.h);
    b.style.width = w + 'px'; b.style.height = h + 'px';
    b.style.transform = `translate(${(bx.cx - w / 2).toFixed(1)}px, ${(bx.y + 64).toFixed(1)}px)`;
    // keep the hover tag inside the stage
    const tw = tagW[i] || (tagW[i] = b.firstElementChild.offsetWidth), sw = stage.clientWidth;
    const c = Math.max(tw / 2 + 6, Math.min(sw - tw / 2 - 6, bx.cx)); b.style.setProperty('--sx', (c - bx.cx).toFixed(1) + 'px');
    b.style.zIndex = Math.round(10 + bx.front * 10);
    b.style.visibility = bx.front < -.55 ? 'hidden' : 'visible';
  });
}

// ---- size
function fitFor(w, h) {
  const phone = w < 700;
  return { phone, fit: phone ? { w: .98, h: .96, dy: 0 } : { w: .96, h: .94, dy: 0 } };
}
function resize() {
  const r = stage.getBoundingClientRect(); const w = Math.max(10, r.width), h = Math.max(10, r.height);
  const dpr = Math.min(2, devicePixelRatio || 1) * (qs.has('fxdpr') ? +qs.get('fxdpr') / Math.min(2, devicePixelRatio || 1) : 1);
  const f = fitFor(w, h);
  if (st.fx) st.fx.resize(w, h, dpr, f.phone, f.fit);
  if (st.fb) st.fb.resize(w, h);
  layoutTabs(); wake();
}

// ---- boot
async function boot() {
  renderBag(); syncTabs(); renderCopy(true);
  try { await Promise.race([Promise.all([document.fonts.load('500 132px "Cormorant Garamond"'), document.fonts.load('600 36px Manrope')]), new Promise((r) => setTimeout(r, 2500))]); } catch (e) {}
  const names = P.map((p) => `${p.a} ${p.b}`);
  if (!qs.has('nofx')) {
    try { st.fx = createRenderer(canvas, { rimNames: names, onLost: fallback }); } catch (e) { st.fx = null; }
  }
  if (st.fx) {
    st.fx.setLiquids(P.map((p) => p.liq));
    resize(); window.__cal = st.fx.calibrate();
  } else fallback();
  new ResizeObserver(() => resize()).observe(stage);
  wake();
}
function fallback() {
  st.fx = null; html.classList.add('no-fx');
  st.fb = createFallback($('fb'), P); resize(); markReady(); wake();
}

window.__tt = {
  ready, P, st, turn, pick, bag,
  freeze: (on) => { st.frozen = !!on; if (!on) wake(); },
  get fx() { return st.fx; },
  state: () => ({ cur: st.cur, theta: st.theta, target: st.target, vel: st.vel, eng: st.eng.slice(), hot: st.hot.slice(), running: st.running,
    fx: !!st.fx, busy: st.fx ? st.fx.busy() : false, stats: st.fx ? { ...st.fx.stats } : null, liveS: st.fx ? st.fx.liveS : 0, bands: st.fx ? st.fx.bands.length : 0 }),
};
boot();

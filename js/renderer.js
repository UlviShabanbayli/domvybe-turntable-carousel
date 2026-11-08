// DV77 TURNTABLE · the WebGL renderer.
// Cost discipline (the scene is a refracting raymarch, ~10× too heavy to trace at full res every frame):
//   moving   → one half-res-or-less sample per frame into a "live" buffer, blended over the last frames (motion blur)
//   at rest  → full-res samples accumulated in horizontal bands, a few bands per frame within a GPU budget measured on
//              this machine at start-up; the image fades from live to accumulated after the first full pass
//   settled  → nothing is traced (the loop sleeps); only the rim pass and the resolve run while the laser engraves
// Everything is scissored to the stage's projected bounds.
import { VS, TRACE, TRACE_LQ, RIM, SHOW, BRIGHT, BLUR } from './shaders.js';

const PR = 300, PH = 26, KS = 1.32, BR = 212;
const CAM = [0, 760, 1420], TG = [0, 70, 0], FOC = 1900;
const BND = [[45, 172], [62, 184], [57, 175], [43, 188]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const nrm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const FW = nrm(sub(TG, CAM)), RT = nrm(cross(FW, [0, 1, 0])), UP = cross(RT, FW);
// q-plane coordinates of a world point (the shader's camRay inverted)
export function toQ(p) { const v = sub(p, CAM), z = dot(v, FW); return [FOC * dot(v, RT) / z, FOC * dot(v, UP) / z, z]; }

const SAMPLES_DESKTOP = 16, SAMPLES_PHONE = 12, MAXBANDS = 16;

export function createRenderer(canvas, { rimNames, onLost, traceSrc } = {}) {
  let gl;
  try { gl = canvas.getContext('webgl2', { antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' }); }
  catch (e) { gl = null; }
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');

  function prog(fs) {
    const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
    const pr = gl.createProgram(); const v = mk(gl.VERTEX_SHADER, VS), f = mk(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(pr, v); gl.attachShader(pr, f); gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
    return { pr, v, f, u: null };
  }
  function finish(P) {
    if (!gl.getProgramParameter(P.pr, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(P.f) || gl.getProgramInfoLog(P.pr); throw new Error('shader: ' + log);
    }
    const u = {}; const n = gl.getProgramParameter(P.pr, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(P.pr, i); u[a.name] = gl.getUniformLocation(P.pr, a.name); }
    P.u = u; return P;
  }
  // compile all three at once (the driver can work on them in parallel), then check
  let TR = prog(traceSrc || TRACE), TL = prog(TRACE_LQ), RM = prog(RIM), SH = prog(SHOW), BR_ = prog(BRIGHT), BL = prog(BLUR);
  TR = finish(TR); TL = finish(TL); RM = finish(RM); SH = finish(SH); BR_ = finish(BR_); BL = finish(BL);

  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // ---- the rim texture: R names (sharp), G small marks, B names softened, A marks softened (for groove normals)
  const TW = 8192, TH = 256;
  const rim = { tex: gl.createTexture(), ext: [] };
  function buildRim(names) {
    const layer = (draw, blur) => {
      const c = document.createElement('canvas'); c.width = TW; c.height = TH; const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, TW, TH); if (blur) g.filter = `blur(${blur}px)`; g.fillStyle = '#fff'; draw(g);
      return g.getImageData(0, 0, TW, TH).data;
    };
    const ext = [];
    const nameDraw = (g) => {
      g.font = '500 132px "Cormorant Garamond"'; g.textAlign = 'center'; g.textBaseline = 'middle';
      names.forEach((n, i) => {
        const s = n.toUpperCase(); g.letterSpacing = '34px';
        const w = g.measureText(s).width; const xc = (i + .5) * TW / 4;
        g.fillText(s, xc + 17, TH * .56); ext[i] = [(xc - w / 2) / TW, (xc + w / 2 + 8) / TW];
      });
    };
    const markDraw = (g) => {
      g.font = '600 36px Manrope'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '15px';
      names.forEach((n, i) => {
        const xc = (i + .5) * TW / 4;
        g.fillText('ONDINE · PARIS', i * TW / 4 + 8, TH * .54); if (i === 0) g.fillText('ONDINE · PARIS', TW + 8, TH * .54);
      });
    };
    const R = layer(nameDraw, 0), G = layer(markDraw, 0), B = layer(nameDraw, 3), A = layer(markDraw, 2.5);
    const px = new Uint8Array(TW * TH * 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 4) { px[i] = R[j]; px[i + 1] = G[j]; px[i + 2] = B[j]; px[i + 3] = A[j]; }
    gl.bindTexture(gl.TEXTURE_2D, rim.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TW, TH, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    rim.ext = ext;
  }
  buildRim(rimNames);

  // ---- targets
  function target(w, h, filter) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  function drop(T) { if (T) { gl.deleteTexture(T.t); gl.deleteFramebuffer(T.f); } }

  const R = {
    gl, W: 0, H: 0, dpr: 1, cssW: 0, cssH: 0, center: [0, 0], scale: 1, phone: false,
    acc: null, live: null, liveS: .5, costPx: 0, costLq: 0, budget: 3.6, liveBudget: 4.4,
    bands: [], bandH: 64, bandY0: 0, cnt: new Float32Array(MAXBANDS), pass: 0, nextBand: 0, target: SAMPLES_DESKTOP,
    mix: 0, tracedTheta: NaN, liveFresh: false, stats: { trace: 0, bands: 0, show: 0, rim: 0, frames: 0 },
    bbox: [0, 0, 1, 1], failed: false, bloomK: .25,
  };

  // scene extent in the q plane (independent of the platter angle)
  const qb = (() => {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    const add = (p) => { const q = toQ(p); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); };
    for (let k = 0; k < 96; k++) {
      const a = k / 96 * Math.PI * 2, s = Math.sin(a), c = Math.cos(a);
      add([PR * s, 0, PR * c]); add([PR * s, -PH, PR * c]); add([262 * s, -64, 262 * c]);
      add([(BR + 62 * KS) * s, 188 * KS, (BR + 62 * KS) * c]);
    }
    return { x0, x1, y0, y1 };
  })();

  R.resize = function (cssW, cssH, dpr, phone, fit = { w: .96, h: .94, dy: 0 }) {
    R.cssW = cssW; R.cssH = cssH; R.dpr = dpr; R.phone = phone;
    const W = Math.max(2, Math.round(cssW * dpr)), H = Math.max(2, Math.round(cssH * dpr));
    canvas.width = W; canvas.height = H; R.W = W; R.H = H;
    const qw = qb.x1 - qb.x0, qh = qb.y1 - qb.y0;
    R.scale = Math.min(W * fit.w / qw, H * fit.h / qh);
    // centre the scene's q-box in the canvas (GL coordinates, y up)
    R.center = [W / 2 - (qb.x0 + qw / 2) * R.scale, H / 2 - (qb.y0 + qh / 2) * R.scale + fit.dy * H];
    const bx0 = Math.max(0, Math.floor(R.center[0] + qb.x0 * R.scale) - 4), bx1 = Math.min(W, Math.ceil(R.center[0] + qb.x1 * R.scale) + 4);
    const by0 = Math.max(0, Math.floor(R.center[1] + qb.y0 * R.scale) - 4), by1 = Math.min(H, Math.ceil(R.center[1] + qb.y1 * R.scale) + 4);
    R.bbox = [bx0, by0, bx1 - bx0, by1 - by0];
    drop(R.acc); R.acc = target(W, H, gl.NEAREST);
    const bw = Math.max(2, Math.round(W / 4)), bh = Math.max(2, Math.round(H / 4));
    drop(R.b1); drop(R.b2); R.b1 = target(bw, bh, gl.LINEAR); R.b2 = target(bw, bh, gl.LINEAR);
    R.target = phone ? SAMPLES_PHONE : SAMPLES_DESKTOP;
    R.plan(); R.invalidate();
  };

  // budget plan from the measured cost per traced pixel
  R.plan = function () {
    const [, , bw, bh] = R.bbox; const px = bw * bh;
    const cost = R.costPx || 6e-5;                         // ms per pixel-sample (full quality)
    const s = Math.sqrt(R.liveBudget / ((R.costLq || cost / 4) * px));
    R.liveS = Math.max(.3, Math.min(.66, s));
    drop(R.live); R.live = target(Math.max(2, Math.round(R.W * R.liveS)), Math.max(2, Math.round(R.H * R.liveS)), gl.LINEAR);
    let rows = Math.max(16, Math.floor(R.budget / (cost * bw)));
    let n = Math.ceil(bh / rows); if (n > MAXBANDS) { n = MAXBANDS; rows = Math.ceil(bh / n); }
    R.bandH = rows; R.bandY0 = R.bbox[1];
    R.bands = []; for (let i = 0; i < n; i++) { const y = R.bbox[1] + i * rows; R.bands.push([y, Math.min(rows, R.bbox[1] + bh - y)]); }
  };

  R.invalidate = function () { R.tracedTheta = NaN; R.pass = 0; R.cnt.fill(0); R.nextBand = 0; R.mix = 0; };

  let liq = [];
  R.setLiquids = (l) => { liq = l.flat(); };

  function traceUniforms(center, scale, theta, seed, jit, P = TR) {
    gl.useProgram(P.pr);
    gl.uniform2f(P.u.uCenter, center[0], center[1]); gl.uniform1f(P.u.uScale, scale);
    gl.uniform1f(P.u.uTheta, theta); gl.uniform1f(P.u.uSeed, seed); gl.uniform1f(P.u.uJit, jit);
    gl.uniform3fv(P.u['uLiq[0]'], liq);
  }

  // one live (low-res) sample, blended over the previous ones by `keep`
  function traceLive(theta, keep, seed) {
    const L = R.live, s = L.w / R.W;
    gl.bindFramebuffer(gl.FRAMEBUFFER, L.f); gl.viewport(0, 0, L.w, L.h);
    gl.enable(gl.SCISSOR_TEST);
    const [x, y, w, h] = R.bbox; gl.scissor(Math.floor(x * s) - 1, Math.floor(y * s) - 1, Math.ceil(w * s) + 2, Math.ceil(h * s) + 2);
    if (keep > 0) { gl.enable(gl.BLEND); gl.blendColor(0, 0, 0, 1 - keep); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); }
    else gl.disable(gl.BLEND);
    traceUniforms([R.center[0] * s, R.center[1] * s], R.scale * s, theta, seed, 1, TL);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    R.stats.trace++;
  }

  // full-res bands into the accumulator
  function traceBands(theta, k) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.acc.f); gl.viewport(0, 0, R.W, R.H);
    gl.enable(gl.SCISSOR_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    const [x, , w] = R.bbox;
    for (let j = 0; j < k; j++) {
      const b = R.nextBand, [y, h] = R.bands[b];
      if (R.cnt[b] >= R.target) break;
      gl.scissor(x, y, w, h);
      if (R.cnt[b] === 0) { gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.enable(gl.BLEND); }
      traceUniforms(R.center, R.scale, theta, R.cnt[b] + 1 + b * 0.37, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      R.cnt[b]++; R.stats.bands++;
      R.nextBand = (b + 1) % R.bands.length;
    }
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }

  function resolveUniforms(P) {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, R.acc.t); gl.uniform1i(P.u.uAcc, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, R.live.t); gl.uniform1i(P.u.uLive, 1);
    gl.uniform1f(P.u.uMix, R.mix); gl.uniform1fv(P.u['uCnt[0]'], R.cnt);
    gl.uniform2f(P.u.uRes, R.W, R.H); gl.uniform1f(P.u.uBandY0, R.bandY0); gl.uniform1f(P.u.uBandH, R.bandH);
  }
  // bloom: bright pass at quarter res, then a separable blur; only when the traced image changed
  function bloom() {
    const B1 = R.b1, B2 = R.b2;
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, B1.f); gl.viewport(0, 0, B1.w, B1.h);
    gl.useProgram(BR_.pr); resolveUniforms(BR_); gl.uniform1f(BR_.u.uDown, R.W / B1.w); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(BL.pr); gl.uniform2f(BL.u.uSize, B1.w, B1.h); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(BL.u.uSrc, 0);
    for (let k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, B2.f); gl.bindTexture(gl.TEXTURE_2D, B1.t); gl.uniform2f(BL.u.uDir, (1 + k) / B1.w, 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, B1.f); gl.bindTexture(gl.TEXTURE_2D, B2.t); gl.uniform2f(BL.u.uDir, 0, (1 + k) / B1.h); gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    R.stats.bloom = (R.stats.bloom || 0) + 1;
  }

  function show() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, R.W, R.H);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST); const [x, y, w, h] = R.bbox; gl.scissor(x, y, w, h);
    gl.useProgram(SH.pr); resolveUniforms(SH);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, R.b1.t); gl.uniform1i(SH.u.uBloom, 2); gl.uniform1f(SH.u.uBloomK, R.bloomK);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    R.stats.show++;
  }

  // the rim pass, scissored to the front half of the band (+ the laser halo)
  function rimPass(theta, rs) {
    const pts = []; for (let k = 0; k <= 24; k++) { const a = -Math.PI / 2 + k / 24 * Math.PI; for (const y of [0, -PH]) pts.push(R.toPx([PR * Math.sin(a), y, PR * Math.cos(a)])); }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    let hx = 0, hy = 0, hi = 0, hr = 22 * R.dpr * (R.phone ? .75 : 1);
    if (rs.head) { const p = R.toPx(rs.head.p); hx = p[0]; hy = p[1]; hi = rs.head.i;
      x0 = Math.min(x0, hx - hr * 3); x1 = Math.max(x1, hx + hr * 3); y0 = Math.min(y0, hy - hr * 3); y1 = Math.max(y1, hy + hr * 3); }
    x0 = Math.max(0, Math.floor(x0) - 2); y0 = Math.max(0, Math.floor(y0) - 2); x1 = Math.min(R.W, Math.ceil(x1) + 2); y1 = Math.min(R.H, Math.ceil(y1) + 2);
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, R.W, R.H);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(RM.pr);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, rim.tex); gl.uniform1i(RM.u.uTex, 0);
    gl.uniform2f(RM.u.uTexel, 1.5 / TW, 2.5 / TH);
    gl.uniform2f(RM.u.uCenter, R.center[0], R.center[1]); gl.uniform1f(RM.u.uScale, R.scale); gl.uniform1f(RM.u.uTheta, theta);
    gl.uniform1fv(RM.u['uRev[0]'], rs.rev); gl.uniform1fv(RM.u['uHot[0]'], rs.hot);
    gl.uniform4f(RM.u.uHead, hx, hy, hi, hr); gl.uniform2f(RM.u.uGlint, rs.glint[0], rs.glint[1]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    R.stats.rim++;
  }

  // world → canvas px (GL, y up) and → CSS px (y down, relative to the canvas)
  R.toPx = (p) => { const q = toQ(p); return [R.center[0] + q[0] * R.scale, R.center[1] + q[1] * R.scale, q[2]]; };
  R.toCss = (p) => { const g = R.toPx(p); return [g[0] / R.dpr, (R.H - g[1]) / R.dpr, g[2]]; };
  R.rimExt = () => rim.ext;

  // screen boxes of the four bottles (CSS px), for the DOM tabs over them
  R.bottleBoxes = function (theta) {
    return BND.map(([br, bh], i) => {
      const a = theta + i * Math.PI / 2, c = [BR * Math.sin(a), 0, BR * Math.cos(a)];
      const b = R.toCss(c), t = R.toCss([c[0], bh * KS, c[2]]);
      const w = 2 * br * KS * R.scale / R.dpr * (FOC / b[2]);
      return { x: b[0] - w / 2, y: t[1], w, h: b[1] - t[1], front: Math.cos(a), cx: b[0], top: t[1] };
    });
  };

  // measure the trace cost on this machine once (sync with a 1-px read; warm-up first)
  R.calibrate = function () {
    const px = new Float32Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.acc.f); gl.viewport(0, 0, R.W, R.H);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, 1, 1);
    for (const P of [TR, TL]) { traceUniforms(R.center, R.scale, 0, 1, 1, P); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
    // the busiest rows: bottle bodies over the lacquer (GL rows 20–55 % of the scene box from the bottom)
    const [x, y, w, h] = R.bbox; const hy = Math.round(y + h * .2), hh = Math.max(8, Math.round(h * .35));
    gl.scissor(x, hy, w, hh);
    const time = (P) => { let best = 1e9; for (let k = 0; k < 2; k++) {
      const t0 = performance.now(); traceUniforms(R.center, R.scale, 0, 1 + k, 1, P); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(x, hy, 1, 1, gl.RGBA, gl.FLOAT, px); best = Math.min(best, performance.now() - t0); } return best; };
    const tq = time(TR), tl = time(TL);
    gl.disable(gl.SCISSOR_TEST);
    R.costPx = Math.max(1e-7, tq / (w * hh)); R.costLq = Math.max(1e-8, tl / (w * hh));
    R.plan(); R.invalidate();
    return { hq: tq, lq: tl, px: w * hh, costPx: R.costPx, costLq: R.costLq, liveS: R.liveS, bands: R.bands.length, bandH: R.bandH };
  };

  // one frame. st = { theta, moving, rim: {rev, hot, head, glint}, rimActive } → returns true while more work remains
  let seed = 0;
  R.frame = function (st, dt) {
    if (gl.isContextLost()) return false;
    let drew = false;
    const thetaChanged = st.theta !== R.tracedTheta;
    if (thetaChanged) {
      // live sample; the first one after a pause replaces, later ones blend (a short motion trail)
      traceLive(st.theta, R.liveFresh && !st.cut ? .34 : 0, ++seed % 997);
      R.liveFresh = true; R.tracedTheta = st.theta; R.pass = 0; R.cnt.fill(0); R.nextBand = 0; R.mix = 0; drew = true;
      R.restT = 0;
    } else if (R.mix < 1 || R.cnt.some((c, i) => i < R.bands.length && c < R.target)) {
      if (R.liveFresh) { traceLive(st.theta, 0, ++seed % 997); R.liveFresh = false; drew = true; }   // a clean live frame at rest
      else {
        const perFrame = Math.max(1, Math.floor(R.budget / Math.max(.05, R.costPx * R.bbox[2] * R.bandH)));
        traceBands(st.theta, perFrame); drew = true;
        const first = R.bands.every((_, i) => R.cnt[i] >= 1);
        if (first) R.mix = Math.min(1, R.mix + (st.instant ? 1 : dt / .22));
      }
    }
    if (drew) bloom();
    if (drew || st.rimActive || st.force) { show(); rimPass(st.theta, st.rim); R.stats.frames++; return true; }
    return false;
  };
  R.busy = () => R.mix < 1 || R.cnt.some((c, i) => i < R.bands.length && c < R.target);
  R.converged = () => !R.busy();

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); R.failed = true; onLost && onLost(); });
  return R;
}

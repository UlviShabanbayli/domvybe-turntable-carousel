// DV77 TURNTABLE · GLSL. One scene, three passes:
//   TRACE  the platter + four refracting bottles. Analytic platter/rim/base, and each bottle marched alone in its own
//          frame (a ray is only ever inside one bottle's bound), so a step costs one bottle's SDFs, not the scene's.
//   RIM    the brushed rim band with the engraving, analytic (no marching), 4 sub-samples, at native device resolution.
//   SHOW   resolve: accumulated full-res samples / the half-res live buffer → tone map → premultiplied canvas.

export const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

const COMMON = `
const float PR = 300., PH = 26., PB = 262., PBY = -64., KS = 1.32, BR = 212., BEV = 4.;
const vec3 CAM = vec3(0., 760., 1420.), TG = vec3(0., 70., 0.);
const float FOC = 1900.;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
vec3 camRay(vec2 frag, vec2 center, float scale){
  vec2 q = (frag - center) / scale;
  vec3 fw = normalize(TG - CAM), rt = normalize(cross(fw, vec3(0., 1., 0.))), up = cross(rt, fw);
  return normalize(fw*FOC + rt*q.x + up*q.y);
}
// the studio: a big warm soft box above the camera, two tall strips behind (warm left, cool right), a faint side card,
// and a warm back light low behind the platter (it is what makes the liquids glow)
vec3 env(vec3 d){
  float up = d.y, az = atan(d.x, d.z);
  vec3 c = vec3(.012, .010, .009) + vec3(.03, .025, .02) * smoothstep(-.2, .8, up);
  c += vec3(4.2, 3.7, 3.1) * smoothstep(.34, .22, length(vec2(az*.8, up - .72) * vec2(1., 1.3)));
  c += vec3(6.0, 5.0, 3.8) * smoothstep(.07, .035, abs(az - 2.55)) * smoothstep(-.3, -.1, up) * smoothstep(.8, .5, up);
  c += vec3(3.2, 3.4, 3.8) * smoothstep(.06, .03, abs(az + 2.5)) * smoothstep(-.3, -.1, up) * smoothstep(.8, .5, up);
  c += vec3(.5, .45, .4) * smoothstep(.12, .05, abs(az + 1.2)) * smoothstep(0., .2, up) * smoothstep(.6, .3, up);
  float baz = 3.14159 - abs(az);
  c += vec3(2.4, 1.75, 1.1) * smoothstep(.75, .3, length(vec2(baz, (up - .02)*1.5)));
  return c;
}
// the room seen straight through glass: the page colour after the tone map (≈ rgb 23,20,17) with the warm haze above
vec3 room(vec3 rd){
  return vec3(.014, .011, .009) + vec3(.05, .036, .022) * exp(-pow(rd.y + .12, 2.)/0.03) * exp(-pow(rd.x, 2.)/0.05);
}
// brushed silver, anisotropic along the circumference (the reflection is stretched vertically)
vec3 brushed(vec3 rd, vec3 n, float v, float az){
  vec3 r = reflect(rd, n); r.y *= .25; r = normalize(r);
  vec3 c = env(r) * vec3(.80, .76, .70) * .7 + vec3(.05, .045, .04);
  c += vec3(.25, .22, .18) * pow(max(dot(normalize(vec3(n.x, 0., n.z)), normalize(vec3(-.3, 0., 1.))), 0.), 6.);
  float streak = .5 + .5*sin(v*611. + sin(az*37.)*2.) * sin(v*173. + 1.7);
  return c * (.9 + .16*streak);
}
`;

// ---- the four flacons (local units; world = local × KS). Each bottle gets its own specialised SDF + march functions:
// with a dynamic bottle index every SDF call compiled to a four-way branch (measured 3-4× slower on ANGLE/Metal).
const BOTTLES = [
  { g: 'sdRB(q - vec3(0., 66.5, 0.), vec3(38., 66., 22.), 9.)', c: 'sdRB(q - vec3(0., 60., 0.), vec3(30., 50., 14.), 5.)', lv: '101.', cy: '128.',
    k: 'min(sdRB(q - vec3(0., 152., 0.), vec3(21., 18., 21.), 3.), sdCyl(q, 11., 128., 136., 1.))' },
  { g: 'min(sdEll(q - vec3(0., 58.5, 0.), vec3(60., 58., 36.)), sdCyl(q, 15., 100., 124., 3.))', c: 'sdEll(q - vec3(0., 58.5, 0.), vec3(49., 47., 26.))', lv: '92.', cy: '122.',
    k: 'sdCyl(q, 18., 122., 182., 5.)' },
  { g: 'sdHex(q - vec3(0., 64.5, 0.), 46., 61.) - 3.', c: 'sdHex(q - vec3(0., 60., 0.), 37., 50.)', lv: '103.', cy: '129.',
    k: 'length(q - vec3(0., 151., 0.)) - 22.' },
  { g: 'sdCyl(q, 42., .5, 150., 12.)', c: 'sdCyl(q, 34., 12., 140., 8.)', lv: '127.', cy: '148.',
    k: 'sdCyl(q, 30., 148., 186., 6.)' },
];
const bottleFnsFor = (steps) => BOTTLES.map((B, i) => `
float gS${i}(vec3 q){ return ${B.g}; }
float cS${i}(vec3 q){ return ${B.c}; }
float kS${i}(vec3 q){ float b = ${B.cy} - q.y; return b > 6. ? b : ${B.k}; }
int mAt${i}(vec3 q){ if (gS${i}(q) > 0.) return 0; if (cS${i}(q) < 0.) return q.y < ${B.lv} ? 2 : 3; return 1; }
vec3 nrm${i}(vec3 q, int w){
  if (w == 2) return vec3(0., 1., 0.);
  vec2 e = vec2(.04, -.04); vec3 a = q + e.xyy, b = q + e.yyx, c = q + e.yxy, d = q + e.xxx;
  if (w == 0) return normalize(e.xyy*gS${i}(a) + e.yyx*gS${i}(b) + e.yxy*gS${i}(c) + e.xxx*gS${i}(d));
  if (w == 1) return normalize(e.xyy*cS${i}(a) + e.yyx*cS${i}(b) + e.yxy*cS${i}(c) + e.xxx*cS${i}(d));
  return normalize(e.xyy*kS${i}(a) + e.yyx*kS${i}(b) + e.yxy*kS${i}(c) + e.xxx*kS${i}(d));
}
// from air into the bound: returns hit; t local, w = 0 glass, 3 cap
bool mAir${i}(vec3 lo, vec3 ld, float tmax, out float t, out int w){
  t = 0.; w = 0; float tp = 0.;
  for (int k = 0; k < ${steps}; k++) { vec3 p = lo + ld*t; float g = gS${i}(p), kk = kS${i}(p);
    float d = g; w = 0; if (kk < d) { d = kk; w = 3; }
    if (d < .03 && t > .2) return true;
    if (d < 0.) { float a0 = tp, a1 = t; for (int r = 0; r < 6; r++) { float m = (a0 + a1)*.5; vec3 pm = lo + ld*m; if (min(gS${i}(pm), kS${i}(pm)) < 0.) a1 = m; else a0 = m; }
      t = a1; vec3 pb = lo + ld*a1; w = kS${i}(pb) < gS${i}(pb) ? 3 : 0; return true; }
    tp = t; t += max(d*.9, .12); if (t > tmax) return false; }
  return false;
}
// inside (medium m): returns hit; t local; w = 0 outer glass, 1 cavity wall, 2 liquid level, 3 cap
bool mIn${i}(vec3 lo, vec3 ld, int m, out float t, out int w){
  t = 0.; w = 0; float tp = 0.;
  for (int k = 0; k < ${steps}; k++) { vec3 p = lo + ld*t;
    float g = gS${i}(p), c = cS${i}(p), kk = kS${i}(p);
    float d = abs(g); w = 0; float ac = abs(c); if (ac < d) { d = ac; w = 1; }
    float lv = max(abs(p.y - ${B.lv}), c); if (lv < d) { d = lv; w = 2; } if (kk < d) { d = kk; w = 3; }
    if (d < .03 && t > .2) return true;
    int mm = g > 0. ? 0 : c < 0. ? (p.y < ${B.lv} ? 2 : 3) : 1;
    if (mm != m) { float a0 = tp, a1 = t; for (int r = 0; r < 6; r++) { float h = (a0 + a1)*.5; if (mAt${i}(lo + ld*h) != m) a1 = h; else a0 = h; } t = a1;
      vec3 pa = lo + ld*a0, pb = lo + ld*a1; w = (gS${i}(pa) < 0.) != (gS${i}(pb) < 0.) ? 0 : (cS${i}(pa) < 0.) != (cS${i}(pb) < 0.) ? 1 : 2; return true; }
    tp = t; t += max(d*.9, .1); }
  return false;
}`).join('\n');
const dispatch = (ret, name, args, call) => `${ret} ${name}(int i, ${args}){ if (i == 0) return ${name}0(${call}); if (i == 1) return ${name}1(${call}); if (i == 2) return ${name}2(${call}); return ${name}3(${call}); }`;

export const makeTrace = ({ ev = 10, steps = 64, bounces = 2 } = {}) => `#version 300 es
precision highp float; out vec4 o;
uniform vec2 uCenter; uniform float uScale, uSeed, uTheta, uJit;
uniform vec3 uLiq[4];
${COMMON}
float sdRB(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, max(q.y, q.z)), 0.) - r; }
float sdCyl(vec3 p, float r, float y0, float y1, float rr){ vec2 d = vec2(length(p.xz) - r + rr, abs(p.y - (y0 + y1)*.5) - (y1 - y0)*.5 + rr); return min(max(d.x, d.y), 0.) + length(max(d, 0.)) - rr; }
float sdEll(vec3 p, vec3 r){ float k0 = length(p/r), k1 = length(p/(r*r)); return k0*(k0 - 1.)/k1; }
float sdHex(vec3 p, float r, float h){ const vec3 k = vec3(-0.8660254, 0.5, 0.57735); vec3 q = abs(p.xzy); q.xy -= 2.*min(dot(k.xy, q.xy), 0.)*k.xy;
  vec2 d = vec2(length(q.xy - vec2(clamp(q.x, -k.z*r, k.z*r), r))*sign(q.y - r), q.z - h); return min(max(d.x, d.y), 0.) + length(max(d, 0.)); }
${bottleFnsFor(steps)}
${dispatch('bool', 'mAir', 'vec3 lo, vec3 ld, float tmax, out float t, out int w', 'lo, ld, tmax, t, w')}
${dispatch('bool', 'mIn', 'vec3 lo, vec3 ld, int m, out float t, out int w', 'lo, ld, m, t, w')}
${dispatch('vec3', 'nrm', 'vec3 q, int w', 'q, w')}
float LV(int i){ return i == 0 ? ${BOTTLES[0].lv} : i == 1 ? ${BOTTLES[1].lv} : i == 2 ? ${BOTTLES[2].lv} : ${BOTTLES[3].lv}; }
vec2 BND(int i){ return i == 0 ? vec2(45., 172.) : i == 1 ? vec2(62., 184.) : i == 2 ? vec2(57., 175.) : vec2(43., 188.); }
float IOR(int m){ return m == 1 ? 1.5 : m == 2 ? 1.36 : 1.; }
vec3 rotY(vec3 v, float a){ float c = cos(a), s = sin(a); return vec3(c*v.x + s*v.z, v.y, -s*v.x + c*v.z); }
float ang(int i){ return uTheta + float(i)*1.5707963; }
vec3 ctr(int i){ float a = ang(i); return vec3(BR*sin(a), 0., BR*cos(a)); }
vec2 cylHit(vec3 o, vec3 d, float r, float h){
  float a = dot(d.xz, d.xz), b = dot(o.xz, d.xz), c = dot(o.xz, o.xz) - r*r;
  float t0 = -1e9, t1 = 1e9;
  if (a > 1e-8) { float D = b*b - a*c; if (D < 0.) return vec2(1e9, -1e9); D = sqrt(D); t0 = (-b - D)/a; t1 = (-b + D)/a; }
  else if (c > 0.) return vec2(1e9, -1e9);
  if (abs(d.y) > 1e-8) { float y0 = (0. - o.y)/d.y, y1 = (h - o.y)/d.y; t0 = max(t0, min(y0, y1)); t1 = min(t1, max(y0, y1)); }
  else if (o.y < 0. || o.y > h) return vec2(1e9, -1e9);
  return vec2(t0, t1);
}
float sideHit(vec3 o, vec3 d, float r, float y0, float y1){
  float a = dot(d.xz, d.xz), b = dot(o.xz, d.xz), c = dot(o.xz, o.xz) - r*r;
  if (a < 1e-8 || c < 0.) return 1e9; float D = b*b - a*c; if (D < 0.) return 1e9;
  float t = (-b - sqrt(D))/a; if (t <= 0.) return 1e9; float y = o.y + d.y*t; return (y >= y0 && y <= y1) ? t : 1e9;
}
vec3 capShade(int i, vec3 p, vec3 rd, vec3 n){
  vec3 r = reflect(rd, n); float ci = max(dot(-rd, n), 0.);
  vec3 F0 = i == 0 ? vec3(1., .78, .45) : i == 2 ? vec3(.62, .62, .66) : vec3(.04);
  vec3 F = F0 + (1. - F0)*pow(1. - ci, 5.);
  vec3 c = env(r) * F;
  if (i == 1) c += vec3(.006);
  if (i == 2) c *= .55;
  if (i == 3) { float g = .5 + .5*sin(p.y*.9 + sin(p.x*.08)*3.); c += vec3(.10, .055, .03) * (.6 + .4*g) * (.4 + .6*max(dot(n, normalize(vec3(-.3, .8, .5))), 0.)); }
  return c;
}
void main(){
  vec2 jit = (vec2(h21(vec2(uSeed, 1.7)), h21(vec2(uSeed, 9.1))) - .5) * uJit;
  vec3 rd = camRay(gl_FragCoord.xy + jit, uCenter, uScale), ro = CAM;
  vec2 nz = gl_FragCoord.xy + uSeed*17.13;
  vec3 col = vec3(0.), thr = vec3(1.);
  float alpha = 0.;
  { vec3 bmin = vec3(-PR - 4., PBY - 4., -PR - 4.), bmax = vec3(PR + 4., 262., PR + 4.);
    vec3 i0 = (bmin - ro)/rd, i1 = (bmax - ro)/rd; vec3 tn3 = min(i0, i1), tf3 = max(i0, i1);
    float tn = max(max(tn3.x, tn3.y), tn3.z), tf = min(min(tf3.x, tf3.y), tf3.z);
    if (tn > tf || tf < 0.) { o = vec4(0.); return; }
    ro += rd*max(tn - 1., 0.); }
  int med = 0, cb = 0, bounces = 0;
  for (int ev = 0; ev < ${ev}; ev++) {
    if (med == 0) {
      float tb = 1e9; int bi = -1; vec2 seg = vec2(0.);
      for (int i = 0; i < 4; i++) {
        float a = ang(i); vec3 lo = rotY(ro - ctr(i), -a)/KS, ld = rotY(rd, -a);
        vec2 bd = BND(i); vec2 h = cylHit(lo, ld, bd.x, bd.y) * KS;
        if (h.y > 0. && h.x < h.y && max(h.x, 0.) < tb) { tb = max(h.x, 0.); bi = i; seg = h; }
      }
      float tt = 1e9;
      if (rd.y < 0. && ro.y > -.5) { float t = max(-ro.y/rd.y, 0.); vec3 p = ro + rd*t; if (dot(p.xz, p.xz) < PR*PR) tt = t; }
      float tr = sideHit(ro, rd, PR, -PH, 0.), tq = sideHit(ro, rd, PB, PBY, -PH);
      float tp = min(tt, min(tr, tq));
      if (bi >= 0 && tb < tp) {
        float a = ang(bi); vec3 lo = rotY(ro + rd*tb - ctr(bi), -a)/KS, ld = rotY(rd, -a);
        float t; int w;
        if (!mAir(bi, lo, ld, (seg.y - tb)/KS, t, w)) { ro = ro + rd*(seg.y + .05); continue; }
        vec3 q = lo + ld*t; vec3 n = rotY(nrm(bi, q, w), a); vec3 pw = ro + rd*(tb + t*KS);
        alpha = 1.;
        if (w == 3) { col += thr * capShade(bi, q, rd, n); break; }
        if (dot(n, rd) > 0.) n = -n;
        float ci = -dot(rd, n), F = .04 + .96*pow(1. - ci, 5.);
        col += thr * F * env(reflect(rd, n)) * 1.2;
        thr *= 1. - F; rd = refract(rd, n, 1./1.5); ro = pw + rd*.1; med = 1; cb = bi;
        continue;
      }
      if (tp >= 1e8) { col += thr * (bounces == 0 ? room(rd) : env(rd) * .9); break; }
      vec3 p = ro + rd*tp; alpha = 1.;
      if (tp == tt) {
        float r = length(p.xz); vec3 n = vec3(0., 1., 0.);
        float s = clamp((r - (PR - BEV))/BEV, 0., 1.);
        if (s > 0.) { float th = s*1.35; n = normalize(vec3(p.x/r*sin(th), cos(th), p.z/r*sin(th))); }
        float ci = max(dot(-rd, n), 0.), F = .04 + .96*pow(1. - ci, 5.);
        col += thr * vec3(.006, .005, .0045) * (1. - F);
        thr *= F; rd = reflect(rd, n); ro = p + vec3(0., .3, 0.);
        rd = normalize(rd + (vec3(h21(nz), h21(nz*1.7 + 3.1), h21(nz*.3 + 7.7)) - .5)*.010);
        if (++bounces > ${bounces}) break;
        continue;
      }
      if (tp == tr) { vec3 n = normalize(vec3(p.x, 0., p.z)); float v = -p.y/PH; n = normalize(n + vec3(0., 1., 0.)*smoothstep(.1, 0., v)*1.2);
        col += thr * brushed(rd, n, v, atan(p.x, p.z)); break; }
      { vec3 n = normalize(vec3(p.x, 0., p.z)); float ci = max(dot(-rd, n), 0.);
        col += thr * (vec3(.012, .010, .009) + env(reflect(rd, n)) * (.03 + .3*pow(1. - ci, 5.)) * .5); break; }
    }
    // inside bottle cb
    float a = ang(cb); vec3 lo = rotY(ro - ctr(cb), -a)/KS, ld = rotY(rd, -a);
    float t; int w; bool hit = mIn(cb, lo, ld, med, t, w);
    float dt = t*KS;
    if (med == 2) { vec3 lc = uLiq[cb]; thr *= exp(-(1. - lc)*.0075*dt - .001*dt); col += thr * lc * lc * .0024 * dt * (1.2 + .8*smoothstep(-.2, .6, rd.y)); }
    else if (med == 1) thr *= exp(-vec3(.001, .0006, .0008)*dt);
    if (!hit) break;
    vec3 q = lo + ld*t; vec3 pw = ro + rd*dt;
    vec3 n = rotY(nrm(cb, q, w), a);
    if (w == 3) { col += thr * capShade(cb, q, rd, n) * .6; break; }
    if (dot(n, rd) > 0.) n = -n;
    int nm = w == 0 ? 0 : w == 1 ? (med == 1 ? (q.y < LV(cb) ? 2 : 3) : 1) : (med == 2 ? 3 : 2);
    float n1 = IOR(med), n2 = IOR(nm);
    float ci = -dot(rd, n), r0 = pow((n1 - n2)/(n1 + n2), 2.), F = r0 + (1. - r0)*pow(1. - ci, 5.);
    col += thr * F * env(reflect(rd, n)) * (med == 1 && nm == 0 ? .22 : .08);
    vec3 rf = refract(rd, n, n1/n2);
    if (dot(rf, rf) < .001) { rd = reflect(rd, n); ro = pw + rd*.1; continue; }
    thr *= 1. - F; rd = rf; ro = pw + rd*.1; med = nm;
    if (med == 0) ro += rd*.05;
  }
  // rays still inside glass when the event budget runs out: let them see the studio through what is left
  if (med != 0) col += thr * room(rd) * 2.;
  o = vec4(col * alpha, alpha);
}`;
export const TRACE = makeTrace();
export const TRACE_LQ = makeTrace({ ev: 7, steps: 40, bounces: 1 });

export const RIM = `#version 300 es
precision highp float; out vec4 o;
uniform vec2 uCenter; uniform float uScale, uTheta, uTime;
uniform sampler2D uTex; uniform vec2 uTexel;
uniform float uRev[4], uHot[4];
uniform vec4 uHead;   // head px (x, y), intensity, radius px
uniform vec2 uGlint;  // az, amplitude
${COMMON}
float tnear(vec3 o, vec3 d, float r){ float a = dot(d.xz, d.xz), b = dot(o.xz, d.xz), c = dot(o.xz, o.xz) - r*r; float D = b*b - a*c; if (D < 0.) return -1.; return (-b - sqrt(D))/a; }
vec4 shade(vec2 frag){
  vec3 rd = camRay(frag, uCenter, uScale);
  float t = tnear(CAM, rd, PR); if (t < 0.) return vec4(0.);
  vec3 p = CAM + rd*t; if (p.y > 0. || p.y < -PH) return vec4(0.);
  float az = atan(p.x, p.z), v = -p.y/PH;
  vec3 n = normalize(vec3(p.x, 0., p.z));
  n = normalize(n + vec3(0., 1., 0.)*smoothstep(.1, 0., v)*1.2 - vec3(0., 1., 0.)*smoothstep(.9, 1., v)*.6);
  // texture coords: rim-local angle, segment i centred at u = (i + .5)/4
  float ph = az - uTheta; float u = fract(ph/6.2831853 + .125);
  int seg = int(floor(u*4.));
  vec2 uv = vec2(u, v);
  vec4 tx = texture(uTex, uv);
  float rev = uRev[seg] > 0. ? smoothstep(uRev[seg] + .0004, uRev[seg] - .0004, u) : 0.;
  float m = tx.r*rev, mk = tx.g;
  // groove normals from the softened mask (blue channel)
  float bx = texture(uTex, uv + vec2(uTexel.x, 0.)).b*rev - texture(uTex, uv - vec2(uTexel.x, 0.)).b*rev;
  float by = texture(uTex, uv + vec2(0., uTexel.y)).b - texture(uTex, uv - vec2(0., uTexel.y)).b;
  float bxm = texture(uTex, uv + vec2(uTexel.x, 0.)).a - texture(uTex, uv - vec2(uTexel.x, 0.)).a;
  float bym = texture(uTex, uv + vec2(0., uTexel.y)).a - texture(uTex, uv - vec2(0., uTexel.y)).a;
  vec3 tg = normalize(vec3(n.z, 0., -n.x));
  vec3 ng = normalize(n + tg*(bx*1.6 + bxm*.9) - vec3(0., 1., 0.)*(by*rev*1.6 + bym*.9));
  vec3 base = brushed(rd, ng, v, az);
  // idle glint: a soft light travelling along the band
  base += vec3(.9, .8, .65) * uGlint.y * exp(-pow((az - uGlint.x)/.12, 2.)) * (1. - m*.6) * smoothstep(0., .25, v) * smoothstep(1., .75, v);
  // the cut: the floor is matte and darker, then gilded; the walls catch the light (ng above)
  vec3 r = reflect(rd, ng); float ci = max(dot(-rd, ng), 0.);
  vec3 gold = env(normalize(vec3(r.x, r.y*.4, r.z))) * (vec3(1., .78, .45) + (1. - vec3(1., .78, .45))*pow(1. - ci, 5.)) * .8 + vec3(.20, .135, .06);
  vec3 c = mix(base, base*.18, mk*.85);
  c = mix(c, gold, m*.92);
  // heat: the fresh cut glows orange → gold, cooling behind the head
  float hot = uHot[seg]; if (hot > 0.) { float behind = max(uRev[seg] - u, 0.); float hh = exp(-behind/.006) * hot + exp(-behind/.03) * hot * .35;
    c += m * (vec3(3.2, 1.25, .35)*hh + vec3(1.1, .62, .22)*hot*.35); }
  return vec4(c, 1.);
}
void main(){
  vec4 acc = vec4(0.);
  acc += shade(gl_FragCoord.xy + vec2(-.125, -.375)); acc += shade(gl_FragCoord.xy + vec2(.375, -.125));
  acc += shade(gl_FragCoord.xy + vec2(.125, .375)); acc += shade(gl_FragCoord.xy + vec2(-.375, .125));
  acc *= .25;
  // laser head: a hot core and a warm halo (additive; also over the lacquer and the dark below the rim)
  vec3 add = vec3(0.);
  if (uHead.z > 0.) { float d = length(gl_FragCoord.xy - uHead.xy);
    add = uHead.z * (vec3(4.0, 3.4, 2.4) * exp(-pow(d/(uHead.w*.14), 2.)) + vec3(1.6, .62, .16) * exp(-pow(d/(uHead.w*.6), 2.)) * .45
        + vec3(.6, .22, .05) * exp(-d/(uHead.w*.9)) * .16) * smoothstep(uHead.w*2.9, uHead.w*1.2, d); }
  vec3 c = acc.rgb + add;            // linear, premultiplied by coverage
  // the same tone map as SHOW, applied to the un-premultiplied colour
  float a = acc.a; vec3 lin = a > 0. ? acc.rgb/a : vec3(0.);
  vec3 x = lin*1.1; vec3 tm = clamp((x*(2.51*x + .03))/(x*(2.43*x + .59) + .14), 0., 1.); tm = pow(tm, vec3(1./2.2));
  vec3 xa = add*1.1; vec3 ta = clamp((xa*(2.51*xa + .03))/(xa*(2.43*xa + .59) + .14), 0., 1.); ta = pow(ta, vec3(1./2.2));
  vec3 outc = tm*a + ta*(1. - a*.5);
  o = vec4(outc, max(a, 0.));
}`;

// resolve helper shared by SHOW and the bloom's bright pass: live (half-res) and accumulated (full-res bands) mixed
const RESOLVE = `
uniform sampler2D uAcc, uLive; uniform float uMix, uCnt[16]; uniform vec2 uRes; uniform float uBandY0, uBandH;
vec4 resolve(vec2 frag){
  vec2 uv = frag/uRes; vec4 c = texture(uLive, uv);
  if (uMix > 0.) { int b = clamp(int((frag.y - uBandY0)/uBandH), 0, 15); float n = max(uCnt[b], 1.); c = mix(c, texture(uAcc, uv)/n, uMix); }
  return c;
}
vec3 tmap(vec3 lin){ vec3 x = lin*1.1; return pow(clamp((x*(2.51*x + .03))/(x*(2.43*x + .59) + .14), 0., 1.), vec3(1./2.2)); }`;

export const BRIGHT = `#version 300 es
precision highp float; out vec4 o; uniform float uDown;
${RESOLVE}
void main(){
  vec2 f = gl_FragCoord.xy*uDown; float h = uDown*.25;
  vec4 c = (resolve(f + vec2(-h, -h)) + resolve(f + vec2(h, -h)) + resolve(f + vec2(-h, h)) + resolve(f + vec2(h, h)))*.25;
  vec3 lin = c.rgb;                                        // premultiplied linear
  float l = max(max(lin.r, lin.g), lin.b);
  o = vec4(lin * smoothstep(.55, 2.2, l), 1.);
}`;

export const BLUR = `#version 300 es
precision highp float; out vec4 o; uniform sampler2D uSrc; uniform vec2 uDir, uSize;
void main(){
  vec2 uv = gl_FragCoord.xy/uSize;
  vec3 c = texture(uSrc, uv).rgb*.227;
  c += (texture(uSrc, uv + uDir*1.385).rgb + texture(uSrc, uv - uDir*1.385).rgb)*.316;
  c += (texture(uSrc, uv + uDir*3.231).rgb + texture(uSrc, uv - uDir*3.231).rgb)*.070;
  o = vec4(c, 1.);
}`;

export const SHOW = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D uBloom; uniform float uBloomK;
${RESOLVE}
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
void main(){
  vec4 c = resolve(gl_FragCoord.xy);
  vec3 b = texture(uBloom, gl_FragCoord.xy/uRes).rgb * uBloomK;
  float a = clamp(c.a, 0., 1.);
  if (a < .002 && dot(b, vec3(1.)) < .0005) { o = vec4(0.); return; }
  vec3 lin = a > .002 ? c.rgb/a : vec3(0.);
  vec3 col = tmap(lin + b)*a + tmap(b)*(1. - a);
  col += (h21(gl_FragCoord.xy) - .5)/255.;
  o = vec4(max(col, 0.), a);
}`;

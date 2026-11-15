/* VINTO 3D engine.
   Turns each flat product photo into a soft, inflated 3D garment (front + back),
   and drives three stages: the Distressed Zip Up film, the spinning lineup, and the product viewer.
   Depends only on three.module.min.js, which sits next to this file. */
import * as THREE from './three.module.min.js';

const TAU = Math.PI * 2;
const SEAM = 0.035;                       // front and back halves overlap by this much
const THICK = 0.135;                       // half-thickness of a garment whose height is 2 units
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const reduceMotion = matchMedia('(prefers-reduced-motion:reduce)').matches;

/* Distressed Zip Up: positions measured on the product photo, in garment units (height = 2). */
const ZIP = {
  cx: 0.009,          // zipper line
  top: 0.553,         // slider when fully zipped
  end: -0.56,         // slider when unzipped
  hinge: 0.47,        // half-width of the front panels
  logo: [0, 0.19],
  pull: [0.009, 0.47],
  pullW: 0.168,       // width of the zip pull
};

export function webglOK() {
  try { const c = document.createElement('canvas'); return !!(window.WebGL2RenderingContext && c.getContext('webgl2')); }
  catch (e) { return false; }
}

/* ---------- shaders ---------- */
/* The inside fabric: a pilled cotton fleece, modelled on the brand's fabric photo.
   A tight field of small rounded nubs, matte, lying in soft folds. Returns a brightness
   around 1.0 that is multiplied by the fleece colour of each piece. */
const FLEECE = /* glsl */`
float vh(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec2 vh2(vec2 p){ float n = vh(p); return vec2(n, vh(p + n * 19.19 + 7.7)); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(vh(i), vh(i+vec2(1,0)), f.x), mix(vh(i+vec2(0,1)), vh(i+vec2(1,1)), f.x), f.y); }
float fb(vec2 p){ float a = .5, s = 0.; for(int i=0;i<3;i++){ s += a*vn(p); p = p*2.03 + 17.3; a *= .5; } return s; }
// rounded nubs: xy = slope, z = height
vec3 nubs(vec2 p){
  vec2 i = floor(p), f = fract(p); float best = 9.0; vec2 bv = vec2(0.0); float br = 0.5;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 g = vec2(float(x), float(y)); vec2 o = vh2(i + g);
    vec2 v = g + 0.12 + 0.76*o - f;
    float r = 0.46 + 0.24*fract(o.x*7.3 + o.y*3.1);
    float d = dot(v, v) / (r*r);
    if (d < best){ best = d; bv = v; br = r; }
  }
  float h = sqrt(max(0.0, 1.0 - best));
  vec2 slope = best < 1.0 ? bv / (br*br*max(h, 0.3)) : vec2(0.0);
  return vec3(slope, h);
}
float fleeceShade(vec2 g, vec2 q, float folds){
  // folds: broad soft rolls lit from the upper left, with deep pockets between them
  vec2 w = vec2(fb(q*0.7 + 3.1), fb(q*0.7 + 9.7)) - 0.5;
  vec2 qq = q + w*0.9;
  float e = 0.07, f0 = fb(qq);
  float lit = (fb(qq + vec2(-e, e)) - fb(qq + vec2(e, -e))) / (2.0*e);
  float fold = mix(1.0, (0.62 + 0.62*smoothstep(0.22, 0.72, f0)) * (1.0 + clamp(lit*0.85, -0.55, 0.6)), folds);
  // pile: two sizes of nub, fading out before they get smaller than a pixel
  float fine = clamp(1.6 - 1.4*fwidth(g.x), 0.0, 1.0);
  vec3 a = nubs(g), b = nubs(g*2.3 + 7.0);
  vec2 slope = a.xy*0.6 + b.xy*0.55;
  float h = a.z*0.6 + b.z*0.4;
  vec3 n = normalize(vec3(-slope*0.42, 1.0));
  float d = dot(n, normalize(vec3(-0.5, 0.55, 0.68)));
  float pile = (0.7 + 0.44*d) * (0.84 + 0.16*smoothstep(0.0, 0.55, h));
  pile += 0.09*(vn(g*4.3) - 0.5) + 0.07*(vn(g*11.0) - 0.5);       // loose fibres soften the nubs
  return fold * mix(0.98, pile, fine);
}`;

const GARMENT_VS = /* glsl */`
attribute float aSide, aRise;
uniform float uZipY, uOpen;
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDepth; varying vec2 vP; varying vec2 vLean; varying float vRise;
void main(){
  vec3 p = position; vec3 n = normal;
  vLean = normal.xy; vRise = aRise;
  #ifdef ZIPPED
    float r = max(HINGE - abs(p.x - CX), 0.0) / HINGE;
    float g = smoothstep(uZipY, uZipY + 0.46, p.y);
    float o = uOpen * g * r;
    p.x += aSide * o * 0.25;
    p.z += o * 0.15 * (0.35 + 0.65 * r);
    n = normalize(n + vec3(-aSide * o * 0.9, 0.0, 0.0));
  #endif
  vUv = uv; vP = position.xy;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * n);
  vV = normalize(-mv.xyz);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const GARMENT_FS = /* glsl */`
uniform sampler2D map;
uniform float uDim, uSil, uShade;
uniform vec3 uFog;            // near, far, strength
varying vec2 vUv; varying vec3 vN; varying vec3 vV; varying float vDepth; varying vec2 vP; varying vec2 vLean; varying float vRise;
uniform vec2 uSize;
#ifdef INNER
uniform sampler2D panels;
uniform float uZipY, uOpen;
uniform vec3 uTint;
${FLEECE}
#endif
void main(){
  // the rim of the shape (its side wall) takes colour from just inside the edge rather than smearing the outline
  float lean = length(vLean);
  float wall = (1.0 - smoothstep(0.06, 0.34, vRise)) * smoothstep(0.55, 0.85, lean) * smoothstep(0.004, 0.03, vRise);
  vec2 uvIn = vUv - (vLean / max(lean, 1e-4)) * wall * 0.05 / uSize;
  vec4 t = texture2D(map, uvIn);
  float a0 = texture2D(map, vUv).a;
  float a = clamp((a0 - 0.5) / max(fwidth(a0), 1e-4) + 0.5, 0.0, 1.0);
  a = max(a, wall * step(0.5, t.a));
  if (a < 0.02) discard;
  vec3 c = t.rgb;
  #ifdef INNER
    // the photo shows through until the zip opens; then the gap between the panels is fleece,
    // except inside the hood where the photo already shows the lining and neck label
    float wedge = clamp(t.a - texture2D(panels, vUv).a, 0.0, 1.0);
    float gap = 0.25 * uOpen * smoothstep(uZipY, uZipY + 0.46, vP.y);
    float ax = abs(vP.x - CX);
    float inGap = (1.0 - smoothstep(gap, gap + 0.03, ax)) * step(0.004, gap);
    float ao = 0.45 + 0.55 * smoothstep(gap + 0.01, gap * 0.3, ax);
    vec3 fl = uTint * fleeceShade(vUv * 330.0, vUv * 4.0, 0.5) * ao;
    c = mix(c, fl, inGap * (1.0 - smoothstep(0.2, 0.85, wedge)));
  #endif
  vec3 n = normalize(vN);
  float d = max(dot(n, normalize(vec3(-0.45, 0.62, 0.72))), 0.0);
  float rim = pow(1.0 - max(dot(n, normalize(vV)), 0.0), 2.6);
  c = mix(c, vec3(dot(c, vec3(0.333))) * 0.42, uSil);
  c *= mix(1.0, 0.74 + 0.40 * d, uShade);
  c += rim * 0.085 * (1.0 - uSil) * uShade;
  c *= uDim * (1.0 - uFog.z * smoothstep(uFog.x, uFog.y, vDepth));
  gl_FragColor = vec4(c, a);
}`;

const OVERLAY_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const OVERLAY_FS = /* glsl */`
uniform float uMix, uScale, uTime, uAspect;
uniform vec3 uTint;
varying vec2 vUv;
${FLEECE}
void main(){
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(p);
  vec2 drift = vec2(uTime * 0.012, -uTime * 0.008);
  float shade = fleeceShade((p + drift) * uScale * 8.0, p * uScale * 0.12 + drift * 0.6 + 2.0, 1.0);
  float pale = dot(uTint, vec3(0.333));
  shade = mix(shade, 1.0, 0.62 * pale);                            // pale fleece holds less shadow
  float sweep = smoothstep(0.6, 0.0, abs(p.x * 0.6 + p.y - 0.2 + sin(uTime * 0.35) * 0.3));
  vec3 c = uTint * shade * (0.96 + 0.16 * sweep);
  c *= 1.0 - mix(0.55, 0.16, pale) * smoothstep(0.3, 1.0, r);
  gl_FragColor = vec4(min(c, vec3(1.0)), uMix);
}`;

/* ---------- image → height field → mesh ---------- */
const imgCache = new Map();
function loadImage(src) {
  if (!imgCache.has(src)) imgCache.set(src, new Promise((res, rej) => {
    const im = new Image(); im.decoding = 'async';
    im.onload = () => res(im); im.onerror = () => rej(new Error('Could not load ' + src)); im.src = src;
  }));
  return imgCache.get(src);
}
const texCache = new Map();
async function loadTexture(src, max = 0) {              // max: cap the longest side (lineup pieces are drawn small)
  const key = src + '@' + max;
  if (!texCache.has(key)) texCache.set(key, loadImage(src).then(im => {
    let source = im; const big = Math.max(im.naturalWidth, im.naturalHeight);
    if (max && big > max) {
      const c = document.createElement('canvas'), k = max / big;
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(im, 0, 0, c.width, c.height); source = c;
    }
    const t = new THREE.Texture(source);
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = 8; t.needsUpdate = true;
    return t;
  }));
  return texCache.get(key);
}

const fieldCache = new Map();
/* Height field for a photo: the silhouette is "inflated" by solving a Poisson equation inside it,
   which gives one smooth cloth-like surface with no creases down the middle of sleeves or legs. */
async function loadField(src, N = 208) {
  const key = src + '@' + N;
  if (!fieldCache.has(key)) fieldCache.set(key, loadImage(src).then(im => {
    const ar = im.naturalWidth / im.naturalHeight;
    const gw = ar >= 1 ? N : Math.max(8, Math.round(N * ar)), gh = ar >= 1 ? Math.max(8, Math.round(N / ar)) : N;
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high'; cx.drawImage(im, 0, 0, gw, gh);
    const px = cx.getImageData(0, 0, gw, gh).data, n = gw * gh;
    const solid = new Uint8Array(n);
    for (let k = 0; k < n; k++) solid[k] = px[k * 4 + 3] > 150 ? 1 : 0;
    // start the surface one cell inside the opaque edge, so its side wall is never see-through
    const ins = new Uint8Array(n);
    for (let j = 1; j < gh - 1; j++) for (let i = 1; i < gw - 1; i++) {
      const k = j * gw + i;
      ins[k] = solid[k] & solid[k - 1] & solid[k + 1] & solid[k - gw] & solid[k + gw];
    }
    const u = new Float32Array(n), W = 1.93, its = Math.round(N * 1.15);
    for (let it = 0; it < its; it++) {
      for (let j = 1; j < gh - 1; j++) { const r = j * gw; for (let i = 1; i < gw - 1; i++) { const k = r + i; if (ins[k]) u[k] += W * ((u[k - 1] + u[k + 1] + u[k - gw] + u[k + gw] + 1) * 0.25 - u[k]); } }
      it++;
      for (let j = gh - 2; j > 0; j--) { const r = j * gw; for (let i = gw - 2; i > 0; i--) { const k = r + i; if (ins[k]) u[k] += W * ((u[k - 1] + u[k + 1] + u[k - gw] + u[k + gw] + 1) * 0.25 - u[k]); } }
    }
    let top = 1e-6; for (let k = 0; k < n; k++) if (u[k] > top) top = u[k];
    let h = new Float32Array(n);
    for (let k = 0; k < n; k++) h[k] = Math.pow(u[k] / top, 0.42);      // flat across the middle, rounded at the edges
    for (let pass = 0; pass < 3; pass++) {                                // soften the edge wall and its stair-steps
      const o = new Float32Array(n);
      for (let j = 1; j < gh - 1; j++) for (let i = 1; i < gw - 1; i++) {
        const k = j * gw + i;
        o[k] = (h[k] * 4 + (h[k - 1] + h[k + 1] + h[k - gw] + h[k + gw]) * 2 + h[k - gw - 1] + h[k - gw + 1] + h[k + gw - 1] + h[k + gw + 1]) / 16;
      }
      h = o;
    }
    return {
      gw, gh, ar,
      at(u_, v_) {
        const x = clamp(u_) * (gw - 1), y = clamp(v_) * (gh - 1), i = Math.min(gw - 2, x | 0), j = Math.min(gh - 2, y | 0), fx = x - i, fy = y - j, k = j * gw + i;
        return lerp(lerp(h[k], h[k + 1], fx), lerp(h[k + gw], h[k + gw + 1], fx), fy);
      },
    };
  }));
  return fieldCache.get(key);
}

/* A grid patch of the inflated surface between u0..u1 (v runs the full height). */
function patch(field, W, H, u0, u1, nx, ny, depth, side = 0) {
  const n = (nx + 1) * (ny + 1), pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2), sd = new Float32Array(n), ht = new Float32Array(n);
  const eu = 1 / field.gw, ev = 1 / field.gh, rise = depth + SEAM;
  let k = 0;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++, k++) {
    const u = lerp(u0, u1, i / nx), v = j / ny;
    ht[k] = field.at(u, v);
    pos[k * 3] = (u - 0.5) * W; pos[k * 3 + 1] = (0.5 - v) * H; pos[k * 3 + 2] = ht[k] * rise - SEAM;
    const dx = (field.at(u + eu, v) - field.at(u - eu, v)) * rise / (2 * eu * W);
    const dy = (field.at(u, v - ev) - field.at(u, v + ev)) * rise / (2 * ev * H);
    const l = Math.hypot(dx, dy, 1);
    nor[k * 3] = -dx / l; nor[k * 3 + 1] = -dy / l; nor[k * 3 + 2] = 1 / l;
    uv[k * 2] = u; uv[k * 2 + 1] = 1 - v; sd[k] = side;
  }
  const idx = new Uint32Array(nx * ny * 6); let q = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, e = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = e;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSide', new THREE.BufferAttribute(sd, 1));
  g.setAttribute('aRise', new THREE.BufferAttribute(ht, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function material(map, defines = {}, extra = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: GARMENT_VS, fragmentShader: GARMENT_FS, alphaToCoverage: true, side: THREE.FrontSide,
    defines: { CX: ZIP.cx.toFixed(4), HINGE: ZIP.hinge.toFixed(4), ...defines },
    uniforms: { map: { value: map }, uDim: { value: 1 }, uSil: { value: 0 }, uShade: { value: 1 }, uSize: { value: new THREE.Vector2(2, 2) }, uFog: { value: new THREE.Vector3(0, 1, 0) }, uZipY: { value: ZIP.top }, uOpen: { value: 0 }, ...extra },
  });
}

/* spec: { front, back?, zip?: { panels, pull }, size?, light?, fleece?: [r,g,b], maxTex? } */
export async function buildGarment(spec) {
  const size = spec.size || 2;
  const mt = spec.maxTex || 0, fn = mt ? 128 : 208;                   // lineup pieces are drawn small: lighter mesh
  const [fField, fTex] = await Promise.all([loadField(spec.front, fn), loadTexture(spec.front, mt)]);
  const H = fField.ar >= 1 ? size / fField.ar : size, W = H * fField.ar;
  const depth = THICK * Math.min(1.15, Math.max(0.55, Math.min(W, H) / 2 + 0.2)) * (spec.light ? 0.78 : 1);
  const tint = spec.fleece || [0.285, 0.285, 0.29];              // colour of the fleece inside this piece
  const g = { group: new THREE.Group(), mats: [], W, H, depth, hasBack: !!spec.back, light: !!spec.light, tint, zip: null, spec };
  const nxFor = w => Math.max(24, Math.round((mt ? 56 : 92) * w));

  if (spec.zip) {
    const [pTex, pullTex] = await Promise.all([loadTexture(spec.zip.panels), loadTexture(spec.zip.pull)]);
    const uC = 0.5 + ZIP.cx / W;
    const inner = new THREE.Mesh(patch(fField, W, H, 0, 1, 96, 96, depth * 0.3), material(fTex, { INNER: '' }, { panels: { value: pTex }, uTint: { value: new THREE.Vector3(...tint) } }));
    const left = new THREE.Mesh(patch(fField, W, H, 0, uC, 96, 184, depth, -1), material(pTex, { ZIPPED: '' }));
    const right = new THREE.Mesh(patch(fField, W, H, uC, 1, 96, 184, depth, 1), material(pTex, { ZIPPED: '' }));
    // the pull rides on the fabric: its height and tilt follow the surface along the zip line
    const ph = ZIP.pullW * 949 / 1181;
    const pg = new THREE.PlaneGeometry(ZIP.pullW, ph); pg.translate(-0.024 * ZIP.pullW, -ph / 2 + ph * 0.008, 0);
    const pull = new THREE.Group();
    const shadow = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ map: pullTex, color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }));
    shadow.position.set(0.006, -0.008, -0.003); shadow.scale.setScalar(1.03); shadow.renderOrder = 4;
    const metal = new THREE.Mesh(pg, new THREE.MeshBasicMaterial({ map: pullTex, transparent: true, depthWrite: false }));
    metal.renderOrder = 5;
    pull.add(shadow, metal);
    const surf = y => fField.at(uC, 0.5 - y / H) * (depth + SEAM) - SEAM;
    g.group.add(inner, left, right, pull);
    g.mats.push(inner.material, left.material, right.material);
    g.zip = { mats: [inner.material, left.material, right.material], pull, surf, t: 0, depth };
    setZip(g, 0);
  } else {
    const m = new THREE.Mesh(patch(fField, W, H, 0, 1, nxFor(W), nxFor(H), depth), material(fTex));
    g.group.add(m); g.mats.push(m.material);
  }

  // back: its own photo when there is one, otherwise a shaded silhouette of the front
  const backSrc = spec.back || spec.front;
  const [bField, bTex] = await Promise.all([loadField(backSrc, fn), loadTexture(backSrc, mt)]);
  const bH = H, bW = bH * bField.ar;
  const bm = new THREE.Mesh(patch(bField, bW, bH, 0, 1, nxFor(bW), nxFor(bH), depth), material(bTex));
  bm.rotation.y = Math.PI; if (!spec.back) { bm.scale.x = -1; bm.material.uniforms.uSil.value = 1; }
  g.group.add(bm); g.mats.push(bm.material);
  g.mats.forEach(m => m.uniforms.uSize.value.set(W, H)); bm.material.uniforms.uSize.value.set(bW, bH);
  if (spec.light) g.mats.forEach(m => { m.uniforms.uShade.value = 0.5; });      // pale fabric needs gentler shading
  return g;
}

export function setZip(g, t) {            // t: 0 zipped … 1 unzipped
  if (!g.zip) return;
  const y = lerp(ZIP.top, ZIP.end, t), open = smooth(clamp(t / 0.3)), z = g.zip;
  z.mats.forEach(m => { m.uniforms.uZipY.value = y; m.uniforms.uOpen.value = open; });
  const yc = y - 0.03, e = 0.02;                                       // sample under the slider body
  z.pull.position.set(ZIP.cx, y, z.surf(yc) + 0.007);
  z.pull.rotation.x = Math.atan((z.surf(yc + e) - z.surf(yc - e)) / (2 * e));
  z.t = t;
}

/* ---------- stage ---------- */
class Stage {
  constructor(canvas, fov = 26) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // photos are shown as authored
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
    this.visible = false; this.running = false; this.t0 = 0; this.w = 1; this.h = 1;
    this.resize = this.resize.bind(this); this.tick = this.tick.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    new IntersectionObserver(es => { this.visible = es[0].isIntersecting; this.kick(); }, { rootMargin: '10% 0px' }).observe(canvas);
    document.addEventListener('visibilitychange', () => this.kick());
    this.resize();
  }
  resize() {
    const r = this.canvas.getBoundingClientRect(); if (!r.width || !r.height) return;
    const mobile = Math.min(innerWidth, innerHeight) < 700;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, mobile ? 1.75 : 2));
    this.renderer.setSize(r.width, r.height, false);
    this.w = r.width; this.h = r.height;
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
    this.kick();
  }
  /* distance at which a w×h object fills `fill` of the view */
  fit(w, h, fill = 0.8) {
    const t = Math.tan(this.camera.fov * Math.PI / 360);
    return Math.max(h / (2 * t * fill), w / (2 * t * this.camera.aspect * fill));
  }
  kick() { if (!this.running && this.visible && !document.hidden) { this.running = true; this.t0 = performance.now(); requestAnimationFrame(this.tick); } }
  tick(now) {
    if (!this.visible || document.hidden) { this.running = false; return; }
    const dt = Math.min(0.05, (now - this.t0) / 1000); this.t0 = now;
    if (this.frame) this.frame(dt, now / 1000);
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.tick);
  }
}

function fleeceOverlay() {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    vertexShader: OVERLAY_VS, fragmentShader: OVERLAY_FS, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uMix: { value: 0 }, uScale: { value: 10 }, uTime: { value: 0 }, uAspect: { value: 1 }, uTint: { value: new THREE.Vector3(0.285, 0.285, 0.29) } },
  }));
  m.frustumCulled = false; m.renderOrder = 99; m.visible = false;
  return m;
}

/* piecewise eased keyframes: [[p, value], ...] */
function track(keys) {
  return p => {
    if (p <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (p <= keys[i][0]) {
      const a = keys[i - 1], b = keys[i];
      return lerp(a[1], b[1], smooth((p - a[0]) / (b[0] - a[0] || 1)));
    }
    return keys[keys.length - 1][1];
  };
}

/* ---------- 1. Product films (scroll-driven) ----------
   Each plan is a set of keyframe tracks over scroll progress 0…1:
   rot (turn), zoom, tx/ty (where the camera looks, in garment units), tz (+1 front face, -1 back face),
   zip (0 zipped … 1 open), mix (fleece close-up 0…1), scale (how tight the fleece close-up is). */
const FADE = { backLogo: [-0.092, 0.39], thigh: [-0.113, -0.113], chest: [0.011, 0.388] };
const PLANS = {
  zip: {
    rot: [[0, -0.38], [0.04, -0.38], [0.105, Math.PI - 0.5], [0.155, Math.PI + 0.5], [0.22, TAU + 0.3], [0.30, TAU + 0.26], [0.41, TAU - 0.2], [0.49, TAU + 0.12], [0.585, TAU - 0.07], [0.64, TAU], [1, TAU]],
    zoom: [[0, 1], [0.22, 1], [0.30, 2.25], [0.41, 2.5], [0.49, 6.4], [0.585, 7.2], [0.67, 1.75], [0.745, 2.0], [0.80, 6.5], [0.90, 7.5], [0.945, 1.5], [1, 1]],
    tx: [[0, 0], [0.41, 0], [0.49, ZIP.pull[0]], [0.585, ZIP.pull[0]], [0.67, 0], [1, 0]],
    ty: [[0, 0], [0.22, 0], [0.30, ZIP.logo[1]], [0.41, ZIP.logo[1]], [0.49, ZIP.pull[1] + 0.01], [0.585, ZIP.pull[1] - 0.01], [0.67, 0.1], [0.745, 0.0], [0.80, 0.22], [0.90, 0.22], [0.945, 0.04], [1, 0]],
    tz: [[0, 1], [1, 1]],
    zip: [[0, 0], [0.60, 0], [0.735, 1], [0.925, 1], [0.99, 0]],
    mix: [[0, 0], [0.775, 0], [0.815, 1], [0.885, 1], [0.925, 0]],
    scale: [[0.775, 11], [0.905, 5.2]],
  },
  fadeaway: {
    rot: [[0, -0.38], [0.05, -0.38], [0.24, Math.PI + 0.24], [0.37, Math.PI - 0.2], [0.50, TAU + 0.22], [0.615, TAU - 0.16], [0.69, TAU], [1, TAU]],
    zoom: [[0, 1], [0.15, 1], [0.25, 2.0], [0.37, 2.3], [0.44, 1.15], [0.52, 2.3], [0.615, 2.7], [0.69, 1.4], [0.775, 6.5], [0.88, 7.5], [0.94, 1.4], [1, 1]],
    tx: [[0, 0], [0.15, 0], [0.25, FADE.backLogo[0]], [0.37, FADE.backLogo[0]], [0.44, 0], [0.52, FADE.thigh[0]], [0.615, FADE.thigh[0]], [0.69, 0], [0.775, FADE.chest[0]], [0.88, FADE.chest[0]], [0.94, 0], [1, 0]],
    ty: [[0, 0], [0.15, 0], [0.25, FADE.backLogo[1]], [0.37, FADE.backLogo[1]], [0.44, 0], [0.52, FADE.thigh[1]], [0.615, FADE.thigh[1]], [0.69, 0.1], [0.775, FADE.chest[1]], [0.88, FADE.chest[1]], [0.94, 0], [1, 0]],
    tz: [[0, 1], [0.15, 1], [0.25, -1], [0.37, -1], [0.46, 1], [1, 1]],
    zip: [[0, 0], [1, 0]],
    mix: [[0, 0], [0.745, 0], [0.785, 1], [0.865, 1], [0.905, 0]],
    scale: [[0.745, 11], [0.885, 5.2]],
  },
};

export async function initFilm({ section, canvas, spec, plan = 'zip', captions = [], onReady }) {
  const st = new Stage(canvas, 24);
  const g = await buildGarment(spec);
  st.scene.add(g.group);
  const fl = fleeceOverlay(); fl.material.uniforms.uTint.value.set(...g.tint); st.scene.add(fl);
  const K = {}; Object.entries(PLANS[plan] || PLANS.zip).forEach(([k, keys]) => { K[k] = track(keys); });
  let p = 0, target = 0, px = 0, py = 0;
  const read = () => { const r = section.getBoundingClientRect(), span = r.height - innerHeight; target = span > 0 ? clamp(-r.top / span) : 0; };
  addEventListener('scroll', read, { passive: true }); addEventListener('resize', read); read(); p = target;
  if (matchMedia('(hover:hover)').matches) addEventListener('pointermove', e => { px = e.clientX / innerWidth - 0.5; py = e.clientY / innerHeight - 0.5; }, { passive: true });
  const v = new THREE.Vector3();
  let lastCap = -2;

  st.frame = (dt, time) => {
    p += (target - p) * (1 - Math.exp(-dt * 7));
    if (Math.abs(target - p) < 0.0002) p = target;
    const wide = st.camera.aspect > 1.05;
    const idle = (1 - smooth(clamp(p / 0.05))) * Math.sin(time * 0.6) * 0.16;
    g.group.rotation.y = K.rot(p) + idle + px * 0.12;
    g.group.rotation.x = py * 0.06;
    if (g.zip) setZip(g, K.zip(p));
    const tall = g.H > g.W * 1.2;
    const zoom = K.zoom(p), base = st.fit(g.W, g.H, wide ? (tall ? 0.86 : 0.76) : (tall ? 0.72 : 0.9)), dist = base / zoom;
    v.set(K.tx(p), K.ty(p), K.tz(p) * g.depth * 0.6); g.group.updateMatrixWorld(); g.group.localToWorld(v);
    // keep the garment right of centre on wide screens, above the captions on tall ones
    const halfH = Math.tan(st.camera.fov * Math.PI / 360) * dist, off = clamp(1.25 - zoom * 0.12, 0.45, 1);
    const lift = clamp(0.84 - (g.H / 2) / (Math.tan(st.camera.fov * Math.PI / 360) * base), 0, 0.4);
    const sx = wide ? -halfH * st.camera.aspect * 0.36 * off : 0, sy = wide ? halfH * 0.04 : -halfH * lift * off;
    st.camera.position.set(v.x + sx, v.y + sy, v.z + dist);
    st.camera.lookAt(v.x + sx, v.y + sy, v.z);
    const mix = K.mix(p);
    fl.visible = mix > 0.002;
    if (fl.visible) { const u = fl.material.uniforms; u.uMix.value = mix; u.uScale.value = K.scale(p); u.uTime.value = time; u.uAspect.value = st.camera.aspect; }
    let cap = -1;
    for (let i = 0; i < captions.length; i++) { const c = captions[i]; if (p >= +c.dataset.from && p <= +c.dataset.to) cap = i; }
    if (cap !== lastCap) { captions.forEach((c, i) => c.classList.toggle('on', i === cap)); lastCap = cap; }
    section.style.setProperty('--p', p.toFixed(4));
  };
  st.kick();
  if (onReady) onReady();
  return { stage: st, garment: g, seek: v => { target = p = v; } };
}

/* ---------- 2. The lineup: every piece on one turning rail ---------- */
export async function initLineup({ canvas, items, onFocus, onReady }) {
  const st = new Stage(canvas, 26);
  const ring = new THREE.Group(); st.scene.add(ring);
  const n = items.length, step = TAU / n;
  const gs = await Promise.all(items.map(it => buildGarment(it.spec)));
  const slots = gs.map((g, i) => {
    const s = new THREE.Group(); s.add(g.group); ring.add(s);
    g.mats.forEach(m => m.uniforms.uFog.value.set(0, 1, 0.86));
    return s;
  });
  let ang = 0, vel = 0, drag = null, goal = null, hold = 2.2, focus = -1, R = 2.7;
  const twirl = gs.map(() => 1);                      // 0…1 progress of each piece's turn on arrival
  const wrap = a => a - TAU * Math.round(a / TAU);
  const layout = () => {
    const narrow = st.camera.aspect < 0.9;
    R = narrow ? 2.15 : 2.9;
    slots.forEach((s, i) => { const a = i * step; s.position.set(Math.sin(a) * R, 0, Math.cos(a) * R); s.rotation.y = a; });
    const dist = st.fit(2.1, 2.1, narrow ? 0.92 : 0.74);
    st.camera.position.set(0, 0.1, R + dist); st.camera.lookAt(0, 0, R);
    gs.forEach(g => g.mats.forEach(m => m.uniforms.uFog.value.set(dist + 0.6, dist + R * 1.6, 0.82)));
  };
  layout(); new ResizeObserver(layout).observe(canvas);

  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, a: ang, t: performance.now(), moved: 0 }; goal = null; vel = 0; canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing'); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, na = drag.a + dx / st.w * 2.6, now = performance.now();
    vel = (na - ang) / Math.max(0.008, (now - drag.t) / 1000); drag.t = now; drag.moved = Math.max(drag.moved, Math.abs(dx)); ang = na;
  });
  const up = () => {
    if (!drag) return; const tap = drag.moved < 6; drag = null; canvas.classList.remove('grabbing');
    goal = Math.round((ang + clamp(vel, -4, 4) * 0.22) / step) * step; hold = 5; vel = 0;      // settle on the nearest piece
    if (tap && api.onTap) api.onTap(focus);
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);

  const api = {
    stage: st,
    go(dir) { goal = (Math.round((goal !== null ? goal : ang) / step) - dir) * step; hold = 5; },
    onTap: null,
  };
  st.frame = (dt, time) => {
    if (!drag) {
      if (goal !== null) { ang += (goal - ang) * (1 - Math.exp(-dt * 4.2)); if (Math.abs(goal - ang) < 0.0015) { ang = goal; goal = null; } }
      else if (!reduceMotion) { hold -= dt; if (hold <= 0) { goal = (Math.round(ang / step) - 1) * step; hold = 3.6; } }
    }
    ring.rotation.y = ang;
    const f = ((Math.round(-ang / step) % n) + n) % n;
    if (f !== focus) { focus = f; if (!reduceMotion) twirl[f] = 0; if (onFocus) onFocus(items[f], f); }
    gs.forEach((g, i) => {
      const rel = wrap(i * step + ang);                 // 0 when the piece is in front
      if (twirl[i] < 1) twirl[i] = Math.min(1, twirl[i] + dt / 2.6);
      const tw = twirl[i], e = tw < 0.5 ? 0.5 * smooth(tw * 2) : 0.5 + 0.5 * smooth(tw * 2 - 1);   // pause on the back, quick through the sides
      g.group.rotation.y = -rel * 0.6 + (g.hasBack ? e * TAU : Math.sin(e * TAU) * 0.55);
    });
  };
  st.kick();
  if (onReady) onReady();
  return api;
}

/* ---------- 3. Product viewer (modal) ---------- */
export function initViewer({ canvas }) {
  const st = new Stage(canvas, 26);
  const fl = fleeceOverlay(); st.scene.add(fl);
  let g = null, token = 0, rot = 0, vel = 0, drag = null, auto = true, goal = null, zipGoal = 0, zipT = 0, fleeceT = -1, zoomK = 1, sway = 0;
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, r: rot, t: performance.now() }; auto = false; goal = null; vel = 0; canvas.setPointerCapture(e.pointerId); canvas.classList.add('grabbing'); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return; const nr = drag.r + (e.clientX - drag.x) / st.w * 4.2, now = performance.now();
    vel = (nr - rot) / Math.max(0.008, (now - drag.t) / 1000); drag.t = now; rot = nr;
  });
  const up = () => { drag = null; canvas.classList.remove('grabbing'); vel = clamp(vel, -7, 7); };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);

  st.frame = (dt, time) => {
    if (!g) return;
    if (!drag) {
      if (goal !== null) { rot += (goal - rot) * (1 - Math.exp(-dt * 6)); if (Math.abs(goal - rot) < 0.003) { rot = goal; goal = null; } }
      else if (auto && !reduceMotion) { sway += dt; if (g.hasBack) rot += dt * (0.4 + 1.5 * Math.sin(rot) * Math.sin(rot)); else rot = Math.sin(sway * 0.7 - 0.9) * 0.6; }
      else { rot += vel * dt; vel *= Math.exp(-dt * 3); }
    }
    g.group.rotation.y = rot;
    if (g.zip) { zipT += (zipGoal - zipT) * (1 - Math.exp(-dt * 2.6)); setZip(g, zipT); }
    let mix = 0;
    if (fleeceT >= 0) {                                   // 3.6 s: push in, hold on the fleece, pull back
      fleeceT += dt; const t = fleeceT / 3.6;
      zoomK = 1 + 5 * smooth(clamp(t / 0.3)) * (1 - smooth(clamp((t - 0.72) / 0.28)));
      mix = smooth(clamp((t - 0.16) / 0.16)) * (1 - smooth(clamp((t - 0.7) / 0.14)));
      const u = fl.material.uniforms; u.uMix.value = mix; u.uScale.value = lerp(11, 5.2, clamp((t - 0.16) / 0.6)); u.uTime.value = time; u.uAspect.value = st.camera.aspect;
      if (t >= 1) { fleeceT = -1; zoomK = 1; if (api.onFleeceEnd) api.onFleeceEnd(); }
    }
    fl.visible = mix > 0.002;
    const d = st.fit(g.W, g.H, 0.86) / zoomK;
    st.camera.position.set(0, 0, d); st.camera.lookAt(0, 0, 0);
  };

  const api = {
    stage: st, onFleeceEnd: null,
    async show(spec) {
      const my = ++token;
      const ng = await buildGarment(spec);
      if (my !== token) return false;
      if (g) st.scene.remove(g.group);
      g = ng; st.scene.add(g.group); fl.material.uniforms.uTint.value.set(...g.tint); rot = -0.5; sway = 0; vel = 0; auto = true; goal = null; zipGoal = 0; zipT = 0; fleeceT = -1; zoomK = 1;
      st.resize(); st.kick();
      return true;
    },
    face(back) { auto = false; const turns = Math.round(rot / TAU); goal = turns * TAU + (back ? Math.PI : 0); },
    toggleZip() { if (!g || !g.zip) return false; zipGoal = zipGoal ? 0 : 1; auto = false; api.face(false); return !!zipGoal; },
    fleece() { if (!g || fleeceT >= 0) return; auto = false; api.face(false); fleeceT = 0; },
    get hasBack() { return !!(g && g.hasBack); },
    get isZip() { return !!(g && g.zip); },
  };
  return api;
}

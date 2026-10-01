/* The 3D scene, built from the view model. Nothing here knows which model it is drawing:
 * the stack has as many layers as the config says, each coloured by its mixer type; the expert grid has as many
 * experts as there are; PLE and the drafter appear only when the model has them. The floor is the memory map.
 * Scene units: the chassis is 15.6 × 5.6 × 15.6. y = 0 is the floor. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { $, esc, clamp, lerp, ease, REDUCED, showTok, int, count } from './util.js';
import { buildSky } from './sky.js';

const rnd = (() => { let s = 1234567; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();   // seeded: same scene every load

export function buildScene(M, hooks = {}) {
  /* ── Theme ── */
  const css = getComputedStyle(document.documentElement);
  const tok = (n, f) => (css.getPropertyValue(n).trim() || f);
  const isLight = document.documentElement.getAttribute('data-theme') === 'glacier';
  const COL = {
    bg: isLight ? '#0c1220' : tok('--page', '#0b0d12'),
    net: tok('--c-net', '#3987e5'), compute: tok('--c-compute', '#d95926'), storage: tok('--c-storage', '#199e70'),
    agent: tok('--c-agent', '#9b7cf0'), neutral: tok('--c-neutral', '#8b93a8'), accent: tok('--accent', '#3987e5'),
    accent2: tok('--accent-2', '#7fb1f0'), warn: tok('--s-warn', '#fab219'), good: tok('--s-good-bright', '#2fd05a'), crit: tok('--s-crit', '#d03b3b'),
    linear: '#22c3a6', attention: '#f2a93b', sliding: '#e9d27a', ssm: '#5ab8e6',
  };
  const SC = {
    hw: COL.accent, api: COL.net, tokenizer: COL.agent, scheduler: COL.neutral, embed: COL.accent2, ple: COL.storage,
    stack: COL.linear, linear: COL.linear, attn: COL.attention, ffn: COL.compute, head: COL.accent2, sample: COL.compute, mtp: COL.agent, stream: COL.net, memory: COL.neutral,
  };
  const typeCol = t => COL[t] || COL.attention;

  /* ── Renderer, camera, post ── */
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!(hooks.shot || hooks.keep) });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COL.bg);
  scene.fog = new THREE.FogExp2(COL.bg, 0.018);
  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 400);
  camera.position.set(7, 6, 30);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.minDistance = 1.2; controls.maxDistance = 60; controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 2.2, 0);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.78, 0.55, 0.62));
  composer.addPass(new OutputPass());
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  $('labels').appendChild(labels.domElement);
  scene.add(new THREE.HemisphereLight('#9fb4ff', '#0b0d12', 0.55));
  const sky = hooks.sky ? buildSky(scene, camera, renderer, hooks.sky) : null;   // the view from orbit behind everything
  if (sky) scene.background = null;
  const key = new THREE.DirectionalLight('#ffffff', 1.4); key.position.set(8, 14, 10); scene.add(key);
  const rim = new THREE.DirectionalLight(COL.agent, 0.6); rim.position.set(-10, 6, -12); scene.add(rim);

  /* ── Factories ── */
  const C3 = c => new THREE.Color(c);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const glassMat = (c, o = .55) => new THREE.MeshPhysicalMaterial({ color: C3(c).multiplyScalar(.25), emissive: C3(c), emissiveIntensity: .25, metalness: .2, roughness: .25,
    clearcoat: 1, clearcoatRoughness: .2, transparent: true, opacity: o, depthWrite: false });
  const glowMat = (c, o = 1) => new THREE.MeshBasicMaterial({ color: C3(c), transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false });
  const darkMat = () => new THREE.MeshStandardMaterial({ color: '#1b2030', metalness: .45, roughness: .42 });
  const label = (html, cls = 'lbl3d') => { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; const o = new CSS2DObject(el); o.userData.el = el; return o; };
  const pickables = [];
  const pickable = (mesh, pick) => { mesh.userData.pick = pick; pickables.push(mesh); return mesh; };
  const hitBox = (w, h, d, pick, y = h / 2) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ visible: false })); m.position.y = y; return pickable(m, pick); };
  const anims = new Set();
  const animate = (dur, fn, done) => { let e = 0; const a = { update(dt) { e += dt; const k = clamp(e / dur, 0, 1); fn(k, e); if (k >= 1) { done?.(); return false; } return true; } }; anims.add(a); return a; };
  const uTime = { value: 0 };
  const _d = new THREE.Object3D();
  const tmpC = new THREE.Color();
  const disposeTree = o => o.traverse(x => { x.geometry?.dispose?.(); if (x.userData?.el) x.userData.el.remove(); });

  /* ── Chassis ── */
  const chassis = new THREE.Group(); scene.add(chassis);
  const shellMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uBase: { value: C3('#171a21') }, uRim: { value: C3(COL.accent2) }, uOpacity: { value: 1 }, uLight: { value: V(.4, .8, .45).normalize() } },
    vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix*vec4(position,1.); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uBase; uniform vec3 uRim; uniform float uOpacity; uniform vec3 uLight; varying vec3 vN; varying vec3 vV;
      void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n; float f = pow(1.-abs(dot(n,vV)),3.); float d = max(dot(n,uLight),0.)*.55+.45;
        vec3 c = uBase*d*1.6 + uRim*f*(.18+.32*(1.-uOpacity)); gl_FragColor = vec4(c, clamp(uOpacity + f*(.22-.16*uOpacity), 0., 1.)); }`,
  });
  const shell = new THREE.Mesh(new RoundedBoxGeometry(15.6, 5.6, 15.6, 6, .55), shellMat); shell.position.y = 2.6; shell.renderOrder = 10; chassis.add(shell);
  const perfMat = kind => new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { uOpacity: { value: 1 }, uTime },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: kind === 'lid'
      ? `uniform float uOpacity; varying vec2 vUv; void main(){ vec2 g = vUv*vec2(64.,64.); vec2 r = vec2(1.,1.732); vec2 a = mod(g,r)-r*.5; vec2 b = mod(g-r*.5,r)-r*.5; float d = min(length(a),length(b));
          float hole = 1.-smoothstep(.26,.31,d); vec2 e = abs(vUv-.5); float edge = smoothstep(.47,.44,max(e.x,e.y)); gl_FragColor = vec4(vec3(.03,.035,.05), hole*edge*.85*uOpacity); }`
      : `uniform float uOpacity; varying vec2 vUv; void main(){ float s = step(.5, fract(vUv.y*26.)); vec2 e = abs(vUv-.5); float edge = smoothstep(.49,.46,max(e.x,e.y));
          float slot = s*smoothstep(.0,.02,fract(vUv.x*3.)-.0)*smoothstep(1.,.98,fract(vUv.x*3.)); gl_FragColor = vec4(vec3(.025,.03,.04), slot*edge*.8*uOpacity); }`,
  });
  const lid = new THREE.Mesh(new THREE.PlaneGeometry(14.2, 14.2), perfMat('lid')); lid.rotation.x = -Math.PI / 2; lid.position.y = 5.415; lid.renderOrder = 11; chassis.add(lid);
  const grille = new THREE.Mesh(new THREE.PlaneGeometry(13.6, 3.2), perfMat('grille')); grille.position.set(0, 2.7, 7.815); grille.renderOrder = 11; chassis.add(grille);
  const led = new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 12), glowMat(COL.good)); led.position.set(6.55, .75, 7.82); chassis.add(led);
  {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 64; const g = cv.getContext('2d');
    g.fillStyle = 'rgba(190,200,220,.55)'; g.font = '600 30px Inter, system-ui, sans-serif'; g.textBaseline = 'middle'; g.fillText(M.hw.badge || 'GPU SERVER', 6, 34);
    const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace;
    const badge = new THREE.Mesh(new THREE.PlaneGeometry(2.6, .325), new THREE.MeshBasicMaterial({ map: tx, transparent: true, depthWrite: false }));
    badge.position.set(-5.6, .75, 7.82); badge.renderOrder = 12; chassis.add(badge);
  }
  [[-5.2, .5, .35], [-3.9, .42, .2], [-3.2, .42, .2], [-2.5, .42, .2], [-1.5, .7, .25], [0, .62, .55], [1.5, 1.0, .42], [2.8, 1.0, .42]]
    .forEach(([x, w, h]) => { const p = new THREE.Mesh(new THREE.BoxGeometry(w, h, .08), new THREE.MeshStandardMaterial({ color: '#06070a', roughness: .9 })); p.position.set(x, 1.0, -7.83); chassis.add(p); });
  const portLight = new THREE.Mesh(new THREE.BoxGeometry(.12, .06, .02), glowMat(COL.good, .9)); portLight.position.set(.22, 1.38, -7.88); chassis.add(portLight);
  const PORT = V(0, 1.0, -7.4);
  [[-6.6, -6.6], [6.6, -6.6], [-6.6, 6.6], [6.6, 6.6]].forEach(([x, z]) => { const f = new THREE.Mesh(new THREE.CylinderGeometry(.5, .55, .12, 24), darkMat()); f.position.set(x, -.26, z); chassis.add(f); });
  chassis.add(hitBox(15.6, 5.6, 15.6, { type: 'station', id: 'hw' }, 2.6));

  /* ── Floor: the memory map, to scale (equal area per GiB) ── */
  const memRegion = {};
  const floor = new THREE.Group(); scene.add(floor);
  {
    const W = 15, D = 15, x0 = -7.5, z0 = -7.5;
    const regs = M.memory?.regions || [];
    const gpu = regs.filter(r => r.band === 'gpu'), host = regs.filter(r => r.band === 'host');
    const sum = l => l.reduce((a, r) => a + r.bytes, 0);
    const gB = sum(gpu), hB = sum(host);
    const split = gB + hB ? D * gB / (gB + hB) : D;
    const lay = (list, total, za, zb) => { let x = x0; for (const r of list) { const w = W * r.bytes / total; memRegion[r.id] = { x, w, z: za, d: zb - za, r }; x += w; } };
    if (gB) lay(gpu, gB, z0, z0 + split);
    if (hB) lay(host, hB, z0 + split, z0 + D);
    const base = new THREE.Mesh(new THREE.PlaneGeometry(W + .6, D + .6), new THREE.MeshStandardMaterial({ color: '#0d1016', metalness: .3, roughness: .8 }));
    base.rotation.x = -Math.PI / 2; base.position.y = -.012; floor.add(base);
    for (const [id, g] of Object.entries(memRegion)) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.02, g.w - .05), g.d - .05), new THREE.MeshBasicMaterial({ color: C3(g.r.color), transparent: true, opacity: .085, depthWrite: false }));
      m.rotation.x = -Math.PI / 2; m.position.set(g.x + g.w / 2, 0, g.z + g.d / 2); floor.add(m); g.mesh = m;
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(Math.max(.02, g.w - .05), g.d - .05)), new THREE.LineBasicMaterial({ color: C3(g.r.color), transparent: true, opacity: .45 }));
      edge.rotation.x = -Math.PI / 2; edge.position.copy(m.position).setY(.004); floor.add(edge);
      const l = label(`${esc(g.r.label)}<small>${(g.r.bytes / 1073741824).toFixed(1)} GiB</small>`, 'lbl3d mem'); l.position.set(g.x + g.w / 2, .02, g.z + g.d - .35); floor.add(l); g.label = l;
      pickable(m, { type: 'station', id: 'memory', region: id });
    }
    const kv = memRegion.kv;
    if (kv) {
      kv.fill = new THREE.Mesh(new THREE.PlaneGeometry(Math.max(.02, kv.w - .1), 1), new THREE.MeshBasicMaterial({ color: C3(kv.r.color), transparent: true, opacity: .32, depthWrite: false, blending: THREE.AdditiveBlending }));
      kv.fill.rotation.x = -Math.PI / 2; kv.fill.position.set(kv.x + kv.w / 2, .006, kv.z); kv.fill.scale.y = .001; floor.add(kv.fill);
    }
    const grid = new THREE.GridHelper(15, 60, '#2a3140', '#1a1f29'); grid.position.y = .002; grid.material.transparent = true; grid.material.opacity = .35; floor.add(grid);
  }
  function setKV(frac) { const kv = memRegion.kv; if (!kv?.fill) return; const d = Math.max(.001, clamp(frac, 0, 1) * (kv.d - .1)); kv.fill.scale.y = d; kv.fill.position.z = kv.z + .05 + d / 2; }

  /* ── Stations ── */
  const POS = { api: [-5.3, -5.2], tokenizer: [-5.3, -2.5], scheduler: [-5.3, .2], embed: [-5.3, 2.9], head: [5.4, 1.4], sample: [5.4, -1.5], mtp: [2.3, -4.2], stream: [5.4, -5.3] };
  const ST = {}, stLabels = [];
  function pedestal(id, title, kicker, w = 1.9, d = 1.9) {
    const [x, z] = POS[id]; const g = new THREE.Group(); g.position.set(x, 0, z); scene.add(g);
    const base = new THREE.Mesh(new RoundedBoxGeometry(w, .16, d, 4, .07), darkMat()); base.position.y = .08; g.add(base);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(Math.min(w, d) * .52, .012, 8, 96), glowMat(SC[id], .8)); ring.rotation.x = Math.PI / 2; ring.position.y = .17; g.add(ring);
    const l = label(`${esc(title)}<small>${esc(kicker)}</small>`); l.position.set(0, 2.15, 0); g.add(l); stLabels.push([id, l.userData.el]);
    g.add(hitBox(w, 2.2, d, { type: 'station', id }));
    ST[id] = { group: g, ring, label: l, pos: V(x, 0, z) };
    return g;
  }
  const T = hooks.titles || {};
  const tt = id => T[id] || [id, ''];

  { const g = pedestal('api', ...tt('api')); const t = new THREE.Mesh(new THREE.TorusGeometry(.62, .05, 16, 80), glassMat(SC.api, .9)); t.position.y = 1.0; g.add(t);
    const t2 = new THREE.Mesh(new THREE.TorusGeometry(.48, .012, 8, 80), glowMat(SC.api, .9)); t2.position.y = 1.0; g.add(t2);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(.6, 48), new THREE.MeshBasicMaterial({ color: C3(SC.api), transparent: true, opacity: .07, side: THREE.DoubleSide, depthWrite: false })); disc.position.y = 1; g.add(disc);
    ST.api.spin = t2; }

  // Tokenizer: one chip per real prompt token (rebuilt for each trace).
  { const g = pedestal('tokenizer', ...tt('tokenizer'));
    const blade = new THREE.Mesh(new THREE.PlaneGeometry(1.2, .5), new THREE.MeshBasicMaterial({ color: C3(SC.tokenizer), transparent: true, opacity: .035, side: THREE.DoubleSide, depthWrite: false })); blade.position.y = 1.15; g.add(blade);
    ST.tokenizer.chipGroup = new THREE.Group(); g.add(ST.tokenizer.chipGroup); ST.tokenizer.chips = []; }
  function buildChips(tokens) {
    const tz = ST.tokenizer; disposeTree(tz.chipGroup); tz.chipGroup.clear(); tz.chips = [];
    const list = tokens.slice(0, 48), n = list.length;
    list.forEach((t, i) => {
      const word = !t.special && /\w/.test(t.text);
      const c = t.special ? COL.agent : word ? COL.accent : COL.neutral;
      const w = clamp(2.4 / Math.max(n, 12), .05, .13);
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, .1 + (t.special ? .05 : 0), .1, 2, .025), glassMat(c, .95));
      const a = (n > 1 ? i / (n - 1) - .5 : 0) * 2.4;
      m.position.set(Math.sin(a) * .72, .55 + Math.cos(a * 2) * .04, -Math.cos(a) * .25 + .2); m.rotation.y = -a * .6;
      tz.chipGroup.add(m); tz.chips.push(m);
      const l = label(esc(showTok(t.text)), 'lbl3d tok hide'); l.position.set(0, .14, 0); m.add(l); m.userData.label = l;
    });
  }

  // Scheduler: one rail per sequence slot, and a strip of KV blocks.
  { const g = pedestal('scheduler', ...tt('scheduler')); const slots = [], pages = [];
    const n = clamp(M.slots || 4, 1, 8);
    for (let i = 0; i < n; i++) {
      const y = .45 + i * (.88 / Math.max(n, 4));
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.4, .025, .05), glassMat(SC.scheduler, .6)); rail.position.set(-.1, y, -.35); g.add(rail);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(.055, 16, 12), glowMat(COL.good, .12)); lamp.position.set(.68, y, -.35); g.add(lamp); slots.push(lamp);
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 10; c++) { const p = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), glassMat(COL.warn, .25)); p.position.set(-.6 + c * .13, .3 + r * .13, .45); g.add(p); pages.push(p); }
    ST.scheduler.slots = slots; ST.scheduler.pages = pages; }

  // Embedding table: a row lights per lookup.
  { const g = pedestal('embed', ...tt('embed')); const tex = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime, uRow: { value: -1 }, uCol: { value: C3(SC.embed) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uTime; uniform float uRow; uniform vec3 uCol; varying vec2 vUv; void main(){ float rows = 64.; float r = floor(vUv.y*rows);
        float line = smoothstep(.0,.08,fract(vUv.y*rows))*smoothstep(1.,.92,fract(vUv.y*rows)); float n = fract(sin(r*12.9898+floor(vUv.x*40.)*78.233)*43758.5453);
        float hot = uRow >= 0. ? exp(-abs(r - uRow)*.9) : 0.; vec3 c = uCol*(.18+.25*n*line) + uCol*hot*1.6; gl_FragColor = vec4(c, .55+hot*.4); }` });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), tex); m.position.set(0, 1.0, 0); m.rotation.y = .5; g.add(m); ST.embed.table = tex; }

  // LM head: a fan of logit bars; five rise with the real top-5.
  { const g = pedestal('head', ...tt('head'), 2.1, 2.1); const N = 140; const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(.018, 1, .018), glowMat(SC.head, .85), N);
    const h = [];
    for (let i = 0; i < N; i++) { const a = (i / (N - 1) - .5) * Math.PI * .9; const v = .04 + Math.pow(rnd(), 6) * .25; h.push(v); _d.position.set(Math.sin(a) * .8, .2 + v / 2, -Math.cos(a) * .45); _d.scale.set(1, v, 1); _d.updateMatrix(); bars.setMatrixAt(i, _d.matrix); }
    g.add(bars); Object.assign(ST.head, { bars, h, N, lift: 0, top: [] }); }

  // Sampler: five bars carrying the real probabilities of the current answer token.
  { const g = pedestal('sample', ...tt('sample')); const bars = [], tags = [];
    for (let i = 0; i < 5; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(.18, 1, .18), glassMat(i ? COL.neutral : SC.sample, .9)); b.position.set(-.5 + i * .25, .2, 0); g.add(b); bars.push(b);
      const l = label('', 'lbl3d tok'); l.position.set(-.5 + i * .25, .05, .3); g.add(l); tags.push(l); }
    const pick = new THREE.Mesh(new THREE.TorusGeometry(.16, .015, 8, 40), glowMat(COL.good, .95)); pick.rotation.x = Math.PI / 2; g.add(pick);
    g.rotation.y = -Math.PI / 2;
    Object.assign(ST.sample, { bars, tags, pick }); }

  // Drafter: k orbs on a ring and a verify gate. Only when the server runs speculative decoding.
  const K = clamp(M.spec?.k || 0, 0, 6);
  if (K) { const g = pedestal('mtp', ...tt('mtp'), 2.1, 2.1); const ring = new THREE.Mesh(new THREE.TorusGeometry(.72, .02, 8, 96), glowMat(SC.mtp, .7)); ring.rotation.x = Math.PI / 2; ring.position.y = .9; g.add(ring);
    const orbs = Array.from({ length: K }, () => { const o = new THREE.Mesh(new THREE.SphereGeometry(.065, 20, 14), glowMat(SC.mtp, .8)); o.position.y = .9; g.add(o);
      const l = label('', 'lbl3d tok'); l.position.set(0, .16, 0); o.add(l); o.userData.tag = l; return o; });
    const gate = new THREE.Mesh(new THREE.TorusGeometry(.32, .03, 10, 48, Math.PI), glassMat(COL.good, .9)); gate.position.set(.72, .9, 0); gate.rotation.y = Math.PI / 2; g.add(gate);
    Object.assign(ST.mtp, { orbs, gate, acc: Array(K).fill(.6), phase: 0 }); }

  { const g = pedestal('stream', ...tt('stream')); ST.stream.discs = [0, 1, 2, 3].map(i => { const d = new THREE.Mesh(new THREE.CylinderGeometry(.45 - i * .06, .45 - i * .06, .03, 48), glassMat(SC.stream, .8)); d.position.y = .4 + i * .18; g.add(d); return d; }); }

  /* ── The layer stack ── */
  const L = Math.max(1, M.L);
  const TOWER = { x0: -3.25, x1: 3.75, z: 1.4, y: 1.3, h: 2.0, d: 2.0 };
  const dx = L > 1 ? (TOWER.x1 - TOWER.x0) / (L - 1) : 0;
  const slabX = i => TOWER.x0 + i * dx;
  const slabs = [];
  const marked = new Set(M.marks.flatMap(m => m.layers));
  {
    const g = new THREE.Group(); scene.add(g);
    const thick = clamp(dx * .3, .012, .06);
    const geo = new THREE.BoxGeometry(thick, TOWER.h, TOWER.d), eg = new THREE.EdgesGeometry(geo);
    M.types.forEach((type, i) => {
      const col = typeCol(type), strong = type === 'attention';
      const mat = new THREE.MeshStandardMaterial({ color: C3(col).multiplyScalar(.3), emissive: C3(col), emissiveIntensity: .12, transparent: true, opacity: strong ? .5 : .32, depthWrite: false, metalness: .1, roughness: .4 });
      const m = new THREE.Mesh(geo, mat); m.position.set(slabX(i), TOWER.y, TOWER.z);
      const e = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: C3(col), transparent: true, opacity: strong ? .55 : .28 })); m.add(e);
      g.add(m); pickable(m, { type: 'layer', i });
      m.userData = { ...m.userData, i, type, base: .12, edge: e, op: strong ? .5 : .32, eop: strong ? .55 : .28 };
      slabs.push(m);
      if (M.pleLayers.includes(i)) { const r = new THREE.Mesh(new THREE.TorusGeometry(.13, .012, 8, 40), glowMat(COL.storage, .95)); r.position.set(0, TOWER.h / 2 + .2, 0); r.rotation.x = Math.PI / 2; m.add(r); }
      if (marked.has(i)) { const d = new THREE.Mesh(new THREE.SphereGeometry(.018, 10, 8), glowMat('#ffffff', .5)); d.position.set(0, TOWER.h / 2 + .08, 0); m.add(d); }
    });
    const railMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uTime, uCol: { value: C3(COL.accent2) }, uBoost: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
      fragmentShader: `uniform float uTime; uniform vec3 uCol; uniform float uBoost; varying vec2 vUv; void main(){ float d = fract(vUv.x*14. - uTime*.35); float p = smoothstep(.0,.15,d)*smoothstep(.5,.15,d);
        gl_FragColor = vec4(uCol*(.35+p*(.6+uBoost*1.5)), .5+p*.4); }` });
    ST.stack = { group: g, rails: railMat, pos: V((TOWER.x0 + TOWER.x1) / 2, 0, TOWER.z) };
    const S = clamp(M.streams, 1, 8);
    for (let k = 0; k < S; k++) { const dy = S > 1 ? -.3 + k * (.6 / (S - 1)) : 0;
      const r = new THREE.Mesh(new THREE.CylinderGeometry(.012, .012, TOWER.x1 - TOWER.x0 + .9, 8, 1, true), railMat); r.rotation.z = Math.PI / 2; r.position.set((TOWER.x0 + TOWER.x1) / 2, TOWER.y + dy, TOWER.z); g.add(r); }
    const l = label(`${esc(tt('stack')[0])}<small>${esc(tt('stack')[1])}</small>`); l.position.set((TOWER.x0 + TOWER.x1) / 2, TOWER.y + TOWER.h / 2 + .55, TOWER.z); g.add(l); ST.stack.label = l; stLabels.push(['stack', l.userData.el]);
    const base = new THREE.Mesh(new RoundedBoxGeometry(TOWER.x1 - TOWER.x0 + .8, .16, TOWER.d + .5, 4, .07), darkMat()); base.position.set((TOWER.x0 + TOWER.x1) / 2, .08, TOWER.z); g.add(base);
    const ring = new THREE.Mesh(new THREE.PlaneGeometry(TOWER.x1 - TOWER.x0 + .7, TOWER.d + .4), glowMat(SC.stack, .05)); ring.rotation.x = -Math.PI / 2; ring.position.set((TOWER.x0 + TOWER.x1) / 2, .17, TOWER.z); g.add(ring); ST.stack.ring = ring;
  }
  const waves = [];
  const wave = (o = {}) => waves.push({ x: TOWER.x0 - .6, speed: o.speed ?? 7, width: o.width ?? .5, amp: o.amp ?? 1.6 });

  /* ── PLE n-gram library on the host band ── */
  if (M.has.ple && memRegion.ple) {
    const reg = memRegion.ple; const g = new THREE.Group(); g.position.set(reg.x + reg.w * .5, 0, reg.z + reg.d * .48); scene.add(g);
    const cols = 96, rows = 4, deep = 5, N = cols * rows * deep;
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(.05, .05, .2), new THREE.MeshStandardMaterial({ color: '#0c1d18', emissive: C3(COL.storage), emissiveIntensity: .16, metalness: .4, roughness: .45 }), N);
    let k = 0; const W = Math.min(reg.w - 1.2, 9.6);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) for (let z = 0; z < deep; z++) { _d.position.set(-W / 2 + c * (W / cols), .2 + r * .075, -.7 + z * .35); _d.updateMatrix(); inst.setMatrixAt(k, _d.matrix); inst.setColorAt(k, C3('#1d4f3f').multiplyScalar(.45 + rnd() * .45)); k++; }
    g.add(inst); pickable(inst, { type: 'station', id: 'ple' });
    const l = label(`${esc(tt('ple')[0])}<small>${esc(tt('ple')[1])}</small>`); l.position.set(0, .95, 0); g.add(l); stLabels.push(['ple', l.userData.el]);
    ST.ple = { group: g, inst, N, label: l, pos: g.position.clone(), hot: new Map() };
  } else if (M.has.ple) {   // PLE on the GPU: draw the library beside the stack instead
    const g = new THREE.Group(); g.position.set(-1.0, 0, 4.6); scene.add(g);
    const N = 600; const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(.05, .05, .2), new THREE.MeshStandardMaterial({ color: '#0c1d18', emissive: C3(COL.storage), emissiveIntensity: .16 }), N);
    for (let k = 0; k < N; k++) { _d.position.set(-2.4 + (k % 60) * .08, .2 + ((k / 60) | 0) % 4 * .075, -.2 + ((k / 240) | 0) * .3); _d.updateMatrix(); inst.setMatrixAt(k, _d.matrix); inst.setColorAt(k, C3('#1d4f3f')); }
    g.add(inst); pickable(inst, { type: 'station', id: 'ple' });
    const l = label(`${esc(tt('ple')[0])}<small>${esc(tt('ple')[1])}</small>`); l.position.set(0, .95, 0); g.add(l); stLabels.push(['ple', l.userData.el]);
    ST.ple = { group: g, inst, N, label: l, pos: g.position.clone(), hot: new Map() };
  }
  const flashPLE = (n = 16) => { const p = ST.ple; if (!p) return; for (let i = 0; i < n; i++) p.hot.set((rnd() * p.N) | 0, 1); };

  /* ── Paths and particles ── */
  const sp = id => ST[id].pos;
  const towerIn = V(TOWER.x0 - .5, TOWER.y, TOWER.z), towerOut = V(TOWER.x1 + .5, TOWER.y, TOWER.z);
  const PATHS = {
    in: [PORT, V(-1.5, .9, -6.6), V(-4.2, .9, -5.6), sp('api').clone().setY(1.0)],
    tok: [sp('api').clone().setY(.7), sp('tokenizer').clone().setY(.7)],
    sched: [sp('tokenizer').clone().setY(.7), sp('scheduler').clone().setY(.7)],
    emb: [sp('scheduler').clone().setY(.7), sp('embed').clone().setY(.9)],
    toTower: [sp('embed').clone().setY(1.0), V(-4.3, 1.2, 2.2), towerIn],
    toHead: [towerOut, V(4.7, 1.25, 1.4), sp('head').clone().setY(.8)],
    toSample: [sp('head').clone().setY(.8), sp('sample').clone().setY(.8)],
    out: [sp('stream').clone().setY(.8), V(3.0, .9, -6.6), PORT.clone().setX(.25)],
  };
  if (ST.ple && M.pleLayers.length) PATHS.ple = [ST.ple.pos.clone().setY(.95), V(-2.6, 2.6, 3.6), V(slabX(M.pleLayers[0]), TOWER.y + TOWER.h / 2 + .1, TOWER.z)];
  if (K) {
    PATHS.toMTP = [sp('sample').clone().setY(.8), V(4.4, .9, -3.4), sp('mtp').clone().setY(.9)];
    PATHS.toStream = [sp('mtp').clone().setY(.9), V(4.2, .9, -5.0), sp('stream').clone().setY(.8)];
    PATHS.loop = [sp('mtp').clone().setY(.9), V(0, 3.4, -2.2), V(TOWER.x0 - 1.0, 2.6, .2), towerIn];
  } else {
    PATHS.toStream = [sp('sample').clone().setY(.8), V(5.9, .9, -3.4), sp('stream').clone().setY(.8)];
    PATHS.loop = [sp('sample').clone().setY(.8), V(1.5, 3.4, -2.2), V(TOWER.x0 - 1.0, 2.6, .2), towerIn];
  }
  const PATHCOL = { in: COL.net, tok: COL.agent, sched: COL.neutral, emb: COL.accent2, toTower: COL.accent2, ple: COL.storage, toHead: COL.accent2, toSample: COL.compute, toMTP: COL.agent, toStream: COL.agent, out: COL.net, loop: COL.agent };
  const curves = {};
  const flowMat = col => new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uTime, uCol: { value: C3(col) }, uA: { value: .22 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `uniform float uTime; uniform vec3 uCol; uniform float uA; varying vec2 vUv; void main(){ float d = fract(vUv.x*9. - uTime*.5); float p = smoothstep(0.,.1,d)*smoothstep(.35,.1,d);
      gl_FragColor = vec4(uCol*(.6+p), uA*(.55+p)); }` });
  for (const [k, pts] of Object.entries(PATHS)) {
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal'); curves[k] = c;
    const mat = flowMat(PATHCOL[k]); if (k === 'loop') mat.uniforms.uA.value = .12;
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(c, 64, k === 'ple' ? .022 : .016, 6, false), mat));
  }
  const P_MAX = 900;
  const particles = new THREE.InstancedMesh(new THREE.SphereGeometry(.05, 10, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), P_MAX);
  particles.instanceMatrix.setUsage(THREE.DynamicDrawUsage); particles.count = 0; scene.add(particles);
  const plist = [];
  function emit(path, n = 1, o = {}) {
    if (!curves[path]) return;
    for (let i = 0; i < n && plist.length < P_MAX; i++) plist.push({ c: curves[path], t: -(o.spread ?? .25) * (i / Math.max(1, n)) - (o.delay ?? 0), v: o.speed ?? .45, col: C3(o.col ?? PATHCOL[path]), s: o.size ?? 1, then: o.then });
  }
  function updateParticles(dt) {
    let k = 0;
    for (let i = plist.length - 1; i >= 0; i--) {
      const p = plist[i]; p.t += p.v * dt;
      if (p.t >= 1) { plist.splice(i, 1); p.then?.(); continue; }
      if (p.t < 0) continue;
      p.c.getPointAt(p.t, _d.position); _d.scale.setScalar(p.s * (.7 + .3 * Math.sin(p.t * Math.PI))); _d.updateMatrix();
      particles.setMatrixAt(k, _d.matrix); particles.setColorAt(k, p.col); k++;
    }
    particles.count = k; particles.instanceMatrix.needsUpdate = true; if (particles.instanceColor) particles.instanceColor.needsUpdate = true;
  }

  /* ── Layer detail rig: a layer lifts out of the stack and unfolds ── */
  const RIG = { y: 2.95, z: TOWER.z, x: .25 };
  const rig = new THREE.Group(); rig.position.set(RIG.x, RIG.y, RIG.z); rig.visible = false; scene.add(rig);
  const R = {};
  {
    const plate = new THREE.Mesh(new RoundedBoxGeometry(7.4, .05, 1.5, 3, .02), new THREE.MeshStandardMaterial({ color: '#10141c', metalness: .4, roughness: .5, transparent: true, opacity: .85 }));
    plate.position.y = -.05; rig.add(plate);
    const hcMat = glowMat(COL.accent2, .7);
    const S = clamp(M.streams, 1, 8), offs = S > 1 ? Array.from({ length: S }, (_, k) => -.3 + k * (.6 / (S - 1))) : [0];
    const fan = (x0, x1, merge) => { for (const dy of offs) { const a = V(x0, .6 + (merge ? dy : 0), 0), b = V(x1, .6 + (merge ? 0 : dy), 0); rig.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 4, .01, 6), hcMat)); } };
    fan(-3.6, -3.05, true); fan(3.1, 3.6, false);
    const lbl = (txt, x, y = 1.42) => { const l = label(esc(txt), 'lbl3d tok'); l.position.set(x, y, 0); rig.add(l); return l; };
    lbl(S > 1 ? `mix ${S} streams` : 'residual in', -3.3, 1.05); lbl(S > 1 ? 'write back' : 'add to residual', 3.35, 1.05);
    const norm = x => { const n = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, .05, 32), glassMat(COL.neutral, .9)); n.rotation.z = Math.PI / 2; n.position.set(x, .6, 0); rig.add(n); lbl('RMSNorm', x, 1.0); };
    norm(-2.85); norm(.6);

    // mixer A: recurrent state (Gated DeltaNet / Mamba): one tile per head
    if (M.has.linear || M.has.ssm) {
      const g = new THREE.Group(); g.position.set(-1.15, 0, 0); rig.add(g);
      const mat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uTime, uAmp: { value: .6 }, uCol: { value: C3(M.has.linear ? COL.linear : COL.ssm) } },
        vertexShader: `attribute float aSeed; varying vec2 vUv; varying float vSeed; void main(){ vUv=uv; vSeed=aSeed; gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.); }`,
        fragmentShader: `uniform float uTime; uniform float uAmp; uniform vec3 uCol; varying vec2 vUv; varying float vSeed;
          float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
          void main(){ vec2 c = floor(vUv*8.); float t = uTime*(.6+vSeed*.8)+vSeed*40.; float a = h(c+floor(t)), b = h(c+floor(t)+1.); float v = mix(a,b,smoothstep(0.,1.,fract(t)));
            float diag = 1.-smoothstep(0.,1.5,abs(c.x-c.y)); v = v*.7 + diag*.3; vec2 e = abs(vUv-.5); float frame = step(.44,max(e.x,e.y));
            gl_FragColor = vec4(uCol*(.15+v*uAmp*1.2) + frame*uCol*.6, .75); }` });
      const nh = clamp(M.lin?.value_heads || M.lin?.heads || 16, 1, 64), cols = Math.min(12, nh), rows = Math.ceil(nh / cols), sz = Math.min(.22, 1.0 / rows);
      const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(sz, sz), mat, nh); const seeds = new Float32Array(nh);
      for (let i = 0; i < nh; i++) { const r = Math.floor(i / cols), c = i % cols; _d.position.set(-(cols - 1) * .215 / 2 + c * .215, .25 + r * (sz + .02), 0); _d.scale.setScalar(1); _d.updateMatrix(); tiles.setMatrixAt(i, _d.matrix); seeds[i] = rnd(); }
      tiles.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1)); g.add(tiles);
      const conv = new THREE.Mesh(new THREE.BoxGeometry(2.6, .06, .14), glassMat(COL.linear, .7)); conv.position.set(0, .08, .25); g.add(conv);
      const l1 = M.lin?.kind === 'gated_deltanet' ? `${nh} value heads · each a ${M.lin.key_dim}×${M.lin.value_dim} state` : M.lin?.kind === 'mamba' ? `${nh} heads · state size ${M.lin.state_size ?? '?'}` : `${nh} heads · fixed-size state`;
      const a = label(esc(l1)); a.position.set(0, 1.35, 0); g.add(a);
      const b = label(M.lin?.conv ? `short conv (k=${M.lin.conv}) · q k v · gates` : 'input projections · gates'); b.position.set(0, -.08, .3); g.add(b);
      g.add(hitBox(2.8, 1.3, .8, { type: 'rig', id: 'linear' }, .65));
      R.linear = { group: g, mat };
    }
    // mixer B: attention (full, sparse or sliding): context ribbon, query heads, KV heads
    {
      const g = new THREE.Group(); g.position.set(-1.15, 0, 0); rig.add(g);
      const NB = 72; const ctx = new THREE.InstancedMesh(new THREE.BoxGeometry(.03, .16, .1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false }), NB);
      for (let i = 0; i < NB; i++) { _d.position.set(-1.3 + i * .036, .22, 0); _d.scale.set(1, 1, 1); _d.updateMatrix(); ctx.setMatrixAt(i, _d.matrix); ctx.setColorAt(i, C3(COL.attention).multiplyScalar(.18)); }
      g.add(ctx);
      const scan = new THREE.Mesh(new THREE.BoxGeometry(.05, .4, .3), glowMat(COL.warn, .5)); scan.position.set(-1.3, .22, 0); g.add(scan);
      const H = clamp(M.att.heads || 8, 1, 48), cols = Math.min(12, H), rows = Math.ceil(H / cols);
      const qpos = i => V(-(cols - 1) * .1 + (i % cols) * .2, .82 + Math.floor(i / cols) * (rows > 2 ? .09 : .14), .05);
      const qs = new THREE.InstancedMesh(new THREE.SphereGeometry(.035, 10, 8), glowMat(COL.attention, .9), H);
      for (let i = 0; i < H; i++) { _d.position.copy(qpos(i)); _d.updateMatrix(); qs.setMatrixAt(i, _d.matrix); } g.add(qs);
      const KH = clamp(M.has.mla ? 1 : (M.att.kv_heads || H), 1, 8);
      const kx = j => KH > 1 ? -.9 + j * (1.8 / (KH - 1)) : 0;
      for (let j = 0; j < KH; j++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(.07, .07, .34, 20), glassMat(COL.warn, .9)); p.position.set(kx(j), 1.22 + (rows > 2 ? .1 : 0), .05); g.add(p); }
      const per = H / KH;
      const gq = new THREE.Group(); for (let i = 0; i < H; i++) { const a = qpos(i), b = V(kx(Math.min(KH - 1, Math.floor(i / per))), 1.08 + (rows > 2 ? .1 : 0), .05);
        gq.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(a, b), 2, .004, 4), glowMat(COL.attention, .35))); } g.add(gq);
      const kvd = (M.kv.dtype && M.kv.dtype !== 'auto') ? M.kv.dtype.toUpperCase() : 'BF16';
      const a1 = label(esc(`KV cache · ${M.has.sliding && !M.idx.attn.length ? 'recent window' : 'whole context'} (${kvd})`)); a1.position.set(0, -.06, .3); g.add(a1);
      const kindTxt = M.has.mla ? `${M.att.heads} query heads → one latent KV (MLA)` : `${M.att.heads} query heads → ${M.att.kv_heads} KV heads (${(M.att.kind || 'gqa').toUpperCase()})`;
      const a2 = label(esc(kindTxt)); a2.position.set(0, 1.55 + (rows > 2 ? .12 : 0), 0); g.add(a2);
      const a3 = label(''); a3.position.set(-.6, .5, .25); g.add(a3);
      g.add(hitBox(2.8, 1.5, .8, { type: 'rig', id: 'attn' }, .7));
      R.attn = { group: g, ctx, scan, NB, sel: new Set(), note: a3, mode: 'full' };
    }
    // FFN: experts (MoE) or one dense block
    {
      const g = new THREE.Group(); g.position.set(1.95, 0, 0); rig.add(g);
      if (M.has.moe) {
        const E = M.moe.experts, cols = E >= 256 ? 32 : E >= 64 ? 16 : 8, rows = Math.ceil(E / cols), s = Math.min(.05, 1.0 / rows * .8), step = Math.min(.062, 2.0 / cols);
        const EX = new THREE.InstancedMesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color: '#ffffff' }), E);
        for (let i = 0; i < E; i++) { const r = Math.floor(i / cols), c = i % cols; _d.position.set(-(cols - 1) * step / 2 + c * step, .12 + r * Math.min(.062, 1.0 / rows), 0); _d.scale.setScalar(1); _d.updateMatrix(); EX.setMatrixAt(i, _d.matrix); EX.setColorAt(i, C3(COL.compute).multiplyScalar(.16)); }
        g.add(EX);
        let shared = null;
        if (M.moe.shared) { shared = new THREE.Mesh(new RoundedBoxGeometry(.22, .22, .22, 2, .03), glassMat(COL.compute, .95)); shared.position.set(1.22, .6, 0); g.add(shared); const l = label(M.moe.shared > 1 ? `${M.moe.shared} shared` : 'shared'); l.position.set(1.22, .86, 0); g.add(l); }
        const router = new THREE.Mesh(new THREE.BoxGeometry(2.0, .03, .12), glassMat(COL.warn, .8)); router.position.set(-.04, .03, .12); g.add(router);
        const l1 = label(esc(`${E} experts · top-${M.moe.top_k} per token`)); l1.position.set(0, 1.25, 0); g.add(l1);
        const l3 = label('router'); l3.position.set(-.04, -.09, .25); g.add(l3);
        R.ffn = { group: g, EX, E, shared, hot: new Float32Array(E) };
      } else {
        const blocks = ['gate', 'up', 'down'].map((n, j) => { const b = new THREE.Mesh(new THREE.BoxGeometry(j === 2 ? .5 : .9, .5, .3), glassMat(COL.compute, .85)); b.position.set(-.6 + j * .62, .55, 0); g.add(b); return b; });
        const l1 = label(esc(`${int(M.denseDim)} hidden units · ${M.act === 'silu' ? 'SwiGLU' : (M.act || 'MLP')}`)); l1.position.set(0, 1.25, 0); g.add(l1);
        R.ffn = { group: g, blocks, dense: true, hot: 0 };
      }
      g.add(hitBox(2.8, 1.3, .8, { type: 'rig', id: 'ffn' }, .65));
    }
    R.title = label('', 'lbl3d'); R.title.position.set(0, 1.95, 0); rig.add(R.title);
    R.beam = new THREE.Mesh(new THREE.CylinderGeometry(.01, .01, 1, 6), glowMat(COL.accent2, .6)); scene.add(R.beam); R.beam.visible = false;
  }
  let rigLayer = -1;
  const MIX = { attention: 'Full attention', sliding: 'Sliding-window attention', linear: M.lin?.kind === 'gated_deltanet' ? 'Gated DeltaNet' : 'Linear attention', ssm: 'State-space (Mamba)' };
  function openLayer(i) {
    i = clamp(i, 0, L - 1); rigLayer = i; const type = M.types[i];
    const recurrent = type === 'linear' || type === 'ssm';
    if (R.linear) R.linear.group.visible = recurrent; R.attn.group.visible = !recurrent;
    R.attn.mode = type === 'sliding' ? 'sliding' : M.has.sparse ? 'sparse' : 'full';
    R.attn.note.userData.el.textContent = R.attn.mode === 'sparse' ? `indexer picks ≤ ${int(M.att.sparse.budget)}` : R.attn.mode === 'sliding' ? `window: last ${int(M.att.sliding_window)}` : 'every earlier token';
    const name = type === 'attention' && M.has.sparse ? 'Sparse attention' : MIX[type];
    const extra = [M.pleLayers.includes(i) ? 'receives PLE rows' : '', ...M.marks.filter(m => m.layers.includes(i)).map(m => m.label)].filter(Boolean).join(' · ');
    const ffn = M.ffnTypes[i] === 'moe' ? `MoE (${M.moe.experts} experts)` : 'dense FFN';
    R.title.userData.el.innerHTML = `Layer ${i + 1} of ${L} · ${esc(name)}<small>mixer → ${esc(ffn)}${M.has.hyper ? ' · hyper-connections' : ''}${extra ? ' · ' + esc(extra) : ''}</small>`;
    if (R.ffn.EX) R.ffn.group.visible = true;
    if (!rig.visible) { rig.visible = true; rig.scale.setScalar(.001); animate(REDUCED ? .01 : .55, k => rig.scale.setScalar(Math.max(.001, ease(k)))); }
    const a = V(slabX(i), TOWER.y + TOWER.h / 2, TOWER.z), b = V(RIG.x, RIG.y - .05, TOWER.z);
    R.beam.visible = true; R.beam.scale.y = a.distanceTo(b); R.beam.quaternion.setFromUnitVectors(V(0, 1, 0), b.clone().sub(a).normalize()); R.beam.position.copy(a.clone().add(b).multiplyScalar(.5));
    slabs.forEach((s, j) => s.userData.sel = j === i);
  }
  function closeLayer() { if (!rig.visible) return; rigLayer = -1; R.beam.visible = false; slabs.forEach(s => s.userData.sel = false);
    animate(REDUCED ? .01 : .3, k => rig.scale.setScalar(Math.max(.001, 1 - ease(k))), () => { rig.visible = false; }); }
  function moeTick(intensity = 1) {
    const f = R.ffn; if (f.dense) { f.hot = intensity; return; }
    for (let j = 0; j < M.moe.top_k; j++) f.hot[(rnd() * f.E) | 0] = intensity;
    if (f.shared) f.shared.material.emissiveIntensity = .9;
  }
  function attnTick() { const a = R.attn; a.sel.clear(); const n = a.mode === 'full' ? a.NB : a.mode === 'sliding' ? 0 : 9 + ((rnd() * 8) | 0); for (let j = 0; j < n; j++) a.sel.add(a.mode === 'full' ? j : (rnd() * a.NB) | 0); a.sweep = 0; }

  /* ── Camera ── */
  const VIEWS = {
    exterior: { pos: V(9, 6.5, 27), target: V(0, 2.2, 0) },
    hw: { pos: V(13, 8.5, 21), target: V(0, 2.0, 0) },
    overview: { pos: V(11.5, 12, 15), target: V(0, .6, .3) },
    memory: { pos: V(.01, 21, 5.5), target: V(0, 0, .4) },
    stack: { pos: V(2.2, 4.3, 7.2), target: V(.25, 1.25, 1.4) },
  };
  if (ST.ple) VIEWS.ple = { pos: ST.ple.pos.clone().add(V(1.8, 3.1, 4.4)), target: ST.ple.pos.clone().add(V(0, .45, 0)) };
  function viewFor(id) {
    if (VIEWS[id]) return VIEWS[id];
    if (id === 'linear' || id === 'attn' || id === 'ffn') { const x = RIG.x + (id === 'ffn' ? .6 : -.5); const t = V(x, RIG.y + .55, RIG.z); return { target: t, pos: t.clone().add(V(.3, 1.0, 7.6)) }; }
    const CAM = { api: [3.2, 2.6, 3.2], tokenizer: [4.2, 3.0, 3.0], scheduler: [2.4, 3.0, 2.6], embed: [3.0, 2.6, 3.4], head: [-.2, 2.6, 4.2], sample: [-3.2, 2.8, -1.2], mtp: [-2.6, 2.8, 2.4], stream: [-3.0, 2.8, 2.0] };
    if (!ST[id]) return VIEWS.overview;
    const t = ST[id].pos.clone().add(V(0, .8, 0)); return { target: t, pos: t.clone().add(V(...(CAM[id] || [3, 2.7, 3.4]))) };
  }
  let flight = null;
  function flyTo(v, dur = 1.7) {
    if (REDUCED || dur <= 0) { camera.position.copy(v.pos); controls.target.copy(v.target); flight = null; return; }
    const p0 = camera.position.clone(), t0 = controls.target.clone();
    flight = { e: 0, dur, p0, t0, p1: v.pos.clone(), t1: v.target.clone(), lift: Math.min(3, p0.distanceTo(v.pos) * .12) };
  }
  controls.addEventListener('start', () => { flight = null; });
  function updateFlight(dt) {
    if (!flight) return; flight.e += dt; const k = ease(clamp(flight.e / flight.dur, 0, 1));
    camera.position.lerpVectors(flight.p0, flight.p1, k); camera.position.y += Math.sin(k * Math.PI) * flight.lift;
    controls.target.lerpVectors(flight.t0, flight.t1, k); if (k >= 1) flight = null;
  }

  /* ── Trace-driven state: sampler bars, head top-5, drafter labels ── */
  let TR = null, ansIdx = 0;
  const samp = { target: [0, 0, 0, 0, 0], cur: [0, 0, 0, 0, 0] };
  function setAnswer(i) {
    if (!TR?.out.length) return;
    ansIdx = ((i % TR.out.length) + TR.out.length) % TR.out.length;
    const top = TR.out[ansIdx].top || [];
    for (let j = 0; j < 5; j++) { samp.target[j] = top[j]?.[1] ?? 0; ST.sample.tags[j].userData.el.textContent = top[j] ? showTok(top[j][0]) : ''; }
  }
  function setTrace(t) {
    TR = t; ansIdx = 0;
    buildChips(t?.tokens || []);
    ST.head.top = (t?.out[0]?.top || []).map(x => x[1]); ST.head._lift = -1;
    setAnswer(0); labelDrafts(1);
  }
  function labelDrafts(si) {   // label the orbs with the drafts a real step accepted; rejected drafts were never revealed
    if (!K || !TR) return; const s = TR.steps[si]; if (!s) return;
    ST.mtp.orbs.forEach((o, j) => { o.userData.tag.userData.el.textContent = j < s.n - 1 ? showTok(s.tokens[j].text) : j === s.n - 1 ? '✗' : '–'; });
  }
  function verify(si) {   // play one real decode step on the drafter: green = accepted, red = first rejection, grey = discarded after it
    if (!K) return; const s = TR?.steps[si];
    const ok = s ? ST.mtp.orbs.map((_, j) => j < s.n - 1 ? 1 : j === s.n - 1 ? -1 : -.4) : ST.mtp.acc.map(p => rnd() < p ? 1 : -1);
    labelDrafts(si);
    ST.mtp.orbs.forEach((o, j) => setTimeout(() => { o.userData.state = ok[j]; }, j * 220));
    ST.mtp.gate.material.emissiveIntensity = 1.2;
  }

  /* ── Beats: the animations the walkthrough plays (all driven by the real trace where one exists) ── */
  const timers = [];
  const later = (sec, fn) => timers.push(setTimeout(fn, sec * 1000 / (S.speed || 1)));
  function clearBeats() { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); timers.length = 0; }
  const portPulse = () => animate(1.2, k => { portLight.material.opacity = .3 + .7 * Math.sin(k * Math.PI * 4) ** 2; });
  let decodeI = 1;
  function decodeStep(rate = 1) {
    wave({ speed: 9, width: .45, amp: 1.3 * rate }); flashPLE(16);
    if (rigLayer >= 0) { moeTick(1); if (M.types[rigLayer] !== 'linear') attnTick(); }
    emit('loop', 1, { speed: .9 }); emit('toHead', 1, { speed: 1.2, delay: .3 });
    if (TR?.steps.length > 1) { const si = decodeI; verify(si); const s = TR.steps[si]; setAnswer(s ? TR.out.findIndex(x => x.step === si) : 0); decodeI = decodeI + 1 >= TR.steps.length ? 1 : decodeI + 1; hooks.onDecodeStep?.(si); }
    else { verify(-1); setAnswer(ansIdx + 1); }
    ST.sample.flash = 1; emit('out', 2, { speed: .9, delay: .4, col: COL.net });
  }
  const BEATS = {
    intro() { flyTo(VIEWS.exterior, 0); flyTo(VIEWS.hw, 2.2); animate(2.4, k => { led.material.opacity = .5 + .5 * Math.sin(k * 18); }); },
    memory() { Object.values(memRegion).forEach((g, j) => later(.3 + j * .25, () => animate(.8, k => { g.mesh.material.opacity = .085 + .3 * Math.sin(k * Math.PI); }))); },
    prompt() { portPulse(); },
    request() { portPulse(); emit('in', 8, { spread: .35, speed: .55 }); later(1.4, () => { ST.api.boost = 1; }); },
    tokenize() { emit('tok', 4, { speed: .8 }); const ch = ST.tokenizer.chips; ch.forEach((c, i) => { c.scale.setScalar(.001); later(.6 + i * Math.min(.17, 4 / ch.length), () => animate(.35, k => c.scale.setScalar(Math.max(.001, ease(k) * (1 + .4 * Math.sin(k * Math.PI)))))); }); },
    schedule() { emit('sched', 6, { speed: .8 }); later(1, () => { ST.scheduler.lit = 1; }); const nb = clamp(TR?.kvBlocks || 2, 1, 40); ST.scheduler.pages.forEach((p, i) => later(1.4 + i * .03, () => { p.userData.on = i < nb ? 1 : 0; })); },
    embed() { emit('emb', 8, { speed: .9 }); const n = TR?.n || 19; later(.9, () => { let r = 0; const iv = setInterval(() => { ST.embed.table.uniforms.uRow.value = ((TR?.tokens[r]?.id ?? r * 7) % 64); if (++r >= Math.min(n, 40)) { clearInterval(iv); ST.embed.table.uniforms.uRow.value = -1; } }, 110); timers.push(iv); });
      later(1.6, () => emit('toTower', Math.min(n, 40), { spread: .5, speed: .5, size: 1.2 })); },
    ple() { const n = Math.min(TR?.n || 19, 30); for (let i = 0; i < n; i++) later(i * .22, () => { flashPLE(16); emit('ple', 1, { speed: .7, size: 1.3 }); }); },
    stack() { emit('toTower', Math.min(TR?.n || 19, 40), { spread: .4, speed: .7 }); later(.9, () => wave({ speed: 2.2, width: 1.2, amp: 2.4 })); later(1, () => { ST.stack.rails.uniforms.uBoost.value = 1; }); later(4.5, () => { ST.stack.rails.uniforms.uBoost.value = 0; }); },
    linear() { openLayer(M.firstOf(M.has.linear ? 'linear' : 'ssm')); if (R.linear) { R.linear.mat.uniforms.uAmp.value = 1.1; later(8, () => { R.linear.mat.uniforms.uAmp.value = .6; }); } },
    attn() { const i = M.firstOf('attention') >= 0 ? M.firstOf('attention') : M.firstOf('sliding'); openLayer(i); for (let j = 0; j < 5; j++) later(.6 + j * 1.5, attnTick); },
    ffn() { if (rigLayer < 0) openLayer(Math.max(0, M.ffnTypes.indexOf(M.has.moe ? 'moe' : 'dense'))); for (let j = 0; j < 24; j++) later(.4 + j * .3, () => moeTick(1)); },
    head() { closeLayer(); emit('toHead', 3, { speed: .7 }); ST.head.lift = 0; later(.8, () => animate(1.6, k => { ST.head.lift = ease(k); })); later(2.6, () => setAnswer(0)); },
    sample() { setAnswer(0); emit('toSample', 2, { speed: .8 }); later(1.2, () => { ST.sample.flash = 1; }); },
    spec() { emit('toMTP', 2, { speed: .8 }); decodeI = 1; later(1.2, () => verify(1)); later(1.2, () => setAnswer(TR?.out.findIndex(x => x.step === 1) ?? 1)); },
    decode() { decodeI = 1; let n = 0; const iv = setInterval(() => { decodeStep(); if (++n >= Math.min(12, (TR?.steps.length || 9) - 1)) clearInterval(iv); }, 900 / (S.speed || 1)); timers.push(iv); },
    stream() { emit('toStream', 4, { speed: .8 }); later(.8, () => emit('out', 8, { spread: .5, speed: .6, col: COL.net })); later(1.2, portPulse); },
    stop() { emit('out', 3, { spread: .4, speed: .6, col: COL.net }); later(.6, portPulse); },
  };
  function beat(name) { clearBeats(); BEATS[name]?.(); }

  /* ── Picking ── */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let hover = null, downAt = null;
  const tip = label('', 'lbl3d'); tip.visible = false; scene.add(tip);
  function pickAt(x, y) {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const vis = pickables.filter(m => { let o = m; while (o) { if (!o.visible) return false; o = o.parent; } return true; });
    for (const h of ray.intersectObjects(vis, false)) { const p = h.object.userData.pick; if (!p) continue; if (p.id === 'hw' && shellMat.uniforms.uOpacity.value < .5) continue; return { ...p, point: h.point }; }
    return null;
  }
  canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return; downAt = null;
    const p = pickAt(e.clientX, e.clientY); if (p) hooks.onPick?.(p);
  });
  canvas.addEventListener('pointermove', e => {
    hover = pickAt(e.clientX, e.clientY); canvas.style.cursor = hover ? 'pointer' : '';
    if (hover?.type === 'layer') { const t = M.types[hover.i]; tip.userData.el.innerHTML = `Layer ${hover.i + 1}<small>${esc(t === 'attention' && M.has.sparse ? 'Sparse attention' : MIX[t])}${M.pleLayers.includes(hover.i) ? ' · PLE' : ''}</small>`;
      tip.position.set(slabX(hover.i), TOWER.y + TOWER.h / 2 + .35, TOWER.z); tip.visible = true; } else tip.visible = false;
  });

  /* ── Frame loop ── */
  const S = { speed: 1, focus: null, show: {}, panelW: 0 };
  let last = performance.now(), fps = 60, interior = false;
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000); last = now; fps = fps * .95 + (1 / Math.max(dt, 1e-3)) * .05; uTime.value += dt;
    updateFlight(dt); controls.update();
    for (const a of [...anims]) if (!a.update(dt)) anims.delete(a);
    hooks.onFrame?.(dt);

    const cp = camera.position; interior = Math.abs(cp.x) < 7.9 && Math.abs(cp.z) < 7.9 && cp.y < 5.5;
    const dist = cp.distanceTo(V(0, 2.6, 0)), nearBox = Math.abs(cp.x) < 10 && Math.abs(cp.z) < 10 && cp.y < 7.5;
    const target = interior || nearBox ? 0 : clamp((dist - 23) / 5, .06, .94);
    shellMat.uniforms.uOpacity.value = lerp(shellMat.uniforms.uOpacity.value, target, Math.min(1, dt * 4));
    const so = shellMat.uniforms.uOpacity.value; lid.material.uniforms.uOpacity.value = interior ? 0 : so; grille.material.uniforms.uOpacity.value = interior ? 0 : Math.max(.15, so);
    const cur = S.focus, inner = so < .6, memOn = cur === 'memory' || cp.y > 14;
    const hid = hover?.type === 'station' ? hover.id : null, sh = S.show;
    const lkey = `${inner}|${cur}|${hid}|${memOn}|${sh.tokens}|${sh.probs}|${sh.drafts}|${rig.visible}`;
    if (lkey !== frame.lkey) { frame.lkey = lkey;
      for (const [id, el] of stLabels) { const show = inner && (!cur || id === hid || cur === 'memory') && id !== cur; el.style.opacity = show ? '1' : '0'; el.classList.toggle('compact', id !== hid); }
      ST.tokenizer.chips.forEach(c => c.userData.label.userData.el.classList.toggle('hide', !(inner && sh.tokens)));
      ST.sample.tags.forEach(t => { t.userData.el.style.opacity = inner && sh.probs ? '1' : '0'; });
      if (K) ST.mtp.orbs.forEach(o => { o.userData.tag.userData.el.style.opacity = inner && sh.drafts ? '1' : '0'; });
      rig.traverse(o => { if (o.userData?.el) o.userData.el.style.opacity = rig.visible && inner ? '1' : '0'; });
      for (const g of Object.values(memRegion)) g.label.userData.el.style.opacity = memOn && g.w > 1.6 ? '1' : '0'; }
    Object.values(memRegion).forEach(g => { if (!anims.size) g.mesh.material.opacity = lerp(g.mesh.material.opacity, cur === 'memory' ? .2 : .085, dt * 4); });
    led.material.opacity = S.live ? .95 : .6 + .3 * Math.sin(uTime.value * 1.6);

    for (const w of waves) w.x += w.speed * dt;
    for (let i = waves.length - 1; i >= 0; i--) if (waves[i].x > TOWER.x1 + 1) waves.splice(i, 1);
    for (const s of slabs) {
      let g = 0; for (const w of waves) { const d = (s.position.x - w.x) / w.width; g += Math.exp(-d * d) * w.amp; }
      g = Math.min(g, 1.1);   // overlapping waves on 48 translucent slabs otherwise bloom to white
      const hov = hover?.type === 'layer' && hover.i === s.userData.i;
      const dim = rig.visible && !s.userData.sel ? .35 : 1;
      s.material.emissiveIntensity = lerp(s.material.emissiveIntensity, (s.userData.base + g) * dim + (s.userData.sel ? 1.2 : 0) + (hov ? .8 : 0) + (cur === 'stack' ? .1 : 0), Math.min(1, dt * 12));
      s.userData.edge.material.opacity = (s.userData.eop + Math.min(.45, g * .3)) * dim + (s.userData.sel || hov ? .4 : 0); s.material.opacity = s.userData.op * (rig.visible && !s.userData.sel ? .45 : 1);
    }
    for (const [id, st] of Object.entries(ST)) if (st.ring) { const on = cur === id || (hover?.type === 'station' && hover.id === id); st.ring.material.opacity = lerp(st.ring.material.opacity, on ? 1 : .55, dt * 8); st.ring.scale.setScalar(lerp(st.ring.scale.x, on ? 1.06 : 1, dt * 8)); }
    ST.api.spin.rotation.z += dt * (1 + (ST.api.boost || 0) * 6); ST.api.boost = Math.max(0, (ST.api.boost || 0) - dt * .5);
    ST.scheduler.slots.forEach((l, i) => { l.material.opacity = lerp(l.material.opacity, i < (ST.scheduler.lit || 0) ? .95 : .12, dt * 5); });
    ST.scheduler.pages.forEach((p, i) => { const on = p.userData.on || (S.live && i < Math.round(40 * (S.kvUsage ?? 0))); p.material.opacity = lerp(p.material.opacity, on ? .9 : .22, dt * 5); p.material.emissiveIntensity = on ? .9 : .25; });
    if (ST.head.lift !== ST.head._lift) {
      ST.head._lift = ST.head.lift; const top = ST.head.top, mid = (ST.head.N / 2) | 0, slots = [-6, -3, 0, 3, 6], order = [2, 1, 0, 3, 4];
      for (let i = 0; i < ST.head.N; i++) { const a = (i / (ST.head.N - 1) - .5) * Math.PI * .9; const j = slots.indexOf(i - mid); const v = ST.head.h[i] + (j >= 0 ? ST.head.lift * (top[order[j]] || 0) * 1.5 : 0);
        _d.position.set(Math.sin(a) * .8, .2 + v / 2, -Math.cos(a) * .45); _d.scale.set(j >= 0 ? 2.2 : 1, v, j >= 0 ? 2.2 : 1); _d.rotation.set(0, 0, 0); _d.updateMatrix(); ST.head.bars.setMatrixAt(i, _d.matrix); }
      ST.head.bars.instanceMatrix.needsUpdate = true;
    }
    ST.sample.flash = Math.max(0, (ST.sample.flash || 0) - dt * 1.5);
    ST.sample.bars.forEach((b, j) => { samp.cur[j] = lerp(samp.cur[j], samp.target[j], Math.min(1, dt * 6)); const h = .04 + samp.cur[j] * 1.3; b.scale.y = h; b.position.y = .2 + h / 2; b.material.emissiveIntensity = j === 0 ? .5 + ST.sample.flash * 1.5 : .2; });
    ST.sample.pick.position.set(ST.sample.bars[0].position.x, .28 + samp.cur[0] * 1.3, 0);
    if (K) {
      ST.mtp.phase += dt * (1.1 + (S.genTps ?? 0) / 40);
      ST.mtp.orbs.forEach((o, j) => { const a = ST.mtp.phase + j * (Math.PI * 2 / K); o.position.set(Math.cos(a) * .72, .9 + Math.sin(a * 2) * .05, Math.sin(a) * .72);
        const st = o.userData.state || 0; o.material.color.set(st > .05 ? COL.good : st < -.6 ? COL.crit : st < -.05 ? COL.neutral : SC.mtp);
        o.userData.state = st > 0 ? Math.max(0, st - dt * .7) : st < 0 ? Math.min(0, st + dt * .7) : 0; o.scale.setScalar(.8 + (ST.mtp.acc[j] ?? .5) * .6); });
      ST.mtp.gate.material.emissiveIntensity = lerp(ST.mtp.gate.material.emissiveIntensity, .25, dt * 2);
    }
    ST.stream.discs.forEach((d, i) => { d.rotation.y += dt * (.4 + i * .25); });
    if (ST.ple?.hot.size) { for (const [i, v] of ST.ple.hot) { const nv = v - dt * 1.6; ST.ple.inst.setColorAt(i, tmpC.set('#1d4f3f').lerp(C3('#9dffd8'), Math.max(0, nv))); if (nv <= 0) { ST.ple.hot.delete(i); ST.ple.inst.setColorAt(i, tmpC.set('#1d4f3f').multiplyScalar(.8)); } else ST.ple.hot.set(i, nv); } ST.ple.inst.instanceColor.needsUpdate = true; }
    if (rig.visible) {
      const f = R.ffn;
      if (f.EX) { let dirty = false; for (let i = 0; i < f.E; i++) if (f.hot[i] > 0) { f.hot[i] = Math.max(0, f.hot[i] - dt * 1.2); f.EX.setColorAt(i, tmpC.set(COL.compute).multiplyScalar(.16).lerp(C3('#fff1e0').multiplyScalar(2.2), f.hot[i])); dirty = true; }
        if (dirty) f.EX.instanceColor.needsUpdate = true; if (f.shared) f.shared.material.emissiveIntensity = lerp(f.shared.material.emissiveIntensity, .35, dt * 2); }
      else { f.hot = Math.max(0, f.hot - dt * 1.2); f.blocks.forEach((b, j) => { b.material.emissiveIntensity = .25 + f.hot * (1.2 - j * .2); }); }
      const A = R.attn; if (A.group.visible) { A.sweep = (A.sweep ?? 0) + dt * .9; const x = -1.3 + ((A.sweep % 1.2) / 1.2) * 2.6; A.scan.position.x = x;
        const win = A.mode === 'sliding' ? 14 : 0;
        for (let i = 0; i < A.NB; i++) { const bx = -1.3 + i * .036, passed = bx < x; const inWin = win && i > A.NB - 1 - win;
          A.ctx.setColorAt(i, tmpC.set(COL.attention).multiplyScalar((A.sel.has(i) && passed) || (inWin && passed) ? 1.4 : .16 + (Math.abs(bx - x) < .06 ? .5 : 0))); }
        A.ctx.instanceColor.needsUpdate = true; }
    }
    const wide = innerWidth > 900 && !document.body.classList.contains('shot');
    const sx = wide ? (280 - S.panelW) / 2 : 0, sy = !wide && S.panelW ? -innerHeight * .26 : 0;
    frame.vx = lerp(frame.vx ?? sx, sx, Math.min(1, dt * 5)); frame.vy = lerp(frame.vy ?? sy, sy, Math.min(1, dt * 5));
    const ax = Math.abs(frame.vx), ay = Math.abs(frame.vy);
    if (ax > .5 || ay > .5) camera.setViewOffset(innerWidth + 2 * ax, innerHeight + 2 * ay, frame.vx > 0 ? 0 : 2 * ax, frame.vy < 0 ? 2 * ay : 0, innerWidth, innerHeight); else camera.clearViewOffset();
    updateParticles(dt); sky?.update();
    composer.render(); labels.render(scene, camera);
    requestAnimationFrame(frame);
  }
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight); });
  requestAnimationFrame(t => { last = t; frame(t); });

  /* ── Ambient motion and live mode ── */
  let idleT = 0;
  function ambience(dt) {
    idleT += dt; if (idleT < 2.4) return; idleT = 0;
    wave({ speed: 6, width: .5, amp: .8 }); flashPLE(10); emit('loop', 1, { speed: .5 });
    emit(rnd() < .5 ? 'in' : 'out', 1, { speed: .5 });
    if (rigLayer >= 0) { moeTick(.8); if (M.types[rigLayer] !== 'linear') attnTick(); }
  }
  const liveAcc = { wave: 0, gen: 0, pre: 0 };
  function liveTick(dt, s) {
    if (!s) return;
    S.kvUsage = s.kvUsage; S.genTps = s.genTokPerSec;
    const gen = Math.min(s.genTokPerSec ?? 0, 400), pre = Math.min(s.promptTokPerSec ?? 0, 20000);
    const stepsPerSec = s.stepMs && gen > .5 ? Math.min(1000 / s.stepMs, 20) : 0;
    liveAcc.wave += stepsPerSec * dt * .5;
    while (liveAcc.wave >= 1) { liveAcc.wave -= 1; wave({ speed: 10, width: .4, amp: 1 + (s.tokensPerStep ?? 1) * .3 }); flashPLE(16 * (s.running || 1)); if (rigLayer >= 0) { moeTick(1); if (M.types[rigLayer] !== 'linear') attnTick(); } if (K) verify(-1); setAnswer(ansIdx + 1); }
    liveAcc.gen += Math.min(gen, 60) * dt * .5; while (liveAcc.gen >= 1) { liveAcc.gen -= 1; emit(rnd() < .5 ? 'toHead' : 'out', 1, { speed: .9 + rnd() * .4 }); }
    liveAcc.pre += Math.min(pre / 40, 30) * dt; while (liveAcc.pre >= 1) { liveAcc.pre -= 1; emit(['in', 'emb', 'toTower', 'ple'][(rnd() * 4) | 0], 1, { speed: .8 + rnd() * .5 }); flashPLE(4); }
    if (s.gpu?.powerW != null) { const p = clamp((s.gpu.powerW - 10) / 90, 0, 1); led.material.color.set(COL.good).lerp(C3(COL.compute), p); }
    ST.scheduler.lit = s.running ?? 0; setKV(s.kvUsage ?? 0);
    if (K && s.acceptance?.every(x => x != null)) ST.mtp.acc = s.acceptance.slice(0, K);
  }

  Object.assign(S, {
    COL, SC, VIEWS, flyTo, viewFor, camera, controls, openLayer, closeLayer, get rigLayer() { return rigLayer; }, beat, clearBeats, setTrace, setAnswer, setKV,
    ambience, liveTick, decodeStep, sky, has: id => !!ST[id] || ['linear', 'attn', 'ffn', 'memory', 'hw', 'stack'].includes(id),
    resetLive() { setKV(0); ST.scheduler.lit = 0; },
    stats: () => ({ fps: +fps.toFixed(1), calls: renderer.info.render.calls, tris: renderer.info.render.triangles, particles: particles.count, interior, layers: L, stations: Object.keys(ST) }),
  });
  return S;
}

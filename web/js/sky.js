/* The background: the view from the International Space Station, now. Everything is computed from the clock:
 * the station's position from its orbital elements, Earth's rotation (sidereal time), the Sun and Moon, and
 * 9,096 catalogue stars precessed to today. The scene's floor faces away from Earth (scene +y is local
 * vertical), its +x is the direction of travel, so the ground slides by at 7.7 km/s and the stars turn once
 * an orbit. Data and credits: data/sky/SOURCES.md.
 * Frames: ECI is equatorial, mean equinox of date (close to the TEME frame the elements are in), Earth radii. */
import * as THREE from 'three';

const D2R = Math.PI / 180, RE = 6378.137, MU = 398600.4418, J2 = 1.08262668e-3;
const jd = ms => ms / 86400000 + 2440587.5;
const sin = Math.sin, cos = Math.cos;

/** Greenwich mean sidereal time, radians. */
export function gmst(ms) { const d = jd(ms) - 2451545, T = d / 36525; return (((280.46061837 + 360.98564736629 * d + .000387933 * T * T) % 360) + 360) % 360 * D2R; }
const obliquity = d => (23.439291 - 3.563e-7 * d) * D2R;
const fromEcliptic = (lam, bet, eps) => new THREE.Vector3(cos(bet) * cos(lam), cos(eps) * cos(bet) * sin(lam) - sin(eps) * sin(bet), sin(eps) * cos(bet) * sin(lam) + cos(eps) * sin(bet));

/** Unit vector to the Sun (Astronomical Almanac low-precision formula, ~0.01°). */
export function sunDir(ms) {
  const n = jd(ms) - 2451545, L = (280.460 + .9856474 * n) * D2R, g = (357.528 + .9856003 * n) * D2R;
  return fromEcliptic(L + (1.915 * sin(g) + .020 * sin(2 * g)) * D2R, 0, obliquity(n));
}
/** Geocentric Moon in Earth radii (Astronomical Almanac low-precision formula, ~0.3°). */
export function moonPos(ms) {
  const n = jd(ms) - 2451545, T = n / 36525, s = (a, b) => sin((a + b * T) * D2R), c = (a, b) => cos((a + b * T) * D2R);
  const lam = 218.32 + 481267.881 * T + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) + .66 * s(235.7, 890534.22) + .21 * s(269.9, 954397.74) - .19 * s(357.5, 35999.05) - .11 * s(186.5, 966404.03);
  const bet = 5.13 * s(93.3, 483202.02) + .28 * s(228.2, 960400.89) - .28 * s(318.3, 6003.15) - .17 * s(217.6, -407332.21);
  const par = .9508 + .0518 * c(135.0, 477198.87) + .0095 * c(259.3, -413335.36) + .0078 * c(235.7, 890534.22) + .0028 * c(269.9, 954397.74);
  return fromEcliptic(lam * D2R, bet * D2R, obliquity(n)).multiplyScalar(1 / sin(par * D2R));
}
/** J2000 → mean equator and equinox of date (IAU 1976 precession). */
export function precession(ms) {
  const T = (jd(ms) - 2451545) / 36525, as = D2R / 3600;
  const z1 = (2306.2181 * T + .30188 * T * T + .017998 * T ** 3) * as, z = (2306.2181 * T + 1.09468 * T * T + .018203 * T ** 3) * as, th = (2004.3109 * T - .42665 * T * T - .041833 * T ** 3) * as;
  const [cz, sz, ct, st, c1, s1] = [cos(z), sin(z), cos(th), sin(th), cos(z1), sin(z1)];
  return new THREE.Matrix3().set(cz * ct * c1 - sz * s1, -cz * ct * s1 - sz * c1, -cz * st, sz * ct * c1 + cz * s1, -sz * ct * s1 + cz * c1, -sz * st, st * c1, -st * s1, ct);
}
/** The station from CelesTrak OMM elements: Kepler plus J2 nodal/apsidal drift plus the decay term. */
export function propagate(el, ms) {
  const t = (ms - Date.parse(el.EPOCH + (/[zZ]|[+-]\d\d:?\d\d$/.test(el.EPOCH) ? '' : 'Z'))) / 86400000, ts = t * 86400;
  const n0 = el.MEAN_MOTION, nd = el.MEAN_MOTION_DOT || 0, e = el.ECCENTRICITY, i = el.INCLINATION * D2R;
  const nr = (n0 + 2 * nd * t) * 2 * Math.PI / 86400, a = Math.cbrt(MU / (nr * nr)), p = a * (1 - e * e), k = 1.5 * J2 * (RE / p) ** 2 * nr;
  const O = el.RA_OF_ASC_NODE * D2R - k * cos(i) * ts, w = el.ARG_OF_PERICENTER * D2R + k * (2 - 2.5 * sin(i) ** 2) * ts;
  const M = (el.MEAN_ANOMALY + 360 * (n0 * t + nd * t * t)) * D2R;
  let E = M; for (let j = 0; j < 6; j++) E -= (E - e * sin(E) - M) / (1 - e * cos(E));
  const xp = a * (cos(E) - e), yp = a * Math.sqrt(1 - e * e) * sin(E);
  const P = new THREE.Vector3(cos(O) * cos(w) - sin(O) * sin(w) * cos(i), sin(O) * cos(w) + cos(O) * sin(w) * cos(i), sin(w) * sin(i));
  const Q = new THREE.Vector3(-cos(O) * sin(w) - sin(O) * cos(w) * cos(i), -sin(O) * sin(w) + cos(O) * cos(w) * cos(i), cos(w) * sin(i));
  const r = P.multiplyScalar(xp).add(Q.multiplyScalar(yp)), R = r.length();
  return { r: r.divideScalar(RE), normal: new THREE.Vector3(sin(O) * sin(i), -cos(O) * sin(i), cos(i)), alt: R - RE, speed: Math.sqrt(MU * (2 / R - 1 / a)), age: t };
}
/** B−V colour index → linear RGB (Ballesteros temperature, then a blackbody fit), pulled toward white. */
function starColour(bv) {
  const T = 4600 * (1 / (.92 * bv + 1.7) + 1 / (.92 * bv + .62)), t = T / 100;
  const r = t <= 66 ? 255 : 329.7 * (t - 60) ** -.1332;
  const g = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -.0755;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  const c = new THREE.Color().setRGB(...[r, g, b].map(v => Math.min(1, Math.max(0, v / 255))), THREE.SRGBColorSpace);
  return c.lerp(new THREE.Color(1, 1, 1), .35);
}

const SKY_VS = `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.); }`;
const SKY_FS = `
  uniform mat3 uToEci, uToJ2000; uniform vec3 uPos, uSun, uMoon; uniform float uMoonR, uGmst, uReady, uGain;
  uniform sampler2D uDay, uNight, uClouds, uMilky;
  varying vec3 vDir;
  const float PI = 3.14159265;
  vec4 eq(sampler2D t, float u, float v) {            // equirectangular lookup without a mip seam where u wraps
    vec2 a = vec2(fract(u), v), b = vec2(fract(u + .5) - .5, v), dx = dFdx(a), dy = dFdy(a), dx2 = dFdx(b), dy2 = dFdy(b);
    if (abs(dx2.x) + abs(dy2.x) < abs(dx.x) + abs(dy.x)) { dx = dx2; dy = dy2; }
    return textureGrad(t, a, dx, dy);
  }
  void main() {
    vec3 d = normalize(uToEci * normalize(vDir));
    vec3 col = vec3(0.);
    float b = dot(uPos, d), c = dot(uPos, uPos) - 1., disc = b * b - c;
    float edge = fwidth(disc) * 1.5 + 1e-7, cover = b < 0. ? smoothstep(-edge, edge, disc) : 0.;

    /* space: the Milky Way, the Sun, the Moon */
    vec3 dj = uToJ2000 * d;
    vec3 space = pow(eq(uMilky, .5 - atan(dj.y, dj.x) / (2. * PI), asin(clamp(dj.z, -1., 1.)) / PI + .5).rgb, vec3(1.1)) * .24;
    float cs = dot(d, uSun);
    space += vec3(1., .96, .9) * (smoothstep(.999984, .999992, cs) * 30. + pow(max(cs, 0.), 3000.) * .5 + pow(max(cs, 0.), 60.) * .05);
    vec3 mv = d - uMoon * dot(d, uMoon); float ms = length(mv) / sin(uMoonR);
    if (dot(d, uMoon) > 0. && ms < 1.2) {
      vec3 n = normalize(mv / sin(uMoonR) - uMoon * sqrt(max(0., 1. - ms * ms)));
      float mare = .82 + .18 * sin(n.x * 9.1 + sin(n.y * 7.3)) * sin(n.z * 6.7 + n.x * 3.);
      float lit = max(dot(n, uSun), 0.), a = 1. - smoothstep(1. - fwidth(ms) * 1.5, 1., ms);
      space = mix(space, vec3(.62, .6, .57) * mare * (lit * .9 + .015), a);
    }

    /* the limb: blue airglow lit by the Sun, a sunset band at the terminator, green airglow on the night side */
    float rmin = sqrt(max(dot(uPos, uPos) - b * b, 0.)), alt = max(rmin - 1., 0.);
    vec3 cp = normalize(uPos - b * d); float sl = dot(cp, uSun);
    float day = smoothstep(-.18, .2, sl), dusk = exp(-sl * sl * 40.);
    vec3 limb = vec3(.25, .52, 1.) * (exp(-alt / .0042) * .55 + exp(-alt / .012) * .12) * day
              + vec3(1., .42, .14) * exp(-alt / .0022) * .5 * dusk
              + vec3(.3, .95, .45) * exp(-pow((alt - .0145) / .0011, 2.)) * .12 * (1. - day);
    if (b < 0.) space += limb;

    /* Earth */
    vec3 earth = vec3(0.);
    if (disc > -edge && b < 0.) {
      vec3 q = normalize(uPos + (-b - sqrt(max(disc, 0.))) * d);
      float u = (atan(q.y, q.x) - uGmst) / (2. * PI) + .5, v = asin(clamp(q.z, -1., 1.)) / PI + .5;
      vec3 land = eq(uDay, u, v).rgb; float cl = eq(uClouds, u, v).r, city = eq(uNight, u, v).r;
      float mu = dot(q, uSun), vm = max(dot(q, -d), 0.);
      float lit = clamp(mu * 1.15 + .04, 0., 1.);
      vec3 warm = mix(vec3(1., .6, .38), vec3(1.), smoothstep(0., .35, mu));
      vec3 surf = mix(land, vec3(.95), cl * .85) * lit * warm;
      float water = smoothstep(.02, .08, land.b - land.r) * (1. - cl);
      surf += vec3(1., .92, .8) * pow(max(dot(reflect(d, q), uSun), 0.), 90.) * water * lit * .9;
      surf += vec3(1., .72, .42) * pow(city, 1.8) * 1.6 * (1. - smoothstep(-.12, .04, mu)) * (1. - cl * .85);
      float haze = exp(-vm * 16.) * .62 + .03;
      vec3 air = vec3(.3, .55, 1.) * smoothstep(-.15, .3, mu) * .55 + vec3(1., .45, .18) * exp(-mu * mu * 40.) * .25 * exp(-vm * 6.);
      earth = mix(pow(surf, vec3(1.12)) * .8, air, haze);
    }
    col = mix(space, earth, cover);
    gl_FragColor = vec4(col * uGain * uReady, 1.);
  }`;
const STAR_VS = `
  attribute float aMag; attribute vec3 aCol; uniform mat3 uToScene; uniform vec3 uPos; uniform float uScale, uGain, uSunUp;
  varying vec3 vCol;
  void main() {
    float b = dot(uPos, position), c = dot(uPos, uPos) - 1.0205;         // hidden behind Earth and its atmosphere
    float seen = (b < 0. && b * b > c) ? 0. : 1.;
    gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * (uToScene * position) * 100., 1.);
    float t = clamp((7.2 - aMag) / 8.7, 0., 1.);
    gl_PointSize = (1.5 + 6.5 * t * t) * uScale * seen;
    vCol = aCol * (.12 + .88 * pow(t, 1.6)) * uGain * (1. - .35 * uSunUp);
  }`;
const STAR_FS = `varying vec3 vCol; void main(){ vec2 p = gl_PointCoord * 2. - 1.; float r = dot(p, p); if (r > 1.) discard; gl_FragColor = vec4(vCol * exp(-r * 4.5), 1.); }`;

/** Adds the sky to `scene`; call update() once per frame. `opts.orbit` is a URL for live elements (CelesTrak
 * OMM JSON) or null for the bundled ones only. */
export function buildSky(scene, camera, renderer, opts = {}) {
  const base = opts.base || 'data/sky/';
  const U = {
    uToEci: { value: new THREE.Matrix3() }, uToJ2000: { value: new THREE.Matrix3() }, uToScene: { value: new THREE.Matrix3() },
    uPos: { value: new THREE.Vector3(0, 0, 1.066) }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uMoon: { value: new THREE.Vector3(0, 1, 0) },
    uMoonR: { value: .0045 }, uGmst: { value: 0 }, uReady: { value: 0 }, uGain: { value: opts.gain ?? 1 }, uSunUp: { value: 0 },
    uScale: { value: renderer.getPixelRatio() }, uDay: { value: null }, uNight: { value: null }, uClouds: { value: null }, uMilky: { value: null },
  };
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({ uniforms: U, vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
  sphere.renderOrder = -1000; sphere.frustumCulled = false; scene.add(sphere);
  const starMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: STAR_VS, fragmentShader: STAR_FS, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
  let stars = null;

  const aniso = renderer.capabilities.getMaxAnisotropy();
  const loader = new THREE.TextureLoader();
  const tex = (f, key, srgb = true) => new Promise(res => loader.load(base + f, t => { t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = aniso; U[key].value = t; res(); }, undefined, () => res()));
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); black.needsUpdate = true;
  ['uDay', 'uNight', 'uClouds', 'uMilky'].forEach(k => { U[k].value = black; });

  const t0 = Date.now(), clock = () => (opts.at ?? t0) + (Date.now() - t0) * (opts.warp || 1), now = () => clock() + sky.offset;
  const P = precession(clock()); U.uToJ2000.value.copy(P).transpose();
  const loadStars = fetch(base + 'stars.bin').then(r => r.ok ? r.arrayBuffer() : Promise.reject(r.status)).then(buf => {
    const v = new Int16Array(buf), N = v.length / 4, pos = new Float32Array(N * 3), mag = new Float32Array(N), col = new Float32Array(N * 3), p = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const ra = v[i * 4] / 90 * D2R, de = v[i * 4 + 1] / 300 * D2R;
      p.set(cos(de) * cos(ra), cos(de) * sin(ra), sin(de)).applyMatrix3(P).toArray(pos, i * 3);
      mag[i] = v[i * 4 + 2] / 1000; starColour(v[i * 4 + 3] / 1000).toArray(col, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1)); g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    stars = new THREE.Points(g, starMat); stars.renderOrder = -999; stars.frustumCulled = false; scene.add(stars);
  }).catch(() => { });

  /* Orbital elements: a fresh copy from opts.orbit (cached 6 h, CelesTrak asks for no more than one fetch per 2 h), else the bundled set. */
  const CK = 'anatomy-sky-elements';
  async function elements() {
    try { const c = JSON.parse(localStorage.getItem(CK) || 'null'); if (c && Date.now() - c.at < 6 * 3600e3) return { el: c.el, live: true }; } catch { }
    if (opts.orbit) try {
      const r = await fetch(opts.orbit, { cache: 'no-cache' }); const j = await r.json(); const el = Array.isArray(j) ? j[0] : j;
      if (el?.MEAN_MOTION) { try { localStorage.setItem(CK, JSON.stringify({ at: Date.now(), el })); } catch { } return { el, live: true }; }
    } catch { }
    return { el: await (await fetch(base + 'iss.json')).json(), live: false };
  }
  let EL = null, live = false;
  const ready = Promise.all([elements().then(x => { EL = x.el; live = x.live; }).catch(() => { }), loadStars,
    tex('milkyway.jpg', 'uMilky'), tex('earth-day.jpg', 'uDay'), tex('earth-night.jpg', 'uNight', false), tex('earth-clouds.jpg', 'uClouds', false)]);
  ready.then(() => { sky.ready = true; });

  /* The station's frame: scene +x = direction of travel, +y = away from Earth, +z = −(orbit normal).
   * opts.pitch tilts the mount so more of Earth sits in the default view. */
  const fwd = new THREE.Vector3(), up = new THREE.Vector3(), side = new THREE.Vector3(), toScene = new THREE.Matrix4(), tilt = new THREE.Matrix4().makeRotationX(-(opts.pitch ?? 0) * D2R);
  const m4 = new THREE.Matrix4(), st = {};
  const sky = {
    ready: false, whenReady: ready,
    update() {
      const t = now();
      sphere.position.copy(camera.position);
      if (sky.ready && U.uReady.value < 1) U.uReady.value = Math.min(1, U.uReady.value + .02);
      if (!EL) return;
      const o = propagate(EL, t);
      up.copy(o.r).normalize(); side.copy(o.normal).negate(); fwd.crossVectors(up, side);
      toScene.makeBasis(fwd, up, side).transpose().premultiply(tilt);                 // rows: the scene axes in ECI
      U.uToScene.value.setFromMatrix4(toScene); U.uToEci.value.setFromMatrix4(m4.copy(toScene).transpose());
      U.uPos.value.copy(o.r);
      const sun = sunDir(t); U.uSun.value.copy(sun);
      const moon = moonPos(t).sub(o.r), md = moon.length(); U.uMoon.value.copy(moon).divideScalar(md); U.uMoonR.value = Math.asin(.2727 / md);
      const g = gmst(t); U.uGmst.value = g; U.uScale.value = renderer.getPixelRatio();
      // the Sun is up for the station unless Earth is in the way
      const b = o.r.dot(sun), c = o.r.lengthSq() - 1; U.uSunUp.value = !(b < 0 && b * b > c) ? 1 : 0;
      const ex = o.r.x * cos(g) + o.r.y * sin(g), ey = -o.r.x * sin(g) + o.r.y * cos(g), lat = Math.atan2(o.r.z, Math.hypot(ex, ey));
      Object.assign(st, { lat: Math.atan(Math.tan(lat) / .99331) / D2R, lon: Math.atan2(ey, ex) / D2R, alt: o.alt, speed: o.speed, sunlit: !!U.uSunUp.value, age: o.age, live, epoch: EL.EPOCH, name: EL.OBJECT_NAME });
    },
    info: () => st,
    offset: 0,                 // ms ahead of the clock: the time slider
    clock,
    /** The ground track from the clock onward: one sample per `step` ms for `span` ms, with whether the ground below is lit. */
    track(span = 864e5, step = 6e4) {
      if (!EL) return [];
      const out = [], t1 = clock();
      for (let t = t1; t <= t1 + span; t += step) {
        const o = propagate(EL, t), g = gmst(t), up = o.r.clone().normalize(), sun = sunDir(t);
        const ex = o.r.x * cos(g) + o.r.y * sin(g), ey = -o.r.x * sin(g) + o.r.y * cos(g), lat = Math.atan2(o.r.z, Math.hypot(ex, ey));
        out.push({ t, lat: Math.atan(Math.tan(lat) / .99331) / D2R, lon: Math.atan2(ey, ex) / D2R, sunEl: Math.asin(up.dot(sun)) / D2R });
      }
      return out;
    },
    dispose() { scene.remove(sphere); if (stars) scene.remove(stars); },
  };
  return sky;
}

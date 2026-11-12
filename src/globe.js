/**
 * 3D visualisation: Globe.gl (Three.js / WebGL) Earth with
 *  - day/night shading from the computed sub-solar point,
 *  - ocean specular glint, atmosphere rim and an (illustrative) cloud layer,
 *  - one GPU point cloud for all displayed satellites (updated in place),
 *  - selected-satellite highlight, nadir line, orbit path and ground track,
 *  - the WhereTheISS.at API position marker,
 *  - screen-space picking and an HTML label overlay with occlusion tests.
 */
import Globe from 'globe.gl';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { CATEGORIES, RENDER } from './config.js';
import { renderAltitude, toCartesian, subsolarPoint } from './orbital-math.js';
import { assetUrl } from '@platform';

const R = RENDER.globeRadius;
const CLOUD_ALT = 0.005;
const GROUND_ALT = 0.007;

const asset = (p) => assetUrl(p);

/* ------------------------------------------------------------------ shaders */

const EARTH_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const EARTH_FRAG = /* glsl */ `
  uniform sampler2D dayTex;
  uniform sampler2D nightTex;
  uniform sampler2D waterTex;
  uniform vec3 sunDir;
  uniform float shading;   // 1 = day/night terminator, 0 = uniformly lit
  varying vec3 vN;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(vN);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float d = dot(n, sunDir);
    float dayMix = mix(1.0, smoothstep(-0.12, 0.10, d), shading);
    vec3 day = texture2D(dayTex, vUv).rgb;
    vec3 night = texture2D(nightTex, vUv).rgb;
    float water = texture2D(waterTex, vUv).r;

    float lambert = mix(1.0, clamp(d * 0.75 + 0.45, 0.0, 1.0), shading);
    vec3 dayCol = day * (0.35 + 0.8 * lambert);
    vec3 nightCol = day * 0.018 + night * vec3(1.25, 1.05, 0.8) * 1.1;
    vec3 col = mix(nightCol, dayCol, dayMix);

    // sun glint on oceans
    vec3 h = normalize(sunDir + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 60.0) * water * 0.55 * dayMix * shading;
    col += vec3(1.0, 0.95, 0.85) * spec;

    // atmospheric rim (Fresnel)
    float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    col += vec3(0.30, 0.62, 1.0) * fres * mix(0.06, 0.6, dayMix);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

const CLOUD_FRAG = /* glsl */ `
  uniform sampler2D cloudTex;
  uniform vec3 sunDir;
  uniform float shading;
  uniform float opacity;
  varying vec3 vN;
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    float a = texture2D(cloudTex, vUv).r;
    float d = dot(normalize(vN), sunDir);
    float lit = mix(1.0, smoothstep(-0.15, 0.25, d), shading);
    gl_FragColor = vec4(vec3(0.95, 0.97, 1.0) * (0.08 + 0.92 * lit), a * opacity * (0.25 + 0.75 * lit));
    #include <colorspace_fragment>
  }
`;

const POINT_VERT = /* glsl */ `
  attribute vec3 color;
  attribute float size;
  uniform float pixelRatio;
  uniform float scale;
  varying vec3 vColor;
  varying float vSize;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float att = clamp(320.0 / -mv.z, 0.8, 2.0);
    vSize = size;
    gl_PointSize = size * scale * pixelRatio * att;
    gl_Position = projectionMatrix * mv;
  }
`;

const POINT_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vSize;
  void main() {
    if (vSize <= 0.0) discard;
    vec2 c = gl_PointCoord - 0.5;
    float r = length(c);
    if (r > 0.5) discard;
    float core = smoothstep(0.20, 0.0, r);
    float glow = smoothstep(0.5, 0.05, r) * 0.6;
    vec3 col = vColor * (core * 1.25 + glow) + vec3(1.0) * core * 0.45;
    gl_FragColor = vec4(col, (core + glow));
    #include <colorspace_fragment>
  }
`;

/* -------------------------------------------------------------- utilities */

function ringTexture(color = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.lineWidth = 7;
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.stroke();
  // corner ticks (targeting reticle)
  g.lineWidth = 5;
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    g.beginPath();
    g.moveTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54);
    g.lineTo(64 + Math.cos(a) * 64, 64 + Math.sin(a) * 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function diamondTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(32, 6);
  g.lineTo(58, 32);
  g.lineTo(32, 58);
  g.lineTo(6, 32);
  g.closePath();
  g.stroke();
  g.fillStyle = color;
  g.beginPath();
  g.arc(32, 32, 5, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const hexToRgb = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

/** True if the segment camera→p is blocked by the globe sphere. */
function occluded(p, cam) {
  const dx = p.x - cam.x;
  const dy = p.y - cam.y;
  const dz = p.z - cam.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz);
  const c = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z - R * R * 0.998;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return false;
  const t1 = (-b - Math.sqrt(disc)) / (2 * a);
  return t1 > 0 && t1 < 0.999;
}

/* ================================================================ GlobeView */

export class GlobeView {
  constructor(container, overlay, { onPick, onHover, onUserInteract } = {}) {
    this.container = container;
    this.overlay = overlay; // label layer (absolute div above the canvas)
    this.onPick = onPick;
    this.onHover = onHover;
    this.onUserInteract = onUserInteract;
    this.altMode = 'compressed';
    this.options = {
      markers: true,
      labels: true,
      orbit: true,
      ground: true,
      rotate: true,
      clouds: true,
      shading: true,
      issMarker: true,
      geoRing: true,
    };
    this.catalog = null; // set by setCatalog
    this.indices = new Int32Array(0); // satellite idx per point slot
    this.data = null; // Float32Array [lat,lng,alt,speed] per slot
    this.slotOf = new Map(); // satellite idx → slot
    this.selectedIdx = null;
    this.hoverIdx = null;
    this.following = false;
    this.trajectory = null;
    this.issApi = null;
    this.lastInteraction = 0;
    this.disposers = [];
    this._v = new THREE.Vector3();
    this._p = {};
  }

  /** Create the globe. Resolves once textures are loaded. */
  async init() {
    const loader = new THREE.TextureLoader();
    const load = (p) =>
      loader.loadAsync(asset(p)).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        return t;
      });
    const [day, night, water, clouds] = await Promise.all([
      load('textures/earth-blue-marble.jpg'),
      load('textures/earth-night.jpg'),
      load('textures/earth-water.jpg'),
      load('textures/clouds-alpha.jpg'),
    ]);
    water.colorSpace = THREE.NoColorSpace;
    clouds.colorSpace = THREE.NoColorSpace;

    this.sunDir = new THREE.Vector3(1, 0, 0);
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        dayTex: { value: day },
        nightTex: { value: night },
        waterTex: { value: water },
        sunDir: { value: this.sunDir },
        shading: { value: 1 },
      },
      vertexShader: EARTH_VERT,
      fragmentShader: EARTH_FRAG,
    });

    const rect = this.container.getBoundingClientRect();
    this.globe = new Globe(this.container, {
      animateIn: false,
      rendererConfig: { antialias: true, alpha: false, powerPreference: 'high-performance' },
    })
      .width(Math.max(1, rect.width))
      .height(Math.max(1, rect.height))
      .backgroundColor('#01030a')
      .backgroundImageUrl(asset('textures/night-sky.jpg'))
      .globeMaterial(this.earthMat)
      .showAtmosphere(true)
      .atmosphereColor('#5aa9ff')
      .atmosphereAltitude(0.17)
      .showGraticules(false)
      .enablePointerInteraction(false);

    this.scene = this.globe.scene();
    this.camera = this.globe.camera();
    this.renderer = this.globe.renderer();
    this.controls = this.globe.controls();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxDistance = R * 18;

    // clouds (illustrative static texture — not live weather)
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: { cloudTex: { value: clouds }, sunDir: { value: this.sunDir }, shading: { value: 1 }, opacity: { value: 0.85 } },
      vertexShader: EARTH_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.SphereGeometry(R * (1 + CLOUD_ALT), 96, 64), this.cloudMat);
    this.clouds.rotation.y = -Math.PI / 2; // align texture with three-globe's globe mesh
    this.clouds.renderOrder = 1;
    this.scene.add(this.clouds);

    this._initPoints();
    this._initOverlays();
    this._initInteraction();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.container);
    this.resize();
    return this;
  }

  /* -------------------------------------------------------- satellites */

  _initPoints() {
    const max = RENDER.maxLimit;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setAttribute('size', this.sizeAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R * 20);
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: this.renderer.getPixelRatio() }, scale: { value: 1 } },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.pointMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.scene.add(this.points);
  }

  setCatalog(catalog) {
    this.catalog = catalog;
  }

  /** Set which satellites are displayed (array of catalog sats). */
  setActive(sats) {
    const n = Math.min(sats.length, RENDER.maxLimit);
    this.indices = new Int32Array(n);
    this.slotOf.clear();
    const col = this.colAttr.array;
    const rgbCache = {};
    for (let k = 0; k < n; k++) {
      const s = sats[k];
      this.indices[k] = s.idx;
      this.slotOf.set(s.idx, k);
      const rgb = (rgbCache[s.category] ??= hexToRgb(CATEGORIES[s.category].color));
      col[k * 3] = rgb[0];
      col[k * 3 + 1] = rgb[1];
      col[k * 3 + 2] = rgb[2];
    }
    this.colAttr.needsUpdate = true;
    this.colAttr.clearUpdateRanges?.();
    this.data = null;
    this.points.geometry.setDrawRange(0, n);
    this.sizeAttr.array.fill(0, 0, n);
    this.sizeAttr.needsUpdate = true;
    return this.indices;
  }

  /** Apply a positions message from the worker. */
  applyPositions(msg) {
    // Only accept data computed for the current active set
    if (msg.version !== this.activeVersion || msg.count !== this.indices.length) return false;
    this.data = msg.data;
    this.dataTime = msg.t;
    this._writePositions();
    return true;
  }

  _writePositions() {
    if (!this.data) return;
    const pos = this.posAttr.array;
    const size = this.sizeAttr.array;
    const d = this.data;
    const mode = this.altMode;
    const p = this._p;
    const show = this.options.markers;
    const n = this.indices.length;
    let base = n > 6000 ? 2.6 : n > 2500 ? 3.2 : 3.8;
    if (mode === 'true') base *= 0.9;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      const lat = d[o];
      if (Number.isNaN(lat) || !show) {
        size[k] = 0;
        continue;
      }
      toCartesian(lat, d[o + 1], renderAltitude(d[o + 2], mode), R, p);
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = p.y;
      pos[k * 3 + 2] = p.z;
      const idx = this.indices[k];
      size[k] = idx === this.selectedIdx ? base * 2.4 : idx === this.hoverIdx ? base * 1.9 : base;
    }
    this.posAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  /** Latest calculated state for a satellite idx (if displayed). */
  stateOf(idx) {
    const k = this.slotOf.get(idx);
    if (k === undefined || !this.data) return null;
    const o = k * 4;
    const lat = this.data[o];
    if (Number.isNaN(lat)) return null;
    return { lat, lng: this.data[o + 1], alt: this.data[o + 2], speed: this.data[o + 3] };
  }

  validCount() {
    if (!this.data) return 0;
    let c = 0;
    for (let k = 0; k < this.indices.length; k++) if (!Number.isNaN(this.data[k * 4])) c++;
    return c;
  }

  /* ---------------------------------------------------------- overlays */

  _makeLine({ color, width, opacity, dashed = false, vertexColors = false }) {
    const mat = new LineMaterial({
      color: vertexColors ? 0xffffff : color,
      linewidth: width,
      transparent: true,
      opacity,
      dashed,
      dashSize: 1.6,
      gapSize: 1.4,
      vertexColors,
      depthWrite: false,
      worldUnits: false,
    });
    const line = new Line2(new LineGeometry(), mat);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 2;
    this.scene.add(line);
    return line;
  }

  _initOverlays() {
    this.orbitFuture = this._makeLine({ width: 2.2, opacity: 0.95, vertexColors: true });
    this.orbitPast = this._makeLine({ color: 0x7fd6ff, width: 1.6, opacity: 0.55, dashed: true });
    this.groundFuture = this._makeLine({ width: 2.0, opacity: 0.95, vertexColors: true });
    this.groundPast = this._makeLine({ color: 0xffd27a, width: 1.4, opacity: 0.5, dashed: true });
    this.nadir = this._makeLine({ color: 0xffffff, width: 1, opacity: 0.45, dashed: true });
    this.geoRing = this._makeLine({ color: 0xd95926, width: 1, opacity: 0.35, dashed: true });
    this.lines = [this.orbitFuture, this.orbitPast, this.groundFuture, this.groundPast, this.nadir, this.geoRing];

    this.selSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ringTexture('#7df9ff'), depthWrite: false, sizeAttenuation: false, transparent: true }),
    );
    this.selSprite.scale.set(0.05, 0.05, 1);
    this.selSprite.visible = false;
    this.selSprite.renderOrder = 4;
    this.scene.add(this.selSprite);

    this.issSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: diamondTexture('#ffc14d'), depthWrite: false, sizeAttenuation: false, transparent: true }),
    );
    this.issSprite.scale.set(0.034, 0.034, 1);
    this.issSprite.visible = false;
    this.issSprite.renderOrder = 4;
    this.scene.add(this.issSprite);

    this.labelPool = [];
    this.labelSet = [];
    this.labelRefreshAt = 0;
    this._updateGeoRing();
  }

  _setLine(line, pts, colorFn) {
    if (!pts || pts.length < 2) {
      line.visible = false;
      return;
    }
    const pos = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      pos[i * 3] = pts[i].x;
      pos[i * 3 + 1] = pts[i].y;
      pos[i * 3 + 2] = pts[i].z;
    }
    const g = new LineGeometry();
    g.setPositions(pos);
    if (colorFn) {
      const col = new Float32Array(pts.length * 3);
      for (let i = 0; i < pts.length; i++) {
        const c = colorFn(i / (pts.length - 1));
        col[i * 3] = c[0];
        col[i * 3 + 1] = c[1];
        col[i * 3 + 2] = c[2];
      }
      g.setColors(col);
    }
    line.geometry.dispose();
    line.geometry = g;
    if (line.material.dashed) line.computeLineDistances();
    line.visible = true;
  }

  _updateGeoRing() {
    const alt = renderAltitude(35_786, this.altMode);
    const pts = [];
    for (let i = 0; i <= 180; i++) pts.push(toCartesian(0, -180 + i * 2, alt, R, {}));
    this._setLine(this.geoRing, pts);
    this.geoRing.visible = this.options.geoRing && this.altMode !== 'ground';
  }

  /** Set/clear the selected satellite's trajectory (from orbital-math.computeTrajectory). */
  setTrajectory(traj) {
    this.trajectory = traj;
    this._drawTrajectory();
  }

  _drawTrajectory() {
    const t = this.trajectory;
    const mode = this.altMode;
    if (!t) {
      for (const l of [this.orbitFuture, this.orbitPast, this.groundFuture, this.groundPast]) l.visible = false;
      return;
    }
    const map = (arr, altFn) => arr.map((q) => toCartesian(q.lat, q.lng, altFn(q), R, {}));
    const orbitAlt = (q) => renderAltitude(q.alt, mode);
    const groundAlt = () => GROUND_ALT;

    const showOrbit = this.options.orbit && mode !== 'ground';
    if (showOrbit) {
      const past = t.orbit.filter((q) => q.dt <= 0);
      const fut = t.orbit.filter((q) => q.dt >= 0);
      this._setLine(this.orbitPast, map(past, orbitAlt));
      // bright cyan near the satellite, fading towards the end of the revolution
      this._setLine(this.orbitFuture, map(fut, orbitAlt), (f) => [0.49 * (1 - f * 0.75), 0.97 * (1 - f * 0.7), 1.0 * (1 - f * 0.6)]);
    } else {
      this.orbitPast.visible = this.orbitFuture.visible = false;
    }
    if (this.options.ground) {
      const past = t.ground.filter((q) => q.dt <= 0);
      const fut = t.ground.filter((q) => q.dt >= 0);
      this._setLine(this.groundPast, map(past, groundAlt));
      this._setLine(this.groundFuture, map(fut, groundAlt), (f) => [1.0 * (1 - f * 0.6), 0.76 * (1 - f * 0.65), 0.3 * (1 - f * 0.7)]);
    } else {
      this.groundPast.visible = this.groundFuture.visible = false;
    }
  }

  setSelected(idx) {
    this.selectedIdx = idx;
    if (idx == null) {
      this.following = false;
      this.selSprite.visible = false;
      this.nadir.visible = false;
      this.setTrajectory(null);
    }
    this._writePositions();
    this.labelRefreshAt = 0;
  }

  setHover(idx) {
    if (idx === this.hoverIdx) return;
    this.hoverIdx = idx;
    this._writePositions();
  }

  setIssApi(pos) {
    this.issApi = pos; // {lat,lng,altKm} or null
  }

  setAltitudeMode(mode) {
    this.altMode = mode;
    this._writePositions();
    this._updateGeoRing();
    this._drawTrajectory();
  }

  setOption(key, value) {
    this.options[key] = value;
    if (key === 'markers') this._writePositions();
    if (key === 'clouds') this.clouds.visible = value;
    if (key === 'shading') {
      this.earthMat.uniforms.shading.value = value ? 1 : 0;
      this.cloudMat.uniforms.shading.value = value ? 1 : 0;
    }
    if (key === 'orbit' || key === 'ground') this._drawTrajectory();
    if (key === 'geoRing') this._updateGeoRing();
    if (key === 'labels' && !value) this._hideLabels(0);
    if (key === 'rotate') this.lastInteraction = 0;
  }

  /* --------------------------------------------------------- per-frame */

  /** Called every animation frame. `simMs` drives the sun position. */
  frame(simMs, now = performance.now()) {
    // Sun direction from the computed sub-solar point at simulation time
    const sun = subsolarPoint(simMs);
    const s = toCartesian(sun.lat, sun.lng, 0, 1, this._p);
    this.sunDir.set(s.x, s.y, s.z).normalize();
    this.subsolar = sun;
    if (this.options.clouds) this.clouds.rotation.y += 0.00003;

    // Selection highlight + nadir line + follow camera
    const sel = this.selectedIdx != null ? this.stateOf(this.selectedIdx) : null;
    if (sel) {
      const p = toCartesian(sel.lat, sel.lng, renderAltitude(sel.alt, this.altMode), R, {});
      this.selSprite.position.set(p.x, p.y, p.z);
      const pulse = 1 + 0.12 * Math.sin(now / 260);
      this.selSprite.scale.set(0.05 * pulse, 0.05 * pulse, 1);
      this.selSprite.visible = true;
      if (this.altMode !== 'ground') {
        const g = toCartesian(sel.lat, sel.lng, GROUND_ALT, R, {});
        if (!this._nadirKey || this._nadirKey !== `${p.x.toFixed(2)},${p.y.toFixed(2)}`) {
          this._setLine(this.nadir, [p, g]);
          this._nadirKey = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
        }
      } else this.nadir.visible = false;
      if (this.following) {
        const pov = this.globe.pointOfView();
        this.globe.pointOfView({ lat: sel.lat, lng: sel.lng, altitude: pov.altitude }, 0);
      }
    } else {
      this.selSprite.visible = false;
      this.nadir.visible = false;
    }

    // ISS API marker
    if (this.issApi && this.options.issMarker) {
      const p = toCartesian(this.issApi.lat, this.issApi.lng, renderAltitude(this.issApi.altKm, this.altMode), R, {});
      this.issSprite.position.set(p.x, p.y, p.z);
      this.issSprite.visible = true;
    } else this.issSprite.visible = false;

    // Auto-rotation: pause while/after the user interacts, and while following
    const idle = now - this.lastInteraction > 9000;
    this.controls.autoRotate = this.options.rotate && idle && !this.following;

    this._updateLabels(now);
  }

  /* ----------------------------------------------------------- labels */

  _hideLabels(from) {
    for (let i = from; i < this.labelPool.length; i++) this.labelPool[i].style.display = 'none';
  }

  _labelEl(i) {
    while (this.labelPool.length <= i) {
      const el = document.createElement('div');
      el.className = 'sat-label';
      el.style.display = 'none';
      this.overlay.appendChild(el);
      this.labelPool.push(el);
    }
    return this.labelPool[i];
  }

  _screenPos(lat, lng, altKm, out) {
    const p = toCartesian(lat, lng, renderAltitude(altKm, this.altMode), R, {});
    const cam = this.camera.position;
    if (occluded(p, cam)) return null;
    this._v.set(p.x, p.y, p.z).project(this.camera);
    if (this._v.z > 1 || Math.abs(this._v.x) > 1.05 || Math.abs(this._v.y) > 1.05) return null;
    out.x = (this._v.x * 0.5 + 0.5) * this.width;
    out.y = (-this._v.y * 0.5 + 0.5) * this.height;
    return out;
  }

  _updateLabels(now) {
    const sats = this.catalog?.sats;
    if (!sats || !this.data) return;
    const wantLabels = this.options.labels && this.options.markers;
    // Re-choose labelled satellites a few times per second
    if (now > this.labelRefreshAt) {
      this.labelRefreshAt = now + 350;
      const set = [];
      if (this.selectedIdx != null) set.push(this.selectedIdx);
      if (this.hoverIdx != null && this.hoverIdx !== this.selectedIdx) set.push(this.hoverIdx);
      if (wantLabels) {
        const cands = [];
        const cx = this.width / 2;
        const cy = this.height / 2;
        const sp = {};
        for (let k = 0; k < this.indices.length; k++) {
          const o = k * 4;
          if (Number.isNaN(this.data[o])) continue;
          const idx = this.indices[k];
          if (idx === this.selectedIdx || idx === this.hoverIdx) continue;
          // sample large sets for speed; stations always considered
          const station = sats[idx].category === 'station';
          if (!station && this.indices.length > 3000 && k % 3) continue;
          if (!this._screenPos(this.data[o], this.data[o + 1], this.data[o + 2], sp)) continue;
          const d = Math.hypot(sp.x - cx, sp.y - cy) - (station ? 1e6 : 0);
          cands.push([d, idx, sp.x, sp.y]);
        }
        cands.sort((a, b) => a[0] - b[0]);
        // fewer labels on small screens
        const maxLabels = Math.max(6, Math.min(RENDER.labelCount, Math.round((this.width * this.height) / 52_000)));
        const placed = [];
        for (const [, idx, x, y] of cands) {
          if (set.length >= maxLabels) break;
          if (placed.some((q) => Math.abs(q[0] - x) < 110 && Math.abs(q[1] - y) < 18)) continue; // avoid overlaps
          placed.push([x, y]);
          set.push(idx);
        }
      }
      this.labelSet = set;
    }
    let used = 0;
    const sp = {};
    for (const idx of this.labelSet) {
      const st = this.stateOf(idx);
      if (!st) continue;
      if (!this._screenPos(st.lat, st.lng, st.alt, sp)) continue;
      const el = this._labelEl(used++);
      const s = sats[idx];
      if (el.dataset.idx !== String(idx)) {
        el.dataset.idx = String(idx);
        el.textContent = s.name;
        el.style.setProperty('--c', CATEGORIES[s.category].color);
      }
      el.classList.toggle('is-selected', idx === this.selectedIdx);
      el.classList.toggle('is-hover', idx === this.hoverIdx);
      el.style.display = 'block';
      el.style.transform = `translate(${sp.x + 9}px, ${sp.y - 9}px)`;
    }
    this._hideLabels(used);
  }

  /* ------------------------------------------------------ interaction */

  _initInteraction() {
    const el = this.renderer.domElement;
    let down = null;
    const onDown = (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 600;
      down = null;
      if (moved < 6 && quick) {
        const idx = this.pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 24 : 12);
        this.onPick?.(idx);
      }
    };
    let hoverQueued = false;
    let lastMove = null;
    const onMove = (e) => {
      if (e.pointerType === 'touch') return;
      lastMove = e;
      if (hoverQueued) return;
      hoverQueued = true;
      requestAnimationFrame(() => {
        hoverQueued = false;
        if (down) return;
        const idx = this.pick(lastMove.clientX, lastMove.clientY, 10);
        this.setHover(idx);
        this.onHover?.(idx, lastMove.clientX, lastMove.clientY);
        el.style.cursor = idx != null ? 'pointer' : 'grab';
      });
    };
    const onLeave = () => {
      this.setHover(null);
      this.onHover?.(null);
    };
    const onStart = () => {
      this.lastInteraction = performance.now();
      this.onUserInteract?.();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    this.controls.addEventListener('start', onStart);
    this.disposers.push(() => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      this.controls.removeEventListener('start', onStart);
    });
  }

  /** Screen-space pick of the nearest visible satellite. */
  pick(clientX, clientY, radiusPx) {
    if (!this.data || !this.options.markers) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const cam = this.camera.position;
    const pos = this.posAttr.array;
    const v = this._v;
    let best = null;
    let bestD = radiusPx;
    for (let k = 0; k < this.indices.length; k++) {
      if (this.sizeAttr.array[k] <= 0) continue;
      const px = pos[k * 3];
      const py = pos[k * 3 + 1];
      const pz = pos[k * 3 + 2];
      v.set(px, py, pz).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width;
      const sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestD && !occluded({ x: px, y: py, z: pz }, cam)) {
        bestD = d;
        best = this.indices[k];
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ camera */

  flyTo(lat, lng, altKm, ms = 1400) {
    const a = renderAltitude(altKm, this.altMode);
    const pov = this.globe.pointOfView();
    const target = Math.max(a + 1.1, Math.min(pov.altitude, a + 2.2));
    this.globe.pointOfView({ lat, lng, altitude: target }, ms);
    this.lastInteraction = performance.now();
  }

  resetCamera(ms = 1400) {
    const lng = this.subsolar ? this.subsolar.lng - 35 : 0;
    this.globe.pointOfView({ lat: 22, lng, altitude: 2.7 }, ms);
    this.following = false;
  }

  zoom(factor) {
    const pov = this.globe.pointOfView();
    this.globe.pointOfView({ ...pov, altitude: Math.min(16, Math.max(0.15, pov.altitude * factor)) }, 400);
    this.lastInteraction = performance.now();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.globe.width(this.width).height(this.height);
    for (const l of this.lines) l.material.resolution.set(this.width, this.height);
    this.pointMat.uniforms.pixelRatio.value = this.renderer.getPixelRatio();
  }

  dispose() {
    for (const d of this.disposers) d();
    this.ro?.disconnect();
    this.globe?._destructor?.();
  }
}

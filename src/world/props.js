import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from './noise.js';

/**
 * Low-poly Nepal-inspired prop geometries.
 * Each type is a single merged, vertex-colored geometry so every prop type
 * renders as ONE InstancedMesh draw call. No textures, no transparency.
 */

function colorize(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  geo.deleteAttribute('uv');
  return geo;
}

function merge(parts) {
  // Primitive geometries are a mix of indexed and non-indexed (Icosahedron
  // is non-indexed) — normalize before merging.
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(flat);
  parts.forEach((p) => p.dispose());
  flat.forEach((p) => p.dispose());
  return g;
}

function pine() {
  const trunk = colorize(new THREE.CylinderGeometry(0.12, 0.2, 1.6, 5), 0.36, 0.25, 0.15).translate(0, 0.8, 0);
  const c1 = colorize(new THREE.ConeGeometry(1.35, 2.6, 6), 0.15, 0.32, 0.18).translate(0, 2.4, 0);
  const c2 = colorize(new THREE.ConeGeometry(0.95, 2.0, 6), 0.18, 0.36, 0.20).translate(0, 3.7, 0);
  return merge([trunk, c1, c2]);
}

function broadleaf() {
  const trunk = colorize(new THREE.CylinderGeometry(0.15, 0.22, 1.6, 5), 0.40, 0.28, 0.17).translate(0, 0.8, 0);
  const blob = colorize(new THREE.IcosahedronGeometry(1.4, 0), 0.24, 0.42, 0.16)
    .scale(1, 0.85, 1).translate(0, 2.5, 0);
  return merge([trunk, blob]);
}

function bush() {
  return colorize(new THREE.IcosahedronGeometry(0.7, 0), 0.22, 0.38, 0.17)
    .scale(1, 0.7, 1).translate(0, 0.34, 0);
}

function rock() {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const rng = mulberry32(1234);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (0.85 + rng() * 0.35),
      p.getY(i) * (0.7 + rng() * 0.3),
      p.getZ(i) * (0.85 + rng() * 0.35));
  }
  g.computeVertexNormals();
  return colorize(g, 0.48, 0.46, 0.43).translate(0, 0.42, 0);
}

function log() {
  return colorize(new THREE.CylinderGeometry(0.22, 0.27, 2.6, 6), 0.34, 0.24, 0.15)
    .rotateZ(Math.PI / 2).translate(0, 0.24, 0);
}

function grass() {
  // Three crossed diamond blades — no textures, no transparency (~6 tris).
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const blade = colorize(new THREE.PlaneGeometry(0.5, 0.55), 0.38, 0.52, 0.20)
      .rotateY((k / 3) * Math.PI)
      .translate(0, 0.26, 0);
    parts.push(blade);
  }
  return merge(parts);
}

function stone() {
  const g = new THREE.IcosahedronGeometry(0.24, 0);
  const rng = mulberry32(777);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * (0.8 + rng() * 0.5), p.getY(i) * (0.55 + rng() * 0.3), p.getZ(i) * (0.8 + rng() * 0.5));
  }
  g.computeVertexNormals();
  return colorize(g, 0.52, 0.50, 0.46).translate(0, 0.1, 0);
}

function branch() {
  const a = colorize(new THREE.CylinderGeometry(0.05, 0.08, 1.6, 5), 0.36, 0.27, 0.16)
    .rotateZ(Math.PI / 2).rotateY(0.3).translate(0, 0.07, 0);
  const b = colorize(new THREE.CylinderGeometry(0.03, 0.05, 0.7, 4), 0.33, 0.24, 0.14)
    .rotateZ(Math.PI / 2).rotateY(-0.9).translate(0.3, 0.06, 0.15);
  return merge([a, b]);
}

function haystack() {
  const body = colorize(new THREE.ConeGeometry(1.15, 1.9, 7), 0.72, 0.60, 0.32).translate(0, 0.95, 0);
  const pole = colorize(new THREE.CylinderGeometry(0.04, 0.04, 0.5, 4), 0.4, 0.3, 0.18).translate(0, 2.05, 0);
  return merge([body, pole]);
}

function house() {
  // Simple mid-hill rural house: ochre mud walls, dark pitched roof.
  const walls = colorize(new THREE.BoxGeometry(3.2, 2.1, 2.7), 0.80, 0.68, 0.52).translate(0, 1.05, 0);
  const band = colorize(new THREE.BoxGeometry(3.3, 0.35, 2.8), 0.55, 0.30, 0.20).translate(0, 0.2, 0);
  const roof = colorize(new THREE.ConeGeometry(2.85, 1.5, 4), 0.34, 0.26, 0.22)
    .rotateY(Math.PI / 4).translate(0, 2.85, 0);
  const door = colorize(new THREE.BoxGeometry(0.75, 1.3, 0.1), 0.25, 0.17, 0.10).translate(0.6, 0.65, 1.38);
  const win = colorize(new THREE.BoxGeometry(0.6, 0.55, 0.08), 0.20, 0.22, 0.26).translate(-0.8, 1.35, 1.38);
  return merge([walls, band, roof, door, win]);
}

function wall() {
  // Low dry-stone retaining wall segment.
  const base = colorize(new THREE.BoxGeometry(2.8, 0.55, 0.42), 0.54, 0.52, 0.48).translate(0, 0.26, 0);
  const cap = colorize(new THREE.BoxGeometry(2.9, 0.12, 0.5), 0.62, 0.60, 0.55).translate(0, 0.58, 0);
  return merge([base, cap]);
}

function flagpole() {
  // Prayer-flag pole: two strings of small coloured flags.
  const parts = [colorize(new THREE.CylinderGeometry(0.05, 0.06, 5, 4), 0.42, 0.32, 0.2).translate(0, 2.5, 0)];
  const cols = [[0.25, 0.45, 0.85], [0.92, 0.92, 0.92], [0.85, 0.25, 0.2], [0.25, 0.65, 0.3], [0.9, 0.8, 0.25]];
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    for (let i = 0; i < 5; i++) {
      const t = (i + 1) / 6;
      const c = cols[i];
      const f = colorize(new THREE.PlaneGeometry(0.4, 0.3), c[0], c[1], c[2])
        .translate(sgn * t * 2.6, 4.9 - t * 1.9, 0);
      parts.push(f);
    }
  }
  return merge(parts);
}

function stupa() {
  // Tiny whitewashed chorten with a gold spire — rare hilltop landmark.
  const base = colorize(new THREE.BoxGeometry(1.7, 0.5, 1.7), 0.85, 0.84, 0.80).translate(0, 0.25, 0);
  const dome = colorize(new THREE.SphereGeometry(0.75, 8, 6), 0.90, 0.89, 0.86).translate(0, 1.0, 0);
  const box = colorize(new THREE.BoxGeometry(0.5, 0.45, 0.5), 0.88, 0.82, 0.62).translate(0, 1.75, 0);
  const spire = colorize(new THREE.ConeGeometry(0.26, 0.9, 4), 0.85, 0.68, 0.28).translate(0, 2.35, 0);
  return merge([base, dome, box, spire]);
}

function bridgeDeck() {
  // Wooden plank bridge: deck + low side rails (spans the stream carve).
  const deck = colorize(new THREE.BoxGeometry(3.0, 0.16, 12.6), 0.50, 0.38, 0.24).translate(0, 0.08, 0);
  const railL = colorize(new THREE.BoxGeometry(0.14, 0.5, 12.6), 0.42, 0.31, 0.19).translate(1.45, 0.5, 0);
  const railR = railL.clone().translate(-2.9, 0, 0);
  const stripes = colorize(new THREE.BoxGeometry(3.02, 0.04, 0.3), 0.40, 0.30, 0.18);
  const parts = [deck, railL, railR];
  for (let i = -2; i <= 2; i++) parts.push(stripes.clone().translate(0, 0.17, i * 2.6));
  stripes.dispose();
  return merge(parts);
}

function rampDeck() {
  // Curved wooden kicker surface matching the analytic ramp profile
  // h(u) = 2.9 * (u/9)^1.8 exactly, +Z forward, origin at ramp start.
  const SEG = 8, W = 4.6, L = 9;
  const pos = [], col = [], idx = [];
  const plank = [0.52, 0.40, 0.26], side = [0.36, 0.27, 0.17];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const y = 2.9 * Math.pow(t, 1.8) + 0.07;
    pos.push(-W / 2, y, t * L, W / 2, y, t * L);
    col.push(...plank, ...plank);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  // Side flaps down to the dirt.
  let base = pos.length / 3;
  for (let s = 0; s < 2; s++) {
    const x = s === 0 ? -W / 2 : W / 2;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const y = 2.9 * Math.pow(t, 1.8) + 0.07;
      pos.push(x, y, t * L, x, Math.max(0, y - 0.9), t * L);
      col.push(...side, ...side);
    }
    for (let i = 0; i < SEG; i++) {
      const a = base + i * 2;
      if (s === 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += (SEG + 1) * 2;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Prop type registry: name, geometry factory, pool capacity, double-sided? */
function corn() {
  // Corn clump: three tall stalks with drooping leaves (Phase 3L-1 farms).
  const parts = [];
  const spots = [[0, 0], [0.45, 0.3], [-0.35, 0.42]];
  for (let i = 0; i < 3; i++) {
    const [sx, sz] = spots[i];
    const h = 1.5 + i * 0.18;
    parts.push(colorize(new THREE.CylinderGeometry(0.035, 0.06, h, 4), 0.44, 0.56, 0.2)
      .translate(sx, h / 2, sz));
    parts.push(colorize(new THREE.ConeGeometry(0.09, 0.5, 4), 0.78, 0.68, 0.3)
      .translate(sx, h + 0.2, sz));
    parts.push(colorize(new THREE.PlaneGeometry(0.5, 0.16), 0.5, 0.62, 0.24)
      .rotateZ(-0.5).rotateY(i * 2.1).translate(sx, h * 0.55, sz));
    parts.push(colorize(new THREE.PlaneGeometry(0.45, 0.14), 0.46, 0.58, 0.22)
      .rotateZ(0.55).rotateY(i * 2.1 + 1.2).translate(sx, h * 0.4, sz));
  }
  return merge(parts);
}

function waterMill() {
  // Stream-side water mill: stone hut, pitched roof, wooden paddle wheel.
  const hut = colorize(new THREE.BoxGeometry(2.4, 1.9, 2.2), 0.58, 0.56, 0.52).translate(0, 0.95, 0);
  const roof = colorize(new THREE.ConeGeometry(2.1, 1.2, 4), 0.36, 0.27, 0.2)
    .rotateY(Math.PI / 4).translate(0, 2.5, 0);
  const door = colorize(new THREE.BoxGeometry(0.7, 1.2, 0.1), 0.24, 0.16, 0.1).translate(0.4, 0.6, 1.12);
  const parts = [hut, roof, door];
  // Wheel on the side: rim + 4 paddles, plane faces along X.
  const rim = colorize(new THREE.TorusGeometry(1.0, 0.1, 5, 10), 0.42, 0.3, 0.18)
    .rotateY(Math.PI / 2).translate(1.55, 0.85, 0);
  parts.push(rim);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    parts.push(colorize(new THREE.BoxGeometry(0.08, 0.55, 0.42), 0.5, 0.36, 0.22)
      .rotateX(a).translate(1.55, 0.85 + Math.cos(a) * 0.95, Math.sin(a) * 0.95));
  }
  parts.push(colorize(new THREE.CylinderGeometry(0.09, 0.09, 1.4, 5), 0.4, 0.3, 0.18)
    .rotateZ(Math.PI / 2).translate(0.9, 0.85, 0));
  return merge(parts);
}

export const PROP_TYPES = [
  { name: 'pine', build: pine, max: 800 },
  { name: 'tree', build: broadleaf, max: 420 },
  { name: 'bush', build: bush, max: 560 },
  { name: 'rock', build: rock, max: 620 },
  { name: 'log', build: log, max: 170 },
  { name: 'haystack', build: haystack, max: 90 },
  { name: 'house', build: house, max: 48 },
  { name: 'wall', build: wall, max: 140 },
  { name: 'flagpole', build: flagpole, max: 40, doubleSided: true },
  { name: 'stupa', build: stupa, max: 16 },
  { name: 'bridge', build: bridgeDeck, max: 16 },
  { name: 'ramp', build: rampDeck, max: 16, doubleSided: true },
  // Micro-props (Phase 3C-1 ground detail): dense, tiny, never collide.
  { name: 'grass', build: grass, max: 1000, doubleSided: true },
  { name: 'stone', build: stone, max: 450 },
  { name: 'branch', build: branch, max: 160 },
  // Phase 3L-1 rural world.
  { name: 'corn', build: corn, max: 520, doubleSided: true },
  { name: 'mill', build: waterMill, max: 10 },
];

export const PROP = {};
PROP_TYPES.forEach((t, i) => { PROP[t.name] = i; });

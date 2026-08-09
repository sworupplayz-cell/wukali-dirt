import * as THREE from 'three';

/**
 * MountainImpostors — far-LOD for mountain destinations.
 *
 * Streamed terrain only reaches ~160 m, and fog hides its edge — which
 * would make a 300 m-radius destination invisible until the player is
 * already on it. These pooled meshes CONFORM to the real analytic terrain:
 * every vertex samples generator.height() and sits a little below it, so
 * streamed chunks always occlude the impostor up close (including the
 * shape-modulated flanks a plain dome would poke through). When the player
 * is on/near a mountain, its impostor sinks a few extra metres so the
 * coarse interpolation between impostor vertices can never surface through
 * the loaded chunks. No collision; recolored/reshaped only on reassign.
 */
const POOL = 8;
const VIEW_R = 2200;      // impostors appear within this range
const RINGS = 12, SEGS = 32;
const BASE_SINK = 1.6;    // m below the real surface at the peak
const EDGE_SINK = 3.0;    // additional sink toward the rim
const NEAR_SINK = 6.0;    // extra sink while the player is on the mountain

export class MountainImpostors {
  constructor(scene, generator) {
    this.gen = generator;
    this._meshes = [];
    this._assigned = new Array(POOL).fill(null); // mountain records
    this._lastCx = null;
    this._lastCz = null;
    this._heights = new Float32Array((RINGS + 1) * SEGS);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(buildDomeGeometry(), mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this._meshes.push(mesh);
    }
  }

  update(x, z) {
    // Proximity sink runs every call (cheap; prevents poke-through while
    // riding on a mountain).
    for (let i = 0; i < POOL; i++) {
      const m = this._assigned[i];
      if (!m) continue;
      const d = Math.hypot(m.x - x, m.z - z);
      const t = 1 - Math.min(1, Math.max(0, (d - (m.R + 40)) / 140));
      this._meshes[i].position.y = -NEAR_SINK * t;
      this._meshes[i].updateMatrix();
    }

    const cx = Math.floor(x / 300), cz = Math.floor(z / 300);
    if (cx === this._lastCx && cz === this._lastCz) return;
    this._lastCx = cx;
    this._lastCz = cz;

    // Mountains in range, nearest first.
    const found = [];
    const mcx = Math.floor(x / 1200), mcz = Math.floor(z / 1200);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const m = this.gen.mountainCell(mcx + dx, mcz + dz);
        if (!m) continue;
        const d = Math.hypot(m.x - x, m.z - z);
        if (d < VIEW_R) found.push([d, m]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    const want = found.slice(0, POOL).map((f) => f[1]);

    const wantIds = new Set(want.map((m) => m.id));
    for (let i = 0; i < POOL; i++) {
      if (this._assigned[i] && !wantIds.has(this._assigned[i].id)) {
        this._assigned[i] = null;
        this._meshes[i].visible = false;
      }
    }
    for (const m of want) {
      if (this._assigned.some((a) => a && a.id === m.id)) continue;
      const slot = this._assigned.indexOf(null);
      if (slot < 0) break;
      this._assigned[slot] = m;
      this._fill(this._meshes[slot], m);
    }
  }

  /** Sample the real terrain at every vertex; color by height fraction. */
  _fill(mesh, m) {
    const pos = mesh.geometry.attributes.position;
    const col = mesh.geometry.attributes.color;
    const hs = this._heights;
    const outer = m.R + 40;

    let peakY = -Infinity, baseY = Infinity;
    let i = 0;
    for (let ring = 0; ring <= RINGS; ring++) {
      const rr = ring / RINGS;
      for (let s2 = 0; s2 < SEGS; s2++, i++) {
        const a = (s2 / SEGS) * Math.PI * 2;
        const h = this.gen.height(m.x + Math.cos(a) * rr * outer, m.z + Math.sin(a) * rr * outer);
        hs[i] = h;
        if (h > peakY) peakY = h;
        if (h < baseY) baseY = h;
      }
    }
    const span = Math.max(8, peakY - baseY);
    const snowy = m.H > 66;

    i = 0;
    for (let ring = 0; ring <= RINGS; ring++) {
      const rr = ring / RINGS;
      const sink = BASE_SINK + EDGE_SINK * rr;
      for (let s2 = 0; s2 < SEGS; s2++, i++) {
        const a = (s2 / SEGS) * Math.PI * 2;
        pos.setXYZ(i, Math.cos(a) * rr * outer, hs[i] - sink, Math.sin(a) * rr * outer);
        const t = (hs[i] - baseY) / span;
        let r = 0.42, g = 0.50, b = 0.38;              // forested base
        if (t > 0.42) { r = 0.47; g = 0.45; b = 0.42; } // rock
        if (t > 0.72) { r = 0.52; g = 0.52; b = 0.55; } // high rock
        if (t > 0.85 && snowy) { r = 0.93; g = 0.94; b = 0.97; }
        col.setXYZ(i, r + (0.70 - r) * 0.22, g + (0.78 - g) * 0.22, b + (0.88 - b) * 0.22);
      }
    }
    // Skirt: below the rim ring.
    const rimStart = RINGS * SEGS;
    for (let s2 = 0; s2 < SEGS; s2++, i++) {
      const a = (s2 / SEGS) * Math.PI * 2;
      pos.setXYZ(i, Math.cos(a) * outer, hs[rimStart + s2] - 30, Math.sin(a) * outer);
      col.setXYZ(i, col.getX(rimStart + s2), col.getY(rimStart + s2), col.getZ(rimStart + s2));
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    mesh.scale.set(1, 1, 1);
    mesh.position.set(m.x, 0, m.z);
    mesh.updateMatrix();
    mesh.visible = true;
    mesh.geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, (peakY + baseY) / 2, 0),
      Math.hypot(outer, span) + 34
    );
  }
}

/** Flat unit disc topology; vertex positions are rewritten per mountain. */
function buildDomeGeometry() {
  const count = (RINGS + 1) * SEGS + SEGS; // rings + skirt
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  const idx = [];
  for (let ring = 0; ring < RINGS + 1; ring++) {
    const a0 = ring * SEGS, b0 = (ring + 1) * SEGS;
    for (let s2 = 0; s2 < SEGS; s2++) {
      const s1 = (s2 + 1) % SEGS;
      idx.push(a0 + s2, b0 + s2, a0 + s1, a0 + s1, b0 + s2, b0 + s1);
    }
  }
  geo.setIndex(idx);
  return geo;
}

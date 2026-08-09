import * as THREE from 'three';

/**
 * MountainImpostors — far-LOD for mountain destinations.
 *
 * Streamed terrain only reaches ~160 m, and fog hides its edge — which
 * would make a 300 m-radius destination invisible until the player is
 * already on it. These pooled low-poly domes stand at the TRUE mountain
 * positions (fog-exempt, haze-tinted like the distant backdrop), so peaks
 * are discoverable from kilometres away. They sit slightly below the real
 * analytic surface, so streamed chunks naturally occlude them up close.
 * No collision, ~500 tris each, recolored only when reassigned.
 */
const POOL = 8;
const VIEW_R = 2200;      // impostors appear within this range
const RINGS = 8, SEGS = 18;

export class MountainImpostors {
  constructor(scene, generator) {
    this.gen = generator;
    this._meshes = [];
    this._assigned = new Array(POOL).fill(null); // mountain ids
    this._lastCx = null;
    this._lastCz = null;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(buildDomeGeometry(), mat);
      mesh.visible = false;
      mesh.frustumCulled = true;
      scene.add(mesh);
      this._meshes.push(mesh);
    }
  }

  /** Called from WorldManager.update; cheap unless the 300 m cell changed. */
  update(x, z) {
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

    // Keep already-assigned meshes; fill freed slots with new mountains.
    const wantIds = new Set(want.map((m) => m.id));
    for (let i = 0; i < POOL; i++) {
      if (this._assigned[i] && !wantIds.has(this._assigned[i])) {
        this._assigned[i] = null;
        this._meshes[i].visible = false;
      }
    }
    for (const m of want) {
      if (this._assigned.includes(m.id)) continue;
      const slot = this._assigned.indexOf(null);
      if (slot < 0) break;
      this._assigned[slot] = m.id;
      this._fill(this._meshes[slot], m);
    }
  }

  _fill(mesh, m) {
    // Real peak/base heights from the analytic terrain.
    const peakY = this.gen.height(m.x, m.z) - 1.5;
    let baseY = Infinity;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      baseY = Math.min(baseY, this.gen.height(m.x + Math.cos(a) * (m.R + 20), m.z + Math.sin(a) * (m.R + 20)));
    }
    baseY -= 3;
    const H = Math.max(10, peakY - baseY);

    const pos = mesh.geometry.attributes.position;
    const col = mesh.geometry.attributes.color;
    const snowy = m.H > 66;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i); // unit profile height 0..1 (skirt < 0)
      // Haze-tinted color bands matching the real terrain coloring.
      let r = 0.42, g = 0.50, b = 0.38;              // forested base
      if (t > 0.42) { r = 0.47; g = 0.45; b = 0.42; } // rock
      if (t > 0.72) { r = 0.52; g = 0.52; b = 0.55; } // high rock
      if (t > 0.85 && snowy) { r = 0.93; g = 0.94; b = 0.97; }
      // Mild atmospheric haze so it reads as mid-distance terrain, clearly
      // nearer than the fog-white backdrop ring.
      col.setXYZ(i, r + (0.70 - r) * 0.22, g + (0.78 - g) * 0.22, b + (0.88 - b) * 0.22);
    }
    col.needsUpdate = true;

    mesh.scale.set(m.R * 0.99, H, m.R * 0.99);
    mesh.position.set(m.x, baseY, m.z);
    mesh.updateMatrix();
    mesh.visible = true;
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 1.6);
  }
}

/** Unit dome: radius 1, height 1, profile y = (1-r²)², plus a short skirt. */
function buildDomeGeometry() {
  const pos = [], col = [], idx = [];
  for (let ring = 0; ring <= RINGS; ring++) {
    const rr = ring / RINGS;
    const q = 1 - rr * rr;
    const y = q * q;
    for (let s2 = 0; s2 < SEGS; s2++) {
      const a = (s2 / SEGS) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      col.push(1, 1, 1);
    }
  }
  // Skirt ring below the base to cover valleys under the rim.
  for (let s2 = 0; s2 < SEGS; s2++) {
    const a = (s2 / SEGS) * Math.PI * 2;
    pos.push(Math.cos(a), -0.4, Math.sin(a));
    col.push(1, 1, 1);
  }
  for (let ring = 0; ring < RINGS + 1; ring++) {
    const a0 = ring * SEGS, b0 = (ring + 1) * SEGS;
    for (let s2 = 0; s2 < SEGS; s2++) {
      const s1 = (s2 + 1) % SEGS;
      idx.push(a0 + s2, b0 + s2, a0 + s1, a0 + s1, b0 + s2, b0 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

import * as THREE from 'three';
import { vnoise, sstep } from './noise.js';
import { BLUEPRINT_SEED } from './NepalBlueprint.js';

/**
 * NepalWater (Phase W-3D) — lightweight rivers, lakes, tributary streams
 * and cascade foam for the Nepal fixed-world mode.
 *
 * NEPAL MODE ONLY (constructed only for `?world=nepal`), and purely visual:
 * no colliders, no physics coupling, no terrain-height changes — the W-3B
 * macro already carved the valleys and basins; this phase floods them.
 *
 * One pooled 33×33 vertex water tile per streamed chunk (a single shared
 * semi-transparent material, one draw call each, ≤ 25 active). Per vertex,
 * the water surface is an ANALYTIC level:
 *   rivers : bed(t) + depth inside a varying width w(t); beyond the bank
 *            the surface dives underground at a capped slope (no walls).
 *            Terrain micro-relief pokes through inside wide corridors —
 *            braided gravel-bar channels, like the real Koshi/Narayani.
 *   lakes  : constant level per lake, sampled from its basin floor.
 *   streams: the procedural stream network gets a shallow ribbon that
 *            follows the terrain; on steep drops it foams white (cascades).
 * Everything derives from blueprint data + fixed-salt noise → fully
 * deterministic; tiles agree exactly across chunk boundaries because the
 * level functions are global. Zero per-frame CPU cost.
 */

const RES = 32;                     // 33×33 verts over the 64 m chunk
const S = BLUEPRINT_SEED * 13 + 40; // water noise salts (fixed forever)
const POOL = 30;

// Base widths (m) by river id: [at headwaters, at the plains].
const WIDTHS = {
  koshi: [16, 64], narayani: [18, 70], karnali: [16, 60],
  mahakali: [12, 40], bagmati: [9, 30], rapti: [9, 26],
};

export class NepalWater {
  constructor(scene, macro, gen) {
    this.gen = gen;
    this.macro = macro;
    // Flatten river polylines with per-vertex width + bed grade.
    this.rivers = [];
    const ids = Object.keys(WIDTHS);
    macro._rivers.forEach((pts, ri) => {
      const id = ids[ri] || 'bagmati';
      const [w0, w1] = WIDTHS[id];
      const segs = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const f0 = k / (pts.length - 1), f1 = (k + 1) / (pts.length - 1);
        segs.push({
          ax: a.x, az: a.z, bx: b.x, bz: b.z, bedA: a.bed, bedB: b.bed,
          wA: w0 + (w1 - w0) * f0, wB: w0 + (w1 - w0) * f1,
          len2: (b.x - a.x) ** 2 + (b.z - a.z) ** 2,
        });
      }
      this.rivers.push(segs);
    });
    // Lake levels: basin floor sampled on a ring (robust against local
    // micro-relief) + fill depth — lakes genuinely flood their basins.
    this.lakes = macro._lakes.map((l) => {
      let sum = 0, n = 0;
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2, rr = k === 0 ? 0 : l.r * 0.45;
        sum += gen.height(l.x + Math.cos(a) * rr, l.z + Math.sin(a) * rr);
        n++;
      }
      return { x: l.x, z: l.z, r: l.r, level: sum / n + 2.4 };
    });

    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.85,
    });
    this._free = [];
    for (let i = 0; i < POOL; i++) {
      const geo = new THREE.PlaneGeometry(1, 1, RES, RES); // indexed grid
      geo.deleteAttribute('uv');
      geo.setAttribute('color',
        new THREE.BufferAttribute(new Float32Array((RES + 1) * (RES + 1) * 3), 3));
      // Water is near-flat: constant up normals (no per-fill normal pass).
      const nrm = geo.attributes.normal;
      for (let n = 0; n < nrm.count; n++) nrm.setXYZ(n, 0, 1, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this._free.push(mesh);
    }
  }

  /** Nearest river surface candidate at (x,z): level diving beyond banks.
   *  Inside/near the channel the level rides the CARVED valley floor at the
   *  centerline (macro surface + depth), so mountain gorges hold water. */
  _riverLevel(x, z, out) {
    let best = -1e9, foam = 0;
    out.inWater = false;
    let bCpx = 0, bCpz = 0, bD = 0, bW = 0, bFoam = 0, found = false;
    for (let r = 0; r < this.rivers.length; r++) {
      const segs = this.rivers[r];
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        const apx = x - s.ax, apz = z - s.az;
        let t = (apx * (s.bx - s.ax) + apz * (s.bz - s.az)) / s.len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const cpx = s.ax + (s.bx - s.ax) * t, cpz = s.az + (s.bz - s.az) * t;
        const dx = x - cpx, dz = z - cpz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > 900) continue;
        const bed = s.bedA + (s.bedB - s.bedA) * t;
        const w = (s.wA + (s.wB - s.wA) * t) *
          (0.72 + 0.56 * vnoise(x * 0.004 + 7.7, z * 0.004 - 3.1, S + 1));
        const y = bed + 0.55 - Math.max(0, d - w) * 0.8; // coarse ranking level
        if (y > best) {
          best = y;
          found = true;
          bCpx = cpx; bCpz = cpz; bD = d; bW = w;
          bFoam = sstep(0.05, 0.12, Math.abs(s.bedB - s.bedA) / Math.sqrt(s.len2)) *
            sstep(w, w * 0.5, d);
        }
      }
    }
    if (found && bD < bW * 2.4) {
      // Exact level: carved floor at the channel centerline + depth.
      const floor = this.macro._macro(bCpx, bCpz, this._mScr || (this._mScr = { h: 0, mul: 1 }));
      best = floor.h + 0.9 - Math.max(0, bD - bW) * 0.8;
      out.inWater = bD < bW;
      foam = bFoam;
    }
    out.y = best;
    out.foam = foam;
    return out;
  }

  /** Fill (or refill) the water tile for a chunk; skips dry chunks. */
  fill(c) {
    this.release(c);
    const ox = c.cx * 64, oz = c.cz * 64;
    const cx = ox + 32, cz = oz + 32;
    // Quick reject: any water feature near this chunk?
    const rl = this._riverLevel(cx, cz, this._scr || (this._scr = { y: 0, foam: 0 }));
    let near = rl.y > -160; // river surface within ~200 m of the ground band
    if (!near) {
      for (const l of this.lakes) {
        if (Math.hypot(cx - l.x, cz - l.z) < l.r + 96) { near = true; break; }
      }
    }
    if (!near) {
      // Coarse tributary scan (the stream channel noise is cheap).
      const v = 0.5 - cz / 50000;
      if (v < 0.62) {
        for (let i = 0; i < 25 && !near; i++) {
          const sx = ox + (i % 5) * 16, sz = oz + Math.floor(i / 5) * 16;
          const sN = vnoise(sx * 0.004 - 11.3, sz * 0.004 + 23.7, this.gen.SS) - 0.5;
          if (Math.abs(sN) < 0.018) near = true;
        }
      }
    }
    if (!near) return;
    const mesh = this._free.pop();
    if (!mesh) return;
    c.water = mesh;

    const pos = mesh.geometry.attributes.position;
    const col = mesh.geometry.attributes.color;
    const scr = this._scr;
    let any = false;
    for (let j = 0; j <= RES; j++) {
      for (let i = 0; i <= RES; i++) {
        const x = ox + (i / RES) * 64, z = oz + (j / RES) * 64;
        const idx = j * (RES + 1) + i;
        this._riverLevel(x, z, scr);
        let y = scr.y, foam = scr.foam;
        let inWater = scr.inWater; // true only inside the actual channel
        let rC = 0.18, gC = 0.42, bC = 0.56; // river blue
        for (const l of this.lakes) {
          const d = Math.hypot(x - l.x, z - l.z);
          const ly = l.level - Math.max(0, d - l.r) * 0.8;
          if (ly > y) {
            y = ly; foam = 0; rC = 0.16; gC = 0.45; bC = 0.66; // clear lake blue
            inWater = d < l.r * 1.05;
          }
        }
        // Tributary streams hug the terrain (shallow pale ribbon).
        const v = 0.5 - z / 50000;
        if (v < 0.62) {
          const sN = vnoise(x * 0.004 - 11.3, z * 0.004 + 23.7, this.gen.SS) - 0.5;
          const sM = sstep(0.017, 0.009, Math.abs(sN));
          if (sM > 0.55) {
            const th = this.gen.height(x, z);
            const sy = th + 0.14 - (1 - sM) * 2;
            if (sy > y) {
              y = sy;
              inWater = true;
              rC = 0.30; gC = 0.48; bC = 0.52;
              // Cascades: steep stream stretches foam white (waterfalls).
              const drop = Math.abs(this.gen.height(x + 2, z) - this.gen.height(x - 2, z)) +
                           Math.abs(this.gen.height(x, z + 2) - this.gen.height(x, z - 2));
              foam = sstep(1.6, 3.2, drop);
            }
          }
        }
        if (inWater) any = true;
        pos.setXYZ(idx, x, Math.max(y, -150), z);
        col.setXYZ(idx, rC + (0.93 - rC) * foam, gC + (0.95 - gC) * foam,
          bC + (0.97 - bC) * foam);
      }
    }
    if (!any) { this.release(c); return; }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    mesh.matrix.identity();
    mesh.matrixWorld.identity();
    mesh.visible = true;
  }

  /** True if ground at (x,z,heightT) sits under standing water (used by
   *  scatter/crops/settlements so nothing grows inside rivers or lakes). */
  submerged(x, z, hT) {
    for (const l of this.lakes) {
      if (Math.hypot(x - l.x, z - l.z) < l.r * 1.08 && l.level > hT + 0.15) return true;
    }
    const scr = this._scr || (this._scr = { y: 0, foam: 0, inWater: false });
    this._riverLevel(x, z, scr);
    return scr.inWater && scr.y > hT + 0.15;
  }

  release(c) {
    if (!c.water) return;
    c.water.visible = false;
    this._free.push(c.water);
    c.water = null;
  }
}

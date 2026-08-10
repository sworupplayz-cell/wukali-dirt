import { sstep } from './noise.js';
import { CITIES, REGIONS, WORLD_SIZE } from './NepalBlueprint.js';

/**
 * NepalRoads (Phase W-3E) — deterministic, terrain-following highway and
 * mountain-road network for the Nepal fixed world.
 *
 * NEPAL MODE ONLY. No meshes and no colliders: routes are PLANNED as
 * polylines over the macro terrain, then PAINTED into the ground through
 * the engine's existing trail pipeline (dirt-road color, detail smoothing,
 * road grip) plus a subtle hillside bench in the macro layer — exactly how
 * real hill roads are cut. Terrain keeps its shape; roads follow it.
 *
 * Planning is a greedy cost walk over the raw macro heightfield:
 *   cost = step + step·22·grade²          (steep ground is expensive)
 *        + wall veto (grade > 0.2)        (never through vertical walls)
 *        + heading bias toward the target
 *        + hairpin penalty                (no impossible sharp turns)
 * On steep flanks the cheap headings are contour traverses, so the walker
 * naturally serpentines — switchbacks emerge instead of wall climbs, and
 * river corridors (already low ground thanks to W-3B carving) attract the
 * long-distance runs.
 *
 * Everything is deterministic: pure functions of blueprint anchors + the
 * fixed-seed macro field. Planning cost ≈ 20k macro samples, once, at load.
 */

const STEP = 110;
const CELL = 192;

export class NepalRoads {
  constructor(macro) {
    this.macro = macro;
    this._scr = { h: 0, mul: 1 };
    const A = {};
    for (const c of CITIES) A[c.id] = this._p(c.u, c.v);
    for (const r of REGIONS) A[r.id] = this._p(r.center[0], r.center[1]);

    // ---- The network -------------------------------------------------------
    const R = (id, kind, w, stops) => ({ id, kind, w, stops });
    const defs = [
      // Major highways.
      R('prithvi', 'highway', 7, [A.kathmandu, A.pokhara]),
      R('ktm-chitwan', 'highway', 7, [A.kathmandu, A.bharatpur]),
      R('east', 'highway', 7, [A.kathmandu, this._p(0.78, 0.36), A.ilam]),
      R('west', 'highway', 6.5, [A.pokhara, A.butwal]),
      R('mahendra', 'highway', 7, [A.nepalgunj, A.butwal, A.bharatpur,
        this._p(0.72, 0.095), A.biratnagar]),
      // Mountain routes.
      R('kali-gandaki', 'mountain', 5, [A.pokhara, this._p(0.435, 0.68),
        this._p(0.425, 0.80), A.mustang]),
      R('marsyangdi', 'mountain', 5, [A.pokhara, this._p(0.49, 0.56),
        A.manang]),
      R('solu', 'mountain', 5, [this._p(0.74, 0.37), this._p(0.78, 0.52),
        A.solukhumbu]),
      R('rara-road', 'mountain', 5, [A.nepalgunj, this._p(0.165, 0.34),
        A.rara]),
    ];

    this.routes = [];
    this._grid = new Map();
    this._segs = [];
    for (const d of defs) {
      const pts = [];
      for (let leg = 0; leg < d.stops.length - 1; leg++) {
        const a = d.stops[leg], b = d.stops[leg + 1];
        const legPts = this._plan(a.x, a.z, b.x, b.z);
        if (pts.length) legPts.shift(); // join without duplicate node
        pts.push(...legPts);
      }
      // W-3F: densify/smooth sharp corners (hairpin apexes) with one
      // Chaikin corner-cut pass — smoother switchbacks, finer node spacing.
      const sm = this._smooth(pts);
      this.routes.push({ id: d.id, kind: d.kind, w: d.w, pts: sm });
      for (let i = 0; i < sm.length - 1; i++) this._addSeg(sm[i], sm[i + 1], d.w, d.kind === 'highway' ? 1 : 0);
    }
    // W-3F: bridge deck pins (registered later by NepalRoadside).
    this.bridges = [];
    this._bgrid = new Map();
    // Per-sample query cache (one query serves trail mask + macro bench).
    this._q = { x: NaN, z: NaN, mask: 0, shelf: 0, centerH: 0, deck: 0, deckH: 0, d: 9e9, w: 5, hw: 0 };
  }

  /** One corner-cutting pass on sharp corners only (W-3F). */
  _smooth(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], b = pts[i], c = pts[i + 1];
      const d1x = b.x - a.x, d1z = b.z - a.z, d2x = c.x - b.x, d2z = c.z - b.z;
      const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
      const dot = (d1x * d2x + d1z * d2z) / (l1 * l2);
      if (dot < 0.86) { // corner sharper than ~30°: cut it
        const p1 = { x: b.x - d1x * 0.3, z: b.z - d1z * 0.3 };
        const p2 = { x: b.x + d2x * 0.3, z: b.z + d2z * 0.3 };
        p1.h = this._h(p1.x, p1.z);
        p2.h = this._h(p2.x, p2.z);
        // Only accept the cut if it doesn't steepen the climb (cutting a
        // hairpin apex can shortcut ACROSS the slope the hairpin avoids).
        const gCut = Math.abs(p2.h - p1.h) / (Math.hypot(p2.x - p1.x, p2.z - p1.z) || 1);
        const gOld = Math.max(Math.abs(b.h - a.h) / l1, Math.abs(c.h - b.h) / l2);
        if (gCut <= gOld + 0.02) {
          out.push(p1, p2);
        } else {
          out.push(b); // keep the true hairpin apex
        }
      } else {
        out.push(b);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /** Register bridge decks (terrain pins; W-3F). {x,z,dx,dz,len,deckH} */
  addBridges(list) {
    this.bridges = list;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const m = b.len * 0.5 + 30;
      const x0 = Math.floor((b.x - m) / CELL), x1 = Math.floor((b.x + m) / CELL);
      const z0 = Math.floor((b.z - m) / CELL), z1 = Math.floor((b.z + m) / CELL);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const key = cx * 100003 + cz;
          let arr = this._bgrid.get(key);
          if (!arr) this._bgrid.set(key, (arr = []));
          arr.push(i);
        }
      }
    }
    this._q.x = NaN; // invalidate the sample cache
  }

  _p(u, v) {
    return { x: (u - 0.5) * WORLD_SIZE, z: (0.5 - v) * WORLD_SIZE };
  }

  _h(x, z) {
    return this.macro._macro(x, z, this._scr).h;
  }

  /** Greedy terrain-cost walk from (ax,az) to (bx,bz). */
  _plan(ax, az, bx, bz) {
    const pts = [{ x: ax, z: az, h: this._h(ax, az) }];
    let x = ax, z = az, dirX = 0, dirZ = 0;
    for (let i = 0; i < 750; i++) {
      const dx = bx - x, dz = bz - z;
      const dist = Math.hypot(dx, dz);
      if (dist < STEP * 1.4) break;
      const bear = Math.atan2(dx, dz);
      const h0 = this._h(x, z);
      let bnx = 0, bnz = 0, bh = 0, bsx = 0, bsz = 0, bestCost = Infinity;
      for (let k = -6; k <= 6; k++) {
        const a = bear + k * (Math.PI / 14); // ±77° fan
        const sx = Math.sin(a) * STEP, sz = Math.cos(a) * STEP;
        const nx = x + sx, nz = z + sz;
        const h1 = this._h(nx, nz);
        const grade = Math.abs(h1 - h0) / STEP;
        let cost = STEP + STEP * 22 * grade * grade;
        if (grade > 0.2) cost += 4000;         // vertical wall: veto
        cost += Math.abs(k) * 16;              // pull toward the target
        if (dirX !== 0 || dirZ !== 0) {
          const dot = (sx * dirX + sz * dirZ) / (STEP * STEP);
          if (dot < 0.2) cost += 900;          // hairpins only when forced
        }
        if (cost < bestCost) {
          bestCost = cost; bnx = nx; bnz = nz; bh = h1; bsx = sx; bsz = sz;
        }
      }
      x = bnx; z = bnz; dirX = bsx; dirZ = bsz;
      pts.push({ x, z, h: bh });
    }
    pts.push({ x: bx, z: bz, h: this._h(bx, bz) });
    return pts;
  }

  _addSeg(a, b, w, hw) {
    const seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, hA: a.h, hB: b.h, w, hw,
      len2: (b.x - a.x) ** 2 + (b.z - a.z) ** 2 || 1 };
    const idx = this._segs.push(seg) - 1;
    const m = w + 34; // bench + mask falloff margin
    const x0 = Math.floor((Math.min(a.x, b.x) - m) / CELL);
    const x1 = Math.floor((Math.max(a.x, b.x) + m) / CELL);
    const z0 = Math.floor((Math.min(a.z, b.z) - m) / CELL);
    const z1 = Math.floor((Math.max(a.z, b.z) + m) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cx * 100003 + cz;
        let arr = this._grid.get(key);
        if (!arr) this._grid.set(key, (arr = []));
        arr.push(idx);
      }
    }
  }

  /** Distance query with per-sample cache: trail mask + macro road bench +
   *  bridge deck pin (W-3F). */
  query(x, z) {
    const q = this._q;
    if (q.x === x && q.z === z) return q;
    q.x = x; q.z = z; q.mask = 0; q.shelf = 0; q.centerH = 0; q.deck = 0; q.deckH = 0; q.d = 9e9; q.w = 5; q.hw = 0;
    const key = Math.floor(x / CELL) * 100003 + Math.floor(z / CELL);
    const arr = this._grid.get(key);
    if (arr) {
      let bd = Infinity, bH = 0, bw = 5, bhw = 0;
      for (let i = 0; i < arr.length; i++) {
        const s = this._segs[arr[i]];
        const apx = x - s.ax, apz = z - s.az;
        let t = (apx * (s.bx - s.ax) + apz * (s.bz - s.az)) / s.len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = apx - (s.bx - s.ax) * t, dz = apz - (s.bz - s.az) * t;
        const d2 = dx * dx + dz * dz;
        if (d2 < bd) { bd = d2; bH = s.hA + (s.hB - s.hA) * t; bw = s.w; bhw = s.hw || 0; }
      }
      const d = Math.sqrt(bd);
      q.mask = sstep(bw + 2.4, bw * 0.5, d);
      q.shelf = sstep(bw + 17, bw * 0.75, d);
      q.centerH = bH;
      q.d = d; q.w = bw; q.hw = bhw;
    }
    const barr = this._bgrid.get(key);
    if (barr) {
      for (let i = 0; i < barr.length; i++) {
        const b = this.bridges[barr[i]];
        const rx = x - b.x, rz = z - b.z;
        const u = rx * b.dx + rz * b.dz;      // along the road
        const v = -rx * b.dz + rz * b.dx;     // across the road
        const half = b.len * 0.5;
        if (Math.abs(u) < half + 9 && Math.abs(v) < 5.5) {
          const e = sstep(half + 8, half - 2, Math.abs(u)) * sstep(5.2, 3.4, Math.abs(v));
          if (e > q.deck) { q.deck = e; q.deckH = b.deckH; }
        }
      }
    }
    return q;
  }
}

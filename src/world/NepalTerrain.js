import { vnoise, sstep } from './noise.js';
import { BLUEPRINT_SEED, WORLD_SIZE, REGIONS, RIVERS, LAKES, CITIES } from './NepalBlueprint.js';

/**
 * NepalMacro (Phase W-3B) — large-scale terrain foundation for the future
 * fixed 50×50 km Nepal world, driven entirely by NepalBlueprint data.
 *
 * OPT-IN ONLY: the game constructs this ONLY when the URL asks for
 * `?world=nepal`. In the default game the TerrainGenerator's macro hook is
 * null and the procedural world is bit-identical to before this phase.
 *
 * The macro layer transforms the existing procedural relief instead of
 * replacing it:   finalH = macroH(x,z) + proceduralH * detailMul(x,z)
 * so every existing system (streams, trails, features, mountain domes,
 * scatter, collision, the 2 m render lattice) keeps working self-
 * consistently on top — they all read the same height() function.
 *
 * Layers (all deterministic from BLUEPRINT_SEED, independent of game seed —
 * the fixed world is the same place for everyone):
 *   1. South→north BELT PROFILE (Terai → Chure → dun → Mahabharat →
 *      Middle Hills → High Mountains → Trans-Himalaya) with longitudinal
 *      drift, sampled from a control-point spline.
 *   2. Low-frequency RIDGE/VALLEY relief, amplitude + sharpness per belt
 *      (soft swells in the Terai, ridgelines in the hills, steep walls in
 *      the high belt, terraced plateaus in Mustang/Dolpo).
 *   3. VALLEY BOWLS for Kathmandu and Pokhara (flat floors from the
 *      blueprint elevation bands).
 *   4. RIVER CORRIDORS carved along the blueprint rivers — cross-belt
 *      valleys that stay gradual (these are the future highway corridors).
 *   5. LAKE BASINS flattened at the eight blueprint lakes.
 *
 * Cost: ~8 vnoise + a spline walk + ~30 segment distances per sample,
 * comparable to the existing per-sample noise budget. No allocations after
 * construction.
 */

// Belt spline: v, baseH, reliefAmp, detailMul, wall (ridge sharpness 0..1).
const BELT = [
  [0.00,   3,  2.5, 0.35, 0.0],  // outer Terai plain
  [0.10,   5,  3.5, 0.35, 0.0],
  [0.145,  9,  5.0, 0.40, 0.0],  // dun (inner Terai / Chitwan) floor
  [0.18,  40, 15.0, 0.60, 0.3],  // Chure / Siwalik crest
  [0.215, 26, 10.0, 0.60, 0.1],  // inner valley shelf
  [0.27,  88, 26.0, 0.85, 0.5],  // Mahabharat crest
  [0.33,  76, 22.0, 0.95, 0.3],
  [0.45, 112, 30.0, 1.00, 0.35], // Middle Hills
  [0.56, 142, 38.0, 1.05, 0.45],
  [0.66, 232, 72.0, 1.20, 0.85], // High Mountain belt: steep walls
  [0.76, 298, 88.0, 1.20, 0.9],
  [0.83, 252, 42.0, 0.80, 0.4],  // trans-Himalayan transition
  [0.92, 234, 30.0, 0.70, 0.25], // Mustang / Dolpo plateau country
  [1.00, 262, 40.0, 0.75, 0.35],
];

const S = BLUEPRINT_SEED * 13; // noise salts (fixed forever)

export class NepalMacro {
  constructor() {
    // Rivers in metres: flat segment arrays + a bed level per vertex
    // (falls from the headwater belt toward ~2 m at the plains).
    this._rivers = RIVERS.map((r) => {
      const pts = r.points.map(([u, v]) => {
        const x = (u - 0.5) * WORLD_SIZE, z = (0.5 - v) * WORLD_SIZE;
        const bed = Math.max(2, this._beltAt(v, 0) * 0.55);
        return { x, z, bed };
      });
      return pts;
    });
    this._lakes = LAKES.map((l) => ({
      x: (l.u - 0.5) * WORLD_SIZE, z: (0.5 - l.v) * WORLD_SIZE,
      r: 130 + l.size * 110,
    }));
    // Valley bowls from the blueprint valley regions (floor = band mid).
    this._bowls = REGIONS.filter((r) => r.type === 'valley').map((r) => ({
      x: (r.center[0] - 0.5) * WORLD_SIZE, z: (0.5 - r.center[1]) * WORLD_SIZE,
      rx: r.extent[0] * WORLD_SIZE, rz: r.extent[1] * WORLD_SIZE,
      floor: (r.band[0] + r.band[1]) * 0.5,
    }));
    this._scratch = { h: 0, mul: 1 };
  }

  /** Belt spline base height at v (with optional index 1..4 for the other
   *  spline columns: 1=relief, 2=detailMul, 3=wall). */
  _beltAt(v, col) {
    const c = col + 1;
    if (v <= BELT[0][0]) return BELT[0][c];
    for (let i = 1; i < BELT.length; i++) {
      if (v <= BELT[i][0]) {
        const a = BELT[i - 1], b = BELT[i];
        const t = sstep(a[0], b[0], v);
        return a[c] + (b[c] - a[c]) * t;
      }
    }
    return BELT[BELT.length - 1][c];
  }

  /** The macro transform: final = macroH + proceduralH * detailMul. */
  apply(x, z, proceduralH) {
    const m = this._macro(x, z, this._scratch);
    return m.h + proceduralH * m.mul;
  }

  _macro(x, z, out) {
    // Normalized map coords, clamped so the endless world continues its
    // edge belts beyond the 50 km square instead of breaking.
    let u = x / WORLD_SIZE + 0.5, v = 0.5 - z / WORLD_SIZE;
    if (u < 0) u = 0; else if (u > 1) u = 1;
    if (v < 0) v = 0; else if (v > 1) v = 1;

    // 1. Belt profile + longitudinal drift (2.5–7 km wavelengths).
    let base = this._beltAt(v, 0);
    const relief = this._beltAt(v, 1);
    let mul = this._beltAt(v, 2);
    const wall = this._beltAt(v, 3);
    base += (vnoise(x * 0.00015 + 3.7, z * 0.00015 - 8.1, S + 1) - 0.5) * base * 0.5;
    base += (vnoise(x * 0.0004 - 12.9, z * 0.0004 + 5.3, S + 2) - 0.5) * relief * 0.9;

    // 2. Ridge/valley relief: ridged noise, sharpened into walls in the
    // high belt, softened to swells in the plains.
    let rr = 1 - Math.abs(2 * vnoise(x * 0.00055 + 21.4, z * 0.00055 + 9.8, S + 3) - 1);
    rr = rr * rr * (1 + wall) - 0.42;                       // ridges AND valleys
    let rel = rr * relief;
    const r2 = 1 - Math.abs(2 * vnoise(x * 0.0013 - 7.7, z * 0.0013 + 15.2, S + 4) - 1);
    rel += (r2 * r2 - 0.4) * relief * 0.35;
    // Steep mountain walls: an extra cliff term where ridges crest in the
    // high belt (kept off the plains entirely).
    if (wall > 0.5) rel += sstep(0.55, 0.95, rr + 0.42) * relief * wall * 0.8;
    let h = base + rel;

    // Trans-Himalayan plateaus: soft height terracing (mesa country).
    if (v > 0.80) {
      const q = h / 16;
      const fq = q - Math.floor(q);
      const hq = (Math.floor(q) + sstep(0.4, 1, fq)) * 16;
      h += (hq - h) * 0.55 * sstep(0.80, 0.86, v);
    }

    // 3. Valley bowls (Kathmandu / Pokhara): flat floors, soft rims.
    for (let i = 0; i < this._bowls.length; i++) {
      const b = this._bowls[i];
      const du = (x - b.x) / b.rx, dv = (z - b.z) / b.rz;
      const d = Math.sqrt(du * du + dv * dv);
      if (d < 1.15) {
        const w = sstep(1.1, 0.6, d);
        const floor = b.floor +
          (vnoise(x * 0.002 + 9.1, z * 0.002 - 4.4, S + 5) - 0.5) * 6;
        h += (floor - h) * w;
        mul += (0.45 - mul) * w;
      }
    }

    // 4. River corridors: gradual cross-belt valleys down to the bed line.
    for (let i = 0; i < this._rivers.length; i++) {
      const pts = this._rivers[i];
      let best = 1e18, bedH = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        const abx = b.x - a.x, abz = b.z - a.z;
        const apx = x - a.x, apz = z - a.z;
        let t = (apx * abx + apz * abz) / (abx * abx + abz * abz);
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const dx = apx - abx * t, dz = apz - abz * t;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bedH = a.bed + (b.bed - a.bed) * t; }
      }
      const d = Math.sqrt(best);
      if (d < 750) {
        const w = sstep(750, 140, d);
        if (h > bedH) h += (bedH - h) * w * 0.9;
        mul += (Math.min(mul, 0.5) - mul) * w;
      }
    }

    // 5. Lake basins: flat floors slightly below their surroundings.
    for (let i = 0; i < this._lakes.length; i++) {
      const l = this._lakes[i];
      const dx = x - l.x, dz = z - l.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < l.r * 1.6) {
        const w = sstep(l.r * 1.5, l.r * 0.7, d);
        h += (Math.min(h, this._beltAt(0.5 - z / WORLD_SIZE, 0)) - 3 - h) * w * 0.85;
        mul += (0.3 - mul) * w;
      }
    }

    out.h = h;
    out.mul = Math.max(0.25, mul);
    return out;
  }
}

/** Anchor world positions (metres) for probes/tests: city + region centers. */
export function nepalAnchors() {
  const out = {};
  for (const c of CITIES) {
    out[c.id] = { x: (c.u - 0.5) * WORLD_SIZE, z: (0.5 - c.v) * WORLD_SIZE };
  }
  for (const r of REGIONS) {
    out[r.id] = { x: (r.center[0] - 0.5) * WORLD_SIZE, z: (0.5 - r.center[1]) * WORLD_SIZE };
  }
  return out;
}

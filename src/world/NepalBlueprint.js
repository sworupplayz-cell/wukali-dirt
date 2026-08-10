/**
 * NepalBlueprint (Phase W-3A) — deterministic geographic blueprint for the
 * future FIXED 50×50 km Nepal-inspired world.
 *
 * PURE DATA + tiny pure helpers. No terrain, no roads, no buildings, no
 * rendering, no dependencies (not even three.js) — nothing here touches the
 * current procedural world or any gameplay system. Later phases (terrain,
 * rivers, highways, cities, landmarks) will CONSUME this layer.
 *
 * Coordinate system
 *   Normalized map coords (u, v) in [0, 1]:
 *     u : west  (0) → east  (1)   — Mahakali border → Ilam/Mechi side
 *     v : south (0) → north (1)   — Terai plain     → Trans-Himalaya
 *   toMeters(u, v) maps onto the 50×50 km world, centered on the origin:
 *     x = (u - 0.5) * WORLD_SIZE   (east positive)
 *     z = (0.5 - v) * WORLD_SIZE   (south positive, matching “ride north =
 *                                   -z” used by the current world’s culture)
 *
 * Geography is REAL in its relationships (what is west of what, which river
 * drains which region, which belt a place sits in) but COMPRESSED in scale
 * and flattened into gameplay-friendly elevation bands (abstract metres for
 * the future fixed terrain, not real altitudes).
 *
 * South → North belts (v ranges):
 *   Terai 0–0.14 → Chure/Siwalik 0.14–0.22 → Mahabharat 0.22–0.32 →
 *   Middle Hills 0.32–0.58 (major valleys nested inside) →
 *   High Mountains 0.58–0.80 → Trans-Himalaya 0.80–1.0
 */

export const BLUEPRINT_VERSION = 1;
export const BLUEPRINT_SEED = 2081;      // fixed forever: the world is one place
export const WORLD_SIZE = 50000;         // metres (50 km square)

// ---- Regions ----------------------------------------------------------------
// type: 'plain' | 'hill-belt' | 'valley' | 'highland' | 'mountain' |
//       'trans-himalaya'
// band: [minY, maxY] gameplay elevation metres for the future fixed terrain.
// center/extent: normalized (u, v) ellipse the region occupies.
export const REGIONS = [
  // -- south → north belts (span the full width) ------------------------------
  { id: 'terai', name: 'Terai', type: 'plain', band: [0, 20],
    center: [0.50, 0.07], extent: [0.50, 0.07],
    neighbors: ['chure', 'chitwan', 'ilam'] },
  { id: 'chure', name: 'Chure / Siwalik', type: 'hill-belt', band: [15, 60],
    center: [0.50, 0.18], extent: [0.50, 0.04],
    neighbors: ['terai', 'mahabharat', 'chitwan'] },
  { id: 'mahabharat', name: 'Mahabharat Range', type: 'hill-belt', band: [40, 130],
    center: [0.50, 0.27], extent: [0.50, 0.05],
    neighbors: ['chure', 'middle-hills'] },
  { id: 'middle-hills', name: 'Middle Hills (Pahad)', type: 'hill-belt', band: [60, 200],
    center: [0.50, 0.45], extent: [0.50, 0.13],
    neighbors: ['mahabharat', 'kathmandu-valley', 'pokhara-valley', 'ilam',
      'rara', 'langtang', 'solukhumbu', 'manang', 'dolpo'] },

  // -- major valleys nested in the hills --------------------------------------
  { id: 'kathmandu-valley', name: 'Kathmandu Valley', type: 'valley', band: [70, 95],
    center: [0.63, 0.44], extent: [0.055, 0.045],
    neighbors: ['middle-hills', 'langtang'] },
  { id: 'pokhara-valley', name: 'Pokhara Valley', type: 'valley', band: [55, 80],
    center: [0.44, 0.46], extent: [0.055, 0.045],
    neighbors: ['middle-hills', 'manang'] },
  { id: 'chitwan', name: 'Chitwan (Inner Terai)', type: 'plain', band: [5, 30],
    center: [0.54, 0.15], extent: [0.09, 0.055],
    neighbors: ['terai', 'chure', 'mahabharat'] },
  { id: 'ilam', name: 'Ilam', type: 'hill-belt', band: [50, 150],
    center: [0.93, 0.30], extent: [0.06, 0.10],
    neighbors: ['terai', 'middle-hills', 'solukhumbu'] },
  { id: 'rara', name: 'Rara', type: 'highland', band: [130, 220],
    center: [0.17, 0.60], extent: [0.07, 0.07],
    neighbors: ['middle-hills', 'dolpo'] },

  // -- high mountain regions ---------------------------------------------------
  { id: 'langtang', name: 'Langtang', type: 'mountain', band: [150, 380],
    center: [0.64, 0.66], extent: [0.08, 0.09],
    neighbors: ['kathmandu-valley', 'middle-hills', 'manang', 'solukhumbu'] },
  { id: 'solukhumbu', name: 'Solukhumbu / Everest', type: 'mountain', band: [170, 400],
    center: [0.80, 0.68], extent: [0.10, 0.11],
    neighbors: ['middle-hills', 'langtang', 'ilam'] },
  { id: 'manang', name: 'Manang', type: 'mountain', band: [160, 380],
    center: [0.45, 0.68], extent: [0.08, 0.08],
    neighbors: ['pokhara-valley', 'middle-hills', 'langtang', 'mustang'] },

  // -- trans-Himalayan north ----------------------------------------------------
  { id: 'mustang', name: 'Mustang', type: 'trans-himalaya', band: [200, 340],
    center: [0.42, 0.87], extent: [0.09, 0.12],
    neighbors: ['manang', 'dolpo'] },
  { id: 'dolpo', name: 'Dolpo', type: 'trans-himalaya', band: [190, 330],
    center: [0.24, 0.82], extent: [0.11, 0.13],
    neighbors: ['mustang', 'rara', 'middle-hills'] },
];

// ---- Major city anchors -------------------------------------------------------
export const CITIES = [
  { id: 'kathmandu', name: 'Kathmandu', u: 0.63, v: 0.44, region: 'kathmandu-valley' },
  { id: 'pokhara', name: 'Pokhara', u: 0.44, v: 0.46, region: 'pokhara-valley' },
  { id: 'bharatpur', name: 'Bharatpur', u: 0.55, v: 0.14, region: 'chitwan' },
  { id: 'butwal', name: 'Butwal', u: 0.42, v: 0.13, region: 'terai' },
  { id: 'biratnagar', name: 'Biratnagar', u: 0.88, v: 0.05, region: 'terai' },
  { id: 'nepalgunj', name: 'Nepalgunj', u: 0.16, v: 0.07, region: 'terai' },
];

// ---- Major rivers ---------------------------------------------------------------
// Polylines run headwaters → plains (north → south), normalized (u, v).
export const RIVERS = [
  { id: 'mahakali', name: 'Mahakali',
    points: [[0.03, 0.72], [0.04, 0.45], [0.03, 0.20], [0.02, 0.04]] },
  { id: 'karnali', name: 'Karnali',
    points: [[0.24, 0.82], [0.19, 0.62], [0.15, 0.38], [0.15, 0.18], [0.16, 0.06]] },
  { id: 'narayani', name: 'Narayani (Gandaki)',
    points: [[0.42, 0.88], [0.44, 0.68], [0.41, 0.48], [0.48, 0.28], [0.53, 0.15], [0.52, 0.05]] },
  { id: 'rapti', name: 'Rapti',
    points: [[0.66, 0.30], [0.60, 0.20], [0.56, 0.15], [0.54, 0.145]] }, // joins Narayani at Chitwan
  { id: 'bagmati', name: 'Bagmati',
    points: [[0.64, 0.50], [0.63, 0.44], [0.61, 0.30], [0.60, 0.12], [0.61, 0.03]] },
  { id: 'koshi', name: 'Koshi',
    points: [[0.80, 0.72], [0.78, 0.52], [0.80, 0.32], [0.84, 0.14], [0.86, 0.04]] },
];

// ---- Major lakes -----------------------------------------------------------------
export const LAKES = [
  { id: 'phewa', name: 'Phewa Tal', u: 0.425, v: 0.45, region: 'pokhara-valley', size: 3 },
  { id: 'begnas', name: 'Begnas Tal', u: 0.465, v: 0.465, region: 'pokhara-valley', size: 2 },
  { id: 'rara', name: 'Rara Tal', u: 0.17, v: 0.61, region: 'rara', size: 3 },
  { id: 'phoksundo', name: 'Shey Phoksundo', u: 0.25, v: 0.78, region: 'dolpo', size: 2 },
  { id: 'gokyo', name: 'Gokyo Tsho', u: 0.79, v: 0.72, region: 'solukhumbu', size: 1 },
  { id: 'mai-pokhari', name: 'Mai Pokhari', u: 0.93, v: 0.33, region: 'ilam', size: 1 },
  { id: 'beeshazar', name: 'Beeshazari Tal', u: 0.55, v: 0.16, region: 'chitwan', size: 1 },
  { id: 'ghodaghodi', name: 'Ghodaghodi Tal', u: 0.09, v: 0.08, region: 'terai', size: 1 },
];

// ---- Helpers (pure, allocation-light) ---------------------------------------------

/** Normalized (u,v) → world metres { x, z } on the 50×50 km map. */
export function toMeters(u, v) {
  return { x: (u - 0.5) * WORLD_SIZE, z: (0.5 - v) * WORLD_SIZE };
}

/** World metres → normalized { u, v }. */
export function toNormalized(x, z) {
  return { u: x / WORLD_SIZE + 0.5, v: 0.5 - z / WORLD_SIZE };
}

/** Region record by id (or null). */
export function getRegion(id) {
  for (const r of REGIONS) if (r.id === id) return r;
  return null;
}

/**
 * The most specific region containing (u,v): nested valleys/areas win over
 * the broad belts they sit inside (smaller extent = more specific).
 */
export function regionAt(u, v) {
  let best = null, bestArea = Infinity;
  for (const r of REGIONS) {
    const du = (u - r.center[0]) / r.extent[0];
    const dv = (v - r.center[1]) / r.extent[1];
    if (du * du + dv * dv > 1) continue;
    const area = r.extent[0] * r.extent[1];
    if (area < bestArea) { bestArea = area; best = r; }
  }
  return best;
}

/** Stable FNV-1a checksum over the whole blueprint (determinism guard). */
export function blueprintChecksum() {
  const s = JSON.stringify([BLUEPRINT_VERSION, BLUEPRINT_SEED, WORLD_SIZE,
    REGIONS, CITIES, RIVERS, LAKES]);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

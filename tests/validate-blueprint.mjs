// W-3A validation: import the blueprint standalone (dependency-free) and
// verify completeness + determinism. Run: node tests/validate-blueprint.mjs
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { copyFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';

const here = dirname(fileURLToPath(import.meta.url));
// The repo is CJS-typed for node, so import the module via an .mjs copy —
// this also proves the file has zero dependencies.
const tmp = mkdtempSync(join(tmpdir(), 'nbp-'));
copyFileSync(join(here, '../src/world/NepalBlueprint.js'), join(tmp, 'nb1.mjs'));
copyFileSync(join(here, '../src/world/NepalBlueprint.js'), join(tmp, 'nb2.mjs'));
const A = await import(join(tmp, 'nb1.mjs'));
const B = await import(join(tmp, 'nb2.mjs')); // independent second instance

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`);
  ok ? pass++ : fail++;
};

const need = (list, ids, key = 'id') => ids.filter((id) => !list.some((r) => r[key] === id));

check('Module imports with no dependencies', !!A.REGIONS);
check('Version + seed + size constants', A.BLUEPRINT_VERSION === 1 &&
  A.BLUEPRINT_SEED === 2081 && A.WORLD_SIZE === 50000);

const wantRegions = ['terai', 'chure', 'mahabharat', 'middle-hills',
  'kathmandu-valley', 'pokhara-valley', 'chitwan', 'mustang', 'manang',
  'solukhumbu', 'langtang', 'dolpo', 'rara', 'ilam'];
check('All 14 required regions exist', need(A.REGIONS, wantRegions).length === 0,
  `${A.REGIONS.length} regions`);

const wantCities = ['kathmandu', 'pokhara', 'bharatpur', 'butwal', 'biratnagar', 'nepalgunj'];
check('All 6 city anchors exist', need(A.CITIES, wantCities).length === 0);

const wantRivers = ['koshi', 'narayani', 'karnali', 'mahakali', 'bagmati', 'rapti'];
check('All 6 rivers exist', need(A.RIVERS, wantRivers).length === 0);

const wantLakes = ['phewa', 'rara', 'phoksundo', 'gokyo', 'begnas',
  'mai-pokhari', 'beeshazar', 'ghodaghodi'];
check('All 8 lakes exist', need(A.LAKES, wantLakes).length === 0);

// Coordinates all in [0,1]; bands sane; neighbors resolve.
let coordsOk = true, bandsOk = true, neighborsOk = true;
for (const r of A.REGIONS) {
  const [u, v] = r.center;
  if (u < 0 || u > 1 || v < 0 || v > 1) coordsOk = false;
  if (!(r.band[0] < r.band[1])) bandsOk = false;
  for (const n of r.neighbors) if (!A.getRegion(n)) neighborsOk = false;
}
for (const c of A.CITIES) if (c.u < 0 || c.u > 1 || c.v < 0 || c.v > 1) coordsOk = false;
for (const l of A.LAKES) if (l.u < 0 || l.u > 1 || l.v < 0 || l.v > 1) coordsOk = false;
for (const rv of A.RIVERS) for (const [u, v] of rv.points) {
  if (u < 0 || u > 1 || v < 0 || v > 1) coordsOk = false;
}
check('All coordinates within [0,1]', coordsOk);
check('Elevation bands are ordered', bandsOk);
check('Every neighbor id resolves', neighborsOk);

// City/lake region references resolve.
let refsOk = true;
for (const c of A.CITIES) if (!A.getRegion(c.region)) refsOk = false;
for (const l of A.LAKES) if (!A.getRegion(l.region)) refsOk = false;
check('City/lake region references resolve', refsOk);

// Rivers flow north → south (v decreasing overall) and reach the plains.
let flowOk = true;
for (const rv of A.RIVERS) {
  const p = rv.points;
  if (p[0][1] <= p[p.length - 1][1]) flowOk = false;
  if (rv.id !== 'rapti' && p[p.length - 1][1] > 0.1) flowOk = false; // Rapti ends at its Narayani confluence
}
check('Rivers flow north to south into the plains', flowOk);

// Geographic sanity: real relative positions.
const g = (id, list) => list.find((r) => r.id === id);
check('West-to-east city order (Nepalgunj < Butwal < Kathmandu < Biratnagar)',
  g('nepalgunj', A.CITIES).u < g('butwal', A.CITIES).u &&
  g('butwal', A.CITIES).u < g('kathmandu', A.CITIES).u &&
  g('kathmandu', A.CITIES).u < g('biratnagar', A.CITIES).u);
check('Pokhara west of Kathmandu', g('pokhara', A.CITIES).u < g('kathmandu', A.CITIES).u);
check('South-to-north belt order (Terai < Chure < Mahabharat < Hills < Mustang)',
  g('terai', A.REGIONS).center[1] < g('chure', A.REGIONS).center[1] &&
  g('chure', A.REGIONS).center[1] < g('mahabharat', A.REGIONS).center[1] &&
  g('mahabharat', A.REGIONS).center[1] < g('middle-hills', A.REGIONS).center[1] &&
  g('middle-hills', A.REGIONS).center[1] < g('mustang', A.REGIONS).center[1]);

// Determinism: two independent module instances agree exactly.
check('Checksum deterministic across imports',
  A.blueprintChecksum() === B.blueprintChecksum(), `0x${A.blueprintChecksum().toString(16)}`);
const m1 = A.toMeters(0.63, 0.44), m2 = B.toMeters(0.63, 0.44);
check('toMeters deterministic + in-bounds', m1.x === m2.x && m1.z === m2.z &&
  Math.abs(m1.x) <= 25000 && Math.abs(m1.z) <= 25000,
  `Kathmandu -> (${m1.x}, ${m1.z}) m`);

// regionAt: nested specificity + belt fallback.
check('regionAt(Kathmandu) = kathmandu-valley',
  A.regionAt(0.63, 0.44)?.id === 'kathmandu-valley');
check('regionAt(mid hills, away from valleys) = middle-hills',
  A.regionAt(0.53, 0.50)?.id === 'middle-hills');
check('regionAt(far south) = terai', A.regionAt(0.30, 0.05)?.id === 'terai');

console.log(`\n${pass}/${pass + fail} blueprint checks passed`);
process.exit(fail ? 1 : 0);

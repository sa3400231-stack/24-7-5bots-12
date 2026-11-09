'use strict';
/*
 * blueprints.js — pure parametric blueprint generators.
 * Coordinates are RELATIVE to an origin (0,0,0). No mineflayer dependency.
 * Export contract:
 *   list() -> [{id, name, size:[w,h,d], description, category}]
 *   generate(id, opts={}) -> { id, name, size:[w,h,d], blocks:[{x,y,z,name}] }
 *     blocks sorted bottom-up (y asc, then x, then z).
 */

// ---------- Seeded RNG (deterministic per opts.seed) ----------
function mulberry32(a) {
  a = a | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function makeRng(opts, salt) {
  const seed = (opts && typeof opts.seed === 'number' ? opts.seed : 12345) + (salt | 0);
  return mulberry32(seed);
}

// ---------- Block set (dedup by coordinate; later write wins) ----------
function BlockSet() { this.map = new Map(); }
BlockSet.prototype._k = function (x, y, z) { return (x | 0) + ',' + (y | 0) + ',' + (z | 0); };
BlockSet.prototype.add = function (x, y, z, name) { this.map.set(this._k(x, y, z), name); };
BlockSet.prototype.has = function (x, y, z) { return this.map.has(this._k(x, y, z)); };
BlockSet.prototype.get = function (x, y, z) { return this.map.get(this._k(x, y, z)); };
BlockSet.prototype.toArray = function () {
  const arr = [];
  for (const [k, name] of this.map) {
    const c = k.split(',');
    arr.push({ x: +c[0], y: +c[1], z: +c[2], name: name });
  }
  arr.sort(function (a, b) { return a.y - b.y || a.x - b.x || a.z - b.z; });
  return arr;
};
function extentsOf(blocks) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const b of blocks) {
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
  }
  return [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
}

// ---------- Geometry helpers ----------
function box(bs, x1, y1, z1, x2, y2, z2, name) {
  for (let y = y1; y <= y2; y++)
    for (let x = x1; x <= x2; x++)
      for (let z = z1; z <= z2; z++) bs.add(x, y, z, name);
}
function hollowBox(bs, x1, y1, z1, x2, y2, z2, name, opts) {
  opts = opts || {};
  const floor = opts.floor !== false;
  const ceiling = opts.ceiling !== false;
  for (let y = y1; y <= y2; y++) {
    const isFloor = y === y1 && floor;
    const isCeil = y === y2 && ceiling;
    for (let x = x1; x <= x2; x++) {
      for (let z = z1; z <= z2; z++) {
        const edge = (x === x1 || x === x2 || z === z1 || z === z2);
        if (edge || isFloor || isCeil) bs.add(x, y, z, name);
      }
    }
  }
}
function rectFill(bs, x1, z1, x2, z2, y, name) {
  for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) bs.add(x, y, z, name);
}
function filledCircleXZ(bs, cx, cz, y, r, name) {
  for (let x = cx - r; x <= cx + r; x++)
    for (let z = cz - r; z <= cz + r; z++)
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) <= r * r) bs.add(x, y, z, name);
}
function ringXZ(bs, cx, cz, y, rInner, rOuter, name) {
  for (let x = cx - rOuter; x <= cx + rOuter; x++)
    for (let z = cz - rOuter; z <= cz + rOuter; z++) {
      const d2 = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d2 <= rOuter * rOuter && d2 >= rInner * rInner) bs.add(x, y, z, name);
    }
}
function circlePointsXY(cx, cy, r) {
  const pts = [];
  const seen = new Set();
  const steps = 360;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = Math.round(cx + r * Math.cos(a));
    const y = Math.round(cy + r * Math.sin(a));
    const k = x + ',' + y;
    if (!seen.has(k)) { seen.add(k); pts.push({ x: x, y: y, a: a }); }
  }
  return pts;
}
function ovalPointsXZ(cx, cz, rx, rz) {
  const pts = [];
  const seen = new Set();
  const steps = 360;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const x = Math.round(cx + rx * Math.cos(a));
    const z = Math.round(cz + rz * Math.sin(a));
    const k = x + ',' + z;
    if (!seen.has(k)) { seen.add(k); pts.push({ x: x, z: z, a: a }); }
  }
  return pts;
}
function line3d(bs, x1, y1, z1, x2, y2, z2, name) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), Math.abs(z2 - z1), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    bs.add(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t), Math.round(z1 + (z2 - z1) * t), name);
  }
}
function cylinder(bs, cx, cz, y1, y2, r, name) {
  for (let y = y1; y <= y2; y++) filledCircleXZ(bs, cx, cz, y, r, name);
}
// A simple blocky tree: trunk + leaves blob.
function tree(bs, x, y, z, trunkBlock, leafBlock, h, rng) {
  for (let i = 0; i < h; i++) bs.add(x, y + i, z, trunkBlock);
  const top = y + h;
  for (const dy of [-2, -1]) {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue; // trunk
      const corner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
      if (corner && rng() < 0.55) continue;
      bs.add(x + dx, top + dy, z + dz, leafBlock);
    }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
    bs.add(x + dx, top, z + dz, leafBlock);
  }
  bs.add(x, top + 1, z, leafBlock);
  if (rng() < 0.5) bs.add(x + 1, top + 1, z, leafBlock);
  if (rng() < 0.5) bs.add(x - 1, top + 1, z, leafBlock);
  if (rng() < 0.5) bs.add(x, top + 1, z + 1, leafBlock);
  if (rng() < 0.5) bs.add(x, top + 1, z - 1, leafBlock);
}

// Small lamp post helper (fence + lantern), used by park.
function lampPost(bs, x, y, z) {
  bs.add(x, y, z, 'oak_fence');
  bs.add(x, y + 1, z, 'oak_fence');
  bs.add(x, y + 2, z, 'oak_fence');
  bs.add(x, y + 3, z, 'lantern');
}
// Small bench helper (oak_slab seat + oak_fence arms), used by park.
function bench(bs, x, y, z) {
  // seat 3 long along +x
  bs.add(x, y, z, 'oak_slab');
  bs.add(x + 1, y, z, 'oak_slab');
  bs.add(x + 2, y, z, 'oak_slab');
  bs.add(x, y + 1, z, 'oak_fence');     // arm
  bs.add(x + 2, y + 1, z, 'oak_fence'); // arm
  bs.add(x + 1, y + 1, z, 'oak_fence'); // backrest
}

// ============================================================
//                       BLUEPRINT GENERATORS
// ============================================================

// ---------- 1. modern_house ~10x7x8 ----------
function genModernHouse(opts) {
  const bs = new BlockSet();
  const W = 10, D = 8, H = 7;
  // foundation
  rectFill(bs, 0, 0, W - 1, D - 1, 0, 'smooth_stone');
  // interior floor
  rectFill(bs, 1, 1, W - 2, D - 2, 1, 'oak_planks');
  // walls y=1..4
  hollowBox(bs, 0, 1, 0, W - 1, 4, D - 1, 'white_concrete', { floor: false, ceiling: false });
  // corner accents
  for (const [cx, cz] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]])
    for (let y = 1; y <= 4; y++) bs.add(cx, y, cz, 'oak_planks');
  // windows (glass) on front (z=0) and back (z=D-1), y=2..3
  for (let y = 2; y <= 3; y++) {
    for (let x = 2; x <= W - 3; x++) {
      if (x === 4 || x === 5) continue; // door gap on front
      bs.add(x, y, 0, 'glass');
      bs.add(x, y, D - 1, 'glass');
    }
  }
  // side windows
  for (let y = 2; y <= 3; y++) {
    for (let z = 2; z <= D - 3; z++) {
      bs.add(0, y, z, 'glass');
      bs.add(W - 1, y, z, 'glass');
    }
  }
  // door opening (leave air) at front x=4..5, y=1..2 — simply don't place wall there; ensure cleared
  bs.add(4, 1, 0, 'oak_planks'); // door frame side
  bs.add(5, 1, 0, 'oak_planks');
  // flat roof + parapet
  rectFill(bs, 0, 0, W - 1, D - 1, 5, 'gray_concrete');
  for (let x = 0; x <= W - 1; x++) { bs.add(x, 6, 0, 'glass_pane'); bs.add(x, 6, D - 1, 'glass_pane'); }
  for (let z = 0; z <= D - 1; z++) { bs.add(0, 6, z, 'glass_pane'); bs.add(W - 1, 6, z, 'glass_pane'); }
  // roof skylight
  rectFill(bs, 3, 3, 6, 5, 5, 'glass');
  return { bs: bs, name: 'Modern House' };
}

// ---------- 2. skyscraper_tower ~12x32x12 ----------
function genSkyscraper(opts) {
  const bs = new BlockSet();
  const S = 12, H = 29; // walls y=1..28, roof y=29, spire y=30..32
  rectFill(bs, 0, 0, S - 1, S - 1, 0, 'smooth_stone');
  // frame: corners + vertical mullions every 3 blocks = concrete; glass between
  for (let y = 1; y <= H - 1; y++) {
    for (let x = 0; x <= S - 1; x++) {
      for (let z = 0; z <= S - 1; z++) {
        const edge = (x === 0 || x === S - 1 || z === 0 || z === S - 1);
        if (!edge) continue;
        const frame = (x % 3 === 0) || (z % 3 === 0) || (x === S - 1) || (z === S - 1);
        bs.add(x, y, z, frame ? 'gray_concrete' : 'glass');
      }
    }
  }
  // floor slabs every 5 levels
  for (let y = 5; y <= H - 1; y += 5) rectFill(bs, 1, 1, S - 2, S - 2, y, 'smooth_stone');
  // entrance (front z=0) glass lobby y=1..2
  for (let y = 1; y <= 2; y++) for (let x = 3; x <= 8; x++) bs.add(x, y, 0, 'glass');
  // roof
  rectFill(bs, 0, 0, S - 1, S - 1, H, 'gray_concrete');
  // roof equipment + antenna
  rectFill(bs, 3, 3, 8, 8, H + 1, 'iron_block');
  for (let y = H + 2; y <= H + 3; y++) bs.add(5, y, 5, 'iron_bars');
  bs.add(5, H + 4, 5, 'redstone_block'); // beacon-like tip
  return { bs: bs, name: 'Skyscraper Tower' };
}

// ---------- 3. road_segment ~16x2x5 ----------
function genRoadSegment(opts) {
  const bs = new BlockSet();
  const L = 16; // x length
  // road bed y=0, z=1..3 (3 lanes) asphalt
  for (let x = 0; x <= L - 1; x++) {
    bs.add(x, 0, 1, 'black_concrete');
    bs.add(x, 0, 2, 'black_concrete');
    bs.add(x, 0, 3, 'black_concrete');
  }
  // dashed yellow center line at z=2
  for (let x = 0; x <= L - 1; x += 2) bs.add(x, 0, 2, 'yellow_concrete');
  // white edge lines at z=1 and z=3
  for (let x = 0; x <= L - 1; x++) { bs.add(x, 0, 1, 'white_concrete'); bs.add(x, 0, 3, 'white_concrete'); }
  // re-apply asphalt under center? no — center dashed stays. Edge lines stay.
  // raised curbs y=1 at z=0 and z=4
  for (let x = 0; x <= L - 1; x++) { bs.add(x, 1, 0, 'smooth_stone'); bs.add(x, 1, 4, 'smooth_stone'); }
  return { bs: bs, name: 'Road Segment' };
}

// ---------- 4. road_grid 2x2 intersections ~32x1x32 ----------
function genRoadGrid(opts) {
  const bs = new BlockSet();
  const S = 32;
  const vRoads = [10, 21]; // x centers, width 3: x-1..x+1
  const hRoads = [10, 21]; // z centers
  // asphalt base for all road cells
  for (let x = 0; x <= S - 1; x++) for (let z = 0; z <= S - 1; z++) {
    const onV = vRoads.some(function (c) { return Math.abs(x - c) <= 1; });
    const onH = hRoads.some(function (c) { return Math.abs(z - c) <= 1; });
    if (onV || onH) bs.add(x, 0, z, 'black_concrete');
  }
  // yellow dashed center lines
  for (const c of vRoads) for (let z = 0; z <= S - 1; z += 2) bs.add(c, 0, z, 'yellow_concrete');
  for (const c of hRoads) for (let x = 0; x <= S - 1; x += 2) bs.add(x, 0, c, 'yellow_concrete');
  // white stop lines before each intersection
  for (const vc of vRoads) for (const hc of hRoads) {
    for (let d = -4; d <= -2; d++) { bs.add(vc + d, 0, hc - 2, 'white_concrete'); bs.add(vc + d, 0, hc + 2, 'white_concrete'); }
    for (let d = -4; d <= -2; d++) { bs.add(vc - 2, 0, hc + d, 'white_concrete'); bs.add(vc + 2, 0, hc + d, 'white_concrete'); }
  }
  return { bs: bs, name: 'Road Grid' };
}

// ---------- 5. park ~20x8x20 ----------
function genPark(opts) {
  const bs = new BlockSet();
  const rng = makeRng(opts, 7);
  const S = 20;
  // grass base y=0
  rectFill(bs, 0, 0, S - 1, S - 1, 0, 'grass_block');
  // winding gravel path (horizontal + vertical cross with offsets)
  for (let x = 0; x <= S - 1; x++) { const z = 9 + Math.round(Math.sin(x * 0.5) * 2); bs.add(x, 0, z, 'gravel'); bs.add(x, 0, z + 1, 'gravel'); }
  for (let z = 0; z <= S - 1; z++) { const x = 10 + Math.round(Math.cos(z * 0.4) * 2); bs.add(x, 0, z, 'gravel'); bs.add(x + 1, 0, z, 'gravel'); }
  // pond with water
  for (let x = 2; x <= 5; x++) for (let z = 2; z <= 5; z++) {
    const d2 = (x - 3.5) * (x - 3.5) + (z - 3.5) * (z - 3.5);
    if (d2 <= 4.5) { bs.add(x, 0, z, 'water'); if (d2 <= 2.5) bs.add(x, 1, z, 'water'); }
  }
  // trees: 2 oak, 2 birch
  tree(bs, 3, 1, 14, 'oak_log', 'oak_leaves', 4, rng);
  tree(bs, 16, 1, 3, 'oak_log', 'oak_leaves', 5, rng);
  tree(bs, 15, 1, 15, 'birch_log', 'birch_leaves', 5, rng);
  tree(bs, 6, 1, 17, 'birch_log', 'birch_leaves', 4, rng);
  // flower beds (short flowers only)
  const flowers = ['poppy', 'dandelion', 'blue_orchid', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'allium'];
  const beds = [[9, 3, 12, 5], [14, 9, 17, 12], [3, 9, 5, 12]];
  for (const [x1, z1, x2, z2] of beds) {
    for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) {
      if (rng() < 0.75) {
        bs.add(x, 0, z, 'grass_block');
        bs.add(x, 1, z, flowers[Math.floor(rng() * flowers.length)]);
      }
    }
  }
  // lamp posts
  lampPost(bs, 2, 1, 9);
  lampPost(bs, 17, 1, 9);
  lampPost(bs, 10, 1, 2);
  lampPost(bs, 10, 1, 17);
  // benches
  bench(bs, 7, 1, 7);
  bench(bs, 13, 1, 13);
  // central stone plaza around path crossing
  rectFill(bs, 8, 8, 11, 11, 0, 'stone');
  return { bs: bs, name: 'Park' };
}

// ---------- 6. ferris_wheel ~17x18x4 ----------
function genFerrisWheel(opts) {
  const bs = new BlockSet();
  const cx = 8, cy = 9, R = 8;
  // base platform
  rectFill(bs, cx - R, 0, cx + R, 3, 0, 'smooth_stone');
  // A-frame supports on z=0 and z=3
  for (const z of [0, 3]) {
    line3d(bs, cx - 5, 0, z, cx, cy - 1, z, 'stone_bricks');
    line3d(bs, cx + 5, 0, z, cx, cy - 1, z, 'stone_bricks');
  }
  // axle along z through center
  for (let z = 0; z <= 3; z++) bs.add(cx, cy, z, 'oak_log');
  // rim (two parallel circles at z=1 and z=2)
  const rim = circlePointsXY(cx, cy, R);
  for (const p of rim) { bs.add(p.x, p.y, 1, 'oak_fence'); bs.add(p.x, p.y, 2, 'oak_fence'); }
  // spokes at 8 angles
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const ex = Math.round(cx + R * Math.cos(a));
    const ey = Math.round(cy + R * Math.sin(a));
    line3d(bs, cx, cy, 1, ex, ey, 1, 'oak_fence');
    line3d(bs, cx, cy, 2, ex, ey, 2, 'oak_fence');
  }
  // cabins (colored wool) hanging below rim at 8 positions
  const colors = ['red_wool', 'orange_wool', 'yellow_wool', 'lime_wool', 'light_blue_wool', 'blue_wool', 'magenta_wool', 'pink_wool'];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.round(cx + R * Math.cos(a));
    const y = Math.round(cy + R * Math.sin(a));
    bs.add(x, y - 1, 1, colors[i]);
    bs.add(x, y - 1, 2, colors[i]);
  }
  return { bs: bs, name: 'Ferris Wheel' };
}

// ---------- 7. roller_coaster ~19x8x13 ----------
function genRollerCoaster(opts) {
  const bs = new BlockSet();
  const cx = 9, cz = 7, rx = 7, rz = 5;
  const pts = ovalPointsXZ(cx, cz, rx, rz);
  // compute height profile (two hills) and rail types
  const ys = [];
  for (const p of pts) {
    const hill = 0.5 - 0.5 * Math.cos(2 * p.a); // 0..1
    ys.push(2 + Math.round(3 * hill));
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const y = ys[i];
    const yNext = ys[(i + 1) % pts.length];
    let rail = 'rail';
    if (i === 0) rail = 'detector_rail';
    else if (yNext > y) rail = 'powered_rail';
    else if (i % 5 === 0) rail = 'powered_rail'; // occasional booster
    bs.add(p.x, y, p.z, rail);
    // mandatory solid block directly below rail
    bs.add(p.x, y - 1, p.z, 'smooth_stone');
    // support pillar from ground every 3rd point
    if (i % 3 === 0 && y - 2 >= 1) {
      for (let yy = 0; yy <= y - 2; yy++) bs.add(p.x, yy, p.z, 'stone_bricks');
    }
  }
  // station platform beside the start point (pts[0] = angle 0 = eastmost)
  const sp = pts[0];
  rectFill(bs, sp.x, sp.z + 1, sp.x + 4, sp.z + 3, 1, 'smooth_stone'); // platform
  // station roof + posts
  for (const [px, pz] of [[sp.x, sp.z + 1], [sp.x + 4, sp.z + 1], [sp.x, sp.z + 3], [sp.x + 4, sp.z + 3]]) {
    for (let y = 1; y <= 3; y++) bs.add(px, y, pz, 'oak_fence');
  }
  rectFill(bs, sp.x, sp.z + 1, sp.x + 4, sp.z + 3, 4, 'oak_planks');
  // platform railing
  for (let x = sp.x; x <= sp.x + 4; x++) { bs.add(x, 2, sp.z + 3, 'oak_fence'); }
  for (let z = sp.z + 1; z <= sp.z + 3; z++) { bs.add(sp.x + 4, 2, z, 'oak_fence'); }
  return { bs: bs, name: 'Roller Coaster' };
}

// ---------- 8. bridge ~24x9x5 ----------
function genBridge(opts) {
  const bs = new BlockSet();
  const L = 24, W = 5;
  // water gap below deck (y=0..3) between towers
  for (let x = 7; x <= 16; x++) for (let z = 0; z <= W - 1; z++) {
    bs.add(x, 0, z, 'water');
    bs.add(x, 1, z, 'water');
    bs.add(x, 2, z, 'water');
    bs.add(x, 3, z, 'blue_concrete'); // riverbed
  }
  // abutments at both ends (stone)
  box(bs, 0, 0, 0, 1, 4, W - 1, 'stone_bricks');
  box(bs, L - 2, 0, 0, L - 1, 4, W - 1, 'stone_bricks');
  // deck at y=4
  rectFill(bs, 0, 0, L - 1, W - 1, 4, 'smooth_stone');
  // deck surface planks
  rectFill(bs, 1, 1, L - 2, W - 2, 5, 'oak_planks');
  // fence rails along deck edges at y=5..6
  for (let x = 1; x <= L - 2; x++) { bs.add(x, 5, 0, 'oak_fence'); bs.add(x, 5, W - 1, 'oak_fence'); }
  // two towers (stone) at x=5 and x=18, two pillars each (z=1 and z=3)
  for (const tx of [5, 18]) {
    for (const tz of [1, 3]) for (let y = 4; y <= 8; y++) bs.add(tx, y, tz, 'stone_bricks');
    // crossbeam at top
    for (let z = 1; z <= 3; z++) bs.add(tx, 8, z, 'stone_bricks');
    bs.add(tx, 9, 2, 'glowstone'); // lamp on top
  }
  // suspension cables (chain) from tower tops down to deck ends
  line3d(bs, 5, 8, 2, 1, 5, 2, 'chain');
  line3d(bs, 5, 8, 2, 1, 5, 2, 'chain');
  line3d(bs, 18, 8, 2, L - 2, 5, 2, 'chain');
  line3d(bs, 18, 8, 2, L - 2, 5, 2, 'chain');
  // vertical suspenders (chain) from cable line to deck (approx)
  for (let x = 2; x <= 4; x++) bs.add(x, 5, 2, 'chain');
  for (let x = 19; x <= 21; x++) bs.add(x, 5, 2, 'chain');
  return { bs: bs, name: 'Suspension Bridge' };
}

// ---------- 9. fountain ~9x5x9 ----------
function genFountain(opts) {
  const bs = new BlockSet();
  const c = 4, R = 4;
  // base solid stone
  filledCircleXZ(bs, c, c, 0, R, 'stone');
  // basin rim at y=1 (ring r=3..4) stone_bricks
  ringXZ(bs, c, c, 1, 3, 4, 'stone_bricks');
  // water inside basin y=1 (r<3) and y=2 (r<2)
  filledCircleXZ(bs, c, c, 1, 2, 'water');
  filledCircleXZ(bs, c, c, 2, 1, 'water');
  // central pillar
  bs.add(c, 1, c, 'quartz_block');
  bs.add(c, 2, c, 'quartz_block');
  bs.add(c, 3, c, 'quartz_pillar');
  bs.add(c, 4, c, 'glowstone');
  // decorative outer ring of glowstone at y=0 edge
  ringXZ(bs, c, c, 0, 4, 4, 'glowstone');
  return { bs: bs, name: 'Fountain' };
}

// ---------- 10. modern_apartment_block ~16x14x12 ----------
function genApartment(opts) {
  const bs = new BlockSet();
  const W = 16, D = 10, H = 13; // building walls z=2..11 (depth 10), balconies z=0..1
  // foundation
  rectFill(bs, 0, 0, W - 1, 11, 0, 'smooth_stone');
  // ground floor lobby (full-ish)
  hollowBox(bs, 2, 1, 2, W - 3, 1, 11, 'white_concrete', { floor: false, ceiling: false });
  for (let x = 5; x <= 10; x++) { bs.add(x, 1, 2, 'glass'); bs.add(x, 2, 2, 'glass'); }
  // upper floors walls y=2..12
  hollowBox(bs, 2, 2, 2, W - 3, 12, 11, 'white_concrete', { floor: false, ceiling: false });
  // corner accents
  for (const [cx, cz] of [[2, 2], [W - 3, 2], [2, 11], [W - 3, 11]])
    for (let y = 2; y <= 12; y++) bs.add(cx, y, cz, 'gray_concrete');
  // window pattern on front (z=2) and back (z=11): glass bays
  for (let y = 3; y <= 11; y += 3) {
    for (let x = 3; x <= W - 4; x += 3) {
      bs.add(x, y, 2, 'glass'); bs.add(x + 1, y, 2, 'glass');
      bs.add(x, y, 11, 'glass'); bs.add(x + 1, y, 11, 'glass');
      bs.add(x, y + 1, 2, 'glass'); bs.add(x + 1, y + 1, 2, 'glass');
      bs.add(x, y + 1, 11, 'glass'); bs.add(x + 1, y + 1, 11, 'glass');
    }
  }
  // side windows
  for (let y = 3; y <= 11; y += 3) for (let z = 4; z <= 9; z += 3) {
    bs.add(2, y, z, 'glass'); bs.add(W - 3, y, z, 'glass');
  }
  // floor slabs every 3
  for (let y = 3; y <= 12; y += 3) rectFill(bs, 3, 3, W - 4, 10, y, 'smooth_stone');
  // balconies on front (z=0..1) at each floor level y=3,6,9,12
  for (const fy of [3, 6, 9, 12]) {
    rectFill(bs, 3, 0, W - 4, 1, fy - 1, 'oak_slab'); // balcony floor
    for (let x = 3; x <= W - 4; x++) bs.add(x, fy, 0, 'oak_fence'); // railing
    // balcony door (glass) behind
    for (let x = 4; x <= W - 5; x += 3) { bs.add(x, fy - 1, 2, 'glass'); bs.add(x, fy, 2, 'glass'); }
  }
  // flat roof + parapet
  rectFill(bs, 2, 2, W - 3, 11, 13, 'gray_concrete');
  for (let x = 2; x <= W - 3; x++) { bs.add(x, 14, 2, 'glass_pane'); bs.add(x, 14, 11, 'glass_pane'); }
  for (let z = 2; z <= 11; z++) { bs.add(2, 14, z, 'glass_pane'); bs.add(W - 3, 14, z, 'glass_pane'); }
  // roof equipment
  rectFill(bs, 6, 5, 9, 8, 14, 'iron_block');
  return { bs: bs, name: 'Modern Apartment Block' };
}

// ---------- 11. lamp_post ~1x4x1 ----------
function genLampPost(opts) {
  const bs = new BlockSet();
  bs.add(0, 0, 0, 'stone'); // base
  lampPost(bs, 0, 1, 0);
  return { bs: bs, name: 'Lamp Post' };
}

// ---------- 12. bench ~3x2x1 ----------
function genBench(opts) {
  const bs = new BlockSet();
  bs.add(0, 0, 0, 'cobblestone');
  bs.add(1, 0, 0, 'cobblestone');
  bs.add(2, 0, 0, 'cobblestone');
  bench(bs, 0, 1, 0);
  return { bs: bs, name: 'Bench' };
}

// ============================================================
//                          REGISTRY
// ============================================================
const REGISTRY = {
  modern_house:          { name: 'Modern House',          size: [10, 7, 8],   category: 'building',      description: 'Glass/concrete/wood modern home with flat roof and skylight.', fn: genModernHouse },
  skyscraper_tower:      { name: 'Skyscraper Tower',      size: [12, 34, 12], category: 'building',      description: 'Tall concrete-frame tower with glass curtain wall and antenna.', fn: genSkyscraper },
  road_segment:          { name: 'Road Segment',          size: [16, 2, 5],   category: 'infrastructure', description: 'Straight 3-lane road with markings and raised curbs.', fn: genRoadSegment },
  road_grid:             { name: 'Road Grid',             size: [32, 1, 32],  category: 'infrastructure', description: '2x2 grid of roads with four intersections and stop lines.', fn: genRoadGrid },
  park:                  { name: 'Park',                  size: [20, 8, 20],  category: 'nature',        description: 'Grass park with oak/birch trees, flower beds, pond, paths, lamps and benches.', fn: genPark },
  ferris_wheel:          { name: 'Ferris Wheel',          size: [17, 18, 4],  category: 'ride',          description: 'Static ferris wheel with A-frame supports, spokes and colored wool cabins.', fn: genFerrisWheel },
  roller_coaster:        { name: 'Roller Coaster',        size: [19, 6, 11],  category: 'ride',          description: 'Oval coaster with hills, powered/detector rails, supports and a station platform.', fn: genRollerCoaster },
  bridge:                { name: 'Suspension Bridge',     size: [24, 10, 5],  category: 'infrastructure', description: 'Stone/wood deck bridge with fence rails, towers and chain cables over water.', fn: genBridge },
  fountain:              { name: 'Fountain',              size: [9, 5, 9],    category: 'decoration',    description: 'Circular stone basin with water, central quartz pillar and glowstone.', fn: genFountain },
  modern_apartment_block:{ name: 'Modern Apartment Block',size: [16, 15, 12], category: 'building',      description: 'Wide apartment block with repeating windows and oak-fence balconies.', fn: genApartment },
  lamp_post:             { name: 'Lamp Post',             size: [1, 5, 1],    category: 'utility',       description: 'Small fence post with lantern on a stone base.', fn: genLampPost },
  bench:                 { name: 'Bench',                 size: [3, 3, 1],    category: 'utility',       description: 'Oak-slab seat with oak-fence arms and backrest.', fn: genBench }
};

function list() {
  const out = [];
  for (const id of Object.keys(REGISTRY)) {
    const r = REGISTRY[id];
    out.push({ id: id, name: r.name, size: r.size.slice(), description: r.description, category: r.category });
  }
  return out;
}

function generate(id, opts) {
  const r = REGISTRY[id];
  if (!r) throw new Error('Unknown blueprint id: ' + id);
  const res = r.fn(opts || {});
  const blocks = res.bs.toArray();
  const size = extentsOf(blocks);
  return { id: id, name: res.name, size: size, blocks: blocks };
}

module.exports = { list: list, generate: generate };

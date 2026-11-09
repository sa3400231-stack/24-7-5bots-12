'use strict';
/*
 * test/blueprints.test.js — plain node self-test (no framework).
 * Run: node test/blueprints.test.js
 * Exit 0 on pass, 1 on failure.
 */

const blueprints = require('../src/blueprints.js');
const ai = require('../src/ai.js');
const mcData = require('minecraft-data')('1.20.1');

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}
const RAILS = new Set(['rail', 'powered_rail', 'detector_rail']);
const NON_SOLID = new Set(['rail', 'powered_rail', 'detector_rail', 'water', 'lava']);

function isValidName(name) {
  if (name === 'water' || name === 'lava') return true;
  if (mcData.blocksByName[name]) return true;
  if (mcData.itemsByName[name]) return true;
  return false;
}

async function main() {
  const list = blueprints.list();
  console.log('Blueprint count: ' + list.length);
  check(Array.isArray(list) && list.length > 0, 'list() must return non-empty array');

  for (const meta of list) {
    const label = '[' + meta.id + ']';
    let bp;
    try {
      bp = blueprints.generate(meta.id, { seed: 42 });
    } catch (e) {
      check(false, label + ' generate() threw: ' + e.message);
      continue;
    }

    // 1. returns object with non-empty blocks array and size array of 3 positive ints
    check(bp && typeof bp === 'object', label + ' generate() must return object');
    check(Array.isArray(bp.blocks) && bp.blocks.length > 0, label + ' blocks array must be non-empty');
    check(Array.isArray(bp.size) && bp.size.length === 3, label + ' size must be array of 3');
    if (Array.isArray(bp.size)) {
      for (let i = 0; i < 3; i++) {
        check(Number.isInteger(bp.size[i]) && bp.size[i] > 0, label + ' size[' + i + '] must be positive int, got ' + bp.size[i]);
      }
    }
    check(bp.id === meta.id, label + ' returned id mismatch: ' + bp.id);
    if (!bp || !Array.isArray(bp.blocks) || bp.blocks.length === 0) continue;

    const blocks = bp.blocks;
    // 2. extents <= declared size (allow exact)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const b of blocks) {
      if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
      if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
      if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    }
    const extW = maxX - minX + 1, extH = maxY - minY + 1, extD = maxZ - minZ + 1;
    check(extW <= bp.size[0], label + ' x extent ' + extW + ' > declared ' + bp.size[0]);
    check(extH <= bp.size[1], label + ' y extent ' + extH + ' > declared ' + bp.size[1]);
    check(extD <= bp.size[2], label + ' z extent ' + extD + ' > declared ' + bp.size[2]);

    // 3. total blocks <= 4000
    check(blocks.length <= 4000, label + ' total blocks ' + blocks.length + ' > 4000');
    check(blocks.length >= 1, label + ' empty blueprint');

    // 4. sorted by y ascending (non-decreasing)
    let sorted = true;
    for (let i = 1; i < blocks.length; i++) {
      if (blocks[i].y < blocks[i - 1].y) { sorted = false; break; }
    }
    check(sorted, label + ' blocks not sorted by y ascending');
    // also check within same y, x asc; within same x, z asc (strict contract)
    let sortedFull = true;
    for (let i = 1; i < blocks.length; i++) {
      const a = blocks[i - 1], b = blocks[i];
      const cmp = a.y - b.y || a.x - b.x || a.z - b.z;
      if (cmp > 0) { sortedFull = false; break; }
    }
    check(sortedFull, label + ' blocks not fully sorted (y,x,z)');

    // 5. every block name valid
    const invalidNames = new Set();
    for (const b of blocks) {
      if (!isValidName(b.name)) invalidNames.add(b.name);
    }
    check(invalidNames.size === 0, label + ' invalid block names: ' + [...invalidNames].join(','));

    // 6. rails must have a solid block directly below (same x,z, y-1)
    const posMap = new Map();
    for (const b of blocks) posMap.set(b.x + ',' + b.y + ',' + b.z, b.name);
    let railFail = 0;
    const railFailExamples = [];
    for (const b of blocks) {
      if (!RAILS.has(b.name)) continue;
      const belowName = posMap.get(b.x + ',' + (b.y - 1) + ',' + b.z);
      if (belowName === undefined || NON_SOLID.has(belowName)) {
        railFail++;
        if (railFailExamples.length < 3) railFailExamples.push('(' + b.x + ',' + b.y + ',' + b.z + ' ' + b.name + ' below=' + (belowName || 'air') + ')');
      }
    }
    check(railFail === 0, label + ' ' + railFail + ' rail(s) lack solid block below: ' + railFailExamples.join(' '));

    console.log('  ' + meta.id + ': blocks=' + blocks.length + ' size=[' + bp.size.join(',') + '] extents=[' + extW + ',' + extH + ',' + extD + ']' + (invalidNames.size ? ' INVALID:' + [...invalidNames].join(',') : '') + (railFail ? ' RAILFAIL:' + railFail : ''));
  }

  // ---- AI module checks ----
  ai.configure({ enabled: false });
  check(ai.isEnabled() === false, 'ai.isEnabled() must be false after configure({enabled:false})');
  const choice = await ai.chooseNextBuild([], {});
  check(choice === null, 'ai.chooseNextBuild([],{}) must return null when disabled, got ' + JSON.stringify(choice));
  // splitChat: 500-char string -> chunks each <=230
  const longStr = 'word '.repeat(100).trim(); // 499 chars
  check(longStr.length >= 500 || longStr.length >= 490, 'test string too short: ' + longStr.length);
  const chunks = ai.splitChat(longStr);
  check(Array.isArray(chunks) && chunks.length >= 2, 'splitChat must return >=2 chunks for ~500 chars, got ' + (chunks && chunks.length));
  let allOk = true;
  for (let i = 0; i < chunks.length; i++) {
    if (typeof chunks[i] !== 'string' || chunks[i].length > 230) allOk = false;
  }
  check(allOk, 'splitChat chunks must each be <=230 chars; lengths=' + (chunks || []).map(function (c) { return c.length; }).join(','));
  // reassembly preserves content (whitespace may differ; check joined length >= original)
  const joined = chunks.join('');
  check(joined.replace(/\s/g, '') === longStr.replace(/\s/g, ''), 'splitChat reassembly must preserve non-whitespace content');

  // also verify enabled-without-key returns null
  ai.configure({ enabled: true, provider: 'gemini', apiKey: '', model: 'gemini-1.5-flash' });
  check(ai.isEnabled() === false, 'ai.isEnabled() must be false with empty apiKey');
  const choice2 = await ai.chooseNextBuild([{ id: 'bench' }], {});
  check(choice2 === null, 'chooseNextBuild must return null with no apiKey');
  ai.configure({ enabled: false });

  // ---- result ----
  if (failures.length === 0) {
    console.log('ALL TESTS PASSED');
    process.exit(0);
  } else {
    console.error('FAILURES (' + failures.length + '):');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
}

main().catch(function (e) {
  console.error('Test harness crashed: ' + (e && e.stack || e));
  process.exit(1);
});

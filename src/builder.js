"use strict";

// ============================================================================
// src/builder.js — Cooperative build engine.
// The foreman drives the blueprint queue; each alive worker gets one contiguous
// slice of blocks (bottom-up order preserved) and places its slice. State is
// persisted to build_state.json. Any per-block failure is logged and skipped —
// the loop never throws.
// ============================================================================

const fs = require("fs");
const path = require("path");
const vec3 = require("vec3");
const mcDataLib = require("minecraft-data");
const { goals } = require("mineflayer-pathfinder");
const { GoalNear } = goals;

const STATE_FILE = path.join(__dirname, "..", "build_state.json");
const PLACE_TIMEOUT_MS = 8000;
const NEIGHBOR_OFFSETS = [
  { x: 0, y: -1, z: 0 }, // below (preferred)
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 1, z: 0 },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("operation timeout")), ms),
  );
}

function normalizeBlueprintIds(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (typeof x === "string") return x;
      if (x && typeof x === "object" && x.id) return x.id;
      return null;
    })
    .filter(Boolean);
}

function partitionBlocks(blocks, n) {
  if (n <= 0) return [];
  const per = Math.max(1, Math.ceil(blocks.length / n));
  const slices = [];
  for (let i = 0; i < n; i++) {
    slices.push(blocks.slice(i * per, (i + 1) * per));
  }
  return slices;
}

function createBuilder(crew, settings, blueprints, ai, logger) {
  const build = settings.build || {};
  const origin0 = build.origin || { x: 0, y: 100, z: 0 };
  const plotSize = build.plotSize || 40;
  const placeDelay = build.placeDelayMs || 250;
  const placeDelayMs = Math.max(50, placeDelay);
  let mcData = null;
  try {
    mcData = mcDataLib(settings.server && settings.server.version ? settings.server.version : "1.20.1");
  } catch (e) {
    mcData = null;
  }

  let state = { completed: [], gridIndex: 0 };
  let running = false;
  let loopRunning = false;
  let current = null; // { id, name, origin, placed, total }
  const missingLogged = new Set(); // "username:blockName"

  function log(msg, tag) {
    try {
      logger.addLog(msg, tag || "Builder");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[Builder] ${msg}`);
    }
  }

  function loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        if (raw && Array.isArray(raw.completed)) {
          state = {
            completed: raw.completed,
            gridIndex: typeof raw.gridIndex === "number" ? raw.gridIndex : 0,
          };
          return;
        }
      }
    } catch (e) {
      log(`build_state load failed, starting fresh: ${e.message}`, "Builder");
    }
    state = { completed: [], gridIndex: 0 };
  }

  function saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      log(`build_state save failed: ${e.message}`, "Builder");
    }
  }

  function originCompleted(o) {
    return state.completed.some(
      (c) =>
        c.origin &&
        c.origin.x === o.x &&
        c.origin.y === o.y &&
        c.origin.z === o.z,
    );
  }

  function gridOrigin(cellIndex) {
    const col = cellIndex % 5;
    const row = Math.floor(cellIndex / 5);
    return {
      x: origin0.x + col * plotSize,
      y: origin0.y,
      z: origin0.z + row * plotSize,
    };
  }

  function cityState() {
    return {
      completed: state.completed.slice(),
      gridIndex: state.gridIndex,
      origin: { x: origin0.x, y: origin0.y, z: origin0.z },
      plotSize,
    };
  }

  function getQueue() {
    try {
      const ids = normalizeBlueprintIds(blueprints.list());
      if (ids.length === 0) return [];
      const out = [];
      for (let k = 0; k < Math.min(5, ids.length); k++) {
        out.push(ids[(state.gridIndex + k) % ids.length]);
      }
      return out;
    } catch (e) {
      return [];
    }
  }

  function getProgress() {
    return {
      current: current ? current.name : null,
      currentId: current ? current.id : null,
      placed: current ? current.placed : 0,
      total: current ? current.total : 0,
      queue: getQueue(),
    };
  }

  // ---- per-worker placement -----------------------------------------------
  function findReference(bot, pos) {
    for (const off of NEIGHBOR_OFFSETS) {
      try {
        const nb = bot.blockAt(pos.offset(off.x, off.y, off.z));
        if (nb && nb.boundingBox === "block") {
          // face vector points from ref block toward the target position
          const face = vec3(-off.x, -off.y, -off.z);
          return { block: nb, face };
        }
      } catch (e) {
        /* try next neighbor */
      }
    }
    return null;
  }

  async function ensureItem(bot, itemName, username) {
    // Try creative first (also when gameMode unknown)
    const gameMode = bot.game ? bot.game.gameMode : null;
    const tryCreative = gameMode === "creative" || gameMode == null;
    if (tryCreative && mcData && bot.creative) {
      const mcItem = mcData.itemsByName[itemName];
      if (mcItem) {
        try {
          await bot.creative.setInventorySlot(36, { id: mcItem.id, count: 1 });
          await sleep(100);
        } catch (e) {
          /* fall through to survival lookup */
        }
      }
    }
    // Find item in inventory (survival fallback, also verifies creative set worked)
    const inv = bot.inventory.items();
    const item =
      inv.find((i) => i.name === itemName) ||
      inv.find((i) => i.name === itemName.replace("_bucket", ""));
    if (item) return item;
    const key = `${username}:${itemName}`;
    if (!missingLogged.has(key)) {
      missingLogged.add(key);
      log(`missing block ${itemName} for ${username} — skipping those blocks`, username);
    }
    return null;
  }

  async function placeOneBlock(w, block, origin) {
    const bot = w.bot;
    if (!bot) return false;
    const wx = origin.x + block.x;
    const wy = origin.y + block.y;
    const wz = origin.z + block.z;
    const pos = vec3(wx, wy, wz);

    // (a) authoritative skip: already built
    try {
      const existing = bot.blockAt(pos);
      if (existing && existing.name && existing.name !== "air") return false;
    } catch (e) {
      /* can't verify, proceed */
    }

    // (b) path near the target
    if (bot.pathfinder) {
      try {
        await Promise.race([
          bot.pathfinder.goto(new GoalNear(wx, wy, wz, 3)),
          timeout(PLACE_TIMEOUT_MS),
        ]);
      } catch (e) {
        return false; // unreachable, skip
      }
    }

    const isLiquid = block.name === "water" || block.name === "lava";
    const itemName = isLiquid
      ? block.name === "water"
        ? "water_bucket"
        : "lava_bucket"
      : block.name;

    // (c)+(d) ensure item and equip
    const item = await ensureItem(bot, itemName, w.username);
    if (!item) return false;
    try {
      await bot.equip(item, "hand");
    } catch (e) {
      return false;
    }

    // (e) place block / use bucket
    const ref = findReference(bot, pos);
    if (!ref) return false;
    try {
      if (isLiquid) {
        const rp = ref.block.position;
        await bot.lookAt(rp.offset(0.5, 0.5, 0.5));
        await bot.activateItem();
      } else {
        await bot.placeBlock(ref.block, ref.face);
      }
    } catch (e) {
      return false;
    }
    return true;
  }

  async function workerBuild(w, slice, origin) {
    try {
      w.state = "BUILDING";
      w.task = current ? current.name : "building";
    } catch (e) {
      /* ignore */
    }
    for (const block of slice) {
      if (!running) break;
      if (!w.bot) break;
      try {
        const ok = await placeOneBlock(w, block, origin);
        if (ok) {
          w.blocksPlaced += 1;
          if (current) current.placed += 1;
        }
      } catch (e) {
        log(`${w.username} place error: ${e.message}`, w.username);
      }
      await sleep(placeDelayMs);
    }
    try {
      if (w.state === "BUILDING") {
        w.state = "IDLE";
        w.task = "";
      }
    } catch (e) {
      /* ignore */
    }
  }

  // ---- foreman loop -------------------------------------------------------
  async function pickNextBlueprint() {
    const ids = normalizeBlueprintIds(blueprints.list());
    if (ids.length === 0) return null;

    let aiEnabled = false;
    try {
      aiEnabled = ai && typeof ai.isEnabled === "function" && ai.isEnabled();
    } catch (e) {
      aiEnabled = false;
    }

    if (aiEnabled && typeof ai.chooseNextBuild === "function") {
      try {
        const pick = await ai.chooseNextBuild(blueprints.list(), cityState());
        if (pick && pick.blueprintId && typeof pick.x === "number") {
          return {
            blueprintId: pick.blueprintId,
            origin: { x: pick.x, y: pick.y, z: pick.z },
            fromAI: true,
          };
        }
      } catch (e) {
        log(`AI chooseNextBuild failed, falling back to grid: ${e.message}`, "Builder");
      }
    }

    // Round-robin grid: advance past already-completed cells
    for (let attempt = 0; attempt < 500; attempt++) {
      const cellIndex = state.gridIndex + attempt;
      const o = gridOrigin(cellIndex);
      if (!originCompleted(o)) {
        const blueprintId = ids[cellIndex % ids.length];
        state.gridIndex = cellIndex + 1;
        return { blueprintId, origin: o, fromAI: false };
      }
    }
    return null;
  }

  async function foremanLoop() {
    if (loopRunning) return;
    loopRunning = true;
    while (running) {
      try {
        const fm = crew.foreman();
        if (!fm || !fm.bot) {
          await sleep(2000);
          continue;
        }
        const alive = crew.aliveBots();
        if (!build.enabled || alive.length < 2) {
          await sleep(2000);
          continue;
        }

        const pick = await pickNextBlueprint();
        if (!pick) {
          await sleep(3000);
          continue;
        }

        let bp;
        try {
          bp = blueprints.generate(pick.blueprintId, {});
        } catch (e) {
          log(`generate ${pick.blueprintId} failed: ${e.message}`, "Builder");
          await sleep(3000);
          continue;
        }
        if (!bp || !Array.isArray(bp.blocks) || bp.blocks.length === 0) {
          log(`blueprint ${pick.blueprintId} has no blocks, skipping`, "Builder");
          await sleep(2000);
          continue;
        }

        current = {
          id: bp.id || pick.blueprintId,
          name: bp.name || pick.blueprintId,
          origin: pick.origin,
          placed: 0,
          total: bp.blocks.length,
        };
        log(
          `Building "${current.name}" at (${pick.origin.x}, ${pick.origin.y}, ${pick.origin.z}) — ${bp.blocks.length} blocks, ${alive.length} workers`,
          "Builder",
        );

        const slices = partitionBlocks(bp.blocks, alive.length);
        const tasks = alive.map((w, i) =>
          workerBuild(w, slices[i] || [], pick.origin),
        );
        await Promise.all(tasks);

        state.completed.push({
          blueprintId: current.id,
          origin: pick.origin,
          name: current.name,
        });
        saveState();
        log(`Completed "${current.name}" (${current.placed}/${current.total} placed)`, "Builder");
        current = null;
      } catch (e) {
        log(`foreman loop error: ${e.message}`, "Builder");
        await sleep(3000);
      }
    }
    loopRunning = false;
  }

  function start() {
    try {
      if (running) return;
      loadState();
      running = true;
      log("Builder started.", "Builder");
      foremanLoop().catch((e) => {
        log(`foremanLoop fatal: ${e.message}`, "Builder");
        running = false;
        loopRunning = false;
      });
    } catch (e) {
      log(`builder.start error: ${e.message}`, "Builder");
    }
  }

  function stop() {
    try {
      running = false;
      current = null;
      try {
        for (const w of crew.aliveBots()) {
          if (w.state === "BUILDING") {
            w.state = "IDLE";
            w.task = "";
          }
        }
      } catch (e) {
        /* ignore */
      }
      log("Builder stopped.", "Builder");
    } catch (e) {
      log(`builder.stop error: ${e.message}`, "Builder");
    }
  }

  return { start, stop, getProgress, getQueue };
}

module.exports = { createBuilder };

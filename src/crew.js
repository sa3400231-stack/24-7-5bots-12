"use strict";

// ============================================================================
// src/crew.js — Multi-bot crew manager (bots named 1..5 by default)
// Manages staggered connects, per-bot auth, auto-reconnect, leader election,
// group follow, anti-AFK, and foreman-only AI chat replies.
// A single bot error must NEVER crash the process — every handler is wrapped.
// ============================================================================

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { GoalNear } = goals;
const { EventEmitter } = require("events");

const FOLLOW_INTERVAL_MS = 4000;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Lazy-load ai module (owned by another agent; may be absent in dev).
let _ai = null;
let _aiTried = false;
function getAI() {
  if (_aiTried) return _ai;
  _aiTried = true;
  try {
    _ai = require("./ai");
  } catch (e) {
    _ai = null;
  }
  return _ai;
}
function aiEnabled() {
  const ai = getAI();
  if (!ai || typeof ai.isEnabled !== "function") return false;
  try {
    return !!ai.isEnabled();
  } catch (e) {
    return false;
  }
}

function createCrew(settings, logger) {
  const emitter = new EventEmitter();
  const server = settings.server || {};
  const build = settings.build || {};
  const followDistance = build.followDistance || 8;
  const auth = settings.auth || { enabled: false, registerPassword: "", loginPassword: "" };

  let started = false;
  let stopping = false;
  let foreman = null;
  let followTimer = null;

  // ---- bot wrappers -------------------------------------------------------
  const wrappers = (settings.bots || []).map((cfg, index) => {
    const w = {
      username: cfg.username || `${index + 1}`,
      index,
      bot: null,
      state: "OFFLINE", // OFFLINE | CONNECTING | AUTH | IDLE | BUILDING | MOVING
      task: "",
      blocksPlaced: 0,
      // internal
      _stopping: false,
      _reconnectAttempts: 0,
      _reconnectTimer: null,
      _connectTimer: null,
      _jumpTimer: null,
      _authTimers: [],
      _authDone: false,
      _pathing: false,
      pos() {
        if (!this.bot || !this.bot.entity || !this.bot.entity.position) return null;
        const p = this.bot.entity.position;
        return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
      },
    };
    return w;
  });

  // ---- helpers ------------------------------------------------------------
  function log(msg, tag) {
    try {
      logger.addLog(msg, tag || "Crew");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`[Crew] ${msg}`);
    }
  }

  function setState(w, state, task) {
    try {
      if (task !== undefined) w.task = task;
      if (w.state === state) return;
      w.state = state;
      emitter.emit("bot_state", {
        username: w.username,
        state,
        task: w.task,
        blocksPlaced: w.blocksPlaced,
      });
      recomputeForeman();
    } catch (e) {
      log(`setState error: ${e.message}`, "Crew");
    }
  }

  function aliveBots() {
    return wrappers.filter((w) => w.bot !== null && !w._stopping);
  }

  function recomputeForeman() {
    try {
      const alive = aliveBots().sort((a, b) => a.index - b.index);
      const next = alive.length > 0 ? alive[0] : null;
      if (next !== foreman) {
        foreman = next;
        emitter.emit("foreman_change", foreman ? foreman.username : null);
        log(
          foreman ? `Foreman is now ${foreman.username}` : "Foreman slot empty (no bots online)",
          "Crew",
        );
      }
    } catch (e) {
      log(`recomputeForeman error: ${e.message}`, "Crew");
    }
  }

  function clearAuthTimers(w) {
    (w._authTimers || []).forEach((t) => clearTimeout(t));
    w._authTimers = [];
  }

  function scheduleJump(w) {
    if (w._stopping) return;
    const delay = rand(30000, 90000);
    w._jumpTimer = setTimeout(() => {
      try {
        if (w.bot && !w._stopping) {
          w.bot.setControlState("jump", true);
          setTimeout(() => {
            try {
              if (w.bot) w.bot.setControlState("jump", false);
            } catch (e) {
              /* ignore */
            }
          }, 300);
        }
      } catch (e) {
        /* ignore */
      }
      scheduleJump(w);
    }, delay);
  }

  function describeKick(reason) {
    const s = String(reason || "").toLowerCase();
    if (
      s.includes("too many") ||
      (s.includes("connection") && (s.includes("max") || s.includes("limit"))) ||
      s.includes("max players") ||
      s.includes("server is full")
    ) {
      return (
        "Server rejected a bot connection (too many connections/players from this IP). " +
        "Raise max-connections-per-IP and max-players in server.properties, or reduce bot count."
      );
    }
    return null;
  }

  // ---- per-bot connection -------------------------------------------------
  function attachHandlers(w) {
    const bot = w.bot;
    if (!bot) return;

    bot.on("spawn", () => {
      try {
        if (w._stopping) return;
        w._reconnectAttempts = 0;
        if (!w._authDone) {
          w._authDone = true;
          clearAuthTimers(w);
          if (auth && auth.enabled) {
            setState(w, "AUTH");
            log(`${w.username} spawned — authenticating (auth enabled)...`, w.username);
            if (auth.registerPassword) {
              try {
                bot.chat(`/register ${auth.registerPassword} ${auth.registerPassword}`);
              } catch (e) {
                log(`${w.username} register send failed: ${e.message}`, w.username);
              }
            }
            if (auth.loginPassword) {
              w._authTimers.push(
                setTimeout(() => {
                  try {
                    bot.chat(`/login ${auth.loginPassword}`);
                  } catch (e) {
                    log(`${w.username} login send failed: ${e.message}`, w.username);
                  }
                }, 1500),
              );
            }
            w._authTimers.push(
              setTimeout(() => {
                try {
                  if (build.allowCreativeCommands) {
                    try {
                      bot.chat("/gamemode creative");
                    } catch (e) {
                      /* best-effort */
                    }
                  }
                } catch (e) {
                  /* ignore */
                }
                setState(w, "IDLE");
                log(`${w.username} authenticated, idle.`, w.username);
              }, 3500),
            );
          } else {
            // No auth plugin (vanilla / Aternos default) — do NOT spam /register /login.
            try {
              if (build.allowCreativeCommands) {
                try {
                  bot.chat("/gamemode creative");
                } catch (e) {
                  /* best-effort */
                }
              }
            } catch (e) {
              /* ignore */
            }
            setState(w, "IDLE");
            log(`${w.username} spawned, idle (auth disabled).`, w.username);
          }
        } else {
          if (w.state === "AUTH" || w.state === "CONNECTING") setState(w, "IDLE");
        }
      } catch (e) {
        log(`${w.username} spawn handler error: ${e.message}`, w.username);
      }
    });

    bot.on("end", (reason) => {
      try {
        log(`${w.username} disconnected: ${reason || "unknown"}`, w.username);
      } catch (e) {
        /* ignore */
      }
      handleDisconnect(w, reason);
    });

    bot.on("kicked", (reason) => {
      try {
        const human = describeKick(reason);
        if (human) {
          log(`[IMPORTANT] ${w.username} kicked: ${human}`, "System");
        } else {
          log(`${w.username} kicked: ${String(reason).slice(0, 200)}`, w.username);
        }
      } catch (e) {
        /* ignore */
      }
      handleDisconnect(w, reason);
    });

    bot.on("error", (err) => {
      try {
        const msg = err && err.message ? err.message : String(err);
        const human = describeKick(msg);
        if (human) {
          log(`[IMPORTANT] ${w.username} connection error: ${human}`, "System");
        } else {
          log(`${w.username} error: ${msg}`, w.username);
        }
      } catch (e) {
        /* ignore */
      }
      // 'error' may be followed by 'end'; don't force-disconnect here to avoid double-handling.
    });

    // Foreman-only AI chat replies
    bot.on("messagestr", (message, _position, _json, sender) => {
      try {
        if (!sender || !message) return;
        if (sender === w.username) return; // ignore own messages
        if (!aiEnabled()) return;
        if (foreman !== w) return; // only foreman replies
        const ai = getAI();
        if (!ai || typeof ai.chatReply !== "function") return;
        Promise.resolve()
          .then(() => ai.chatReply(sender, message))
          .then(async (reply) => {
            try {
              if (!reply) return;
              const chunks =
                typeof ai.splitChat === "function" ? ai.splitChat(reply) : [reply];
              for (const chunk of chunks) {
                if (!chunk) continue;
                try {
                  if (w.bot) w.bot.chat(String(chunk));
                } catch (e) {
                  log(`${w.username} chat send failed: ${e.message}`, w.username);
                }
                await sleep(700);
              }
            } catch (e) {
              log(`${w.username} chat reply error: ${e.message}`, w.username);
            }
          })
          .catch((e) => {
            log(`${w.username} ai.chatReply error: ${e.message}`, w.username);
          });
      } catch (e) {
        log(`${w.username} chat handler error: ${e.message}`, w.username);
      }
    });
  }

  function handleDisconnect(w, reason) {
    try {
      clearAuthTimers(w);
      if (w._jumpTimer) clearTimeout(w._jumpTimer);
      w.bot = null;
      w._authDone = false;
      setState(w, "OFFLINE");
      if (stopping || w._stopping) return;
      scheduleReconnect(w);
    } catch (e) {
      log(`handleDisconnect error for ${w.username}: ${e.message}`, "Crew");
    }
  }

  function scheduleReconnect(w) {
    try {
      if (stopping || w._stopping) return;
      w._reconnectAttempts += 1;
      const base = rand(2000, 10000);
      const backoff = Math.min(5000 * w._reconnectAttempts, 30000);
      const stagger = w.index * 1500;
      const delay = base + backoff + stagger;
      log(
        `${w.username} reconnecting in ${Math.round(delay / 1000)}s (attempt ${w._reconnectAttempts})`,
        w.username,
      );
      w._reconnectTimer = setTimeout(() => connectBot(w), delay);
    } catch (e) {
      log(`scheduleReconnect error for ${w.username}: ${e.message}`, "Crew");
    }
  }

  function connectBot(w) {
    try {
      if (stopping || w._stopping) return;
      if (w.bot) {
        try {
          w.bot.end();
        } catch (e) {
          /* ignore */
        }
        w.bot = null;
      }
      w._authDone = false;
      setState(w, "CONNECTING");
      log(`Connecting ${w.username} to ${server.host}:${server.port}...`, w.username);

      let bot;
      try {
        bot = mineflayer.createBot({
          host: server.host,
          port: server.port || 25565,
          version: server.version ? server.version : false, // empty string -> auto-detect
          username: w.username,
          auth: "offline",
        });
      } catch (e) {
        log(`${w.username} createBot failed: ${e.message}`, w.username);
        setState(w, "OFFLINE");
        scheduleReconnect(w);
        return;
      }

      w.bot = bot;

      try {
        bot.loadPlugin(pathfinder);
        const moves = new Movements(bot);
        bot.pathfinder.setMovements(moves);
      } catch (e) {
        log(`${w.username} pathfinder setup failed: ${e.message}`, w.username);
      }

      attachHandlers(w);
      scheduleJump(w);
      recomputeForeman();
    } catch (e) {
      log(`connectBot error for ${w.username}: ${e.message}`, "Crew");
      try {
        setState(w, "OFFLINE");
      } catch (e2) {
        /* ignore */
      }
      scheduleReconnect(w);
    }
  }

  // ---- group follow -------------------------------------------------------
  function followTick() {
    try {
      if (!foreman || !foreman.bot || !foreman.bot.entity) return;
      const fp = foreman.bot.entity.position;
      for (const w of aliveBots()) {
        try {
          if (w === foreman) continue;
          if (!w.bot || !w.bot.entity || w._pathing) continue;
          const p = w.bot.entity.position;
          const dist = Math.sqrt(
            (p.x - fp.x) ** 2 + (p.y - fp.y) ** 2 + (p.z - fp.z) ** 2,
          );
          if (dist > followDistance) {
            w._pathing = true;
            if (w.state === "IDLE") setState(w, "MOVING", "following foreman");
            Promise.resolve()
              .then(() =>
                w.bot.pathfinder.goto(new GoalNear(fp.x, fp.y, fp.z, 4)),
              )
              .catch((e) => {
                log(`${w.username} follow path error: ${e.message}`, w.username);
              })
              .finally(() => {
                w._pathing = false;
                if (w.state === "MOVING") setState(w, "IDLE", "");
              });
          }
        } catch (e) {
          log(`${w.username} follow tick error: ${e.message}`, w.username);
        }
      }
    } catch (e) {
      log(`followTick error: ${e.message}`, "Crew");
    }
  }

  // ---- public API ---------------------------------------------------------
  function start() {
    try {
      if (started) {
        log("Crew already started.", "Crew");
        return;
      }
      started = true;
      stopping = false;
      log(`Starting crew of ${wrappers.length} bots (staggered)...`, "Crew");
      log(
        "Aternos note: start your server from the Aternos panel first — while it is offline the bots will keep reconnecting with backoff until it comes online.",
        "System",
      );
      wrappers.forEach((w, i) => {
        const delay = i * 6000 + rand(0, 2000);
        w._stopping = false;
        w._connectTimer = setTimeout(() => connectBot(w), delay);
      });
      followTimer = setInterval(followTick, FOLLOW_INTERVAL_MS);
    } catch (e) {
      log(`crew.start error: ${e.message}`, "Crew");
    }
  }

  function stopAll() {
    try {
      stopping = true;
      started = false;
      log("Stopping all bots...", "Crew");
      if (followTimer) {
        clearInterval(followTimer);
        followTimer = null;
      }
      for (const w of wrappers) {
        try {
          w._stopping = true;
          if (w._connectTimer) clearTimeout(w._connectTimer);
          if (w._reconnectTimer) clearTimeout(w._reconnectTimer);
          if (w._jumpTimer) clearTimeout(w._jumpTimer);
          clearAuthTimers(w);
          if (w.bot) {
            try {
              w.bot.end();
            } catch (e) {
              /* ignore */
            }
            w.bot = null;
          }
          setState(w, "OFFLINE", "");
        } catch (e) {
          log(`stop ${w.username} error: ${e.message}`, "Crew");
        }
      }
      foreman = null;
      log("All bots stopped.", "Crew");
    } catch (e) {
      log(`crew.stopAll error: ${e.message}`, "Crew");
    }
  }

  function getStatus() {
    try {
      return wrappers.map((w) => {
        const p = w.pos();
        return {
          username: w.username,
          online: w.bot !== null,
          x: p ? p.x : null,
          y: p ? p.y : null,
          z: p ? p.z : null,
          state: w.state,
          task: w.task,
          blocksPlaced: w.blocksPlaced,
        };
      });
    } catch (e) {
      log(`getStatus error: ${e.message}`, "Crew");
      return [];
    }
  }

  return {
    start,
    stopAll,
    getStatus,
    foreman: () => foreman,
    aliveBots,
    on: (event, cb) => emitter.on(event, cb),
    // internal access for builder (blocksPlaced increments, state/task updates)
    _wrappers: wrappers,
  };
}

module.exports = { createCrew };

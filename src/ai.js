'use strict';
/*
 * ai.js — optional AI hook. Uses ONLY global fetch (Node 18+).
 * ZERO new npm dependencies. Must NEVER throw (always catch and return null/fallback).
 */

let config = { enabled: false, provider: 'none', apiKey: '', model: '' };

function configure(aiConfig) {
  try {
    if (aiConfig && typeof aiConfig === 'object') {
      config = {
        enabled: !!aiConfig.enabled,
        provider: String(aiConfig.provider || 'none'),
        apiKey: String(aiConfig.apiKey || ''),
        model: String(aiConfig.model || '')
      };
    }
  } catch (e) {
    config = { enabled: false, provider: 'none', apiKey: '', model: '' };
  }
}

function isEnabled() {
  try {
    return !!(config.enabled && config.apiKey && config.model &&
      (config.provider === 'gemini' || config.provider === 'openai'));
  } catch (e) {
    return false;
  }
}

// Strip markdown code fences and surrounding whitespace, then JSON.parse.
function parseJsonStrict(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  // also handle leading ```json without closing
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // find first { and last }
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s < 0 || e < 0 || e <= s) return null;
  t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

async function callModel(prompt, timeoutMs) {
  if (!isEnabled()) return null;
  const controller = new AbortController();
  const timer = setTimeout(function () { try { controller.abort(); } catch (e) { } }, timeoutMs || 8000);
  try {
    if (config.provider === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(config.model) + ':generateContent?key=' + encodeURIComponent(config.apiKey);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const parts = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts;
      if (!parts || !parts.length) return null;
      return parts.map(function (p) { return p.text || ''; }).join('');
    }
    if (config.provider === 'openai') {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.apiKey },
        body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
        signal: controller.signal
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      return (msg && typeof msg.content === 'string') ? msg.content : null;
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function chooseNextBuild(blueprintList, cityState) {
  try {
    if (!isEnabled()) return null;
    const ids = (blueprintList || []).map(function (b) { return b && b.id; }).filter(Boolean);
    if (!ids.length) return null;
    const prompt =
      'You are the city planner for a Minecraft 1.20.1 multi-bot builder crew. ' +
      'Choose the next blueprint to build and where to place its origin (x,y,z). ' +
      'Available blueprint ids: ' + JSON.stringify(ids) + '. ' +
      'Current city state: ' + JSON.stringify(cityState || {}) + '. ' +
      'Respond ONLY with raw JSON, no markdown, no explanation, exactly this shape: ' +
      '{"blueprintId":"<one of the listed ids>","x":integer,"y":integer,"z":integer}.';
    const text = await callModel(prompt, 8000);
    if (!text) return null;
    const obj = parseJsonStrict(text);
    if (!obj || typeof obj !== 'object') return null;
    if (ids.indexOf(obj.blueprintId) < 0) return null;
    const x = Number(obj.x), y = Number(obj.y), z = Number(obj.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return { blueprintId: obj.blueprintId, x: Math.round(x), y: Math.round(y), z: Math.round(z) };
  } catch (e) {
    return null;
  }
}

async function chatReply(playerName, message) {
  try {
    if (!isEnabled()) return null;
    const prompt =
      'You are a friendly Minecraft builder bot (part of a 5-bot crew named 1,2,3,4,5 building a modern city/park/rides). ' +
      'Reply briefly (1-2 short sentences, max 200 chars) to the player. Mix of English/Banglish ok. ' +
      'Player name: ' + String(playerName || 'player') + '. Player says: ' + String(message || '');
    const text = await callModel(prompt, 8000);
    if (!text || typeof text !== 'string') return null;
    let out = text.trim().replace(/\s+/g, ' ');
    if (out.length > 200) out = out.slice(0, 197) + '...';
    return out;
  } catch (e) {
    return null;
  }
}

// Split text into chunks <= maxLen (default 230) at word boundaries.
function splitChat(text, maxLen) {
  try {
    const limit = (typeof maxLen === 'number' && maxLen > 0) ? maxLen : 230;
    if (typeof text !== 'string' || text.length === 0) return [];
    if (text.length <= limit) return [text];
    const words = text.split(/(\s+)/); // keep whitespace
    const chunks = [];
    let cur = '';
    for (const w of words) {
      if (cur.length + w.length <= limit) {
        cur += w;
      } else {
        if (cur.length > 0) chunks.push(cur);
        // if a single word/token exceeds limit, hard-split it
        if (w.length > limit) {
          for (let i = 0; i < w.length; i += limit) chunks.push(w.slice(i, i + limit));
          cur = '';
        } else {
          cur = w;
        }
      }
    }
    if (cur.length > 0) chunks.push(cur);
    return chunks.filter(function (c) { return c.length > 0; });
  } catch (e) {
    return [String(text).slice(0, 230)];
  }
}

module.exports = {
  configure: configure,
  isEnabled: isEnabled,
  chooseNextBuild: chooseNextBuild,
  chatReply: chatReply,
  splitChat: splitChat
};

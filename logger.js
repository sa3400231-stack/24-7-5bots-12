"use strict";

// Ring-buffered logger with per-bot tags.
// Backward compatible: addLog(message) defaults tag to 'System'.

const MAX_LOGS = 500;
const logs = [];

function addLog(message, tag) {
  const safeTag = tag && typeof tag === "string" ? tag : "System";
  const time = new Date().toLocaleTimeString();
  const formatted = `[${time}] [${safeTag}] ${message}`;
  // eslint-disable-next-line no-console
  console.log(formatted); // still goes to Render/host logs
  logs.push(formatted);
  while (logs.length > MAX_LOGS) logs.shift();
  return formatted;
}

function getLogs() {
  return logs.slice();
}

// Convenience: create a scoped logger for a specific bot/tag.
function forTag(tag) {
  return (message) => addLog(message, tag);
}

module.exports = { addLog, getLogs, forTag, MAX_LOGS };

import fs from "fs";
import path from "path";

const THREADS_PATH = path.resolve("state/active-threads.json");
const AUDIT_PATH = path.resolve("state/audit.jsonl");
const PENDING_PATH = path.resolve("state/pending-actions.json");

// Active threads
let threads = {};

export function loadThreads() {
  try {
    threads = JSON.parse(fs.readFileSync(THREADS_PATH, "utf8"));
  } catch {
    threads = {};
  }
}

function saveThreads() {
  fs.mkdirSync(path.dirname(THREADS_PATH), { recursive: true });
  fs.writeFileSync(THREADS_PATH, JSON.stringify(threads, null, 2));
}

export function trackThread(threadTs, channel, userId) {
  threads[threadTs] = {
    channel,
    userId,
    lastActivity: Date.now(),
  };
  saveThreads();
}

export function isActiveThread(threadTs) {
  return !!threads[threadTs];
}

export function getThread(threadTs) {
  return threads[threadTs] || null;
}

export function getAllThreads() {
  return { ...threads };
}

// Clean up threads older than 24 hours
export function cleanupThreads() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [ts, data] of Object.entries(threads)) {
    if (data.lastActivity < cutoff) delete threads[ts];
  }
  saveThreads();
}

// Pending actions (confirmation-gated)
let pending = {};

export function addPendingAction(id, action) {
  pending[id] = { ...action, createdAt: Date.now() };
  fs.mkdirSync(path.dirname(PENDING_PATH), { recursive: true });
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

export function getPendingAction(id) {
  return pending[id] || null;
}

export function removePendingAction(id) {
  delete pending[id];
  fs.writeFileSync(PENDING_PATH, JSON.stringify(pending, null, 2));
}

export function loadPending() {
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, "utf8"));
  } catch {
    pending = {};
  }
}

// Audit log
export function audit(action, userId, details) {
  const entry = {
    ts: new Date().toISOString(),
    action,
    userId,
    ...details,
  };
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n");
}

// Initialize
loadThreads();
loadPending();

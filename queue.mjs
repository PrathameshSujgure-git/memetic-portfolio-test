// Branch-level locking to prevent concurrent GitHub writes
const locks = new Map();

export async function withBranchLock(branch, fn) {
  const prev = locks.get(branch) || Promise.resolve();
  const next = prev.then(fn).catch((err) => {
    console.error(`[queue] Error in branch lock for ${branch}:`, err.message);
    throw err;
  });
  locks.set(branch, next.catch(() => {})); // don't propagate to next queued fn
  return next;
}

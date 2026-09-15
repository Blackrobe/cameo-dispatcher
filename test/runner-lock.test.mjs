import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { acquireRunnerLock, releaseRunnerLock } from "../src/runner-lock.mjs";

test("runner lock records its owner and rejects a live duplicate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cameo-lock-"));
  const lockPath = path.join(root, "runner.lock");
  try {
    const handle = await acquireRunnerLock(lockPath);
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(record.pid, process.pid);
    await assert.rejects(() => acquireRunnerLock(lockPath), /lock already exists/);
    await releaseRunnerLock(handle, lockPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runner lock fails closed on an orphaned or partially written lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cameo-lock-"));
  const lockPath = path.join(root, "runner.lock");
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, startedAt: "2000-01-01T00:00:00Z" }));
    await assert.rejects(() => acquireRunnerLock(lockPath), /reconcile it explicitly/);
    await writeFile(lockPath, "");
    await assert.rejects(() => acquireRunnerLock(lockPath), /reconcile it explicitly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

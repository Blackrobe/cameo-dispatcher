import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { waitForChildWithTimeout } from "../src/process-timeout.mjs";

test("terminates an over-time child through the injected tree terminator", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    stdio: "ignore"
  });
  let terminatedPid = null;
  const result = await waitForChildWithTimeout(child, 100, target => {
    terminatedPid = target.pid;
    target.kill();
  });

  assert.equal(result.timedOut, true);
  assert.equal(terminatedPid, child.pid);
  assert.notEqual(result.exitCode, 0);
});

test("the Windows timeout terminates the spawned process tree", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-timeout-tree-"));
  const childPidPath = path.join(root, "child.pid");
  const parentScript = `
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
    writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ["-e", parentScript], { windowsHide: true, stdio: "ignore" });
  let spawnedChildPid = null;

  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        spawnedChildPid = Number(readFileSync(childPidPath, "utf8"));
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    assert.ok(Number.isInteger(spawnedChildPid) && spawnedChildPid > 0);

    const result = await waitForChildWithTimeout(parent, 100);
    assert.equal(result.timedOut, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(parent.pid, 0));
    assert.throws(() => process.kill(spawnedChildPid, 0));
  } finally {
    for (const pid of [parent.pid, spawnedChildPid]) {
      if (Number.isInteger(pid) && pid > 0) {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  githubActionPaths,
  reconcileGithubActionOutcomes,
  runJournaledGithubAction,
  runLockedJournaledGithubAction
} from "../src/github-action-journal.mjs";
import { acquireRunnerLock, releaseRunnerLock } from "../src/runner-lock.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-github-journal-"));
  const localConfig = { stateRoot: path.join(root, "state") };
  const action = {
    id: "CGA-20260915-ABCDEF12",
    interactionId: "1549600000000000001",
    rootJobId: "CAM-20260915-ABCDEF12",
    requesterDiscordId: "900000000000000001",
    action: "merge",
    repository: "cameo-mod/Cameo-mod",
    prNumber: 400,
    prUrl: "https://github.com/cameo-mod/Cameo-mod/pull/400",
    expectedHeadSha: "a".repeat(40),
    headOwner: "Blackrobe",
    headBranch: "codex/dispatcher-test",
    baseBranch: "master",
    mergeMethod: "merge"
  };
  return { root, localConfig, action };
}

test("journaled GitHub actions execute once and resend a retained outcome without replay", async () => {
  const { root, localConfig, action } = fixture();
  let executions = 0;
  let posts = 0;
  try {
    const execute = async () => {
      executions += 1;
      return { status: "completed", summary: "Merged upstream PR #400." };
    };
    const first = await runJournaledGithubAction(localConfig, action, execute);
    const second = await runJournaledGithubAction(localConfig, action, execute);
    assert.deepEqual(second, first);
    assert.equal(executions, 1);
    const paths = githubActionPaths(localConfig, action.id);
    assert.ok(existsSync(paths.intentPath));
    assert.ok(existsSync(paths.outcomePath));

    await assert.rejects(() => reconcileGithubActionOutcomes(localConfig, async () => {
      posts += 1;
      throw new Error("tunnel unavailable");
    }, action), /tunnel unavailable/);
    assert.equal(existsSync(paths.deliveredPath), false);
    await reconcileGithubActionOutcomes(localConfig, async (retained, outcome) => {
      posts += 1;
      assert.equal(retained.expectedHeadSha, action.expectedHeadSha);
      assert.equal(outcome.result.summary, "Merged upstream PR #400.");
    }, action);
    assert.ok(existsSync(paths.deliveredPath));
    assert.equal(await reconcileGithubActionOutcomes(localConfig, async () => { posts += 1; }, action), false);
    assert.equal(posts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("journal refuses changed intent and persists failures without retrying", async () => {
  const { root, localConfig, action } = fixture();
  let executions = 0;
  try {
    const failed = await runJournaledGithubAction(localConfig, action, async () => {
      executions += 1;
      throw new Error("GitHub refused merge");
    });
    assert.equal(failed.state, "needs_attention");
    assert.match(failed.result.summary, /GitHub refused merge/);
    const retained = await runJournaledGithubAction(localConfig, action, async () => { executions += 1; });
    assert.deepEqual(retained, failed);
    assert.equal(executions, 1);
    await assert.rejects(
      () => runJournaledGithubAction(localConfig, { ...action, expectedHeadSha: "b".repeat(40) }, async () => {}),
      /intent differs/
    );
    assert.equal(executions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live runner lock blocks a new GitHub mutation callback", async () => {
  const { root, localConfig, action } = fixture();
  mkdirSync(localConfig.stateRoot, { recursive: true });
  const lockPath = path.join(localConfig.stateRoot, "runner.lock");
  const lock = await acquireRunnerLock(lockPath);
  let executed = false;
  try {
    const outcome = await runLockedJournaledGithubAction(localConfig, action, async () => {
      executed = true;
      return { status: "completed", summary: "must not run" };
    });
    assert.equal(executed, false);
    assert.equal(outcome.state, "needs_attention");
    assert.match(outcome.result.summary, /runner lock already exists/);
  } finally {
    await releaseRunnerLock(lock, lockPath);
    rmSync(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findActiveSessionFile } from "../src/session-registry.mjs";

const sessionId = "01a0a275-a2f1-73f1-89ae-f94d4b983fd6";

test("finds exactly one active dispatcher session and ignores archived copies", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-session-registry-"));
  const activeDirectory = path.join(root, "sessions", "2026", "09", "15");
  const archivedDirectory = path.join(root, "archived_sessions");
  mkdirSync(activeDirectory, { recursive: true });
  mkdirSync(archivedDirectory, { recursive: true });
  const activePath = path.join(activeDirectory, `rollout-${sessionId}.jsonl`);
  writeFileSync(activePath, `${JSON.stringify({
    type: "session_meta",
    payload: { id: sessionId, session_id: sessionId, cwd: "C:\\retained-worktree" }
  })}\n`);
  writeFileSync(path.join(archivedDirectory, `rollout-${sessionId}.jsonl`), "{}\n");
  try {
    assert.equal(await findActiveSessionFile(sessionId, root, "C:\\retained-worktree"), path.resolve(activePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed on missing, duplicate, or malformed session identity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-session-registry-"));
  const first = path.join(root, "sessions", "one");
  const second = path.join(root, "sessions", "two");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  try {
    assert.equal(await findActiveSessionFile(sessionId, root), null);
    const metadata = `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "C:\\worktree" } })}\n`;
    writeFileSync(path.join(first, `rollout-${sessionId}.jsonl`), metadata);
    writeFileSync(path.join(second, `rollout-${sessionId}.jsonl`), metadata);
    await assert.rejects(() => findActiveSessionFile(sessionId, root), /more than one/);
    await assert.rejects(() => findActiveSessionFile("not-a-uuid", root), /must be a UUID/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a correctly named session file with wrong or malformed metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-session-registry-"));
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions, { recursive: true });
  const sessionPath = path.join(sessions, `rollout-${sessionId}.jsonl`);
  try {
    writeFileSync(sessionPath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: "01a0a275-a2f1-73f1-89ae-000000000000", cwd: "C:\\retained-worktree" }
    })}\n`);
    await assert.rejects(() => findActiveSessionFile(sessionId, root, "C:\\retained-worktree"), /metadata UUID/);

    writeFileSync(sessionPath, `${JSON.stringify({
      type: "session_meta",
      payload: { id: sessionId, cwd: "C:\\wrong-worktree" }
    })}\n`);
    await assert.rejects(() => findActiveSessionFile(sessionId, root, "C:\\retained-worktree"), /metadata cwd/);

    writeFileSync(sessionPath, "{}\n");
    await assert.rejects(() => findActiveSessionFile(sessionId, root), /session_meta header/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

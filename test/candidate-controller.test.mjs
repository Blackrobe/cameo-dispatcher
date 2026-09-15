import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { changedPaths, deterministicBranchName, publicationRemoteHeadIsAllowed, validateCandidate } from "../src/candidate-controller.mjs";

function withRepo(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cameo-candidate-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  mkdirSync(path.join(root, "mods", "cameo"), { recursive: true });
  writeFileSync(path.join(root, "mods", "cameo", "rules.yaml"), "Value: 1\n");
  git("add", "."); git("commit", "-m", "base");
  try { run(root, git); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("validates a bounded in-scope candidate without moving HEAD", () => withRepo((root, git) => {
  const head = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "mods", "cameo", "rules.yaml"), "Value: 2\n");
  writeFileSync(path.join(root, "mods", "cameo", "new.yaml"), "Enabled: true\n");
  assert.deepEqual(changedPaths(root), ["mods/cameo/new.yaml", "mods/cameo/rules.yaml"]);
  const candidate = validateCandidate(root, { scope: ["mods/cameo"] }, head);
  assert.equal(candidate.head, head);
  assert.equal(candidate.candidateHash.length, 64);
}));

test("publication recovery is deterministic and fails closed on branch drift", () => {
  const config = { publication: { branchPrefix: "codex/dispatcher-" } };
  assert.equal(deterministicBranchName(config, "Discord Message 123"), "codex/dispatcher-discord-message-123");
  const committed = { state: "committed", lastCommit: "abc" };
  assert.equal(publicationRemoteHeadIsAllowed(committed, null), true);
  assert.equal(publicationRemoteHeadIsAllowed({ ...committed, expectedParent: "old" }, "old"), true);
  assert.equal(publicationRemoteHeadIsAllowed(committed, "abc"), true);
  assert.equal(publicationRemoteHeadIsAllowed(committed, "foreign"), false);
  assert.equal(publicationRemoteHeadIsAllowed({ state: "published", lastCommit: "abc" }, null), false);
});

test("rejects protected paths, scope escapes, secrets, and moved HEAD", () => withRepo((root, git) => {
  const head = git("rev-parse", "HEAD");
  writeFileSync(path.join(root, "AGENTS.md"), "override\n");
  assert.throws(() => validateCandidate(root, { scope: [] }, head), /protected path/);
  rmSync(path.join(root, "AGENTS.md"));
  writeFileSync(path.join(root, "outside.txt"), "value\n");
  assert.throws(() => validateCandidate(root, { scope: ["mods/cameo"] }, head), /exceeds requested scope/);
  rmSync(path.join(root, "outside.txt"));
  writeFileSync(path.join(root, "secret.txt"), "github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890\n");
  assert.throws(() => validateCandidate(root, { scope: [] }, head), /credential/);
  rmSync(path.join(root, "secret.txt"));
  writeFileSync(path.join(root, "mods", "cameo", "rules.yaml"), "Value: 3\n");
  git("add", "."); git("commit", "-m", "moved");
  assert.throws(() => validateCandidate(root, { scope: [] }, head), /HEAD moved/);
}));

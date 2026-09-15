import test from "node:test";
import assert from "node:assert/strict";

import { defaultMentionAcceptance, parseMentionIntake } from "../src/mention-intake.mjs";

const botId = "900000000000000001";

test("accepts only an immutable bot mention at raw position zero", () => {
  assert.deepEqual(parseMentionIntake(`<@${botId}> inspect active YAML`, botId), {
    kind: "task",
    objective: "inspect active YAML"
  });
  assert.deepEqual(parseMentionIntake(`<@!${botId}>\ninspect active YAML`, botId), {
    kind: "task",
    objective: "inspect active YAML"
  });
  assert.equal(parseMentionIntake(`hello <@${botId}> inspect active YAML`, botId), null);
  assert.equal(parseMentionIntake(`> <@${botId}> inspect active YAML`, botId), null);
  assert.equal(parseMentionIntake(`\`\`\`\n<@${botId}> inspect active YAML\n\`\`\``, botId), null);
  assert.equal(parseMentionIntake(` <@${botId}> inspect active YAML`, botId), null);
  assert.equal(parseMentionIntake(`＜＠${botId}＞ inspect active YAML`, botId), null);
  assert.equal(parseMentionIntake(`<@${botId}>inspect active YAML`, botId), null);
});

test("handles empty, help, and exact control hints without creating task text", () => {
  assert.deepEqual(parseMentionIntake(`<@${botId}>`, botId), { kind: "empty" });
  assert.deepEqual(parseMentionIntake(`<@${botId}>   `, botId), { kind: "empty" });
  assert.deepEqual(parseMentionIntake(`<@${botId}> help`, botId), { kind: "help" });
  assert.deepEqual(parseMentionIntake(`<@${botId}> status CAM-20260914-1234ABCD`, botId), {
    kind: "control_hint",
    command: "status",
    jobId: "CAM-20260914-1234ABCD"
  });
  assert.deepEqual(parseMentionIntake(`<@${botId}> cancel CAM-20260914-1234ABCD`, botId), {
    kind: "control_hint",
    command: "cancel",
    jobId: "CAM-20260914-1234ABCD"
  });
  assert.equal(parseMentionIntake(`<@${botId}> Help`, botId).kind, "task");
  assert.equal(defaultMentionAcceptance.length, 7);
});

test("recognizes bounded natural owner PR instructions but not capability questions", () => {
  for (const [text, action, requestedPrNumber] of [
    ["merge PR 400", "merge", 400],
    ["please merge PR #400", "merge", 400],
    ["try to merge this pull request", "merge", null],
    ["kindly close the PR.", "close", null],
    ["go ahead and merge your PR now", "merge", null],
    ["could you please merge PR 400?", "merge", 400]
  ])
    assert.deepEqual(parseMentionIntake(`<@${botId}> ${text}`, botId), {
      kind: "github_task_control", action, requestedPrNumber
    });
  assert.equal(parseMentionIntake(`<@${botId}> are you able to merge PR 400?`, botId).kind, "task");
  assert.equal(parseMentionIntake(`<@${botId}> explain whether PR 400 can merge`, botId).kind, "task");
  for (const text of [
    "don't merge PR 400", "merge PR 400 after CI finishes", "should we merge PR 400?",
    "is this PR mergeable?", "merge PR 400 and close PR 401", "merge it", "PR 400 merge",
    "can you merge PR 400?", "Explain how to merge PR 400", "Please explain how to merge PR 400?",
    "I cannot merge PR 400", "Aedis suggested we merge PR 400", "Please review the merge of PR 400",
    "don’t merge PR 400"
  ])
    assert.equal(parseMentionIntake(`<@${botId}> ${text}`, botId).kind, "task", text);
});

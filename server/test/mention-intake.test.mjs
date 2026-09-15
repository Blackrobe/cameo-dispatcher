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

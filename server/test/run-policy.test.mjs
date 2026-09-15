import test from "node:test";
import assert from "node:assert/strict";

import { chooseRunPolicy } from "../src/run-policy.mjs";

test("routes ordinary implementation to Sol high and visual work to Astra max", () => {
  assert.deepEqual(chooseRunPolicy("Fix the active unit cost"), {
    executionMode: "draft_pr", model: "gpt-5.6-sol", reasoningEffort: "high", modelSource: "default_route"
  });
  assert.deepEqual(chooseRunPolicy("Fix incorrect magenta player color in TKM sprites"), {
    executionMode: "draft_pr", model: "gpt-6-astra", reasoningEffort: "max", modelSource: "visual_route"
  });
});
test("accepts only the owner allowlist for explicit routing", () => {
  assert.equal(chooseRunPolicy("routine", { model: "gpt-6-astra", effort: "high" }).modelSource, "owner_explicit");
  assert.throws(() => chooseRunPolicy("routine", { model: "attacker-model" }));
  assert.throws(() => chooseRunPolicy("routine", { effort: "ultra" }));
});

import test from "node:test";
import assert from "node:assert/strict";

import { codexExecutionArgs, reviewerSelection } from "../src/codex-policy.mjs";

test("writer args ignore user config and disable external capabilities", () => {
  const args = codexExecutionArgs({ executionMode: "draft_pr", model: "gpt-6-astra", reasoningEffort: "max" }, "C:\\worktree", "schema.json", "final.json");
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  for (const required of [
    'approval_policy="never"', 'sandbox_workspace_write.network_access=false',
    'windows.sandbox="elevated"', 'features.apps=false', 'apps._default.enabled=false',
    'web_search="disabled"', 'features.skill_mcp_dependency_install=false'
  ])
    assert.ok(args.includes(required));
});
test("reviewer escalates visual work but keeps routine review on Sol high", () => {
  assert.equal(reviewerSelection({ model: "gpt-5.6-sol", objective: "Fix typo" }).model, "gpt-5.6-sol");
  assert.deepEqual(reviewerSelection({ model: "gpt-6-astra", objective: "Fix TKM sprite" }), {
    model: "gpt-6-astra", reasoningEffort: "max", reason: "complex_or_visual"
  });
});

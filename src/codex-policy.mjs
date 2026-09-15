const fixedConfig = Object.freeze([
  'approval_policy="never"',
  'sandbox_workspace_write.network_access=false',
  'windows.sandbox="elevated"',
  'features.apps=false',
  'apps._default.enabled=false',
  'apps._default.open_world_enabled=false',
  'web_search="disabled"',
  'features.skill_mcp_dependency_install=false'
]);

export function codexExecutionArgs(job, worktreePath, resultSchemaPath, finalPath) {
  const sandbox = job.executionMode === "draft_pr" ? "workspace-write" : "read-only";
  const args = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox", sandbox,
    "-m", job.model,
    "-c", `model_reasoning_effort="${job.reasoningEffort}"`
  ];
  for (const value of fixedConfig)
    args.push("-c", value);
  args.push(
    "-C", worktreePath,
    "--output-schema", resultSchemaPath,
    "--output-last-message", finalPath
  );
  return args;
}
export function reviewerSelection(job) {
  const complex = job.model === "gpt-6-astra"
    || /\b(engine|security|crash|save|network|multiplayer|economy|balance|sprite|palette|remap|tkm|voxel|shp)\b/i.test(job.objective);
  return complex
    ? { model: "gpt-6-astra", reasoningEffort: "max", reason: "complex_or_visual" }
    : { model: "gpt-5.6-sol", reasoningEffort: "high", reason: "routine" };
}

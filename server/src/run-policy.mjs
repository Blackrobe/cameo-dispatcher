export const MODELS = Object.freeze({
  sol: "gpt-5.6-sol",
  astra: "gpt-6-astra"
});

export const EFFORTS = Object.freeze(["high", "max"]);

const visualPattern = /\b(tkm|sprite|sprites|shp|voxel|vxl|hva|palette|palettes|remap|magenta|pixel|pixels|frame|frames|sequence|sequences|art|visual|render)\b/i;

export function chooseRunPolicy(objective, explicit = {}) {
  const model = explicit.model ?? (visualPattern.test(objective) ? MODELS.astra : MODELS.sol);
  const effort = explicit.effort ?? (model === MODELS.astra ? "max" : "high");
  if (!Object.values(MODELS).includes(model))
    throw new Error("model is not owner-allowlisted");
  if (!EFFORTS.includes(effort))
    throw new Error("reasoning effort is not owner-allowlisted");
  return {
    executionMode: explicit.executionMode ?? "draft_pr",
    model,
    reasoningEffort: effort,
    modelSource: explicit.model || explicit.effort ? "owner_explicit" : visualPattern.test(objective) ? "visual_route" : "default_route"
  };
}

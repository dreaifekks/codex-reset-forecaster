export const MODEL_ARTIFACT_VERSION = "reset-model-artifact/0.3.2";
export const MODEL_VERSION_PREFIX = "reset-model/0.3.2";

export function modelReleaseFromVersion(value) {
  const match = String(value ?? "").match(
    /^(reset-model\/\d+\.\d+\.\d+)(?:-|$)/,
  );
  return match?.[1] ?? null;
}

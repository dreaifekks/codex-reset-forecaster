export function completedRunOwnsServingSnapshot(runtimeState, snapshot) {
  const lastSuccessAt = Date.parse(runtimeState?.last_success_at ?? "");
  const issuedAt = Date.parse(snapshot?.prediction?.data?.issued_at ?? "");
  return Number.isFinite(lastSuccessAt) &&
    Number.isFinite(issuedAt) &&
    snapshot?.readiness?.serving_ready === true &&
    snapshot?.readiness?.synthetic_only !== true &&
    snapshot?.readiness?.current_forecast?.status === "fresh" &&
    typeof runtimeState?.last_prediction_id === "string" &&
    runtimeState.last_prediction_id.length > 0 &&
    snapshot?.prediction_ref?.record_id === runtimeState.last_prediction_id &&
    snapshot?.prediction?.record_id === runtimeState.last_prediction_id &&
    issuedAt <= lastSuccessAt;
}

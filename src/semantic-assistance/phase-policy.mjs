const STARTED_PHASE_CUES = new RegExp([
  String.raw`\bland(?:s|ing)?\b`,
  String.raw`\brolling\s+out\b`,
  String.raw`\bunderway\b`,
  String.raw`\bin\s+progress\b`,
  String.raw`\bpropagat(?:e|es|ed|ing)\b`,
  String.raw`\bgoing\s+live\b`,
  String.raw`\b(?:reset(?:ting|ing)?|refill(?:ing)?)\b[^.!?\n]{0,32}\b(?:now|currently)\b`,
].join("|"), "i");

const EXPECTED_PHASE_CUES =
  /\b(?:expect(?:s|ed|ing)?|likely|probably|should|might|may|could|hope(?:s|d|ing)?)\b/i;

const SCHEDULED_PHASE_CUES = new RegExp([
  String.raw`\bwill\b`,
  String.raw`\bgoing\s+to\b`,
  String.raw`\b(?:tomorrow|tonight|later|soon|incoming|in\s+a\s+bit)\b`,
  String.raw`\bnext\s+(?:\d{1,3}\s+)?(?:minutes?|hours?|day|week)\b`,
  String.raw`\b(?:in|within|over)\s+(?:the\s+)?(?:next\s+)?\d{1,3}\s+(?:minutes?|hours?)\b`,
].join("|"), "i");

// The model may resolve semantics, but it cannot invent a phase unsupported by
// the authority wrapper. Conflicting lower-priority phases fail closed.
export function semanticTimingPhaseHasWrapperSupport(text, phase) {
  const wrapper = String(text ?? "");
  const started = STARTED_PHASE_CUES.test(wrapper);
  const expected = EXPECTED_PHASE_CUES.test(wrapper);
  if (phase === "started") return started;
  if (phase === "expected") return expected && !started;
  if (phase === "scheduled") {
    return SCHEDULED_PHASE_CUES.test(wrapper) && !started && !expected;
  }
  return false;
}

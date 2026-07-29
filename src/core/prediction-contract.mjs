export const FORECAST_PRODUCER_NAME = "reset-forecaster";
export const FORECAST_PRODUCER_VERSION = "0.3.2";

function numericVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(value, minimum) {
  const actual = numericVersion(value);
  const required = numericVersion(minimum);
  if (!actual || !required) return false;
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index] !== required[index]) {
      return actual[index] > required[index];
    }
  }
  return true;
}

export function predictionRequiresPostOutcomeRefractory(prediction) {
  if (prediction?.producer?.name !== FORECAST_PRODUCER_NAME) return false;
  const version = prediction.producer.version;
  return numericVersion(version) === null ||
    atLeast(version, FORECAST_PRODUCER_VERSION);
}

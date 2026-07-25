import { sha256, stableStringify } from "../core/hash.mjs";
import { clamp } from "../core/time.mjs";

function sigmoid(value) {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function dot(left, right) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

function identity(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => row === column ? 1 : 0),
  );
}

function invertSymmetricPositiveDefinite(matrix) {
  const size = matrix.length;
  const scale = Math.max(...matrix.map((row, index) => Math.abs(row[index])));
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  let minimumDiagonal = Infinity;
  let maximumDiagonal = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = matrix[row][column];
      for (let index = 0; index < column; index += 1) {
        value -= lower[row][index] * lower[column][index];
      }
      if (row === column) {
        if (!Number.isFinite(value) || value <= scale * 1e-10) return null;
        lower[row][column] = Math.sqrt(value);
        minimumDiagonal = Math.min(minimumDiagonal, lower[row][column]);
        maximumDiagonal = Math.max(maximumDiagonal, lower[row][column]);
      } else {
        lower[row][column] = value / lower[column][column];
      }
    }
  }
  const inverse = Array.from({ length: size }, () => Array(size).fill(0));
  for (let basis = 0; basis < size; basis += 1) {
    const forward = Array(size).fill(0);
    for (let row = 0; row < size; row += 1) {
      let value = row === basis ? 1 : 0;
      for (let column = 0; column < row; column += 1) {
        value -= lower[row][column] * forward[column];
      }
      forward[row] = value / lower[row][row];
    }
    const solution = Array(size).fill(0);
    for (let row = size - 1; row >= 0; row -= 1) {
      let value = forward[row];
      for (let column = row + 1; column < size; column += 1) {
        value -= lower[column][row] * solution[column];
      }
      solution[row] = value / lower[row][row];
    }
    for (let row = 0; row < size; row += 1) inverse[row][basis] = solution[row];
  }
  if (!inverse.every((row) => row.every(Number.isFinite))) return null;
  return {
    inverse,
    conditionEstimate: (maximumDiagonal / minimumDiagonal) ** 2,
  };
}

function standardization(examples, featureCount) {
  const rows = examples.flatMap((example) => example.type === "event_interval" ? example.rows : [example.row]);
  const means = Array(featureCount).fill(0);
  for (const row of rows) row.forEach((value, index) => { means[index] += value; });
  means.forEach((_, index) => { means[index] /= Math.max(1, rows.length); });
  const scales = Array(featureCount).fill(0);
  for (const row of rows) {
    row.forEach((value, index) => { scales[index] += (value - means[index]) ** 2; });
  }
  scales.forEach((_, index) => {
    scales[index] = Math.sqrt(scales[index] / Math.max(1, rows.length));
    if (scales[index] < 1e-8) scales[index] = 1;
  });
  return { means, scales };
}

function exposuresFor(example) {
  return example.rows.map((_, index) => {
    const exposure = Number(example.exposures?.[index] ?? 1);
    return clamp(exposure, 0, 1);
  });
}

function transform(row, means, scales) {
  return [1, ...row.map((value, index) => (value - means[index]) / scales[index])];
}

function contributions(example, weights, means, scales) {
  if (example.type === "negative") {
    const x = transform(example.row, means, scales);
    const probability = sigmoid(dot(weights, x));
    return [{ x, gradientFactor: -probability, probability, target: 0 }];
  }
  const transformed = example.rows.map((row) => transform(row, means, scales));
  const probabilities = transformed.map((x) => sigmoid(dot(weights, x)));
  const exposures = exposuresFor(example);
  const survival = probabilities.reduce(
    (value, probability, index) => value * (1 - probability) ** exposures[index],
    1,
  );
  const eventProbability = clamp(1 - survival, 1e-12, 1 - 1e-12);
  return transformed.map((x, index) => ({
    x,
    gradientFactor: (exposures[index] * survival * probabilities[index]) / eventProbability,
    probability: probabilities[index],
    target: 1,
  }));
}

function logLikelihood(examples, weights, means, scales, lambda, coefficientPriors) {
  let value = 0;
  for (const example of examples) {
    if (example.type === "negative") {
      const x = transform(example.row, means, scales);
      value += Math.log(clamp(1 - sigmoid(dot(weights, x)), 1e-12, 1));
    } else {
      const exposures = exposuresFor(example);
      const survival = example.rows
        .map((row) => sigmoid(dot(weights, transform(row, means, scales))))
        .reduce(
          (result, probability, index) => result * (1 - probability) ** exposures[index],
          1,
        );
      value += Math.log(clamp(1 - survival, 1e-12, 1));
    }
  }
  for (let index = 1; index < weights.length; index += 1) {
    value -= 0.5 * lambda * (weights[index] - coefficientPriors[index]) ** 2;
  }
  return value;
}

function objectiveAndGradient(examples, weights, means, scales, lambda, coefficientPriors) {
  const gradient = Array(weights.length).fill(0);
  for (const example of examples) {
    for (const contribution of contributions(example, weights, means, scales)) {
      contribution.x.forEach((value, index) => {
        gradient[index] += contribution.gradientFactor * value;
      });
    }
  }
  for (let index = 1; index < weights.length; index += 1) {
    gradient[index] -= lambda * (weights[index] - coefficientPriors[index]);
  }
  const scale = Math.max(1, examples.length);
  return {
    objective: -logLikelihood(examples, weights, means, scales, lambda, coefficientPriors) / scale,
    gradient: gradient.map((value) => -value / scale),
  };
}

function numericalObservedHessian(
  examples,
  weights,
  means,
  scales,
  lambda,
  coefficientPriors,
  relativeStep,
) {
  const size = weights.length;
  const hessian = Array.from({ length: size }, () => Array(size).fill(0));
  for (let column = 0; column < size; column += 1) {
    const step = relativeStep * Math.max(1, Math.abs(weights[column]));
    const plus = [...weights];
    const minus = [...weights];
    plus[column] += step;
    minus[column] -= step;
    const plusGradient = objectiveAndGradient(
      examples,
      plus,
      means,
      scales,
      lambda,
      coefficientPriors,
    ).gradient;
    const minusGradient = objectiveAndGradient(
      examples,
      minus,
      means,
      scales,
      lambda,
      coefficientPriors,
    ).gradient;
    for (let row = 0; row < size; row += 1) {
      hessian[row][column] =
        (plusGradient[row] - minusGradient[row]) / (2 * step);
    }
  }
  const likelihoodScale = Math.max(1, examples.length);
  return hessian.map((row, rowIndex) =>
    row.map((value, columnIndex) =>
      likelihoodScale * 0.5 * (value + hessian[columnIndex][rowIndex]),
    ),
  );
}

function norm(values) {
  return Math.sqrt(values.reduce((sum, value) => sum + value ** 2, 0));
}

function matrixVector(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function bfgsInverseUpdate(inverse, step, gradientChange) {
  const curvature = dot(step, gradientChange);
  if (!Number.isFinite(curvature) || curvature <= 1e-12) return identity(inverse.length);
  const size = inverse.length;
  const rho = 1 / curvature;
  const left = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) =>
      (row === column ? 1 : 0) - rho * step[row] * gradientChange[column],
    ),
  );
  const right = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) =>
      (row === column ? 1 : 0) - rho * gradientChange[row] * step[column],
    ),
  );
  const intermediate = left.map((row) =>
    Array.from({ length: size }, (_, column) =>
      row.reduce((sum, value, index) => sum + value * inverse[index][column], 0),
    ),
  );
  return intermediate.map((row, rowIndex) =>
    Array.from({ length: size }, (_, column) =>
      row.reduce((sum, value, index) => sum + value * right[index][column], 0) +
      rho * step[rowIndex] * step[column],
    ),
  );
}

export function trainLogisticHazard(examples, featureNames, options = {}) {
  if (!Array.isArray(examples) || examples.length === 0) throw new Error("Training examples are required");
  const eventCount = examples.filter((example) => example.type === "event_interval").length;
  if (eventCount === 0) throw new Error("At least one confirmed event interval is required");
  const lambda = options.lambda ?? 2;
  const maxIterations = options.maxIterations ?? 2500;
  const gradientTolerance = options.gradientTolerance ?? 1e-5;
  const objectiveTolerance = options.objectiveTolerance ?? 1e-10;
  const initialStep = options.initialStep ?? options.learningRate ?? 1;
  const hessianStep = options.hessianStep ?? 1e-4;
  if (!Number.isFinite(initialStep) || initialStep <= 0) {
    throw new RangeError("Optimizer initial step must be positive");
  }
  if (!Number.isFinite(gradientTolerance) || gradientTolerance <= 0) {
    throw new RangeError("Optimizer gradient tolerance must be positive");
  }
  if (!Number.isFinite(objectiveTolerance) || objectiveTolerance <= 0) {
    throw new RangeError("Optimizer objective tolerance must be positive");
  }
  if (!Number.isFinite(hessianStep) || hessianStep <= 0) {
    throw new RangeError("Numerical Hessian step must be positive");
  }
  const configuredPriors = options.coefficientPriors ?? {};
  const coefficientPriors = [
    0,
    ...featureNames.map((name) => Number(configuredPriors[name] ?? 0)),
  ];
  const { means, scales } = standardization(examples, featureNames.length);
  const totalRows = examples.reduce((sum, example) => sum + (example.rows?.length ?? 1), 0);
  const prevalence = clamp(eventCount / totalRows, 1e-5, 1 - 1e-5);
  const weights = [...coefficientPriors];
  weights[0] = Math.log(prevalence / (1 - prevalence));
  let inverseHessian = identity(weights.length);
  let state = objectiveAndGradient(
    examples,
    weights,
    means,
    scales,
    lambda,
    coefficientPriors,
  );
  let iterations = 0;
  let converged = norm(state.gradient) <= gradientTolerance;
  let stopReason = converged ? "gradient_tolerance" : "max_iterations";

  while (!converged && iterations < maxIterations) {
    let direction = matrixVector(inverseHessian, state.gradient).map((value) => -value);
    if (!direction.every(Number.isFinite) || dot(state.gradient, direction) >= 0) {
      inverseHessian = identity(weights.length);
      direction = state.gradient.map((value) => -value);
    }
    const directionalDerivative = dot(state.gradient, direction);
    let stepSize = initialStep;
    let candidate = null;
    let candidateState = null;
    while (stepSize >= 1e-12) {
      candidate = weights.map((value, index) => value + stepSize * direction[index]);
      candidateState = objectiveAndGradient(
        examples,
        candidate,
        means,
        scales,
        lambda,
        coefficientPriors,
      );
      if (
        Number.isFinite(candidateState.objective) &&
        candidateState.objective <= state.objective + 1e-4 * stepSize * directionalDerivative
      ) {
        break;
      }
      stepSize /= 2;
    }
    if (stepSize < 1e-12 || !candidateState) {
      stopReason = "line_search_failed";
      break;
    }
    const parameterStep = candidate.map((value, index) => value - weights[index]);
    const gradientChange = candidateState.gradient.map(
      (value, index) => value - state.gradient[index],
    );
    inverseHessian = bfgsInverseUpdate(inverseHessian, parameterStep, gradientChange);
    const objectiveChange = Math.abs(state.objective - candidateState.objective);
    weights.splice(0, weights.length, ...candidate);
    state = candidateState;
    iterations += 1;
    const gradientNorm = norm(state.gradient);
    if (gradientNorm <= gradientTolerance) {
      converged = true;
      stopReason = "gradient_tolerance";
    } else if (
      objectiveChange <= objectiveTolerance * (1 + Math.abs(state.objective)) &&
      gradientNorm <= Math.max(gradientTolerance * 10, 1e-4)
    ) {
      converged = true;
      stopReason = "objective_tolerance";
    }
  }

  const hessian = numericalObservedHessian(
    examples,
    weights,
    means,
    scales,
    lambda,
    coefficientPriors,
    hessianStep,
  );
  const inverseResult = invertSymmetricPositiveDefinite(hessian);
  const covariance = inverseResult?.inverse ?? null;
  const uncertainty = inverseResult
    ? {
      status: "available",
      method: "inverse_observed_numerical_hessian",
      hessian_step: hessianStep,
      condition_estimate: inverseResult.conditionEstimate,
    }
    : {
      status: "unavailable",
      method: "inverse_observed_numerical_hessian",
      hessian_step: hessianStep,
      reason: "observed_hessian_not_positive_definite_or_singular",
    };
  const trained = {
    family: "ridge_logistic_discrete_time_hazard",
    feature_names: featureNames,
    means,
    scales,
    weights,
    covariance,
    uncertainty,
    lambda,
    coefficient_priors: coefficientPriors,
    iterations,
    converged,
    stop_reason: stopReason,
    objective: state.objective,
    gradient_norm: norm(state.gradient),
    optimizer: {
      method: "bfgs_backtracking",
      initial_step: initialStep,
      gradient_tolerance: gradientTolerance,
      objective_tolerance: objectiveTolerance,
      hessian_step: hessianStep,
    },
    event_count: eventCount,
    example_count: examples.length,
    training_data_hash: sha256(stableStringify(examples)),
  };
  trained.artifact_hash = sha256(stableStringify(trained));
  return trained;
}

export function assertModelCompatibility(model, {
  featureNames,
  featureSchemaVersion = null,
  configHash = null,
  modelContractHash = null,
  requireConverged = false,
} = {}) {
  if (!model || typeof model !== "object") throw new Error("Model artifact is required");
  if (model.artifact_hash) {
    const immutablePayload = structuredClone(model);
    delete immutablePayload.artifact_hash;
    delete immutablePayload.promoted_at;
    delete immutablePayload.promotion_evaluation;
    if (sha256(stableStringify(immutablePayload)) !== model.artifact_hash) {
      throw new Error("Model artifact hash does not match its immutable payload");
    }
  }
  if (JSON.stringify(model.feature_names) !== JSON.stringify(featureNames)) {
    throw new Error("Model feature names do not match the runtime feature schema");
  }
  if (model.weights?.length !== featureNames.length + 1 ||
      model.means?.length !== featureNames.length ||
      model.scales?.length !== featureNames.length) {
    throw new Error("Model coefficient dimensions do not match the runtime feature schema");
  }
  const coefficientCount = featureNames.length + 1;
  if (model.covariance === null) {
    if (model.uncertainty?.status !== "unavailable") {
      throw new Error("Model without covariance must declare uncertainty unavailable");
    }
  } else {
    if (
      model.covariance?.length !== coefficientCount ||
      !model.covariance.every((row) =>
        Array.isArray(row) &&
        row.length === coefficientCount &&
        row.every(Number.isFinite)
      )
    ) {
      throw new Error("Model covariance dimensions do not match the runtime feature schema");
    }
  }
  if (featureSchemaVersion && model.feature_schema_version !== featureSchemaVersion) {
    throw new Error("Model feature schema version does not match runtime configuration");
  }
  if (configHash && model.config_hash !== configHash) {
    throw new Error("Model configuration hash does not match runtime configuration");
  }
  if (modelContractHash && model.model_contract_hash !== modelContractHash) {
    throw new Error("Model contract hash does not match runtime model configuration");
  }
  if (requireConverged && model.converged !== true) {
    throw new Error(`Model optimizer is not converged (${model.stop_reason ?? "unknown"})`);
  }
  if (![...model.weights, ...model.means, ...model.scales].every(Number.isFinite)) {
    throw new Error("Model artifact contains non-finite coefficients");
  }
  if (model.scales.some((scale) => scale <= 0)) {
    throw new Error("Model artifact contains a non-positive feature scale");
  }
  return true;
}

export function predictHazard(model, row) {
  const x = transform(row, model.means, model.scales);
  const linear = dot(model.weights, x);
  const probability = sigmoid(linear);
  if (
    model.calibrator &&
    (
      model.calibrator.method !== "identity" ||
      model.calibrator_version !== model.calibrator.version
    )
  ) {
    throw new Error("Unsupported or inconsistent model calibrator");
  }
  if (model.covariance === null || model.uncertainty?.status === "unavailable") {
    return {
      probability,
      interval80: null,
      uncertainty: {
        status: "unavailable",
        reason: model.uncertainty?.reason ?? "model_covariance_unavailable",
      },
    };
  }
  let variance = 0;
  for (let left = 0; left < x.length; left += 1) {
    for (let right = 0; right < x.length; right += 1) {
      variance += x[left] * (model.covariance?.[left]?.[right] ?? 0) * x[right];
    }
  }
  const standardError = Math.sqrt(Math.max(0, variance));
  const critical80 = 1.2815515655446004;
  return {
    probability,
    interval80: [
      sigmoid(linear - critical80 * standardError),
      sigmoid(linear + critical80 * standardError),
    ],
    uncertainty: { status: "available" },
  };
}

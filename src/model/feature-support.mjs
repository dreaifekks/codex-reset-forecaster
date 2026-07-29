export const FEATURE_SUPPORT_POLICY_VERSION = "feature-support-gate/1";

export const DEFAULT_FEATURE_SUPPORT_POLICY = Object.freeze({
  version: FEATURE_SUPPORT_POLICY_VERSION,
  enabled: false,
  minimum_nonzero_positive_events: 3,
  minimum_nonzero_negative_hours: 24,
  maximum_absolute_pairwise_correlation: 0.995,
  nonzero_epsilon: 1e-12,
});

export function assertFeatureSupportPolicy(policy) {
  if (
    policy?.version !== FEATURE_SUPPORT_POLICY_VERSION ||
    typeof policy.enabled !== "boolean" ||
    !Number.isInteger(policy.minimum_nonzero_positive_events) ||
    policy.minimum_nonzero_positive_events < 1 ||
    !Number.isInteger(policy.minimum_nonzero_negative_hours) ||
    policy.minimum_nonzero_negative_hours < 1 ||
    !Number.isFinite(policy.maximum_absolute_pairwise_correlation) ||
    policy.maximum_absolute_pairwise_correlation <= 0 ||
    policy.maximum_absolute_pairwise_correlation > 1 ||
    !Number.isFinite(policy.nonzero_epsilon) ||
    policy.nonzero_epsilon <= 0
  ) {
    throw new TypeError(
      "model.feature_support must use the supported versioned support thresholds",
    );
  }
}

function exposedRows(example) {
  if (example.type === "negative") {
    return [{ row: example.row, weight: 1 }];
  }
  return example.rows.map((row, index) => ({
    row,
    weight: Math.max(0, Math.min(1, Number(example.exposures?.[index] ?? 1))),
  })).filter(({ weight }) => weight > 0);
}

function weightedCorrelation(rows, leftIndex, rightIndex, epsilon) {
  const totalWeight = rows.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) return null;
  const leftMean = rows.reduce(
    (sum, entry) => sum + entry.weight * entry.row[leftIndex],
    0,
  ) / totalWeight;
  const rightMean = rows.reduce(
    (sum, entry) => sum + entry.weight * entry.row[rightIndex],
    0,
  ) / totalWeight;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const entry of rows) {
    const left = entry.row[leftIndex] - leftMean;
    const right = entry.row[rightIndex] - rightMean;
    covariance += entry.weight * left * right;
    leftVariance += entry.weight * left ** 2;
    rightVariance += entry.weight * right ** 2;
  }
  if (leftVariance <= epsilon ** 2 || rightVariance <= epsilon ** 2) {
    return null;
  }
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

function supportScore(feature, policy) {
  return Math.min(
    feature.positive_nonzero_event_count /
      policy.minimum_nonzero_positive_events,
    feature.negative_nonzero_hour_count /
      policy.minimum_nonzero_negative_hours,
  );
}

export function assessFeatureSupport(
  examples,
  featureNames,
  policy = DEFAULT_FEATURE_SUPPORT_POLICY,
) {
  assertFeatureSupportPolicy(policy);
  if (!Array.isArray(examples) || examples.length === 0) {
    throw new TypeError("Feature support assessment requires training examples");
  }
  if (!Array.isArray(featureNames)) {
    throw new TypeError("Feature support assessment requires feature names");
  }
  const rows = examples.flatMap(exposedRows);
  for (const { row, weight } of rows) {
    if (
      !Array.isArray(row) ||
      row.length !== featureNames.length ||
      !row.every(Number.isFinite) ||
      !Number.isFinite(weight)
    ) {
      throw new TypeError(
        "Feature support assessment requires finite, schema-aligned rows",
      );
    }
  }
  const positiveExamples = examples.filter(
    (example) => example.type === "event_interval",
  );
  const negativeExamples = examples.filter(
    (example) => example.type === "negative",
  );
  const features = featureNames.map((featureName, featureIndex) => {
    const positiveNonzeroEventCount = positiveExamples.filter((example) =>
      exposedRows(example).some(({ row }) =>
        Math.abs(row[featureIndex]) > policy.nonzero_epsilon
      )
    ).length;
    const positiveNonzeroRowCount = positiveExamples.reduce(
      (count, example) =>
        count + exposedRows(example).filter(({ row }) =>
          Math.abs(row[featureIndex]) > policy.nonzero_epsilon
        ).length,
      0,
    );
    const negativeNonzeroHourCount = negativeExamples.filter((example) =>
      Math.abs(example.row[featureIndex]) > policy.nonzero_epsilon
    ).length;
    const totalWeight = rows.reduce((sum, entry) => sum + entry.weight, 0);
    const mean = totalWeight === 0
      ? 0
      : rows.reduce(
        (sum, entry) => sum + entry.weight * entry.row[featureIndex],
        0,
      ) / totalWeight;
    const variance = totalWeight === 0
      ? 0
      : rows.reduce(
        (sum, entry) =>
          sum + entry.weight * (entry.row[featureIndex] - mean) ** 2,
        0,
      ) / totalWeight;
    const reasons = [];
    if (policy.enabled) {
      if (
        positiveNonzeroEventCount <
        policy.minimum_nonzero_positive_events
      ) {
        reasons.push("insufficient_positive_support");
      }
      if (
        negativeNonzeroHourCount <
        policy.minimum_nonzero_negative_hours
      ) {
        reasons.push("insufficient_negative_support");
      }
      if (variance <= policy.nonzero_epsilon ** 2) {
        reasons.push("zero_variance");
      }
    }
    return {
      feature_name: featureName,
      feature_index: featureIndex,
      status: reasons[0] ?? "active",
      reasons,
      positive_nonzero_event_count: positiveNonzeroEventCount,
      positive_nonzero_row_count: positiveNonzeroRowCount,
      negative_nonzero_hour_count: negativeNonzeroHourCount,
      total_nonzero_row_count:
        positiveNonzeroRowCount + negativeNonzeroHourCount,
      weighted_mean: mean,
      weighted_variance: variance,
      collinear_with: null,
    };
  });

  const eligible = features.filter((feature) => feature.status === "active");
  const parent = new Map(eligible.map((feature) => [
    feature.feature_index,
    feature.feature_index,
  ]));
  const find = (index) => {
    let cursor = index;
    while (parent.get(cursor) !== cursor) cursor = parent.get(cursor);
    while (parent.get(index) !== index) {
      const next = parent.get(index);
      parent.set(index, cursor);
      index = next;
    }
    return cursor;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const correlations = [];
  if (policy.enabled) {
    for (let left = 0; left < eligible.length; left += 1) {
      for (let right = left + 1; right < eligible.length; right += 1) {
        const correlation = weightedCorrelation(
          rows,
          eligible[left].feature_index,
          eligible[right].feature_index,
          policy.nonzero_epsilon,
        );
        if (
          correlation !== null &&
          Math.abs(correlation) >=
            policy.maximum_absolute_pairwise_correlation
        ) {
          correlations.push({
            left: eligible[left].feature_index,
            right: eligible[right].feature_index,
            absolute_correlation: Math.abs(correlation),
          });
          union(eligible[left].feature_index, eligible[right].feature_index);
        }
      }
    }
  }

  const grouped = new Map();
  for (const feature of eligible) {
    const root = find(feature.feature_index);
    const group = grouped.get(root) ?? [];
    group.push(feature);
    grouped.set(root, group);
  }
  const collinearityGroups = [];
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((left, right) =>
      supportScore(right, policy) - supportScore(left, policy) ||
      right.total_nonzero_row_count - left.total_nonzero_row_count ||
      left.feature_index - right.feature_index
    );
    const representative = ranked[0];
    const suppressed = ranked.slice(1);
    for (const feature of suppressed) {
      feature.status = "collinear_duplicate";
      feature.reasons.push("collinear_duplicate");
      feature.collinear_with = representative.feature_name;
    }
    const indices = new Set(group.map((feature) => feature.feature_index));
    collinearityGroups.push({
      members: group
        .sort((left, right) => left.feature_index - right.feature_index)
        .map((feature) => feature.feature_name),
      representative: representative.feature_name,
      suppressed: suppressed.map((feature) => feature.feature_name),
      maximum_absolute_correlation: Math.max(
        ...correlations
          .filter(({ left, right }) =>
            indices.has(left) && indices.has(right)
          )
          .map(({ absolute_correlation }) => absolute_correlation),
      ),
    });
  }

  const activeFeatures = features.filter(
    (feature) => feature.status === "active",
  );
  return {
    version: FEATURE_SUPPORT_POLICY_VERSION,
    policy: structuredClone(policy),
    input_feature_count: featureNames.length,
    active_feature_count: activeFeatures.length,
    positive_event_count: positiveExamples.length,
    negative_hour_count: negativeExamples.length,
    active_features: activeFeatures.map((feature) => feature.feature_name),
    features,
    collinearity_groups: collinearityGroups,
  };
}

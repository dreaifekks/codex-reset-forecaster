#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "schemas", "reset-intel.schema.json");
const examplesDir = path.join(root, "examples");
const allowedTypes = new Set([
  "raw_observation",
  "normalized_signal",
  "event_candidate",
  "reset_outcome",
  "feature_snapshot",
  "prediction",
]);

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${path.relative(root, filePath)} is not valid JSON: ${error.message}`);
  }
}

function isUtc(value) {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function assertProbability(value, label) {
  if (typeof value !== "number" || value < 0 || value > 1) {
    fail(`${label} must be a probability, got ${JSON.stringify(value)}`);
  }
}

function validateEnvelope(record, fileName) {
  if (record.schema_version !== "reset-intel/0.1") fail(`${fileName}: wrong schema_version`);
  if (!allowedTypes.has(record.record_type)) fail(`${fileName}: unsupported record_type`);
  if (!record.record_id || !Number.isInteger(record.revision) || record.revision < 1) {
    fail(`${fileName}: invalid record identity`);
  }
  if (!isUtc(record.created_at)) fail(`${fileName}: created_at must be RFC 3339 UTC`);
  if (!record.producer?.name || !record.producer?.version) fail(`${fileName}: producer is incomplete`);
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
    fail(`${fileName}: data must be an object`);
  }
}

function validateRange(range, label) {
  if (!range) return;
  if (!isUtc(range.start) || !isUtc(range.end)) fail(`${label}: range timestamps must be UTC`);
  if (Date.parse(range.start) >= Date.parse(range.end)) fail(`${label}: range start must precede end`);
  if (range.boundary !== "[start,end)") fail(`${label}: boundary must be [start,end)`);
}

function closeEnough(left, right, tolerance = 1e-9) {
  return Math.abs(left - right) <= tolerance;
}

function validatePrediction(record, fileName) {
  const data = record.data;
  if (!isUtc(data.issued_at) || !isUtc(data.knowledge_cutoff)) {
    fail(`${fileName}: prediction timestamps must be UTC`);
  }
  validateRange(data.horizon, `${fileName}: horizon`);
  if (data.base_slot !== "PT1H" || data.display_horizon !== "PT4H") {
    fail(`${fileName}: expected PT1H base slot and PT4H display horizon`);
  }
  if (!Array.isArray(data.slots) || data.slots.length === 0 || data.slots.length > 168) {
    fail(`${fileName}: slots must contain 1..168 entries`);
  }

  let survival = 1;
  let previousEnd = null;
  for (const [index, slot] of data.slots.entries()) {
    validateRange({ start: slot.start, end: slot.end, boundary: "[start,end)" }, `${fileName}: slot ${index}`);
    if (Date.parse(slot.end) - Date.parse(slot.start) !== 60 * 60 * 1000) {
      fail(`${fileName}: slot ${index} is not one hour`);
    }
    if (previousEnd && slot.start !== previousEnd) fail(`${fileName}: slots are not contiguous`);
    previousEnd = slot.end;
    for (const key of ["hazard", "first_reset_probability", "reset_by_end_probability", "rolling_4h_probability"]) {
      assertProbability(slot[key], `${fileName}: slot ${index}.${key}`);
    }
    const expectedFirst = survival * slot.hazard;
    if (!closeEnough(slot.first_reset_probability, expectedFirst, 1e-8)) {
      fail(`${fileName}: slot ${index} first-reset probability is inconsistent with hazard`);
    }
    survival *= 1 - slot.hazard;
    if (!closeEnough(slot.reset_by_end_probability, 1 - survival, 1e-8)) {
      fail(`${fileName}: slot ${index} cumulative probability is inconsistent with hazard`);
    }
  }
  if (data.event_process === "first_reset") {
    assertProbability(data.no_reset_probability, `${fileName}: no_reset_probability`);
    if (!closeEnough(data.no_reset_probability, survival, 1e-8)) {
      fail(`${fileName}: no_reset_probability is inconsistent with hourly hazards`);
    }
  }
}

const schema = readJson(schemaPath);
if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
  fail("schemas/reset-intel.schema.json must declare JSON Schema draft 2020-12");
}
if (!schema.$defs?.envelope || !schema.$defs?.prediction) {
  fail("schemas/reset-intel.schema.json is missing core definitions");
}

const exampleFiles = fs.readdirSync(examplesDir).filter((name) => name.endsWith(".json")).sort();
if (exampleFiles.length === 0) fail("No JSON examples found");

for (const fileName of exampleFiles) {
  const record = readJson(path.join(examplesDir, fileName));
  validateEnvelope(record, fileName);
  if (record.record_type === "normalized_signal") {
    if (!isUtc(record.data.available_at)) fail(`${fileName}: available_at must be UTC`);
    validateRange(record.data.claim?.asserted_time_range, `${fileName}: asserted_time_range`);
    assertProbability(record.data.extraction?.confidence, `${fileName}: extraction confidence`);
  }
  if (record.record_type === "reset_outcome") {
    if (!isUtc(record.data.known_at)) fail(`${fileName}: known_at must be UTC`);
    validateRange(record.data.occurred_time_range, `${fileName}: occurred_time_range`);
  }
  if (record.record_type === "prediction") validatePrediction(record, fileName);
}

console.log(`Validated schema and ${exampleFiles.length} example records.`);

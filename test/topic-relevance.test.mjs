import assert from "node:assert/strict";
import test from "node:test";
import {
  assessTopicRelevance,
  TOPIC_RELEVANCE_POLICY_VERSION,
} from "../src/pipeline/topic-relevance.mjs";

const relevantParent = {
  relation_type: "reply",
  text: "Codex is degraded and the team is investigating a capacity incident.",
  observation_ref: {
    record_id: "obs_parent_incident",
    revision: 1,
  },
};

test("topic relevance policy exposes a stable version", () => {
  assert.equal(
    TOPIC_RELEVANCE_POLICY_VERSION,
    "reset-topic-relevance/2",
  );
});

test("real gateway false positives and reset requests are rejected", () => {
  const cases = [
    {
      name: "Gemini individual 429",
      text: "__RATE_LIMIT__: Gemini monthly cap exceeded. HTTP 429: You exceeded your current quota.",
      reason: "individual_quota_error",
    },
    {
      name: "Grok philosophy",
      text: "Grok isn’t so sure: abundance is not enough. The capacity to define what matters belongs to people, and technology will force society to reconsider its values.",
      reason: "generic_discussion",
    },
    {
      name: "non-claim reset hint",
      text: "Trying, but not sure this time (possible reset hint; does not explicitly state Codex usage-limit reset).",
      reason: "explicit_non_claim",
    },
    {
      name: "Claude reset request",
      text: "Hey Anthropic, please reset Claude Code usage limits for us.",
      reason: "request_or_hypothetical",
    },
    {
      name: "Claude startup workflow",
      text: "Claude can build your entire startup from idea to launch for free.",
      reason: "generic_discussion",
    },
    {
      name: "generic model release cycle",
      text: "Models are releasing in a cycle, so the next Google release after Gemini will outperform the current best.",
      reason: "generic_discussion",
    },
  ];

  for (const entry of cases) {
    const assessed = assessTopicRelevance({
      text: entry.text,
      sourceRole: "aggregator",
    });
    assert.equal(assessed.decision, "irrelevant", entry.name);
    assert.equal(assessed.reason_code, entry.reason, entry.name);
    assert.equal(assessed.basis, "self", entry.name);
    assert.deepEqual(assessed.matched_segments, [], entry.name);
    assert.deepEqual(assessed.context_refs, [], entry.name);
  }
});

test("source authority alone cannot turn a vague other-limit comment into a target signal", () => {
  const assessed = assessTopicRelevance({
    text: "And transitively might also have reset other rate limits out there.",
    sourceRole: "product_lead",
  });
  assert.equal(assessed.decision, "irrelevant");
  assert.equal(assessed.reason_code, "generic_discussion");
});

test("genuine target operations and ecosystem policy or release claims are relevant", () => {
  const cases = [
    {
      text: "We have reset Codex usage limits for all paid users.",
      reason: "target_operational_claim",
    },
    {
      text: "Codex is degraded and the team is investigating a capacity incident.",
      reason: "target_operational_claim",
    },
    {
      text: "ChatGPT Work rate limits will be doubled for all paid plans tomorrow.",
      reason: "target_operational_claim",
    },
    {
      text: "Anthropic doubled Claude Code usage limits across all paid plans.",
      reason: "ecosystem_operational_claim",
    },
    {
      text: "Google increased Gemini API rate limits for all users.",
      reason: "ecosystem_operational_claim",
    },
    {
      text: "Google officially released Gemini 3.6 Flash today.",
      reason: "ecosystem_operational_claim",
    },
    {
      text: "Anthropic launched Claude 5 for general availability.",
      reason: "ecosystem_operational_claim",
    },
    {
      text: "Claude Opus 5 launched at half the prior price.",
      reason: "ecosystem_operational_claim",
    },
  ];

  for (const entry of cases) {
    const assessed = assessTopicRelevance({
      text: entry.text,
      sourceRole: "community",
    });
    assert.equal(assessed.decision, "relevant", entry.text);
    assert.equal(assessed.reason_code, entry.reason, entry.text);
    assert.equal(assessed.basis, "self", entry.text);
    assert.deepEqual(assessed.matched_segments, [entry.text], entry.text);
    assert.deepEqual(assessed.context_refs, [], entry.text);
  }
});

test("product and operational action must occur in the same sentence", () => {
  for (const text of [
    "Codex is an excellent product. Usage limits were reset for all paid users.",
    "Gemini is fast. Rate limits were increased for all users.",
  ]) {
    const assessed = assessTopicRelevance({ text });
    assert.equal(assessed.decision, "irrelevant", text);
    assert.equal(assessed.reason_code, "generic_discussion", text);
  }
});

test("resolved reply and quote context can establish relevance", () => {
  const reply = assessTopicRelevance({
    text: "Still seeing this in the CLI.",
    sourceRole: "community",
    contexts: [relevantParent],
  });
  assert.equal(reply.decision, "relevant");
  assert.equal(reply.reason_code, "contextual_operational_claim");
  assert.equal(reply.basis, "reply_parent");
  assert.deepEqual(reply.context_refs, [relevantParent.observation_ref]);
  assert.deepEqual(reply.matched_segments, [
    "Still seeing this in the CLI.",
    relevantParent.text,
  ]);

  const quoteRef = {
    record_id: "obs_quoted_reset",
    revision: 2,
  };
  const quote = assessTopicRelevance({
    text: "Confirmed here too.",
    contexts: [{
      relation: "quotes",
      text: "Codex usage limits have been reset for all paid users.",
      ref: quoteRef,
    }],
  });
  assert.equal(quote.decision, "relevant");
  assert.equal(quote.reason_code, "contextual_operational_claim");
  assert.equal(quote.basis, "quote");
  assert.deepEqual(quote.context_refs, [quoteRef]);
});

test("unresolved relation context remains pending", () => {
  const assessed = assessTopicRelevance({
    text: "Still seeing this in the CLI.",
    contexts: [],
    hasUnresolvedContext: true,
  });
  assert.deepEqual(assessed, {
    decision: "pending_context",
    reason_code: "missing_relation_context",
    basis: "unresolved_context",
    matched_segments: [],
    context_refs: [],
  });
});

test("personal errors and requests cannot be rescued by context", () => {
  const cases = [
    {
      text: "Gemini returned HTTP 429 because I exceeded my current quota.",
      reason: "individual_quota_error",
    },
    {
      text: "Anthropic, please reset Claude Code usage limits for me.",
      reason: "request_or_hypothetical",
    },
  ];

  for (const entry of cases) {
    const assessed = assessTopicRelevance({
      text: entry.text,
      contexts: [relevantParent],
      hasUnresolvedContext: true,
    });
    assert.equal(assessed.decision, "irrelevant", entry.text);
    assert.equal(assessed.reason_code, entry.reason, entry.text);
    assert.equal(assessed.basis, "self", entry.text);
    assert.deepEqual(assessed.context_refs, [], entry.text);
  }
});

test("generic links and unrelated replies do not inherit topic relevance", () => {
  const linked = assessTopicRelevance({
    text: "Interesting.",
    contexts: [{
      relation_type: "links",
      text: relevantParent.text,
      observation_ref: relevantParent.observation_ref,
    }],
  });
  assert.equal(linked.decision, "irrelevant");

  const unrelatedReply = assessTopicRelevance({
    text: "Nice weather today.",
    contexts: [relevantParent],
  });
  assert.equal(unrelatedReply.decision, "irrelevant");
});

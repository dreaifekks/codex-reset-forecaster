import assert from "node:assert/strict";
import test from "node:test";
import {
  assessTopicRelevance,
  TOPIC_RELEVANCE_POLICY_VERSION,
} from "../src/pipeline/topic-relevance.mjs";
import {
  authorityReplyCommitmentSegment,
} from "../src/core/authority-reply.mjs";

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
    "reset-topic-relevance/5",
  );
});

test("a configured authority reply commitment uses parent context for scope only", () => {
  const text = "I'll do another performative reset on Monday";
  const parentRef = {
    record_id: "obs_parent_reset_context",
    revision: 1,
  };
  const assessed = assessTopicRelevance({
    text,
    sourceRole: "product_lead",
    authorityReplyCommitment: authorityReplyCommitmentSegment(text),
    authorityReplyTargetProduct: "codex",
    contexts: [{
      relation_type: "reply",
      text:
        "This is just performative at this point. The weekly reset was yesterday.\n" +
        "Tibo: I have reset usage limits for all paid users of ChatGPT Work and Codex.",
      observation_ref: parentRef,
      available_at: "2026-08-09T10:45:00.000Z",
    }],
  });

  assert.deepEqual(assessed, {
    decision: "relevant",
    reason_code: "authority_reply_reset_commitment",
    basis: "self",
    matched_segments: [text],
    context_refs: [parentRef],
  });

  for (const entry of [
    {
      name: "non-authority role",
      sourceRole: "community",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "Codex usage limits were reset for all paid users.",
    },
    {
      name: "unrelated parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "The weather was good yesterday.",
    },
    {
      name: "personal parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "My Codex usage was reset yesterday.",
    },
    {
      name: "narrow-plan parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "Codex usage limits were reset for Pro users.",
    },
    {
      name: "other-product parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "ChatGPT Work usage limits were reset for all paid users.",
    },
    {
      name: "region-qualified parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "Codex usage limits were reset for all users in the EU.",
    },
    {
      name: "plan-qualified all-users parent",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment(text),
      contextText: "Codex usage limits were reset for all users on Pro.",
    },
    {
      name: "no own commitment",
      sourceRole: "product_lead",
      commitment: authorityReplyCommitmentSegment("Same here."),
      contextText: "Codex usage limits were reset for all paid users.",
    },
  ]) {
    const rejected = assessTopicRelevance({
      text: entry.name === "no own commitment" ? "Same here." : text,
      sourceRole: entry.sourceRole,
      authorityReplyCommitment: entry.commitment,
      authorityReplyTargetProduct: "codex",
      contexts: [{
        relation_type: "reply",
        text: entry.contextText,
        observation_ref: parentRef,
        available_at: "2026-08-09T10:45:00.000Z",
      }],
    });
    assert.notEqual(rejected.reason_code, "authority_reply_reset_commitment", entry.name);
  }

  for (const entry of [
    {
      name: "missing exact context ref",
      context: {
        relation_type: "reply",
        text: "Codex usage limits were reset for all paid users.",
        available_at: "2026-08-09T10:45:00.000Z",
      },
    },
    {
      name: "missing context availability",
      context: {
        relation_type: "reply",
        text: "Codex usage limits were reset for all paid users.",
        observation_ref: parentRef,
      },
    },
  ]) {
    const rejected = assessTopicRelevance({
      text,
      sourceRole: "product_lead",
      authorityReplyCommitment: authorityReplyCommitmentSegment(text),
      authorityReplyTargetProduct: "codex",
      contexts: [entry.context],
    });
    assert.notEqual(
      rejected.reason_code,
      "authority_reply_reset_commitment",
      entry.name,
    );
  }
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
    {
      name: "competitor client crash on launch",
      text: "Claude Code crashes on launch with an authentication error.",
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
      reason: "competitive_model_release",
    },
    {
      text: "Anthropic launched Claude 5 for general availability.",
      reason: "competitive_model_release",
    },
    {
      text: "Claude Opus 5 launched at half the prior price.",
      reason: "competitive_model_release",
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

test("Codex experience impact is relevant without using community resonance", () => {
  const cases = [
    "Codex CLI hangs indefinitely when a tool call returns.",
    "The Codex MCP integration is broken after the latest update.",
    "Codex usage is draining incorrectly even while the agent is idle.",
    "Codex is much slower today and every run times out.",
    "Codex is working again after the session-state bug was fixed.",
    "Codex still returns HTTP 429 after the usage limits were reset.",
    "Codex CLI hangs on every run, please fix Codex.",
    "Codex CLI is stuck on every run. Please fix this Codex bug.",
    "Codex has a security vulnerability that exposes authentication tokens.",
    "Codex authentication tokens were exposed for multiple users.",
    "Codex credentials were leaked in agent logs.",
    "Codex API keys were compromised.",
    "Codex private customer data was exposed.",
    "Codex leaked authentication tokens for multiple users.",
    "Codex exposed private customer data in an agent log.",
    "Codex lost local changes because its session data was corrupted.",
    "Codex corrupted my workspace files during a tool run.",
    "Codex data was truncated across the platform.",
    "Codex has a compatibility regression after the latest IDE update.",
    "Codex is still broken for multiple users while the team investigates.",
    "Codex is still broken, but a workaround is available.",
    "Codex is fixed now and working again.",
    "Codex was rolled back and is working again after the compatibility issue.",
  ];
  for (const text of cases) {
    const assessed = assessTopicRelevance({
      text,
      sourceRole: "community",
    });
    assert.equal(assessed.decision, "relevant", text);
    assert.equal(assessed.reason_code, "target_experience_issue", text);
  }

  for (const text of [
    "Codex returned HTTP 429 because I used my full weekly allowance.",
    "Please fix this Codex bug.",
    "Codex is bad and I dislike it.",
  ]) {
    assert.equal(
      assessTopicRelevance({ text, sourceRole: "community" }).decision,
      "irrelevant",
      text,
    );
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

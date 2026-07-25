import { addHours, floorHour, toUtcIso } from "../core/time.mjs";

function item({ id, at, author, identityId, text }) {
  const timestamp = toUtcIso(at);
  return {
    provider_item_id: id,
    canonical_url: `https://example.invalid/demo/${id}`,
    published_at: timestamp,
    first_seen_at: timestamp,
    fetched_at: timestamp,
    author: {
      provider_author_id: author,
      identity_id: identityId,
      display_handle: `@${author}`,
    },
    native_relations: [],
    content: {
      media_type: "text/plain",
      text,
      language: "en",
    },
  };
}

export function generateDemoHistory({ now = new Date(), days = 140 } = {}) {
  const end = floorHour(now);
  const start = addHours(end, -days * 24);
  const items = [];
  let id = 1;
  let eventAt = addHours(start, 9 * 24 + 18);
  let eventIndex = 0;

  while (eventAt < addHours(end, -24)) {
    const scheduled = addHours(eventAt, -6);
    const community = addHours(eventAt, -10);
    const competitor = addHours(eventAt, -20);
    items.push(item({
      id: `demo-${id++}`,
      at: competitor,
      author: eventIndex % 2 ? "modelwatch" : "aicommunity",
      identityId: `community_competitor_${eventIndex % 2}`,
      text: eventIndex % 2
        ? "Anthropic launched a new Claude model and changed usage limits."
        : "Google released a new Gemini model as the AI community discusses capacity.",
    }));
    items.push(item({
      id: `demo-${id++}`,
      at: community,
      author: `community${eventIndex % 4}`,
      identityId: `community_${eventIndex % 4}`,
      text: "Community expects Codex usage limits may reset for all paid users soon.",
    }));
    items.push(item({
      id: `demo-${id++}`,
      at: scheduled,
      author: "thsottiaux",
      identityId: "person_tibo_sottiaux",
      text: "We will reset Codex usage limits for all paid users later today.",
    }));
    items.push(item({
      id: `demo-${id++}`,
      at: addHours(eventAt, 0.1),
      author: "thsottiaux",
      identityId: "person_tibo_sottiaux",
      text: "We have now fully reset Codex usage limits across all paid plans. Enjoy!",
    }));

    // Background ecosystem activity prevents a trivial post-count classifier.
    items.push(item({
      id: `demo-${id++}`,
      at: addHours(eventAt, 3 * 24 + 7),
      author: `community${(eventIndex + 1) % 4}`,
      identityId: `community_${(eventIndex + 1) % 4}`,
      text: "A new model release has the community discussing usage limits, but no Codex reset is expected.",
    }));
    eventIndex += 1;
    eventAt = addHours(eventAt, (eventIndex % 3 === 0 ? 10 : 8) * 24);
  }

  return {
    coverage: { start: toUtcIso(start), end: toUtcIso(end) },
    items: items.sort((left, right) => left.published_at.localeCompare(right.published_at)),
    metadata: {
      synthetic: true,
      purpose: "deterministic pipeline and model-mechanics validation only",
      generated_at: toUtcIso(now),
    },
  };
}

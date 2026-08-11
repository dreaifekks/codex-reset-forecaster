import { hashLabel } from "../core/hash.mjs";

const DEFAULT_TOPICS = new Set(["authority", "outcome"]);

function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]);
}

function absolutePublicUrl(value, publicBaseUrl, fallback = "/") {
  const origin = new URL(publicBaseUrl).origin;
  try {
    const url = new URL(value ?? fallback, origin);
    return url.origin === origin ? url.href : new URL(fallback, origin).href;
  } catch {
    return new URL(fallback, origin).href;
  }
}

function eventTitle(event) {
  return event.notification?.title ?? event.title ?? "Codex 重置预测更新";
}

function eventSummary(event) {
  return event.notification?.body ?? event.summary ?? "预测状态已有更新。";
}

export function renderPublicationAtom(events, {
  publicBaseUrl,
  includeExperimental = false,
  limit = 50,
  now = new Date(),
} = {}) {
  const origin = new URL(publicBaseUrl).origin;
  const feedPath = includeExperimental ? "/feeds/experimental.xml" : "/feed.xml";
  const topics = includeExperimental
    ? new Set(["authority", "outcome", "experimental_probability"])
    : DEFAULT_TOPICS;
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("Atom render time is invalid");
  const relevant = [...events].filter((event) => topics.has(event.topic));
  const selected = relevant
    .filter((event) => {
      const expiresAt = Date.parse(event.expires_at ?? "");
      return !Number.isFinite(expiresAt) || expiresAt > nowMs;
    })
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, limit);
  const updated = relevant.reduce((latest, event) => {
    const candidate = event.emitted_at ?? event.created_at;
    const candidateMs = Date.parse(candidate ?? "");
    return Number.isFinite(candidateMs) && candidateMs > Date.parse(latest)
      ? candidate
      : latest;
  }, "1970-01-01T00:00:00.000Z");
  const entries = selected.map((event) => {
    const eventUrl = absolutePublicUrl(
      event.notification?.url ?? event.url,
      origin,
    );
    const emittedAt = event.emitted_at ?? event.created_at ?? updated;
    return [
      "  <entry>",
      `    <id>urn:codex-reset-forecaster:publication:${xml(event.event_id)}</id>`,
      `    <title>${xml(eventTitle(event))}</title>`,
      `    <link rel="alternate" href="${xml(eventUrl)}"/>`,
      `    <published>${xml(emittedAt)}</published>`,
      `    <updated>${xml(emittedAt)}</updated>`,
      `    <category term="${xml(event.topic)}"/>`,
      `    <summary type="text">${xml(eventSummary(event))}</summary>`,
      "  </entry>",
    ].join("\n");
  }).join("\n");
  const document = [
    "<?xml version=\"1.0\" encoding=\"utf-8\"?>",
    "<feed xmlns=\"http://www.w3.org/2005/Atom\">",
    `  <id>urn:codex-reset-forecaster:alerts:${includeExperimental ? "experimental" : "stable"}</id>`,
    `  <title>${includeExperimental ? "Codex 重置预测实验告警" : "Codex 重置提醒"}</title>`,
    `  <subtitle>${includeExperimental ? "稳定事件，以及公共固定 4 小时概率观察（50% 开启、30% 解除）。" : "权威未来时间窗、确认结果及其修正。"}</subtitle>`,
    `  <link rel="self" href="${xml(new URL(feedPath, origin).href)}"/>`,
    `  <link rel="alternate" href="${xml(new URL("/", origin).href)}"/>`,
    `  <updated>${xml(updated)}</updated>`,
    entries,
    "</feed>",
    "",
  ].filter((line) => line !== "").join("\n");
  return {
    body: document,
    etag: `"${hashLabel(document).slice("sha256:".length)}"`,
    event_count: selected.length,
    latest_sequence: selected[0]?.sequence ?? 0,
  };
}

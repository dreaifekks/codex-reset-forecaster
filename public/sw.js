const FALLBACK_TITLE = "Codex 重置预测更新";

function safePath(value) {
  try {
    const url = new URL(typeof value === "string" ? value : "/", self.location.origin);
    return url.origin === self.location.origin
      ? `${url.pathname}${url.search}${url.hash}`
      : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { body: event.data?.text() ?? "预测状态已有更新。" };
  }
  const expiresAt = Date.parse(payload.expires_at ?? "");
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return;
  const title = String(payload.title ?? FALLBACK_TITLE).slice(0, 120);
  const url = safePath(payload.url);
  event.waitUntil(self.registration.showNotification(title, {
    body: String(payload.body ?? "预测状态已有更新。").slice(0, 600),
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: String(payload.tag ?? payload.event_id ?? "codex-reset-update").slice(0, 120),
    data: {
      url,
      event_id: String(payload.event_id ?? ""),
    },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data?.url);
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ("navigate" in client && client.url !== destination) await client.navigate(destination);
      return client.focus();
    }
    return clients.openWindow(destination);
  })());
});

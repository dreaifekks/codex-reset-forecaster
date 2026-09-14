import { loadWebPushConfig } from "./config.mjs";
import { createWebPushService } from "./service.mjs";

export async function createWebPushRuntime({
  config: inputConfig = {},
  store = null,
  publicationLedger,
  sendNotification = null,
  webPushClient = null,
  ...serviceOptions
} = {}) {
  const config = await loadWebPushConfig(inputConfig);
  let sender = sendNotification;
  if (!sender) {
    const imported = webPushClient ?? await import("web-push");
    const client = imported.default ?? imported;
    if (config.enabled) {
      client.setVapidDetails(config.subject, config.publicKey, config.privateKey);
    }
    sender = client.sendNotification.bind(client);
  }
  return createWebPushService({
    config,
    store,
    publicationLedger,
    sendNotification: sender,
    ...serviceOptions,
  });
}

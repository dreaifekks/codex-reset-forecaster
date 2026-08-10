#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import webPush from "web-push";
import { normalizeWebPushConfig } from "../src/web-push/config.mjs";

function usage() {
  return "Usage: node scripts/generate-vapid-keys.mjs --output /secure/path/web-push-vapid.json --subject mailto:you@example.com";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const output = argument("--output");
const subject = argument("--subject");
let normalizedSubject = null;
try {
  normalizedSubject = normalizeWebPushConfig({ subject }).subject;
} catch {
  // The usage error below deliberately avoids echoing an invalid value.
}
if (!output || !normalizedSubject) {
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 2;
} else {
  const target = path.resolve(output);
  const keys = webPush.generateVAPIDKeys();
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    target,
    `${JSON.stringify({
      schema_version: "web-push-vapid-keys/1",
      subject: normalizedSubject,
      public_key: keys.publicKey,
      private_key: keys.privateKey,
    }, null, 2)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`Created ${target} with mode 0600.\n`);
}

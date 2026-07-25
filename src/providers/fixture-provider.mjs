import fs from "node:fs/promises";
import { hashLabel } from "../core/hash.mjs";
import { appendRawObservationRevision } from "./raw.mjs";
import { addCoverageInterval } from "../pipeline/coverage.mjs";

export class FixtureProvider {
  constructor({ fixturePath, items, name = "fixture", now = () => new Date() }) {
    this.fixturePath = fixturePath;
    this.items = items;
    this.name = name;
    this.now = now;
  }

  async poll() {
    const fixture = this.items ?? JSON.parse(await fs.readFile(this.fixturePath, "utf8"));
    const items = Array.isArray(fixture) ? fixture : fixture.items;
    const coverage = Array.isArray(fixture) ? null : fixture.coverage;
    return { items, coverage, cursor: null, health: { ok: true, delay_seconds: 0 } };
  }

  async collect(store) {
    const fetchedAt = this.now();
    const { items, coverage, health } = await this.poll();
    let inserted = 0;
    for (const item of items) {
      const result = await appendRawObservationRevision(store, item, {
        providerName: this.name,
        providerVersion: "0.2.0",
        config: { fixture: true },
        firstSeenAt: item.first_seen_at ?? fetchedAt,
        fetchedAt: item.fetched_at ?? fetchedAt,
        rawPayload: item,
      });
      if (result.inserted) inserted += 1;
    }
    if (coverage?.start && coverage?.end) {
      const coverageManifest = {
        provider: this.name,
        declared_coverage: coverage,
        exhausted_at: fetchedAt.toISOString(),
        provider_item_ids: items.map((item) => String(item.provider_item_id)).sort(),
        synthetic: true,
      };
      const coverageManifestHash = hashLabel(coverageManifest);
      const coverageManifestRef = await store.writeBlob(
        `${this.name}-coverage`,
        `${fetchedAt.toISOString()}:${coverageManifestHash}`,
        coverageManifest,
      );
      await addCoverageInterval(store, this.name, coverage.start, coverage.end, {
        mode: "fixture_declared_complete",
        adequacy: "negative_label_eligible",
        evidence_refs: [{
          kind: "fixture_manifest",
          ref: coverageManifestRef,
          sha256: coverageManifestHash,
          method: "synthetic_fixture_manifest",
          exhausted_at: fetchedAt.toISOString(),
        }],
        asserted_at: fetchedAt,
      });
    }
    return { collected: inserted, health };
  }
}

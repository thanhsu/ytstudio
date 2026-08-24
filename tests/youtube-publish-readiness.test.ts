import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePublishReadiness } from "../src/youtube/publish-readiness.ts";

test("publish readiness reports source-not-found with a UI-shaped matrix", async () => {
  await assert.rejects(
    () => evaluatePublishReadiness("missing-channel", "story", "missing-story"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "source-not-found");
      assert.deepEqual((error as { matrix?: unknown }).matrix, {
        script: "missing",
        media: "missing",
        final: "missing",
        export: "missing",
      });
      return true;
    },
  );
});


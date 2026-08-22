import assert from "node:assert/strict";
import test from "node:test";
import { buildDryRunScript } from "../src/llm/dry-run.ts";
import type { VideoBrief } from "../src/types.ts";

const brief: VideoBrief = {
  id: "tales-herding-gods-qin-mu",
  topic: "Why Qin Mu is not your typical cultivation MC",
  show: "Tales of Herding Gods",
  format: "shorts",
  audience: "English-speaking donghua viewers",
  language: "English",
  notes: "",
  createdAt: "2026-08-20T00:00:00.000Z",
};

test("dry-run script generation produces script, metadata, and scene plan", () => {
  const result = buildDryRunScript(brief);

  assert.match(result.script, /Why Qin Mu/);
  assert.equal(result.metadata.projectId, brief.id);
  assert.ok(result.metadata.titles.length >= 3);
  assert.equal(result.scenePlan.projectId, brief.id);
  assert.ok(result.scenePlan.scenes.length >= 4);
});

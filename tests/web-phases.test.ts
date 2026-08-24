import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGES,
  STAGE_TITLES,
  REVIEW_PHASES,
  phaseForStage,
  derivePhaseState,
} from "../src/web/lib/phases.js";

test("every pipeline stage belongs to exactly one phase", () => {
  const phaseStages = REVIEW_PHASES.flatMap((phase) => phase.stages);
  assert.deepEqual([...phaseStages].sort(), [...STAGES].sort());
  assert.equal(new Set(phaseStages).size, phaseStages.length);
});

test("phase mapping follows the approved split", () => {
  assert.deepEqual(REVIEW_PHASES.map((phase) => phase.id), ["content", "edit", "publish"]);
  assert.deepEqual(REVIEW_PHASES[0].stages, ["brief", "script", "media", "asr", "subtitles", "translation"]);
  assert.deepEqual(REVIEW_PHASES[1].stages, ["voice", "captions", "assets", "render"]);
  assert.deepEqual(REVIEW_PHASES[2].stages, ["copyright", "export"]);
  assert.equal(phaseForStage("brief"), "content");
  assert.equal(phaseForStage("render"), "edit");
  assert.equal(phaseForStage("export"), "publish");
  assert.equal(STAGE_TITLES.copyright, "Copyright Check");
});

test("derivePhaseState reflects workflow step statuses", () => {
  const stages = ["brief", "script"];
  assert.equal(derivePhaseState(stages, []), "empty");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "blocked" },
    { id: "script", stage: "script", status: "blocked" },
  ]), "pending");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "ready" },
    { id: "script", stage: "script", status: "blocked" },
  ]), "in-progress");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "done" },
    { id: "script", stage: "script", status: "ready" },
  ]), "needs-approval");
  assert.equal(derivePhaseState(stages, [
    { id: "input", stage: "brief", status: "done" },
    { id: "script", stage: "script", status: "done" },
  ]), "done");
  assert.equal(derivePhaseState(stages, [
    { id: "media", stage: "media", status: "ready" },
  ]), "empty");
});

import assert from "node:assert/strict";
import test from "node:test";
import { parseScriptGeneration } from "../src/llm/parse.ts";

function validPayload() {
  return {
    script: "# Title\n\n## Hook\n\nOriginal commentary.",
    metadata: {
      titles: ["First title", "Second title"],
      description: "A review description.",
      hashtags: ["#donghua", "#review"],
      pinnedComment: "What do you think?",
    },
    scenePlan: [
      { label: "Hook", durationSeconds: 8, purpose: "State the claim.", visualDirection: "Title card." },
    ],
  };
}

test("a well-formed response is parsed and stamped with the project id", () => {
  const result = parseScriptGeneration(JSON.stringify(validPayload()), "sample-project");

  assert.match(result.script, /Original commentary/);
  assert.equal(result.metadata.projectId, "sample-project");
  assert.deepEqual(result.metadata.hashtags, ["#donghua", "#review"]);
  assert.equal(result.scenePlan.projectId, "sample-project");
  assert.equal(result.scenePlan.scenes[0].durationSeconds, 8);
});

test("a fenced JSON block is accepted", () => {
  const raw = "```json\n" + JSON.stringify(validPayload()) + "\n```";

  assert.equal(parseScriptGeneration(raw, "sample-project").metadata.projectId, "sample-project");
});

test("prose instead of JSON is rejected", () => {
  assert.throws(() => parseScriptGeneration("Sure! Here is your script:", "sample-project"), /not JSON/i);
});

test("a missing script is rejected by name", () => {
  const payload = { ...validPayload(), script: "   " };

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /script/);
});

test("titles that are not a non-empty string array are rejected by name", () => {
  const payload = validPayload();
  payload.metadata.titles = [];

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /metadata\.titles/);
});

test("an empty scene plan is rejected", () => {
  const payload = validPayload();
  payload.scenePlan = [];

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /scenePlan/);
});

test("a non-positive scene duration is rejected by position", () => {
  const payload = validPayload();
  payload.scenePlan[0].durationSeconds = 0;

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /scenePlan\[0\]\.durationSeconds/);
});

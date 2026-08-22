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

test("a script with translated section headings is rejected before anything is written", () => {
  const payload = {
    ...validPayload(),
    script: "# Qin Mu\n\n## Mở đầu\n\nBình luận gốc.\n\n## Phân tích\n\nNội dung.\n\n## Kết luận\n\nKết.",
  };

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /no narration/i);
    assert.match(error.message, /## Hook/);
    assert.match(error.message, /## Closing/);
    // The message may not describe a rule the extractor does not apply: it also
    // narrates "## Review".
    assert.match(error.message, /## Review/);
    return true;
  });
});

test("a script with common English aliases for the headings is rejected", () => {
  const payload = {
    ...validPayload(),
    script: "# Title\n\n## Introduction\n\nSetup.\n\n## Analysis\n\nArgument.\n\n## Conclusion\n\nWrap up.",
  };

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /no narration/i);
});

test("a script with no headings at all is rejected", () => {
  const payload = { ...validPayload(), script: "Just a wall of prose with no markdown headings anywhere." };

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /no narration/i);
});

test("a script whose required headings are present but empty is rejected", () => {
  const payload = { ...validPayload(), script: "# Title\n\n## Hook\n\n## Context\n\n## Main Points\n\n## Closing\n" };

  assert.throws(() => parseScriptGeneration(JSON.stringify(payload), "sample-project"), /no narration/i);
});

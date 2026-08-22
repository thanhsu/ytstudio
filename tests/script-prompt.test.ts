import assert from "node:assert/strict";
import test from "node:test";
import { buildScriptPrompt } from "../src/script-prompt.ts";
import type { VideoBrief } from "../src/types.ts";

function sampleBrief(overrides: Partial<VideoBrief> = {}): VideoBrief {
  return {
    id: "sample-project",
    topic: "Why Qin Mu is not your typical cultivation MC",
    show: "Tales of Herding Gods",
    format: "shorts",
    audience: "English-speaking donghua viewers",
    language: "English",
    notes: "",
    createdAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

test("the prompt carries every brief field the model needs", () => {
  const [, user] = buildScriptPrompt(sampleBrief());

  assert.match(user.content, /Why Qin Mu is not your typical cultivation MC/);
  assert.match(user.content, /Tales of Herding Gods/);
  assert.match(user.content, /English-speaking donghua viewers/);
  assert.match(user.content, /English/);
});

test("runtime target follows the brief format", () => {
  const [, shorts] = buildScriptPrompt(sampleBrief({ format: "shorts" }));
  const [, longform] = buildScriptPrompt(sampleBrief({ format: "longform" }));

  assert.match(shorts.content, /75 seconds/);
  assert.match(longform.content, /7 minutes/);
});

test("brief notes steer tone only when present", () => {
  const [, withNotes] = buildScriptPrompt(sampleBrief({ notes: "Keep it sarcastic." }));
  const [, withoutNotes] = buildScriptPrompt(sampleBrief({ notes: "   " }));

  assert.match(withNotes.content, /Keep it sarcastic\./);
  assert.doesNotMatch(withoutNotes.content, /Creator notes/);
});

test("the system message demands original commentary and JSON only", () => {
  const [system] = buildScriptPrompt(sampleBrief());

  assert.equal(system.role, "system");
  assert.match(system.content, /original commentary/i);
  assert.match(system.content, /do not (?:recap|retell)/i);
  assert.match(system.content, /single JSON object/i);
  assert.match(system.content, /scenePlan/);
});

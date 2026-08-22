# LLM Script Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded script template with a real language model, so each project produces distinct commentary, titles, and scene plans.

**Architecture:** One `LlmProvider` interface with two implementations — an `openai-compatible` adapter that speaks `/v1/chat/completions` (serving Ollama, LM Studio, OpenAI, DeepSeek, Groq, OpenRouter alike) and a `dry-run` provider wrapping today's template. The prompt builder and the response validator are pure functions, so nothing in the test suite touches the network. The script route becomes a background job on the manager already wired for voice, render, and ASR.

**Tech Stack:** TypeScript on Node 22 with native type stripping, `node:test`, no runtime dependencies beyond `busboy`.

**Spec:** `docs/superpowers/specs/2026-08-22-llm-script-generation-design.md`

## Global Constraints

- Node.js >= 22.6.0. Import local modules with explicit `.ts` extensions.
- No new runtime dependencies. Use `fetch` from the platform.
- No test may perform network access. Providers accept an injected `fetch`.
- Never fall back from a configured model to the template silently.
- Never reach a paid provider without `confirmedPaidRequest === true`.
- API keys are read from the environment, never written to `studio.config.json`.
- `npm test` and `npm run typecheck` must both be clean before every commit.
- Follow the existing style: named exports, `type` imports, two-space indent, no semicolon-free lines.

**Refinements against the spec:**
1. The spec put validation in `src/script.ts`. This plan puts `parseScriptGeneration` in `src/llm/parse.ts`, keeping `script.ts` focused on provider selection and file writes. Behaviour is identical.
2. The spec said the paid dialog would reuse the voice confirmation component. This plan adds a separate `#paid-script-dialog` instead: the existing dialog's button is already bound to `requestVoice(true)`, and rewiring it to dispatch on a stored pending action would put the working voice gate at risk for no gain.

## File Structure

| File | Responsibility |
|---|---|
| `src/llm/types.ts` | `LlmProvider` interface, request and result types |
| `src/llm/parse.ts` | `parseScriptGeneration` — validate a model response into typed output |
| `src/llm/openai-compatible.ts` | HTTP adapter for `/v1/chat/completions` |
| `src/llm/dry-run.ts` | today's template, moved here and exposed as a provider |
| `src/script-prompt.ts` | `buildScriptPrompt` — pure prompt construction |
| `src/script.ts` | provider selection from config, file writes |
| `src/config.ts` | new `script` fields plus `booleanValue` and `rangeValue` helpers |
| `src/server.ts` | script route as a job, paid gate |
| `src/web/index.html`, `src/web/app.js` | paid-script dialog, provider display |

---

### Task 1: Response validation

**Files:**
- Create: `src/llm/types.ts`
- Create: `src/llm/parse.ts`
- Test: `tests/llm-parse.test.ts`

**Interfaces:**
- Consumes: `Metadata`, `ScenePlan`, `VideoBrief` from `src/types.ts`
- Produces: `LlmProvider`, `ScriptGenerationRequest`, `ScriptGenerationResult` (Task 3, 4); `parseScriptGeneration(raw: string, projectId: string): ParsedScript` where `ParsedScript = { script: string; metadata: Metadata; scenePlan: ScenePlan }` (Task 3)

- [ ] **Step 1: Write the failing test**

Create `tests/llm-parse.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/llm-parse.test.ts`
Expected: FAIL — `Cannot find module '../src/llm/parse.ts'`

- [ ] **Step 3: Write the types**

Create `src/llm/types.ts`:

```ts
import type { Metadata, ScenePlan, VideoBrief } from "../types.ts";

export type ScriptGenerationRequest = {
  projectId: string;
  brief: VideoBrief;
  confirmedPaidRequest: boolean;
};

export type ScriptGenerationResult = {
  provider: string;
  model: string;
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

export type LlmProvider = {
  readonly name: string;
  generate(request: ScriptGenerationRequest, signal?: AbortSignal): Promise<ScriptGenerationResult>;
};
```

- [ ] **Step 4: Write the validator**

Create `src/llm/parse.ts`:

```ts
import type { Metadata, ScenePlan } from "../types.ts";

export type ParsedScript = {
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

/**
 * Validates a model response before anything is written to the project. A model
 * that answers in prose, omits a field, or invents a scene without a duration
 * fails here, so a bad response can never leave a half-written project.
 */
export function parseScriptGeneration(raw: string, projectId: string): ParsedScript {
  const payload = parseJsonObject(raw);
  const metadataValue = requireObject(payload.metadata, "metadata");

  const metadata: Metadata = {
    projectId,
    titles: requireStringArray(metadataValue.titles, "metadata.titles"),
    description: requireText(metadataValue.description, "metadata.description"),
    hashtags: requireStringArray(metadataValue.hashtags, "metadata.hashtags"),
    pinnedComment: requireText(metadataValue.pinnedComment, "metadata.pinnedComment"),
  };

  const scenes = requireArray(payload.scenePlan, "scenePlan").map((scene, index) => {
    const value = requireObject(scene, `scenePlan[${index}]`);
    return {
      label: requireText(value.label, `scenePlan[${index}].label`),
      durationSeconds: requirePositiveNumber(value.durationSeconds, `scenePlan[${index}].durationSeconds`),
      purpose: requireText(value.purpose, `scenePlan[${index}].purpose`),
      visualDirection: requireText(value.visualDirection, `scenePlan[${index}].visualDirection`),
    };
  });

  const scenePlan: ScenePlan = { projectId, scenes };
  return { script: requireText(payload.script, "script"), metadata, scenePlan };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(raw).trim());
  } catch {
    throw new Error("Model response was not JSON. Configure a model that can return a JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Model response was not JSON object.");
  }
  return value as Record<string, unknown>;
}

// Local models frequently wrap JSON in a markdown fence even when asked not to.
function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(raw);
  return fenced ? fenced[1] : raw;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Model response field ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Model response field ${field} must be a non-empty array.`);
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Model response field ${field} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  const items = requireArray(value, field);
  return items.map((item, index) => requireText(item, `${field}[${index}]`));
}

function requirePositiveNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Model response field ${field} must be a positive number.`);
  }
  return number;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/llm-parse.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/llm/types.ts src/llm/parse.ts tests/llm-parse.test.ts
git commit -m "feat: validate model script responses before writing project files"
```

---

### Task 2: Prompt builder

**Files:**
- Create: `src/script-prompt.ts`
- Test: `tests/script-prompt.test.ts`

**Interfaces:**
- Consumes: `VideoBrief` from `src/types.ts`
- Produces: `buildScriptPrompt(brief: VideoBrief): ChatMessage[]` and `ChatMessage = { role: "system" | "user"; content: string }` (Task 3)

- [ ] **Step 1: Write the failing test**

Create `tests/script-prompt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/script-prompt.test.ts`
Expected: FAIL — `Cannot find module '../src/script-prompt.ts'`

- [ ] **Step 3: Write the prompt builder**

Create `src/script-prompt.ts`:

```ts
import type { VideoBrief } from "./types.ts";

export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const RUNTIME_TARGET: Record<VideoBrief["format"], string> = {
  shorts: "about 75 seconds",
  longform: "about 7 minutes",
};

export function buildScriptPrompt(brief: VideoBrief): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt(brief) },
  ];
}

const SYSTEM_PROMPT = `You write scripts for a YouTube review channel.

Write original commentary, analysis, and opinion. Do not recap or retell the
source episode scene by scene: the value of the video must come from the
argument, not from replaying the original footage. Reference specific moments
only to support a point you are making about them.

Answer with a single JSON object and nothing else. No markdown fence, no
commentary before or after. The object has exactly these fields:

{
  "script": "markdown with '## Hook', '## Context', '## Main Points', '## Closing' sections",
  "metadata": {
    "titles": ["three to five title options, each under 100 characters"],
    "description": "two or three sentences for the video description",
    "hashtags": ["four to six hashtags, each starting with #"],
    "pinnedComment": "one question that invites debate"
  },
  "scenePlan": [
    {
      "label": "short scene name",
      "durationSeconds": 8,
      "purpose": "what this scene achieves",
      "visualDirection": "what is on screen"
    }
  ]
}

Every durationSeconds must be a positive number, and the scene durations
together should roughly match the runtime target. Write the script in the
requested language.`;

function userPrompt(brief: VideoBrief): string {
  const lines = [
    `Show: ${brief.show}`,
    `Topic: ${brief.topic}`,
    `Format: ${brief.format}`,
    `Runtime target: ${RUNTIME_TARGET[brief.format]}`,
    `Target audience: ${brief.audience}`,
    `Language: ${brief.language}`,
  ];
  if (brief.notes.trim()) {
    lines.push(`Creator notes: ${brief.notes.trim()}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/script-prompt.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/script-prompt.ts tests/script-prompt.test.ts
git commit -m "feat: build script prompts from the project brief"
```

---

### Task 3: OpenAI-compatible adapter

**Files:**
- Create: `src/llm/openai-compatible.ts`
- Test: `tests/llm-openai-compatible.test.ts`

**Interfaces:**
- Consumes: `LlmProvider`, `ScriptGenerationRequest`, `ScriptGenerationResult` (Task 1); `parseScriptGeneration` (Task 1); `buildScriptPrompt` (Task 2)
- Produces: `createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider` where `OpenAiCompatibleConfig = { baseUrl: string; model: string; apiKey: string; paid: boolean; temperature: number; maxOutputTokens: number; fetch?: typeof fetch }` (Task 4)

- [ ] **Step 1: Write the failing test**

Create `tests/llm-openai-compatible.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAiCompatibleProvider } from "../src/llm/openai-compatible.ts";
import type { ScriptGenerationRequest } from "../src/llm/types.ts";

type FakeFetch = typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> };

function modelContent(): string {
  return JSON.stringify({
    script: "# Title\n\n## Hook\n\nOriginal commentary.",
    metadata: {
      titles: ["A title"],
      description: "A description.",
      hashtags: ["#review"],
      pinnedComment: "Your take?",
    },
    scenePlan: [
      { label: "Hook", durationSeconds: 8, purpose: "Open strong.", visualDirection: "Title card." },
    ],
  });
}

function createFakeFetch(content = modelContent(), status = 200): FakeFetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = status === 200
      ? JSON.stringify({ choices: [{ message: { content } }] })
      : "upstream failure";
    return new Response(body, { status });
  }) as FakeFetch;
  fakeFetch.calls = calls;
  return fakeFetch;
}

function sampleRequest(overrides: Partial<ScriptGenerationRequest> = {}): ScriptGenerationRequest {
  return {
    projectId: "sample-project",
    brief: {
      id: "sample-project",
      topic: "Why Qin Mu is different",
      show: "Tales of Herding Gods",
      format: "shorts",
      audience: "EU donghua viewers",
      language: "English",
      notes: "",
      createdAt: "2026-08-22T00:00:00.000Z",
    },
    confirmedPaidRequest: false,
    ...overrides,
  };
}

function localConfig(fakeFetch: FakeFetch) {
  return {
    baseUrl: "http://127.0.0.1:11434/v1/",
    model: "qwen2.5:14b",
    apiKey: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 4000,
    fetch: fakeFetch,
  };
}

test("a local model call needs no confirmation and sends no authorization", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider(localConfig(fakeFetch));

  const result = await provider.generate(sampleRequest());

  assert.equal(result.model, "qwen2.5:14b");
  assert.equal(result.metadata.projectId, "sample-project");
  assert.equal(fakeFetch.calls.length, 1);
  assert.equal(fakeFetch.calls[0].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal((fakeFetch.calls[0].init?.headers as Record<string, string>).Authorization, undefined);
});

test("a paid provider refuses to send anything without confirmation", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "test-key" });

  await assert.rejects(() => provider.generate(sampleRequest()), /confirm/i);
  assert.equal(fakeFetch.calls.length, 0);
});

test("a confirmed paid provider sends the bearer key", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "test-key" });

  await provider.generate(sampleRequest({ confirmedPaidRequest: true }));

  const headers = fakeFetch.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer test-key");
});

test("a paid provider without a key fails before any request", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider({ ...localConfig(fakeFetch), paid: true, apiKey: "" });

  await assert.rejects(() => provider.generate(sampleRequest({ confirmedPaidRequest: true })), /api key/i);
  assert.equal(fakeFetch.calls.length, 0);
});

test("an unreachable server names the endpoint", async () => {
  const failingFetch = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as FakeFetch;
  failingFetch.calls = [];
  const provider = createOpenAiCompatibleProvider(localConfig(failingFetch));

  await assert.rejects(() => provider.generate(sampleRequest()), /127\.0\.0\.1:11434/);
});

test("an error status is reported with its code", async () => {
  const provider = createOpenAiCompatibleProvider(localConfig(createFakeFetch(modelContent(), 500)));

  await assert.rejects(() => provider.generate(sampleRequest()), /500/);
});

test("a model answering in prose is rejected", async () => {
  const provider = createOpenAiCompatibleProvider(localConfig(createFakeFetch("Sure! Here you go:")));

  await assert.rejects(() => provider.generate(sampleRequest()), /not JSON/i);
});

test("the abort signal reaches fetch", async () => {
  const fakeFetch = createFakeFetch();
  const provider = createOpenAiCompatibleProvider(localConfig(fakeFetch));
  const controller = new AbortController();

  await provider.generate(sampleRequest(), controller.signal);

  assert.equal(fakeFetch.calls[0].init?.signal, controller.signal);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/llm-openai-compatible.test.ts`
Expected: FAIL — `Cannot find module '../src/llm/openai-compatible.ts'`

- [ ] **Step 3: Write the adapter**

Create `src/llm/openai-compatible.ts`:

```ts
import { buildScriptPrompt } from "../script-prompt.ts";
import { parseScriptGeneration } from "./parse.ts";
import type { LlmProvider, ScriptGenerationRequest, ScriptGenerationResult } from "./types.ts";

export type OpenAiCompatibleConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  paid: boolean;
  temperature: number;
  maxOutputTokens: number;
  fetch?: typeof fetch;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

/**
 * One adapter for every server speaking /v1/chat/completions: Ollama, LM Studio,
 * llama.cpp, vLLM, OpenAI, DeepSeek, Groq, and OpenRouter. Moving between them
 * is a change of baseUrl and key, not of code.
 */
export function createOpenAiCompatibleProvider(config: OpenAiCompatibleConfig): LlmProvider {
  return {
    name: "openai-compatible",
    async generate(request: ScriptGenerationRequest, signal?: AbortSignal): Promise<ScriptGenerationResult> {
      if (config.paid && !request.confirmedPaidRequest) {
        throw new Error("This model is marked paid and requires an explicit confirmed paid request.");
      }
      if (config.paid && !config.apiKey) {
        throw new Error("An API key is required for the configured paid model provider.");
      }

      const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      let response: Response;
      try {
        response = await (config.fetch ?? fetch)(endpoint, {
          method: "POST",
          signal,
          headers,
          body: JSON.stringify({
            model: config.model,
            messages: buildScriptPrompt(request.brief),
            temperature: config.temperature,
            max_tokens: config.maxOutputTokens,
            response_format: { type: "json_object" },
          }),
        });
      } catch (error: unknown) {
        throw new Error(`Could not reach the model server at ${endpoint}: ${messageOf(error)}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`Model request failed with status ${response.status}: ${redact(body)}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("Model returned an empty response.");
      }

      return {
        provider: "openai-compatible",
        model: config.model,
        ...parseScriptGeneration(content, request.projectId),
      };
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string): string {
  return value.replace(/(authorization|api[_-]?key|token)(["']?\s*[:=]\s*["']?)[^"'\s]+/gi, "$1$2[redacted]");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/llm-openai-compatible.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/llm/openai-compatible.ts tests/llm-openai-compatible.test.ts
git commit -m "feat: add an OpenAI-compatible script model adapter"
```

---

### Task 4: Provider selection, config, and file writes

**Files:**
- Create: `src/llm/dry-run.ts`
- Modify: `src/script.ts` (move the template out, add `generateScript`)
- Modify: `src/config.ts` (new `script` fields, `booleanValue`, `rangeValue`)
- Modify: `tests/script.test.ts:3` (import moves to `../src/llm/dry-run.ts`)
- Test: `tests/script-generation.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Consumes: `LlmProvider` (Task 1); `createOpenAiCompatibleProvider` (Task 3)
- Produces: `createDryRunProvider(): LlmProvider`; `generateScript(projectId: string, options?: GenerateScriptOptions): Promise<ScriptGeneration>` where `GenerateScriptOptions = { provider?: LlmProvider; confirmedPaidRequest?: boolean; signal?: AbortSignal }` (Task 5); `config.script.paid` (Task 5)

Note: `buildDryRunScript` moves verbatim from `src/script.ts` to `src/llm/dry-run.ts`. Moving it — rather than importing it back into `dry-run.ts` — avoids a cycle, because `script.ts` must import the provider.

- [ ] **Step 1: Write the failing tests**

Create `tests/script-generation.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateScript } from "../src/script.ts";
import type { LlmProvider } from "../src/llm/types.ts";

async function withProject<T>(fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "yt-script-"));
  try {
    process.chdir(root);
    await mkdir(join("projects", "sample-project"), { recursive: true });
    await writeFile(
      join("projects", "sample-project", "brief.json"),
      JSON.stringify({
        id: "sample-project",
        topic: "Why Qin Mu is different",
        show: "Tales of Herding Gods",
        format: "shorts",
        audience: "EU donghua viewers",
        language: "English",
        notes: "",
        createdAt: "2026-08-22T00:00:00.000Z",
      }),
      "utf8",
    );
    return await fn();
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

function stubProvider(): LlmProvider {
  return {
    name: "stub",
    async generate(request) {
      return {
        provider: "stub",
        model: "stub-model",
        script: "# Stub\n\n## Hook\n\nDistinct commentary.",
        metadata: {
          projectId: request.projectId,
          titles: ["Stub title"],
          description: "Stub description.",
          hashtags: ["#stub"],
          pinnedComment: "Stub question?",
        },
        scenePlan: {
          projectId: request.projectId,
          scenes: [{ label: "Hook", durationSeconds: 8, purpose: "Open.", visualDirection: "Card." }],
        },
      };
    },
  };
}

test("generation writes the script, metadata, and scene plan together", async () => {
  await withProject(async () => {
    await generateScript("sample-project", { provider: stubProvider() });

    assert.match(await readFile(join("projects", "sample-project", "script.md"), "utf8"), /Distinct commentary/);
    const metadata = JSON.parse(await readFile(join("projects", "sample-project", "metadata.json"), "utf8"));
    assert.deepEqual(metadata.titles, ["Stub title"]);
    const scenePlan = JSON.parse(await readFile(join("projects", "sample-project", "scene-plan.json"), "utf8"));
    assert.equal(scenePlan.scenes[0].durationSeconds, 8);
  });
});

test("a provider failure writes nothing and surfaces the reason", async () => {
  await withProject(async () => {
    const failing: LlmProvider = {
      name: "failing",
      async generate() {
        throw new Error("Could not reach the model server at http://127.0.0.1:11434/v1/chat/completions");
      },
    };

    await assert.rejects(() => generateScript("sample-project", { provider: failing }), /11434/);
    await assert.rejects(() => stat(join("projects", "sample-project", "script.md")), /ENOENT/);
  });
});
```

Append to `tests/config.test.ts`:

```ts
test("studio config carries script model settings", async () => {
  await withTempCwd(async () => {
    const config = await loadStudioConfig();

    assert.equal(config.script.provider, "dry-run");
    assert.equal(config.script.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(config.script.paid, false);
    assert.equal(config.script.temperature, 0.8);
    assert.equal(config.script.maxOutputTokens, 4000);
  });
});

test("a zero temperature is preserved rather than replaced by the default", async () => {
  await withTempCwd(async () => {
    const saved = await saveStudioConfig({ script: { provider: "openai-compatible", temperature: 0 } });

    assert.equal(saved.script.provider, "openai-compatible");
    assert.equal(saved.script.temperature, 0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/script-generation.test.ts tests/config.test.ts`
Expected: FAIL — `generateScript` is not exported, and `config.script.baseUrl` is `undefined`

- [ ] **Step 3: Move the template into a provider**

Create `src/llm/dry-run.ts`. Cut `src/script.ts:6-10` (the `ScriptGeneration` type) and `src/script.ts:24-100` (the entire `buildDryRunScript` function, from `export function buildDryRunScript` through its closing brace) and paste both into the new file unchanged. Then add the provider factory below them:

```ts
import type { Metadata, ScenePlan, VideoBrief } from "../types.ts";
import type { LlmProvider } from "./types.ts";

export type ScriptGeneration = {
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

export function buildDryRunScript(brief: VideoBrief): ScriptGeneration {
  // Pasted unchanged from src/script.ts:24-100. Do not rewrite it: tests/script.test.ts
  // asserts on its current output.
}

/**
 * The template as an explicit provider. It is selected only by configuration,
 * never as a fallback, so template output is never mistaken for model output.
 */
export function createDryRunProvider(): LlmProvider {
  return {
    name: "dry-run",
    async generate(request) {
      const generation = buildDryRunScript(request.brief);
      return { provider: "dry-run", model: "local-template", ...generation };
    },
  };
}
```

- [ ] **Step 4: Add the config fields**

In `src/config.ts`, replace the `script` block of `StudioConfig`:

```ts
  script: {
    provider: "dry-run" | "openai-compatible";
    model: string;
    baseUrl: string;
    apiKeyEnv: string;
    paid: boolean;
    temperature: number;
    maxOutputTokens: number;
  };
```

Replace the `script` block of `DEFAULT_STUDIO_CONFIG`:

```ts
  script: {
    provider: "dry-run",
    model: "local-template",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    paid: false,
    temperature: 0.8,
    maxOutputTokens: 4000,
  },
```

Replace the `script` block of `normalizeStudioConfig`:

```ts
    script: {
      provider: enumValue(candidate.script?.provider, ["dry-run", "openai-compatible"], "dry-run"),
      model: stringValue(candidate.script?.model, DEFAULT_STUDIO_CONFIG.script.model),
      baseUrl: stringValue(candidate.script?.baseUrl, DEFAULT_STUDIO_CONFIG.script.baseUrl),
      apiKeyEnv: stringValue(candidate.script?.apiKeyEnv, DEFAULT_STUDIO_CONFIG.script.apiKeyEnv),
      paid: booleanValue(candidate.script?.paid, DEFAULT_STUDIO_CONFIG.script.paid),
      temperature: rangeValue(candidate.script?.temperature, DEFAULT_STUDIO_CONFIG.script.temperature, 0, 2),
      maxOutputTokens: numberValue(candidate.script?.maxOutputTokens, DEFAULT_STUDIO_CONFIG.script.maxOutputTokens),
    },
```

Add both helpers beside `numberValue`. `rangeValue` exists because `numberValue` rejects `0`, which would silently discard a deliberate `temperature: 0`:

```ts
function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function rangeValue(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}
```

- [ ] **Step 5: Rewrite `src/script.ts`**

Replace the whole file:

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadStudioConfig, type StudioConfig } from "./config.ts";
import { ensureProjectDir, projectDir, readJson, writeJson } from "./fs.ts";
import { buildDryRunScript, createDryRunProvider, type ScriptGeneration } from "./llm/dry-run.ts";
import { createOpenAiCompatibleProvider } from "./llm/openai-compatible.ts";
import type { LlmProvider } from "./llm/types.ts";
import type { VideoBrief } from "./types.ts";

export { buildDryRunScript };
export type { ScriptGeneration };

export type GenerateScriptOptions = {
  provider?: LlmProvider;
  confirmedPaidRequest?: boolean;
  signal?: AbortSignal;
};

export async function generateScript(
  projectId: string,
  options: GenerateScriptOptions = {},
): Promise<ScriptGeneration> {
  const brief = await readJson<VideoBrief>(join(projectDir(projectId), "brief.json"));
  const provider = options.provider ?? createConfiguredProvider(await loadStudioConfig());

  // Files are written only after the provider returns a validated result, so a
  // failed call leaves the previous script in place rather than a partial one.
  const result = await provider.generate(
    { projectId, brief, confirmedPaidRequest: options.confirmedPaidRequest === true },
    options.signal,
  );

  const dir = await ensureProjectDir(projectId);
  await writeFile(join(dir, "script.md"), result.script, "utf8");
  await writeJson(join(dir, "metadata.json"), result.metadata);
  await writeJson(join(dir, "scene-plan.json"), result.scenePlan);

  return { script: result.script, metadata: result.metadata, scenePlan: result.scenePlan };
}

export async function generateDryRunScript(projectId: string): Promise<ScriptGeneration> {
  return generateScript(projectId, { provider: createDryRunProvider() });
}

function createConfiguredProvider(config: StudioConfig): LlmProvider {
  if (config.script.provider === "openai-compatible") {
    return createOpenAiCompatibleProvider({
      baseUrl: config.script.baseUrl,
      model: config.script.model,
      apiKey: config.script.apiKeyEnv ? process.env[config.script.apiKeyEnv] ?? "" : "",
      paid: config.script.paid,
      temperature: config.script.temperature,
      maxOutputTokens: config.script.maxOutputTokens,
    });
  }
  return createDryRunProvider();
}
```

- [ ] **Step 6: Point the existing template test at its new home**

In `tests/script.test.ts` line 3, change the import:

```ts
import { buildDryRunScript } from "../src/llm/dry-run.ts";
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS, all tests including the untouched smoke test that still uses `generateDryRunScript`

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/llm/dry-run.ts src/script.ts src/config.ts tests/script.test.ts tests/script-generation.test.ts tests/config.test.ts
git commit -m "feat: select a script model provider from studio config"
```

---

### Task 5: Script route as a job

**Files:**
- Modify: `src/jobs.ts:6` (add `"script"` to `JobKind`)
- Modify: `src/server.ts` (script route, import `generateScript`)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `generateScript`, `config.script.paid` (Task 4); `startProjectJob`, `readEventStreamUntil`, `postJson` (already in the codebase)
- Produces: `POST /api/projects/:id/script` answering `202` with a job of kind `script`

- [ ] **Step 1: Write the failing tests**

Append to `tests/server.test.ts`:

```ts
test("script generation runs as a job and writes the project files", async () => {
  await withTempCwd(async () => {
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const events = await fetch(`${running.url}/api/projects/sample-project/events`);

      const started = await postJson(running, "script");
      assert.equal(started.status, 202);
      const { job } = await started.json();
      assert.equal(job.kind, "script");

      const finished = await readEventStreamUntil(
        events,
        (payload) => payload.id === job.id && payload.status !== "running",
      );
      assert.equal(finished.status, "succeeded");
      assert.match(await readFile(join("projects", "sample-project", "script.md"), "utf8"), /Hook/);
    } finally {
      await running.close();
    }
  });
});

test("a paid script model is refused without confirmation", async () => {
  await withTempCwd(async () => {
    await writeFile(
      "studio.config.json",
      JSON.stringify({ script: { provider: "openai-compatible", paid: true, apiKeyEnv: "TEST_SCRIPT_KEY" } }),
      "utf8",
    );
    const running = await startStudioServer(createStudioServer(), { port: 0 });
    try {
      const response = await postJson(running, "script");

      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, "paid-confirmation-required");
    } finally {
      await running.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/server.test.ts`
Expected: FAIL — the route answers `200`, not `202`, and the paid request is not refused

- [ ] **Step 3: Add the job kind**

In `src/jobs.ts` line 6:

```ts
export type JobKind = "voice" | "captions" | "render" | "asset" | "asr" | "script";
```

- [ ] **Step 4: Convert the route**

In `src/server.ts`, replace the existing script route:

```ts
  if (method === "POST" && rest === "script") {
    const body = await readJsonBody(request);
    const config = await loadStudioConfig();
    if (config.script.paid && body.confirmedPaidRequest !== true) {
      sendError(response, 409, {
        code: "paid-confirmation-required",
        message: "The configured script model is paid and requires explicit confirmation.",
        action: "confirm-paid-request",
      });
      return;
    }
    await startProjectJob(response, projectId, "script", ({ signal }) =>
      generateScript(projectId, {
        confirmedPaidRequest: body.confirmedPaidRequest === true,
        signal,
      }));
    return;
  }
```

Change the import on `src/server.ts:45`:

```ts
import { generateScript } from "./script.ts";
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. If `tests/workflow-templates.test.ts` asserted a `200` from this route, update that assertion to `202`.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/jobs.ts src/server.ts tests/server.test.ts
git commit -m "feat: run script generation as a background job with a paid gate"
```

---

### Task 6: Studio controls and documentation

**Files:**
- Modify: `src/web/index.html:73-82` (add a paid-script dialog after the voice dialog)
- Modify: `src/web/app.js` (`renderScript`, dialog wiring)
- Modify: `README.md`
- Test: `tests/web.test.ts`

**Interfaces:**
- Consumes: `config.script` (Task 4); the `202` job response (Task 5)

- [ ] **Step 1: Write the failing test**

Append to `tests/web.test.ts`:

```ts
test("the script stage shows the configured model and gates paid generation", async () => {
  const html = await readFile("src/web/index.html", "utf8");
  const script = await readFile("src/web/app.js", "utf8");

  assert.match(html, /id="paid-script-dialog"/);
  assert.match(html, /id="confirm-paid-script"/);
  assert.match(script, /paidScriptDialog/);
  assert.match(script, /requestScript/);
  assert.match(script, /Script model/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/web.test.ts`
Expected: FAIL — `id="paid-script-dialog"` is absent

- [ ] **Step 3: Add the dialog**

In `src/web/index.html`, immediately after the `paid-voice-dialog` element closing tag:

```html
    <dialog id="paid-script-dialog">
      <form method="dialog">
        <h2>Confirm Paid Script Model</h2>
        <p>The configured script model is a paid API and each generation costs money. Confirm only if you intend to spend on this request.</p>
        <menu>
          <button value="cancel">Cancel</button>
          <button id="confirm-paid-script" value="confirm">Confirm</button>
        </menu>
      </form>
    </dialog>
```

- [ ] **Step 4: Wire the studio**

In `src/web/app.js`, beside the existing `confirmPaidVoice` element lookups near line 116:

```js
const paidScriptDialog = document.querySelector("#paid-script-dialog");
const confirmPaidScript = document.querySelector("#confirm-paid-script");
```

Beside the existing `confirmPaidVoice` listener near line 126:

```js
confirmPaidScript.addEventListener("click", () => requestScript(true));
```

Replace the `Generate Script` action inside `renderScript` so it routes through the gate, and show the configured model:

```js
    actionButton("Generate Script", () => requestScript(false), "button", "primary"),
```

Add `Script model` to the `summaryGrid` call in `renderScript`:

```js
      "Script model": `${appState.config?.script?.provider ?? "dry-run"} · ${appState.config?.script?.model ?? "local-template"}`,
```

Add the request function beside `requestVoice`:

```js
async function requestScript(confirmedPaidRequest) {
  const response = await fetch(projectApiUrl("script"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmedPaidRequest }),
  });
  const data = await response.json();
  if (response.status === 409 && data.code === "paid-confirmation-required") {
    paidScriptDialog.showModal();
    return;
  }
  if (!response.ok) {
    setStatus(`${data.code}: ${data.message}`);
    return;
  }
  if (reportedAsJob(response, data)) {
    return;
  }
  setStatus("Script generated.");
  await selectProject(appState.selectedProject);
}
```

Add `script` to `JOB_LABELS`:

```js
const JOB_LABELS = { voice: "Voice", render: "Render", asr: "ASR", captions: "Captions", asset: "Asset analysis", script: "Script" };
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: Document the configuration**

In `README.md`, add a section after `## Studio Config`:

````markdown
## Script Model

Script, metadata, and scene plan generation runs through a configurable model.
The default is `dry-run`, the built-in template, which produces the same
structure for every project and exists for offline testing rather than for
publishing.

For a free local model, install [Ollama](https://ollama.com), pull a model, and
point the studio at it:

```powershell
ollama pull qwen2.5:14b
```

```jsonc
"script": {
  "provider": "openai-compatible",
  "model": "qwen2.5:14b",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKeyEnv": "",
  "paid": false,
  "temperature": 0.8,
  "maxOutputTokens": 4000
}
```

For a hosted API, change `baseUrl`, name the environment variable holding the
key, and mark it paid so the studio asks before every spend:

```jsonc
"script": {
  "provider": "openai-compatible",
  "model": "gpt-4o-mini",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",
  "paid": true
}
```

The same settings reach any OpenAI-compatible endpoint, including LM Studio,
llama.cpp, vLLM, DeepSeek, Groq, and OpenRouter.

A failed model call fails the job and reports why. The studio never falls back
to the template, because template output presented as model output is exactly
the sameness this setting exists to remove. Generating a script also makes any
existing script approval stale, so voice and render stay blocked until you read
and approve the new text.
````

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add src/web/index.html src/web/app.js tests/web.test.ts README.md
git commit -m "feat: expose script model choice and paid confirmation in the studio"
```

---

## Verification

After Task 6, confirm against the spec's success criteria:

- [ ] `npm test` and `npm run typecheck` are clean.
- [ ] `grep -rn "fetch(" tests/` shows no real network call — only injected fakes.
- [ ] With `provider: "dry-run"`, the studio behaves exactly as before.
- [ ] With Ollama stopped and `provider: "openai-compatible"`, generating a script produces a failed job naming `127.0.0.1:11434`, and `script.md` is unchanged.
- [ ] With `paid: true`, the studio shows the confirmation dialog and no request is sent until confirmed.
- [ ] After generating a script on a project whose script was approved, the render gate reports `script-approval-stale`.

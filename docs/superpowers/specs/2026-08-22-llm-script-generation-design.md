# LLM Script Generation Design

**Date:** 2026-08-22
**Status:** Approved design, pending implementation
**Project:** YouTube Review Studio

## Goal

Replace the fixed script template with a real language model, so the studio
produces distinct commentary per project instead of one interpolated skeleton
reused for every video.

## Problem

`buildDryRunScript` interpolates brief fields into a hardcoded string. Every
project therefore yields the same sentences with a different show name, and the
only outbound model call in the codebase is OpenAI TTS. The README promises
"AI-assisted brief, script, title, description, and pinned comment generation",
and `studio.config.json` already declares `script.provider: "dry-run"` as a
placeholder for the real thing.

Beyond the unmet promise, near-identical output across a channel is the pattern
YouTube treats as mass-produced content, which puts monetization at risk.

## User Outcome

1. Point the studio at a local model server, or at a paid API after confirming
   the cost.
2. Generate a script, publishing metadata, and scene plan from the brief.
3. Read and edit the result, which makes any prior approval stale.
4. Approve the current narration and continue to voice, captions, and render.

## Product Constraints

- Prefer local and free generation by default, consistent with Piper and local
  ASR.
- Never fall back from a configured model to the template silently.
- Never reach a paid provider without explicit confirmation.
- Keep generated project files under the ignored project workspace.
- Keep the approval gates already enforced for script, assets, and copyright.

## Scope

Included: a provider interface, one OpenAI-compatible adapter, the existing
template exposed as an explicit provider, a pure prompt builder, response
validation, config fields, and the script route converted to a background job.

Not included: response streaming, cost accounting or budget caps, a native
Anthropic adapter, a series link on the brief so the brand kit can shape the
prompt, and conversion of the `audio-story` and `review-script` templates. Those
remain template-driven and are separate work.

## Module Layout

```text
src/llm/
  types.ts              LlmProvider interface, request and result types
  openai-compatible.ts  POST /v1/chat/completions with an injectable fetch
  dry-run.ts            the existing template exposed as a provider
src/script-prompt.ts    pure prompt builder from the brief
src/script.ts           provider selection, validation, file writes
```

One adapter covers Ollama, LM Studio, llama.cpp, vLLM, OpenAI, DeepSeek, Groq,
and OpenRouter, because all of them speak `/v1/chat/completions`. OpenRouter in
turn reaches Anthropic models, so a native Anthropic adapter earns nothing yet.

## Provider Interface

```ts
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

`signal` carries the job's `AbortSignal` so cancelling a job aborts the request,
matching how `renderDraft` already threads cancellation into FFmpeg.

## Configuration

The `script` section gains the fields needed to reach a model server:

```jsonc
"script": {
  "provider": "dry-run",                    // or "openai-compatible"
  "model": "qwen2.5:14b",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "apiKeyEnv": "",                          // empty for a local server
  "paid": false,
  "temperature": 0.8,
  "maxOutputTokens": 4000
}
```

Moving from a local model to a hosted one is a change of `baseUrl`, `apiKeyEnv`,
and `paid`. No new code. Defaults keep `dry-run`, so an existing checkout behaves
exactly as before until configured.

The API key is read from the named environment variable, never stored in
`studio.config.json`, which follows the existing rule for `OPENAI_API_KEY`.

## Prompt and Response Contract

`buildScriptPrompt(brief)` is a pure function returning the system and user
messages. It states the format, target runtime, audience, language, and the
required response shape, and it instructs the model to write original commentary
rather than to summarize copyrighted footage.

Tone and style guidance comes from `brief.notes`. The brand kit is deliberately
not consulted: it is keyed by series id, and `VideoBrief` carries no series link,
so a standalone project cannot reach one. Giving briefs a series link and feeding
the brand kit into the prompt is worthwhile, and is separate work.

The model must answer with a single JSON object:

```jsonc
{
  "script": "# Title\n\n## Hook\n...",
  "metadata": {
    "titles": ["..."],
    "description": "...",
    "hashtags": ["..."],
    "pinnedComment": "..."
  },
  "scenePlan": [
    { "label": "Hook", "durationSeconds": 8, "purpose": "...", "visualDirection": "..." }
  ]
}
```

The request sets `response_format: { type: "json_object" }` where the server
supports it, and validation does not depend on that support.

## Validation

`parseScriptGeneration(raw, projectId)` is pure and rejects, with a message
naming the specific defect:

- output that is not JSON, including a model that answers in prose
- a missing or empty `script`
- `metadata.titles` or `metadata.hashtags` that is not a non-empty string array
- a `scenePlan` that is not a non-empty array of well-formed scenes
- any scene with a non-finite or non-positive `durationSeconds`

Files are written only after validation passes, so a bad response never leaves a
half-written project. `script.md`, `metadata.json`, and `scene-plan.json` are
still written together, preserving the current contract with the narration
extractor and the visual mapper.

## API and Job Model

`POST /api/projects/:id/script` becomes a background job of kind `script`:

- `202` with the job record on acceptance; progress arrives on the project event
  stream, as with voice, render, and ASR.
- `409 paid-confirmation-required` when `script.paid` is true and the request did
  not set `confirmedPaidRequest`, mirroring the OpenAI voice gate.
- `409 job-already-running` when the project already has a job in flight.

The studio's Script stage gains a paid-confirmation dialog reusing the existing
voice confirmation component.

## Approval Interaction

No change is required. Generation rewrites `script.md`, which changes the
narration hash, which makes any existing script approval stale, which blocks
voice and render until a human approves the new text. That chain is already
enforced and tested.

## Error Handling

A provider failure fails the job and surfaces the provider's message. The studio
never substitutes the template for a failed model call: doing so would ship
template content under the belief that a model wrote it, which is the exact
failure this work exists to remove. Choosing the template stays an explicit
`provider: "dry-run"` setting.

Connection failures name the configured `baseUrl` so a stopped Ollama is
diagnosable from the status line. A missing API key for a provider that needs one
fails before any request is sent.

## Testing Strategy

No test performs network access.

- `openai-compatible` receives an injected `fetch`, as `tts/openai.ts` does, and
  is tested for request shape, authorization header presence and absence, and
  abort propagation.
- `buildScriptPrompt` is tested as a pure function for brief fields, language,
  and format-specific runtime targets.
- `parseScriptGeneration` is tested against each rejection case above and one
  well-formed response.
- A server test covers the paid gate, the `202` job response, and the failure
  reaching the event stream.
- The existing smoke test keeps using `dry-run`, proving the default path is
  unchanged.

## Delivery Sequence

1. `src/llm/types.ts` and `parseScriptGeneration` with validation tests.
2. `buildScriptPrompt` with tests.
3. `openai-compatible` adapter with injected-fetch tests.
4. `dry-run` provider wrapping the existing template.
5. Config fields and defaults.
6. `generateScript` provider selection and file writes.
7. Script route as a job, with the paid gate.
8. Studio Script stage: provider display and paid confirmation.
9. README and config documentation.

## Success Criteria

- Two projects with different briefs produce materially different scripts,
  titles, and descriptions.
- A stopped local model server produces a failed job naming the endpoint, and no
  project file is modified.
- A paid provider cannot be reached without confirmation.
- Generating a script makes an existing approval stale and blocks render.
- `npm test` and `npm run typecheck` stay clean, with no network in tests.

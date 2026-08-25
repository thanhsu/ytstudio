import type { ChatMessage } from "../llm/chat.ts";
import { JSON_ONLY_RULE } from "../story-factory/prompts/context.ts";
import { renderList } from "../story-factory/prompts/template.ts";
import type { CanonChapterPlan, CanonSeries, CanonTypedFact } from "./types.ts";

/**
 * Canon prompts.
 *
 * These differ from the story-factory prompts in one structural way: the
 * existing `renderStoryContext` bakes in "write for LISTENING", the channel
 * locale, and the audio-story safety framing. A canon chapter is written in the
 * series' canonical language against a story bible, and is not a publication —
 * so it gets its own framing rather than inheriting a narration brief. Both
 * share `JSON_ONLY_RULE`, which is the actual contract.
 *
 * Ordering is prompt-cache friendly: the stable series framing comes first in
 * the system message, the volatile retrieved context last in the user message.
 * No transport here implements cache_control, so this costs nothing today and
 * is simply the shape that benefits when one does.
 */

export const CANON_PROMPTS = {
  seriesBible: { name: "canon.series-bible", version: "canon-bible-v1" },
  seriesCharacters: { name: "canon.series-characters", version: "canon-characters-v1" },
  seriesArcs: { name: "canon.series-arcs", version: "canon-arcs-v1" },
  chapterPlan: { name: "canon.chapter-plan", version: "canon-plan-v1" },
  chapterWrite: { name: "canon.chapter-write", version: "canon-write-v1" },
  continuity: { name: "canon.continuity", version: "canon-continuity-v1" },
  memoryExtract: { name: "canon.memory-extract", version: "canon-memory-v1" },
} as const;

export function renderSeriesFraming(series: CanonSeries): string {
  return `Series: ${series.title}
- Canonical language: ${series.canonicalLanguage}. Write ALL prose in this language.
- Genre: ${series.genre}${series.subGenres.length ? ` (${series.subGenres.join(", ")})` : ""}.
- Tone: ${series.tone}
- Audience: ${series.targetAudience}
- House style: ${series.styleProfile}

Hard rules:
- 100% original fiction. Never retell a known book, film, game, creepypasta, or franchise; never use trademarked names or franchise characters.
- Fictional stories only: no real crimes presented as fact, no instructions for crimes, no sexual content, no content endangering minors, no hate content, no excessive graphic gore.
- The canon supplied to you is the single source of truth. Where your instincts and the canon disagree, the canon wins.`;
}

// ---------------------------------------------------------------------------
// Series design
// ---------------------------------------------------------------------------

export function buildSeriesBibleMessages(series: CanonSeries, brief: string): ChatMessage[] {
  const system = `You are a series architect designing the authoritative bible for a long-running audio-fiction series. This is structure, not prose: no scenes, no dialogue.

${renderSeriesFraming(series)}

Design for a series of roughly ${series.targetChapterCount || 40} chapters. The mysteries you define must have real answers you record now — a mystery without a planned answer becomes a plot hole around chapter twenty.

${JSON_ONLY_RULE}
Fields:
- "premise": one paragraph, the engine of the whole series.
- "setting": where and when it happens.
- "worldRules": array of strings — the rules of this world that may never be broken.
- "fixedFacts": array of strings — established facts every chapter must respect.
- "locations": array of {"name","description"}.
- "importantObjects": array of {"name","description","status"}.
- "mysteries": array of {"question","answer"} — the answer is the planned truth, never revealed early.
- "endingConstraints": array of strings — what must be true when the series ends.`;

  return [
    { role: "system", content: system },
    { role: "user", content: `Series brief:\n${brief}\n\nDesign the bible now.` },
  ];
}

export function buildSeriesCharactersMessages(series: CanonSeries, bibleSummary: string): ChatMessage[] {
  const system = `You are a series architect defining the cast of a long-running series. Identity is permanent: what you write here constrains every chapter that follows.

${renderSeriesFraming(series)}

${JSON_ONLY_RULE}
Fields:
- "characters": array of objects with
  - "name": the character's full name.
  - "role": their function in the story.
  - "birthYear": integer or null.
  - "appearance": one sentence.
  - "personality": array of short traits.
  - "background": array of short factual statements.
  - "startingLocation": where they are when the series opens.
  - "startingGoals": array of what they want.`;

  return [
    { role: "system", content: system },
    { role: "user", content: `Story bible:\n${bibleSummary}\n\nDefine the cast now.` },
  ];
}

export function buildSeriesArcsMessages(series: CanonSeries, bibleSummary: string, castSummary: string): ChatMessage[] {
  const system = `You are a series architect laying out the major arcs of a long-running series, then the lightweight chapter cards inside each one. Cards are concepts, never prose.

${renderSeriesFraming(series)}

"mustNotRevealYet" is the most important field you write: it is what stops a later writer, who will see this arc but not your intentions, from spending a twist ten chapters early.

${JSON_ONLY_RULE}
Fields:
- "arcs": array of objects with
  - "title", "goal", "endingHook": strings.
  - "startChapter", "targetEndChapter": integers.
  - "requiredReveals": array of strings — what MUST be revealed by the arc's end.
  - "mustNotRevealYet": array of strings — what must NOT be revealed during this arc.
  - "requiredEvents": array of strings.
  - "chapterCards": array of objects with "chapterNumber", "goal", "mainEvents" (array), "characters" (array of names), "locations" (array of names), "requiredClues" (array), "mustNotReveal" (array), "endingHook", "arcProgress".`;

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `Story bible:\n${bibleSummary}\n\nCast:\n${castSummary}\n\nPlan the arcs and their chapter cards now.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Chapter planning
// ---------------------------------------------------------------------------

export function buildChapterPlanMessages(
  series: CanonSeries,
  input: { chapterNumber: number; arcTitle: string; arcGoal: string; card: string; mustNotReveal: string[] },
): ChatMessage[] {
  const system = `You turn a lightweight chapter card into a concrete chapter plan. You are planning, not writing: no prose.

${renderSeriesFraming(series)}

${JSON_ONLY_RULE}
Fields:
- "title": the chapter's working title.
- "goal": what this chapter must accomplish for the arc.
- "beats": array of 4-8 ordered beats.
- "characters": array of character ids appearing.
- "locations": array of location ids used.
- "requiredClues": array of clues that must be planted.
- "mustNotReveal": array — carry forward everything you were told not to reveal.
- "endingHook": the closing beat that pulls the listener into the next chapter.
- "targetWords": integer word target for the chapter.`;

  const user = `Chapter ${input.chapterNumber}, in arc "${input.arcTitle}" (goal: ${input.arcGoal}).

Chapter card:
${input.card}

Must NOT be revealed yet:
${renderList(input.mustNotReveal)}

Plan chapter ${input.chapterNumber} now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// Chapter writing
// ---------------------------------------------------------------------------

export function buildChapterWriteMessages(
  series: CanonSeries,
  plan: CanonChapterPlan,
  assembledContext: string,
): ChatMessage[] {
  const system = `You write ONE chapter of an ongoing series. You are a writer, not the architect: the plan and the canon below are given to you and you may not overrule them.

${renderSeriesFraming(series)}

You MUST NOT:
- invent canon that conflicts with the context you were given;
- resolve a mystery unless the plan tells you to;
- reveal anything listed under "must not reveal";
- change a character's identity, age, appearance, or what they know;
- change an established world rule;
- silently add major backstory for a character or location.

If the plan requires something the supplied canon does not tell you — a fact you would have to invent to write the scene — DO NOT invent it. Return the contextGap field instead. A paused chapter is cheap; a hallucinated canon fact is permanent and every later chapter inherits it.

${JSON_ONLY_RULE}
Fields:
- "title": the chapter's final title.
- "text": the full chapter prose.
- "summary": 3-5 sentences covering what actually happened, for later retrieval.
- "contextGap": OMIT this field entirely when you can write the chapter. When you cannot, set it to {"missing": ["..."], "question": "..."} and leave "text" empty.`;

  const user = `${assembledContext}

Chapter ${plan.chapterNumber}: ${plan.title}
Goal: ${plan.goal}
Beats:
${renderList(plan.beats)}
Clues to plant:
${renderList(plan.requiredClues)}
Must NOT reveal:
${renderList(plan.mustNotReveal)}
Ending hook: ${plan.endingHook}
Target length: about ${plan.targetWords} words.

Write chapter ${plan.chapterNumber} now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

export function buildContinuityMessages(
  series: CanonSeries,
  input: { chapterNumber: number; chapterText: string; assembledContext: string; openThreads: string[] },
): ChatMessage[] {
  const system = `You are a continuity checker. You are NOT a writer and NOT an editor: you do not rewrite, and you do not judge quality.

${renderSeriesFraming(series)}

The canon supplied below is authoritative. Check the chapter against it for:
character identity, age, appearance, what each character knows and when they learned it, relationships, timeline, location, inventory, injuries, deaths, world rules, established facts, mystery state, reveal timing, foreshadowing, and forgotten open plot threads.

DO NOT INVENT AN EXPLANATION TO MAKE AN ERROR VALID. If the chapter says a character knows something no scene taught them, that is an error even if you can imagine how they might have found out. Rationalising a contradiction is the one thing you must never do.

Report only real contradictions with the supplied canon. An empty issues array is the correct answer for a clean chapter.

${JSON_ONLY_RULE}
Fields:
- "passed": boolean — true only when there are no ERROR issues.
- "issues": array of {"severity":"ERROR"|"WARN","type":"CHARACTER_KNOWLEDGE"|"TIMELINE"|"WORLD_RULE"|"CHARACTER_IDENTITY"|"LOCATION"|"INVENTORY"|"INJURY"|"DEATH"|"RELATIONSHIP"|"ESTABLISHED_FACT"|"MYSTERY_STATE"|"REVEAL_TIMING"|"FORESHADOWING"|"OPEN_THREAD"|"APPEARANCE"|"CHARACTER_AGE","description":"...","canonReference":"the canon statement it contradicts","suggestedAction":"REWRITE"|"CLARIFY"|"ACCEPT"}`;

  const user = `${input.assembledContext}

Open plot threads that must not be silently dropped:
${renderList(input.openThreads)}

Chapter ${input.chapterNumber} as written:
${input.chapterText}

Check it now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ---------------------------------------------------------------------------
// Memory extraction
// ---------------------------------------------------------------------------

export function buildMemoryExtractMessages(
  series: CanonSeries,
  input: { chapterNumber: number; chapterText: string; characterIds: string[]; locationIds: string[] },
): ChatMessage[] {
  const system = `You extract structured memory from a chapter that has already been accepted as canon. You are a recorder: you do not judge, improve, or add anything the chapter does not state.

${renderSeriesFraming(series)}

Use ONLY these character ids: ${input.characterIds.join(", ") || "(none)"}
Use ONLY these location ids: ${input.locationIds.join(", ") || "(none)"}
Anything naming an id outside those lists is rejected, so omit it rather than guessing.

Knowledge rules — these are validated and violations are rejected:
- Every knowledge update must name the event that taught it, by its index in your own "newEvents" array.
- A character can only learn from an event they are listed in.
- Use "add" only for a subject the character knows nothing about yet. If they already know something about that subject and it has changed, use "supersede".

"facts" on an event are machine-comparable values a later translation must preserve: times as HH:MM, dates as YYYY-MM-DD, numbers as digits, names as written. Record only values the chapter actually states.

${JSON_ONLY_RULE}
Fields:
- "newEvents": array of {"eventType","summary","characters","locations","importance"(0-1),"storyTime","facts":[{"kind":"number"|"time"|"date"|"name","label","value"}]}
- "newFacts": array of {"field":"worldRules"|"fixedFacts","text"}
- "characterStateUpdates": array of {"characterId","currentLocation","emotionalState","addHealth","addInventory","removeInventory","addGoals","removeGoals","deceased"}
- "knowledgeUpdates": array of {"characterId","changeType":"add"|"supersede"|"retract","fact","subject","sourceEventIndex","supersedes"}
- "relationshipUpdates": array of {"characterId","otherCharacterId","relation"}
- "worldStateUpdates": array of {"currentStoryTime","currentDate","setLocation":{"locationId","condition"},"addThreats","removeThreats"}
- "newPlotThreads": array of {"id","title","notes"}
- "resolvedPlotThreads": array of thread ids
- "foreshadowingAdded": array of strings
- "mysteriesRevealed": array of mystery ids`;

  return [
    { role: "system", content: system },
    { role: "user", content: `Chapter ${input.chapterNumber}:\n${input.chapterText}\n\nExtract memory now.` },
  ];
}

/** Rendered for the localizer so it knows which values are load-bearing. */
export function renderTypedFacts(facts: CanonTypedFact[]): string {
  if (facts.length === 0) return "(none)";
  return facts.map((fact) => `- ${fact.label}: ${fact.value}`).join("\n");
}

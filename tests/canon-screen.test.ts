import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * The canon UI reuses the existing chrome deliberately: a canon series is a
 * channel project, so it opens in the channel workspace, and a canon chapter is
 * a StoryProject, so it opens in the story detail view. These tests pin that
 * reuse — if someone later adds a parallel screen, they break.
 */

async function storyFactoryScreen(): Promise<string> {
  return readFile("src/web/screens/story-factory.js", "utf8");
}

test("canon does not add a new screen or a new route", async () => {
  const [main, router, html] = await Promise.all([
    readFile("src/web/main.js", "utf8"),
    readFile("src/web/lib/router.js", "utf8"),
    readFile("src/web/index.html", "utf8"),
  ]);
  // The workspace phase bar and the router's PHASE_IDS are fixed four-element
  // sets shared with review-project and series. Canon uses the in-panel tab
  // pattern instead of widening them.
  assert.doesNotMatch(main, /mountCanon/);
  assert.doesNotMatch(router, /"canon"/);
  assert.doesNotMatch(html, /data-nav="canon"/);
});

test("a story's tabs follow its kind, so a variant never offers Idea or Outline", async () => {
  const script = await storyFactoryScreen();
  assert.match(script, /const CANON_CHAPTER_TABS = \[/);
  assert.match(script, /const VARIANT_TABS = \[/);
  assert.match(script, /function tabsForStory\(story\)/);
  assert.match(script, /for \(const \[id, label\] of tabsForStory\(detail\.story\)\)/);

  const variantBlock = script.slice(script.indexOf("const VARIANT_TABS"), script.indexOf("function tabsForStory"));
  for (const tab of ["localize", "canon-alignment", "script", "audio", "publish"]) {
    assert.ok(variantBlock.includes(`"${tab}"`), `a variant needs the ${tab} tab`);
  }
  for (const tab of ["idea", "hook", "outline"]) {
    assert.equal(variantBlock.includes(`["${tab}"`), false, `a variant must not offer ${tab}: it has no such stage`);
  }
});

test("a canon chapter exposes plan, context, continuity, and memory", async () => {
  const script = await storyFactoryScreen();
  const canonBlock = script.slice(script.indexOf("const CANON_CHAPTER_TABS"), script.indexOf("const VARIANT_TABS"));
  // Every one of these tab ids is also a stage id, which is what lets the
  // generic artifact viewer render them without bespoke code.
  for (const tab of ["chapter-plan", "canon-context", "canon-write", "canon-continuity", "memory-extract", "memory-apply"]) {
    assert.ok(canonBlock.includes(`"${tab}"`), `a canon chapter needs the ${tab} tab`);
  }
});

test("a variant says where its canon lives and that canon is the source of truth", async () => {
  const script = await storyFactoryScreen();
  assert.match(script, /function canonBanner\(story\)/);
  assert.match(script, /Canon is the source of truth/);
  assert.match(script, /LOCKED/);
});

test("the canon panel appears only for a project that really is a canon series", async () => {
  const script = await storyFactoryScreen();
  assert.match(script, /canon\/series/);
  assert.match(script, /canon\?\.series \? \[renderCanonPanel/);
  for (const entity of ["bible", "characters", "world-state", "arcs", "threads"]) {
    assert.ok(script.includes(`["${entity}"`), `the canon panel needs a ${entity} view`);
  }
});

test("the memory view shows the score breakdown but never raw embeddings", async () => {
  const script = await storyFactoryScreen();
  assert.match(script, /keyword \$\{entry\.keywordScore\}/);
  assert.match(script, /importance \$\{entry\.importance\}/);
  assert.match(script, /final \$\{entry\.finalScore\}/);
  // Debuggability is scores and ranks; a wall of floats helps nobody.
  assert.doesNotMatch(script, /entry\.values/);
  assert.doesNotMatch(script, /\.embedding\b/);
});

test("a damaged ledger line and a stale localization are surfaced, not hidden", async () => {
  const script = await storyFactoryScreen();
  assert.match(script, /Damaged ledger lines/);
  assert.match(script, /could not be parsed/);
  assert.match(script, /are behind their canon chapter/);
  // The system reports the impact; regenerating a published video stays a
  // human decision.
  assert.match(script, /Nothing has been regenerated/);
});

test("the config screen renders model roles from a list rather than by hand", async () => {
  const config = await readFile("src/web/screens/config.js", "utf8");
  assert.match(config, /const MODEL_ROLES = \[/);
  assert.match(config, /MODEL_ROLES\.map\(/);
  for (const role of ["planner", "writer", "qa", "architect", "localizer", "memory"]) {
    assert.ok(config.includes(`["${role}"`), `the config screen must offer the ${role} role`);
  }
  // Optional chaining throughout: a config file written before these roles
  // existed must not crash the screen.
  assert.match(config, /config\.storyFactory\.models\?\.\[role\]/);
  assert.match(config, /contextWindowTokens/);
  assert.match(config, /storyFactory\.embeddings\.provider/);
  assert.match(config, /storyFactory\.canon\.enabled/);
});

test("the canon UI keeps the repo's DOM conventions", async () => {
  const script = await storyFactoryScreen();
  const panel = script.slice(script.indexOf("// =============================== Story Canon"));
  assert.ok(panel.length > 0, "the canon panel section exists");
  assert.equal(panel.includes("innerHTML"), false, "no innerHTML, as everywhere else in this UI");
  assert.match(panel, /createElement/);
  assert.match(panel, /replaceChildren/);
});

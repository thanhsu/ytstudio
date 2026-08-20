import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureProjectDir, projectDir, readJson, writeJson } from "./fs.ts";
import type { Metadata, ScenePlan, VideoBrief } from "./types.ts";

export type ScriptGeneration = {
  script: string;
  metadata: Metadata;
  scenePlan: ScenePlan;
};

export async function generateDryRunScript(projectId: string): Promise<ScriptGeneration> {
  const brief = await readJson<VideoBrief>(join(projectDir(projectId), "brief.json"));
  const generation = buildDryRunScript(brief);
  const dir = await ensureProjectDir(projectId);

  await writeFile(join(dir, "script.md"), generation.script, "utf8");
  await writeJson(join(dir, "metadata.json"), generation.metadata);
  await writeJson(join(dir, "scene-plan.json"), generation.scenePlan);

  return generation;
}

export function buildDryRunScript(brief: VideoBrief): ScriptGeneration {
  const isShort = brief.format === "shorts";
  const duration = isShort ? "75 seconds" : "7 minutes";
  const titleCore = brief.topic.replace(/[.?!]+$/g, "");

  const script = `# ${titleCore}

Format: ${brief.format}
Target audience: ${brief.audience}
Language: ${brief.language}
Runtime target: ${duration}

## Hook

${brief.show} is getting attention because ${titleCore.toLowerCase()}, but the interesting part is not just the action. It is what this says about the character, the world, and why viewers keep arguing about it.

## Context

In this review, we use ${brief.show} as the case study. The goal is commentary and explanation, not replaying the original episode. Any source footage should be short and tied to a specific point.

## Main Points

1. The scene or character works because there is a clear tension underneath the spectacle.
2. The strongest hook for international viewers is the contrast with typical cultivation-story expectations.
3. The video should make one sharp claim, support it with examples, then invite debate in the comments.

## Closing

So the real question is not whether ${brief.show} is popular right now. The question is whether this moment proves the series has enough depth to stay popular after the trend cools down.

What do you think: is this one of the strongest donghua stories right now?
`;

  const metadata: Metadata = {
    projectId: brief.id,
    titles: [
      `${titleCore} | ${brief.show} Review`,
      `Why ${brief.show} Is Getting Bigger Than Expected`,
      `${brief.show}: The Detail Most Viewers Missed`,
    ],
    description: `Original review and commentary about ${brief.show}. This video focuses on analysis, context, and opinion rather than replaying the source material.`,
    hashtags: ["#donghua", "#animeReview", "#TalesOfHerdingGods", "#review"],
    pinnedComment: `What is your take on ${brief.show} right now? Drop the strongest argument for or against it.`,
  };

  const scenePlan: ScenePlan = {
    projectId: brief.id,
    scenes: [
      {
        label: "Hook",
        durationSeconds: isShort ? 4 : 20,
        purpose: "State the strongest opinion quickly.",
        visualDirection: "Large title text over generated fantasy background.",
      },
      {
        label: "Context",
        durationSeconds: isShort ? 10 : 60,
        purpose: "Name the show and frame the review topic.",
        visualDirection: "Show title card, character relationship card, or map-style visual.",
      },
      {
        label: "Analysis",
        durationSeconds: isShort ? 45 : 280,
        purpose: "Deliver original commentary with two or three supporting points.",
        visualDirection: "Use captions, power-scale cards, diagrams, and very short source clips only when needed.",
      },
      {
        label: "Comment prompt",
        durationSeconds: isShort ? 12 : 60,
        purpose: "Drive comments with a clear debate question.",
        visualDirection: "Bold question card with channel branding.",
      },
    ],
  };

  return { script, metadata, scenePlan };
}

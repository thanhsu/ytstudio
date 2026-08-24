import { bindShell, setStatus, confirmPaidVoice, confirmPaidScript } from "./lib/shell.js";
import { startRouter, navigate } from "./lib/router.js";
import { mountProjects } from "./screens/projects.js";
import { mountReviewProject, requestVoice, requestScript } from "./screens/review-project.js";
import { mountSeries } from "./screens/series.js";
import { mountChannel } from "./screens/story-factory.js";
import { mountSources } from "./screens/sources.js";
import { mountConfig } from "./screens/config.js";

const SCREENS = {
  projects: mountProjects,
  "review-project": mountReviewProject,
  series: mountSeries,
  channel: mountChannel,
  sources: mountSources,
  config: mountConfig,
};

bindShell();

// The paid-spend dialogs live in the shell, outside any screen, so their
// confirm buttons are wired once at boot.
confirmPaidVoice.addEventListener("click", () => requestVoice(true));
confirmPaidScript.addEventListener("click", () => requestScript(true));

startRouter((route) => {
  const mount = SCREENS[route.screen] ?? mountProjects;
  Promise.resolve(mount(route)).catch((error) => {
    setStatus(error.message);
    if (route.screen !== "projects") navigate("#/projects");
  });
});

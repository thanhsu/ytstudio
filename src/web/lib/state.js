import { setStatus } from "./shell.js";

export const appState = {
  projects: [],
  series: [],
  reviewProjectsBySeries: {},
  audioStoryWorkspaces: {},
  brandKits: {},
  thumbnailBriefs: {},
  selectedSeries: null,
  selectedReviewProjectId: null,
  selectedProject: null,
  activeStage: "brief",
  projectSnapshot: null,
  editManifest: null,
  editExport: null,
  translationPresets: null,
  workflowTemplates: null,
  config: null,
  selectedMappingSceneId: null,
  eventStream: null,
  eventStreamProject: null,
  activeJob: null,
  sourceSearchResults: [],
  sourceSearchFilters: {
    expandBilibiliQuery: true,
  },
};

export const JOB_LABELS = {
  voice: "Voice",
  render: "Render",
  asr: "ASR",
  captions: "Captions",
  asset: "Asset analysis",
  script: "Script",
  "story-pipeline": "Story pipeline",
  "story-stage": "Story stage",
  "story-export": "Story export",
  "voiceover-render": "Voiceover render",
};

const jobEventHandlers = new Set();

// Screens subscribe to react to finished jobs (e.g. reload the open story or
// project). state.js stays ignorant of which screens exist.
export function onJobEvent(handler) {
  jobEventHandlers.add(handler);
}

/**
 * Slow routes answer with a job instead of a finished artifact, so the studio
 * follows the project event stream for progress rather than holding a request
 * open for the whole render.
 */
export function ensureProjectEventStream(projectId) {
  if (appState.eventStreamProject === projectId && appState.eventStream) {
    return;
  }
  appState.eventStream?.close();
  const source = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
  source.addEventListener("job", (event) => handleJobEvent(JSON.parse(event.data)));
  appState.eventStream = source;
  appState.eventStreamProject = projectId;
}

function handleJobEvent(job) {
  const label = JOB_LABELS[job.kind] ?? job.kind;
  if (job.status === "running") {
    appState.activeJob = job;
    setStatus(`${label}: ${job.message} (${job.progress}%)`);
    return;
  }

  appState.activeJob = null;
  if (job.status === "succeeded") {
    setStatus(`${label} finished.`);
  } else if (job.status === "cancelled") {
    setStatus(`${label} cancelled.`);
  } else {
    setStatus(`${label} failed: ${job.error ?? "unknown error"}`);
  }
  for (const handler of jobEventHandlers) {
    handler(job);
  }
}

/**
 * Returns true when the route accepted the work as a background job, so the
 * caller should wait for the event stream instead of reading an artifact.
 */
export function reportedAsJob(response, data) {
  if (response.status !== 202) {
    return false;
  }
  const label = JOB_LABELS[data.job?.kind] ?? data.job?.kind ?? "Job";
  setStatus(`${label} started.`);
  return true;
}

export function projectApiUrl(route) {
  return `/api/projects/${encodeURIComponent(appState.selectedProject)}/${route}`;
}

export function projectFileUrl(relativePath) {
  return `/api/projects/${encodeURIComponent(appState.selectedProject)}/files/${encodeURIComponent(relativePath)}`;
}

// The fetch half of the old loadProjects(): fills appState, renders nothing.
export async function refreshAppData() {
  const [projectsResponse, seriesResponse, presetsResponse, workflowsResponse, configResponse] = await Promise.all([
    fetch("/api/projects"),
    fetch("/api/series"),
    fetch("/api/translation-presets"),
    fetch("/api/workflow-templates"),
    fetch("/api/config"),
  ]);
  const data = await projectsResponse.json();
  appState.series = (await seriesResponse.json()).series ?? [];
  appState.translationPresets = await presetsResponse.json();
  appState.workflowTemplates = await workflowsResponse.json();
  appState.config = (await configResponse.json()).config;
  appState.projects = data.projects ?? [];
  appState.projectBriefs = data.briefs ?? [];
  appState.reviewProjectsBySeries = Object.fromEntries(
    await Promise.all(
      appState.series.map(async (series) => {
        const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/review-projects`);
        return [series.id, (await response.json()).reviewProjects ?? []];
      }),
    ),
  );
  appState.audioStoryWorkspaces = Object.fromEntries(
    await Promise.all(
      appState.series
        .filter((series) => series.workflowType === "audio-story")
        .map(async (series) => {
          const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/audio-story`);
          return [series.id, (await response.json()).workspace ?? {}];
        }),
    ),
  );
  appState.brandKits = Object.fromEntries(
    await Promise.all(
      appState.series.map(async (series) => {
        const response = await fetch(`/api/series/${encodeURIComponent(series.id)}/brand-kit`);
        return [series.id, (await response.json()).brandKit ?? {}];
      }),
    ),
  );
  if (!appState.selectedSeries && appState.series.length > 0) {
    appState.selectedSeries = appState.series[0];
  }
}

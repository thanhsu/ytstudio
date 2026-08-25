import { buildSourceSearchQueries, lines } from "../search-queries.js";
import { postJson, patchJson } from "../lib/api.js";
import {
  paragraph, wrapSection, gateNotice, field, textareaField, checkboxField,
  selectField, actionButton, formValues, boolFormValues, lower,
} from "../lib/dom.js";
import { setStatus, view, setBreadcrumb, setActiveNav } from "../lib/shell.js";
import { appState } from "../lib/state.js";

// The container this screen paints into. mountSources() creates it; the screen's
// own re-renders keep writing to the same node.
let sourcesHost = null;

export function sourcePlatformOptions() {
  return [
    ["youtube", "YouTube"],
    ["bilibili", "Bilibili"],
    ["tiktok", "TikTok (URL-only unless search prefix is configured)"],
    ["douyin", "Douyin (URL-only unless search prefix is configured)"],
    ["facebook", "Facebook (URL-only unless search prefix is configured)"],
    ["seedance", "BestSeedancePrompts video assets"],
  ];
}

// Pairs, because selectField destructures each entry as [value, label]. An
// object literal here throws "is not iterable" and takes the whole screen with it.
const SOURCE_RIGHTS_OPTIONS = [
  ["unknown", "Not declared"],
  ["own", "I own this footage"],
  ["licensed", "I hold a licence"],
  ["third-party-fair-use", "Third party, review commentary"],
];

// Top-level screen entry point: owns its own container under #view.
export async function mountSources() {
  setActiveNav("sources");
  setBreadcrumb([{ label: "Sources" }]);
  const host = document.createElement("section");
  host.className = "screen sources-screen";
  view.replaceChildren(host);
  await renderSources(host);
}

export async function renderSources(container = sourcesHost) {
  sourcesHost = container;
  setStatus("Loading sources...");

  let sources = [];
  try {
    sources = (await (await fetch("/api/sources")).json()).sources ?? [];
  } catch (error) {
    setStatus(error.message);
  }

  const addForm = document.createElement("form");
  addForm.className = "form-grid";
  addForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { url } = formValues(addForm);
      const data = await postJson("/api/sources", { url });
      setStatus(data.created ? `Added ${data.candidate.title}.` : `Already tracked: ${data.candidate.title}.`);
      await renderSources();
    } catch (error) {
      setStatus(error.message);
    }
  });

  const searchForm = document.createElement("form");
  searchForm.className = "form-grid source-search-form";
  searchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await searchSources(boolFormValues(searchForm));
  });
  const expandedQueries = textareaField(
    "Expanded queries",
    "expandedQueries",
    (appState.sourceSearchFilters.expandedQueries ?? buildSourceSearchQueries(appState.sourceSearchFilters)).join("\n"),
  );
  expandedQueries.classList.add("source-query-preview");
  searchForm.replaceChildren(
    field("Keyword", "query", appState.sourceSearchFilters.query ?? "", "text", "牧神记 episode 1"),
    selectField("Platform", "platform", appState.sourceSearchFilters.platform ?? appState.config?.sources?.defaultSearchPlatform ?? "youtube", sourcePlatformOptions()),
    field("Limit", "limit", String(appState.sourceSearchFilters.limit ?? appState.config?.sources?.searchLimit ?? 8), "number"),
    checkboxField("Expand Bilibili/Douyin query", "expandBilibiliQuery", appState.sourceSearchFilters.expandBilibiliQuery !== false),
    field("Include keywords", "includeKeywords", appState.sourceSearchFilters.includeKeywords ?? "", "text", "episode, recap"),
    field("Exclude keywords", "excludeKeywords", appState.sourceSearchFilters.excludeKeywords ?? "", "text", "official, trailer"),
    field("Max views", "maxViews", String(appState.sourceSearchFilters.maxViews || ""), "number"),
    checkboxField("Hide short clips", "hideShortClips", appState.sourceSearchFilters.hideShortClips === true),
    expandedQueries,
    sourceSearchToolbar(),
  );

  addForm.replaceChildren(
    field("Video URL", "url", "", "text", "https://www.youtube.com/watch?v=..."),
    actionButton("Add Source", null, "submit", "primary"),
  );

  // Rights are permission to download, and only that. A project still needs its
  // own approved copyright checklist before anything renders, and this screen
  // must not let anyone believe otherwise.
  const boundary = paragraph(
    "One pasted URL at a time, for making original review commentary. " +
      "Declaring rights permits the download only — a project still needs its own approved copyright check before it can render.",
  );
  boundary.className = "source-boundary";

  const heading = document.createElement("h2");
  heading.textContent = "Sources";

  sourcesHost.replaceChildren(
    heading,
    gateNotice(
      "Discovery only",
      "Searching and tracking a candidate does not grant reuse permission. Declaring rights permits the download only — a project still needs its own approved copyright check before it can render.",
      "block",
    ),
    wrapSection(
      "Search by keyword",
      paragraph("Find possible review sources first. Search results are not downloaded or tracked until you choose one."),
      searchForm,
      renderSourceSearchResults(filterSourceSearchResults(appState.sourceSearchResults, appState.sourceSearchFilters)),
    ),
    wrapSection(
      "Add a source",
      paragraph("Paste a video URL. Metadata is read first; nothing is downloaded until you declare rights."),
      addForm,
    ),
    wrapSection("Candidates", boundary, renderSourceList(sources)),
  );
  setStatus(`${sources.length} source${sources.length === 1 ? "" : "s"} tracked.`);
}

function renderSourceSearchResults(results) {
  const wrapper = document.createElement("div");
  wrapper.className = "source-search-results";
  if (!results.length) {
    wrapper.append(paragraph("No keyword search results yet."));
    return wrapper;
  }

  for (const result of results) {
    const card = document.createElement("article");
    card.className = "source-result-card";
    const children = [];
    if (result.thumbnailUrl) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "source-thumbnail";
      thumbnail.src = result.thumbnailUrl;
      thumbnail.alt = "";
      thumbnail.loading = "lazy";
      thumbnail.referrerPolicy = "no-referrer";
      children.push(thumbnail);
    }
    const title = document.createElement("h4");
    title.textContent = result.title;
    const meta = document.createElement("p");
    meta.className = "source-meta";
    meta.textContent = [
      result.platform,
      result.uploader || "unknown channel",
      formatSourceDuration(result.durationSeconds),
      result.viewCount ? `${result.viewCount.toLocaleString()} views` : "views unknown",
    ].join(" · ");
    const triage = triageSourceSearchResult(result);
    const badge = document.createElement("span");
    badge.className = `source-triage source-triage-${triage.risk}`;
    badge.textContent = triage.label;
    badge.title = triage.reason;
    const matched = document.createElement("p");
    matched.className = "source-matched-query";
    matched.textContent = result.matchedQuery ? `Matched query: ${result.matchedQuery}` : "Matched query: original keyword";
    const link = document.createElement("a");
    link.href = result.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = result.url;
    const actions = document.createElement("div");
    actions.className = "source-actions";
    actions.append(actionButton("Track Source", () => trackSource(result), "button", "primary"));
    card.append(...children, title, meta, badge, matched, link, actions);
    wrapper.append(card);
  }
  return wrapper;
}

function sourceSearchToolbar() {
  const toolbar = document.createElement("div");
  toolbar.className = "source-search-toolbar field-wide";
  toolbar.append(
    actionButton("Refresh expanded queries", () => refreshSourceExpandedQueries(), "button"),
    actionButton("Search Sources", null, "submit", "primary"),
  );
  return toolbar;
}

function refreshSourceExpandedQueries() {
  const form = document.querySelector(".source-search-form");
  if (!form) return;
  const values = boolFormValues(form);
  const preview = form.elements.namedItem("expandedQueries");
  if (preview) preview.value = buildSourceSearchQueries(values, { ignoreEditedQueryList: true }).join("\n");
}

async function searchSources(values) {
  try {
    const queries = buildSourceSearchQueries(values);
    appState.sourceSearchFilters = {
      query: values.query,
      platform: values.platform,
      limit: values.limit,
      includeKeywords: values.includeKeywords,
      excludeKeywords: values.excludeKeywords,
      maxViews: Number(values.maxViews) > 0 ? values.maxViews : "",
      hideShortClips: values.hideShortClips === true,
      expandBilibiliQuery: values.expandBilibiliQuery !== false,
      expandedQueries: queries,
    };
    const searches = await Promise.all(
      queries.map(async (query) => {
        const data = await postJson("/api/sources/search", {
          query,
          platform: values.platform,
          limit: values.limit,
        });
        return (data.results ?? []).map((result) => ({ ...result, matchedQuery: query }));
      }),
    );
    appState.sourceSearchResults = dedupeSourceSearchResults(searches.flat());
    const visible = filterSourceSearchResults(appState.sourceSearchResults, appState.sourceSearchFilters).length;
    setStatus(`${visible}/${appState.sourceSearchResults.length} source search result(s) visible after filters.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function dedupeSourceSearchResults(results) {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = result.url || `${result.platform}:${result.id ?? result.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(result);
  }
  return deduped;
}

function filterSourceSearchResults(results, filters) {
  const include = lines(filters.includeKeywords).map(lower);
  const exclude = lines(filters.excludeKeywords).map(lower);
  const maxViews = Number(filters.maxViews);
  return results.filter((result) => {
    const haystack = lower(`${result.title} ${result.uploader} ${result.url}`);
    if (include.length && !include.some((term) => haystack.includes(term))) return false;
    if (exclude.some((term) => haystack.includes(term))) return false;
    if (Number.isFinite(maxViews) && maxViews > 0 && Number(result.viewCount) > maxViews) return false;
    if (filters.hideShortClips === true && triageSourceSearchResult(result).label === "short clip") return false;
    return true;
  });
}

/**
 * Rates how workable a result is as review material, and nothing else.
 *
 * It deliberately does not rank by how likely a rights holder is to enforce.
 * Popularity does not weaken fair use, and a rights holder posting their own
 * work does not strengthen it — a badge built on those signals would be steering
 * the operator toward whoever is least likely to object, which is target
 * selection, not review judgement.
 */
function triageSourceSearchResult(result) {
  const haystack = lower(`${result.title} ${result.uploader}`);
  const durationSeconds = Number(result.durationSeconds);

  if (/(trailer|teaser|pv|预告|preview)/.test(haystack)) {
    return { label: "promo material", risk: "warn", reason: "Trailers and teasers are promotional cuts with little story to analyse." };
  }
  if (durationSeconds > 0 && durationSeconds < 180) {
    return { label: "short clip", risk: "warn", reason: "Short clips often lack enough story context for a review." };
  }
  if (!durationSeconds || !lower(result.title).trim()) {
    return { label: "thin metadata", risk: "warn", reason: "Missing duration or title makes this hard to judge before downloading." };
  }
  if (/(official|官方|腾讯|youku|iqiyi)/.test(haystack)) {
    return { label: "official channel", risk: "ok", reason: "Posted by the rights holder, which is the best place to verify the source." };
  }
  return { label: "review-friendly", risk: "ok", reason: "Metadata looks usable for human review triage." };
}

async function trackSource(result) {
  try {
    const data = await postJson("/api/sources", { url: result.url, searchResult: result });
    appState.sourceSearchResults = appState.sourceSearchResults.filter((item) => item.url !== result.url);
    setStatus(data.created ? `Tracking ${data.candidate.title}.` : `Already tracked: ${data.candidate.title}.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function renderSourceList(sources) {
  if (!sources.length) {
    return paragraph("No sources yet. Paste a URL above to start.");
  }

  const list = document.createElement("ul");
  list.className = "source-list";
  // Unscored candidates sort last rather than being hidden: a score is an
  // ordinal hint, not a filter.
  const ranked = [...sources].sort((left, right) => (right.score?.value ?? -1) - (left.score?.value ?? -1));
  for (const candidate of ranked) {
    list.append(renderSourceRow(candidate));
  }
  return list;
}

function renderSourceRow(candidate) {
  const item = document.createElement("li");
  item.className = `source-row source-status-${candidate.status}`;

  const heading = document.createElement("h4");
  heading.textContent = candidate.title;

  const meta = document.createElement("p");
  meta.className = "source-meta";
  meta.textContent = [
    candidate.platform,
    candidate.uploader || "unknown channel",
    formatSourceDuration(candidate.durationSeconds),
    candidate.status,
  ].join(" · ");

  const children = [heading, meta];

  if (candidate.score) {
    children.push(renderSourceScore(candidate.score));
  }

  if (candidate.error) {
    const failure = document.createElement("p");
    failure.className = "source-error";
    failure.textContent = candidate.error;
    children.push(failure);
  }

  // The video is on disk; something optional beside it is not. Saying so keeps
  // a missing subtitle from reading as a silent success.
  if (candidate.warning) {
    const note = document.createElement("p");
    note.className = "source-warning";
    note.textContent = `Video saved, but: ${candidate.warning}`;
    children.push(note);
  }

  const rightsForm = document.createElement("form");
  rightsForm.className = "form-grid source-rights";
  rightsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await patchJson(`/api/sources/${encodeURIComponent(candidate.id)}`, formValues(rightsForm));
      setStatus(`Rights recorded for ${candidate.title}.`);
      await renderSources();
    } catch (error) {
      setStatus(error.message);
    }
  });
  rightsForm.replaceChildren(
    selectField("Rights", "rights", candidate.rights, SOURCE_RIGHTS_OPTIONS),
    field("Note", "rightsNote", candidate.rightsNote),
    actionButton("Save rights", null, "submit"),
  );

  const actions = document.createElement("div");
  actions.className = "source-actions";
  const download = actionButton("Download", () => startSourceJob(candidate.id, "download"), "button", "primary");
  const audioDownload = actionButton("Audio only", () => startSourceJob(candidate.id, "download", { audioOnly: true }), "button");
  if (candidate.rights === "unknown") {
    for (const button of [download, audioDownload]) {
      button.disabled = true;
      button.title = "Declare rights before downloading.";
    }
  }
  actions.append(
    actionButton("Score", () => startSourceJob(candidate.id, "score")),
    download,
    audioDownload,
    actionButton("Delete", () => deleteSource(candidate.id, candidate.title)),
  );
  if (candidate.status === "downloaded") {
    actions.append(useInProjectControl(candidate));
  }

  item.replaceChildren(...children, rightsForm, actions);
  return item;
}

function useInProjectControl(candidate) {
  const wrap = document.createElement("span");
  wrap.className = "source-use-in-project";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Target project");
  for (const project of appState.projects ?? []) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.id;
    select.append(option);
  }
  const button = actionButton("Use in project", () => sendSourceToProject(candidate.id, select.value), "button");
  if (!select.options.length) {
    button.disabled = true;
    button.title = "Create a project first.";
  }
  wrap.append(select, button);
  return wrap;
}

async function sendSourceToProject(sourceId, projectId) {
  if (!projectId) return;
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/media/from-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId }),
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(`${data.code}: ${data.message}`);
      return;
    }
    const subtitleNote = data.subtitle
      ? `subtitle ready (${data.subtitle.cueCount} cues)`
      : "no subtitle — extract audio and run ASR in the project";
    setStatus(`Imported into ${projectId}: ${data.media.relativePath}; ${subtitleNote}. Continue in the project's Media, ASR, and Script stages.`);
  } catch (error) {
    setStatus(error.message);
  }
}

/**
 * The number never stands alone. A score is one model reading metadata it has not
 * verified, so the angle it proposes, the risks it saw, and what produced it are
 * shown beside it.
 */
function renderSourceScore(score) {
  const panel = document.createElement("div");
  panel.className = "source-score";

  const value = document.createElement("strong");
  value.textContent = `${score.value}/100`;

  const angle = document.createElement("p");
  angle.textContent = `Angle: ${score.angle}`;

  const reason = document.createElement("p");
  reason.className = "source-score-reason";
  reason.textContent = score.reason;

  panel.append(value, angle, reason);

  if (score.risks?.length) {
    const risks = document.createElement("ul");
    risks.className = "source-risks";
    for (const risk of score.risks) {
      const entry = document.createElement("li");
      entry.textContent = risk;
      risks.append(entry);
    }
    panel.append(risks);
  }

  const provenance = document.createElement("p");
  provenance.className = "source-score-provenance";
  provenance.textContent = `Scored by ${score.provider} · ${score.model}`;
  panel.append(provenance);

  return panel;
}

async function startSourceJob(id, action, body = {}) {
  try {
    const response = await fetch(`/api/sources/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      setStatus(`${data.code}: ${data.message}`);
      return;
    }
    setStatus(`${action} running in the background for ${id}.`);
    followSourceJob(id);
  } catch (error) {
    setStatus(error.message);
  }
}

function followSourceJob(id) {
  const stream = new EventSource(`/api/sources/${encodeURIComponent(id)}/events`);
  stream.addEventListener("job", async (event) => {
    const job = JSON.parse(event.data);
    const percent = job.status === "running" && Number.isFinite(job.progress) ? ` ${job.progress}%` : "";
    setStatus(`${job.kind} ${job.status}${percent}: ${job.message}`);
    if (job.status !== "running") {
      stream.close();
      await renderSources();
    }
  });
  stream.addEventListener("error", () => stream.close());
}

async function deleteSource(id, title) {
  if (!confirm(`Delete the source "${title}" and every file downloaded for it?`)) return;
  try {
    const response = await fetch(`/api/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      setStatus(`${data.code}: ${data.message}`);
      return;
    }
    setStatus(`Deleted ${title}.`);
    await renderSources();
  } catch (error) {
    setStatus(error.message);
  }
}

function formatSourceDuration(seconds) {
  if (!seconds) return "duration unknown";
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

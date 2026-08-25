const PHASE_IDS = new Set(["overview", "content", "edit", "publish"]);

export function parseRoute(hash) {
  const path = String(hash ?? "").replace(/^#/, "");

  // Legacy single-word hashes from the pre-router shell.
  if (path === "sources") return { screen: "sources" };
  if (path === "config") return { screen: "config" };
  if (path === "series") return { screen: "projects", typeFilter: "series" };
  if (path === "story-factory") return { screen: "projects", typeFilter: "channel" };

  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0] === "projects") return { screen: "projects" };
  if (parts[0] === "sources") return { screen: "sources" };
  if (parts[0] === "config") return { screen: "config" };
  if (parts[0] === "jobs") return { screen: "jobs" };
  if (parts[0] === "youtube") {
    return parts[1]
      ? { screen: "youtube", id: decodeURIComponent(parts[1]), view: parts[2] || "overview" }
      : { screen: "youtube", view: "overview" };
  }
  if (parts[0] === "project" && parts[1]) {
    return { screen: "review-project", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  if (parts[0] === "series" && parts[1]) {
    return { screen: "series", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  if (parts[0] === "channel" && parts[1]) {
    if (parts[2] === "story" && parts[3]) {
      return { screen: "channel", id: decodeURIComponent(parts[1]), storyId: decodeURIComponent(parts[3]) };
    }
    return { screen: "channel", id: decodeURIComponent(parts[1]), phase: normalizePhase(parts[2]) };
  }
  return { screen: "projects" };
}

function normalizePhase(part) {
  return PHASE_IDS.has(part) ? part : "overview";
}

export function routeHash(route) {
  if (route.screen === "sources") return "#/sources";
  if (route.screen === "config") return "#/config";
  if (route.screen === "jobs") return "#/jobs";
  if (route.screen === "youtube") return `#/youtube/${encodeURIComponent(route.id)}/${route.view ?? "overview"}`;
  if (route.screen === "review-project") return `#/project/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  if (route.screen === "series") return `#/series/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  if (route.screen === "channel" && route.storyId) {
    return `#/channel/${encodeURIComponent(route.id)}/story/${encodeURIComponent(route.storyId)}`;
  }
  if (route.screen === "channel") return `#/channel/${encodeURIComponent(route.id)}/${route.phase ?? "overview"}`;
  return "#/projects";
}

export function navigate(routeOrHash) {
  location.hash = typeof routeOrHash === "string" ? routeOrHash : routeHash(routeOrHash);
}

export function startRouter(onChange) {
  window.addEventListener("hashchange", () => onChange(parseRoute(location.hash)));
  onChange(parseRoute(location.hash));
}

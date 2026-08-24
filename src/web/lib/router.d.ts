// Hand-written because the module ships as plain JavaScript: the browser loads
// it directly from /lib/router.js, so it cannot be a .ts file.

export type ScreenType = "projects" | "sources" | "config" | "review-project" | "series" | "channel" | "youtube";

export type TypeFilter = "review" | "series" | "channel";

export type PhaseType = "overview" | "content" | "edit" | "publish";

export type Route =
  | { screen: "projects"; typeFilter?: TypeFilter }
  | { screen: "sources" }
  | { screen: "config" }
  | { screen: "youtube"; id?: string; view?: string }
  | { screen: "review-project"; id: string; phase?: PhaseType }
  | { screen: "series"; id: string; phase?: PhaseType }
  | { screen: "channel"; id: string; phase?: PhaseType }
  | { screen: "channel"; id: string; storyId: string };

export function parseRoute(hash: string): Route;

export function routeHash(route: Route): string;

export function navigate(routeOrHash: Route | string): void;

export function startRouter(onChange: (route: Route) => void): void;

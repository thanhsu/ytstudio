import { redact } from "../redact.ts";

export type YouTubeError = { code: string; message: string; retryable: boolean; action?: string };

export function normalizeYouTubeError(error: unknown): YouTubeError {
  const body = providerBody(error);
  const reason = /(?:quotaExceeded|uploadLimitExceeded)/i.exec(body)?.[0];
  if (reason) return { code: "youtube-quota-exceeded", message: "YouTube quota has been exceeded. Retry after the quota resets.", retryable: false, action: "retry-after-quota-reset" };
  if (/(permissionDenied|forbidden)/i.test(body)) return { code: "youtube-permission-denied", message: "YouTube denied this operation. Review channel permissions.", retryable: false, action: "review-permissions" };
  if (/notFound/i.test(body)) return { code: "youtube-video-not-found", message: "The YouTube video was not found.", retryable: false };
  const status = /(?:^|\s)(\d{3})(?:\s|$)/.exec(body)?.[1];
  return { code: "youtube-upload-failed", message: `YouTube request failed${status ? ` (${status})` : ""}. Retry the operation.`, retryable: true, action: "retry" };
}

export function redactedYouTubeError(error: unknown): Error {
  const normalized = normalizeYouTubeError(error);
  return new Error(`${normalized.code}: ${normalized.message}`);
}

function providerBody(error: unknown): string {
  if (error instanceof Error) return redact(error.message);
  if (typeof error === "string") return redact(error);
  if (typeof error === "object" && error !== null) {
    const value = error as { response?: { body?: unknown }; body?: unknown; message?: unknown };
    const body = value.response?.body ?? value.body ?? value.message ?? "";
    const status = "response" in value && value.response && "status" in value.response ? ` ${String((value.response as { status?: unknown }).status)}` : "";
    return redact(`${status} ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return "";
}

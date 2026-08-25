import { lines } from "../search-queries.js";
import {
  selectField, field, checkboxField, textareaField, actionButton,
  sectionTitle, readinessPill, setPathValue,
} from "../lib/dom.js";
import { setStatus, view, setBreadcrumb, setActiveNav } from "../lib/shell.js";
import { appState, refreshAppData } from "../lib/state.js";
import { targetOptions } from "./review-project.js";
import { sourcePlatformOptions } from "./sources.js";

// The container this screen paints into. mountConfig() creates it; saving
// re-renders into the same node.
let configHost = null;

// A hand-edited studio.config.json can hold a provider the studio will refuse to
// use. It is listed as it is rather than dropped, so the screen never shows a
// provider that differs from the one Generate Script will complain about.
function scriptProviderOptions(current) {
  const options = [
    ["dry-run", "Dry run (offline template)"],
    ["openai-compatible", "OpenAI-compatible"],
  ];
  if (typeof current === "string" && current && !options.some(([value]) => value === current)) {
    options.push([current, `${current} (unrecognized — pick a valid provider)`]);
  }
  return options;
}

// Top-level screen entry point: owns its own container under #view.
export async function mountConfig() {
  setActiveNav("config");
  setBreadcrumb([{ label: "Config" }]);
  const host = document.createElement("section");
  host.className = "screen config-screen";
  view.replaceChildren(host);
  if (!appState.config) {
    await refreshAppData();
  }
  renderConfig(host);
}

export function renderConfig(container = configHost) {
  configHost = container;
  const config = appState.config;
  if (!config) return;
  const form = document.createElement("form");
  form.className = "config-form";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveConfig(form).catch((error) => setStatus(error.message));
  });

  const scriptReady = config.script.provider === "dry-run"
    ? ["done", "Ready (offline)"]
    : config.script.provider === "openai-compatible" && config.script.model && config.script.baseUrl
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const translationReady = config.translation.provider === "prompt-only"
    ? ["done", "Ready (manual)"]
    : config.translation.model
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const asrReady = config.asr.provider === "disabled"
    ? ["neutral", "Optional"]
    : config.asr.executablePath
      ? ["done", "Ready"]
      : ["warn", "Needs setup"];
  const ttsProvider = config.tts.defaultProvider;
  const ttsReady = ttsProvider === "piper"
    ? (config.tts.piper.executablePath && config.tts.piper.modelPath ? ["done", "Ready"] : ["warn", "Needs setup"])
    : ttsProvider === "vietnamese-local"
      ? (config.tts.vietnameseLocal.pythonPath && config.tts.vietnameseLocal.appPath ? ["done", "Ready"] : ["warn", "Needs setup"])
      : (config.tts.openai.apiKeyEnv ? ["done", "Ready"] : ["warn", "Needs setup"]);
  const renderReady = config.render.ffmpegPath && config.render.ffprobePath ? ["done", "Ready"] : ["warn", "Needs setup"];
  const sourcesReady = config.sources.ytDlpPath ? ["done", "Ready"] : ["neutral", "Optional"];

  form.replaceChildren(
    configSection("Script", scriptReady[0], scriptReady[1], [
      selectField("Script provider", "script.provider", config.script.provider, scriptProviderOptions(config.script.provider)),
      field("Script model", "script.model", config.script.model),
      field("Script base URL", "script.baseUrl", config.script.baseUrl),
      field("Script API key env", "script.apiKeyEnv", config.script.apiKeyEnv),
      checkboxField("Script provider is paid", "script.paid", config.script.paid),
      field("Script temperature", "script.temperature", String(config.script.temperature), "number", "", "any"),
      field("Script max output tokens", "script.maxOutputTokens", String(config.script.maxOutputTokens), "number"),
    ]),
    configSection("Translation", translationReady[0], translationReady[1], [
      selectField("Translation provider", "translation.provider", config.translation.provider, [
        ["prompt-only", "Prompt only"],
        ["openai", "OpenAI"],
        ["gemini", "Gemini"],
      ]),
      field("Translation model", "translation.model", config.translation.model),
      selectField("Default target", "translation.defaultTarget", config.translation.defaultTarget, targetOptions()),
      selectField("Default genre", "translation.defaultGenre", config.translation.defaultGenre, [
        ["cultivation", "Cultivation"],
        ["fantasy-system", "Fantasy / system"],
        ["modern-drama", "Modern drama"],
      ]),
    ]),
    configSection("ASR", asrReady[0], asrReady[1], [
      selectField("ASR provider", "asr.provider", config.asr.provider, [
        ["disabled", "Disabled"],
        ["faster-whisper", "Faster Whisper"],
        ["whisper-cpp", "whisper.cpp"],
      ]),
      field("ASR executable", "asr.executablePath", config.asr.executablePath),
      field("ASR model", "asr.model", config.asr.model),
      field("ASR model path", "asr.modelPath", config.asr.modelPath),
      field("ASR language", "asr.language", config.asr.language),
    ]),
    configSection("Voice", ttsReady[0], ttsReady[1], [
      selectField("Default voice provider", "tts.defaultProvider", config.tts.defaultProvider, [
        ["piper", "Piper"],
        ["vietnamese-local", "Vietnamese local"],
        ["openai", "OpenAI"],
      ]),
      field("OpenAI speech model", "tts.openai.model", config.tts.openai.model),
      field("OpenAI voice", "tts.openai.voice", config.tts.openai.voice),
      field("OpenAI API key env", "tts.openai.apiKeyEnv", config.tts.openai.apiKeyEnv),
      field("Piper executable", "tts.piper.executablePath", config.tts.piper.executablePath),
      field("Piper model path", "tts.piper.modelPath", config.tts.piper.modelPath),
      field("Piper voice label", "tts.piper.voice", config.tts.piper.voice),
      field("Vietnamese Python path", "tts.vietnameseLocal.pythonPath", config.tts.vietnameseLocal.pythonPath),
      field("Vietnamese app path", "tts.vietnameseLocal.appPath", config.tts.vietnameseLocal.appPath),
      field("Vietnamese voice", "tts.vietnameseLocal.voice", config.tts.vietnameseLocal.voice),
    ]),
    configSection("Render", renderReady[0], renderReady[1], [
      field("FFmpeg path", "render.ffmpegPath", config.render.ffmpegPath),
      field("FFprobe path", "render.ffprobePath", config.render.ffprobePath),
      selectField("Story video engine", "render.storyEngine", config.render.storyEngine, [
        ["ffmpeg", "FFmpeg"],
        ["hyperframes", "Hyperframes"],
      ]),
      field("Hyperframes command", "render.hyperframesCommand", config.render.hyperframesCommand),
      textareaField("Hyperframes args", "render.hyperframesArgs", (config.render.hyperframesArgs ?? []).join("\n")),
      field("Hyperframes timeout minutes", "render.hyperframesTimeoutMinutes", String(config.render.hyperframesTimeoutMinutes), "number"),
      field("Shorts width", "render.shortsWidth", String(config.render.shortsWidth), "number"),
      field("Shorts height", "render.shortsHeight", String(config.render.shortsHeight), "number"),
      field("Story width", "render.longformWidth", String(config.render.longformWidth), "number"),
      field("Story height", "render.longformHeight", String(config.render.longformHeight), "number"),
      selectField("Story transition", "render.storyTransition", config.render.storyTransition, [["fade", "Fade"], ["xfade", "Crossfade"]]),
      field("Transition seconds", "render.storyTransitionSeconds", String(config.render.storyTransitionSeconds), "number", "", "any"),
    ]),
    configSection("Story Factory", config.storyFactory.enabled ? "done" : "neutral", config.storyFactory.enabled ? "Enabled" : "Disabled", [
      checkboxField("Story factory enabled", "storyFactory.enabled", config.storyFactory.enabled),
      field("Planner model", "storyFactory.models.planner.model", config.storyFactory.models.planner.model),
      field("Planner base URL", "storyFactory.models.planner.baseUrl", config.storyFactory.models.planner.baseUrl),
      field("Planner API key env", "storyFactory.models.planner.apiKeyEnv", config.storyFactory.models.planner.apiKeyEnv),
      checkboxField("Planner is paid", "storyFactory.models.planner.paid", config.storyFactory.models.planner.paid),
      selectField("Planner provider", "storyFactory.models.planner.provider", config.storyFactory.models.planner.provider, [["openai-compatible", "OpenAI-compatible"], ["anthropic", "Anthropic"], ["gemini", "Gemini"]]),
      field("Writer model", "storyFactory.models.writer.model", config.storyFactory.models.writer.model),
      field("Writer base URL", "storyFactory.models.writer.baseUrl", config.storyFactory.models.writer.baseUrl),
      field("Writer API key env", "storyFactory.models.writer.apiKeyEnv", config.storyFactory.models.writer.apiKeyEnv),
      checkboxField("Writer is paid", "storyFactory.models.writer.paid", config.storyFactory.models.writer.paid),
      selectField("Writer provider", "storyFactory.models.writer.provider", config.storyFactory.models.writer.provider, [["openai-compatible", "OpenAI-compatible"], ["anthropic", "Anthropic"], ["gemini", "Gemini"]]),
      field("QA model", "storyFactory.models.qa.model", config.storyFactory.models.qa.model),
      field("QA base URL", "storyFactory.models.qa.baseUrl", config.storyFactory.models.qa.baseUrl),
      field("QA API key env", "storyFactory.models.qa.apiKeyEnv", config.storyFactory.models.qa.apiKeyEnv),
      checkboxField("QA is paid", "storyFactory.models.qa.paid", config.storyFactory.models.qa.paid),
      selectField("QA provider", "storyFactory.models.qa.provider", config.storyFactory.models.qa.provider, [["openai-compatible", "OpenAI-compatible"], ["anthropic", "Anthropic"], ["gemini", "Gemini"]]),
      field("Duplicate similarity threshold", "storyFactory.duplicateSimilarityThreshold", String(config.storyFactory.duplicateSimilarityThreshold), "number", "", "any"),
      field("Default max cost per story (USD)", "storyFactory.defaultMaxCostPerStoryUsd", String(config.storyFactory.defaultMaxCostPerStoryUsd), "number", "", "any"),
    ]),
    configSection("YouTube", config.youtube.clientIdEnv && config.youtube.clientSecretEnv ? "done" : "warn", config.youtube.clientIdEnv && config.youtube.clientSecretEnv ? "Configured" : "Needs environment variables", [
      field("Client ID environment variable", "youtube.clientIdEnv", config.youtube.clientIdEnv),
      field("Client secret environment variable", "youtube.clientSecretEnv", config.youtube.clientSecretEnv),
      textareaField("OAuth scopes", "youtube.scopes", (config.youtube.scopes ?? []).join("\n")),
    ]),
    configSection("Google TTS", config.tts.google.apiKeyEnv ? "done" : "warn", "Story narration", [
      field("Google TTS API key env", "tts.google.apiKeyEnv", config.tts.google.apiKeyEnv),
      field("Google TTS base URL", "tts.google.baseUrl", config.tts.google.baseUrl),
      selectField("Audio encoding", "tts.google.audioEncoding", config.tts.google.audioEncoding, [
        ["MP3", "MP3"],
        ["LINEAR16", "WAV (LINEAR16)"],
      ]),
      field("Chunk min chars", "tts.google.chunkMinChars", String(config.tts.google.chunkMinChars), "number"),
      field("Chunk max chars", "tts.google.chunkMaxChars", String(config.tts.google.chunkMaxChars), "number"),
      field("Economy USD / 1M chars", "tts.google.pricing.economy", String(config.tts.google.pricing.economy), "number", "", "any"),
      field("Standard USD / 1M chars", "tts.google.pricing.standard", String(config.tts.google.pricing.standard), "number", "", "any"),
      field("Premium USD / 1M chars", "tts.google.pricing.premium", String(config.tts.google.pricing.premium), "number", "", "any"),
    ]),
    configSection("Images", config.images.provider === "gemini" ? "done" : "neutral", config.images.provider === "gemini" ? "Gemini" : "Disabled", [
      selectField("Image provider", "images.provider", config.images.provider, [
        ["disabled", "Disabled"],
        ["gemini", "Gemini"],
      ]),
      field("Gemini API key env", "images.gemini.apiKeyEnv", config.images.gemini.apiKeyEnv),
      field("Gemini image model", "images.gemini.model", config.images.gemini.model),
      field("USD per image (approx.)", "images.gemini.usdPerImage", String(config.images.gemini.usdPerImage), "number", "", "any"),
    ]),
    configSection("Sources", sourcesReady[0], sourcesReady[1], [
      field("yt-dlp path", "sources.ytDlpPath", config.sources.ytDlpPath),
      textareaField("yt-dlp args", "sources.ytDlpArgs", (config.sources.ytDlpArgs ?? []).join("\n")),
      field("Download format", "sources.format", config.sources.format),
      field("Download folder (empty = ./sources)", "sources.downloadDir", config.sources.downloadDir ?? ""),
      textareaField("Subtitle languages", "sources.subtitleLanguages", (config.sources.subtitleLanguages ?? []).join("\n")),
      selectField("Default source search", "sources.defaultSearchPlatform", config.sources.defaultSearchPlatform, sourcePlatformOptions()),
      field("Source search limit", "sources.searchLimit", String(config.sources.searchLimit), "number"),
      field("YouTube search prefix", "sources.searchPrefixes.youtube", config.sources.searchPrefixes.youtube),
      field("Bilibili search prefix", "sources.searchPrefixes.bilibili", config.sources.searchPrefixes.bilibili),
      field("TikTok search prefix", "sources.searchPrefixes.tiktok", config.sources.searchPrefixes.tiktok),
      field("Douyin search prefix", "sources.searchPrefixes.douyin", config.sources.searchPrefixes.douyin),
      field("Facebook search prefix", "sources.searchPrefixes.facebook", config.sources.searchPrefixes.facebook),
    ]),
    actionButton("Save Config", null, "submit", "primary"),
  );
  const heading = document.createElement("h2");
  heading.textContent = "Config";
  configHost.replaceChildren(heading, form);
  setStatus("Config loaded. Secrets stay in environment variables, not in this file.");
}

async function saveConfig(form) {
  const nextConfig = structuredClone(appState.config);
  for (const input of Array.from(form.elements)) {
    if (!input.name) continue;
    setPathValue(nextConfig, input.name, configInputValue(input));
  }

  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(nextConfig),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  appState.config = data.config;
  renderConfig();
  setStatus("Config saved to studio.config.json.");
}

function configInputValue(input) {
  if (input.type === "number") return Number(input.value);
  if (input.type === "checkbox") return input.checked;
  if (input.name === "sources.ytDlpArgs" || input.name === "sources.subtitleLanguages" || input.name === "render.hyperframesArgs") return lines(input.value);
  return input.value;
}

function configSection(title, level, label, fields) {
  const section = document.createElement("div");
  section.className = "config-section";
  const header = document.createElement("div");
  header.className = "config-section-header";
  header.append(sectionTitle(title), readinessPill(level, label));
  const fieldWrap = document.createElement("div");
  fieldWrap.className = "config-section-fields";
  fieldWrap.append(...fields);
  section.append(header, fieldWrap);
  return section;
}

/**
 * Tiny {{variable}} interpolation for prompt templates. Prompt text lives in
 * dedicated modules under prompts/, never inline in stage logic, so wording can
 * change without touching orchestration and every template carries a version.
 */

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      // A silently-empty slot would ship a prompt that reads like an editor
      // deleted a sentence — the model then invents the missing context.
      throw new Error(`Prompt template variable {{${name}}} has no value.`);
    }
    return value;
  });
}

/** Render a string list as prompt-friendly dash bullets; "(none)" keeps the slot visibly empty. */
export function renderList(items: string[]): string {
  if (items.length === 0) {
    return "(none)";
  }
  return items.map((item) => `- ${item}`).join("\n");
}

/** Render a labeled block only when it has content, so prompts skip empty sections. */
export function renderOptionalBlock(label: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  return `${label}:\n${trimmed}\n`;
}

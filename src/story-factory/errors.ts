/**
 * A failure in the CONTENT itself — a flagged duplicate, a failed QA pass, a
 * safety block. Retrying the same call cannot fix it; the material needs to
 * change. The pipeline classifies these separately from provider failures so
 * the operator sees "regenerate or edit", not "try again".
 */
export class StoryContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryContentError";
  }
}

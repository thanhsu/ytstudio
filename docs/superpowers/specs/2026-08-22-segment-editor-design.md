# Subtitle Segment Editor Design

## Goal

Add a local-first human review step for subtitle cues. An operator can create an edit manifest from an SRT file, mark cues as kept or removed, and export a clean SRT plus a CSV decision manifest.

## Scope

- Persist `workspace/edit/segments.json` beneath the selected project.
- Accept individual cue numbers and comma/range input such as `1,5,10-12`.
- Preserve source timing and text; clean SRT output reindexes kept cues sequentially.
- Export `workspace/edit/clean.srt` and `workspace/edit/segments.csv`.
- Expose the workflow through TypeScript functions, CLI commands, project API routes, and the Translation stage in Studio.
- Keep explicit human decisions. Do not download third-party media, cut video, remove watermarks, or automate publishing.

## Data model

The versioned manifest records its project-relative SRT source, a SHA-256 source hash, timestamps, and one segment per parsed cue. Each segment contains the original cue index, start/end timestamps, text, and a `keep` or `remove` decision.

## Validation and safety

- Project paths must use the existing `resolveProjectPath` boundary.
- The SRT source must exist inside the project directory.
- Range syntax rejects malformed, reversed, non-positive, duplicate-free/out-of-range cue values.
- Creating a manifest never overwrites existing human decisions unless replacement is explicitly confirmed.
- API mutations remain protected by the server's existing same-origin rule.

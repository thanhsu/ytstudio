# YouTube Ops Usability Improvements

Date: 2026-08-25

## Summary

Implemented the next UI hardening pass after the render/status overhaul:

- Added a YouTube publish readiness API at `GET /api/series/:id/youtube/publish/readiness`.
- Reworked the publish wizard so the operator can check readiness before upload and see approval matrix, export path, thumbnail path, and metadata inline.
- Added a Jobs debug drawer with owner, id, status, message, error, and raw job JSON for easier failure triage.
- Added a Sources rights review panel with unknown/declaration/downloaded counts, an "unknown rights only" filter, and bulk declaration for unknown-rights candidates.

## Notes

- Readiness remains authoritative on the server. The UI preflight only makes the same gate visible before `Confirm publish`; `startYouTubePublish()` still enforces it.
- Source rights declarations still only permit download. Project-level copyright approval remains a separate gate before render/publish.

## Verification

- `npm run typecheck` passed.
- `node --test tests\jobs-list.test.ts tests\youtube-publish-routes.test.ts tests\youtube-screen.test.ts tests\web.test.ts` passed: 41/41.
- `node --test --test-concurrency=1 tests\*.test.ts` passed: 789/789.

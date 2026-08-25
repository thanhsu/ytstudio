# Seedance Video Asset Source

## Summary

Added BestSeedancePrompts as a source-search platform for the Sources screen. Operators can search the public prompt index, track a selected result as a source candidate, declare rights, and download the direct video asset through the existing source download flow.

## Scope

- Added `seedance` to source search platform normalization and UI platform options.
- Added `src/sources/seedance.ts` to fetch and parse BestSeedancePrompts prompt cards into video search results.
- Supported both plain JSON fixtures and escaped Next.js stream records observed on the live site.
- Added source candidate creation from a selected Seedance search result without requiring yt-dlp metadata probing.
- Added direct-video download for `SeedancePrompt` candidates after the existing rights declaration gate passes.
- Kept search read-only: search results do not create candidates until the operator clicks Track Source.

## Safety Notes

- Download is still blocked until the source rights field is declared.
- New candidates default to `rights: "unknown"` and do not bypass existing project approval gates.
- The implementation downloads only the selected result URL; it does not mass-download the site.

## Verification

- `node --test tests\seedance-source.test.ts`
- `node --test --test-name-pattern "source search|pasted url|downloading is refused|Seedance" tests\server.test.ts tests\seedance-source.test.ts`
- `npm run typecheck`

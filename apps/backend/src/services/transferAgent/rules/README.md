# Venue rules (Transfer Agent)

Per-venue handbooks. One Markdown file per venue, named `${venueId}.md`.
Loaded at runtime by `loadVenueRules(venueId)` in
[`apps/backend/src/services/transferAgent/neuripsRules.js`](../neuripsRules.js)
and injected verbatim as the `{VENUE}_FULL_HANDBOOK` block inside the
venue-skill system prompt (see `apps/backend/src/services/transferAgent/skills/`).

## Contents

| File | Venue | Loaded by |
|------|-------|-----------|
| `neurips.md` | NeurIPS 2026 | `buildNeuripsSkillFromState` |
| `icml.md`    | ICML 2026    | `buildIcmlSkillFromState` |
| `cvpr.md`    | CVPR 2026    | `buildCvprSkillFromState` |
| `acl.md`     | *ACL family (ACL/NAACL/EACL/EMNLP) | `buildAclSkillFromState` |

## Authoring conventions

- **Language**: English only. The runtime LLM prompt is English; mixed-language rules have caused prompt-injection issues in the past.
- **Ground truth**: every rule should tie back to a real artefact in `templates/<venue>/` (a line in `main.tex`, an option in `.sty`, a filename, …). Do not cite the conference website inline — site text changes; local templates are the authoritative baseline.
- **Tool-awareness**: rules should name the actual agent tools (`readFile`, `writeFile`, `applyDiff`, `grepFile`, `listProjectTree`, `copyAsset`, `raiseQuestion`, `measureFigures`) when prescribing a migration step, since the LLM sees the tool list and the handbook in the same prompt.
- **Shape**: sections covered (at minimum):
  1. Template layout on disk
  2. Submission modes (`\usepackage` options, based on `transferIntake.doubleBlind` / `preprint`)
  3. Document class & preamble
  4. Title / authors / anonymity
  5. Document structure & page budget
  6. Citations & bibliography
  7. Figures & tables
  8. Math / typography
  9. Critical DON'Ts (desk-rejection risks)
  10. Migration playbook (tool-call recipes)
  11. Pre-submission checklist

## Related paths

- Templates: `templates/<venueId>/` (with `templates/manifest.json` listing `id`, `label`, `mainFile`, …).
- Caching: `loadVenueRules` caches per venue by `mtimeMs`, so editing a file here is picked up on next load without a process restart.

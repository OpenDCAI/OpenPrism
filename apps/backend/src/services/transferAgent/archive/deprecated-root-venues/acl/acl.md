# ACL Venue Rules (OpenPrism)

This file is the venue handbook loaded by the transfer agent for `acl`.

## Core constraints

1. Use the official ACL style files.
2. Do not modify `acl.sty`.
3. Use correct ACL mode:
   - Review: `\\usepackage[review]{acl}`
   - Final: `\\usepackage{acl}`
4. Keep ACL two-column layout and avoid conflicting geometry overrides.
5. Preserve all scientific content (math, citations, labels, references).
6. Keep ACL-compatible author-year citation behavior and bibliography structure.
7. Ordering:
   - References section appears before appendices.
8. Double-blind review requirements:
   - Remove author-identifying names, affiliations, and identifying URLs.
   - Remove acknowledgements in review mode.
   - Use neutral self-citation style.

## Migration guidance

- Prefer minimal, surgical edits over whole-file rewrites.
- Keep full-width floats when required using `figure*` / `table*`.
- Ensure all assets (`.bib`, images, style dependencies) are copied and paths resolve.
- Do not introduce custom style hacks that break official ACL formatting.

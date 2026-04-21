# ICML 2026 Submission & Formatting Rules

## Key Facts
- **Venue**: International Conference on Machine Learning (ICML) 2026
- **Style package**: `icml2026.sty` (with `icml2026.bst` for bibliography)
- **Layout**: Two-column, US Letter, 10pt Times font
- **Page limit**: 8 pages main body (excluding references and appendices); camera-ready allows 9 pages
- **Review**: Double-blind

## Submission Mode
- Anonymous submission: `\usepackage{icml2026}` (default)
- Camera-ready: `\usepackage[accepted]{icml2026}`
- To disable hyperref: add `nohyperref` option

## Document Structure (Required Order)
1. Title, abstract (single paragraph, 4-6 sentences)
2. Main body sections (max 8 pages)
3. Impact Statement (unnumbered section, does not count toward page limit)
4. Acknowledgements (unnumbered, hidden in submission mode, does not count toward page limit)
5. References (unnumbered first-level heading, APA author-year style)
6. Appendix (optional, submitted as part of same PDF, not a separate file)

## Author Commands
- Use `\icmlauthor{Name}{affiliation-label}` (not `\author{}`)
- Use `\icmlaffiliation{label}{Department, University, City, Country}`
- Use `\icmlcorrespondingauthor{Name}{email}`
- Author info only visible with `[accepted]` option

## Citation Style
- **APA author-year format** (NOT numeric)
- Use `natbib.sty` (loaded by `icml2026.sty`)
- Use `icml2026.bst` for bibliography style
- `\citep{key}` → (Author, Year); `\citet{key}` → Author (Year)
- Self-cite in third person for blind review
- Do NOT anonymize citations in references section
- Alphabetize references by first author surname

## Figures and Tables
- **Two-column layout**: `figure` for single-column, `figure*` for full-width spanning both columns
- Caption below figures, above tables
- 9pt captions, centered unless multi-line (then flush left)
- Float to top or bottom; two-column figures/tables at top or bottom only
- No titles inside figure graphics — use caption instead

## Mathematics
- Use `algorithm` and `algorithmic` environments for pseudocode
- Number definitions, propositions, lemmas consecutively within sections

## Typography
- 10pt Times font throughout
- Section headings: 11pt bold, content words capitalized
- Subsection: 10pt bold, content words capitalized
- Subsubsection: 10pt small caps
- No more than three levels of headings
- Footnotes in 9pt at column bottom

## Critical DON'Ts
- Do NOT include author information in submission
- Do NOT alter style template (no vertical space compression)
- Do NOT use Type-3 fonts
- Do NOT include URLs revealing identity in submission
- Do NOT use `$$...$$` for display math
- Do NOT submit appendix as separate PDF

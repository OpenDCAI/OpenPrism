# ACL — Venue Handbook (OpenPrism)

Authoritative rules for `venueId = acl`. Loaded verbatim by
`loadVenueRules('acl')` and injected as `ACL_FULL_HANDBOOK` into the
skill system prompt. Ground every decision in this file plus the actual
ACL template under `templates/acl/`. The same `acl.sty` is used across
the `*ACL` family (ACL, NAACL, EACL, EMNLP); the per-conference call
for papers may override page limits and deadlines — honour intake notes
when they do.

---

## 1. Template layout on disk

| Path | Purpose |
|------|---------|
| `templates/acl/acl_latex.tex` | Reference paper shell (the `mainFile` in `templates/manifest.json`); `pdflatex` entry. |
| `templates/acl/acl_lualatex.tex` | Alternate shell for `lualatex` / `xelatex` (non-Latin scripts). |
| `templates/acl/acl.sty` | Official style with `review` / `final` / `preprint` options. **Never modify.** |
| `templates/acl/acl_natbib.bst` | Official bibliography style (APA-like author-year). |
| `templates/acl/custom.bib` | Sample bibliography. |

Tool usage:

- `listProjectTree({project:"target"})` to confirm the shell, `.sty`, `.bst`, and `.bib` are present.
- `readFile({project:"target", path:"acl_latex.tex"})` before any edit.

---

## 2. Submission modes (`\usepackage` options)

`acl.sty` defines three top-level options:

| Intake flags | Required preamble |
|---|---|
| `doubleBlind=true` (default review submission) | `\usepackage[review]{acl}` — anonymisation on, line numbers on, page numbers on |
| Camera-ready (accepted paper, final version) | `\usepackage{acl}` — no anonymisation, no line numbers, no page numbers |
| `preprint=true` (non-anonymous, arXiv) | `\usepackage[preprint]{acl}` — authors visible, page numbers on, line numbers off |

Facts:

- `review` mode inserts left-margin line numbers (`lineno`) — never quote these in the body; they vanish in `final`.
- `review` mode also suppresses acknowledgements (per ACL policy — do not render them during blind review).
- `final` mode reveals authors and drops line numbers.
- The default engine is `pdflatex`. `acl.sty` is also compatible with `lualatex` / `xelatex`; the alternate shell `acl_lualatex.tex` demonstrates the setup for non-Latin scripts.

---

## 3. Document class & preamble

Required first line (matches `templates/acl/acl_latex.tex`):

```latex
\documentclass[11pt]{article}
```

Expected package order:

```latex
\usepackage[review]{acl}          % or \usepackage{acl} / [preprint]
\usepackage{times}                % font — alternatives: txfonts, newtx
\usepackage{latexsym}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{microtype}
\usepackage{inconsolata}
\usepackage{graphicx}
% \setlength\titlebox{<dim>}      % only if the title/authors overflow; never below 5cm
```

Hard rules:

1. `\documentclass[11pt]{article}` is mandatory — do not add extra class options, do not switch to `IEEEtran`, `revtex*`, `acmart`, `llncs`, etc.
2. **Never modify `acl.sty`** or `acl_natbib.bst`. The sty enforces column width, margins, and anonymisation logic.
3. Never load `geometry` or set `\textwidth` / `\columnsep` / `\oddsidemargin` manually.
4. `\setlength\titlebox{<dim>}` is the **only** sanctioned layout tweak, and only when the title/author block genuinely overflows. `<dim>` must be ≥ 5 cm.
5. For non-Latin scripts, compile with `lualatex` or `xelatex` and start from `acl_lualatex.tex`; do not add `\usepackage[T5]{fontenc}` on top of a `pdflatex` build — migrate the engine instead.

---

## 4. Title, authors, anonymity

- Use standard LaTeX `\title{...}` and `\author{...}`. Author separators:
  - `\and` / `\And` — same author block, no forced row break.
  - `\AND` — force a new row of author blocks.
- `review` mode hides the author block automatically; still keep real `\author{...}` content so `\usepackage{acl}` produces a correct camera-ready without re-editing.
- Double-blind hygiene in review mode:
  - Remove names, affiliations, identifying emails, public URLs, GitHub handles, grant numbers, dataset slugs from body, captions, and comments.
  - `acl.sty` already hides the acknowledgements section in review — ensure acknowledgements live in their own `\section*{Acknowledgments}` (or `\section*{Acknowledgements}`) so the suppression works.
  - Self-cite in the third person (“Smith et al. (2023) …”).
  - Clear `hyperref` metadata (`pdfauthor`, `pdftitle`, `pdfkeywords`) if the source set it.

---

## 5. Document structure & ordering

Required ordering inside `\begin{document} … \end{document}`:

1. `\maketitle`
2. `\begin{abstract} … \end{abstract}` — typically a single paragraph.
3. Main body sections.
4. `\section*{Limitations}` — **required by most *ACL venues** (e.g. ACL/NAACL/EMNLP); check the current CFP. Unnumbered (starred). Does not count toward the page limit.
5. `\section*{Acknowledgments}` — hidden in `review` mode; rendered in `final`.
6. **References** — `\bibliography{custom}` (or your actual `.bib` name). Must come **before** appendices.
7. `\appendix` followed by appendix sections.

Notes:

- Some *ACL venues also require `\section*{Ethics Statement}` or an analogous section. Consult intake notes; if present in the source, preserve it and place it near the Limitations section.
- Do not place appendices before References — that order is wrong for *ACL submissions.

---

## 6. Page budget

- *ACL page limits are venue-specific and change per call for papers. Common defaults:
  - Long papers: 8 pages main body; camera-ready adds 1 page.
  - Short papers: 4 pages main body; camera-ready adds 1 page.
- References, Limitations, Ethics Statement, Acknowledgments, and Appendices do **not** count toward the page limit.
- If `transferIntake.outputNotes` names a specific *ACL venue, use its current limit. When unsure, `raiseQuestion` once with the two or three plausible choices rather than guessing silently.

---

## 7. Citations & bibliography

- `acl.sty` loads `natbib`. Use the *ACL-natbib macros:
  - `\citep{key}` → `(Author, Year)`
  - `\citet{key}` → `Author (Year)` (narrative)
  - `\citealp{key}` → `Author, Year` (no parentheses)
  - `\citeyearpar{key}` → `(Year)`
  - `\citeposs{key}` → possessive (“Author's (Year)”) — *ACL-only convenience, skip it for cross-venue portability.
- Bibliography style is `acl_natbib.bst`; the template does not require `\bibliographystyle{...}` explicitly because the sty already sets it. Use only:
  - `\bibliography{custom}` for your own `.bib`, or
  - `\bibliography{anthology,custom}` to merge the ACL Anthology bib with your own.
- Do not anonymise the reference list — self-citations keep real authorship; anonymity is enforced via third-person narration.
- Prefer BibTeX. If the source uses `biblatex`, migrate to BibTeX + ACL's natbib style. `copyAsset` the `.bib` file(s) into the target and update the `\bibliography{...}` argument accordingly.
- `.bib` entries should include DOI or URL fields when possible — `acl.sty` renders the paper title as a hyperlink when one is present.
- Bib entries must avoid raw Unicode (BibTeX does not handle it reliably); use the `\"a`, `\^e`, `\'u`, … forms for accents.

---

## 8. Figures & tables (two-column layout)

- *ACL uses **two-column** layout (inherited from `acl.sty`).
- Keep `figure` for single-column graphics and `figure*` for full-width art (`width=\linewidth` inside `figure*` spans both columns). **Do not** flatten `figure*` / `table*` to single-column.
- Inside a single-column `figure`, use `width=\columnwidth` (or equivalently `\linewidth`) — this is what the template does in its `figure[t]` example.
- Caption below figures, above tables. **Do not override default caption sizes** (the ACL author guide is explicit).
- Reference figures and tables with `\ref{...}` — the template does not require `\cref`. If the source uses `cleveref`, feel free to keep it but configure the labels consistently.
- When migrating from a single-column source (`article`, `neurips`, `llncs`, `revtex` single), call `measureFigures({sourceClass:<src>, sourceTwocolumn:false, targetClass:"acmart", figures:[...]})` as an approximation for two-column width advice — the ACL column width (~240 pt) is close to `acmart` sigconf — and apply the recommended ratios via `applyDiff`. (`acl` is not a first-class entry in the layout DB, so treat the tool output as guidance, not ground truth.)

Tool usage:

- `copyAsset(srcPath, destPath)` every image referenced by `\includegraphics` and every `.bib` the source needs.
- After copying, `listProjectTree({project:"target"})` and `grepFile({project:"target", pattern:"\\\\includegraphics"})` to confirm paths resolve from the target root.

---

## 9. Math, typography, hyperlinks

- Use LaTeX/AMS math environments (`equation`, `align`, `gather`). Never use `$$ … $$` — interacts badly with `lineno` in review mode.
- Do not override body font sizes or section heading styles; `acl.sty` controls them.
- `hyperref` is not loaded by the template by default — add it late in the preamble if needed, after all other packages. The *ACL template warns about `\pdfendlink`/`\pdfstartlink` nesting errors with older TeX Live versions; ensure the build environment is modern (TeX Live 2018-12-01 or newer).
- Footnotes use `\footnote{...}`; keep them rare.
- For Bib\TeX accents and special characters, follow the accent-command table in the reference shell (e.g. `\"a`, `\^e`, `\'u`, `\aa`).

---

## 10. Critical DON'Ts (desk-rejection / format-check risks)

- Do **not** modify `acl.sty` or `acl_natbib.bst`.
- Do **not** add `\usepackage{geometry}`, or change `\textwidth`, `\columnsep`, `\oddsidemargin`, `\topmargin`.
- Do **not** set `\setlength\titlebox{<dim>}` below 5 cm.
- Do **not** convert `figure*` / `table*` to single-column wholesale; keep wide art wide.
- Do **not** leave author names, affiliations, identifying URLs, or acknowledgement content visible in `review` mode.
- Do **not** place appendices before References.
- Do **not** drop the Limitations section when the target venue requires it.
- Do **not** use `$$ … $$` for display math.
- Do **not** override default caption sizes.

---

## 11. Migration playbook (agent actions)

1. **Reconnaissance**
   - `listProjectTree({project:"source"})` + `listProjectTree({project:"target"})`.
   - `readFile({project:"target", path:"acl_latex.tex"})` to read the *ACL shell as-is.
   - `grepFile({project:"source", pattern:"\\\\documentclass|\\\\usepackage|\\\\author|\\\\title|\\\\bibliography(style)?|biblatex|figure\\*|table\\*|\\$\\$", glob:"*.tex"})`.
2. **Engine decision**
   - Default to `pdflatex` + `acl_latex.tex`.
   - If the source requires non-Latin scripts (Chinese, Arabic, Devanagari, etc.), migrate to `acl_lualatex.tex` or `acl_xelatex`-style preamble. Decide up front; mixing engines mid-migration is error-prone.
3. **Preamble transplant**
   - Replace the source `\documentclass{...}` with `\documentclass[11pt]{article}` via `applyDiff`.
   - Swap the style package to `\usepackage[review]{acl}` / `\usepackage{acl}` / `\usepackage[preprint]{acl}` based on intake.
   - Remove any source `\usepackage{geometry}`, `\setlength{\textwidth}{...}`, `\oddsidemargin`, column overrides.
   - Keep/add `\usepackage{times}`, `\usepackage{microtype}`, `\usepackage{graphicx}`, `\usepackage{inconsolata}` to match the template's defaults.
4. **Body**
   - Copy section content verbatim. Preserve `figure*` / `table*`.
   - Ensure the tail order is: body → `\section*{Limitations}` → `\section*{Acknowledgments}` → `\bibliography{...}` → `\appendix`.
5. **Citations & bibliography**
   - If source is `biblatex`: switch to `\bibliography{<bibname>}`, replace `\autocite` / `\parencite` / `\textcite` with `\citep` / `\citet`, remove `\addbibresource{...}`.
   - `grepFile({project:"target", pattern:"\\\\cite(alp|p|t|poss|yearpar)?\\{", glob:"*.tex"})` to audit coverage.
   - `copyAsset` every `.bib` needed (and `anthology.bib` if the source merges it).
6. **Figures**
   - `copyAsset` every image. Use `measureFigures` as guidance (see §8) and apply widths via `applyDiff`.
7. **Anonymisation sweep** (review mode)
   - `grepFile` for names, affiliations, emails, grant IDs, public URLs, GitHub handles, dataset slugs. Redact via `applyDiff` or `writeFile`.
   - Clear hyperref metadata if present.
   - Verify the acknowledgements live in `\section*{Acknowledg(e)?ments}` so `acl.sty` can suppress them.
8. **Limitations / Ethics**
   - Ensure `\section*{Limitations}` is present. If the source lacks one, insert a placeholder (`raiseQuestion` only if the intake explicitly leaves this ambiguous).
   - Preserve any `\section*{Ethics Statement}` the source carries.
9. **Verification**
   - `grepFile(pattern:"\\$\\$")` → zero hits.
   - `grepFile(pattern:"\\\\usepackage\\{geometry\\}|\\\\setlength\\\\textwidth|\\\\setlength\\\\columnsep")` → zero hits.
   - `grepFile(pattern:"\\\\appendix")` appears after `\\bibliography{...}`, not before.
   - `grepFile(pattern:"\\\\section\\*\\{Limitations\\}")` → exactly one hit (when required).
   - `grepFile(pattern:"\\\\bibliography\\{")` → exactly one hit; argument matches a `.bib` file that exists in the target.

Prefer `applyDiff` for small surgical changes (style swap, `\documentclass` change, inserting Limitations). Use `writeFile` only for wholesale rewrites, e.g. when moving from a single-column `revtex` paper with a fundamentally different tail layout.

Use `raiseQuestion` sparingly: only when the choice changes the output and cannot be derived from `transferIntake` / file contents (e.g. which *ACL venue the submission targets when the intake says only “acl”, whether to keep a `figure*` span, whether to keep or remove an Ethics Statement inherited from another venue).

---

## 12. Pre-submission checklist

- [ ] `\documentclass[11pt]{article}` and the correct `acl` option (`[review]` / none / `[preprint]`) per intake.
- [ ] `acl.sty`, `acl_natbib.bst` unmodified.
- [ ] No `\usepackage{geometry}`, no manual `\textwidth` / `\columnsep` / margins; `\setlength\titlebox{...}` (if used) is ≥ 5 cm.
- [ ] Two-column layout preserved; `figure*` / `table*` kept for full-width art; default caption sizes intact.
- [ ] Tail order: body → Limitations (unnumbered) → Acknowledgments (unnumbered) → References → `\appendix` → appendix sections.
- [ ] Citations use `\citep` / `\citet` / `\citealp` / `\citeyearpar`; `\bibliography{...}` points to an existing `.bib`; DOIs / URLs populated where possible.
- [ ] No `$$ … $$` in the body.
- [ ] Double-blind sweep (review): no names, affiliations, identifying URLs, GitHub handles, acknowledgements in body; `hyperref` metadata clean; line numbers untouched in source.
- [ ] Limitations section present (when required by the venue).
- [ ] Engine matches the target shell (`pdflatex` ↔ `acl_latex.tex`; `lualatex`/`xelatex` ↔ `acl_lualatex.tex`).
- [ ] `pdflatex` (or chosen engine) compiles cleanly (at least two passes).

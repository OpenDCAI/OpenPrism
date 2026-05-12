# ICML 2026 — Venue Handbook (OpenPrism)

Authoritative rules for `venueId = icml`. Loaded verbatim by
`loadVenueRules('icml')` and injected as `ICML_FULL_HANDBOOK` into the
skill system prompt. Ground all decisions in this file plus the actual
template under `templates/icml/`.

---

## 1. Template layout on disk

| File | Purpose |
|------|---------|
| `templates/icml/example_paper.tex` | Paper shell and `pdflatex` entry. |
| `templates/icml/icml2026.sty` | Official two-column style. `textwidth=487.8225pt` is enforced; the sty warns if it is altered. **Never modify.** |
| `templates/icml/icml2026.bst` | Official bibliography style (APA author-year). |
| `templates/icml/references.bib` | Sample bibliography. |
| `templates/icml/algorithm.sty`, `algorithmic.sty`, `fancyhdr.sty` | Bundled dependencies; copy as-is if the target project needs them. |

Tool usage:

- `listProjectTree({project:"target"})` to confirm the five style/bst files are present.
- `readFile({project:"target", path:"main.tex"})` before any edit.

---

## 2. Submission modes (`\usepackage` options)

`icml2026.sty` defines the following options:

| Intake flags | Required preamble |
|---|---|
| `doubleBlind=true` (default anonymous submission) | `\usepackage{icml2026}` |
| `preprint=true` (non-anonymous, page numbers) | `\usepackage[preprint]{icml2026}` |
| Camera-ready (accepted paper) | `\usepackage[accepted]{icml2026}` |
| Package clash with `hyperref` | append `,nohyperref` |

Facts:

- Anonymous mode shows `Anonymous Authors` regardless of the `\icmlauthor` metadata and hides acknowledgements.
- The style auto-loads `natbib` and `newtx`/`times`, plus line numbers in review mode. Do not add them again.

---

## 3. Document class & preamble

Required structure (matches `templates/icml/example_paper.tex`):

```latex
\documentclass{article}
\usepackage{icml2026}

\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{url}
\usepackage{booktabs}
\usepackage{amsfonts}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{microtype}
\usepackage{graphicx}
\usepackage{xcolor}
\usepackage{algorithm}
\usepackage{algorithmic}
\usepackage{hyperref}

\icmltitlerunning{<short title for running header>}
```

Hard rules:

1. `\documentclass` **must be `article`**. Reject `revtex*`, `IEEEtran`, `acmart`, `llncs`, etc.
2. Never load `geometry`, never set `\textwidth`, `\columnsep`, `\oddsidemargin` by hand. The sty enforces `\textwidth=487.8225pt` and flushbottom+twocolumn layout; any alteration triggers a warning and may be grounds for desk rejection.
3. Never modify `icml2026.sty` (or its bundled `algorithm.sty`, `algorithmic.sty`, `fancyhdr.sty`).

---

## 4. Title, authors, anonymity

Use the ICML macros, not `\author{}`:

```latex
\twocolumn[
  \icmltitle{Paper Title}
  \icmlsetsymbol{equal}{*}
  \begin{icmlauthorlist}
    \icmlauthor{First Author}{inst1}
    \icmlauthor{Second Author}{inst2}
  \end{icmlauthorlist}
  \icmlaffiliation{inst1}{Department, University, City, Country}
  \icmlaffiliation{inst2}{Department, University, City, Country}
  \icmlcorrespondingauthor{First Author}{email@domain}
  \icmlkeywords{Machine Learning, ICML}
  \vskip 0.3in
]
\printAffiliationsAndNotice{}
```

- Always call `\printAffiliationsAndNotice{}` somewhere in the body, otherwise the style emits an end-of-document warning.
- Double-blind hygiene: remove author names, affiliations, identifying URLs, GitHub handles, dataset slugs, grant numbers. Self-cite in the third person (“Jones et al. [4] …”). Keep `\icmlauthor` / `\icmlaffiliation` populated in source — they are hidden by the style in anonymous mode and surface when `[accepted]` is set.

---

## 5. Document structure & page budget

Required ordering (does **not** all count toward the page limit):

1. Title, `\icmlauthorlist`, `\icmlaffiliation`, `\icmlcorrespondingauthor`, `\icmlkeywords`.
2. `\begin{abstract} … \end{abstract}` — single paragraph, 4–6 sentences.
3. Main body sections. **Max 8 pages.** Camera-ready gets one extra page (9 total).
4. `\section{Impact Statement}` — mandatory, unnumbered effectively, placed before References. If the paper does not discuss impacts, state so in a sentence; do not omit the section.
5. `\section*{Acknowledgements}` — hidden in anonymous mode; visible with `[accepted]`.
6. `\bibliographystyle{icml2026}` then `\bibliography{<bibname>}` (no `natbib` style swap).
7. Appendix (optional) via `\appendix`. Submitted in the **same PDF**, never a separate file. `\onecolumn` after `\appendix` is allowed if the appendix would otherwise be cramped.

What does **not** count toward the 8-page limit: Impact Statement, Acknowledgements, References, Appendix.

---

## 6. Citations & bibliography

- Citation style is **APA author-year**, NOT numeric.
- `icml2026.sty` auto-loads `natbib`. Use:
  - `\citet{key}` for narrative: `Jones et al. (2022) showed …`.
  - `\citep{key}` for parenthetical: `… (Jones et al., 2022)`.
  - `\citeauthor`, `\citeyear`, `\citealp` for variants.
- `\bibliographystyle{icml2026}` + `\bibliography{<bibname>}` — do **not** swap to `plainnat`, `unsrtnat`, `IEEEtran`, etc.
- If the source uses `biblatex`, migrate to BibTeX + `icml2026.bst`. Copy `.bib` files with `copyAsset`.
- Do not anonymise the reference list. Self-citations stay under their real authorship; the anonymisation requirement is satisfied by third-person narration in the body.
- Alphabetise the `.bib` by first-author surname for APA-like output.

---

## 7. Figures & tables (two-column layout)

- ICML is **two-column**. `\textwidth ≈ 487.8 pt` (column width ≈ 233 pt).
- Keep `figure` for single-column art and `figure*` for full-width art that must span both columns. **Do not** convert `figure*`/`table*` to single-column; they are needed for wide panels/tables.
- Caption below figures, above tables; captions are 9 pt (set by the style).
- Two-column floats (`figure*`, `table*`) may only be placed at the top or bottom of a page.
- Do not put titles inside the figure graphics — rely on captions.
- Use `\includegraphics[width=\linewidth]{...}` inside a one-column `figure`; in `figure*`, `\linewidth = \textwidth` so the same command spans both columns.
- Call `measureFigures({sourceClass:<src>, sourceTwocolumn:<bool>, targetClass:"icml", figures:[...]})` after migrating from another venue — the tool returns a recommended width ratio based on ICML's geometry.

Tool usage:

- `copyAsset(srcPath, destPath)` for every `\includegraphics` target (`.pdf/.png/.jpg`) and every `.bib` / `.bst` file the source relied on.

---

## 8. Math, algorithms, typography

- Use LaTeX/AMS math environments (`equation`, `align`, `gather`, …). Never use `$$ … $$` — it breaks `lineno` in review mode.
- Pseudocode: `algorithm` + `algorithmic` (already loaded by the sample preamble). Keep algorithms inside floats (`\begin{algorithm}[tb]`).
- 10 pt Times (newtx) body is enforced by the sty. Do not override fonts.
- Headings: `\section` 11 pt bold, content words capitalised; `\subsection` 10 pt bold; `\subsubsection` 10 pt small caps. Do not go deeper than three levels.
- Footnotes are 9 pt at column bottom — keep them rare.

---

## 9. Critical DON'Ts (any of these is a desk-rejection risk)

- Do **not** include author info in the anonymous submission (names, affiliations, emails, identifying URLs, GitHub profiles, acknowledgements, grant IDs).
- Do **not** modify `icml2026.sty`, `icml2026.bst`, `algorithm.sty`, `algorithmic.sty`, or `fancyhdr.sty`.
- Do **not** add `\usepackage{geometry}` or hand-set text width / margins — the sty refuses.
- Do **not** use Type-3 fonts. `pdflatex` with the provided sty is correct.
- Do **not** use `$$ … $$` for display math.
- Do **not** split the appendix into a separate PDF; append it with `\appendix` in the same file.
- Do **not** drop the Impact Statement.

---

## 10. Migration playbook (agent actions)

1. **Reconnaissance**
   - `listProjectTree({project:"source"})` + `listProjectTree({project:"target"})`.
   - `readFile({project:"target", path:"main.tex"})` to read the ICML shell as-is.
   - `grepFile({project:"source", pattern:"\\\\documentclass|\\\\usepackage|\\\\title|\\\\author|\\\\bibliographystyle|biblatex|figure\\*|table\\*|\\$\\$", glob:"*.tex"})` to spot trouble areas at once.
2. **Preamble / title block**
   - Replace source `\documentclass{...}` with `\documentclass{article}` + `\usepackage{icml2026}` via `applyDiff`.
   - Convert `\author{...}` (and any `\affiliation{...}`, `\email{...}`) into `\icmlauthorlist` / `\icmlaffiliation` / `\icmlcorrespondingauthor`. For anonymous submissions, keep the real data inside these macros — the style hides them.
3. **Body**
   - Copy content verbatim. **Preserve `figure*` / `table*`.** Remove custom `\geometry{...}`, `\oddsidemargin`, column overrides.
   - Ensure `\printAffiliationsAndNotice{}` is called after the title block (the shell already does this).
4. **Impact Statement**
   - Add or keep `\section{Impact Statement}` before References. If the source has no equivalent, insert a short placeholder the user can expand. Consider `raiseQuestion` only if intake notes are ambiguous about societal impact posture.
5. **Citations & bibliography**
   - If the source uses `biblatex`, switch to `\bibliographystyle{icml2026}` + `\bibliography{...}`. Replace every `\autocite`, `\parencite`, `\textcite` with the natbib equivalents.
   - Enforce author-year via `\citep`/`\citet`. `grepFile(pattern:"\\\\cite(alp|p|t|author|year)?\\{")` to audit.
6. **Assets**
   - `copyAsset` every image and every `.bib` referenced by the source. After copying, rerun `listProjectTree({project:"target"})`.
7. **Figures**
   - Call `measureFigures` with `targetClass:"icml"` and the source class. Update widths via `applyDiff`.
8. **Double-blind sweep**
   - `grepFile` for real names, affiliations, emails, public URLs, GitHub handles. Redact anything that survives in body text, captions, comments, or hyperref metadata.
9. **Verification**
   - `grepFile(pattern:"\\$\\$")` → zero hits expected.
   - `grepFile(pattern:"\\\\usepackage\\{geometry\\}|\\\\setlength\\\\textwidth|\\\\setlength\\\\columnsep")` → zero hits.
   - `grepFile(pattern:"\\\\section\\*?\\{Impact Statement\\}")` → exactly one hit.
   - `grepFile(pattern:"\\\\bibliographystyle\\{icml2026\\}")` → one hit.

Use `raiseQuestion` only when a choice materially changes output and cannot be inferred from `transferIntake` / file contents (e.g., whether to keep a figure as `figure*` because the user resized it).

---

## 11. Pre-submission checklist

- [ ] `\documentclass{article}` and `\usepackage{icml2026}` (anonymous) or `\usepackage[accepted]{icml2026}` (camera-ready) or `\usepackage[preprint]{icml2026}`.
- [ ] Two-column layout preserved; `figure*` / `table*` used for full-width art.
- [ ] `\icmlauthorlist` / `\icmlaffiliation` / `\icmlcorrespondingauthor` populated; `\printAffiliationsAndNotice{}` present.
- [ ] Abstract is a single paragraph, 4–6 sentences.
- [ ] Main body ≤ 8 pages (camera-ready may use 9).
- [ ] `\section{Impact Statement}` present before References.
- [ ] `\bibliographystyle{icml2026}` + `\bibliography{<name>}`; citations are author-year (`\citet` / `\citep`).
- [ ] No `$$ … $$`, no `\usepackage{geometry}`, no `\textwidth` overrides.
- [ ] Double-blind sweep done: no identifying data, no acknowledgements in anonymous mode, no identifying URLs.
- [ ] Appendix (if any) in the same PDF via `\appendix`.
- [ ] `pdflatex` compiles cleanly (at least two passes); no Type-3 fonts.

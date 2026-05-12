# CVPR 2026 — Venue Handbook (OpenPrism)

Authoritative rules for `venueId = cvpr`. Loaded verbatim by
`loadVenueRules('cvpr')` and injected as `CVPR_FULL_HANDBOOK` into the
skill system prompt. Ground every decision in this file plus the actual
CVPR template under `templates/cvpr/`.

---

## 1. Template layout on disk

| Path | Purpose |
|------|---------|
| `templates/cvpr/main.tex` | Paper shell; `pdflatex` entry point. |
| `templates/cvpr/cvpr.sty` | Official style (two-column, letterpaper, `\textwidth=6.875in`, `\textheight=8.875in`). Offers `review`, `pagenumbers` options. **Never modify.** |
| `templates/cvpr/preamble.tex` | Optional tweaks (TODO macros, `microtype`, spacing). Loaded via `\input{preamble}`. |
| `templates/cvpr/ieeenat_fullname.bst` | CVPR bibliography style (numeric, full author names). |
| `templates/cvpr/main.bib` | Sample bibliography. |
| `templates/cvpr/rebuttal.tex` | Rebuttal template — only relevant after reviewer feedback. |
| `templates/cvpr/sec/0_abstract.tex` etc. | Section files already split by `\input{sec/...}`. |
| `templates/cvpr/sec/X_suppl.tex` | Supplementary material — **do not** include it in the main submission by default. |

Tool usage:

- `listProjectTree({project:"target"})` to confirm the `sec/` directory and `.sty/.bst` files exist.
- `readFile({project:"target", path:"main.tex"})` and, as needed, each `sec/*.tex`.

---

## 2. Submission modes (`\usepackage` options)

| Intake flags | Required preamble |
|---|---|
| `doubleBlind=true` (review submission) | `\usepackage[review]{cvpr}` |
| Camera-ready (accepted paper) | `\usepackage{cvpr}` |
| Preprint / arXiv (non-anonymous, numbered pages) | `\usepackage[pagenumbers]{cvpr}` |

Facts:

- `review` mode enables anonymisation + page numbers + the CVPR ruler/line numbers on the left margin.
- Camera-ready mode hides page numbers automatically.
- `pagenumbers` forces page numbers without enabling review annotations.

---

## 3. Document class & preamble

Required first line (matches `templates/cvpr/main.tex`):

```latex
\documentclass[10pt,twocolumn,letterpaper]{article}
```

Required package/preamble order:

```latex
\usepackage[review]{cvpr}        % or \usepackage{cvpr} for camera-ready
\input{preamble}                 % optional per-paper tweaks
\definecolor{cvprblue}{rgb}{0.21,0.49,0.74}
\usepackage[pagebackref,breaklinks,colorlinks,allcolors=cvprblue]{hyperref}

\def\paperID{*****}   % reviewer-supplied paper ID
\def\confName{CVPR}
\def\confYear{2026}
```

Hard rules:

1. `\documentclass` **must** be `\documentclass[10pt,twocolumn,letterpaper]{article}`. Reject `IEEEtran`, `revtex*`, `acmart`, `llncs`, etc.
2. Load `hyperref` **after** `cvpr.sty` (the template comment warns against disabling it). `pagebackref,breaklinks,colorlinks,allcolors=cvprblue` are the expected options for review/final.
3. **Never modify `cvpr.sty`** or `ieeenat_fullname.bst`. The sty enforces `\textwidth=6.875in` and `\textheight=8.875in`.
4. Never load `geometry` or set `\textwidth`, `\columnsep`, `\oddsidemargin`, `\topmargin` by hand.
5. Keep `\paperID`, `\confName`, `\confYear` present; `\paperID` must be populated with the reviewer-supplied ID before submission.

---

## 4. Title, authors, anonymity

- Review mode shows a generated anonymous author block; the real `\author{...}` is only rendered in camera-ready.
- In review mode, remove every identifying string: names, affiliations, acknowledgements, public URLs, GitHub handles, dataset slugs, grant numbers.
- Self-cite in the third person (“Smith et al. [12] …”), never “our prior work [12]”.
- Hyperref metadata: if the source sets `pdfauthor=` / `pdftitle=` / `pdfkeywords=`, strip or blank them for review.

---

## 5. Document structure (follows the template)

The shell already splits content into `sec/*.tex`:

```latex
\begin{document}
\maketitle
\input{sec/0_abstract}
\input{sec/1_intro}
\input{sec/2_formatting}
\input{sec/3_finalcopy}
{
  \small
  \bibliographystyle{ieeenat_fullname}
  \bibliography{main}
}
% \input{sec/X_suppl}   % ← DO NOT ship in the main submission
\end{document}
```

When migrating:

- Either keep this split and populate the section files from the source, or inline everything into `main.tex` — match whatever the source uses. Fewer files is fine if the source has ≤ 3 logical sections.
- **Never** include `sec/X_suppl.tex` or any other supplementary file inside the main submission unless the user explicitly asks. Supplementary PDF goes as a separate upload.

Content order rules:

1. `\maketitle`.
2. Abstract (`\begin{abstract} … \end{abstract}`), single paragraph.
3. Main body sections.
4. References (inside `{\small \bibliographystyle{ieeenat_fullname} \bibliography{main}}`).
5. Optional appendix / supplementary — again, do **not** inline in main for submission.

---

## 6. Page budget

- Main body: typically **8 pages excluding references**. Camera-ready usually extends by 1 page for references. Always check the current call for papers; if intake notes disagree with the template, call `raiseQuestion`.
- References do not count toward the main-body limit.
- Supplementary material is a **separate PDF**, not appended to the main submission.

---

## 7. Citations & bibliography

- Bibliography style is `ieeenat_fullname` (numeric `[1, 2, 3]` style with full author names). Use `\bibliographystyle{ieeenat_fullname}` + `\bibliography{main}` (or whatever `.bib` the source uses — rename the argument, not the style).
- Wrap the bibliography in `{\small … }` as in the template.
- Do not anonymise the reference list. Self-citations retain their real author names; anonymisation is satisfied by third-person narration in the body.
- If the source uses `biblatex`, migrate to BibTeX. `copyAsset` the `.bib` file(s) into the target, then replace `\printbibliography` + `\addbibresource{...}` with the CVPR pattern.

---

## 8. Figures & tables (two-column layout)

- CVPR is **two-column**. `\textwidth = 6.875in` ≈ 496 pt; each column ≈ 237 pt.
- Keep `figure` for single-column graphics and `figure*` for full-width art that must span both columns. **Do not** flatten `figure*`/`table*` to single-column.
- Caption below figures, above tables. Floats (especially `figure*`/`table*`) may only appear at the top or bottom of a page.
- Use `\includegraphics[width=\linewidth]{...}` inside a one-column `figure`; in `figure*`, `\linewidth = \textwidth` so the same command spans both columns.
- `\cref`-style references are encouraged (the template supports them via `cleveref` when loaded in `preamble.tex`).
- When migrating from a single-column source (`article`, `revtex` single, `neurips`, `llncs`): call `measureFigures({sourceClass:<src>, sourceTwocolumn:false, targetClass:"cvpr", figures:[...]})` and apply the recommended widths via `applyDiff`.

Tool usage:

- `copyAsset(srcPath, destPath)` every image file referenced by `\includegraphics` and every `.bib` that the source relied on.
- After copies, `listProjectTree({project:"target"})` and `grepFile({project:"target", pattern:"\\\\includegraphics"})` to confirm paths resolve.

---

## 9. Math, typography, hyperlinks

- Use LaTeX/AMS math environments (`equation`, `align`, `gather`). Never use `$$ … $$`.
- Do not redefine section fonts or spacing — the sty controls them.
- Keep `hyperref` enabled with the CVPR preset (`pagebackref,breaklinks,colorlinks,allcolors=cvprblue`). Disable only as a last resort when a genuine compile blocker appears. If you do disable it, delete the project's `*.aux` files before the next compile.
- Keep references in the bibliography and `\label`/`\ref` targets intact; migration must not break cross-references.

---

## 10. Critical DON'Ts (desk-rejection risks)

- Do **not** modify `cvpr.sty` or `ieeenat_fullname.bst`.
- Do **not** add `\usepackage{geometry}` or change `\textwidth`, `\columnsep`, `\oddsidemargin`, `\topmargin`.
- Do **not** drop two-column layout or convert `figure*`/`table*` to single-column wholesale.
- Do **not** include `sec/X_suppl.tex` (or any supplementary content) in the main review PDF by default.
- Do **not** leave `\paperID{*****}` in the final review submission — replace with the real ID (if intake notes provide one; otherwise `raiseQuestion`).
- Do **not** use `$$ … $$` for display math.
- Do **not** expose author names, affiliations, acknowledgements, or identifying URLs in review mode.

---

## 11. Migration playbook (agent actions)

1. **Reconnaissance**
   - `listProjectTree({project:"source"})` + `listProjectTree({project:"target"})`.
   - `readFile({project:"target", path:"main.tex"})`; `readFile({project:"target", path:"preamble.tex"})`.
   - `grepFile({project:"source", pattern:"\\\\documentclass|\\\\usepackage|\\\\bibliographystyle|biblatex|\\$\\$|\\\\author|\\\\affiliation", glob:"*.tex"})`.
2. **Preamble transplant**
   - Replace the source `\documentclass{...}` with `\documentclass[10pt,twocolumn,letterpaper]{article}` via `applyDiff`.
   - Swap the style package to `\usepackage[review]{cvpr}` (or `\usepackage{cvpr}` / `\usepackage[pagenumbers]{cvpr}` based on intake).
   - Keep the hyperref line as in the template. Remove any source `\usepackage{geometry}` / custom margin commands.
3. **Body**
   - Move section content into the matching `sec/*.tex` files or inline into `main.tex`, whichever matches the source shape.
   - Preserve `figure*` and `table*` — do not downgrade them.
4. **Citations & bibliography**
   - If source is `biblatex`: switch to `\bibliographystyle{ieeenat_fullname}` + `\bibliography{<name>}`. Replace `\autocite` / `\parencite` / `\textcite` with `\cite` / `\citep` / `\citet` as appropriate. Citations are numeric under CVPR, so `\cite{...}` prints as `[N]`.
   - Confirm the `.bib` file is present in target and that its name matches the `\bibliography{...}` argument.
5. **Figures**
   - `copyAsset` every image. Then `measureFigures` with `targetClass:"cvpr"` and apply recommended widths via `applyDiff`.
6. **Double-blind sweep** (review mode)
   - `grepFile` for names, affiliations, acknowledgements, grant numbers, GitHub URLs, dataset paths that expose identity.
   - Also clear hyperref metadata (`pdfauthor=`, `pdftitle=`, `pdfkeywords=`) or set `pdfauthor={}` — `\hypersetup{pdfauthor={}}` is safe to add.
7. **Paper ID**
   - Replace `\def\paperID{*****}` with the real ID if intake notes provide one. Otherwise leave the placeholder for the user and flag it via `raiseQuestion` **only if the intake notes are ambiguous**.
8. **Verification**
   - `grepFile(pattern:"\\$\\$")` → zero hits.
   - `grepFile(pattern:"\\\\usepackage\\{geometry\\}|\\\\setlength\\\\textwidth|\\\\setlength\\\\columnsep")` → zero hits.
   - `grepFile(pattern:"sec/X_suppl")` → must not be `\input`'d uncommented.
   - `grepFile(pattern:"\\\\bibliographystyle\\{ieeenat_fullname\\}")` → exactly one hit.

Prefer `applyDiff` for small surgical changes (style swap, `\documentclass` change, single `\bibliographystyle` update). Fall back to `writeFile` only for a full rewrite — e.g. converting from a single-column layout to CVPR's two-column shell.

Use `raiseQuestion` sparingly: only when intake notes cannot resolve a genuine fork (e.g. whether a figure should stay as `figure*` because the source had a custom two-column override, or when the user forgot to provide a paper ID).

---

## 12. Pre-submission checklist

- [ ] `\documentclass[10pt,twocolumn,letterpaper]{article}` present.
- [ ] Correct `cvpr` option: `[review]` / none / `[pagenumbers]` per intake.
- [ ] `cvpr.sty` and `ieeenat_fullname.bst` unmodified.
- [ ] `\paperID` populated (for review submissions).
- [ ] `hyperref` loaded with the CVPR preset (or deliberately disabled with `*.aux` cleaned).
- [ ] Two-column layout preserved; `figure*` / `table*` kept for full-width art.
- [ ] Captions: below figures, above tables; `\cref`/`\ref` targets intact.
- [ ] `{\small \bibliographystyle{ieeenat_fullname} \bibliography{<bib>}}` present; numeric citations.
- [ ] No `$$ … $$`; no `\usepackage{geometry}`; no manual `\textwidth`/`\columnsep`.
- [ ] Double-blind sweep done (review): names, affiliations, ack, URLs, GitHub handles, hyperref metadata all clean.
- [ ] `sec/X_suppl.tex` (or any supplementary) **not** `\input`'d in the main submission.
- [ ] `pdflatex` compiles cleanly (at least two passes) on US Letter.

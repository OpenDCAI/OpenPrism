# NeurIPS 2026 — Venue Handbook (OpenPrism)

This file is the authoritative handbook for any `venueId = neurips` transfer.
It is loaded verbatim by `loadVenueRules('neurips')` and injected as
`NEURIPS_FULL_HANDBOOK` into the venue-skill system prompt. Treat conflicts
with the live NeurIPS site as cues to ask the user (`raiseQuestion`) — do
**not** try to fetch external pages from within a transfer run.

> Line numbers ≠ preprint. The default anonymous submission *does* ship with
> line numbers (`lineno`). The `preprint` option *disables* them and reveals
> authors. See §2.

---

## 1. Template layout on disk

The reference NeurIPS workspace lives in `templates/neurips/` and contains
exactly four files. When migrating, copy/adapt these into the target project
and never edit the `.sty`.

| File | Purpose |
|------|---------|
| `main.tex` | Paper shell. `pdflatex` entry point. |
| `neurips_2026.sty` | Official style. Sets `letterpaper`, `textwidth=5.5in`, `textheight=9in`, `\normalsize = 10pt/11pt leading`. **Never modify.** |
| `checklist.tex` | NeurIPS Paper Checklist; `\input{checklist.tex}` at end of `main.tex`. Required for conference submissions — removing it causes **desk rejection**. |
| `references.bib` | Sample bibliography. |

Tool usage:

- Use `listProjectTree({project:"target"})` first to confirm the four files landed in the target workspace.
- Use `readFile({project:"target", path:"main.tex"})` (or with `startLine/endLine` for partial reads) before every edit.

---

## 2. Submission modes (`\usepackage` options)

NeurIPS 2026 uses **one** style package with several mutually exclusive options declared by `neurips_2026.sty`: `main` (default), `position`, `eandd` (with optional `nonanonymous`), `creativeai`, `sglblindworkshop`, `dblblindworkshop`, plus the modifiers `final`, `preprint`, `nonatbib`.

Pick the option from `transferIntake`:

| Intake flags | Required line in `main.tex` |
|---|---|
| `doubleBlind=true`, `preprint=false` (default conference submission) | `\usepackage[main]{neurips_2026}` (or `\usepackage{neurips_2026}`, equivalent) |
| `doubleBlind=false`, `preprint=true` (arXiv / non-anonymous) | `\usepackage[preprint]{neurips_2026}` |
| Camera-ready (accepted paper) | `\usepackage[main,final]{neurips_2026}` |
| Workshop track | `\usepackage[sglblindworkshop]{neurips_2026}` **and** `\workshoptitle{...}` |
| Package clash with natbib | append `,nonatbib`, e.g. `\usepackage[preprint,nonatbib]{neurips_2026}` |

Anonymous/main mode facts:

- Line numbers (`lineno`) are auto-loaded. Never quote them in the body — they disappear at acceptance.
- The author block renders as **Anonymous Author(s)** regardless of what is inside `\author{...}` (so keep the real author metadata in source for camera-ready).
- The `ack` environment is present in the source but **hidden** in the anonymous PDF; write the acknowledgements now, they will surface with `final`.
- First-page footer reads “Submitted to … NeurIPS …. Do not distribute.”

Preprint mode facts:

- No line numbers. Real authors visible.
- Footer reads “Preprint.”; `ack` renders normally.
- Never use `[final]` on an un-accepted paper. Do not declare the target conference in a preprint.

---

## 3. Document class & preamble

Required preamble header (matches `templates/neurips/main.tex`):

```latex
\PassOptionsToPackage{numbers,compress,sort}{natbib}
\documentclass{article}
\usepackage[main]{neurips_2026}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{url}
\usepackage{booktabs}
\usepackage{amsfonts}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{nicefrac}
\usepackage{microtype}
\usepackage{xcolor}
\usepackage{graphicx}
\usepackage[hidelinks]{hyperref}
\hypersetup{pdfauthor={}}   % anonymity
```

Hard rules:

1. `\documentclass` **must be `article`**. Reject `revtex*`, `amsart`, `IEEEtran`, `acmart`, `llncs`, etc.
2. `\PassOptionsToPackage{numbers,compress,sort}{natbib}` must appear **before** `\documentclass` whenever numeric `[1, 2, 4–7]` citations are wanted.
3. Load `hyperref` late in the preamble (after `amsmath`, `graphicx`). For anonymous submissions keep `\hypersetup{pdfauthor={}}` to avoid PDF metadata leaks.
4. Never load `geometry` with A4 or custom margins. Never edit geometry inside `neurips_2026.sty` (altering textwidth, textheight, font sizes → **desk rejection**).

---

## 4. Page budget

- Main text: **≤ 9 pages including figures**. Papers exceeding 9 pages are not reviewed.
- **Not counted** toward the 9-page limit: acknowledgements, references, NeurIPS Paper Checklist, optional technical appendix.
- Recommended tail order in `main.tex` (matches the template):
  `\clearpage → \begin{ack}...\end{ack} → \section*{References} → \newpage → \input{checklist.tex}`.
  Appendices, if any, go before `References` or after `checklist.tex` per the current submission-system instructions; they do not count toward 9 pages but the main body must stand alone.
- Use `\input{sections/...}` to split long papers; do **not** duplicate `\documentclass` or `\usepackage{neurips_2026}` inside sub-files.

---

## 5. Typography & layout (for sanity checks — do not re-implement)

`neurips_2026.sty` sets:

- `letterpaper`, `\textwidth = 5.5in` (33 pc), `\textheight = 9in` (54 pc), left margin 1.5 in.
- Body text 10 pt, leading 11 pt. Half-line paragraph spacing, no first-line indent.
- Title: ~17 pt bold, centered, initial caps + lower case, with top rule 4 pt and bottom rule 1 pt.
- Section heading sizes: `\section` 12 pt, `\subsection` 10 pt, `\subsubsection` 10 pt (all lower-case except sentence start & proper nouns, left-aligned, bold).
- `\paragraph`: bold, inline, 1 em space after the heading word.

The agent should never emit commands that override these (`\setlength{\textwidth}...`, `\geometry{...}`, custom `\renewcommand\normalsize`, etc.). Delete them when migrating.

---

## 6. Title, authors, anonymity

- Keep `\title{...}` and a real `\author{...}` in source. In `[main]` mode the PDF shows the anonymous placeholder; in `[preprint]` or `[main,final]` your metadata renders.
- Author separators: `\and` (LaTeX decides line break); `\And` (no hard break); `\AND` (force new author row).
- `\thanks{...}` is for extra author info (homepages, primary-contact notes), **not** funding/acknowledgements — those belong in `ack`.
- Double-blind text hygiene (§9.2): refer to your own prior work in the third person (“Jones et al. [4] showed …”). Never write “our previous work [4]”. Do not expose identifying URLs, dataset slugs, institution references, or self-revealing GitHub handles.

---

## 7. Abstract

- Single paragraph only.
- Heading `Abstract` is centered, bold, ≈ 12 pt (handled by the style).
- Left/right indent ≈ 0.5 in (3 pc). Body text 10 pt / 11 pt leading.
- Approx 2-line vertical gap before the abstract body.

---

## 8. Citations & bibliography

- `neurips_2026` auto-loads `natbib`. Pick one citation style — numeric **or** author-year — and stay consistent throughout.
- For numeric, compressed and sorted ranges (`[1, 3–6]`), the preamble must contain:
  `\PassOptionsToPackage{numbers,compress,sort}{natbib}` **before** `\documentclass`.
- For author-year, omit `numbers` and use `\citet{…}` for narrative, `\citep{…}` for parenthetical.
- If the source project uses `biblatex`, either:
  - Migrate to BibTeX + a natbib-compatible `.bst` (preferred), or
  - Use `\usepackage[nonatbib]{neurips_2026}` and bring back whatever the source used.
  In either case copy `.bib` files via `copyAsset`, not `writeFile`.
- Handwritten `thebibliography` items need the optional label for author-year, e.g.
  `\bibitem[Hasselmo et al.(1995)]{hasselmo}`.
- Place the bibliography after `ack` and before the checklist. Use `\section*{References}` and wrap the list in `{\small …}` (≈ 9 pt) to save space.

---

## 9. Figures & tables

- NeurIPS is **single column**. Convert every `figure*`/`table*` from the source to `figure`/`table`.
- Caption convention: label below figures, above tables. Use sentence case. Every caption must state one key take-away in addition to describing the panel.
- Recommended graphics call:
  `\includegraphics[width=\linewidth]{path}` or a fraction thereof (`0.8\linewidth`).
- **Never** use `\special` for positioning. Use `graphicx`.
- Use `measureFigures` with `targetClass:"neurips"` to pick a sane width when migrating from a two-column source (CVPR/ICML/acmart/IEEEtran/revtex). The tool returns a recommended `\linewidth` ratio based on textwidth deltas.
- `copyAsset(srcPath, destPath)` any image file (`.pdf/.png/.jpg/.eps`) that the source `\includegraphics` references — then verify the path resolves from the target root.

Float overflow (“all figures end up at the end”):

1. Prefer placement specifiers `[!htbp]`, not bare `[t]`.
2. Place the `figure` environment near the first `\ref{fig:…}` in the source, not in its own later block.
3. In the main file (never in the `.sty`), tune float fractions:
   ```latex
   \renewcommand{\topfraction}{0.9}
   \renewcommand{\bottomfraction}{0.8}
   \renewcommand{\textfraction}{0.1}
   ```
4. Use `\FloatBarrier` (from `placeins`) between sections to stop drift.
5. Reserve `[H]` (from `float`) for desperate cases only — it often leaves whitespace.

---

## 10. Math

- Line numbers interact badly with TeX `$$ … $$`. Always use `equation`, `align`, `gather`, `equation*`, etc.
- Even in preprint mode, keep LaTeX environments so behaviour is the same when you later switch to `[main]`.
- `amsmath` and `amsfonts` are part of the template preamble; use `\mathbb{…}` instead of `bbold`.

---

## 11. Fonts & PDF requirements

- `pdflatex` only. Two consecutive runs minimum so cross-references stabilise.
- PDF must contain Type 1 or embedded TrueType. No Type 3. Check with `pdffonts`.
- Stay on US Letter output.

---

## 12. Acknowledgements / funding disclosure

Use the `ack` environment defined by the style — **do not** hand-roll `\section*{Acknowledgments...}`.

```latex
\begin{ack}
  This work was supported by ...
\end{ack}
```

- Anonymous mode: hidden in PDF. Keep real content in source; it surfaces with `[main,final]`.
- Preprint: rendered. Still follow the NeurIPS Funding Disclosure rules.

---

## 13. NeurIPS Paper Checklist (conference submissions only)

Located in `templates/neurips/checklist.tex`.

- The checklist is **mandatory** for any conference submission. Removing it causes desk rejection.
- Must appear after `References` (and after the appendix if present). The template already ends with `\newpage\input{checklist.tex}`.
- The checklist does **not** count toward the 9-page limit.

Editing discipline (enforced by the reviewers):

- **Delete** the `%%% BEGIN INSTRUCTIONS %%%` … `%%% END INSTRUCTIONS %%%` block entirely.
- **Keep** the `\section*{NeurIPS Paper Checklist}` heading, every subsection heading, and every question verbatim.
- Answers may only use `\answerYes{}`, `\answerNo{}`, `\answerNA{}`. Replace every `\answerTODO{}` and `\justificationTODO{}` before submission.
- Provide a 1–2 sentence justification after every answer (even for `\answerNA`).
- Answering `No` or `N/A` with a valid justification is acceptable. Reviewers do not reject solely on answer value.
- Typical question→paper mapping the reviewer will spot-check:

| Question topic | Expected location in the paper |
|---|---|
| Claims | Abstract + end of Introduction |
| Limitations | A dedicated `\section*{Limitations}` or a paragraph in the discussion |
| Theory assumptions & proofs | Main text statements; full proofs in appendix if needed |
| Reproducibility | Experimental setup / Methods |
| Open data & code | Methods + appendix pointer to supplementary |
| Experimental details | Methods + appendix tables (hyperparameters, seeds) |
| Statistical significance | Results (error bars / CIs / repeats) |
| Compute resources | Methods or a short dedicated paragraph |
| Ethics, broader impacts, safeguards | Discussion or a dedicated section |
| Licenses / new assets | Methods or appendix |
| Human subjects / IRB | Only if applicable |
| LLM usage declaration | Methods or acknowledgements |

Each `\answerYes{}` justification should cite the section or appendix it refers to (“see §4.2” / “see Appendix B”).

---

## 14. Appendices & supplementary material

- Appendices are allowed, unlimited in length, and are part of the same PDF. Do **not** submit a separate appendix PDF.
- Additional videos/code/data go into the supplementary ZIP.
- Reviewers may skip appendices — keep the main text self-contained. Do not hide the key experiment supporting a main claim in the appendix only.

---

## 15. Migration playbook (agent actions)

When migrating a source project into the NeurIPS workspace, prefer this order. Each step maps directly to the tools available in the skill prompt.

1. **Reconnaissance**
   - `listProjectTree({project:"source"})` and `listProjectTree({project:"target"})`.
   - `readFile({project:"target", path:"main.tex"})` — current NeurIPS shell (never modify the `.sty`).
   - `readFile({project:"source", path:"<source main file>"})` — full file. If very long, use `startLine/endLine` or `grepFile` for hotspots (`\\documentclass`, `\\usepackage`, `\\title`, `\\author`, `\\begin{abstract}`, `figure\\*?`, `\\bibliography`, `\\bibliographystyle`, `biblatex`, `hyperref`).
2. **Preamble transplant**
   - Use `applyDiff` when replacing `\\documentclass`, swapping the `neurips_2026` option, or inserting the numbered-citation `\PassOptionsToPackage` line. Prefer a single minimal hunk per logical change.
   - Use `writeFile` only when the source preamble and body have to be rewritten wholesale (e.g., moving away from a revtex two-column layout).
3. **Body ingestion**
   - Copy section content verbatim into `main.tex`, converting `figure*`/`table*` → `figure`/`table`.
   - If the source uses `\input{sections/...}`, either copy those files with `copyAsset` and keep the `\input`, or inline them — decide based on file count (> 3 sub-files → keep split; ≤ 3 → inline).
4. **Assets**
   - For every image and bibliography file referenced by the source, call `copyAsset(src, dest)`. Never dump binary content through `writeFile`.
   - After copies, `listProjectTree({project:"target"})` to confirm.
5. **Bibliography**
   - Preserve or rebuild. Enforce consistency (numeric vs author-year) across the whole paper. Run `grepFile({project:"target", pattern:"\\\\cite[tp]?\\{", glob:"*.tex"})` to audit.
6. **Figures**
   - After paths are fixed, call `measureFigures({sourceClass:<src>, sourceTwocolumn:<bool>, targetClass:"neurips", figures:[...]})` and apply the recommended widths with `applyDiff`.
7. **Double-blind sweep**
   - `grepFile` for author names, affiliations, grant numbers, public URLs (`github.com/`, `https?://.+`). Redact as needed with `applyDiff`.
   - Also check `\hypersetup{pdfauthor=...}` and anything the source may have set in `pdftitle`, `pdfkeywords`, etc.
8. **Checklist**
   - `readFile({project:"target", path:"checklist.tex"})` to confirm the template version is present.
   - Remove the instruction block, convert every `\answerTODO` into a real answer, and write 1–2 sentence justifications. Cross-link to `\ref{sec:…}` / `\ref{app:…}`.
9. **Verification**
   - `grepFile({project:"target", pattern:"\\\\bibliographystyle|\\\\bibliography|biblatex"})`, `grepFile(pattern:"\\$\\$")`, `grepFile(pattern:"figure\\*|table\\*")` — no hits expected at the end of a clean migration.
   - If anything is ambiguous (e.g., workshop vs main track, whether to preserve a tabular float as full-width) call `raiseQuestion` **once** with the minimal number of options.

`raiseQuestion` is expensive (it pauses the graph). Do not raise questions for information you can recover by reading files or by consulting `transferIntake` (`venue`, `doubleBlind`, `preprint`, `outputNotes`).

---

## 16. Pre-submission checklist (run before `finalize`)

- [ ] `\documentclass{article}` and `\usepackage[...]{neurips_2026}` options match the intake.
- [ ] `\PassOptionsToPackage{numbers,compress,sort}{natbib}` above `\documentclass` if numeric citations are used.
- [ ] `neurips_2026.sty` is unmodified (compare against `templates/neurips/neurips_2026.sty`).
- [ ] Compiles with `pdflatex` twice without errors; US Letter output; fonts are Type 1 / embedded TrueType.
- [ ] Main body ≤ 9 pages including figures (excluding ack, references, checklist, appendix).
- [ ] All `figure*` / `table*` converted to single-column.
- [ ] No `$$ … $$` anywhere in body (`grepFile` the source and target).
- [ ] All `\cite{}`, `\ref{}`, `\label{}` still resolve; consistent citation style across the paper.
- [ ] Double-blind: no identifying names, affiliations, URLs, grant numbers, GitHub handles; `\hypersetup{pdfauthor={}}` present.
- [ ] `ack` content written in source (even if hidden).
- [ ] `\input{checklist.tex}` present; instruction block removed; no `\answerTODO` / `\justificationTODO` remains; every answer has a justification; justifications cite back to section/appendix.
- [ ] Appendix (if any) is inside the same PDF; no separate appendix PDF.
- [ ] For preprint: `[preprint]` option; no mention of the target conference in the body; `[final]` is not used.

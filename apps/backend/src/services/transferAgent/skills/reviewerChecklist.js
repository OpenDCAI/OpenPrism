/**
 * Reviewer skills — venue-specific review checklists.
 *
 * Each venue exports a function that returns the review checklist string
 * to be injected into the reviewer's user message.
 *
 * The reviewer prompt skeleton is venue-agnostic; all venue-specific
 * constraints live here for progressive disclosure and extensibility.
 */

// ─────────────────────────────────────────────
//  NeurIPS
// ─────────────────────────────────────────────

function neuripsReviewChecklist({ intake }) {
  const isBlind = intake.doubleBlind !== false && !intake.preprint;
  return {
    structure: `- \\usepackage[main]{neurips_2026} (anonymous + line numbers) or \\usepackage[preprint]{neurips_2026}
   - \\PassOptionsToPackage{numbers,compress,sort}{natbib} BEFORE \\documentclass
   - No \\usepackage{geometry} (neurips_2026 handles layout)`,

    figures: `- No figure* or table* environments (NeurIPS is single-column)
   - \\includegraphics paths point to files that exist
   - Reasonable \\includegraphics widths (\\linewidth or fraction)`,

    bibliography: `- \\bibliographystyle is NeurIPS-compatible (unsrtnat, plainnat, abbrvnat)
   - Numeric citations [1,2,3] (NOT author-year)
   - .bib or .bbl files present in target project`,

    policy: `6. NEURIPS POLICY:
   - \\input{checklist.tex} or \\include{checklist.tex} present
   - No \\answerTODO remaining (checklist should be filled or template default)
   - $$ ... $$ display math → equation/align (lineno compatibility)`,

    blind: isBlind
      ? `BLIND COMPLIANCE:
   - \\hypersetup{pdfauthor={}} or equivalent
   - No identifying URLs (GitHub repos, project pages) unless user confirmed
   - Self-citations in third-person form
   - Author block shows "Anonymous Author(s)"`
      : '(Single-blind or preprint — no anonymization needed)',
  };
}

// ─────────────────────────────────────────────
//  ICML
// ─────────────────────────────────────────────

function icmlReviewChecklist({ intake }) {
  const isBlind = intake.doubleBlind !== false;
  return {
    structure: `- \\usepackage{icml2026} (anonymous) or \\usepackage[accepted]{icml2026} (camera-ready)
   - Do NOT add \\PassOptionsToPackage{numbers}{natbib} (ICML uses author-year)
   - No \\usepackage{geometry} (icml2026.sty handles layout)
   - Use \\icmlauthor / \\icmlaffiliation for author info (NOT \\author{})`,

    figures: `- figure* for full-width figures, figure for single-column (ICML is two-column)
   - Do NOT convert figure* to figure
   - \\includegraphics paths point to files that exist
   - Reasonable \\includegraphics widths`,

    bibliography: `- \\bibliographystyle{icml2026} (APA author-year, NOT numeric)
   - natbib loaded by icml2026.sty automatically
   - .bib or .bbl files present in target project`,

    policy: `6. ICML POLICY:
   - Impact Statement section present (unnumbered, before References)
   - No checklist required (this is NOT NeurIPS — do NOT create checklist.tex)
   - Do NOT create or reference neurips_2026.sty
   - $$ ... $$ display math → equation/align (lineno compatibility)
   - Appendix (if any) goes AFTER references in same PDF
   - Main body max 8 pages (excluding references and appendices)`,

    blind: isBlind
      ? `BLIND COMPLIANCE:
   - \\hypersetup{pdfauthor={}} or equivalent
   - No identifying URLs unless user confirmed
   - Self-citations in third-person form
   - Author info hidden (only visible with [accepted] option)`
      : '(Camera-ready — author info should be visible)',
  };
}

// ─────────────────────────────────────────────
//  Fallback (generic)
// ─────────────────────────────────────────────

function genericReviewChecklist({ intake }) {
  return {
    structure: `- Correct \\documentclass and style package for the target venue
   - No conflicting geometry/font packages`,

    figures: `- Figure environments appropriate for the venue's column layout
   - \\includegraphics paths point to files that exist
   - Reasonable \\includegraphics widths`,

    bibliography: `- Bibliography mechanism consistent with venue requirements
   - .bib or .bbl files present in target project`,

    policy: `6. VENUE POLICY:
   - Follow venue-specific rules from your system prompt`,

    blind: intake.doubleBlind
      ? `BLIND COMPLIANCE:
   - No author-identifying information visible
   - Self-citations in third-person form`
      : '(No anonymization needed)',
  };
}

// ─────────────────────────────────────────────
//  Dispatcher
// ─────────────────────────────────────────────

const VENUE_CHECKLIST_BUILDERS = {
  neurips: neuripsReviewChecklist,
  icml: icmlReviewChecklist,
};

/**
 * Build the venue-specific review checklist sections.
 *
 * @param {string} venueId — e.g. 'neurips', 'icml'
 * @param {{ intake: object }} ctx — context with transferIntake
 * @returns {{ structure, figures, bibliography, policy, blind }}
 */
export function buildReviewChecklist(venueId, ctx) {
  const builder = VENUE_CHECKLIST_BUILDERS[venueId] || genericReviewChecklist;
  return builder(ctx);
}

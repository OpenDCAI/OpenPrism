# Completed features and their release

## v0.0.1 - Templates

- [x] #8 **Built-in ACL and arXiv templates (and uploaded templates) have no compilable main file.** ACL's manifest
      says `main.tex` but its files are `acl_latex.tex` / `acl_lualatex.tex`; arXiv is not in the manifest and its file
      is `template.tex`; template upload also hard-codes `main.tex`. Detect the main file; fix the manifest.
- [x] #9 **Template transfer: the layout check cannot finish from the UI.** The backend pauses at `waiting_images`;
      `TransferPanel` must render the compiled PDF's pages (pdf.js), call `transferSubmitImages`, and resume polling.
      The backend must also serve the PDF during the pause.

## v0.0.1.1 - QA tooling

- [x] #11 **API tests delete the built-in templates' files from the dev bucket.** `BuiltinTemplateTests` (from #8)
      imports the real templates and the shared cleanup clears their storage. Keep the real templates' files; add a guard.

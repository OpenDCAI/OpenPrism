# Completed features and their release

## v0.0.1 - Templates

- [x] #8 **Built-in ACL and arXiv templates (and uploaded templates) have no compilable main file.** ACL's manifest
      says `main.tex` but its files are `acl_latex.tex` / `acl_lualatex.tex`; arXiv is not in the manifest and its file
      is `template.tex`; template upload also hard-codes `main.tex`. Detect the main file; fix the manifest.

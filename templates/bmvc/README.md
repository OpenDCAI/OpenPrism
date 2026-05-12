# BMVC Paper Templates

This folder provides all the files necessary to produce both the review and final proceedings version of the paper.

Typesetting should preferably be done using the PDFLaTeX system (part of all modern LaTeX distributions).
However, submissions prepared in Microsoft Word or OpenOffice will be accepted – but are discouraged.

All LaTeX class and support files are supplied in this git repository.

Two example template LaTeX files are also provided:
- Review example PDF: `bmvc_review.pdf`
- Final Proceedings example PDF: `bmvc_final.pdf`

Within these files there are details about preparing your paper for double-blind review and the formatting of the paper.
PLEASE READ BOTH these files carefully.

They also illustrate how to produce both version of the paper from LaTeX.

Essentially to produce the review paper you must include the command:

`\bmvcreviewcopy{??}`

in the LaTeX preamble.

The `??` is the paper number your are assigned when registering your paper on the OpenReview submission web site:
[https://openreview.net/group?id=bmva.org/BMVC/2026/Conference](https://openreview.net/group?id=bmva.org/BMVC/2026/Conference)


A word template is also provided: `BMVC_MS_Office_2026_review.docx`

More details on paper submission is at: [https://bmvc2026.bmva.org/authors/submit-your-paper/](https://bmvc2026.bmva.org/authors/submit-your-paper/)

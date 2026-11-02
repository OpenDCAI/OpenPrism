# Doing Now

## v0.0.1 - Templates

- [ ] #9 **Template transfer: the layout check cannot finish from the UI.** The backend pauses at `waiting_images`;
      `TransferPanel` must render the compiled PDF's pages (pdf.js), call `transferSubmitImages`, and resume polling.
      The backend must also serve the PDF during the pause.

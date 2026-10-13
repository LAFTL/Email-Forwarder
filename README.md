# Email PDFs to Drive

1. Set `GOOGLE_DRIVE_FOLDER_ID` in `MainFunction.js` to your folder ID.
2. Check `START` and `QUERY`; the current start date is 4 September 2026, UTC+10.
3. Keep Advanced Gmail enabled and use the included Apps Script manifest.
4. Run `installForwarder` once. It checks unread Inbox mail every 30 minutes.

The Gmail query leaves subjects containing remittance, payment, or EFT alone.
It does not change those emails. This simple filter also skips payment requests
with those subject words; edit the query if you want a narrower selection.

Other emails save directly into the chosen Drive folder:

- `<message ID>_EMAIL_BODY.pdf`: readable headers and the original HTML body.
- `<message ID>_<number>_<filename>`: each attachment in its original format,
  including inline images. Attachments are not converted.

The message ID prevents collisions. Existing filenames are reused after partial
failures. Only after all files save does the source get `forwarded` and become
read. It stays in Inbox. Up to 50 emails are handled each run.

For an older `.eml` download, remove `forwarded` and mark its source email unread
before rerunning. Earlier downloads remain in their old location.

PDF rendering is done by Apps Script's HTML-to-PDF conversion. It is not a browser
print command; Gmail's interface, remotely hosted images, and inline image layout
may render differently. Inline image files are saved separately.

Local validation: `node --check MainFunction.js` and
`node --test test/forwarder.test.cjs`. Tests use mocks; live Gmail and PDF rendering
must be checked in Apps Script.

# Email PDFs to Drive

1. Set `GOOGLE_DRIVE_FOLDER_ID` in `MainFunction.js` to your folder ID.
2. Check `START` and `QUERY`; the current start date is 4 September 2026, UTC+10.
3. Keep Advanced Gmail enabled and use the included Apps Script manifest.
4. Run `installForwarder` once. It checks unread Inbox mail every 30 minutes.

Query - just update that to whatever list of emails that you don't want to forwarded;
START - Date should be updated once a month; I got some idea on how to dynamically change it but it is the most lazy approach.
You know what i mean by lazy if I said + or ++ WAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAHAHAHA

Other emails save directly into the chosen Drive folder:

- `<message ID>_EMAIL_BODY.pdf`: readable headers and the original HTML body.
- `<message ID>_<number>_<filename>`: each attachment in its original format,
  including inline images. Attachments are not converted.

The message ID prevents collisions but so does lock() - Existing filenames are reused after partial
failures - This is true but soon will be push out because it is bound to break if I forget to adjust it. Only after all files save does the source get `forwarded` and become
read. It stays in Inbox. Up to 50 emails are handled each run. :) or 500 like the last failure of code.T_T that's the reason production had 1700 uploads. that and that lyrebird is a lyre-er lol

For an older `.eml` (15/10 THIS IS ONLY TRUE WITH GOOGLE WORKSPACE - OUTLOOK HAS A NATIVE VIEWER) download, remove `forwarded` (14/10 meta-data for you blud) and mark its source email unread
before rerunning. Earlier downloads remain in their old location.

PDF rendering is done by Apps Script's HTML-to-PDF conversion. It is not a browser
print command (15/10 - this shit was so unreliable. GET BLOB CALL MIME THEN RENAME THE TITLE OFF+.blob(MIME)? WHO CODES THAT ); Gmail's interface, remotely hosted images (data residency can go frick itself - Joking. I am joking :( ), and inline image layout ( 15/10 - DevLATFL here. There's some issues with how inline images are actually meant to be skipped during the upload stage, but i am too stress from coding other things to fix this or solution magic it)
may render differently. Inline image files are saved separately. (13/10 - dis is true but breaks the point of avoiding inline images)

Local validation: `node --check MainFunction.js` and (15/10 - ~~i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this. i hate this.~~ the documentation is at best the most ass experience to read. 
`node --test test/forwarder.test.cjs`. Tests use mocks; live Gmail and PDF rendering
must be checked in Apps Script. (14/10 - Private "testing" push one email and test on one email. "Yep it works. Sleep time")

## Improvements for the future
1. START can be increment LET or DO or DEADLINE? Lwk took that off peachy+co
2. bundle to package into an tailor app, so FFM doesn't have to re-config rclone every time.
3. VCS via github is good. frick :)

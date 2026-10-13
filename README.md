# Email downloads

Save unread Inbox emails and their original attachments to Google Drive.
There is no forwarding or file conversion.

1. Paste `MainFunction.js` and `TriggerInstaller.js` into your standalone Apps
   Script project. Use the included `appsscript.json` and enable Advanced Gmail
   API v1. A standard Cloud project also needs the Gmail API enabled there.
2. Check `START` and `QUERY`. The current cutoff is 4 September 2026, midnight
   UTC+10. Change `DRIVE_FOLDER_NAME` if you want a different folder name.
3. Run `forwardFromSeptember4` to download a batch. Its existing name is retained
   so old triggers continue working. Run `installForwarder` once if you need
   the 30-minute schedule; it preserves unrelated triggers.

The script creates **Email downloads** in My Drive. Each email gets a subfolder
named with its Gmail message ID. `email.eml` contains the complete original email,
including headers, body, and embedded attachments. Open it with an email client.
Attachments are also saved separately in their original formats, including
inline images. Numbered filenames distinguish attachments with identical names.

After all files save, that individual Gmail message gets `forwarded` and becomes
read. It stays in Inbox. The label name is retained from the original workflow;
here it means saved to Drive. Existing `forwarded` messages remain excluded.
Remittance/EFT notices get `CheckPlease`, stay unread, and are not downloaded.
Detection uses subject, body notice phrases, and filenames; it does not inspect
attachment contents and unusual notices may need a filter adjustment.

Each run handles up to 50 messages. The next run picks up remaining unread mail.
A lock prevents overlapping runs. If a save or label change fails, the next run
reuses the same message folder and existing filenames, then saves missing files.
Keep downloaded files intact until the source has been marked complete.

## Local validation

```sh
node --check MainFunction.js
node --check TriggerInstaller.js
node --test test/forwarder.test.cjs
```

Tests use mock Gmail and Drive services. Live Google authorization and downloads
have not been executed during this code review.

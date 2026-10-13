const GOOGLE_DRIVE_FOLDER_ID = 'PASTE_FOLDER_ID_HERE'; // Folder ID, not the full URL.
const HANDLER = 'forwardFromSeptember4'; // Keep the existing trigger working.
const START = Math.floor(Date.parse('2026-09-04T00:00:00+10:00') / 1000) - 1;
// Gmail skips payment subjects and emails already marked forwarded.
const QUERY = `in:inbox is:unread after:${START} -in:sent -label:forwarded -subject:remittance -subject:payment -subject:eft`;

function forwardFromSeptember4() {
  if (GOOGLE_DRIVE_FOLDER_ID === 'PASTE_FOLDER_ID_HERE') throw new Error('Set GOOGLE_DRIVE_FOLDER_ID first.');
  // One run at a time. This prevents overlapping downloads.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const folder = DriveApp.getFolderById(GOOGLE_DRIVE_FOLDER_ID);
    const forwarded = labelId('forwarded');
    const messages = Gmail.Users.Messages.list('me', {q: QUERY, maxResults: 50}).messages || [];
    const deadline = Date.now() + 240000;

    for (const {id} of messages) {
      if (Date.now() >= deadline) break;
      try {
        const labels = Gmail.Users.Messages.get('me', id, {format: 'metadata'}).labelIds || [];
        if (!labels.includes('INBOX') || !labels.includes('UNREAD') || labels.includes(forwarded)) continue;
        const email = GmailApp.getMessageById(id);
        const pdfName = `${id}_EMAIL_BODY.pdf`;
        // Print the readable email body to PDF. Reuse it if an earlier run saved it.
        if (!folder.getFilesByName(pdfName).hasNext()) {
          const headers = [
            'Subject: ' + email.getSubject(),
            'From: ' + email.getFrom(),
            'To: ' + email.getTo(),
            'Date (UTC): ' + email.getDate().toISOString(),
          ].map(escapeHtml).join('<br>');
          const html = '<p>' + headers + '</p><hr>' + email.getBody();
          const pdf = Utilities.newBlob(html, MimeType.HTML).getAs(MimeType.PDF).setName(pdfName);
          folder.createFile(pdf);
        }
        // Save the attachments as they arrived. The message ID prevents name clashes.
        email.getAttachments({includeInlineImages: true, includeAttachments: true}).forEach((file, index) => {
          saveFile(folder, file.copyBlob().setName(`${id}_${index + 1}_${file.getName() || 'attachment'}`));
        });
        // Only mark forwarded and read after every file is saved.
        Gmail.Users.Messages.modify({addLabelIds: [forwarded], removeLabelIds: ['UNREAD']}, 'me', id);
      } catch (error) {
        console.error(`Message ${id}: ${error.message || error}`);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function labelId(name) {
  const label = (Gmail.Users.Labels.list('me').labels || []).find(item => item.name === name);
  return label ? label.id : Gmail.Users.Labels.create({name}, 'me').id;
}

function saveFile(folder, blob) {
  if (!folder.getFilesByName(blob.getName()).hasNext()) folder.createFile(blob);
}

function escapeHtml(text) {
  // Keep sender addresses and subject characters visible in the PDF header.
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

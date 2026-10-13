const HANDLER = 'forwardFromSeptember4'; // Keep the existing trigger working.
const START = Math.floor(Date.parse('2026-09-04T00:00:00+10:00') / 1000) - 1;
const QUERY = `in:inbox is:unread after:${START} -in:sent -in:drafts -in:spam -in:trash -label:forwarded -label:CheckPlease`;
const DRIVE_FOLDER_NAME = 'Email downloads';

function forwardFromSeptember4() {
  if (!Number.isFinite(START)) throw new Error('Invalid start date.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const forwarded = labelId('forwarded');
    const checkPlease = labelId('CheckPlease');
    const messages = Gmail.Users.Messages.list('me', {q: QUERY, maxResults: 50}).messages || [];
    if (!messages.length) return;
    const root = getOrCreateFolder(DriveApp.getRootFolder(), DRIVE_FOLDER_NAME);
    const deadline = Date.now() + 240000;

    for (const {id} of messages) {
      if (Date.now() >= deadline) break;
      try {
        const labels = Gmail.Users.Messages.get('me', id, {format: 'metadata'}).labelIds || [];
        if (!labels.includes('INBOX') || !labels.includes('UNREAD') ||
            [forwarded, checkPlease, 'SENT', 'DRAFT', 'SPAM', 'TRASH'].some(label => labels.includes(label))) continue;
        const email = GmailApp.getMessageById(id);
        const attachments = email.getAttachments({includeInlineImages: true, includeAttachments: true});
        if (isPaymentNotice(email.getSubject(), email.getPlainBody(), attachments.map(file => file.getName()))) {
          Gmail.Users.Messages.modify({addLabelIds: [checkPlease]}, 'me', id);
          continue;
        }

        const folder = getOrCreateFolder(root, id);
        saveFile(folder, Utilities.newBlob(email.getRawContent(), 'message/rfc822', 'email.eml'));
        attachments.forEach((file, index) => {
          if (Date.now() >= deadline) throw new Error('Time limit reached; retry next run.');
          saveFile(folder, file.copyBlob().setName(`${index + 1}_${file.getName() || 'attachment'}`));
        });
        // Mark complete only after the email and every attachment are saved.
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

function getOrCreateFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  return folders.hasNext() ? folders.next() : parent.createFolder(name);
}

function saveFile(folder, blob) {
  // Reuse earlier downloads if a run stopped before Gmail labeling succeeded.
  if (!folder.getFilesByName(blob.getName()).hasNext()) folder.createFile(blob);
}

function isPaymentNotice(subject, body, attachmentNames) {
  const titles = [subject].concat(attachmentNames).map(text => String(text || '').replace(/[_-]+/g, ' '));
  const notice = /\bremittance\b|\beft\s+(?:payment\s+)?(?:advice|notice|notification|confirmation)\b|\bpayment\s+(?:advice|confirmation|notification)\b/i;
  const currentBody = String(body || '').split(/\n(?:On .+wrote:|From:\s)/i)[0];
  const attachedNotice = /\b(?:attached|enclosed)\s+(?:(?:is|the|your|our|a)\s+){0,3}(?:remittance\s+(?:advice|notice)|eft\s+(?:payment\s+)?(?:advice|notice))\b/i;
  const eftReceived = /\beft\s+payment\s+(?:has been|was|is)\s+(?:received|made|processed|completed)\b/i;
  return titles.some(text => notice.test(text)) || attachedNotice.test(currentBody) || eftReceived.test(currentBody);
}

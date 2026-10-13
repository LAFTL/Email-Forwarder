const DESTINATION = 'familyfocusmedical@mail.lyrebirdhealth.com';
const HANDLER = 'forwardFromSeptember4';
const START = Math.floor(
  Date.parse('2026-09-04T00:00:00+10:00') / 1000
) - 1;
// math.floor - rounds to the lowest integer
// there is math.round but yeah not good for date in iso
// yes reader i know i could write a function the fetch date in iso with tostringiso() method but i am lazy

// Forwards Inbox email received from 4 September 2026, then archives it.
// Originally it was created for 4 September 2026 but there are older iterations.
// I wish I knew at the time how to get better
// First Day off of each month I would review:
// April 'IamAFool.md'
// May 'MayTheForceBwithU.md'
// June 'DrinkMoreP-JuneJuice.md'
// July 'EOY.md'
// August 'MyBaby.md'
// September 'SuperDepressedButGettingThere.md'

// The cutoff above follows the existing September 4 comments. Confirm it before use.
// Historical archive comments above are retained; this version keeps mail in Inbox.
const FORWARDER = Object.freeze({
  query: `in:inbox is:unread after:${START} -in:sent -in:drafts -in:spam -in:trash`,
  forwardedLabel: 'forwarded',
  reviewLabel: 'CheckPlease',
  convertAttachmentsToPdf: true,
  maxMessagesPerRun: 50,
  maxRunMs: 240000,
  maxAttachmentBytes: 20 * 1024 * 1024,
});
const SEND_STATE_PREFIX = 'forwarder.message.';

function forwardFromSeptember4() {
  if (!Number.isFinite(START) || !FORWARDER.query.trim()) {
    throw new Error('Configure a valid start date and Gmail search query.');
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Another forwarding run is active; skipping.');
    return;
  }
  try {
    const deadline = Date.now() + FORWARDER.maxRunMs;
    const labels = ensureForwarderLabels();
    const properties = PropertiesService.getScriptProperties();
    // Finish label changes from successful sends without sending another email.
    recoverSentMessages(properties, labels.forwarded, deadline);
    const query = // This is a fair important const you need keep nested in this function.
      `(${FORWARDER.query}) in:inbox is:unread -label:"${FORWARDER.forwardedLabel}" -label:"${FORWARDER.reviewLabel}"`; // See the Start and scroll up. I declared the global const with math.floor and see the explanation - see the September.md for context
    const messageIds = []; // I love array. I have an array of strong emotions wanting to punch the closing square bracket. But serious keep the const nested as well.
    let pageToken; // let const is really important. You need to remember that once let is declared for a variable. it can not be access outside this function.
    // but the var was not given a value every time functio
    const states = properties.getProperties();
    // Collect a bounded snapshot before changing labels; pagination stays stable.
    do {
      if (Date.now() >= deadline) break;
      const page = Gmail.Users.Messages.list('me', {
        q: query, maxResults: 500, pageToken,
      });
      for (const message of page.messages || []) {
        if (states[SEND_STATE_PREFIX + message.id]) {
          console.warn(`Message ${message.id} has unresolved send state; not resending.`);
          continue;
        }
        messageIds.push(message.id);
        if (messageIds.length >= FORWARDER.maxMessagesPerRun) break;
      }
      pageToken = page.nextPageToken;
    } while (pageToken && messageIds.length < FORWARDER.maxMessagesPerRun);

    for (const messageId of messageIds) {
      if (Date.now() >= deadline) break;
      try {
        processForwarderMessage(messageId, labels, properties, deadline);
      } catch (error) {
        // A pending send is intentionally retained if sending may have happened.
        console.error(`Message ${messageId}: ${error.message || error}`);
      }
      console.log("Log"+messageId); // just for reduntant purpose called logging
    }
  } finally {
    lock.releaseLock();
  }
}

function ensureForwarderLabels() {
  const existing = Gmail.Users.Labels.list('me').labels || [];
  function getId(name) {
    const label = existing.find(item => item.name === name);
    return label ? label.id : Gmail.Users.Labels.create({
      name, labelListVisibility: 'labelShow', messageListVisibility: 'show',
    }, 'me').id;
  }
  return {
    forwarded: getId(FORWARDER.forwardedLabel),
    review: getId(FORWARDER.reviewLabel),
  };
}

function markForwarded(messageId, forwardedLabelId) {
  // Archive only after forwarding succeeds.
  // This workflow marks read and keeps INBOX; it does not archive.
  Gmail.Users.Messages.modify({
    addLabelIds: [forwardedLabelId],
    removeLabelIds: ['UNREAD'], // follow the function of the parent.child.child.child to find the right api documentation
  }, 'me', messageId);
}

function recoverSentMessages(properties, forwardedLabelId, deadline) {
  const states = properties.getProperties();
  for (const key of Object.keys(states)) {
    if (Date.now() >= deadline) return;
    if (!key.startsWith(SEND_STATE_PREFIX)) continue;
    try {
      const state = JSON.parse(states[key]);
      if (state.status !== 'sent') continue;
      markForwarded(key.slice(SEND_STATE_PREFIX.length), forwardedLabelId);
      properties.deleteProperty(key);
    } catch (error) {
      console.error(`Send recovery ${key}: ${error.message || error}`);
    }
  }
}

function processForwarderMessage(messageId, labels, properties, deadline) {
  const key = SEND_STATE_PREFIX + messageId;
  if (properties.getProperty(key)) return;
  // Recheck this exact message; a thread can contain earlier processed replies.
  const metadata = Gmail.Users.Messages.get('me', messageId, {format: 'metadata'});
  const currentLabels = metadata.labelIds || [];
  if (!currentLabels.includes('INBOX') || !currentLabels.includes('UNREAD') ||
      currentLabels.includes(labels.forwarded) || currentLabels.includes(labels.review) ||
      ['SENT', 'DRAFT', 'SPAM', 'TRASH'].some(id => currentLabels.includes(id))) return;

  const message = GmailApp.getMessageById(messageId);
  const attachments = message.getAttachments({includeInlineImages: false, includeAttachments: true});
  if (isPaymentNotice(message.getSubject(), message.getPlainBody(), attachments.map(a => a.getName()))) {
    Gmail.Users.Messages.modify({addLabelIds: [labels.review]}, 'me', messageId);
    return;
  }
  if (MailApp.getRemainingDailyQuota() < 1) {
    throw new Error('Mail sending quota exhausted; message remains unread.');
  }
  // Native Gmail forwarding preserves the email and original attachments.
  // GmailApp.getMessageById(messageId).forward(DESTINATION);
  // Build the requested email-body PDF instead of using native forwarding.
  const inlineImages = message.getAttachments({includeInlineImages: true, includeAttachments: false});
  const outgoingAttachments = [emailBodyPdf(message, messageId, inlineImages)];
  for (const inlineImage of inlineImages) {
    if (!/^image\/(?:png|jpeg|gif)$/i.test(inlineImage.getContentType())) {
      outgoingAttachments.push(inlineImage.copyBlob());
    }
  }
  for (const attachment of attachments) {
    if (Date.now() >= deadline) throw new Error('Time limit reached before sending.');
    outgoingAttachments.push(prepareForwarderAttachment(attachment));
  }
  if (outgoingAttachments.reduce((sum, blob) => sum + blob.getBytes().length, 0) > FORWARDER.maxAttachmentBytes) {
    throw new Error('Attachments exceed the configured 20 MiB limit; nothing sent.');
  }
  if (Date.now() >= deadline) throw new Error('Time limit reached before sending.');

  // Gmail send and labeling cannot be atomic. Never retry an ambiguous send.
  const state = {status: 'pending', createdAt: new Date().toISOString()};
  properties.setProperty(key, JSON.stringify(state));
  MailApp.sendEmail({
    to: DESTINATION,
    subject: `Fwd: ${message.getSubject() || '(no subject)'}`.slice(0, 250),
    body: `Original email headers and body are in the attached PDF.\nSource Gmail message: ${messageId}`,
    attachments: outgoingAttachments,
  });
  state.status = 'sent';
  properties.setProperty(key, JSON.stringify(state));
  markForwarded(messageId, labels.forwarded);
  properties.deleteProperty(key);
}

function isPaymentNotice(subject, body, attachmentNames) {
  function normalize(text) {
    return String(text || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  const notice = /\b(?:remittance\s+(?:advice|notice)|payment\s+(?:advice|confirmation|notification)|eft\s+(?:payment\s+)?(?:advice|notice|notification|confirmation))\b/i;
  const titles = [subject].concat(attachmentNames || []).map(normalize);
  if (titles.some(text => notice.test(text) || /^(?:(?:re|fw|fwd):\s*)*remittance\b/i.test(text))) return true;
  // Avoid classifying quoted old notices and invoice payment instructions.
  const currentBody = String(body || '').split(/\n(?:On .+wrote:|[- ]*Original Message[- ]*|From:\s)/i)[0];
  const text = currentBody.split(/[.!?\n]+/).map(normalize).filter(sentence =>
    !/\b(?:please|kindly)\s+(?:send|email|provide|return|forward|attach|pay)\b|\b(?:once|after|when|if)\s+(?:(?:your|the)\s+)?(?:eft\s+)?payment\b/i.test(sentence)
  ).join(' ');
  const enclosed = /\b(?:attached|enclosed)\s+(?:(?:is|the|your|a|our)\s+){0,3}(?:remittance\s+(?:advice|notice)|eft\s+(?:payment\s+)?(?:advice|notice|notification))\b|\bremittance\s+(?:advice|notice)\s+(?:is\s+)?(?:attached|enclosed)\b/i;
  const completed = /\b(?:payment\s+(?:(?:has|have)\s+been|was|is)\s+(?:made|processed|transferred|completed|received)|funds\s+(?:(?:has|have)\s+been|were)\s+(?:transferred|credited))\b/i;
  const eftReceipt = /\beft\s+payment\s+(?:(?:has|have)\s+been|was|is)\s+(?:made|processed|transferred|completed|received)\b/i;
  return enclosed.test(text) || eftReceipt.test(text) || (notice.test(text) && completed.test(text));
}

function safeForwarderName(name) {
  return String(name || 'email').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 150);
}

function temporaryDocumentPdf(name, populate) {
  const document = DocumentApp.create(name);
  const id = document.getId();
  try {
    populate(document.getBody());
    document.saveAndClose();
    return DriveApp.getFileById(id).getAs(MimeType.PDF).setName(name + '.pdf');
  } finally {
    try { DriveApp.getFileById(id).setTrashed(true); }
    catch (error) { console.warn(`Temporary document cleanup ${id}: ${error.message || error}`); }
  }
}

function emailBodyPdf(message, messageId, inlineImages) {
  const name = safeForwarderName(message.getSubject()) + '_' + messageId;
  return temporaryDocumentPdf(name, body => {
    body.appendParagraph('Original email');
    body.appendParagraph('Subject: ' + (message.getSubject() || '(no subject)'));
    body.appendParagraph('From: ' + message.getFrom());
    body.appendParagraph('To: ' + message.getTo());
    if (message.getCc()) body.appendParagraph('Cc: ' + message.getCc());
    body.appendParagraph('Timestamp (UTC): ' + message.getDate().toISOString());
    body.appendParagraph('Gmail message ID: ' + messageId);
    body.appendParagraph('');
    body.appendParagraph(message.getPlainBody().replace(/\u0000/g, ''));
    for (const image of inlineImages || []) {
      body.appendParagraph('Inline image: ' + image.getName());
      if (/^image\/(?:png|jpeg|gif)$/i.test(image.getContentType())) {
        appendForwarderImage(body, image.copyBlob());
      } else {
        body.appendParagraph('This inline image is included as a separate original attachment.');
      }
    }
  });
}

function appendForwarderImage(body, blob) {
  const image = body.appendImage(blob);
  const width = image.getWidth();
  const height = image.getHeight();
  const scale = Math.min(1, 450 / width, 600 / height);
  image.setWidth(Math.max(1, Math.floor(width * scale)));
  image.setHeight(Math.max(1, Math.floor(height * scale)));
}

function prepareForwarderAttachment(attachment) {
  const name = attachment.getName() || 'attachment';
  const blob = attachment.copyBlob().setName(name);
  if (!FORWARDER.convertAttachmentsToPdf || blob.getContentType() === MimeType.PDF || /\.pdf$/i.test(name)) return blob;
  const extension = (name.split('.').pop() || '').toLowerCase();
  const officeTypes = {
    doc: ['application/msword', 'application/vnd.google-apps.document'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.google-apps.document'],
    odt: ['application/vnd.oasis.opendocument.text', 'application/vnd.google-apps.document'],
    rtf: ['application/rtf', 'application/vnd.google-apps.document'],
    xls: ['application/vnd.ms-excel', 'application/vnd.google-apps.spreadsheet'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.google-apps.spreadsheet'],
    ods: ['application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.google-apps.spreadsheet'],
    ppt: ['application/vnd.ms-powerpoint', 'application/vnd.google-apps.presentation'],
    pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.google-apps.presentation'],
    odp: ['application/vnd.oasis.opendocument.presentation', 'application/vnd.google-apps.presentation'],
  };
  const pdfName = safeForwarderName(name.replace(/\.[^.]+$/, ''));
  if (officeTypes[extension]) {
    const types = officeTypes[extension];
    const file = Drive.Files.create({name: pdfName, mimeType: types[1]}, blob.setContentType(types[0]), {fields: 'id'});
    try {
      return DriveApp.getFileById(file.id).getAs(MimeType.PDF).setName(pdfName + '.pdf');
    } finally {
      try { DriveApp.getFileById(file.id).setTrashed(true); }
      catch (error) { console.warn(`Temporary conversion cleanup ${file.id}: ${error.message || error}`); }
    }
  }
  if (/^image\/(?:png|jpeg|gif)$/i.test(blob.getContentType())) {
    return temporaryDocumentPdf(pdfName, body => appendForwarderImage(body, blob));
  }
  if (blob.getContentType() === 'text/plain' || extension === 'txt') {
    return temporaryDocumentPdf(pdfName, body => body.appendParagraph(blob.getDataAsString()));
  }
  // Unsupported formats stay attached in their original format; never drop files.
  return blob;
}

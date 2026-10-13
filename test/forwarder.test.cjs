// Local regression checks only. No Gmail, Drive, or mail service is contacted.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = ['MainFunction.js', 'TriggerInstaller.js']
  .map(name => fs.readFileSync(path.join(root, name), 'utf8'))
  .join('\n');

function attachment(name, mime, options = {}) {
  return {
    name,
    mime,
    conversionError: options.conversionError || false,
    bytes: options.bytes || [1, 2, 3],
    getName() { return this.name; },
    getContentType() { return this.mime; },
    getBytes() { return this.bytes; },
    getDataAsString() { return options.text || 'attachment contents'; },
    setName(value) { this.name = value; return this; },
    setContentType(value) { this.mime = value; return this; },
    copyBlob() { return attachment(this.name, this.mime, options); },
    getAs(target) {
      if (options.conversionError) throw new Error('Attachment conversion failed');
      if (target !== 'application/pdf') throw new Error('Unexpected conversion');
      return attachment(this.name.replace(/\.[^.]+$/, '') + '.pdf', target);
    },
  };
}

function message(id, overrides = {}) {
  return {
    id,
    threadId: 'thread-' + id,
    subject: 'Invoice ' + id,
    from: 'Supplier <supplier@example.com>',
    to: 'Business <business@example.com>',
    cc: 'Accounts <accounts@example.com>',
    date: new Date('2026-10-05T12:34:56Z'),
    body: 'Please find the invoice attached.\nThank you.',
    labels: new Set(['INBOX', 'UNREAD']),
    attachments: [],
    inlineImages: [],
    ...overrides,
  };
}

function harness(options = {}) {
  const messages = new Map((options.messages || []).map(item => [item.id, item]));
  const properties = new Map(Object.entries(options.properties || {}));
  const labels = new Map([
    ['forwarded', 'label-forwarded'],
    ['CheckPlease', 'label-review'],
  ]);
  const state = {
    messages,
    properties,
    queries: [],
    gets: [],
    modifications: [],
    sends: [],
    sendAttempts: [],
    documents: [],
    officeImports: [],
    files: new Map(),
    trashed: [],
    events: [],
    logs: [],
    attachmentOptions: [],
    lockAttempts: 0,
    lockReleases: 0,
    remainingQuota: options.remainingQuota ?? 100,
    modifyFailures: options.modifyFailures || 0,
    deletedTriggers: [],
    createdTriggers: [],
  };
  const event = (type, details) => state.events.push({type, details});
  const propertyService = {
    getProperties() { return Object.fromEntries(properties); },
    getProperty(key) { return properties.has(key) ? properties.get(key) : null; },
    setProperty(key, value) {
      if (options.sentCheckpointError && JSON.parse(value).status === 'sent') {
        throw new Error('Sent checkpoint write failed');
      }
      properties.set(key, String(value));
      event('setProperty', {key, value: String(value)});
      return this;
    },
    deleteProperty(key) {
      properties.delete(key);
      event('deleteProperty', key);
      return this;
    },
  };
  function makeDocument(name) {
    const id = 'doc-' + (state.documents.length + 1);
    const paragraphs = [];
    const images = [];
    const paragraph = {
      setHeading() { return this; },
      setBold() { return this; },
      setFontSize() { return this; },
      setSpacingAfter() { return this; },
    };
    const body = {
      appendParagraph(value) { paragraphs.push(String(value)); return paragraph; },
      appendImage(blob) {
        images.push(blob);
        const image = {
          width: 1000, height: 800,
          getWidth() { return this.width; },
          getHeight() { return this.height; },
          setWidth(value) { this.width = value; return this; },
          setHeight(value) { this.height = value; return this; },
        };
        return image;
      },
      appendPageBreak() { paragraphs.push('\n'); return this; },
      setText(value) { paragraphs.splice(0, paragraphs.length, String(value)); return this; },
      getText() { return paragraphs.join('\n'); },
    };
    const doc = {
      id, name, paragraphs,
      getId() { return id; },
      getBody() { return body; },
      saveAndClose() { event('saveDocument', id); },
      getBlob() {
        const result = attachment(name, 'application/vnd.google-apps.document');
        result.getAs = () => pdf();
        return result;
      },
    };
    function pdf() {
      const blob = attachment(name + '.pdf', 'application/pdf');
      blob.documentText = paragraphs.join('\n');
      blob.documentImages = images.map(blob => blob.getName());
      return blob;
    }
    const file = {
      getId() { return id; },
      getAs(target) {
        if (options.bodyConversionError || images.some(blob => blob.conversionError)) {
          throw new Error('Document conversion failed');
        }
        assert.equal(target, 'application/pdf');
        return pdf();
      },
      getBlob() { return doc.getBlob(); },
      setTrashed(value) { if (value) state.trashed.push(id); return this; },
    };
    state.documents.push(doc);
    state.files.set(id, file);
    event('createDocument', id);
    return doc;
  }
  const triggers = options.triggers || [];
  const context = vm.createContext({
    console: {
      log(...args) { state.logs.push(args.join(' ')); },
      warn(...args) { state.logs.push(args.join(' ')); },
      error(...args) { state.logs.push(args.join(' ')); },
    },
    Logger: {log(...args) { state.logs.push(args.join(' ')); }},
    Gmail: {Users: {
      Labels: {
        list() { event('listLabels'); return {labels: [...labels].map(([name, id]) => ({name, id}))}; },
        create(resource) {
          const id = 'label-' + labels.size;
          labels.set(resource.name, id);
          event('createLabel', resource);
          return {id, name: resource.name};
        },
      },
      Messages: {
        list(user, args) {
          state.queries.push({...args});
          event('listMessages', args);
          if (options.listError || (options.listErrorAt && state.queries.length === options.listErrorAt)) {
            throw new Error('Gmail listing failed');
          }
          assert.equal(user, 'me');
          let found = [...messages.values()].filter(item =>
            item.labels.has('INBOX') && item.labels.has('UNREAD'));
          if (/-label:(?:"?forwarded"?)/.test(args.q)) {
            found = found.filter(item => !item.labels.has(labels.get('forwarded')));
          }
          if (/-label:(?:"?CheckPlease"?)/.test(args.q)) {
            found = found.filter(item => !item.labels.has(labels.get('CheckPlease')));
          }
          const start = Number(args.pageToken || 0);
          const count = Math.min(options.listPageSize || Infinity, args.maxResults || 100);
          const page = found.slice(start, start + count);
          return {
            messages: page.map(({id, threadId}) => ({id, threadId})),
            ...(start + count < found.length ? {nextPageToken: String(start + count)} : {}),
          };
        },
        get(user, id, args) {
          assert.equal(user, 'me');
          const item = messages.get(id);
          if (!item) throw new Error('Message not found');
          if (options.onMetadataGet) options.onMetadataGet(item);
          state.gets.push({id, args});
          return {id, threadId: item.threadId, labelIds: [...item.labels]};
        },
        modify(resource, user, id) {
          assert.equal(user, 'me');
          state.modifications.push({id, resource});
          event('modifyMessage', {id, resource});
          if (state.modifyFailures > 0) {
            state.modifyFailures--;
            throw new Error('Gmail label update failed');
          }
          const item = messages.get(id);
          if (!item) throw new Error('Message not found');
          for (const label of resource.addLabelIds || []) item.labels.add(label);
          for (const label of resource.removeLabelIds || []) item.labels.delete(label);
          return {id, labelIds: [...item.labels]};
        },
      },
    }},
    GmailApp: {
      getMessageById(id) {
        const item = messages.get(id);
        if (!item) throw new Error('Message not found');
        return {
          getId: () => id,
          getSubject: () => item.subject,
          getFrom: () => item.from,
          getTo: () => item.to,
          getCc: () => item.cc,
          getDate: () => item.date,
          getPlainBody: () => item.body,
          getBody: () => '<p>' + item.body + '</p>',
          getAttachments(args) {
            state.attachmentOptions.push(args);
            return (args.includeAttachments !== false ? item.attachments : [])
              .concat(args.includeInlineImages === true ? item.inlineImages : []);
          },
        };
      },
    },
    MailApp: {
      getRemainingDailyQuota() { return state.remainingQuota; },
      sendEmail(args) {
        state.sendAttempts.push(args);
        event('sendEmail', args);
        if (options.sendError) throw new Error('Mail send failed or acknowledgement lost');
        state.sends.push(args);
        state.remainingQuota--;
      },
    },
    DocumentApp: {
      create: makeDocument,
      ParagraphHeading: {HEADING1: 'HEADING1', NORMAL: 'NORMAL'},
    },
    DriveApp: {
      getFileById(id) {
        const file = state.files.get(id);
        if (!file) throw new Error('File not found');
        return file;
      },
    },
    MimeType: {PDF: 'application/pdf'},
    Drive: {Files: {
      create(resource, blob, args) {
        const id = 'office-' + (state.officeImports.length + 1);
        state.officeImports.push({resource, blob, args, id});
        state.files.set(id, {
          getAs(target) {
            if (options.officeConversionError) throw new Error('Office conversion failed');
            assert.equal(target, 'application/pdf');
            return attachment(resource.name + '.pdf', target);
          },
          setTrashed(value) { if (value) state.trashed.push(id); return this; },
        });
        return {id};
      },
    }},
    PropertiesService: {getScriptProperties: () => propertyService},
    LockService: {getScriptLock: () => ({
      tryLock() { state.lockAttempts++; return options.lockAvailable !== false; },
      releaseLock() { state.lockReleases++; },
    })},
    Session: {getScriptTimeZone: () => 'Australia/Sydney'},
    Utilities: {
      formatDate(date) { return date.toISOString(); },
      newBlob(value, mime, name) { return attachment(name, mime, {text: String(value)}); },
      sleep() {},
    },
    ScriptApp: {
      TriggerSource: {CLOCK: 'CLOCK', SPREADSHEETS: 'SPREADSHEETS'},
      EventType: {CLOCK: 'CLOCK', ON_EDIT: 'ON_EDIT'},
      getProjectTriggers: () => triggers,
      deleteTrigger(trigger) { state.deletedTriggers.push(trigger); },
      newTrigger(handler) {
        const spec = {handler};
        const builder = {
          timeBased() { spec.source = 'CLOCK'; return this; },
          everyMinutes(minutes) { spec.minutes = minutes; return this; },
          create() { state.createdTriggers.push(spec); return spec; },
        };
        return builder;
      },
    },
  });
  vm.runInContext(source, context, {filename: 'forwarder-source.js'});
  function run() {
    try { vm.runInContext('forwardFromSeptember4()', context); return null; }
    catch (error) { return error; }
  }
  return {state, context, run};
}

function assertForwarded(item) {
  assert.equal(item.labels.has('label-forwarded'), true);
  assert.equal(item.labels.has('UNREAD'), false);
  assert.equal(item.labels.has('INBOX'), true, 'Source stays in inbox');
}

test('query has a valid date and unread inbox filter; repeated runs send once', () => {
  const item = message('once');
  const {state, context, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(run(), null);
  assert.equal(vm.runInContext('Number.isFinite(START)', context), true);
  assert.match(state.queries[0].q, /\bin:inbox\b/);
  assert.match(state.queries[0].q, /\bis:unread\b/);
  assert.match(state.queries[0].q, /\bafter:\d+\b/);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
  assert.equal(state.properties.size, 0);
});

test('separate unread replies in one thread are each sent and labelled', () => {
  const first = message('reply-1', {threadId: 'same-thread'});
  const second = message('reply-2', {threadId: 'same-thread'});
  const {state, run} = harness({messages: [first, second]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 2);
  assertForwarded(first);
  assertForwarded(second);
});

test('paged search is collected before label changes so later pages are not skipped', () => {
  const items = Array.from({length: 5}, (_, index) => message('page-' + index));
  const {state, run} = harness({messages: items, listPageSize: 2});
  assert.equal(run(), null);
  assert.equal(state.queries.length, 3);
  assert.equal(state.sends.length, 5);
  const firstModification = state.events.findIndex(event => event.type === 'modifyMessage');
  const lastListing = state.events.map(event => event.type).lastIndexOf('listMessages');
  assert.ok(lastListing < firstModification);
  items.forEach(assertForwarded);
});

test('a run sends at most 50 messages and the next run handles the remaining messages', () => {
  const items = Array.from({length: 61}, (_, index) => message('limit-' + index));
  const {state, run} = harness({messages: items});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 50);
  assert.equal(items.filter(item => item.labels.has('UNREAD')).length, 11);
  assert.equal(run(), null);
  assert.equal(state.sends.length, 61);
  items.forEach(assertForwarded);
});

test('a message marked read after search is rechecked and not sent', () => {
  const item = message('changed-after-search');
  const {state, run} = harness({messages: [item], onMetadataGet(source) {
    source.labels.delete('UNREAD');
  }});
  run();
  assert.equal(state.sends.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('label-forwarded'), false);
});

test('read mail and previously forwarded unread mail are not resent', () => {
  const read = message('read', {labels: new Set(['INBOX'])});
  const forwarded = message('labelled', {labels: new Set(['INBOX', 'UNREAD', 'label-forwarded'])});
  const {state, run} = harness({messages: [read, forwarded]});
  run();
  assert.equal(state.sends.length, 0);
  assert.equal(state.sendAttempts.length, 0);
});

test('a successful send followed by label failure is recovered without resending', () => {
  const item = message('recovery');
  const {state, run} = harness({messages: [item], modifyFailures: 1});
  run();
  assert.equal(state.sends.length, 1);
  assert.equal(item.labels.has('UNREAD'), true);
  const checkpoint = JSON.parse(state.properties.get('forwarder.message.recovery'));
  assert.equal(checkpoint.status, 'sent');
  assert.equal(Number.isNaN(Date.parse(checkpoint.createdAt)), false);
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
  assert.equal(state.properties.size, 0);
});

test('sent checkpoint recovery works even if the source is already read', () => {
  const item = message('already-read', {labels: new Set(['INBOX'])});
  const {state, run} = harness({messages: [item], properties: {
    'forwarder.message.already-read': JSON.stringify({status: 'sent', createdAt: '2026-10-05T12:00:00Z'}),
  }});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 0);
  assertForwarded(item);
  assert.equal(state.properties.size, 0);
});

test('send exceptions leave an ambiguous pending checkpoint and cannot auto-resend', () => {
  const item = message('uncertain');
  const {state, run} = harness({messages: [item], sendError: true});
  run();
  run();
  assert.equal(state.sendAttempts.length, 1);
  assert.equal(state.sends.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(item.labels.has('label-forwarded'), false);
  assert.equal(state.modifications.length, 0);
  assert.equal(JSON.parse(state.properties.get('forwarder.message.uncertain')).status, 'pending');
});

test('an existing old pending checkpoint is retained and never automatically retried', () => {
  const item = message('pending');
  const {state, run} = harness({messages: [item], properties: {
    'forwarder.message.pending': JSON.stringify({status: 'pending', createdAt: '2020-01-01T00:00:00Z'}),
  }});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(state.properties.has('forwarder.message.pending'), true);
});

test('a failed sent checkpoint write preserves pending and prevents duplicate sends', () => {
  const item = message('checkpoint-failure');
  const {state, run} = harness({messages: [item], sentCheckpointError: true});
  run();
  run();
  assert.equal(state.sends.length, 1);
  assert.equal(state.sendAttempts.length, 1);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(JSON.parse(state.properties.get('forwarder.message.checkpoint-failure')).status, 'pending');
});

test('pending state is persisted before mail and success state before source mutation', () => {
  const {state, run} = harness({messages: [message('order')]});
  assert.equal(run(), null);
  const pending = state.events.findIndex(event => event.type === 'setProperty' && JSON.parse(event.details.value).status === 'pending');
  const send = state.events.findIndex(event => event.type === 'sendEmail');
  const sent = state.events.findIndex(event => event.type === 'setProperty' && JSON.parse(event.details.value).status === 'sent');
  const modify = state.events.findIndex(event => event.type === 'modifyMessage');
  assert.ok(pending >= 0 && pending < send && send < sent && sent < modify);
});

for (const subject of ['Remittance advice', 'EFT payment notification']) {
  test(subject + ' is labelled CheckPlease and remains unread without sending', () => {
    const item = message('remit', {subject, body: 'Payment of $123.45 has been made. Reference INV-100.'});
    const {state, run} = harness({messages: [item]});
    assert.equal(run(), null);
    assert.equal(state.sends.length, 0);
    assert.equal(item.labels.has('label-review'), true);
    assert.equal(item.labels.has('UNREAD'), true);
    assert.equal(item.labels.has('label-forwarded'), false);
    run();
    assert.equal(state.sendAttempts.length, 0);
  });
}

test('notice mentioned in current body or attachment filename is also held for review', () => {
  const bodyNotice = message('body-notice', {
    subject: 'Accounts update',
    body: 'Please find attached remittance advice for the payment of $123.45.',
  });
  const filenameNotice = message('filename-notice', {
    subject: 'Accounts update',
    body: 'See attachment.',
    attachments: [attachment('Remittance_Advice_123.pdf', 'application/pdf')],
  });
  const {state, run} = harness({messages: [bodyNotice, filenameNotice]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 0);
  for (const item of [bodyNotice, filenameNotice]) {
    assert.equal(item.labels.has('label-review'), true);
    assert.equal(item.labels.has('UNREAD'), true);
  }
});

test('a quoted previous payment notice does not hide a new invoice', () => {
  const item = message('quoted-notice', {
    body: 'New invoice attached. Please arrange payment.\nOn Monday Accounts wrote:\nPayment confirmation: payment has been made.',
  });
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
});

test('ordinary invoice EFT payment instructions are forwarded', () => {
  const item = message('invoice-eft', {
    subject: 'Invoice INV-100 — payment due',
    body: 'Amount due: $123.45. Please pay via EFT using invoice number as reference. Payment has not yet been received.',
  });
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
  assert.equal(item.labels.has('label-review'), false);
});

test('an EFT receipt in the current body is labelled CheckPlease', () => {
  const item = message('eft-received', {
    subject: 'Accounts update', body: 'Your EFT payment has been received.',
  });
  const {state, run} = harness({messages: [item]});
  run();
  assert.equal(state.sends.length, 0);
  assert.equal(item.labels.has('label-review'), true);
  assert.equal(item.labels.has('UNREAD'), true);
});

test('invoice instructions asking for future remittance advice are forwarded', () => {
  const item = message('future-advice', {
    body: 'Please find attached invoice. Please email remittance advice after payment.',
  });
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
});

test('future payment confirmation instructions do not imply a payment was made', () => {
  const item = message('future-confirmation', {
    body: 'Please send payment confirmation after payment has been made.',
  });
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assertForwarded(item);
});

test('body PDF includes sender, recipients, subject, timestamp and full text', () => {
  const item = message('headers', {subject: 'Invoice <100>', body: 'First line\nSecond line'});
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  const pdf = state.sends[0].attachments.find(blob => typeof blob.documentText === 'string');
  assert.ok(pdf, 'A body PDF is attached');
  assert.equal(pdf.getContentType(), 'application/pdf');
  for (const value of [item.subject, item.from, item.to, item.cc, '2026', 'First line', 'Second line']) {
    assert.ok(pdf.documentText.includes(value), 'PDF contains ' + value);
  }
  assert.match(pdf.documentText, /(?:Date|Sent|Received|Timestamp)(?:\s*\([^)]+\))?\s*:/i);
  assert.ok(pdf.documentText.includes(item.date.toISOString()));
  assert.equal(state.trashed.length, state.documents.length, 'Temporary documents are removed');
  assert.ok(state.attachmentOptions.some(args => args.includeInlineImages === false && args.includeAttachments === true));
  assert.ok(state.attachmentOptions.some(args => args.includeInlineImages === true && args.includeAttachments === false));
});

test('an inline-only image email retains its image in the body PDF', () => {
  const inline = attachment('scanned-invoice.png', 'image/png');
  const item = message('inline-only', {body: '', inlineImages: [inline]});
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0].attachments.length, 1);
  assert.deepEqual(state.sends[0].attachments[0].documentImages, ['scanned-invoice.png']);
  assertForwarded(item);
});

test('unsupported inline image formats retain the original as a separate attachment', () => {
  const inline = attachment('invoice.webp', 'image/webp', {bytes: [8, 9]});
  const item = message('inline-unsupported', {body: '', inlineImages: [inline]});
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.sends[0].attachments.length, 2);
  const preserved = state.sends[0].attachments.find(blob => blob.getName() === 'invoice.webp');
  assert.ok(preserved);
  assert.deepEqual(preserved.getBytes(), [8, 9]);
  assertForwarded(item);
});

test('PDF attachment stays intact, supported image converts, unsupported original is retained', () => {
  const pdf = attachment('invoice.pdf', 'application/pdf', {bytes: [11, 22, 33]});
  const image = attachment('receipt.png', 'image/png');
  const zip = attachment('supporting-files.zip', 'application/zip', {bytes: [44, 55]});
  const item = message('attachments', {attachments: [pdf, image, zip]});
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  const blobs = state.sends[0].attachments;
  assert.equal(blobs.length, 4, 'Body PDF plus all three original attachment contents');
  const forwardedPdf = blobs.find(blob => blob.getName() === 'invoice.pdf');
  assert.ok(forwardedPdf);
  assert.deepEqual(forwardedPdf.getBytes(), [11, 22, 33]);
  assert.ok(blobs.some(blob => blob.getName() === 'receipt.pdf' && blob.getContentType() === 'application/pdf'));
  const forwardedZip = blobs.find(blob => blob.getName() === 'supporting-files.zip');
  assert.ok(forwardedZip);
  assert.deepEqual(forwardedZip.getBytes(), [44, 55]);
});

test('failed attachment conversion does not send or mark the original as complete', () => {
  const item = message('bad-conversion', {attachments: [attachment('scan.png', 'image/png', {conversionError: true})]});
  const {state, run} = harness({messages: [item]});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(item.labels.has('label-forwarded'), false);
  assert.equal(state.properties.size, 0);
  assert.equal(state.trashed.length, state.documents.length);
});

test('Office documents are imported, converted to PDF and temporary files removed', () => {
  const office = attachment('invoice.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const item = message('office', {attachments: [office]});
  const {state, run} = harness({messages: [item]});
  assert.equal(run(), null);
  assert.equal(state.officeImports.length, 1);
  assert.equal(state.officeImports[0].resource.mimeType, 'application/vnd.google-apps.document');
  assert.equal(state.sends.length, 1);
  assert.ok(state.sends[0].attachments.some(blob => blob.getName() === 'invoice.pdf'));
  assert.ok(state.trashed.includes(state.officeImports[0].id));
  assertForwarded(item);
});

test('Office conversion failure retains unread source and removes temporary file', () => {
  const office = attachment('invoice.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const item = message('bad-office', {attachments: [office]});
  const {state, run} = harness({messages: [item], officeConversionError: true});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(state.properties.size, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.ok(state.trashed.includes(state.officeImports[0].id));
});

test('failed body PDF conversion does not send or mark the original as complete', () => {
  const item = message('bad-body');
  const {state, run} = harness({messages: [item], bodyConversionError: true});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(state.properties.size, 0);
  assert.equal(state.trashed.length, state.documents.length);
});

test('overlapping invocation exits before Gmail or mail operations', () => {
  const {state, run} = harness({messages: [message('locked')], lockAvailable: false});
  run();
  assert.equal(state.lockAttempts, 1);
  assert.equal(state.events.length, 0);
  assert.equal(state.sends.length, 0);
  assert.equal(state.lockReleases, 0);
});

test('listing failure leaves the source untouched and releases the lock', () => {
  const item = message('list-failure');
  const {state, run} = harness({messages: [item], listError: true});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(state.lockReleases, 1);
});

test('failure while reading a later search page does not send earlier collected results', () => {
  const items = Array.from({length: 3}, (_, index) => message('list-page-error-' + index));
  const {state, run} = harness({messages: items, listPageSize: 2, listErrorAt: 2});
  run();
  assert.equal(state.queries.length, 2);
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(state.lockReleases, 1);
  assert.ok(items.every(item => item.labels.has('UNREAD')));
});

test('no daily mail quota leaves the original unread without creating a checkpoint', () => {
  const item = message('quota');
  const {state, run} = harness({messages: [item], remainingQuota: 0});
  run();
  assert.equal(state.sendAttempts.length, 0);
  assert.equal(state.modifications.length, 0);
  assert.equal(item.labels.has('UNREAD'), true);
  assert.equal(state.properties.size, 0);
});

test('trigger installer replaces only this handler’s clock triggers', () => {
  function trigger(name, source) {
    return {
      getHandlerFunction: () => name,
      getTriggerSource: () => source,
      getEventType: () => source === 'CLOCK' ? 'CLOCK' : 'ON_EDIT',
    };
  }
  const ownClock = trigger('forwardFromSeptember4', 'CLOCK');
  const unrelatedClock = trigger('anotherJob', 'CLOCK');
  const ownEvent = trigger('forwardFromSeptember4', 'SPREADSHEETS');
  const {state, context} = harness({triggers: [ownClock, unrelatedClock, ownEvent]});
  vm.runInContext('installForwarder()', context);
  assert.deepEqual(state.deletedTriggers, [ownClock]);
  assert.deepEqual(state.createdTriggers, [{handler: 'forwardFromSeptember4', source: 'CLOCK', minutes: 30}]);
});

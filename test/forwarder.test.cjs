// Local mocks only: no Gmail, Drive, or mail account is contacted.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = ['MainFunction.js', 'TriggerInstaller.js']
  .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');

function blob(name, mime, contents) {
  const bytes = Buffer.from(contents);
  return {
    getName: () => name, getContentType: () => mime,
    getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8'),
    setName(value) { name = value; return this; },
    copyBlob: () => blob(name, mime, bytes),
  };
}
function message(id, overrides = {}) {
  return {id, threadId: 'thread-' + id, subject: 'Invoice ' + id,
    body: 'Please pay via EFT using invoice number as reference.',
    raw: 'From: supplier@example.com\r\nTo: business@example.com\r\n' +
      'Subject: Invoice\r\nDate: Mon, 5 Oct 2026 12:34:56 +0000\r\n\r\nOriginal body é',
    labels: new Set(['INBOX', 'UNREAD']), attachments: [], ...overrides};
}
function iterator(values) {
  let index = 0;
  return {hasNext: () => index < values.length, next: () => values[index++]};
}
function harness(options = {}) {
  const messages = new Map((options.messages || []).map(item => [item.id, item]));
  const labels = new Map(options.noLabels ? [] : [['forwarded', 'label-forwarded'], ['CheckPlease', 'label-review']]);
  const state = {messages, queries: [], events: [], saves: 0, saveAttempts: 0,
    modifications: [], attachmentOptions: [], releases: 0, logs: [], modifyFailures: options.modifyFailures || 0};
  function folder(name) {
    const result = {name, children: new Map(), files: new Map(),
      getFoldersByName: value => iterator(result.children.has(value) ? [result.children.get(value)] : []),
      createFolder(value) {
        const child = folder(value); result.children.set(value, child);
        state.events.push('createFolder'); return child;
      },
      getFilesByName: value => iterator(result.files.has(value) ? [result.files.get(value)] : []),
      createFile(value) {
        state.saveAttempts++;
        if (options.saveError || state.saveAttempts === options.failSaveAt) throw new Error('Drive save failed');
        assert.equal(result.files.has(value.getName()), false, 'Never create a duplicate filename');
        result.files.set(value.getName(), value.copyBlob());
        state.saves++; state.events.push('save');
        if (state.saveAttempts === options.saveAcknowledgementErrorAt) throw new Error('Save acknowledgement lost');
        return value;
      }};
    return result;
  }
  state.root = folder('My Drive');
  const context = vm.createContext({
    console: {log: value => state.logs.push(value), warn: value => state.logs.push(value), error: value => state.logs.push(value)},
    LockService: {getScriptLock: () => ({tryLock: () => options.lockAvailable !== false, releaseLock: () => state.releases++})},
    Gmail: {Users: {
      Labels: {list() { state.events.push('labels'); return {labels: [...labels].map(([name, id]) => ({name, id}))}; },
        create(resource) { const id = resource.name === 'forwarded' ? 'label-forwarded' : 'label-review';
          labels.set(resource.name, id); return {id}; }},
      Messages: {
        list(user, args) {
          assert.equal(user, 'me'); state.queries.push(args); state.events.push('list');
          if (options.listError) throw new Error('Gmail search failed');
          return {messages: [...messages.values()].filter(item =>
            item.labels.has('INBOX') && item.labels.has('UNREAD') &&
            !item.labels.has('label-forwarded') && !item.labels.has('label-review'))
            .slice(0, args.maxResults).map(({id, threadId}) => ({id, threadId}))};
        },
        get(user, id) {
          const item = messages.get(id); if (options.onGet) options.onGet(item);
          return {id, threadId: item.threadId, labelIds: [...item.labels]};
        },
        modify(resource, user, id) {
          state.modifications.push({resource, id}); state.events.push('modify');
          if (state.modifyFailures-- > 0) throw new Error('Gmail labels failed');
          const item = messages.get(id);
          (resource.addLabelIds || []).forEach(value => item.labels.add(value));
          (resource.removeLabelIds || []).forEach(value => item.labels.delete(value));
        }} }},
    GmailApp: {getMessageById(id) {
      const item = messages.get(id);
      return {getSubject: () => item.subject, getPlainBody: () => item.body, getRawContent: () => item.raw,
        getAttachments(args) { state.attachmentOptions.push(args); return item.attachments; }};
    }},
    DriveApp: {getRootFolder() { state.events.push('root'); return state.root; }},
    Utilities: {newBlob: (contents, mime, name) => blob(name, mime, contents)},
    ScriptApp: {EventType: {CLOCK: 'CLOCK'}, getProjectTriggers: () => options.triggers || [],
      deleteTrigger: value => state.deletedTriggers.push(value),
      newTrigger(handler) { const spec = {handler}; return {
        timeBased() { return this; }, everyMinutes(minutes) { spec.minutes = minutes; return this; },
        create() { state.createdTriggers.push(spec); }}; }},
  });
  state.deletedTriggers = []; state.createdTriggers = [];
  vm.runInContext(source, context);
  return {state, context, run() {
    try { vm.runInContext('forwardFromSeptember4()', context); return null; }
    catch (error) { return error; }
  }, output(id) { return state.root.children.get('Email downloads')?.children.get(id); }};
}
function completed(item) {
  assert.equal(item.labels.has('label-forwarded'), true);
  assert.equal(item.labels.has('UNREAD'), false);
  assert.equal(item.labels.has('INBOX'), true);
}
function incomplete(item) {
  assert.equal(item.labels.has('label-forwarded'), false);
  assert.equal(item.labels.has('UNREAD'), true);
}

test('valid unread Inbox query uses September 4 cutoff, label exclusions, and one 50-message batch', () => {
  const h = harness(); assert.equal(h.run(), null);
  const query = h.state.queries[0];
  assert.match(query.q, /\bin:inbox\b/); assert.match(query.q, /\bis:unread\b/);
  const cutoff = Number(query.q.match(/after:(\d+)/)?.[1]);
  assert.equal(cutoff, Math.floor(Date.parse('2026-09-04T00:00:00+10:00') / 1000) - 1);
  assert.match(query.q, /-label:"?forwarded"?/); assert.match(query.q, /-label:"?CheckPlease"?/);
  assert.equal(query.maxResults, 50); assert.equal(h.state.queries.length, 1);
});
test('saves exact original .eml including headers, original attachments and inline images', () => {
  const attachments = [blob('invoice.pdf', 'application/pdf', [1, 2, 3]),
    blob('invoice.docx', 'application/octet-stream', [4, 5]), blob('inline.png', 'image/png', [6, 7])];
  const item = message('original', {attachments}); const h = harness({messages: [item], noLabels: true});
  assert.equal(h.run(), null); const files = h.output(item.id).files;
  assert.equal(files.size, 4); assert.equal(files.get('email.eml').getContentType(), 'message/rfc822');
  assert.equal(files.get('email.eml').getDataAsString(), item.raw);
  attachments.forEach((original, index) => {
    const saved = files.get(`${index + 1}_${original.getName()}`);
    assert.deepEqual(saved.getBytes(), original.getBytes());
    assert.equal(saved.getContentType(), original.getContentType());
  });
  assert.equal(h.state.attachmentOptions[0].includeInlineImages, true);
  completed(item); assert.ok(h.state.events.lastIndexOf('save') < h.state.events.indexOf('modify'));
});
test('successful messages are skipped on a repeat invocation', () => {
  const item = message('repeat'); const h = harness({messages: [item]});
  h.run(); h.run(); assert.equal(h.state.saves, 1); assert.equal(h.state.modifications.length, 1); completed(item);
});
test('failed label update retries labels without creating duplicate saved files', () => {
  const item = message('label-retry', {attachments: [blob('invoice.pdf', 'application/pdf', [1])]});
  const h = harness({messages: [item], modifyFailures: 1});
  h.run(); incomplete(item); assert.equal(h.state.saves, 2);
  assert.equal(h.run(), null); completed(item); assert.equal(h.state.saves, 2); assert.equal(h.output(item.id).files.size, 2);
});
test('a partial save retries only missing files before marking complete', () => {
  const item = message('partial', {attachments: [blob('a.pdf', 'application/pdf', [1]), blob('b.pdf', 'application/pdf', [2])]});
  const h = harness({messages: [item], failSaveAt: 2});
  h.run(); incomplete(item); assert.equal(h.output(item.id).files.size, 1); assert.equal(h.state.modifications.length, 0);
  assert.equal(h.run(), null); completed(item); assert.equal(h.state.saves, 3); assert.equal(h.output(item.id).files.size, 3);
});
test('a saved file with a lost acknowledgement is reused rather than duplicated', () => {
  const item = message('save-ack'); const h = harness({messages: [item], saveAcknowledgementErrorAt: 1});
  h.run(); incomplete(item); assert.equal(h.state.saves, 1); assert.equal(h.state.modifications.length, 0);
  h.run(); completed(item); assert.equal(h.state.saves, 1); assert.equal(h.output(item.id).files.size, 1);
});
test('attachments with identical or empty names all survive with unique ordinal filenames', () => {
  const attachments = [blob('same.pdf', 'application/pdf', [1]), blob('same.pdf', 'application/pdf', [2]),
    blob('', 'application/octet-stream', [3])];
  const item = message('same-names', {attachments}); const h = harness({messages: [item]}); h.run();
  const files = h.output(item.id).files; assert.equal(files.size, 4);
  assert.deepEqual(files.get('1_same.pdf').getBytes(), [1]);
  assert.deepEqual(files.get('2_same.pdf').getBytes(), [2]);
  assert.deepEqual(files.get('3_attachment').getBytes(), [3]); completed(item);
});
test('save failure leaves original unread and unforwarded', () => {
  const item = message('failed'); const h = harness({messages: [item], saveError: true});
  h.run(); incomplete(item); assert.equal(h.state.modifications.length, 0); assert.equal(h.state.releases, 1);
});
test('one failed message does not stop saving another message', () => {
  const failed = message('failed'); const good = message('good');
  const h = harness({messages: [failed, good], failSaveAt: 1}); h.run(); incomplete(failed); completed(good);
});
test('each fresh reply in a shared thread gets its own folder and exact-message labels', () => {
  const first = message('reply1', {threadId: 'shared'}); const second = message('reply2', {threadId: 'shared'});
  const h = harness({messages: [first, second]}); h.run();
  completed(first); completed(second); assert.ok(h.output(first.id)); assert.ok(h.output(second.id)); assert.equal(h.state.saves, 2);
});
for (const subject of ['Remittance advice', 'EFT payment notification']) {
  test(subject + ' is CheckPlease, remains unread, and has no saved files', () => {
    const item = message('notice', {subject}); const h = harness({messages: [item]}); h.run(); h.run();
    incomplete(item); assert.equal(item.labels.has('label-review'), true); assert.equal(h.state.saves, 0);
  });
}
test('invoice EFT instructions and requests for future remittance advice are saved', () => {
  const item = message('invoice', {body: 'Please pay via EFT. Please email remittance advice after payment.'});
  const h = harness({messages: [item]}); h.run(); completed(item); assert.equal(item.labels.has('label-review'), false);
});
test('separate subject and filename words do not combine into a payment notice', () => {
  const item = message('split-words', {subject: 'Invoice payment',
    attachments: [blob('confirmation_required.pdf', 'application/pdf', [1])]});
  const h = harness({messages: [item]}); h.run(); completed(item);
  assert.equal(item.labels.has('label-review'), false); assert.equal(h.state.saves, 2);
});
for (const body of ['Please find attached remittance advice', 'Your EFT payment has been received.']) {
  test('body-only notice is held for review: ' + body, () => {
    const item = message('body-notice', {subject: 'Accounts update', body});
    const h = harness({messages: [item]}); h.run(); incomplete(item);
    assert.equal(item.labels.has('label-review'), true); assert.equal(h.state.saves, 0);
  });
}
test('a source marked read after search is rechecked and skipped', () => {
  const item = message('race'); const h = harness({messages: [item], onGet: source => source.labels.delete('UNREAD')});
  h.run(); assert.equal(h.state.saves, 0); assert.equal(h.state.modifications.length, 0);
});
test('overlapping invocation performs no Gmail or Drive operations', () => {
  const h = harness({messages: [message('locked')], lockAvailable: false}); h.run();
  assert.equal(h.state.events.length, 0); assert.equal(h.state.releases, 0);
});
test('search error leaves messages untouched and releases lock', () => {
  const item = message('search-error'); const h = harness({messages: [item], listError: true});
  h.run(); incomplete(item); assert.equal(h.state.saves, 0); assert.equal(h.state.modifications.length, 0); assert.equal(h.state.releases, 1);
});
test('installer preserves unrelated triggers and this handler’s non-clock triggers', () => {
  const trigger = (name, event) => ({getHandlerFunction: () => name, getEventType: () => event});
  const clock = trigger('forwardFromSeptember4', 'CLOCK');
  const unrelated = trigger('otherJob', 'CLOCK'); const event = trigger('forwardFromSeptember4', 'ON_EDIT');
  const h = harness({triggers: [clock, unrelated, event]}); vm.runInContext('installForwarder()', h.context);
  assert.deepEqual(h.state.deletedTriggers, [clock]);
  assert.deepEqual(h.state.createdTriggers, [{handler: 'forwardFromSeptember4', minutes: 30}]);
});

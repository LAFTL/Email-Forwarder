// Local mocks only. No Gmail, Drive, or other live account is contacted.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = ['MainFunction.js', 'TriggerInstaller.js']
  .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');

function blob(name, mime, contents, sourceHtml) {
  const bytes = Buffer.from(contents);
  return {sourceHtml, getName: () => name, getContentType: () => mime,
    getBytes: () => [...bytes], getDataAsString: () => bytes.toString('utf8'),
    setName(value) { name = value; return this; },
    copyBlob: () => blob(name, mime, bytes, sourceHtml),
    getAs() { throw new Error('Original attachments must not be converted'); }};
}
function message(id, overrides = {}) {
  return {id, threadId: 'thread-' + id, subject: 'Invoice ' + id,
    from: 'Supplier <supplier@example.com>', to: 'Business <business@example.com>',
    date: new Date('2026-10-05T12:34:56Z'),
    html: '<p>Invoice café £123.45</p><table><tr><td>Balance</td><td>123.45</td></tr></table>',
    labels: new Set(['INBOX', 'UNREAD']), attachments: [], ...overrides};
}
function iterator(values) {
  let index = 0;
  return {hasNext: () => index < values.length, next: () => values[index++]};
}
function harness(options = {}) {
  const messages = new Map((options.messages || []).map(item => [item.id, item]));
  const labels = new Map(options.noLabels ? [] : [['forwarded', 'label-forwarded']]);
  const state = {files: new Map(), queries: [], events: [], saves: 0, saveAttempts: 0,
    conversions: [], modifications: [], attachmentOptions: [], folderIds: [], releases: 0,
    logs: [], modifyFailures: options.modifyFailures || 0, deletedTriggers: [], createdTriggers: []};
  const folder = {
    getFilesByName: name => iterator(state.files.has(name) ? [state.files.get(name)] : []),
    createFile(value) {
      state.saveAttempts++;
      if (options.saveError || state.saveAttempts === options.failSaveAt) throw new Error('Drive save failed');
      assert.equal(state.files.has(value.getName()), false, 'Never create a duplicate filename');
      state.files.set(value.getName(), value.copyBlob()); state.saves++; state.events.push('save');
      if (state.saveAttempts === options.saveAcknowledgementErrorAt) throw new Error('Save acknowledgement lost');
      return value;
    },
  };
  const context = vm.createContext({
    console: {log: value => state.logs.push(value), warn: value => state.logs.push(value), error: value => state.logs.push(value)},
    LockService: {getScriptLock: () => ({tryLock: () => options.lockAvailable !== false, releaseLock: () => state.releases++})},
    Gmail: {Users: {
      Labels: {list() { state.events.push('labels'); return {labels: [...labels].map(([name, id]) => ({name, id}))}; },
        create(resource) { assert.equal(resource.name, 'forwarded'); labels.set(resource.name, 'label-forwarded'); return {id: 'label-forwarded'}; }},
      Messages: {
        list(user, args) {
          assert.equal(user, 'me'); state.queries.push(args); state.events.push('list');
          if (options.listError) throw new Error('Gmail search failed');
          const excludedSubjects = ['remittance', 'payment', 'eft'].filter(word => args.q.includes('-subject:' + word));
          return {messages: [...messages.values()].filter(item =>
            item.labels.has('INBOX') && item.labels.has('UNREAD') && !item.labels.has('label-forwarded') &&
            !excludedSubjects.some(word => item.subject.toLowerCase().includes(word)))
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
      return {getSubject: () => item.subject, getBody: () => item.html,
        getFrom: () => item.from, getTo: () => item.to, getDate: () => item.date,
        getRawContent() { throw new Error('Raw RFC/MIME output must not be saved'); },
        getPlainBody() { throw new Error('Use the original HTML body for the PDF'); },
        getAttachments(args) { state.attachmentOptions.push(args); return item.attachments; }};
    }},
    DriveApp: {getFolderById(id) { state.folderIds.push(id); state.events.push('folder'); return folder; }},
    MimeType: {HTML: 'text/html', PDF: 'application/pdf'},
    Utilities: {newBlob(contents, mime, name) {
      const value = blob(name, mime, contents);
      value.getAs = target => {
        assert.equal(mime, 'text/html'); assert.equal(target, 'application/pdf');
        if (options.pdfError) throw new Error('PDF conversion failed');
        state.conversions.push(contents);
        return blob(name, target, '%PDF-mock', contents);
      };
      return value;
    }},
    ScriptApp: {EventType: {CLOCK: 'CLOCK'}, getProjectTriggers: () => options.triggers || [],
      deleteTrigger: value => state.deletedTriggers.push(value),
      newTrigger(handler) { const spec = {handler}; return {
        timeBased() { return this; }, everyMinutes(minutes) { spec.minutes = minutes; return this; },
        create() { state.createdTriggers.push(spec); }}; }},
  });
  // Supply a fake folder ID to exercise logic even when the production placeholder is guarded.
  vm.runInContext(source.replace('PASTE_FOLDER_ID_HERE', 'TEST_FOLDER_ID'), context);
  return {state, context, run() {
    try { vm.runInContext('forwardFromSeptember4()', context); return null; }
    catch (error) { return error; }
  }};
}
function completed(item) {
  assert.equal(item.labels.has('label-forwarded'), true);
  assert.equal(item.labels.has('UNREAD'), false); assert.equal(item.labels.has('INBOX'), true);
}
function incomplete(item) {
  assert.equal(item.labels.has('label-forwarded'), false); assert.equal(item.labels.has('UNREAD'), true);
}

test('valid unread Inbox query uses September 4 cutoff, forwarded exclusion, and one 50-message batch', () => {
  const h = harness(); assert.equal(h.run(), null); const query = h.state.queries[0];
  assert.match(query.q, /\bin:inbox\b/); assert.match(query.q, /\bis:unread\b/);
  assert.equal(Number(query.q.match(/after:(\d+)/)?.[1]), Math.floor(Date.parse('2026-09-04T00:00:00+10:00') / 1000) - 1);
  assert.match(query.q, /-label:"?forwarded"?/); assert.equal(query.q.includes('CheckPlease'), false);
  for (const word of ['remittance', 'payment', 'eft']) assert.ok(query.q.includes('-subject:' + word));
  assert.equal(query.maxResults, 50); assert.equal(h.state.queries.length, 1);
});
test('PDF retains original HTML and escaped readable headers; attachment bytes and formats stay original', () => {
  const attachments = [blob('invoice.pdf', 'application/pdf', [1, 2, 3]),
    blob('invoice.docx', 'application/octet-stream', [4, 5]), blob('inline.png', 'image/png', [6, 7])];
  const item = message('original', {subject: 'Invoice <42> & café', attachments});
  const h = harness({messages: [item], noLabels: true}); assert.equal(h.run(), null);
  const pdf = h.state.files.get('original_EMAIL_BODY.pdf'); assert.ok(pdf);
  assert.equal(pdf.getContentType(), 'application/pdf'); assert.equal(h.state.files.size, 4);
  assert.ok(pdf.sourceHtml.includes(item.html), 'Original table and rich body reach PDF conversion');
  for (const text of ['Invoice &lt;42&gt; &amp; café', 'Supplier &lt;supplier@example.com&gt;',
    'Business &lt;business@example.com&gt;', item.date.toISOString()]) assert.ok(pdf.sourceHtml.includes(text), text);
  attachments.forEach((original, index) => {
    const saved = h.state.files.get(`${item.id}_${index + 1}_${original.getName()}`);
    assert.deepEqual(saved.getBytes(), original.getBytes()); assert.equal(saved.getContentType(), original.getContentType());
  });
  assert.equal(h.state.folderIds[0], 'TEST_FOLDER_ID'); assert.equal(h.state.attachmentOptions[0].includeInlineImages, true);
  completed(item); assert.ok(h.state.events.lastIndexOf('save') < h.state.events.indexOf('modify'));
});
test('successful repeat run adds neither files nor another PDF conversion', () => {
  const item = message('repeat'); const h = harness({messages: [item]}); h.run(); h.run();
  assert.equal(h.state.saves, 1); assert.equal(h.state.conversions.length, 1); assert.equal(h.state.modifications.length, 1); completed(item);
});
test('label failure retries labels and reuses previously saved PDF and attachment', () => {
  const item = message('label-retry', {attachments: [blob('invoice.pdf', 'application/pdf', [1])]});
  const h = harness({messages: [item], modifyFailures: 1}); h.run(); incomplete(item); assert.equal(h.state.saves, 2);
  h.run(); completed(item); assert.equal(h.state.saves, 2); assert.equal(h.state.conversions.length, 1);
});
test('partial save retries only missing attachment files before completing the source', () => {
  const item = message('partial', {attachments: [blob('a.pdf', 'application/pdf', [1]), blob('b.pdf', 'application/pdf', [2])]});
  const h = harness({messages: [item], failSaveAt: 2}); h.run(); incomplete(item);
  assert.equal(h.state.files.size, 1); assert.equal(h.state.modifications.length, 0);
  h.run(); completed(item); assert.equal(h.state.saves, 3); assert.equal(h.state.files.size, 3); assert.equal(h.state.conversions.length, 1);
});
test('a saved PDF with a lost acknowledgement is reused without another conversion', () => {
  const item = message('save-ack'); const h = harness({messages: [item], saveAcknowledgementErrorAt: 1});
  h.run(); incomplete(item); assert.equal(h.state.modifications.length, 0);
  h.run(); completed(item); assert.equal(h.state.saves, 1); assert.equal(h.state.conversions.length, 1);
});
test('failed PDF conversion leaves the email unread and unforwarded with no saved files', () => {
  const item = message('pdf-failure'); const h = harness({messages: [item], pdfError: true}); h.run(); incomplete(item);
  assert.equal(h.state.saves, 0); assert.equal(h.state.modifications.length, 0); assert.equal(h.state.releases, 1);
});
test('save failure leaves the source untouched and does not stop the next message', () => {
  const failed = message('failed'); const good = message('good');
  const h = harness({messages: [failed, good], failSaveAt: 1}); h.run(); incomplete(failed); completed(good);
});
test('fresh replies with one thread and repeated subject get separate files and exact-message labels', () => {
  const first = message('reply1', {threadId: 'shared', subject: 'Invoice'});
  const second = message('reply2', {threadId: 'shared', subject: 'Invoice'});
  const h = harness({messages: [first, second]}); h.run(); completed(first); completed(second);
  assert.ok(h.state.files.has('reply1_EMAIL_BODY.pdf')); assert.ok(h.state.files.has('reply2_EMAIL_BODY.pdf'));
  assert.deepEqual(h.state.modifications.map(value => value.id), ['reply1', 'reply2']);
});
for (const subject of ['REMITTANCE advice', 'Payment confirmation', 'EFT notice', 'Invoice payment due']) {
  test(subject + ' is skipped without modifying any source label or saving files', () => {
    const item = message('payment', {subject}); const before = [...item.labels];
    const h = harness({messages: [item]}); h.run(); h.run();
    assert.deepEqual([...item.labels], before); assert.equal(h.state.modifications.length, 0); assert.equal(h.state.saves, 0);
  });
}
test('body payment instructions do not exclude an ordinary invoice subject', () => {
  const item = message('invoice', {html: '<p>Please pay via EFT. Send remittance advice after payment.</p>'});
  const h = harness({messages: [item]}); h.run(); completed(item);
});
test('a source marked read after search is rechecked and skipped', () => {
  const item = message('race'); const h = harness({messages: [item], onGet: source => source.labels.delete('UNREAD')});
  h.run(); assert.equal(h.state.saves, 0); assert.equal(h.state.modifications.length, 0);
});
test('overlapping invocation performs no Gmail or Drive operations', () => {
  const h = harness({messages: [message('locked')], lockAvailable: false}); h.run();
  assert.equal(h.state.events.length, 0); assert.equal(h.state.releases, 0);
});
test('search error leaves messages untouched and releases lock', () => {
  const item = message('search-error'); const h = harness({messages: [item], listError: true}); h.run(); incomplete(item);
  assert.equal(h.state.saves, 0); assert.equal(h.state.modifications.length, 0); assert.equal(h.state.releases, 1);
});
test('installer preserves unrelated triggers and this handler’s non-clock triggers', () => {
  const trigger = (name, event) => ({getHandlerFunction: () => name, getEventType: () => event});
  const clock = trigger('forwardFromSeptember4', 'CLOCK');
  const h = harness({triggers: [clock, trigger('otherJob', 'CLOCK'), trigger('forwardFromSeptember4', 'ON_EDIT')]});
  vm.runInContext('installForwarder()', h.context); assert.deepEqual(h.state.deletedTriggers, [clock]);
  assert.deepEqual(h.state.createdTriggers, [{handler: 'forwardFromSeptember4', minutes: 30}]);
});

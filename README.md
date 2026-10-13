# Email-Forwarder
Business email forwarder used parallel with lyrebirdhealth

# Current tested conditions
Working and tested only on Google appscript

# Lyrebirdhealth has shit support

## Current forwarding behavior

`forwardFromSeptember4` selects individual unread Inbox messages using
`FORWARDER.query`. The default begins at 4 September 2026, midnight UTC+10,
following the existing source comments. Confirm this cutoff before using it;
the previous source contained an invalid October date.

- Remittance advice and EFT notices receive `CheckPlease`, stay unread, and are
  not sent. The query excludes that label on future runs.
- Other messages are sent to `DESTINATION` with a PDF containing Subject, From,
  To, Cc when present, the original UTC timestamp, and the full plain-text body.
  Inline PNG, JPEG, and GIF images appear after the plain-text body. Other inline
  formats remain separate original attachments. HTML styling, original inline
  placement, and images hosted remotely are not reproduced.
- Original PDF attachments are retained. Supported Word, Excel, PowerPoint,
  OpenDocument, RTF, PNG, JPEG, GIF, and plain-text attachments are converted to
  PDF. Unsupported formats, including ZIP files, remain attached unchanged.
  Set `convertAttachmentsToPdf` to `false` to keep all original attachments.
  Failed supported conversions stop that message before sending.
- After a successful send, only that source message receives `forwarded` and
  loses `UNREAD`. It remains in Inbox. Later replies in the same conversation
  are processed independently.
- Each run prepares at most 50 messages within a four-minute working budget.
  Attachments over a combined 20 MiB are not sent; the source stays unread.

The remittance classifier checks subject, plain-text body, and attachment names.
It does not read attachment contents or perform OCR. Phrase matching can miss
unusual notices and can misclassify quoted payment wording. Tune
`isPaymentNotice` using real examples. Invoice instructions such as “Please pay
by EFT and email remittance advice” alone do not qualify as a payment notice.

## Duplicate protection

A script lock prevents overlapping executions in this Apps Script project.
Gmail labels provide the normal completed-message guard. A temporary per-message
journal in Script Properties protects the interval between sending and labeling:

1. Save `pending` immediately before calling `MailApp.sendEmail`.
2. Save `sent` when that call returns successfully.
3. Apply `forwarded` and remove `UNREAD`, then delete the journal entry.

On the next run, `sent` entries finish labeling without another email. A
`pending` entry is never resent automatically because a failed or interrupted
send may already have been accepted. The execution log identifies its source
Gmail message ID. Check the destination and Sent mail before resolving it. If
delivery is confirmed, label that source message `forwarded`, mark it read, and
delete only its `forwarder.message.<id>` Script Property. If it was definitely
not sent, delete only that property to permit another attempt. Do not clear
uncertain entries merely to make forwarding resume.

This trades an occasional manual check after an ambiguous send for avoiding
another duplicate storm. Gmail sending and source-label changes are separate
operations; the script cannot guarantee exactly-once delivery. Messages sent by
the older script without a `forwarded` label or this journal cannot be recognized
as previously sent. Establish the correct cutoff or label those sources before
enabling the replacement, otherwise they are eligible again.

## Apps Script setup

Copy `MainFunction.js` and `TriggerInstaller.js` into the existing standalone
Apps Script project, and use the included `appsscript.json` manifest. Enable
Advanced Gmail API v1 and Advanced Drive API v3. If the project uses a standard
Google Cloud project, enable the Gmail API and Drive API there too.

Review `DESTINATION`, `START`, and `FORWARDER.query` before running. The epoch
query is timezone explicit and includes the cutoff second. The Gmail search
always additionally requires Inbox and unread status and excludes `forwarded`
and `CheckPlease`. Google Docs and Drive are used for temporary PDF conversion;
temporary files are moved to Trash, not permanently deleted.

`installForwarder` replaces only clock triggers for `HANDLER` owned by the
current user, then creates one every 30 minutes. Other handlers are preserved.
Disable older forwarding handlers or projects separately before enabling this
one. Local development does not invoke this installer or access a real mailbox.

## Local checks

```sh
node --check MainFunction.js
node --check TriggerInstaller.js
node --test test/forwarder.test.cjs
```

These use isolated mocks. Real Gmail sending, Office conversion fidelity, Google
quotas, and live authorization still require testing in Apps Script. The earlier
onboarding helper asserts native forwarding and archiving; those expectations
do not describe this requested PDF-and-label workflow and were not removed.


# 3. Email as documents

**Size: small.**

## What you would see

Drag an email — or a folder of them — into a matter, and it files like any
other document: sender, recipients, date and subject visible, the body readable
and quotable, attachments filed alongside it.

Today Mike cannot take an email at all. In most matters the correspondence is
half the file.

## How it would work

Two formats cover practically everything: `.eml`, which is what most mail
programs export, and `.msg`, which is what Outlook produces. Both hold the
message and its attachments.

Reading them means pulling out the header details, the body, and each
attachment. The attachments then go through the paths that already exist —
including OCR, so a scanned letter attached to an email becomes readable
without anyone doing anything.

## What is involved

1. Accept `.eml` and `.msg`.
2. Pull out sender, recipients, date, subject and body.
3. Store attachments as their own documents, linked to the email.
4. Render the email as a page so it previews and cites like everything else.

`.eml` is a standard format and straightforward. `.msg` is Microsoft's own and
needs a dedicated reader — the one real cost in this document.

## What to watch

- **The header details are evidence.** Who received what and when is often the
  point. They must be visible and quotable, not buried.
- **A thread repeats itself.** Ten replies contain nine copies of the first
  message. Worth collapsing quoted history, or search fills with duplicates.
- **Attachments must not be lost quietly.** If one cannot be read, say so on
  the email rather than dropping it.

## Done when

An Outlook export with attachments files itself into a matter, the email is
readable with its header details, the attachments are separate documents, and a
scanned attachment is readable text.

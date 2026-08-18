# 1. Search across a matter

**Size: large.** Build in stages, useful from the first one.

## What you would see

Ask "which of these files contains an indemnity clause?" or "where does anyone
mention the March inspection?" and get an answer with the file and page,
without naming the documents first.

Today you cannot. Mike reads the documents you hand it. There is no way to ask
a question of a matter as a whole. With one or two files that is fine; with a
folder of thirty, or a OneDrive matter with three hundred, it is the difference
between useful and unusable.

## Why it comes first

Everything else on the roadmap gets better once this exists, and one thing —
connecting OneDrive — is actively unwise without it. Feeding hundreds of client
files into a system that can only read what you point at just makes a bigger
pile.

## How it would work

Mike keeps the text of every document it has read, cut into passages and stored
so that passages can be found by meaning rather than by exact wording — so
"who pays if this goes wrong" finds an indemnity clause that never uses those
words. When you ask a question, the passages that look relevant are found
first, and only those are given to the AI, along with where each came from.

Two things fall out of that, both wanted anyway:

- **Ordinary search.** A search box that actually looks inside documents.
- **One answer across many documents.** Not a row per file as the review grids
  give you, but a single answer drawn from the whole set, with citations.

The database already has the extension available for this kind of storage; the
text now exists for scans too, since OCR went in.

## What is involved

1. Store the text of every document, in passages, when it is uploaded.
2. Fill in the documents already uploaded.
3. Find relevant passages for a question, and hand those to the AI.
4. A search box in the interface.
5. Consolidated answers across a document set.

Stages 1 to 3 are the substance. Stage 4 is a day. Stage 5 builds on the rest.

## What to watch

- **Passages must carry their page number**, or citations break. Non-negotiable.
- **Scanned text has errors in it.** Search has to tolerate a wrong character
  or two, and anything quoted from a scan keeps its existing warning.
- **Permissions have to hold.** Search must never surface a passage from a
  matter the person cannot open. Worth building alongside document 4, not after.
- **Cost and privacy.** Working out the meaning of a passage is normally done by
  sending it to an AI service. For client material that is a decision to make
  deliberately — it can be done on our own machine instead, more slowly.

## Done when

You can ask a question of a project with fifty documents, get a correct answer
citing the right file and page, in a few seconds, without attaching anything.

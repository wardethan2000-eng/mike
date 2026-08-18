# 1. Search across a matter

**Size: large.** Seven stages, useful from the third.

## What you would see

Ask "which of these files contains an indemnity clause?" or "where does anyone
mention the March inspection?" and get an answer with the file and page,
without naming the documents first.

Today you cannot. Mike reads the documents you hand it. There is no way to ask
a question of a matter as a whole. With one or two files that is fine; with a
folder of thirty, or a OneDrive matter with three hundred, it is the difference
between useful and unusable.

## Why it comes first

Everything else on the roadmap gets better once this exists, and connecting
OneDrive is actively unwise without it — feeding hundreds of client files into a
system that can only read what you point at just makes a bigger pile.

## What gets stored

One new table holding the text of every document in passages. Each row records
the document, the version, **the page**, the text, and a numeric fingerprint of
its meaning. Nothing existing changes shape, which keeps upstream updates cheap.

Passages are cut page by page, then split at paragraph boundaries into pieces of
roughly a page-third, overlapping slightly so a clause split across a boundary
is still found whole.

**Every passage carries its page number.** Without that, citations break, and
citations are the point.

## Two kinds of search, combined

Neither is good enough alone:

- **Exact words** — party names, case numbers, defined terms, "Section 7.2".
  The database does this natively and it costs nothing.
- **Meaning** — "who pays if this goes wrong" finding an indemnity clause that
  never uses those words. This is what the fingerprints are for.

Both run and the results are merged, so a passage scoring on both rises to the
top. Meaning-search alone is notoriously bad at finding a specific name, which
is the difference between a search that demonstrates well and one that gets used.

The database can already do this: the `vector` extension (0.8.2) ships in the
image we run and simply is not switched on yet. No new infrastructure.

## Reading happens on our own machine

**Decided 18 August 2026: fingerprints are computed locally. No client text is
sent to an outside service for this.**

The decision is hard to reverse — what has been sent is sent — and it is the
same question that governs OneDrive. The cost is speed: reading a large
collection becomes an overnight job rather than minutes.

### What that means for the machine

The VM is configured with 8 GB but ballooned down to 4 GB, which is why it sees
3.9 GB and why OCR was killed on a long scan. The Proxmox host has 15 GB total
with about 5 GB spare, and already has 16 GB promised across four machines, so
there is no large increase available.

The practical answer is a **small model** — a few hundred megabytes, not several
gigabytes — and **one heavy job at a time**. Reading documents and computing
fingerprints must not run alongside each other unattended. If we later want
headroom, raising this machine's balloon floor from 4 GB to 6 GB is the lever,
at the host's expense.

## Permissions are part of it, not after it

The access rules exist already for documents and matters. The filter has to sit
**inside the search query**, so a passage from a matter you are not on is never
a candidate. Filtering afterwards is how these things leak.

This is why accounts and permissions is the next item on the roadmap: this work
should be written expecting it.

## How the assistant uses it

Mike already has a Ctrl+F for a single document. This adds its sibling: search
the whole matter, return the best passages with document and page, cite them.
Two small edits to upstream files — one describing the new ability, one running
it — and everything else in files of ours.

The assistant then stops needing to be handed documents.

## The order of work

1. Store passages when a document is uploaded, wired in where OCR now runs.
   Nothing visible yet.
2. Fill in the documents already uploaded, with a command like the one that
   fixed the first scan.
3. **Search on exact words.** Immediately useful, and it proves the passages and
   page numbers are right before any model is involved.
4. Add meaning-based search and merge the two.
5. Give the assistant the tool — the point where asking a question of a matter
   starts working.
6. A search box in the interface.
7. One answer across a whole document set, using the existing citation
   machinery.

## What to watch

- **Scanned text contains recognition errors.** Exact search must tolerate a
  wrong character or two, or the OCR'd documents become the ones it cannot find.
- **Old versions must not pollute results.** Passages belong to a version; only
  the current one is searched by default.
- **Re-reading must be cheap.** Documents change. Re-doing one document must not
  mean re-doing the matter.
- **Say where an answer came from.** If the assistant answered from passages
  rather than a full read, the citations must make that traceable.
- **Do not run two heavy jobs at once.** See the memory note above.

## Done when

A question asked of a fifty-document project returns a correct answer citing the
right file and page, within seconds, with nothing attached — and a person not on
that matter gets nothing at all.

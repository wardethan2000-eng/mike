# 2. Comparing two documents

**Size: small.** The clearest value for the least work on this list.

## What you would see

Pick two documents — their draft against your precedent, this version against
last week's — and get a plain list of what changed: what was added, removed and
reworded, clause by clause, with a Word file of the comparison if you want one.

Today Mike can edit a document with tracked changes, but it cannot tell you how
two documents differ. For transactional work that is a daily task.

## How it would work

The machinery is already here. Mike knows how to read both documents to text,
and it already writes genuine tracked changes into a Word file for the redline
feature. Comparing is joining those two: work out the differences, then either
describe them or write them into a copy of one document as tracked changes.

Two ways to ask, both worth having:

- **In conversation.** "How does their draft differ from our standard form?"
  and the assistant answers, then draws out the ones that matter — a changed
  liability cap is not the same as a changed date format.
- **As a document.** A Word file with the differences marked up, to send on.

## What is involved

1. A compare step that takes two documents and returns the differences.
2. Make it available to the assistant as something it can do.
3. Write the result into a Word file as tracked changes.
4. A "compare with…" option in the interface.

All new files apart from a small hook into the assistant's list of abilities.

## What to watch

- **Compare at the level of sentences and clauses, not characters.** A
  character-level result is technically correct and useless to read.
- **Say what changed in substance.** The value is not the list of edits, it is
  "the indemnity cap moved from £1m to £5m and the notice period halved".
- **Scanned documents compare badly**, because recognition errors look like
  edits. Warn when either side came from a scan.

## Done when

Two versions of a real agreement can be compared, the substantive changes are
correctly described and ranked, and the Word output opens cleanly with the
changes reviewable one at a time.

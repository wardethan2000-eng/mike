# 9. Discovery and productions

**Size: large.** The biggest thing on this list. Seven pieces that each work on
their own, built in order, ending with documents that can go out the door.

## What you would see

A discovery request arrives. You give it to Mike. Before it reads a single
document, two things get settled: who everyone is, and what you are objecting
to. Then Mike reads every document in the matter against every request and
proposes a disposition for each one — produce, withhold, or not responsive —
with the passage that made it think so.

You go through those proposals and accept or change each one. Nothing moves
without you. When the decisions are done, Mike copies the accepted documents
into a production folder, turns them into PDFs, stamps them with Bates numbers,
and hands you either one combined PDF or a stamped set of separate files. It
also writes the privilege log for everything held back, and drafts the written
responses and objections with the real Bates ranges filled in.

The originals are never touched.

## Why this is one feature and not seven

Bates stamping on its own is a fortnight of work and solves nothing. The
numbers only mean something at the end of a chain: a decision about what is
responsive, an attorney's confirmation of that decision, a frozen set of
documents in a fixed order, and then numbers burned onto pages that can never
be reused. Build the stamp first and you have a stamping tool nobody can safely
use on a real case.

The chain also runs in one direction. The written responses quote Bates ranges,
so they cannot be drafted until the stamping is done. The stamping cannot start
until the set is frozen. The set cannot be frozen until a human has accepted
every call. And the calls are only as good as the ground rules agreed at the
start.

## The people list

Privilege turns on **who was on a document** far more than on what it says. So
the first thing a matter needs is a list of people and organisations, gathered
before review rather than during it:

- **The client's own lawyers** — the firm, its attorneys, its paralegals and
  staff. Mike already holds most of this: the firm record has the name and
  address, and every member carries a name, an email, a title and their bar
  admissions. This half fills itself in.
- **Prior counsel.** Privilege does not lapse when a client changes firms, and
  old correspondence from a previous lawyer is the easiest privileged material
  to miss entirely.
- **In-house or general counsel** at the client, where the client is a
  business, and which of their staff were acting on a lawyer's instructions.
- **Opposing counsel and their firm.** This is the useful inverse — a document
  with the other side on it is usually not privileged, and knowing their names
  clears a great many false flags cheaply.
- **Co-party counsel**, where a common interest or joint defence is claimed.
- **Experts, split into testifying and consulting.** The distinction decides
  the answer: a consulting expert's work is generally protected and a
  testifying expert's largely is not, so they cannot sit in one bucket.
- **Insurers and adjusters**, which vary by state and by whether coverage is in
  dispute.

**Email domains do more work than names.** One entry for `@smithlaw.com`
catches every person at that firm, including the ones nobody thought to list.

And one date that everything work-product hangs from: **when litigation was
first anticipated.** Work product attaches from that point, not from the day
the petition was filed. Without it, every work-product call is guesswork.

Mike proposes this list from what is already in the matter — the pleadings, the
engagement letter, the correspondence — and you correct it. It is a document in
the matter, so it can be revised as new people appear, and every review run
records which version it ran under.

## The rest of the ground rules

Alongside the people, and still before review starts:

- **The objections you are asserting**, request by request, and the limits you
  are producing under — a date range, particular custodians, a subject-matter
  boundary. If Request 7 is limited to 2022 through 2024, a document from 2019
  is not responsive to Request 7, and Mike needs to know that while it reads
  rather than afterwards.
- **The privilege categories in play.** Attorney-client and work product
  always. Sometimes common interest, spousal, physician-patient, or trade
  secrets.
- **The protective order**, if there is one, and what its tiers are called.

## Reading the requests

Discovery requests arrive as a Word file or a PDF. Mike splits them into
numbered items and, for each one, writes a plain restatement of what is
actually being asked for.

Two things make this less trivial than it sounds. The definitions and
instructions at the front of a request change the meaning of every numbered
item beneath it — "Document", "You", "the relevant time period" — so they have
to be captured and attached to each request rather than skimmed. And if Mike
splits a compound request wrongly, every downstream decision inherits the
error. So the parse is confirmed by a human before anything else happens.

## Reading the documents

This is the tabular review engine Mike already has, pointed at a new job. It
is already a grid of documents down the side and questions across the top,
where every answer carries a citation back to the page it came from. That is
exactly the shape of a responsiveness review.

The important design decision is that **each document is read once, not once
per request.** Two thousand documents against thirty-five requests is seventy
thousand questions if you do it the obvious way, which is unaffordable and
slow. Instead the whole request list goes into the prompt and the document
comes back with every request number it answers, the reason for each, and the
passages. That is one pass per document.

For each document Mike returns:

- Which requests it responds to, if any, and why, with citations
- Whether anything in it looks privileged, which category, and which people on
  the list put it there
- Its confidentiality tier, if a protective order applies
- A proposed disposition: produce, withhold, or not responsive

Documents that already carry a text layer — which is all of them, because Mike
makes a PDF rendition with text for everything on upload — need no conversion
work at this stage. Long documents get read in page ranges and merged, because
a deposition transcript will not fit in one pass and responsiveness can turn on
a single page in the middle.

A run shows an estimated cost before it starts, reports progress you can watch,
can be stopped, and resumes where it left off. Built for a few thousand
documents. Past ten thousand this is a vendor's job and Mike should say so
rather than try.

**Over-flagging is the correct bias.** A privileged document produced by
mistake is a waiver and possibly a malpractice claim. A document wrongly
flagged as privileged costs a minute of review. So the model is tuned to raise
its hand too often, and the review screen is built to make clearing a flag
fast.

## Every call is yours

Mike proposes. It never decides. That holds for each privilege identification
and for the final produce-or-withhold call on every document.

The review screen is a queue rather than a summary. Each item shows the
proposed disposition, the requests it answers, and the passage that triggered
it — clickable, opening the document at that page, which Mike already does for
citations elsewhere. You accept, change, or set it aside.

Accepting a batch at once is available for the easy piles, like clear
non-responsive material, because a review with no bulk action does not get
finished. It is still an affirmative act by a person. Anything carrying a
privilege flag is reviewed one at a time.

The rule underneath all of it: **a document nobody has looked at cannot end up
in a production.** If a decision is missing the document is held back, not
released. Every decision records who made it and when, and that record is kept
whether or not it matches what Mike proposed.

## Building the production

Once the decisions are locked:

1. Accepted documents are **copied** into a production folder in the matter.
   Copied, never moved. The matter file stays as it was.
2. Everything becomes a PDF. Word files, images and scans already have a PDF
   rendition, so this is mostly done already.
3. You set the order. Bates numbers run in that order, so the order is frozen
   at this point.
4. Pages are stamped, bottom right by default, on a small opaque patch so the
   number never lands on top of existing text. A confidentiality legend goes
   underneath where the protective order calls for one, per document.
5. Output is either **one combined PDF** for the whole production or **a
   stamped file per document**, your choice per production. The numbering is
   identical either way.
6. An **index spreadsheet** is produced for your files — each document, its
   Bates range, its date, and which requests it answers. This is a work tool
   and is not part of what goes to the other side.

Duplicate copies of the same document are detected for free, because Mike
already stores a fingerprint of every file's contents. Near-duplicates are not,
and that is honest to say out loud.

## The numbering rules that cannot bend

- **A number is never reused.** The counter lives on the matter and only moves
  forward, whatever happens to the production afterwards.
- **Numbers are recorded, not recalculated.** Which page got which number is
  stored at the moment of stamping. Regenerating a production two years later
  has to produce identical numbering, and that is only guaranteed if it is read
  back rather than derived again.
- **A production is never renumbered.** Missed documents go out as a
  supplemental production starting after the last number used. Renumbering
  would break every reference anyone has made to the set.
- **Prefixes belong to a matter**, so two matters cannot collide.

## The privilege log and the written responses

Everything withheld becomes a privilege log entry: date, type of document,
author, recipients, a description of the subject matter that does not itself
give away the privileged content, the privilege asserted, and the requests it
would otherwise answer.

Kansas has no standard log format, so the build captures the fields and keeps
the **layout swappable**. When a preferred form exists it goes into the firm's
form bank like any other template, and the log is rendered into it. Getting the
fields right is the work; the shape on the page is a template change.

The responses and objections document comes last, because it quotes the Bates
ranges the stamping just created — "responsive non-privileged documents are
produced as SMITH000123 through SMITH000456". It is assembled request by
request from the objections you settled at the start plus what was actually
produced, using the letterhead and form bank machinery that already exists.

## The order of work

| | Piece | Size | Why here |
| --- | --- | --- | --- |
| 1 | The people list and request parsing | Medium | Everything downstream is wrong if this is wrong |
| 2 | Objections and limits per request | Small | Cheap once 1 exists, and the review needs it |
| 3 | The review run | Large | The engine; builds on tabular review |
| 4 | The decision queue | Medium | Where the attorney actually works |
| 5 | Production assembly and Bates stamping | Medium | Needs one new library that writes PDFs |
| 6 | Privilege log and index | Small | Falls out of the decisions already recorded |
| 7 | Responses and objections document | Medium | Needs the Bates ranges from 5 |

Pieces 1 and 2 are usable on their own — settling objections against a parsed
request list is worth having even with no review behind it. Piece 5 could be
built early as a standalone stamping tool if there is a production to get out
before the rest exists.

## Deliberately not in this version

- **Spreadsheets.** Mike has no PDF version of a spreadsheet on purpose,
  because a wide one paginates badly and printing it loses formulas and hidden
  columns. These stay a human job for now — pulled, checked and produced by
  hand, outside the automated set.
- **Email.** Mike has no concept of an attachment belonging to a parent
  message, so families will not travel together or take consecutive numbers.
  Also a human job for now. Revisit alongside feature 3.
- **Redactions.** A document that is responsive but partly privileged is
  withheld whole and logged. Producing it with passages blacked out means
  burning them in so the text cannot be recovered underneath, and that is the
  highest-stakes thing on this page to get wrong. Its own phase, later.
- **Load files.** No Concordance DAT or OPT export. Add it when an opponent
  actually asks.
- **Clawback handling.** If something privileged goes out, the response is a
  letter and a process, not a button.

## What to watch

- **A bad scan reviewed as though it were accurate.** Mike already warns when a
  scan is too low-resolution to read reliably. That warning has to reach the
  review screen, because a document whose text came out as noise will look
  non-responsive to any model.
- **A stale people list.** New lawyers appear mid-case. If the list is set once
  and forgotten, the documents reviewed after that point are screened against
  the wrong names — and nothing about the output will look wrong.
- **Cost.** Reading a few thousand documents through a model is real money.
  Estimate before the run, not after. Using a cheap model for the first pass is
  tempting and fine for responsiveness, but privilege work should stay on the
  strongest model available.
- **The model's proposal is not a legal judgment**, and nothing in the
  interface should suggest otherwise. It is a first pass by a fast reader who
  has read the ground rules. The lawyer's acceptance is what makes it a
  decision.

## Done when

A real discovery request is loaded, the people list is settled, objections are
agreed against each request, every document in a matter is reviewed and every
disposition accepted by a person, a production comes out as both a combined PDF
and a separate stamped set with continuous numbering, the privilege log covers
everything held back, the responses quote the right Bates ranges, and
re-running the export gives byte-identical numbering.

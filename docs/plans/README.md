# Where this version of Mike is going

Mike is an open legal AI platform (AGPL-3.0) from Open-Legal-Products. This is
our version of it, running at `chat.wardtechnologies.online`. These documents
say what we are adding and in what order.

Each numbered document covers one feature: what you would see, why it matters,
what it takes to build, and how we will know it is finished.

## The rule that keeps updates cheap

The original project ships security fixes only on its main line and does not
back-port them, so we have to keep pulling their changes in. That is easy as
long as we mostly add files rather than edit theirs.

**New work goes in new files. Their files get the smallest edit that will do.**

The OCR work is the pattern: two new files of our own, plus four small edits in
theirs. Only those four can ever collide when we take an update.

Secrets never go in the repository. The live server's keys live in
`docker-compose.override.yml`, which is excluded from git;
`docker-compose.override.example.yml` shows the shape without the values.

## Done

- **Reading scans and photographs.** Images and plain text can be uploaded, and
  anything without a text layer is read automatically so it can be quoted and
  cited by page. Deployed 18 August 2026.

## The order of work

| | Feature | Size | Why here |
| --- | --- | --- | --- |
| 1 | [Search across a matter](01-search-across-a-matter.md) | Large | Everything else gets better once Mike can find things it was not handed |
| 2 | [Comparing two documents](02-document-comparison.md) | Small | Daily transactional work, and cheap to build |
| 3 | [Email as documents](03-email-as-documents.md) | Small | The correspondence is usually half the matter file |
| 4 | [Accounts and permissions](04-accounts-and-permissions.md) | Medium | Nobody else at the firm can safely use Mike until this exists |
| 5 | [OneDrive and SharePoint](05-onedrive-and-sharepoint.md) | Large | Needs 1 and 4 first, or it just makes a bigger pile |
| 6 | [Transcripts and chronologies](06-transcripts-and-chronologies.md) | Medium | Litigation work Mike cannot do at all today |
| 7 | [Workflows for our practice](07-practice-workflows.md) | Small each | Uses machinery that already exists |
| 8 | [Deadline calculation](08-deadline-calculation.md) | Medium | Narrow, checkable, and useful every week |
| 9 | [Discovery and productions](09-discovery-and-productions.md) | Large | The whole chain, ending in documents that can go out the door |

Sizes are rough: **small** is a sitting or two, **medium** is several,
**large** is a project measured in weeks with checkpoints along the way.

## Deliberately not doing

- **Letting the AI look at pictures.** Parked. Reading the words out of an image
  covers the legal work; genuinely seeing a photograph or a diagram is a much
  larger change, only works on some models, and does not fit citation
  discipline. Revisit if exhibit photographs become a real need.
- **A phone app.** The web app works in a phone browser.
- **Competing on scale.** The original's commercial rivals handle productions of
  a hundred thousand documents. Not our problem unless it becomes one.
- **A general legal research product.** Our case-law and statute tools already
  answer with real sources, which is the part that matters.

## The known gap we cannot close ourselves

There is no free authoritative source for state statutes. Federal regulations
and federal statutes work. State law means either a paid service or downloading
from the legislature by hand. This is a purchasing decision, not a build.

# 5. OneDrive and SharePoint

**Size: large.** Needs accounts and permissions first, and search to be worth it.

## What you would see

Point a matter at its folder in the firm's OneDrive or SharePoint. The files
appear in Mike as matter documents, stay up to date, and new versions arrive as
versions. Nobody re-uploads anything.

## Why it waits

Two things have to exist first, or this actively makes matters worse:

- **Accounts and permissions.** Connecting firm files to a system with one
  shared account and open registration is not something to do.
- **Search across a matter.** Without it, syncing three hundred files gives you
  three hundred files Mike cannot look inside.

## The groundwork is already there

A matter already records a client-matter number and who it is shared with.
Every document already records where it came from and a fingerprint of its
contents, with full version history. "This came from OneDrive, here is which
version, it changed on Tuesday" is something the design already expects.

## Two ways in, and we should do both, in order

**First, as a connector.** Mike gains the ability to search the firm's files and
open one mid-conversation. Quick to stand up, stores no copies, and it tells us
how people actually use it before we commit to the larger thing. What it cannot
do is make those files properly part of a matter — no page citations, no
redlines, no review grids.

**Then, linked folders.** A matter is pointed at a folder and the files become
real documents in it, kept current. This is the feature as described, and the
bigger build: signing in with Microsoft, permissions, a sync that notices
changes, and decisions about what a deletion at the firm means here.

## What to watch

- **Each person signs in as themselves**, so Mike sees only what that person can
  already see and the ethical walls hold. The alternative gives the server
  blanket access to every matter in the firm. Not negotiable.
- **Where the text goes.** Matter files are sent to whichever AI backend is
  configured. For privileged material that is a professional-responsibility
  decision, not a technical one, and it should be settled before real matters
  are involved.
- **Disk.** The machine has about 29 GB free. Syncing matter folders wholesale
  will fill it. Fetch on demand, or sync chosen folders only.
- **Deletion.** If a file disappears at the firm, does it disappear here? Decide
  deliberately; the safe answer is to hide it and keep the record.

## Done when

A matter is linked to a real folder, its files are readable and citable in Mike,
a change at the firm shows up here as a new version, and a person not on the
matter cannot see any of it.

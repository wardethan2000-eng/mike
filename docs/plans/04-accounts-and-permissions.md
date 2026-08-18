# 4. Accounts and permissions

**Size: medium.** Nothing else at the firm can happen safely until this exists.

## Where things stand

Mike has one account — yours. Anyone who finds the web address can still
register, because sign-up was never closed. There is a notion of sharing a
matter with named people in the database, but no accounts to share with and no
check that stops someone opening a matter they should not see.

For a firm that is the whole ball game. Ethical walls are not a feature
request; they are the reason a matter can be on the system at all.

## What you would see

- You invite someone; they sign in with their own account.
- Every matter has people on it. If you are not on it, you cannot see it, it
  does not appear in search, and the assistant will not read from it.
- An administrator can see who has access to what, and take it away.
- Signing in uses the firm's Microsoft accounts, so there is no second password
  and access ends when someone leaves.

## How it would work

1. **Close sign-up.** Ten minutes, and it should not wait for the rest.
2. **Invitations**, so accounts exist because someone was asked in.
3. **Enforce matter access on every route.** The important half. Every place
   that reads a document, searches, or answers a question has to ask the same
   question first: is this person on this matter? One shared check, used
   everywhere, is the only way this stays true as things get added.
4. **Roles** — at least administrator and ordinary user.
5. **Sign in with Microsoft**, once the rest is solid.
6. **An access record**: who opened what, and when. The audit trail already
   exists and mostly needs surfacing.

## What to watch

- **Test that it refuses.** The valuable tests here are the ones that prove
  someone cannot reach a matter they are not on — including through search,
  through the assistant, and through a direct link to a file.
- **Sharing must be deliberate.** Default to private; opening a matter up is an
  action someone takes, never a default.
- **Do this alongside search, not after it.** Retro-fitting permissions onto a
  search index is how things leak.

## Done when

Two accounts exist on separate matters, and neither can reach the other's
documents by any route — interface, search, assistant or direct link — and the
attempts are recorded.

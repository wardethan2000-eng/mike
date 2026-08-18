# 8. Deadline calculation

**Size: medium.** Narrow, checkable, and useful most weeks.

## What you would see

"Response to a motion to dismiss, served 14 March 2026, Kansas state court" and
get the date, along with the rule it comes from, how weekends and holidays were
handled, and what the trigger was — so you can check the reasoning rather than
trust it.

## Why this one is worth building

Most AI legal features are hard to check. This one is not: the answer is a
single date reached by a stated rule, and it is either right or wrong. That
makes it a good candidate to trust with a real workflow, and a bad one to guess
at — which is exactly why it should be calculated, not asked of a model.

Mike already reaches the Kansas and Missouri statutes through its statute tools,
so the rule text is available. The mistake would be to let the AI do the
arithmetic from memory.

## How it would work

The counting is done by ordinary arithmetic, not by the model: take a trigger
date and a period, count forwards or backwards in the direction the rule
specifies, skip weekends and court holidays where the rule says so, and roll
forward when the last day falls on one. The AI's job is only to work out which
rule applies and hand over the numbers, then explain the result in words.

That split matters: the part that must be exactly right is arithmetic, and the
part that needs judgement is choosing the rule.

## What is involved

1. A calculator with the counting rules — calendar days, court days, backwards
   counting, the roll-forward rule.
2. A court holiday calendar per jurisdiction. This is the tedious part, and it
   needs updating every year.
3. Make it something the assistant can call, so a date can be asked for in
   conversation.
4. Always show the working: rule, trigger, method, holidays applied.

## What to watch

- **Start with the jurisdictions we actually practise in**, and refuse the rest
  plainly rather than guessing.
- **The holiday calendar goes stale.** Whatever we build should say how old its
  calendar is, and warn when it is out of date.
- **Never present a computed date as advice.** It is a calculation to be checked,
  and it should say so.

## Done when

A dozen real deadlines across our jurisdictions are calculated correctly,
including at least one counted backwards and one landing on a holiday, each
answer showing its rule and its working.

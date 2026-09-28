---
name: second-look
description: Before handing finished work to a person (a pull request, a web page, a report, social drafts, a spreadsheet), run mechanical checks and send it to a fresh-eyes breaker agent that never saw how it was made. Use when work is done and about to be delivered, or when someone asks for a second look, a review, or "try to break it".
---

# Second look

The builder is the worst person to judge the work: they test what they thought of and miss the same things twice. This skill gets the work in front of eyes that didn't make it, plus a few checks that don't need eyes at all.

Paths below are relative to this plugin's root (two folders up from this file): `checks/`, `agents/breaker.md`, `misses.md`.

## 1. Pin down what was asked

Write down the original request **in the requester's words**, not your summary of what you built. If the conversation refined it ("also make it work on phones"), include that too. This is the yardstick. Your interpretation is not.

## 2. Run the mechanical checks that fit

These are cheap, fast, and don't get tired. Run every one that applies:

| The work includes | Run |
|---|---|
| Web pages (new or changed) | `node checks/page-check.mjs <url> [more urls] --out <dir>`: phone widths with normal and 130% text, sideways overflow, cut-off content, JS errors, failed requests, titles. Add `--links` to test links. Look at the screenshots. |
| Text with dates, numbers, totals, percentages (reports, posts, schedules) | `python3 checks/claims_check.py <file>`, or pipe text in with `-`. |
| Code | The project's own build, type check, lint and tests. |

For local pages, start the app on a spare port and check against `http://localhost:<port>`. Check the pages the change touches, the home page, and at least one page as a logged-out visitor.

Anything that FAILs here, fix before going further (or note why it isn't real). Don't send the breaker work that a script can already see is broken.

## 3. Send it to the breaker

Launch a subagent (the Agent tool). Use the `breaker` agent type if it's installed; otherwise use a general-purpose agent and paste the full contents of `agents/breaker.md` at the top of its prompt.

Brief it with **only**:
- the ask from step 1, verbatim;
- where the work lives (branch name and repo path, URL, file paths, draft IDs);
- how to run it (start command, port, test command) if it isn't obvious;
- constraints (never publish, never delete, read-only on production);
- the path to `misses.md`.

**Do not** include your reasoning, your design choices, what you already tested, or what you think might be weak. That's the builder's view, and the breaker is only useful because it doesn't have it. Resist the urge to "help" it.

## 4. Check the breaker's findings

Reproduce each finding yourself before acting on it. The breaker can be wrong too. For each one:
- **Real:** fix it, then rerun the check that caught it.
- **Not real:** drop it, and note in one line why (so a false alarm doesn't come back).
- **Can't tell:** tell the person, plainly, as an open question.

## 5. Write down what you missed

If the breaker or a mechanical check caught something real that you would have delivered, add it to `misses.md`: what happened and the check that catches it next time. One or two lines. This is how the next review gets sharper. If a script could have caught it, consider adding that check to `checks/` with a test.

## 6. Tell the person

Deliver the work with one or two lines on the second look: what it caught and fixed, and anything still open. Don't dump the whole report unless they ask.

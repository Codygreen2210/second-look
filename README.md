# second-look

**See your site the way real visitors do, before they do.**

AI builders (Claude, Cursor, Lovable, Bolt, v0) make pages that look fine on your laptop and break on a real phone. The worst ones show up only when a visitor has **larger text turned on** in their phone settings, which lots of people do. You'll never see those bugs on your own screen.

second-look loads your page at real phone widths, twice each (normal text, then text at 130%), and tells you in plain words what broke:

```
$ npx second-look https://yoursite.com

https://yoursite.com
  FAIL [360px, text 130%] content cut off at the screen edge:
      a.card "Hunting, fishing, camping, hiking, boa…"  spans 16→421px

1 FAIL finding(s)
```

## What it catches

At 360px, 412px and desktop, with normal and larger text:

- **Content cut off** at the screen edge, including content hidden by `overflow: hidden`, which *looks* fine but isn't
- **Words spilling out** of a box that itself fits (long words in big headings)
- **Pages that scroll sideways** on phones
- **JavaScript errors**, files that fail to load, and **broken links** (`--links`)
- **Tiny tap targets** and **tiny text** on phones
- Missing page titles, descriptions, alt text and headings

And one trap most tools fall into: if your web fonts fail to load, a fallback font with different widths makes perfectly good layouts *look* broken. second-look **warns you** instead of crying wolf. Supply the real font with `--font` to confirm.

## Use it

**Anywhere (Node 18+):**

```
npx playwright install chromium     # once
npx second-look https://yoursite.com --out screens/
```

Screenshots of every width go in `screens/`. The exit code is 1 when anything fails, so it can gate a pull request or a deploy.

Options: `--widths 360,412,1280`, `--links` (test every link), `--json`, `--no-big-text`, `--font "Family=path/to/font.woff2"`, `--ignore <regex>`.

**In Claude Code:**

```
/plugin marketplace add Codygreen2210/second-look
/plugin install second-look
```

Then ask Claude for "a second look" when work is done. The plugin also includes:
- a **claims checker** for reports and posts (weekdays that don't match their dates, math that doesn't add up, wrong percentages, unsourced stats), and
- a **breaker agent**: a reviewer that only gets what was asked for and where the work is, never how it was made, so it can't share the builder's blind spots.

## Why it exists

It was built after a real bug: a site's Join button was cut off on small phones with larger text turned on. The owner was always logged in, used default text size, and never saw it. Every test looked fine.

`misses.md` is the notebook of real mistakes like that one, each with the check that now catches it. The checker's own test suite plants each bug and makes sure it's caught.

## Honest limits

- It checks what a page **looks like** and whether it loads cleanly. It doesn't click through your app's flows (logins, checkout). Tools like TestSprite do that.
- Automated checks catch a lot but not everything. Look at the screenshots.
- It runs Chromium only. Safari-only bugs won't show up yet.

## License

MIT. Built by Cody Green with Claude.

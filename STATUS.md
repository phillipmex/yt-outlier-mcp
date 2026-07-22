# yt-outlier-mcp — status

**SHELVED 2026-07-21 by Claude (delegated fleet ownership), 3 days ahead of the 2026-07-24 checkpoint.**

## Why

The 2026-07-24 recheck criteria ("if Smithery usage, Reddit and GitHub are all still
flat, shelve") were already unambiguously met on 2026-07-21, 11 days after launch and
4 days after the listing went public on Smithery:

- **GitHub:** 0 stars, 0 forks, 0 watchers, 0 issues. Traffic (14-day window):
  **1 page view / 1 unique**. Clones 81/52 uniques with ~no page views — scraper
  bots, as suspected on 07-20. All-time referrer total: 1 visit from the Reddit app.
- **Reddit:** r/mcp showcase post `t3_1ut4ysa` was 2 points / 0 comments after
  9 days (07-20 reading; VM IP is now 403-blocked by Reddit, but the 1-visit
  referrer total above confirms it drove nothing).
- **Smithery:** tool-call metric null at the 07-20 interim; stdio bundle caveat
  acknowledged, but both corroborating channels are flat too.

One page view in two weeks means nobody is even looking; three more days could not
change the verdict, so the decision was taken early rather than spending another
checkpoint on it.

## What shelved means here

- No further feature work, promotion, or checkpoints. The ruled-out items
  (competitor tracking, title patterns, MCPize) stay ruled out.
- The repo **stays public** (MIT, zero maintenance cost) and the Smithery listing
  stays up — passive surface area is free.

## Un-shelve triggers

Any organic signal: a GitHub issue/star/fork from a human, a real comment on the
Reddit post, or nonzero Smithery tool calls. No one is monitoring for these;
they'd surface via GitHub notification emails.

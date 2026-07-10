# yt-outlier-mcp

MCP server that finds **YouTube outlier videos**: videos on small channels
(≤100K subs) with one video massively outperforming both the channel's
subscriber base (≥5:1 views:subs) and the channel's own recent uploads. That
signature means the recommendation algorithm rewarded the **format**, not an
existing audience — so the format is replicable by a new channel.

The method is the "Icon Method" qualifying criteria proven manually on
@Before-You-Start (see `hobby-channel/IDEAS.md`); this server automates it as
one MCP tool. Origin: idea #2 in `_ideas/next-batch.html` (paid MCP servers).

## Tool: `find_outliers`

| Input | Default | Meaning |
|---|---|---|
| `query` | (required) | Topic phrase, e.g. `"beginner mistakes sourdough"` |
| `maxSubs` | 100,000 | Max channel subscribers |
| `minViews` | 100,000 | Min video views |
| `minRatio` | 5 | Min views:subs ratio |
| `publishedWithinDays` | 365 | Freshness window (older outliers are stale evidence) |
| `minOutlierFactor` | 3 | Video views vs. median of channel's other recent uploads |
| `maxResults` | 10 | Cap on returned outliers |

Pipeline per call: `search.list` (order=viewCount, the expensive call) →
batch `videos.list` + `channels.list` → cheap-filter by views/subs/ratio →
for survivors, pull the uploads playlist and compare against the channel's
median recent-upload views (the outlier-vs-baseline check that separates a
breakout format from a big channel's normal video).

Output per outlier: URL, views, subs, ratio, channel median views,
outlier factor, comments-enabled flag (comments are the manual demand-signal
step), channel video count, plus total quota units consumed.

## Tool: `get_video_structure`

Icon Method verification step 2 — extract the replicable format instead of
guessing it. Takes a video ID or URL; returns duration, tags, chapters
(parsed from `0:00 Intro`-style description lines), the description, and the
transcript. Costs **1 quota unit**; the transcript itself is fetched outside
the Data API at zero quota (`captions.download` needs owner OAuth, so the
server asks the InnerTube player endpoint as the ANDROID client — unofficial,
returns `transcript: null` gracefully if YouTube ever gates it).

| Input | Default | Meaning |
|---|---|---|
| `video` | (required) | Video ID or URL (watch/shorts/youtu.be forms) |
| `includeTranscript` | true | Fetch the transcript |
| `maxTranscriptChars` | 15,000 | Truncation cap |

## Tool: `get_comment_signal`

Icon Method verification step 3 — comments prove unmet demand, not just
views. Returns the top relevance-ordered comments (author, text, likes,
replies) plus quick counts: comments asking questions and comments using
demand phrasing ("please make…", "part 2", "how do you…"). Handles
comments-disabled videos gracefully. Costs **1 quota unit**.

| Input | Default | Meaning |
|---|---|---|
| `video` | (required) | Video ID or URL |
| `maxComments` | 30 | Top comments to fetch (max 100) |

## Setup

```sh
npm install
npm run build
```

Configure in a client (Claude Code example):

```sh
claude mcp add yt-outliers -e YOUTUBE_API_KEY=<key> -- node <abs-path>/dist/index.js
```

**BYO key:** needs a YouTube Data API v3 key (`.env.example`). Free quota is
10,000 units/day; one `find_outliers` call costs ~110–130 units (search=100,
everything else 1/call), so ~75–90 searches/day. The BYO-key model is what
makes this sellable without a Google quota-extension audit.

## Roadmap

- [x] Live-test tool against real niches (2026-07-10: 4 real outliers on
      "beginner mistakes sourdough", 110 units/call as predicted)
- [x] Phase 2 tools: `get_video_structure` (chapters/transcript) and
      `get_comment_signal` (top comments → demand resonance) to automate
      Icon Method verification steps 2–3 (2026-07-10, live-tested)
- [ ] `search_niche_sweep`: rotate one phrase template across hobby clusters
- [ ] List on Smithery (free discovery) + MCPize (hosting/billing, 85% rev share)

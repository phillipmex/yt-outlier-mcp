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
| `minQueryRelevance` | 0 (off) | Min fraction of query terms found in title/description/tags; `0.5` cuts off-topic noise |
| `maxResults` | 10 | Cap on returned outliers |

Pipeline per call: `search.list` (order=viewCount, the expensive call) →
batch `videos.list` + `channels.list` → cheap-filter by views/subs/ratio →
for survivors, pull the uploads playlist and compare against the channel's
median recent-upload views (the outlier-vs-baseline check that separates a
breakout format from a big channel's normal video).

Output per outlier: URL, views, subs, ratio, channel median views,
outlier factor, `queryRelevance` (fraction of query terms found in
title/description/tags — always reported, filtered only if
`minQueryRelevance` > 0; costs zero extra quota since the snippet is already
fetched), comments-enabled flag (comments are the manual demand-signal
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

## Tool: `search_niche_sweep`

Runs `find_outliers` once per niche by substituting each niche into a phrase
template, then ranks every hit across all niches by views:subs ratio — the
niche that keeps appearing up top is where the replicable format lives.
**Expensive**: each niche is a full search (~110–130 units), max 8 niches per
sweep. Per-niche API errors are recorded without killing the sweep; a
quota-exhausted error aborts the remaining niches with a note.

| Input | Default | Meaning |
|---|---|---|
| `template` | (required) | Phrase containing `{niche}`, e.g. `"beginner mistakes {niche}"` |
| `niches` | (required) | 1–8 niches to substitute |
| `maxResultsPerNiche` | 5 | Cap per niche |
| filters | same as `find_outliers` | `maxSubs`, `minViews`, `minRatio`, `publishedWithinDays`, `minOutlierFactor`, `minQueryRelevance` |

## Tool: `get_channel_baseline`

The inverse entry point: you already have a suspect channel (from a
competitor, a comment, another tool) instead of a topic query. Computes the
channel's baseline — median views of its recent uploads — and scores every
recent upload against it, flagging outliers. **Cheap: ~3 quota units** (no
`search.list` call). Accepts channel ID, `@handle`, or channel URL.

| Input | Default | Meaning |
|---|---|---|
| `channel` | (required) | Channel ID (`UC…`), `@handle`, or channel URL |
| `recentUploads` | 15 | Recent uploads to fetch for the baseline (3–50) |
| `minOutlierFactor` | 3 | Flag uploads at ≥ this multiple of the channel median |

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
- [x] `search_niche_sweep`: rotate one phrase template across hobby clusters
      (2026-07-10, live-tested: 2-niche sweep = 210 units, cross-niche ranking works)
- [x] List on Smithery (2026-07-10): live at
      [smithery.ai/servers/phillipmex3/yt-outlier-mcp](https://smithery.ai/servers/phillipmex3/yt-outlier-mcp).
      MCPize deferred (their SDK/hosting required; actual rev share 80%, not the
      85% marketed) — revisit if Smithery shows install signal.

## Publishing note

Smithery's registry requires each `tools[]` entry in `manifest.json` to carry an
`inputSchema`, but `npx @anthropic-ai/mcpb pack` rejects that key as invalid.
Workaround used here: pack the bundle from a manifest **without** the schemas,
then replace `manifest.json` inside the `.mcpb` (it's a plain zip) with the
schema-bearing version in this repo before `smithery mcp publish`.

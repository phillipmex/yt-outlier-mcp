#!/usr/bin/env node
// yt-outlier-mcp — MCP server exposing find_outliers: locate videos on small
// channels (≤100K subs) that massively outperform both the channel's size
// (views:subs ratio) and its own baseline (vs. median of recent uploads).
// Method source: hobby-channel IDEAS.md "Icon Method" qualifying criteria.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  QuotaTracker,
  fetchTranscript,
  getChannelStats,
  getRecentUploads,
  getTopComments,
  getVideoDetails,
  getVideoStats,
  searchVideos,
} from "./youtube.js";

interface OutlierResult {
  videoId: string;
  url: string;
  title: string;
  channelTitle: string;
  channelUrl: string;
  publishedAt: string;
  views: number;
  subs: number;
  viewsToSubsRatio: number;
  channelMedianViews: number | null;
  outlierFactor: number | null; // views / median of channel's other recent uploads
  commentsEnabled: boolean;
  channelVideoCount: number;
}

const server = new McpServer({ name: "yt-outlier-finder", version: "0.3.0" });

const MISSING_KEY = {
  isError: true as const,
  content: [
    {
      type: "text" as const,
      text: "YOUTUBE_API_KEY is not set. Provide a YouTube Data API v3 key via environment variable (see .env.example).",
    },
  ],
};

/** Accept a bare 11-char video ID or any common YouTube URL form. */
function parseVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

interface Chapter {
  timestamp: string;
  seconds: number;
  title: string;
}

/** Parse "0:00 Intro"-style chapter lines out of a video description. */
function parseChapters(description: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of description.split("\n")) {
    const m = line.match(
      /^\s*[-•*]?\s*\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:.]?\s*(\S.*)$/,
    );
    if (!m) continue;
    const parts = m[1].split(":").map(Number);
    const seconds = parts.reduce((acc, p) => acc * 60 + p, 0);
    chapters.push({ timestamp: m[1], seconds, title: m[2].trim() });
  }
  // Real chapter lists start at 0:00 and have several entries; a lone
  // timestamp in a description is usually just prose.
  return chapters.length >= 2 && chapters[0].seconds === 0 ? chapters : [];
}

interface OutlierSearchOpts {
  query: string;
  maxSubs: number;
  minViews: number;
  minRatio: number;
  publishedWithinDays: number;
  minOutlierFactor: number;
  maxResults: number;
}

// Shared engine behind find_outliers and search_niche_sweep.
async function runOutlierSearch(
  apiKey: string,
  quota: QuotaTracker,
  opts: OutlierSearchOpts,
): Promise<OutlierResult[]> {
  const publishedAfter = new Date(
    Date.now() - opts.publishedWithinDays * 86_400_000,
  ).toISOString();

  // 1. Search (the expensive call: 100 units)
  const videoIds = await searchVideos(
    apiKey,
    quota,
    opts.query,
    publishedAfter,
    50,
  );
  if (videoIds.length === 0) return [];

  // 2. Hydrate video + channel stats, apply the cheap filters
  const videos = await getVideoStats(apiKey, quota, videoIds);
  const channels = await getChannelStats(apiKey, quota, [
    ...new Set([...videos.values()].map((v) => v.channelId)),
  ]);

  const candidates = [...videos.values()]
    .map((v) => ({ video: v, channel: channels.get(v.channelId) }))
    .filter(
      (c): c is { video: (typeof c)["video"]; channel: NonNullable<(typeof c)["channel"]> } =>
        c.channel !== undefined &&
        c.channel.subs !== null && // hidden sub counts can't prove the ratio
        c.channel.subs <= opts.maxSubs &&
        c.video.views >= opts.minViews &&
        c.video.views / Math.max(c.channel.subs, 1) >= opts.minRatio,
    )
    .sort(
      (a, b) =>
        b.video.views / Math.max(b.channel.subs!, 1) -
        a.video.views / Math.max(a.channel.subs!, 1),
    )
    // Baseline checks cost ~2 units each — cap how many we verify
    .slice(0, opts.maxResults * 2);

  // 3. Outlier-vs-baseline check: compare against median of the channel's
  //    other recent uploads (a big video on a channel whose EVERY video is
  //    big proves nothing about the format).
  const outliers: OutlierResult[] = [];
  for (const { video, channel } of candidates) {
    if (outliers.length >= opts.maxResults) break;

    let medianViews: number | null = null;
    let factor: number | null = null;
    if (channel.uploadsPlaylistId) {
      const uploadIds = (
        await getRecentUploads(apiKey, quota, channel.uploadsPlaylistId, 15)
      ).filter((id) => id !== video.videoId);
      if (uploadIds.length >= 3) {
        const uploadStats = await getVideoStats(apiKey, quota, uploadIds);
        const views = [...uploadStats.values()]
          .map((v) => v.views)
          .sort((a, b) => a - b);
        medianViews = views[Math.floor(views.length / 2)];
        factor =
          medianViews > 0 ? video.views / medianViews : Number.POSITIVE_INFINITY;
        if (factor < opts.minOutlierFactor) continue;
      }
      // <3 other uploads: channel is basically this one video — that IS the
      // outlier signature (idea6's azcheckers case), so keep it unverified.
    }

    outliers.push({
      videoId: video.videoId,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      title: video.title,
      channelTitle: channel.title,
      channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
      publishedAt: video.publishedAt,
      views: video.views,
      subs: channel.subs!,
      viewsToSubsRatio:
        Math.round((video.views / Math.max(channel.subs!, 1)) * 10) / 10,
      channelMedianViews: medianViews,
      outlierFactor: factor === null ? null : Math.round(factor * 10) / 10,
      commentsEnabled: video.comments !== null,
      channelVideoCount: channel.videoCount,
    });
  }
  return outliers;
}

server.registerTool(
  "find_outliers",
  {
    title: "Find YouTube outlier videos",
    description:
      "Search YouTube for a topic phrase and return videos on small channels " +
      "that hugely outperform the channel's subscriber base and its own recent " +
      "uploads — evidence the FORMAT drove the views (replicable by a new " +
      "channel), not an existing audience. Defaults encode the Icon Method " +
      "criteria: ≥100K views, channel ≤100K subs, ≥5:1 views:subs, uploaded " +
      "within the last year. Costs ~110-130 YouTube API quota units per call " +
      "(free daily quota: 10,000).",
    inputSchema: {
      query: z
        .string()
        .min(2)
        .describe(
          'Topic search phrase, e.g. "beginner mistakes sourdough" or "how to win backgammon"',
        ),
      maxSubs: z
        .number()
        .int()
        .positive()
        .default(100_000)
        .describe("Maximum channel subscriber count"),
      minViews: z
        .number()
        .int()
        .positive()
        .default(100_000)
        .describe("Minimum video view count"),
      minRatio: z
        .number()
        .positive()
        .default(5)
        .describe("Minimum views-to-subscribers ratio"),
      publishedWithinDays: z
        .number()
        .int()
        .positive()
        .default(365)
        .describe("Only consider videos uploaded within this many days"),
      minOutlierFactor: z
        .number()
        .positive()
        .default(3)
        .describe(
          "Video views must be at least this multiple of the channel's median recent-upload views",
        ),
      maxResults: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe("Maximum outliers to return"),
    },
  },
  async (args) => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return MISSING_KEY;

    const quota = new QuotaTracker();
    const outliers = await runOutlierSearch(apiKey, quota, args);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query: args.query,
              criteria: {
                maxSubs: args.maxSubs,
                minViews: args.minViews,
                minRatio: args.minRatio,
                publishedWithinDays: args.publishedWithinDays,
                minOutlierFactor: args.minOutlierFactor,
              },
              outliers,
              quotaUnitsUsed: quota.units,
              note:
                "outlierFactor=null means the channel had <3 other uploads to " +
                "compare against (one-video channel — strong outlier signature " +
                "but verify manually). Next steps per Icon Method: call " +
                "get_comment_signal for demand resonance and " +
                "get_video_structure for the replicable format.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "get_video_structure",
  {
    title: "Get a video's replicable structure",
    description:
      "Fetch what makes an outlier video's format copyable: duration, " +
      "chapters (parsed from the description), tags, and the transcript. " +
      "Icon Method verification step: extract the structure, don't guess it. " +
      "Costs 1 YouTube API quota unit (transcript is fetched outside the API " +
      "at zero quota and may be unavailable for some videos).",
    inputSchema: {
      video: z
        .string()
        .min(4)
        .describe("YouTube video ID or URL (watch/shorts/youtu.be forms)"),
      includeTranscript: z
        .boolean()
        .default(true)
        .describe("Fetch the transcript (slower; adds no quota cost)"),
      maxTranscriptChars: z
        .number()
        .int()
        .positive()
        .default(15_000)
        .describe("Truncate the transcript to this many characters"),
    },
  },
  async (args) => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return MISSING_KEY;

    const videoId = parseVideoId(args.video);
    if (!videoId) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Could not parse a video ID from "${args.video}".` },
        ],
      };
    }

    const quota = new QuotaTracker();
    const details = await getVideoDetails(apiKey, quota, videoId);
    if (!details) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Video ${videoId} not found (deleted or private).` },
        ],
      };
    }

    const transcript = args.includeTranscript
      ? await fetchTranscript(videoId)
      : null;
    const truncated =
      transcript !== null && transcript.text.length > args.maxTranscriptChars;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              title: details.title,
              channelTitle: details.channelTitle,
              publishedAt: details.publishedAt,
              durationSeconds: details.durationSeconds,
              views: details.views,
              tags: details.tags,
              chapters: parseChapters(details.description),
              description: details.description.slice(0, 2_000),
              transcript:
                transcript === null
                  ? null
                  : {
                      source: transcript.source,
                      language: transcript.language,
                      truncated,
                      text: transcript.text.slice(0, args.maxTranscriptChars),
                    },
              transcriptNote:
                transcript === null
                  ? args.includeTranscript
                    ? "No transcript available (no captions, or YouTube blocked the unofficial fetch). Structure analysis must rely on chapters/description."
                    : "Transcript skipped (includeTranscript=false)."
                  : undefined,
              quotaUnitsUsed: quota.units,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Phrases that signal audience demand rather than mere appreciation
const DEMAND_RE =
  /\b(please|pls|more videos?|part (2|two)|next video|tutorial|i wish|wish (you|there)|how (do|did) you|can you (do|make|show)|what about|where (can|do) (i|you))\b/i;

server.registerTool(
  "get_comment_signal",
  {
    title: "Read a video's comment demand signal",
    description:
      "Fetch a video's top comments (relevance-ordered) plus simple demand " +
      "metrics: how many ask questions and how many use demand phrasing " +
      "('please make...', 'part 2', 'how do you...'). Icon Method " +
      "verification step: comments prove the topic has unmet demand, not " +
      "just views. Costs 1 YouTube API quota unit.",
    inputSchema: {
      video: z
        .string()
        .min(4)
        .describe("YouTube video ID or URL (watch/shorts/youtu.be forms)"),
      maxComments: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .describe("Number of top comments to fetch"),
    },
  },
  async (args) => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return MISSING_KEY;

    const videoId = parseVideoId(args.video);
    if (!videoId) {
      return {
        isError: true,
        content: [
          { type: "text", text: `Could not parse a video ID from "${args.video}".` },
        ],
      };
    }

    const quota = new QuotaTracker();
    const comments = await getTopComments(apiKey, quota, videoId, args.maxComments);

    if (comments === null) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                videoId,
                url: `https://www.youtube.com/watch?v=${videoId}`,
                commentsEnabled: false,
                note: "Comments are disabled on this video — no demand signal readable. Per Icon Method that weakens the outlier (comments are the demand-verification step).",
                quotaUnitsUsed: quota.units,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const trimmed = comments.map((c) => ({
      ...c,
      text: c.text.length > 500 ? `${c.text.slice(0, 500)}…` : c.text,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              videoId,
              url: `https://www.youtube.com/watch?v=${videoId}`,
              commentsEnabled: true,
              fetched: trimmed.length,
              signals: {
                questionComments: comments.filter((c) => c.text.includes("?"))
                  .length,
                demandComments: comments.filter((c) => DEMAND_RE.test(c.text))
                  .length,
                totalLikesOnTop: comments.reduce((sum, c) => sum + c.likes, 0),
              },
              comments: trimmed,
              note:
                "Comments are relevance-ordered (YouTube's ranking). Read for " +
                "demand resonance: unanswered questions, requests for " +
                "follow-ups, and 'I was looking for exactly this' energy.",
              quotaUnitsUsed: quota.units,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "search_niche_sweep",
  {
    title: "Sweep a phrase template across niches",
    description:
      "Run the outlier search once per niche by substituting each niche into " +
      'a phrase template (e.g. "beginner mistakes {niche}" across ' +
      "['sourdough', 'bonsai', 'leathercraft']) and rank the hits across all " +
      "niches. Answers: which hobby cluster has a replicable breakout format " +
      "right now? EXPENSIVE: each niche costs a full search (~110-130 quota " +
      "units), so an 8-niche sweep uses ~10% of the 10,000-unit daily free " +
      "quota.",
    inputSchema: {
      template: z
        .string()
        .min(4)
        .refine((s) => s.includes("{niche}"), {
          message: 'template must contain the "{niche}" placeholder',
        })
        .describe(
          'Search phrase template containing "{niche}", e.g. "beginner mistakes {niche}"',
        ),
      niches: z
        .array(z.string().min(2))
        .min(1)
        .max(8)
        .describe(
          "Niches to substitute into the template (max 8 per sweep to cap quota)",
        ),
      maxSubs: z
        .number()
        .int()
        .positive()
        .default(100_000)
        .describe("Maximum channel subscriber count"),
      minViews: z
        .number()
        .int()
        .positive()
        .default(100_000)
        .describe("Minimum video view count"),
      minRatio: z
        .number()
        .positive()
        .default(5)
        .describe("Minimum views-to-subscribers ratio"),
      publishedWithinDays: z
        .number()
        .int()
        .positive()
        .default(365)
        .describe("Only consider videos uploaded within this many days"),
      minOutlierFactor: z
        .number()
        .positive()
        .default(3)
        .describe(
          "Video views must be at least this multiple of the channel's median recent-upload views",
        ),
      maxResultsPerNiche: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Maximum outliers to return per niche"),
    },
  },
  async (args) => {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return MISSING_KEY;

    const quota = new QuotaTracker();
    const perNiche: {
      niche: string;
      query: string;
      outliers?: OutlierResult[];
      error?: string;
    }[] = [];
    let sweepAborted: string | null = null;

    for (const niche of args.niches) {
      const query = args.template.replaceAll("{niche}", niche);
      try {
        const outliers = await runOutlierSearch(apiKey, quota, {
          query,
          maxSubs: args.maxSubs,
          minViews: args.minViews,
          minRatio: args.minRatio,
          publishedWithinDays: args.publishedWithinDays,
          minOutlierFactor: args.minOutlierFactor,
          maxResults: args.maxResultsPerNiche,
        });
        perNiche.push({ niche, query, outliers });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        perNiche.push({ niche, query, error: msg });
        // Out of quota means every remaining search would also fail — stop
        if (/quotaExceeded|dailyLimitExceeded/.test(msg)) {
          sweepAborted =
            "Daily YouTube API quota exhausted mid-sweep; remaining niches were skipped.";
          break;
        }
      }
    }

    // Cross-niche ranking: the whole point of a sweep is comparing clusters
    const topAcrossNiches = perNiche
      .flatMap((n) => (n.outliers ?? []).map((o) => ({ niche: n.niche, ...o })))
      .sort((a, b) => b.viewsToSubsRatio - a.viewsToSubsRatio)
      .slice(0, 10);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              template: args.template,
              criteria: {
                maxSubs: args.maxSubs,
                minViews: args.minViews,
                minRatio: args.minRatio,
                publishedWithinDays: args.publishedWithinDays,
                minOutlierFactor: args.minOutlierFactor,
              },
              nichesSwept: perNiche.length,
              nichesRequested: args.niches.length,
              topAcrossNiches,
              perNiche,
              quotaUnitsUsed: quota.units,
              note:
                (sweepAborted ? `${sweepAborted} ` : "") +
                "topAcrossNiches ranks all hits by views:subs ratio — the " +
                "niche appearing most often up top is where the replicable " +
                "format lives. Verify winners with get_video_structure and " +
                "get_comment_signal.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

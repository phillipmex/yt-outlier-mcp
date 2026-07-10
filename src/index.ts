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
  getChannelStats,
  getRecentUploads,
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

const server = new McpServer({ name: "yt-outlier-finder", version: "0.1.0" });

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
    if (!apiKey) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "YOUTUBE_API_KEY is not set. Provide a YouTube Data API v3 key via environment variable (see .env.example).",
          },
        ],
      };
    }

    const quota = new QuotaTracker();
    const publishedAfter = new Date(
      Date.now() - args.publishedWithinDays * 86_400_000,
    ).toISOString();

    // 1. Search (the expensive call: 100 units)
    const videoIds = await searchVideos(
      apiKey,
      quota,
      args.query,
      publishedAfter,
      50,
    );
    if (videoIds.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { query: args.query, outliers: [], quotaUnitsUsed: quota.units },
              null,
              2,
            ),
          },
        ],
      };
    }

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
          c.channel.subs <= args.maxSubs &&
          c.video.views >= args.minViews &&
          c.video.views / Math.max(c.channel.subs, 1) >= args.minRatio,
      )
      .sort(
        (a, b) =>
          b.video.views / Math.max(b.channel.subs!, 1) -
          a.video.views / Math.max(a.channel.subs!, 1),
      )
      // Baseline checks cost ~2 units each — cap how many we verify
      .slice(0, args.maxResults * 2);

    // 3. Outlier-vs-baseline check: compare against median of the channel's
    //    other recent uploads (a big video on a channel whose EVERY video is
    //    big proves nothing about the format).
    const outliers: OutlierResult[] = [];
    for (const { video, channel } of candidates) {
      if (outliers.length >= args.maxResults) break;

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
          if (factor < args.minOutlierFactor) continue;
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
        outlierFactor:
          factor === null ? null : Math.round(factor * 10) / 10,
        commentsEnabled: video.comments !== null,
        channelVideoCount: channel.videoCount,
      });
    }

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
                "but verify manually). Next manual steps per Icon Method: read " +
                "top comments for demand signal, extract structure from " +
                "chapters/transcript.",
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

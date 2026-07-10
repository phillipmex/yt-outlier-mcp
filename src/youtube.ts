// Thin YouTube Data API v3 client (fetch-based, no googleapis dependency).
// Quota costs: search.list = 100 units; videos/channels/playlistItems.list = 1 unit each.

const API_BASE = "https://www.googleapis.com/youtube/v3";

export interface VideoStats {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  views: number;
  comments: number | null; // null when comments are disabled
}

export interface ChannelStats {
  channelId: string;
  title: string;
  subs: number | null; // null when the channel hides subscriber count
  uploadsPlaylistId: string;
  videoCount: number;
}

export class QuotaTracker {
  units = 0;
  add(n: number) {
    this.units += n;
  }
}

async function apiGet(
  path: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<any> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    let reason = `HTTP ${res.status}`;
    try {
      const err = JSON.parse(body)?.error;
      if (err?.message) reason = `${reason}: ${err.message}`;
      // quotaExceeded / rateLimitExceeded arrive here — surface them verbatim
    } catch {
      reason = `${reason}: ${body.slice(0, 300)}`;
    }
    throw new Error(`YouTube API ${path} failed — ${reason}`);
  }
  return res.json();
}

/** search.list — 100 quota units. Returns video IDs ordered by view count. */
export async function searchVideos(
  apiKey: string,
  quota: QuotaTracker,
  query: string,
  publishedAfter: string,
  maxResults: number,
): Promise<string[]> {
  const data = await apiGet(
    "search",
    {
      part: "id",
      q: query,
      type: "video",
      order: "viewCount",
      publishedAfter,
      maxResults: String(Math.min(maxResults, 50)),
      relevanceLanguage: "en",
    },
    apiKey,
  );
  quota.add(100);
  return (data.items ?? [])
    .map((it: any) => it.id?.videoId)
    .filter((id: any): id is string => typeof id === "string");
}

/** videos.list — 1 unit per call, up to 50 IDs per call. */
export async function getVideoStats(
  apiKey: string,
  quota: QuotaTracker,
  videoIds: string[],
): Promise<Map<string, VideoStats>> {
  const out = new Map<string, VideoStats>();
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await apiGet(
      "videos",
      { part: "snippet,statistics", id: batch.join(","), maxResults: "50" },
      apiKey,
    );
    quota.add(1);
    for (const it of data.items ?? []) {
      out.set(it.id, {
        videoId: it.id,
        title: it.snippet.title,
        channelId: it.snippet.channelId,
        channelTitle: it.snippet.channelTitle,
        publishedAt: it.snippet.publishedAt,
        views: Number(it.statistics.viewCount ?? 0),
        comments:
          it.statistics.commentCount !== undefined
            ? Number(it.statistics.commentCount)
            : null,
      });
    }
  }
  return out;
}

/** channels.list — 1 unit per call, up to 50 IDs per call. */
export async function getChannelStats(
  apiKey: string,
  quota: QuotaTracker,
  channelIds: string[],
): Promise<Map<string, ChannelStats>> {
  const out = new Map<string, ChannelStats>();
  const unique = [...new Set(channelIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const data = await apiGet(
      "channels",
      {
        part: "snippet,statistics,contentDetails",
        id: batch.join(","),
        maxResults: "50",
      },
      apiKey,
    );
    quota.add(1);
    for (const it of data.items ?? []) {
      out.set(it.id, {
        channelId: it.id,
        title: it.snippet.title,
        subs: it.statistics.hiddenSubscriberCount
          ? null
          : Number(it.statistics.subscriberCount ?? 0),
        uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ?? "",
        videoCount: Number(it.statistics.videoCount ?? 0),
      });
    }
  }
  return out;
}

/** playlistItems.list on the uploads playlist — 1 unit. Returns recent upload video IDs. */
export async function getRecentUploads(
  apiKey: string,
  quota: QuotaTracker,
  uploadsPlaylistId: string,
  max: number,
): Promise<string[]> {
  const data = await apiGet(
    "playlistItems",
    {
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(max, 50)),
    },
    apiKey,
  );
  quota.add(1);
  return (data.items ?? [])
    .map((it: any) => it.contentDetails?.videoId)
    .filter((id: any): id is string => typeof id === "string");
}

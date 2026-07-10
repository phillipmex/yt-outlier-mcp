// Thin YouTube Data API v3 client (fetch-based, no googleapis dependency).
// Quota costs: search.list = 100 units; videos/channels/playlistItems.list = 1 unit each.

const API_BASE = "https://www.googleapis.com/youtube/v3";

export interface VideoStats {
  videoId: string;
  title: string;
  description: string;
  tags: string[];
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

export interface VideoDetails {
  videoId: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  durationSeconds: number;
  views: number;
  comments: number | null; // null when comments are disabled
  tags: string[];
}

export interface TopComment {
  author: string;
  text: string;
  likes: number;
  replies: number;
  publishedAt: string;
}

export interface TranscriptResult {
  source: "manual" | "auto"; // auto = YouTube's ASR captions
  language: string;
  text: string;
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
      // quotaExceeded / rateLimitExceeded / commentsDisabled arrive here —
      // include the machine-readable reason so callers can branch on it
      const code = err?.errors?.[0]?.reason;
      if (code) reason = `${reason} (${code})`;
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
        description: it.snippet.description ?? "",
        tags: it.snippet.tags ?? [],
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

function toChannelStats(it: any): ChannelStats {
  return {
    channelId: it.id,
    title: it.snippet.title,
    subs: it.statistics.hiddenSubscriberCount
      ? null
      : Number(it.statistics.subscriberCount ?? 0),
    uploadsPlaylistId: it.contentDetails?.relatedPlaylists?.uploads ?? "",
    videoCount: Number(it.statistics.videoCount ?? 0),
  };
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
      out.set(it.id, toChannelStats(it));
    }
  }
  return out;
}

/** channels.list by @handle (forHandle) or legacy username (forUsername) — 1 unit. */
export async function getChannelByHandle(
  apiKey: string,
  quota: QuotaTracker,
  handle: string,
  legacyUsername = false,
): Promise<ChannelStats | null> {
  const data = await apiGet(
    "channels",
    {
      part: "snippet,statistics,contentDetails",
      [legacyUsername ? "forUsername" : "forHandle"]: handle,
    },
    apiKey,
  );
  quota.add(1);
  const it = (data.items ?? [])[0];
  return it ? toChannelStats(it) : null;
}

/** ISO 8601 duration (PT1H2M3S, P1DT2H) → seconds. */
function parseIsoDuration(iso: string): number {
  const m = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 86_400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

/** videos.list for one video — 1 unit. Full snippet incl. description + duration. */
export async function getVideoDetails(
  apiKey: string,
  quota: QuotaTracker,
  videoId: string,
): Promise<VideoDetails | null> {
  const data = await apiGet(
    "videos",
    { part: "snippet,contentDetails,statistics", id: videoId },
    apiKey,
  );
  quota.add(1);
  const it = (data.items ?? [])[0];
  if (!it) return null;
  return {
    videoId: it.id,
    title: it.snippet.title,
    description: it.snippet.description ?? "",
    channelId: it.snippet.channelId,
    channelTitle: it.snippet.channelTitle,
    publishedAt: it.snippet.publishedAt,
    durationSeconds: parseIsoDuration(it.contentDetails?.duration ?? ""),
    views: Number(it.statistics.viewCount ?? 0),
    comments:
      it.statistics.commentCount !== undefined
        ? Number(it.statistics.commentCount)
        : null,
    tags: it.snippet.tags ?? [],
  };
}

/** commentThreads.list — 1 unit. Relevance-ordered top-level comments; null when disabled. */
export async function getTopComments(
  apiKey: string,
  quota: QuotaTracker,
  videoId: string,
  max: number,
): Promise<TopComment[] | null> {
  let data;
  try {
    data = await apiGet(
      "commentThreads",
      {
        part: "snippet",
        videoId,
        order: "relevance",
        maxResults: String(Math.min(max, 100)),
        textFormat: "plainText",
      },
      apiKey,
    );
  } catch (e) {
    if (e instanceof Error && /commentsDisabled/.test(e.message)) return null;
    throw e;
  }
  quota.add(1);
  return (data.items ?? []).map((it: any): TopComment => {
    const c = it.snippet.topLevelComment.snippet;
    return {
      author: c.authorDisplayName ?? "",
      text: c.textDisplay ?? "",
      likes: Number(c.likeCount ?? 0),
      replies: Number(it.snippet.totalReplyCount ?? 0),
      publishedAt: c.publishedAt ?? "",
    };
  });
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Transcript fetch is NOT part of the Data API (captions.download needs OAuth
// as the video owner). The watch page's caption URLs are gated behind a
// proof-of-origin token since ~2024 (they return an empty 200), so instead ask
// the InnerTube player endpoint as the ANDROID client, whose caption URLs are
// not gated. Zero quota, but unofficial — callers must treat null as a soft
// failure.
export async function fetchTranscript(
  videoId: string,
): Promise<TranscriptResult | null> {
  let player: any;
  try {
    const res = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 30,
            hl: "en",
          },
        },
        videoId,
      }),
    });
    if (!res.ok) return null;
    player = await res.json();
  } catch {
    return null;
  }

  const tracks: any[] =
    player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return null;

  // Prefer human-made English captions, then auto-generated English, then anything
  const isEn = (t: any) =>
    typeof t.languageCode === "string" && t.languageCode.startsWith("en");
  const track =
    tracks.find((t) => isEn(t) && t.kind !== "asr") ??
    tracks.find(isEn) ??
    tracks[0];
  if (typeof track?.baseUrl !== "string") return null;

  const res = await fetch(`${track.baseUrl}&fmt=json3`);
  if (!res.ok) return null;
  const body = await res.text();

  let text: string;
  if (body.trimStart().startsWith("<")) {
    // The ANDROID client ignores fmt=json3 and returns timedtext XML:
    // <p t="..." d="...">line</p>, sometimes with nested <s> segments
    text = [...body.matchAll(/<p[^>]*>(.*?)<\/p>/gs)]
      .map((m) => decodeXmlEntities(m[1].replace(/<[^>]+>/g, "")))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else {
    let events: any[];
    try {
      events = JSON.parse(body)?.events ?? [];
    } catch {
      return null;
    }
    text = events
      .filter((e) => Array.isArray(e.segs))
      .map((e) => e.segs.map((s: any) => s.utf8 ?? "").join(""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (!text) return null;

  return {
    source: track.kind === "asr" ? "auto" : "manual",
    language: track.languageCode ?? "unknown",
    text,
  };
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

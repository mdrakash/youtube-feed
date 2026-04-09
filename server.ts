import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { google } from "googleapis";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { createRequire } from "module";
import type { Response } from "express";

const require = createRequire(import.meta.url);
const YT = require("youtube-transcript");
const fetchTranscript = YT.fetchTranscript || YT.YoutubeTranscript?.fetchTranscript;

dotenv.config();

const app = express();
const PORT = 3000;
const isProduction = process.env.NODE_ENV === "production";
// Fetch a limited set of subscriptions per page to balance API quota and feed freshness.
const SUBSCRIPTIONS_PAGE_SIZE = 6;
// Pull a few latest uploads per channel so each page remains diverse but not too large.
const SUBSCRIPTION_UPLOADS_PER_CHANNEL = 4;

app.use(cookieParser());
app.use(express.json());

type ApiVideo = {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  thumbnail?: string | null;
  channelTitle?: string | null;
  publishedAt?: string | null;
};

const encodePageToken = (cursor: Record<string, string | null>) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodePageToken = (token?: string) => {
  if (!token) return null;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    return typeof decoded === "object" && decoded ? decoded : null;
  } catch {
    return null;
  }
};

type HomeFeedCursor = {
  source: "home";
  homePageToken: string | null;
};

const encodeHomeFeedCursor = (cursor: HomeFeedCursor) =>
  encodePageToken({
    source: cursor.source,
    homePageToken: cursor.homePageToken,
  });

const decodeHomeFeedCursor = (token?: string): HomeFeedCursor => {
  const decoded = decodePageToken(token);
  const hasUndecodableToken = !!token && !decoded;
  const homePageToken =
    typeof decoded?.homePageToken === "string"
      ? decoded.homePageToken
      : hasUndecodableToken
        ? token
        : null;

  return { source: "home", homePageToken };
};

const mapVideoItem = (item: any): ApiVideo => ({
  id: item.id,
  title: item.snippet?.title,
  description: item.snippet?.description,
  thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url,
  channelTitle: item.snippet?.channelTitle,
  publishedAt: item.snippet?.publishedAt,
});

const sortVideosByDateDesc = (videos: ApiVideo[]) =>
  videos.sort((a, b) => {
    const aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bTime - aTime;
  });

const sendApiError = (
  res: Response,
  status: number,
  code: string,
  message: string
) => res.status(status).json({ error: { code, message } });

// Add transcript endpoint
app.get("/api/youtube/transcript/:videoId", async (req, res) => {
  const { videoId } = req.params;
  try {
    console.log(`Fetching transcript for ${videoId}...`);
    if (!fetchTranscript) {
      throw new Error("fetchTranscript method not found");
    }
    const transcript = await fetchTranscript(videoId);
    res.json({ transcript });
  } catch (error: any) {
    if (error.message?.includes("Transcript is disabled")) {
      console.log(`Transcript disabled for ${videoId}`);
      res.json({ transcript: [], error: "Transcript is disabled for this video" });
    } else {
      console.error(`Error fetching transcript for ${videoId}:`, error);
      res.json({ transcript: [], error: "Transcript not available" });
    }
  }
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID || "placeholder",
  process.env.GOOGLE_CLIENT_SECRET || "placeholder",
  `${process.env.APP_URL || "http://localhost:3000"}/auth/callback`
);

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
app.get("/api/auth/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    
    // Store tokens in cookies
      res.cookie("youtube_tokens", JSON.stringify(tokens), {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    sendApiError(res, 500, "AUTH_CALLBACK_FAILED", "Authentication failed");
  }
});

app.get("/api/auth/status", (req, res) => {
  const tokens = req.cookies.youtube_tokens;
  res.json({ isAuthenticated: !!tokens });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("youtube_tokens");
  res.json({ success: true });
});

app.get("/api/youtube/home", async (req, res) => {
  const tokensStr = req.cookies.youtube_tokens;
  const pageToken = req.query.pageToken as string | undefined;
  
  try {
    let auth: any = process.env.GOOGLE_API_KEY;
    if (tokensStr) {
      const tokens = JSON.parse(tokensStr);
      oauth2Client.setCredentials(tokens);
      auth = oauth2Client;
    }

    const yt = google.youtube({ version: "v3", auth });

    if (tokensStr) {
      const cursor = decodeHomeFeedCursor(pageToken);

      // Personalized "Home" feed
      // Fetching 50 items to ensure we get a good mix after filtering
      const response = await yt.activities.list({
        part: ["snippet", "contentDetails"],
        home: true,
        maxResults: 50,
        pageToken: cursor.homePageToken || undefined,
      });

      let videoIds = response.data.items
        ?.map(item => item.contentDetails?.upload?.videoId || item.contentDetails?.playlistItem?.resourceId?.videoId)
        .filter(Boolean) as string[];
      videoIds = Array.from(new Set(videoIds));

      // If Home feed is empty on first page, try to get user's own activities or subscriptions
      if (videoIds.length === 0 && !cursor.homePageToken) {
        const mineResponse = await yt.activities.list({
          part: ["snippet", "contentDetails"],
          mine: true,
          maxResults: 24,
        });
        videoIds = mineResponse.data.items
          ?.map(item => item.contentDetails?.upload?.videoId || item.contentDetails?.playlistItem?.resourceId?.videoId)
          .filter(Boolean) as string[];
        videoIds = Array.from(new Set(videoIds));
      }

      if (videoIds.length === 0) {
        const nextCursor = response.data.nextPageToken
          ? encodeHomeFeedCursor({
              source: "home",
              homePageToken: response.data.nextPageToken,
            })
          : null;
        return res.json({ items: [], nextPageToken: nextCursor });
      }

      const videoDetails = await yt.videos.list({
        part: ["snippet", "contentDetails", "statistics"],
        id: videoIds,
      });

      const items = sortVideosByDateDesc((videoDetails.data.items?.map(mapVideoItem) || []));

      const nextCursor = response.data.nextPageToken
        ? encodeHomeFeedCursor({
            source: "home",
            homePageToken: response.data.nextPageToken,
          })
        : null;
      return res.json({ items, nextPageToken: nextCursor });
    } else {
      // Public popular feed for non-logged in users
      const response = await yt.videos.list({
        part: ["snippet", "contentDetails", "statistics"],
        chart: "mostPopular",
        regionCode: "BD",
        maxResults: 24,
        pageToken,
      });

      const items = sortVideosByDateDesc((response.data.items?.map(mapVideoItem) || []));

      res.json({ items, nextPageToken: response.data.nextPageToken });
    }
  } catch (error) {
    console.error("Error fetching home feed:", error);
    sendApiError(res, 500, "HOME_FEED_FETCH_FAILED", "Failed to fetch home feed");
  }
});

app.get("/api/youtube/feed", async (req, res) => {
  const tokensStr = req.cookies.youtube_tokens;
  const pageToken = req.query.pageToken as string;
  if (!tokensStr) return sendApiError(res, 401, "UNAUTHORIZED", "Unauthorized");

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });
    const decodedCursor = decodePageToken(pageToken);
    const subscriptionsPageToken =
      typeof decodedCursor?.subscriptionsPageToken === "string"
        ? decodedCursor.subscriptionsPageToken
        : undefined;

    const subsResponse = await youtube.subscriptions.list({
      mine: true,
      part: ["snippet", "contentDetails"],
      maxResults: SUBSCRIPTIONS_PAGE_SIZE,
      order: "relevance",
      pageToken: subscriptionsPageToken,
    });

    const channelIds = subsResponse.data.items
      ?.map(sub => sub.snippet?.resourceId?.channelId)
      .filter(Boolean) as string[];

    if (!channelIds.length) {
      const nextCursor = subsResponse.data.nextPageToken
        ? encodePageToken({ subscriptionsPageToken: subsResponse.data.nextPageToken })
        : null;
      return res.json({ items: [], nextPageToken: nextCursor });
    }

    const channelDetails = await youtube.channels.list({
      id: channelIds,
      part: ["contentDetails"],
      maxResults: channelIds.length,
    });

    const playlistIds = channelDetails.data.items
      ?.map(c => c.contentDetails?.relatedPlaylists?.uploads)
      .filter(Boolean) as string[];

    const playlistPromises = playlistIds.map(playlistId =>
      youtube.playlistItems.list({
        playlistId,
        part: ["snippet", "contentDetails"],
        maxResults: SUBSCRIPTION_UPLOADS_PER_CHANNEL,
      })
    );

    const playlistResults = await Promise.all(playlistPromises);
    const videoIds = Array.from(
      new Set(
        playlistResults
          .flatMap(result => result.data.items || [])
          .map(item => item.contentDetails?.videoId)
          .filter(Boolean) as string[]
      )
    );

    if (videoIds.length === 0) {
      const nextCursor = subsResponse.data.nextPageToken
        ? encodePageToken({ subscriptionsPageToken: subsResponse.data.nextPageToken })
        : null;
      return res.json({ items: [], nextPageToken: nextCursor });
    }

    const videoDetails = await youtube.videos.list({
      part: ["snippet", "contentDetails", "statistics"],
      id: videoIds,
    });

    const items = sortVideosByDateDesc((videoDetails.data.items?.map(mapVideoItem) || []));
    const nextCursor = subsResponse.data.nextPageToken
      ? encodePageToken({ subscriptionsPageToken: subsResponse.data.nextPageToken })
      : null;

    res.json({ items, nextPageToken: nextCursor });
  } catch (error) {
    console.error("Error fetching subscription feed:", error);
    sendApiError(
      res,
      500,
      "SUBSCRIPTION_FEED_FETCH_FAILED",
      "Failed to fetch subscription feed"
    );
  }
});

// Vite middleware setup
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log("Vite middleware should be active.");
  });
}

console.log("Starting server initialization...");
startServer().catch(err => {
  console.error("Failed to start server:", err);
});

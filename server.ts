import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { google } from "googleapis";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const YT = require("youtube-transcript");
const fetchTranscript = YT.fetchTranscript || YT.YoutubeTranscript?.fetchTranscript;

dotenv.config();

const app = express();
const PORT = 3000;

app.use(cookieParser());
app.use(express.json());

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
      secure: true,
      sameSite: "none",
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
    res.status(500).send("Authentication failed");
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
  const pageToken = req.query.pageToken as string;
  
  try {
    let auth: any = process.env.GOOGLE_API_KEY;
    if (tokensStr) {
      const tokens = JSON.parse(tokensStr);
      oauth2Client.setCredentials(tokens);
      auth = oauth2Client;
    }

    const yt = google.youtube({ version: "v3", auth });

    if (tokensStr) {
      // Personalized "Home" feed
      // Fetching 50 items to ensure we get a good mix after filtering
      const response = await yt.activities.list({
        part: ["snippet", "contentDetails"],
        home: true,
        maxResults: 50,
        pageToken,
      });

      let videoIds = response.data.items
        ?.map(item => item.contentDetails?.upload?.videoId || item.contentDetails?.playlistItem?.resourceId?.videoId)
        .filter(Boolean) as string[];

      // If Home feed is empty on first page, try to get user's own activities or subscriptions
      if (videoIds.length === 0 && !pageToken) {
        const mineResponse = await yt.activities.list({
          part: ["snippet", "contentDetails"],
          mine: true,
          maxResults: 24,
        });
        videoIds = mineResponse.data.items
          ?.map(item => item.contentDetails?.upload?.videoId || item.contentDetails?.playlistItem?.resourceId?.videoId)
          .filter(Boolean) as string[];
      }

      // Final fallback to popular if still empty
      if (videoIds.length === 0 && !pageToken) {
        const popularResponse = await yt.videos.list({
          part: ["snippet", "contentDetails", "statistics"],
          chart: "mostPopular",
          maxResults: 24,
        });

        const items = popularResponse.data.items?.map(item => ({
          id: item.id,
          title: item.snippet?.title,
          description: item.snippet?.description,
          thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url,
          channelTitle: item.snippet?.channelTitle,
          publishedAt: item.snippet?.publishedAt,
        })) || [];

        return res.json({ items, nextPageToken: popularResponse.data.nextPageToken });
      }

      if (videoIds.length === 0) {
        return res.json({ items: [], nextPageToken: response.data.nextPageToken });
      }

      const videoDetails = await yt.videos.list({
        part: ["snippet", "contentDetails", "statistics"],
        id: videoIds,
      });

      const items = videoDetails.data.items?.map(item => ({
        id: item.id,
        title: item.snippet?.title,
        description: item.snippet?.description,
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url,
        channelTitle: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt,
      })) || [];

      return res.json({ items, nextPageToken: response.data.nextPageToken });
    } else {
      // Public popular feed for non-logged in users
      const response = await yt.videos.list({
        part: ["snippet", "contentDetails", "statistics"],
        chart: "mostPopular",
        regionCode: "BD",
        maxResults: 24,
        pageToken,
      });

      const items = response.data.items?.map(item => ({
        id: item.id,
        title: item.snippet?.title,
        description: item.snippet?.description,
        thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url,
        channelTitle: item.snippet?.channelTitle,
        publishedAt: item.snippet?.publishedAt,
      })) || [];

      res.json({ items, nextPageToken: response.data.nextPageToken });
    }
  } catch (error) {
    console.error("Error fetching home feed:", error);
    res.status(500).json({ error: "Failed to fetch home feed" });
  }
});

app.get("/api/youtube/feed", async (req, res) => {
  const tokensStr = req.cookies.youtube_tokens;
  const pageToken = req.query.pageToken as string;
  if (!tokensStr) return res.status(401).json({ error: "Unauthorized" });

  try {
    const tokens = JSON.parse(tokensStr);
    oauth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: "v3", auth: oauth2Client });

    // For "Subscriptions" tab, we'll fetch from multiple sources to ensure a rich feed
    const response = await youtube.activities.list({
      part: ["snippet", "contentDetails"],
      home: true,
      maxResults: 50,
      pageToken,
    });

    let videoIds = response.data.items
      ?.filter(item => item.snippet?.type === "upload" || item.snippet?.type === "playlistItem")
      .map(item => item.contentDetails?.upload?.videoId || item.contentDetails?.playlistItem?.resourceId?.videoId)
      .filter(Boolean) as string[];

    // If activities are sparse, fetch directly from subscriptions
    if (videoIds.length < 10 && !pageToken) {
      const subsResponse = await youtube.subscriptions.list({
        mine: true,
        part: ["snippet", "contentDetails"],
        maxResults: 20,
        order: "relevance",
      });

      const channelIds = subsResponse.data.items?.map(sub => sub.snippet?.resourceId?.channelId).filter(Boolean) as string[];
      
      if (channelIds && channelIds.length > 0) {
        // Fetch latest videos from the top 8 subscribed channels
        const channelDetails = await youtube.channels.list({
          id: channelIds.slice(0, 8),
          part: ["contentDetails"],
        });

        const playlistIds = channelDetails.data.items?.map(c => c.contentDetails?.relatedPlaylists?.uploads).filter(Boolean) as string[];
        
        const playlistPromises = playlistIds.map(playlistId => 
          youtube.playlistItems.list({
            playlistId,
            part: ["snippet", "contentDetails"],
            maxResults: 4,
          })
        );

        const playlistResults = await Promise.all(playlistPromises);
        const extraIds = playlistResults.flatMap(res => res.data.items || []).map(item => item.contentDetails?.videoId).filter(Boolean) as string[];
        
        // Merge and deduplicate
        videoIds = Array.from(new Set([...videoIds, ...extraIds]));
      }
    }

    if (videoIds.length === 0) {
      return res.json({ items: [], nextPageToken: response.data.nextPageToken });
    }

    const videoDetails = await youtube.videos.list({
      part: ["snippet", "contentDetails", "statistics"],
      id: videoIds,
    });

    const items = videoDetails.data.items?.map(item => ({
      id: item.id,
      title: item.snippet?.title,
      description: item.snippet?.description,
      thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.medium?.url,
      channelTitle: item.snippet?.channelTitle,
      publishedAt: item.snippet?.publishedAt,
    })) || [];

    res.json({ items, nextPageToken: response.data.nextPageToken });
  } catch (error) {
    console.error("Error fetching subscription feed:", error);
    res.status(500).json({ error: "Failed to fetch subscription feed" });
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

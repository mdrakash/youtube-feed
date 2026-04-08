/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from "react-markdown";
import { 
  Youtube, 
  Loader2, 
  LogOut, 
  Play, 
  FileText, 
  ExternalLink,
  RefreshCw,
  LayoutDashboard,
  Clock,
  User,
  X,
  ChevronRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "./lib/utils";

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

interface Video {
  id: string;
  title: string;
  description: string;
  thumbnail: string;
  channelTitle: string;
  publishedAt: string;
}

const SummaryContent = ({ content, videoId }: { content: string; videoId: string }) => {
  const processedContent = useMemo(() => {
    // Regex to find [mm:ss] or [hh:mm:ss]
    const timestampRegex = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/g;
    
    return content.replace(timestampRegex, (match, hh, mm, ss) => {
      const hours = hh ? parseInt(hh) : 0;
      const minutes = parseInt(mm);
      const seconds = parseInt(ss);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;
      
      return `${match}(https://youtu.be/${videoId}?t=${totalSeconds})`;
    });
  }, [content, videoId]);

  return (
    <div className="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed prose-a:text-red-500 prose-a:no-underline hover:prose-a:underline">
      <ReactMarkdown
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono font-bold bg-red-500/10 px-1.5 py-0.5 rounded hover:bg-red-500/20 transition-colors" />
          )
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [loading, setLoading] = useState(false);
  const [summarizingId, setSummarizingId] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"home" | "subscriptions">("home");
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const selectedVideo = useMemo(() => 
    videos.find(v => v.id === selectedVideoId), 
    [videos, selectedVideoId]
  );

  const fetchFeed = useCallback(async (tab: "home" | "subscriptions" = activeTab, isLoadMore = false) => {
    if (isLoadMore) setIsFetchingMore(true);
    else {
      setLoading(true);
      setVideos([]);
    }
    setError(null);
    try {
      const endpoint = tab === "home" ? "/api/youtube/home" : "/api/youtube/feed";
      const url = new URL(endpoint, window.location.origin);
      if (isLoadMore && nextPageToken) {
        url.searchParams.append("pageToken", nextPageToken);
      }
      
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to fetch feed");
      const data = await res.json();
      
      if (isLoadMore) {
        setVideos(prev => [...prev, ...data.items]);
      } else {
        setVideos(data.items);
      }
      setNextPageToken(data.nextPageToken || null);
    } catch (err) {
      setError(`Could not load your YouTube ${tab} feed. Please try again.`);
      console.error(err);
    } finally {
      setLoading(false);
      setIsFetchingMore(false);
    }
  }, [activeTab, nextPageToken]);

  const checkAuthStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/status");
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      setIsAuthenticated(data.isAuthenticated);
      if (data.isAuthenticated) {
        fetchFeed("home");
      }
    } catch (err) {
      console.error("Auth status check failed:", err);
      setIsAuthenticated(false);
      setError("Connection error: Could not reach the server. Please ensure the backend is running.");
    }
  }, [fetchFeed]);

  useEffect(() => {
    checkAuthStatus();

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "OAUTH_AUTH_SUCCESS") {
        checkAuthStatus();
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [checkAuthStatus]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchFeed(activeTab);
    }
  }, [isAuthenticated, activeTab]); // Removed fetchFeed from deps to avoid loop

  // Infinite Scroll Observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && nextPageToken && !isFetchingMore && !loading) {
          fetchFeed(activeTab, true);
        }
      },
      { threshold: 0.5 }
    );

    const target = document.querySelector("#scroll-anchor");
    if (target) observer.observe(target);

    return () => observer.disconnect();
  }, [nextPageToken, isFetchingMore, loading, activeTab, fetchFeed]);

  const handleLogin = async () => {
    try {
      const res = await fetch("/api/auth/url");
      const { url } = await res.json();
      window.open(url, "youtube_oauth", "width=600,height=700");
    } catch (err) {
      console.error("Failed to get auth URL:", err);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setIsAuthenticated(false);
    setVideos([]);
  };

  const summarizeVideo = async (video: Video) => {
    if (summaries[video.id]) return;
    
    setSummarizingId(video.id);
    try {
      // 1. Try to fetch transcript
      let transcriptText = "";
      try {
        const transcriptRes = await fetch(`/api/youtube/transcript/${video.id}`);
        if (transcriptRes.ok) {
          const { transcript } = await transcriptRes.json();
          transcriptText = transcript.map((t: any) => `[${new Date(t.offset).toISOString().substr(14, 5)}] ${t.text}`).join("\n");
        }
      } catch (err) {
        console.error("Transcript fetch failed, falling back to description:", err);
      }

      const contentToSummarize = transcriptText || `Title: ${video.title}\nDescription: ${video.description}`;

      const prompt = `
        You are a YouTube video summarizer. 
        Summarize the following video content in Bengali (Bangla).
        The summary must be DETAILED, COMPREHENSIVE, and LONG. Do not provide a short summary.
        
        Follow the exact format provided in the example below for each point.
        Every key point MUST end with its corresponding timestamp in [mm:ss] or [hh:mm:ss] format.
        
        Format for each point:
        [টপিক শিরোনাম]: [বিস্তারিত আলোচনা এবং সারসংক্ষেপ] [mm:ss]
        
        Example:
        উত্তম জীবনের ভিত্তি ঈমান ও নেক আমল: উত্তম বা পবিত্র জীবন (হায়াতান তায়্যিবাহ) লাভের প্রধান শর্ত হলো আল্লাহর ওপর অবিচল ঈমান এবং সেই অনুযায়ী নেক আমল করা। দুনিয়া ও আখিরাতে শান্তির জন্য এর কোনো বিকল্প নেই [00:05]
        
        Content to summarize:
        ${contentToSummarize}
        
        Provide the summary now in the requested format.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} } as any],
        }
      });

      const summary = response.text || "No summary generated.";
      setSummaries(prev => ({ ...prev, [video.id]: summary }));
      setSelectedVideoId(video.id); // Open modal automatically
    } catch (err) {
      console.error("Summarization failed:", err);
      setSummaries(prev => ({ ...prev, [video.id]: "Failed to generate summary. Please try again." }));
    } finally {
      setSummarizingId(null);
    }
  };

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen bg-[#0F0F0F] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-red-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F0F0F] text-white font-sans selection:bg-red-500/30">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-[#0F0F0F]/80 backdrop-blur-md border-b border-white/10 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-red-600 p-1.5 rounded-lg">
              <Youtube className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight hidden sm:block">
              Feed<span className="text-red-600">Summarizer</span>
            </h1>
          </div>

          <div className="flex items-center gap-4">
            {isAuthenticated ? (
              <>
                <button 
                  onClick={() => fetchFeed(activeTab)}
                  disabled={loading}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors disabled:opacity-50"
                  title="Refresh Feed"
                >
                  <RefreshCw className={cn("w-5 h-5", loading && "animate-spin")} />
                </button>
                <div className="h-6 w-[1px] bg-white/10" />
                <button 
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-4 py-2 hover:bg-white/10 rounded-full transition-colors text-sm font-medium"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </>
            ) : (
              <button 
                onClick={handleLogin}
                className="bg-white text-black px-6 py-2 rounded-full font-bold hover:bg-white/90 transition-all flex items-center gap-2"
              >
                <User className="w-4 h-4" />
                Connect YouTube
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        {!isAuthenticated ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="max-w-md"
            >
              <div className="w-20 h-20 bg-red-600/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <Youtube className="w-10 h-10 text-red-600" />
              </div>
              <h2 className="text-3xl font-bold mb-4">Your YouTube Feed, Summarized.</h2>
              <p className="text-gray-400 mb-8">
                Connect your account to see your latest subscription videos and get instant AI-powered summaries. Save time and stay informed.
              </p>
              <button 
                onClick={handleLogin}
                className="w-full bg-red-600 text-white px-8 py-4 rounded-2xl font-bold hover:bg-red-700 transition-all shadow-lg shadow-red-600/20 flex items-center justify-center gap-3"
              >
                Get Started Now
                <Play className="w-4 h-4 fill-current" />
              </button>
            </motion.div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex items-center gap-6 border-b border-white/10 mb-6">
              <button 
                onClick={() => setActiveTab("home")}
                className={cn(
                  "pb-4 text-sm font-bold transition-all relative",
                  activeTab === "home" ? "text-white" : "text-gray-500 hover:text-gray-300"
                )}
              >
                Home
                {activeTab === "home" && (
                  <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />
                )}
              </button>
              <button 
                onClick={() => setActiveTab("subscriptions")}
                className={cn(
                  "pb-4 text-sm font-bold transition-all relative",
                  activeTab === "subscriptions" ? "text-white" : "text-gray-500 hover:text-gray-300"
                )}
              >
                Subscriptions
                {activeTab === "subscriptions" && (
                  <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />
                )}
              </button>
            </div>

            {loading && videos.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 space-y-4">
                <Loader2 className="w-10 h-10 text-red-600 animate-spin" />
                <p className="text-gray-500">Fetching your latest videos...</p>
              </div>
            ) : error ? (
              <div className="bg-red-500/10 border border-red-500/20 p-6 rounded-2xl text-center">
                <p className="text-red-400 mb-4">{error}</p>
                <button onClick={() => fetchFeed(activeTab)} className="text-white underline font-medium">Try Again</button>
              </div>
            ) : videos.length === 0 ? (
              <div className="bg-[#1A1A1A] border border-dashed border-white/10 rounded-2xl p-12 text-center">
                <Youtube className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-xl font-bold mb-2">No videos found</h3>
                <p className="text-gray-500 max-w-sm mx-auto">
                  We couldn't find any recent videos in your {activeTab} feed. Try checking back later or refreshing.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                <AnimatePresence mode="popLayout">
                  {videos.map((video, index) => (
                    <motion.div
                      key={video.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: index * 0.05 }}
                      className="group bg-[#1A1A1A] border border-white/5 rounded-2xl overflow-hidden hover:border-white/20 transition-all flex flex-col"
                    >
                      <div className="relative aspect-video overflow-hidden">
                        <img 
                          src={video.thumbnail} 
                          alt={video.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-4">
                          <a 
                            href={`https://youtube.com/watch?v=${video.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bg-white/20 backdrop-blur-md p-2 rounded-full hover:bg-white/40 transition-colors"
                          >
                            <ExternalLink className="w-4 h-4" />
                          </a>
                        </div>
                      </div>
                      <div className="p-4 flex-1 flex flex-col">
                        <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
                          <span className="font-semibold text-white/80 line-clamp-1">{video.channelTitle}</span>
                          <span>•</span>
                          <span className="flex items-center gap-1 whitespace-nowrap">
                            <Clock className="w-3 h-3" />
                            {new Date(video.publishedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <h3 className="font-bold line-clamp-2 mb-4 group-hover:text-red-500 transition-colors flex-1">
                          {video.title}
                        </h3>
                        <button
                          onClick={() => summaries[video.id] ? setSelectedVideoId(video.id) : summarizeVideo(video)}
                          disabled={summarizingId === video.id}
                          className={cn(
                            "w-full py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all",
                            summaries[video.id] 
                              ? "bg-white/10 text-white hover:bg-white/20" 
                              : "bg-red-600 hover:bg-red-700 text-white"
                          )}
                        >
                          {summarizingId === video.id ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Summarizing...
                            </>
                          ) : summaries[video.id] ? (
                            <>
                              <FileText className="w-4 h-4" />
                              View Summary
                            </>
                          ) : (
                            <>
                              <FileText className="w-4 h-4" />
                              Summarize
                            </>
                          )}
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            )}

            {/* Scroll Anchor for Infinite Scroll */}
            <div id="scroll-anchor" className="h-20 flex items-center justify-center">
              {(isFetchingMore || (loading && videos.length > 0)) && (
                <Loader2 className="w-6 h-6 text-red-600 animate-spin" />
              )}
            </div>
          </div>
        )}
      </main>

      {/* Summary Modal */}
      <AnimatePresence>
        {selectedVideoId && selectedVideo && (
          <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedVideoId(null)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, y: 100, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 100, scale: 0.95 }}
              className="relative w-full max-w-2xl bg-[#1A1A1A] border-t sm:border border-white/10 rounded-t-[32px] sm:rounded-[32px] overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
            >
              {/* Modal Header */}
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-[#1A1A1A]/80 backdrop-blur-md sticky top-0 z-10">
                <div className="flex items-center gap-3">
                  <div className="bg-red-600/10 p-2 rounded-xl">
                    <FileText className="w-5 h-5 text-red-600" />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg line-clamp-1">{selectedVideo.title}</h3>
                    <p className="text-xs text-gray-400">{selectedVideo.channelTitle}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedVideoId(null)}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Modal Content */}
              <div className="p-6 overflow-y-auto custom-scrollbar">
                <div className="mb-6 rounded-2xl overflow-hidden aspect-video relative group">
                  <img 
                    src={selectedVideo.thumbnail} 
                    alt={selectedVideo.title}
                    className="w-full h-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                  <a 
                    href={`https://youtube.com/watch?v=${selectedVideo.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <div className="bg-red-600 p-4 rounded-full shadow-xl">
                      <Play className="w-6 h-6 fill-current" />
                    </div>
                  </a>
                </div>

                <SummaryContent 
                  content={summaries[selectedVideoId] || ""} 
                  videoId={selectedVideoId} 
                />

                <div className="mt-8 pt-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    <Clock className="w-3 h-3" />
                    Published on {new Date(selectedVideo.publishedAt).toLocaleDateString()}
                  </div>
                  <a 
                    href={`https://youtube.com/watch?v=${selectedVideo.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm font-bold text-red-500 hover:text-red-400 transition-colors"
                  >
                    Watch full video on YouTube
                    <ChevronRight className="w-4 h-4" />
                  </a>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}

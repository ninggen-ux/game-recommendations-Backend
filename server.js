require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { GoogleGenAI } = require("@google/genai");

const MAX_GAMES = 5;
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_TIMEOUT_MS = 15000;

class CacheManager {
    constructor() {
        this.cache = new Map();
    }

    get(key) {
        return this.cache.get(key);
    }

    set(key, value) {
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }
}

class GameService {
    constructor(rawgApiKey, geminiApiKey) {
        this.rawgApiKey = rawgApiKey;
        this.ai = new GoogleGenAI({ apiKey: geminiApiKey });
        this.cacheManager = new CacheManager();
    }

    normalizeArray(input) {
        if (!input) return [];
        if (Array.isArray(input)) {
            return input.map((item) => String(item).trim()).filter(Boolean);
        }
        return String(input)
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean);
    }

    async generateContentWithTimeout(params, timeoutMs = GEMINI_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await this.ai.models.generateContent({
                ...params,
                config: {
                    ...(params.config || {}),
                    abortSignal: controller.signal,
                },
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async fetchGameDescription(rawgId, tag) {
        const label = `rawg-desc:${rawgId}:${tag}`;
        console.time(label);
        try {
            const res = await axios.get(
                `https://api.rawg.io/api/games/${rawgId}`,
                {
                    params: { key: this.rawgApiKey },
                    timeout: 6000,
                },
            );
            return (
                res.data?.description_raw ||
                res.data?.description ||
                "Deskripsi game tidak tersedia."
            );
        } catch (err) {
            console.error(`RAWG desc error (${rawgId}):`, err.message);
            return "Deskripsi game tidak tersedia.";
        } finally {
            console.timeEnd(label);
        }
    }

    async fetchGameFromRAWG(title, reqId) {
        const safeTitle = String(title)
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .slice(0, 25);
        const tag = `${safeTitle}-${reqId}-${Math.random().toString(36).slice(2, 5)}`;
        const searchLabel = `rawg-search:${tag}`;

        console.time(searchLabel);
        let searchEnded = false;
        try {
            const res = await axios.get("https://api.rawg.io/api/games", {
                params: {
                    key: this.rawgApiKey,
                    search: title,
                    page_size: 1,
                },
                timeout: 6000,
            });
            console.timeEnd(searchLabel);
            searchEnded = true;

            const results = res.data?.results;
            if (!Array.isArray(results) || results.length === 0) {
                return null;
            }

            const game = results[0];
            const description = await this.fetchGameDescription(game.id, tag);

            return {
                id: game.id,
                name: game.name,
                rating: game.rating ?? 0,
                releasedDate: game.released || "",
                backgroundImage: game.background_image || "",
                platforms: Array.isArray(game.platforms)
                    ? game.platforms.map((p) => p.platform?.name).filter(Boolean)
                    : [],
                genre: Array.isArray(game.genres)
                    ? game.genres.map((g) => g.name).filter(Boolean)
                    : [],
                description,
            };
        } catch (err) {
            if (!searchEnded) {
                console.timeEnd(searchLabel);
            }
            console.error(`RAWG fetch error (${title}):`, err.message);
            return null;
        }
    }

    async getRecommendations({
        description,
        genres,
        platforms,
        releasedDate,
    }) {
        if (
            !description ||
            typeof description !== "string" ||
            description.trim() === ""
        ) {
            throw new Error("Description kriteria game tidak boleh kosong.");
        }
        if (description.length > 300) {
            throw new Error(
                "Description melebihi batas maksimal 300 karakter.",
            );
        }

        const cleanDescription = description.trim();
        const normalizedGenres = this.normalizeArray(genres);
        const normalizedPlatforms = this.normalizeArray(platforms);
        const cleanReleasedDate = releasedDate
            ? String(releasedDate).trim()
            : "";

        const cacheKey = JSON.stringify({
            description: cleanDescription.toLowerCase(),
            genres: normalizedGenres.map((g) => g.toLowerCase()).sort(),
            platforms: normalizedPlatforms.map((p) => p.toLowerCase()).sort(),
            releasedDate: cleanReleasedDate.toLowerCase(),
        });

        if (this.cacheManager.has(cacheKey)) {
            return { source: "cache", data: this.cacheManager.get(cacheKey) };
        }

        const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const totalLabel = `total-request:${reqId}`;
        console.time(totalLabel);

        try {
            const aiPrompt = `Berikan rekomendasi 5 judul game (minimal 3 dan maksimal 5 judul) yang paling sesuai dengan kriteria berikut:
- Deskripsi: "${cleanDescription}"
- Genres: ${normalizedGenres.length > 0 ? normalizedGenres.join(", ") : "Bebas"}
- Platforms: ${normalizedPlatforms.length > 0 ? normalizedPlatforms.join(", ") : "Bebas"}
- Released Date / Tahun: ${cleanReleasedDate || "Bebas"}

Keluarkan hasilnya HANYA DALAM BENTUK ARRAY JSON berisikan 3 sampai 5 nama judul game saja tanpa teks tambahan, contoh format: ["Game A", "Game B", "Game C"]`;

            const geminiLabel = `gemini:${reqId}`;
            console.time(geminiLabel);
            let aiResponse;
            try {
                aiResponse = await this.generateContentWithTimeout({
                    model: GEMINI_MODEL,
                    contents: aiPrompt,
                });
            } finally {
                console.timeEnd(geminiLabel);
            }

            let gameTitles = [];
            try {
                const cleanText = aiResponse.text
                    .replace(/```json/g, "")
                    .replace(/```/g, "")
                    .trim();
                gameTitles = JSON.parse(cleanText);
            } catch (parseError) {
                throw new Error("Gagal memproses daftar game dari AI.");
            }

            if (!Array.isArray(gameTitles) || gameTitles.length === 0) {
                return { source: "api", data: [] };
            }

            const limitedTitles = gameTitles
                .map((t) => String(t).trim())
                .filter(Boolean)
                .slice(0, MAX_GAMES);

            const rawgTotalLabel = `rawg-total:${reqId}`;
            console.time(rawgTotalLabel);
            let gameDetailsResults;
            try {
                const gameDetailsPromises = limitedTitles.map((title) =>
                    this.fetchGameFromRAWG(title, reqId),
                );
                gameDetailsResults = await Promise.all(gameDetailsPromises);
            } finally {
                console.timeEnd(rawgTotalLabel);
            }

            const validGames = gameDetailsResults.filter(
                (item) => item !== null,
            );

            this.cacheManager.set(cacheKey, validGames);

            return { source: "api", data: validGames };
        } finally {
            console.timeEnd(totalLabel);
        }
    }
}

class ServerApp {
    constructor() {
        this.app = express();
        this.port = process.env.PORT || 3000;
        this.gameService = new GameService(
            process.env.RAWG_API_KEY,
            process.env.GEMINI_API_KEY,
        );

        this.configureMiddleware();
        this.configureRoutes();
    }

    configureMiddleware() {
        const allowedOrigins = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:3001",
            "https://gamespoi.netlify.app",
        ];

        this.app.use(
            cors({
                origin: (origin, callback) => {
                    if (!origin || allowedOrigins.includes(origin)) {
                        callback(null, true);
                    } else {
                        callback(
                            new Error(
                                `Origin ${origin} tidak diizinkan oleh CORS`,
                            ),
                        );
                    }
                },
                methods: ["GET", "POST", "OPTIONS"],
                allowedHeaders: ["Content-Type", "Authorization"],
                credentials: true,
            }),
        );

        this.app.use(express.json());
    }

    configureRoutes() {
        this.app.get("/", (req, res) => {
            res.json({
                message: "Halo! Backend OOP GameMatch berhasil berjalan!",
            });
        });

        this.app.post("/api/recommend", async (req, res) => {
            try {
                const { description, genres, platforms, releasedDate } =
                    req.body;
                const result = await this.gameService.getRecommendations({
                    description,
                    genres,
                    platforms,
                    releasedDate,
                });

                res.json({
                    success: true,
                    source: result.source,
                    data: result.data,
                });
            } catch (error) {
                res.status(400).json({
                    success: false,
                    message: error.message,
                });
            }
        });
    }

    start() {
        this.app.listen(this.port, () => {
            console.log(`Server OOP berjalan di http://localhost:${this.port}`);
        });
    }
}

const server = new ServerApp();
server.start();
import { app, IpcMainInvokeEvent, nativeImage } from "electron";
import { createHash } from "crypto";
import { appendFileSync } from "fs";
import { join } from "path";
import { createServer, Server } from "http";

const DEFAULT_POSTER_PORT = 45454;
const MAX_CACHE_ITEMS = 50;

type CachedPoster = {
    buffer: Buffer;
    contentType: string;
    createdAt: number;
};

let posterServer: Server | null = null;
let posterServerPort = 0;
let latestPosterFilename: string | null = null;

const posterCache = new Map<string, CachedPoster>();

function logNative(...args: unknown[]) {
    const line = `[${new Date().toISOString()}] ${args.map(arg => {
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
        if (typeof arg === "string") return arg;

        try {
            return JSON.stringify(arg);
        } catch {
            return String(arg);
        }
    }).join(" ")}\n`;

    console.log("[PlexRichPresence:native]", ...args);

    try {
        appendFileSync(join(app.getPath("userData"), "plex-rich-presence.log"), line, "utf8");
    } catch {
        // Ignore logging failures.
    }
}

function cleanBaseUrl(url: string) {
    return String(url ?? "").trim().replace(/\/+$/, "");
}

function normalizePort(port: unknown) {
    const parsed = Number(port);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return DEFAULT_POSTER_PORT;
    }

    return parsed;
}

function makePlexUrl(baseUrl: string, path: string, token: string) {
    const clean = cleanBaseUrl(baseUrl);
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    const sep = cleanPath.includes("?") ? "&" : "?";

    return `${clean}${cleanPath}${sep}X-Plex-Token=${encodeURIComponent(token.trim())}`;
}

function prunePosterCache() {
    while (posterCache.size > MAX_CACHE_ITEMS) {
        const oldestKey = [...posterCache.entries()]
            .sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[0];

        if (!oldestKey) return;
        posterCache.delete(oldestKey);
    }
}

function writePosterResponse(res: any, poster: CachedPoster, isHeadRequest: boolean) {
    res.writeHead(200, {
        "Content-Type": poster.contentType,
        "Content-Length": poster.buffer.length,
        "Cache-Control": "public, max-age=86400, immutable",
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff"
    });

    if (isHeadRequest) {
        res.end();
        return;
    }

    res.end(poster.buffer);
}

async function ensurePosterServer(port: number) {
    const wantedPort = normalizePort(port);

    if (posterServer && posterServerPort === wantedPort) {
        logNative("Poster server already running", { port: posterServerPort });
        return { ok: true, port: posterServerPort };
    }

    if (posterServer) {
        await new Promise<void>(resolve => posterServer?.close(() => resolve()));
        posterServer = null;
        posterServerPort = 0;
    }

    const server = createServer((req, res) => {
        try {
            const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${wantedPort}`);
            const method = req.method ?? "GET";

            if (method === "OPTIONS") {
                res.writeHead(204, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                    "Access-Control-Allow-Headers": "*"
                });
                res.end();
                return;
            }

            if (requestUrl.pathname === "/__health") {
                res.writeHead(200, {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Access-Control-Allow-Origin": "*"
                });
                res.end(JSON.stringify({
                    ok: true,
                    port: wantedPort,
                    boundAddress: "0.0.0.0",
                    cachedPosters: posterCache.size,
                    latestPoster: latestPosterFilename,
                    latestPosterUrl: latestPosterFilename ? `/poster/${latestPosterFilename}` : null
                }));
                return;
            }

            if (method !== "GET" && method !== "HEAD") {
                res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Method not allowed");
                return;
            }

            let filename: string | null = null;

            if (requestUrl.pathname === "/poster/latest.jpg") {
                filename = latestPosterFilename;
            } else if (requestUrl.pathname.startsWith("/poster/")) {
                filename = decodeURIComponent(requestUrl.pathname.slice("/poster/".length));
            }

            if (!filename) {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("No poster has been cached yet");
                return;
            }

            const poster = posterCache.get(filename);

            if (!poster) {
                res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("Poster not found");
                return;
            }

            writePosterResponse(res, poster, method === "HEAD");
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(String(err));
        }
    });

    const listenResult = await new Promise<{ ok: true; port: number; } | { ok: false; error: string; }>(resolve => {
        const onError = (err: Error) => {
            logNative("Poster server failed to listen", err);
            resolve({ ok: false, error: `${err.name}: ${err.message}` });
        };

        server.once("error", onError);

        server.listen(wantedPort, "0.0.0.0", () => {
            server.off("error", onError);

            posterServer = server;
            posterServerPort = wantedPort;

            logNative("Poster server listening", {
                port: wantedPort,
                address: "0.0.0.0"
            });

            resolve({ ok: true, port: wantedPort });
        });
    });

    if (!listenResult.ok) {
        try {
            server.close();
        } catch {
            // Ignore close failures.
        }

        return listenResult;
    }

    posterServer?.on("error", err => {
        logNative("Poster server runtime error", err);
    });

    return listenResult;
}

export async function getPlexSessions(
    _: IpcMainInvokeEvent,
    baseUrl: string,
    token: string
) {
    const clean = cleanBaseUrl(baseUrl);

    if (!clean || !token.trim()) {
        return { ok: false, error: "Missing Plex URL or token" };
    }

    const url = makePlexUrl(clean, "/status/sessions", token);

    try {
        const res = await fetch(url, {
            headers: {
                Accept: "application/json"
            }
        });

        if (!res.ok) {
            return {
                ok: false,
                error: `Plex returned HTTP ${res.status}`
            };
        }

        const json = await res.json();

        return {
            ok: true,
            sessions: json?.MediaContainer?.Metadata ?? []
        };
    } catch (err) {
        return {
            ok: false,
            error: String(err)
        };
    }
}

export async function startPosterServer(
    _: IpcMainInvokeEvent,
    posterPort: number
) {
    try {
        const result = await ensurePosterServer(normalizePort(posterPort));

        return {
            ...result,
            cachedPosters: posterCache.size,
            latestPoster: latestPosterFilename
        };
    } catch (err) {
        logNative("startPosterServer failed", err);

        return {
            ok: false,
            error: String(err)
        };
    }
}

export async function preparePlexPoster(
    _: IpcMainInvokeEvent,
    baseUrl: string,
    token: string,
    imagePath: string,
    posterPort: number
) {
    const clean = cleanBaseUrl(baseUrl);
    const port = normalizePort(posterPort);

    if (!clean || !token.trim() || !imagePath) {
        return { ok: false, error: "Missing Plex URL, token, or image path" };
    }

    try {
        const serverResult = await ensurePosterServer(port);

        if (!serverResult.ok) {
            return serverResult;
        }

        const plexImageUrl = makePlexUrl(clean, imagePath, token);

        const res = await fetch(plexImageUrl, {
            headers: {
                Accept: "image/*"
            }
        });

        if (!res.ok) {
            return {
                ok: false,
                error: `Plex image returned HTTP ${res.status}`
            };
        }

        const arrayBuffer = await res.arrayBuffer();
        const originalBuffer = Buffer.from(arrayBuffer);

        const image = nativeImage.createFromBuffer(originalBuffer);

        if (image.isEmpty()) {
            return {
                ok: false,
                error: "Electron could not decode Plex image"
            };
        }

        const resized = image.resize({
            width: 512,
            height: 512,
            quality: "good"
        });

        const jpegBuffer = resized.toJPEG(85);

        const hash = createHash("sha256")
            .update(imagePath)
            .update(jpegBuffer)
            .digest("hex")
            .slice(0, 32);

        const filename = `${hash}.jpg`;

        posterCache.set(filename, {
            buffer: jpegBuffer,
            contentType: "image/jpeg",
            createdAt: Date.now()
        });

        latestPosterFilename = filename;
        prunePosterCache();

        logNative("Prepared poster", {
            filename,
            originalBytes: originalBuffer.length,
            resizedBytes: jpegBuffer.length,
            port
        });

        return {
            ok: true,
            port,
            publicPath: `/poster/${filename}`,
            latestPath: "/poster/latest.jpg",
            originalBytes: originalBuffer.length,
            resizedBytes: jpegBuffer.length
        };
    } catch (err) {
        logNative("preparePlexPoster failed", err);

        return {
            ok: false,
            error: String(err)
        };
    }
}

export async function stopPosterServer(_: IpcMainInvokeEvent) {
    if (posterServer) {
        posterServer.close();
        posterServer = null;
        posterServerPort = 0;
    }

    posterCache.clear();
    latestPosterFilename = null;

    logNative("Poster server stopped");

    return { ok: true };
}
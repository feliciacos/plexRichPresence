/*
 * Plex Rich Presence
 * Local Vencord userplugin
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ActivityType } from "@vencord/discord-types/enums";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

const SOCKET_ID = "PlexRichPresence";
const DEFAULT_POSTER_PORT = 45454;

const Native = VencordNative.pluginHelpers.PlexRichPresence as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    plexBaseUrl: {
        type: OptionType.STRING,
        description: "Your Plex server URL, for example http://localhost:32400 or http://192.168.1.10:32400",
        default: "http://localhost:32400"
    },
    plexToken: {
        type: OptionType.STRING,
        description: "Your Plex token. Treat this like a password. It is only used locally and is never added to Discord image URLs.",
        default: ""
    },
    appId: {
        type: OptionType.STRING,
        description: "Discord Application ID used for Rich Presence assets. This is NOT a bot token.",
        default: ""
    },
    posterUrl: {
        type: OptionType.STRING,
        description: "Public HTTPS reverse-proxy URL for posters, for example https://plexposter.example.com. Do not include a trailing slash.",
        default: ""
    },
    posterPort: {
        type: OptionType.NUMBER,
        description: `Local poster server port on this PC. Point your reverse proxy destination to this port. Default: ${DEFAULT_POSTER_PORT}`,
        default: DEFAULT_POSTER_PORT
    },
    pollSeconds: {
        type: OptionType.NUMBER,
        description: "How often to check Plex playback.",
        default: 10
    },
    showPaused: {
        type: OptionType.BOOLEAN,
        description: "Keep showing Rich Presence while Plex is paused.",
        default: true
    },
    buttonUrl: {
        type: OptionType.STRING,
        description: "Optional button URL, for example https://app.plex.tv/desktop",
        default: "https://app.plex.tv/desktop"
    },
    debug: {
        type: OptionType.BOOLEAN,
        description: "Log Plex Rich Presence debug info to the console.",
        default: true
    }
});

type PlexPlayerState = "playing" | "paused" | "buffering" | "stopped";

type PlexSession = {
    title?: string;
    grandparentTitle?: string;
    parentTitle?: string;
    type?: "movie" | "episode" | "track" | string;
    viewOffset?: number;
    duration?: number;
    year?: number;
    ratingKey?: string;
    key?: string;

    thumb?: string;
    art?: string;
    grandparentThumb?: string;
    parentThumb?: string;

    Player?: {
        state?: PlexPlayerState;
        title?: string;
        product?: string;
        platform?: string;
        machineIdentifier?: string;
    };

    User?: {
        title?: string;
        id?: string;
    };
};

let interval: ReturnType<typeof setInterval> | null = null;
let lastActivityKey = "";

function log(...args: unknown[]) {
    if (settings.store.debug) {
        console.log("[PlexRichPresence]", ...args);
    }
}

function warn(...args: unknown[]) {
    console.warn("[PlexRichPresence]", ...args);
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

function joinUrl(baseUrl: string, path: string) {
    const cleanBase = cleanBaseUrl(baseUrl);
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${cleanBase}${cleanPath}`;
}

function toSeconds(ms?: number) {
    return Math.floor((ms ?? 0) / 1000);
}

function formatSeasonEpisode(parentTitle?: string) {
    const match = parentTitle?.match(/Season\s+(\d+)/i);
    return match ? `S${match[1]}` : parentTitle;
}

async function getApplicationAsset(appId: string, key: string): Promise<string | undefined> {
    try {
        const assets = await ApplicationAssetUtils.fetchAssetIds(appId, [key]);
        return assets?.[0];
    } catch (err) {
        warn(`Failed to fetch Discord application asset "${key}".`, err);
        return undefined;
    }
}

function getBestPlexImagePath(session: PlexSession): string | undefined {
    if (session.type === "episode") {
        return session.grandparentThumb || session.thumb || session.parentThumb || session.art;
    }

    return session.thumb || session.grandparentThumb || session.parentThumb || session.art;
}

async function startPosterServer() {
    try {
        if (typeof Native.startPosterServer !== "function") {
            warn("Native.startPosterServer is missing. Rebuild/reinject Vencord so native.ts is included.");
            return;
        }

        const result = await Native.startPosterServer(normalizePort(settings.store.posterPort));

        log("Poster server startup result:", result);

        if (!result?.ok) {
            warn("Poster server did not start:", result?.error);
        }
    } catch (err) {
        warn("Failed to start poster server:", err);
    }
}

async function getPlexPosterAsset(appId: string, session: PlexSession): Promise<string | undefined> {
    const posterBaseUrl = cleanBaseUrl(settings.store.posterUrl);

    if (!posterBaseUrl) {
        log("No posterUrl configured. Falling back to the Plex application asset.");
        return undefined;
    }

    const imagePath = getBestPlexImagePath(session);

    if (!imagePath) {
        log("No Plex image path found for session.");
        return undefined;
    }

    try {
        if (typeof Native.preparePlexPoster !== "function") {
            warn("Native.preparePlexPoster is missing. Rebuild/reinject Vencord so native.ts is included.");
            return undefined;
        }

        const result = await Native.preparePlexPoster(
            settings.store.plexBaseUrl,
            settings.store.plexToken,
            imagePath,
            normalizePort(settings.store.posterPort)
        );

        log("Prepared Plex poster:", {
            ok: result?.ok,
            error: result?.error,
            publicPath: result?.publicPath,
            port: result?.port,
            originalBytes: result?.originalBytes,
            resizedBytes: result?.resizedBytes
        });

        if (!result?.ok || !result.publicPath) {
            warn("Failed to prepare Plex poster:", result?.error);
            return undefined;
        }

        const publicPosterUrl = joinUrl(posterBaseUrl, result.publicPath);

        if (!publicPosterUrl.startsWith("https://")) {
            warn("Poster URL should be public HTTPS for Discord external images:", publicPosterUrl);
        }

        const assets = await ApplicationAssetUtils.fetchAssetIds(appId, [publicPosterUrl]);

        log("Discord poster asset result:", {
            publicPosterUrl,
            assets
        });

        return assets?.[0];
    } catch (err) {
        warn("Failed to prepare Plex poster for Discord:", err);
        return undefined;
    }
}

async function buildActivity(session: PlexSession): Promise<any | null> {
    const appId = settings.store.appId.trim();

    if (!appId) {
        log("No Discord appId configured.");
        return null;
    }

    const playerState = session.Player?.state;

    if (playerState !== "playing" && !(playerState === "paused" && settings.store.showPaused)) {
        log("Ignoring session because state is", playerState);
        return null;
    }

    const isEpisode = session.type === "episode";
    const isMovie = session.type === "movie";
    const isTrack = session.type === "track";

    const mainTitle = isEpisode
        ? session.grandparentTitle || session.title || "Plex"
        : session.title || "Plex";

    let subtitle = "Plex";

    if (isEpisode) {
        subtitle = [
            session.title,
            formatSeasonEpisode(session.parentTitle)
        ].filter(Boolean).join(" • ");
    } else if (isMovie) {
        subtitle = session.year ? String(session.year) : "Movie";
    } else if (isTrack) {
        subtitle = session.grandparentTitle || session.parentTitle || "Music";
    } else {
        subtitle = session.Player?.title || session.type || "Plex";
    }

    const elapsed = toSeconds(session.viewOffset);
    const duration = toSeconds(session.duration);
    const now = Date.now();

    /*
     * Upload these fallback Rich Presence assets to your Discord application:
     * - plex
     * - play
     * - pause
     *
     * Dynamic posters are served through your configured token-free reverse proxy.
     */
    const largeImage =
        await getPlexPosterAsset(appId, session)
        ?? await getApplicationAsset(appId, "plex");

    const smallImage = await getApplicationAsset(appId, playerState === "paused" ? "pause" : "play");

    const activity: any = {
        application_id: appId,
        name: "Plex",
        type: ActivityType.WATCHING,
        details: mainTitle,
        state: playerState === "paused" ? `Paused • ${subtitle}` : subtitle,

        /*
         * This flag is used by Vencord CustomRPC too.
         */
        flags: 1 << 0
    };

    if (largeImage || smallImage) {
        activity.assets = {
            ...(largeImage && {
                large_image: largeImage,
                large_text: "Plex"
            }),
            ...(smallImage && {
                small_image: smallImage,
                small_text: playerState === "paused" ? "Paused" : "Watching"
            })
        };
    }

    if (playerState === "playing" && elapsed > 0) {
        activity.timestamps = {
            start: now - elapsed * 1000
        };

        if (duration > elapsed) {
            activity.timestamps.end = now + (duration - elapsed) * 1000;
        }
    }

    const buttonUrl = settings.store.buttonUrl.trim();

    if (buttonUrl) {
        activity.buttons = ["Open Plex"];
        activity.metadata = {
            button_urls: [buttonUrl]
        };
    }

    return activity;
}

async function getCurrentPlexSession(): Promise<PlexSession | null> {
    const baseUrl = cleanBaseUrl(settings.store.plexBaseUrl);
    const token = settings.store.plexToken.trim();

    if (!baseUrl) {
        log("No Plex base URL configured.");
        return null;
    }

    if (!token) {
        log("No Plex token configured.");
        return null;
    }

    if (typeof Native.getPlexSessions !== "function") {
        throw new Error("Native.getPlexSessions is missing. Rebuild/reinject Vencord so native.ts is included.");
    }

    log("Fetching Plex sessions through native bridge from", baseUrl);

    const result = await Native.getPlexSessions(baseUrl, token);

    if (!result?.ok) {
        throw new Error(result?.error ?? "Unknown native Plex error");
    }

    const sessions: PlexSession[] = result.sessions ?? [];

    log("Plex sessions:", sessions);

    return (
        sessions.find(s => s.Player?.state === "playing")
        ?? sessions.find(s => s.Player?.state === "paused")
        ?? null
    );
}

function dispatchActivity(activity: any | null) {
    const key = JSON.stringify(activity);

    if (key === lastActivityKey) return;

    lastActivityKey = key;

    log("Dispatching activity:", activity);

    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity,
        socketId: SOCKET_ID
    });
}

async function updatePresence() {
    try {
        const session = await getCurrentPlexSession();

        if (!session) {
            log("No active Plex session.");
            dispatchActivity(null);
            return;
        }

        const activity = await buildActivity(session);
        dispatchActivity(activity);
    } catch (err) {
        warn("Failed to update presence:", err);
        dispatchActivity(null);
    }
}

function startPolling() {
    stopPolling();

    log("Starting Plex Rich Presence.");

    startPosterServer();
    updatePresence();

    const seconds = Math.max(5, Number(settings.store.pollSeconds) || 10);
    interval = setInterval(updatePresence, seconds * 1000);
}

function stopPolling() {
    if (interval) {
        clearInterval(interval);
        interval = null;
    }

    lastActivityKey = "";

    FluxDispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: null,
        socketId: SOCKET_ID
    });

    Native.stopPosterServer?.().catch(err => warn("Failed to stop poster server:", err));

    log("Stopped Plex Rich Presence.");
}

export default definePlugin({
    name: "PlexRichPresence",
    description: "Shows your current Plex playback as Discord Rich Presence.",
    authors: [{ name: "Felicia", id: 0n }],
    tags: ["Activity", "Rich Presence", "Plex"],

    settings,

    start: startPolling,
    stop: stopPolling
});
# Plex Rich Presence for Vencord

A local Vencord userplugin that shows your current Plex playback as Discord Rich Presence.

It can display the current movie/show title, episode information, playback progress, pause/play state, and a dynamic Plex poster image.

## What this plugin does

- Polls your Plex server for active playback sessions.
- Builds a Discord local activity using your Discord Application ID.
- Downloads Plex poster art locally using your Plex token.
- Serves the poster from a tiny local HTTP server on your PC.
- Lets you expose that local poster server through your own HTTPS reverse proxy.
- Sends Discord only the clean public poster URL, not your Plex token.

## Privacy and token safety

Your Plex token is required so the plugin can read Plex sessions and download poster art.

The plugin does **not** put your Plex token in the Discord Rich Presence image URL. Instead, poster art is downloaded locally and then served from the local poster server.

Discord receives a URL like this:

```text
https://your-poster-domain.example/poster/abc123.jpg
```

Discord should **not** receive a URL like this:

```text
https://your-plex-server.example/library/metadata/.../thumb?...X-Plex-Token=YOUR_TOKEN
```

Do not configure your reverse proxy to point directly at Plex. It should point to the local poster server started by this plugin.

## Files

Place the plugin files here:

```text
Vencord/src/userplugins/plexRichPresence/index.tsx
Vencord/src/userplugins/plexRichPresence/native.ts
```

Then rebuild and reinject Vencord:

```powershell
cd C:\Users\YourName\Documents\Vencord
pnpm build
pnpm inject
```

Fully quit Discord from the tray and reopen it afterwards.

## Required Discord application setup

You need a Discord application ID for Rich Presence.

Create or use an application in the Discord Developer Portal, then copy its **Application ID** into the plugin's `appId` setting.

Recommended application assets to upload:

| Asset name | Purpose |
|---|---|
| `plex` | Fallback large image when no poster is available |
| `play` | Small icon while media is playing |
| `pause` | Small icon while media is paused |

Dynamic posters are loaded through external image URLs and do not need to be uploaded as Discord application assets.

## Plugin settings

### `plexBaseUrl`

Your Plex server URL.

Examples:

```text
http://localhost:32400
http://192.168.1.10:32400
http://10.0.0.2:32400
```

This URL is used locally by the plugin to talk to Plex. It does not need to be public.

### `plexToken`

Your Plex authentication token.

This is sensitive and should be treated like a password.

The token is used locally to fetch Plex sessions and poster art. It should not be committed to GitHub. It is stored in your local Vencord settings, not hardcoded in the plugin files.

### `appId`

Your Discord Application ID.

This is not a bot token. It is safe to share in most cases, but each user should normally configure their own application ID.

### `posterUrl`

The public HTTPS URL for your poster reverse proxy.

Example:

```text
https://plexposter.example.com
```

Do not include a trailing slash.

This URL should point to the plugin's local poster server through your reverse proxy. It should not point directly to Plex.

### `posterPort`

The local port used by the poster server on the PC running Discord/Vencord.

Default:

```text
45454
```

You can change it if another program already uses that port.

Your reverse proxy destination must use the same port.

Example reverse proxy destination:

```text
http://YOUR_DISCORD_PC_LAN_IP:45454
```

If you set `posterPort` to `45456`, then your reverse proxy destination must also use port `45456`.

### `pollSeconds`

How often the plugin checks Plex for playback updates.

Default:

```text
10
```

Lower values update faster but make more requests to Plex.

### `showPaused`

Whether to keep showing the Rich Presence when playback is paused.

Default:

```text
true
```

If disabled, the activity disappears while Plex is paused.

### `buttonUrl`

Optional URL for the activity button.

Default:

```text
https://app.plex.tv/desktop
```

This can be changed to your own Plex web URL or left as the Plex web app.

### `debug`

Enables console logging for troubleshooting.

Default:

```text
true
```

When enabled, logs appear in the Discord Developer Tools console with the prefix:

```text
[PlexRichPresence]
```

The native helper may also write logs to:

```text
%APPDATA%\discord\plex-rich-presence.log
```

## Reverse proxy setup

Your reverse proxy should look like this:

```text
Internet / Discord
  -> https://your-poster-domain.example
  -> reverse proxy
  -> http://YOUR_DISCORD_PC_LAN_IP:POSTER_PORT
  -> Vencord local poster server
```

Example:

```text
Source:
HTTPS your-poster-domain.example : 443

Destination:
HTTP 192.168.1.50 : 45454
```

Important:

- Use HTTPS on the public/source side.
- Use HTTP on the destination side.
- Point the destination to the PC running Discord/Vencord.
- Do not point the destination to Plex.
- Make sure Windows Firewall allows inbound TCP traffic on the poster port.

## Test URLs

On the PC running Discord/Vencord:

```text
http://localhost:45454/__health
```

From another device on your LAN:

```text
http://YOUR_DISCORD_PC_LAN_IP:45454/__health
```

Through your public reverse proxy:

```text
https://your-poster-domain.example/__health
```

After a poster has been cached:

```text
https://your-poster-domain.example/poster/latest.jpg
```

A healthy server response looks like this:

```json
{
  "ok": true,
  "port": 45454,
  "boundAddress": "0.0.0.0",
  "cachedPosters": 1,
  "latestPoster": "abc123.jpg",
  "latestPosterUrl": "/poster/abc123.jpg"
}
```

## Troubleshooting

### Discord shows a question mark instead of the poster

Check that the public poster URL is reachable over valid HTTPS.

Test:

```text
https://your-poster-domain.example/__health
https://your-poster-domain.example/poster/latest.jpg
```

If these do not work, Discord cannot load the poster either.

### `localhost:45454` refuses to connect

The local poster server is not running on that port.

Check the plugin setting `posterPort`, then test the correct port:

```powershell
netstat -ano | findstr :45454
```

If your configured port is `45456`, test:

```powershell
netstat -ano | findstr :45456
```

### The public reverse proxy says no poster has been cached yet

This usually means the reverse proxy is reaching the local poster server, but no Plex poster has been prepared yet.

Start playing something in Plex and wait for the next polling interval.

### The reverse proxy returns 502 Bad Gateway

The reverse proxy cannot reach the PC running Discord/Vencord.

Check:

- The destination IP is the Discord/Vencord PC.
- The destination port matches `posterPort`.
- Windows Firewall allows inbound traffic on that port.
- The PC is on and Discord/Vencord is running.

## GitHub safety checklist

Before publishing, make sure you do **not** commit:

- Your Plex token.
- Your real Plex server URL, if you consider it private.
- Your personal reverse proxy hostname, if you do not want it public.
- Local Vencord settings files.
- Logs such as `plex-rich-presence.log`.

The plugin source files should contain defaults/placeholders only. User-specific values should be configured through Vencord settings.

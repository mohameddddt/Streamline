# Streamline

A desktop movie & TV streamer for Windows/macOS/Linux, built on Electron + React + TypeScript.
It speaks the **Stremio addon protocol**, so it works with Torrentio, TorrentsDB, MediaFusion,
Comet, Cinemeta, OpenSubtitles and anything else that publishes a `manifest.json`.

You can either **stream** a title — WebTorrent fetches pieces in order and serves them over a
loopback-only HTTP server, so playback starts long before the file is complete — or **download**
it to keep. Downloads run in the background, survive restarts, and are watchable while still in
progress.

Everything it uses is free. No account, no API key, nothing to pay for.

## Getting an .exe

```bash
npm install
npm run dist
```

That writes two files into `release/`:

- **Streamline-Setup-0.2.0.exe** — an installer. Run it once and you get a Start-menu and
  desktop shortcut, and it updates cleanly.
- **Streamline-Portable-0.2.0.exe** — a single self-contained file. Double-click it and the app
  runs. Nothing is installed; keep it wherever you like.

For development instead:

```bash
npm run dev       # hot-reloading
npm run build     # bundles into out/
npm start         # run the production bundles
npm run icon      # regenerate resources/icon.ico
```

## How it fits together

| Path | Role |
| --- | --- |
| [src/main/index.ts](src/main/index.ts) | Electron main process, window, all IPC handlers |
| [src/main/addons.ts](src/main/addons.ts) | Stremio addon client: catalogs, meta, streams, subtitles |
| [src/main/torrent.ts](src/main/torrent.ts) | WebTorrent engine + range-capable local stream server |
| [src/main/downloads.ts](src/main/downloads.ts) | Download manager: queue, pause/resume, disk storage |
| [src/main/playback.ts](src/main/playback.ts) | Codec probing + on-the-fly remux/transcode via ffmpeg |
| [src/main/trackers.ts](src/main/trackers.ts) | Trakt + Simkl scrobbling, Letterboxd CSV export |
| [src/main/updater.ts](src/main/updater.ts) | Self-update from GitHub Releases |
| [src/main/settings.ts](src/main/settings.ts) | Settings, library and watch-progress storage |
| [src/preload/index.ts](src/preload/index.ts) | Typed `window.api` bridge (contextIsolation on) |
| [src/renderer/src/pages/](src/renderer/src/pages/) | Discover, Search, Detail, Player, Library, Settings |
| [src/shared/types.ts](src/shared/types.ts) | Types shared across all three processes |

The renderer never touches Node or the network directly — everything goes through IPC.

## Addons

Four are installed by default:

- **Cinemeta** `https://v3-cinemeta.strem.io/manifest.json` — catalogs and metadata
- **Torrentio** `https://torrentio.strem.fun/manifest.json` — torrent sources
- **TorrentsDB** `https://torrentsdb.com/manifest.json` — torrent sources
- **OpenSubtitles v3** `https://opensubtitles-v3.strem.io/manifest.json` — subtitles

Add any other addon in Settings by pasting its `manifest.json` URL. If an addon has a configure
page, configure it there first and paste the personalised URL it hands back — that URL carries
your options in it.

## Watching vs. downloading

Every source in the list has two actions:

- **Click the row** to stream it now. Pieces are fetched in order into a temporary cache that is
  wiped when the app closes.
- **↓ save** to download it properly. The file goes to your Downloads folder (configurable), is
  never auto-deleted, and keeps going in the background while you browse. It survives restarts —
  unfinished downloads resume automatically.

A download is playable before it finishes: hitting Play on a partial download streams from the
same torrent, and once complete it plays straight off disk.

## Library

Four tabs:

- **Continue watching** — anything started but under 95% complete, with resume positions
- **Watched** — anything finished, kept as history
- **Downloads** — progress, speed, peers, pause/resume, show-in-folder, delete
- **Saved** — titles bookmarked with "Add to library"

## Watch tracking

**Trakt and Simkl** both have free public APIs, so Streamline scrobbles to them live: it marks
playback started, paused and finished, and a title passing 80% is recorded as watched. Register a
free app on either site, paste the client ID into Settings, and approve the device code that
appears.

**Letterboxd and Serializd cannot be synced automatically.** Letterboxd grants API access only on
request, and Serializd has no public API at all. Instead, Settings exports your history as CSV —
the Letterboxd file carries an `imdbID` column, which their importer matches on exactly.

## Updating

Your settings, library and downloads live outside the install folder (`%APPDATA%\Streamline` and
your downloads folder), so they always survive an update.

Running a newer `Streamline-Setup-*.exe` upgrades in place. For automatic updates, set your repo
under `build.publish` in [package.json](package.json), replacing `YOUR_GITHUB_USERNAME`, and
publish releases with `npx electron-builder --win --publish always`. The app then checks on
startup, downloads in the background, and installs on quit. Until that is set, the Updates panel
in Settings reports that no update server is configured.

## Debrid (optional, paid — off by default)

Streamline is fully functional for free over peer-to-peer torrents, which is the default. If you
ever want one, setting a debrid provider + API key in Settings rewrites the config segment of any
Torrentio-style addon URL so results come back as direct HTTPS links.

## Codecs — everything plays in-app

Chromium alone only decodes H.264/AAC, which leaves out the HEVC, AC3 and DTS releases that make
up a lot of good torrents. Streamline bundles its own ffmpeg and puts it in front of the player:

1. **ffprobe** inspects the file first.
2. If Chromium can already handle it, it plays **direct** — no ffmpeg, native seeking.
3. If only the audio is unsupported (the common AC3 case), it **remuxes**: the video is copied
   untouched and only the audio becomes AAC. Near-zero CPU, starts immediately.
4. If the video itself is unsupported (HEVC), it **transcodes**, preferring a hardware encoder
   (NVENC / QuickSync / AMF) and falling back to x264.

Each encoder is verified by actually encoding a frame at startup, because `ffmpeg -encoders`
lists what was compiled in rather than what your GPU can run.

Remuxed and transcoded output is a live pipe, so it cannot be seeked natively. The player handles
that itself: seeking restarts ffmpeg at the new timestamp and offsets the clock. Because a copied
video stream can only start on a keyframe, a seek can land up to one GOP (typically ~2s) early.

VLC is no longer required. The **Open in external player** button is still there if you want it.

## Note

Streamline ships with no content. What you can legally stream through it depends on the addons you
install and the rights you hold in your country.

# Lunar

Multiplayer lunar lander game. Land your spacecraft on procedurally generated terrain — or crash trying and leave a grave for everyone to see.

Built with Astro, PartyServer (Cloudflare Durable Objects), and canvas.

Each browser owns its lander's physics, fuel, collisions, landing/crash result, and landing score. Physics runs at a fixed 20 Hz regardless of display refresh rate; drawing remains smooth between ticks. The server accepts and relays state at 20 Hz, aggregates scores and session stats, and controls terrain seeds, rounds, play windows, and shared cameras. Remote ships smooth received positions with at most 150 ms of extrapolation. Server echoes never replace the owning browser's current simulation.

Flight reports include a connection authority token, round ID, pause generation, and increasing sequence number. The server validates message structure and finite values, but trusts the reported flight and outcome; it does not repeat physics or attempt anti-cheat. Each pilot's outcome counts once per round. Landing records use the browser's active flight clock, excluding pauses and time offline.

Hidden tabs stop their flight connection. A browser suspension longer than one second also requires a fresh connection before flight resumes; there is no large physics catch-up. The server removes silent flying clients after 15 seconds without recording a crash. A reconnect resumes the last accepted state if that round is still active; when the fleet empties or a round changes, the next flight starts fresh. Opening the same pilot in another tab transfers ownership and stops the superseded tab from reconnecting. Live flights are in memory; after a server restart, reconnecting clients start a new flight while saved session stats remain.

Open `/display` for a spectator display of the whole fleet. Display browsers do not create ships or participate in rounds. The camera follows ships approaching the terrain and briefly holds on successful landings. Nearby approaches share a view; distant approaches split into up to four views. More than four simultaneous approaches use the full fleet view. Players enter a name before their first launch; the browser remembers it for future visits. Names appear beside rockets and in landing announcements.

## Controls

- **Arrow keys / WASD** — rotate and thrust
- **Touch** — left third rotates left, center thrusts, right third rotates right
- **S on `/display`** — toggle live session stats; **Escape** returns to flight; **Q** ends the session and returns every display to session setup

## Display options and leaderboard

The top-left leaderboard shows the current session name and the top five pilots, ranked by landings by default. Press **O** on `/display` to rename the session, quit, choose a leaderboard metric, toggle the leaderboard or QR code, and edit the QR title. Available rankings are landings, crashes, connected time, longest or current landing streak, and fastest landing. Rankings include everyone in the session, including disconnected pilots. Options apply to every display and persist until the session ends. Renaming preserves totals and the original expiry.

Run `node tests/display-options.test.cjs` to check ranking and setting validation.

## Display camera

Open `/camera` on a second browser or device to control all `/display` views. Use the direction buttons or arrow keys to pan and the zoom buttons or + / − keys to zoom. Choose a ship to follow it through rounds and reconnects. Following overrides all other landing close-ups. Without following, automatic landing close-ups return to the saved custom viewport afterward. Stop following restores the custom view; Reset to auto clears it. A camera controller does not create a ship or stats session.

Run `node tests/camera.test.cjs` for camera behavior checks.

## Session stats

The first visit to `/display` without an active session asks for a session name. All displays share that named session. Each session has a fixed 12-hour lifetime; refreshes and reconnects do not extend it. After expiry, the display asks for a new name and starts fresh totals. Players can play without an active stats session. Ships already connected when a session starts are included automatically, without reloading or interrupting their flight. Ending a stats session leaves player flights running normally.

The display tracks unique ships, successful landings, crashes, fastest landing, longest successful landing streak, most landings, most crashes, and longest time connected. Ships joined counts each saved browser UUID once per session, including across reconnects and multiple tabs. Names are labels, so two browsers with the same name remain separate ships. Spectator displays do not count. Landing times begin when gameplay starts (or when a player joins an active round), excluding terrain mapping. A crash resets the pilot's current streak; the longest streak remains their record. Incomplete flights do not count as landings or crashes.

Pilot records use a saved browser ID, so reconnecting or changing a name preserves totals in the same browser. Connected time accumulates across visits, excludes time offline, and counts overlapping tabs once. Active session records are saved in Durable Object storage and survive display refreshes and server restarts until their original expiry time. Tracking starts with this feature; earlier flights cannot be recovered.

Run `node tests/session-stats.test.cjs` and `node tests/session-lifecycle.test.cjs` to check stats accounting, unique ships, session creation, and expiry.

## Hack Night play windows

A session named **Hack Night** (case-insensitive) automatically follows Purdue's local time (`America/Indiana/Indianapolis`). Play is unrestricted before 9:00 p.m. Starting at 9:00 p.m., the game pauses for the first 45 minutes of every hour and opens for the final 15 minutes: paused 9:00–9:45, playable 9:45–10:00, paused 10:00–10:45, and so on through midnight until the session ends. Sessions opened between midnight and 9:00 a.m. use the previous night's schedule.

Players and displays show a pause screen with a countdown, plus the time remaining during play windows. Browsers freeze their flights while the server freezes round timers and rejects flight reports during pauses, including for newly connected players. Flights resume automatically; paused time is excluded from landing records. Connected-time totals still measure time connected. The schedule survives restarts through the saved session. Other session names and play without a session remain unrestricted; renaming or ending a Hack Night session updates the schedule immediately.

Run `node tests/play-schedule.test.cjs` to check schedule boundaries, overnight play, time zones, and server pause/resume behavior.

## Development

```sh
bun install
bun dev
```

Run `bun run test` for physics, client-loop, relay, lifecycle, schedule, camera, and stats checks. With the dev server running, run `bun run test:network http://127.0.0.1:4321` for real WebSocket checks in an isolated local room (two pilots, spectators, reconnects, results, and new rounds). The flight protocol changed with client authority; publish the browser bundle and server together when deploying.

## Deploy

```sh
bun run deploy
```

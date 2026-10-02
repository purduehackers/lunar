# Lunar

Multiplayer lunar lander game. Land your spacecraft on procedurally generated terrain — or crash trying and leave a grave for everyone to see.

Built with Astro, PartyServer (Cloudflare Durable Objects), and canvas.

Open `/display` for a spectator display of the whole fleet. Display browsers do not create ships or participate in rounds. The camera follows ships approaching the terrain and briefly holds on successful landings. Nearby approaches share a view; distant approaches split into up to four views. More than four simultaneous approaches use the full fleet view. Landing announcements identify ships by color.

## Controls

- **Arrow keys / WASD** — rotate and thrust
- **Touch** — left third rotates left, center thrusts, right third rotates right

## Development

```sh
bun install
bun dev
```

## Deploy

```sh
bun run deploy
```

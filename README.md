<p align="center">
  <img src="src/assets/icons/menu.svg" alt="Mint logo" width="75">
</p>

<h1 align="center">
  Xserve
</h1>

<p align="center">
  <a href="https://github.com/triflare/xserve/actions/workflows/ci.yml">
    <img src="https://github.com/triflare/xserve/actions/workflows/ci.yml/badge.svg" alt="Continuous integration">
  </a>
    <a href="https://github.com/triflare/xserve/actions/workflows/cd.yml">
    <img src="https://github.com/triflare/xserve/actions/workflows/cd.yml/badge.svg" alt="Continuous deployment">
  </a>
</p>

Xserve is a simple server architecture, designed for multi-player games or something like group chat software. It primarily uses WebSockets and requires a Node.js server (Xserver) to run so other hosts can create "sub-servers" (or just servers).

## Key Features

- **Based on Mint:** Xserve uses the Mint developent toolchain, so it'll be rock-hard and stable in the future.
- **Ease of use:** To start a server, just connect to an Xserver by URL, and create your server with a name & password.
- **Star topology:** As all good things should be, Xserve servers have star topologies. There is one host and many clients.
- **Operational quick checks:** Xserver now exposes `GET /health` and `GET /stats` for uptime/room visibility.
- **Auto cleanup:** Offline rooms are removed automatically if no host comes back within 5 minutes.
- **Live room count in Scratch:** The extension includes a `room user count` reporter block powered by `get_room_info`.

## Documentation

If you want a more practical guide, start with the docs in [docs/toc.md](docs/toc.md).

# Using the Xserve extension

Xserve lets your Scratch project create a room, let players join, and send messages between host and clients.

If you are building multiplayer games, lobbies, or chat-like systems in TurboWarp, this is the part you use in your project scripts.

> [!IMPORTANT]
>
> Xserve is an **unsandboxed** extension. Make sure **Run unsandboxed** is enabled when you load it.

## What each side does

- **Host:** Creates the room and controls who joins.
- **Client:** Joins the host's room and exchanges messages.
- **Xserver:** The server software both sides connect to.

Think of Xserver as the meeting place, and your host/client scripts as the people talking.

## Typical Scratch workflow

1. **Connect** with `connect to Xserver URL [URL]`.
2. **Host flow:** create a room with `create server with name [ROOM] ...`.
3. **Client flow:** join with `join server with name [ROOM] password [PASS]`.
4. Exchange data with:
   - `client: send message [DATA] to host`
   - `host: send message [DATA] to client ID [ID]`
   - `host: broadcast message [DATA] to all clients`
5. React to incoming data using:
   - `when I receive a message`
   - `last message data`
   - `last message sender client ID`

## Useful blocks to check status

- `am I connected to a server?`
- `am I hosting?`
- `client: my ID`
- `room client count`
- `last error`

If something goes wrong, check `last error` first before retrying.

## Public and private rooms

When creating a room, you can choose:

- **public**: shows up in `public servers`
- **private**: does not appear in the public list

Use `public servers` to get a JSON list of available public room names.

## Host moderation blocks

Hosts can manage their room with:

- `host: kick client ID [ID]`
- `host: delete my server`

Deleting a room disconnects everyone in that room.

## Server health and stats blocks

You can check server status directly from Scratch:

- `server health status`
- `server stats`
- `Xserve + Xserver version`

If your server has admin protection enabled, set the token first using:

- `set server admin token to [TOKEN]`

## Downloading the server software

Use the button block:

- `Download Xserver Software...`

This downloads `xserver.js` so you can self-host your own server.

# Running Xserver software

Xserver is the server program that powers Xserve rooms.

If Xserve is the extension in Scratch, Xserver is the service that keeps hosts and clients connected.

## Quick start

1. Make sure you have Node.js installed.
2. In this repository, run:

   ```bash
   npm ci
   npm start
   ```

3. Your server will start on port `8080` by default.
4. In your Scratch project, connect using a URL like:

   ```text
   ws://localhost:8080
   ```

> [!NOTE]
>
> If you're hosting this for other people, use your public server URL instead of `localhost`.

## Basic server options

You can set these before starting the server:

- `PORT` — choose a different port
- `XSERVER_ADMIN_TOKEN` — protect full stats access
- `XSERVER_ROOMS_DB_PATH` — choose where room data is stored

Example:

```bash
PORT=9090 XSERVER_ADMIN_TOKEN=mySecret npm start
```

## Built-in health and stats endpoints

Xserver includes two HTTP endpoints:

- `GET /health` — quick status check (`ok` when ready)
- `GET /stats` — server and room activity data

If `XSERVER_ADMIN_TOKEN` is set, `/stats` needs authentication.

You can pass the token using either:

- `x-xserve-admin-token` header, or
- `Authorization: Bearer <token>`

## Room behavior to know

- Room names are letters and numbers only.
- A room has one host and many clients.
- Public rooms can be listed by clients.
- If a host disconnects, that room is marked offline.
- Offline rooms are cleaned up automatically after a short delay.

## Troubleshooting

- Confirm the URL in your Scratch project matches your Xserver URL.
- Use extension blocks like `server health status` and `last error` to quickly diagnose issues.
- Check your server terminal logs if clients cannot create or join rooms.

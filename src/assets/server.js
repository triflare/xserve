/*
 * Xserve signalling server ("Xserver")
 * Run with `npm start` or `pnpm start`
 */

import WebSocket, { WebSocketServer } from 'ws';
import chalk from 'chalk';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 10;
const RATE_LIMIT_COOLDOWN_MS = 1000;

// Key-Value store for active rooms
// Format: {
//   roomName: {
//     host: WebSocket,
//     password: string,
//     isPublic: boolean,
//     clients: Map<clientId, WebSocket>
//   }
// }
const rooms = {};
let nextClientId = 1;

// --- Logger Utilities ---
const getTimestamp = () => {
  const now = new Date();
  const h = now.getHours().toString().padStart(2, '0');
  const m = now.getMinutes().toString().padStart(2, '0');
  const s = now.getSeconds().toString().padStart(2, '0');
  const ms = now.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
};

const log = {
  info: msg =>
    console.log(
      `${chalk.gray(`[${getTimestamp()}]`)} ${chalk.cyan.bold('[INFO]')}    ${msg}`
    ),
  success: msg =>
    console.log(
      `${chalk.gray(`[${getTimestamp()}]`)} ${chalk.green.bold('[SUCCESS]')} ${msg}`
    ),
  warn: msg =>
    console.log(
      `${chalk.gray(`[${getTimestamp()}]`)} ${chalk.yellow.bold('[WARN]')}    ${msg}`
    ),
  error: msg =>
    console.log(
      `${chalk.gray(`[${getTimestamp()}]`)} ${chalk.red.bold('[ERROR]')}   ${msg}`
    ),
  verbose: msg =>
    console.log(
      `${chalk.gray(`[${getTimestamp()}]`)} ${chalk.magenta.bold('[VERBOSE]')} ${msg}`
    ),
};

// --- Startup Banner ---
console.log(chalk.blue.bold('================================================'));
console.log(chalk.blue.bold(' Xserve Signalling Server (Xserver)'));
console.log(chalk.blue.bold('================================================\n'));
log.success(`Server initialized successfully.`);
log.info(`Listening for WebSocket connections on port ${PORT}`);
log.info(`Local Endpoint: ws://localhost:${PORT}\n`);

const sanitizeAlphaNumeric = value => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  return /^[a-z0-9]+$/i.test(trimmed) ? trimmed : '';
};

const parsePublicFlag = value =>
  value === true ||
  String(value ?? '')
    .trim()
    .toLowerCase() === 'true';

const getPublicRoomNames = () =>
  Object.entries(rooms)
    .filter(([, roomState]) => !roomState.password || roomState.isPublic)
    .map(([roomName]) => roomName);

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let isHost = false;
  const myClientId = nextClientId++;
  const clientIp = req.socket.remoteAddress;
  let rateWindowStart = Date.now();
  let rateWindowCount = 0;
  let blockedUntil = 0;

  log.info(`New connection established | Client ID: ${myClientId} | IP: ${clientIp}`);

  ws.on('message', rawMessage => {
    const now = Date.now();
    const messageSize = Buffer.isBuffer(rawMessage)
      ? rawMessage.length
      : Buffer.byteLength(String(rawMessage), 'utf8');

    if (messageSize > MAX_MESSAGE_BYTES) {
      log.warn(
        `Ignored oversized payload from Client ${myClientId} (${messageSize} bytes > ${MAX_MESSAGE_BYTES} bytes)`
      );
      return;
    }

    if (now - rateWindowStart >= 1000) {
      rateWindowStart = now;
      rateWindowCount = 0;
    }
    rateWindowCount++;

    if (now < blockedUntil) {
      return;
    }
    if (rateWindowCount > MAX_MESSAGES_PER_SECOND) {
      blockedUntil = now + RATE_LIMIT_COOLDOWN_MS;
      log.warn(
        `Rate limit triggered for Client ${myClientId}; ignoring input until cooldown ends`
      );
      return;
    }

    const messageAsString = rawMessage.toString();
    log.verbose(`Raw payload from Client ${myClientId}: ${messageAsString}`);

    try {
      const data = JSON.parse(messageAsString);
      const sanitizedRoom = sanitizeAlphaNumeric(data.room);
      const sanitizedTarget = sanitizeAlphaNumeric(data.target);

      switch (data.type) {
        case 'create': {
          if (!sanitizedRoom) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid room name.' }));
            return;
          }

          if (rooms[sanitizedRoom]) {
            log.warn(
              `Client ${myClientId} attempted to create existing room: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Room already exists.' }));
            return;
          }

          rooms[sanitizedRoom] = {
            host: ws,
            password: data.password || '',
            isPublic: parsePublicFlag(data.public),
            clients: new Map(),
          };

          currentRoom = sanitizedRoom;
          isHost = true;
          ws.send(JSON.stringify({ type: 'created', room: currentRoom }));
          log.success(`Room created | Room: "${currentRoom}" | Host ID: ${myClientId}`);
          break;
        }

        case 'join': {
          if (!sanitizedRoom) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid room name.' }));
            return;
          }

          const targetRoom = rooms[sanitizedRoom];
          if (!targetRoom) {
            log.warn(
              `Client ${myClientId} attempted to join non-existent room: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' }));
            return;
          }
          if (targetRoom.password && targetRoom.password !== data.password) {
            log.warn(
              `Client ${myClientId} failed authentication for room: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password.' }));
            return;
          }

          currentRoom = sanitizedRoom;
          isHost = false;
          targetRoom.clients.set(myClientId, ws);

          // Notify the client they successfully joined
          ws.send(JSON.stringify({ type: 'joined', room: currentRoom, id: myClientId }));

          // Notify the host that a new client joined
          targetRoom.host.send(JSON.stringify({ type: 'client_joined', id: myClientId }));
          log.success(
            `Client joined room | Client ID: ${myClientId} | Room: "${currentRoom}"`
          );
          break;
        }

        case 'send_to_host': {
          if (!isHost && currentRoom && rooms[currentRoom]) {
            rooms[currentRoom].host.send(
              JSON.stringify({
                type: 'message',
                sender: myClientId,
                data: data.data,
              })
            );
            log.verbose(
              `Message routed to host | From: Client ${myClientId} | Room: "${currentRoom}"`
            );
          } else {
            log.warn(`Invalid send_to_host attempt | Client ID: ${myClientId}`);
          }
          break;
        }

        case 'send_to_client': {
          if (isHost && currentRoom && rooms[currentRoom]) {
            const targetClient = rooms[currentRoom].clients.get(Number(sanitizedTarget));
            if (targetClient && targetClient.readyState === WebSocket.OPEN) {
              targetClient.send(
                JSON.stringify({
                  type: 'message',
                  sender: 'host',
                  data: data.data,
                })
              );
              log.verbose(
                `Message routed to client | Target: ${sanitizedTarget} | Room: "${currentRoom}"`
              );
            } else {
              log.warn(
                `Host attempted to send to invalid client | Target: ${sanitizedTarget}`
              );
            }
          }
          break;
        }

        case 'broadcast': {
          if (isHost && currentRoom && rooms[currentRoom]) {
            let broadcastCount = 0;
            rooms[currentRoom].clients.forEach(clientWs => {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: 'message',
                    sender: 'host',
                    data: data.data,
                  })
                );
                broadcastCount++;
              }
            });
            log.verbose(
              `Broadcast sent | Room: "${currentRoom}" | Recipients: ${broadcastCount}`
            );
          }
          break;
        }

        case 'fetch_rooms': {
          ws.send(JSON.stringify({ type: 'rooms_list', rooms: getPublicRoomNames() }));
          break;
        }

        case 'kick': {
          if (isHost && currentRoom && rooms[currentRoom]) {
            const targetClientId = Number(sanitizedTarget);
            const targetClient = rooms[currentRoom].clients.get(targetClientId);
            if (targetClient && targetClient.readyState === WebSocket.OPEN) {
              targetClient.send(JSON.stringify({ type: 'kicked', by: 'host' }));
              targetClient.close();
              rooms[currentRoom].clients.delete(targetClientId);
              log.info(
                `Host kicked client | Room: "${currentRoom}" | Target Client: ${targetClientId}`
              );
            } else {
              log.warn(
                `Host attempted to kick invalid client | Room: "${currentRoom}" | Target: ${sanitizedTarget}`
              );
            }
          }
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          log.warn(
            `Unknown message type received | Client ID: ${myClientId} | Type: ${data.type}`
          );
      }
    } catch (e) {
      log.error(
        `Malformed message received from Client ${myClientId} | Error: ${e.message}`
      );
    }
  });

  ws.on('close', () => {
    log.info(`Connection closed | Client ID: ${myClientId}`);

    if (currentRoom && rooms[currentRoom]) {
      if (isHost) {
        // Host left: Kick all clients and destroy the room
        let evictedCount = 0;
        rooms[currentRoom].clients.forEach((clientWs, _id) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: 'error',
                message: 'Host disconnected. Room closed.',
              })
            );
            clientWs.close();
            evictedCount++;
          }
        });
        delete rooms[currentRoom];
        log.warn(
          `Host disconnected, room destroyed | Room: "${currentRoom}" | Evicted Clients: ${evictedCount}`
        );
      } else {
        // Client left: Remove them and notify host
        rooms[currentRoom].clients.delete(myClientId);
        if (rooms[currentRoom].host.readyState === WebSocket.OPEN) {
          rooms[currentRoom].host.send(
            JSON.stringify({ type: 'client_left', id: myClientId })
          );
        }
        log.info(`Client left room | Client ID: ${myClientId} | Room: "${currentRoom}"`);
      }
    }
  });
});

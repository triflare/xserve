/*
 * Xserve signalling server ("Xserver")
 * Run with `npm start` or `pnpm start`
 */

import WebSocket, { WebSocketServer } from 'ws';
import chalk from 'chalk';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 10;
const RATE_LIMIT_COOLDOWN_MS = 1000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOMS_DB_PATH = path.resolve(__dirname, '../../xserver-rooms.json');

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

class RoomStore {
  constructor(filePath = DEFAULT_ROOMS_DB_PATH) {
    this.filePath = filePath;
    this.rooms = {};
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.rooms = {};
      return;
    }

    try {
      const rawData = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(rawData);
      if (!isPlainObject(parsed)) {
        this.rooms = {};
        return;
      }
      this.rooms = Object.fromEntries(
        Object.entries(parsed).map(([roomName, roomData]) => [
          String(roomName),
          {
            password: String(roomData?.password ?? ''),
            isPublic: roomData?.isPublic === true,
          },
        ])
      );
    } catch (error) {
      const safeErrorMessage = String(error?.message ?? 'Unknown error')
        .replace(/[\r\n]/g, '')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 200);
      console.warn(
        `Unable to read persisted rooms database at "${this.filePath}"; starting with an empty store (${safeErrorMessage})`
      );
      this.rooms = {};
    }
  }

  _persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempFilePath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempFilePath, JSON.stringify(this.rooms, null, 2));
    try {
      fs.renameSync(tempFilePath, this.filePath);
    } catch (error) {
      if (fs.existsSync(tempFilePath)) {
        fs.rmSync(tempFilePath, { force: true });
      }
      throw error;
    }
  }

  getRoom(roomName) {
    return this.rooms[roomName] || null;
  }

  upsertRoom(roomName, roomData) {
    const priorState = this.rooms[roomName];
    this.rooms[roomName] = {
      password: String(roomData?.password ?? ''),
      isPublic: roomData?.isPublic === true,
    };
    try {
      this._persist();
    } catch (error) {
      if (priorState === undefined) {
        delete this.rooms[roomName];
      } else {
        this.rooms[roomName] = priorState;
      }
      throw error;
    }
  }

  deleteRoom(roomName) {
    const priorState = this.rooms[roomName];
    if (priorState === undefined) return;
    delete this.rooms[roomName];
    try {
      this._persist();
    } catch (error) {
      this.rooms[roomName] = priorState;
      throw error;
    }
  }

  getPublicRoomNames() {
    return Object.entries(this.rooms)
      .filter(([, roomState]) => !roomState.password || roomState.isPublic)
      .map(([roomName]) => roomName);
  }
}

const safeStringEquals = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.from(String(right ?? ''), 'utf8');
  const maxLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const leftPadded = Buffer.alloc(maxLength);
  const rightPadded = Buffer.alloc(maxLength);
  const leftLengthBuffer = Buffer.alloc(4);
  const rightLengthBuffer = Buffer.alloc(4);
  leftBuffer.copy(leftPadded);
  rightBuffer.copy(rightPadded);
  leftLengthBuffer.writeUInt32BE(leftBuffer.length >>> 0);
  rightLengthBuffer.writeUInt32BE(rightBuffer.length >>> 0);
  const valuesMatch = timingSafeEqual(leftPadded, rightPadded);
  const lengthsMatch = timingSafeEqual(leftLengthBuffer, rightLengthBuffer);
  return Boolean(Number(valuesMatch) & Number(lengthsMatch));
};

const roomStore = new RoomStore(
  process.env.XSERVER_ROOMS_DB_PATH || DEFAULT_ROOMS_DB_PATH
);
roomStore.load();

// Format: Map<roomName, { host: WebSocket, clients: Map<clientId, WebSocket> }>
const activeRooms = new Map();
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

    if (now < blockedUntil) {
      return;
    }
    rateWindowCount++;
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

          const activeRoom = activeRooms.get(sanitizedRoom);
          const password = String(data.password ?? '');
          if (activeRoom && activeRoom.host.readyState === WebSocket.OPEN) {
            log.warn(
              `Client ${myClientId} attempted to create existing room: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Room already exists.' }));
            return;
          }

          const existingRoom = roomStore.getRoom(sanitizedRoom);
          if (existingRoom && !safeStringEquals(existingRoom.password, password)) {
            log.warn(
              `Client ${myClientId} attempted to create room with invalid credentials: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Unable to create room.' }));
            return;
          }

          roomStore.upsertRoom(sanitizedRoom, {
            password,
            isPublic: parsePublicFlag(data.public),
          });
          activeRooms.set(sanitizedRoom, { host: ws, clients: new Map() });

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

          const targetRoomRecord = roomStore.getRoom(sanitizedRoom);
          if (!targetRoomRecord) {
            log.warn(
              `Client ${myClientId} attempted to join non-existent room: "${sanitizedRoom}"`
            );
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' }));
            return;
          }

          const targetRoom = activeRooms.get(sanitizedRoom);
          if (!targetRoom || targetRoom.host.readyState !== WebSocket.OPEN) {
            log.warn(
              `Client ${myClientId} attempted to join offline room: "${sanitizedRoom}"`
            );
            ws.send(
              JSON.stringify({ type: 'error', message: 'Room is currently offline.' })
            );
            return;
          }

          if (
            targetRoomRecord.password &&
            !safeStringEquals(targetRoomRecord.password, data.password)
          ) {
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
          const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
          if (!isHost && currentActiveRoom) {
            currentActiveRoom.host.send(
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
          const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
          if (isHost && currentActiveRoom) {
            const targetClient = currentActiveRoom.clients.get(Number(sanitizedTarget));
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
          const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
          if (isHost && currentActiveRoom) {
            let broadcastCount = 0;
            currentActiveRoom.clients.forEach(clientWs => {
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
          const activePublicRooms = roomStore
            .getPublicRoomNames()
            .filter(roomName => activeRooms.has(roomName));
          ws.send(JSON.stringify({ type: 'rooms_list', rooms: activePublicRooms }));
          break;
        }

        case 'kick': {
          const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
          if (isHost && currentActiveRoom) {
            const targetClientId = Number(sanitizedTarget);
            const targetClient = currentActiveRoom.clients.get(targetClientId);
            if (targetClient && targetClient.readyState === WebSocket.OPEN) {
              targetClient.send(JSON.stringify({ type: 'kicked', by: 'host' }));
              targetClient.close();
              currentActiveRoom.clients.delete(targetClientId);
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

        case 'delete_room': {
          const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
          if (isHost && currentRoom && currentActiveRoom) {
            let evictedCount = 0;
            const clientsToEvict = Array.from(currentActiveRoom.clients.values());
            clientsToEvict.forEach(clientWs => {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Host deleted this room.',
                  })
                );
                clientWs.close();
                evictedCount++;
              }
            });
            const deletedRoomName = currentRoom;
            activeRooms.delete(currentRoom);
            roomStore.deleteRoom(currentRoom);
            currentRoom = null;
            isHost = false;
            ws.send(JSON.stringify({ type: 'room_deleted', room: deletedRoomName }));
            log.info(
              `Host deleted room | Room: "${deletedRoomName}" | Evicted Clients: ${evictedCount}`
            );
          } else {
            log.warn(`Invalid delete_room attempt | Client ID: ${myClientId}`);
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

    const currentActiveRoom = currentRoom ? activeRooms.get(currentRoom) : null;
    if (currentRoom && currentActiveRoom) {
      if (isHost) {
        // Host left: Kick all clients and keep room metadata for future reconnects
        let evictedCount = 0;
        const clientsToEvict = Array.from(currentActiveRoom.clients.values());
        clientsToEvict.forEach(clientWs => {
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
        activeRooms.delete(currentRoom);
        log.warn(
          `Host disconnected, room is now offline | Room: "${currentRoom}" | Evicted Clients: ${evictedCount}`
        );
      } else {
        // Client left: Remove them and notify host
        currentActiveRoom.clients.delete(myClientId);
        if (currentActiveRoom.host.readyState === WebSocket.OPEN) {
          currentActiveRoom.host.send(
            JSON.stringify({ type: 'client_left', id: myClientId })
          );
        }
        log.info(`Client left room | Client ID: ${myClientId} | Room: "${currentRoom}"`);
      }
    }
  });
});

/**
 * Unit tests for src/01-core.js — Xserve Scratch extension
 */

import { describe, it, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installScratchMock } from './helpers/mock-scratch.js';

const OPEN = 1;
const CLOSED = 3;

class MockWebSocket {
  static OPEN = OPEN;

  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = OPEN;
    this.sentMessages = [];
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;

    MockWebSocket.instances.push(this);
    setImmediate(() => {
      if (typeof this.onopen === 'function') {
        this.onopen();
      }
    });
  }

  send(data) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = CLOSED;
    if (typeof this.onclose === 'function') {
      this.onclose();
    }
  }
}

globalThis.WebSocket = MockWebSocket;

const { mock, restore } = installScratchMock();
mock.extensions.unsandboxed = true;
mock.Cast = { toString: value => String(value) };
mock.canFetch = () => Promise.resolve(true);
mock.fetch = () =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ status: 'ok' }),
  });
mock.download = (data, filename) => {
  mock.lastDownload = { data, filename };
};
mock.vm = { runtime: { startHats: () => [] } };

let extension;
mock.extensions.register = instance => {
  extension = instance;
};

await import('../src/01-core.js');

const lastWs = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

function clearExtensionState() {
  extension.disconnect();
  extension.connected = false;
  extension.isHost = false;
  extension.currentRoom = '';
  extension.myId = '';
  extension.lastMessage = '';
  extension.lastSender = '';
  extension.lastEventClient = '';
  extension._messageQueue = [];
  extension._clientEventQueue = [];
  extension._currentActionResolve = null;
  extension._publicRoomsCache = [];
  extension._publicRoomsInFlightPromise = null;
  extension._publicRoomsLastFetchAt = 0;
  extension._roomInfoCache = { clientCount: 0, isHost: false };
  extension._roomInfoInFlightPromise = null;
  extension._serverBaseUrl = '';
  extension._serverAdminToken = '';
  extension._serverStatsCache = '{}';
  extension._lastError = '';
  if (extension._actionTimeout) {
    clearTimeout(extension._actionTimeout);
    extension._actionTimeout = null;
  }
  if (extension._publicRoomsTimeout) {
    clearTimeout(extension._publicRoomsTimeout);
    extension._publicRoomsTimeout = null;
  }
  if (extension._roomInfoTimeout) {
    clearTimeout(extension._roomInfoTimeout);
    extension._roomInfoTimeout = null;
  }
}

describe('Xserve extension', () => {
  before(() => {
    assert.ok(extension, 'Extension must register during module import');
  });

  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    clearExtensionState();
  });

  afterEach(() => {
    clearExtensionState();
  });

  after(() => {
    delete globalThis.WebSocket;
    restore();
  });

  it('exposes extension metadata', () => {
    const info = extension.getInfo();
    assert.equal(info.id, 'tfXserve');
    assert.equal(typeof info.name, 'string');
    assert.ok(Array.isArray(info.blocks));
    assert.ok(info.blocks.length > 0);
    assert.ok(info.menus.CLIENT_EVENTS.items.some(item => item.value === 'joined'));
    assert.ok(info.blocks.some(block => block.opcode === 'deleteServer'));
    assert.ok(info.blocks.some(block => block.opcode === 'getRoomUserCount'));
    assert.ok(info.blocks.some(block => block.opcode === 'setServerAdminToken'));
    assert.ok(info.blocks.some(block => block.opcode === 'getServerHealth'));
    assert.ok(info.blocks.some(block => block.opcode === 'getServerStats'));
    assert.ok(info.blocks.some(block => block.opcode === 'getXserveVersion'));
    assert.ok(info.blocks.some(block => block.opcode === 'getLastError'));
  });

  it('connectToServer resolves when WebSocket opens', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();
    assert.ok(ws, 'WebSocket instance should be created');
    assert.equal(ws.url, 'wss://example.com/?xserveVersion=2.0.0');
    assert.equal(extension.connected, false);
  });

  it('disconnect resets state and closes the socket', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();
    extension.disconnect();
    assert.equal(ws.readyState, CLOSED);
    assert.equal(extension.connected, false);
    assert.equal(extension.isHost, false);
    assert.equal(extension.currentRoom, '');
  });

  it('creates a room and updates host state when received created response', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const result = extension.createRoom({
      ROOM: 'myRoom',
      PASS: 'secret',
      VISIBILITY: 'public',
    });
    assert.equal(ws.sentMessages.length, 1);
    const payload = JSON.parse(ws.sentMessages[0]);
    assert.equal(payload.type, 'create');
    assert.equal(payload.room, 'myRoom');
    assert.equal(payload.password, 'secret');
    assert.equal(payload.public, true);

    ws.onmessage({ data: JSON.stringify({ type: 'created', room: 'myRoom' }) });
    await result;

    assert.equal(extension.connected, true);
    assert.equal(extension.isHost, true);
    assert.equal(extension.currentRoom, 'myRoom');
  });

  it('sends private and default room create payloads as non-public', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const privateResult = extension.createRoom({
      ROOM: 'privateRoom',
      PASS: 'secret',
      VISIBILITY: 'private',
    });
    assert.equal(ws.sentMessages.length, 1);
    let payload = JSON.parse(ws.sentMessages[0]);
    assert.equal(payload.type, 'create');
    assert.equal(payload.room, 'privateRoom');
    assert.equal(payload.password, 'secret');
    assert.equal(payload.public, false);

    ws.onmessage({ data: JSON.stringify({ type: 'created', room: 'privateRoom' }) });
    await privateResult;

    const defaultResult = extension.createRoom({
      ROOM: 'defaultRoom',
      PASS: 'secret',
    });
    assert.equal(ws.sentMessages.length, 2);
    payload = JSON.parse(ws.sentMessages[1]);
    assert.equal(payload.type, 'create');
    assert.equal(payload.room, 'defaultRoom');
    assert.equal(payload.password, 'secret');
    assert.equal(payload.public, false);

    ws.onmessage({ data: JSON.stringify({ type: 'created', room: 'defaultRoom' }) });
    await defaultResult;
  });

  it('joins a room and updates client state when received joined response', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const result = extension.joinRoom({ ROOM: 'myRoom', PASS: 'secret' });
    assert.equal(ws.sentMessages.length, 1);
    const payload = JSON.parse(ws.sentMessages[0]);
    assert.equal(payload.type, 'join');
    assert.equal(payload.room, 'myRoom');
    assert.equal(payload.password, 'secret');

    ws.onmessage({ data: JSON.stringify({ type: 'joined', room: 'myRoom', id: 'client-123' }) });
    await result;

    assert.equal(extension.connected, true);
    assert.equal(extension.isHost, false);
    assert.equal(extension.currentRoom, 'myRoom');
    assert.equal(extension.myId, 'client-123');
  });

  it('handles incoming messages and toggles whenMessageReceived', () => {
    extension._handleMessage(JSON.stringify({ type: 'message', sender: '42', data: 'hello' }));
    assert.equal(extension.lastMessage, 'hello');
    assert.equal(extension.lastSender, '42');
    assert.equal(extension.whenMessageReceived(), true);
    assert.equal(extension.whenMessageReceived(), false);
  });

  it('stores server error messages for last error reporter', () => {
    extension._handleMessage(
      JSON.stringify({ type: 'error', message: 'Version mismatch. Expected 2.0.0.' })
    );
    assert.equal(extension.getLastError(), 'Version mismatch. Expected 2.0.0.');
  });

  it('handles client join and leave events and whenClientEvent matching', () => {
    extension._handleMessage(JSON.stringify({ type: 'client_joined', id: '42' }));
    assert.equal(extension.lastEventClient, '42');
    assert.equal(extension.whenClientEvent({ EVENT: 'joined' }), true);
    assert.equal(extension.lastEventClient, '42');
    assert.equal(extension.whenClientEvent({ EVENT: 'left' }), false);

    extension._handleMessage(JSON.stringify({ type: 'client_left', id: '99' }));
    assert.equal(extension.lastEventClient, '99');
    assert.equal(extension.whenClientEvent({ EVENT: 'left' }), true);
    assert.equal(extension.lastEventClient, '99');
  });

  it('sends the correct commands based on extension role', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    extension.isHost = false;
    extension.sendToHost({ DATA: 'hello' });
    assert.equal(ws.sentMessages.length, 1);
    assert.deepEqual(JSON.parse(ws.sentMessages[0]), {
      type: 'send_to_host',
      data: 'hello',
    });

    extension.isHost = true;
    extension.sendToClient({ ID: '1', DATA: 'hello' });
    extension.broadcast({ DATA: 'everyone' });
    extension.kickClient({ ID: '1' });
    extension.deleteServer();
    assert.equal(ws.sentMessages.length, 5);
    assert.deepEqual(JSON.parse(ws.sentMessages[1]), {
      type: 'send_to_client',
      target: '1',
      data: 'hello',
    });
    assert.deepEqual(JSON.parse(ws.sentMessages[2]), {
      type: 'broadcast',
      data: 'everyone',
    });
    assert.deepEqual(JSON.parse(ws.sentMessages[3]), {
      type: 'kick',
      target: '1',
    });
    assert.deepEqual(JSON.parse(ws.sentMessages[4]), {
      type: 'delete_room',
    });
  });

  it('fetches public room names from the server', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const pending = extension.getPublicRooms();
    assert.deepEqual(JSON.parse(ws.sentMessages[0]), { type: 'fetch_rooms' });
    ws.onmessage({ data: JSON.stringify({ type: 'rooms_list', rooms: ['lobby', 'openroom'] }) });

    const result = await pending;
    assert.equal(result, JSON.stringify(['lobby', 'openroom']));

    ws.sentMessages.length = 0;
    const cached = extension.getPublicRooms();
    assert.equal(cached, JSON.stringify(['lobby', 'openroom']));
    assert.equal(ws.sentMessages.length, 0);
  });

  it('debounces concurrent getPublicRooms requests and resolves pending request on close', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const pendingA = extension.getPublicRooms();
    const pendingB = extension.getPublicRooms();
    assert.equal(pendingA, pendingB);
    assert.equal(ws.sentMessages.length, 1);
    assert.deepEqual(JSON.parse(ws.sentMessages[0]), { type: 'fetch_rooms' });

    ws.close();
    const result = await pendingA;
    assert.equal(result, JSON.stringify([]));
    assert.equal(extension._publicRoomsInFlightPromise, null);
  });

  it('fetches room user count from the server', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();

    const pending = extension.getRoomUserCount();
    assert.deepEqual(JSON.parse(ws.sentMessages[0]), { type: 'get_room_info' });
    ws.onmessage({ data: JSON.stringify({ type: 'room_info', clientCount: 3, isHost: false }) });

    const result = await pending;
    assert.equal(result, 3);
    assert.equal(extension._roomInfoCache.clientCount, 3);
    assert.equal(extension._roomInfoCache.isHost, false);
  });

  it('debounces concurrent getRoomUserCount requests and resolves pending request on close', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    const ws = lastWs();
    extension._roomInfoCache = { clientCount: 9, isHost: false };

    const pendingA = extension.getRoomUserCount();
    const pendingB = extension.getRoomUserCount();
    assert.equal(pendingA, pendingB);
    assert.equal(ws.sentMessages.length, 1);
    assert.deepEqual(JSON.parse(ws.sentMessages[0]), { type: 'get_room_info' });

    ws.close();
    const result = await pendingA;
    assert.equal(result, 0);
    assert.equal(extension._roomInfoCache.clientCount, 0);
    assert.equal(extension._roomInfoInFlightPromise, null);
  });

  it('clears host room state when room_deleted is received', () => {
    extension.isHost = true;
    extension.currentRoom = 'myRoom';
    extension._roomInfoCache = { clientCount: 5, isHost: true };
    extension._handleMessage(JSON.stringify({ type: 'room_deleted', room: 'myRoom' }));
    assert.equal(extension.isHost, false);
    assert.equal(extension.currentRoom, '');
    assert.equal(extension._roomInfoCache.clientCount, 0);
  });

  it('downloads the server asset to the expected filename', () => {
    extension.downloadServerSoftware();
    assert.deepEqual(mock.lastDownload, { data: undefined, filename: 'xserver.js' });
  });

  it('sets the server admin token for stats requests', () => {
    extension.setServerAdminToken({ TOKEN: 'abc123' });
    assert.equal(extension._serverAdminToken, 'abc123');
  });

  it('fetches server health status from the HTTP endpoint', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    let fetchEndpoint = '';
    mock.fetch = endpoint => {
      fetchEndpoint = endpoint;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    };

    const status = await extension.getServerHealth();
    assert.equal(status, 'ok');
    assert.equal(fetchEndpoint, 'https://example.com/health');
  });

  it('fetches server stats and sends admin token header when set', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    extension.setServerAdminToken({ TOKEN: 'secret-token' });

    let requestHeaders = null;
    mock.fetch = (_endpoint, options) => {
      requestHeaders = options?.headers || {};
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ activeRooms: 2 }),
      });
    };

    const stats = await extension.getServerStats();
    assert.equal(stats, '{"activeRooms":2}');
    assert.equal(requestHeaders['x-xserve-admin-token'], 'secret-token');
  });

  it('reports extension and server versions', async () => {
    await extension.connectToServer({ URL: 'wss://example.com' });
    mock.fetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'ok', version: '2.0.0' }),
      });

    const versions = await extension.getXserveVersion();
    assert.equal(versions, '2.0.0 + 2.0.0');
  });
});

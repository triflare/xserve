/**
 * Integration tests for src/assets/server.js — Xserve signalling server
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '../src/assets/server.js');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to obtain ephemeral port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForServerReady(port, proc) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error('Server process exited prematurely');
    }

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(ws, 'open');
      ws.close();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  throw new Error('Server did not become ready in time');
}

async function openClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, 'open');
  return ws;
}

async function receiveJson(ws) {
  const [message] = await once(ws, 'message');
  return JSON.parse(message.toString());
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

describe('Xserve signalling server', () => {
  let serverProc;
  let port;

  before(async () => {
    port = await getFreePort();
    serverProc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Ensure the child process output is drained so stdout/stderr buffering
    // cannot block the server process in CI environments.
    serverProc.stdout?.resume();
    serverProc.stderr?.resume();

    try {
      await Promise.race([
        waitForServerReady(port, serverProc),
        once(serverProc, 'error').then(([err]) => {
          throw err;
        }),
      ]);
    } catch (err) {
      if (serverProc.exitCode === null) {
        serverProc.kill();
      }
      throw err;
    }
  });

  after(async () => {
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill('SIGTERM');
      await once(serverProc, 'exit');
    }
  });

  it('rejects join requests for non-existent rooms', async () => {
    const client = await openClient(port);
    sendJson(client, { type: 'join', room: 'missing-room', password: '' });

    const response = await receiveJson(client);
    assert.equal(response.type, 'error');
    assert.equal(response.message, 'Room not found.');
    client.close();
  });

  it('creates a room and notifies the host when a client joins', async () => {
    const host = await openClient(port);
    const client = await openClient(port);

    sendJson(host, { type: 'create', room: 'room-a', password: 'secret' });
    const created = await receiveJson(host);
    assert.equal(created.type, 'created');
    assert.equal(created.room, 'room-a');

    sendJson(client, { type: 'join', room: 'room-a', password: 'secret' });
    const joined = await receiveJson(client);
    assert.equal(joined.type, 'joined');
    assert.equal(joined.room, 'room-a');
    assert.equal(typeof joined.id, 'number');

    const hostEvent = await receiveJson(host);
    assert.equal(hostEvent.type, 'client_joined');
    assert.equal(hostEvent.id, joined.id);

    host.close();
    client.close();
  });

  it('routes client messages to the host and host messages to the client', async () => {
    const host = await openClient(port);
    const client = await openClient(port);

    sendJson(host, { type: 'create', room: 'room-b', password: '' });
    await receiveJson(host);
    sendJson(client, { type: 'join', room: 'room-b', password: '' });
    const joined = await receiveJson(client);
    await receiveJson(host); // client_joined

    sendJson(client, { type: 'send_to_host', data: 'hello-host' });
    const hostMessage = await receiveJson(host);
    assert.equal(hostMessage.type, 'message');
    assert.equal(hostMessage.data, 'hello-host');
    assert.equal(hostMessage.sender, joined.id);

    sendJson(host, { type: 'send_to_client', target: String(joined.id), data: 'hello-client' });
    const clientMessage = await receiveJson(client);
    assert.equal(clientMessage.type, 'message');
    assert.equal(clientMessage.data, 'hello-client');

    host.close();
    client.close();
  });

  it('broadcasts messages from the host to all connected clients', async () => {
    const host = await openClient(port);
    const client1 = await openClient(port);
    const client2 = await openClient(port);

    sendJson(host, { type: 'create', room: 'room-c', password: '' });
    await receiveJson(host);
    sendJson(client1, { type: 'join', room: 'room-c', password: '' });
    const joined1 = await receiveJson(client1);
    await receiveJson(host);
    sendJson(client2, { type: 'join', room: 'room-c', password: '' });
    const joined2 = await receiveJson(client2);
    await receiveJson(host);

    sendJson(host, { type: 'broadcast', data: 'hello-all' });

    const broadcast1 = await receiveJson(client1);
    const broadcast2 = await receiveJson(client2);
    assert.equal(broadcast1.type, 'message');
    assert.equal(broadcast1.data, 'hello-all');
    assert.equal(broadcast2.type, 'message');
    assert.equal(broadcast2.data, 'hello-all');

    host.close();
    client1.close();
    client2.close();
  });
});

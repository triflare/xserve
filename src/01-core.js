if (!Scratch.extensions.unsandboxed) {
  throw new Error('Xserve must be run unsandboxed to handle events properly.');
}

class tfXserve {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.isHost = false;
    this.currentRoom = '';
    this.myId = '';

    this.lastMessage = '';
    this.lastSender = '';
    this.lastEventClient = '';

    this._messageQueue = [];
    this._clientEventQueue = [];

    this._currentActionResolve = null;
    this._actionTimeout = null;
    this._publicRoomsCache = [];
    this._publicRoomsResolve = null;
    this._publicRoomsTimeout = null;
    this._heartbeatInterval = null;
  }

  getInfo() {
    return {
      id: 'tfXserve',
      name: Scratch.translate('Xserve'),
      color1: '#c44dff',
      color2: '#9b2ad4',
      menuIconURI: mint.assets.get('icons/menu.svg'),
      blocks: [
        {
          blockType: Scratch.BlockType.BUTTON,
          text: Scratch.translate('Download Xserver Software...'),
          func: 'downloadServerSoftware',
        },
        {
          opcode: 'connectToServer',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('connect to Xserver URL [URL]'),
          arguments: {
            URL: {
              type: Scratch.ArgumentType.STRING,
              defaultValue: '',
            },
          },
        },
        {
          opcode: 'disconnect',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('disconnect from Xserver'),
        },
        '---',
        {
          opcode: 'createRoom',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate(
            'create server with name [ROOM] password [PASS] visibility [VISIBILITY]'
          ),
          arguments: {
            ROOM: { type: Scratch.ArgumentType.STRING, defaultValue: 'myServer' },
            PASS: { type: Scratch.ArgumentType.STRING, defaultValue: 'AbCdEfG!' },
            VISIBILITY: {
              type: Scratch.ArgumentType.STRING,
              menu: 'ROOM_VISIBILITY',
            },
          },
        },
        {
          opcode: 'joinRoom',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('join server with name [ROOM] password [PASS]'),
          arguments: {
            ROOM: { type: Scratch.ArgumentType.STRING, defaultValue: 'myServer' },
            PASS: { type: Scratch.ArgumentType.STRING, defaultValue: 'AbCdEfG!' },
          },
        },
        '---',
        {
          opcode: 'isConnected',
          blockType: Scratch.BlockType.BOOLEAN,
          text: Scratch.translate('connected to a server?'),
        },
        {
          opcode: 'amIHost',
          blockType: Scratch.BlockType.BOOLEAN,
          text: Scratch.translate('am I hosting?'),
        },
        {
          opcode: 'getMyId',
          blockType: Scratch.BlockType.REPORTER,
          text: Scratch.translate('client: my ID'),
        },
        '---',
        {
          opcode: 'getPublicRooms',
          blockType: Scratch.BlockType.REPORTER,
          text: Scratch.translate('public servers'),
        },
        '---',
        {
          opcode: 'sendToHost',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('client: send message [DATA] to host'),
          arguments: {
            DATA: { type: Scratch.ArgumentType.STRING, defaultValue: 'Hello host!' },
          },
        },
        {
          opcode: 'sendToClient',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('host: send message [DATA] to client ID [ID]'),
          arguments: {
            DATA: { type: Scratch.ArgumentType.STRING, defaultValue: 'Hello client!' },
            ID: { type: Scratch.ArgumentType.STRING, defaultValue: '1' },
          },
        },
        {
          opcode: 'broadcast',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('host: broadcast message [DATA] to all clients'),
          arguments: {
            DATA: {
              type: Scratch.ArgumentType.STRING,
              defaultValue: 'Attention everyone!',
            },
          },
        },
        {
          opcode: 'kickClient',
          blockType: Scratch.BlockType.COMMAND,
          text: Scratch.translate('host: kick client ID [ID]'),
          arguments: {
            ID: { type: Scratch.ArgumentType.STRING, defaultValue: '1' },
          },
        },
        '---',
        {
          opcode: 'whenMessageReceived',
          blockType: Scratch.BlockType.EVENT,
          text: Scratch.translate('when I receive a message'),
          isEdgeActivated: false,
          shouldRestartExistingThreads: true,
        },
        {
          opcode: 'getLastMessage',
          blockType: Scratch.BlockType.REPORTER,
          text: Scratch.translate('last message data'),
        },
        {
          opcode: 'getLastSender',
          blockType: Scratch.BlockType.REPORTER,
          text: Scratch.translate('last message sender client ID'),
        },
        '---',
        {
          opcode: 'whenClientEvent',
          blockType: Scratch.BlockType.EVENT,
          text: Scratch.translate('host: when client [EVENT]'),
          isEdgeActivated: false,
          shouldRestartExistingThreads: true,
          arguments: {
            EVENT: { type: Scratch.ArgumentType.STRING, menu: 'CLIENT_EVENTS' },
          },
        },
        {
          opcode: 'getLastEventClient',
          blockType: Scratch.BlockType.REPORTER,
          text: Scratch.translate('last event client ID'),
        },
      ],
      menus: {
        CLIENT_EVENTS: {
          acceptReporters: false,
          items: [
            { text: Scratch.translate('joins the server'), value: 'joined' },
            { text: Scratch.translate('leaves the server'), value: 'left' },
          ],
        },
        ROOM_VISIBILITY: {
          acceptReporters: false,
          items: [
            { text: Scratch.translate('public'), value: 'public' },
            { text: Scratch.translate('private'), value: 'private' },
          ],
        },
      },
    };
  }

  _handleMessage(messageAsString) {
    try {
      const msg = JSON.parse(messageAsString);

      // Handle Setup Phase Responses
      if (msg.type === 'created' || msg.type === 'joined' || msg.type === 'error') {
        if (msg.type === 'created') {
          this.connected = true;
          this.isHost = true;
          this.currentRoom = msg.room;
        } else if (msg.type === 'joined') {
          this.connected = true;
          this.isHost = false;
          this.currentRoom = msg.room;
          this.myId = msg.id;
        } else if (msg.type === 'error') {
          const safeErrorMessage = Scratch.Cast.toString(msg.message).replace(
            /[\r\n]/g,
            ''
          );
          console.error('Xserve Error:', safeErrorMessage);
        }

        // Release the pending block
        if (this._currentActionResolve) {
          this._currentActionResolve();
          this._currentActionResolve = null;
          clearTimeout(this._actionTimeout);
        }
        return;
      }

      // Handle Gameplay Phase Events
      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'rooms_list') {
        this._publicRoomsCache = Array.isArray(msg.rooms)
          ? msg.rooms.map(room => Scratch.Cast.toString(room))
          : [];
        if (this._publicRoomsResolve) {
          this._publicRoomsResolve(this._formatPublicRooms());
          this._publicRoomsResolve = null;
          clearTimeout(this._publicRoomsTimeout);
          this._publicRoomsTimeout = null;
        }
        return;
      }

      if (msg.type === 'kicked') {
        console.warn('Xserve: You were removed from the room by the host.');
        if (this.ws) {
          this.ws.close();
        }
        return;
      }

      if (msg.type === 'message') {
        this.lastMessage = msg.data;
        this.lastSender = msg.sender;
        this._messageQueue.push(msg);
        const threads = Scratch.vm.runtime.startHats('tfXserve_whenMessageReceived');
        console.log(`[Xserve] Message received! Fired ${threads.length} threads.`);
      } else if (msg.type === 'client_joined') {
        this.lastEventClient = msg.id;
        this._clientEventQueue.push({ event: 'joined', id: msg.id });
        const threads = Scratch.vm.runtime.startHats('tfXserve_whenClientEvent', {
          EVENT: 'joined',
        });
        console.log(`[Xserve] Client joined! Fired ${threads.length} threads.`);
      } else if (msg.type === 'client_left') {
        this.lastEventClient = msg.id;
        this._clientEventQueue.push({ event: 'left', id: msg.id });
        const threads = Scratch.vm.runtime.startHats('tfXserve_whenClientEvent', {
          EVENT: 'left',
        });
        console.log(`[Xserve] Client left! Fired ${threads.length} threads.`);
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message', err);
    }
  }

  _formatPublicRooms() {
    return this._publicRoomsCache.join(', ');
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  _sendAndWait(msgObj, resolve) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      resolve();
      return;
    }

    this._currentActionResolve = resolve;

    // 5 second timeout so scratch blocks don't hang infinitely
    if (this._actionTimeout) clearTimeout(this._actionTimeout);
    this._actionTimeout = setTimeout(() => {
      if (this._currentActionResolve) {
        console.warn('Xserve: Request timed out');
        this._currentActionResolve();
        this._currentActionResolve = null;
      }
    }, 5000);

    this.ws.send(JSON.stringify(msgObj));
  }

  async connectToServer(args) {
    if (this.ws) {
      this.ws.close();
    }

    const url = Scratch.Cast.toString(args.URL);
    if (!(await Scratch.canFetch(url))) {
      console.error('Xserve: Cannot fetch URL', url);
      return;
    }

    return new Promise(resolve => {
      try {
        // eslint-disable-next-line turbowarp/check-can-fetch
        this.ws = new WebSocket(url);
      } catch (e) {
        console.error('Xserve: Invalid URL', e);
        resolve();
        return;
      }

      this.ws.onopen = () => {
        this._startHeartbeat();
        resolve();
      };

      this.ws.onclose = () => {
        this._stopHeartbeat();
        this.connected = false;
        this.isHost = false;
        this.currentRoom = '';
        this.myId = '';
      };

      this.ws.onmessage = e => this._handleMessage(e.data);

      this.ws.onerror = () => {
        console.error('Xserve: Connection failed');
        resolve();
      };
    });
  }

  disconnect() {
    this._stopHeartbeat();
    if (this._publicRoomsTimeout) {
      clearTimeout(this._publicRoomsTimeout);
      this._publicRoomsTimeout = null;
    }
    this._publicRoomsResolve = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.isHost = false;
    this.currentRoom = '';
  }

  createRoom(args) {
    return new Promise(resolve => {
      this._sendAndWait(
        {
          type: 'create',
          room: Scratch.Cast.toString(args.ROOM),
          password: Scratch.Cast.toString(args.PASS),
          public: Scratch.Cast.toString(args.VISIBILITY) === 'public',
        },
        resolve
      );
    });
  }

  joinRoom(args) {
    return new Promise(resolve => {
      this._sendAndWait(
        {
          type: 'join',
          room: Scratch.Cast.toString(args.ROOM),
          password: Scratch.Cast.toString(args.PASS),
        },
        resolve
      );
    });
  }

  isConnected() {
    return this.connected;
  }
  amIHost() {
    return this.isHost;
  }
  getMyId() {
    return this.myId;
  }
  getLastMessage() {
    return this.lastMessage;
  }
  getLastSender() {
    return this.lastSender;
  }
  getPublicRooms() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this._formatPublicRooms();
    }

    return new Promise(resolve => {
      if (this._publicRoomsResolve) {
        this._publicRoomsResolve(this._formatPublicRooms());
      }

      this._publicRoomsResolve = resolve;

      if (this._publicRoomsTimeout) {
        clearTimeout(this._publicRoomsTimeout);
      }
      this._publicRoomsTimeout = setTimeout(() => {
        if (this._publicRoomsResolve) {
          this._publicRoomsResolve(this._formatPublicRooms());
          this._publicRoomsResolve = null;
        }
      }, 3000);

      this.ws.send(JSON.stringify({ type: 'fetch_rooms' }));
    });
  }

  whenMessageReceived() {
    if (this._messageQueue.length === 0) return false;
    this._messageQueue.shift();
    return true;
  }

  whenClientEvent(args) {
    const expectedEvent = Scratch.Cast.toString(args.EVENT);
    const queueIndex = this._clientEventQueue.findIndex(
      entry => entry.event === expectedEvent
    );
    if (queueIndex === -1) return false;

    const [matchedEvent] = this._clientEventQueue.splice(queueIndex, 1);
    this.lastEventClient = matchedEvent.id;
    return true;
  }

  getLastEventClient() {
    return this.lastEventClient;
  }

  sendToHost(args) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.isHost) {
      this.ws.send(
        JSON.stringify({
          type: 'send_to_host',
          data: Scratch.Cast.toString(args.DATA),
        })
      );
    }
  }

  sendToClient(args) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isHost) {
      this.ws.send(
        JSON.stringify({
          type: 'send_to_client',
          target: Scratch.Cast.toString(args.ID),
          data: Scratch.Cast.toString(args.DATA),
        })
      );
    }
  }

  broadcast(args) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isHost) {
      this.ws.send(
        JSON.stringify({
          type: 'broadcast',
          data: Scratch.Cast.toString(args.DATA),
        })
      );
    }
  }

  kickClient(args) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isHost) {
      this.ws.send(
        JSON.stringify({
          type: 'kick',
          target: Scratch.Cast.toString(args.ID),
        })
      );
    }
  }

  downloadServerSoftware() {
    Scratch.download(mint.assets.get('server.js'), 'xserver.js');
  }
}

Scratch.extensions.register(new tfXserve());

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50e6 // 50MB for PDF sharing
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Room state ──
const rooms = new Map();

function generateRoomCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      users: new Map(),
      strokes: {},       // page -> stroke[]
      pdfData: null,      // shared PDF as base64
      pdfName: '',
      totalPages: 0,
      createdAt: Date.now()
    });
  }
  return rooms.get(roomId);
}

// Random colors for users
const USER_COLORS = [
  '#6c5ce7', '#ff6b6b', '#339af0', '#51cf66', '#fcc419',
  '#ff922b', '#f06595', '#20c997', '#845ef7', '#e64980',
  '#5c7cfa', '#ff8787', '#38d9a9', '#fab005', '#4dabf7'
];

// ── Socket.io handlers ──
io.on('connection', (socket) => {
  let currentRoom = null;
  let userData = null;

  console.log(`[+] Connected: ${socket.id}`);

  // ── Create room ──
  socket.on('create-room', ({ username }, callback) => {
    const roomId = generateRoomCode();
    const room = getRoom(roomId);
    const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

    userData = {
      id: socket.id,
      username,
      color,
      initials: username.slice(0, 2).toUpperCase(),
      page: 1
    };

    room.users.set(socket.id, userData);
    socket.join(roomId);
    currentRoom = roomId;

    console.log(`[Room] ${username} created room ${roomId}`);
    callback({ roomId, user: userData, users: Array.from(room.users.values()) });
  });

  // ── Join room ──
  socket.on('join-room', ({ roomId, username }, callback) => {
    roomId = roomId.toUpperCase();
    if (!rooms.has(roomId)) {
      return callback({ error: 'Room introuvable' });
    }

    const room = getRoom(roomId);
    const usedColors = Array.from(room.users.values()).map(u => u.color);
    const availableColors = USER_COLORS.filter(c => !usedColors.includes(c));
    const color = availableColors.length > 0
      ? availableColors[Math.floor(Math.random() * availableColors.length)]
      : USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

    userData = {
      id: socket.id,
      username,
      color,
      initials: username.slice(0, 2).toUpperCase(),
      page: 1
    };

    room.users.set(socket.id, userData);
    socket.join(roomId);
    currentRoom = roomId;

    // Notify others
    socket.to(roomId).emit('user-joined', userData);

    console.log(`[Room] ${username} joined room ${roomId} (${room.users.size} users)`);

    callback({
      roomId,
      user: userData,
      users: Array.from(room.users.values()),
      strokes: room.strokes,
      pdfData: room.pdfData,
      pdfName: room.pdfName,
      totalPages: room.totalPages
    });
  });

  // ── PDF shared ──
  socket.on('share-pdf', ({ pdfBase64, pdfName, totalPages }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.pdfData = pdfBase64;
    room.pdfName = pdfName;
    room.totalPages = totalPages;
    room.strokes = {}; // Reset strokes on new PDF

    socket.to(currentRoom).emit('pdf-shared', { pdfBase64, pdfName, totalPages });
    console.log(`[PDF] ${userData?.username} shared "${pdfName}" (${totalPages} pages)`);
  });

  // ── Stroke drawing ──
  socket.on('stroke-start', (stroke) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-start', { ...stroke, userId: socket.id });
  });

  socket.on('stroke-move', (point) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-move', { ...point, userId: socket.id });
  });

  socket.on('stroke-end', ({ page, stroke }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);

    // Store stroke
    if (!room.strokes[page]) room.strokes[page] = [];
    room.strokes[page].push({ ...stroke, userId: socket.id, username: userData?.username });

    socket.to(currentRoom).emit('stroke-end', {
      page,
      stroke: { ...stroke, userId: socket.id, username: userData?.username }
    });
  });

  // ── Shape / text added ──
  socket.on('add-shape', ({ page, shape }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room.strokes[page]) room.strokes[page] = [];
    const fullShape = { ...shape, userId: socket.id, username: userData?.username };
    room.strokes[page].push(fullShape);
    socket.to(currentRoom).emit('add-shape', { page, shape: fullShape });
  });

  // ── Undo ──
  socket.on('undo', ({ page }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (room.strokes[page]) {
      // Remove last stroke from this user
      for (let i = room.strokes[page].length - 1; i >= 0; i--) {
        if (room.strokes[page][i].userId === socket.id) {
          room.strokes[page].splice(i, 1);
          break;
        }
      }
    }
    // Broadcast full page state
    io.to(currentRoom).emit('page-strokes', { page, strokes: room.strokes[page] || [] });
  });

  // ── Clear page ──
  socket.on('clear-page', ({ page }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.strokes[page] = [];
    io.to(currentRoom).emit('page-strokes', { page, strokes: [] });
  });

  // ── Cursor movement ──
  socket.on('cursor-move', ({ x, y, page }) => {
    if (!currentRoom || !userData) return;
    socket.to(currentRoom).emit('cursor-move', {
      userId: socket.id,
      username: userData.username,
      color: userData.color,
      initials: userData.initials,
      x, y, page
    });
  });

  // ── Page change ──
  socket.on('page-change', ({ page }) => {
    if (!currentRoom || !userData) return;
    userData.page = page;
    socket.to(currentRoom).emit('user-page-change', {
      userId: socket.id,
      username: userData.username,
      page
    });
  });

  // ── Chat ──
  socket.on('chat-message', ({ text }) => {
    if (!currentRoom || !userData) return;
    const msg = {
      userId: socket.id,
      username: userData.username,
      color: userData.color,
      initials: userData.initials,
      text,
      timestamp: Date.now()
    };
    io.to(currentRoom).emit('chat-message', msg);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.users.delete(socket.id);

      io.to(currentRoom).emit('user-left', {
        userId: socket.id,
        username: userData?.username
      });

      console.log(`[-] ${userData?.username || socket.id} left room ${currentRoom} (${room.users.size} remaining)`);

      // Cleanup empty rooms after 5 min
      if (room.users.size === 0) {
        setTimeout(() => {
          if (rooms.has(currentRoom) && rooms.get(currentRoom).users.size === 0) {
            rooms.delete(currentRoom);
            console.log(`[Cleanup] Room ${currentRoom} deleted`);
          }
        }, 5 * 60 * 1000);
      }
    }
  });
});

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    connections: io.engine.clientsCount
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎨 CoDraw PDF Server`);
  console.log(`  ────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://0.0.0.0:${PORT}\n`);
});

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const MAX_CHAT_HISTORY = 200;

// In-memory room store (fine for local dev / single instance deployment).
const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function generateRoomId(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let roomId = "";

  for (let index = 0; index < length; index += 1) {
    roomId += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return roomId;
}

function getUniqueRoomId() {
  let roomId = generateRoomId();

  while (rooms.has(roomId)) {
    roomId = generateRoomId();
  }

  return roomId;
}

function sanitizeUsername(username) {
  const fallback = "Guest";

  if (!username || typeof username !== "string") {
    return fallback;
  }

  return username.trim().slice(0, 24) || fallback;
}

function sanitizeVideoId(videoId) {
  if (!videoId || typeof videoId !== "string") {
    return "dQw4w9WgXcQ";
  }

  return videoId.trim().slice(0, 32) || "dQw4w9WgXcQ";
}

function getPlaybackSnapshot(room) {
  const { playback } = room;

  if (!playback.isPlaying) {
    return {
      isPlaying: false,
      currentTime: playback.currentTime,
      lastUpdateAt: playback.lastUpdateAt,
    };
  }

  const elapsedSeconds = (Date.now() - playback.lastUpdateAt) / 1000;

  return {
    isPlaying: true,
    currentTime: playback.currentTime + elapsedSeconds,
    lastUpdateAt: Date.now(),
  };
}

function createSyncPayload(room, type, extra = {}) {
  const snapshot = getPlaybackSnapshot(room);

  return {
    type,
    videoId: room.videoId,
    isPlaying: snapshot.isPlaying,
    currentTime: snapshot.currentTime,
    serverSentAt: Date.now(),
    ...extra,
  };
}

function updatePlaybackFromHost(room, nextPlayback) {
  room.playback = {
    ...nextPlayback,
    currentTime: Math.max(0, Number(nextPlayback.currentTime) || 0),
    isPlaying: Boolean(nextPlayback.isPlaying),
    lastUpdateAt: Date.now(),
  };
}

function serializeUsers(room) {
  return [...room.users.entries()].map(([socketId, user]) => ({
    socketId,
    username: user.username,
    isHost: socketId === room.hostSocketId,
  }));
}

app.post("/api/create-room", (req, res) => {
  const roomId = getUniqueRoomId();
  const videoId = sanitizeVideoId(req.body?.videoId);

  rooms.set(roomId, {
    id: roomId,
    hostSocketId: null,
    videoId,
    users: new Map(),
    chatHistory: [],
    playback: {
      isPlaying: false,
      currentTime: 0,
      lastUpdateAt: Date.now(),
    },
  });

  res.json({ roomId });
});

app.get("/api/room/:roomId", (req, res) => {
  const roomId = String(req.params.roomId || "").trim().toUpperCase();
  const room = rooms.get(roomId);

  if (!room) {
    return res.status(404).json({ exists: false });
  }

  return res.json({ exists: true, roomId: room.id });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, username }) => {
    const normalizedRoomId = String(roomId || "").trim().toUpperCase();

    if (!normalizedRoomId || !rooms.has(normalizedRoomId)) {
      socket.emit("room-error", "Room not found. Please check the invite link.");
      return;
    }

    const room = rooms.get(normalizedRoomId);
    const safeUsername = sanitizeUsername(username);

    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    socket.data.username = safeUsername;

    room.users.set(socket.id, { username: safeUsername });

    // First user becomes host.
    if (!room.hostSocketId) {
      room.hostSocketId = socket.id;
    }

    socket.emit("joined-room", {
      roomId: room.id,
      videoId: room.videoId,
      isHost: socket.id === room.hostSocketId,
      users: serializeUsers(room),
      chatHistory: room.chatHistory,
      playback: getPlaybackSnapshot(room),
      hostSocketId: room.hostSocketId,
    });

    socket.to(normalizedRoomId).emit("user-joined", {
      username: safeUsername,
      users: serializeUsers(room),
    });

    io.to(normalizedRoomId).emit("users-updated", {
      users: serializeUsers(room),
      hostSocketId: room.hostSocketId,
    });
  });

  socket.on("chat-message", ({ message }) => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const text = String(message || "").trim().slice(0, 400);

    if (!text) {
      return;
    }

    io.to(roomId).emit("chat-message", {
      username: socket.data.username,
      message: text,
      timestamp: Date.now(),
    });

    room.chatHistory.push({
      username: socket.data.username,
      message: text,
      timestamp: Date.now(),
    });

    if (room.chatHistory.length > MAX_CHAT_HISTORY) {
      room.chatHistory.splice(0, room.chatHistory.length - MAX_CHAT_HISTORY);
    }
  });

  socket.on("host-control", ({ type, currentTime, videoId, isPlaying }) => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);

    // Only host can control playback for everyone.
    if (socket.id !== room.hostSocketId) {
      return;
    }

    if (type === "load-video") {
      room.videoId = sanitizeVideoId(videoId);
      updatePlaybackFromHost(room, {
        isPlaying: false,
        currentTime: Number(currentTime) || 0,
      });

      socket.to(roomId).emit("sync-event", createSyncPayload(room, "load-video"));

      return;
    }

    if (type === "play") {
      updatePlaybackFromHost(room, {
        isPlaying: true,
        currentTime: Number(currentTime) || 0,
      });

      socket.to(roomId).emit("sync-event", createSyncPayload(room, "play"));
      return;
    }

    if (type === "pause") {
      updatePlaybackFromHost(room, {
        isPlaying: false,
        currentTime: Number(currentTime) || 0,
      });

      socket.to(roomId).emit("sync-event", createSyncPayload(room, "pause"));
      return;
    }

    if (type === "seek") {
      updatePlaybackFromHost(room, {
        isPlaying: room.playback.isPlaying,
        currentTime: Number(currentTime) || 0,
      });

      socket.to(roomId).emit("sync-event", createSyncPayload(room, "seek"));
      return;
    }

    if (type === "time-update") {
      updatePlaybackFromHost(room, {
        isPlaying: typeof isPlaying === "boolean" ? isPlaying : room.playback.isPlaying,
        currentTime: Number(currentTime) || 0,
      });

      socket.to(roomId).emit("sync-event", createSyncPayload(room, "clock"));
    }
  });

  socket.on("request-sync", () => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);

    socket.emit("sync-event", createSyncPayload(room, "sync-state"));
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    const leavingUser = room.users.get(socket.id);

    room.users.delete(socket.id);

    if (leavingUser) {
      socket.to(roomId).emit("user-left", {
        username: leavingUser.username,
      });
    }

    // If host leaves, transfer host role to the first remaining user.
    if (room.hostSocketId === socket.id) {
      const nextHost = room.users.keys().next().value || null;
      room.hostSocketId = nextHost;

      if (nextHost) {
        io.to(roomId).emit("host-changed", {
          hostSocketId: nextHost,
          users: serializeUsers(room),
        });
      }
    }

    if (room.users.size === 0) {
      rooms.delete(roomId);
      return;
    }

    io.to(roomId).emit("users-updated", {
      users: serializeUsers(room),
      hostSocketId: room.hostSocketId,
    });
  });
});

server.listen(PORT, () => {
  console.log(`SyncTube server is running on http://localhost:${PORT}`);
});

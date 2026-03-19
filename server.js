const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
  pingInterval: 25000,
  pingTimeout: 20000,
});
const MAX_CHAT_HISTORY = 200;
const HOST_RECONNECT_GRACE_MS = 7000;
const USER_RECONNECT_GRACE_MS = 2500;

// In-memory room store (fine for local dev / single instance deployment).
const rooms = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

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

function generateHostKey(length = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let hostKey = "";

  for (let index = 0; index < length; index += 1) {
    hostKey += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return hostKey;
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

function appendChatHistory(room, messageEntry) {
  room.chatHistory.push(messageEntry);

  if (room.chatHistory.length > MAX_CHAT_HISTORY) {
    room.chatHistory.splice(0, room.chatHistory.length - MAX_CHAT_HISTORY);
  }
}

function clearPendingHostHandoff(room) {
  if (room.pendingHostHandoffTimer) {
    clearTimeout(room.pendingHostHandoffTimer);
    room.pendingHostHandoffTimer = null;
  }

  room.pendingHostClientId = null;
}

function clearPendingLeaveNotice(room, clientId) {
  if (!clientId || !room.pendingLeaveNotices?.has(clientId)) {
    return false;
  }

  const timer = room.pendingLeaveNotices.get(clientId);
  clearTimeout(timer);
  room.pendingLeaveNotices.delete(clientId);
  return true;
}

function clearAllPendingLeaveNotices(room) {
  if (!room.pendingLeaveNotices) {
    return;
  }

  for (const timer of room.pendingLeaveNotices.values()) {
    clearTimeout(timer);
  }

  room.pendingLeaveNotices.clear();
}

app.post("/api/create-room", (req, res) => {
  const roomId = getUniqueRoomId();
  const videoId = sanitizeVideoId(req.body?.videoId);
  const hostKey = generateHostKey();

  rooms.set(roomId, {
    id: roomId,
    hostSocketId: null,
    hostKey,
    pendingHostHandoffTimer: null,
    pendingHostClientId: null,
    pendingLeaveNotices: new Map(),
    videoId,
    users: new Map(),
    chatHistory: [],
    playback: {
      isPlaying: false,
      currentTime: 0,
      lastUpdateAt: Date.now(),
    },
  });

  res.json({ roomId, hostKey });
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
  socket.on("join-room", ({ roomId, username, hostKey, bootstrapVideoId, clientId } = {}) => {
    const normalizedRoomId = String(roomId || "").trim().toUpperCase();

    if (!normalizedRoomId) {
      socket.emit("room-error", "Room not found. Please check the invite link.");
      return;
    }

    if (!rooms.has(normalizedRoomId)) {
      const safeBootstrapVideoId = sanitizeVideoId(bootstrapVideoId);
      const canBootstrapRoom =
        typeof hostKey === "string" && hostKey.trim().length >= 12 && Boolean(safeBootstrapVideoId);

      if (!canBootstrapRoom) {
        socket.emit("room-error", "Room not found. Please check the invite link.");
        return;
      }

      rooms.set(normalizedRoomId, {
        id: normalizedRoomId,
        hostSocketId: null,
        hostKey: hostKey.trim(),
        pendingHostHandoffTimer: null,
        pendingHostClientId: null,
        pendingLeaveNotices: new Map(),
        videoId: safeBootstrapVideoId,
        users: new Map(),
        chatHistory: [],
        playback: {
          isPlaying: false,
          currentTime: 0,
          lastUpdateAt: Date.now(),
        },
      });
    }

    const room = rooms.get(normalizedRoomId);
    const safeUsername = sanitizeUsername(username);
    const normalizedClientId =
      typeof clientId === "string" && clientId.trim()
        ? clientId.trim().slice(0, 64)
        : socket.id;

    let duplicateSocketId = null;

    for (const [existingSocketId, existingUser] of room.users.entries()) {
      if (existingSocketId !== socket.id && existingUser.clientId === normalizedClientId) {
        duplicateSocketId = existingSocketId;
        break;
      }
    }

    if (duplicateSocketId) {
      room.users.delete(duplicateSocketId);

      const duplicateSocket = io.sockets.sockets.get(duplicateSocketId);

      if (duplicateSocket) {
        duplicateSocket.leave(normalizedRoomId);
        duplicateSocket.data.roomId = null;
        duplicateSocket.data.username = null;
        duplicateSocket.data.clientId = null;
      }

      if (room.hostSocketId === duplicateSocketId) {
        room.hostSocketId = socket.id;
      }
    }

    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    socket.data.username = safeUsername;
    socket.data.clientId = normalizedClientId;

    room.users.set(socket.id, { username: safeUsername, clientId: normalizedClientId });
    const isReconnectJoin = clearPendingLeaveNotice(room, normalizedClientId);

    const isReservedHost = typeof hostKey === "string" && hostKey === room.hostKey;
    const isReturningHostClient =
      Boolean(room.pendingHostClientId) && room.pendingHostClientId === normalizedClientId;

    if (isReservedHost || isReturningHostClient) {
      clearPendingHostHandoff(room);
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

    if (!isReconnectJoin) {
      const joinSystemMessage = {
        username: "System",
        message: `${safeUsername} joined the room.`,
        timestamp: Date.now(),
        system: true,
      };

      appendChatHistory(room, joinSystemMessage);
      io.to(normalizedRoomId).emit("chat-message", joinSystemMessage);
    }

    socket.to(normalizedRoomId).emit("user-joined", {
      username: safeUsername,
      users: serializeUsers(room),
    });

    io.to(normalizedRoomId).emit("users-updated", {
      users: serializeUsers(room),
      hostSocketId: room.hostSocketId,
    });
  });

  socket.on("chat-message", ({ message } = {}) => {
    const roomId = socket.data.roomId;

    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    const sender = room.users.get(socket.id);

    if (!sender) {
      return;
    }

    const text = String(message || "").trim().slice(0, 400);

    if (!text) {
      return;
    }

    const timestamp = Date.now();

    io.to(roomId).emit("chat-message", {
      username: sender.username,
      message: text,
      timestamp,
    });

    appendChatHistory(room, {
      username: sender.username,
      message: text,
      timestamp,
    });
  });

  socket.on("host-control", ({ type, currentTime, videoId, isPlaying } = {}) => {
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
    const wasHostDisconnect = room.hostSocketId === socket.id;
    let shouldBroadcastUsersUpdatedNow = true;

    room.users.delete(socket.id);

    if (leavingUser) {
      const hasAnotherConnectionForClient = [...room.users.values()].some(
        (user) => user.clientId === leavingUser.clientId
      );

      if (!hasAnotherConnectionForClient && leavingUser.clientId) {
        clearPendingLeaveNotice(room, leavingUser.clientId);

        const pendingTimer = setTimeout(() => {
          room.pendingLeaveNotices.delete(leavingUser.clientId);

          if (!rooms.has(roomId)) {
            return;
          }

          const currentRoom = rooms.get(roomId);
          const clientStillInRoom = [...currentRoom.users.values()].some(
            (user) => user.clientId === leavingUser.clientId
          );

          if (clientStillInRoom) {
            return;
          }

          socket.to(roomId).emit("user-left", {
            username: leavingUser.username,
          });

          const leaveSystemMessage = {
            username: "System",
            message: `${leavingUser.username} left the room.`,
            timestamp: Date.now(),
            system: true,
          };

          appendChatHistory(currentRoom, leaveSystemMessage);
          io.to(roomId).emit("chat-message", leaveSystemMessage);
        }, USER_RECONNECT_GRACE_MS);

        room.pendingLeaveNotices.set(leavingUser.clientId, pendingTimer);
      }
    }

    // If host leaves, wait briefly for host reconnect before transferring host role.
    if (wasHostDisconnect) {
      room.hostSocketId = null;
      room.pendingHostClientId = leavingUser?.clientId || null;
      shouldBroadcastUsersUpdatedNow = false;

      clearPendingHostHandoff(room);
      room.pendingHostClientId = leavingUser?.clientId || null;
      room.pendingHostHandoffTimer = setTimeout(() => {
        room.pendingHostHandoffTimer = null;

        if (!rooms.has(roomId)) {
          return;
        }

        const currentRoom = rooms.get(roomId);

        if (currentRoom.hostSocketId) {
          clearPendingHostHandoff(currentRoom);
          return;
        }

        const nextHost = currentRoom.users.keys().next().value || null;
        currentRoom.hostSocketId = nextHost;
        clearPendingHostHandoff(currentRoom);

        if (nextHost) {
          io.to(roomId).emit("host-changed", {
            hostSocketId: nextHost,
            users: serializeUsers(currentRoom),
          });
        }

        io.to(roomId).emit("users-updated", {
          users: serializeUsers(currentRoom),
          hostSocketId: currentRoom.hostSocketId,
        });
      }, HOST_RECONNECT_GRACE_MS);
    }

    if (room.users.size === 0) {
      clearPendingHostHandoff(room);
      clearAllPendingLeaveNotices(room);
      rooms.delete(roomId);
      return;
    }

    if (shouldBroadcastUsersUpdatedNow) {
      io.to(roomId).emit("users-updated", {
        users: serializeUsers(room),
        hostSocketId: room.hostSocketId,
      });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`SyncTube server is running on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  io.close(() => {
    server.close((error) => {
      if (error) {
        console.error("Error while shutting down server:", error);
        process.exit(1);
      }

      process.exit(0);
    });
  });

  setTimeout(() => {
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

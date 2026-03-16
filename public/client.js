/* global io, YT */

(function initSyncTube() {
  const isIndexPage = Boolean(document.getElementById("create-room-form"));
  const isRoomPage = Boolean(document.getElementById("room-id-display"));

  function extractYouTubeVideoId(input) {
    const raw = String(input || "").trim();

    if (!raw) {
      return null;
    }

    // If user already pasted an 11-char video ID.
    if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) {
      return raw;
    }

    try {
      const url = new URL(raw);

      if (url.hostname.includes("youtu.be")) {
        return (url.pathname.split("/")[1] || "").slice(0, 11) || null;
      }

      if (url.hostname.includes("youtube.com")) {
        return (url.searchParams.get("v") || "").slice(0, 11) || null;
      }

      return null;
    } catch {
      return null;
    }
  }

  if (isIndexPage) {
    const createForm = document.getElementById("create-room-form");
    const joinForm = document.getElementById("join-room-form");

    createForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const username = document.getElementById("create-username").value.trim();
      const videoInput = document.getElementById("video-url").value.trim();
      const videoId = extractYouTubeVideoId(videoInput);

      if (!username) {
        alert("Please enter a username.");
        return;
      }

      if (!videoId) {
        alert("Please enter a valid YouTube URL or video ID.");
        return;
      }

      try {
        const response = await fetch("/api/create-room", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ videoId }),
        });

        if (!response.ok) {
          throw new Error("Could not create room");
        }

        const { roomId, hostKey } = await response.json();
        const nextUrl = new URL("/room.html", window.location.origin);

        sessionStorage.setItem(`synctube-host-key:${roomId}`, hostKey);
        sessionStorage.setItem(`synctube-bootstrap-video:${roomId}`, videoId);

        nextUrl.searchParams.set("room", roomId);
        nextUrl.searchParams.set("username", username);

        window.location.href = nextUrl.toString();
      } catch (error) {
        alert("Failed to create room. Please try again.");
      }
    });

    joinForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const username = document.getElementById("join-username").value.trim();
      const roomId = document.getElementById("room-id").value.trim().toUpperCase();

      if (!username || !roomId) {
        alert("Please enter both username and room ID.");
        return;
      }

      const nextUrl = new URL("/room.html", window.location.origin);
      nextUrl.searchParams.set("room", roomId);
      nextUrl.searchParams.set("username", username);

      window.location.href = nextUrl.toString();
    });

    return;
  }

  if (!isRoomPage) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const roomId = (params.get("room") || "").trim().toUpperCase();
  let username = (params.get("username") || "").trim();
  const hostKey = roomId ? sessionStorage.getItem(`synctube-host-key:${roomId}`) || "" : "";
  const bootstrapVideoId = roomId
    ? sessionStorage.getItem(`synctube-bootstrap-video:${roomId}`) || ""
    : "";

  let clientId = sessionStorage.getItem("synctube-client-id") || "";

  if (!clientId) {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      clientId = window.crypto.randomUUID();
    } else {
      clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    sessionStorage.setItem("synctube-client-id", clientId);
  }

  if (!roomId) {
    alert("Missing room ID. Please return to the home page.");
    window.location.href = "/";
    return;
  }

  if (!username) {
    const enteredNickname = window.prompt("Enter your nickname to join this room:", "");

    if (!enteredNickname || !enteredNickname.trim()) {
      alert("Nickname is required to join a room.");
      window.location.href = "/";
      return;
    }

    username = enteredNickname.trim().slice(0, 24);
    params.set("username", username);
    window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
  }

  const socket = io();

  const roomIdDisplay = document.getElementById("room-id-display");
  const copyLinkBtn = document.getElementById("copy-link-btn");
  const hostStatus = document.getElementById("host-status");
  const userList = document.getElementById("user-list");
  const chatMessages = document.getElementById("chat-messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const playerLock = document.getElementById("player-lock");
  const loadVideoBtn = document.getElementById("load-video-btn");
  const videoInput = document.getElementById("video-input");
  const videoControls = document.querySelector(".video-controls");
  const enableAudioBtn = document.getElementById("enable-audio-btn");

  let player;
  let isHost = false;
  let joinedRoomState = null;
  let applyingRemoteSync = false;
  let hostHeartbeatInterval = null;
  let hostSeekWatchInterval = null;
  let viewerResyncInterval = null;
  let hostLastObservedTime = 0;
  let youtubeApiPromise = null;
  let lastViewerCorrectionAt = 0;
  let joinRetryCount = 0;
  let joinRetryTimer = null;
  let playerReady = false;
  let queuedSyncEvent = null;
  let viewerAudioEnabled = false;

  const CLOCK_DRIFT_SOFT_THRESHOLD = 1.2;
  const CLOCK_DRIFT_HARD_THRESHOLD = 2.6;
  const MIN_CORRECTION_INTERVAL_MS = 1200;
  const MAX_JOIN_RETRIES = 8;

  function expectedTimeFromServer({ currentTime, isPlaying, serverSentAt }) {
    const base = Math.max(0, Number(currentTime) || 0);

    if (!isPlaying) {
      return base;
    }

    const networkDelaySeconds = serverSentAt ? Math.max(0, (Date.now() - serverSentAt) / 1000) : 0;
    return base + networkDelaySeconds;
  }

  roomIdDisplay.textContent = roomId;

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function addChatMessage({ username: name, message, timestamp, system = false }) {
    const node = document.createElement("div");
    node.className = `chat-message${system ? " system" : ""}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${name} • ${formatTime(timestamp)}`;

    const text = document.createElement("div");
    text.className = "text";
    text.textContent = message;

    node.append(meta, text);
    chatMessages.appendChild(node);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function renderUsers(users, hostSocketId) {
    userList.innerHTML = "";

    const sortedUsers = [...users].sort((left, right) => {
      if (left.socketId === hostSocketId) {
        return -1;
      }

      if (right.socketId === hostSocketId) {
        return 1;
      }

      return left.username.localeCompare(right.username);
    });

    sortedUsers.forEach((user) => {
      const li = document.createElement("li");
      li.textContent = user.username;

      if (user.socketId === hostSocketId) {
        const hostTag = document.createElement("span");
        hostTag.className = "user-host-badge";
        hostTag.textContent = "Host";
        li.appendChild(hostTag);
      }

      userList.appendChild(li);
    });
  }

  function setHostMode(nextIsHost) {
    const wasHost = isHost;
    isHost = Boolean(nextIsHost);
    hostStatus.textContent = isHost ? "Host" : "Viewer";
    hostStatus.style.color = isHost ? "var(--success)" : "var(--muted)";

    loadVideoBtn.disabled = !isHost;
    videoInput.disabled = !isHost;
    playerLock.classList.toggle("hidden", isHost);

    if (videoControls) {
      videoControls.hidden = !isHost;
    }

    document.body.classList.toggle("host-mode", isHost);
    document.body.classList.toggle("viewer-mode", !isHost);

    if (enableAudioBtn) {
      if (isHost) {
        enableAudioBtn.classList.add("hidden");
      } else if (playerReady && !viewerAudioEnabled) {
        enableAudioBtn.classList.remove("hidden");
      }
    }

    if (!isHost) {
      clearInterval(hostHeartbeatInterval);
      clearInterval(hostSeekWatchInterval);
      hostHeartbeatInterval = null;
      hostSeekWatchInterval = null;

      clearInterval(viewerResyncInterval);
      viewerResyncInterval = setInterval(() => {
        socket.emit("request-sync");
      }, 3000);
    } else {
      clearInterval(viewerResyncInterval);
      viewerResyncInterval = null;

      if (!wasHost && player && typeof player.getCurrentTime === "function") {
        hostLastObservedTime = player.getCurrentTime();
        startHostSyncIntervals();

        emitHostControl("time-update", {
          isPlaying: player.getPlayerState?.() === YT.PlayerState.PLAYING,
          currentTime: player.getCurrentTime(),
        });
      }
    }
  }

  function loadYouTubeApi() {
    if (youtubeApiPromise) {
      return youtubeApiPromise;
    }

    youtubeApiPromise = new Promise((resolve) => {
      const existingScript = document.getElementById("youtube-api-script");

      if (existingScript) {
        if (window.YT && window.YT.Player) {
          resolve();
        } else {
          window.onYouTubeIframeAPIReady = resolve;
        }
        return;
      }

      const script = document.createElement("script");
      script.id = "youtube-api-script";
      script.src = "https://www.youtube.com/iframe_api";

      window.onYouTubeIframeAPIReady = resolve;
      document.body.appendChild(script);
    });

    return youtubeApiPromise;
  }

  const youtubeApiReady = loadYouTubeApi();

  function emitHostControl(type, payload = {}) {
    if (!isHost) {
      return;
    }

    socket.emit("host-control", {
      type,
      ...payload,
    });
  }

  function emitJoinRoom() {
    socket.emit("join-room", { roomId, username, hostKey, bootstrapVideoId, clientId });
  }

  function applyPlaybackState(playback, videoId) {
    if (!player || typeof player.seekTo !== "function") {
      return;
    }

    applyingRemoteSync = true;

    try {
      if (videoId && typeof player.getVideoData === "function") {
        const currentVideoId = player.getVideoData()?.video_id;

        if (currentVideoId !== videoId) {
          player.loadVideoById({
            videoId,
            startSeconds: Number(playback.currentTime) || 0,
          });
        } else {
          player.seekTo(Number(playback.currentTime) || 0, true);
        }
      } else {
        player.seekTo(Number(playback.currentTime) || 0, true);
      }

      if (playback.isPlaying) {
        player.playVideo();
      } else {
        player.pauseVideo();
      }
    } finally {
      setTimeout(() => {
        applyingRemoteSync = false;
      }, 180);
    }
  }

  function applyClockCorrection(event, forceSeek = false) {
    if (!player || isHost) {
      return;
    }

    const now = Date.now();
    const expectedTime = expectedTimeFromServer(event);
    const localTime = Number(player.getCurrentTime?.()) || 0;
    const drift = Math.abs(localTime - expectedTime);
    const allowSoftCorrection = now - lastViewerCorrectionAt >= MIN_CORRECTION_INTERVAL_MS;
    const shouldSeekHard = forceSeek || drift > CLOCK_DRIFT_HARD_THRESHOLD;
    const shouldSeekSoft =
      !shouldSeekHard &&
      drift > CLOCK_DRIFT_SOFT_THRESHOLD &&
      allowSoftCorrection &&
      Boolean(event.isPlaying);

    if (shouldSeekHard) {
      applyingRemoteSync = true;
      player.seekTo(expectedTime, true);
      lastViewerCorrectionAt = now;
      setTimeout(() => {
        applyingRemoteSync = false;
      }, 130);
    } else if (shouldSeekSoft) {
      applyingRemoteSync = true;
      player.seekTo(expectedTime, true);
      lastViewerCorrectionAt = now;
      setTimeout(() => {
        applyingRemoteSync = false;
      }, 70);
    }

    const playerState = player.getPlayerState?.();

    if (event.isPlaying && playerState !== YT.PlayerState.PLAYING) {
      player.playVideo();
    } else if (!event.isPlaying && playerState === YT.PlayerState.PLAYING) {
      player.pauseVideo();
    }
  }

  function startHostSyncIntervals() {
    clearInterval(hostHeartbeatInterval);
    clearInterval(hostSeekWatchInterval);

    hostHeartbeatInterval = setInterval(() => {
      if (!isHost || !player || typeof player.getCurrentTime !== "function") {
        return;
      }

      emitHostControl("time-update", {
        isPlaying: player.getPlayerState?.() === YT.PlayerState.PLAYING,
        currentTime: player.getCurrentTime(),
      });
    }, 1000);

    hostSeekWatchInterval = setInterval(() => {
      if (!isHost || !player || typeof player.getCurrentTime !== "function") {
        return;
      }

      const current = player.getCurrentTime();
      const playerState = player.getPlayerState?.();
      const expectedDelta = playerState === YT.PlayerState.PLAYING ? 1 : 0;
      const delta = Math.abs(current - hostLastObservedTime - expectedDelta);

      if (delta > 0.75) {
        emitHostControl("seek", {
          currentTime: current,
        });
      }

      hostLastObservedTime = current;
    }, 1000);
  }

  function buildPlayer(initialVideoId) {
    player = new YT.Player("player", {
      videoId: initialVideoId,
      playerVars: {
        rel: 0,
        playsinline: 1,
        modestbranding: 1,
      },
      events: {
        onReady: () => {
          playerReady = true;

          if (!isHost) {
            player.mute();

            if (enableAudioBtn && !viewerAudioEnabled) {
              enableAudioBtn.classList.remove("hidden");
            }
          }

          if (joinedRoomState) {
            applyPlaybackState(joinedRoomState.playback, joinedRoomState.videoId);
          }

          if (queuedSyncEvent) {
            const pendingEvent = queuedSyncEvent;
            queuedSyncEvent = null;

            if (!isHost) {
              if (pendingEvent.type === "sync-state") {
                applyPlaybackState(
                  {
                    currentTime: expectedTimeFromServer(pendingEvent),
                    isPlaying: pendingEvent.isPlaying,
                  },
                  pendingEvent.videoId
                );
              } else {
                applyClockCorrection(pendingEvent, pendingEvent.type !== "clock");
              }
            }
          }

          if (isHost) {
            startHostSyncIntervals();
          } else {
            socket.emit("request-sync");
          }
        },
        onStateChange: (event) => {
          if (!isHost && event.data === YT.PlayerState.BUFFERING) {
            socket.emit("request-sync");
          }

          if (!isHost || applyingRemoteSync) {
            return;
          }

          const currentTime = player.getCurrentTime?.() || 0;
          hostLastObservedTime = currentTime;

          if (event.data === YT.PlayerState.PLAYING) {
            emitHostControl("play", { currentTime });
            startHostSyncIntervals();
          }

          if (event.data === YT.PlayerState.PAUSED) {
            emitHostControl("pause", { currentTime });
          }

          if (event.data === YT.PlayerState.BUFFERING) {
            setTimeout(() => {
              if (!isHost || applyingRemoteSync) {
                return;
              }

              emitHostControl("seek", {
                currentTime: player.getCurrentTime?.() || 0,
              });
            }, 100);
          }
        },
      },
    });
  }

  copyLinkBtn.addEventListener("click", async () => {
    const inviteUrl = `${window.location.origin}/room.html?room=${encodeURIComponent(roomId)}`;

    try {
      await navigator.clipboard.writeText(inviteUrl);
      copyLinkBtn.textContent = "Copied!";
      setTimeout(() => {
        copyLinkBtn.textContent = "Copy Invite Link";
      }, 1200);
    } catch {
      alert("Could not copy invite link.");
    }
  });

  loadVideoBtn.addEventListener("click", () => {
    if (!isHost) {
      return;
    }

    if (!playerReady || !player || typeof player.loadVideoById !== "function") {
      alert("Player is still loading. Please try again in a moment.");
      return;
    }

    const nextVideoId = extractYouTubeVideoId(videoInput.value.trim());

    if (!nextVideoId) {
      alert("Please enter a valid YouTube URL or video ID.");
      return;
    }

    emitHostControl("load-video", {
      videoId: nextVideoId,
      currentTime: 0,
    });

    // Keep host player aligned with what everyone else receives.
    applyingRemoteSync = true;
    player.loadVideoById({ videoId: nextVideoId, startSeconds: 0 });

    setTimeout(() => {
      applyingRemoteSync = false;
    }, 180);
  });

  if (enableAudioBtn) {
    enableAudioBtn.addEventListener("click", () => {
      if (!player || !playerReady || isHost) {
        return;
      }

      viewerAudioEnabled = true;
      enableAudioBtn.classList.add("hidden");

      if (typeof player.unMute === "function") {
        player.unMute();
      }

      if (typeof player.setVolume === "function") {
        player.setVolume(100);
      }

      if (player.getPlayerState?.() !== YT.PlayerState.PLAYING) {
        player.playVideo();
      }
    });
  }

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const message = chatInput.value.trim();

    if (!message) {
      return;
    }

    socket.emit("chat-message", { message });
    chatInput.value = "";
  });

  socket.on("connect", () => {
    clearTimeout(joinRetryTimer);
    joinRetryCount = 0;
    emitJoinRoom();
  });

  socket.on("room-error", (message) => {
    const normalizedMessage = String(message || "").toLowerCase();

    if (normalizedMessage.includes("room not found") && joinRetryCount < MAX_JOIN_RETRIES) {
      const retryDelay = Math.min(3500, 500 * (joinRetryCount + 1));
      joinRetryCount += 1;

      clearTimeout(joinRetryTimer);
      joinRetryTimer = setTimeout(() => {
        emitJoinRoom();
      }, retryDelay);
      return;
    }

    alert(message || "Could not join room.");
    window.location.href = "/";
  });

  socket.on("joined-room", async (state) => {
    clearTimeout(joinRetryTimer);
    joinRetryCount = 0;

    joinedRoomState = state;
    setHostMode(state.isHost);
    renderUsers(state.users, state.hostSocketId);

    chatMessages.innerHTML = "";
    (state.chatHistory || []).forEach((chat) => {
      addChatMessage(chat);
    });

    await youtubeApiReady;
    buildPlayer(state.videoId);
  });

  socket.on("users-updated", ({ users, hostSocketId }) => {
    renderUsers(users, hostSocketId);

    const amIHost = socket.id === hostSocketId;

    if (amIHost !== isHost) {
      setHostMode(amIHost);

      addChatMessage({
        username: "System",
        message: amIHost
          ? "You are now the host and can control playback."
          : "Host role changed.",
        timestamp: Date.now(),
        system: true,
      });
    }
  });

  socket.on("host-changed", ({ hostSocketId, users }) => {
    renderUsers(users, hostSocketId);

    const amIHost = socket.id === hostSocketId;
    setHostMode(amIHost);

    addChatMessage({
      username: "System",
      message: amIHost
        ? "You are now the host."
        : "Host changed.",
      timestamp: Date.now(),
      system: true,
    });
  });

  socket.on("chat-message", (payload) => {
    addChatMessage(payload);
  });

  socket.on("sync-event", (event) => {
    if (isHost) {
      return;
    }

    if (!player || !playerReady) {
      queuedSyncEvent = event;
      return;
    }

    if (event.type === "load-video") {
      applyPlaybackState(
        {
          currentTime: expectedTimeFromServer(event),
          isPlaying: false,
        },
        event.videoId
      );
      return;
    }

    if (event.type === "play") {
      applyClockCorrection(event, true);
      return;
    }

    if (event.type === "pause") {
      applyClockCorrection(event, true);
      return;
    }

    if (event.type === "seek") {
      applyClockCorrection(event, true);
      return;
    }

    if (event.type === "clock") {
      applyClockCorrection(event, false);
      return;
    }

    if (event.type === "sync-state") {
      applyPlaybackState(
        {
          currentTime: expectedTimeFromServer(event),
          isPlaying: event.isPlaying,
        },
        event.videoId
      );
    }
  });
})();

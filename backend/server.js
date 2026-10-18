
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { Server } = require("socket.io");
require("dotenv").config();
const {
  SESSION_TTL_MS,
  clearSessionCookie,
  createOriginValidator,
  createSession,
  findActiveSession,
  findActiveSessionByHash,
  readSessionToken,
  registerUser,
  requireAuth,
  revokeSession,
  sessionCookie,
  verifyCredentials,
} = require("./auth");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;
const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5174";
const FRONTEND_ORIGIN = new URL(FRONTEND_URL).origin;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const PRIVATE_FILES_DIRECTORY = path.join(__dirname, "private-files");
const AUTH_RATE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT = 20;
const ROOM_CODE_RATE_WINDOW_MS = 15 * 60 * 1000;
const ROOM_CODE_RATE_LIMIT = 30;
const ROOM_CODE_PATTERN = /^[0-9A-F]{32}$/;
const MAX_CHAT_MESSAGE_LENGTH = 2000;
const MAX_SIGNALING_SDP_BYTES = 64 * 1024;
const MAX_SIGNALING_CANDIDATE_BYTES = 4 * 1024;
const MAX_SIGNALING_METADATA_LENGTH = 256;
const MAX_SIGNALING_PAYLOAD_BYTES = 72 * 1024;
const MAX_SIGNALING_ICE_PAYLOAD_BYTES = 8 * 1024;
const MAX_WHITEBOARD_STROKE_BYTES = 12 * 1024;
const MAX_WHITEBOARD_STROKE_POINTS = 96;
const MAX_WHITEBOARD_BRUSH_SIZE = 24;
const MAX_WHITEBOARD_HISTORY_STROKES = 1500;
const MAX_WHITEBOARD_HISTORY_POINTS = 50000;
const MAX_WHITEBOARD_HISTORY_BYTES = 2 * 1024 * 1024;
const WHITEBOARD_COLORS = new Set([
  "#1d2938",
  "#2c5fbe",
  "#be4b3c",
  "#2c8c6b",
  "#d18a21",
]);
const WHITEBOARD_STROKE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

fs.mkdirSync(PRIVATE_FILES_DIRECTORY, { recursive: true });

app.use(helmet());
app.use(cors({
  origin: FRONTEND_ORIGIN,
  credentials: true,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return createOriginValidator(FRONTEND_ORIGIN)(req, res, next);
  }
  next();
});
app.use(express.json({ limit: "1mb" }));

const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Temporary in-memory room storage
const rooms = new Map();
const fileAccessTokens = new Map();
const authRateLimits = new Map();
const roomCodeRateLimits = new Map();

function pruneRoomCodeRateLimits(now) {
  for (const [ip, entry] of roomCodeRateLimits) {
    if (entry.resetAt <= now) roomCodeRateLimits.delete(ip);
  }
}

function isRoomCodeRateLimited(ip) {
  const now = Date.now();
  pruneRoomCodeRateLimits(now);
  const entry = roomCodeRateLimits.get(ip);
  return entry && entry.count >= ROOM_CODE_RATE_LIMIT;
}

function recordRoomCodeFailure(ip) {
  const now = Date.now();
  pruneRoomCodeRateLimits(now);
  let entry = roomCodeRateLimits.get(ip);
  if (!entry) {
    entry = { count: 0, resetAt: now + ROOM_CODE_RATE_WINDOW_MS };
    roomCodeRateLimits.set(ip, entry);
  }
  entry.count += 1;
  return entry.count >= ROOM_CODE_RATE_LIMIT;
}

function sendRoomCodeRateLimit(response) {
  response.set("Retry-After", String(Math.ceil(ROOM_CODE_RATE_WINDOW_MS / 1000)));
  return response.status(429).json({
    error: "Too many invalid meeting codes. Wait 15 minutes and try again.",
  });
}

function checkAuthRateLimit(request, response, next) {
  const now = Date.now();
  const email =
    typeof request.body?.email === "string"
      ? request.body.email.trim().toLowerCase().slice(0, 254)
      : "missing-email";
  const keys = [`ip:${request.ip}`, `email:${email}`];

  for (const [key, entry] of authRateLimits) {
    if (entry.resetAt <= now) authRateLimits.delete(key);
  }

  const entries = keys.map((key) => {
    const entry = authRateLimits.get(key);
    if (!entry || entry.resetAt <= now) {
      const fresh = { count: 0, resetAt: now + AUTH_RATE_WINDOW_MS };
      authRateLimits.set(key, fresh);
      return fresh;
    }
    return entry;
  });

  if (entries.some((entry) => entry.count >= AUTH_RATE_LIMIT)) {
    return response.status(429).json({
      error: "Too many sign-in attempts. Wait 15 minutes and try again.",
    });
  }

  entries.forEach((entry) => {
    entry.count += 1;
  });
  next();
}

function setSessionCookie(response, session) {
  response.setHeader(
    "Set-Cookie",
    sessionCookie(session.token, Math.floor(SESSION_TTL_MS / 1000)),
  );
}

const allowedFileTypes = {
  ".csv": { mimeTypes: ["text/csv", "text/plain", "application/vnd.ms-excel"], kind: "text" },
  ".gif": { mimeTypes: ["image/gif"], kind: "gif" },
  ".jpeg": { mimeTypes: ["image/jpeg"], kind: "jpeg" },
  ".jpg": { mimeTypes: ["image/jpeg"], kind: "jpeg" },
  ".mp3": { mimeTypes: ["audio/mpeg", "audio/mp3"], kind: "mp3" },
  ".mp4": { mimeTypes: ["video/mp4"], kind: "mp4" },
  ".ogg": { mimeTypes: ["audio/ogg", "video/ogg"], kind: "ogg" },
  ".pdf": { mimeTypes: ["application/pdf"], kind: "pdf" },
  ".png": { mimeTypes: ["image/png"], kind: "png" },
  ".txt": { mimeTypes: ["text/plain"], kind: "text" },
  ".wav": { mimeTypes: ["audio/wav", "audio/x-wav"], kind: "wav" },
  ".webm": { mimeTypes: ["video/webm", "audio/webm"], kind: "webm" },
  ".webp": { mimeTypes: ["image/webp"], kind: "webp" },
  ".zip": { mimeTypes: ["application/zip", "application/x-zip-compressed"], kind: "zip" },
};

const upload = multer({
  storage: multer.diskStorage({
    destination: PRIVATE_FILES_DIRECTORY,
    filename: (_req, _file, callback) => callback(null, crypto.randomBytes(24).toString("hex")),
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const definition = allowedFileTypes[extension];

    if (!definition || !definition.mimeTypes.includes(file.mimetype.toLowerCase())) {
      callback(new Error("This file type is not supported."));
      return;
    }

    callback(null, true);
  },
});

function sanitizeDisplayFilename(filename) {
  if (
    typeof filename !== "string" ||
    filename.length > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    return null;
  }

  const normalized = filename.normalize("NFC").trim();
  if (!normalized || normalized === "." || normalized === ".." || normalized.length > 180) {
    return null;
  }

  return normalized;
}

function discardUploadedFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    console.error("Could not remove a rejected upload:", error);
  }
}

function validateFileContent(filePath, kind) {
  const descriptor = fs.openSync(filePath, "r");
  const header = Buffer.alloc(16);
  let bytesRead;

  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }

  const bytes = header.subarray(0, bytesRead);
  const startsWith = (...signature) =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

  switch (kind) {
    case "gif":
      return bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
        bytes.subarray(0, 6).toString("ascii") === "GIF89a";
    case "jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "mp3":
      return bytes.subarray(0, 3).toString("ascii") === "ID3" ||
        (bytes.length > 1 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "mp4":
      return bytes.length >= 8 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
    case "ogg":
      return bytes.subarray(0, 4).toString("ascii") === "OggS";
    case "pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
    case "png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "wav":
      return bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WAVE";
    case "webm":
      return startsWith(0x1a, 0x45, 0xdf, 0xa3);
    case "webp":
      return bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP";
    case "zip":
      return startsWith(0x50, 0x4b, 0x03, 0x04) ||
        startsWith(0x50, 0x4b, 0x05, 0x06) ||
        startsWith(0x50, 0x4b, 0x07, 0x08);
    case "text": {
      const content = fs.readFileSync(filePath);
      if (content.includes(0)) return false;
      new TextDecoder("utf-8", { fatal: true }).decode(content);
      return true;
    }
    default:
      return false;
  }
}

function requireRoomFileAccess(req, res, next) {
  const code = String(req.params.code || "").trim().toUpperCase();
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const capability = fileAccessTokens.get(token);
  const socket = capability && io.sockets.sockets.get(capability.socketId);
  const room = rooms.get(code);

  if (
    !capability ||
    capability.code !== code ||
    capability.tokenHash !== req.auth.tokenHash ||
    capability.userId !== req.auth.user.id ||
    !socket?.connected ||
    !socket.rooms.has(code) ||
    !room?.participants.has(capability.socketId) ||
    room.participants.get(capability.socketId).userId !== req.auth.user.id
  ) {
    return res.status(403).json({ error: "Join this meeting to access its shared files." });
  }

  req.fileRoomCode = code;
  req.fileUploader = room.participants.get(capability.socketId);
  next();
}

function serializeSharedFile(file) {
  const { storageName: _storageName, ...publicFile } = file;
  return publicFile;
}

function listRoomFiles(roomCode) {
  const room = rooms.get(roomCode);
  if (!room?.files) return [];

  return [...room.files.values()]
    .sort((first, second) => second.uploadedAt.localeCompare(first.uploadedAt))
    .map(serializeSharedFile);
}

app.get("/api/rooms/:code/files", requireAuth, requireRoomFileAccess, (req, res) => {
  res.json({ files: listRoomFiles(req.fileRoomCode) });
});

app.post(
  "/api/rooms/:code/files",
  requireAuth,
  requireRoomFileAccess,
  (req, res, next) => upload.single("file")(req, res, next),
  (req, res, next) => {
    if (!req.file) {
      return res.status(400).json({ error: "Choose a file to upload." });
    }

    const filename = sanitizeDisplayFilename(req.file.originalname);
    const extension = path.extname(req.file.originalname).toLowerCase();
    const definition = allowedFileTypes[extension];

    if (!filename || !definition) {
      discardUploadedFile(req.file.path);
      return res.status(400).json({ error: "The filename or file type is not supported." });
    }

    try {
      if (!validateFileContent(req.file.path, definition.kind)) {
        discardUploadedFile(req.file.path);
        return res.status(400).json({ error: "The uploaded content does not match its file type." });
      }
    } catch (error) {
      discardUploadedFile(req.file.path);
      if (error instanceof TypeError) {
        return res.status(400).json({ error: "Text files must contain valid UTF-8 text." });
      }
      return next(error);
    }

    const room = rooms.get(req.fileRoomCode);
    const uploaderSocket = io.sockets.sockets.get(req.fileUploader.id);
    if (
      !room?.participants.has(req.fileUploader.id) ||
      room.participants.get(req.fileUploader.id).userId !== req.auth.user.id ||
      !uploaderSocket?.connected ||
      !findActiveSessionByHash(uploaderSocket.data.auth?.tokenHash)
    ) {
      discardUploadedFile(req.file.path);
      return res.status(403).json({ error: "You have left this meeting." });
    }

    if (!room.files) room.files = new Map();

    const file = {
      id: crypto.randomUUID(),
      name: filename,
      size: req.file.size,
      mimeType: req.file.mimetype,
      uploaderName: req.fileUploader.name,
      uploadedAt: new Date().toISOString(),
      storageName: path.basename(req.file.filename),
    };

    room.files.set(file.id, file);
    const sharedFile = serializeSharedFile(file);
    io.to(req.fileRoomCode).emit("room:file-shared", {
      code: req.fileRoomCode,
      file: sharedFile,
    });

    return res.status(201).json({ file: sharedFile });
  },
);

app.get(
  "/api/rooms/:code/files/:fileId/download",
  requireAuth,
  requireRoomFileAccess,
  (req, res) => {
  const file = rooms.get(req.fileRoomCode)?.files?.get(req.params.fileId);

  if (!file) {
    return res.status(404).json({ error: "This shared file was not found." });
  }

  const storedPath = path.join(PRIVATE_FILES_DIRECTORY, file.storageName);
  if (!fs.existsSync(storedPath)) {
    return res.status(410).json({ error: "This file is no longer available on the server." });
  }

  return res.download(storedPath, file.name);
  },
);

function createRoomCode() {
  let code;

  do {
    code = crypto.randomBytes(16).toString("hex").toUpperCase();
  } while (!code || rooms.has(code));

  return code;
}

function getParticipants(roomCode) {
  const room = rooms.get(roomCode);

  if (!room) return [];

  return [...room.participants.values()].map((participant) => ({
    id: participant.id,
    name: participant.name,
  }));
}

function sendParticipants(roomCode) {
  io.to(roomCode).emit("room:participants", {
    code: roomCode,
    participants: getParticipants(roomCode),
  });
}


function leaveCurrentRooms(socket) {
  for (const roomCode of [...socket.rooms]) {
    if (roomCode === socket.id || !rooms.has(roomCode)) continue

    for (const [token, capability] of fileAccessTokens) {
      if (capability.socketId === socket.id && capability.code === roomCode) {
        fileAccessTokens.delete(token)
      }
    }

    const room = rooms.get(roomCode)
    const participant = room.participants.get(socket.id)

    if (!participant) {
      socket.leave(roomCode)
      continue
    }

    // Notify remaining participants before removing the socket.
    socket.to(roomCode).emit('room:participant-left', {
      code: roomCode,
      participantId: socket.id,
      name: participant.name,
    })

    room.participants.delete(socket.id)
    socket.leave(roomCode)

    sendParticipants(roomCode)

    console.log(`${participant.name} left room ${roomCode}`)
  }
}

function getActiveSocketSession(socket) {
  const auth = socket.data.auth;
  if (!auth) return null;

  const session = findActiveSessionByHash(auth.tokenHash);
  if (!session || session.user.id !== auth.user.id) {
    socket.disconnect(true);
    return null;
  }

  socket.data.auth = {
    tokenHash: session.tokenHash,
    expiresAt: session.expiresAt,
    user: session.user,
  };
  return session;
}

function getSocketRoom(socket) {
  const auth = getActiveSocketSession(socket);
  if (!auth) return null;

  for (const roomCode of socket.rooms) {
    const room = rooms.get(roomCode);
    const participant = room?.participants.get(socket.id);
    if (
      participant &&
      participant.userId === auth.user.id &&
      socket.rooms.has(roomCode)
    ) {
      return { code: roomCode, room, participant, auth };
    }
  }
  return null;
}

function getAuthorizedSignalTarget(socket, targetId) {
  if (
    typeof targetId !== "string" ||
    !targetId ||
    targetId.length > MAX_SIGNALING_METADATA_LENGTH ||
    targetId === socket.id
  ) return null;

  const senderRoom = getSocketRoom(socket);
  const targetSocket = io.sockets.sockets.get(targetId);
  if (!senderRoom || !targetSocket?.connected) return null;

  const targetRoom = getSocketRoom(targetSocket);
  if (!targetRoom || targetRoom.code !== senderRoom.code) return null;
  return { targetSocket, room: senderRoom.room };
}

io.use((socket, next) => {
  const origin = socket.handshake.headers.origin;
  if (origin !== FRONTEND_ORIGIN) {
    next(new Error("Socket connection origin is not allowed."));
    return;
  }

  const token = readSessionToken(socket);
  const session = findActiveSession(token);
  if (!session) {
    next(new Error("Authentication required."));
    return;
  }

  socket.data.auth = {
    tokenHash: session.tokenHash,
    expiresAt: session.expiresAt,
    user: session.user,
  };

  const delay = Math.max(0, session.expiresAt - Date.now());
  socket.data.sessionExpiryTimer = setTimeout(() => {
    if (!findActiveSessionByHash(session.tokenHash)) socket.disconnect(true);
  }, delay);
  socket.data.sessionExpiryTimer.unref?.();
  next();
});


// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Real-Time Communication API is running",
  });
});

app.post("/api/auth/register", checkAuthRateLimit, async (req, res, next) => {
  try {
    const user = await registerUser(req.body || {});
    const session = createSession(user.id);
    setSessionCookie(res, session);
    return res.status(201).json({ user, expiresAt: session.expiresAt });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

app.post("/api/auth/login", checkAuthRateLimit, async (req, res, next) => {
  try {
    const user = await verifyCredentials(req.body || {});
    if (!user) return res.status(401).json({ error: "Email or password is incorrect." });

    const session = createSession(user.id);
    setSessionCookie(res, session);
    return res.json({ user, expiresAt: session.expiresAt });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.auth.user, expiresAt: req.auth.expiresAt });
});

app.post("/api/auth/logout", (req, res) => {
  const token = readSessionToken(req);
  const session = findActiveSession(token);
  revokeSession(token);
  res.setHeader("Set-Cookie", clearSessionCookie());

  if (session) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.auth?.tokenHash === session.tokenHash) {
        socket.disconnect(true);
      }
    }
  }

  return res.status(204).end();
});

// List rooms
app.get("/api/rooms", requireAuth, (req, res) => {
  const roomList = [...rooms.entries()]
    .filter(([, room]) => room.ownerUserId === req.auth.user.id)
    .map(([code, room]) => ({
      id: code,
      name: room.name,
      code,
      participants: getParticipants(code),
    }));

  res.json(roomList);
});

// Create room
app.post("/api/rooms", requireAuth, (req, res) => {
  const name = String(req.body?.name || "").trim();

  if (!name || name.length > 64) {
    return res.status(400).json({
      error: "Room name must contain 1-64 characters.",
    });
  }

  const code = createRoomCode();

  rooms.set(code, {
    name,
    ownerUserId: req.auth.user.id,
    participants: new Map(),
    files: new Map(),
    whiteboard: {
      strokes: [],
      strokeIds: new Set(),
      pointCount: 0,
      retainedBytes: 0,
      revision: 0,
    },
  });

  return res.status(201).json({
    id: code,
    name,
    code,
    participants: [],
  });
});

// Find room
app.get("/api/rooms/:code", requireAuth, (req, res) => {
  if (isRoomCodeRateLimited(req.ip)) return sendRoomCodeRateLimit(res);

  const code = String(req.params.code || "").trim().toUpperCase();
  const room = rooms.get(code);

  if (!ROOM_CODE_PATTERN.test(code) || !room) {
    if (recordRoomCodeFailure(req.ip)) return sendRoomCodeRateLimit(res);
    return res.status(404).json({
      error: "Meeting room not found. Check the meeting code.",
    });
  }

  return res.json({
    id: code,
    name: room.name,
    code,
  });
});

// Socket.IO
io.on("connection", (socket) => {
  console.log("Authenticated connection:", socket.id);

  socket.on("room:join", async (payload = {}) => {
    const auth = getActiveSocketSession(socket);
    if (!auth) return;
    const ip = socket.handshake.address || "unknown";
    if (isRoomCodeRateLimited(ip)) {
      socket.emit("room:error", "Too many invalid meeting codes. Wait 15 minutes and try again.");
      return;
    }

    const code =
      typeof payload?.code === "string" ? payload.code.trim().toUpperCase() : "";

    if (!ROOM_CODE_PATTERN.test(code) || !rooms.has(code)) {
      const rateLimited = recordRoomCodeFailure(ip);
      socket.emit(
        "room:error",
        rateLimited
          ? "Too many invalid meeting codes. Wait 15 minutes and try again."
          : "Room not found. Check the meeting code.",
      );
      return;
    }

    leaveCurrentRooms(socket);

    const room = rooms.get(code);
    const name = auth.user.displayName;

    try {
      await socket.join(code);
    } catch (error) {
      console.error("Could not join Socket.IO room:", error);
      socket.emit("room:error", "Could not join the meeting. Please try again.");
      return;
    }

    const currentAuth = getActiveSocketSession(socket);
    if (!currentAuth) {
      socket.leave(code);
      return;
    }

    room.participants.set(socket.id, {
      id: socket.id,
      userId: currentAuth.user.id,
      name,
    });

    const fileAccessToken = crypto.randomBytes(32).toString("hex");
    fileAccessTokens.set(fileAccessToken, {
      socketId: socket.id,
      code,
      tokenHash: currentAuth.tokenHash,
      userId: currentAuth.user.id,
    });

    socket.emit("room:joined", {
      code,
      name: room.name,
      participants: getParticipants(code),
      fileAccessToken,
    });
    socket.emit("whiteboard:state", {
      code,
      revision: room.whiteboard.revision,
      strokes: room.whiteboard.strokes,
    });

    sendParticipants(code);

    console.log(`${name} joined room ${code}`);
  });

  socket.on("room:leave", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.code !== "string"
    ) {
      respond({ ok: false, error: "This room-leave request is invalid." });
      return;
    }

    const code = payload.code.trim().toUpperCase();
    if (!ROOM_CODE_PATTERN.test(code)) {
      respond({ ok: false, error: "This room-leave request is invalid." });
      return;
    }

    if (socket.rooms.has(code)) {
      leaveCurrentRooms(socket);
      respond({ ok: true });
      return;
    }

    respond({ ok: false, error: "You are not a member of this meeting." });
  });

  socket.on("chat:send", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    const senderRoom = getSocketRoom(socket);

    if (!senderRoom) {
      respond({ ok: false, error: "Join a meeting before sending messages." });
      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.code !== "string" ||
      payload.code.trim().toUpperCase() !== senderRoom.code ||
      typeof payload.message !== "string"
    ) {
      respond({ ok: false, error: "This chat message is invalid." });
      return;
    }

    const message = payload.message.trim();
    if (!message || Array.from(message).length > MAX_CHAT_MESSAGE_LENGTH) {
      respond({
        ok: false,
        error: message
          ? `Messages must be ${MAX_CHAT_MESSAGE_LENGTH} characters or fewer.`
          : "Enter a message before sending.",
      });
      return;
    }

    const chatMessage = {
      id: crypto.randomUUID(),
      code: senderRoom.code,
      senderId: socket.id,
      senderName: senderRoom.participant.name,
      message,
      createdAt: new Date().toISOString(),
    };

    io.to(senderRoom.code).emit("chat:message", chatMessage);
    respond({ ok: true, id: chatMessage.id });
  });

  socket.on("whiteboard:stroke", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    const senderRoom = getSocketRoom(socket);

    if (!senderRoom) {
      respond({ ok: false, error: "Join a meeting before drawing." });
      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.code !== "string" ||
      payload.code.trim().toUpperCase() !== senderRoom.code ||
      !payload.stroke ||
      typeof payload.stroke !== "object" ||
      Array.isArray(payload.stroke)
    ) {
      respond({ ok: false, error: "This drawing data is invalid." });
      return;
    }

    let payloadBytes;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    } catch {
      respond({ ok: false, error: "This drawing data is invalid." });
      return;
    }

    const { stroke } = payload;
    if (
      payloadBytes > MAX_WHITEBOARD_STROKE_BYTES ||
      typeof stroke.id !== "string" ||
      !WHITEBOARD_STROKE_ID_PATTERN.test(stroke.id) ||
      !WHITEBOARD_COLORS.has(stroke.color) ||
      !Number.isInteger(stroke.size) ||
      stroke.size < 1 ||
      stroke.size > MAX_WHITEBOARD_BRUSH_SIZE ||
      typeof stroke.eraser !== "boolean" ||
      !Array.isArray(stroke.points) ||
      stroke.points.length < 1 ||
      stroke.points.length > MAX_WHITEBOARD_STROKE_POINTS
    ) {
      respond({
        ok: false,
        error: `Drawing must use an allowed color and brush size, with 1-${MAX_WHITEBOARD_STROKE_POINTS} points and a payload under ${MAX_WHITEBOARD_STROKE_BYTES / 1024} KB.`,
      });
      return;
    }

    if (senderRoom.room.whiteboard.strokeIds.has(stroke.id)) {
      respond({ ok: true, duplicate: true });
      return;
    }

    const points = [];
    for (const point of stroke.points) {
      if (
        !point ||
        typeof point !== "object" ||
        Array.isArray(point) ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.x > 1 ||
        point.y < 0 ||
        point.y > 1
      ) {
        respond({
          ok: false,
          error: "Drawing points must be valid normalized coordinates.",
        });
        return;
      }

      points.push({
        x: Math.round(point.x * 10000) / 10000,
        y: Math.round(point.y * 10000) / 10000,
      });
    }

    const storedStroke = {
      id: stroke.id,
      color: stroke.color,
      size: stroke.size,
      eraser: stroke.eraser,
      points,
      senderId: socket.id,
      senderName: senderRoom.participant.name,
    };
    const retainedBytes = Buffer.byteLength(
      JSON.stringify(storedStroke),
      "utf8",
    );
    const board = senderRoom.room.whiteboard;

    if (
      board.strokes.length >= MAX_WHITEBOARD_HISTORY_STROKES ||
      board.pointCount + points.length > MAX_WHITEBOARD_HISTORY_POINTS ||
      board.retainedBytes + retainedBytes > MAX_WHITEBOARD_HISTORY_BYTES
    ) {
      respond({
        ok: false,
        error: "This room's board has reached its drawing limit. Clear it to continue.",
      });
      return;
    }

    board.strokes.push(storedStroke);
    board.strokeIds.add(storedStroke.id);
    board.pointCount += points.length;
    board.retainedBytes += retainedBytes;
    board.revision += 1;

    io.to(senderRoom.code).emit("whiteboard:stroke", {
      code: senderRoom.code,
      revision: board.revision,
      stroke: storedStroke,
    });
    respond({ ok: true, id: storedStroke.id, revision: board.revision });
  });

  socket.on("whiteboard:clear", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    const senderRoom = getSocketRoom(socket);

    if (!senderRoom) {
      respond({ ok: false, error: "Join a meeting before clearing the board." });
      return;
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.code !== "string" ||
      payload.code.trim().toUpperCase() !== senderRoom.code ||
      Buffer.byteLength(JSON.stringify(payload), "utf8") > 256
    ) {
      respond({ ok: false, error: "This clear-board request is invalid." });
      return;
    }

    const board = senderRoom.room.whiteboard;
    board.strokes = [];
    board.strokeIds.clear();
    board.pointCount = 0;
    board.retainedBytes = 0;
    board.revision += 1;

    io.to(senderRoom.code).emit("whiteboard:clear", {
      code: senderRoom.code,
      revision: board.revision,
    });
    respond({ ok: true, revision: board.revision });
  });

  // Limits: 64 KiB per SDP, 4 KiB per ICE candidate, 256-character metadata,
  // 72 KiB per SDP signal, and 8 KiB per ICE signal.
  socket.on("webrtc:offer", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SIGNALING_PAYLOAD_BYTES
    ) {
      respond({ ok: false, error: "This WebRTC offer is invalid or too large." });
      return;
    }

    const { targetId, offer } = payload;
    if (
      !offer ||
      typeof offer !== "object" ||
      Array.isArray(offer) ||
      offer.type !== "offer" ||
      typeof offer.sdp !== "string" ||
      Buffer.byteLength(offer.sdp, "utf8") === 0 ||
      Buffer.byteLength(offer.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES
    ) {
      respond({ ok: false, error: "This WebRTC offer is malformed or too large." });
      return;
    }

    const target = getAuthorizedSignalTarget(socket, targetId);
    if (!target) {
      respond({ ok: false, error: "The signaling target is not in your meeting." });
      return;
    }

    target.targetSocket.emit("webrtc:offer", {
      fromId: socket.id,
      offer: { type: "offer", sdp: offer.sdp },
    });
    respond({ ok: true });
  });

  socket.on("webrtc:answer", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SIGNALING_PAYLOAD_BYTES
    ) {
      respond({ ok: false, error: "This WebRTC answer is invalid or too large." });
      return;
    }

    const { targetId, answer } = payload;
    if (
      !answer ||
      typeof answer !== "object" ||
      Array.isArray(answer) ||
      answer.type !== "answer" ||
      typeof answer.sdp !== "string" ||
      Buffer.byteLength(answer.sdp, "utf8") === 0 ||
      Buffer.byteLength(answer.sdp, "utf8") > MAX_SIGNALING_SDP_BYTES
    ) {
      respond({ ok: false, error: "This WebRTC answer is malformed or too large." });
      return;
    }

    const target = getAuthorizedSignalTarget(socket, targetId);
    if (!target) {
      respond({ ok: false, error: "The signaling target is not in your meeting." });
      return;
    }

    target.targetSocket.emit("webrtc:answer", {
      fromId: socket.id,
      answer: { type: "answer", sdp: answer.sdp },
    });
    respond({ ok: true });
  });

  socket.on("webrtc:ice-candidate", (payload, acknowledge) => {
    const respond = typeof acknowledge === "function" ? acknowledge : () => {};
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_SIGNALING_ICE_PAYLOAD_BYTES
    ) {
      respond({ ok: false, error: "This ICE candidate is invalid or too large." });
      return;
    }

    const { targetId, candidate } = payload;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      typeof candidate.candidate !== "string" ||
      Buffer.byteLength(candidate.candidate, "utf8") > MAX_SIGNALING_CANDIDATE_BYTES ||
      (candidate.sdpMid !== undefined &&
        candidate.sdpMid !== null &&
        (typeof candidate.sdpMid !== "string" ||
          candidate.sdpMid.length > MAX_SIGNALING_METADATA_LENGTH)) ||
      (candidate.sdpMLineIndex !== undefined &&
        candidate.sdpMLineIndex !== null &&
        (!Number.isInteger(candidate.sdpMLineIndex) ||
          candidate.sdpMLineIndex < 0 ||
          candidate.sdpMLineIndex > 65535)) ||
      (candidate.usernameFragment !== undefined &&
        candidate.usernameFragment !== null &&
        (typeof candidate.usernameFragment !== "string" ||
          candidate.usernameFragment.length > MAX_SIGNALING_METADATA_LENGTH))
    ) {
      respond({ ok: false, error: "This ICE candidate is malformed or too large." });
      return;
    }

    const target = getAuthorizedSignalTarget(socket, targetId);
    if (!target) {
      respond({ ok: false, error: "The signaling target is not in your meeting." });
      return;
    }

    target.targetSocket.emit("webrtc:ice-candidate", {
      fromId: socket.id,
      candidate: {
        candidate: candidate.candidate,
        ...(candidate.sdpMid !== undefined ? { sdpMid: candidate.sdpMid } : {}),
        ...(candidate.sdpMLineIndex !== undefined
          ? { sdpMLineIndex: candidate.sdpMLineIndex }
          : {}),
        ...(candidate.usernameFragment !== undefined
          ? { usernameFragment: candidate.usernameFragment }
          : {}),
      },
    });
    respond({ ok: true });
  });

  socket.on("disconnecting", () => {
    leaveCurrentRooms(socket);
  });

  socket.on("disconnect", () => {
    clearTimeout(socket.data.sessionExpiryTimer);
    console.log("Disconnected:", socket.id);
  });
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;

  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Files must be 25 MB or smaller." });
  }

  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: "Upload one supported file at a time." });
  }

  if (req.path.includes("/files") && error.message === "This file type is not supported.") {
    return res.status(400).json({ error: error.message });
  }

  console.error("Request failed:", error);
  return res.status(500).json({ error: "The server could not complete this request." });
});

server.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);
});

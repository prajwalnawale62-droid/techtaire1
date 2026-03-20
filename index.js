const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.json());

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const MAX_MESSAGES_PER_DAY = 3000;
const BATCH_SIZE = 500;
const MESSAGES_PER_BURST = 20;
const BURST_GAP_MS = 12000; // 12 seconds (between 10-15s range)
const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// ─────────────────────────────────────────────
// IN-MEMORY STORE
// ─────────────────────────────────────────────
// sessions: { userId -> { sock, status, qr, dailyCount, lastReset, queue, isSending } }
const sessions = {};

// ─────────────────────────────────────────────
// DAILY LIMIT RESET (runs at midnight)
// ─────────────────────────────────────────────
function resetDailyCount(userId) {
  const today = new Date().toDateString();
  if (sessions[userId] && sessions[userId].lastReset !== today) {
    sessions[userId].dailyCount = 0;
    sessions[userId].lastReset = today;
  }
}

// ─────────────────────────────────────────────
// CREATE / CONNECT SESSION FOR A USER
// ─────────────────────────────────────────────
async function createSession(userId) {
  if (sessions[userId]?.status === "connected") {
    return { success: false, message: "Already connected" };
  }

  const sessionPath = path.join(SESSIONS_DIR, userId);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sessions[userId] = {
    sock,
    status: "waiting_qr",
    qr: null,
    dailyCount: 0,
    lastReset: new Date().toDateString(),
    queue: [],
    isSending: false,
  };

  // ── QR Code Event ──
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[userId].qr = qr;
      sessions[userId].status = "waiting_qr";
      // Emit QR only to the specific user's socket room
      io.to(`user_${userId}`).emit("qr", { userId, qr });
      console.log(`[${userId}] QR Code generated`);
    }

    if (connection === "open") {
      sessions[userId].status = "connected";
      sessions[userId].qr = null;
      io.to(`user_${userId}`).emit("connected", { userId });
      console.log(`[${userId}] WhatsApp Connected!`);
    }

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      sessions[userId].status = "disconnected";
      io.to(`user_${userId}`).emit("disconnected", { userId });
      console.log(`[${userId}] Disconnected. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => createSession(userId), 3000);
      } else {
        // Logged out — clear session files
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete sessions[userId];
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return { success: true, message: "Session starting, QR will be emitted via socket" };
}

// ─────────────────────────────────────────────
// BATCH SENDER (20 msgs → gap → 20 msgs ...)
// ─────────────────────────────────────────────
async function processBatch(userId, batch) {
  const session = sessions[userId];
  if (!session || session.status !== "connected") return;

  let i = 0;
  while (i < batch.length) {
    const burst = batch.slice(i, i + MESSAGES_PER_BURST);

    for (const item of burst) {
      resetDailyCount(userId);

      if (session.dailyCount >= MAX_MESSAGES_PER_DAY) {
        io.to(`user_${userId}`).emit("limit_reached", {
          userId,
          message: "Daily limit of 3000 messages reached",
        });
        return;
      }

      try {
        const jid = item.number.includes("@s.whatsapp.net")
          ? item.number
          : `${item.number}@s.whatsapp.net`;

        await session.sock.sendMessage(jid, { text: item.message });
        session.dailyCount++;

        io.to(`user_${userId}`).emit("message_sent", {
          userId,
          number: item.number,
          dailyCount: session.dailyCount,
        });

        // Small 1s delay between individual messages within burst
        await sleep(1000);
      } catch (err) {
        io.to(`user_${userId}`).emit("message_failed", {
          userId,
          number: item.number,
          error: err.message,
        });
      }
    }

    i += MESSAGES_PER_BURST;

    // Gap between bursts (only if more messages remain)
    if (i < batch.length) {
      io.to(`user_${userId}`).emit("burst_gap", { userId, waitMs: BURST_GAP_MS });
      await sleep(BURST_GAP_MS);
    }
  }
}

async function processQueue(userId) {
  const session = sessions[userId];
  if (!session || session.isSending) return;

  session.isSending = true;

  while (session.queue.length > 0) {
    const batch = session.queue.splice(0, BATCH_SIZE);
    io.to(`user_${userId}`).emit("batch_started", {
      userId,
      batchSize: batch.length,
      remaining: session.queue.length,
    });
    await processBatch(userId, batch);
  }

  session.isSending = false;
  io.to(`user_${userId}`).emit("queue_complete", { userId });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Techtaire Server Running 🚀", time: new Date() });
});

// Start session (generate QR)
app.post("/session/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const result = await createSession(userId);
  res.json(result);
});

// Session status
app.get("/session/status/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.json({ status: "not_found" });

  res.json({
    status: session.status,
    dailyCount: session.dailyCount,
    queueLength: session.queue.length,
    isSending: session.isSending,
  });
});

// Logout session
app.post("/session/logout", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });

  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    await session.sock.logout();
  } catch (_) {}

  const sessionPath = path.join(SESSIONS_DIR, userId);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  delete sessions[userId];

  res.json({ success: true, message: `Session ${userId} logged out` });
});

// Send bulk messages
app.post("/messages/send", (req, res) => {
  const { userId, messages } = req.body;

  // Validate
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });

  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "connected")
    return res.status(400).json({ error: "WhatsApp not connected for this user" });

  resetDailyCount(userId);
  const remaining = MAX_MESSAGES_PER_DAY - session.dailyCount;
  if (remaining <= 0)
    return res.status(429).json({ error: "Daily limit of 3000 messages reached" });

  // Trim to daily remaining
  const toSend = messages.slice(0, remaining);

  // Push to queue
  session.queue.push(...toSend);

  // Start processing (non-blocking)
  processQueue(userId);

  res.json({
    success: true,
    queued: toSend.length,
    skipped: messages.length - toSend.length,
    dailyRemaining: remaining - toSend.length,
  });
});

// Get daily stats for a user
app.get("/messages/stats/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  resetDailyCount(userId);
  res.json({
    userId,
    dailyCount: session.dailyCount,
    dailyLimit: MAX_MESSAGES_PER_DAY,
    dailyRemaining: MAX_MESSAGES_PER_DAY - session.dailyCount,
    queueLength: session.queue.length,
    isSending: session.isSending,
    status: session.status,
  });
});

// ─────────────────────────────────────────────
// SOCKET.IO — User joins their private room
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // Client must emit join with their userId to get private events
  socket.on("join", (userId) => {
    socket.join(`user_${userId}`);
    console.log(`[Socket] ${socket.id} joined room user_${userId}`);

    // If session exists, send current status
    const session = sessions[userId];
    if (session) {
      socket.emit("status", { userId, status: session.status });
      if (session.qr) {
        socket.emit("qr", { userId, qr: session.qr });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Techtaire Server running on port ${PORT}`);
});

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
// CONFIG — 3000 messages in ~16 hours
// ─────────────────────────────────────────────
const MAX_MESSAGES_PER_DAY  = 3000;
const BATCH_SIZE            = 500;
const MESSAGES_PER_BURST    = 15;       // 15 messages per burst
const MIN_MSG_DELAY_MS      = 4000;     // 4 sec min between messages
const MAX_MSG_DELAY_MS      = 9000;     // 9 sec max between messages
const MIN_BURST_GAP_MS      = 270000;   // 4.5 min min between bursts
const MAX_BURST_GAP_MS      = 330000;   // 5.5 min max between bursts

// MATH:
// 3000 / 15 = 200 bursts
// Each burst: 15 msgs × avg 6.5s = ~97s (~1.6 min sending)
// Each gap: avg 5 min
// Total: 200 × (1.6 + 5) = 200 × 6.6 = 1320 min = ~16 hours ✅

const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// ─────────────────────────────────────────────
// IN-MEMORY STORE
// ─────────────────────────────────────────────
const sessions = {};

// ─────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────

// Random number between min and max
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// GUARANTEED sleep — always runs no matter what
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Validate phone number — only digits, 10–15 length
function isValidNumber(number) {
  const cleaned = number.replace(/\D/g, "");
  return cleaned.length >= 10 && cleaned.length <= 15;
}

// Clean number — remove all non-digits
function cleanNumber(number) {
  return number.replace(/\D/g, "");
}

// ─────────────────────────────────────────────
// DAILY LIMIT RESET
// ─────────────────────────────────────────────
function resetDailyCount(userId) {
  const today = new Date().toDateString();
  if (sessions[userId] && sessions[userId].lastReset !== today) {
    sessions[userId].dailyCount = 0;
    sessions[userId].lastReset = today;
    console.log(`[${userId}] Daily count reset for new day`);
  }
}

// ─────────────────────────────────────────────
// CREATE / CONNECT SESSION
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
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sessions[userId] = {
    sock,
    status: "waiting_qr",
    qr: null,
    dailyCount: 0,
    lastReset: new Date().toDateString(),
    queue: [],
    isSending: false,
    isPaused: false,
    failedNumbers: [],
  };

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[userId].qr = qr;
      sessions[userId].status = "waiting_qr";
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
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      sessions[userId].status = "disconnected";
      io.to(`user_${userId}`).emit("disconnected", { userId, statusCode });
      console.log(`[${userId}] Disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        const delay = randomBetween(5000, 15000);
        setTimeout(() => createSession(userId), delay);
      } else {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete sessions[userId];
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return { success: true, message: "Session starting, QR will be emitted via socket" };
}

// ─────────────────────────────────────────────
// SEND SINGLE MESSAGE
// sleep() is OUTSIDE try/catch — ALWAYS runs
// ─────────────────────────────────────────────
async function sendSingleMessage(userId, number, message) {
  const session = sessions[userId];
  const cleaned = cleanNumber(number);
  const jid = `${cleaned}@s.whatsapp.net`;

  try {
    // Simulate typing like a real human
    await session.sock.sendPresenceUpdate("composing", jid);
    await sleep(randomBetween(1000, 2500));
    await session.sock.sendPresenceUpdate("paused", jid);

    // Send message
    await session.sock.sendMessage(jid, { text: message });
    session.dailyCount++;

    io.to(`user_${userId}`).emit("message_sent", {
      userId,
      number: cleaned,
      dailyCount: session.dailyCount,
      dailyRemaining: MAX_MESSAGES_PER_DAY - session.dailyCount,
    });

    console.log(`[${userId}] ✅ Sent to ${cleaned} | Total: ${session.dailyCount}`);

  } catch (err) {
    // Log failure but do NOT return — sleep() must still run below
    session.failedNumbers.push(cleaned);

    io.to(`user_${userId}`).emit("message_failed", {
      userId,
      number: cleaned,
      error: err.message,
    });

    console.log(`[${userId}] ❌ Failed: ${cleaned} — ${err.message}`);
  }

  // ✅ GUARANTEED DELAY — error aaye ya na aaye, ye HAMESHA chalega
  const msgDelay = randomBetween(MIN_MSG_DELAY_MS, MAX_MSG_DELAY_MS);
  console.log(`[${userId}] ⏱ Next message in ${(msgDelay / 1000).toFixed(1)}s`);
  await sleep(msgDelay);
}

// ─────────────────────────────────────────────
// PROCESS BATCH
// ─────────────────────────────────────────────
async function processBatch(userId, batch) {
  const session = sessions[userId];
  if (!session || session.status !== "connected") return;

  // Filter invalid numbers before starting
  const validBatch = batch.filter((item) => {
    if (!isValidNumber(item.number)) {
      io.to(`user_${userId}`).emit("message_failed", {
        userId,
        number: item.number,
        error: "Invalid number — skipped",
      });
      console.log(`[${userId}] ⚠️ Invalid number skipped: ${item.number}`);
      return false;
    }
    return true;
  });

  let i = 0;

  while (i < validBatch.length) {

    // Stop if session lost
    if (!sessions[userId] || sessions[userId].status !== "connected") {
      console.log(`[${userId}] Session lost. Stopping batch.`);
      break;
    }

    // Stop if paused
    if (sessions[userId].isPaused) {
      io.to(`user_${userId}`).emit("queue_paused", {
        userId,
        message: "Queue is paused. Call /messages/resume to continue.",
      });
      console.log(`[${userId}] Queue paused by user.`);
      break;
    }

    const burstNumber = Math.floor(i / MESSAGES_PER_BURST) + 1;
    const burst = validBatch.slice(i, i + MESSAGES_PER_BURST);

    io.to(`user_${userId}`).emit("burst_started", {
      userId,
      burstNumber,
      burstSize: burst.length,
      totalSent: i,
      totalRemaining: validBatch.length - i,
    });

    console.log(`[${userId}] 🚀 Burst #${burstNumber} started — ${burst.length} messages`);

    // Send each message in this burst
    for (const item of burst) {
      resetDailyCount(userId);

      // Daily limit check
      if (session.dailyCount >= MAX_MESSAGES_PER_DAY) {
        io.to(`user_${userId}`).emit("limit_reached", {
          userId,
          message: "Daily limit of 3000 messages reached. Stopping.",
        });
        session.isSending = false;
        return;
      }

      await sendSingleMessage(userId, item.number, item.message);
    }

    i += MESSAGES_PER_BURST;

    // Gap between bursts (only if more messages remain)
    if (i < validBatch.length) {
      const burstGap = randomBetween(MIN_BURST_GAP_MS, MAX_BURST_GAP_MS);
      const gapMin = (burstGap / 60000).toFixed(1);

      io.to(`user_${userId}`).emit("burst_gap", {
        userId,
        burstNumber,
        waitMs: burstGap,
        waitMinutes: gapMin,
        totalSent: i,
        totalRemaining: validBatch.length - i,
        message: `Burst #${burstNumber} done. Waiting ${gapMin} min before next burst...`,
      });

      console.log(`[${userId}] ⏳ Burst gap: ${gapMin} minutes`);
      await sleep(burstGap);
    }
  }
}

// ─────────────────────────────────────────────
// QUEUE PROCESSOR
// ─────────────────────────────────────────────
async function processQueue(userId) {
  const session = sessions[userId];
  if (!session || session.isSending) return;

  session.isSending = true;
  console.log(`[${userId}] Queue processing started`);

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

  io.to(`user_${userId}`).emit("queue_complete", {
    userId,
    totalSent: session.dailyCount,
    totalFailed: session.failedNumbers.length,
    failedNumbers: session.failedNumbers,
  });

  console.log(`[${userId}] ✅ Queue complete. Sent: ${session.dailyCount} | Failed: ${session.failedNumbers.length}`);
}

// ─────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Techtaire Server Running 🚀",
    time: new Date(),
    config: {
      maxPerDay: MAX_MESSAGES_PER_DAY,
      messagesPerBurst: MESSAGES_PER_BURST,
      msgDelayRange: `${MIN_MSG_DELAY_MS / 1000}s – ${MAX_MSG_DELAY_MS / 1000}s`,
      burstGapRange: `${MIN_BURST_GAP_MS / 60000}min – ${MAX_BURST_GAP_MS / 60000}min`,
      estimatedTimeFor3000: "~16 hours",
    },
  });
});

// Start session
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
    dailyLimit: MAX_MESSAGES_PER_DAY,
    dailyRemaining: MAX_MESSAGES_PER_DAY - session.dailyCount,
    queueLength: session.queue.length,
    isSending: session.isSending,
    isPaused: session.isPaused,
    failedCount: session.failedNumbers?.length || 0,
  });
});

// Logout session
app.post("/session/logout", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  try { await session.sock.logout(); } catch (_) {}
  const sessionPath = path.join(SESSIONS_DIR, userId);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  delete sessions[userId];
  res.json({ success: true, message: `Session ${userId} logged out` });
});

// Send bulk messages
app.post("/messages/send", (req, res) => {
  const { userId, messages } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!Array.isArray(messages) || messages.length === 0)
    return res.status(400).json({ error: "messages array required" });

  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "connected")
    return res.status(400).json({ error: "WhatsApp not connected" });

  resetDailyCount(userId);
  const remaining = MAX_MESSAGES_PER_DAY - session.dailyCount;
  if (remaining <= 0)
    return res.status(429).json({ error: "Daily limit of 3000 messages reached" });

  const toSend = messages.slice(0, remaining);
  session.queue.push(...toSend);
  processQueue(userId);

  res.json({
    success: true,
    queued: toSend.length,
    skipped: messages.length - toSend.length,
    dailyRemaining: remaining - toSend.length,
    estimatedTime: `~${((toSend.length / MESSAGES_PER_BURST) * ((MIN_BURST_GAP_MS + MAX_BURST_GAP_MS) / 2 / 60000 + 1.6) / 60).toFixed(1)} hours`,
  });
});

// Pause queue
app.post("/messages/pause", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.isPaused = true;
  res.json({ success: true, message: "Queue will pause after current message" });
});

// Resume queue
app.post("/messages/resume", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.isPaused = false;
  processQueue(userId);
  res.json({ success: true, message: "Queue resumed" });
});

// Get failed numbers
app.get("/messages/failed/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    userId,
    failedNumbers: session.failedNumbers || [],
    count: session.failedNumbers?.length || 0,
  });
});

// Clear failed numbers
app.delete("/messages/failed/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.failedNumbers = [];
  res.json({ success: true, message: "Failed numbers list cleared" });
});

// Daily stats
app.get("/messages/stats/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  resetDailyCount(userId);
  res.json({
    userId,
    status: session.status,
    dailyCount: session.dailyCount,
    dailyLimit: MAX_MESSAGES_PER_DAY,
    dailyRemaining: MAX_MESSAGES_PER_DAY - session.dailyCount,
    queueLength: session.queue.length,
    isSending: session.isSending,
    isPaused: session.isPaused,
    failedCount: session.failedNumbers?.length || 0,
  });
});

// ─────────────────────────────────────────────
// SOCKET.IO
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  socket.on("join", (userId) => {
    socket.join(`user_${userId}`);
    console.log(`[Socket] ${socket.id} joined room user_${userId}`);

    const session = sessions[userId];
    if (session) {
      socket.emit("status", { userId, status: session.status });
      if (session.qr) socket.emit("qr", { userId, qr: session.qr });
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
  console.log(`📊 Config: ${MESSAGES_PER_BURST} msgs/burst | ${MIN_MSG_DELAY_MS/1000}–${MAX_MSG_DELAY_MS/1000}s delay | ${MIN_BURST_GAP_MS/60000}–${MAX_BURST_GAP_MS/60000}min gap`);
  console.log(`⏱  3000 messages estimated time: ~16 hours`);
});

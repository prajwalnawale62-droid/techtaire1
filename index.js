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
const MESSAGES_PER_BURST    = 15;
const MIN_MSG_DELAY_MS      = 4000;
const MAX_MSG_DELAY_MS      = 9000;
const MIN_BURST_GAP_MS      = 270000;
const MAX_BURST_GAP_MS      = 330000;

// ✅ FIX 4: Failed numbers max limit — memory leak rokne ke liye
const MAX_FAILED_NUMBERS    = 10000;

const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

// ─────────────────────────────────────────────
// ✅ FIX 3: QUEUE PERSISTENCE — file mein save karo
// Server restart hone pe bhi queue wapas milegi
// ─────────────────────────────────────────────
const QUEUE_FILE = path.join(__dirname, "queue_state.json");

function saveQueueState() {
  try {
    const state = {};
    for (const [userId, session] of Object.entries(sessions)) {
      state[userId] = {
        queue: session.queue,
        dailyCount: session.dailyCount,
        lastReset: session.lastReset,
        failedNumbers: session.failedNumbers,
      };
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("[Queue] State save failed:", err.message);
  }
}

function loadQueueState() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return {};
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch (err) {
    console.error("[Queue] State load failed:", err.message);
    return {};
  }
}

// ─────────────────────────────────────────────
// IN-MEMORY STORE
// ─────────────────────────────────────────────
const sessions = {};

// ─────────────────────────────────────────────
// UTILITY FUNCTIONS
// ─────────────────────────────────────────────

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidNumber(number) {
  const cleaned = number.replace(/\D/g, "");
  return cleaned.length >= 10 && cleaned.length <= 15;
}

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
    saveQueueState(); // ✅ FIX 3: reset ke baad save karo
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

  // ✅ Fallback version — agar network slow ho
  let version;
  try {
    const result = await fetchLatestBaileysVersion();
    version = result.version;
  } catch (err) {
    version = [2, 3000, 1023625794]; // safe fallback version
    console.warn(`[${userId}] fetchLatestBaileysVersion failed, using fallback:`, version);
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // ✅ FIX 3: Pehle se saved queue restore karo
  const savedState = loadQueueState();
  const saved = savedState[userId] || {};

  sessions[userId] = {
    sock,
    status: "waiting_qr",
    qr: null,
    dailyCount: saved.dailyCount || 0,
    lastReset: saved.lastReset || new Date().toDateString(),
    queue: saved.queue || [],        // ✅ Queue restore
    isSending: false,
    isPaused: false,
    failedNumbers: saved.failedNumbers || [],
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

      // ✅ FIX 3: Connect hone pe agar queue thi toh resume karo
      if (sessions[userId].queue.length > 0 && !sessions[userId].isSending) {
        console.log(`[${userId}] Restored queue found (${sessions[userId].queue.length} items), resuming...`);
        processQueue(userId);
      }
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
        const sessionPath = path.join(SESSIONS_DIR, userId);
        fs.rmSync(sessionPath, { recursive: true, force: true });
        delete sessions[userId];
        saveQueueState(); // ✅ FIX 3: logout pe state clean karo
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  return { success: true, message: "Session starting, QR will be emitted via socket" };
}

// ─────────────────────────────────────────────
// SEND SINGLE MESSAGE
// ─────────────────────────────────────────────
async function sendSingleMessage(userId, number, message) {
  const session = sessions[userId];
  const cleaned = cleanNumber(number);
  const jid = `${cleaned}@s.whatsapp.net`;

  // ✅ FIX 1: Pause check sendSingleMessage ke ANDAR bhi — mid-burst bhi pause hoga
  if (session.isPaused) {
    console.log(`[${userId}] ⏸ Paused mid-burst, skipping ${cleaned}`);
    return "paused"; // caller ko batao ki paused hai
  }

  try {
    await session.sock.sendPresenceUpdate("composing", jid);
    await sleep(randomBetween(1000, 2500));
    await session.sock.sendPresenceUpdate("paused", jid);

    await session.sock.sendMessage(jid, { text: message });
    session.dailyCount++;

    // ✅ FIX 3: Har message ke baad state save karo
    saveQueueState();

    io.to(`user_${userId}`).emit("message_sent", {
      userId,
      number: cleaned,
      dailyCount: session.dailyCount,
      dailyRemaining: MAX_MESSAGES_PER_DAY - session.dailyCount,
    });

    console.log(`[${userId}] ✅ Sent to ${cleaned} | Total: ${session.dailyCount}`);

  } catch (err) {
    // ✅ FIX 4: failedNumbers max limit check
    if (session.failedNumbers.length < MAX_FAILED_NUMBERS) {
      session.failedNumbers.push(cleaned);
    } else {
      console.warn(`[${userId}] ⚠️ failedNumbers limit reached, not adding more`);
    }

    io.to(`user_${userId}`).emit("message_failed", {
      userId,
      number: cleaned,
      error: err.message,
    });

    console.log(`[${userId}] ❌ Failed: ${cleaned} — ${err.message}`);
  }

  // ✅ GUARANTEED DELAY — hamesha chalega
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

    if (!sessions[userId] || sessions[userId].status !== "connected") {
      console.log(`[${userId}] Session lost. Stopping batch.`);
      break;
    }

    // ✅ FIX 1: Pause check burst ke START pe
    if (sessions[userId].isPaused) {
      io.to(`user_${userId}`).emit("queue_paused", {
        userId,
        message: "Queue paused. Call /messages/resume to continue.",
      });
      console.log(`[${userId}] Queue paused.`);
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

    for (const item of burst) {
      resetDailyCount(userId);

      if (session.dailyCount >= MAX_MESSAGES_PER_DAY) {
        io.to(`user_${userId}`).emit("limit_reached", {
          userId,
          message: "Daily limit of 3000 messages reached. Stopping.",
        });
        session.isSending = false;
        return;
      }

      // ✅ FIX 1: sendSingleMessage se "paused" return aaye toh burst rok do
      const result = await sendSingleMessage(userId, item.number, item.message);
      if (result === "paused") {
        io.to(`user_${userId}`).emit("queue_paused", {
          userId,
          message: "Queue paused mid-burst. Call /messages/resume to continue.",
        });
        console.log(`[${userId}] Queue paused mid-burst.`);
        return; // processBatch se bahar nikal jao
      }
    }

    i += MESSAGES_PER_BURST;

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
// ✅ FIX 2: Resume pe double processing nahi hoga
// isSending flag se guard already hai — resume pe processQueue
// sirf tab call hoti hai jab isSending === false ho
// ─────────────────────────────────────────────
async function processQueue(userId) {
  const session = sessions[userId];
  if (!session || session.isSending) return; // ✅ Double processing blocked

  session.isSending = true;
  console.log(`[${userId}] Queue processing started`);

  while (session.queue.length > 0) {

    // ✅ FIX 1: Queue loop mein bhi pause check
    if (session.isPaused) {
      console.log(`[${userId}] Queue paused, exiting queue loop.`);
      break;
    }

    const batch = session.queue.splice(0, BATCH_SIZE);
    saveQueueState(); // ✅ FIX 3: Batch remove hone ke baad save

    io.to(`user_${userId}`).emit("batch_started", {
      userId,
      batchSize: batch.length,
      remaining: session.queue.length,
    });

    await processBatch(userId, batch);
  }

  session.isSending = false;

  // ✅ FIX 1: Agar paused hai toh complete emit mat karo
  if (!session.isPaused) {
    io.to(`user_${userId}`).emit("queue_complete", {
      userId,
      totalSent: session.dailyCount,
      totalFailed: session.failedNumbers.length,
      failedNumbers: session.failedNumbers,
    });
    console.log(`[${userId}] ✅ Queue complete. Sent: ${session.dailyCount} | Failed: ${session.failedNumbers.length}`);
    saveQueueState(); // ✅ Final save
  }
}

// ─────────────────────────────────────────────
// REST API ROUTES
// ─────────────────────────────────────────────

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

app.post("/session/start", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const result = await createSession(userId);
  res.json(result);
});

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

app.post("/session/logout", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  try { await session.sock.logout(); } catch (_) {}
  const sessionPath = path.join(SESSIONS_DIR, userId);
  fs.rmSync(sessionPath, { recursive: true, force: true });
  delete sessions[userId];
  saveQueueState(); // ✅ FIX 3: Logout pe state clean
  res.json({ success: true, message: `Session ${userId} logged out` });
});

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
  saveQueueState(); // ✅ FIX 3: Queue add hone ke baad save

  processQueue(userId); // ✅ FIX 2: isSending guard andar hai, safe hai

  res.json({
    success: true,
    queued: toSend.length,
    skipped: messages.length - toSend.length,
    dailyRemaining: remaining - toSend.length,
    estimatedTime: `~${((toSend.length / MESSAGES_PER_BURST) * ((MIN_BURST_GAP_MS + MAX_BURST_GAP_MS) / 2 / 60000 + 1.6) / 60).toFixed(1)} hours`,
  });
});

app.post("/messages/pause", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.isPaused = true;
  // ✅ FIX 1: Pause turant kaam karega — next message check pe rok jaayega
  res.json({ success: true, message: "Queue pausing — will stop at next message" });
});

app.post("/messages/resume", (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  session.isPaused = false;

  // ✅ FIX 2: Sirf tab processQueue call karo jab already nahi chal rahi
  if (!session.isSending && session.queue.length > 0) {
    processQueue(userId);
  }

  res.json({ success: true, message: "Queue resumed" });
});

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

app.delete("/messages/failed/:userId", (req, res) => {
  const { userId } = req.params;
  const session = sessions[userId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  session.failedNumbers = [];
  saveQueueState(); // ✅ FIX 3: Clear ke baad save
  res.json({ success: true, message: "Failed numbers list cleared" });
});

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
// GRACEFUL SHUTDOWN — Ctrl+C pe bhi state save ho
// ─────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\n[Server] Shutting down — saving queue state...");
  saveQueueState();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Server] SIGTERM — saving queue state...");
  saveQueueState();
  process.exit(0);
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

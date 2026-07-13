// ============================================================
//  บอท LINE ตอบลูกค้าอัตโนมัติ ด้วย Claude AI + ส่งรูปหลายรูปได้
//  สมองบอท (ข้อมูล+บุคลิก) อยู่ใน brain.js + data/knowledge.md
//  รูปห้อง/บรรยากาศ อยู่ในโฟลเดอร์ images/ (ห้องละหลายรูป)
// ============================================================

const express = require("express");
const line = require("@line/bot-sdk");
const path = require("path");
const fs = require("fs");
const { generateReply } = require("./brain");

// ---- กุญแจ LINE + ที่อยู่สาธารณะ (สำหรับลิงก์รูป) ----
// .trim() กันช่องว่าง/ขึ้นบรรทัดใหม่ที่อาจติดมาตอน paste ค่าใน Render
const LINE_CHANNEL_SECRET = (process.env.LINE_CHANNEL_SECRET || "").trim();
const LINE_CHANNEL_ACCESS_TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// ---- โหลดรายชื่อรูปแต่ละห้อง จากโฟลเดอร์ images/ อัตโนมัติ ----
//  รูปปก = <key>.jpg (มาก่อน), รูปเพิ่ม = <key>-2.jpg, <key>-3.jpg ...
//  อยากเพิ่ม/เปลี่ยนรูป: แค่เอาไฟล์ไปวาง/ลบในโฟลเดอร์ images/ แล้วรีสตาร์ทบอท
const IMAGE_KEYS = [
  "premier-king", "family-room", "sky-riverview",
  "luxury-villa", "pool-panoramic", "pool-pet", "view",
];

function loadImages() {
  const dir = path.join(__dirname, "images");
  const all = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f))
    : [];
  const map = {};
  for (const key of IMAGE_KEYS) {
    const re = new RegExp("^" + key + "(-(\\d+))?\\.jpe?g$", "i");
    map[key] = all
      .filter((f) => re.test(f))
      .sort((a, b) => {
        const na = a.toLowerCase() === key + ".jpg" ? 0 : parseInt((a.match(/-(\d+)\./) || [])[1] || "999", 10);
        const nb = b.toLowerCase() === key + ".jpg" ? 0 : parseInt((b.match(/-(\d+)\./) || [])[1] || "999", 10);
        return na - nb;
      });
  }
  return map;
}
const IMAGES = loadImages();
const BATCH = 4; // ส่งรูปทีละ 4 (ข้อความ + 4 รูป = 5 = ลิมิต LINE)

// ---- ความจำการสนทนา + ความคืบหน้าการส่งรูป (ต่อคน) ----
const conversations = new Map();
const imgProgress = new Map(); // userId -> { key: จำนวนที่ส่งไปแล้ว }
const MAX_TURNS = 10;

function nextBatch(userId, key) {
  const files = IMAGES[key] || [];
  if (files.length === 0) return [];
  if (!imgProgress.has(userId)) imgProgress.set(userId, {});
  const prog = imgProgress.get(userId);
  let start = prog[key] || 0;
  if (start >= files.length) start = 0; // ดูครบแล้ว วนกลับไปเริ่มใหม่
  const batch = files.slice(start, start + BATCH);
  prog[key] = start + batch.length;
  return batch;
}

// ---- แปลงคำตอบ (ที่อาจมี [[IMG:key]] / [[IMG:key:more]]) เป็นข้อความ LINE ----
function buildMessages(userId, replyText) {
  const files = [];
  const text = replyText
    // [[IMG:key:more]] = ส่งรูปชุดถัดไป (4 รูป)
    .replace(/\[\[IMG:([a-z-]+):more\]\]/gi, (_m, k) => {
      if (IMAGES[k]) files.push(...nextBatch(userId, k));
      return "";
    })
    // [[IMG:key]] = ส่งรูปปก 1 รูป
    .replace(/\[\[IMG:([a-z-]+)\]\]/gi, (_m, k) => {
      if (IMAGES[k] && IMAGES[k][0]) files.push(IMAGES[k][0]);
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ type: "text", text });
  for (const f of files) {
    if (!PUBLIC_URL) break;
    const url = `${PUBLIC_URL}/images/${encodeURIComponent(f)}`;
    messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  return messages.slice(0, 5); // LINE จำกัด 5 ข้อความต่อการตอบ 1 ครั้ง
}

async function handleTextMessage(event) {
  const userId = event.source.userId || "unknown";
  const userText = event.message.text;

  let history = conversations.get(userId) || [];
  history.push({ role: "user", content: userText });
  if (history.length > MAX_TURNS * 2) {
    history = history.slice(-MAX_TURNS * 2);
  }

  let replyText;
  try {
    replyText = await generateReply(history);
  } catch (err) {
    console.error("Claude error:", err);
    replyText = "";
  }

  let messages;
  if (!replyText) {
    messages = [
      { type: "text", text: "ขออภัยค่ะ ระบบขัดข้องชั่วคราว รบกวนลองใหม่อีกครั้งนะคะ 🙏" },
    ];
  } else {
    history.push({ role: "assistant", content: replyText });
    conversations.set(userId, history);
    messages = buildMessages(userId, replyText);
    if (messages.length === 0) {
      messages = [{ type: "text", text: replyText }];
    }
  }

  await lineClient.replyMessage({ replyToken: event.replyToken, messages });
}

// ---- เว็บเซิร์ฟเวอร์ ----
const app = express();
app.use("/images", express.static(path.join(__dirname, "images")));
app.get("/", (_req, res) => res.send("LINE Claude bot is running ✅"));

// ปุ่มทดสอบลับ: เช็คว่ารุ่นโค้ดไหนกำลังรัน + กุญแจสะอาดไหม + AI ตอบได้ไหม
app.get("/selftest", async (_req, res) => {
  const raw = process.env.ANTHROPIC_API_KEY || "";
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "");
  let claude;
  try {
    const reply = await generateReply([{ role: "user", content: "สวัสดี" }]);
    claude = reply ? "OK: " + reply.slice(0, 50) : "EMPTY_REPLY";
  } catch (e) {
    claude = "ERROR: " + (e && e.message ? e.message : String(e));
  }
  res.json({ version: "v3-strip-keychars", keyRawLen: raw.length, keyCleanLen: clean.length, claude });
});
app.post(
  "/webhook",
  line.middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  async (req, res) => {
    res.status(200).end();
    const events = req.body.events || [];
    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        try {
          await handleTextMessage(event);
        } catch (err) {
          console.error("Handle error:", err);
        }
      }
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot listening on port ${port}`));

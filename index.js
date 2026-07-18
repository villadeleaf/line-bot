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
const { faqEnabled, loadFaq, teachFaq, faqText } = require("./faq");

// LINE userId ของแอดมินที่สอนบอทได้ (คั่นด้วยจุลภาค) เช่น "U123...,U456..."
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
  "package", // รูปเรทแพ็กเกจเหมา/กรุ๊ป (วันธรรมดา/เสาร์-อาทิตย์/เทศกาล)
  "food",       // อาหารเช้า (ใบ Breakfast Selection + จานจริง)
  "atv",        // กิจกรรม ATV
  "raft",       // ล่องแก่ง
  "merit",      // ตักบาตรทางเรือ (ทำบุญตอนเช้า)
  "accessible", // ทางลาด/พื้นที่รองรับวีลแชร์-ผู้สูงอายุ
  "nearby",     // อินโฟกราฟิก ที่เที่ยวใกล้รีสอร์ท
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
const seenEvents = new Set(); // webhookEventId ที่ประมวลผลแล้ว (กันตอบซ้ำจาก LINE redelivery)
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

// ตอบกลับข้อความเดียวสั้น ๆ (ใช้กับคำสั่งแอดมิน)
async function replyText1(replyToken, text) {
  await lineClient.replyMessage({ replyToken, messages: [{ type: "text", text }] });
}

// ============================================================
//  ระบบแจ้งเตือนแอดมิน + รับช่วงคุยเอง (handover)
// ============================================================

// ---- ชื่อโปรไฟล์ลูกค้า (แคชไว้ ไม่ต้องยิงทุกครั้ง) ----
const nameCache = new Map();
async function getName(userId) {
  if (nameCache.has(userId)) return nameCache.get(userId);
  let name = "ลูกค้า";
  try {
    const p = await lineClient.getProfile(userId);
    if (p && p.displayName) name = p.displayName;
  } catch (_e) {}
  nameCache.set(userId, name);
  return name;
}

// ---- สถานะ "หยุดบอทให้ลูกค้าคนนี้" (แอดมินคุยเอง) ----
const pausedUsers = new Map(); // customerId -> pausedAt (ms)
const AUTO_RESUME_MS = 2 * 60 * 60 * 1000; // ตื่นเองอัตโนมัติหลัง 2 ชม. (กันลืมกดให้บอทต่อ)
function pauseUser(id) { pausedUsers.set(id, Date.now()); }
function resumeUser(id) { pausedUsers.delete(id); }
function isPaused(id) {
  const t = pausedUsers.get(id);
  if (!t) return false;
  if (Date.now() - t > AUTO_RESUME_MS) { pausedUsers.delete(id); return false; } // ตื่นเอง
  return true;
}

// ---- ข้อความแจ้งเตือน + ปุ่ม (buttons template) ----
function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function alertMessage(custId, name, type, detail) {
  const titles = {
    booking: "🔔 ลูกค้าสนใจจอง!",
    lead: "🌟 ลูกค้าสนใจ (ยังไม่จอง) — น่าตามต่อ",
    help: "⚠️ น้องลีฟตอบไม่ได้ ขอทีมงานช่วย",
  };
  const title = titles[type] || titles.help;
  const text = clip(`${title}\n👤 ${name}\n${detail || ""}`.trim(), 160);
  return {
    type: "template",
    altText: `${title} — ${name}`,
    template: {
      type: "buttons",
      text,
      actions: [
        { type: "postback", label: "🙋 ขอคุยเอง", data: `handover:on:${custId}`, displayText: `ขอคุยเองกับ ${clip(name, 20)}` },
      ],
    },
  };
}

function resumeMessage(custId, name) {
  return {
    type: "template",
    altText: "ให้บอทตอบต่อ",
    template: {
      type: "buttons",
      text: clip(`คุยกับ ${name} เสร็จแล้ว กดให้น้องลีฟดูแลต่อได้เลยค่ะ 🌿`, 160),
      actions: [
        { type: "postback", label: "🤖 ให้บอทตอบต่อ", data: `handover:off:${custId}`, displayText: `ให้บอทตอบต่อ ${clip(name, 20)}` },
      ],
    },
  };
}

// ---- ส่งแจ้งเตือนไปหาแอดมินทุกคน ----
async function pushAlert(custId, name, type, detail) {
  if (ADMIN_USER_IDS.length === 0) return;
  const msg = alertMessage(custId, name, type, detail);
  for (const adminId of ADMIN_USER_IDS) {
    try {
      await lineClient.pushMessage({ to: adminId, messages: [msg] });
    } catch (e) {
      console.error("pushAlert error:", e.message);
    }
  }
}

// ---- แอดมินกดปุ่ม (postback) ขอคุยเอง / ให้บอทต่อ ----
async function handlePostback(event) {
  const userId = event.source.userId || "";
  if (!ADMIN_USER_IDS.includes(userId)) return; // เฉพาะแอดมิน
  const m = (event.postback.data || "").match(/^handover:(on|off):(.+)$/);
  if (!m) return;
  const [, action, custId] = m;
  const name = await getName(custId);
  if (action === "on") {
    pauseUser(custId);
    await lineClient.replyMessage({
      replyToken: event.replyToken,
      messages: [
        { type: "text", text: `หยุดให้แล้วค่ะ 🤫 คุณคุยกับ ${name} ได้เลย น้องลีฟจะไม่แย่งตอบนะคะ (ถ้าลืมกดให้บอทต่อ เดี๋ยวหนูตื่นเองใน 2 ชม.)` },
        resumeMessage(custId, name),
      ],
    });
  } else {
    resumeUser(custId);
    await replyText1(event.replyToken, `น้องลีฟกลับมาดูแล ${name} ต่อแล้วค่ะ 🌿`);
  }
}

// ---- ข้อความต้อนรับ เมื่อลูกค้าแอดบอทเป็นเพื่อนครั้งแรก (follow) ----
const WELCOME_MESSAGE =
  "สวัสดีค่ะ 🌿 น้องลีฟยินดีต้อนรับสู่ Villa de Leaf River Kaeng Krachan ค่ะ!\n\n" +
  "รีสอร์ทริมแม่น้ำเพชรบุรี บรรยากาศธรรมชาติ สระว่ายน้ำเกลือ วิวแม่น้ำสวย ๆ 🏞️\n\n" +
  "สนใจเรื่องไหนถามน้องลีฟได้เลยนะคะ 😊\n" +
  "🛏️ ห้องพัก / ราคา / ดูรูป\n" +
  "🍽️ อาหาร\n" +
  "🎣 กิจกรรม (ล่องเรือ · ATV · นวด)\n" +
  "🗺️ ที่เที่ยวรอบรีสอร์ท\n\n" +
  "พิมพ์ทักมาได้เลยค่ะ น้องลีฟช่วยดูแลให้ทริปของคุณดีที่สุดเลยค่ะ 💚";

async function handleFollow(event) {
  try {
    await replyText1(event.replyToken, WELCOME_MESSAGE);
  } catch (e) {
    console.error("handleFollow error:", e.message);
  }
}

async function handleTextMessage(event) {
  const userId = event.source.userId || "unknown";
  const userText = event.message.text;
  const trimmed = userText.trim();
  const isAdmin = ADMIN_USER_IDS.includes(userId);

  // ---- คำสั่ง #myid : บอทบอก LINE userId ของคุณ (ไว้ตั้งค่าแอดมิน) ----
  if (trimmed === "#myid") {
    await replyText1(event.replyToken, `LINE userId ของคุณคือ:\n${userId}`);
    return;
  }

  // ---- คำสั่ง #สอน คำถาม | คำตอบ : สอนบอท (เฉพาะแอดมิน) ----
  if (trimmed.startsWith("#สอน")) {
    if (!isAdmin) {
      await replyText1(event.replyToken, "ขออภัยค่ะ คำสั่งนี้ใช้ได้เฉพาะแอดมินเท่านั้นนะคะ 🙏");
      return;
    }
    const body = trimmed.replace(/^#สอน\s*/, "");
    const idx = body.indexOf("|");
    if (idx === -1) {
      await replyText1(event.replyToken, 'พิมพ์แบบนี้นะคะ:\n#สอน คำถาม | คำตอบ\n\nตัวอย่าง:\n#สอน มีที่จอดรถไหม | มีค่ะ จอดฟรีหน้าห้อง 10 คัน');
      return;
    }
    const q = body.slice(0, idx).trim();
    const a = body.slice(idx + 1).trim();
    if (!q || !a) {
      await replyText1(event.replyToken, "ใส่ทั้งคำถามและคำตอบด้วยนะคะ 🙏\n#สอน คำถาม | คำตอบ");
      return;
    }
    try {
      await teachFaq(q, a);
      await replyText1(event.replyToken, `จำแล้วค่ะ ✅\nถาม: ${q}\nตอบ: ${a}\n\nครั้งหน้าลูกค้าถามเรื่องนี้ หนูตอบเองได้เลยค่ะ 😊`);
    } catch (e) {
      console.error("teachFaq error:", e.message);
      await replyText1(event.replyToken, `บันทึกไม่สำเร็จค่ะ 🙏 (${e.message})`);
    }
    return;
  }

  // ---- ถ้าแอดมินขอ "คุยเอง" กับลูกค้าคนนี้อยู่ → เก็บประวัติไว้ แต่บอทเงียบ ไม่ตอบ ----
  if (!isAdmin && isPaused(userId)) {
    const h = conversations.get(userId) || [];
    h.push({ role: "user", content: userText });
    conversations.set(userId, h);
    return;
  }

  let history = conversations.get(userId) || [];
  history.push({ role: "user", content: userText });
  if (history.length > MAX_TURNS * 2) {
    history = history.slice(-MAX_TURNS * 2);
  }

  // ดึงความรู้ที่แอดมินสอนไว้ (จาก Google Sheet) มาแนบให้ AI
  let extra = "";
  try {
    if (faqEnabled()) extra = faqText(await loadFaq());
  } catch (e) {
    console.error("loadFaq error:", e.message);
  }

  let replyText;
  try {
    replyText = await generateReply(history, extra);
  } catch (err) {
    console.error("Claude error:", err);
    replyText = "";
  }

  let messages;
  const alerts = []; // เรื่องที่ต้องเด้งเตือนแอดมิน (จอง / ตอบไม่ได้)
  if (!replyText) {
    // AI เรียกไม่ได้ (เช่น API overload) → ตอบสุภาพ + เด้งเตือนแอดมินให้มารับช่วง (อย่าทิ้งลูกค้า)
    messages = [
      { type: "text", text: "ขอโทษนะคะ 🙏 ตอนนี้น้องลีฟตอบช้าไปนิดนึง เดี๋ยวทีมงานมาดูแลต่อให้เลยนะคะ สักครู่ค่ะ 😊" },
    ];
    alerts.push({ type: "help", detail: "⚠️ ระบบ AI ขัดข้อง (บอทตอบลูกค้าไม่ได้ชั่วคราว) — ลูกค้ารออยู่ รบกวนเข้าไปดูแลต่อด้วยค่ะ" });
  } else {
    // ดึงมาร์กเกอร์ [[ALERT:booking:...]] / [[ALERT:help:...]] ออก (ลูกค้าไม่เห็น) เก็บไว้แจ้งแอดมิน
    replyText = replyText
      .replace(/\[\[ALERT:(booking|help|lead):([^\]]*)\]\]/gi, (_m, type, detail) => {
        alerts.push({ type: type.toLowerCase(), detail: (detail || "").trim() });
        return "";
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!replyText) replyText = "รับเรื่องแล้วค่ะ เดี๋ยวน้องลีฟดูแลให้นะคะ 😊";

    history.push({ role: "assistant", content: replyText });
    conversations.set(userId, history);
    messages = buildMessages(userId, replyText);
    if (messages.length === 0) {
      messages = [{ type: "text", text: replyText }];
    }
  }

  await lineClient.replyMessage({ replyToken: event.replyToken, messages });

  // ตอบลูกค้าเสร็จแล้ว → เด้งเตือนแอดมิน (ถ้ามี)
  if (alerts.length > 0) {
    const name = await getName(userId);
    for (const a of alerts) await pushAlert(userId, name, a.type, a.detail);
  }
}

// ---- เว็บเซิร์ฟเวอร์ ----
const app = express();
app.use("/images", express.static(path.join(__dirname, "images")));
app.get("/", (_req, res) => res.send("LINE Claude bot is running ✅"));

// ปุ่มตรวจสถานะระบบ (ล็อกด้วยกุญแจ + ไม่เรียก AI = ไม่เปลืองค่าใช้จ่าย)
//  ใช้เช็คว่ารุ่นโค้ดไหน deploy อยู่ + กุญแจสะอาดไหม + FAQ เชื่อมติดไหม
const SELFTEST_KEY = (process.env.FAQ_SECRET || "").trim();
app.get("/selftest", async (req, res) => {
  if (!SELFTEST_KEY || (req.query.key || "") !== SELFTEST_KEY) {
    return res.status(403).json({ error: "unauthorized" });
  }
  const clean = (process.env.ANTHROPIC_API_KEY || "").replace(/[^A-Za-z0-9_-]/g, "");
  const faq = { enabled: faqEnabled(), count: 0, error: null };
  try {
    if (faqEnabled()) faq.count = (await loadFaq()).length;
  } catch (e) {
    faq.error = e && e.message ? e.message : String(e);
  }
  res.json({
    version: "v7-sales",
    keyCleanLen: clean.length,
    adminCount: ADMIN_USER_IDS.length,
    faq,
  });
});
app.post(
  "/webhook",
  line.middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  async (req, res) => {
    res.status(200).end();
    const events = req.body.events || [];
    for (const event of events) {
      // กัน event ซ้ำ: LINE อาจส่ง webhook เดิมซ้ำ (redelivery/retry ตอน Render ตื่นจากหลับ)
      // ถ้าไม่กัน บอทจะตอบคำถามเดียวกันซ้ำ 2-3 รอบ
      const eid = event.webhookEventId;
      if (eid) {
        if (seenEvents.has(eid)) continue; // เคยเจอ event นี้แล้ว → ข้าม
        seenEvents.add(eid);
        if (seenEvents.size > 2000) seenEvents.clear(); // กันหน่วยความจำโตไม่จำกัด
      }
      try {
        if (event.type === "message" && event.message.type === "text") {
          await handleTextMessage(event);
        } else if (event.type === "postback") {
          await handlePostback(event); // ปุ่มขอคุยเอง / ให้บอทต่อ
        } else if (event.type === "follow") {
          await handleFollow(event); // ลูกค้าแอดบอทใหม่ → ทักทายต้อนรับ
        }
      } catch (err) {
        console.error("Handle error:", err);
      }
    }
  }
);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot listening on port ${port}`));

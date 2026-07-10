// ============================================================
//  บอท LINE ตอบลูกค้าอัตโนมัติ ด้วย Claude AI
//  - ขายห้องพัก / ขายอาหาร / ให้ข้อมูล 24 ชม.
//  ปกติคุณไม่ต้องแก้ไฟล์นี้เลย — แก้แค่ข้อมูลร้านในไฟล์ data/knowledge.md
// ============================================================

const express = require("express");
const line = require("@line/bot-sdk");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");

// ---- ตั้งค่ากุญแจ (มาจาก Environment Variables ตอน deploy) ----
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---- เลือกรุ่น AI ----
//  claude-haiku-4-5  = ถูก + เร็ว (แนะนำสำหรับตอบลูกค้าทั่วไป)
//  claude-sonnet-5   = ฉลาดกว่า แต่แพงกว่า (เปลี่ยนได้ถ้าต้องการคำตอบซับซ้อน)
const MODEL = "claude-haiku-4-5";

// ---- โหลด "ความรู้" ของร้าน (ห้องพัก / เมนู / ข้อมูล) ----
const knowledge = fs.readFileSync(
  path.join(__dirname, "data", "knowledge.md"),
  "utf8"
);

// ---- บุคลิกและวิธีตอบของบอท ----
const SYSTEM_PROMPT = `คุณคือแอดมินร้านที่สุภาพ เป็นกันเอง และช่วยขายเก่ง ตอบลูกค้าทางแชท LINE

หน้าที่ของคุณ:
- ตอบคำถามเรื่องห้องพัก ราคา ห้องว่าง โปรโมชั่น
- แนะนำและช่วยขายอาหาร/เมนู
- ให้ข้อมูลทั่วไปของร้าน (ที่ตั้ง เวลาเปิด-ปิด การเดินทาง ฯลฯ)

วิธีตอบ:
- ตอบเป็นภาษาไทย สุภาพ ใช้คำลงท้าย "ค่ะ/ครับ" ให้เหมาะสม
- กระชับ อ่านง่าย เหมาะกับการอ่านบนมือถือ ไม่ยาวเกินไป
- ทำตัวเป็น "พนักงานขายเชิงรุก" ไม่ใช่แค่ตอบคำถาม — คิดแทนลูกค้า เสนอสิ่งที่คุ้มและน่าสนใจก่อนเสมอ
- ชูความคุ้ม: ถ้าเป็นช่วง Low season ให้บอกว่าราคาพิเศษกว่าปกติ (เทียบให้เห็นว่า High season แพงกว่า) เพื่อกระตุ้นการตัดสินใจ
- ขายพ่วง/อัปเซลเมื่อเหมาะ: เสนอกิจกรรม (ล่องเรือ 1,500฿, นวด 2 ชม. 700฿, ATV 300฿), อัปเกรดห้อง หรือเตียงเสริม เพื่อเพิ่มมูลค่าการจอง
- ไฮไลต์จุดขาย/ของฟรี: ตักบาตรริมน้ำวันอาทิตย์, ตลาดนัดริมน้ำจามจุรีเสาร์-อาทิตย์, สระเกลือ, วิวแม่น้ำ, รับสัตว์เลี้ยง, อาหารเช้าฟรี
- สร้างแรงจูงใจให้รีบจอง แต่ต้องเป็นความจริงเท่านั้น (เช่น ห้องรับสัตว์เลี้ยงมีจำนวนจำกัด) ห้ามโกหก
- ปิดการขายทุกครั้ง: ถามวันเข้าพัก/จำนวนคืน แล้วชวนจอง
- ห้ามลดราคา/ให้ส่วนลดที่ไม่มีในข้อมูลเอง ถ้าลูกค้าขอต่อราคา ให้เสนอสิ่งที่มี (แถมกิจกรรม/ชูโปรที่ระบุไว้) หรือบอกว่าจะเช็คโปรกับทีมงานให้
- เรื่องราคาห้อง: ต้อง "ถามวันที่เข้าพักก่อนเสมอ" แล้วดูตารางราคาให้ตรงช่วง (Low/High season + วันธรรมดา อา-พฤ / ศุกร์-เสาร์ / วันหยุดยาว / เทศกาลสงกรานต์-ปีใหม่) ห้ามเดาหรือบอกราคาลอย ๆ ถ้ายังไม่รู้วันที่ ให้บอก "ราคาเริ่มต้น" ได้ แล้วถามวันที่เพื่อเช็คราคาจริง
- ถ้าเป็นเรื่องที่ต้องยืนยัน (จองจริง/ชำระเงิน/เรื่องที่ไม่มีข้อมูล) ให้บอกลูกค้าว่าจะให้ทีมงานติดต่อกลับ หรือให้เบอร์ติดต่อ
- ตอบเฉพาะจากข้อมูลด้านล่าง อย่าเดาข้อมูลที่ไม่มี ถ้าไม่รู้ให้บอกตามตรงและเสนอให้ติดต่อทีมงาน

===== ข้อมูลร้าน =====
${knowledge}`;

// ---- ตัวเชื่อม ----
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

// ---- ความจำการสนทนา (เก็บชั่วคราวในหน่วยความจำ, รีเซ็ตเมื่อรีสตาร์ท) ----
const conversations = new Map();
const MAX_TURNS = 10; // จำย้อนหลังกี่รอบสนทนาต่อคน

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
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" }, // ประหยัดค่าใช้จ่ายจากข้อมูลที่ส่งซ้ำ
        },
      ],
      messages: history,
    });

    replyText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (err) {
    console.error("Claude error:", err);
    replyText = "";
  }

  if (!replyText) {
    replyText = "ขออภัยค่ะ ระบบขัดข้องชั่วคราว รบกวนลองใหม่อีกครั้งนะคะ 🙏";
  } else {
    history.push({ role: "assistant", content: replyText });
    conversations.set(userId, history);
  }

  await lineClient.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: "text", text: replyText }],
  });
}

// ---- เว็บเซิร์ฟเวอร์ ----
const app = express();

// หน้าเช็คว่าบอทออนไลน์
app.get("/", (_req, res) => res.send("LINE Claude bot is running ✅"));

// รับข้อความจาก LINE
app.post(
  "/webhook",
  line.middleware({ channelSecret: LINE_CHANNEL_SECRET }),
  async (req, res) => {
    res.status(200).end(); // ตอบ LINE ให้เร็วก่อน
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

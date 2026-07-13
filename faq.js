// ============================================================
//  FAQ — "สมุดความจำถาวร" ของบอท เก็บใน Google Sheet
//  แอดมินสอนบอทผ่าน LINE (#สอน คำถาม | คำตอบ) → บันทึกลงชีต
//  บอทดึงความรู้จากชีตมาตอบลูกค้าอัตโนมัติ
//
//  เชื่อมผ่าน Google Apps Script Web App:
//   - GET  <URL>?secret=xxx           → คืน JSON [{q, a}, ...]
//   - POST <URL> {secret, q, a}       → เพิ่มแถวใหม่ คืน {ok:true}
//  ตั้งค่าใน env: FAQ_SHEET_URL, FAQ_SECRET
// ============================================================

const FAQ_URL = (process.env.FAQ_SHEET_URL || "").trim();
const FAQ_SECRET = (process.env.FAQ_SECRET || "").trim();

// แคชไว้ ไม่ต้องยิงชีตทุกข้อความ (รีเฟรชอย่างมากทุก 60 วิ)
let cache = { items: [], at: 0 };
const TTL = 60 * 1000;

// เปิดใช้งาน FAQ ไหม (ถ้ายังไม่ตั้ง URL = ปิด ทำงานปกติได้)
function faqEnabled() {
  return FAQ_URL.length > 0;
}

// โหลดความรู้จากชีต (มีแคช)
async function loadFaq() {
  if (!faqEnabled()) return [];
  if (Date.now() - cache.at < TTL && cache.items.length >= 0 && cache.at > 0) {
    return cache.items;
  }
  try {
    const res = await fetch(`${FAQ_URL}?secret=${encodeURIComponent(FAQ_SECRET)}`);
    const data = await res.json();
    cache = { items: Array.isArray(data) ? data.filter((x) => x && x.q && x.a) : [], at: Date.now() };
  } catch (e) {
    console.error("FAQ load error:", e.message);
  }
  return cache.items;
}

// สอนบอท (เพิ่มความรู้ลงชีต)
async function teachFaq(q, a) {
  if (!faqEnabled()) throw new Error("ยังไม่ได้ตั้งค่า Google Sheet");
  const res = await fetch(FAQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: FAQ_SECRET, q, a }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || "บันทึกไม่สำเร็จ");
  cache.at = 0; // บังคับรีเฟรชครั้งหน้า
  return true;
}

// แปลงความรู้ FAQ เป็นข้อความแนบให้ AI
function faqText(items) {
  if (!items || items.length === 0) return "";
  const lines = items.map((x) => `- ถาม: ${x.q}\n  ตอบ: ${x.a}`).join("\n");
  return `\n\n===== ความรู้เพิ่มเติมที่แอดมินสอนไว้ (ให้ใช้ตอบลูกค้าได้เลย ถือว่าถูกต้อง) =====\n${lines}`;
}

module.exports = { faqEnabled, loadFaq, teachFaq, faqText };

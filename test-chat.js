// ============================================================
//  ห้องทดสอบส่วนตัว — คุยกับบอทจริงในเครื่อง (ไม่ต่อ LINE ไม่มีลูกค้าเห็น)
//  ใช้สมองตัวเดียวกับบอทจริง (brain.js) ทุกอย่าง
//
//  วิธีใช้:
//    node --env-file=.env test-chat.js "ข้อความ 1" "ข้อความ 2" ...
//  แต่ละข้อความ = ลูกค้าพิมพ์ 1 ที (คุยต่อเนื่องได้ บอทจำบทสนทนา)
// ============================================================

const { generateReply, MODEL } = require("./brain");

async function main() {
  const messages = process.argv.slice(2);
  if (messages.length === 0) {
    console.log('ตัวอย่าง: node --env-file=.env test-chat.js "สวัสดีครับ ห้องราคาเท่าไหร่"');
    return;
  }

  console.log(`🤖 ห้องทดสอบบอท Villa de Leaf (รุ่น ${MODEL}) — ไม่ต่อ LINE\n`);
  const history = [];
  for (const msg of messages) {
    history.push({ role: "user", content: msg });
    console.log("🧑 ลูกค้า: " + msg);
    const reply = await generateReply(history);
    history.push({ role: "assistant", content: reply });
    console.log("🤖 บอท: " + reply + "\n");
  }
}

main().catch((err) => {
  console.error("เกิดข้อผิดพลาด:", err.message);
  process.exit(1);
});

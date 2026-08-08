// ============================================================
//  บอท LINE ตอบลูกค้าอัตโนมัติ ด้วย Claude AI + ส่งรูปหลายรูปได้
//  สมองบอท (ข้อมูล+บุคลิก) อยู่ใน brain.js + data/knowledge.md
//  รูปห้อง/บรรยากาศ อยู่ในโฟลเดอร์ images/ (ห้องละหลายรูป)
// ============================================================

const express = require("express");
const line = require("@line/bot-sdk");
const path = require("path");
const fs = require("fs");
const { generateReply, generateFbReply, extractTeaching, extractAvailabilityQuery, findMenuImage } = require("./brain");

// ---- Phase 3: เช็คห้องว่างเรียลไทม์จากระบบเฮีย (อ่านอย่างเดียว) ----
//  ทำงานเมื่อตั้ง AVAIL_API_KEY เท่านั้น — ไม่ตั้ง = พฤติกรรมเดิมทุกอย่าง (ส่งทีมเช็ค)
const AVAIL_API_URL = (process.env.AVAIL_API_URL || "https://backend.villadeleaf.online/api/availability").trim();
const AVAIL_API_KEY = (process.env.AVAIL_API_KEY || "").trim();

async function fetchAvailability(checkin, checkout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${AVAIL_API_URL}?checkin=${encodeURIComponent(checkin)}&checkout=${encodeURIComponent(checkout)}`, {
      headers: { "x-api-key": AVAIL_API_KEY },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- ตัวช่วยวันที่ (UTC ล้วน กัน timezone เพี้ยน) + ป้ายไทย ----
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const TH_DOW = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const ymdToUTC = (s) => { const [y, m, d] = String(s).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const utcToYmd = (dt) => dt.toISOString().slice(0, 10);
const addDaysStr = (s, n) => { const dt = ymdToUTC(s); dt.setUTCDate(dt.getUTCDate() + n); return utcToYmd(dt); };
const thaiDate = (s) => { const dt = ymdToUTC(s); return `${dt.getUTCDate()} ${TH_MONTHS[dt.getUTCMonth()]} (${TH_DOW[dt.getUTCDay()]})`; };
// กันปี พ.ศ. หลุดมา (เช่น 2569) — ปีเกินปีปัจจุบัน +2 = พ.ศ. แน่นอน → ลบ 543 เป็น ค.ศ.
const fixBE = (d) => { const y = parseInt(String(d).slice(0, 4), 10); const nowY = new Date().getFullYear(); return y > nowY + 2 ? String(y - 543) + String(d).slice(4) : d; };
// season ที่ลดได้ = มีคำว่า Low (ทั้ง "Low season" และ "Low ศ-ส") · เรทพื้น (floor) = Low ที่ไม่ใช่ ศ-ส/เสาร์-อาทิตย์
const isLowSeason = (season) => /low/i.test(String(season));
const isLowWeekday = (season) => { const s = String(season); return /low/i.test(s) && !/ศ-ส|ศ\.?-?ส\.?|เสาร|อาทิตย/i.test(s); };

// เมื่อไหร่ถึงเข้าโหมดเช็คห้องว่าง/ราคา (รวมคำถามต่อ: ลด/แพง/คิดยังไง/ทำไม เพื่อให้ follow-up ทริกเกอร์บล็อกได้)
const AVAIL_RE = /ว่าง|เต็ม|จอง|เข้าพัก|ราคา|เรท|เท่าไหร่|เท่าไร|กี่บาท|คืนละ|available|vacan|book|price|rate|ลด|แพง|โปร|ส่วนลด|ถูก|คิดราคา|คิดยังไง|คำนวณ|ทำไม|ไม่เท่า|รายคืน|แจกแจง|discount/i;
// ลูกค้า "คุยเรื่องห้อง/ขอแนะนำห้อง" — ต้องเช็คปฏิทินด้วย (กันน้องลีฟเชียร์ห้องที่เต็มในวันที่ลูกค้าบอกไว้แล้ว)
const ROOM_RE = /ห้อง|วิลล่า|บ้านพัก|แนะนำ|กี่ท่าน|กี่คน|นอน|แบบไหน|แบบอื่น|อีกแบบ|หลัง|เตียงเสริม|luxury|pool|villa|sky|river|premier|family|king|panoram|pet/i;
// เมื่อไหร่ถึงต้องดึงรายคืน+โปร (จังหวะ 1-3) นอกเหนือจากยอดรวม (จังหวะ 0)
const DIG_RE = /คิด|คำนวณ|ทำไม|ไม่เท่า|ลด|แพง|ถูกกว่า|โปร|ส่วนลด|ต่อรอง|รายคืน|แจกแจง|breakdown|discount|เท่าวันธรรมดา|วันธรรมดา/i;

// ---- สร้างข้อมูลห้องว่าง+ราคา (แหล่งความจริงเดียว ใช้ทั้ง /webhook และ /ask) ----
//  จังหวะ 0 (เริ่มถามราคา) = โชว์ยอดรวมล้วน (ไม่มีเฉลี่ย/รายคืน)
//  จังหวะ 1-3 (คิดยังไง/ทำไมไม่เท่า/ขอลด) = แนบรายคืน + โปรส่วนลด Low season (ลดคืน ศ-ส Low ให้เท่าเรทวันธรรมดา)
//  ล้มเหลว/วันไม่ชัด = คืน "" เงียบ ๆ → กลับโหมดเดิม (ขอเช็คทีม) ลูกค้าไม่เจอ error
async function buildAvailabilityExtra(history, message) {
  if (!AVAIL_API_KEY) return "";
  // ทริกเกอร์เช็คห้องว่าง — เดิมดูแค่คำใน "ข้อความล่าสุด" → พลาดตอนลูกค้า:
  //   • ตอบสั้น ("ไม่มีค่ะ", "ค่ะ")  • ให้วันที่/จำนวนคนที่ไม่มีคำว่าห้อง/ราคา ("2 ท่าน วันที่ 10-12 สค.")
  // ใหม่: + จับรูปแบบวันที่/จำนวนคน + ทำงานต่อเนื่องเมื่อบทสนทนาอยู่ในโหมดจองแล้ว (มีคำคีย์ใน history ล่าสุด)
  // ตัวกรองจริงยังอยู่ที่ extractAvailabilityQuery (ต้องมีวันที่ชัด q.ask) → ทริกเกอร์กว้างขึ้นแต่ไม่ยิงมั่ว
  const msg = String(message);
  const DATE_RE = /\d{1,2}\s*[-–/]\s*\d{1,2}|วันที่|กี่คืน|\d+\s*คืน|\d+\s*ท่าน|\d+\s*คน|พรุ่งนี้|มะรืน|เสาร์|อาทิตย์|สุดสัปดาห์|ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค/;
  const recentText = history.slice(-6).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
  const inBookingFlow = AVAIL_RE.test(recentText) || ROOM_RE.test(recentText);
  if (!AVAIL_RE.test(msg) && !ROOM_RE.test(msg) && !DATE_RE.test(msg) && !inBookingFlow) return "";
  const q = await extractAvailabilityQuery(history);
  if (!q || !q.ask) return "";
  const checkin = fixBE(q.checkin);
  const checkout = fixBE(q.checkout);
  const data = await fetchAvailability(checkin, checkout);
  const av = data.available || {};
  const det = data.detail || {};
  const seasonTag = String(data.season || "").trim();

  // ----- จังหวะ 0: ยอดรวม + ห้องว่าง (โชว์เป็นค่าเริ่มต้น ไม่มีเฉลี่ย/รายคืน) -----
  // ข้อมูลคงที่ต่อห้อง (ความจุ + รับสัตว์เลี้ยง) — ใส่ลงในข้อมูลห้องว่างโดยตรง ให้ AI จับคู่ขนาด/หมา ตามข้อมูลจริง ไม่ใช่เดาจากชื่อห้อง
  const ROOM_INFO = {
    "Premier King": "พัก 2 ท่าน",
    "Premier Family": "พัก 4 ท่าน (ครอบครัว)",
    "Deluxe Sky Riverview": "พัก 2 ท่าน",
    "Luxury Villa": "พัก 2 ท่าน · รับสัตว์เลี้ยง 🐶",
    "Pool Villa (Pet Friendly)": "พัก 8 ท่าน (หลังใหญ่ มีสระส่วนตัว) · รับสัตว์เลี้ยง 🐶",
    "Panoramic Pool Villa": "พัก 8 ท่าน (หลังใหญ่ มีสระส่วนตัว)",
  };
  const lines = Object.entries(av)
    .map(([k, v]) => {
      const d = det[k] || {};
      const total = d.priceTotal ? ` · รวม ${Number(d.priceTotal).toLocaleString()}฿` : "";
      const info = ROOM_INFO[k] ? ` · ${ROOM_INFO[k]}` : "";
      return `• ${k}: ${Number(v) > 0 ? `ว่าง ${v} ห้อง ✅` : "เต็มแล้ว ❌"}${info}${total}`;
    })
    .join("\n");
  let extra =
    `\n\n[ข้อมูลห้องว่าง+ราคาจริงจากระบบจอง ณ ขณะนี้ · เช็คอิน ${checkin} → เช็คเอาท์ ${checkout} (${data.nights || "?"} คืน)]\n` +
    lines +
    (seasonTag ? `\nป้ายช่วงวันจากระบบจอง: "${seasonTag}"` : "") +
    `\n(ตรงปฏิทินจองจริง อัปเดตช้าสุด ~1 นาที)\n` +
    `คำสั่งราคา:\n` +
    `- ตอบยืนยันห้องว่าง/เต็มได้ทันทีอย่างมั่นใจ — ห้ามพูด "ขอเช็คกับทีมงาน" และห้ามใส่ [[ALERT:availability]]\n` +
    `- 💰 ค่าเริ่มต้น: โชว์เฉพาะ "ราคารวมทั้งหมด" ต่อห้อง (รวมอาหารเช้าแล้ว) — ❌ ห้ามโชว์ราคาเฉลี่ยต่อคืน ❌ ห้ามแจกแจงรายคืน เว้นแต่ลูกค้าถามวิธีคิด/ทำไมราคาต่างกัน\n` +
    `- ห้องที่ "เต็มแล้ว ❌" ต้องบอกตรง ๆ ว่าเต็ม แล้วเสนอห้องที่ว่างแทน\n` +
    `- 🎯 จับคู่ขนาดห้องกับจำนวนคน: แนะนำห้องที่ "พักพอดีกับจำนวนคนของลูกค้า" ก่อนเสมอ — ❌ ห้ามลากห้องใหญ่เกิน (เช่นหลังใหญ่พัก 8) มาเสนอลูกค้าแค่ 2 คน (โอเวอร์+แพงเกิน+งง) · เสนอห้องใหญ่/พูลวิลล่าเฉพาะเมื่อลูกค้าขอเอง ("มีใหญ่กว่าไหม/อยากได้สระ/มากันเยอะ")\n` +
    `- 🐶 ลูกค้ามีสัตว์เลี้ยง → เสนอเฉพาะห้องที่มีป้าย "รับสัตว์เลี้ยง 🐶" เท่านั้น · **2 ท่าน+หมา = เชียร์ Luxury Villa (พัก 2 · ถูกกว่า) ตัวเดียวจบ — ❌ ห้ามเอ่ยชื่อ/พูดถึง Pool Villa Pet เลยในจังหวะแรก แม้เป็นทางเลือกเสริมก็ห้าม** · จะพูดถึง Pool Villa Pet ได้เฉพาะตอนลูกค้าถามหาห้องใหญ่กว่า/อยากได้สระ/มากันเยอะเองเท่านั้น\n` +
    `- ราคามาจากปฏิทินจริง ห้ามคำนวณเอง/ห้ามใช้ตัวเลขในคลังทับ · ค่าสัตว์เลี้ยง 500฿/ตัว/คืน + เตียงเสริมตามกฎในคลัง (บวกเพิ่มบนยอดรวม)\n` +
    `- ลูกค้าตกลงจอง → เก็บชื่อ-เบอร์ + [[ALERT:booking:...]] (การจองจริงยังต้องทีมยืนยัน)`;

  // ----- จังหวะ 1-3: รายคืน + โปรส่วนลด (เฉพาะเมื่อลูกค้าเริ่มเจาะราคา/ขอลด) -----
  if (DIG_RE.test(String(message)) && data.nights && data.nights >= 1 && data.nights <= 14) {
    try {
      const nights = data.nights;
      // ยิงถามทีละคืน → ได้ราคา+season ต่อคืน
      const nightly = [];
      for (let i = 0; i < nights; i++) {
        const nd = await fetchAvailability(addDaysStr(checkin, i), addDaysStr(checkin, i + 1));
        nightly.push({ date: addDaysStr(checkin, i), season: String(nd.season || "").trim(), detail: nd.detail || {} });
      }
      // เรท Low วันธรรมดา (floor) ต่อห้อง: จากคืนใน stay ที่เป็น Low วันธรรมดาก่อน
      const floor = {};
      for (const n of nightly) {
        if (isLowWeekday(n.season)) {
          for (const [room, d] of Object.entries(n.detail)) {
            if (floor[room] == null && d.priceNight != null) floor[room] = Number(d.priceNight);
          }
        }
      }
      // ถ้าใน stay ไม่มีคืน Low วันธรรมดาเลย แต่มีคืน Low ศ-ส → ยิงถามวันจ-พฤ ข้างเคียงมาหาเรท floor
      //  (ลองหลายวันเรียงจากใกล้สุด เผื่อวันที่ใกล้เป็นวันหยุด/เทศกาล — สูงสุด 4 วัน)
      const hasLowFriSat = nightly.some((n) => isLowSeason(n.season) && !isLowWeekday(n.season));
      if (hasLowFriSat && Object.keys(floor).length === 0) {
        const cands = [];
        for (let off = -12; off <= 12; off++) {
          const dstr = addDaysStr(checkin, off);
          const dow = ymdToUTC(dstr).getUTCDay();
          if (dow >= 1 && dow <= 4) cands.push({ dstr, dist: Math.abs(off) }); // จ-พฤ เท่านั้น
        }
        cands.sort((a, b) => a.dist - b.dist);
        for (const c of cands.slice(0, 4)) {
          try {
            const pr = await fetchAvailability(c.dstr, addDaysStr(c.dstr, 1));
            if (isLowWeekday(String(pr.season || ""))) {
              for (const [room, d] of Object.entries(pr.detail || {})) {
                if (d.priceNight != null) floor[room] = Number(d.priceNight);
              }
              break; // เจอ Low วันธรรมดาแล้ว พอ
            }
          } catch (e) { /* ลองวันถัดไป */ }
        }
      }

      const availRooms = Object.keys(av).filter((k) => Number(av[k]) > 0);
      const breakdownLines = [];
      const promoLines = [];
      for (const room of availRooms) {
        const perNight = nightly.map((n) => {
          const rate = n.detail[room] && n.detail[room].priceNight != null ? Number(n.detail[room].priceNight) : null;
          const low = isLowSeason(n.season);
          const canDiscount = low && !isLowWeekday(n.season) && floor[room] != null && rate != null && floor[room] < rate;
          return { date: n.date, season: n.season, rate, low, canDiscount };
        });
        const nightsText = perNight
          .map((p) => {
            const tag = p.canDiscount ? ` [ลดได้→${floor[room].toLocaleString()}฿]` : p.low ? " [ราคา Low แล้ว ลดต่อไม่ได้]" : " [ลดไม่ได้]";
            return `    ${thaiDate(p.date)} ${p.rate != null ? p.rate.toLocaleString() + "฿" : "-"} — ${p.season}${tag}`;
          })
          .join("\n");
        const normalTotal = det[room] && det[room].priceTotal != null ? Number(det[room].priceTotal) : perNight.reduce((s, p) => s + (p.rate || 0), 0);
        const discountedTotal = perNight.reduce((s, p) => s + (p.canDiscount ? floor[room] : p.rate || 0), 0);
        breakdownLines.push(`  ${room} (รวมปกติ ${normalTotal.toLocaleString()}฿):\n${nightsText}`);
        if (discountedTotal < normalTotal) {
          promoLines.push(`  ${room}: ถ้าลูกค้าขอลด(โปร Low season) → รวมเหลือ ${discountedTotal.toLocaleString()}฿`);
        }
      }

      extra +=
        `\n\n[รายละเอียดรายคืน + โปรส่วนลด — ใช้ตามลำดับด้านล่างเท่านั้น]\n` +
        breakdownLines.join("\n") +
        (promoLines.length ? `\nโปรที่ลดได้ (ลดคืน ศ-ส ที่เป็น Low ให้เท่าเรทวันธรรมดา):\n` + promoLines.join("\n") : `\n(ช่วงวันนี้ไม่มีคืนที่ลดได้ตามโปร Low season)`) +
        `\nกฎการตอบตามลำดับ (ห้ามข้ามขั้น):\n` +
        `1) ลูกค้าถาม "คิดราคายังไง/คำนวณยังไง" → แจกแจงรายคืนตามข้างบน (ถ้าเกิน 4 คืน สรุปเป็นถูกสุด-แพงสุด + ยอดรวม) แล้วปิดด้วยยอดรวมปกติ\n` +
        `2) ลูกค้าถาม "ทำไมราคาไม่เท่ากัน" → อธิบายว่าคืนศุกร์-เสาร์เรทสูงกว่าวันธรรมดาตามปกติของรีสอร์ท — ❌ ยังไม่ลด ❌ ห้ามเอ่ยถึงโปร\n` +
        `3) ลูกค้า "ขอลด/บ่นว่าแพง" ตรง ๆ เท่านั้น → ยื่นโปร Low season: บอก "ยอดรวมหลังลด" ตามข้างบน + บอกว่าจัดโปร Low season ลดคืนศุกร์ให้เท่าเรทวันธรรมดา\n` +
        `4) ❌ ห้ามเสนอ/ใบ้ส่วนลดก่อนลูกค้าขอเด็ดขาด — คืนที่ลูกค้าไม่ขอ = เก็บราคาปฏิทินปกติ (นี่คือเจตนาของโปร: ไม่ขอ=ราคาเต็ม)\n` +
        `5) คืน [ลดไม่ได้] (วันหยุดยาว/เทศกาล/High season) ห้ามลดเด็ดขาด\n` +
        `6) ถ้าลดตามโปรจนสุดแล้วลูกค้ายังต่อราคาอีก → "ขอเช็คกับทีมงาน" + [[ALERT:discount:...]] (ห้ามลดเกินโปร)`;
      console.log(`avail+breakdown: ${checkin}→${checkout} nights=${nights} floorRooms=${Object.keys(floor).length}`);
    } catch (e) {
      console.error("breakdown/discount build error:", e.message); // เงียบ ๆ ใช้แค่จังหวะ 0
    }
  } else {
    console.log(`avail check ok: ${checkin}→${checkout}`);
  }
  return extra;
}

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
// ตัวดึงไฟล์ (รูป/วิดีโอ/เสียง) ที่ลูกค้าส่งมา — ใช้ตอนน้องลีฟ "อ่านรูป"
const lineBlobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});
// ---- แจ้งเตือนเข้า "กลุ่มไลน์ทีม" (ใช้ token ของ OA จริงที่อยู่ในกลุ่ม เช่น @villadeleaf) ----
//  ตั้ง env: ALERT_PUSH_TOKEN = Channel Access Token ของ OA ที่อยู่ในกลุ่ม · ALERT_GROUP_ID = C8efd...
//  ไม่ตั้ง = ไม่เด้งกลุ่ม (พฤติกรรมเดิม เด้งแชทแอดมินอย่างเดียว)
const ALERT_PUSH_TOKEN = (process.env.ALERT_PUSH_TOKEN || "").trim();
const ALERT_GROUP_ID = (process.env.ALERT_GROUP_ID || "").trim();
const alertClient = ALERT_PUSH_TOKEN
  ? new line.messagingApi.MessagingApiClient({ channelAccessToken: ALERT_PUSH_TOKEN })
  : null;
// Group ID จริงล่าสุดที่ webhook เห็น (ไว้หา ALERT_GROUP_ID ที่ถูกต้อง ผ่าน /selftest)
let lastGroupSeen = null;
// ตัวดักจับ /ask 20 รายการล่าสุด (ไว้เช็คผ่าน /selftest ว่า FB/LINE ยิงเข้า /ask จริงไหม)
const recentAsk = [];
// พักน้องลีฟทั้งระบบ (แอดมินกดจากหน้า /leaf) — รีเซ็ตเป็น "เปิด" เมื่อ deploy ใหม่
let botPaused = false;
const bootAt = Date.now();
// รวม Readable stream → Buffer
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

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
  "cafe",       // โปสเตอร์เมนูคาเฟ่ 4 ใบ (ปก=Signature · มัทฉะ/โซดา · ของหวาน · ไอศครีม)
  "map",        // แผนผังรีสอร์ทมุมสูง (Top View) — ตำแหน่งแต่ละวิลล่าริมแม่น้ำ
  "buffet",     // เมนูบุฟเฟต์อาหารเย็นกรุ๊ป (2 ราคา 350/400 · เซ็ตละ 3 · เลือก 1)
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
// ข้อมูลย่อรายแชท (ไว้โชว์รายชื่อในห้องแชท /leaf) — userId → {name, at, lastMsg, needsHuman}
const chatMeta = new Map();

// สกัด "สรุปการจอง" จากบทสนทนาลูกค้าแบบเบา ๆ (จำนวนคน/วัน/สัตว์เลี้ยง/ห้องที่พูดถึง) — ไม่ใช้ AI
function extractSummary(history) {
  const all = (history || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
  const cust = (history || []).filter((m) => m.role === "user" && typeof m.content === "string" && m.content.indexOf("(ระบบ)") !== 0).map((m) => m.content).join(" ");
  const g = cust.match(/(\d+)\s*(?:ท่าน|คน)/);
  const guests = g ? g[1] + " ท่าน" : "";
  const d = cust.match(/\d{1,2}\s*[-–/]\s*\d{1,2}(?:\s*[-–/]\s*\d{2,4})?|วันที่\s*\d{1,2}|พรุ่งนี้|มะรืน|สุดสัปดาห์|เสาร์|อาทิตย์|\d{1,2}\s*ส\.?ค|\d{1,2}\s*ก\.?ค/);
  const date = d ? d[0].trim() : "";
  let pet = "";
  if (/ไม่มี(?:หมา|แมว|สัตว|น้อง)/.test(cust) || (/มีสัตว์เลี้ยงไหม|มีน้องหมา/.test(all) && /ไม่มี(?:ค่ะ|คับ|ครับ|ค่า)?$|ไม่มี /.test(cust))) pet = "ไม่มีสัตว์เลี้ยง";
  else if (/หมา|แมว|สัตว์เลี้ยง|เพ็ท|\bpet\b/i.test(cust)) pet = "มีสัตว์เลี้ยง";
  const rooms = [];
  [["Premier King", /premier\s*king|พรีเมียร์/i], ["Sky Riverview", /sky\s*riverview|วิวแม่น้ำ/i], ["Luxury Villa", /luxury|ลักซ/i], ["Pool Villa", /pool\s*villa|พูลวิลล่า/i], ["Premier Family", /family|แฟมิลี/i]].forEach(([n, re]) => { if (re.test(all)) rooms.push(n); });
  return { guests, date, pet, rooms: rooms.join(", ") };
}
// ลูกค้ารายนี้มี "แววจอง" ไหม (ไว้คัดเข้ากระดาน lead)
function hasBookingIntent(history) {
  const t = (history || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
  return /จอง|สนใจ|ห้องพัก|ราคา|ห้องว่าง|กี่คืน|เข้าพัก|\d+\s*(?:ท่าน|คน|คืน)/.test(t);
}
const imgProgress = new Map(); // userId -> { key: จำนวนที่ส่งไปแล้ว }
const seenEvents = new Set(); // webhookEventId ที่ประมวลผลแล้ว (กันตอบซ้ำจาก LINE redelivery)
// เก็บว่าข้อความแจ้งเตือนที่ส่งให้แอดมิน (messageId) = ของลูกค้าคนไหน → ตอนแอดมิน Reply จะได้รู้ว่าตอบให้ใคร
const alertMap = new Map(); // adminAlertMessageId -> { custId, name, type, question }
const MAX_TURNS = 20; // ความจำบทสนทนา 20 เทิร์น (40 ข้อความ) — บทสนทนาจองยาว ๆ ข้อมูลต้นแชทไม่หลุด (เดิม 10 สั้นไป ทำให้บอทถามซ้ำ)

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
  const extUrls = []; // รูปจาก URL ภายนอก (เช่นรูปเมนูจากระบบเฮีย)
  const text = replyText
    // [[IMG:key:more]] = ส่งรูปชุดถัดไป (4 รูป)
    .replace(/\[\[IMG:([a-z-]+):more\]{1,2}/gi, (_m, k) => {
      if (IMAGES[k]) files.push(...nextBatch(userId, k));
      return "";
    })
    // [[IMG:key]] = ส่งรูปปก 1 รูป
    .replace(/\[\[IMG:([a-z-]+)\]{1,2}/gi, (_m, k) => {
      if (IMAGES[k] && IMAGES[k][0]) files.push(IMAGES[k][0]);
      return "";
    })
    // [[MENUIMG:ชื่อเมนู]] = รูปเมนูจริงจาก API ระบบร้าน (สูงสุด 2)
    .replace(/\[\[MENUIMG:([^\]]+)\]{1,2}/gi, (_m, name) => {
      const u = findMenuImage(name);
      if (u && extUrls.length < 2) extUrls.push(u);
      return "";
    })
    // 🛡️ กันเหนียว: ลบมาร์กเกอร์ระบบทุกชนิด [[...]] ที่หลุดรอดมา ไม่ให้ลูกค้าเห็นเด็ดขาด
    // (เผื่อบอทเพี้ยน/รีสตาร์ต แล้ว [[ALERT:...]] หรือมาร์กเกอร์อื่นไม่ถูกลบต้นทาง)
    .replace(/\[\[[^\]]*\]{1,2}/g, "")
    .replace(/\[\[\s*(?:ALERT|IMG|MENUIMG)\b[^\]]*\]{0,2}/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const messages = [];
  if (text) messages.push({ type: "text", text });
  for (const f of files) {
    if (!PUBLIC_URL) break;
    const url = `${PUBLIC_URL}/images/${encodeURIComponent(f)}`;
    messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  for (const url of extUrls) {
    messages.push({ type: "image", originalContentUrl: url, previewImageUrl: url });
  }
  return messages.slice(0, 5); // LINE จำกัด 5 ข้อความต่อการตอบ 1 ครั้ง
}

// ---- ดึง URL รูปจากมาร์กเกอร์ [[IMG:...]] ในคำตอบ → ให้ /ask ส่ง images ไปให้ระบบเฮียส่งรูปเอง ----
//   (ระบบเฮียเอา url ในลิสต์ไปสร้าง LINE image message เอง · สูงสุด 4 รูป = ข้อความ+4รูป = ลิมิต LINE)
function extractImageUrls(userId, replyText) {
  const files = [];
  const extUrls = []; // รูปเมนูจริงจาก API ระบบร้าน ([[MENUIMG:ชื่อ]])
  (replyText || "")
    .replace(/\[\[IMG:([a-z-]+):more\]{1,2}/gi, (_m, k) => { if (IMAGES[k]) files.push(...nextBatch(userId, k)); return ""; })
    .replace(/\[\[IMG:([a-z-]+)\]{1,2}/gi, (_m, k) => { if (IMAGES[k] && IMAGES[k][0]) files.push(IMAGES[k][0]); return ""; })
    .replace(/\[\[MENUIMG:([^\]]+)\]{1,2}/gi, (_m, name) => { const u = findMenuImage(name); if (u && extUrls.length < 2) extUrls.push(u); return ""; });
  const fileUrls = PUBLIC_URL ? files.map((f) => `${PUBLIC_URL}/images/${encodeURIComponent(f)}`) : [];
  return [...fileUrls, ...extUrls].slice(0, 4);
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
    availability: "🏨 ลูกค้าถามห้องว่าง — รอทีมงานเช็ค",
    discount: "💸 ลูกค้าขอส่วนลด/ถามโปร — รอทีมงานพิจารณา",
  };
  const title = titles[type] || titles.help;
  let text = `${title}\n👤 ${name}\n${detail || ""}`.trim();
  // help/availability/discount = แอดมินตอบกลับได้ (relay): กด Reply ข้อความนี้ แล้วพิมพ์คำตอบ → น้องลีฟเอาไปบอกลูกค้าให้
  if (type === "help" || type === "availability" || type === "discount") {
    text += `\n\n💬 ตอบลูกค้า: กด Reply ข้อความนี้ แล้วพิมพ์คำตอบสั้น ๆ น้องลีฟจะเอาไปบอกลูกค้าให้เองค่ะ`;
  }
  return { type: "text", text: clip(text, 1500) };
}

// ปุ่ม "ขอคุยเอง" (แยกจากข้อความเตือน เพราะข้อความเตือนต้อง Reply ได้)
function handoverButton(custId, name) {
  return {
    type: "template",
    altText: `ขอคุยเองกับ ${name}`,
    template: {
      type: "buttons",
      text: clip(`หรือถ้าอยากคุยเองกับ ${name} กดปุ่มด้านล่างได้เลยค่ะ`, 160),
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
  const textMsg = alertMessage(custId, name, type, detail);
  const btnMsg = handoverButton(custId, name);
  for (const adminId of ADMIN_USER_IDS) {
    try {
      const res = await lineClient.pushMessage({ to: adminId, messages: [textMsg, btnMsg] });
      // เก็บ id ของ "ข้อความเตือน" (อันแรก) → ตอนแอดมิน Reply จะได้รู้ว่าตอบให้ลูกค้าคนไหน
      const mid = res && res.sentMessages && res.sentMessages[0] && res.sentMessages[0].id;
      if (mid) {
        alertMap.set(mid, { custId, name, type, question: (detail || "").trim() });
        if (alertMap.size > 500) alertMap.delete(alertMap.keys().next().value); // กันโตไม่จำกัด
      }
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

// ---- ลูกค้าส่ง "รูป" มา → น้องลีฟดูรูปออกจริง (Claude sonnet-5 อ่านรูปได้) แล้วคุยตามรูป ----
async function handleImageMessage(event) {
  const userId = event.source.userId || "unknown";
  if (ADMIN_USER_IDS.includes(userId)) return; // แอดมินส่งรูปเอง ไม่ต้องตอบ
  if (isPaused(userId)) return;                 // แอดมินคุยเองอยู่ → บอทเงียบ

  // 1) ดึงไฟล์รูปจาก LINE → base64 (ใหญ่เกิน ~4.5MB ใช้รูปพรีวิว กันเกินลิมิต AI)
  let b64 = "";
  try {
    const buf = await streamToBuffer(await lineBlobClient.getMessageContent(event.message.id));
    b64 = (buf.length > 4_500_000
      ? await streamToBuffer(await lineBlobClient.getMessageContentPreview(event.message.id))
      : buf
    ).toString("base64");
  } catch (e) {
    console.error("getMessageContent error:", e.message);
    await lineClient.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: "ขอโทษนะคะ 🙏 น้องลีฟเปิดดูรูปไม่สำเร็จ รบกวนพิมพ์บอกสั้น ๆ ได้ไหมคะว่าให้ช่วยเรื่องไหน เดี๋ยวดูแลให้เลยค่ะ 🌿" }] });
    return;
  }

  // 2) ประกอบ history + รูป ส่งเข้าสมองให้ "ดูรูป" (เก็บลง history เป็นข้อความ ไม่เก็บ base64 กันส่งซ้ำ/เปลือง token)
  let history = conversations.get(userId) || [];
  const callHistory = [
    ...history,
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: "(ลูกค้าส่งรูปนี้มาค่ะ) ช่วยดูรูปแล้วคุยกับลูกค้าต่อในบทบาทน้องลีฟตามปกติ — อธิบาย/ช่วยเหลือตามสิ่งที่เห็นในรูป ถ้าดูไม่ออกจริง ๆ ให้ถามลูกค้าสุภาพ ๆ ว่าต้องการให้ช่วยเรื่องอะไร" },
      ],
    },
  ];

  let extra = "";
  try { if (faqEnabled()) extra = faqText(await loadFaq()); } catch (e) { console.error("img loadFaq error:", e.message); }

  let replyText;
  try {
    replyText = await generateReply(callHistory, extra);
  } catch (e) {
    console.error("img generateReply error:", e.message);
    replyText = "";
  }

  const alerts = [];
  let messages;
  if (!replyText) {
    messages = [{ type: "text", text: "ขอโทษนะคะ 🙏 น้องลีฟดูรูปให้ไม่ทันนิดนึง เดี๋ยวทีมงานมาดูแลต่อให้นะคะ 😊" }];
    alerts.push({ type: "help", detail: "ลูกค้าส่งรูปมาแต่ AI ดูรูปไม่สำเร็จ — รบกวนทีมเปิดดูรูปในแชทและช่วยดูแลต่อค่ะ" });
  } else {
    replyText = replyText
      .replace(/\[\[ALERT:(booking|help|lead|availability|discount):([^\]]*)\]{1,2}/gi, (_m, type, detail) => {
        alerts.push({ type: type.toLowerCase(), detail: (detail || "").trim() });
        return "";
      })
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!replyText) replyText = "รับเรื่องแล้วค่ะ เดี๋ยวน้องลีฟดูแลให้นะคะ 😊";
    history.push({ role: "user", content: "(ลูกค้าส่งรูปมา 1 รูป)" });
    history.push({ role: "assistant", content: replyText });
    if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);
    conversations.set(userId, history);
    messages = buildMessages(userId, replyText);
    if (messages.length === 0) messages = [{ type: "text", text: replyText }];
  }

  await lineClient.replyMessage({ replyToken: event.replyToken, messages });
  if (alerts.length > 0) {
    const name = await getName(userId);
    for (const a of alerts) await pushAlert(userId, name, a.type, a.detail);
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

  // ---- โหมดคุยสอนแบบธรรมชาติ: แอดมินพิมพ์ "จำไว้นะว่า..." → น้องลีฟสกัด+จำเอง (ไม่ต้องใช้ #สอน / |) ----
  if (isAdmin && /จำ|อัปเดต|อัพเดต|บันทึก|ต่อไปนี้|ให้จำ|สอนน้องลีฟ|แก้ข้อมูล|เปลี่ยนเป็น/.test(trimmed)) {
    try {
      const t = await extractTeaching(trimmed);
      if (t.isTeach) {
        await teachFaq(t.question, t.answer);
        await replyText1(
          event.replyToken,
          `จำแล้วค่ะ ✅\nถาม: ${t.question}\nตอบ: ${t.answer}\n\nครั้งหน้าลูกค้าถามเรื่องนี้ น้องลีฟตอบเองได้เลยค่ะ 😊 (อยากแก้ พิมพ์บอกใหม่ได้เลย)`
        );
        return;
      }
    } catch (e) {
      console.error("natural teach error:", e.message);
    }
    // ถ้าไม่ใช่การสอน → ตกไปที่โฟลว์ปกติ (ตอบตามบุคลิก)
  }

  // ---- แอดมิน Reply (อ้างอิง) ข้อความแจ้งเตือน → น้องลีฟเอาคำตอบไปบอกลูกค้าให้ ----
  const quotedId = event.message.quotedMessageId;
  if (isAdmin && quotedId && alertMap.has(quotedId)) {
    const target = alertMap.get(quotedId);
    const adminAnswer = trimmed;
    // สร้างคำตอบให้ลูกค้าในสไตล์น้องลีฟ โดยใช้ข้อมูลที่แอดมินยืนยัน (ต่อจากบทสนทนาเดิมของลูกค้า)
    const custHistory = conversations.get(target.custId) || [];
    // สำคัญ: แนบคำสั่งเป็น "user turn" ต่อท้าย เพื่อบังคับให้ AI แต่งคำตอบใหม่ในสไตล์น้องลีฟ
    // (ถ้าส่ง custHistory เฉย ๆ มันจบด้วย assistant → AI ไม่แต่งใหม่ เลยหลุดคำดิบของแอดมิน)
    const relayHistory = [
      ...custHistory,
      {
        role: "user",
        content: `(ระบบ) ทีมงานเพิ่งยืนยันข้อมูลเรื่องที่ลูกค้าถามค้างไว้ว่า: "${adminAnswer}" — ช่วยเอาข้อมูลนี้ไปตอบลูกค้าต่อในสไตล์น้องลีฟเลยนะ (อบอุ่น เป็นกันเอง เป็นธรรมชาติ ห้ามบอกว่า "ทีมงานแจ้งมา" และห้ามพูดถึงข้อความระบบนี้) ถ้าเป็นข่าวดี/ห้องว่าง ให้ชวนจองหรือถามข้อมูลจองต่อแบบเนียน ๆ`,
      },
    ];
    let relayText = "";
    try {
      relayText = await generateReply(relayHistory, "");
    } catch (e) {
      console.error("relay generateReply error:", e.message);
      relayText = adminAnswer;
    }
    relayText = (relayText || adminAnswer).replace(/\[\[ALERT:[^\]]*\]{1,2}/gi, "").trim();
    try {
      const msgs = buildMessages(target.custId, relayText);
      await lineClient.pushMessage({
        to: target.custId,
        messages: msgs.length ? msgs : [{ type: "text", text: relayText }],
      });
      custHistory.push({ role: "assistant", content: relayText });
      conversations.set(target.custId, custHistory);
    } catch (e) {
      console.error("relay push error:", e.message);
      await replyText1(event.replyToken, `ส่งให้ลูกค้าไม่สำเร็จค่ะ 🙏 (${e.message})`);
      return;
    }
    // จำเฉพาะ "คำถามทั่วไป" — ห้องว่าง (เปลี่ยนตามวัน) + ส่วนลด/โปร (ให้เป็นรายคน) ห้ามจำ
    let note2 = "";
    const noRemember = target.type === "availability" || target.type === "discount";
    if (!noRemember && target.question) {
      try {
        await teachFaq(target.question, adminAnswer);
        note2 = "\n🧠 จำไว้แล้ว ครั้งหน้าน้องลีฟตอบเองได้ค่ะ";
      } catch (e) {
        console.error("relay teach error:", e.message);
      }
    } else if (target.type === "availability") {
      note2 = "\n(ไม่จำห้องว่าง เพราะเปลี่ยนตามวันค่ะ)";
    } else if (target.type === "discount") {
      note2 = "\n(ไม่จำส่วนลด/โปร เพราะให้เป็นรายคนค่ะ)";
    }
    alertMap.delete(quotedId);
    await replyText1(event.replyToken, `ส่งให้ ${target.name} แล้วค่ะ ✅${note2}`);
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

  // ---- Phase 3: ห้องว่าง/ราคา/โปรส่วนลด — ผ่านฟังก์ชันกลาง (ใช้ตัวเดียวกับ /ask) ----
  //  ล้มเหลว/วันไม่ชัด = เงียบ ๆ กลับไปโหมดเดิม (ขอเช็คทีม + เด้งเตือน) ลูกค้าไม่เจอ error
  try {
    extra += await buildAvailabilityExtra(history, userText);
  } catch (e) {
    console.error("avail extra error (webhook):", e.message);
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
      .replace(/\[\[ALERT:(booking|help|lead|availability|discount):([^\]]*)\]{1,2}/gi, (_m, type, detail) => {
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
  // Phase 3: ตรวจกุญแจห้องว่าง — บอกความยาว + หัว/ท้าย + ลองยิง API จริง (วินิจฉัย key หาย/เพี้ยนได้ทันที)
  const ak = AVAIL_API_KEY;
  const avail = { keyLen: ak.length, head: ak.slice(0, 4), tail: ak.slice(-4), probe: "no-key" };
  if (ak) {
    try {
      // ถ้าส่ง ?checkin=YYYY-MM-DD&checkout=... มา = ดู JSON ดิบจาก API ช่วงนั้น (วินิจฉัยโครงสร้างราคา/รายคืน)
      const ci = (req.query.checkin || "").trim() || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const co = (req.query.checkout || "").trim() || new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
      const raw = await fetchAvailability(ci, co);
      avail.probe = "ok";
      if (req.query.checkin) avail.raw = raw; // โชว์ JSON ดิบเฉพาะเมื่อระบุวันเอง (ล็อกด้วยกุญแจอยู่แล้ว)
    } catch (e) {
      avail.probe = "error: " + (e && e.message ? e.message : String(e));
    }
  }
  // วินิจฉัยแจ้งเตือนกลุ่ม: บอกว่าตั้ง token/group ไหม + ถ้า ?testgroup=1 ลองยิงเข้ากลุ่มจริงแล้วบอกผล/error
  const alertCfg = {
    pushTokenLen: ALERT_PUSH_TOKEN.length,
    pushTokenHead: ALERT_PUSH_TOKEN.slice(0, 4),
    groupId: ALERT_GROUP_ID ? ALERT_GROUP_ID.slice(0, 6) + "…" + ALERT_GROUP_ID.slice(-4) : "(ไม่ตั้ง)",
    clientReady: !!alertClient,
    push: "not-tested",
  };
  if (req.query.testgroup === "1") {
    if (!alertClient) alertCfg.push = "no-token (ALERT_PUSH_TOKEN ไม่ได้ตั้ง)";
    else {
      // เช็คว่า token นี้เป็นของ OA ไหน (ต้องเป็น @villadeleaf ที่อยู่ในกลุ่ม)
      try {
        const info = await alertClient.getBotInfo();
        alertCfg.tokenOA = { name: info.displayName, basicId: info.basicId, userId: (info.userId || "").slice(0, 8) + "…" };
      } catch (e) {
        alertCfg.tokenOA = "getBotInfo error: " + (e && (e.status || e.statusCode) ? (e.status || e.statusCode) + " " + (typeof e.body === "string" ? e.body : JSON.stringify(e.body || "")) : e.message || String(e));
      }
      // เช็คว่าบอทเข้าถึงกลุ่มนี้ได้ไหม (ใช้ ?gid= ทดสอบ groupId อื่นได้ ไม่ต้องแก้ env)
      const gid = (req.query.gid || ALERT_GROUP_ID || "").trim();
      alertCfg.testGid = gid ? gid.slice(0, 6) + "…" + gid.slice(-4) : "(none)";
      if (gid) {
        try {
          const gs = await alertClient.getGroupSummary(gid);
          alertCfg.group = { name: gs.groupName || "(ok)" };
        } catch (e) {
          const st = e && (e.status || e.statusCode);
          const body = e && (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {}));
          alertCfg.group = `เข้าถึงกลุ่มไม่ได้ ${st || ""}: ${body || (e && e.message) || String(e)}`.slice(0, 300);
        }
      }
      // เช็คโควตา push ของ OA (ฟรี ~500/เดือน) — ถ้าใช้หมดจะ push ไม่ได้
      try {
        const q = await alertClient.getMessageQuota();
        const c = await alertClient.getMessageQuotaConsumption();
        alertCfg.quota = { type: q.type, limit: q.value, used: c.totalUsage };
      } catch (e) {
        alertCfg.quota = "quota check error: " + (e && e.message ? e.message : String(e));
      }
      if (gid) {
        try {
          await alertClient.pushMessage({ to: gid, messages: [{ type: "text", text: "🔔 ทดสอบแจ้งเตือนเข้ากลุ่มจากน้องลีฟค่ะ (ข้อความทดสอบ)" }] });
          alertCfg.push = "ok ✅ ส่งเข้ากลุ่มสำเร็จ";
        } catch (e) {
          const st = e && (e.status || e.statusCode);
          const body = e && (typeof e.body === "string" ? e.body : JSON.stringify(e.body || {}));
          alertCfg.push = `error ${st || ""}: ${body || (e && e.message) || String(e)}`.slice(0, 600);
        }
      }
    }
  }
  res.json({
    version: "v7-sales",
    keyCleanLen: clean.length,
    adminCount: ADMIN_USER_IDS.length,
    faq,
    avail,
    alertCfg,
    lastGroupSeen,
    recentAsk: recentAsk.slice(-15),
  });
});

// ============ หน้าเว็บ "ห้องน้องลีฟ" (/leaf dashboard) ============
//  แอดมินใช้จัดการน้องลีฟเอง: ทดลองคุย · สอน FAQ · ดูสถานะ · พักบอท
//  ล็อกด้วยรหัส DASH_PASS (env) — ค่าเริ่มต้น 1234 (แนะนำตั้ง env ใหม่ทีหลัง)
const DASH_PASS = (process.env.DASH_PASS || "1234").trim();
function dashAuth(req, res, next) {
  const k = req.headers["x-leaf-key"] || req.query.key || "";
  if (k !== DASH_PASS) return res.status(401).json({ error: "unauthorized" });
  next();
}
app.get("/leaf", (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/leaf/api/ping", dashAuth, (_req, res) => res.json({ ok: true }));

app.get("/leaf/api/faq", dashAuth, async (_req, res) => {
  try { const items = faqEnabled() ? await loadFaq() : []; res.json({ items }); }
  catch (e) { res.status(200).json({ items: [], error: e.message }); }
});
app.post("/leaf/api/faq", dashAuth, express.json({ limit: "64kb" }), async (req, res) => {
  const q = String((req.body && req.body.q) || "").trim();
  const a = String((req.body && req.body.a) || "").trim();
  if (!q || !a) return res.status(400).json({ ok: false, error: "ใส่คำถามและคำตอบ" });
  try { await teachFaq(q, a); res.json({ ok: true }); }
  catch (e) { res.status(200).json({ ok: false, error: e.message }); }
});
app.post("/leaf/api/test", dashAuth, express.json({ limit: "64kb" }), async (req, res) => {
  const message = String((req.body && req.body.message) || "").trim();
  if (!message) return res.status(400).json({ reply: "" });
  try {
    const history = [{ role: "user", content: message }];
    let extra = "";
    try { if (faqEnabled()) extra = faqText(await loadFaq()); } catch (_e) {}
    try { extra += await buildAvailabilityExtra(history, message); } catch (_e) {}
    let reply = await generateReply(history, extra);
    reply = (reply || "").replace(/\[\[[^\]]*\]{1,2}/g, "").replace(/\[\[\s*(?:ALERT|IMG|MENUIMG)\b[^\]]*\]{0,2}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    res.json({ reply });
  } catch (e) { res.status(200).json({ reply: "", error: e.message }); }
});
app.get("/leaf/api/status", dashAuth, async (_req, res) => {
  let faqCount = null;
  try { if (faqEnabled()) faqCount = (await loadFaq()).length; } catch (_e) {}
  res.json({ online: true, paused: botPaused, faqCount, recentAsk: recentAsk.slice(-15), uptimeMin: Math.round((Date.now() - bootAt) / 60000) });
});
app.post("/leaf/api/pause", dashAuth, express.json({ limit: "8kb" }), (req, res) => {
  botPaused = !!(req.body && req.body.on);
  console.log("dashboard: botPaused =", botPaused);
  res.json({ paused: botPaused });
});
// ห้องแชท: รายชื่อบทสนทนาลูกค้า (สดจาก chatMeta) + อ่านบทสนทนารายคน (จาก conversations)
app.get("/leaf/api/chats", dashAuth, (_req, res) => {
  const list = [];
  chatMeta.forEach((v, k) => list.push({ userId: k, name: v.name || "", pictureUrl: v.pictureUrl || "", at: v.at || "", lastMsg: v.lastMsg || "", needsHuman: !!v.needsHuman }));
  list.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  res.json({ chats: list.slice(0, 50) });
});
app.get("/leaf/api/chat", dashAuth, (req, res) => {
  const uid = String(req.query.userId || "");
  const h = conversations.get(uid) || [];
  const meta = chatMeta.get(uid) || {};
  const messages = h
    .filter((m) => typeof m.content === "string" && m.content.indexOf("(ระบบ)") !== 0)
    .map((m) => ({ from: m.role === "assistant" ? "bot" : "cust", text: m.content }));
  res.json({ name: meta.name || "", pictureUrl: meta.pictureUrl || "", needsHuman: !!meta.needsHuman, summary: extractSummary(h), messages });
});
// กระดาน lead: ลูกค้าที่มีแววจอง (สนใจแต่ยังไม่ปิด) พร้อมสรุปข้อมูล
app.get("/leaf/api/leads", dashAuth, (_req, res) => {
  const leads = [];
  chatMeta.forEach((v, k) => {
    const h = conversations.get(k) || [];
    if (!hasBookingIntent(h)) return;
    leads.push({ userId: k, name: v.name || "", pictureUrl: v.pictureUrl || "", at: v.at || "", lastMsg: v.lastMsg || "", needsHuman: !!v.needsHuman, summary: extractSummary(h) });
  });
  leads.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  res.json({ leads });
});
// ---- ช่องให้ระบบหัวหน้าเรียกใช้น้องลีฟ (แบบ B): ส่งข้อความลูกค้ามา → คืนคำตอบน้องลีฟ ----
//  ระบบหัวหน้ายิง POST /ask {userId, message, name} พร้อม header x-nong-secret → ได้ {reply}
//  น้องลีฟจำบทสนทนาต่อเนื่องด้วย userId (ใช้ conversations Map เดียวกับ LINE)
const ASK_SECRET = (process.env.ASK_SECRET || "").trim();
app.post("/ask", express.json({ limit: "256kb" }), async (req, res) => {
  if (!ASK_SECRET || (req.headers["x-nong-secret"] || "") !== ASK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { userId, message, fromAdmin } = req.body || {};
  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message required" });
  }

  // 🕵️ ดักจับ: บันทึกว่า /ask ถูกเรียก (ดูผ่าน /selftest ว่า FB/LINE ยิงเข้า /ask จริงไหม)
  const _t0 = Date.now();
  const askRec = {
    at: new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(11, 19),
    userId: String(userId).slice(0, 14),
    name: String(req.body.name || "").slice(0, 24),
    msg: String(message).slice(0, 30),
    fromAdmin: !!fromAdmin,
    bodyKeys: Object.keys(req.body || {}).join(","),
    result: "(processing…)",
  };
  recentAsk.push(askRec);
  if (recentAsk.length > 20) recentAsk.shift();

  // แอดมินพักน้องลีฟทั้งระบบจากหน้า /leaf → คืน reply ว่าง (ระบบเฮียไม่ส่ง = บอทเงียบ ทีมตอบเอง)
  if (botPaused && !fromAdmin && !req.body.test) {
    askRec.result = "⏸️ พักบอท (แอดมินปิดจาก /leaf)";
    askRec.ms = Date.now() - _t0;
    return res.status(200).json({ reply: "", needsHuman: true, type: "help", detail: "น้องลีฟถูกพักชั่วคราวโดยแอดมิน", paused: true });
  }

  // ---- โหมดทีมงานตอบ (relay): ทีมพิมพ์คำตอบในระบบเฮีย → น้องลีฟเรียบเรียงเป็นภาษาตัวเอง → ส่งกลับให้ระบบเฮียส่งลูกค้า ----
  //   ระบบเฮียยิง { fromAdmin:true, userId:<ไอดีลูกค้า>, message:<คำตอบดิบของทีม> } → ได้ { reply } กลับไปส่งลูกค้าจริง
  if (fromAdmin) {
    // ---- พิมพ์ "#สอน คำถาม | คำตอบ" ในกล่องเขียวได้เลย → สอนน้องลีฟตรง ๆ (ไม่ส่งหาลูกค้า) ----
    //   ตอบกลับมี taught:true → ระบบเฮียโชว์ note ให้ทีม และ "ห้ามส่งข้อความนี้หาลูกค้า"
    const fromAdminMsg = String(message).trim();

    // ---- กล่องสอนน้องลีฟ (โหมดคุยธรรมชาติ): ระบบเฮียส่ง { fromAdmin:true, teach:true, message:"<คุยธรรมดา>" } ----
    //   น้องลีฟสกัดเป็นคำถาม/คำตอบเอง (ไม่ต้องมี #สอน หรือ |) แล้วจำลง Google Sheet เดิม
    if (req.body.teach === true) {
      let q = "", a = "";
      try {
        if (fromAdminMsg.startsWith("#สอน") && fromAdminMsg.includes("|")) {
          const body = fromAdminMsg.replace(/^#สอน\s*/, "");
          const idx = body.indexOf("|");
          q = body.slice(0, idx).trim();
          a = body.slice(idx + 1).trim();
        } else {
          const t = await extractTeaching(fromAdminMsg);
          if (t.isTeach) { q = t.question; a = t.answer; }
        }
        if (q && a) {
          await teachFaq(q, a);
          return res.status(200).json({ reply: "", taught: true, note: `จำแล้วค่ะ ✅\nถาม: ${q}\nตอบ: ${a}` });
        }
        return res.status(200).json({ reply: "", taught: false, note: 'ยังไม่แน่ใจว่าจะให้จำอะไรค่ะ ลองพิมพ์ใหม่ เช่น "ที่จอดรถมี 20 คัน จอดฟรี"' });
      } catch (e) {
        console.error("teach box error:", e.message);
        return res.status(200).json({ reply: "", taught: false, note: `บันทึกไม่สำเร็จค่ะ 🙏 (${e.message})` });
      }
    }

    if (fromAdminMsg.startsWith("#สอน")) {
      const body = fromAdminMsg.replace(/^#สอน\s*/, "");
      const idx = body.indexOf("|");
      if (idx === -1) {
        return res.status(200).json({ reply: "", taught: false, note: "พิมพ์แบบนี้นะคะ:\n#สอน คำถาม | คำตอบ" });
      }
      const q = body.slice(0, idx).trim();
      const a = body.slice(idx + 1).trim();
      if (!q || !a) {
        return res.status(200).json({ reply: "", taught: false, note: "ใส่ทั้งคำถามและคำตอบด้วยนะคะ 🙏\n#สอน คำถาม | คำตอบ" });
      }
      try {
        await teachFaq(q, a);
        return res.status(200).json({ reply: "", taught: true, note: `จำแล้วค่ะ ✅\nถาม: ${q}\nตอบ: ${a}\n\nครั้งหน้าลูกค้าถามเรื่องนี้ น้องลีฟตอบเองได้เลยค่ะ 😊` });
      } catch (e) {
        console.error("ask fromAdmin teach error:", e.message);
        return res.status(200).json({ reply: "", taught: false, note: `บันทึกไม่สำเร็จค่ะ 🙏 (${e.message})` });
      }
    }

    const custHistory = conversations.get(userId) || [];
    const relayHistory = [
      ...custHistory,
      {
        role: "user",
        content: `(ระบบ) ทีมงานเพิ่งยืนยันข้อมูลเรื่องที่ลูกค้าถามค้างไว้ว่า: "${String(message)}" — ช่วยเอาข้อมูลนี้ไปตอบลูกค้าต่อในสไตล์น้องลีฟเลยนะ (อบอุ่น เป็นกันเอง เป็นธรรมชาติ ห้ามบอกว่า "ทีมงานแจ้งมา" และห้ามพูดถึงข้อความระบบนี้ ห้ามแต่งข้อมูล/ตัวเลขเพิ่มเอง) ถ้าเป็นข่าวดี/ห้องว่าง ให้ชวนจองหรือถามข้อมูลจองต่อแบบเนียน ๆ`,
      },
    ];
    let relayText;
    try {
      relayText = await generateReply(relayHistory, "");
    } catch (e) {
      console.error("ask fromAdmin error:", e.message);
      return res.status(200).json({ reply: "" }); // ระบบเฮีย fallback: ส่งคำตอบดิบของทีมเอง
    }
    const relayClean = (relayText || "").replace(/\[\[[^\]]*\]{1,2}/g, "").replace(/\[\[\s*(?:ALERT|IMG|MENUIMG)\b[^\]]*\]{0,2}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
    if (relayClean) {
      custHistory.push({ role: "assistant", content: relayClean });
      conversations.set(userId, custHistory);
    }
    // จำอัตโนมัติ (เหมือน relay เก่า): จำ "คำถามทั่วไป" ลง Google Sheet เดิม — ไม่จำห้องว่าง/ส่วนลด (เปลี่ยนตามวัน/รายคน)
    //   ระบบเฮียส่ง type + question (ที่ได้จากตอน needsHuman) มาด้วย น้องลีฟจะได้รู้ว่าอันไหนควรจำ
    let remembered = false;
    const askType = String(req.body.type || "").toLowerCase();
    const askQuestion = String(req.body.question || "").trim();
    const noRemember = askType === "availability" || askType === "discount";
    if (!noRemember && askQuestion) {
      try {
        await teachFaq(askQuestion, String(message));
        remembered = true;
      } catch (e) {
        console.error("ask fromAdmin teach error:", e.message);
      }
    }
    const relayImages = extractImageUrls(userId, relayText);
    return res.json({ reply: relayClean, remembered, images: relayImages });
  }

  let history = conversations.get(userId) || [];
  history.push({ role: "user", content: String(message) });
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);

  let extra = "";
  try {
    if (faqEnabled()) extra = faqText(await loadFaq());
  } catch (e) {
    console.error("ask loadFaq error:", e.message);
  }

  // ---- Phase 3: ห้องว่าง/ราคา/โปรส่วนลด — ผ่านฟังก์ชันกลาง (ใช้ตัวเดียวกับ /webhook) ----
  //  พลาด/ล่ม/วันไม่ชัด = เงียบ ๆ กลับไปโหมดเดิม (ขอเช็คทีม + เด้งกล่องเขียว) ลูกค้าไม่เจอ error
  try {
    extra += await buildAvailabilityExtra(history, message);
  } catch (e) {
    console.error("avail extra error:", e.message);
  }

  let replyText;
  try {
    replyText = await generateReply(history, extra);
  } catch (e) {
    console.error("ask error:", e.message);
    askRec.result = "❌ ERROR: " + (e && e.message ? e.message : String(e));
    askRec.ms = Date.now() - _t0;
    // AI ขัดข้อง → บอกระบบเฮียให้เด้งกล่องเขียว (needsHuman) + fallback เป็นคนตอบ
    return res.status(200).json({ reply: "", needsHuman: true, type: "help", detail: req.body.test ? "AI error: " + (e && e.message ? e.message : String(e)) : "ระบบ AI ขัดข้องชั่วคราว รบกวนทีมงานเข้าไปดูแลลูกค้าต่อค่ะ" });
  }

  // ถ้าน้องลีฟเจอเคสที่ต้องให้คนดู (จอง/ห้องว่าง/ส่วนลด/ตอบไม่ได้):
  //   (1) ส่ง needsHuman + type กลับ → ระบบเฮียเด้งเคสนี้ขึ้น "กล่องเขียวแชทน้องลีฟ"
  //   (2) เด้งเข้า LINE ส่วนตัวแอดมินด้วย (ตัวสำรอง ระหว่างที่ระบบเฮียยังต่อกล่องเขียวไม่เสร็จ)
  let needsHuman = false;
  let alertType = null;
  let alertDetail = "";
  try {
    const m = (replyText || "").match(/\[\[ALERT:(booking|help|availability|discount|note):([^\]]*)\]{1,2}/i);
    if (m) {
      alertType = m[1].toLowerCase();
      alertDetail = (m[2] || "").trim();
      needsHuman = alertType !== "note"; // note = แจ้งกลุ่มเฉย ๆ ไม่เด้งกล่องเขียว (น้องลีฟตอบลูกค้าเต็มแล้ว ทีมแค่รับรู้เพื่ออัปเดตบิล)
      // โหมดทดสอบ (test:true) → ไม่เด้งเตือน (ทดสอบเงียบ ๆ) แต่ยังส่ง needsHuman กลับให้ดู
      if (!req.body.test) {
        const titles = {
          booking: "🔔 ลูกค้าสนใจจอง",
          help: "⚠️ ลูกค้าถามอะไรที่น้องลีฟตอบไม่ได้",
          availability: "🏨 ลูกค้าถามห้องว่าง",
          discount: "💸 ลูกค้าขอส่วนลด/โปร",
          note: "🔔 อัปเดตการจอง (แจ้งให้ทราบ)",
        };
        const custName = String(req.body.name || "ลูกค้า").trim();
        const title = titles[alertType] || titles.help;
        // (1) เด้งเข้า "กลุ่มไลน์ทีม" (ผ่าน token OA จริงที่อยู่ในกลุ่ม) — ตัวหลัก
        //   booking = สรุปการจองพร้อมก๊อป + เลขบัญชี (แอดมินก๊อปส่งลูกค้าเอง · น้องลีฟไม่ส่งให้ลูกค้า)
        const bankBlock = "🏦 ธนาคารกสิกรไทย\nเลขบัญชี 230-1-67564-2\nชื่อบัญชี บจก. วิลลาเดอลีฟ";
        const groupText = (alertType === "booking"
          ? `📋 สรุปการจอง (ก๊อปส่งลูกค้าได้เลยค่ะ)\n\n${alertDetail.replace(/\s*\/\s*/g, "\n")}\n\n${bankBlock}\n\nเมื่อโอนแล้วรบกวนส่งสลิปกลับมานะคะ\n⚠️ น้องลีฟยังไม่ได้ส่งให้ลูกค้า — แอดมินก๊อปส่งเองค่ะ`
          : alertType === "note"
          ? `${title}\n👤 ${custName}\n${alertDetail}\n\n✅ น้องลีฟตอบลูกค้าให้แล้ว — แจ้งเพื่ออัปเดตข้อมูล/บิลตอนเช็คเอาท์เท่านั้น ไม่ต้องตอบลูกค้าค่ะ`
          : `${title}\n👤 ${custName}\n${alertDetail}\n\n💬 เปิดแชทลูกค้าใน LINE OA แล้วพิมพ์ตอบได้เลยค่ะ`
        ).slice(0, 1900);
        if (alertClient && ALERT_GROUP_ID) {
          alertClient
            .pushMessage({ to: ALERT_GROUP_ID, messages: [{ type: "text", text: groupText }] })
            .catch((e) => console.error("group alert push:", e.message));
        }
        // (2) สำรอง: เด้งเข้าแชทแอดมิน (OA เดิม) — เฉพาะตอน "ยังไม่ได้ตั้งกลุ่ม" เท่านั้น
        //     ถ้าตั้งกลุ่มแล้ว (alertClient+ALERT_GROUP_ID) จะเด้งแค่กลุ่มอย่างเดียว กันแจ้งซ้ำ
        const groupActive = !!(alertClient && ALERT_GROUP_ID);
        if (!groupActive && ADMIN_USER_IDS.length) {
          const alertText = `${title}\n👤 ${custName}\n${alertDetail}\n\n👉 เข้าไปตอบลูกค้าในระบบได้เลยนะคะ`.slice(0, 1500);
          for (const admin of ADMIN_USER_IDS) {
            lineClient
              .pushMessage({ to: admin, messages: [{ type: "text", text: alertText }] })
              .catch((e) => console.error("ask alert push:", e.message));
          }
        }
      }
    }
  } catch (e) {
    console.error("ask alert error:", e.message);
  }

  // ตอบกลับเป็นข้อความล้วน — ลบมาร์กเกอร์ระบบทุกชนิด [[...]] ออก (ลูกค้าไม่เห็น)
  const clean = (replyText || "").replace(/\[\[[^\]]*\]{1,2}/g, "").replace(/\[\[\s*(?:ALERT|IMG|MENUIMG)\b[^\]]*\]{0,2}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean) {
    history.push({ role: "assistant", content: clean });
    conversations.set(userId, history);
  }
  //  images → รูปที่น้องลีฟอยากส่ง (ระบบเฮียเอา url ไปส่งเป็น LINE image message)
  const images = extractImageUrls(userId, replyText);
  //  needsHuman=true + type → บอกระบบเฮียให้เด้งเคสนี้ขึ้นกล่องเขียวให้ทีมเข้ามาช่วย
  askRec.result = "✅ ตอบ " + clean.length + " ตัวอักษร" + (needsHuman ? " +needsHuman(" + alertType + ")" : "") + (images && images.length ? " +" + images.length + "รูป" : "");
  askRec.ms = Date.now() - _t0;
  const _b = req.body || {};
  const _pic = _b.pictureUrl || _b.picture || _b.pictureURL || _b.picUrl || _b.avatar || _b.photo || _b.image || _b.profileImage || _b.img || _b.avatarUrl || "";
  chatMeta.set(userId, { name: String(_b.name || "").slice(0, 40), pictureUrl: String(_pic).slice(0, 400), at: askRec.at, lastMsg: String(message).slice(0, 60), needsHuman: needsHuman });
  res.json({ reply: clean, needsHuman, type: alertType, detail: alertDetail, images });
});

// ---- น้องลีฟเวอร์ชันเบาสำหรับ Facebook/Instagram: ตอบสั้น + ลากเข้า LINE ----
//  ยิง POST /ask-fb {userId, message} + header x-nong-secret → ได้ {reply} (สั้น + ชวนแอดไลน์)
app.post("/ask-fb", express.json({ limit: "256kb" }), async (req, res) => {
  if (!ASK_SECRET || (req.headers["x-nong-secret"] || "") !== ASK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { userId, message } = req.body || {};
  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message required" });
  }
  const key = "fb:" + userId; // แยก namespace กัน FB ชนกับ LINE
  let history = conversations.get(key) || [];
  history.push({ role: "user", content: String(message) });
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS * 2);

  let replyText;
  try {
    replyText = await generateFbReply(history);
  } catch (e) {
    console.error("ask-fb error:", e.message);
    return res.status(200).json({ reply: "" }); // ให้ระบบต้นทาง fallback เป็นคน
  }
  const clean = (replyText || "").replace(/\[\[[^\]]*\]{1,2}/g, "").replace(/\[\[\s*(?:ALERT|IMG|MENUIMG)\b[^\]]*\]{0,2}/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean) {
    history.push({ role: "assistant", content: clean });
    conversations.set(key, history);
  }
  res.json({ reply: clean });
});

// ---- ส่งสำเนา event ต่อเข้าระบบหัวหน้า (เปิดใช้เมื่อใส่ LINE_FORWARD_URL เท่านั้น) ----
//  ส่ง raw body + ลายเซ็นเดิม → ระบบหัวหน้าตรวจลายเซ็นด้วย channel secret ตัวเดียวกันได้เลย
//  ทำแบบ fire-and-forget (ไม่รอผล) เพื่อไม่ให้กระทบความเร็วการตอบลูกค้า
const FORWARD_URL = (process.env.LINE_FORWARD_URL || "").trim();
function forwardToBackend(rawBody, signature) {
  if (!FORWARD_URL) return; // ปิดไว้ถ้ายังไม่ได้ตั้งค่า
  fetch(FORWARD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": signature || "" },
    body: rawBody,
  }).catch((e) => console.error("forward error:", e.message));
}

app.post("/webhook", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-line-signature"];
  const rawBody = req.body; // Buffer (จาก express.raw)
  // ตรวจลายเซ็น LINE เอง (แทน line.middleware) เพื่อเก็บ rawBody ไว้ส่งต่อระบบหัวหน้าได้
  if (!signature || !Buffer.isBuffer(rawBody) || !line.validateSignature(rawBody, LINE_CHANNEL_SECRET, signature)) {
    return res.status(401).end();
  }
  res.status(200).end(); // ตอบ LINE เร็ว ๆ ก่อน

  forwardToBackend(rawBody, signature); // ส่งสำเนาต่อให้ระบบหัวหน้า (ถ้าตั้งค่าไว้)

  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch (e) {
    console.error("webhook parse error:", e.message);
    return;
  }
  const events = parsed.events || [];
  (async () => {
    for (const event of events) {
      // กัน event ซ้ำ: LINE อาจส่ง webhook เดิมซ้ำ (redelivery/retry ตอน Render ตื่นจากหลับ)
      // ถ้าไม่กัน บอทจะตอบคำถามเดียวกันซ้ำ 2-3 รอบ
      const eid = event.webhookEventId;
      if (eid) {
        if (seenEvents.has(eid)) continue; // เคยเจอ event นี้แล้ว → ข้าม
        seenEvents.add(eid);
        if (seenEvents.size > 2000) seenEvents.clear(); // กันหน่วยความจำโตไม่จำกัด
      }
      // จับ Group ID จริงจาก event (ไว้ดึงผ่าน /selftest เพื่อหา ALERT_GROUP_ID ที่ถูกต้อง)
      if (event.source && (event.source.groupId || event.source.roomId)) {
        lastGroupSeen = { id: event.source.groupId || event.source.roomId, kind: event.source.groupId ? "group" : "room", type: event.type, at: new Date().toISOString() };
        console.log("group/room event seen:", JSON.stringify(lastGroupSeen));
      }
      try {
        if (event.type === "message" && event.message.type === "text") {
          await handleTextMessage(event);
        } else if (event.type === "message" && event.message.type === "image") {
          await handleImageMessage(event); // ลูกค้าส่งรูป → ตอบ + แจ้งทีม (ไม่ปล่อยเงียบ)
        } else if (event.type === "postback") {
          await handlePostback(event); // ปุ่มขอคุยเอง / ให้บอทต่อ
        } else if (event.type === "follow") {
          await handleFollow(event); // ลูกค้าแอดบอทใหม่ → ทักทายต้อนรับ
        }
      } catch (err) {
        console.error("Handle error:", err);
      }
    }
  })();
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Bot listening on port ${port}`));

// ---- Keep-alive: ping ตัวเองทุก ~10 นาที กัน Render free "หลับ" ตอนไม่มีคนใช้ ----
//  (Render free spin-down เมื่อไม่มี inbound request ~15 นาที → ข้อความแรกหลังหลับช้า/หาย)
//  คนใช้เยอะจริงค่อยอัปเกรด Render เป็น paid (ไม่หลับเลย) แล้วเอาบล็อกนี้ออกก็ได้
// ใช้ PUBLIC_URL ถ้าตั้งไว้ ไม่งั้น fallback เป็น URL จริงบน Render
// → กันหลับได้ "เสมอ" ไม่ต้องพึ่ง env var / ไม่ต้องพึ่งใครมาตั้งค่า
const SELF_URL = PUBLIC_URL || "https://line-bot-p2ne.onrender.com";
const KEEPALIVE_MS = 10 * 60 * 1000; // 10 นาที (ก่อน 15 นาทีที่จะหลับ)
setInterval(() => {
  fetch(SELF_URL, { method: "GET" }).catch(() => {});
}, KEEPALIVE_MS);
console.log(`keep-alive: ping ${SELF_URL} ทุก ${KEEPALIVE_MS / 60000} นาที (เปิดตลอด)`);

# 🤖 บอท LINE ตอบลูกค้าด้วย Claude AI

บอทตอบลูกค้าอัตโนมัติบน LINE — ขายห้องพัก / ขายอาหาร / ให้ข้อมูล 24 ชม.
**ไม่ต้องมีความรู้เขียนโค้ด** ทำตามทีละขั้นด้านล่างได้เลย

---

## 🧾 ต้องเตรียมอะไรบ้าง
1. บัญชี **Claude** (ฟรีในการสมัคร) → https://console.anthropic.com
2. บัญชี **LINE Developers** (ใช้ LINE OA ที่มีอยู่) → https://developers.line.biz
3. บัญชี **Render** (ที่รันบอทฟรี) → https://render.com
4. บัญชี **GitHub** (เก็บโค้ด ฟรี) → https://github.com

---

## ✏️ ขั้นที่ 0 — ใส่ข้อมูลร้านของคุณ
เปิดไฟล์ `data/knowledge.md` แล้วแก้ให้เป็นข้อมูลจริง (ห้องพัก ราคา เมนู เวลาเปิด-ปิด เบอร์)
พิมพ์เป็นภาษาคนธรรมดาได้เลย ยิ่งใส่ละเอียด บอทยิ่งตอบเก่ง

---

## 🔑 ขั้นที่ 1 — เอากุญแจ Claude
1. เข้า https://console.anthropic.com → สมัคร/เข้าสู่ระบบ
2. เติมเครดิตขั้นต่ำ (เช่น $5) ที่เมนู **Billing**
3. ไปที่ **API Keys** → **Create Key** → คัดลอกกุญแจ (ขึ้นต้น `sk-ant-...`) เก็บไว้

---

## 🔑 ขั้นที่ 2 — เอากุญแจ LINE
1. เข้า https://developers.line.biz → เข้าด้วยบัญชี LINE
2. เลือก **Provider** → เลือก LINE OA ของคุณ → แท็บ **Messaging API**
3. คัดลอกไว้ 2 ค่า:
   - **Channel secret**
   - **Channel access token** (กด Issue ถ้ายังไม่มี)
4. เลื่อนลงล่าง เปิดใช้งาน **Use webhook** = เปิด
   และปิด **Auto-reply messages / Greeting** (ไม่งั้นจะตอบชนกับบอท)

---

## ☁️ ขั้นที่ 3 — เอาโค้ดขึ้น GitHub
> ถ้ายังไม่เคยใช้ Git บอกผม (Claude) ได้ ผมพาทำทีละคำสั่ง
1. สร้าง repository ใหม่บน GitHub (ตั้ง Private ได้)
2. อัปโหลดโฟลเดอร์ `line-bot` นี้ขึ้นไป

---

## 🚀 ขั้นที่ 4 — Deploy บน Render (ฟรี)
1. เข้า https://render.com → **New +** → **Web Service**
2. เชื่อม GitHub แล้วเลือก repo ที่เพิ่งอัปไป
3. ตั้งค่า:
   - **Root Directory:** `line-bot`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. ไปที่ **Environment** ใส่ 3 ค่านี้ (จากขั้น 1 และ 2):
   - `ANTHROPIC_API_KEY`
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
5. กด **Create Web Service** → รอสักครู่จนขึ้นสถานะ **Live**
6. คัดลอก URL ของบริการ (เช่น `https://your-bot.onrender.com`)

---

## 🔗 ขั้นที่ 5 — ต่อ Webhook เข้า LINE
1. กลับไปหน้า **Messaging API** ใน LINE Developers
2. ช่อง **Webhook URL** ใส่: `https://your-bot.onrender.com/webhook`
   (URL จากขั้น 4 + `/webhook` ต่อท้าย)
3. กด **Verify** → ควรขึ้น Success ✅
4. เปิด **Use webhook** ให้เป็นเปิด

---

## 🎉 เสร็จแล้ว!
ทักไปที่ LINE OA ของคุณ — บอทจะตอบให้ทันที
อยากแก้คำตอบ/เพิ่มเมนู → แก้ไฟล์ `data/knowledge.md` แล้ว push ขึ้น GitHub ใหม่ (Render จะอัปเดตให้เอง)

---

## 🧪 (ทางเลือก) ทดสอบในเครื่องก่อน
```bash
cd line-bot
npm install
cp .env.example .env   # แล้วเปิด .env ใส่กุญแจจริง
npm start
```
เปิดเบราว์เซอร์ที่ http://localhost:3000 ควรเห็นข้อความ "running ✅"
(การต่อ LINE จริงต้องมี URL สาธารณะ จึงแนะนำให้ deploy บน Render ตามขั้น 4)

---

## ❓ ติดปัญหาตรงไหน
บอก Claude ได้เลยว่าติดขั้นไหน ขึ้น error อะไร — จะช่วยแก้ทีละขั้นให้ครับ

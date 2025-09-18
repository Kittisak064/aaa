import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";
import creds from "./config/google-service-account.json" assert { type: "json" };

// ================== LINE CONFIG ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// ================== OPENAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== GOOGLE SHEETS ==================
const auth = new GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

async function loadSheetData() {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  let products = {};
  rows.forEach((row) => {
    products[row.รหัสสินค้า] = {
      name: row["ชื่อสินค้า (ทางการ)"],
      price: parseFloat(row["ราคา"]),
      keywords: row["คำที่มักถูกเรียก (Alias Keywords)"]
        ? row["คำที่มักถูกเรียก (Alias Keywords)"]
            .split(",")
            .map((k) => k.trim())
        : [],
    };
  });

  return { sheet, products };
}

// ================== LINE BOT ==================
const app = express();

app.post("/webhook", middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook Error:", err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  const { products } = await loadSheetData();

  // ตรวจสอบว่ามีสินค้าที่ตรงกับข้อความ
  let matchedProduct = null;
  for (const code in products) {
    if (
      userMessage.includes(code) ||
      products[code].keywords.some((k) => userMessage.includes(k))
    ) {
      matchedProduct = products[code];
      break;
    }
  }

  let replyText;

  if (matchedProduct) {
    replyText = `📌 ${matchedProduct.name}\n💰 ราคา: ${matchedProduct.price.toLocaleString()} บาท\nสนใจสั่งซื้อ แจ้งจำนวนได้เลยครับ`;
  } else if (/ราคา|เท่าไร|กี่บาท/.test(userMessage)) {
    replyText =
      "รบกวนบอกรายละเอียดสินค้าที่ต้องการ เช่น น้ำพริกหรือรถเข็นรุ่นไหนครับ ✅";
  } else if (/สั่งซื้อ|อยากได้|เอา/.test(userMessage)) {
    replyText =
      "ยินดีครับ 🥰 รบกวนแจ้งชื่อ-ที่อยู่-เบอร์โทร และวิธีชำระ (โอน/ปลายทาง) เพื่อบันทึกออเดอร์นะครับ";
  } else {
    const systemPrompt = `
      คุณคือผู้ช่วยขายสินค้าและบริการของร้านนี้
      ใช้ข้อมูลจาก Google Sheet (สินค้า, ราคา, โปรโมชัน, การชำระเงิน, การรับประกัน)
      เวลาตอบให้เป็นธรรมชาติแบบแอดมินจริง ไม่ยาวเกินไป
      ห้ามตอบข้อมูลนอกเหนือจากฐานข้อมูล
      ถ้าคำถามไม่เกี่ยวข้องให้ตอบว่า "ขอให้แอดมินช่วยตอบครับ"
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    replyText = completion.choices[0].message.content.trim();
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ================== START SERVER ==================
app.listen(process.env.PORT || 10000, () => {
  console.log("✅ Server is running");
});

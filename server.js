import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import fs from "fs";
import OpenAI from "openai";

// ================== LINE CONFIG ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== GOOGLE SHEET ==================
const creds = JSON.parse(
  fs.readFileSync("/etc/secrets/google-service-account.json", "utf-8")
);

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
      price: row["ราคา"],
      keywords: row["คำที่มักถูกเรียก (Alias Keywords)"]
        .split(",")
        .map((k) => k.trim()),
    };
  });

  return products;
}

// ================== LINE BOT ==================
const app = express();
app.post("/webhook", middleware(config), async (req, res) => {
  try {
    const results = await Promise.all(req.body.events.map(handleEvent));
    res.json(results);
  } catch (err) {
    console.error("❌ Webhook Error:", err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userMessage = event.message.text.trim();
  const products = await loadSheetData();

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
    replyText = `📌 ${matchedProduct.name}\n💰 ราคา: ${matchedProduct.price} บาท\nสนใจสั่งซื้อ แจ้งจำนวนได้เลยครับ`;
  } else if (/ราคา|กี่บาท|เท่าไร/.test(userMessage)) {
    replyText = "รบกวนบอกรายละเอียดสินค้า เช่น น้ำพริกหรือรถเข็นรุ่นไหนครับ ✅";
  } else if (/สั่งซื้อ|อยากได้|เอา/.test(userMessage)) {
    replyText = "ยินดีครับ 🥰 แจ้งชื่อ-ที่อยู่-เบอร์โทร และวิธีชำระ (โอน/ปลายทาง) ได้เลยครับ";
  } else {
    const systemPrompt = `
    คุณคือผู้ช่วยขายของร้าน
    ใช้ข้อมูลจาก Google Sheet เท่านั้น
    เวลาตอบให้สั้น กระชับ และเป็นธรรมชาติแบบแอดมินจริง
    ห้ามแต่งข้อมูลใหม่เอง`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    replyText = completion.choices[0].message.content.trim();
  }

  return client.replyMessage(event.replyToken, { type: "text", text: replyText });
}

// ================== START SERVER ==================
app.listen(process.env.PORT || 10000, () => {
  console.log("🚀 Server is running");
});

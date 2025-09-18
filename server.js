import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";
import fs from "fs";
import OpenAI from "openai";

// ================== LINE CONFIG ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// ================== GOOGLE SHEETS CONFIG ==================
const creds = JSON.parse(
  fs.readFileSync("/etc/secrets/google-service-account.json", "utf8")
);

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const doc = new GoogleSpreadsheet(SHEET_ID);

async function loadSheetData() {
  await doc.useServiceAccountAuth({
    client_email: creds.client_email,
    private_key: creds.private_key,
  });
  await doc.loadInfo();

  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  let products = {};
  rows.forEach((row) => {
    products[row["รหัสสินค้า"]] = {
      name: row["ชื่อสินค้า (ทางการ)"],
      price: parseFloat(row["ราคา"]),
      keywords: row["คำที่มักถูกเรียก (Alias Keywords)"]
        ? row["คำที่มักถูกเรียก (Alias Keywords)"].split(",").map((k) => k.trim())
        : [],
    };
  });

  return { sheet, products };
}

// ================== OPENAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== EXPRESS APP ==================
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
  const { products } = await loadSheetData();

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
    replyText = "รบกวนบอกชื่อสินค้าที่ต้องการครับ จะได้แจ้งราคาที่ถูกต้อง ✅";
  } else if (/สั่งซื้อ|อยากได้|เอา/.test(userMessage)) {
    replyText =
      "ยินดีครับ 🥰 รบกวนแจ้งชื่อ-ที่อยู่-เบอร์โทร และวิธีชำระ (โอน/ปลายทาง) เพื่อบันทึกออเดอร์ครับ";
  } else {
    const systemPrompt = `
คุณคือผู้ช่วยขายของร้านนี้
- ใช้ข้อมูลจาก Google Sheet เท่านั้น
- เวลาตอบให้เป็นธรรมชาติแบบแอดมิน
- ถ้าไม่เกี่ยวกับสินค้า/บริการ ตอบว่า "ขอให้แอดมินช่วยตอบครับ"
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
  console.log("🚀 Server is running");
});

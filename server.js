import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";

// ================== ENV ==================
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== GOOGLE SHEETS ==================
const privateKey = Buffer.from(
  process.env.GOOGLE_PRIVATE_KEY_BASE64,
  "base64"
).toString("utf-8");

const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: privateKey,
  },
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
    products[row["รหัสสินค้า"] || `NO_CODE_${Math.random()}`] = {
      name: row["ชื่อสินค้า (ทางการ)"] || "ไม่ระบุชื่อสินค้า",
      price: row["ราคา"] ? parseFloat(row["ราคา"]) : 0,
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
const client = new Client(config);

app.post("/webhook", middleware(config), async (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("❌ Webhook Error:", err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();
  const { products } = await loadSheetData();

  // ตรวจสอบว่า user พูดถึงสินค้าไหน
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
  } else if (userMessage.match(/ราคา|เท่าไร|กี่บาท/)) {
    replyText =
      "รบกวนบอกรายละเอียดสินค้า เช่น น้ำพริกหรือรถเข็นรุ่นไหนครับ จะได้แจ้งราคาที่ถูกต้อง ✅";
  } else if (userMessage.match(/สั่งซื้อ|อยากได้|เอา/)) {
    replyText =
      "ยินดีครับ 🥰 รบกวนแจ้งชื่อ-ที่อยู่-เบอร์โทร และวิธีชำระ (โอน/ปลายทาง) เพื่อบันทึกออเดอร์นะครับ";
  } else {
    // ส่งต่อไป GPT ให้ช่วยตอบ
    const systemPrompt = `
    คุณคือผู้ช่วยขายสินค้าและบริการของร้านนี้
    ใช้ข้อมูลจาก Google Sheet (สินค้า, ราคา, โปรโมชัน, การชำระเงิน, การรับประกัน)
    เวลาตอบให้เป็นธรรมชาติแบบแอดมินจริง ไม่ยาวเกินไป
    ห้ามตอบข้อมูลนอกเหนือจากฐานข้อมูล
    ถ้าคำถามไม่เกี่ยวข้องให้ตอบว่า "ขอให้แอดมินช่วยตอบครับ"`;

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
  console.log("🚀 Server is running on port " + (process.env.PORT || 10000));
});

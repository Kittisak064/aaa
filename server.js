import express from "express";
import bodyParser from "body-parser";
import { middleware, Client } from "@line/bot-sdk";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.json());

// LINE config
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new Client(lineConfig);

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Google Sheets
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

// โหลดข้อมูลจากชีท
async function loadData() {
  await doc.loadInfo();
  return {
    products: await doc.sheetsByTitle["Products"].getRows(),
    faqs: await doc.sheetsByTitle["FAQ"].getRows(),
    payments: await doc.sheetsByTitle["Payment"].getRows(),
    ordersSheet: doc.sheetsByTitle["Orders"],
  };
}

// หาสินค้า
function findProduct(products, text) {
  text = text.toLowerCase();
  return products.find(p =>
    (p.alias_keywords || "").toLowerCase().includes(text)
  );
}

// หาคำตอบ FAQ
function findFAQ(faqs, text) {
  text = text.toLowerCase();
  return faqs.find(f =>
    (f.question || "").toLowerCase().includes(text)
  );
}

// บันทึกคำสั่งซื้อ
async function saveOrder(ordersSheet, userId, product, qty, total, method, status) {
  await ordersSheet.addRow({
    order_id: "ORD" + Date.now(),
    user_id: userId,
    product: product.name,
    qty,
    total,
    payment_method: method,
    status,
    created_at: new Date().toISOString(),
  });
}

// Webhook
app.post("/webhook", middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  for (let event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userText = event.message.text;
      const userId = event.source.userId;
      const { products, faqs, payments, ordersSheet } = await loadData();

      let reply = "";

      // 1. เช็กสินค้า
      const product = findProduct(products, userText);
      if (product) {
        reply = `สินค้า: ${product.name}\nราคา: ${product.price} บาท\n👉 ต้องการกี่ชิ้นคะ?`;
      }

      // 2. เช็ก FAQ
      else {
        const faq = findFAQ(faqs, userText);
        if (faq) {
          reply = faq.answer;
        }
      }

      // 3. สั่งซื้อ
      if (/^\d+$/.test(userText) && product) {
        const qty = parseInt(userText, 10);
        const total = qty * parseFloat(product.price);
        await saveOrder(ordersSheet, userId, product, qty, total, "pending", "pending");
        reply = `✅ รับออเดอร์ ${product.name} ${qty} ชิ้น\nรวม ${total} บาท\nเลือกรูปแบบการชำระ: โอน / เก็บเงินปลายทาง (COD)`;
      }

      // 4. เลือกวิธีจ่าย
      if (/โอน/i.test(userText)) {
        const pay = payments.find(p => p.category === "all" || p.category === "food");
        reply = `📌 โอนเงินได้ที่:\n${pay.detail}\nแล้วส่งสลิปพร้อมชื่อที่อยู่มาได้เลยค่ะ 🙏`;
      }
      if (/cod|ปลายทาง/i.test(userText)) {
        reply = `✅ รับออเดอร์แบบเก็บเงินปลายทางแล้วค่ะ\nทีมงานจะติดต่อยืนยันการจัดส่งอีกครั้ง 🚚`;
      }

      // 5. ถ้าไม่เจอ → GPT ช่วยตอบ
      if (!reply) {
        const gpt = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "คุณคือผู้ช่วยฝ่ายขาย ให้ตอบสั้น กระชับ แต่สุภาพ และใช้ข้อมูลจริงจากร้าน ถ้าไม่เจอข้อมูลให้บอกว่าจะให้แอดมินช่วยต่อ",
            },
            { role: "user", content: userText },
          ],
        });
        reply = gpt.choices[0].message.content;
      }

      await client.replyMessage(event.replyToken, { type: "text", text: reply });
    }
  }
  res.sendStatus(200);
});

// Run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

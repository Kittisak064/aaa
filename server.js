const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const Papa = require("papaparse");
const OpenAI = require("openai");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const client = new line.Client(config);
const app = express();

// OpenAI API
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// โหลดข้อมูลจาก Google Sheet
async function loadData() {
  try {
    const url = process.env.SHEET_URL; // Google Sheet CSV link
    const res = await axios.get(url);
    const parsed = Papa.parse(res.data, { header: true });
    return parsed.data;
  } catch (error) {
    console.error("โหลด Google Sheet ไม่ได้:", error.message);
    return [];
  }
}

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMsg = event.message.text;
  const data = await loadData();

  if (!data || data.length === 0) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "ขออภัยค่ะ ตอนนี้ฐานข้อมูลยังไม่พร้อม 🙏"
    });
  }

  // ส่งข้อมูลจาก Google Sheet + คำถามลูกค้าเข้า GPT
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "คุณคือแอดมินร้าน ใช้ข้อมูลจาก Google Sheet ตอบลูกค้าเท่านั้น ห้ามแต่งราคาหรือข้อมูลผิด แต่สามารถแต่งสำนวนให้เป็นธรรมชาติได้"
      },
      {
        role: "user",
        content: `ข้อมูลสินค้าและ FAQ:\n${JSON.stringify(
          data
        )}\n\nคำถามลูกค้า: ${userMsg}`
      }
    ]
  });

  const reply = completion.choices[0].message.content || "ขออภัยค่ะ ระบบไม่ตอบกลับ";
  return client.replyMessage(event.replyToken, { type: "text", text: reply });
}

app.listen(3000, () => console.log("🤖 Bot running with Google Sheet + LINE OA"));

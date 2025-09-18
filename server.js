import express from "express";
import { middleware, Client } from "@line/bot-sdk";
import fetch from "node-fetch";
import { GoogleSpreadsheet } from "google-spreadsheet";

const app = express();

// ===== LINE CONFIG =====
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(config);

// ===== OpenAI CONFIG =====
import OpenAI from "openai";
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== GOOGLE SHEETS CONFIG (API KEY) =====
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// ===== WEBHOOK =====
app.post("/webhook", middleware(config), async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userMessage = event.message.text;

  // ===== Example: อ่าน Google Sheet =====
  let sheetData = "ยังไม่มีข้อมูล";
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A1:B5?key=${GOOGLE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    sheetData = JSON.stringify(data.values);
  } catch (err) {
    sheetData = "ดึงข้อมูลจาก Google Sheet ไม่ได้";
  }

  // ===== Example: ใช้ OpenAI =====
  const aiResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: userMessage }],
  });

  const replyText = `AI ตอบ: ${aiResponse.choices[0].message.content}\n\nข้อมูลจากชีท: ${sheetData}`;

  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

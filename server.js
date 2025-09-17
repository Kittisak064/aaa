const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const fs = require('fs');

const app = express();

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);

// โหลด FAQ
const knowledge = JSON.parse(fs.readFileSync('faq.json', 'utf8'));

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    if (!req.body.events || req.body.events.length === 0) {
      return res.status(200).send("OK");
    }

    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;

  const prompt = `
คุณคือผู้ช่วยของร้านค้าออนไลน์
- ข้อมูลร้าน: ${JSON.stringify(knowledge)}
- หน้าที่: ตอบลูกค้าโดยใช้ข้อมูลจริงเท่านั้น
- วิธีการตอบ: เขียนให้อ่านง่าย เป็นธรรมชาติ สุภาพ อาจใส่อีโมจิได้
- ห้ามแต่งหรือสร้างข้อมูลใหม่เกินกว่าที่ให้มา
- ถ้าไม่มีข้อมูลตรง ให้ตอบว่า "เดี๋ยวแอดมินช่วยตอบให้นะครับ"

ลูกค้าถาม: "${userMessage}"
  `;

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    },
    {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  const replyText = response.data.choices[0].message.content.trim();

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText
  });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

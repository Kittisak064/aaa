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
คุณคือผู้ช่วยร้านค้าออนไลน์
- ฐานข้อมูลร้าน: ${JSON.stringify(knowledge)}
- กฎการตอบ:
  1. ใช้ข้อมูลจริงจากฐานข้อมูลเท่านั้น
  2. เขียนให้เป็นธรรมชาติ เหมือนคนจริงคุยกับลูกค้า
  3. ใช้คำสุภาพ + อีโมจิเล็กน้อยให้ดูเป็นกันเอง
  4. ห้ามแต่งข้อมูลใหม่เกินจากฐานข้อมูล
  5. ถ้าไม่เจอข้อมูลตรง → ให้บอกว่า "เดี๋ยวแอดมินช่วยตอบให้นะครับ 🙏"

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

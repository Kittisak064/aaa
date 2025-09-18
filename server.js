const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const client = new line.Client(config);
const app = express();

// ✅ โหลดข้อมูล FAQ จากไฟล์ faq.json
const faqData = JSON.parse(fs.readFileSync("./faq.json", "utf8"));

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMsg = event.message.text.toLowerCase();
  let reply = "ขออภัยค่ะ ให้แอดมินช่วยตอบแทนนะคะ 😊";

  // ✅ วนหาสินค้าใน faq.json
  for (let key in faqData) {
    if (faqData[key].keywords.some(k => userMsg.includes(k.toLowerCase()))) {
      reply = `📌 ${faqData[key].name}\n💰 ราคา: ${faqData[key].price} บาท\n\n${faqData[key].desc}`;
      break;
    }
  }

  return client.replyMessage(event.replyToken, { type: "text", text: reply });
}

app.listen(3000, () => console.log("🤖 Bot running on port 3000"));

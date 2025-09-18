import express from "express";
import line from "@line/bot-sdk";

const app = express();

// ✅ ตั้งค่า LINE
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// ✅ ใช้ LINE middleware + raw body verify
app.post(
  "/webhook",
  line.middleware(config),
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString(); // เก็บ raw body
    },
  }),
  (req, res) => {
    Promise.all(req.body.events.map(handleEvent))
      .then((result) => res.json(result))
      .catch((err) => {
        console.error("Webhook Error:", err);
        res.status(500).end();
      });
  }
);

// ✅ ฟังก์ชันหลัก
async function handleEvent(event) {
  console.log("📩 EVENT:", JSON.stringify(event, null, 2));

  // ข้าม event ที่ไม่ใช่ข้อความ
  if (event.type !== "message" || event.message.type !== "text") {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text.trim();

  // ตัวอย่างการตอบกลับ
  let replyText;
  if (userMessage === "สวัสดี") {
    replyText = "สวัสดีค่ะ 🙏 ยินดีต้อนรับค่ะ";
  } else if (userMessage.includes("ราคา")) {
    replyText = "ตอนนี้สินค้ามีหลายรายการค่ะ ต้องการดูสินค้าตัวไหนเอ่ย?";
  } else {
    replyText = `คุณพิมพ์ว่า: ${userMessage}`;
  }

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

// ✅ Run server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

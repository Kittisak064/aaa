import express from "express";
import { middleware as lineMiddleware, Client as LineClient } from "@line/bot-sdk";
import dotenv from "dotenv";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { GoogleAuth } from "google-auth-library";
import OpenAI from "openai";

dotenv.config();

const app = express();

/** ---------- LINE CONFIG ---------- **/
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new LineClient(lineConfig);

/** ---------- OPENAI (ให้ตอบเป็นธรรมชาติ) ---------- **/
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ---------- GOOGLE SHEETS ---------- **/
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const doc = new GoogleSpreadsheet(SHEET_ID, auth);

/** ---------- SESSION/CONTEXT ในหน่วยความจำ ---------- **/
const sessions = {}; 
// รูปแบบ: sessions[userId] = { lastProductId, pendingOrderId, stage, cart: {productId, qty} }

/** ---------- โหลดข้อมูลจากชีท ---------- **/
async function loadSheets() {
  await doc.loadInfo();
  const productsSheet = doc.sheetsByTitle["Products"];
  const faqsSheet = doc.sheetsByTitle["FAQ"];
  const paymentsSheet = doc.sheetsByTitle["Payment"];
  const promosSheet = doc.sheetsByTitle["Promotions"]; // optional
  const ordersSheet = doc.sheetsByTitle["Orders"];

  const [products, faqs, payments, promos] = await Promise.all([
    productsSheet.getRows(),
    faqsSheet.getRows(),
    paymentsSheet.getRows(),
    promosSheet ? promosSheet.getRows() : [],
  ]);

  return { products, faqs, payments, promos, ordersSheet };
}

/** ---------- UTIL: หา product จากข้อความ ---------- **/
function findProductByText(products, text) {
  const t = text.toLowerCase();
  // หาโดย code / name / alias_keywords
  for (const p of products) {
    if ((p.code || "").toLowerCase() === t) return p;
    if ((p.name || "").toLowerCase().includes(t)) return p;
    const aliases = (p.alias_keywords || "").toLowerCase();
    if (aliases && aliases.split(",").some(a => t.includes(a.trim()))) return p;
  }
  return null;
}

/** ---------- UTIL: ดึง product จาก product_id ---------- **/
function getProductById(products, id) {
  return products.find(p => (p.code || "").toLowerCase() === (id || "").toLowerCase()) || null;
}

/** ---------- UTIL: ดึง payment ตาม category ---------- **/
function getPaymentForCategory(payments, category) {
  // ลองหาตรง category ก่อน ไม่เจอค่อย fallback เป็น all
  let row = payments.find(r => (r.category || "").toLowerCase() === (category || "").toLowerCase());
  if (!row) row = payments.find(r => (r.category || "").toLowerCase() === "all");
  return row ? { method: row.method || "", detail: row.detail || "" } : null;
}

/** ---------- UTIL: แมทช์ FAQ ---------- **/
function findFAQ(faqs, text) {
  const t = text.toLowerCase();
  return faqs.find(f => (f.question || "").toLowerCase().split(",").some(q => t.includes(q.trim())));
}

/** ---------- UTIL: ดึงโปร + คิดส่วนลด/ค่าส่ง ---------- **/
function applyPromotion(productRow, qty, promos) {
  let shipping = Number(productRow.shipping || 0);
  let discount = 0;
  let promoNote = "";

  const promoId = productRow.promo_id || "";
  if (!promoId) {
    return { shipping, discount, promoNote };
  }
  const promo = promos.find(r => (r.promo_id || "").toLowerCase() === promoId.toLowerCase());
  if (!promo) return { shipping, discount, promoNote };

  const conditionType = (promo.condition_type || "").toLowerCase(); // เช่น min_qty, product, category, all
  const conditionValue = (promo.condition_value || "").toLowerCase();
  const discountType = (promo.discount_type || "").toLowerCase(); // free_shipping, percent, amount
  const discountValue = Number(promo.discount_value || 0);

  // ตรวจเงื่อนไขง่าย ๆ
  let pass = false;
  if (conditionType === "min_qty") {
    pass = qty >= Number(conditionValue || 0);
  } else if (conditionType === "product") {
    pass = (productRow.code || "").toLowerCase() === conditionValue;
  } else if (conditionType === "category") {
    pass = (productRow.category || "").toLowerCase() === conditionValue;
  } else if (conditionType === "all" || !conditionType) {
    pass = true;
  }

  if (pass) {
    if (discountType === "free_shipping") {
      promoNote = promo.detail || "โปรส่งฟรี";
      shipping = 0;
    } else if (discountType === "percent") {
      promoNote = promo.detail || `ลด ${discountValue}%`;
      // ลดจากค่าสินค้า (คำนวณรวมภายนอกง่ายกว่า) -> คืนเป็น percent เพื่อให้ caller เอาไปใช้
      return { shipping, discountPercent: discountValue, promoNote };
    } else if (discountType === "amount") {
      promoNote = promo.detail || `ลด ${discountValue} บาท`;
      discount = discountValue;
    } else {
      promoNote = promo.detail || "";
    }
  }

  return { shipping, discount, promoNote };
}

/** ---------- UTIL: สรุปราคา ---------- **/
function calcTotals(productRow, qty, promos) {
  const price = Number(productRow.price || 0);
  const base = price * qty;

  // โปรโมชัน
  const promoResult = applyPromotion(productRow, qty, promos);
  let shipping = promoResult.shipping;
  let discount = promoResult.discount || 0;
  let promoNote = promoResult.promoNote || "";

  // ถ้าโปรเป็น percent
  if (promoResult.discountPercent) {
    discount += Math.round((base * promoResult.discountPercent) / 100);
  }

  const total = Math.max(0, base + shipping - discount);

  return {
    base,
    shipping,
    discount,
    total,
    promoNote
  };
}

/** ---------- สร้างออเดอร์ลงชีท ---------- **/
async function createOrder(ordersSheet, { userId, productRow, qty, totals, method = "pending", status = "pending" }) {
  const orderId = "ORD" + Date.now();
  await ordersSheet.addRow({
    order_id: orderId,
    user_id: userId,
    items: `${productRow.code}x${qty}`,
    total: totals.total,
    discount: totals.discount,
    shipping: totals.shipping,
    grand_total: totals.total, // (= total),
    payment_method: method,
    status,
    name: "",
    phone: "",
    address: "",
    created_at: new Date().toISOString()
  });
  return orderId;
}

/** ---------- อัปเดตออเดอร์ ---------- **/
async function updateOrder(ordersSheet, orderId, patch) {
  const rows = await ordersSheet.getRows();
  const row = rows.find(r => (r.order_id || "") === orderId);
  if (!row) return false;
  Object.keys(patch).forEach(k => {
    row[k] = patch[k];
  });
  await row.save();
  return true;
}

/** ---------- ตัวช่วยแยกจำนวนจากข้อความ ---------- **/
function extractQty(text) {
  const m = text.match(/(\d{1,4})/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** ---------- LINE Webhook (สำคัญ: ห้าม parse body เองก่อน middleware) ---------- **/
app.post("/webhook", lineMiddleware(lineConfig), async (req, res) => {
  try {
    const { products, faqs, payments, promos, ordersSheet } = await loadSheets();

    const results = await Promise.all(
      req.body.events.map(async (event) => {
        if (event.type !== "message" || event.message.type !== "text") return null;

        const userId = event.source.userId;
        const text = (event.message.text || "").trim();
        const lower = text.toLowerCase();
        sessions[userId] = sessions[userId] || { cart: {} };

        let reply = "";

        /** 0) ยกเลิก flow */
        if (/ยกเลิก|cancel/i.test(text)) {
          sessions[userId] = { cart: {} };
          reply = "ยกเลิกคำสั่งก่อนหน้าเรียบร้อยครับ ✅";
          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 1) จับสินค้า */
        let selectedProduct = findProductByText(products, text);
        if (selectedProduct) {
          sessions[userId].lastProductId = selectedProduct.code;
          // ถ้าข้อความมีจำนวนมาด้วย
          const inlineQty = extractQty(text);
          if (inlineQty) {
            const totals = calcTotals(selectedProduct, inlineQty, promos);
            const orderId = await createOrder(ordersSheet, {
              userId,
              productRow: selectedProduct,
              qty: inlineQty,
              totals,
              method: "pending",
              status: "pending",
            });
            sessions[userId].pendingOrderId = orderId;
            reply =
              `สรุป: ${selectedProduct.name}\n` +
              `ราคา ${Number(selectedProduct.price)} x ${inlineQty} = ${totals.base} บาท\n` +
              (totals.promoNote ? `โปร: ${totals.promoNote}\n` : "") +
              (totals.shipping > 0 ? `ค่าส่ง ${totals.shipping} บาท\n` : `ค่าส่ง ฟรี\n`) +
              (totals.discount > 0 ? `ส่วนลด ${totals.discount} บาท\n` : "") +
              `รวมทั้งสิ้น ${totals.total} บาท\n\n` +
              `ต้องการชำระแบบ "โอน" หรือ "ปลายทาง (COD)" ครับ? (รหัสออเดอร์: ${orderId})`;
          } else {
            reply =
              `สินค้า: ${selectedProduct.name}\nราคา: ${selectedProduct.price} บาท/ชิ้น\n` +
              `อยากรับกี่ชิ้นครับ (พิมพ์ตัวเลขได้เลย เช่น 3)`;
            sessions[userId].stage = "awaiting_qty";
          }

          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 2) ถ้าพิมพ์เป็นตัวเลขล้วน = จำนวน */
        if (/^\d{1,4}$/.test(text) && sessions[userId].lastProductId) {
          const qty = parseInt(text, 10);
          const productRow = getProductById(products, sessions[userId].lastProductId);
          if (!productRow) {
            reply = "ขออภัยหาแถวสินค้าที่เลือกไม่เจอ รบกวนพิมพ์ชื่อสินค้าอีกครั้งครับ";
            return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
          }
          const totals = calcTotals(productRow, qty, promos);
          const orderId = await createOrder(ordersSheet, {
            userId,
            productRow,
            qty,
            totals,
            method: "pending",
            status: "pending",
          });
          sessions[userId].pendingOrderId = orderId;
          sessions[userId].stage = "awaiting_payment_method";

          reply =
            `สรุป: ${productRow.name}\n` +
            `ราคา ${Number(productRow.price)} x ${qty} = ${totals.base} บาท\n` +
            (totals.promoNote ? `โปร: ${totals.promoNote}\n` : "") +
            (totals.shipping > 0 ? `ค่าส่ง ${totals.shipping} บาท\n` : `ค่าส่ง ฟรี\n`) +
            (totals.discount > 0 ? `ส่วนลด ${totals.discount} บาท\n` : "") +
            `รวมทั้งสิ้น ${totals.total} บาท\n\n` +
            `ต้องการชำระแบบ "โอน" หรือ "ปลายทาง (COD)" ครับ? (รหัสออเดอร์: ${orderId})`;

          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 3) เลือกวิธีชำระ: โอน / COD */
        if (/^โอน|โอนเงิน/i.test(text) && sessions[userId].pendingOrderId) {
          const orderId = sessions[userId].pendingOrderId;
          // ดึงสินค้าเดิมสำหรับดึงหมวดสินค้าหา payment
          const productRow = getProductById(products, sessions[userId].lastProductId);
          const pay = getPaymentForCategory(payments, productRow?.category || "all");
          await updateOrder(ordersSheet, orderId, { payment_method: "transfer" });

          reply =
            `วิธีชำระเงิน (โอน):\n${pay ? pay.detail : "—"}\n\n` +
            `โอนแล้วรบกวนแจ้ง "ชื่อ-นามสกุล", "เบอร์โทร", "ที่อยู่จัดส่ง" (พิมพ์ในบรรทัดเดียวก็ได้)\n` +
            `เช่น: ชื่อ สมชาย ใจดี, 0891234567, 123/45 เขต/อำเภอ จังหวัด\n` +
            `ระบุรหัสออเดอร์: ${orderId}`;
          sessions[userId].stage = "awaiting_address_transfer";

          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        if (/(cod|ปลายทาง)/i.test(lower) && sessions[userId].pendingOrderId) {
          const orderId = sessions[userId].pendingOrderId;
          await updateOrder(ordersSheet, orderId, { payment_method: "COD", status: "awaiting_delivery" });
          reply =
            `รับออเดอร์แบบเก็บเงินปลายทางเรียบร้อย ✅\n` +
            `ขอ "ชื่อ-นามสกุล", "เบอร์โทร", "ที่อยู่จัดส่ง" เพื่อเตรียมส่งของครับ\n` +
            `ระบุรหัสออเดอร์: ${orderId}`;
          sessions[userId].stage = "awaiting_address_cod";

          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 4) เก็บข้อมูลชื่อ/เบอร์/ที่อยู่ */
        if (/ชื่อ|ที่อยู่|เบอร์|โทร|ส่งที่/i.test(text) && sessions[userId].pendingOrderId) {
          // แยกง่าย ๆ ด้วยคอมม่า
          const parts = text.split(/,|\n/).map(s => s.trim()).filter(Boolean);
          let name = "", phone = "", address = "";
          for (const part of parts) {
            if (/^\d{8,12}$/.test(part)) phone = part;
            else if (/ชื่อ|นามสกุล/i.test(part)) name = part.replace(/ชื่อ|นามสกุล|:/gi, "").trim();
            else address += (address ? " " : "") + part;
          }
          // ถ้าไม่ได้ขึ้นรูป ให้เดาว่า part แรกเป็นชื่อ, อันที่มีตัวเลขยาวเป็นเบอร์, ที่เหลือเป็นที่อยู่
          if (!name && parts.length >= 1) name = parts[0].replace(/ชื่อ|:|-/g, "").trim();
          if (!phone) {
            const m = text.match(/(0\d{8,9})/);
            if (m) phone = m[1];
          }
          if (!address) address = text;

          const orderId = sessions[userId].pendingOrderId;
          await updateOrder(ordersSheet, orderId, {
            name,
            phone,
            address
          });

          const stage = sessions[userId].stage || "";
          if (stage === "awaiting_address_transfer") {
            // โอนแล้วให้แอดมินตรวจสลิปภายหลัง → เปลี่ยนเป็น paid เมื่อยืนยัน
            await updateOrder(ordersSheet, orderId, { status: "paid", paid_at: new Date().toISOString() });
            reply =
              `บันทึกข้อมูลจัดส่งแล้วครับ ✅\n` +
              `ยืนยันการชำระเงินเรียบร้อย (รอทีมงานตรวจสลิปถ้ามี)\n` +
              `ขอบคุณมากครับ 🙏 เราจะรีบจัดส่งให้เร็วที่สุด`;
          } else {
            reply =
              `บันทึกข้อมูลจัดส่งแล้วครับ ✅\n` +
              `ออเดอร์แบบ COD รอจัดส่ง 🚚\n` +
              `ขอบคุณมากครับ 🙏`;
          }
          sessions[userId] = { cart: {} }; // เคลียร์สถานะ

          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 5) คำถามทั่วไป/FAQ */
        const faq = findFAQ(faqs, text);
        if (faq) {
          reply = faq.answer;
          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 6) ถาม "ราคา" แบบไม่มีบริบท */
        if (/ราคา|กี่บาท/.test(text)) {
          if (sessions[userId].lastProductId) {
            const p = getProductById(products, sessions[userId].lastProductId);
            if (p) {
              reply = `ราคาของ ${p.name} คือ ${p.price} บาทครับ`;
              return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
            }
          }
          reply = "ลูกค้าสนใจดูราคาสินค้าตัวไหนครับ เช่น น้ำพริกต้มยำ หรือ รถเข็นไฟฟ้ารุ่นมาตรฐาน";
          return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }

        /** 7) Fallback → ให้ GPT แต่งคำตอบสุภาพ (ไม่มั่วข้อมูลราคาเอง) */
        const gpt = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "คุณเป็นผู้ช่วยฝ่ายขาย ให้ตอบสั้น กระชับ สุภาพ ใช้ถ้อยคำธรรมชาติ แต่ห้ามเดาราคา/สต๊อก/โปร หากไม่พบในข้อมูล ให้ชวนลูกค้าบอกชื่อสินค้าหรือส่งต่อแอดมิน",
            },
            { role: "user", content: text }
          ],
          max_tokens: 200
        });
        reply = gpt.choices?.[0]?.message?.content?.trim() || "เดี๋ยวให้แอดมินช่วยตอบนะครับ 😊";
        return lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
      })
    );

    res.json(results);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.status(500).end();
  }
});

/** ---------- HEALTH CHECK ---------- **/
app.get("/", (_req, res) => res.send("OK"));

/** ---------- START ---------- **/
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

# LINE Bot + OpenAI + Google Sheets

## 🚀 วิธีใช้งาน
1. สร้าง Google Sheet เก็บข้อมูลสินค้า
2. สร้าง Service Account ใน Google Cloud และโหลดไฟล์ JSON
3. ใส่ไฟล์ JSON ไว้ที่ `config/google-service-account.json`
4. ตั้งค่า Environment Variables บน Render:
   - LINE_CHANNEL_ACCESS_TOKEN
   - LINE_CHANNEL_SECRET
   - OPENAI_API_KEY
   - GOOGLE_SHEET_ID
5. Deploy ไปยัง Render → ใช้ Webhook เดิมใน LINE Developers

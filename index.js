/***********************************************
 * 1. 環境變數與基礎設定
 * 使用 dotenv 自動讀取專案根目錄下的 .env 檔案
 ***********************************************/
require('dotenv').config();

/***********************************************
 * 2. 引入必要的第三方模組
 ***********************************************/
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');   // 用於操作 Google Sheets API
const { nanoid } = require('nanoid');         // 用於生成唯一訂單 ID
const nodemailer = require('nodemailer');       // 用於發送郵件
const axios = require('axios');               // 用於發送 Discord 通知
const session = require('express-session');     // 用於 session 管理

/***********************************************
 * 3. 建立 Express 應用並設定中間件
 ***********************************************/
const app = express();

/**
 * 預熱初始化工作
 * 可在此處執行輕量級作業，例如預先讀取 Google Sheets 的部分資料
 */
async function warmUp() {
  try {
    // 嘗試讀取 Inventory 工作表的 A 欄（僅讀取標題列）
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!A:A`
    });
    console.log("Warmup: Inventory header fetched successfully.");
  } catch (err) {
    console.error("Warmup failed:", err);
  }
}

// 設定預熱請求路由 (請將此路由放在其他路由設定之前)
app.get('/_ah/warmup', async (req, res) => {
  console.log('Warmup request received.');
  // 執行預熱初始化作業（你可以根據需要調整要預先執行的工作內容）
  await warmUp();
  // 快速回應 200 狀態
  res.status(200).send('Warmup completed.');
});

// 設定 express-session 中間件
const SESSION_SECRET = process.env.SESSION_SECRET || 'a3f1d8e4c9bffb4a7d3e2c';
app.use(session({
  secret: SESSION_SECRET,    // 建議使用複雜難猜的密鑰
  resave: false,             // 未修改的 session 不會被重存
  saveUninitialized: true,   // 是否儲存未初始化的 session
  cookie: { 
    maxAge: 5 * 60 * 1000,   // session 存活 5 分鐘
    secure: false            // HTTPS 時設定為 true，開發環境可用 false
  }
}));

// 使用 body-parser 處理 application/x-www-form-urlencoded 與 JSON 格式請求
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/***********************************************
 * 4. 讀取環境變數並設定參數
 ***********************************************/
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID   || '1nDs6ZjIqOFU3FLVqRPheLjAiC-Xd23ykLBuffEm12R0'; // 試算表 ID
const ORDERS_SHEET     = process.env.ORDERS_SHEET     || 'Orders';        // 訂單工作表名稱
const INVENTORY_SHEET  = process.env.INVENTORY_SHEET  || 'Inventory';     // 庫存工作表名稱
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1355787715332804741/48qF2dutYE0d9dH02FukAy2aC4yLLVuqEf3qVJGpjtTBLfB-geYQKpUpeRwwlZiFMEtg';  // Discord Webhook URL


/***********************************************
 * 5. Google Sheets API 認證及客戶端建立
 ***********************************************/
// 建立認證物件，使用服務帳號金鑰檔案與存取範圍設定
const auth = new google.auth.GoogleAuth({
  keyFile: 'credentials.json', 
  scopes: ['https://www.googleapis.com/auth/spreadsheets'], 
});
// 建立 Google Sheets 客戶端
const sheets = google.sheets({ version: 'v4', auth });

/***********************************************
 * 6. 建立 Nodemailer 傳輸器
 * 透過 Gmail SMTP 發送郵件
 ***********************************************/
// Gmail 帳號與應用程式密碼(預設值僅供示範，不建議直接寫在程式碼中)
const GMAIL_USER = process.env.GMAIL_USER || "i13mogi@gmail.com"; 
const GMAIL_PASS = process.env.GMAIL_PASS || "alyk ktqo sglh kcaw";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,            // 使用 SSL 加密連線
  secure: true,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

/***********************************************
 * 7. 工具函式區
 ***********************************************/
/**
 * 將數字轉換為 Excel 欄位字母
 * 例如：1 -> A, 27 -> AA
 */
function columnToLetter(column) {
  let temp, letter = '';
  while (column > 0) {
    temp = (column - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    column = (column - temp - 1) / 26;
  }
  return letter;
}

/**
 * 根據文字長度截斷並加入「...展開」功能
 */
function getTruncatedText(text) {
  if (text.length > 20) {
    const truncated = text.substring(0, 20);
    return `<span class="description-text">${truncated}</span><span class="expand-toggle" onclick="toggleExpand(this)">...展開</span><span class="full-text" style="display:none;">${text}</span>`;
  }
  return `<span class="description-text">${text}</span>`;
}

/***********************************************
 * 8. 全域變數定義區 (非 Express session)
 ***********************************************/
// 保存當前在 modal 中操作的商品資訊與數量資訊
let currentModalProduct  = null;
let currentQuantityProduct = null;
var cart = {};  // 購物車內容，作為全域儲存

/***********************************************
 * 9. Express 路由設定
 ***********************************************/

/**
 * 路由：讀取最新庫存資料
 * 從 Google Sheets 讀取 Inventory 工作表中 A:F 資料，
 * 整理成 { productCode: stock } 的格式回傳給前端。
 */
app.get('/api/getLatestInventory', async (req, res) => {
  try {
    // 從 INVENTORY_SHEET 的 A:F 欄位讀取資料
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!A:F`
    });
    const rows = result.data.values || [];
    let latestInventory = {};
    // 第一列是假設為標題列
    for (let i = 1; i < rows.length; i++) {
      const [mainCat, catIntro, code, intro, stockStr] = rows[i];
      if (!code) continue;
      // 將庫存字串轉換成數字
      const stock = parseInt(stockStr, 10) || 0;
      latestInventory[code] = stock;
    }
    res.json(latestInventory);
  } catch (error) {
    console.error("取得最新庫存錯誤：", error);
    res.status(500).json({ error: '取得最新庫存失敗' });
  }
});


/**
 * 路由：首頁
 * 從 Google Sheets 讀取庫存與分類資料，生成商品卡片 HTML 及分類資料後回傳網頁
 */
app.get('/', async (req, res) => {
  try {
    // 1) 從 INVENTORY_SHEET 讀取 A:F 欄位資料：Main Category, Category Intro, Code, Intro, Stock, Price
    const inventoryResult = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!A:F`
    });
    const rows = inventoryResult.data.values || [];

    // 2) 建立主分類對照物件 { mainCategory: categoryIntro }
    const categories = {};
    for (let i = 1; i < rows.length; i++) {
      const [mainCat, catIntro] = rows[i];
      if (mainCat && !categories[mainCat]) {
        categories[mainCat] = catIntro;
      }
    }

    // 3) 產生商品卡片 HTML 字串
    let productCardsHtml = '';
    for (let i = 1; i < rows.length; i++) {
      const [ mainCat, , code, intro, stockStr, priceStr ] = rows[i];
      if (!code) continue;
    
      const stock = parseInt(stockStr, 10);
      const price = parseInt(priceStr, 10) || 0;
      const descHtml = getTruncatedText(intro);
    
      // 當 stock 為 -1 表示僅供展示，不顯示按鈕與數據標籤
      if (stock === -1) {
        productCardsHtml += `
          <div class="product-card" data-category="${mainCat}">
            <div class="image-container">
              <img
                class="product-image"
                src="https://raw.githubusercontent.com/i13mogi/013image/refs/heads/main/${code}.jpg"
                alt="${code}"
                loading="lazy"
                data-code="${code}"
                data-intro="${intro}"
              >
              <div class="click-overlay">點擊圖片</div>
            </div>
            <div class="product-content">
              <div class="product-title">${code}</div>
              <div class="product-description">${descHtml}</div>
            </div>
          </div>`;
        continue;
      }
    
      // 庫存不為 -1 時，加入 data-price 與 data-stock 屬性
      const attr = stock >= 0
        ? `data-price="${price}" data-stock="${stock}"`
        : '';
    
      // 判斷是否售完及按鈕顯示文字
      const isSoldOut   = (stock === 0);
      const disabled    = isSoldOut ? 'disabled' : '';
      const buttonLabel = isSoldOut ? '【你來遲啦!】' : '加入背籃';
    
      productCardsHtml += `
        <div class="product-card" data-category="${mainCat}">
          <img
            class="product-image"
            src="https://raw.githubusercontent.com/i13mogi/013image/refs/heads/main/${code}.jpg"
            alt="${code}"
            loading="lazy"
            data-code="${code}"
            data-intro="${intro}"
            ${attr}
          >
          <div class="product-content">
            <div class="product-title">${code}</div>
            <div class="product-description">${descHtml}</div>
            <div class="product-price">懿昇價: ${price} / 數量: ${stock}</div>
            <button
              class="btn-select"
              ${disabled}
              onclick="selectProduct('${code}', ${stock}, ${price})"
            >${buttonLabel}</button>
          </div>
        </div>`;
    }
    
// 建立完整的 HTML 頁面 (包含 header、商品列表、購物車與各種 Modal)
const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>懿昇土地藝術生活訂購單</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
/* ============================================================
   1. 全域變數與基礎樣式
   定義網站主要色系、字體與全站過渡效果
   ============================================================ */
:root {
  --primary-color: #A3B18A;
  --primary-hover: #8B9B75;
  --accent-color: #FAD689;
  --text-color: #4D3B2F;
  --background-color: #F5F9ED;
  --border-color: #DCE2D0;
  --light-bg: #FFFFFF;
  --shadow-color: rgba(0, 0, 0, 0.1);
}
* {
  transition: all 0.3s ease;
}
body {
  font-family: 'Noto Sans', sans-serif;
  margin: 0;
  padding-top: 60px;
  background: linear-gradient(to bottom, var(--accent-color), var(--background-color));
  color: var(--text-color);
  line-height: 1.6;
}


/* ============================================================
   2. 頁首 Header 與導覽列
   固定頁首、標題、導航、漢堡選單等設定
   ============================================================ */
header {
  background-color: var(--light-bg);
  border-bottom: 4px solid var(--border-color);
  box-shadow: 0 4px 6px var(--shadow-color);
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  padding: 0 1rem;
  z-index: 1000;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.header-left {
  display: flex;
  align-items: center;
}
header h1 {
  font-size: 1.4rem;
  font-weight: bold !important; /* 或寫成 font-weight: 700; */
  margin: 0;
}
header nav {
  display: flex;
  align-items: center;
}
header nav.active {
  display: flex;
  flex-direction: column;
  width: 100%;
  margin-top: 0.5rem;
}
header nav a {
  color: var(--primary-color);
  text-decoration: none;
  font-size: 0.9rem;
  padding: 0.4rem 1rem;
  border: 2px solid var(--primary-color);
  border-radius: 7px;
  margin-left: 1rem;
}
header nav a:hover {
  background-color: var(--primary-color);
  color: #fff;
}
.hamburger {
  display: none;
  flex-direction: column;
  cursor: pointer;
  margin-left: 0.3rem;
  margin-right: 1rem;
}
.hamburger span {
  width: 25px;
  height: 3px;
  background: var(--primary-color);
  margin: 2px 0;
}

/* 按鈕：分類 Modal 開啟按鈕 */
#openCategoryModal {
  background-color:rgb(105, 122, 82);
  color: #fff;
  font-size: 1rem !important;
  padding: 0.3rem 0.5rem !important;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-left: 1rem;
}
#openCategoryModal:hover {
  background-color: var(--primary-hover);
}


/* ============================================================
   3. 主要容器設定
   控制內容顯示區域的最大寬度與內邊距
   ============================================================ */
.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
}


/* ============================================================
   4. 商品列表與商品卡片
   定義商品網格（雙欄）與單一商品卡片的版型與排版
   ============================================================ */
.products-grid {
  column-count: 2;
  column-gap: 1rem;
}
.product-card {
  display: inline-block;
  width: 100%;
  margin-bottom: 1rem;
  break-inside: avoid;
  background: var(--light-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 2px 4px var(--shadow-color);
}
.product-card:hover {
  transform: translateY(-5px);
}
.product-image {
  width: 100%;
  height: auto;
  object-fit: cover;
  cursor: pointer;
}
.product-content {
  padding: 0.75rem;
}
.product-title {
  font-size: 1.1rem;
  margin-bottom: 0.5rem;
}
.product-description {
  font-size: 0.95rem;
  color: var(--text-color);
  opacity: 0.8;
  margin-bottom: 0.5rem;
}
.product-price {
  font-size: 1rem;
  color: var(--primary-color);
  font-weight: 600;
  margin-bottom: 0.75rem;
}


/* ============================================================
   5. 按鈕樣式
   定義各類操作按鈕，如商品選取、載入更多、編輯等
   ============================================================ */
.btn-select {
  display: block;
  width: 100%;
  padding: 0.75rem;
  background-color: var(--primary-color);
  color: #fff;
  text-align: center;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  cursor: pointer;
}
.btn-select:hover,
.btn-select:active {
  background-color: var(--primary-hover);
}
#loadMoreBtn {
  display: block;
  margin: 1rem auto;
  padding: 0.75rem 1.5rem;
  background-color: var(--primary-color);
  color: #fff;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 1rem;
}
#loadMoreBtn:hover {
  background-color: var(--primary-hover);
}


/* ============================================================
   6. 購物車按鈕與抽屜
   固定在畫面上的購物車按鈕與隱藏式抽屜（cart-drawer）的樣式
   ============================================================ */
#openCartButton {
  position: fixed;
  bottom: 20px;
  right: 20px;
  background-color: var(--primary-color);
  color: #fff;
  padding: 10px 20px;
  border: none;
  border-radius: 25px;
  z-index: 1000;
}
.cart-drawer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--light-bg);
  border-top: 1px solid var(--border-color);
  box-shadow: 0 -2px 6px var(--shadow-color);
  transform: translateY(100%);
  transition: transform 0.3s ease;
  z-index: 1000;
  max-height: 50%;
  overflow-y: auto;
  padding: 1rem;
}
.cart-drawer.open {
  transform: translateY(0);
}
.drawer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.close-drawer {
  position: absolute;
  top: 10px;
  right: 15px;
  width: 36px;            /* 調整按鈕大小 */
  height: 36px;
  font-size: 30px !important;        /* 調整 X 字體大小 */
  line-height: 10px;      /* 讓 X 在中間 */
  text-align: center;
  color: white;
  background-color: #e74c3c;
  border: none;
  border-radius: 50%;     /* 變成圓形 */
  cursor: pointer;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s ease, background-color 0.3s ease;
}

.close-drawer:hover {
  background-color: #c0392b;
  transform: scale(1.1);  /* 滑過放大一點點 */
}


/* ============================================================
   7. Modal 與彈窗
   包含各式 Modal (數量輸入、庫存提醒、全螢幕 Icon Grid Modal)
   ============================================================ */
.modal {
  display: none;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6);
  justify-content: center;
  align-items: center;
  z-index: 1000;
  opacity: 0;
  overflow: auto; /* 如果有內容過長時，讓整個 modal 也可滾動 */
}
.modal.show {
  display: flex;
  opacity: 1;
}
.modal-content {
  position: relative;
  background-color: var(--light-bg);
  padding: 1.5rem;
  border-radius: 10px;
  max-width: 400px;
  width: 90%;
  max-height: 75vh;              /* 固定高度，讓內容超出時一定產生滾動 */
  overflow-y: scroll;        /* 強制顯示垂直滾軸 */
  scrollbar-gutter: stable;  /* (支援瀏覽器保留滾軸空間) */
  
  /* Firefox 專用設定 */
  scrollbar-width: auto;
  scrollbar-color: #7e8a24 #eee;
  animation: fadeIn 0.3s ease;
}

/* Webkit 瀏覽器自訂滾軸 */
.modal-content::-webkit-scrollbar {
  width: 14px;
}

.modal-content::-webkit-scrollbar-thumb {
  background: #7e8a24;
  border-radius: 7px;
}

.modal-content::-webkit-scrollbar-track {
  background: #eee;
}

@keyframes fadeIn {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

.close-modal {
  position: absolute;
  top: 10px;
  right: 15px;
  font-size: 1.5rem;
  width: 36px;
  height: 36px;
  text-align: center;
  line-height: 36px;
  cursor: pointer;
  color: white;
  background-color: #e74c3c;  /* 背景紅色 */
  border: none;
  border-radius: 50%;         /* 圓形按鈕 */
  transition: background-color 0.3s ease, transform 0.2s ease;
}

.close-modal:hover {
  background-color: #c0392b;  /* 滑過變深紅 */
  transform: scale(1.1);      /* 稍微放大 */
}

/* 全螢幕 Icon Grid Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  display: none;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}
.modal-overlay.active {
  display: flex;
}
.modal-content.icon-grid {
  background: #fff;
  padding: 2rem;
  border-radius: 8px;
  max-width: 500px;
  width: 90%;
  text-align: center;
  animation: fadeIn 0.3s ease;
}
.icon-grid h2 {
  margin-top: 0;
  margin-bottom: 1rem;
}
.grid-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
  gap: 1rem;
  margin: 1rem 0;
}
.grid-item {
  background: var(--light-bg);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 0.5rem;
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
}
/* 調整 icon 圖示大小 */
.grid-item img {
  width: auto;    /* 設定合適的寬度，例如 60px */
  height: 30px;   /* 同時調整高度，或設定 auto 依比例調整 */
  object-fit: contain; /* 若圖示比例不同，可使用此設定 */
  margin-bottom: 0.5rem;
}
/* 調整 icon 文字大小 */
.grid-item span {
  font-size: 16px;
  font-weight: 600;
  margin-top: 8px;
  display: block;
  text-align: center;
}
.grid-item:hover,
.grid-item:focus {
  transform: scale(1.05);
  box-shadow: 0 4px 8px rgba(0,0,0,0.2);
}
.close-btn {
  background: var(--primary-color);
  color: #fff;
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  margin-top: 1rem;
}


/* ============================================================
   8. Toast 提示訊息
   顯示臨時操作反饋訊息的樣式設計
   ============================================================ */
#toast {
  position: fixed;
  bottom: 80px;
  right: 20px;
  background-color: rgba(0, 0, 0, 0.7);
  color: #fff;
  padding: 10px 20px;
  border-radius: 5px;
  opacity: 0;
  transition: opacity 0.5s ease;
  z-index: 1100;
}


/* ============================================================
   9. 其他小工具
   包含展開/收起文字、編輯按鈕、數量 Modal 的細部設定等
   ============================================================ */
.expand-toggle {
  color: #d9534f;
  cursor: pointer;
  font-weight: bold;
  margin-left: 4px;
}
.expand-toggle:hover {
  color: #c9302c;
}
.edit-button {
  background-color: var(--primary-color);
  color: #fff;
  border: none;
  border-radius: 20px;
  padding: 0.3rem 0.4rem !important;
  font-size: 10px !important;
  cursor: pointer;
  margin-left: 0.3rem;
  margin: 0.1rem 0.1rem !important;
  transition: background-color 0.3s ease;
}
.edit-button:hover {
  background-color: var(--primary-hover);
}
#quantityModal .btn-select {
  padding: 0.4rem 0.6rem;
  font-size: 1rem;
  margin-right: 0.3rem;
  margin: 0.3rem 0;
}
#deleteButton {
  background-color: #c9302c;
  color: #fff;
}
#cartSummary ul {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
#cartSummary ul li {
  margin-bottom: 3px;
}
.total-amount {
  color: #c9302c;
}
.image-container {
  position: relative;
  display: inline-block;
}
.click-overlay {
  position: absolute;
  bottom: 10px;
  right: 10px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 0.7rem;
}


/* ============================================================
   10. 手機版媒體查詢
   為螢幕寬度小於 600px 的裝置調整部分排版
   注意：此處保留 .products-grid 為雙欄布局
   ============================================================ */
@media (max-width: 600px) {
  .hamburger {
    display: flex;
  }
  .product-price {
    font-size: 0.9rem !important;
  }
  button, .btn-select {
    padding: 0.7rem !important;
    font-size: 1rem !important;
  }
  /* 保留雙欄布局 */
  .products-grid {
    column-count: 2;
    column-gap: 1rem;
  }
  header nav {
    display: none;
    flex-direction: column;
    width: 100%;
    margin-top: 0.5rem;
  }
  header nav a {
    margin: 0.25rem 0;
    width: 100%;
    text-align: center;
  }
  header {
    flex-direction: column;
    align-items: flex-start;
    padding: 0.5rem 1rem;
  }
}
  </style>
</head>
<body>
  <!-- header 與導覽列 -->
  <header>
    <div class="header-left">     
      <div class="hamburger" onclick="toggleHamburger()">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <h1>懿昇土地藝術生活訂購單</h1>
      <!-- 更新為觸發全螢幕分類 Modal -->
      <button id="openCategoryModal" onclick="openCategoryModal()">目錄</button>
    </div>
    <nav id="navMenu">
      <a href="https://www.facebook.com/cutmourning/">懿昇Facebook</a>
      <a href="https://www.facebook.com/Landartgatheringschool/">懿昇粉絲頁</a>
      <a href="https://111axfqv.netlify.app/">懿昇Line官網</a>
    </nav>
  </header>
  <!-- 主內容：商品列表 -->
  <div class="container">
    <div id="productsGrid" class="products-grid">
      ${productCardsHtml}
    </div>
    <button id="loadMoreBtn" onclick="loadMoreProducts()">載入更多</button>
  </div>
  <!-- 背籃按鈕與抽屜 -->
  <button id="openCartButton" onclick="openCartDrawer()">背籃 (<span id="cartCount">0</span>)</button>
  <div id="cartDrawer" class="cart-drawer">
    <div class="drawer-header">
      <h2>背籃</h2>
      <button class="close-drawer" onclick="closeCartDrawer()">&times;</button>
    </div>
    <div id="cartSummary" class="drawer-content">目前尚未選購任何商品。</div>
    <button class="btn-select" onclick="goToCheckout()">結帳</button>
  </div>

 <!-- 全螢幕 Icon Grid Modal for 品項分類 -->
<div id="categoryModal" class="modal-overlay">
  <div class="modal-content icon-grid">
    <h2>選擇分類</h2>
    <div class="grid-container">
      ${Object.keys(categories).map(mainCat =>
        `<button
           class="grid-item"
           onclick="openCategoryDetail('${mainCat}', \`${categories[mainCat]}\`)"
         >
          <img src="https://raw.githubusercontent.com/i13mogi/013image/refs/heads/main/${mainCat}.jpg" alt="${mainCat} Icon">
          <span>${mainCat}</span>
        </button>`
      ).join('')}
      <button class="grid-item" onclick="filterCategory('all')">
        <img src="https://raw.githubusercontent.com/i13mogi/013image/refs/heads/main/icons/all.png" alt="全部內容">
        <span>全部內容</span>
      </button>
    </div>
    <button class="close-btn" onclick="closeCategoryModal()">關閉</button>
  </div>
</div>
<!-- 類別詳細 Modal -->
<div id="categoryDetailModal" class="modal-overlay">
<span class="close-modal" onclick="closeCategoryDetailModal()">&times;</span>
  <div class="modal-content">
    <img id="categoryDetailImage" src="" alt="大圖" style="width:100%; height:auto;">
    <div id="categoryDetailIntro" style="margin-top:1rem; font-size:1rem; line-height:1.4;"></div>
  </div>
</div>
  <!-- 其他 Modal（空背籃、商品詳細、修改商品數量、庫存不足提醒、Toast） -->
  <div id="emptyCartModal" class="modal">
    <div class="modal-content">
      <span class="close-modal" onclick="closeEmptyCartModal()">&times;</span>
      <h2>提醒</h2>
      <p>請至少選擇一個品項</p>
      <button class="btn-select" onclick="closeEmptyCartModal()">確定</button>
    </div>
  </div>
  <div id="productModal" class="modal">
  <span class="close-modal" onclick="closeModal('productModal')">&times;</span>
    <div class="modal-content">
      <img id="modalImage" src="" alt="大圖" style="width:100%; height:auto;">
      <div id="modalDetails" style="margin-top: 1rem;">
        <h2 id="modalTitle"></h2>
        <p id="modalDescription"></p>
        <p id="modalPrice"></p>
        <button id="modalSelectButton" class="btn-select" onclick="modalSelectProduct()">加入背籃</button>
      </div>
    </div>
  </div>
  <div id="quantityModal" class="modal">
    <div class="modal-content">
      <span class="close-modal" onclick="closeModal('quantityModal')">&times;</span>
      <h2 id="quantityModalTitle">修改品項數量</h2>
      <p id="quantityModalInfo"></p>
      <input type="number" id="quantityInput" min="1" placeholder="請輸入數量" style="width:100%; padding:0.5rem; margin: 1rem 0;" oninput="validateQuantity()">
      <p id="quantityError" style="color:red; display:none; font-size:0.9rem;"></p>
      <button class="btn-select" onclick="confirmQuantity()">確定</button>
      <button id="deleteButton" class="btn-select" onclick="deleteCartItem(currentQuantityProduct.code)">刪除</button>
    </div>
  </div>
  <div id="inventoryModal" class="modal">
    <div class="modal-content">
      <span class="close-modal" onclick="closeInventoryModal()">&times;</span>
      <h2 id="inventoryModalTitle"></h2>
      <p id="inventoryModalContent"></p>
      <button class="btn-select" onclick="closeInventoryModal()">確認</button>
    </div>
  </div>
  <div id="toast"></div>
  <script>
  /*******************************************
   * 工具函式區 - 包含防抖（debounce）工具函式
   *******************************************/
  // 防抖函式：避免短時間內重複觸發同一事件
  function debounce(func, delay) {
    let timeout;
    return function(...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), delay);
    };
  }

  /*******************************************
   * 全域變數定義區
   *******************************************/
  // 購物車物件、目前被選的產品、頁面顯示資訊等
  var cart = {};
  var currentProductIndex = 0;
  var pageSize = 5;
  var currentQuantityProduct = null;
  var currentModalProduct = null;

  /*******************************************
   * 分類與 Modal 控制函式區
   *******************************************/
  // 開啟全螢幕分類 Modal
  function openCategoryModal() {
    document.getElementById('categoryModal').classList.add('active');
  }
  // 關閉全螢幕分類 Modal
  function closeCategoryModal() {
    document.getElementById('categoryModal').classList.remove('active');
  }

  // 根據所選分類篩選商品卡片
  function filterCategory(category) {
    var cards = document.querySelectorAll('.product-card');
    cards.forEach(function(card) {
      card.style.display =
        (category === 'all' || card.getAttribute('data-category') === category) ? 'inline-block' : 'none';
    });
    updateLoadMoreVisibility();
    closeCategoryModal();
  }

  /*******************************************
   * 分類詳細資訊 Modal 處理
   *******************************************/
  // 確保 DOM 載入完成後執行
  document.addEventListener('DOMContentLoaded', () => {
    // 開啟分類詳細資訊 Modal （依據分類、介紹文字設定內容）
    window.openCategoryDetail = function(category, intro) {
      closeCategoryModal();             // 1. 關閉分類選單
      filterCategory(category);         // 2. 篩選商品
      const imgUrl = 'https://raw.githubusercontent.com/i13mogi/013image/refs/heads/main/' + category + '.jpg';
      document.getElementById('categoryDetailImage').src = imgUrl;  // 3. 設定大圖
      document.getElementById('categoryDetailIntro').textContent = intro;  // 4. 設定介紹文字
      const modal = document.getElementById('categoryDetailModal');
      modal.classList.add('active');    // 5. 顯示 Modal
    };

    // 關閉分類詳細資訊 Modal
    window.closeCategoryDetailModal = function() {
      document.getElementById('categoryDetailModal').classList.remove('active');
    };

    // 點擊空白處關閉分類詳細資訊 Modal
    window.addEventListener('click', function(e) {
      const modal = document.getElementById('categoryDetailModal');
      if (e.target === modal) {
        closeCategoryDetailModal();
      }
    });
  });

  /*******************************************
   * 購物車抽屜控制函式區
   *******************************************/
  // 掛載在全域，確保 HTML 中 onclick 可正確呼叫
  window.openCartDrawer = function() {
    document.getElementById('cartDrawer').classList.add('open');
  };

  window.closeCartDrawer = function() {
    document.getElementById('cartDrawer').classList.remove('open');
  };

  /*******************************************
   * 商品庫存相關函式區
   *******************************************/
  // 從後端 API 取得最新庫存資料
  function fetchLatestInventory() {
    return fetch('/api/getLatestInventory')
      .then(response => response.json())
      .catch(error => {
        console.error('取得庫存資料錯誤：', error);
        return {};
      });
  }

  // 更新所有商品卡片的庫存與按鈕狀態，同時同步更新購物車數據至 localStorage
  function refreshProductCards() {  
    return fetch('/api/getLatestInventory')
      .then(response => response.json())
      .then(latestInventory => {
        // 更新各商品卡片上的庫存狀態與按鈕狀態
        const productCards = document.querySelectorAll('.product-card');
        productCards.forEach(card => {
          const img = card.querySelector('.product-image');
          const productCode = img.getAttribute('data-code');
          const newStock = latestInventory[productCode] || 0;
          img.setAttribute('data-stock', newStock);

          // 若庫存為 -1 則僅供展示，不更新按鈕
          if (newStock === -1) {
            return;
          }

          // 更新價格與庫存資訊顯示
          const priceElem = card.querySelector('.product-price');
          if (priceElem) {
            const price = img.getAttribute('data-price') || '';
            priceElem.textContent = '懿昇價: ' + price + ' / 數量: ' + newStock;
          }

          // 按鈕處理：根據庫存決定新增或移除按鈕與售完提示
          let addButton = card.querySelector('.btn-select');
          if (!addButton && newStock > 0) {
            addButton = document.createElement('button');
            addButton.classList.add('btn-select');
            addButton.onclick = function() {
              const priceVal = parseInt(img.getAttribute('data-price'), 10) || 0;
              selectProduct(productCode, newStock, priceVal);
            };
            const content = card.querySelector('.product-content');
            if (content) {
              content.appendChild(addButton);
            }
          }

          if (addButton) {
            if (newStock === 0) {
              addButton.remove();
              let soldOutText = card.querySelector('.sold-out');
              if (!soldOutText) {
                soldOutText = document.createElement('div');
                soldOutText.classList.add('sold-out');
                soldOutText.style.color = 'red';
                soldOutText.style.fontWeight = 'bold';
                soldOutText.textContent = '【你來遲啦!】';
                const content = card.querySelector('.product-content');
                if (content) {
                  content.appendChild(soldOutText);
                }
              }
            } else {
              // 移除已存在的售完提示，並更新按鈕狀態
              const soldOutText = card.querySelector('.sold-out');
              if (soldOutText) soldOutText.remove();
              addButton.disabled = false;
              addButton.textContent = '加入背籃';
            }
          } else {
            // 若按鈕不存在且庫存大於 0，動態新增按鈕
            if (newStock > 0) {
              addButton = document.createElement('button');
              addButton.classList.add('btn-select');
              addButton.onclick = function() {
                const priceVal = parseInt(img.getAttribute('data-price'), 10) || 0;
                selectProduct(productCode, newStock, priceVal);
              };
              const content = card.querySelector('.product-content');
              if (content) {
                content.appendChild(addButton);
              }
              addButton.textContent = '加入背籃';
              addButton.disabled = false;
            } else {
              // 庫存為 0 時顯示售完文字
              const content = card.querySelector('.product-content');
              if (content && !content.querySelector('.sold-out')) {
                const soldOutText = document.createElement('div');
                soldOutText.classList.add('sold-out');
                soldOutText.style.color = 'red';
                soldOutText.style.fontWeight = 'bold';
                soldOutText.textContent = '【你來遲啦!】';
                content.appendChild(soldOutText);
              }
            }
          }
        });

        // 更新購物車中每個商品的庫存與數量限制邏輯
        for (let code in cart) {
          if (latestInventory.hasOwnProperty(code)) {
            cart[code].stock = latestInventory[code];
            if (cart[code].qty > latestInventory[code]) {
              if (!cart[code].originalQty) {
                cart[code].originalQty = cart[code].qty;
              }
              cart[code].adjusted = true;
              cart[code].qty = latestInventory[code];
              displayInventoryModal(code, latestInventory[code]);
            } else {
              if (cart[code].originalQty && cart[code].originalQty > latestInventory[code]) {
                cart[code].adjusted = true;
              } else {
                delete cart[code].adjusted;
                delete cart[code].originalQty;
              }
            }
          }
        }
        // 更新 localStorage 中的購物車資料
        localStorage.setItem("cart", JSON.stringify(cart));
      })
      .catch(error => {
        console.error('取得最新庫存錯誤：', error);
      });
  }

  // 使用防抖包裝 refreshProductCards()，例如延遲 500 毫秒
  const debouncedRefreshProductCards = debounce(refreshProductCards, 500);

  /*******************************************
   * 商品選取與 Modal 處理函式區
   *******************************************/
  // 統一使用最新庫存判斷是否進入數量輸入流程
  async function selectProduct(productCode, stock, price) { 
    // 記錄選取產品資訊
    currentQuantityProduct = { code: productCode, stock: stock, price: price };

    await debouncedRefreshProductCards(); // 使用防抖更新庫存

    // 從 DOM 重新取得最新庫存（轉為數字）
    const updatedStockStr = document.querySelector('[data-code="' + productCode + '"]')?.getAttribute('data-stock') || stock;
    const updatedStock = parseInt(updatedStockStr, 10);
    currentQuantityProduct.stock = updatedStock;

    // 若最新庫存為 0 則跳出流程
    if (updatedStock === 0) {
      showToast('你來遲啦!無法加入背籃！');
      return;
    }

    // 更新數量 Modal 的標題與提示訊息
    document.getElementById('quantityModalTitle').textContent = '輸入 ' + productCode + ' 數量';
    document.getElementById('quantityModalInfo').textContent = '請輸入數量 (最大 ' + updatedStock + ')';
    document.getElementById('quantityInput').value = '';
    document.getElementById('quantityError').style.display = 'none';

    // 根據購物車內是否已有此品項設定刪除按鈕的顯示
    if (!cart[productCode]) {
      document.getElementById('deleteButton').style.display = 'none';
    } else {
      document.getElementById('deleteButton').style.display = 'inline-block';
    }

    document.getElementById('quantityModal').classList.add('show');
  }

  // 為所有商品圖片加入點擊事件，點擊後顯示商品詳細 Modal
  document.querySelectorAll('.product-image').forEach(function(img) {
    img.addEventListener('click', async function() {
      await debouncedRefreshProductCards(); // 更新庫存資料
      var code = img.getAttribute('data-code');
      var intro = img.getAttribute('data-intro');
      var price = img.getAttribute('data-price');
      var updatedStockStr = img.getAttribute('data-stock') || '0';
      var updatedStock = parseInt(updatedStockStr, 10);
      var imageUrl = img.src;
      // 更新全域變數，供 Modal 使用
      currentModalProduct = { code: code, intro: intro, price: price, stock: updatedStock, imageUrl: imageUrl };
      // 開啟商品詳細資訊 Modal
      openProductModal(code, intro, price, updatedStock, imageUrl);
    });
  });

  // 當在商品 Modal 中點選「加入背籃」按鈕，進入數量選擇流程
  function modalSelectProduct() {
    if (currentModalProduct) {
      selectProduct(currentModalProduct.code, currentModalProduct.stock, parseInt(currentModalProduct.price, 10));
      closeModal('productModal');
    }
  }

  // 開啟商品詳細資訊 Modal（大圖與詳細描述）
  function openProductModal(code, intro, price, stock, imageUrl) {
    const stockNum = isNaN(stock) ? -1 : stock;
    document.getElementById('modalImage').src = imageUrl;
    document.getElementById('modalTitle').textContent = code;
    document.getElementById('modalDescription').textContent = intro;
    
    if (stockNum === -1) {
      document.getElementById('modalPrice').textContent = '';
      document.getElementById('modalSelectButton').style.display = 'none';
    } else if (stockNum === 0) {
      document.getElementById('modalPrice').textContent = '懿昇價: ' + price + ' / 數量: ' + stockNum;
      document.getElementById('modalSelectButton').style.display = 'none';
    } else {
      document.getElementById('modalPrice').textContent = '懿昇價: ' + price + ' / 數量: ' + stockNum;
      document.getElementById('modalSelectButton').style.display = 'inline-block';
      document.getElementById('modalSelectButton').textContent = '加入背籃';
      document.getElementById('modalSelectButton').disabled = false;
    }
    document.getElementById('productModal').classList.add('show');
  }

  // 關閉指定 ID 的 Modal（並在必要時恢復初始狀態）
  function closeModal(modalId) {
    var modal = document.getElementById(modalId);
    modal.classList.remove('show');

    if (modalId === 'quantityModal') {
      document.getElementById('quantityInput').style.display = '';
      document.getElementById('quantityError').style.display = 'none';
      var modalBtns = document.querySelectorAll('#quantityModal .btn-select');
      modalBtns.forEach(function(btn) {
        btn.style.display = '';
      });
    }
  }

  /*******************************************
   * 背籃與數量處理函式區
   *******************************************/
  // 初始只顯示一定數量的商品卡片
  function showInitialProducts() {
    var productCards = document.querySelectorAll('.product-card');
    productCards.forEach(function(card, index) {
      card.style.display = (index < pageSize) ? 'inline-block' : 'none';
    });
    currentProductIndex = pageSize;
    updateLoadMoreVisibility();
  }

  // 載入更多商品卡片
  function loadMoreProducts() {
    var productCards = document.querySelectorAll('.product-card');
    var count = 0;
    productCards.forEach(function(card) {
      if (card.style.display === 'none' && count < pageSize) {
        card.style.display = 'inline-block';
        count++;
      }
    });
    currentProductIndex += count;
    updateLoadMoreVisibility();
  }

  // 根據隱藏的卡片數量更新「載入更多」按鈕的可見性
  function updateLoadMoreVisibility() {
    var productCards = document.querySelectorAll('.product-card');
    var hiddenCards = Array.from(productCards).filter(card => card.style.display === 'none');
    var loadMoreBtn = document.getElementById('loadMoreBtn');
    loadMoreBtn.style.display = (hiddenCards.length === 0) ? 'none' : 'block';
  }

  // 編輯購物車中已有商品的數量
  function editCartItem(productCode) {
    var item = cart[productCode];
    if (item) {
      currentQuantityProduct = { code: productCode, stock: item.stock, price: item.price };
      document.getElementById('quantityModalTitle').textContent = '修改 ' + productCode + ' 數量';
      document.getElementById('quantityModalInfo').textContent = '請輸入數量 (最大 ' + item.stock + ')';
      document.getElementById('quantityInput').value = item.qty;
      document.getElementById('quantityError').style.display = 'none';
      document.getElementById('deleteButton').style.display = 'inline-block';
      document.getElementById('quantityModal').classList.add('show');
    }
  }

  // 驗證數量輸入是否正確
  function validateQuantity() {
    var qtyStr = document.getElementById('quantityInput').value;
    var errorElem = document.getElementById('quantityError');
    if (!qtyStr) {
      errorElem.textContent = '';
      errorElem.style.display = 'none';
      return;
    }
    var qty = parseInt(qtyStr, 10);
    if (isNaN(qty) || qty <= 0) {
      errorElem.textContent = '請輸入正確的數量';
      errorElem.style.display = 'block';
    } else if (qty > currentQuantityProduct.stock) {
      errorElem.textContent = '數量超過擁有 (最大 ' + currentQuantityProduct.stock + ')';
      errorElem.style.display = 'block';
    } else {
      errorElem.textContent = '';
      errorElem.style.display = 'none';
    }
  }

  // 確認數量輸入，更新購物車資料並同步 localStorage
  function confirmQuantity() {
    var qtyStr = document.getElementById('quantityInput').value;
    var errorElem = document.getElementById('quantityError');
    if (!qtyStr) {
      errorElem.textContent = '請輸入數量';
      errorElem.style.display = 'block';
      return;
    }
    var qty = parseInt(qtyStr, 10);
    if (isNaN(qty) || qty <= 0) {
      errorElem.textContent = '請輸入正確數量';
      errorElem.style.display = 'block';
      return;
    }
    if (qty > currentQuantityProduct.stock) {
      errorElem.textContent = '訂購數量超過擁有，最多 ' + currentQuantityProduct.stock;
      errorElem.style.display = 'block';
      return;
    }
    // 更新購物車資料
    cart[currentQuantityProduct.code] = { qty: qty, price: currentQuantityProduct.price, stock: currentQuantityProduct.stock };
    localStorage.setItem("cart", JSON.stringify(cart));
    updateCartDisplay();
    closeModal('quantityModal');
    showToast('採集已加入/更新至背籃');
  }

  // 從購物車中移除指定商品
  function deleteCartItem(productCode) {
    delete cart[productCode];
    updateCartDisplay();
    closeModal('quantityModal');
    showToast('已刪除 ' + productCode);
  }

  // 更新購物車顯示，包含庫存同步與金額計算
  function updateCartDisplay() {
    return refreshProductCards().then(() => {
      return fetchLatestInventory().then(latestInventory => {
        for (var code in cart) {
          if (latestInventory[code] === 0) {
            cart[code].outOfStock = true;
            delete cart[code].adjusted;
            currentQuantityProduct = { code: code, stock: 0, price: cart[code].price };
            document.getElementById('quantityModalTitle').textContent = '品項 ' + code + ' 已售罄';
            document.getElementById('quantityModalInfo').textContent = '此品項已無數量，請刪除。';
            document.getElementById('quantityInput').style.display = 'none';
            document.getElementById('quantityError').style.display = 'none';
            var modalBtns = document.querySelectorAll('#quantityModal .btn-select');
            modalBtns.forEach(function(btn) {
              if (btn.id !== 'deleteButton') {
                btn.style.display = 'none';
              }
            });
            document.getElementById('deleteButton').style.display = 'inline-block';
            document.getElementById('quantityModal').classList.add('show');
          } else {
            delete cart[code].outOfStock;
            if (cart[code].qty > latestInventory[code]) {
              if (!cart[code].originalQty) {
                cart[code].originalQty = cart[code].qty;
              }
              cart[code].adjusted = true;
              cart[code].qty = latestInventory[code];
              displayInventoryModal(code, latestInventory[code]);
            } else {
              if (cart[code].originalQty && cart[code].originalQty > latestInventory[code]) {
                cart[code].adjusted = true;
              } else {
                delete cart[code].adjusted;
                delete cart[code].originalQty;
              }
            }
          }
        }
        
        // 更新購物車摘要與 localStorage
        const cartDiv = document.getElementById('cartSummary');
        const keys = Object.keys(cart);
        document.getElementById('cartCount').textContent = keys.length;
        document.getElementById('openCartButton').style.backgroundColor =
          keys.length > 0 ? '#bd1111' : 'var(--primary-color)';
        localStorage.setItem("cart", JSON.stringify(cart));
        if (keys.length === 0) {
          cartDiv.innerHTML = '你的背籃空空也，趕緊填滿它吧!';
        } else {
          let html = '<ul>';
          let shippingFee = 65;
          let totalAmount = shippingFee;
          keys.forEach(function(code) {
            const item = cart[code];
            const subTotal = item.qty * item.price;
            totalAmount += subTotal;
            var extraText = '';
            if (item.adjusted) {
              extraText = '<span style="color:red; margin-left:8px;">【已調整為僅存數量!】</span>';
            } else if (item.qty === 0 || item.outOfStock) {
              extraText = '<span style="color:rgb(236, 26, 89); margin-left:8px;">【你慢一步啦!】</span>';
            }
            html += '<li>' + code + ': ' + item.qty + ' x ' + item.price + ' = ' + subTotal + ' 元'
                 + extraText
                 + ' <button onclick="editCartItem(&quot;' + code + '&quot;)" class="edit-button" aria-label="修改">修改</button>'
                 + '</li>';
          });
          html += '</ul>';
          html += '<p>運費: ' + shippingFee + ' 元</p>';
          html += '<p>總金額: <span class="total-amount">' + totalAmount + ' 元</span></p>';
          cartDiv.innerHTML = html;
        }
        return Promise.resolve();
      });
    }).catch(error => {
      console.error('更新庫存失敗：', error);
      return Promise.reject(error);
    });
  }

  // 顯示庫存不足提醒 Modal
  function displayInventoryModal(productCode, newStock) {
    document.getElementById('inventoryModalTitle').textContent = productCode + " 已經快到甕底啦!";
    document.getElementById('inventoryModalContent').textContent =
      "您所選擇的品項超出了目前數量，已自動調整為 " + newStock + "，請核對背籃裡的所有品項數量。";
    document.getElementById('inventoryModal').classList.add('show');
  }

  // 關閉庫存不足提醒 Modal
  function closeInventoryModal() {
    document.getElementById('inventoryModal').classList.remove('show');
  }

  // 從購物車中刪除指定商品後更新畫面
  function removeFromCart(productCode) {
    delete cart[productCode];
    updateCartDisplay();
    showToast('已刪除 ' + productCode);
  }

  /*******************************************
   * 提示訊息與其他 UI 互動函式區
   *******************************************/
  // 顯示暫時性提示訊息 (Toast)
  function showToast(message) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.backgroundColor = '#7f8a25';
    toast.style.color = '#fff';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '5px';
    toast.style.position = 'fixed';
    toast.style.bottom = '80px';
    toast.style.right = '20px';
    toast.style.opacity = 1;
    toast.style.transition = 'opacity 0.5s ease';
    
    setTimeout(function() {
      toast.style.opacity = 0;
    }, 3500);
  }

  // 切換展開/收起描述文字（部分/全部顯示）
  function toggleExpand(toggleElem) {
    var container = toggleElem.parentElement;
    var descriptionSpan = container.querySelector('.description-text');
    var fullTextSpan = container.querySelector('.full-text');
    if (toggleElem.textContent.trim() === '...展開') {
      descriptionSpan.textContent = fullTextSpan.textContent;
      toggleElem.textContent = ' 收起';
    } else {
      descriptionSpan.textContent = fullTextSpan.textContent.substring(0, 20);
      toggleElem.textContent = '...展開';
    }
  }

  // 切換漢堡選單（適用行動裝置版）
  function toggleHamburger() {
    var navMenu = document.getElementById('navMenu');
    navMenu.classList.toggle('active');
  }

  // 點擊空白處關閉 Modal（針對商品與數量 Modal）
  window.addEventListener('click', function(e) {
    var productModal = document.getElementById('productModal');
    var quantityModal = document.getElementById('quantityModal');
    if (e.target === productModal) {
      productModal.classList.remove('show');
    }
    if (e.target === quantityModal) {
      quantityModal.classList.remove('show');
    }
  });

  /*******************************************
   * 結帳流程處理
   *******************************************/
  // 前往結帳頁面前更新庫存與購物車資料，確保庫存資訊最新
  async function goToCheckout() {
    const productCodes = Object.keys(cart);
    if (productCodes.length === 0) {
      showEmptyCartModal();
      return;
    }
    for (let code of productCodes) {
      if (cart[code].qty === 0) {
        showToast(code + ' 的數量為 0，請確認數量後再結帳！');
        return;
      }
    }
    try {
      await refreshProductCards();
      await updateCartDisplay();
      if (Object.keys(cart).length === 0) {
        showEmptyCartModal();
        return;
      }
      window.location.href = "/order";
    } catch (error) {
      console.error("結帳時更新庫存發生錯誤：", error);
      alert("無法確認最新庫存，請稍後再試。");
    }
  }

  // 顯示空背籃提醒 Modal
  function showEmptyCartModal() {
    document.getElementById('emptyCartModal').classList.add('show');
  }
  // 關閉空背籃提醒 Modal
  function closeEmptyCartModal() {
    document.getElementById('emptyCartModal').classList.remove('show');
  }

  /*******************************************
   * 初始化與事件綁定
   *******************************************/
  // DOM 載入完成時初始化購物車資料與商品顯示
  window.addEventListener('DOMContentLoaded', function() {
    cart = JSON.parse(localStorage.getItem("cart") || "{}");
    updateCartDisplay();
    showInitialProducts();
  });

  // 為購物車按鈕設定點擊事件，更新購物車顯示
  document.addEventListener('DOMContentLoaded', function() {
    const openCartButton = document.getElementById('openCartButton');
    openCartButton.addEventListener('click', updateCartDisplay);
  });

  // 當 localStorage 中購物車資料改變時更新訂單摘要
  window.addEventListener('storage', function(e) {
    if (e.key === 'cart') {
      renderOrderSummary();
    }
  });
  
  // 請確認 renderOrderSummary() 函式是否有定義，
  // 若無，請根據您實際需求自行實作更新訂單摘要的邏輯

</script>

</body>
</html>`;
    // 傳送生成的 HTML 給使用者
    res.send(html);
  } catch (error) {
    console.error("Error generating order form:", error);
    res.status(500).send("Internal Server Error");
  }
});

// 訂購資料填寫頁面 (結帳流程中的第二步)
app.get('/order', (req, res) => {
  const html = `<!DOCTYPE html>  
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>訂購資料填寫</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
    /* 設定頁面樣式與表單樣式 */
    :root {
      --primary-color: #A3B18A;
      --primary-hover: #8B9B75;
      --accent-color: #FAD689;
      --text-color: #4D3B2F;
      --background-color: #F5F9ED;
      --border-color: #DCE2D0;
      --light-bg: #FFFFFF;
      --shadow-color: rgba(0, 0, 0, 0.1);
    }
    body {
      font-family: 'Noto Sans', sans-serif;
      background-color: var(--background-color);
      color: var(--text-color);
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 600px;
      background: var(--light-bg);
      margin: 40px auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: 0 2px 4px var(--shadow-color);
      text-align: center;
    }
    h1 {
      color: var(--primary-color);
      margin-bottom: 20px;
    }
    .order-summary-display {
      text-align: left;
      margin-bottom: 20px;
      border: 1px solid var(--border-color);
      padding: 10px;
      border-radius: 8px;
      background: var(--background-color);
    }
    .form-group {
      margin: 15px 0;
      text-align: left;
    }
    input[type="text"],
    input[type="email"],
    textarea {
      width: 100%;
      padding: 10px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-sizing: border-box;
    }
    button {
      background: var(--primary-color);
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1rem;
      margin-top: 15px;
    }
    button:hover { background: var(--primary-hover); }
    .modal {
      display: none;
      position: fixed;
      z-index: 1000;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      background-color: rgba(0,0,0,0.5);
    }
    .modal-content {
      background-color: var(--light-bg);
      margin: 15% auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      max-width: 400px;
      text-align: center;
    }
    .close {
      color: var(--text-color);
      float: right;
      font-size: 20px;
      font-weight: bold;
      cursor: pointer;
    }
    .close:hover {
      color: var(--primary-hover);
    }
    h1 {
      text-align: center;
    }
    .center-button {
      display: block;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <div class="container">
      <div class="order-summary-display">
        <h1>請核對訂購明細</h1> 
        <div id="orderSummaryDisplay"></div> 
        <button type="button" class="center-button" onclick="window.location.href='/'">返回首頁修改背籃</button>
      </div>
    <form id="orderForm" action="/submitOrder" method="POST">
    <h1>填寫訂購資料</h1>
      <div class="form-group">
        <label><strong>姓名</strong>(中文):</label>
        <input type="text" name="name" required>
      </div>
      <div class="form-group">
        <label><strong>手機</strong>(09開頭):</label>
        <input type="text" name="phone" required>
      </div>
      <div class="form-group">
        <label><strong>Email</strong>(Gmail):</label>
        <input type="email" name="email" required>
      </div>
      <div class="form-group">
        <label><strong>住址</strong>(例如:353苗栗縣...):</label>
        <input type="text" name="address" required>
      </div>
      <div class="form-group">
        <label><strong>帳號後五碼</strong>(對帳用):</label>
        <input type="text" name="accountLastFive" maxlength="5" required>
      </div>
      <div class="form-group">
        <label><strong>個人臉書</strong>(私訊用):</label>
        <input type="text" name="facebook">
      </div>
      <div class="form-group">
        <label><strong>備註</strong>(建議或留言):</label>
        <textarea name="remark" rows="3"></textarea>
      </div>
      <!-- 隱藏的背籃資料欄位，結帳時用於傳遞背籃內容 -->
      <div id="cartHiddenInputs"></div>
      <button type="submit" onclick="prepareCartInputs()">送出訂購</button>
    </form>
  </div>
  <!-- 訂單填寫錯誤提示 Modal -->
  <div id="errorModal" class="modal">
    <div class="modal-content">
      <span class="close" id="closeModal">&times;</span>
      <p id="errorMessage"></p>
    </div>
  </div>
  <script>
    // 以下為新增的函式，與首頁保持一致的庫存與購物車更新邏輯
    // 由於 /order 頁面本身並無商品卡片，此處 refreshProductCards 可僅回傳 resolved promise
    function refreshProductCards() {
      return Promise.resolve();
    }

    function fetchLatestInventory() {
      return fetch('/api/getLatestInventory')
        .then(response => response.json())
        .catch(error => {
          console.error('取得庫存資料錯誤：', error);
          return {};
        });
    }

    function updateCartDisplay() {
      return refreshProductCards().then(() => {
        return fetchLatestInventory().then(latestInventory => {
          // 讀取 localStorage 中的購物車資料，並同步更新訂單摘要（如有需要，也可根據最新庫存調整數量）
          var cart = JSON.parse(localStorage.getItem("cart") || "{}");
          // 此處可加入根據 latestInventory 的檢查，若購物車數量超過最新庫存則調整
          // 之後呼叫 renderOrderSummary() 更新訂單摘要顯示
          renderOrderSummary();
          return Promise.resolve();
        });
      }).catch(error => {
        console.error('更新庫存失敗：', error);
        return Promise.reject(error);
      });
    }

// renderOrderSummary() 實作：將購物車內容及總金額顯示於訂單摘要區
function renderOrderSummary() {
  var cart = JSON.parse(localStorage.getItem("cart") || "{}");
  var summaryDiv = document.getElementById("orderSummaryDisplay");
  var hiddenDiv = document.getElementById("cartHiddenInputs");
  var summaryHtml = "";
  var shippingFee = 65;
  var totalAmount = shippingFee;
  var codes = Object.keys(cart);
  if (codes.length === 0) {
    summaryHtml = "<p>你的背籃空空喔~趕緊填滿它吧！</p>";
  } else {
    codes.forEach(function(code) {
      var item = cart[code];
      var subTotal = item.qty * item.price;
      totalAmount += subTotal;
      // 檢查兩種情況：如果數量為 0，就加上紅色【你慢一步啦!】的標示，否則【已調整為僅存數量!】
      var extraText = "";
      if (item.qty === 0) {
        extraText = "<span style='color:rgb(236, 26, 89);'>【你慢一步啦!】</span>";
      } else if (item.adjusted) {
        extraText = "<span style='color:red; margin-left:8px;'>【已調整為僅存數量!】</span>";
      }
      summaryHtml += "<p>" + code + ": " + item.qty + " x " + item.price + " = " + subTotal + " 元" + extraText + "</p>";
    });
    summaryHtml += "<p>運費: " + shippingFee + " 元</p>";
    summaryHtml += "<p><strong>總金額: <span style='color: #c9302c;'>" + totalAmount + " 元</span></strong></p>";
  }
  summaryDiv.innerHTML = summaryHtml;
  // 隱藏欄位部分可視需求決定是否也傳遞庫存為0的品項，這裡保留所有項目
  hiddenDiv.innerHTML = "";
  if (codes.length > 0) {
    var selectedInput = document.createElement('input');
    selectedInput.type = 'hidden';
    selectedInput.name = 'selectedProducts';
    selectedInput.value = codes.join(',');
    hiddenDiv.appendChild(selectedInput);
    codes.forEach(function(code) {
      var qtyInput = document.createElement('input');
      qtyInput.type = 'hidden';
      qtyInput.name = 'quantity_' + code;
      qtyInput.value = cart[code].qty;
      hiddenDiv.appendChild(qtyInput);
    });
  }
}

    function prepareCartInputs() {
      renderOrderSummary();
    }

    // 當頁面 DOM 載入完成時，先更新購物車資料再渲染訂單摘要
    document.addEventListener('DOMContentLoaded', function() {
      updateCartDisplay()
        .then(function() {
          // 如更新庫存與購物車後訂單摘要將自動透過 renderOrderSummary() 呈現
        })
        .catch(function(error) {
          console.error("更新庫存與購物車資料失敗：", error);
        });
    });
    
    // 顯示錯誤 Modal 並傳入錯誤訊息
    function showModal(message) {
      document.getElementById("errorMessage").textContent = message;
      document.getElementById("errorModal").style.display = "block";
    }
    document.getElementById("closeModal").addEventListener("click", function() {
      document.getElementById("errorModal").style.display = "none";
    });
    window.addEventListener("click", function(event) {
      var modal = document.getElementById("errorModal");
      if (event.target == modal) {
        modal.style.display = "none";
      }
    });
    // 表單送出前進行資料驗證
    document.getElementById("orderForm").addEventListener("submit", function(event) {
      var name = this.elements["name"].value.trim();
      var phone = this.elements["phone"].value.trim();
      var email = this.elements["email"].value.trim();
      var address = this.elements["address"].value.trim();
      var accountLastFive = this.elements["accountLastFive"].value.trim();
      var nameRegex = /^[\u4E00-\u9FFF]+$/;
      if (!nameRegex.test(name)) {
        event.preventDefault();
        showModal("姓名必須以繁體中文輸入，不接受英文字母或其他符號！");
        return false;
      }
      var phoneRegex = /^09[0-9]{8}$/;
      if (!phoneRegex.test(phone)) {
        event.preventDefault();
        showModal("請輸入有效的台灣手機號碼（必須為09開頭的10位數字）！");
        return false;
      }
      var accountRegex = /^[0-9]{5}$/;
      if (!accountRegex.test(accountLastFive)) {
        event.preventDefault();
        showModal("帳號後五碼必須為剛好五位數字！");
        return false;
      }
      var emailRegex = /^[A-Za-z0-9._%+-]+@gmail\.com$/;
      if (!emailRegex.test(email)) {
        event.preventDefault();
        showModal("請輸入有效的 Gmail 地址（例如：xxx@gmail.com）！");
        return false;
      }
      var countyRegex = /^[0-9]{3}\s*(台北市|新北市|台中市|台南市|高雄市|基隆市|新竹縣|新竹市|苗栗縣|彰化縣|南投縣|雲林縣|嘉義縣|嘉義市|屏東縣|宜蘭縣|花蓮縣|台東縣|澎湖縣|金門縣|連江縣)/;
      if (!address || !countyRegex.test(address)) {
        event.preventDefault();
        showModal("住址必須填寫，且需以三位數郵遞區號及有效的縣市名稱開頭！");
        return false;
      }
    });
    
  </script>
</body>
</html>`;
  res.send(html);
});

// 1. POST /submitOrder：產生訂單確認頁面，同時生成一次性令牌
// 當使用者送出訂單資料時，處理訂單資料並生成訂單確認頁面
app.post('/submitOrder', async (req, res) => {
  try {
    console.log("req.body:", req.body);
    const { name, phone, email, address, accountLastFive, facebook, remark } = req.body;
    let selectedProducts = req.body.selectedProducts;
    if (!selectedProducts) {
      // 空背籃錯誤頁面
      return res.send(`
        <!DOCTYPE html>
        <html lang="zh-TW">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>錯誤提示</title>
          <style>
            body { font-family: 'Noto Sans', sans-serif; background: #F5F9ED; color: #4D3B2F; text-align: center; padding: 50px; }
            .error-container { border: 1px solid #DCE2D0; background: #fff; padding: 20px; border-radius: 10px; display: inline-block; }
            .error-message { font-size: 1.2rem; margin-bottom: 20px; }
            .back-button { padding: 10px 20px; background: #A3B18A; color: #fff; border: none; border-radius: 8px; text-decoration: none; }
            .back-button:hover { background: #8B9B75; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <div class="error-message">你的背籃空空喔~請返回背籃填滿他吧!</div>
            <a href="/" class="back-button">返回首頁</a>
          </div>
        </body>
        </html>
      `);
    }    
    // 解析背籃、組成 orderedItems
    selectedProducts = selectedProducts.split(',');
    const orderedItems = {};
    selectedProducts.forEach(code => {
      const qty = parseInt(req.body['quantity_' + code], 10) || 0;
      if (qty > 0) orderedItems[code] = qty;
    });
    if (Object.keys(orderedItems).length === 0) {
      // 無有效訂購數量錯誤頁面
      return res.send(`
        <!DOCTYPE html>
        <html lang="zh-TW">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>錯誤提示</title>
          <style>
            body { font-family: 'Noto Sans', sans-serif; background: #F5F9ED; color: #4D3B2F; text-align: center; padding: 50px; }
            .error-container { border: 1px solid #DCE2D0; background: #fff; padding: 20px; border-radius: 10px; display: inline-block; }
            .error-message { font-size: 1.2rem; margin-bottom: 20px; }
            .back-button { padding: 10px 20px; background: #A3B18A; color: #fff; border: none; border-radius: 8px; text-decoration: none; }
            .back-button:hover { background: #8B9B75; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <div class="error-message">請至少選則一個品項且填寫數量大於 0。</div>
            <a href="/" class="back-button">返回首頁</a>
          </div>
        </body>
        </html>
      `);
    }    

    // 從 Google Sheets 取得最新的庫存與價格資料
     // 只用一次 values.get 讀 A:F 四欄：MainCat, CatIntro, Code, Intro, Stock, Price
     const invRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!A:F`
    });
    const rows = invRes.data.values || [];
    // 組 productPrices，只留 stock !== -1
    const productPrices = {};
    for (let i = 1; i < rows.length; i++) {
      const [ , , code, , stockStr, priceStr ] = rows[i];
      const stock = parseInt(stockStr, 10);
      if (!code || stock === -1) continue;
      productPrices[code] = parseInt(priceStr, 10) || 0;
    }
    if (Object.keys(productPrices).length === 0) {
      return res.status(500).send("價格資料讀取失敗");
    }
 
     // 計算金額
    let totalAmount = 0;
    const shippingFee = 65;
    const summaryLines = [];
    for (const code in orderedItems) {
      const qty = orderedItems[code];
      const unitPrice = productPrices[code] || 0;
      const subTotal = qty * unitPrice;
      summaryLines.push(`${code}: ${qty} x ${unitPrice} = ${subTotal} 元`);
      totalAmount += subTotal;
    }
    totalAmount += shippingFee;
    summaryLines.push(`運費: ${shippingFee} 元`);
    const orderSummaryText = summaryLines.join('<br>');

    // 生成一次性令牌
    const orderToken = nanoid();
    req.session.orderToken = orderToken;

    // 生成訂單確認頁面 HTML，該頁面的表單會提交到 POST /confirmOrder
    const confirmationHtml = `<!DOCTYPE html> 
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>訂單確認</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
    /* 設定訂單確認頁面的樣式 */
    :root {
      --primary-color: #A3B18A;
      --primary-hover: #8B9B75;
      --accent-color: #FAD689;
      --text-color: #4D3B2F;
      --background-color: #F5F9ED;
      --border-color: #DCE2D0;
      --light-bg: #FFFFFF;
      --shadow-color: rgba(0, 0, 0, 0.1);
    }
    body {
      font-family: 'Noto Sans', sans-serif;
      background-color: var(--background-color);
      color: var(--text-color);
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 600px;
      background: var(--light-bg);
      margin: 40px auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: 0 2px 4px var(--shadow-color);
    }
    h1 {
      text-align: center;
      color: var(--primary-color);
      margin-bottom: 20px;
    }
    .order-details p {
      margin: 10px 0;
      line-height: 1.6;
    }
    .order-summary {
      background: var(--background-color);
      padding: 10px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    form { 
      text-align: center; 
    }
    button {
      background: var(--primary-color);
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1rem;
      margin: 5px;
    }
    button:hover { 
      background: var(--primary-hover); 
    }
    #waitMessage {
      display: none;
      text-align: center;
      margin-top: 20px;
      font-weight: bold;
      color: var(--primary-color);
    }
  </style>
</head>
<body>
<div class="container">
  <h1>訂單確認</h1>
  <form action="confirmOrder" method="POST" onsubmit="return showWaitMessage();">
    <!-- 按鈕直接在標題下方，設定 id 用以後續隱藏 -->
    <button id="confirmButton" type="submit" name="action" value="confirm">確定</button>
    <button id="cancelButton" type="submit" name="action" value="cancel">取消</button>
    <!-- 隱藏欄位 -->
    <!-- 隱藏欄位包含訂單資料與一次性令牌 -->
    <input type="hidden" name="orderToken" value="${orderToken}">
    <input type="hidden" name="name" value="${name}">
    <input type="hidden" name="phone" value="${phone}">
    <input type="hidden" name="email" value="${email}">
    <input type="hidden" name="address" value="${address}">
    <input type="hidden" name="accountLastFive" value="${accountLastFive}">
    <input type="hidden" name="facebook" value="${facebook || ''}">
    <input type="hidden" name="remark" value="${remark || ''}">
    <input type="hidden" name="orderSummaryText" value="${encodeURIComponent(orderSummaryText)}">
    <input type="hidden" name="totalAmount" value="${totalAmount}">
    <input type="hidden" name="orderedItems" value="${encodeURIComponent(JSON.stringify(orderedItems))}">
  </form>
  
  <!-- 訊息區塊，預設隱藏 -->
  <div id="waitMessage">
    請等候3~5秒，系統正在生成訂單...
  </div>
  
  <div class="order-details">
    <p><strong>姓名:</strong> ${name}</p>
    <p><strong>電話:</strong> ${phone}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>住址:</strong> ${address}</p>
    <p><strong>帳號後五碼:</strong> ${accountLastFive}</p>
    <p><strong>個人臉書:</strong> ${facebook || ''}</p>
    <p><strong>備註:</strong> ${remark || ''}</p>
  </div>
  <div class="order-summary">
    <p><strong>訂購明細:</strong></p>
    <p>${orderSummaryText}</p>
    <p><strong>總金額:</strong> <span style="color:rgb(194, 20, 58);">${totalAmount} 元</span></p>
  </div>
</div>
<script>
  function showWaitMessage() {
    // 顯示等待訊息
    document.getElementById('waitMessage').style.display = 'block';
    // 隱藏「確定」按鈕
    document.getElementById('confirmButton').style.display = 'none';
    // 隱藏「取消」按鈕
    document.getElementById('cancelButton').style.display = 'none';
    return true; // 繼續提交表單
  }
</script>
</body>
</html>`;
    res.send(confirmationHtml);
  } catch (error) {
    console.error("Error in /submitOrder:", error);
    res.status(500).send("Internal Server Error");
  }
});
// 2. POST /confirmOrder：檢查一次性令牌，進行最終訂單處理，並重定向至 GET /confirmOrder
// 當用戶在訂單確認頁面按下「確定」後，進行最終訂單處理，並使用 PRG 模式重定向到 GET /confirmOrder
app.post('/confirmOrder', async (req, res) => {
  try {
    const { action, orderToken } = req.body;
    // 檢查一次性令牌是否存在且有效
    if (!req.session.orderToken || req.session.orderToken !== orderToken) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="zh-TW">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>錯誤</title>
          <style>
            body { font-family: 'Noto Sans', sans-serif; background: #F5F9ED; color: #4D3B2F; text-align: center; padding: 50px; }
            .error-container { border: 1px solid #DCE2D0; background: #fff; padding: 20px; border-radius: 10px; display: inline-block; }
            .error-message { font-size: 1.2rem; margin-bottom: 20px; }
            .back-button { padding: 10px 20px; background: #A3B18A; color: #fff; border: none; border-radius: 8px; text-decoration: none; }
            .back-button:hover { background: #8B9B75; }
          </style>
        </head>
        <body>
          <div class="error-container">
            <div class="error-message">此訂單已提交，請勿重複提交。</div>
            <a href="/" class="back-button">返回首頁</a>
          </div>
        </body>
        </html>
      `);
    }    
    // 清除令牌，防止重複提交
    req.session.orderToken = null;

    if (action === 'cancel') {
      // 取消訂單時導回首頁
      return res.redirect('/');
    } else if (action === 'confirm') {
      const { name, phone, email, address, accountLastFive, facebook, remark,
              orderSummaryText, totalAmount, orderedItems } = req.body;
      const decodedSummary = decodeURIComponent(orderSummaryText);
      const orderedItemsObj = JSON.parse(decodeURIComponent(orderedItems));
      const orderId = nanoid(5); // 生成 5 字元的訂單 ID

      // 1) 一次讀取整張長表格 A:F（含 MainCat、CatIntro、Code、Intro、Stock、Price）
    const invRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${INVENTORY_SHEET}!A:F`
    });
    const rows = invRes.data.values || [];
    if (rows.length < 2) {
      return res.status(500).send("庫存資料讀取失敗");
    }

    // 2) 找出要更新的庫存，並檢查是否足夠
    //    rows[0] 是標題，實際資料從 rows[1] 開始
    const updates = [];
    for (const code in orderedItemsObj) {
      const qty = orderedItemsObj[code];
      // 在 rows 中搜尋 code
      const idx = rows.findIndex((r, i) => i > 0 && r[2] === code);
      if (idx < 1) {
        return res.send(`找不到品項 ${code} 的庫存資料`);
      }
      const stockStr = rows[idx][4] || '0';
      const currentStock = parseInt(stockStr, 10);
      if (currentStock < qty) {
        // 庫存不足，直接顯示錯誤頁面
        return res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>庫存不足</title>
  <style>
    body { 
      font-family: 'Noto Sans', sans-serif; 
      background: #F5F9ED; 
      color: #4D3B2F; 
      text-align: center; 
      padding: 50px; 
    }
    .error-container { 
      border: 1px solid #DCE2D0; 
      background: #fff; 
      padding: 20px; 
      border-radius: 10px; 
      display: inline-block; 
    }
    .error-message { 
      font-size: 1.2rem; 
      margin-bottom: 20px; 
    }
    .back-button { 
      padding: 10px 20px; 
      background: #A3B18A; 
      color: #fff; 
      border: none; 
      border-radius: 8px; 
      text-decoration: none; 
    }
    .back-button:hover { 
      background: #8B9B75; 
    }
  </style>
</head>
<body>
  <div class="error-container">
    <div class="error-message">
      <p>你慢來一步啦!<br>${code} 數量為：${currentStock}</p>
    </div>
    <a href="/" class="back-button">返回首頁</a>
  </div>
</body>
</html>`);
        }
        const newStock = currentStock - qty;
      // E 欄是第 5 欄，對應 rows[*][4]，實際儲存格是 E{idx+1}
      updates.push({
        range: `${INVENTORY_SHEET}!E${idx + 1}`,
        values: [[newStock]]
      });
    }

    // 3) 批次更新庫存
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          valueInputOption: 'USER_ENTERED',
          data: updates
        }
      });
    }
    
      // 4) 寫入訂單、通知、重導向
    // 訂單建立的時間（台北時間）
      const taipeiTime = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
      // 建立新訂單資料行，包含訂單編號、使用者資料、訂單摘要、總金額與訂單時間
      const newRow = [
        orderId,
        name,
        phone,
        email,
        address,
        accountLastFive,
        facebook || '',
        remark || '',
        decodedSummary,
        totalAmount,
        taipeiTime
      ];
      // 寫入訂單資料至訂單工作表
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${ORDERS_SHEET}!A:K`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [newRow] }
      });
      // 發送 Discord 通知
      const discordMessage = `
**有新訂購通知!**
訂單編號：${orderId}
姓名：${name}
電話：${phone}
Email：${email}
住址：${address}
個人臉書：${facebook || ''}
備註：${remark || ''}
訂購明細：${decodedSummary}
總金額：${totalAmount} 元
訂單時間：${taipeiTime}
      `;
      try {
        await axios.post(DISCORD_WEBHOOK_URL, { content: discordMessage });
        console.log("Discord 通知已發送");
      } catch (discordError) {
        console.error("Discord 通知錯誤:", discordError);
      }
      // 發送訂單確認信
      const mailOptions = {
        from: '"懿昇土地藝術生活訂購單" <your-email@gmail.com>',
        to: email,
        subject: "訂購懿昇確認信",
        text: `您好 ${name}, 您的訂單已生成，訂單編號: ${orderId}\n訂單明細: ${decodedSummary}\n總金額: ${totalAmount}\n請記下訂單編號以供查詢訂單使用。`,
        html: `<p>您好 ${name},</p>
        <p>感謝您的訂購，<br>您的訂單已成立。</p>
        <p style="color: red;">-----轉帳匯款資訊-----</p>
        <p style="color: red;">中華郵政(代碼:700)</p>
        <p style="color: red;">戶名：李懿宣</p>
        <p style="color: red;">帳號：<strong>00413220515625</strong></p>
        <p><strong>訂單明細：</strong><br>${decodedSummary}</p>
        <p><strong>總金額：</strong><span style="color:rgb(194, 20, 58);">${totalAmount} 元</span></p>
        <p><strong>訂購時間：</strong><br>${taipeiTime}</p>
        <p><strong>按下編號查詢訂單:</strong><br><a href="https://order013.de.r.appspot.com/queryOrder?orderId=${orderId}" style="display: inline-block; padding: 10px 20px; background-color:rgb(125, 173, 13); color: #ffffff; text-decoration: none; border-radius: 4px;">${orderId}</a></p>
        <p>謝謝您的訂購！</p>`
      };
      try {
        await transporter.sendMail(mailOptions);
        console.log("確認信已寄出");
      } catch (emailError) {
        console.error("寄送確認信錯誤:", emailError);
      }
      // 完成訂單處理後，使用重定向導向 GET /confirmOrder
      res.redirect(`/confirmOrder?orderId=${orderId}`);
    }
  } catch (error) {
    console.error("Error in POST /confirmOrder:", error);
    res.status(500).send(`
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>錯誤</title>
      <style>
        body { font-family: 'Noto Sans', sans-serif; background: #F5F9ED; color: #4D3B2F; text-align: center; padding: 50px; }
        .error-container { border: 1px solid #DCE2D0; background: #fff; padding: 20px; border-radius: 10px; display: inline-block; }
        .error-message { font-size: 1.2rem; margin-bottom: 20px; }
        .back-button { padding: 10px 20px; background: #A3B18A; color: #fff; border: none; border-radius: 8px; text-decoration: none; }
        .back-button:hover { background: #8B9B75; }
      </style>
    </head>
    <body>
      <div class="error-container">
        <div class="error-message">系統發生錯誤，請稍後再試。</div>
        <a href="/" class="back-button">返回首頁</a>
      </div>
    </body>
    </html>
  `);
  }
});

// 3. GET /confirmOrder：最終訂單完成頁面，禁止緩存，清除 localStorage 資料
// 用來顯示最終的訂單完成頁面，並清除瀏覽器歷史紀錄與購物車資料
app.get('/confirmOrder', (req, res) => {
  const { orderId } = req.query;
  if (!orderId) {
    return res.redirect('/');
  }
  // 設定禁止緩存的 HTTP 標頭
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>訂單完成</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
    /* 訂單完成頁面樣式設定 */
    :root {
      --primary-color: #A3B18A;
      --primary-hover: #8B9B75;
      --accent-color: #FAD689;
      --text-color: #4D3B2F;
      --background-color: #F5F9ED;
      --border-color: #DCE2D0;
      --light-bg: #FFFFFF;
      --shadow-color: rgba(0, 0, 0, 0.1);
    }
    body {
      font-family: 'Noto Sans', sans-serif;
      background-color: var(--background-color);
      color: var(--text-color);
      padding: 20px;
      margin: 0;
      text-align: center;
    }
    .container {
      max-width: 600px;
      background: var(--light-bg);
      margin: 40px auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: 0 2px 4px var(--shadow-color);
    }
    h1 {
      color: var(--primary-color);
      margin-bottom: 20px;
    }
    a {
      display: inline-block;
      margin-top: 20px;
      padding: 10px 20px;
      background: var(--primary-color);
      color: #fff;
      border-radius: 8px;
      text-decoration: none;
    }
    a:hover {
      background: var(--primary-hover);
    }
    button.order-button {
      cursor: pointer;
      padding: 5px 10px;
      background-color: var(--primary-color);
      color: #fff;
      border: none;
      border-radius: 5px;
      font-size: 1rem;
    }
    button.order-button:hover {
      background-color: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>訂單已生成</h1>
    <p style="color: red;">-----轉帳匯款資訊-----</p>
    <p style="color: red;">中華郵政(代碼:700)</p>
    <p style="color: red;">戶名：李懿宣</p>
    <p style="color: red;">帳號：<strong>00413220515625</strong></p>
    <p>
      請按下訂單編號查詢訂單:
      <button class="order-button" onclick="window.location.href='/queryOrder?orderId=${orderId}'">
        ${orderId}
      </button>
    </p>
    <p>確認信已寄送至您的 Email。</p>
    <p>若未收到，請檢查垃圾郵件夾。</p>
    <a href="/">返回訂購頁面</a>
  </div>
  <script>
    // 替換目前的歷史紀錄，避免返回到包含表單提交的頁面
    history.replaceState(null, null, window.location.href);
    // 清除 localStorage 中的購物車資料
    localStorage.removeItem('cart');
  </script>
</body>
</html>`;
  res.send(html);
});


// 訂單查詢頁面，使用者可根據訂單編號查詢訂單資料
app.get('/queryOrder', async (req, res) => {
  try {
    if (!req.query.orderId) {
      // 若未傳入訂單編號，則顯示查詢表單頁面
      const queryHtml = `<!DOCTYPE html> 
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>訂單查詢</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
    /* 設定查詢頁面樣式 */
    :root {
      --primary-color: #A3B18A;
      --primary-hover: #8B9B75;
      --accent-color: #FAD689;
      --text-color: #4D3B2F;
      --background-color: #F5F9ED;
      --border-color: #DCE2D0;
      --light-bg: #FFFFFF;
      --shadow-color: rgba(0, 0, 0, 0.1);
    }
    body {
      font-family: 'Noto Sans', sans-serif;
      background-color: var(--background-color);
      color: var(--text-color);
      padding: 20px;
      margin: 0;
    }
    .container {
      max-width: 600px;
      background: var(--light-bg);
      margin: 40px auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: 0 2px 4px var(--shadow-color);
      text-align: center;
    }
    h1 {
      color: var(--primary-color);
      margin-bottom: 20px;
    }
    form {
      margin-top: 20px;
    }
    input[type="text"] {
      padding: 10px;
      width: 80%;
      margin-bottom: 20px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
    }
    /* 將按鈕放在同一行 */
    .button-group {
      display: inline-block;
    }
    .button-group button {
      background: var(--primary-color);
      color: #fff;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 1rem;
      margin-right: 10px;
    }
    .button-group button:hover {
      background: var(--primary-hover);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>訂單查詢</h1>
    <form action="/queryOrder" method="GET">
      <input type="text" name="orderId" placeholder="請輸入訂單編號" required>
      <div class="button-group">
        <button type="submit">查詢</button>
        <button type="button" onclick="window.location.href='/'">返回首頁</button>
      </div>
    </form>
  </div>
</body>
</html>`;
      return res.send(queryHtml);
    }
    const { orderId } = req.query;
    // 從 Google Sheets 中讀取所有訂單資料
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ORDERS_SHEET}!A:K`
    });
    const rows = result.data.values;
    if (rows && rows.length) {
      // 根據訂單編號搜尋符合的訂單資料
      const order = rows.find(function(row) {
        return row[0] === orderId;
      });
      if (order) {
        // 顯示訂單查詢結果頁面
        res.send(`<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>訂單查詢結果</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&display=swap">
  <style>
    /* 設定查詢結果頁面樣式 */
    :root {
      --primary-color: #A3B18A;
      --primary-hover: #8B9B75;
      --accent-color: #FAD689;
      --text-color: #4D3B2F;
      --background-color: #F5F9ED;
      --border-color: #DCE2D0;
      --light-bg: #FFFFFF;
      --shadow-color: rgba(0, 0, 0, 0.1);
    }
    body {
      font-family: 'Noto Sans', sans-serif;
      background-color: var(--background-color);
      color: var(--text-color);
      padding: 20px;
      margin: 0;
    }
    .order-summary {
      background: var(--background-color);
      padding: 10px;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .button {
      display: inline-block;
      background: var(--primary-color);
      color: #fff;
      padding: 10px 20px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 1rem;
      margin: 5px;
      cursor: pointer;
    }
    .button:hover {
      background: var(--primary-hover);
    }
    .container {
      max-width: 600px;
      background: var(--light-bg);
      margin: 40px auto;
      padding: 20px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      box-shadow: 0 2px 4px var(--shadow-color);
    }
    h1 {
      text-align: center;
      color: var(--primary-color);
      margin-bottom: 20px;
    }
    .order-info p {
      margin: 8px 0;
      line-height: 1.6;
    }
    a {
      display: block;
      text-align: center;
      margin-top: 20px;
      color: var(--primary-color);
      text-decoration: none;
      font-size: 1.1rem;
    }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>訂單查詢結果</h1>
    <div class="order-info">
      <p><strong>訂單編號:</strong> ${order[0]}</p>
      <p><strong>姓名:</strong> ${order[1]}</p>
      <p><strong>電話:</strong> ${order[2]}</p>
      <p><strong>Email:</strong> ${order[3]}</p>
      <p><strong>住址:</strong> ${order[4]}</p>
      <p><strong>帳號後五碼:</strong> ${order[5]}</p>
      <p><strong>個人臉書:</strong> ${order[6]}</p>
      <p><strong>備註:</strong> ${order[7]}</p>
      <div class="order-summary">
      <p><strong>訂購明細:</strong></p>
      <p>${order[8]}</p>
      <p><strong>總金額：</strong><span style="color:rgb(194, 20, 58);">${order[9]} 元</span></p>
      <p>訂單時間: ${order[10]}</p>
      </div>
    </div>
<a class="button" href="/queryOrder">返回查詢頁面</a>
<a class="button" href="/">返回訂購頁面</a>
  </div>
</body>
</html>`);
      } else {
        return res.send(`
          <!DOCTYPE html>
          <html lang="zh-TW">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>錯誤提示</title>
            <style>
              body { font-family: 'Noto Sans', sans-serif; background: #F5F9ED; color: #4D3B2F; text-align: center; padding: 50px; }
              .error-container { border: 1px solid #DCE2D0; background: #fff; padding: 20px; border-radius: 10px; display: inline-block; }
              .error-message { font-size: 1.2rem; margin-bottom: 20px; }
              .back-button { padding: 10px 20px; background: #A3B18A; color: #fff; border: none; border-radius: 8px; text-decoration: none; }
              .back-button:hover { background: #8B9B75; }
            </style>
          </head>
          <body>
            <div class="error-container">
              <div class="error-message">找不到該訂單編號，請確認後重試。</div>
              <a href="/" class="back-button">返回首頁</a>
            </div>
          </body>
          </html>
        `);
      }
    } else {
      res.send('目前無訂單資料。');
    }
  } catch (error) {
    console.error("Error in /queryOrder:", error);
    res.status(500).send("Internal Server Error");
  }
});

// 啟動伺服器，監聽指定的 PORT
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

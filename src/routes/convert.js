'use strict';

/**
 * /api/convert 路由
 * POST /api/convert/images-to-pptx  接收多张图片 → 返回 PDF（用 pdf-lib 合并，无水印）
 * POST /api/convert/pdf-to-word      接收 PDF    → 返回 DOCX（Cloudmersive API）
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { PDFDocument } = require('pdf-lib');
const { getDb } = require('../db');
const { checkQuota, recordUsage, getUserId } = require('./usage');

// ─── Cloudmersive PDF → DOCX ──────────────────────────────
const CLOUDMERSIVE_API_KEY = process.env.CLOUDMERSIVE_API_KEY || '1b8cac71-9e46-47af-821f-1ef1a8329c97';

/**
 * 调用 Cloudmersive /convert/pdf/to/docx
 * pdfBuffer: Buffer
 * 返回: Buffer (docx)
 */
function cloudmersivePdfToDocx(pdfBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = 'Boundary-' + Date.now();
    const CRLF = '\r\n';

    const header = Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="inputFile"; filename="scan_result.pdf"${CRLF}` +
      `Content-Type: application/pdf${CRLF}${CRLF}`
    );
    const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
    const body = Buffer.concat([header, pdfBuffer, footer]);

    const options = {
      hostname: 'api.cloudmersive.com',
      path: '/convert/pdf/to/docx',
      method: 'POST',
      headers: {
        'Apikey': CLOUDMERSIVE_API_KEY,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Cloudmersive 响应 ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── 工具：base64 → Buffer ────────────────────────────────
function base64ToBuffer(base64) {
  return Buffer.from(base64, 'base64');
}

function base64ToTmp(base64, ext) {
  const buf = base64ToBuffer(base64);
  const tmpPath = path.join(os.tmpdir(), `scan_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// ─── POST /api/convert/images-to-pptx ───────────────────
// Body: { images: ["base64...", "base64..."] }
// 用 pdf-lib 把图片合并为 PDF，无水印，无外部依赖
router.post('/images-to-pptx', async (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: '请提供图片数组 images[]' });
  }

  // ── 使用量卡控 ──
  const user = getUserId(req);
  if (!user) return res.status(400).json({ error: '缺少用户标识（需要登录或提供 X-Device-UUID）' });

  try {
    const db = await getDb();
    const quota = await checkQuota(db, user.id, 'images_pdf');
    if (!quota.allowed) {
      return res.status(402).json({
        error: 'quota_exceeded',
        feature: 'images_pdf',
        used: quota.used,
        limit: quota.limit,
        message: '已超过免费次数，请购买VIP后继续使用',
      });
    }

    console.log(`[convert] images-to-pdf 开始，共 ${images.length} 张图片`);

    const pdfDoc = await PDFDocument.create();

    for (let i = 0; i < images.length; i++) {
      const buf = base64ToBuffer(images[i]);

      // 判断图片类型（jpg / png），pdf-lib 都支持
      let img;
      // JPEG 魔数 FF D8
      if (buf[0] === 0xff && buf[1] === 0xd8) {
        img = await pdfDoc.embedJpg(buf);
      } else {
        // 默认当 PNG 处理
        img = await pdfDoc.embedPng(buf);
      }

      // 每张图片占一页，页面尺寸与图片尺寸一致（保持原始比例）
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const pdfBytes = await pdfDoc.save();
    const outputPath = path.join(os.tmpdir(), `pdf_${Date.now()}.pdf`);
    fs.writeFileSync(outputPath, pdfBytes);

    console.log(`[convert] images-to-pdf 完成：${outputPath}`);

    // 转换成功后记录使用量
    await recordUsage(db, user.id, 'images_pdf');

    res.download(outputPath, 'document.pdf', err => {
      if (err) console.error('[convert] 下载失败', err);
      try { fs.unlinkSync(outputPath); } catch {}
    });
  } catch (err) {
    console.error('[convert] images-to-pdf 失败:', err.message);
    res.status(500).json({ error: '转换失败：' + err.message });
  }
});

// ─── POST /api/convert/pdf-to-word ───────────────────────
// Body: { pdf: "base64..." }
router.post('/pdf-to-word', async (req, res) => {
  const { pdf } = req.body;
  if (!pdf) return res.status(400).json({ error: '请提供 pdf base64 字符串' });

  // ── 使用量卡控 ──
  const user = getUserId(req);
  if (!user) return res.status(400).json({ error: '缺少用户标识（需要登录或提供 X-Device-UUID）' });

  try {
    const db = await getDb();
    const quota = await checkQuota(db, user.id, 'pdf_word');
    if (!quota.allowed) {
      return res.status(402).json({
        error: 'quota_exceeded',
        feature: 'pdf_word',
        used: quota.used,
        limit: quota.limit,
        message: '已超过免费次数，请购买VIP后继续使用',
      });
    }

    console.log('[convert] pdf-to-word 开始（Cloudmersive）');
    const pdfBuffer = base64ToBuffer(pdf);
    const docxBuffer = await cloudmersivePdfToDocx(pdfBuffer);

    const outputPath = path.join(os.tmpdir(), `word_${Date.now()}.docx`);
    fs.writeFileSync(outputPath, docxBuffer);
    console.log('[convert] pdf-to-word 完成');

    // 转换成功后记录使用量
    await recordUsage(db, user.id, 'pdf_word');

    res.download(outputPath, 'document.docx', err => {
      if (err) console.error('[convert] 下载失败', err);
      try { fs.unlinkSync(outputPath); } catch {}
    });
  } catch (err) {
    console.error('[convert] pdf-to-word 失败:', err.message);
    res.status(500).json({ error: '转换失败：' + err.message });
  }
});

module.exports = router;

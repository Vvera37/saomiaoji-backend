'use strict';

/**
 * /api/convert 路由
 * POST /api/convert/images-to-pptx  接收多张图片 → 返回 PPTX 下载
 * POST /api/convert/pdf-to-word      接收 PDF    → 返回 DOCX 下载
 *
 * 图片以 base64 JSON 上传，避免 multer 依赖
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { imagesToPptx, pdfToWord } = require('../ilovepdf');

// ─── 工具：base64 → 临时文件 ─────────────────────────────
function base64ToTmp(base64, ext) {
  const buf = Buffer.from(base64, 'base64');
  const tmpPath = path.join(os.tmpdir(), `scan_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

// ─── POST /api/convert/images-to-pptx ───────────────────
// Body: { images: ["base64...", "base64..."] }
router.post('/images-to-pptx', async (req, res) => {
  const { images } = req.body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: '请提供图片数组 images[]' });
  }

  const tmpImages = [];
  const outputPath = path.join(os.tmpdir(), `ppt_${Date.now()}.pptx`);

  try {
    // base64 → 临时 jpg 文件
    for (const b64 of images) {
      tmpImages.push(base64ToTmp(b64, 'jpg'));
    }

    console.log(`[convert] images-to-pptx 开始，共 ${images.length} 张图片`);
    await imagesToPptx(tmpImages, outputPath);
    console.log(`[convert] images-to-pptx 完成：${outputPath}`);

    // 下载后删除临时文件
    res.download(outputPath, 'presentation.pptx', err => {
      if (err) console.error('[convert] 下载失败', err);
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    console.error('[convert] images-to-pptx 失败:', err.message);
    res.status(500).json({ error: '转换失败：' + err.message });
  } finally {
    tmpImages.forEach(p => { try { fs.unlinkSync(p); } catch {} });
  }
});

// ─── POST /api/convert/pdf-to-word ───────────────────────
// Body: { pdf: "base64..." }
router.post('/pdf-to-word', async (req, res) => {
  const { pdf } = req.body;
  if (!pdf) return res.status(400).json({ error: '请提供 pdf base64 字符串' });

  const tmpPdf = base64ToTmp(pdf, 'pdf');
  const outputPath = path.join(os.tmpdir(), `word_${Date.now()}.docx`);

  try {
    console.log('[convert] pdf-to-word 开始');
    await pdfToWord(tmpPdf, outputPath);
    console.log('[convert] pdf-to-word 完成');

    res.download(outputPath, 'document.docx', err => {
      if (err) console.error('[convert] 下载失败', err);
      fs.unlinkSync(outputPath);
    });
  } catch (err) {
    console.error('[convert] pdf-to-word 失败:', err.message);
    res.status(500).json({ error: '转换失败：' + err.message });
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch {}
  }
});

module.exports = router;

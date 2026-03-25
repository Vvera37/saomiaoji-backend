'use strict';

/**
 * /api/ocr 路由
 * POST /api/ocr/handwriting  接收图片 base64 → 调用 OpenRouter Claude Vision → 返回识别文字
 */

const express = require('express');
const router = express.Router();
const https = require('https');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * 调用 OpenRouter Claude Vision 识别图片文字
 * imageBase64: string (jpeg base64, 不含 data:image 前缀)
 */
function claudeOCR(imageBase64) {
  return new Promise((resolve, reject) => {
    if (!OPENROUTER_API_KEY) {
      return reject(new Error('未配置 OPENROUTER_API_KEY'));
    }

    const bodyObj = {
      model: 'anthropic/claude-sonnet-4.6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`
              }
            },
            {
              type: 'text',
              text: '请识别图片中的所有文字内容，包括印刷体和手写体。要求：\n1. 无论原文是简体还是繁体中文，一律转换为简体中文输出\n2. 完整保留原文内容，不要添加任何解释或注释\n3. 保持原有换行和段落结构\n4. 如有多列，从左到右、从上到下按阅读顺序输出\n5. 只输出识别到的文字，不要输出任何其他内容'
            }
          ]
        }
      ]
    };

    const body = JSON.stringify(bodyObj);

    const options = {
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'HTTP-Referer': 'https://saomiaoji.app',
        'X-Title': 'SpeedScan'
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.error) {
            // 打印完整错误，方便排查
            console.error('[ocr] OpenRouter 完整错误:', JSON.stringify(json.error));
            return reject(new Error(`OpenRouter 错误: ${json.error.message || JSON.stringify(json.error)}`));
          }
          const text = json.choices?.[0]?.message?.content ?? '';
          resolve(text);
        } catch (e) {
          console.error('[ocr] 原始响应:', raw.slice(0, 500));
          reject(new Error('响应解析失败: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// POST /api/ocr/handwriting
// Body: { image: "base64 jpeg string" }
router.post('/handwriting', async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: '请提供图片 base64 字符串 image' });

  try {
    console.log('[ocr] handwriting 识别开始');
    const text = await claudeOCR(image);
    console.log(`[ocr] handwriting 识别完成，字符数: ${text.length}`);
    res.json({ text });
  } catch (err) {
    console.error('[ocr] handwriting 失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

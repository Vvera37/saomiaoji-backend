'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { sendSmsCode } = require('../sms');
const { saveCode, verifyCode } = require('../store');
const { mergeUsage } = require('./usage');

const router = express.Router();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function isValidPhone(phone) {
  return /^1[3-9]\d{9}$/.test(phone);
}

// 苹果审核演示账号（固定验证码，跳过短信，用于 App Review & 内部测试）
const DEMO_PHONE = '13900139000';
const DEMO_CODE  = '999999';

// 短信发送冷却（内存级，重启重置；Sealos 单实例够用）
const smsCooldown = new Map(); // phone → timestamp

// POST /api/auth/send-code
router.post('/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }

  // 演示账号：跳过短信，直接返回 ok（审核员和测试用）
  if (phone === DEMO_PHONE) {
    console.log('[DEMO] 演示账号请求验证码，跳过短信');
    return res.json({ ok: true });
  }

  // 60 秒冷却，防止阿里云限流返回 UNKNOWN
  const lastSent = smsCooldown.get(phone);
  if (lastSent && Date.now() - lastSent < 60_000) {
    const remaining = Math.ceil((60_000 - (Date.now() - lastSent)) / 1000);
    return res.status(429).json({ error: `发送太频繁，请 ${remaining} 秒后重试` });
  }

  const code = generateCode();

  try {
    if (process.env.NODE_ENV === 'development') {
      await saveCode(phone, code);
      console.log(`[DEV] 手机 ${phone} 验证码：${code}`);
      return res.json({ ok: true, dev_code: code });
    }

    await sendSmsCode(phone, code);
    smsCooldown.set(phone, Date.now()); // 发送成功才记录冷却
    await saveCode(phone, code);
    res.json({ ok: true });
  } catch (err) {
    console.error('[send-code error]', err.message);
    res.status(500).json({ error: '短信发送失败，请稍后重试' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: '验证码格式不正确' });
  }

  // 演示账号直通：跳过 store 验证，直接下发 token
  if (phone === DEMO_PHONE && code === DEMO_CODE) {
    console.log('[DEMO] 演示账号登录成功');
    const expiresInSeconds = 90 * 24 * 60 * 60;
    const token = jwt.sign(
      { phone, iat: Math.floor(Date.now() / 1000) },
      process.env.JWT_SECRET,
      { expiresIn: expiresInSeconds }
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    // 合并 UUID 使用量（如果有传）
    const uuid = req.headers['x-device-uuid'];
    if (uuid) {
      try {
        const { getDb } = require('../db');
        const db = await getDb();
        await mergeUsage(db, uuid, phone);
      } catch (e) {
        console.error('[auth] UUID 合并失败（不阻断登录）:', e.message);
      }
    }
    return res.json({ token, expires_at: expiresAt, phone });
  }

  const result = await verifyCode(phone, code);
  if (!result.ok) {
    const messages = {
      not_found:         '验证码不存在，请重新获取',
      expired:           '验证码已过期，请重新获取',
      wrong_code:        '验证码错误，请重新输入',
      too_many_attempts: '验证次数过多，请重新获取验证码',
    };
    return res.status(401).json({ error: messages[result.reason] || '验证失败' });
  }

  const expiresInSeconds = 90 * 24 * 60 * 60;
  const token = jwt.sign(
    { phone, iat: Math.floor(Date.now() / 1000) },
    process.env.JWT_SECRET,
    { expiresIn: expiresInSeconds }
  );
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();

  // 合并 UUID 使用量（如果有传）
  const uuid = req.headers['x-device-uuid'];
  if (uuid) {
    try {
      const { getDb } = require('../db');
      const db = await getDb();
      await mergeUsage(db, uuid, phone);
    } catch (e) {
      console.error('[auth] UUID 合并失败（不阻断登录）:', e.message);
    }
  }

  res.json({ token, expires_at: expiresAt, phone });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    const expiresInSeconds = 90 * 24 * 60 * 60;
    const newToken = jwt.sign(
      { phone: decoded.phone },
      process.env.JWT_SECRET,
      { expiresIn: expiresInSeconds }
    );
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
    res.json({ token: newToken, expires_at: expiresAt });
  } catch {
    res.status(401).json({ error: 'Token 无效或已过期' });
  }
});

module.exports = router;

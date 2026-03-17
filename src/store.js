'use strict';

/**
 * 验证码存储 — MongoDB 版
 * collection: sms_codes
 * { phone, code, expiresAt, attempts, createdAt }
 */

const { getDb } = require('./db');

const CODE_TTL_MS = 5 * 60 * 1000; // 5分钟

async function saveCode(phone, code) {
  const col = (await getDb()).collection('sms_codes');
  await col.deleteMany({ phone }); // 覆盖旧的
  await col.insertOne({
    phone,
    code,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    attempts: 0,
    createdAt: new Date(),
  });
}

async function verifyCode(phone, inputCode) {
  const col = (await getDb()).collection('sms_codes');
  const entry = await col.findOne({ phone });

  if (!entry) return { ok: false, reason: 'not_found' };
  if (new Date() > entry.expiresAt) {
    await col.deleteOne({ phone });
    return { ok: false, reason: 'expired' };
  }
  if (entry.attempts >= 5) {
    await col.deleteOne({ phone });
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (entry.code !== inputCode) {
    await col.updateOne({ phone }, { $inc: { attempts: 1 } });
    return { ok: false, reason: 'wrong_code' };
  }

  await col.deleteOne({ phone }); // 验证成功立即清除
  return { ok: true };
}

module.exports = { saveCode, verifyCode };

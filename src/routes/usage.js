'use strict';

/**
 * /api/usage 路由
 *
 * 使用量管理：累计计数，不重置
 *
 * 免费额度：
 *   ocr        → 20 次（拍照识别 / 图片识别）
 *   images_pdf → 5  次（图片转 PDF）
 *   pdf_word   → 5  次（PDF 转 Word）
 *
 * 标识逻辑：
 *   - 未登录：用 UUID（iOS 本地生成，存 Keychain，请求带 X-Device-UUID header）
 *   - 已登录：用手机号（phone）
 *   - 登录时：mergeUsage(uuid, phone) → UUID 次数合并到手机号，之后 UUID 不再计数
 *
 * 超级账号（superphones）：无限制，跳过计数
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db');

const router = express.Router();

// ─── 免费额度配置 ─────────────────────────────────────────
const FREE_LIMITS = {
  ocr:        20,
  images_pdf: 5,
  pdf_word:   5,
};

// ─── 超级账号（终身会员，写入 DB 后此处可为空） ────────────
// 通过 DB superphones 集合管理，此处只是 fallback 兜底
const SUPER_PHONES_FALLBACK = [];

// ─── 工具：从 JWT 解析手机号（不强制验证，路由自行决定是否需要登录） ──
function getPhoneFromToken(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    return decoded.phone || null;
  } catch {
    return null;
  }
}

// ─── 工具：获取请求中的用户标识 ──────────────────────────
// 已登录 → phone；未登录 → UUID（X-Device-UUID header）
function getUserId(req) {
  const phone = getPhoneFromToken(req);
  if (phone) return { type: 'phone', id: phone };
  const uuid = req.headers['x-device-uuid'];
  if (uuid && uuid.length >= 8) return { type: 'uuid', id: uuid };
  return null;
}

// ─── 工具：查询 usage 文档 ─────────────────────────────────
async function getUsageDoc(db, userId) {
  return db.collection('usage').findOne({ userId });
}

// ─── 工具：检查是否是超级账号 ─────────────────────────────
async function isSuperUser(db, userId) {
  if (SUPER_PHONES_FALLBACK.includes(userId)) return true;
  const doc = await db.collection('superphones').findOne({ phone: userId });
  return !!doc;
}

// ─── 工具：检查是否是付费会员（StoreKit receipt 验证后写入 DB） ─
async function isVip(db, userId) {
  const doc = await db.collection('vip_users').findOne({ userId });
  return !!(doc?.active);
}

// ─── 核心：检查某功能是否还有剩余次数 ───────────────────────
// 返回 { allowed: bool, used: number, limit: number | null }
async function checkQuota(db, userId, feature) {
  // 超级账号
  if (await isSuperUser(db, userId)) {
    return { allowed: true, used: 0, limit: null, vip: true };
  }
  // 付费会员
  if (await isVip(db, userId)) {
    return { allowed: true, used: 0, limit: null, vip: true };
  }

  const limit = FREE_LIMITS[feature];
  if (limit === undefined) {
    // 未配置的 feature 不限制
    return { allowed: true, used: 0, limit: null };
  }

  const doc = await getUsageDoc(db, userId);
  const used = doc?.counts?.[feature] ?? 0;
  return { allowed: used < limit, used, limit, vip: false };
}

// ─── 核心：记录一次使用 ────────────────────────────────────
async function recordUsage(db, userId, feature) {
  await db.collection('usage').updateOne(
    { userId },
    {
      $inc: { [`counts.${feature}`]: 1 },
      $set: { updatedAt: new Date() },
      $setOnInsert: { userId, createdAt: new Date() }
    },
    { upsert: true }
  );
}

// ─── 核心：UUID 使用量合并到手机号 ────────────────────────
// 登录时调用：把 UUID 累计的次数加到手机号账号上，然后标记 UUID 已合并
async function mergeUsage(db, uuid, phone) {
  const uuidDoc = await getUsageDoc(db, uuid);
  if (!uuidDoc || uuidDoc.merged) return; // 没有 UUID 记录 或 已合并过

  const counts = uuidDoc.counts || {};
  const features = Object.keys(counts);
  if (features.length === 0) {
    // 没有任何计数，只标记已合并
    await db.collection('usage').updateOne({ userId: uuid }, { $set: { merged: true, mergedTo: phone, mergedAt: new Date() } });
    return;
  }

  // 把 UUID 各 feature 的次数加到 phone 账号
  const incOps = {};
  for (const f of features) {
    incOps[`counts.${f}`] = counts[f];
  }

  await db.collection('usage').updateOne(
    { userId: phone },
    {
      $inc: incOps,
      $set: { updatedAt: new Date() },
      $setOnInsert: { userId: phone, createdAt: new Date() }
    },
    { upsert: true }
  );

  // 标记 UUID 记录为已合并
  await db.collection('usage').updateOne(
    { userId: uuid },
    { $set: { merged: true, mergedTo: phone, mergedAt: new Date() } }
  );

  console.log(`[usage] UUID ${uuid} 合并到 ${phone}，次数: ${JSON.stringify(counts)}`);
}

// ─── 对外导出（供 auth.js 登录时调用） ────────────────────
module.exports.mergeUsage = mergeUsage;
module.exports.checkQuota = checkQuota;
module.exports.recordUsage = recordUsage;
module.exports.getUserId = getUserId;

// ─── GET /api/usage/status ────────────────────────────────
// 返回当前用户所有 feature 的使用量和剩余量
router.get('/status', async (req, res) => {
  const user = getUserId(req);
  if (!user) return res.status(400).json({ error: '缺少用户标识（需要登录或提供 X-Device-UUID）' });

  try {
    const db = await getDb();
    const doc = await getUsageDoc(db, user.id);
    const counts = doc?.counts || {};

    const vipCheck = await isVip(db, user.id);
    const superCheck = await isSuperUser(db, user.id);
    const unlimited = vipCheck || superCheck;

    const status = {};
    for (const [feature, limit] of Object.entries(FREE_LIMITS)) {
      const used = counts[feature] ?? 0;
      status[feature] = {
        used,
        limit: unlimited ? null : limit,
        remaining: unlimited ? null : Math.max(0, limit - used),
        allowed: unlimited ? true : used < limit,
      };
    }

    res.json({ userId: user.id, type: user.type, vip: unlimited, status });
  } catch (err) {
    console.error('[usage] status 失败:', err.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// ─── POST /api/usage/check ────────────────────────────────
// Body: { feature: "ocr" | "images_pdf" | "pdf_word" }
// 返回: { allowed: bool, used: number, limit: number|null, vip: bool }
router.post('/check', async (req, res) => {
  const { feature } = req.body;
  if (!feature || !FREE_LIMITS.hasOwnProperty(feature)) {
    return res.status(400).json({ error: '无效的 feature，支持：' + Object.keys(FREE_LIMITS).join(', ') });
  }

  const user = getUserId(req);
  if (!user) return res.status(400).json({ error: '缺少用户标识' });

  try {
    const db = await getDb();
    const result = await checkQuota(db, user.id, feature);
    res.json(result);
  } catch (err) {
    console.error('[usage] check 失败:', err.message);
    res.status(500).json({ error: '查询失败' });
  }
});

// ─── POST /api/usage/record ───────────────────────────────
// Body: { feature: "ocr" | "images_pdf" | "pdf_word" }
// 操作成功后由客户端调用，+1 计数
router.post('/record', async (req, res) => {
  const { feature } = req.body;
  if (!feature || !FREE_LIMITS.hasOwnProperty(feature)) {
    return res.status(400).json({ error: '无效的 feature' });
  }

  const user = getUserId(req);
  if (!user) return res.status(400).json({ error: '缺少用户标识' });

  try {
    const db = await getDb();
    // 会员不计数
    const vipCheck = await isVip(db, user.id);
    const superCheck = await isSuperUser(db, user.id);
    if (!vipCheck && !superCheck) {
      await recordUsage(db, user.id, feature);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[usage] record 失败:', err.message);
    res.status(500).json({ error: '记录失败' });
  }
});

// ─── POST /api/usage/add-super ────────────────────────────
// 管理员接口：添加超级账号（需要 ADMIN_SECRET header）
router.post('/add-super', async (req, res) => {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: '无权限' });
  }

  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }

  try {
    const db = await getDb();
    await db.collection('superphones').updateOne(
      { phone },
      { $set: { phone, addedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true, phone });
  } catch (err) {
    console.error('[usage] add-super 失败:', err.message);
    res.status(500).json({ error: '添加失败' });
  }
});

module.exports.router = router;

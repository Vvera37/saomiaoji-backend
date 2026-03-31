'use strict';

/**
 * 苹果订阅验证接口
 * POST /api/subscription/verify
 *
 * 客户端购买成功后，传入 transactionId，后端向苹果 App Store Server API 验证，
 * 验证通过后写入 vip_users 集合。
 *
 * 支持已登录（手机号）和未登录（Device UUID）两种用户身份。
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const https = require('https');

const router = express.Router();

// ── App Store Connect API 配置 ────────────────────────────────
const ISSUER_ID = process.env.APPLE_ISSUER_ID || 'daa3b38b-42d0-4b20-af51-4fe34541ea6d';
const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.saomiaoji.app';

// 两个产品对应两个 Key
const KEY_CONFIGS = {
  'com.saomiaoji.app.monthly': {
    keyId: process.env.APPLE_KEY_ID_MONTHLY || '7P9Y9Y8C33',
    p8Path: path.join(__dirname, '../../sao_monthly.p8'),
  },
  'com.saomiaoji.app.yearly': {
    keyId: process.env.APPLE_KEY_ID_YEARLY || 'UTLY2GA3SC',
    p8Path: path.join(__dirname, '../../sao_yearly.p8'),
  },
};

// ── 生成 App Store Connect JWT ────────────────────────────────
function generateAppleJWT(keyId, p8Path) {
  const privateKey = fs.readFileSync(p8Path, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: ISSUER_ID,
      iat: now,
      exp: now + 60 * 20, // 20分钟有效期
      aud: 'appstoreconnect-v1',
      bid: BUNDLE_ID,
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: keyId, typ: 'JWT' },
    }
  );
}

// ── 调用苹果 API 验证 transactionId ──────────────────────────
function verifyTransactionWithApple(transactionId, appleJWT) {
  return new Promise((resolve, reject) => {
    // 先尝试生产环境，失败再试沙盒
    const tryEnv = (env) => {
      const host =
        env === 'production'
          ? 'api.storekit.itunes.apple.com'
          : 'api.storekit-sandbox.itunes.apple.com';
      const options = {
        hostname: host,
        path: `/inApps/v1/transactions/${transactionId}`,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${appleJWT}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve({ env, data: JSON.parse(data) });
            } catch (e) {
              reject(new Error('苹果响应解析失败'));
            }
          } else if (res.statusCode === 404 && env === 'production') {
            // 生产没找到，试沙盒（测试账号购买）
            tryEnv('sandbox');
          } else {
            reject(new Error(`苹果验证失败: ${res.statusCode} ${data}`));
          }
        });
      });
      req.on('error', reject);
      req.end();
    };

    tryEnv('production');
  });
}

// ── 从 token 中提取手机号（复用 auth 逻辑）──────────────────
function getPhoneFromToken(req) {
  try {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token) return null;
    const decoded = jwt.decode(token);
    return decoded?.phone || null;
  } catch {
    return null;
  }
}

// ── POST /api/subscription/verify ────────────────────────────
router.post('/verify', async (req, res) => {
  const { transactionId, productId } = req.body;

  if (!transactionId || !productId) {
    return res.status(400).json({ error: '缺少 transactionId 或 productId' });
  }

  const keyConfig = KEY_CONFIGS[productId];
  if (!keyConfig) {
    return res.status(400).json({ error: '无效的 productId' });
  }

  // 确定用户身份
  const phone = getPhoneFromToken(req);
  const deviceUUID = req.headers['x-device-uuid'];
  const userId = phone || deviceUUID;

  if (!userId) {
    return res.status(400).json({ error: '无法确认用户身份（需要登录或 Device UUID）' });
  }

  try {
    const db = req.app.locals.db;

    // 生成苹果 JWT 并验证
    const appleJWT = generateAppleJWT(keyConfig.keyId, keyConfig.p8Path);
    const { env, data: appleResp } = await verifyTransactionWithApple(transactionId, appleJWT);

    // 解析苹果返回的 signed transaction（JWS 格式，中间段是 payload）
    const signedTx = appleResp.signedTransactionInfo;
    if (!signedTx) {
      return res.status(400).json({ error: '苹果未返回交易信息' });
    }
    const payload = JSON.parse(
      Buffer.from(signedTx.split('.')[1], 'base64url').toString('utf8')
    );

    // 校验 bundleId 和 productId
    if (payload.bundleId !== BUNDLE_ID || payload.productId !== productId) {
      return res.status(400).json({ error: '交易信息与产品不匹配' });
    }

    // 检查是否已过期
    const expiresMs = payload.expiresDate;
    const now = Date.now();
    if (expiresMs && expiresMs < now) {
      return res.status(402).json({ error: '订阅已过期', expiresDate: expiresMs });
    }

    const expiresDate = expiresMs ? new Date(expiresMs) : null;
    const planName = productId.includes('yearly') ? '年度会员' : '月度会员';

    // 写入 vip_users（upsert）
    await db.collection('vip_users').updateOne(
      { userId },
      {
        $set: {
          userId,
          active: true,
          productId,
          planName,
          transactionId,
          expiresDate,
          verifiedEnv: env,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    console.log(`[subscription] ✅ 验证成功 userId=${userId} plan=${planName} env=${env}`);

    return res.json({
      success: true,
      userId,
      planName,
      expiresDate,
      env,
    });
  } catch (err) {
    console.error('[subscription] 验证失败:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

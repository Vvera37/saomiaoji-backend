'use strict';

require('dotenv').config();
const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');

/**
 * 阿里云「号码认证服务」· SendSmsVerifyCode
 *
 * API：dypnsapi.aliyuncs.com（注意：dypnsapi，不是 dytnsapi）
 * Action：SendSmsVerifyCode
 * Version：2017-05-25
 *
 * ⚠️ 签名（SignName）必须使用系统赠送签名，不支持自定义签名
 * ⚠️ 模板（TemplateCode）必须使用系统赠送模板，搭配赠送签名使用
 * 赠送签名配置：号码认证控制台 → 赠送签名配置
 * 赠送模板配置：号码认证控制台 → 赠送模板配置
 *
 * 文档：https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
 */

const ACCESS_KEY_ID     = process.env.ALIYUN_ACCESS_KEY_ID;
const ACCESS_KEY_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET;

/**
 * 阿里云 API HMAC-SHA1 签名
 */
function sign(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const stringToSign = `POST&${encodeURIComponent('/')}&${encodeURIComponent(sorted)}`;
  return crypto
    .createHmac('sha1', secret + '&')
    .update(stringToSign)
    .digest('base64');
}

/**
 * 发送短信验证码
 * @param {string} phone 手机号（11位，不含+86）
 * @param {string} code  验证码（6位数字）
 */
async function sendSmsCode(phone, code) {
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const nonce     = crypto.randomBytes(8).toString('hex');

  const params = {
    AccessKeyId:    ACCESS_KEY_ID,
    Action:         'SendSmsVerifyCode',
    Format:         'JSON',
    PhoneNumber:    phone,
    SignName:       process.env.ALIYUN_SMS_SIGN_NAME,     // 系统赠送签名名称
    TemplateCode:   process.env.ALIYUN_SMS_TEMPLATE_CODE, // 系统赠送模板 CODE
    TemplateParam:  JSON.stringify({ code }),              // 验证码参数（模板只有 ${code} 占位符）
    SignatureMethod:  'HMAC-SHA1',
    SignatureNonce:   nonce,
    SignatureVersion: '1.0',
    Timestamp:        timestamp,
    Version:          '2017-05-25',
  };

  params.Signature = sign(params, ACCESS_KEY_SECRET);

  return new Promise((resolve, reject) => {
    const body    = querystring.stringify(params);
    const options = {
      hostname: 'dypnsapi.aliyuncs.com',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('[SMS Response]', JSON.stringify(json));
          // SendSmsVerifyCode 成功时返回 Model.Code === 'OK'
          if (json.Code !== 'OK') {
            reject(new Error(`短信发送失败：${json.Message}（${json.Code}）`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error('响应解析失败：' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendSmsCode };

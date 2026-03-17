# 扫描鸡后端服务

## 快速启动

```bash
npm install
npm start
```

服务跑在 http://localhost:3000

## 接口文档

### 发送验证码
```
POST /api/auth/send-code
Content-Type: application/json

{ "phone": "13800138000" }

# 成功
{ "ok": true }
# 开发模式下额外返回（上线前去掉）
{ "ok": true, "dev_code": "123456" }
```

### 登录
```
POST /api/auth/login
Content-Type: application/json

{ "phone": "13800138000", "code": "123456" }

# 成功
{ "token": "eyJ...", "expires_at": "2026-06-10T...", "phone": "13800138000" }
```

### 续期 Token
```
POST /api/auth/refresh
Authorization: Bearer <token>

# 成功
{ "token": "eyJ...", "expires_at": "2026-06-10T..." }
```

### 健康检查
```
GET /health
{ "ok": true, "time": "2026-03-12T..." }
```

## 环境变量配置

复制 `.env.example` 为 `.env`，填入真实值：

```
ALIYUN_ACCESS_KEY_ID=     # 阿里云 AccessKey ID
ALIYUN_ACCESS_KEY_SECRET= # 阿里云 AccessKey Secret
ALIYUN_SMS_SIGN_NAME=     # 短信签名（如：扫描鸡）
ALIYUN_SMS_TEMPLATE_CODE= # 模板 Code（如：SMS_xxxxxxx）
JWT_SECRET=               # JWT 密钥，生产环境用随机长字符串
PORT=3000
NODE_ENV=development
```

## 部署到 Vercel（推荐·免费）

1. 安装 Vercel CLI：`npm i -g vercel`
2. 在项目根目录：`vercel`
3. 在 Vercel 控制台配置环境变量（同 .env 内容）
4. 生产 URL 填入 iOS 客户端 `AuthService.swift` 的 `baseURL`

## 注意事项

- 验证码存储在内存中，服务重启后失效（MVP 阶段足够用）
- 生产环境建议接入 Redis 持久化验证码
- `NODE_ENV=development` 时发送验证码会跳过真实短信，直接在日志打印验证码
- 上线前务必将 `NODE_ENV` 改为 `production`，并配置真实阿里云短信签名和模板

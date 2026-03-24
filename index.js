'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./src/routes/auth');
const convertRoutes = require('./src/routes/convert');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json({ limit: '20mb' }));        // 图片 base64 体积大，默认 1mb 不够
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// 健康检查
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/convert', convertRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// 启动
app.listen(PORT, () => {
  console.log(`✅ 扫描鸡后端服务启动：http://localhost:${PORT}`);
  console.log(`环境：${process.env.NODE_ENV}`);
});

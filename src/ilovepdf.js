'use strict';

/**
 * iLovePDF REST API 封装（纯 Node.js https，无第三方依赖）
 * 流程：auth → upload → task → download
 * 支持：images_to_pdf → pdf_to_pptx（图片转PPT）
 *       pdf_to_word（PDF转Word）
 */

require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const PUBLIC_KEY = process.env.ILOVEPDF_PUBLIC_KEY;
const SECRET_KEY = process.env.ILOVEPDF_SECRET_KEY;

// ─── 基础请求 ───────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // 如果是 JSON 就 parse，否则返回 Buffer（下载文件用）
        const ct = res.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { resolve(JSON.parse(buf.toString())); }
          catch (e) { reject(new Error('JSON parse error: ' + buf.toString().slice(0, 200))); }
        } else {
          resolve(buf); // 文件二进制
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Step 1: 获取 JWT token ──────────────────────────────
async function getToken() {
  const body = JSON.stringify({ public_key: PUBLIC_KEY });
  const res = await request({
    hostname: 'api.ilovepdf.com',
    path: '/v1/auth',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  if (!res.token) throw new Error('iLovePDF auth failed: ' + JSON.stringify(res));
  return res.token;
}

// ─── Step 2: 创建任务，获取 server + task_id ─────────────
async function createTask(token, tool) {
  const res = await request({
    hostname: 'api.ilovepdf.com',
    path: `/v1/start/${tool}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.server || !res.task) throw new Error('createTask failed: ' + JSON.stringify(res));
  return { server: res.server, taskId: res.task };
}

// ─── Step 3: 上传文件 ────────────────────────────────────
async function uploadFile(token, server, taskId, filePath, filename) {
  const fileBuffer = fs.readFileSync(filePath);
  const boundary = '----ilovepdf' + Date.now();
  const CRLF = '\r\n';

  let header = '';
  header += `--${boundary}${CRLF}`;
  header += `Content-Disposition: form-data; name="task"${CRLF}${CRLF}${taskId}${CRLF}`;
  header += `--${boundary}${CRLF}`;
  header += `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`;
  header += `Content-Type: application/octet-stream${CRLF}${CRLF}`;
  const footer = `${CRLF}--${boundary}--${CRLF}`;

  const body = Buffer.concat([
    Buffer.from(header),
    fileBuffer,
    Buffer.from(footer)
  ]);

  const res = await request({
    hostname: server,
    path: '/v1/upload',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    }
  }, body);
  if (!res.server_filename) throw new Error('upload failed: ' + JSON.stringify(res));
  return res.server_filename;
}

// ─── Step 4: 执行任务 ────────────────────────────────────
async function processTask(token, server, taskId, tool, serverFilenames) {
  const files = serverFilenames.map((sf, i) => ({
    server_filename: sf,
    filename: `image_${i + 1}.jpg`
  }));
  const body = JSON.stringify({ task: taskId, tool, files });
  const res = await request({
    hostname: server,
    path: '/v1/process',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);
  if (!res.download_filename) throw new Error('process failed: ' + JSON.stringify(res));
  return res.download_filename;
}

// ─── Step 5: 下载结果 ────────────────────────────────────
async function downloadResult(token, server, taskId, outputPath) {
  const buf = await request({
    hostname: server,
    path: `/v1/download/${taskId}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!Buffer.isBuffer(buf)) throw new Error('download failed: ' + JSON.stringify(buf));
  fs.writeFileSync(outputPath, buf);
  return outputPath;
}

// ─── 主流程：图片数组 → PPTX 文件 ───────────────────────
async function imagesToPptx(imagePaths, outputPath) {
  const token = await getToken();

  // 1. 图片 → PDF
  const { server: s1, taskId: t1 } = await createTask(token, 'imagepdf');
  const sfNames1 = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const sf = await uploadFile(token, s1, t1, imagePaths[i], `page_${i + 1}.jpg`);
    sfNames1.push(sf);
  }
  const pdfFilename = await processTask(token, s1, t1, 'imagepdf', sfNames1);
  const tmpPdf = outputPath.replace(/\.pptx$/, '_tmp.pdf');
  await downloadResult(token, s1, t1, tmpPdf);

  // 2. PDF → PPTX
  const token2 = await getToken(); // 重新获取 token
  const { server: s2, taskId: t2 } = await createTask(token2, 'pdftopresentaion');
  const sf2 = await uploadFile(token2, s2, t2, tmpPdf, 'document.pdf');
  await processTask(token2, s2, t2, 'pdftopresentaion', [sf2]);
  await downloadResult(token2, s2, t2, outputPath);

  // 清理临时 PDF
  fs.unlinkSync(tmpPdf);
  return outputPath;
}

// ─── 主流程：PDF → Word ──────────────────────────────────
async function pdfToWord(pdfPath, outputPath) {
  const token = await getToken();
  const { server, taskId } = await createTask(token, 'pdftoword');
  const sf = await uploadFile(token, server, taskId, pdfPath, 'document.pdf');
  await processTask(token, server, taskId, 'pdftoword', [sf]);
  await downloadResult(token, server, taskId, outputPath);
  return outputPath;
}

module.exports = { imagesToPptx, pdfToWord };

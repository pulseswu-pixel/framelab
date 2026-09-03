const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const send = (res, status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const base = value => String(value || '').replace(/\/+$/, '');
async function readJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
function readMultipart(req) { return new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { const buf = Buffer.concat(chunks); const ct = req.headers['content-type'] || ''; const bIdx = ct.indexOf('boundary='); const boundaryStr = bIdx >= 0 ? ct.slice(bIdx + 9) : ''; const boundary = Buffer.from('--' + boundaryStr); const files = []; let start = buf.indexOf(boundary); if (start === -1) return resolve(files); start += boundary.length; while (start < buf.length) { if (buf.slice(start, start + 2).toString() === '--') break; start += 2; const nextBoundary = buf.indexOf(boundary, start); if (nextBoundary === -1) break; const part = buf.slice(start, nextBoundary - 2); const headerEnd = part.indexOf('\r\n\r\n'); if (headerEnd === -1) break; const header = part.slice(0, headerEnd).toString(); const nameMatch = header.match(/name="([^"]+)"/); const filenameMatch = header.match(/filename="([^"]+)"/); const typeMatch = header.match(/Content-Type: ([^\r\n]+)/); files.push({ name: nameMatch?.[1] || '', filename: filenameMatch?.[1] || '', type: typeMatch?.[1] || 'image/png', data: part.slice(headerEnd + 4) }); start = nextBoundary + boundary.length; } resolve(files); }); }); }
async function result(baseUrl, key, id) { for (let n = 0; n < 100; n++) { await new Promise(done => setTimeout(done, n < 5 ? 2000 : n < 15 ? 3000 : 5000)); const r = await fetch(`${baseUrl}/v1/api/result?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } }); const data = await r.json(); if (data.status === 'succeeded' || data.results?.[0]?.url) return data; if (data.status === 'failed') throw new Error(data.error?.message || '图像生成失败'); } throw new Error('生成超时（超过5分钟），请稍后重试'); }

// === 对象存储配置（Cloudflare R2，兼容 COS 降级）===
const COS = require('cos-nodejs-sdk-v5');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');

// R2 配置
const r2Config = {
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  bucket: process.env.R2_BUCKET || 'framelab',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  publicUrl: process.env.R2_PUBLIC_URL || ''
};
const r2Enabled = !!(r2Config.accessKeyId && r2Config.secretAccessKey);

// R2 S3 客户端
let r2Client = null;
if (r2Enabled) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: r2Config.endpoint,
    credentials: { accessKeyId: r2Config.accessKeyId, secretAccessKey: r2Config.secretAccessKey }
  });
}

// COS 降级配置（仅当 R2 未启用且有 COS 凭据时使用）
const cosConfig = {
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
  Bucket: process.env.COS_BUCKET || 'image-lab-1478230079',
  Region: process.env.COS_REGION || 'ap-beijing'
};
const cosEnabled = !r2Enabled && !!(cosConfig.SecretId && cosConfig.SecretKey);
const cos = cosEnabled ? new COS({ SecretId: cosConfig.SecretId, SecretKey: cosConfig.SecretKey }) : null;
const cosBaseUrl = cosEnabled ? `https://${cosConfig.Bucket}.cos.${cosConfig.Region}.myqcloud.com` : '';
const storageType = r2Enabled ? 'R2' : cosEnabled ? 'COS' : 'local';

async function uploadToR2(buffer, key) {
  await r2Client.send(new PutObjectCommand({ Bucket: r2Config.bucket, Key: key, Body: buffer }));
  const base = r2Config.publicUrl || r2Config.endpoint.replace(/\/$/, '');
  return r2Config.publicUrl ? `${r2Config.publicUrl}/${key}` : `${r2Config.endpoint}/${r2Config.bucket}/${key}`;
}

async function uploadToCos(buffer, key) {
  return new Promise((resolve, reject) => {
    cos.putObject({ Bucket: cosConfig.Bucket, Region: cosConfig.Region, Key: key, Body: buffer }, (err, data) => {
      if (err) reject(err); else resolve(`${cosBaseUrl}/${key}`);
    });
  });
}

async function uploadToStorage(buffer, key) {
  if (r2Enabled) return await uploadToR2(buffer, key);
  if (cosEnabled) return await uploadToCos(buffer, key);
  const folder = path.join(root, path.dirname(key));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(root, key), buffer);
  return `/${key}`;
}

async function saveImageToStorage(buffer, ext) {
  const name = `framelab-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  return await uploadToStorage(buffer, `generated-images/${name}`);
}

async function saveReferenceToStorage(buffer, ext) {
  const name = `ref-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  return await uploadToStorage(buffer, `reference-images/${name}`);
}

async function saveImage(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('无法下载生成图片');
  const contentType = response.headers.get('content-type') || '';
  const extension = contentType.includes('webp') ? 'webp' : contentType.includes('jpeg') ? 'jpg' : 'png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return await saveImageToStorage(buffer, extension);
}

// === 项目记录存储（R2 优先，COS 降级，本地兜底）===
const dataFile = path.join(root, 'data', 'projects.json');
const storageProjectsKey = 'data/projects.json';
let writeDebounceTimer = null;
let writeDebounceData = null;

async function readProjects() {
  if (r2Enabled) {
    try {
      const response = await r2Client.send(new GetObjectCommand({ Bucket: r2Config.bucket, Key: storageProjectsKey }));
      const text = await response.Body.transformToString('utf8');
      return JSON.parse(text) || [];
    } catch {}
  }
  if (cosEnabled) {
    try {
      const data = await new Promise((resolve, reject) => {
        cos.getObject({ Bucket: cosConfig.Bucket, Region: cosConfig.Region, Key: storageProjectsKey }, (err, result) => {
          if (err) reject(err); else resolve(result.Body.toString('utf8'));
        });
      });
      return JSON.parse(data) || [];
    } catch {}
  }
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')) || []; } catch { return []; }
}

async function writeProjects(list) {
  writeDebounceData = list;
  const json = JSON.stringify(list, null, 2);
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, json);
  if (writeDebounceTimer) clearTimeout(writeDebounceTimer);
  writeDebounceTimer = setTimeout(async () => {
    const data = writeDebounceData;
    writeDebounceData = null;
    writeDebounceTimer = null;
    if (data) { try { await uploadToStorage(Buffer.from(JSON.stringify(data, null, 2), 'utf8'), storageProjectsKey); } catch {} }
  }, 2000);
}

// === 异步任务存储 ===
const tasks = new Map();
// task 结构: { status, url, error, meta: { projectId, model, index, prompt, ratio, batchCount, refUrls }, createdAt }

const port = Number(process.env.PORT) || 4173;
const server = http.createServer(async (req, res) => { try {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', storage: storageType });
  if (req.method === 'POST' && req.url === '/api/generate') {
    const { baseUrl, apiKey, payload, meta } = await readJson(req);
    if (!baseUrl || !apiKey) return send(res, 400, { error: '请先在 API 管理中填写基础节点和 API Key。' });
    const taskId = `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    tasks.set(taskId, { status: 'pending', url: null, error: null, meta: meta || {}, createdAt: Date.now() });
    (async () => {
      try {
        const r = await fetch(`${base(baseUrl)}/v1/api/generate`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error?.message || 'API 请求失败');
        const generated = data.status === 'succeeded' || data.results?.[0]?.url ? data : await result(base(baseUrl), apiKey, data.id);
        if (!generated.results?.[0]?.url) throw new Error('API 返回数据异常');
        const savedUrl = await saveImage(generated.results[0].url);
        tasks.set(taskId, { ...tasks.get(taskId), status: 'done', url: savedUrl, error: null });
      } catch (err) {
        tasks.set(taskId, { ...tasks.get(taskId), status: 'failed', url: null, error: err.message || '生成失败' });
      }
    })();
    return send(res, 200, { taskId });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/status?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const taskId = params.get('id');
    if (!taskId || !tasks.has(taskId)) return send(res, 200, { status: 'pending' });
    const task = tasks.get(taskId);
    const resp = { status: task.status, url: task.url, error: task.error };
    if (task.status === 'done' || task.status === 'failed') { task.completedAt = Date.now(); setTimeout(() => tasks.delete(taskId), 60000); }
    return send(res, 200, resp);
  }
  if (req.method === 'GET' && req.url.startsWith('/api/tasks')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const projectId = params.get('projectId');
    const list = [];
    for (const [taskId, task] of tasks) {
      if (projectId && task.meta?.projectId !== projectId) continue;
      if (task.status === 'pending') {
        list.push({ taskId, status: 'pending', meta: task.meta });
      } else if (task.status === 'done' && !task.saved) {
        list.push({ taskId, status: 'done', url: task.url, meta: task.meta });
      } else if (task.status === 'failed' && !task.saved) {
        list.push({ taskId, status: 'failed', error: task.error, meta: task.meta });
      }
    }
    return send(res, 200, { tasks: list });
  }
  if (req.method === 'POST' && req.url === '/api/tasks/saved') {
    const { taskIds } = await readJson(req);
    if (Array.isArray(taskIds)) taskIds.forEach(id => { if (tasks.has(id)) { tasks.get(id).saved = true; setTimeout(() => tasks.delete(id), 30000); } });
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && req.url === '/api/save-reference') {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('multipart/form-data')) {
      const files = await readMultipart(req);
      const urls = [];
      for (const file of files) { const ext = file.type.includes('jpeg') || file.type.includes('jpg') ? 'jpg' : file.type.includes('webp') ? 'webp' : 'png'; urls.push(await saveReferenceToStorage(file.data, ext)); }
      return send(res, 200, { urls });
    }
    const { imageData } = await readJson(req); if (!imageData) return send(res, 400, { error: '缺少图片数据' }); const match = imageData.match(/^data:image\/(\w+);base64,(.+)/); if (!match) return send(res, 400, { error: '无效的图片数据格式' }); const ext = match[1] === 'jpeg' ? 'jpg' : match[1]; const buf = Buffer.from(match[2], 'base64'); return send(res, 200, { url: await saveReferenceToStorage(buf, ext) });
  }
  if (req.method === 'POST' && req.url === '/api/save-image') { const { imageUrl } = await readJson(req); if (!imageUrl) return send(res, 400, { error: '缺少图片地址' }); return send(res, 200, { url: await saveImage(imageUrl) }); }
  if (req.method === 'GET' && req.url === '/api/projects') return send(res, 200, await readProjects());
  if (req.method === 'POST' && req.url === '/api/projects') { const list = await readJson(req); await writeProjects(Array.isArray(list) ? list : []); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && req.url === '/api/config') {
    try {
      if (r2Enabled) {
        const response = await r2Client.send(new GetObjectCommand({ Bucket: r2Config.bucket, Key: 'data/api-config.json' }));
        return send(res, 200, await response.Body.transformToString('utf8'), 'application/json; charset=utf-8');
      }
      if (cosEnabled) {
        const r = await new Promise((resolve, reject) => { cos.getObject({ Bucket: cosConfig.Bucket, Region: cosConfig.Region, Key: 'data/api-config.json' }, (err, result) => err ? reject(err) : resolve(result.Body.toString('utf8'))); });
        return send(res, 200, r, 'application/json; charset=utf-8');
      }
    } catch {}
    return send(res, 200, '{}', 'application/json; charset=utf-8');
  }
  if (req.method === 'POST' && req.url === '/api/config') { const cfg = await readJson(req); await uploadToStorage(Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'), 'data/api-config.json'); return send(res, 200, { ok: true }); }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  const relative = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  const ext = path.extname(file);
  if (!types[ext]) return send(res, 415, { error: 'Unsupported type' });
  if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), types[ext]);
} catch (error) { send(res, 500, { error: error.message || '本地服务错误' }); } });
server.listen(port, () => console.log(`FrameLab is running on port ${port} (storage: ${storageType})`));
server.timeout = 300000;
server.keepAliveTimeout = 65000;

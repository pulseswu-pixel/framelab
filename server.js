const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const send = (res, status, body, type = 'application/json; charset=utf-8') => { res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const base = value => String(value || '').replace(/\/+$/, '');
async function readJson(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
async function result(baseUrl, key, id) { for (let n = 0; n < 30; n++) { await new Promise(done => setTimeout(done, 2000)); const r = await fetch(`${baseUrl}/v1/api/result?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } }); const data = await r.json(); if (data.status === 'succeeded' || data.results?.[0]?.url) return data; if (data.status === 'failed') throw new Error(data.error?.message || '图像生成失败'); } throw new Error('生成超时，请稍后重试'); }

// === COS 配置 ===
const COS = require('cos-nodejs-sdk-v5');
const cosConfig = {
  SecretId: process.env.COS_SECRET_ID,
  SecretKey: process.env.COS_SECRET_KEY,
  Bucket: process.env.COS_BUCKET || 'image-lab-1478230079',
  Region: process.env.COS_REGION || 'ap-beijing'
};
const cosEnabled = !!(cosConfig.SecretId && cosConfig.SecretKey);
const cos = cosEnabled ? new COS({ SecretId: cosConfig.SecretId, SecretKey: cosConfig.SecretKey }) : null;
const cosBaseUrl = cosEnabled ? `https://${cosConfig.Bucket}.cos.${cosConfig.Region}.myqcloud.com` : '';

async function uploadToCos(buffer, key) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: cosConfig.Bucket,
      Region: cosConfig.Region,
      Key: key,
      Body: buffer
    }, (err, data) => {
      if (err) reject(err);
      else resolve(`${cosBaseUrl}/${key}`);
    });
  });
}

async function saveImageToStorage(buffer, ext) {
  const name = `framelab-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  if (cosEnabled) {
    return await uploadToCos(buffer, `generated-images/${name}`);
  }
  const folder = path.join(root, 'generated-images');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), buffer);
  return `/generated-images/${name}`;
}

async function saveReferenceToStorage(buffer, ext) {
  const name = `ref-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
  if (cosEnabled) {
    return await uploadToCos(buffer, `reference-images/${name}`);
  }
  const folder = path.join(root, 'reference-images');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), buffer);
  return `/reference-images/${name}`;
}

async function saveImage(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('无法下载生成图片');
  const contentType = response.headers.get('content-type') || '';
  const extension = contentType.includes('webp') ? 'webp' : contentType.includes('jpeg') ? 'jpg' : 'png';
  const buffer = Buffer.from(await response.arrayBuffer());
  return await saveImageToStorage(buffer, extension);
}

// === 项目记录存储（COS 优先，本地降级）===
const dataFile = path.join(root, 'data', 'projects.json');
const cosProjectsKey = 'data/projects.json';

async function readProjects() {
  if (cosEnabled) {
    try {
      const data = await new Promise((resolve, reject) => {
        cos.getObject({ Bucket: cosConfig.Bucket, Region: cosConfig.Region, Key: cosProjectsKey }, (err, result) => {
          if (err) reject(err); else resolve(result.Body.toString('utf8'));
        });
      });
      return JSON.parse(data) || [];
    } catch { /* COS 上没有记录文件，降级 */ }
  }
  try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')) || []; } catch { return []; }
}

async function writeProjects(list) {
  const json = JSON.stringify(list, null, 2);
  if (cosEnabled) {
    try { await uploadToCos(Buffer.from(json, 'utf8'), cosProjectsKey); } catch {}
  }
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, json);
}

// === 异步任务存储 ===
const tasks = new Map();

const port = Number(process.env.PORT) || 4173;
const server = http.createServer(async (req, res) => { try {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { status: 'ok', cos: cosEnabled ? 'enabled' : 'disabled (local mode)' });
  if (req.method === 'POST' && req.url === '/api/generate') {
    const { baseUrl, apiKey, payload } = await readJson(req);
    if (!baseUrl || !apiKey) return send(res, 400, { error: '请先在 API 管理中填写基础节点和 API Key。' });
    const taskId = `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    tasks.set(taskId, { status: 'pending', url: null, error: null });
    (async () => {
      try {
        const r = await fetch(`${base(baseUrl)}/v1/api/generate`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || data.error?.message || 'API 请求失败');
        const generated = data.status === 'succeeded' || data.results?.[0]?.url ? data : await result(base(baseUrl), apiKey, data.id);
        if (!generated.results?.[0]?.url) throw new Error('API 返回数据异常');
        const savedUrl = await saveImage(generated.results[0].url);
        tasks.set(taskId, { status: 'done', url: savedUrl, error: null });
      } catch (err) {
        tasks.set(taskId, { status: 'failed', url: null, error: err.message || '生成失败' });
      }
    })();
    return send(res, 200, { taskId });
  }
  if (req.method === 'GET' && req.url.startsWith('/api/status?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const taskId = params.get('id');
    if (!taskId || !tasks.has(taskId)) return send(res, 404, { error: '任务不存在' });
    const task = tasks.get(taskId);
    const resp = { status: task.status, url: task.url, error: task.error };
    if (task.status === 'done' || task.status === 'failed') tasks.delete(taskId);
    return send(res, 200, resp);
  }
  if (req.method === 'POST' && req.url === '/api/save-reference') { const { imageData } = await readJson(req); if (!imageData) return send(res, 400, { error: '缺少图片数据' }); const match = imageData.match(/^data:image\/(\w+);base64,(.+)/); if (!match) return send(res, 400, { error: '无效的图片数据格式' }); const ext = match[1] === 'jpeg' ? 'jpg' : match[1]; const buf = Buffer.from(match[2], 'base64'); return send(res, 200, { url: await saveReferenceToStorage(buf, ext) }); }
  if (req.method === 'POST' && req.url === '/api/save-image') { const { imageUrl } = await readJson(req); if (!imageUrl) return send(res, 400, { error: '缺少图片地址' }); return send(res, 200, { url: await saveImage(imageUrl) }); }
  if (req.method === 'GET' && req.url === '/api/projects') return send(res, 200, await readProjects());
  if (req.method === 'POST' && req.url === '/api/projects') { const list = await readJson(req); await writeProjects(Array.isArray(list) ? list : []); return send(res, 200, { ok: true }); }
  if (req.method === 'GET' && req.url === '/api/config') { try { const r = await new Promise((resolve, reject) => { cos.getObject({ Bucket: cosConfig.Bucket, Region: cosConfig.Region, Key: 'data/api-config.json' }, (err, result) => err ? reject(err) : resolve(result.Body.toString('utf8'))); }); return send(res, 200, r, 'application/json; charset=utf-8'); } catch { return send(res, 200, '{}', 'application/json; charset=utf-8'); } }
  if (req.method === 'POST' && req.url === '/api/config') { const cfg = await readJson(req); await uploadToCos(Buffer.from(JSON.stringify(cfg, null, 2), 'utf8'), 'data/api-config.json'); return send(res, 200, { ok: true }); }
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
  const relative = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) return send(res, 403, { error: 'Forbidden' });
  const ext = path.extname(file);
  if (!types[ext]) return send(res, 415, { error: 'Unsupported type' });
  if (!fs.existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(file), types[ext]);
} catch (error) { send(res, 500, { error: error.message || '本地服务错误' }); } });
server.listen(port, () => console.log(`FrameLab is running on port ${port} (COS: ${cosEnabled ? 'enabled' : 'disabled'})`));
server.timeout = 300000;
server.keepAliveTimeout = 65000;

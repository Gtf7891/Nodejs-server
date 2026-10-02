import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { jwt, sign } from 'hono/jwt';
import bcrypt from 'bcryptjs';
import { ZipWriter, BlobWriter, BlobReader } from '@zip.js/zip.js';
import { PNG } from 'pngjs';
import si from 'systeminformation';
import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SHARED_DIR = path.join(DATA_DIR, 'shared');
const CLOUD_DIR  = path.join(DATA_DIR, 'cloud');
const CHUNK_DIR  = path.join(DATA_DIR, 'chunks');
const TICKET_FILE = path.join(DATA_DIR, 'tickets.json');
const IMG_DIR    = path.join(DATA_DIR, 'images');

for (const d of [DATA_DIR, SHARED_DIR, CLOUD_DIR, CHUNK_DIR, IMG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
if (!fs.existsSync(USERS_FILE))  fs.writeFileSync(USERS_FILE, '[]');
if (!fs.existsSync(TICKET_FILE)) fs.writeFileSync(TICKET_FILE, '{}');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('缺少 JWT_SECRET'); process.exit(1); }

// ============ 模型部分 ============
const RAW_STAND = JSON.parse(fs.readFileSync(path.join(__dirname, 'stand.json'), 'utf-8'));
const RAW_DOLL  = JSON.parse(fs.readFileSync(path.join(__dirname, 'doll.json'),  'utf-8'));
const ARM_STAND = { rIn: 4, rOut: 5, lIn: 6, lOut: 7 };
const ARM_DOLL  = { rIn: 4, rOut: 5, lIn: 6, lOut: 7 };

function rewriteTextures(m) {
  const o = structuredClone(m);
  if (o.textures) for (const k of Object.keys(o.textures)) {
    if (typeof o.textures[k] === 'string') {
      o.textures[k] = o.textures[k]
        .replace('item/totem_of_undying', 'item/custom_totem')
        .replace('item_of_undying',       'item/custom_totem');
    }
  }
  return o;
}
function scaleUVWidth(f, k) {
  if (!f?.uv) return;
  const [x1,y1,x2,y2] = f.uv;
  f.uv = [x1, y1, +(x1 + (x2-x1)*k).toFixed(4), y2];
}
function scaleArmUV(el, k) {
  if (!el?.faces) return;
  for (const f of ['north','south','up','down']) scaleUVWidth(el.faces[f], k);
}
function makeSlim(model, arms) {
  const o = structuredClone(model);
  const { rIn, rOut, lIn, lOut } = arms;
  for (const i of [rIn,rOut,lIn,lOut]) if (o.elements[i]) scaleArmUV(o.elements[i], 0.75);
  if (o.elements[rIn])  o.elements[rIn].to[0]   = 7;
  if (o.elements[rOut]) o.elements[rOut].to[0]  = 7.25;
  if (o.elements[lIn])  o.elements[lIn].from[0]  = -7;
  if (o.elements[lOut]) o.elements[lOut].from[0] = -7.25;
  return o;
}
function makeWide(model, arms) {
  const o = structuredClone(model);
  const { rIn, rOut, lIn, lOut } = arms;
  for (const i of [rIn,rOut,lIn,lOut]) if (o.elements[i]) scaleArmUV(o.elements[i], 1/0.75);
  return o;
}
const STAND_WIDE = rewriteTextures(RAW_STAND);
const STAND_SLIM = makeSlim(STAND_WIDE, ARM_STAND);
const DOLL_SLIM  = rewriteTextures(RAW_DOLL);
const DOLL_WIDE  = makeWide(DOLL_SLIM, ARM_DOLL);
const MODELS = {
  'stand-wide': STAND_WIDE, 'stand-slim': STAND_SLIM,
  'doll-wide':  DOLL_WIDE,  'doll-slim':  DOLL_SLIM
};

function detectVariant(buf) {
  try {
    const png = PNG.sync.read(buf);
    if (png.width !== 64 || png.height !== 64) return 'wide';
    let opaque = 0;
    for (let y = 20; y < 32; y++)
      for (let x = 54; x < 56; x++)
        if (png.data[(y*64+x)*4+3] > 0) opaque++;
    return opaque === 0 ? 'slim' : 'wide';
  } catch { return 'wide'; }
}

// ============ 工具 ============
const TRUSTED = /^(127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/;
function getClientIP(c) {
  const sock = c.env?.incoming?.socket || c.env?.incoming?.connection;
  const addr = sock?.remoteAddress || '';
  if (TRUSTED.test(addr)) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    const xri = c.req.header('x-real-ip');
    if (xri) return xri;
  }
  return addr || 'unknown';
}
function loadUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE,'utf-8')); } catch { return []; } }
function saveUsers(u) {
  const t = USERS_FILE + '.tmp';
  fs.writeFileSync(t, JSON.stringify(u, null, 2));
  fs.renameSync(t, USERS_FILE);
}
function loadTickets() { try { return JSON.parse(fs.readFileSync(TICKET_FILE,'utf-8')); } catch { return {}; } }
function saveTickets(o) {
  const t = TICKET_FILE + '.tmp';
  fs.writeFileSync(t, JSON.stringify(o, null, 2));
  fs.renameSync(t, TICKET_FILE);
}
function safeName(n) {
  return String(n).replace(/[\/\\\0<>:"|?*]/g, '_').slice(0, 200);
}
function fmtDate(d) { return new Date(d).toISOString(); }

const app = new Hono();
app.use('/*', serveStatic({ root: path.join(__dirname, 'public') }));

// ============ 注册 / 登录 ============
app.post('/api/register', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  if (!username || !password) return c.json({ error: '用户名和密码不能为空' }, 400);
  if (username.length > 32 || password.length < 6)
    return c.json({ error: '用户名 ≤ 32 字符，密码 ≥ 6 位' }, 400);

  const ip = getClientIP(c);
  const users = loadUsers();
  if (users.find(u => u.ip === ip)) return c.json({ error: '该 IP 已注册' }, 403);
  if (users.find(u => u.username === username)) return c.json({ error: '用户名已存在' }, 409);

  const hash = await bcrypt.hash(password, 10);
  const user = { id: crypto.randomBytes(8).toString('hex'), username, password: hash, ip, createdAt: fmtDate(Date.now()) };
  users.push(user); saveUsers(users);

  const token = await sign({ id: user.id, username: user.username, exp: Math.floor(Date.now()/1000) + 7*24*3600 }, JWT_SECRET);
  return c.json({ token, username: user.username });
});

app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = loadUsers().find(u => u.username === username);
  if (!user || !(await bcrypt.compare(password, user.password || '')))
    return c.json({ error: '用户名或密码错误' }, 401);
  const token = await sign({ id: user.id, username: user.username, exp: Math.floor(Date.now()/1000) + 7*24*3600 }, JWT_SECRET);
  return c.json({ token, username: user.username });
});

const requireAuth = jwt({ secret: JWT_SECRET, alg: 'HS256' });

// ============ 服务器性能（简版，保留兼容） ============
app.get('/api/stats', requireAuth, async (c) => {
  try {
    const [cpu, mem, fsSize, temp] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature().catch(() => ({ main: null }))
    ]);
    const root = fsSize.find(f => f.mount === '/' || f.mount === '/opt') || fsSize[0] || {};
    return c.json({
      cpu: +cpu.currentLoad.toFixed(1),
      cpuTemp: temp.main ?? null,
      ramUsed: mem.active,
      ramTotal: mem.total,
      diskUsed: root.used || 0,
      diskTotal: root.size || 0,
      uptime: si.time().uptime
    });
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

// ============ 服务器性能（详细版） ============
app.get('/api/stats/full', requireAuth, async (c) => {
  try {
    const [cpu, mem, fsSize, temp, cpuInfo, osInfo, netIfaces, netStats, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpuTemperature().catch(() => ({ main: null, cores: [], max: null })),
      si.cpu(),
      si.osInfo(),
      si.networkInterfaces().catch(() => []),
      si.networkStats().catch(() => []),
      si.processes().catch(() => ({ all: 0, running: 0, sleeping: 0 }))
    ]);

    const rootFs = fsSize.find(f => f.mount === '/' || f.mount === '/opt') || fsSize[0] || {};

    // 网络接口汇总（排除回环）
    const netList = Array.isArray(netStats) ? netStats : (netStats ? [netStats] : []);
    let rxTotal = 0, txTotal = 0;
    for (const n of netList) {
      if (n.iface === 'lo' || (n.iface && n.iface.startsWith('lo'))) continue;
      rxTotal += n.rx_sec || 0;
      txTotal += n.tx_sec || 0;
    }

    // CPU 每核心负载
    const coresLoad = (cpu.cpus || []).map((x, i) => ({
      core: i,
      load: +(x.load || 0).toFixed(1),
      user: +(x.user || 0).toFixed(1),
      system: +(x.system || 0).toFixed(1),
      idle: +(x.idle || 0).toFixed(1)
    }));

    // Load average（用 Node 内置 os）
    const loadAvg = os.loadavg(); // [1m, 5m, 15m]

    return c.json({
      cpu: {
        currentLoad: +(cpu.currentLoad || 0).toFixed(1),
        currentLoadUser: +(cpu.currentLoadUser || 0).toFixed(1),
        currentLoadSystem: +(cpu.currentLoadSystem || 0).toFixed(1),
        currentLoadIdle: +(cpu.currentLoadIdle || 0).toFixed(1),
        currentLoadNice: +(cpu.currentLoadNice || 0).toFixed(1),
        currentLoadIrq: +(cpu.currentLoadIrq || 0).toFixed(1),
        cores: coresLoad,
        temp: temp.main ?? null,
        tempMax: temp.max ?? null,
        tempCores: temp.cores || [],
        manufacturer: cpuInfo.manufacturer || '',
        brand: cpuInfo.brand || '',
        speed: cpuInfo.speed || 0,
        coresCount: cpuInfo.cores || 0,
        physicalCores: cpuInfo.physicalCores || 0,
        processors: cpuInfo.processors || 0,
        socket: cpuInfo.socket || ''
      },
      memory: {
        total: mem.total || 0,
        used: mem.active || 0,
        free: mem.free || 0,
        available: mem.available || 0,
        active: mem.active || 0,
        buffcache: mem.buffcache || 0,
        buffers: mem.buffers || 0,
        cached: mem.cached || 0,
        slab: mem.slab || 0,
        swapTotal: mem.swaptotal || 0,
        swapUsed: mem.swapused || 0,
        swapFree: mem.swapfree || 0,
        usagePercent: mem.total ? +((mem.active || 0) / mem.total * 100).toFixed(1) : 0
      },
      disk: {
        mount: rootFs.mount || '/',
        fs: rootFs.fs || '',
        type: rootFs.type || '',
        size: rootFs.size || 0,
        used: rootFs.used || 0,
        available: rootFs.available || 0,
        usePercent: rootFs.use || 0,
        allMounts: fsSize.map(f => ({
          fs: f.fs, mount: f.mount, type: f.type,
          size: f.size, used: f.used, available: f.available, use: f.use
        }))
      },
      network: {
        rxSec: rxTotal,
        txSec: txTotal,
        interfaces: netList.map(n => ({
          iface: n.iface || '',
          rxSec: n.rx_sec || 0,
          txSec: n.tx_sec || 0,
          rxBytes: n.rx_bytes || 0,
          txBytes: n.tx_bytes || 0,
          operstate: n.operstate || ''
        })),
        allInterfaces: (Array.isArray(netIfaces) ? netIfaces : []).map(n => ({
          iface: n.iface || '',
          ip4: n.ip4 || '',
          ip6: n.ip6 || '',
          mac: n.mac || '',
          speed: n.speed || 0,
          operstate: n.operstate || '',
          type: n.type || ''
        }))
      },
      system: {
        uptime: si.time().uptime || 0,
        platform: osInfo.platform || '',
        distro: osInfo.distro || '',
        release: osInfo.release || '',
        kernel: osInfo.kernel || '',
        arch: osInfo.arch || '',
        hostname: osInfo.hostname || '',
        load1: +(loadAvg[0] || 0).toFixed(2),
        load5: +(loadAvg[1] || 0).toFixed(2),
        load15: +(loadAvg[2] || 0).toFixed(2),
        processes: processes.all || 0,
        processesRunning: processes.running || 0,
        processesSleeping: processes.sleeping || 0
      }
    });
  } catch (e) {
    console.error('stats/full error:', e);
    return c.json({ error: e.message }, 500);
  }
});

// ============ 用户数据隔离 ============
function loadUserTickets(userId) {
  const all = loadTickets();
  if (!all[userId]) {
    all[userId] = {
      list: [],
      updatedAt: null,
      updatedBy: null,
      votes: { candidates: [], counts: [], updatedAt: null }
    };
  }
  return all[userId];
}
function saveUserTickets(userId, data) {
  const all = loadTickets();
  all[userId] = data;
  saveTickets(all);
}

// ============ 抽签器 ============
app.get('/api/tickets', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  return c.json({ list: t.list || [], updatedAt: t.updatedAt || null, updatedBy: t.updatedBy || null });
});

app.post('/api/tickets', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const list = Array.isArray(body.list) ? body.list.filter(x => typeof x === 'string' && x.trim()) : [];
  if (!list.length) return c.json({ error: '列表为空' }, 400);
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  t.list = list.map(s => s.trim());
  t.updatedAt = fmtDate(Date.now());
  t.updatedBy = c.get('jwtPayload').username;
  saveUserTickets(uid, t);
  return c.json({ list: t.list, updatedAt: t.updatedAt, updatedBy: t.updatedBy });
});

app.post('/api/tickets/reset', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  t.list = [];
  t.updatedAt = fmtDate(Date.now());
  t.updatedBy = c.get('jwtPayload').username;
  saveUserTickets(uid, t);
  return c.json({ list: [], updatedAt: t.updatedAt, updatedBy: t.updatedBy });
});

// ============ 记票器 ============
app.get('/api/votes', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  return c.json(t.votes || { candidates: [], counts: [], updatedAt: null });
});

app.post('/api/votes', requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cands = Array.isArray(body.candidates)
    ? body.candidates.map(s => String(s).trim()).filter(Boolean).slice(0, 200) : [];
  const counts = cands.map((_, i) => Number(body.counts?.[i]) || 0);
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  t.votes = { candidates: cands, counts, updatedAt: fmtDate(Date.now()) };
  saveUserTickets(uid, t);
  return c.json(t.votes);
});

app.post('/api/votes/bump', requireAuth, async (c) => {
  const { index, delta } = await c.req.json().catch(() => ({}));
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  if (!t.votes?.candidates?.length) return c.json({ error: '尚未设置候选人' }, 400);
  const i = Number(index);
  if (i < 0 || i >= t.votes.candidates.length) return c.json({ error: '索引无效' }, 400);
  t.votes.counts[i] = Math.max(0, (t.votes.counts[i] || 0) + (Number(delta) || 0));
  t.votes.updatedAt = fmtDate(Date.now());
  saveUserTickets(uid, t);
  return c.json(t.votes);
});

app.post('/api/votes/reset', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  t.votes = { candidates: [], counts: [], updatedAt: fmtDate(Date.now()) };
  saveUserTickets(uid, t);
  return c.json(t.votes);
});

// ============ Minecraft 皮肤查询 ============
const skinCache = new Map();
const SKIN_CACHE_TTL = 30 * 60 * 1000;

const API_SOURCES = {
  auto:              { name: '自动（先官方，失败后 Minotar）', desc: '依次尝试所有源，任一成功即返回' },
  minecraftservices: { name: 'Minecraft Services', desc: '微软官方接口，返回 UUID' },
  minotar:           { name: 'Minotar',            desc: '直接用用户名渲染，不查 UUID' }
};

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'totem-server/1.0' },
      signal: controller.signal
    });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function tryMinecraftServices(username) {
  try {
    const r = await fetchWithTimeout(`https://api.minecraftservices.com/minecraft/profile/lookup/name/${encodeURIComponent(username)}`);
    if (r.status === 204 || r.status === 404) return { notFound: true };
    if (r.status === 429) return { rateLimited: true };
    if (!r.ok) return null;
    const data = await r.json();
    if (!data?.id) return { notFound: true };
    return { id: data.id, name: data.name, source: 'minecraftservices' };
  } catch { return null; }
}

async function tryMinotar(username) {
  // Minotar 不查 UUID，直接用用户名渲染，永远视为成功
  return { id: '', name: username, source: 'minotar', noUuid: true };
}

const SOURCE_FNS = {
  minecraftservices: tryMinecraftServices,
  minotar:           tryMinotar
};

app.get('/api/mc/sources', (c) => {
  return c.json(Object.entries(API_SOURCES).map(([key, v]) => ({ key, ...v })));
});

app.get('/api/mc/profile/:username', async (c) => {
  const username = c.req.param('username');
  const sourceParam = c.req.query('source') || 'auto';

  if (!username || username.length > 32 || !/^[A-Za-z0-9_]+$/.test(username)) {
    return c.json({ error: '用户名不合法' }, 400);
  }

  if (sourceParam === 'auto') {
    const cached = skinCache.get(username.toLowerCase());
    if (cached && Date.now() - cached.ts < SKIN_CACHE_TTL) {
      return c.json({ id: cached.id, name: cached.name, source: cached.source, cached: true });
    }
  }

  let sourcesToTry;
  if (sourceParam === 'auto') {
    sourcesToTry = Object.keys(SOURCE_FNS);
  } else if (SOURCE_FNS[sourceParam]) {
    sourcesToTry = [sourceParam];
  } else {
    return c.json({ error: '未知的查询接口：' + sourceParam, available: Object.keys(SOURCE_FNS) }, 400);
  }

  let rateLimited = false;
  const triedSources = [];

  for (const key of sourcesToTry) {
    triedSources.push(API_SOURCES[key]?.name || key);
    const result = await SOURCE_FNS[key](username);

    // 修复：用 name 判断成功，允许 id 为空（Minotar）
    if (result && result.name) {
      if (result.id) {
        skinCache.set(username.toLowerCase(), {
          id: result.id, name: result.name, source: result.source, ts: Date.now()
        });
      }
      return c.json({
        id: result.id || '',
        name: result.name,
        source: result.source,
        noUuid: !!result.noUuid,
        tried: triedSources
      });
    }

    if (result?.rateLimited) {
      rateLimited = true;
      continue;
    }
  }

  if (rateLimited) {
    return c.json({ error: '查询源被限流或不可用，请稍后再试', tried: triedSources }, 503);
  }
  return c.json({
    error: '未找到该玩家。请确认这是 Java 版用户名（非 Xbox Gamertag），且拼写正确。',
    tried: triedSources,
    hint: 'Java 版用户名在 minecraft.net 个人资料页查看，最多 16 字符，只能用字母、数字、下划线'
  }, 404);
});

// ============ 图片格式转换 ============
const CONVERT_FORMATS = {
  webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  png: 'image/png', avif: 'image/avif', tiff: 'image/tiff'
};

app.post('/api/convert/image', requireAuth, async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    const formatIn = String(form.get('format') || 'webp').toLowerCase();
    const quality = Math.min(100, Math.max(1, parseInt(form.get('quality')) || 80));

    if (!file || typeof file === 'string') return c.json({ error: '请上传图片文件' }, 400);
    if (file.size > 20 * 1024 * 1024) return c.json({ error: '图片 ≤ 20MB' }, 400);
    if (!CONVERT_FORMATS[formatIn]) return c.json({ error: '不支持的格式' }, 400);

    const outFormat = formatIn === 'jpg' ? 'jpeg' : formatIn;
    const buf = Buffer.from(await file.arrayBuffer());
    let pipeline = sharp(buf, { failOn: 'none' });
    const meta = await pipeline.metadata().catch(() => ({}));

    if (outFormat === 'webp')      pipeline = pipeline.webp({ quality });
    else if (outFormat === 'jpeg') pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    else if (outFormat === 'png')  pipeline = pipeline.png({ compressionLevel: 9 });
    else if (outFormat === 'avif') pipeline = pipeline.avif({ quality });
    else if (outFormat === 'tiff') pipeline = pipeline.tiff({ quality });

    const outBuf = await pipeline.toBuffer();
    const ext = outFormat === 'jpeg' ? 'jpg' : outFormat;

    return new Response(outBuf, {
      headers: {
        'Content-Type': CONVERT_FORMATS[formatIn],
        'Content-Disposition': `attachment; filename="converted.${ext}"`,
        'X-Original-Size': String(buf.length),
        'X-Converted-Size': String(outBuf.length),
        'X-Original-Width': String(meta.width || 0),
        'X-Original-Height': String(meta.height || 0),
        'Access-Control-Expose-Headers': 'X-Original-Size, X-Converted-Size, X-Original-Width, X-Original-Height'
      }
    });
  } catch (e) {
    console.error('convert error:', e);
    return c.json({ error: '转换失败：' + e.message }, 500);
  }
});

app.post('/api/convert/info', requireAuth, async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return c.json({ error: '缺少文件' }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    return c.json({
      format: meta.format || 'unknown', width: meta.width || 0, height: meta.height || 0,
      size: buf.length, space: meta.space || null, channels: meta.channels || null, hasAlpha: meta.hasAlpha || false
    });
  } catch (e) { return c.json({ error: e.message }, 500); }
});

// ============ 图床 ============
function userImgDir(uid) {
  const d = path.join(IMG_DIR, uid);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

app.post('/api/images/upload', requireAuth, async (c) => {
  try {
    const uid = c.get('jwtPayload').id;
    const form = await c.req.formData();
    const files = form.getAll('files').filter(f => f && typeof f !== 'string');
    if (!files.length) return c.json({ error: '请选择图片' }, 400);
    if (files.length > 20) return c.json({ error: '单次最多 20 张' }, 400);

    const results = [];
    const t = loadUserTickets(uid);
    t.images = t.images || [];

    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { results.push({ ok: false, name: file.name, error: '文件 > 10MB' }); continue; }
      const buf = Buffer.from(await file.arrayBuffer());
      const isPng  = buf[0] === 0x89 && buf[1] === 0x50;
      const isJpg  = buf[0] === 0xFF && buf[1] === 0xD8;
      const isGif  = buf[0] === 0x47 && buf[1] === 0x49;
      const isWebp = buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45;
      if (!isPng && !isJpg && !isGif && !isWebp) { results.push({ ok: false, name: file.name, error: '不是有效图片' }); continue; }

      const ext = isPng ? 'png' : isJpg ? 'jpg' : isGif ? 'gif' : 'webp';
      const name = crypto.randomBytes(10).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(userImgDir(uid), name), buf);

      let width = 0, height = 0;
      try { const m = await sharp(buf).metadata(); width = m.width || 0; height = m.height || 0; } catch {}

      const record = { name, originalName: String(file.name || '').slice(0, 200), size: buf.length, ext, width, height, createdAt: Date.now() };
      t.images.push(record);
      results.push({ ok: true, ...record, url: `/api/i/${name}` });
    }

    saveUserTickets(uid, t);
    return c.json({ results });
  } catch (e) {
    console.error('image upload error:', e);
    return c.json({ error: '上传失败：' + e.message }, 500);
  }
});

app.get('/api/images', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const t = loadUserTickets(uid);
  const list = (t.images || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  return c.json(list.map(x => ({ ...x, url: `/api/i/${x.name}` })));
});

app.delete('/api/images/:name', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const name = safeName(c.req.param('name'));
  const fp = path.join(userImgDir(uid), name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const t = loadUserTickets(uid);
  t.images = (t.images || []).filter(i => i.name !== name);
  saveUserTickets(uid, t);
  return c.json({ ok: true });
});

app.get('/api/i/:name', (c) => {
  const name = safeName(c.req.param('name'));
  if (!/^[a-f0-9]{20}\.(png|jpg|gif|webp|avif)$/.test(name)) return c.json({ error: '非法' }, 400);
  try {
    for (const uid of fs.readdirSync(IMG_DIR)) {
      const fp = path.join(IMG_DIR, uid, name);
      if (fs.existsSync(fp)) {
        const ext = name.split('.').pop();
        const mime = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' }[ext] || 'application/octet-stream';
        return new Response(fs.readFileSync(fp), {
          headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }
  } catch {}
  return c.json({ error: '不存在' }, 404);
});

// ============ 网盘 ============
function userCloudDir(userId) {
  const d = path.join(CLOUD_DIR, userId);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

app.get('/api/cloud', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const d = userCloudDir(uid);
  const list = fs.readdirSync(d)
    .filter(f => !f.endsWith('.part') && !f.endsWith('.share.json'))
    .map(f => { const st = fs.statSync(path.join(d, f)); return { name: f, size: st.size, mtime: st.mtime }; })
    .sort((a, b) => b.mtime - a.mtime);
  return c.json(list);
});

app.get('/api/cloud/download/:name', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const name = safeName(c.req.param('name'));
  const fp = path.join(userCloudDir(uid), name);
  if (!fs.existsSync(fp)) return c.json({ error: '不存在' }, 404);
  const stat = fs.statSync(fp);
  const total = stat.size;
  const range = c.req.header('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1]) : 0;
      const end = m[2] ? parseInt(m[2]) : Math.min(start + 1024*1024 - 1, total - 1);
      if (start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      const stream = fs.createReadStream(fp, { start, end });
      return new Response(stream, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': 'application/octet-stream' } });
    }
  }
  const stream = fs.createReadStream(fp);
  return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` } });
});

app.post('/api/cloud/upload/init', requireAuth, async (c) => {
  const { filename, totalSize } = await c.req.json().catch(() => ({}));
  if (!filename) return c.json({ error: '缺少文件名' }, 400);
  const uid = c.get('jwtPayload').id;
  const uploadId = crypto.randomBytes(12).toString('hex');
  const dir = path.join(CHUNK_DIR, uid, uploadId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ filename: safeName(filename), totalSize: Number(totalSize) || 0, createdAt: Date.now() }));
  return c.json({ uploadId });
});

app.post('/api/cloud/upload/chunk', requireAuth, async (c) => {
  const uid = c.get('jwtPayload').id;
  const form = await c.req.formData();
  const uploadId = String(form.get('uploadId') || '');
  const index = parseInt(form.get('index'));
  const file = form.get('chunk');
  if (!uploadId || Number.isNaN(index) || !file || typeof file === 'string') return c.json({ error: '参数不完整' }, 400);
  const dir = path.join(CHUNK_DIR, uid, uploadId);
  if (!fs.existsSync(dir)) return c.json({ error: '上传会话不存在' }, 404);
  const buf = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(path.join(dir, `${index}.part`), buf);
  return c.json({ ok: true });
});

app.post('/api/cloud/upload/complete', requireAuth, async (c) => {
  const uid = c.get('jwtPayload').id;
  const { uploadId } = await c.req.json().catch(() => ({}));
  const dir = path.join(CHUNK_DIR, uid, String(uploadId));
  if (!fs.existsSync(dir)) return c.json({ error: '上传会话不存在' }, 404);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
  const parts = fs.readdirSync(dir).filter(f => f.endsWith('.part')).map(f => ({ i: parseInt(f), p: path.join(dir, f) })).sort((a, b) => a.i - b.i);
  const target = path.join(userCloudDir(uid), meta.filename);
  const ws = fs.createWriteStream(target);
  for (const { p } of parts) {
    await new Promise((res, rej) => { const rs = fs.createReadStream(p); rs.pipe(ws, { end: false }); rs.on('end', res); rs.on('error', rej); });
  }
  ws.end();
  await new Promise(res => ws.on('finish', res));
  fs.rmSync(dir, { recursive: true, force: true });
  return c.json({ ok: true, name: meta.filename });
});

app.delete('/api/cloud/:name', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const name = safeName(c.req.param('name'));
  const fp = path.join(userCloudDir(uid), name);
  if (!fs.existsSync(fp)) return c.json({ error: '不存在' }, 404);
  fs.unlinkSync(fp);
  const sp = path.join(userCloudDir(uid), name + '.share.json');
  if (fs.existsSync(sp)) fs.unlinkSync(sp);
  return c.json({ ok: true });
});

app.post('/api/cloud/share/:name', requireAuth, (c) => {
  const uid = c.get('jwtPayload').id;
  const name = safeName(c.req.param('name'));
  const dir = userCloudDir(uid);
  const fp = path.join(dir, name);
  if (!fs.existsSync(fp)) return c.json({ error: '文件不存在' }, 404);
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, name + '.share.json'), JSON.stringify({ token, name, createdAt: Date.now() }));
  return c.json({ url: `/api/cloud/public/${token}` });
});

app.get('/api/cloud/public/:token', (c) => {
  const token = c.req.param('token');
  if (!/^[a-f0-9]{32}$/.test(token)) return c.json({ error: '非法 token' }, 400);
  if (!fs.existsSync(CLOUD_DIR)) return c.json({ error: '不存在' }, 404);
  for (const uid of fs.readdirSync(CLOUD_DIR)) {
    const dir = path.join(CLOUD_DIR, uid);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.share.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (j.token !== token) continue;
        const fp = path.join(dir, j.name);
        if (!fs.existsSync(fp)) continue;
        const stat = fs.statSync(fp);
        const total = stat.size;
        const range = c.req.header('range');
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          if (m) {
            const start = m[1] ? parseInt(m[1]) : 0;
            const end = m[2] ? parseInt(m[2]) : Math.min(start + 1024*1024 - 1, total - 1);
            if (start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
            const stream = fs.createReadStream(fp, { start, end });
            return new Response(stream, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': 'application/octet-stream' } });
          }
        }
        const stream = fs.createReadStream(fp);
        return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(j.name)}` } });
      } catch {}
    }
  }
  return c.json({ error: '分享已失效' }, 404);
});

// ============ 图腾生成 ============
function buildSharedName(pose, variant, username) {
  const poseZh = pose === 'stand' ? '站立' : '娃娃';
  const safeUser = username.replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 20);
  return `${poseZh}-${variant}-${safeUser}-${Date.now()}.zip`;
}

app.post('/api/generate', requireAuth, async (c) => {
  const payload = c.get('jwtPayload');
  if (!payload) return c.json({ error: '请先登录' }, 401);
  const form = await c.req.formData();
  const version   = String(form.get('version') || '1.21.5');
  const variantIn = String(form.get('variant') || 'auto');
  const pose      = String(form.get('pose')    || 'stand');
  const share     = form.get('share') !== 'false';
  const skinFile  = form.get('skin');
  if (!skinFile || typeof skinFile === 'string') return c.json({ error: '请上传皮肤文件' }, 400);
  const skinBuffer = Buffer.from(await skinFile.arrayBuffer());
  try {
    const png = PNG.sync.read(skinBuffer);
    if (png.width !== 64 || png.height !== 64) return c.json({ error: '仅支持 64×64 皮肤' }, 400);
  } catch { return c.json({ error: '无法解析 PNG' }, 400); }

  let variant = variantIn === 'auto' ? detectVariant(skinBuffer) : variantIn;
  if (!['wide','slim'].includes(variant)) variant = 'wide';
  if (!['stand','doll'].includes(pose))   pose = 'stand';

  const files = buildPack({ version, variant, pose, skinBuffer });
  const zw = new ZipWriter(new BlobWriter('application/zip'));
  for (const [p, blob] of Object.entries(files)) await zw.add(p, new BlobReader(blob));
  const zipBuf = Buffer.from(await (await zw.close()).arrayBuffer());

  if (share) fs.writeFileSync(path.join(SHARED_DIR, buildSharedName(pose, variant, payload.username)), zipBuf);
  return new Response(zipBuf, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="totem_${version}_${variant}_${pose}.zip"` } });
});

app.get('/api/shared', requireAuth, (c) => {
  const list = fs.readdirSync(SHARED_DIR).filter(f => f.endsWith('.zip')).map(f => {
    const st = fs.statSync(path.join(SHARED_DIR, f));
    return { name: f, size: st.size, mtime: st.mtime, url: `/api/shared/${encodeURIComponent(f)}` };
  }).sort((a, b) => b.mtime - a.mtime);
  return c.json(list);
});

app.get('/api/shared/:name', requireAuth, (c) => {
  const name = c.req.param('name');
  if (!name.endsWith('.zip') || name.includes('/') || name.includes('..') || name.includes('\0')) return c.json({ error: '非法' }, 400);
  const fp = path.join(SHARED_DIR, name);
  if (!fs.existsSync(fp)) return c.json({ error: '不存在' }, 404);
  return new Response(fs.readFileSync(fp), { headers: { 'Content-Type': 'application/zip' } });
});

// ============ 资源包构建 ============
const PACK_FORMATS = {
  '1.21.5': { format: 55, style: 'items'  }, '1.21.4': { format: 46, style: 'items'  },
  '1.21.3': { format: 42, style: 'legacy' }, '1.21.1': { format: 34, style: 'legacy' },
  '1.20.6': { format: 32, style: 'legacy' }, '1.20.4': { format: 22, style: 'legacy' },
  '1.20.2': { format: 18, style: 'legacy' }, '1.20.1': { format: 15, style: 'legacy' },
  '1.19.4': { format: 13, style: 'legacy' }, '1.19.2': { format: 9,  style: 'legacy' },
  '1.18.2': { format: 8,  style: 'legacy' }, '1.17.1': { format: 7,  style: 'legacy' },
  '1.16.5': { format: 6,  style: 'legacy' }, '1.16.1': { format: 5,  style: 'legacy' },
  '1.14.4': { format: 4,  style: 'legacy' }, '1.12.2': { format: 3,  style: 'legacy' },
  '1.8.9':  { format: 1,  style: 'legacy' }
};
function jsonBlob(o) { return new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }); }

function buildPack({ version, variant, pose, skinBuffer }) {
  const entry = PACK_FORMATS[version] || PACK_FORMATS['1.21.5'];
  const files = {};
  const meta = { pack: { pack_format: entry.format, description: `不死图腾 doll (${variant}, ${pose === 'stand' ? '站立' : '娃娃'})` } };
  if (entry.format >= 18) meta.pack.supported_formats = [4, entry.format];
  files['pack.mcmeta'] = jsonBlob(meta);
  files['assets/minecraft/textures/item/custom_totem.png'] = new Blob([skinBuffer], { type: 'image/png' });
  files['assets/minecraft/models/item/custom_totem.json'] = jsonBlob(MODELS[`${pose}-${variant}`]);
  if (entry.style === 'items') {
    files['assets/minecraft/items/totem_of_undying.json'] = jsonBlob({ model: { type: 'minecraft:model', model: 'minecraft:item/custom_totem' } });
  } else {
    files['assets/minecraft/models/item/totem_of_undying.json'] = jsonBlob({ parent: 'minecraft:item/custom_totem' });
  }
  return files;
}

// ============ 启动 ============
const port = 3000;
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`服务已启动 http://0.0.0.0:${info.port}`);
});

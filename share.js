// 分享辅助模块（被 server.js import）
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const SHARE_FILE_SUFFIX = '.share.json';

export function makeShareToken() {
  return crypto.randomBytes(16).toString('hex');
}

export function sharePath(cloudDir, name) {
  return path.join(cloudDir, path.basename(name) + SHARE_FILE_SUFFIX);
}

export function createShare(cloudDir, name) {
  const token = makeShareToken();
  fs.writeFileSync(sharePath(cloudDir, name), JSON.stringify({
    token, name, createdAt: Date.now()
  }));
  return token;
}

export function readShare(cloudDir, token) {
  const dir = cloudDir;
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(SHARE_FILE_SUFFIX)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (j.token === token) {
        const fp = path.join(dir, j.name);
        if (fs.existsSync(fp)) return { name: j.name, path: fp };
      }
    } catch {}
  }
  return null;
}

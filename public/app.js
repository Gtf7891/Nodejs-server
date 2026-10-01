const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
const userInfo = document.getElementById('user-info');

if (token && username) {
  userInfo.textContent = `已登录：${username}`;
} else {
  userInfo.innerHTML = '未登录，<a href="/login.html">请先登录</a>';
}

document.getElementById('generate').addEventListener('click', async () => {
  const status = document.getElementById('status');

  if (!token) { location.href = '/login.html'; return; }

  const version = document.getElementById('version').value;
  const pose    = document.getElementById('pose').value;
  const variant = document.getElementById('variant').value;
  const share   = document.getElementById('share').checked;
  const file    = document.getElementById('skin').files[0];

  if (!file) { status.textContent = '请先选择皮肤文件'; return; }

  status.textContent = '正在生成...';

  const fd = new FormData();
  fd.append('version', version);
  fd.append('pose', pose);
  fd.append('variant', variant);
  fd.append('share', String(share));
  fd.append('skin', file);

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: fd
    });

    if (res.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('username');
      location.href = '/login.html';
      return;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '生成失败');
    }

    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `totem_${version}_${variant}_${pose}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    status.textContent = '✅ 生成完成，已开始下载';
  } catch (e) {
    status.textContent = `❌ ${e.message}`;
  }
});

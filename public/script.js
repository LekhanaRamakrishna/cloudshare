/**
 * CloudShare — script.js (v3)
 * - Loads all files from DB on every login (persistent)
 * - Download count updates live in DB
 * - Full dark/light theme support
 */

let allFiles      = [];
let deleteTarget  = null;
let toastTimer    = null;
let dlCurrentId   = null;
let dlCurrentInfo = null;
let dlHistory     = [];

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = 'login.html'; return; }
    const data = await res.json();
    setUserInfo(data.email);
  } catch { window.location.href = 'login.html'; return; }

  applyTheme(localStorage.getItem('cs-theme') || 'dark');
  loadStats();
  loadFiles();           // loads from DB — always shows logged-in user's files
  setupDragDrop();
  setupExpiryPreview();
  setupTabNav();

  // ── Live stats refresh every 30 seconds ──
  // This keeps the expired count dynamic as files cross their expiry time
  setInterval(() => {
    loadStats();
    // Also rerender files/links so expiry badges update live
    if (allFiles.length) {
      renderFiles(allFiles);
      const activeTab = document.querySelector('.tab-panel.active');
      if (activeTab && activeTab.id === 'tab-links') renderLinks(allFiles);
      if (activeTab && activeTab.id === 'tab-activity') renderActivity();
    }
  }, 30000);
});

// ─── Theme ────────────────────────────────────────────────────────────────────
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  localStorage.setItem('cs-theme', next);
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const icon = document.getElementById('themeIcon');
  if (icon) icon.textContent = t === 'dark' ? '☀️' : '🌙';
}

// ─── User Info ────────────────────────────────────────────────────────────────
function setUserInfo(email) {
  document.getElementById('userEmailBadge').textContent   = email;
  document.getElementById('userEmailSidebar').textContent = email;
  document.getElementById('userAvatar').textContent       = email.charAt(0).toUpperCase();
}

// ─── Logout ───────────────────────────────────────────────────────────────────
async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = 'index.html';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabNav() {
  document.querySelectorAll('.nav-item').forEach(el =>
    el.addEventListener('click', e => { e.preventDefault(); showTab(el.dataset.tab); })
  );
}
function showTab(name) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const nav = document.querySelector(`[data-tab="${name}"]`);
  if (nav) nav.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(`tab-${name}`);
  if (panel) panel.classList.add('active');

  const titles = {
    files:      ['My Files',          'Manage all your shared files'],
    upload:     ['Upload File',       'Share a new file with the world'],
    links:      ['All Links',         'Every download link you have generated'],
    downloader: ['Download via Link', 'Paste any CloudShare link to download'],
    activity:   ['Activity',         'See your file activity at a glance'],
  };
  if (titles[name]) {
    document.getElementById('pageTitle').textContent    = titles[name][0];
    document.getElementById('pageSubtitle').textContent = titles[name][1];
  }
  if (name === 'activity')   renderActivity();
  if (name === 'links')      renderLinks(allFiles);
  if (name === 'downloader') renderDlHistory();
}

// ─── Stats — fetched from DB + live expired count from client ────────────────
async function loadStats() {
  try {
    const data = await (await fetch('/api/stats')).json();
    document.getElementById('statUploaded').textContent  = data.total_uploaded  || 0;
    document.getElementById('statDownloads').textContent = data.total_downloads || 0;

    // Use DB values as base; also compute live from allFiles for instant accuracy
    const now = new Date();
    const liveExpired = allFiles.filter(f => new Date(f.expiry) < now).length;
    const liveActive  = allFiles.filter(f => new Date(f.expiry) >= now).length;

    // Use whichever is higher (DB may have more rows than allFiles if recently loaded)
    const expired = Math.max(parseInt(data.expired) || 0, liveExpired);
    const active  = allFiles.length
      ? liveActive
      : (parseInt(data.active) || 0);

    document.getElementById('statExpired').textContent = expired;
    document.getElementById('statActive').textContent  = active;
  } catch {}
}

// ─── Called after files load to sync stats ────────────────────────────────────
function syncStatsFromFiles() {
  const now     = new Date();
  const expired = allFiles.filter(f => new Date(f.expiry) < now).length;
  const active  = allFiles.filter(f => new Date(f.expiry) >= now).length;
  const total   = allFiles.length;
  const downloads = allFiles.reduce((sum, f) => sum + (f.download_count || 0), 0);

  document.getElementById('statUploaded').textContent  = total;
  document.getElementById('statActive').textContent    = active;
  document.getElementById('statExpired').textContent   = expired;
  document.getElementById('statDownloads').textContent = downloads;
}

// ─── Files — loaded from DB on every login ────────────────────────────────────
async function loadFiles() {
  document.getElementById('loadingState').classList.remove('hidden');
  document.getElementById('fileTable').classList.add('hidden');
  document.getElementById('emptyState').classList.add('hidden');
  try {
    const res = await fetch('/api/files');
    if (!res.ok) throw new Error();
    allFiles = await res.json();
    renderFiles(allFiles);
    syncStatsFromFiles();   // update all 4 stat cards from live data
  } catch { showToast('⚠️ Failed to load files.', 'error'); }
  finally  { document.getElementById('loadingState').classList.add('hidden'); }
}

function renderFiles(files) {
  const table = document.getElementById('fileTable');
  const empty = document.getElementById('emptyState');
  const tbody = document.getElementById('fileTableBody');
  if (!files.length) { table.classList.add('hidden'); empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden'); table.classList.remove('hidden');
  tbody.innerHTML = '';
  files.forEach(f => {
    const exp = new Date(f.expiry) < new Date();
    const lim = f.download_count >= f.download_limit;
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="file-name-cell">
        <span class="file-type-icon">${icon(f.mime_type, f.original_name)}</span>
        <div><div class="file-name-text" title="${esc(f.original_name)}">${esc(f.original_name)}</div>
        ${f.password_protected ? '<small style="color:var(--text-muted);font-size:.72rem;">🔐 Protected</small>' : ''}</div>
      </div></td>
      <td style="color:var(--text)">${fmtSize(f.file_size)}</td>
      <td><div style="font-size:.85rem">${fmtExpiry(f.expiry,exp)}</div>
          <div style="font-size:.73rem;color:var(--text-muted);margin-top:.15rem">${fmtDate(f.expiry)}</div></td>
      <td><div style="font-weight:600;color:var(--text)">${f.download_count}</div>
          <div style="font-size:.73rem;color:var(--text-muted)">/ ${f.download_limit}</div></td>
      <td>${exp ? '<span class="badge badge-expired">Expired</span>'
               : lim ? '<span class="badge badge-limited">Limit Hit</span>'
                     : '<span class="badge badge-active">Active</span>'}</td>
      <td><div class="actions-cell">
        ${!exp && !lim ? `<button class="action-btn" onclick="copyFileLink('${f.id}',this)" title="Copy">📋</button>` : ''}
        <button class="action-btn" onclick="openPreview('${f.id}','${esc(f.original_name)}','${f.mime_type||''}')" title="Preview">👁</button>
        <button class="action-btn danger" onclick="confirmDelete('${f.id}')" title="Delete">🗑</button>
      </div></td>`;
    tbody.appendChild(tr);
  });
}

function filterFiles() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  const s = document.getElementById('filterStatus').value;
  renderFiles(allFiles.filter(f => {
    const exp = new Date(f.expiry) < new Date();
    return f.original_name.toLowerCase().includes(q) &&
      (s==='all' || (s==='active'&&!exp) || (s==='expired'&&exp));
  }));
}

// ─── All Links tab ────────────────────────────────────────────────────────────
function renderLinks(files) {
  const grid = document.getElementById('linksGrid');
  if (!files?.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🔗</div><h3>No links yet</h3>
      <p>Upload a file to generate your first link</p>
      <button class="btn-primary-sm" onclick="showTab('upload')">Upload Now</button></div>`;
    return;
  }
  const q = (document.getElementById('linkSearchInput')?.value||'').toLowerCase();
  const s = document.getElementById('linkFilterStatus')?.value||'all';
  const filtered = files.filter(f => {
    const exp = new Date(f.expiry) < new Date();
    return f.original_name.toLowerCase().includes(q) &&
      (s==='all' || (s==='active'&&!exp) || (s==='expired'&&exp));
  });
  if (!filtered.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>No matches</h3></div>`;
    return;
  }
  grid.innerHTML = filtered.map(f => {
    const exp  = new Date(f.expiry) < new Date();
    const lim  = f.download_count >= f.download_limit;
    const link = `${location.origin}/download/${f.id}`;
    const badge = exp  ? '<span class="badge badge-expired">⏰ Expired</span>'
                : lim  ? '<span class="badge badge-limited">🚫 Limit Hit</span>'
                       : '<span class="badge badge-active">✅ Active</span>';
    return `<div class="link-card ${exp?'link-card-expired':''}">
      <div class="link-card-header">
        <span class="link-card-icon">${icon(f.mime_type,f.original_name)}</span>
        <div class="link-card-info">
          <div class="link-card-name">${esc(f.original_name)}</div>
          <div class="link-card-meta">${fmtSize(f.file_size)} · Uploaded ${ago(f.created_at)}</div>
        </div>${badge}
      </div>
      <div class="link-card-url-wrap">
        <div class="link-card-url ${exp||lim?'link-url-dead':''}">${link}</div>
        ${!exp&&!lim
          ? `<button class="link-card-copy" onclick="copyText('${link}',this)">📋 Copy</button>
             <a class="link-card-open" href="${link}" target="_blank">↗</a>`
          : '<span class="link-unavail">Unavailable</span>'}
      </div>
      <div class="link-card-footer">
        <span>⬇ ${f.download_count} / ${f.download_limit} downloads</span>
        <span>${exp ? '⏰ Expired ' : '⏳ Expires '}${fmtDate(f.expiry)}</span>
        ${f.password_protected ? '<span>🔐 Password protected</span>' : ''}
      </div>
    </div>`;
  }).join('');
}
function filterLinks() { renderLinks(allFiles); }

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '✅ Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
    showToast('✅ Link copied!', 'success');
  });
}
function copyFileLink(id, btn) {
  copyText(`${location.origin}/download/${id}`, btn);
}

// ─── Delete ───────────────────────────────────────────────────────────────────
function confirmDelete(id) {
  deleteTarget = id;
  document.getElementById('deleteModal').classList.remove('hidden');
  document.getElementById('confirmDeleteBtn').onclick = () => doDelete(id);
}
function closeDeleteModal() {
  document.getElementById('deleteModal').classList.add('hidden');
  deleteTarget = null;
}
async function doDelete(id) {
  closeDeleteModal();
  try {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    allFiles = allFiles.filter(f => f.id !== id);
    renderFiles(allFiles); renderLinks(allFiles); loadStats();
    showToast('🗑 File deleted.', 'info');
  } catch { showToast('❌ Failed to delete.', 'error'); }
}

// ─── Preview ──────────────────────────────────────────────────────────────────
function openPreview(id, name, mime) {
  document.getElementById('previewTitle').textContent = name;
  const body = document.getElementById('previewBody');
  const url  = `/download/${id}`;
  if (mime?.startsWith('image/'))
    body.innerHTML = `<img src="${url}" alt="${esc(name)}" style="max-width:100%;border-radius:8px"/>`;
  else if (mime === 'application/pdf')
    body.innerHTML = `<iframe src="${url}" title="${esc(name)}"></iframe>`;
  else
    body.innerHTML = `<div class="no-preview"><div class="icon">${icon(mime,name)}</div>
      <p style="color:var(--text);font-weight:600;margin-bottom:.5rem">${esc(name)}</p>
      <p style="color:var(--text-muted);margin-bottom:1.5rem">Preview not available for this file type.</p>
      <a href="${url}" download class="btn-primary-sm">⬇ Download File</a></div>`;
  document.getElementById('previewModal').classList.remove('hidden');
}
function closePreview() {
  document.getElementById('previewModal').classList.add('hidden');
  document.getElementById('previewBody').innerHTML = '';
}
document.querySelectorAll('.modal-overlay').forEach(o =>
  o.addEventListener('click', e => { if (e.target===o) { closePreview(); closeDeleteModal(); } })
);

// ─── Upload ───────────────────────────────────────────────────────────────────
function setupDragDrop() {
  const zone  = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
  });
  zone.addEventListener('click', e => {
    if (!e.target.closest('.file-preview-wrap') && !e.target.closest('.btn-browse')) input.click();
  });
  input.addEventListener('change', () => { if (input.files[0]) selectFile(input.files[0]); });
}

function selectFile(f) {
  document.getElementById('selectedFileName').textContent = f.name;
  document.getElementById('selectedFileSize').textContent = fmtSize(f.size);
  document.getElementById('selectedFileIcon').textContent = icon(f.type, f.name);
  document.getElementById('filePreviewWrap').classList.remove('hidden');
  document.getElementById('dropZone').querySelector('.drop-zone-inner').style.display = 'none';
  document.getElementById('resultBox').classList.add('hidden');
}
function clearFileSelection() {
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreviewWrap').classList.add('hidden');
  document.getElementById('dropZone').querySelector('.drop-zone-inner').style.display = '';
  document.getElementById('resultBox').classList.add('hidden');
}
function closeResultBox() {
  document.getElementById('resultBox').classList.add('hidden');
}
function setupExpiryPreview() {
  const update = () => {
    const v = parseInt(document.getElementById('expiryValue').value)||0;
    const u = parseInt(document.getElementById('expiryUnit').value);
    const t = v*u;
    document.getElementById('expiryPreview').textContent =
      t<60 ? `Expires in ${t} minute${t!==1?'s':''}`
      : t<1440 ? `Expires in ${t/60} hour${t/60!==1?'s':''}`
      : `Expires in ${t/1440} day${t/1440!==1?'s':''}`;
  };
  document.getElementById('expiryValue').addEventListener('input', update);
  document.getElementById('expiryUnit').addEventListener('change', update);
  update();
}

async function uploadFile() {
  const input = document.getElementById('fileInput');
  if (!input.files[0]) { showToast('⚠️ Select a file first.', 'error'); return; }
  const mins = (parseInt(document.getElementById('expiryValue').value)||60)
             * parseInt(document.getElementById('expiryUnit').value);
  if (mins < 1) { showToast('⚠️ Expiry must be at least 1 minute.', 'error'); return; }

  const fd = new FormData();
  fd.append('file', input.files[0]);
  fd.append('expiry_minutes', mins);
  fd.append('download_limit', document.getElementById('downloadLimit').value || 100);
  const pw = document.getElementById('filePassword').value;
  if (pw) fd.append('password', pw);

  const btn  = document.getElementById('uploadBtn');
  const wrap = document.getElementById('progressWrap');
  const fill = document.getElementById('progressFill');
  const txt  = document.getElementById('progressText');
  const box  = document.getElementById('resultBox');
  const name = input.files[0].name;

  btn.disabled = true;
  document.getElementById('uploadBtnText').textContent = '⏳ Uploading...';
  wrap.classList.remove('hidden');
  box.classList.add('hidden');

  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const p = Math.round(e.loaded/e.total*100);
        fill.style.width = p + '%';
        txt.textContent  = `Uploading... ${p}%`;
      }
    };
    xhr.onload = () => {
      btn.disabled = false;
      document.getElementById('uploadBtnText').textContent = '⬆ Upload & Generate Link';
      wrap.classList.add('hidden');
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        // Show big link banner
        document.getElementById('resultLink').textContent     = data.downloadLink;
        document.getElementById('resultFileName').textContent  = name;
        document.getElementById('resultExpiry').textContent   = '⏰ Expires ' + new Date(data.expiry).toLocaleString();
        document.getElementById('linkOpenBtn').href           = data.downloadLink;
        box.classList.remove('hidden');
        box.scrollIntoView({ behavior:'smooth', block:'center' });
        showToast('🎉 Link generated!', 'success', 5000);
        clearFileSelection();
        loadFiles();   // refresh from DB
        loadStats();
      } else {
        showToast('❌ ' + (JSON.parse(xhr.responseText).error||'Upload failed.'), 'error');
      }
      resolve();
    };
    xhr.onerror = () => {
      btn.disabled = false;
      document.getElementById('uploadBtnText').textContent = '⬆ Upload & Generate Link';
      wrap.classList.add('hidden');
      showToast('❌ Network error.', 'error');
      resolve();
    };
    xhr.send(fd);
  });
}

function copyLink() {
  const link = document.getElementById('resultLink').textContent.trim();
  navigator.clipboard.writeText(link).then(() => {
    document.getElementById('linkCopyBtn').textContent = '✅ Copied!';
    showToast('✅ Link copied!', 'success');
    setTimeout(() => document.getElementById('linkCopyBtn').textContent = '📋 Copy Link', 2000);
  });
}

// ─── Activity ─────────────────────────────────────────────────────────────────
function renderActivity() {
  const grid = document.getElementById('activityGrid');
  if (!allFiles.length) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div>
      <h3>No activity yet</h3><p>Upload your first file to see activity here</p></div>`;
    return;
  }
  grid.innerHTML = [...allFiles]
    .sort((a,b) => new Date(b.created_at)-new Date(a.created_at))
    .map(f => {
      const exp = new Date(f.expiry)<new Date();
      return `<div class="activity-item">
        <div class="activity-icon">${exp?'⏰':f.download_count>0?'⬇️':'📤'}</div>
        <div class="activity-info">
          <strong>${esc(f.original_name)}</strong>
          <span>Uploaded ${ago(f.created_at)} · ${exp?'Expired':'Active'}</span>
        </div>
        <div class="activity-meta">
          <strong>${f.download_count} ⬇</strong>
          <small>${fmtSize(f.file_size)}</small>
        </div>
      </div>`;
    }).join('');
}

// ─── Download via Link ────────────────────────────────────────────────────────
function onDlLinkInput() {
  if (!document.getElementById('dlLinkInput').value.trim()) resetDownloader();
}

function extractId(url) {
  const m = url.match(/\/download\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

async function previewLink() {
  const raw = document.getElementById('dlLinkInput').value.trim();
  if (!raw) { showToast('⚠️ Paste a link first.', 'error'); return; }
  const id = extractId(raw);
  if (!id) { showDlError('❌ Invalid link. Paste a full CloudShare download URL.'); return; }

  const btn = document.getElementById('dlLookupBtn');
  btn.textContent = '⏳ Looking up...'; btn.disabled = true;
  hideDlError();
  document.getElementById('dlPreviewCard').classList.add('hidden');

  try {
    const res  = await fetch(`/api/file-info/${id}`);
    const data = await res.json();
    if (!res.ok) { showDlError('❌ ' + (data.error||'File not found.')); return; }
    dlCurrentId   = id;
    dlCurrentInfo = data;
    renderDlPreview(data);
  } catch { showDlError('❌ Network error. Is the server running?'); }
  finally { btn.textContent = '🔍 Look Up'; btn.disabled = false; }
}

function renderDlPreview(info) {
  document.getElementById('dlFileIcon').textContent = icon(info.mime_type, info.original_name);
  document.getElementById('dlFileName').textContent  = info.original_name;
  document.getElementById('dlFileMeta').textContent  = (info.mime_type||'Unknown type') + ' · ' + fmtSize(info.file_size);

  const badge = document.getElementById('dlStatusBadge');
  badge.innerHTML = info.is_expired  ? '<span class="badge badge-expired">⏰ Expired</span>'
                  : info.is_limited  ? '<span class="badge badge-limited">🚫 Limit Reached</span>'
                                     : '<span class="badge badge-active">✅ Available</span>';

  document.getElementById('dlStatSize').textContent      = fmtSize(info.file_size);
  document.getElementById('dlStatDownloads').textContent = info.download_count;
  document.getElementById('dlStatLimit').textContent     = info.download_limit;
  document.getElementById('dlStatExpiry').textContent    = info.is_expired ? '⏰ Expired' : fmtDate(info.expiry);

  const pwRow = document.getElementById('dlPasswordRow');
  if (info.password_protected && !info.is_expired && !info.is_limited)
    pwRow.classList.remove('hidden');
  else { pwRow.classList.add('hidden'); document.getElementById('dlPassword').value = ''; }

  const btn = document.getElementById('dlDownloadBtn');
  const txt = document.getElementById('dlDownloadBtnText');
  if (info.is_expired)       { btn.disabled=true; txt.textContent='⏰ Link Expired'; btn.style.opacity='.5'; }
  else if (info.is_limited)  { btn.disabled=true; txt.textContent='🚫 Download Limit Reached'; btn.style.opacity='.5'; }
  else                       { btn.disabled=false; txt.textContent='⬇️ Download File'; btn.style.opacity='1'; }

  hideDlError();
  document.getElementById('dlPreviewCard').classList.remove('hidden');
  document.getElementById('dlPreviewCard').scrollIntoView({ behavior:'smooth', block:'nearest' });
}

function triggerDownload() {
  if (!dlCurrentId) return;
  const pw  = document.getElementById('dlPassword').value.trim();
  const url = `/download/${dlCurrentId}` + (pw ? `?password=${encodeURIComponent(pw)}` : '');
  window.open(url, '_blank');
  addDlHistory(dlCurrentInfo);
  // Refresh count from DB after brief delay
  setTimeout(async () => {
    loadStats(); loadFiles();
    if (dlCurrentId) {
      try {
        const d = await (await fetch(`/api/file-info/${dlCurrentId}`)).json();
        dlCurrentInfo = d; renderDlPreview(d);
      } catch {}
    }
  }, 1500);
  showToast('⬇️ Download started! Count updated.', 'success');
}

function addDlHistory(info) {
  if (!info) return;
  dlHistory.unshift({ ...info, downloadedAt: new Date() });
  if (dlHistory.length > 10) dlHistory.pop();
  renderDlHistory();
}
function renderDlHistory() {
  const list = document.getElementById('dlHistoryList');
  if (!list) return;
  if (!dlHistory.length) {
    list.innerHTML = '<div class="dl-history-empty">No downloads yet this session</div>'; return;
  }
  list.innerHTML = dlHistory.map(item => `
    <div class="dl-history-item">
      <span class="dl-history-icon">${icon(item.mime_type, item.original_name)}</span>
      <div class="dl-history-info">
        <span class="dl-history-name">${esc(item.original_name)}</span>
        <span class="dl-history-time">${ago(item.downloadedAt)}</span>
      </div>
      <a class="dl-history-again" href="/download/${item.id}" target="_blank"
         onclick="setTimeout(()=>{loadStats();loadFiles();},1500)">↗ Again</a>
    </div>`).join('');
}

function resetDownloader() {
  dlCurrentId = null; dlCurrentInfo = null;
  document.getElementById('dlLinkInput').value = '';
  document.getElementById('dlPreviewCard').classList.add('hidden');
  document.getElementById('dlPassword').value = '';
  hideDlError();
}
function showDlError(msg) {
  const el = document.getElementById('dlError');
  el.textContent = msg; el.classList.remove('hidden');
  document.getElementById('dlPreviewCard').classList.add('hidden');
}
function hideDlError() { document.getElementById('dlError').classList.add('hidden'); }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function icon(mime, name) {
  if (!mime && name) {
    const ext = name.split('.').pop().toLowerCase();
    return ({pdf:'📄',jpg:'🖼',jpeg:'🖼',png:'🖼',gif:'🖼',webp:'🖼',svg:'🖼',
      mp4:'🎬',mov:'🎬',avi:'🎬',webm:'🎬',mp3:'🎵',wav:'🎵',ogg:'🎵',
      zip:'🗜',rar:'🗜','7z':'🗜',tar:'🗜',gz:'🗜',
      doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📑',pptx:'📑',
      txt:'📃',csv:'📊',json:'⚙️',js:'⚙️',ts:'⚙️',html:'🌐',css:'🎨',
      py:'🐍',java:'☕',c:'⚙️',cpp:'⚙️',exe:'💻',apk:'📱'}[ext] || '📁');
  }
  if (!mime) return '📁';
  if (mime.startsWith('image/'))  return '🖼';
  if (mime.startsWith('video/'))  return '🎬';
  if (mime.startsWith('audio/'))  return '🎵';
  if (mime==='application/pdf')   return '📄';
  if (mime.includes('zip')||mime.includes('compressed')) return '🗜';
  if (mime.includes('word'))      return '📝';
  if (mime.includes('excel')||mime.includes('spreadsheet')) return '📊';
  if (mime.includes('powerpoint')) return '📑';
  if (mime.includes('text/'))     return '📃';
  return '📁';
}
function fmtSize(b) {
  if (!b) return '0 B';
  const k=1024, s=['B','KB','MB','GB'], i=Math.floor(Math.log(b)/Math.log(k));
  return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i];
}
function fmtExpiry(str, isExpired) {
  if (isExpired) return '<span style="color:var(--danger)">Expired</span>';
  const diff=new Date(str)-new Date(), m=Math.floor(diff/60000);
  if (m<60)  return `<span style="color:var(--warning)">${m}m left</span>`;
  const h=Math.floor(m/60);
  if (h<24)  return `${h}h left`;
  return `${Math.floor(h/24)}d left`;
}
function fmtDate(str) {
  return new Date(str).toLocaleDateString('en-IN',
    {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function ago(str) {
  const d=(new Date()-new Date(str))/1000;
  if (d<60)    return 'just now';
  if (d<3600)  return Math.floor(d/60)+'m ago';
  if (d<86400) return Math.floor(d/3600)+'h ago';
  return Math.floor(d/86400)+'d ago';
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function togglePass(id) {
  const el=document.getElementById(id);
  el.type=el.type==='password'?'text':'password';
}
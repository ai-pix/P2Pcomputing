/* ─── UI Module — DOM helpers, toasts, animations ─── */
const UI = {
  /* Toast notifications */
  toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 300); }, 3500);
  },



  /* Stats update */
  updateStats(stats) {
    document.getElementById('navProviders').textContent = stats.activeProviders || 0;
    document.getElementById('navCompleted').textContent = stats.totalCompleted || 0;
  },

  /* Format bytes */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  /* Progress bar updates */
  setProgress(elementId, percent) {
    const el = document.getElementById(elementId);
    if (el) el.style.width = Math.min(100, percent) + '%';
  },

  /* Job stage activation */
  setStage(stageId, status, statusText) {
    const stage = document.getElementById(stageId);
    if (!stage) return;
    stage.classList.remove('active', 'done');
    if (status === 'active') stage.classList.add('active');
    if (status === 'done') stage.classList.add('done');
    const statusEl = stage.querySelector('.stage-status');
    if (statusEl && statusText) statusEl.textContent = statusText;
  },

  /* Show/hide elements */
  show(id) { const el = document.getElementById(id); if (el) el.classList.add('active'); },
  hide(id) { const el = document.getElementById(id); if (el) el.classList.remove('active'); },
  showEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'block'; },
  hideEl(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; },
  setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; },

  /* Setup drag-and-drop */
  setupDragDrop(zoneId, fileInputId, onFile) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(fileInputId);

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', (e) => { if (e.target.files[0]) onFile(e.target.files[0]); });

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
  }
};

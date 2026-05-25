/* ─── UI Module — DOM helpers, toasts, animations ─── */
const UI = {
  /* Toast notifications */
  toast(message: string, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { 
      el.style.opacity = '0'; 
      el.style.transform = 'translateX(20px)'; 
      setTimeout(() => el.remove(), 300); 
    }, 3500);
  },

  /* Stats update */
  updateStats(stats: { activeProviders?: number; totalCompleted?: number }) {
    const providersEl = document.getElementById('navProviders');
    if (providersEl) providersEl.textContent = String(stats.activeProviders || 0);
    const completedEl = document.getElementById('navCompleted');
    if (completedEl) completedEl.textContent = String(stats.totalCompleted || 0);
  },

  /* Format bytes */
  formatBytes(bytes: number) {
    if (bytes === 0) return '0 B';
    const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  },

  /* Progress bar updates */
  setProgress(elementId: string, percent: number) {
    const el = document.getElementById(elementId);
    if (el) el.style.width = Math.min(100, percent) + '%';
  },

  /* Job stage activation */
  setStage(stageId: string, status: 'active' | 'done' | 'reset', statusText?: string) {
    const stage = document.getElementById(stageId);
    if (!stage) return;
    stage.classList.remove('active', 'done');
    if (status === 'active') stage.classList.add('active');
    if (status === 'done') stage.classList.add('done');
    const statusEl = stage.querySelector('.stage-status');
    if (statusEl && statusText) statusEl.textContent = statusText;
  },

  /* Show/hide elements */
  show(id: string) { const el = document.getElementById(id); if (el) el.classList.add('active'); },
  hide(id: string) { const el = document.getElementById(id); if (el) el.classList.remove('active'); },
  showEl(id: string) { const el = document.getElementById(id); if (el) el.style.display = 'block'; },
  hideEl(id: string) { const el = document.getElementById(id); if (el) el.style.display = 'none'; },
  setText(id: string, text: string | number) { const el = document.getElementById(id); if (el) el.textContent = String(text); },

  /* Setup drag-and-drop */
  setupDragDrop(zoneId: string, fileInputId: string, onFile: (files: FileList) => void) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(fileInputId) as HTMLInputElement | null;
    if (!zone || !input) return;

    zone.addEventListener('click', () => input.click());
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('change', (e: any) => { if (e.target?.files?.length) onFile(e.target.files); });

    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e: any) => {
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer?.files?.length) onFile(e.dataTransfer.files);
    });
  }
};

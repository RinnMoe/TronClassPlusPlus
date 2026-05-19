(async function() {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const status = $('#dl-status');
  const list = $('#dl-list');
  const dlAllBtn = $('#dl-all');
  const aboutBtn = $('#about');
  const githubBtn = $('#github');
  const checkUpdateBtn = $('#check-update');
  const currentVersionLabel = $('#current-version');
  const updateStatus = $('#update-status');
  const updateMessage = $('#update-message');
  const openReleaseBtn = $('#open-release');
  const footer = $('#footer');
  const emptyState = $('#empty-state');
  const emptyMessage = $('#empty-message');
  const tutorialLink = $('#tutorial-link');
  const refreshLink = $('#refresh-link');

  const videoStatus = $('#video-status');
  const videoPanel = $('#video-panel');
  const videoEmptyState = $('#video-empty-state');
  const videoEmptyMessage = $('#video-empty-message');
  const antiPauseToggle = $('#anti-pause-toggle');
  const autoNavigateToggle = $('#auto-navigate-toggle');
  const antiPauseState = $('#anti-pause-state');
  const autoNavigateState = $('#auto-navigate-state');
  const videoRefreshBtn = $('#video-refresh');
  const tabs = $$('.mode-tab');
  const downloadView = $('#view-downloads');
  const videoView = $('#view-video');
  const REPO_URL = 'https://github.com/RinnMoe/TronClassFileDownloadEnhancer';
  const DOCS_URL = 'https://rinnmoe.github.io/TronClassFileDownloadEnhancer';
  const LATEST_RELEASE_API = 'https://api.github.com/repos/RinnMoe/TronClassFileDownloadEnhancer/releases/latest';
  const REMOTE_MANIFEST_URL = 'https://raw.githubusercontent.com/RinnMoe/TronClassFileDownloadEnhancer/main/manifest.json';

  let currentOrigin = null;
  let currentView = 'downloads';
  let currentFiles = [];
  let suppressVideoChange = false;
  let videoStateLoaded = false;
  let videoStateRequest = null;
  let updateCheckRequest = null;
  let updateCheckShouldShowLatest = false;
  let latestVersionUrl = REPO_URL;

  function getCurrentVersion() {
    return globalThis.chrome && chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest().version
      : '0.0.0';
  }

  function normalizeVersion(version) {
    return String(version || '')
      .trim()
      .replace(/^v/i, '')
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((part) => Number.parseInt(part, 10));
  }

  function compareVersions(left, right) {
    const leftParts = normalizeVersion(left);
    const rightParts = normalizeVersion(right);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < length; i++) {
      const leftPart = leftParts[i] || 0;
      const rightPart = rightParts[i] || 0;
      if (leftPart > rightPart) return 1;
      if (leftPart < rightPart) return -1;
    }

    return 0;
  }

  function setUpdateStatus(message, type, actionText) {
    updateStatus.hidden = false;
    updateStatus.className = `update-status ${type || ''}`.trim();
    updateMessage.textContent = message;
    openReleaseBtn.hidden = !actionText;
    openReleaseBtn.textContent = actionText || '';
  }

  async function fetchLatestVersion() {
    const candidates = [];

    const releaseResponse = await fetch(LATEST_RELEASE_API, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' }
    }).catch(() => null);

    if (releaseResponse && releaseResponse.ok) {
      const release = await releaseResponse.json();
      candidates.push({
        version: release.tag_name || release.name,
        url: release.html_url || REPO_URL
      });
    }

    const manifestResponse = await fetch(REMOTE_MANIFEST_URL, { cache: 'no-store' }).catch(() => null);
    if (manifestResponse && manifestResponse.ok) {
      const manifest = await manifestResponse.json();
      candidates.push({
        version: manifest.version,
        url: `${REPO_URL}/releases`
      });
    }

    if (!candidates.length) {
      throw new Error('无法获取远端版本信息');
    }

    return candidates.reduce((best, candidate) => (
      compareVersions(best.version, candidate.version) < 0 ? candidate : best
    ));
  }

  async function checkForUpdates(showLatestMessage) {
    if (updateCheckRequest) {
      if (showLatestMessage) {
        updateCheckShouldShowLatest = true;
        setUpdateStatus('正在检查更新...', 'notice');
      }
      return updateCheckRequest;
    }

    checkUpdateBtn.disabled = true;
    updateCheckShouldShowLatest = !!showLatestMessage;
    if (showLatestMessage) {
      setUpdateStatus('正在检查更新...', 'notice');
    }

    updateCheckRequest = fetchLatestVersion()
      .then((latest) => {
        const currentVersion = getCurrentVersion();
        const latestVersion = latest.version;
        latestVersionUrl = latest.url || REPO_URL;

        if (!latestVersion) {
          throw new Error('远端版本号为空');
        }

        if (compareVersions(currentVersion, latestVersion) < 0) {
          setUpdateStatus(`发现新版本 v${String(latestVersion).replace(/^v/i, '')}，当前版本 v${currentVersion}`, 'notice', '查看');
          return;
        }

        if (updateCheckShouldShowLatest) {
          setUpdateStatus(`当前已是最新版本 v${currentVersion}`, 'success');
        } else {
          updateStatus.hidden = true;
        }
      })
      .catch(() => {
        if (updateCheckShouldShowLatest) {
          setUpdateStatus('更新检查失败，请稍后重试', 'error');
        } else {
          updateStatus.hidden = true;
        }
      })
      .finally(() => {
        checkUpdateBtn.disabled = false;
        updateCheckRequest = null;
        updateCheckShouldShowLatest = false;
      });

    return updateCheckRequest;
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '未知大小';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return size.toFixed(unitIndex === 0 ? 0 : 2) + ' ' + units[unitIndex];
  }

  function updateFooter() {
    const showDownloadFooter = currentView === 'downloads' && currentFiles.length > 1;
    footer.style.display = showDownloadFooter ? 'block' : 'none';
    dlAllBtn.style.display = showDownloadFooter ? 'block' : 'none';
  }

  function setActiveView(view) {
    if (view === currentView) {
      if (view === 'video') {
        loadVideoState(true);
      }
      return;
    }

    currentView = view;

    tabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === view);
      tab.setAttribute('aria-selected', String(tab.dataset.view === view));
    });

    downloadView.classList.toggle('active', view === 'downloads');
    videoView.classList.toggle('active', view === 'video');
    updateFooter();

    if (view === 'video' && !videoStateLoaded) {
      loadVideoState();
    }
  }

  function renderFiles(files) {
    currentFiles = Array.isArray(files) ? files : [];
    list.innerHTML = '';

    if (!currentFiles.length) {
      status.style.display = 'none';
      list.style.display = 'none';
      emptyState.style.display = 'flex';
      emptyMessage.textContent = '未检测到可下载的文件';
      updateFooter();
      return;
    }

    status.style.display = 'block';
    list.style.display = 'block';
    emptyState.style.display = 'none';
    status.textContent = `检测到 ${currentFiles.length} 个文件`;
    status.className = 'status success';

    const fragment = document.createDocumentFragment();

    currentFiles.forEach((file) => {
      const row = document.createElement('div');
      row.className = 'file-item';

      const info = document.createElement('div');
      info.className = 'file-info';

      const name = document.createElement('div');
      name.className = 'file-name';
      name.title = file.name || '';
      name.textContent = file.name || 'Unnamed file';

      const size = document.createElement('div');
      size.className = 'file-size';
      size.textContent = formatFileSize(file.size);

      info.append(name, size);

      const btn = document.createElement('button');
      btn.className = 'primary';
      btn.type = 'button';
      btn.textContent = '下载';
      btn.addEventListener('click', () => {
        if (!currentOrigin) return;
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_FILE',
          fileId: file.id,
          fileName: file.name,
          baseUrl: currentOrigin
        });
      });

      row.append(info, btn);
      fragment.appendChild(row);
    });

    list.replaceChildren(fragment);

    dlAllBtn.onclick = async () => {
      if (!currentOrigin) return;
      for (let i = 0; i < currentFiles.length; i++) {
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_FILE',
          fileId: currentFiles[i].id,
          fileName: currentFiles[i].name,
          baseUrl: currentOrigin
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    };

    updateFooter();
  }

  async function getActiveTab() {
    if (!globalThis.chrome || !chrome.tabs) {
      throw new Error('请在扩展弹窗中使用');
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('未找到活动页面');
    }
    return tab;
  }

  async function sendToActiveTab(message) {
    const tab = await getActiveTab();
    return chrome.tabs.sendMessage(tab.id, message);
  }

  async function loadFiles() {
    emptyState.style.display = 'none';
    status.style.display = 'block';
    list.style.display = 'block';
    status.textContent = '正在读取当前页面的文件...';
    status.className = 'status';
    list.innerHTML = '';
    currentFiles = [];
    updateFooter();

    let tab;
    try {
      tab = await getActiveTab();
    } catch (error) {
      status.style.display = 'none';
      list.style.display = 'none';
      emptyState.style.display = 'flex';
      emptyMessage.textContent = error.message;
      return;
    }

    try {
      const url = new URL(tab.url);
      currentOrigin = url.origin;
    } catch {
      currentOrigin = null;
    }

    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_FILES' });
      renderFiles((resp && resp.files) || []);
    } catch {
      status.style.display = 'none';
      list.style.display = 'none';
      emptyState.style.display = 'flex';
      emptyMessage.textContent = '不支持当前页面';
    }
  }

  function setVideoControlsEnabled(enabled) {
    antiPauseToggle.disabled = !enabled;
    autoNavigateToggle.disabled = !enabled;
    videoRefreshBtn.disabled = !enabled;
  }

  function renderVideoState(state) {
    if (!state || state.error) {
      videoStatus.style.display = 'none';
      videoPanel.style.display = 'none';
      videoEmptyState.style.display = 'flex';
      videoEmptyMessage.textContent = state && state.error ? state.error : '当前页面无可用视频功能';
      setVideoControlsEnabled(false);
      return;
    }

    videoStatus.style.display = 'block';
    videoPanel.style.display = 'block';
    videoEmptyState.style.display = 'none';
    videoStatus.className = state.hasVideo ? 'status success' : 'status';
    videoStatus.textContent = state.hasVideo
      ? `检测到 ${state.videoCount} 个视频`
      : '未检测到视频';

    suppressVideoChange = true;
    antiPauseToggle.checked = !!state.antiPause;
    autoNavigateToggle.checked = !!state.autoNavigate;
    antiPauseState.textContent = state.antiPause ? '已开启' : '已关闭';
    autoNavigateState.textContent = state.autoNavigate ? '已开启' : '已关闭';
    suppressVideoChange = false;
    setVideoControlsEnabled(true);
  }

  async function loadVideoState(force) {
    if (videoStateLoaded && !force) return;
    if (videoStateRequest) return videoStateRequest;

    videoEmptyState.style.display = 'none';
    videoPanel.style.display = 'block';
    videoStatus.style.display = 'block';
    videoStatus.className = 'status';
    videoStatus.textContent = '正在读取当前页面的视频状态...';
    setVideoControlsEnabled(false);

    videoStateRequest = sendToActiveTab({ type: 'GET_VIDEO_STATE' })
      .then((state) => {
        renderVideoState(state);
        videoStateLoaded = true;
      })
      .catch(() => {
        renderVideoState({ error: '请在学习活动页面使用视频播放功能' });
        videoStateLoaded = true;
      })
      .finally(() => {
        videoStateRequest = null;
      });

    return videoStateRequest;
  }

  async function updateVideoOption(option, enabled) {
    setVideoControlsEnabled(false);
    try {
      const state = await sendToActiveTab({
        type: 'SET_VIDEO_OPTION',
        option,
        enabled
      });
      renderVideoState(state);
    } catch {
      await loadVideoState();
    }
  }

  tabs.forEach((tab) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
    tab.addEventListener('click', () => setActiveView(tab.dataset.view));
  });

  antiPauseToggle.addEventListener('change', () => {
    if (suppressVideoChange) return;
    updateVideoOption('antiPause', antiPauseToggle.checked);
  });

  autoNavigateToggle.addEventListener('change', () => {
    if (suppressVideoChange) return;
    updateVideoOption('autoNavigate', autoNavigateToggle.checked);
  });

  videoRefreshBtn.addEventListener('click', () => loadVideoState(true));

  currentVersionLabel.textContent = `v${getCurrentVersion()}`;

  checkUpdateBtn.addEventListener('click', () => {
    checkForUpdates(true);
  });

  openReleaseBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: latestVersionUrl });
  });

  aboutBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: DOCS_URL });
  });

  githubBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: REPO_URL });
  });

  tutorialLink.addEventListener('click', (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: `${DOCS_URL}/tutorial.html` });
  });

  refreshLink.addEventListener('click', async (event) => {
    event.preventDefault();
    try {
      const tab = await getActiveTab();
      await chrome.tabs.reload(tab.id);
      setTimeout(() => loadFiles(), 500);
    } catch {}
  });

  checkForUpdates(false);
  await loadFiles();
})();

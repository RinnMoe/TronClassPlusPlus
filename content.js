(function() {
  'use strict';

  const DEBUG = false;

  let filesData = [];
  let lastBadgeCount = null;
  let lastFilesSignature = '';
  let currentActivityId = null;
  let resolvedActivityId = null;
  let activeFetchActivityId = null;
  let inFlightFetch = null;
  let refreshTimer = null;
  let videoBridgeInjected = false;
  let videoBridgeReady = null;
  let videoBridgeRequestId = 0;
  const selfInitiatedRequests = new Set();
  const LOG_PREFIX = '[TronClass++]';
  const MESSAGE_SOURCE = 'tronclass-plus-plus-content';
  const VIDEO_BRIDGE_SOURCE = 'tronclass-plus-plus-video-bridge';

  function log(...args) {
    if (DEBUG) {
      console.log(LOG_PREFIX, ...args);
    }
  }

  function injectVideoBridge() {
    if (videoBridgeReady) return videoBridgeReady;
    if (videoBridgeInjected) return Promise.resolve();
    videoBridgeInjected = true;

    videoBridgeReady = new Promise((resolve) => {
      const startedAt = Date.now();

      function attachWhenReady() {
        try {
          const container = document.documentElement || document.head || document.body;
          if (!container) {
            if (Date.now() - startedAt < 10000) {
              window.setTimeout(attachWhenReady, 10);
            } else {
              videoBridgeInjected = false;
              videoBridgeReady = null;
              resolve();
            }
            return;
          }

          if (document.documentElement) {
            document.documentElement.setAttribute('data-tronclass-plus-plus-content', '1');
          }

          const script = document.createElement('script');
          script.src = chrome.runtime.getURL('video-bridge.js');
          script.onload = () => {
            if (document.documentElement) {
              document.documentElement.setAttribute('data-tronclass-plus-plus-bridge-injected', '1');
            }
            script.remove();
            resolve();
          };
          script.onerror = () => {
            if (document.documentElement) {
              document.documentElement.setAttribute('data-tronclass-plus-plus-bridge-error', '1');
            }
            videoBridgeInjected = false;
            videoBridgeReady = null;
            script.remove();
            resolve();
          };
          container.appendChild(script);
        } catch (error) {
          videoBridgeInjected = false;
          videoBridgeReady = null;
          console.error(`${LOG_PREFIX} Failed to inject video bridge:`, error);
          resolve();
        }
      }

      attachWhenReady();
    });

    return videoBridgeReady;
  }

  function sendVideoBridgeCommand(action, payload) {
    return injectVideoBridge().then(() => new Promise((resolve) => {
      const id = `tronclass-plus-plus-${Date.now()}-${++videoBridgeRequestId}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', onMessage);
        resolve({
          ok: false,
          error: '视频控制脚本无响应'
        });
      }, 1800);

      function onMessage(event) {
        if (event.source !== window) return;
        const message = event.data;
        if (!message || message.source !== VIDEO_BRIDGE_SOURCE || message.id !== id) return;

        window.clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(message);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({
        source: MESSAGE_SOURCE,
        id,
        action,
        payload: payload || {}
      }, '*');
    }));
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function getAbsoluteUrl(rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin);
    } catch {
      return null;
    }
  }

  function isUploadReferenceUrl(rawUrl) {
    const url = getAbsoluteUrl(rawUrl);
    if (!url) return false;
    if (!url.pathname.includes('/api/activities/')) return false;
    return /\/upload[_-]?references?(?:\/|$)/i.test(url.pathname);
  }

  function extractActivityIdFromApiUrl(rawUrl) {
    const url = getAbsoluteUrl(rawUrl);
    if (!url) return null;
    const match = url.pathname.match(/\/api\/activities\/(\d+)\//);
    return match ? match[1] : null;
  }

  function extractActivityIdFromPage() {
    const hashMatch = window.location.hash.match(/#\/(\d+)/);
    if (hashMatch) return hashMatch[1];

    const pathMatch = window.location.href.match(/\/activities\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    const learningMatch = window.location.href.match(/learning-activity\/[^#]*#\/(\d+)/);
    return learningMatch ? learningMatch[1] : null;
  }

  function syncBadge(count) {
    if (lastBadgeCount === count) return;
    lastBadgeCount = count;

    chrome.runtime.sendMessage({
      type: 'UPDATE_BADGE',
      count
    }).catch(() => {});
  }

  function updateFilesList(files, activityId) {
    const normalizedFiles = Array.isArray(files) ? files : [];
    const signature = JSON.stringify(normalizedFiles);

    if (activityId) {
      resolvedActivityId = activityId;
    }

    if (signature === lastFilesSignature) {
      syncBadge(normalizedFiles.length);
      return;
    }

    filesData = normalizedFiles;
    lastFilesSignature = signature;
    syncBadge(filesData.length);
    log('Files list updated:', filesData.length);
  }

  function processFilesData(activityId, data) {
    if (activityId && currentActivityId && activityId !== currentActivityId) {
      log('Ignore stale activity payload:', activityId);
      return;
    }

    const references = data?.referances || data?.references || data?.value || [];
    const files = Array.isArray(references)
      ? references.map((ref) => ({
          id: ref.id || ref.reference_id,
          name: ref.name || ref.reference_name || ref.title || 'Unnamed file',
          size: ref.upload && ref.upload.size ? ref.upload.size : 0
        }))
      : [];

    updateFilesList(files, activityId || currentActivityId);
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const requestUrl = getRequestUrl(input);
    const shouldInspect = isUploadReferenceUrl(requestUrl) && !selfInitiatedRequests.has(requestUrl);
    const response = await originalFetch(input, init);

    if (shouldInspect && response.ok) {
      const activityId = extractActivityIdFromApiUrl(requestUrl);
      response.clone().json()
        .then((data) => {
          processFilesData(activityId, data);
        })
        .catch((error) => {
          console.error(`${LOG_PREFIX} Failed to parse fetch response:`, error);
        });
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._tronUrl = url;
    this._tronShouldInspect = isUploadReferenceUrl(url);
    return originalOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    if (this._tronShouldInspect) {
      this.addEventListener('load', () => {
        try {
          const activityId = extractActivityIdFromApiUrl(this._tronUrl);
          processFilesData(activityId, JSON.parse(this.responseText));
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to parse XHR response:`, error);
        }
      }, { once: true });
    }

    return originalSend.apply(this, args);
  };

  function fetchFilesForActivity(activityId, force) {
    if (!activityId) return Promise.resolve();

    if (inFlightFetch && activeFetchActivityId === activityId) {
      return inFlightFetch;
    }

    if (!force && resolvedActivityId === activityId) {
      return Promise.resolve();
    }

    const apiUrl = `${window.location.origin}/api/activities/${activityId}/upload_references`;
    activeFetchActivityId = activityId;
    selfInitiatedRequests.add(apiUrl);

    inFlightFetch = originalFetch(apiUrl, {
      credentials: 'include'
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        processFilesData(activityId, data);
      })
      .catch((error) => {
        console.error(`${LOG_PREFIX} Fetch error:`, error);
      })
      .finally(() => {
        selfInitiatedRequests.delete(apiUrl);
        activeFetchActivityId = null;
        inFlightFetch = null;
      });

    return inFlightFetch;
  }

  function refreshFiles(force) {
    const activityId = extractActivityIdFromPage();
    currentActivityId = activityId;

    if (!activityId) return;

    if (resolvedActivityId !== activityId) {
      filesData = [];
      lastFilesSignature = '';
      lastBadgeCount = null;
    }

    fetchFilesForActivity(activityId, force);
  }

  function scheduleRefresh(force, delay) {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refreshFiles(force);
    }, delay);
  }

  if (document.readyState === 'complete') {
    scheduleRefresh(false, 0);
  } else {
    window.addEventListener('load', () => {
      scheduleRefresh(false, 0);
    }, { once: true });
  }

  window.addEventListener('hashchange', () => {
    scheduleRefresh(false, 150);
  });

  injectVideoBridge();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request) return;

    if (request.type === 'GET_FILES') {
      sendResponse({ files: filesData || [] });
      return true;
    }

    if (request.type === 'REFRESH') {
      scheduleRefresh(true, 0);
      sendResponse({ ok: true });
      return true;
    }

    if (request.type === 'GET_VIDEO_STATE') {
      sendVideoBridgeCommand('GET_VIDEO_STATE')
        .then((response) => {
          sendResponse(response.ok ? response.state : {
            error: response.error || '无法读取视频状态'
          });
        });
      return true;
    }

    if (request.type === 'SET_VIDEO_OPTION') {
      sendVideoBridgeCommand('SET_VIDEO_OPTION', {
        option: request.option,
        enabled: request.enabled
      }).then((response) => {
        sendResponse(response.ok ? response.state : {
          error: response.error || '无法更新视频设置'
        });
      });
      return true;
    }
  });
})();

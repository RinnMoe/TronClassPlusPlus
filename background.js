// Background Service Worker
const LOG_PREFIX = '[TronClass++]';

console.log(`${LOG_PREFIX} Service worker started`);

// 监听来自content script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log(`${LOG_PREFIX} Message received:`, request.type);

  if (request.type === 'DOWNLOAD_FILE') {
    console.log(`${LOG_PREFIX} Download request:`, request.fileName);
    downloadFile(request.fileId, request.fileName, request.baseUrl)
      .then(() => {
        console.log(`${LOG_PREFIX} Download success`);
        sendResponse({ success: true });
      })
      .catch(error => {
        console.error(`${LOG_PREFIX} Download error:`, error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // 保持消息通道开启以进行异步响应
  }

  if (request.type === 'UPDATE_BADGE') {
    console.log(`${LOG_PREFIX} Update badge:`, request.count);
    updateBadge(request.count, sender.tab?.id);
    sendResponse({ success: true });
    return true;
  }
});

// 下载文件函数
async function downloadFile(fileId, fileName, baseUrl) {
  console.log(`${LOG_PREFIX} Starting download:`, fileName, 'ID:', fileId);
  
  if (!baseUrl) {
    throw new Error('未提供基础域名 (Base URL)');
  }

  try {
    // 先获取文件的真实下载地址
    const apiUrl = `${baseUrl}/api/uploads/reference/document/${fileId}/url?preview=true`;
    console.log(`${LOG_PREFIX} Fetching download URL from:`, apiUrl);

    const response = await fetch(apiUrl, {
      credentials: 'include'
    });

    const data = await response.json();
    console.log(`${LOG_PREFIX} API response:`, data);

    if (data.status === 'ready' && data.url) {
      console.log(`${LOG_PREFIX} Got download URL:`, data.url);

      // 触发下载
      chrome.downloads.download({
        url: data.url,
        filename: fileName,
        saveAs: true
      });

      console.log(`${LOG_PREFIX} Download initiated`);
    } else {
      throw new Error('无法获取下载链接');
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Download failed:`, error);
    throw error;
  }
}

// 更新浏览器扩展图标角标
function updateBadge(count, tabId) {
  const text = count > 0 ? String(count) : '';
  
  if (tabId) {
    // 为特定标签页设置角标
    chrome.action.setBadgeText({ text: text, tabId: tabId });
    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50', tabId: tabId });
    }
  } else {
    // 全局设置
    chrome.action.setBadgeText({ text: text });
    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#4caf50' });
    }
  }
  
  console.log(`${LOG_PREFIX} Badge updated:`, text);
}

console.log(`${LOG_PREFIX} Ready to handle download requests`);


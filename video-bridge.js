(function() {
  'use strict';

  if (window.__tronclassPlusPlusVideoBridge) return;
  window.__tronclassPlusPlusVideoBridge = true;
  try {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-tronclass-plus-plus-bridge', '1');
    }
  } catch {}

  const STORAGE_KEY = 'tronclass_plus_plus_video_options';
  const SOURCE_IN = 'tronclass-plus-plus-content';
  const SOURCE_OUT = 'tronclass-plus-plus-video-bridge';

  const options = loadOptions();
  const patchedVideos = new WeakMap();
  const patchedPlayers = new WeakMap();
  const observedVideos = new WeakSet();
  const observedPlayers = new WeakSet();
  const patchedMediaPrototypes = [];
  const networkActivities = new Map();
  const activityInfoRequests = new Map();
  const pendingResumeClicks = new WeakMap();

  let scanTimer = null;
  let navigateDelayTimer = null;
  let navigateTimer = null;
  let navigateOverlay = null;
  let cancelledAutoNavigateKey = null;
  let activityKey = null;
  let activityFirstSeenAt = 0;
  let activityHasSeenVideo = false;
  let lastResumeClickAt = 0;

  const ENDING_TOLERANCE_SECONDS = 0.75;
  const NON_VIDEO_SKIP_DELAY_MS = 2500;
  const UNKNOWN_ACTIVITY_SKIP_DELAY_MS = 9000;
  const AUTO_NAVIGATE_COUNTDOWN_SECONDS = 5;
  const RESUME_CLICK_COOLDOWN_MS = 350;

  function loadOptions() {
    try {
      return Object.assign({
        antiPause: false,
        autoNavigate: false
      }, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return {
        antiPause: false,
        autoNavigate: false
      };
    }
  }

  function saveOptions() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch {}
  }

  function getRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function normalizeActivityId(value) {
    if (value === null || value === undefined) return null;
    const text = String(value);
    return /^\d+$/.test(text) ? text : null;
  }

  function normalizeActivity(activity) {
    if (!activity || typeof activity !== 'object') return null;

    const id = normalizeActivityId(
      activity.referrerId ||
      activity.referrer_id ||
      activity.activity_id ||
      activity.activityId ||
      activity.id
    );
    if (!id) return null;

    const type = String(activity.type || activity.activity_type || activity.activityType || '');
    const title = activity.title || activity.name || activity.display_name || activity.displayName || '';
    const url = activity.url || activity.href || '';
    const sort = Number(activity.sort ?? activity.activity_sort ?? activity.activitySort ?? 0);
    const syllabusSort = Number(activity.syllabus_sort ?? activity.syllabusSort ?? 0);
    const moduleSort = Number(activity.module_sort ?? activity.moduleSort ?? 0);

    if (!type && !url && !title) return null;

    return {
      id,
      type,
      title,
      url,
      sort: Number.isFinite(sort) ? sort : 0,
      syllabusSort: Number.isFinite(syllabusSort) ? syllabusSort : 0,
      moduleSort: Number.isFinite(moduleSort) ? moduleSort : 0
    };
  }

  function rememberActivity(activity) {
    const normalized = normalizeActivity(activity);
    if (!normalized) return;

    const existing = networkActivities.get(normalized.id) || {};
    networkActivities.set(normalized.id, Object.assign(existing, normalized));
  }

  function harvestActivities(value, depth, seen) {
    if (!value || depth > 6) return;
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item) => harvestActivities(item, depth + 1, seen));
      return;
    }

    rememberActivity(value);
    Object.keys(value).forEach((key) => {
      if (/activities|activity|modules|syllabuses|course|items|children|data|value/i.test(key)) {
        harvestActivities(value[key], depth + 1, seen);
      }
    });
  }

  function harvestKnownGlobals() {
    [
      window.globalData,
      window.__INITIAL_STATE__,
      window.__NUXT__,
      window.__APP_DATA__,
      window.course,
      window.activity,
      window.modules
    ].forEach((value) => harvestActivities(value, 0, new WeakSet()));
  }

  function captureActivityPayload(data) {
    try {
      harvestActivities(data, 0, new WeakSet());
    } catch {}
  }

  function getCurrentActivity() {
    harvestKnownGlobals();
    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    return currentActivityId ? networkActivities.get(currentActivityId) || null : null;
  }

  function getCurrentActivityKind() {
    const activity = getCurrentActivity();
    if (!activity || !activity.type) return 'unknown';
    return isVideoActivity(activity) ? 'video' : 'nonVideo';
  }

  function requestCurrentActivityInfo(activityId) {
    if (!activityId || networkActivities.has(activityId) || activityInfoRequests.has(activityId)) return;

    try {
      const url = new URL(`/api/activities/${activityId}`, window.location.origin).href;
      const request = window.fetch(url, {
        credentials: 'include',
        cache: 'no-store'
      })
        .then((response) => (response && response.ok ? response.clone().json() : null))
        .then((data) => {
          if (data) captureActivityPayload(data);
        })
        .catch(() => {})
        .finally(() => {
          activityInfoRequests.delete(activityId);
        });
      activityInfoRequests.set(activityId, request);
    } catch {}
  }

  function getNetworkActivityList(currentActivityId) {
    const activities = Array.from(networkActivities.values())
      .filter((activity) => activity.id)
      .sort((left, right) => (
        left.moduleSort - right.moduleSort ||
        left.syllabusSort - right.syllabusSort ||
        left.sort - right.sort ||
        Number(left.id) - Number(right.id)
      ));

    return activities.some((activity) => activity.id === currentActivityId) ? activities : [];
  }

  function getAccessibleDocuments() {
    const documents = [];
    const seen = new Set();

    function collect(doc) {
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      documents.push(doc);

      Array.from(doc.querySelectorAll('iframe, frame')).forEach((frame) => {
        try {
          collect(frame.contentDocument || (frame.contentWindow && frame.contentWindow.document));
        } catch {}
      });
    }

    collect(document);
    return documents;
  }

  function getVideos() {
    const videos = [];
    const seen = new Set();

    function addVideo(video) {
      if (!video || seen.has(video)) return;
      seen.add(video);
      videos.push(video);
    }

    getAccessibleDocuments().forEach((doc) => {
      try {
        Array.from(doc.getElementsByTagName('video')).forEach(addVideo);
      } catch {}

      try {
        Array.from((doc.body || doc).getElementsByTagName('video')).forEach(addVideo);
      } catch {}

      try {
        Array.from(doc.querySelectorAll('video, .video-js video, .vjs-tech')).forEach(addVideo);
      } catch {}
    });

    return videos;
  }

  function getRawVideoCounts() {
    const counts = {
      tag: 0,
      bodyTag: 0,
      query: 0
    };

    getAccessibleDocuments().forEach((doc) => {
      try {
        counts.tag += doc.getElementsByTagName('video').length;
      } catch {}

      try {
        counts.bodyTag += (doc.body || doc).getElementsByTagName('video').length;
      } catch {}

      try {
        counts.query += doc.querySelectorAll('video').length;
      } catch {}
    });

    return counts;
  }

  function getPlayers() {
    const players = [];
    getAccessibleDocuments().forEach((doc) => {
      try {
        const win = doc.defaultView;
        if (!win || !win.videojs || !win.videojs.players) return;
        Object.keys(win.videojs.players).forEach((key) => {
          if (win.videojs.players[key]) {
            players.push(win.videojs.players[key]);
          }
        });
      } catch {}
    });
    return players;
  }

  function isMediaEnded(media) {
    if (!media) return false;
    const duration = Number(media.duration);
    const currentTime = Number(media.currentTime);
    return !!media.ended || (
      Number.isFinite(duration) &&
      duration > 0 &&
      Number.isFinite(currentTime) &&
      currentTime >= duration - ENDING_TOLERANCE_SECONDS
    );
  }

  function getAutoNavigateKey() {
    return extractActivityIdFromUrl(window.location.href) || window.location.href;
  }

  function isDomReady() {
    return document.readyState === 'interactive' || document.readyState === 'complete';
  }

  function isActivityDomReady() {
    if (!isDomReady() || !document.body) return false;

    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    if (!currentActivityId) return true;

    return !!(
      getActiveRenderedActivityRow() ||
      document.querySelector('.module-list, .activity-list, li.activity, [ng-repeat*="activity"]')
    );
  }

  function getCurrentRenderedActivityText() {
    try {
      return (getActiveRenderedActivityRow()?.textContent || '').replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  function isExplicitNonVideoActivityText(text) {
    return /课件|作业|测试|测验|练习|知识图谱|图谱|问卷|讨论|文档|资料|附件|考试|PPT|PDF/i.test(text || '');
  }

  function isPlayerEnded(player) {
    try {
      if (typeof player.ended === 'function' && player.ended()) return true;
    } catch {}

    try {
      const duration = Number(typeof player.duration === 'function' ? player.duration() : player.duration);
      const currentTime = Number(typeof player.currentTime === 'function' ? player.currentTime() : player.currentTime);
      return Number.isFinite(duration) &&
        duration > 0 &&
        Number.isFinite(currentTime) &&
        currentTime >= duration - ENDING_TOLERANCE_SECONDS;
    } catch {
      return false;
    }
  }

  function isPlayerPaused(player) {
    try {
      if (typeof player.paused === 'function') return !!player.paused();
      return !!player.paused;
    } catch {
      return false;
    }
  }

  function shouldBlockPause(target) {
    return options.antiPause && !isMediaEnded(target);
  }

  function shouldBlockPlayerPause(player) {
    return options.antiPause && !isPlayerEnded(player);
  }

  function isResumeTargetPaused(target) {
    if (!target) return false;
    if (target.nodeType === 1 && typeof target.paused === 'boolean') {
      return target.paused && !isMediaEnded(target);
    }
    return isPlayerPaused(target) && !isPlayerEnded(target);
  }

  function getPlayerElementFromVideo(video) {
    return video && video.closest && video.closest('#video, .video-player, [id^="wg-video-player-"], .video-js');
  }

  function getPlayerElementFromPlayer(player) {
    try {
      if (typeof player.el === 'function') return player.el();
      if (player.el) return player.el;
    } catch {}

    try {
      if (typeof player.tech === 'function') {
        const tech = player.tech();
        if (tech && typeof tech.el === 'function') {
          return getPlayerElementFromVideo(tech.el()) || tech.el();
        }
      }
    } catch {}

    return null;
  }

  function findPlayButton(root) {
    const doc = root && root.ownerDocument ? root.ownerDocument : document;
    const scope = root || doc;
    const selector = [
      'button.mvp-toggle-play[aria-label="播放"]',
      'button.mvp-toggle-play[aria-label*="播放"]',
      'button.mvp-toggle-play'
    ].join(',');

    try {
      const scopedButton = scope.querySelector(selector);
      if (scopedButton && isVisible(scopedButton)) return scopedButton;
    } catch {}

    try {
      const pageButton = doc.querySelector(`#video ${selector}, .video-player ${selector}`);
      if (pageButton && isVisible(pageButton)) return pageButton;
    } catch {}

    return null;
  }

  function clickPlayControl(target) {
    const root = target && target.nodeType === 1
      ? getPlayerElementFromVideo(target)
      : getPlayerElementFromPlayer(target);
    const button = findPlayButton(root);
    return !!(button && clickElement(button));
  }

  function resumeByUserLikeClick(target) {
    const now = Date.now();
    if (now - lastResumeClickAt < RESUME_CLICK_COOLDOWN_MS) return;
    lastResumeClickAt = now;

    if (target && (typeof target === 'object' || typeof target === 'function')) {
      if (pendingResumeClicks.has(target)) return;
      const timer = window.setTimeout(() => {
        pendingResumeClicks.delete(target);
        clickPlayControl(target);
      }, 120);
      pendingResumeClicks.set(target, timer);
      return;
    }

    window.setTimeout(() => {
      clickPlayControl(target);
    }, 120);
  }

  function patchMediaPrototype(win) {
    try {
      const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
      if (!proto || patchedMediaPrototypes.some((entry) => entry.proto === proto)) return;

      const descriptor = Object.getOwnPropertyDescriptor(proto, 'pause');
      const originalPause = proto.pause;
      if (typeof originalPause !== 'function') return;

      Object.defineProperty(proto, 'pause', {
        configurable: true,
        writable: true,
        value: function(...args) {
          if (shouldBlockPause(this)) {
            const result = originalPause.apply(this, args);
            resumeByUserLikeClick(this);
            return result;
          }

          return originalPause.apply(this, args);
        }
      });

      patchedMediaPrototypes.push({ proto, descriptor });
    } catch {}
  }

  function restoreMediaPrototypes() {
    while (patchedMediaPrototypes.length) {
      const { proto, descriptor } = patchedMediaPrototypes.pop();
      try {
        if (descriptor) {
          Object.defineProperty(proto, 'pause', descriptor);
        }
      } catch {}
    }
  }

  function patchVideo(video) {
    if (patchedVideos.has(video)) return;
    const descriptor = Object.getOwnPropertyDescriptor(video, 'pause');
    const originalPause = video.pause;
    patchedVideos.set(video, { descriptor, originalPause });
    try {
      Object.defineProperty(video, 'pause', {
        configurable: true,
        writable: true,
        value: function(...args) {
          if (shouldBlockPause(this)) {
            const result = originalPause.apply(this, args);
            resumeByUserLikeClick(this);
            return result;
          }

          return originalPause.apply(this, args);
        }
      });
    } catch {}
  }

  function restoreVideo(video) {
    if (!patchedVideos.has(video)) return;
    const { descriptor } = patchedVideos.get(video);
    try {
      if (descriptor) {
        Object.defineProperty(video, 'pause', descriptor);
      } else {
        delete video.pause;
      }
    } catch {}
    patchedVideos.delete(video);
  }

  function patchPlayer(player) {
    if (patchedPlayers.has(player) || typeof player.pause !== 'function') return;
    const originalPause = player.pause;
    patchedPlayers.set(player, originalPause);
    try {
      player.pause = function(...args) {
        if (!shouldBlockPlayerPause(this)) {
          return originalPause.apply(this, args);
        }

        const result = originalPause.apply(this, args);
        resumeByUserLikeClick(this);
        return result;
      };
    } catch {}
  }

  function restorePlayer(player) {
    if (!patchedPlayers.has(player)) return;
    try {
      player.pause = patchedPlayers.get(player);
    } catch {}
    patchedPlayers.delete(player);
  }

  function observeVideo(video) {
    if (observedVideos.has(video)) return;
    observedVideos.add(video);

    const maybeStartAutoNavigate = () => {
      if (options.autoNavigate && isMediaEnded(video)) {
        startAutoNavigate(0);
      }
    };

    video.addEventListener('ended', () => {
      if (options.autoNavigate) startAutoNavigate(0);
    }, true);
    video.addEventListener('timeupdate', maybeStartAutoNavigate, true);
    video.addEventListener('pause', () => {
      if (shouldBlockPause(video)) {
        resumeByUserLikeClick(video);
      }
    }, true);
  }

  function observePlayer(player) {
    if (observedPlayers.has(player) || typeof player.on !== 'function') return;
    observedPlayers.add(player);
    try {
      player.on('ended', () => {
        if (options.autoNavigate) startAutoNavigate(0);
      });
      player.on('timeupdate', () => {
        if (options.autoNavigate && isPlayerEnded(player)) startAutoNavigate(0);
      });
    } catch {}
  }

  function updateDebugAttributes(state) {
    try {
      const root = document.documentElement;
      if (!root) return;

      Object.entries(state).forEach(([key, value]) => {
        root.setAttribute(`data-tronclass-plus-plus-${key}`, String(value ?? ''));
      });
    } catch {}
  }

  function scanPlayersAndVideos() {
    if (!isActivityDomReady()) {
      updateDebugAttributes({
        ready: '0',
        videos: 0,
        players: 0,
        overlay: navigateOverlay ? '1' : '0'
      });
      updateScanTimer();
      return {
        videoCount: 0,
        playerCount: 0
      };
    }

    const docs = getAccessibleDocuments();
    const videos = getVideos();
    const players = getPlayers();
    const rawVideoCounts = getRawVideoCounts();
    const rawVideoCount = Math.max(rawVideoCounts.tag, rawVideoCounts.bodyTag, rawVideoCounts.query);
    const currentActivityKey = getAutoNavigateKey();
    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    const currentActivityText = getCurrentRenderedActivityText();
    const isExplicitNonVideoText = isExplicitNonVideoActivityText(currentActivityText);

    if (activityKey !== currentActivityKey) {
      clearAutoNavigate();
      activityKey = currentActivityKey;
      activityFirstSeenAt = Date.now();
      activityHasSeenVideo = false;
      cancelledAutoNavigateKey = null;
    }

    requestCurrentActivityInfo(currentActivityId);

    const currentActivityKind = getCurrentActivityKind();
    updateDebugAttributes({
      ready: '1',
      activity: currentActivityId || '',
      kind: currentActivityKind,
      videos: videos.length,
      rawVideos: rawVideoCount,
      rawVideoTags: rawVideoCounts.tag,
      rawVideoBodyTags: rawVideoCounts.bodyTag,
      rawVideoQueries: rawVideoCounts.query,
      players: players.length,
      overlay: navigateOverlay ? '1' : '0',
      autoNavigate: options.autoNavigate ? '1' : '0',
      antiPause: options.antiPause ? '1' : '0',
      explicitNonVideo: isExplicitNonVideoText ? '1' : '0'
    });

    if (currentActivityKind === 'video' || videos.length > 0 || rawVideoCount > 0 || players.length > 0) {
      activityHasSeenVideo = true;
    }

    videos.forEach(observeVideo);
    players.forEach(observePlayer);

    if (options.antiPause) {
      docs.forEach((doc) => {
        if (doc.defaultView) patchMediaPrototype(doc.defaultView);
      });
      videos.forEach(patchVideo);
      videos.forEach((video) => {
        if (video.paused && !isMediaEnded(video)) resumeByUserLikeClick(video);
      });
      players.forEach(patchPlayer);
      players.forEach((player) => {
        if (isPlayerPaused(player) && !isPlayerEnded(player)) resumeByUserLikeClick(player);
      });
    } else {
      videos.forEach(restoreVideo);
      players.forEach(restorePlayer);
      restoreMediaPrototypes();
    }

    if (options.autoNavigate) {
      if (videos.some(isMediaEnded) || players.some(isPlayerEnded)) {
        startAutoNavigate(0);
      } else if (videos.length || rawVideoCount || players.length) {
        cancelledAutoNavigateKey = null;
      } else if (
        currentActivityKind === 'nonVideo' &&
        !videos.length &&
        !players.length &&
        Date.now() - activityFirstSeenAt >= (
          isExplicitNonVideoText ? NON_VIDEO_SKIP_DELAY_MS : UNKNOWN_ACTIVITY_SKIP_DELAY_MS
        )
      ) {
        startAutoNavigate(0, {
          reason: 'nonVideo',
          message: '当前内容不是视频',
          action: '跳过'
        });
      } else if (
        currentActivityKind === 'unknown' &&
        !videos.length &&
        !players.length &&
        !activityHasSeenVideo &&
        Date.now() - activityFirstSeenAt >= UNKNOWN_ACTIVITY_SKIP_DELAY_MS
      ) {
        startAutoNavigate(0, {
          reason: 'nonVideo',
          message: '当前内容不是视频',
          action: '跳过'
        });
      }
    }

    updateScanTimer();
    return {
      videoCount: videos.length,
      playerCount: players.length
    };
  }

  function updateScanTimer() {
    const shouldScan = options.antiPause || options.autoNavigate;
    if (shouldScan && !scanTimer) {
      scanTimer = window.setInterval(scanPlayersAndVideos, 1500);
    } else if (!shouldScan && scanTimer) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function extractActivityIdFromUrl(rawUrl) {
    if (!rawUrl) return null;

    const value = String(rawUrl);
    const patterns = [
      /learning-activity(?:\/[^#?]*)?#\/(\d+)/i,
      /#\/(\d+)(?:[/?&]|$)/,
      /\/activities\/(\d+)(?:[/?#]|$)/i,
      /\/activity\/(\d+)(?:[/?#]|$)/i,
      /[?&]activity[_-]?id=(\d+)(?:&|$)/i
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  function extractActivityIdFromSignal(signal) {
    if (!signal) return null;

    return extractActivityIdFromUrl(signal) || (() => {
      const value = String(signal);
      const patterns = [
        /activity[_-]?id['"]?\s*[:=]\s*['"]?(\d+)/i,
        /(?:change|open|select|goto|goTo|load)Activity\s*\(\s*['"]?(\d+)/,
        /activities?['"]?\s*[,:\]]\s*['"]?(\d+)/i
      ];

      for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) return match[1];
      }

      return null;
    })();
  }

  function getElementActivitySignal(el) {
    const attrs = [
      'href',
      'ng-href',
      'data-href',
      'data-url',
      'to',
      'ui-sref',
      'ng-click',
      '@click',
      'v-on:click',
      'onclick',
      'data-action',
      'data-activity-id',
      'activity-id',
      'data-id',
      'id',
      'class'
    ];

    return attrs
      .map((name) => el.getAttribute(name))
      .filter(Boolean)
      .join(' ');
  }

  function getElementActivityContextSignal(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === 1 && node !== node.ownerDocument.body) {
      parts.push(
        node.id,
        typeof node.className === 'string' ? node.className : '',
        node.getAttribute('role'),
        node.getAttribute('aria-label'),
        node.getAttribute('ng-repeat'),
        node.getAttribute('data-type'),
        node.getAttribute('activity-type')
      );
      node = node.parentElement;
    }

    return parts.filter(Boolean).join(' ');
  }

  function hasActivityIdContext(el) {
    if (!el) return false;

    const signal = [
      getElementActivitySignal(el),
      getElementActivityContextSignal(el)
    ].filter(Boolean).join(' ');

    return /activity|activities|learning-activity/i.test(signal);
  }

  function getActivityIdFromElement(el) {
    if (!el) return null;

    const activityIdAttrs = [
      'data-activity-id',
      'activity-id'
    ];
    for (const name of activityIdAttrs) {
      const id = normalizeActivityId(el.getAttribute && el.getAttribute(name));
      if (id) return id;
    }

    const genericId = normalizeActivityId(el.getAttribute && el.getAttribute('data-id'));
    if (genericId && hasActivityIdContext(el)) return genericId;

    const ownId = extractActivityIdFromSignal(getElementActivitySignal(el));
    if (ownId) return ownId;

    try {
      const descendants = Array.from(el.querySelectorAll([
        'a[href]',
        '[ng-href]',
        '[data-href]',
        '[data-url]',
        '[to]',
        '[ui-sref]',
        '[ng-click]',
        '[onclick]',
        '[data-action]',
        '[data-activity-id]',
        '[activity-id]',
        '[data-id]'
      ].join(',')));
      for (const node of descendants) {
        for (const name of activityIdAttrs) {
          const id = normalizeActivityId(node.getAttribute && node.getAttribute(name));
          if (id) return id;
        }
        const nestedGenericId = normalizeActivityId(node.getAttribute && node.getAttribute('data-id'));
        if (nestedGenericId && hasActivityIdContext(node)) return nestedGenericId;
        const id = extractActivityIdFromSignal(getElementActivitySignal(node));
        if (id) return id;
      }
    } catch {}

    return null;
  }

  function getElementDeepSignal(el) {
    if (!el) return '';

    const parts = [
      el.textContent,
      el.id,
      typeof el.className === 'string' ? el.className : ''
    ];

    const attrs = [
      'title',
      'aria-label',
      'data-original-title',
      'ng-controller',
      'ng-repeat',
      'activity-type',
      'data-type',
      'type'
    ];

    [el, ...Array.from(el.querySelectorAll('*'))].forEach((node) => {
      attrs.forEach((name) => {
        const value = node.getAttribute && node.getAttribute(name);
        if (value) parts.push(value);
      });
      if (typeof node.className === 'string') parts.push(node.className);
    });

    return parts.filter(Boolean).join(' ');
  }

  function isVideoActivityElement(el) {
    const signal = getElementDeepSignal(el);

    if (/音视频|视频|录播|微课|online_video|video|lesson|slide/i.test(signal)) {
      return true;
    }

    if (/参考资料|课件|作业|测试|讨论|问卷|material|homework|exam|forum|questionnaire/i.test(signal)) {
      return false;
    }

    return false;
  }

  function isVideoActivity(activity) {
    if (!activity) return false;

    const type = String(activity.type || '').toLowerCase();
    if (type) return type === 'online_video' || type === 'video';

    const signal = [
      activity.title,
      activity.url
    ].filter(Boolean).join(' ');

    if (/online[_-]?video|video|音视频|视频|录播|微课/i.test(signal)) {
      return true;
    }

    return false;
  }

  function getCourseIdFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      const match = url.pathname.match(/\/course\/([^/]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function isSafeActivityTarget(rawUrl, activityId) {
    if (!rawUrl || !activityId) return false;

    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.origin !== window.location.origin) return false;
      if (/\/api\//i.test(url.pathname)) return false;

      const targetActivityId = extractActivityIdFromUrl(url.href);
      if (targetActivityId !== activityId) return false;

      const currentCourseId = getCourseIdFromUrl(window.location.href);
      const targetCourseId = getCourseIdFromUrl(url.href);
      if (currentCourseId && targetCourseId && currentCourseId !== targetCourseId) return false;

      return true;
    } catch {
      return false;
    }
  }

  function getActivityHref(el, activityId) {
    const rawHref = el.getAttribute('href') ||
      el.getAttribute('ng-href') ||
      el.getAttribute('data-href') ||
      el.getAttribute('data-url') ||
      el.getAttribute('to');

    if (!rawHref || /^javascript:/i.test(rawHref)) return null;

    const hrefId = extractActivityIdFromUrl(rawHref);
    if (hrefId !== activityId) return null;

    try {
      const href = new URL(rawHref, el.ownerDocument.defaultView.location.href).href;
      return isSafeActivityTarget(href, activityId) ? href : null;
    } catch {
      return null;
    }
  }

  function getActivityListCandidates(doc) {
    const selectors = [
      'a[href]',
      '[ng-href]',
      '[data-href]',
      '[data-url]',
      '[to]',
      '[ui-sref]',
      '[ng-click]',
      '[onclick]',
      '[data-action]',
      '[data-activity-id]',
      '[activity-id]',
      '[data-id]'
    ].join(',');

    return Array.from(doc.querySelectorAll(selectors))
      .map((el, index) => {
        const id = getActivityIdFromElement(el);
        if (!id) return null;

        return {
          el,
          id,
          href: getActivityHref(el, id),
          visible: isVisible(el),
          index
        };
      })
      .filter(Boolean);
  }

  function getActivityContainerScore(el) {
    let score = 0;
    let node = el;

    while (node && node.nodeType === 1 && node !== node.ownerDocument.body) {
      const signal = [
        node.id,
        typeof node.className === 'string' ? node.className : '',
        node.getAttribute('role'),
        node.getAttribute('aria-label')
      ].filter(Boolean).join(' ');

      if (/activity|activities|chapter|lesson|section|unit|catalog|course|outline|sidebar|menu|list|tree|nav|目录|章|节|课/i.test(signal)) {
        score += 2;
      }

      node = node.parentElement;
    }

    return score;
  }

  function filterActivitiesByContainer(activities) {
    const maxContainerScore = activities.reduce((max, activity) => Math.max(max, activity.containerScore || 0), 0);

    return maxContainerScore > 0
      ? activities.filter((activity) => activity.containerScore === maxContainerScore)
      : activities;
  }

  function compareActivityCandidate(left, right) {
    if (!left) return right;
    if (!right) return left;

    const leftScore = left.containerScore || 0;
    const rightScore = right.containerScore || 0;
    if (left.visible !== right.visible) return right.visible ? right : left;
    if (leftScore !== rightScore) return rightScore > leftScore ? right : left;
    if (!!left.href !== !!right.href) return right.href ? right : left;
    return left.order <= right.order ? left : right;
  }

  function getOrderedActivities(currentActivityId) {
    const byId = new Map();
    const visible = [];
    const hidden = [];
    let order = 0;

    getAccessibleDocuments().forEach((doc) => {
      const candidates = getActivityListCandidates(doc);
      candidates.forEach((activity) => {
        activity.containerScore = getActivityContainerScore(activity.el);
        activity.order = order++;
        byId.set(activity.id, compareActivityCandidate(byId.get(activity.id), activity));
      });
    });

    Array.from(byId.values())
      .sort((left, right) => left.order - right.order)
      .forEach((activity) => {
        (activity.visible ? visible : hidden).push(activity);
      });

    const visibleOrdered = filterActivitiesByContainer(visible);
    if (visibleOrdered.length >= 2 && (!currentActivityId || visibleOrdered.some((activity) => activity.id === currentActivityId))) {
      return visibleOrdered;
    }

    return filterActivitiesByContainer(visible.concat(hidden));
  }

  function getNavigationDebugState() {
    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    const activities = getOrderedActivities(currentActivityId).map((activity, index) => ({
      index,
      id: activity.id,
      href: activity.href,
      visible: activity.visible,
      containerScore: activity.containerScore || 0,
      text: activity.el ? (activity.el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    }));
    const currentIndex = activities.findIndex((activity) => activity.id === currentActivityId);
    const nextActivity = currentIndex >= 0 ? activities[currentIndex + 1] : null;
    const activeRow = getActiveRenderedActivityRow();
    const nextRenderedAny = getNextActivityElementFromRenderedList();

    return {
      href: window.location.href,
      currentActivityId,
      currentIndex,
      nextActivity: nextActivity || null,
      activeRenderedActivity: serializeActivityRow(activeRow),
      nextRenderedActivity: serializeActivityRow(nextRenderedAny),
      activityCount: activities.length,
      activities
    };
  }

  function buildActivityUrl(activityId, href) {
    if (href && isSafeActivityTarget(href, activityId)) return href;

    const current = window.location.href;
    if (/#\/\d+/.test(current)) {
      return current.replace(/#\/\d+/, `#/${activityId}`);
    }

    if (/\/activities\/\d+/.test(current)) {
      return current.replace(/\/activities\/\d+/, `/activities/${activityId}`);
    }

    if (/\/activity\/\d+/.test(current)) {
      return current.replace(/\/activity\/\d+/, `/activity/${activityId}`);
    }

    const url = new URL(current);
    url.hash = `/${activityId}`;
    return url.href;
  }

  function navigateToActivity(activityId, href) {
    const nextUrl = buildActivityUrl(activityId, href);
    if (!nextUrl || nextUrl === window.location.href) return false;
    if (!isSafeActivityTarget(nextUrl, activityId)) return false;

    window.location.assign(nextUrl);
    return true;
  }

  function navigateToNextActivityFromNetworkList() {
    harvestKnownGlobals();

    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    if (!currentActivityId) return false;

    const activities = getNetworkActivityList(currentActivityId);
    const currentIndex = activities.findIndex((activity) => activity.id === currentActivityId);
    if (currentIndex < 0) return false;

    const nextActivity = activities[currentIndex + 1];
    if (!nextActivity) return false;

    return navigateToActivity(nextActivity.id, nextActivity.url);
  }

  function navigateToRenderedActivity(row) {
    const activityId = getActivityIdFromElement(row);
    if (!activityId) return false;

    const href = getActivityHref(row, activityId);
    return navigateToActivity(activityId, href);
  }

  function clickElement(el) {
    try {
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
    } catch {}

    try {
      const win = el.ownerDocument.defaultView || window;
      const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const x = rect ? rect.left + rect.width / 2 : 0;
      const y = rect ? rect.top + rect.height / 2 : 0;
      const pointerOptions = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        clientX: x,
        clientY: y
      };

      if (typeof win.PointerEvent === 'function') {
        el.dispatchEvent(new win.PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, pointerOptions)));
      }
      el.dispatchEvent(new win.MouseEvent('mousedown', pointerOptions));
      if (typeof win.PointerEvent === 'function') {
        el.dispatchEvent(new win.PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, pointerOptions)));
      }
      el.dispatchEvent(new win.MouseEvent('mouseup', pointerOptions));
      el.dispatchEvent(new win.MouseEvent('click', pointerOptions));
      return true;
    } catch {}

    try {
      el.click();
      return true;
    } catch {
      return false;
    }
  }

  function serializeActivityRow(row) {
    if (!row) return null;

    return {
      text: (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      className: typeof row.className === 'string' ? row.className : '',
      isVideo: isVideoActivityElement(row)
    };
  }

  function getActiveRenderedActivityRow() {
    const selectors = [
      'li.activity.active',
      '.activity.active[ng-repeat*="activity"]',
      '.activity.active'
    ];

    for (const doc of getAccessibleDocuments()) {
      for (const selector of selectors) {
        const active = doc.querySelector(selector);
        if (active) return active;
      }
    }

    return null;
  }

  function getNextActivityElementFromRenderedList() {
    for (const doc of getAccessibleDocuments()) {
      const active = getActiveRenderedActivityRow();
      if (!active || active.ownerDocument !== doc) continue;

      const rows = Array.from(doc.querySelectorAll('li.activity, .activity[ng-repeat*="activity"]'))
        .filter((row) => (row.textContent || '').trim());
      const index = rows.indexOf(active);

      if (index >= 0) {
        const next = rows[index + 1];
        if (next) return next;
      }
    }

    return null;
  }

  function navigateToNextActivityFromList() {
    const nextElement = getNextActivityElementFromRenderedList();
    if (nextElement && navigateToRenderedActivity(nextElement)) return true;

    if (navigateToNextActivityFromNetworkList()) return true;

    const currentActivityId = extractActivityIdFromUrl(window.location.href);
    if (!currentActivityId) return false;

    const activities = getOrderedActivities(currentActivityId);
    const currentIndex = activities.findIndex((activity) => activity.id === currentActivityId);
    if (currentIndex < 0 || currentIndex >= activities.length - 1) return false;

    const nextActivity = activities[currentIndex + 1];
    return navigateToActivity(nextActivity.id, nextActivity.href);
  }

  function clearAutoNavigate() {
    if (navigateDelayTimer) {
      window.clearTimeout(navigateDelayTimer);
      navigateDelayTimer = null;
    }
    if (navigateTimer) {
      window.clearInterval(navigateTimer);
      navigateTimer = null;
    }
    if (navigateOverlay) {
      navigateOverlay.remove();
      navigateOverlay = null;
    }
  }

  function cancelAutoNavigate() {
    cancelledAutoNavigateKey = getAutoNavigateKey();
    clearAutoNavigate();
  }

  function getAutoNavigateMessage(config, remaining) {
    if (config && config.reason === 'nonVideo') {
      return `${config.message || '当前内容不是视频'}，${remaining} 秒后${config.action || '跳过'}`;
    }

    return `当前播放已完成，${remaining} 秒后跳转`;
  }

  function startAutoNavigate(delaySeconds, config) {
    if (navigateOverlay || navigateDelayTimer) return;
    if (cancelledAutoNavigateKey === getAutoNavigateKey()) return;
    if (!isActivityDomReady()) return;

    navigateDelayTimer = window.setTimeout(() => {
      navigateDelayTimer = null;
      if (!options.autoNavigate || navigateOverlay) return;
      if (cancelledAutoNavigateKey === getAutoNavigateKey()) return;
      if (!isActivityDomReady()) return;

      let remaining = AUTO_NAVIGATE_COUNTDOWN_SECONDS;
      const overlay = document.createElement('div');
      overlay.className = 'tronclass-plus-plus-auto-navigate-overlay';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483646',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'flex-direction:column',
        'gap:18px',
        'background:rgba(0,0,0,0.55)',
        'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif',
        'color:#fff'
      ].join(';');

      const text = document.createElement('div');
      text.style.cssText = 'font-size:20px;font-weight:600;text-align:center;';
      text.textContent = getAutoNavigateMessage(config, remaining);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = '取消';
      cancel.style.cssText = [
        'border:0',
        'border-radius:6px',
        'background:#e64553',
        'color:#fff',
        'padding:8px 24px',
        'font-size:14px',
        'font-weight:600',
        'cursor:pointer'
      ].join(';');
      cancel.addEventListener('click', cancelAutoNavigate);

      overlay.append(text, cancel);
      document.body.appendChild(overlay);
      navigateOverlay = overlay;

      navigateTimer = window.setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearAutoNavigate();
          if (!navigateToNextActivityFromList()) {
            cancelledAutoNavigateKey = getAutoNavigateKey();
          }
          return;
        }
        text.textContent = getAutoNavigateMessage(config, remaining);
      }, 1000);
    }, Math.max(0, delaySeconds || 0) * 1000);
  }

  function getState() {
    const scan = scanPlayersAndVideos();
    return {
      antiPause: !!options.antiPause,
      autoNavigate: !!options.autoNavigate,
      hasVideo: scan.videoCount > 0 || scan.playerCount > 0,
      videoCount: scan.videoCount,
      playerCount: scan.playerCount
    };
  }

  function setOption(name, value) {
    if (name === 'antiPause') {
      options.antiPause = !!value;
    } else if (name === 'autoNavigate') {
      options.autoNavigate = !!value;
      if (!options.autoNavigate) {
        clearAutoNavigate();
      }
    }
    saveOptions();
    return getState();
  }

  function installActivityNetworkCapture() {
    try {
      if (!window.__tronclassPlusPlusActivityNetworkCapture && typeof window.fetch === 'function') {
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
          const result = originalFetch.apply(this, args);
          try {
            result.then((response) => {
              const url = response && response.url ? response.url : getRequestUrl(args[0]);
              if (!/course|activ|module|syllabus|score/i.test(url || '')) return;
              response.clone().json()
                .then(captureActivityPayload)
                .catch(() => {});
            }).catch(() => {});
          } catch {}
          return result;
        };
        window.__tronclassPlusPlusActivityNetworkCapture = true;
      }
    } catch {}

    try {
      if (!window.__tronclassPlusPlusActivityXhrCapture && window.XMLHttpRequest) {
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__tronclassPlusPlusUrl = url;
          return originalOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function(...args) {
          try {
            this.addEventListener('load', () => {
              const url = this.responseURL || this.__tronclassPlusPlusUrl || '';
              if (!/course|activ|module|syllabus|score/i.test(url)) return;
              const contentType = this.getResponseHeader && this.getResponseHeader('content-type');
              if (contentType && !/json/i.test(contentType)) return;
              captureActivityPayload(JSON.parse(this.responseText));
            }, { once: true });
          } catch {}
          return originalSend.apply(this, args);
        };

        window.__tronclassPlusPlusActivityXhrCapture = true;
      }
    } catch {}

    harvestKnownGlobals();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.source !== SOURCE_IN || !message.id) return;

    try {
      let state;
      if (message.action === 'GET_VIDEO_STATE') {
        state = getState();
      } else if (message.action === 'SET_VIDEO_OPTION') {
        state = setOption(message.payload && message.payload.option, message.payload && message.payload.enabled);
      } else {
        throw new Error('Unknown action');
      }

      window.postMessage({
        source: SOURCE_OUT,
        id: message.id,
        ok: true,
        state
      }, '*');
    } catch (error) {
      window.postMessage({
        source: SOURCE_OUT,
        id: message.id,
        ok: false,
        error: error.message
      }, '*');
    }
  });

  window.__tronclassPlusPlusVideoDebug = {
    getNavigationState: getNavigationDebugState,
    navigateToNextActivity: navigateToNextActivityFromList,
    scan: getState
  };

  installActivityNetworkCapture();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPlayersAndVideos, { once: true });
  } else {
    scanPlayersAndVideos();
  }
})();

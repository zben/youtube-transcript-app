document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('summary-form');
  const urlInput = document.getElementById('url-input');
  const clearBtn = document.getElementById('clear-btn');
  const instructionInput = document.getElementById('instruction-input');
  const instructionCount = document.getElementById('instruction-count');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnLoader = submitBtn.querySelector('.btn-loader');

  const statusContainer = document.getElementById('status-container');
  const statusText = document.getElementById('status-text');

  // Enhanced Error & Diagnostics Elements
  const errorContainer = document.getElementById('error-container');
  const errorTitle = document.getElementById('error-title');
  const errorCodeBadge = document.getElementById('error-code-badge');
  const errorText = document.getElementById('error-text');
  const errorRetryBtn = document.getElementById('error-retry-btn');
  const errorDebugToggle = document.getElementById('error-debug-toggle');
  const errorDebugPanel = document.getElementById('error-debug-panel');
  const errorDebugContent = document.getElementById('error-debug-content');
  const errorDebugCopyBtn = document.getElementById('error-debug-copy-btn');

  const outputContainer = document.getElementById('output-container');
  const streamStatusLabel = document.getElementById('stream-status-label');
  const copyMarkdownBtn = document.getElementById('copy-markdown-btn');
  const clearVideoDataBtn = document.getElementById('clear-video-data-btn');
  const renderedContent = document.getElementById('rendered-content');
  const toast = document.getElementById('toast');

  let currentVideoId = null;
  let fullAccumulatedMarkdown = '';
  let activeRetryAction = null;
  let lastDebugData = null;
  const collapsedState = new Map();
  const saved5W1HMap = new Map();

  function normalizeHeading(h) {
    if (!h) return '';
    return h
      .replace(/^[#\s一二三四五六七八九十\d.、-]+/, '')
      .replace(/[：:\s\-_—·]/g, '')
      .trim()
      .toLowerCase();
  }

  // Clear button logic
  instructionInput.addEventListener('input', () => {
    instructionCount.textContent = String(instructionInput.value.length);
  });

  urlInput.addEventListener('input', () => {
    clearBtn.style.display = urlInput.value ? 'block' : 'none';
    hideError();
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    clearBtn.style.display = 'none';
    hideError();
    urlInput.focus();
  });

  // Example tags
  document.querySelectorAll('.tag-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      urlInput.value = btn.dataset.url;
      clearBtn.style.display = 'block';
      hideError();
      form.dispatchEvent(new Event('submit'));
    });
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function setOutputActionsVisible(visible) {
    const display = visible ? 'inline-flex' : 'none';
    copyMarkdownBtn.style.display = display;
    clearVideoDataBtn.style.display = display;
  }

  // Remove every stored record for the current video so it can be re-processed from scratch.
  clearVideoDataBtn.addEventListener('click', async () => {
    if (!currentVideoId) {
      showToast('当前没有可清除的视频');
      return;
    }

    if (!window.confirm(`确定要清除视频 ${currentVideoId} 的所有本地数据吗？\n\n包括字幕、完整总结与全部 5W1H 章节分析，清除后需重新生成。`)) {
      return;
    }

    const originalHtml = clearVideoDataBtn.innerHTML;
    clearVideoDataBtn.disabled = true;
    clearVideoDataBtn.innerHTML = '<span class="spinner-small"></span> 正在清除...';

    try {
      const res = await fetch(`/api/video/${currentVideoId}/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.success) {
        if (res.status === 404) {
          resetOutputView();
          showToast('该视频原本没有本地数据，可直接重新生成');
        } else {
          showToast(data.error || '清除失败，请稍后重试');
        }
        return;
      }

      resetOutputView();
      instructionInput.value = '';
      instructionCount.textContent = '0';
      showToast(data.message || '已清除该视频的所有本地数据');
    } catch (err) {
      console.error('Failed to clear video data:', err);
      showToast('清除请求失败，请确认服务在线后重试');
    } finally {
      clearVideoDataBtn.disabled = false;
      clearVideoDataBtn.innerHTML = originalHtml;
    }
  });

  function resetOutputView() {
    fullAccumulatedMarkdown = '';
    saved5W1HMap.clear();
    collapsedState.clear();
    renderedContent.innerHTML = '';
    outputContainer.style.display = 'none';
    setOutputActionsVisible(false);
    streamStatusLabel.textContent = '';
    activeRetryAction = null;
  }

  // Map error codes to friendly titles
  function getErrorTitle(code) {
    switch (code) {
      case 'INVALID_URL':
      case 'INVALID_INPUT':
        return '视频链接格式有误';
      case 'NO_TRANSCRIPT':
      case 'TRANSCRIPT_DISABLED':
        return '无法提取视频字幕';
      case 'VIDEO_UNAVAILABLE':
        return 'YouTube 视频无法访问';
      case 'YOUTUBE_RATE_LIMIT':
        return 'YouTube 访问频次受限';
      case 'YOUTUBE_NETWORK_ERROR':
      case 'TIMEOUT_ERROR':
      case 'NETWORK_ERROR':
        return '网络连接或请求超时';
      case 'AI_API_KEY_MISSING':
      case 'AI_API_KEY_INVALID':
        return 'Gemini API 密钥配置异常';
      case 'AI_RATE_LIMIT':
        return 'AI 接口配额或速率超限';
      case 'AI_SERVICE_UNAVAILABLE':
        return 'AI 服务暂时不可用';
      case 'AI_PARSE_ERROR':
        return 'AI 结构化解析失败';
      case 'DATABASE_ERROR':
        return '本地数据库异常';
      default:
        return '操作遇到问题';
    }
  }

  function showError(errData, onRetry) {
    let message = '发生未知错误，请重试。';
    let code = '';
    let debugInfo = null;
    let isRetryable = false;

    if (typeof errData === 'string') {
      message = errData;
    } else if (errData instanceof Error) {
      message = errData.message || message;
      debugInfo = {
        name: errData.name,
        message: errData.message,
        stack: errData.stack
      };
      isRetryable = true;
    } else if (errData && typeof errData === 'object') {
      message = errData.error || errData.message || message;
      code = errData.code || '';
      debugInfo = errData.debug || null;
      isRetryable = errData.retryable !== false;
    }

    // Fallback debug metadata if none provided
    if (!debugInfo) {
      debugInfo = {
        timestamp: new Date().toISOString(),
        url: urlInput.value.trim(),
        videoId: currentVideoId,
        code: code || 'UNKNOWN_CLIENT_ERROR'
      };
    }

    lastDebugData = debugInfo;

    // Set UI Texts
    errorTitle.textContent = getErrorTitle(code);
    errorText.textContent = message;

    if (code) {
      errorCodeBadge.textContent = code;
      errorCodeBadge.style.display = 'inline-block';
    } else {
      errorCodeBadge.style.display = 'none';
    }

    // Configure Retry Button
    if (isRetryable && typeof onRetry === 'function') {
      activeRetryAction = onRetry;
      errorRetryBtn.style.display = 'inline-flex';
    } else {
      activeRetryAction = null;
      errorRetryBtn.style.display = 'none';
    }

    // Configure Debug Panel
    if (debugInfo) {
      errorDebugContent.textContent = typeof debugInfo === 'string' 
        ? debugInfo 
        : JSON.stringify(debugInfo, null, 2);
      errorDebugToggle.style.display = 'inline-block';
      errorDebugToggle.textContent = '查看诊断信息 ▼';
      errorDebugPanel.style.display = 'none';
    } else {
      errorDebugToggle.style.display = 'none';
      errorDebugPanel.style.display = 'none';
    }

    errorContainer.style.display = 'flex';
  }

  function hideError() {
    errorContainer.style.display = 'none';
    errorText.textContent = '';
    errorDebugPanel.style.display = 'none';
    activeRetryAction = null;
    lastDebugData = null;
  }

  // Retry Button Click
  errorRetryBtn.addEventListener('click', () => {
    if (typeof activeRetryAction === 'function') {
      hideError();
      activeRetryAction();
    }
  });

  // Debug Details Toggle
  errorDebugToggle.addEventListener('click', () => {
    const isHidden = errorDebugPanel.style.display === 'none';
    if (isHidden) {
      errorDebugPanel.style.display = 'block';
      errorDebugToggle.textContent = '收起诊断信息 ▲';
    } else {
      errorDebugPanel.style.display = 'none';
      errorDebugToggle.textContent = '查看诊断信息 ▼';
    }
  });

  // Copy Debug Info
  errorDebugCopyBtn.addEventListener('click', async () => {
    if (!lastDebugData) return;
    try {
      const textToCopy = typeof lastDebugData === 'string'
        ? lastDebugData
        : JSON.stringify(lastDebugData, null, 2);
      await navigator.clipboard.writeText(textToCopy);
      showToast('已复制技术诊断信息到剪贴板');
    } catch {
      showToast('复制失败，请手动选择文本复制');
    }
  });

  function setStatus(msg) {
    statusText.textContent = msg;
    statusContainer.style.display = 'flex';
  }

  function hideStatus() {
    statusContainer.style.display = 'none';
  }

  function extractVideoId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const match = trimmed.match(/(?:watch\?v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  // Online / Offline Status
  window.addEventListener('offline', () => {
    showToast('网络连接已断开，请检查您的互联网连接');
  });

  window.addEventListener('online', () => {
    showToast('网络已恢复连接');
  });

  // --- RESTful Routing & Page Refresh Persistence ---
  async function checkInitialRoute() {
    const path = window.location.pathname;
    const match = path.match(/^\/(?:summary|video)\/([a-zA-Z0-9_-]{11})/);
    if (match && match[1]) {
      const vid = match[1];
      urlInput.value = `https://www.youtube.com/watch?v=${vid}`;
      clearBtn.style.display = 'block';
      currentVideoId = vid;

      // Check if already in D1/SQLite database
      try {
        setStatus('正在读取数据库中已保存的总结...');
        const res = await fetch(`/api/summary/${vid}`);
        const data = await res.json();
        hideStatus();

        if (data.exists && data.summaryMarkdown) {
          fullAccumulatedMarkdown = data.summaryMarkdown;
          saved5W1HMap.clear();
          if (data.fiveWoneHList && Array.isArray(data.fiveWoneHList)) {
            data.fiveWoneHList.forEach((item) => {
              const norm = normalizeHeading(item.chapter_heading);
              const val = {
                who: item.who,
                what: item.what,
                when: item.when,
                where: item.where,
                why: item.why,
                how: item.how
              };
              saved5W1HMap.set(norm, val);
              saved5W1HMap.set(item.chapter_heading, val);
            });
          }
          outputContainer.style.display = 'block';
          const savedCount = saved5W1HMap.size > 0 ? ` (已恢复 ${Math.floor(saved5W1HMap.size / 2)} 个章节的 5W1H)` : '';
          streamStatusLabel.textContent = `⚡ 已从数据库快速恢复总结${savedCount}，点击 5W1H 可查阅或切换`;
          setOutputActionsVisible(true);
          renderStructuredView(fullAccumulatedMarkdown, true);
          return;
        }
      } catch (err) {
        console.warn('Failed to fetch cached summary on load:', err);
        hideStatus();
      }

      // If not yet generated, start generation
      startGeneration(urlInput.value, false);
    }
  }

  // Form Submit Handler
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;

    const vid = extractVideoId(url);
    if (!vid) {
      showError({
        error: '无法识别输入的链接格式。请输入标准的 YouTube 链接（如 https://www.youtube.com/watch?v=... 或 11 位视频 ID）。',
        code: 'INVALID_URL',
        retryable: false
      });
      return;
    }

    startGeneration(url, false);
  });

  async function startGeneration(url, forceRefresh = false) {
    const vid = extractVideoId(url);
    if (!vid) {
      showError({
        error: '输入的 YouTube 链接无效，请检查后重试。',
        code: 'INVALID_URL',
        retryable: false
      });
      return;
    }

    const instruction = instructionInput.value.trim();

    currentVideoId = vid;
    // Update browser URL without reloading page
    if (window.location.pathname !== `/summary/${vid}`) {
      window.history.pushState({ videoId: vid }, '', `/summary/${vid}`);
    }

    hideError();
    hideStatus();
    outputContainer.style.display = 'none';
    setOutputActionsVisible(false);
    renderedContent.innerHTML = '';
    fullAccumulatedMarkdown = '';
    collapsedState.clear();

    submitBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-flex';

    setStatus('正在建立连接并准备提取视频信息...');

    let isStreamCompleted = false;

    try {
      if (!navigator.onLine) {
        throw new Error('当前处于离线状态，请检查网络连接后重试。');
      }

      const response = await fetch('/api/summarize-stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': `web-${Date.now().toString(36)}`
        },
        body: JSON.stringify({ url, forceRefresh, instruction })
      });

      if (!response.ok) {
        let errData;
        try {
          errData = await response.json();
        } catch {
          errData = { error: `请求失败 (HTTP ${response.status})` };
        }
        showError(errData, () => startGeneration(url, true));
        return;
      }

      outputContainer.style.display = 'block';
      streamStatusLabel.innerHTML = '<span class="spinner-small"></span> 正在实时流式生成中...';

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          const payloadStr = line.slice(6).trim();

          if (payloadStr === '[DONE]') {
            isStreamCompleted = true;
            break;
          }

          try {
            const parsed = JSON.parse(payloadStr);

            if (parsed.status === 'connected') {
              setStatus('服务端已连接，正在处理...');
            } else if (parsed.status === 'fetching_transcript') {
              setStatus(parsed.message || '正在提取视频演职员名单与字幕...');
            } else if (parsed.status === 'ready') {
              if (parsed.videoId) currentVideoId = parsed.videoId;
              hideStatus();
            } else if (parsed.status === 'streaming') {
              hideStatus();
              streamStatusLabel.innerHTML = '<span class="spinner-small"></span> ' + (parsed.message || '正在流式提炼总结...');
            } else if (parsed.error) {
              hideStatus();
              showError(parsed, () => startGeneration(url, true));
              if (fullAccumulatedMarkdown && fullAccumulatedMarkdown.trim().length > 50) {
                streamStatusLabel.innerHTML = `<span style="color: #f87171;">⚠️ 生成中断 (已保留部分内容): ${escapeHtml(parsed.error)}</span>`;
                setOutputActionsVisible(true);
                renderStructuredView(fullAccumulatedMarkdown, true);
              }
              return;
            } else if (parsed.text) {
              hideStatus();
              fullAccumulatedMarkdown += parsed.text;
              renderStructuredView(fullAccumulatedMarkdown, false);
            }
          } catch (jsonErr) {
            console.debug('SSE JSON parse skipped for chunk:', payloadStr);
          }
        }
      }

      // Check and load any existing 5W1H records from DB
      try {
        if (currentVideoId) {
          const checkRes = await fetch(`/api/summary/${currentVideoId}`);
          const checkData = await checkRes.json();
          if (checkData.fiveWoneHList && Array.isArray(checkData.fiveWoneHList)) {
            checkData.fiveWoneHList.forEach((item) => {
              const norm = normalizeHeading(item.chapter_heading);
              const val = {
                who: item.who,
                what: item.what,
                when: item.when,
                where: item.where,
                why: item.why,
                how: item.how
              };
              saved5W1HMap.set(norm, val);
              saved5W1HMap.set(item.chapter_heading, val);
            });
          }
        }
      } catch (e) {
        console.debug('Failed to sync 5W1H list:', e);
      }

      if (fullAccumulatedMarkdown && fullAccumulatedMarkdown.trim().length > 50) {
        streamStatusLabel.textContent = '✅ 对话总结生成完毕 (已安全保存至数据库，刷新页面不丢失)';
        setOutputActionsVisible(true);
        renderStructuredView(fullAccumulatedMarkdown, true);
        showToast('总结全部输出完成并已保存！');
      } else if (!isStreamCompleted) {
        throw new Error('流式传输意外中断，未接收到完整内容。');
      }
    } catch (err) {
      console.error('[Client Generation Error]:', err);
      hideStatus();

      const friendlyMsg = err.name === 'TypeError' && err.message.includes('fetch')
        ? '无法连接至本地服务端，请确认服务已启动或检查代理设置。'
        : (err.message || '生成对话总结时发生网络错误。');

      showError(
        {
          error: friendlyMsg,
          code: 'CLIENT_NETWORK_ERROR',
          retryable: true,
          debug: {
            name: err.name,
            message: err.message,
            stack: err.stack,
            videoId: currentVideoId
          }
        },
        () => startGeneration(url, true)
      );

      if (!fullAccumulatedMarkdown) {
        outputContainer.style.display = 'none';
      } else {
        streamStatusLabel.innerHTML = `<span style="color: #f87171;">⚠️ 生成中断: ${escapeHtml(err.message)}</span>`;
        setOutputActionsVisible(true);
      }
    } finally {
      submitBtn.disabled = false;
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
    }
  }

  // --- Render Markdown into Structured Collapsible & Indented Elements ---
  function renderStructuredView(markdownText, isComplete) {
    if (!markdownText) return;

    let mainTitle = '';
    let remaining = markdownText;

    // Extract Main Title (# ...)
    const titleMatch = remaining.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      mainTitle = titleMatch[1].trim();
      remaining = remaining.replace(/^#\s+.+$/m, '').trim();
    }

    // Split into chapters by "## "
    const rawBlocks = remaining.split(/(?=^##\s+)/m);
    const validChapters = rawBlocks.filter((b) => b.trim().startsWith('##'));

    const fragment = document.createDocumentFragment();

    if (mainTitle) {
      const h1 = document.createElement('h1');
      h1.className = 'main-title';
      h1.textContent = mainTitle;
      fragment.appendChild(h1);
    }

    validChapters.forEach((chapterBlock, idx) => {
      const trimmed = chapterBlock.trim();
      const headerMatch = trimmed.match(/^##\s+(.+)$/m);
      if (!headerMatch) return;

      let chapterHeading = headerMatch[1].trim();
      chapterHeading = chapterHeading.replace(/^[-*#\s]+/, '').replace(/[-*#\s]+$/, '');

      const chapterBodyContent = trimmed.replace(/^##\s+.+$/m, '').trim();
      const chapterId = `chapter-${idx}`;
      const isCollapsed = collapsedState.get(chapterId) || false;

      const sectionEl = document.createElement('div');
      sectionEl.className = `chapter-section ${isCollapsed ? 'collapsed' : ''}`;
      sectionEl.id = chapterId;

      // Header Bar
      const headerBar = document.createElement('div');
      headerBar.className = 'chapter-header';

      const titleGroup = document.createElement('div');
      titleGroup.className = 'chapter-title-group';
      titleGroup.innerHTML = `
        <span class="collapse-icon">▼</span>
        <span class="chapter-title">${escapeHtml(chapterHeading)}</span>
      `;

      titleGroup.addEventListener('click', () => {
        const currentlyCollapsed = sectionEl.classList.toggle('collapsed');
        collapsedState.set(chapterId, currentlyCollapsed);
      });

      // Check if 5W1H data is already available
      const normKey = normalizeHeading(chapterHeading);
      let existing5W1H = saved5W1HMap.get(chapterHeading) || saved5W1HMap.get(normKey);
      if (!existing5W1H) {
        for (const [k, v] of saved5W1HMap.entries()) {
          if (k && normKey && (k.includes(normKey) || normKey.includes(k))) {
            existing5W1H = v;
            break;
          }
        }
      }

      // 5W1H button
      const w5hBtn = document.createElement('button');
      w5hBtn.type = 'button';
      w5hBtn.className = `btn-5w1h ${existing5W1H ? 'has-data' : ''}`;
      w5hBtn.innerHTML = existing5W1H ? '5W1H <span class="badge-saved">✓</span>' : '5W1H';
      w5hBtn.title = existing5W1H ? '收起 / 展开该章节 5W1H 归纳 (已保存)' : '查阅该章节简明 5W1H 归纳';

      w5hBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handle5W1HClick(chapterHeading, sectionEl, w5hBtn);
      });

      headerBar.appendChild(titleGroup);
      headerBar.appendChild(w5hBtn);
      sectionEl.appendChild(headerBar);

      // If existing5W1H is available, automatically render it!
      if (existing5W1H) {
        const card = create5W1HCard(existing5W1H);
        sectionEl.appendChild(card);
      }

      // Chapter Body
      const bodyEl = document.createElement('div');
      bodyEl.className = 'chapter-body';
      renderChapterBodyFormatted(bodyEl, chapterBodyContent);
      sectionEl.appendChild(bodyEl);

      fragment.appendChild(sectionEl);
    });

    renderedContent.innerHTML = '';
    renderedContent.appendChild(fragment);
  }

  // Format Chapter Body with Subheadings & Indented Dialogue Turns
  function renderChapterBodyFormatted(container, rawMarkdown) {
    const lines = rawMarkdown.split('\n');
    let currentDialogueTurn = null;
    let currentSpeechBody = null;

    lines.forEach((line) => {
      let trimmedLine = line.trim();
      if (!trimmedLine || /^[-*_]{3,}$/.test(trimmedLine)) return;

      // 1. Subheading (### ...)
      if (trimmedLine.startsWith('###')) {
        currentDialogueTurn = null;
        currentSpeechBody = null;
        const subHead = document.createElement('div');
        subHead.className = 'sub-heading';
        const subTitleText = trimmedLine.replace(/^###\s*/, '').replace(/^[-*#\s]+/, '');
        subHead.textContent = subTitleText;
        container.appendChild(subHead);
        return;
      }

      // 2. Speaker Turn detection
      const speakerMatch = trimmedLine.match(/^\*{0,2}([\w\u4e00-\u9fa5\s]+?)\*{0,2}\s*[:：]\s*(.*)$/);

      if (speakerMatch && speakerMatch[1].length < 20) {
        const rawSpeakerName = speakerMatch[1].replace(/[*_#]/g, '').trim();
        const speechText = speakerMatch[2].trim();

        currentDialogueTurn = document.createElement('div');
        currentDialogueTurn.className = 'dialogue-turn';

        const speakerLine = document.createElement('div');
        const isQuestion = /jen|host|interviewer|问|记者/i.test(rawSpeakerName);
        speakerLine.className = `speaker-line ${isQuestion ? 'speaker-question' : 'speaker-answer'}`;
        speakerLine.textContent = `${rawSpeakerName}:`;
        currentDialogueTurn.appendChild(speakerLine);

        currentSpeechBody = document.createElement('div');
        currentSpeechBody.className = 'speech-body';

        if (speechText) {
          const p = document.createElement('p');
          p.innerHTML = parseInlineMarkdown(speechText);
          currentSpeechBody.appendChild(p);
        }

        currentDialogueTurn.appendChild(currentSpeechBody);
        container.appendChild(currentDialogueTurn);
        return;
      }

      // 3. Spoken bullet points or follow-up paragraphs under current speaker
      if (currentSpeechBody) {
        if (/^[-*•]\s+/.test(trimmedLine) || /^\d+\.\s+/.test(trimmedLine)) {
          let list = currentSpeechBody.querySelector('ul');
          if (!list) {
            list = document.createElement('ul');
            currentSpeechBody.appendChild(list);
          }
          const li = document.createElement('li');
          const cleanLiText = trimmedLine.replace(/^[-*•\d.]+\s*/, '');
          li.innerHTML = parseInlineMarkdown(cleanLiText);
          list.appendChild(li);
        } else {
          const p = document.createElement('p');
          p.innerHTML = parseInlineMarkdown(trimmedLine);
          currentSpeechBody.appendChild(p);
        }
      } else {
        const p = document.createElement('p');
        p.style.color = '#cbd5e1';
        p.innerHTML = parseInlineMarkdown(trimmedLine);
        container.appendChild(p);
      }
    });
  }

  // Safe inline markdown parser
  function parseInlineMarkdown(text) {
    if (!text) return '';
    if (window.marked && typeof window.marked.parseInline === 'function') {
      return window.marked.parseInline(text);
    }
    return escapeHtml(text)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>');
  }

  // --- 5W1H On-Demand Fetcher & Renderer with Retries & Hardened Error States ---
  async function handle5W1HClick(heading, sectionEl, w5hBtn) {
    const existingCard = sectionEl.querySelector('.card-5w1h');
    if (existingCard) {
      existingCard.remove();
      return;
    }

    if (!currentVideoId) {
      showError({
        error: '视频标识缺失，请先在顶部提交并生成总结。',
        code: 'INVALID_INPUT',
        retryable: false
      });
      return;
    }

    const normKey = normalizeHeading(heading);
    let cached = saved5W1HMap.get(heading) || saved5W1HMap.get(normKey);
    if (!cached) {
      for (const [k, v] of saved5W1HMap.entries()) {
        if (k && normKey && (k.includes(normKey) || normKey.includes(k))) {
          cached = v;
          break;
        }
      }
    }

    const bodyEl = sectionEl.querySelector('.chapter-body');

    // If already in client map, render immediately
    if (cached) {
      const card = create5W1HCard(cached);
      sectionEl.insertBefore(card, bodyEl);
      if (w5hBtn) {
        w5hBtn.classList.add('has-data');
        w5hBtn.innerHTML = '5W1H <span class="badge-saved">✓</span>';
        w5hBtn.title = '收起 / 展开该章节 5W1H 归纳 (已保存)';
      }
      return;
    }

    const loadingCard = document.createElement('div');
    loadingCard.className = 'card-5w1h';
    loadingCard.innerHTML = `
      <div class="card-5w1h-title">
        <span class="spinner-small"></span>
        <span>正在基于服务端总结提取【${escapeHtml(heading)}】的 5W1H...</span>
      </div>
    `;
    sectionEl.insertBefore(loadingCard, bodyEl);

    try {
      const res = await fetch('/api/5w1h', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': `5w1h-${Date.now().toString(36)}`
        },
        body: JSON.stringify({
          videoId: currentVideoId,
          sectionHeading: heading
        })
      });

      const resData = await res.json();

      if (!res.ok) {
        throw resData;
      }

      const val = {
        who: resData.data.who,
        what: resData.data.what,
        when: resData.data.when,
        where: resData.data.where,
        why: resData.data.why,
        how: resData.data.how
      };

      saved5W1HMap.set(normKey, val);
      saved5W1HMap.set(heading, val);

      if (w5hBtn) {
        w5hBtn.classList.add('has-data');
        w5hBtn.innerHTML = '5W1H <span class="badge-saved">✓</span>';
        w5hBtn.title = '收起 / 展开该章节 5W1H 归纳 (已保存)';
      }

      const structuredCard = create5W1HCard(val);
      loadingCard.replaceWith(structuredCard);
    } catch (errData) {
      console.error('[5W1H Request Error]:', errData);

      const errMessage = errData?.error || errData?.message || '提取 5W1H 失败，请检查网络或稍后重试。';
      const debugInfo = errData?.debug || { error: String(errData) };

      // Render persistent error card with Retry button
      const errorCard = document.createElement('div');
      errorCard.className = 'card-5w1h card-5w1h-error';
      errorCard.innerHTML = `
        <div class="card-5w1h-error-header">
          <span>⚠️</span>
          <span>${escapeHtml(errMessage)}</span>
        </div>
        <div class="card-5w1h-error-actions">
          <button type="button" class="btn-retry-inline">重试 5W1H</button>
          <button type="button" class="btn-debug-inline-toggle">查看诊断</button>
          <button type="button" class="btn-dismiss-inline">关闭</button>
        </div>
        <div class="card-5w1h-debug-details" style="display: none;">${escapeHtml(JSON.stringify(debugInfo, null, 2))}</div>
      `;

      // Bind inline retry
      errorCard.querySelector('.btn-retry-inline').addEventListener('click', () => {
        errorCard.remove();
        handle5W1HClick(heading, sectionEl, w5hBtn);
      });

      // Bind inline debug toggle
      const debugPanel = errorCard.querySelector('.card-5w1h-debug-details');
      const debugToggle = errorCard.querySelector('.btn-debug-inline-toggle');
      debugToggle.addEventListener('click', () => {
        const isHidden = debugPanel.style.display === 'none';
        debugPanel.style.display = isHidden ? 'block' : 'none';
        debugToggle.textContent = isHidden ? '收起诊断' : '查看诊断';
      });

      // Bind dismiss
      errorCard.querySelector('.btn-dismiss-inline').addEventListener('click', () => {
        errorCard.remove();
      });

      loadingCard.replaceWith(errorCard);
    }
  }

  function create5W1HCard(d) {
    const card = document.createElement('div');
    card.className = 'card-5w1h';
    card.innerHTML = `
      <div class="card-5w1h-title">
        <span>⚡ 章节 5W1H 简明归纳</span>
      </div>
      <div class="grid-5w1h">
        <div class="item-5w1h">
          <span class="tag-5w1h tag-who">WHO</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.who || '-')}</span>
        </div>
        <div class="item-5w1h">
          <span class="tag-5w1h tag-what">WHAT</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.what || '-')}</span>
        </div>
        <div class="item-5w1h">
          <span class="tag-5w1h tag-when">WHEN</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.when || '-')}</span>
        </div>
        <div class="item-5w1h">
          <span class="tag-5w1h tag-where">WHERE</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.where || '-')}</span>
        </div>
        <div class="item-5w1h">
          <span class="tag-5w1h tag-why">WHY</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.why || '-')}</span>
        </div>
        <div class="item-5w1h">
          <span class="tag-5w1h tag-how">HOW</span>
          <span class="val-5w1h">${parseInlineMarkdown(d.how || '-')}</span>
        </div>
      </div>
    `;
    return card;
  }

  // Copy Markdown
  copyMarkdownBtn.addEventListener('click', async () => {
    if (!fullAccumulatedMarkdown) return;
    try {
      await navigator.clipboard.writeText(fullAccumulatedMarkdown);
      showToast('已复制全文 Markdown 到剪贴板！');
    } catch {
      showToast('复制失败。');
    }
  });

  // Handle browser back/forward buttons
  window.addEventListener('popstate', () => {
    checkInitialRoute();
  });

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Initialize route on page load
  checkInitialRoute();
});

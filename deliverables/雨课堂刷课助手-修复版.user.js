// ==UserScript==
// @name         雨课堂刷课助手
// @namespace    http://tampermonkey.net/
// @version      3.0.6-fix13
// @description  针对雨课堂视频进行自动播放，配置AI自动答题
// @author       风之子
// @license      GPL3
// @match        *://*.yuketang.cn/*
// @match        *://*.gdufemooc.cn/*
// @run-at       document-start
// @icon         http://yuketang.cn/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      api.openai.com
// @connect      api.moonshot.cn
// @connect      api.deepseek.com
// @connect      dashscope.aliyuncs.com
// @connect      api.anthropic.com
// @connect      *
// @connect      cdn.jsdelivr.net
// @connect      unpkg.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js
// @require      https://unpkg.com/tesseract.js@v2.1.0/dist/tesseract.min.js
// ==/UserScript==

(() => {
  'use strict';

  let panel; // UI 面板实例后置初始化

  // ---- 脚本配置，用户可修改 ----
  const Config = {
    version: '3.0.6-fix12',     // 版本号
    playbackRate: 2,      // 视频播放倍速
    pptInterval: 3000,    // ppt翻页间隔
    storageKeys: {        // 使用者勿动
      progress: '[雨课堂脚本]刷课进度信息',
      ai: 'ykt_ai_conf',
      proClassCount: 'pro_lms_classCount',
      feature: 'ykt_feature_conf', // 是否开启AI作答/自动评论
      pendingAutoStart: 'ykt_pending_auto_start'
    }
  };

  const Utils = {
    // 短暂睡眠，等待网页加载
    sleep: (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms)),
    // 将一个 JSON 字符串解析为 JavaScript 对象
    safeJSONParse(value, fallback) {
      try {
        return JSON.parse(value);
      } catch (_) {
        return fallback;
      }
    },
    // 每隔一段时间检查某个条件是否满足（通过 checker 函数），如果满足就成功返回；如果超时仍未满足，就失败返回
    poll(checker, { interval = 1000, timeout = 20000 } = {}) {
      return new Promise(resolve => {
        const start = Date.now();
        const timer = setInterval(() => {
          if (checker()) {
            clearInterval(timer);
            resolve(true);
            return;
          }
          if (Date.now() - start > timeout) {
            clearInterval(timer);
            resolve(false);
          }
        }, interval);
      });
    },
    // 使用UI课程完成度来判别是否完成课程
    // 注意：98%/99% 只是"接近"，服务端要等视频真正 ended 才记完成，不能当完成
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },
    // 严格判定：只有 UI 明确显示 100% / 已完成，才算真正完成
    isProgressFullyDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('已完成');
    },
    // 取当前页面的进度文本。
    // 线上主包（web/1.2.334）里 progress-wrap 组件结构已变：百分比被放进 el-tooltip 的
    // content slot（<span class="f16 font-weight500">98</span><span class="f12">%</span>），
    // **没有 .text 类了，而且数字和 % 是两个独立元素**。
    // 原脚本写死 '.progress-wrap .text' 会取到 null -> isProgressDone 永远 false -> 卡到截止时间。
    // 这里按顺序尝试多种结构，取到第一个像样的进度文本就用。
    getProgressText() {
      const sels = [
        '.progress-wrap .text',              // 旧结构
        '.progress-wrap .f16',               // 新结构：进度数字
        '.progress-wrap .f12',               // 新结构：百分号
        '.study-progress .text',
        '.study-progress .f16',
        '.progress-wrap',
        '.study-progress',
      ];
      for (const sel of sels) {
        let el = null;
        try { el = document.querySelector(sel); } catch (e) { continue; }
        if (!el) continue;
        const t = (el.innerText || el.textContent || '').trim();
        if (/\d{1,3}\s*%/.test(t) || t.includes('已完成')) return t;
      }
      // 数字和 % 分开渲染时，把容器内所有文本按顺序拼起来再匹配
      let wrap = null;
      try { wrap = document.querySelector('.progress-wrap, .study-progress'); } catch (e) { wrap = null; }
      if (wrap) {
        let acc = '';
        const nodes = wrap.querySelectorAll('*');
        for (const n of nodes) acc += (n.textContent || '');
        const m = acc.match(/\d{1,3}\s*%/);
        if (m) return m[0];
        if (acc.includes('已完成')) return '已完成';
      }
      return '';
    },
    // 主要是规避firefox会创建多个iframe的问题
    inIframe() {
      return window.top !== window.self;
    },
    // 下滑到最底部，触发课程加载
    scrollToBottom(containerSelector) {
      const el = document.querySelector(containerSelector);
      if (el) el.scrollTop = el.scrollHeight;
    },
    getCurrentClassroomId() {
      const query = new URLSearchParams(location.search);
      const queryId = query.get('classroom_id');
      if (queryId) return queryId;

      const path = location.pathname;
      return path.match(/^\/ai-workspace\/lms-graph\/([^/]+)/)?.[1]
        || path.match(/^\/v2\/web\/studentLog\/([^/]+)/)?.[1]
        || path.match(/\/(\d+)\/studycontent$/)?.[1]
        || '';
    },
    returnUrl() { // 得到课程开始的url
      if (location.pathname.includes('/v2/web/studentLog/') || location.pathname.includes('pro/lms/')) {
        return location.href
      }
      return ""
    },
    isSupportedLearningPage() {
      const path = location.pathname;
      return path.includes('/ai-workspace/lms-graph/')
        || path.includes('/v2/web/')
        || path.includes('/pro/lms/');
    },
    waitForMountTarget(timeout = 15000) {
      const getTarget = () => document.body || document.documentElement;
      const existing = getTarget();
      if (existing) return Promise.resolve(existing);

      return new Promise(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(getTarget());
        };
        const observer = new MutationObserver(() => {
          if (getTarget()) finish();
        });
        observer.observe(document, { childList: true, subtree: true });
        document.addEventListener('DOMContentLoaded', finish, { once: true });
        window.addEventListener('load', finish, { once: true });
        const timer = setTimeout(finish, timeout);
      });
    },
    async getDDL() {
      const element = document.querySelector('video') || document.querySelector('audio');

      const fallback = 180_000;
      if (!element) return fallback;

      let duration = Number(element.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        await new Promise(resolve => element.addEventListener('loadedmetadata', resolve, { once: true }));
        duration = Number(element.duration);
      }

      const elementDurationMs = duration * 1000;               // 转为秒
      const timeout = Math.max(elementDurationMs * 3, 10_000); // 至少 10 秒（防极短视频）;
      return timeout;
    },
    // 关闭雨课堂的挂机/离开检测弹窗，避免遮罩拦截刷课流程
    dismissPopups() {
      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const style = getComputedStyle(wrapper);
        const rect = wrapper.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || rect.width === 0) continue;
        const text = wrapper.innerText || '';
        const buttons = [...wrapper.querySelectorAll('button')];
        const clickBtn = label => {
          const btn = buttons.find(b => (b.innerText || '').trim().includes(label));
          if (btn) btn.click();
        };
        if (text.includes('好好学习') || text.includes('继续观看')) {
          clickBtn('继续观看');
        } else if (text.includes('报告老师')) {
          clickBtn('取消');
        }
      }
    }
  };

  // ---- [v5] 本地答案中转站 ----
  // 本地中转站（127.0.0.1:8900）是一个 OpenAI 兼容的假服务端：
  // 脚本把题目截图发过去 -> 服务端落盘 -> 人工/Agent 读图出答案 -> 回填给脚本。
  // 命中它就不会消耗任何 API 额度。
  const LOCAL_BRIDGE_URL = 'http://127.0.0.1:8900/v1/chat/completions';
  const LOCAL_BRIDGE_HEALTH = 'http://127.0.0.1:8900/api/health';

  // 哪些失败响应值得降级到本地中转站？（余额不足 / 配额耗尽）
  const shouldFallbackToBridge = (status, text) =>
    status === 402 ||
    /insufficient_balance|insufficient balance|quota exceeded|exceeded your current quota/i.test(String(text || ''));

  // ---- 存储工具 ----
  const Store = {
    getProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {}) || { url: { outside: 0, inside: 0 } };
      if (!all[url]) {
        all[url] = { outside: 0, inside: 0 };
        localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
      }
      return { all, current: all[url] };
    },
    setProgress(url, outside, inside = 0) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      all[url] = { outside, inside };
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    removeProgress(url) {
      const raw = localStorage.getItem(Config.storageKeys.progress);
      const all = Utils.safeJSONParse(raw, {});
      delete all[url];
      localStorage.setItem(Config.storageKeys.progress, JSON.stringify(all));
    },
    getAIConf() {
      const raw = localStorage.getItem(Config.storageKeys.ai);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        url: saved.url ?? "https://api.deepseek.com/chat/completions",
        key: saved.key ?? "sk-xxxxxxx",
        model: saved.model ?? "deepseek-chat",
        apiFormat: saved.apiFormat ?? "openai", // openai 或 anthropic
        authMethod: saved.authMethod ?? "bearer", // bearer 或 x-api-key
      };
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
      return conf;
    },
    setAIConf(conf) {
      localStorage.setItem(Config.storageKeys.ai, JSON.stringify(conf));
    },
    getProClassCount() {
      const value = localStorage.getItem(Config.storageKeys.proClassCount);
      return value ? Number(value) : 1;
    },
    setProClassCount(count) {
      localStorage.setItem(Config.storageKeys.proClassCount, count);
    },
    getFeatureConf() {
      const raw = localStorage.getItem(Config.storageKeys.feature);
      const saved = Utils.safeJSONParse(raw, {}) || {};
      const conf = {
        autoAI: saved.autoAI ?? false,
        autoComment: saved.autoComment ?? false,
      };
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
      return conf;
    },
    setFeatureConf(conf) {
      localStorage.setItem(Config.storageKeys.feature, JSON.stringify(conf));
    },
    getPendingAutoStart() {
      const raw = localStorage.getItem(Config.storageKeys.pendingAutoStart);
      const saved = Utils.safeJSONParse(raw, null);
      if (!saved || !saved.classroomId || !saved.ts) return null;
      if (Date.now() - saved.ts > 30 * 60 * 1000) {
        localStorage.removeItem(Config.storageKeys.pendingAutoStart);
        return null;
      }
      return saved;
    },
    setPendingAutoStart(classroomId = '', returnUrl = '') {
      if (!classroomId) return;
      const prev = this.getPendingAutoStart() || {};
      localStorage.setItem(Config.storageKeys.pendingAutoStart, JSON.stringify({
        classroomId,
        returnUrl: returnUrl || prev.returnUrl || '',
        ts: Date.now()
      }));
    },
    clearPendingAutoStart() {
      localStorage.removeItem(Config.storageKeys.pendingAutoStart);
    },
  };

  // ---- UI 面板 ----
  function createPanel() {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '40px';
    iframe.style.left = '40px';
    iframe.style.width = '520px';
    iframe.style.height = '340px';
    iframe.style.zIndex = '999999';
    iframe.style.border = '1px solid #a3a3a3';
    iframe.style.borderRadius = '10px';
    iframe.style.background = '#fff';
    iframe.style.overflow = 'hidden';
    iframe.style.boxShadow = '6px 4px 17px 2px #000000';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('id', 'ykt-helper-iframe');
    iframe.setAttribute('allowtransparency', 'true');
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) {
      throw new Error('面板挂载点不存在');
    }
    mountTarget.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(`
                  <style>
              /* 全局重置 */
              html, body { overflow: hidden; margin: 0; padding: 0; font-family: "Segoe UI", "PingFang SC", Avenir, Helvetica, Arial, sans-serif; color: #4a4a4a; background: transparent; }

              /* 主容器 */
              .mini-basic {
                position: absolute;
                inset: 0;
                background: #3a7afe;
                color: white;
                height: 100%;
                width: 100%;
                min-height: 42px;
                min-width: 42px;
                border-radius: 10px;
                text-align: center;
                line-height: 1;
                z-index: 1000000;
                cursor: pointer;
                display: none;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0);
              }
              .mini-basic.show {
                display: flex;
              }

              /* 面板主容器 */
              .panel {
                width: 100%;
                height: 100%;
                background: white;
                border-radius: 10px;
                position: relative;
                overflow: hidden;
              }

              /* 标题栏 */
              .header {
                text-align: center;
                height: 40px;
                background: #f7f7f7;
                color: #000;
                font-size: 18px;
                line-height: 40px;
                border-radius: 10px 10px 0 0;
                border-bottom: 2px solid #eee;
                cursor: move;
                position: relative;
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 0 10px;
              }
              .tools ul {
                margin: 0;
                padding: 0;
                list-style: none;
                display: flex;
                gap: 5px;
              }
              .tools li {
                display: inline-block;
                cursor: pointer;
                font-size: 14px;
                padding: 0 5px;
              }

              /* 内容区 */
              .body {
                font-weight: normal;
                font-size: 13px;
                line-height: 22px;
                height: calc(100% - 85px);
                overflow-y: auto;
                padding: 6px 8px;
                box-sizing: border-box;
              }

              .info {
                margin: 0;
                padding: 0;
                list-style: none;
              }
              .info li {
                margin-bottom: 4px;
                color: #333;
              }

              /* 设置面板 */
              #settings {
                display: none;
                position: absolute;
                top: 40px;
                left: 0;
                width: 100%;
                height: calc(100% - 40px);
                background: white;
                z-index: 99;
                padding: 15px;
                box-sizing: border-box;
                overflow-y: auto;
              }

              /* 表单项 */
              .form-item {
                margin-bottom: 15px;
              }
              .form-item label {
                display: block;
                margin-bottom: 5px;
                font-size: 12px;
                color: #333;
              }
              .form-item input[type="text"],
              .form-item input[type="password"] {
                width: 100%;
                padding: 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 12px;
                box-sizing: border-box;
              }

              /* 复选框标签优化：避免“启用”跑到右边 */
              .form-item .checkbox-label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 12px;
                cursor: pointer;
              }
              .form-item .checkbox-label input[type="checkbox"] {
                margin: 0;
                width: auto;
              }

              /* 底部按钮栏 */
              .footer {
                position: absolute;
                bottom: 0;
                left: 0;
                width: 100%;
                background: #f7f7f7;
                color: #c5c5c5;
                font-size: 13px;
                line-height: 25px;
                border-radius: 0 0 10px 10px;
                border-bottom: 2px solid #eee;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 6px 0;
                gap: 10px;
              }
              .footer button {
                border: none;
                border-radius: 6px;
                color: white;
                cursor: pointer;
                padding: 6px 12px;
                font-size: 12px;
                transition: all 0.2s ease;
              }
              #btn-start {
                background-color: #1677ff;
              }
              #btn-start:hover {
                background-color: #f6ff00;
                color: black;
              }
              #btn-clear {
                background-color: #ff4d4f;
              }
              #btn-setting {
                background-color: #52c41a;
              }
              #btn-stop {
                background-color: #8c8c8c;
              }
              #btn-reload {
                background-color: #fa8c16;
              }

              /* 设置页底部按钮 */
              .settings-footer {
                text-align: center;
                margin-top: 12px;
                display: flex;
                justify-content: center;
                gap: 10px;
              }
              .settings-footer button {
                padding: 6px 15px;
                font-size: 12px;
                border-radius: 6px;
                border: none;
                cursor: pointer;
              }
              #save_settings {
                background-color: #1677ff;
                color: white;
              }
              #close_settings {
                background-color: #999;
                color: white;
              }
            </style>

            <div class="mini-basic" id="mini-basic">展开</div>
            <div class="panel" id="panel">
              <div class="header" id="header">
                雨课堂刷课助手
                <div class='tools'>
                  <ul>
                    <li class='minimality' id="minimality">_</li>
                    <li class='question' id="question">?</li>
                  </ul>
                </div>
              </div>
              <div class="body">
                <ul class="info" id="info">
                  <li>⭐ 脚本支持：雨课堂所有版本</li>
                  <li>🤖 <strong>支持模型：</strong>DeepSeek、Kimi(Moonshot)、通义千问、OpenAI、Claude(Anthropic)</li>
                  <li>📢 <strong>使用必读：</strong>自动答题需先点击<span style="color:green">[AI配置]</span>开启并填入API Key</li>
                  <li>🚀 配置完成后，点击<span style="color:blue">[开始刷课]</span>即可启动视频与作业挂机</li>
                  <li>🤝 脚本还有很多不足，欢迎各位一起完善代码</li>
                  <hr>
                </ul>
              </div>
              <div id="settings">
                <div class="form-item">
                  <label>API URL:</label>
                  <input type="text" id="ai_url" placeholder="https://api.deepseek.com/chat/completions">
                </div>
                <div class="form-item">
                  <label>API KEY:</label>
                  <input type="password" id="ai_key" placeholder="sk-xxxxxxxx">
                </div>
                <div class="form-item">
                  <label>Model Name:</label>
                  <input type="text" id="ai_model" placeholder="deepseek-chat">
                </div>
                <div class="form-item">
                  <label>API Format:</label>
                  <select id="ai_format" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="openai">OpenAI Format (Chat Completions)</option>
                    <option value="anthropic">Anthropic Format (Messages API)</option>
                  </select>
                </div>
                <div class="form-item">
                  <label>Auth Method:</label>
                  <select id="auth_method" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:4px;font-size:12px;">
                    <option value="bearer">Bearer Token (Authorization: Bearer)</option>
                    <option value="x-api-key">X-API-Key Header</option>
                  </select>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_ai">
                    用 AI 自动作答（作业/题目）
                  </label>
                </div>
                <div class="form-item">
                  <label class="checkbox-label">
                    <input type="checkbox" id="feature_auto_comment">
                    用批量区图文/讨论自动回复
                  </label>
                </div>
                <div class="settings-footer">
                  <button id="save_settings">保存并关闭</button>
                  <button id="close_settings">取消</button>
                </div>
              </div>
              <div class="footer">
                <button id="btn-setting">AI配置</button>
                <button id="btn-clear">清除缓存</button>
                <button id="btn-grab">📋 取题</button>
                <button id="btn-start">开始刷课</button>
                <button id="btn-stop">停止刷课</button>
                <button id="btn-reload">重新加载</button>
              </div>
            </div>
    `);
    doc.close();

    const ui = {
      iframe,
      doc,
      panel: doc.getElementById('panel'),
      header: doc.getElementById('header'),
      info: doc.getElementById('info'),
      btnStart: doc.getElementById('btn-start'),
      btnClear: doc.getElementById('btn-clear'),
      btnGrab: doc.getElementById('btn-grab'),
      btnSetting: doc.getElementById('btn-setting'),
      btnStop: doc.getElementById('btn-stop'),
      btnReload: doc.getElementById('btn-reload'),
      settings: doc.getElementById('settings'),
      saveSettings: doc.getElementById('save_settings'),
      closeSettings: doc.getElementById('close_settings'),
      aiUrlInput: doc.getElementById('ai_url'),
      aiKeyInput: doc.getElementById('ai_key'),
      aiModelInput: doc.getElementById('ai_model'),
      aiFormatSelect: doc.getElementById('ai_format'),
      authMethodSelect: doc.getElementById('auth_method'),
      featureAutoAI: doc.getElementById('feature_auto_ai'),
      featureAutoComment: doc.getElementById('feature_auto_comment'),
      minimality: doc.getElementById('minimality'),
      question: doc.getElementById('question'),
      miniBasic: doc.getElementById('mini-basic')
    };

    let isDragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    const hostWindow = window.parent || window;
    const onMove = e => {
      if (!isDragging) return;
      const deltaX = e.screenX - startX;
      const deltaY = e.screenY - startY;
      const maxLeft = Math.max(0, hostWindow.innerWidth - iframe.offsetWidth);
      const maxTop = Math.max(0, hostWindow.innerHeight - iframe.offsetHeight);
      iframe.style.left = Math.min(Math.max(0, startLeft + deltaX), maxLeft) + 'px';
      iframe.style.top = Math.min(Math.max(0, startTop + deltaY), maxTop) + 'px';
    };
    const stopDrag = () => {
      if (!isDragging) return;
      isDragging = false;
      iframe.style.transition = '';
      doc.body.style.userSelect = '';
    };
    ui.header.addEventListener('mousedown', e => {
      isDragging = true;
      startX = e.screenX;
      startY = e.screenY;
      startLeft = parseFloat(iframe.style.left) || 0;
      startTop = parseFloat(iframe.style.top) || 0;
      iframe.style.transition = 'none';
      doc.body.style.userSelect = 'none';
      e.preventDefault();
    });
    doc.addEventListener('mousemove', onMove);
    hostWindow.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('mouseup', stopDrag);
    hostWindow.addEventListener('blur', stopDrag);

    const normalSize = { width: parseFloat(iframe.style.width), height: parseFloat(iframe.style.height) };
    const miniSize = 64;
    let isMinimized = false;
    const enterMini = () => {
      if (isMinimized) return;
      isMinimized = true;
      ui.panel.style.display = 'none';
      ui.miniBasic.classList.add('show');
      iframe.style.width = miniSize + 'px';
      iframe.style.height = miniSize + 'px';
    };
    const exitMini = () => {
      if (!isMinimized) return;
      isMinimized = false;
      ui.panel.style.display = '';
      ui.miniBasic.classList.remove('show');
      iframe.style.width = normalSize.width + 'px';
      iframe.style.height = normalSize.height + 'px';
    };
    ui.minimality.addEventListener('click', enterMini);
    ui.miniBasic.addEventListener('click', exitMini);

    ui.question.addEventListener('click', () => {
      window.parent.alert('作者：niuwh.cn（重构版 by Codex）');
    });

    const log = message => {
      const li = doc.createElement('li');
      li.innerText = message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const warn = message => {
      const li = doc.createElement('li');
      li.innerText = '⚠️警告：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const error = message => {
      const li = doc.createElement('li');
      li.innerText = '🚨报错：' + message;
      ui.info.appendChild(li);
      if (ui.info.lastElementChild) ui.info.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' });
    };

    const defaultAI = { url: 'https://api.deepseek.com/chat/completions', key: 'sk-xxxxxxx', model: 'deepseek-chat', apiFormat: 'openai', authMethod: 'bearer' };
    const loadAIConf = () => {
      const saved = Store.getAIConf();
      ui.aiUrlInput.value = saved.url || defaultAI.url;
      ui.aiKeyInput.value = saved.key || defaultAI.key;
      ui.aiModelInput.value = saved.model || defaultAI.model;
      ui.aiFormatSelect.value = saved.apiFormat || defaultAI.apiFormat;
      ui.authMethodSelect.value = saved.authMethod || defaultAI.authMethod;
    };
    const loadFeatureConf = () => {
      const saved = Store.getFeatureConf();
      ui.featureAutoAI.checked = saved.autoAI;
      ui.featureAutoComment.checked = saved.autoComment;
    };
    loadAIConf();
    loadFeatureConf();
    ui.btnSetting.onclick = () => {
      loadAIConf();
      loadFeatureConf();
      ui.settings.style.display = 'block';
    };
    ui.closeSettings.onclick = () => {
      ui.settings.style.display = 'none';
    };
    ui.saveSettings.onclick = () => {
      const conf = {
        url: ui.aiUrlInput.value.trim(),
        key: ui.aiKeyInput.value.trim(),
        model: ui.aiModelInput.value.trim(),
        apiFormat: ui.aiFormatSelect.value,
        authMethod: ui.authMethodSelect.value
      };
      Store.setAIConf(conf);
      const featureConf = {
        autoAI: ui.featureAutoAI.checked,
        autoComment: ui.featureAutoComment.checked
      };
      Store.setFeatureConf(featureConf);
      ui.settings.style.display = 'none';
      log('✅ AI 配置已保存');
    };

    ui.btnClear.onclick = () => {
      Store.removeProgress(window.parent.location.href);
      localStorage.removeItem(Config.storageKeys.proClassCount);
      Store.clearPendingAutoStart();
      log('已清除当前课程的刷课进度缓存');
    };

    // 停止刷课：清除自动恢复标记后刷新页面，刷新后脚本回到空闲状态（进度缓存保留）
    ui.btnStop.onclick = () => {
      Store.clearPendingAutoStart();
      log('已停止刷课，页面即将刷新');
      window.parent.location.reload();
    };

    // 重新加载：重建自动恢复标记后刷新页面，刷新后自动恢复刷课（停止后点击同样生效）
    ui.btnReload.onclick = () => {
      Store.setPendingAutoStart(Utils.getCurrentClassroomId());
      log('正在重新加载脚本...');
      window.parent.location.reload();
    };

    // [v12] 📋 取题：把当前这一题单独送到「本地答案中转站」的待答队列，
    //        同时复制到剪贴板（可以直接粘给任何 AI）。
    //        队列是持久化的 —— AI 什么时候回，题目就什么时候被填上并提交。
    let grabbing = false;
    ui.btnGrab.onclick = async () => {
      if (grabbing) { log('正在取题，请稍候...'); return; }
      grabbing = true;
      ui.btnGrab.innerText = '取题中...';
      try {
        const q = await Solver.captureQuestion();
        if (!q || !q.ok) {
          panel.error('取题失败：' + ((q && q.error) || '未知原因'));
          return;
        }
        log('📋 题面已复制到剪贴板，并已进入待答队列');
        log('　　' + String(q.question || '').slice(0, 300));
        const ans = await Solver.waitInboxAnswer(q.key, 300000);
        if (ans) {
          log('🤖 收到答案：' + ans + '，正在填入并提交...');
          await Solver.autoSelectAndSubmit(ans, q.el);
          log('✅ 已提交');
        } else {
          log('⏳ 等待超时（题目仍留在队列里，随时可以再取一次）');
        }
      } catch (e) {
        panel.error('取题异常：' + ((e && e.message) || e));
      } finally {
        grabbing = false;
        ui.btnGrab.innerText = '📋 取题';
      }
    };

    let startHandler = null;
    let running = false;
    const invokeStart = () => {
      if (running) {
        log('已在刷课中，忽略重复启动');
        return;
      }
      running = true;
      log('启动中...');
      ui.btnStart.innerText = '刷课中...';
      startHandler && startHandler();
    };

    // 后面赋值给panel
    return {
      ...ui,
      log,
      warn,
      error,
      setStartHandler(fn) {
        startHandler = fn;
        ui.btnStart.onclick = invokeStart;
      },
      start() {
        invokeStart();
      },
      resetStartButton(text = '开始刷课') {
        ui.btnStart.innerText = text;
        if (text !== '刷课中...') running = false;
      }
    };
  }

  // ---- 播放器工具 ----
  const Player = {
    isNearEnd(media, threshold = 1) {
      if (!media) return false;
      const duration = Number(media.duration || 0);
      const currentTime = Number(media.currentTime || 0);
      return Number.isFinite(duration) && duration > 1 && currentTime > 0 && duration - currentTime <= threshold;
    },
    applySpeed() {
      const rate = Config.playbackRate;
      const speedBtn = document.querySelector('xt-speedlist xt-button') || document.getElementsByTagName('xt-speedlist')[0]?.firstElementChild?.firstElementChild;
      const speedWrap = document.getElementsByTagName('xt-speedbutton')[0];
      if (speedBtn && speedWrap) {
        speedBtn.setAttribute('data-speed', rate);
        speedBtn.setAttribute('keyt', `${rate}.00`);
        speedBtn.innerText = `${rate}.00X`;
        const mousemove = document.createEvent('MouseEvent');
        mousemove.initMouseEvent('mousemove', true, true, unsafeWindow, 0, 10, 10, 10, 10, 0, 0, 0, 0, 0, null);
        speedWrap.dispatchEvent(mousemove);
        speedBtn.click();
      } else if (document.querySelector('video')) {
        document.querySelector('video').playbackRate = rate;
      }
    },
    mute() {
      const muteBtn = document.querySelector('#video-box > div > xt-wrap > xt-controls > xt-inner > xt-volumebutton > xt-icon');
      if (muteBtn) muteBtn.click();
      const video = document.querySelector('video');
      if (video) video.volume = 0;
    },
    applyMediaDefault(media) {
      if (!media) return;
      media.play();
      media.volume = 0;
      media.playbackRate = Config.playbackRate;
    },
    observePause(video, shouldResume = () => true) {
      if (!video) return () => { };
      const canResume = () => shouldResume() && !video.ended && !this.isNearEnd(video);
      // 自动播放
      const playVideo = () => {
        if (!canResume()) return;
        video.play().catch(e => {
          if (!canResume()) return;
          console.warn('自动播放失败:', e);
          setTimeout(playVideo, 3000);
        });
      };
      playVideo();
      // 直接监听 pause 事件，不依赖播放器 UI 元素
      const onPause = () => { if (canResume()) playVideo(); };
      video.addEventListener('pause', onPause);
      // 定时兜底：防止 pause 事件被拦截（缩短到 1.5s，降低"断断续续"的卡顿感）
      const timer = setInterval(() => { if (video.paused && canResume()) playVideo(); }, 1500);
      // 标签页重新可见 / 重新获得焦点时立即续播，避免后台节流后长时间不续播
      const onVisible = () => { if (!document.hidden && canResume()) playVideo(); };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
      // 播放器 UI 观察：按钮被点击暂停时 tip 变为「播放」
      const target = document.getElementsByClassName('play-btn-tip')[0];
      let observer = null;
      if (target) {
        observer = new MutationObserver(list => {
          for (const mutation of list) {
            if (mutation.type === 'childList' && target.innerText === '播放' && canResume()) {
              video.play();
            }
          }
        });
        observer.observe(target, { childList: true });
      }
      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        if (observer) observer.disconnect();
      };
    },
    waitForEnd(media, timeout = 0) {
      return new Promise(resolve => {
        if (!media) return resolve();
        if (media.ended) return resolve();
        let timer;
        const onEnded = () => {
          clearTimeout(timer);
          resolve();
        };
        media.addEventListener('ended', onEnded, { once: true });
        if (timeout > 0) {
          timer = setTimeout(() => {
            media.removeEventListener('ended', onEnded);
            resolve();
          }, timeout);
        }
      });
    },
    // 等待「媒体真正播完」且「UI 进度确认 100%」
    // 只等 ended 事件是不够的：ended 早于服务端回写时仍会留下 98%。
    // getProgressText 取不到文本时（页面结构又变了）降级：ended + 短暂宽限即视为完成，
    // 不能干等到天荒地老。
    async waitPlaybackComplete(media, getProgressText, timeout = 600000) {
      if (!media) return false;
      const start = Date.now();
      // 1) 分段等待 ended 事件；超时仍未结束说明还在播，不能跳走
      while (!media.ended && Date.now() - start < timeout) {
        const remaining = Math.max(1000, Math.min(5000, timeout - (Date.now() - start)));
        await this.waitForEnd(media, remaining);
        if (media.ended) break;
        // 还没播完：多半是播放器被暂停了，尝试续播
        if (media.paused) {
          try { media.play(); } catch (e) { /* 忽略 */ }
        }
      }
      if (!media.ended) {
        console.warn('[雨课堂脚本] 等待视频结束超时，视频仍在播放，不予跳转');
        return false;
      }
      // 2) 等服务端把 UI 进度回写成 100%（有延迟）
      const readText = typeof getProgressText === 'function' ? getProgressText : getProgressText;
      const uiDeadline = Date.now() + 60000;
      while (Date.now() < uiDeadline) {
        const t = readText();
        if (!t) {
          // 取不到进度文本（DOM 结构可能又变了）-> 降级：ended 后再宽限 5s 就算完成
          console.warn('[雨课堂脚本] 取不到进度文本，降级为以 ended 为准');
          await Utils.sleep(5000);
          return false;
        }
        if (Utils.isProgressFullyDone(t)) return true;
        await Utils.sleep(1000);
      }
      console.warn('[雨课堂脚本] 视频已结束，但 UI 进度未回写为 100%');
      return false;
    }
  };

  // ---- ai-workspace 路由工具 ----
  const AiWorkspace = {
    normalizeText(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    },
    isVisibleElement(element) {
      if (!element || element.nodeType !== 1) return false;
      const view = element.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    },
    getRoute() {
      const match = location.pathname.match(/^\/ai-workspace\/lms-graph\/([^/]+)\/([^/]+)\/([^/?#]+)/);
      if (!match) return null;
      const [, classroomId, type, leafId] = match;
      const query = new URLSearchParams(location.search);
      return {
        classroomId,
        type,
        leafId,
        nodeId: query.get('node_id') || ''
      };
    },
    getMediaCandidates() {
      return [...document.querySelectorAll('video, audio')].filter(media => {
        if (!(media instanceof HTMLMediaElement)) return false;
        const rect = media.getBoundingClientRect();
        const isVisible = rect.width > 0 && rect.height > 0;
        return isVisible || media.tagName.toLowerCase() === 'audio';
      });
    },
    getMedia() {
      const candidates = this.getMediaCandidates();
      if (!candidates.length) return document.querySelector('video') || document.querySelector('audio');
      const score = media => {
        const rect = media.getBoundingClientRect();
        const area = rect.width * rect.height;
        const playingBoost = !media.paused && !media.ended ? 1_000_000 : 0;
        const currentBoost = Number(media.currentTime || 0);
        return playingBoost + area + currentBoost;
      };
      return [...candidates].sort((a, b) => score(b) - score(a))[0];
    },
    isPlayerDone(media, { startTime = 0, minPlayedDelta = 0 } = {}) {
      if (!media) return false;
      const currentTime = Number(media?.currentTime || 0);
      const duration = Number(media?.duration || 0);
      const playedDelta = Math.max(0, currentTime - startTime);
      if (playedDelta < minPlayedDelta) return false;
      if (media?.ended) return true;
      if (duration > 1 && currentTime > 0 && duration - currentTime <= 1) return true;
      const display = document.querySelector('.xt_video_player_current_time_display')?.innerText?.trim() || '';
      const [current, total] = display.split(' / ').map(text => text?.trim());
      return Boolean(playedDelta >= minPlayedDelta && current && total && current === total);
    },
    keepAlive(shouldResume = () => true) {
      let lastMedia = null;
      const tick = () => {
        if (!shouldResume()) return;
        const media = this.getMedia();
        if (!media) return;
        if (lastMedia !== media) {
          lastMedia = media;
          media.addEventListener('pause', tick);
        }
        media.muted = true;
        media.defaultMuted = true;
        media.volume = 0;
        media.playbackRate = Config.playbackRate;
        if (media.paused && !media.ended && !Player.isNearEnd(media)) {
          media.play().catch(() => { });
        }
      };
      const timer = setInterval(tick, 500);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      tick();
      return () => {
        clearInterval(timer);
        if (lastMedia) lastMedia.removeEventListener('pause', tick);
        document.removeEventListener('visibilitychange', tick);
        window.removeEventListener('focus', tick);
      };
    },
    getActiveLeafTitle() {
      return document.querySelector('.leaf-item.is-active')?.innerText?.replace(/\s+/g, ' ').trim() || '';
    },
    getExerciseDocument() {
      const localHasExercise = document.querySelector('#app .container-body .container-problem')
        || document.querySelector('#app .container-problem')
        || document.querySelector('.container-problem');
      if (localHasExercise) return document;

      const frames = [...document.querySelectorAll('iframe')];
      for (const frame of frames) {
        try {
          const doc = frame.contentDocument;
          if (!doc?.body) continue;
          if (
            doc.querySelector('.container-problem')
            || doc.querySelector('.subject-item')
            || doc.querySelector('.item-body')
          ) {
            return doc;
          }
        } catch (_) {
          // ignore cross-document access failures
        }
      }
      return null;
    },
    getExerciseContainer() {
      const exerciseDoc = this.getExerciseDocument();
      return exerciseDoc?.querySelector('#app .container-body .container-problem')
        || exerciseDoc?.querySelector('#app .container-problem')
        || exerciseDoc?.querySelector('.container-problem')
        || null;
    },
    getExerciseQuestionTabs(root = this.getExerciseContainer()) {
      // [v4] 线上（2026）把题目索引挪到了 .problems-aside 侧边栏，与 .container-problem 平级，
      // 原来只在 root 内找 → 永远找不到 → "共 0 题"。这里把作用域放宽到整个作业文档。
      const scope = this.getExerciseDocument() || root || document;
      if (!scope) return [];

      // [v4] 线上新结构：span.problem-item-index（题号）→ 往上找 .subject-item（可点击的索引项）
      const idxSpans = [...scope.querySelectorAll('.problem-item-index')];
      if (idxSpans.length) {
        const tabs = idxSpans
          .map((el) => (el.closest && el.closest('.subject-item')) || el)
          .filter((el, i, arr) => arr.indexOf(el) === i)
          .filter((el) => this.isVisibleElement(el));
        if (tabs.length) return tabs;
      }

      // 旧结构兜底（保留原有选择器）
      const selectors = [
        '.problems-aside .subject-item',
        '.list-inline > .subject-item',
        '.subject-item.J_order',
        '.subject-item',
        '.problem-index-item',
        '.question-index-item',
        '[class*="subject-item"]',
        '[class*="problem-index"]',
        '[class*="question-index"]'
      ].join(',');
      const all = [...scope.querySelectorAll(selectors)];
      return all.filter((el, index, arr) => {
        if (!this.isVisibleElement(el)) return false;
        if (arr.indexOf(el) !== index) return false;
        const text = this.normalizeText(el.innerText);
        return text && text.length <= 20;
      });
    },
    // [v4] 题目索引找不到时，把真实 DOM 线索打到面板日志里（免得再猜）
    diagnoseExerciseTabs(root = this.getExerciseContainer()) {
      const scope = this.getExerciseDocument() || root || document;
      if (!scope) return;
      const counts = {};
      for (const sel of ['.container-problem', '.problems-aside', '.list-inline',
        '.subject-item', '.problem-item-index', '.problem-content', '.problem-body',
        '.item-type', '.item-line', '.container-body']) {
        counts[sel] = scope.querySelectorAll(sel).length;
      }
      try {
        console.log('[诊断] 作业页元素计数', counts);
        this.panel.log('诊断: ' + JSON.stringify(counts));
        const aside = scope.querySelector('.problems-aside, .problems-aside-content');
        if (aside) {
          const cls = [...new Set([...aside.querySelectorAll('*')]
            .map((e) => String(e.className || '').split(' ')[0])
            .filter((c) => c && c.length > 2))].slice(0, 25);
          console.log('[诊断] 侧边栏类名', cls);
          this.panel.log('诊断-侧边栏类名: ' + cls.join(','));
        }
      } catch (e) { /* 忽略 */ }
    },
    getExerciseQuestionBody(root = this.getExerciseContainer()) {
      if (!root) return null;
      const itemType = root.querySelector('.item-type');
      if (itemType?.parentElement && this.isVisibleElement(itemType.parentElement)) return itemType.parentElement;
      const selectors = [
        '.item-body',
        '.problem-content',
        '.question-content',
        '.problem-main',
        '.problem-body',
        '.question-body',
        '[class*="problem-content"]',
        '[class*="question-content"]',
        '[class*="problem-body"]',
        '[class*="question-body"]'
      ];
      for (const selector of selectors) {
        const match = [...root.querySelectorAll(selector)].find(el => this.isVisibleElement(el));
        if (match) return match;
      }
      return root;
    },
    isExerciseAnswered(root = this.getExerciseContainer()) {
      if (!root) return false;
      const disabled = root.querySelector('.el-button.el-button--info.is-disabled.is-plain')
        || root.querySelector('button[disabled]');
      if (disabled) return true;
      const statusSelectors = [
        '.result',
        '.status',
        '.answer-status',
        '[class*="result"]',
        '[class*="status"]'
      ];
      for (const selector of statusSelectors) {
        const statusNode = [...root.querySelectorAll(selector)]
          .find(el => this.isVisibleElement(el) && /已完成|已作答|已提交|回答正确|回答错误/.test(this.normalizeText(el.innerText)));
        if (statusNode) return true;
      }
      return false;
    },
    getExerciseActionButton(root = this.getExerciseContainer(), pattern = /提交|保存|确认|确定|下一题|下一道|下一步|完成本题/) {
      if (!root) return null;
      const selectors = 'button, .el-button, [role="button"], [class*="button"]';
      const nodes = [
        ...root.querySelectorAll(selectors),
        ...document.querySelectorAll(selectors)
      ];
      return nodes.find(el => this.isVisibleElement(el) && pattern.test(this.normalizeText(el.innerText)));
    },
    getAllScourse() { // 获得ai-workspace的课程列表
      const list = document?.querySelectorAll(".nav-item-leaf-box")
      if (!list) panel.warn("没有发现课程资源")
      return list
    }
  };

  // ---- 防切屏 ----
  function preventScreenCheck() {
    const win = unsafeWindow;
    const blackList = new Set(['visibilitychange', 'blur', 'pagehide']);
    win._addEventListener = win.addEventListener;
    win.addEventListener = (...args) => blackList.has(args[0]) ? undefined : win._addEventListener(...args);
    document._addEventListener = document.addEventListener;
    document.addEventListener = (...args) => blackList.has(args[0]) ? undefined : document._addEventListener(...args);
    Object.defineProperties(document, {
      hidden: { value: false },
      visibilityState: { value: 'visible' },
      hasFocus: { value: () => true },
      onvisibilitychange: { get: () => undefined, set: () => { } },
      onblur: { get: () => undefined, set: () => { } }
    });
    Object.defineProperties(win, {
      onblur: { get: () => undefined, set: () => { } },
      onpagehide: { get: () => undefined, set: () => { } }
    });
  }

  // ---- OCR & AI ----
  const Solver = {
    _lastImage: '',
    // [v6] 最近一次截图对应的「加密原文 + 混淆字体信息」，随请求发给本地中转站
    _lastExtra: '',
    // [v7] 混淆字体文件（base64），只抓一次并缓存
    _fontData: '',
    _fontUrl: '',
    _fontReady: false,
    // [v11] 混淆字体还原后的明文题面（比 OCR 准）
    _decodedPlain: '',
    async grabFont(fontUrl) {
      if (this._fontData) return this._fontData;
      if (!fontUrl) return '';
      try {
        const b64 = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: fontUrl,
            responseType: 'arraybuffer',
            timeout: 20000,
            onload: (r) => {
              try {
                const bytes = new Uint8Array(r.response);
                let bin = '';
                const CH = 0x8000;
                for (let i = 0; i < bytes.length; i += CH) {
                  bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
                }
                resolve(btoa(bin));
              } catch (e) { resolve(''); }
            },
            onerror: () => resolve(''),
            ontimeout: () => resolve(''),
          });
        });
        if (b64 && b64.length > 1000) {
          this._fontData = b64;
          this._fontUrl = fontUrl;
          panel.log('✅ 已抓取混淆字体（' + Math.round(b64.length / 1024) + ' KB）');
        }
        return this._fontData;
      } catch (e) {
        return '';
      }
    },
    // [v7] 内联字体 CSS：data URL 字体 + 把加密 span 指向它
    // [v10] 优先用真实 URL（@font-face 加载跨域字体不需要 CORS），
    //        没有 URL 才用 data:URL（脚本下载后内联，完全不依赖跨域加载）。
    //        注意：font-family 的值列表里**不能**写 inherit —— 那会让整条声明失效。
    _fontFaceCss(preferDataUrl) {
      let src = '';
      if (preferDataUrl && this._fontData) {
        src = 'url(data:font/ttf;base64,' + this._fontData + ') format("truetype")';
      } else if (this._fontUrl) {
        src = 'url("' + this._fontUrl + '") format("truetype")';
      } else if (this._fontData) {
        src = 'url(data:font/ttf;base64,' + this._fontData + ') format("truetype")';
      }
      if (!src) return '';
      return '@font-face{font-family:"ykt-obf";src:' + src + ';font-weight:normal;font-style:normal;}' +
        '.xuetangx-com-encrypted-font{font-family:"ykt-obf" !important;}';
    },
    // [v7] 注入主文档并等字体就绪
    async installFont() {
      if (this._fontReady) return;
      if (!this._fontUrl && !this._fontData) return;
      try {
        const inject = (css) => {
          let st = document.getElementById('ykt-obf-font');
          if (!st) {
            st = document.createElement('style');
            st.id = 'ykt-obf-font';
            document.head.appendChild(st);
          }
          st.textContent = css;
        };
        // [v10] 关键：必须让**主文档里存在一个同源的 data:URL 字体**。
        //   html2canvas 1.4.1 在克隆文档时会遍历 document.fonts，把已加载的字体
        //   转成 base64 内联进克隆文档；跨源字体它下载不到（无 CORS 头）-> 内联失败
        //   -> 克隆文档缺 @font-face -> 字体 fallback -> 题面乱码。
        //   data:URL 字体是同源的，html2canvas 一定能拿到并内联 -> 字形正确。
        //   所以顺序是：data:URL 优先，原始 URL 只作为拿不到 fontData 时的退路。
        this._fontUseDataUrl = false;
        if (this._fontData) {
          inject(this._fontFaceCss(true));
          this._fontUseDataUrl = true;
          if (document.fonts && document.fonts.load) {
            try { await document.fonts.load('16px "ykt-obf"'); } catch (e) { /* ignore */ }
          }
          try { ok = !!(document.fonts && document.fonts.check('16px "ykt-obf"')); } catch (e) { ok = false; }
          if (!ok) this._fontUseDataUrl = false;
        }
        // 退路：URL 版（@font-face 加载跨域字体本身不需要 CORS，
        //        但 html2canvas 内联时可能失败，所以只作兜底）
        if (!ok && this._fontUrl) {
          inject(this._fontFaceCss(false));
          if (document.fonts && document.fonts.load) {
            try { await document.fonts.load('16px "ykt-obf"'); } catch (e) { /* ignore */ }
          }
          try { ok = !!(document.fonts && document.fonts.check('16px "ykt-obf"')); } catch (e) { ok = false; }
        }
        this._fontReady = ok;
        if (ok) {
          panel.log('✅ 混淆字体已注入（截图将按正确字形渲染）');
        } else {
          panel.log('⚠️ 混淆字体注入后仍未生效，题面可能显示为乱码');
        }
      } catch (e) { /* ignore */ }
    },
    // [v5] 本地答案中转站探测（结果缓存 60 秒，避免每题都探）
    _bridge: { ok: false, checked: false, ts: 0, logged: null },
    async probeLocalBridge() {
      const now = Date.now();
      if (this._bridge.checked && now - this._bridge.ts < 60000) return this._bridge;
      this._bridge.checked = true;
      this._bridge.ts = now;
      let ok = false;
      try {
        ok = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'GET',
            url: LOCAL_BRIDGE_HEALTH,
            timeout: 1500,
            onload: (r) => resolve(r.status === 200),
            onerror: () => resolve(false),
            ontimeout: () => resolve(false),
          });
        });
      } catch (e) {
        ok = false;
      }
      this._bridge.ok = ok;
      if (this._bridge.logged !== ok) {
        this._bridge.logged = ok;
        panel.log(ok
          ? '🔗 已接入本地答案中转站（不消耗 API 额度）'
          : 'ℹ️ 未检测到本地答案中转站，按 [AI配置] 中的接口请求');
      }
      return this._bridge;
    },
    // [v11] 让本地中转站用混淆字体把加密 span 还原成明文，并写回页面。
    // 还原后：1) 截图里是真字（OCR 也就准了）  2) 用户自己也能直接看到题面。
    // 中转站侧原理：加密字体是思源黑体的乱序子集，按字形轮廓哈希比对即可反查真字符。
    async decodeInPage(element, fontUrl) {
      if (!element || !fontUrl) return '';
      const bridge = await Solver.probeLocalBridge();
      if (!bridge || !bridge.ok) return '';
      const html = element.innerHTML || '';
      if (!html || html.indexOf('xuetangx-com-encrypted-font') < 0) return '';
      const out = await new Promise((resolve) => {
        try {
          GM_xmlhttpRequest({
            method: 'POST',
            url: LOCAL_BRIDGE_URL.replace(/\/v1\/chat\/completions.*$/, '') + '/api/decode',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ html: html, fontUrl: fontUrl }),
            timeout: 45000,
            onload: (r) => { try { resolve(JSON.parse(r.responseText || '{}')); } catch (e) { resolve({}); } },
            onerror: () => resolve({}),
            ontimeout: () => resolve({}),
          });
        } catch (e) { resolve({}); }
      });
      if (!out || !out.ok || !out.decoded) return '';
      try {
        const tmp = document.createElement('div');
        tmp.innerHTML = out.decoded;
        const srcSpans = Array.from(element.querySelectorAll('.xuetangx-com-encrypted-font'));
        const dstSpans = Array.from(tmp.querySelectorAll('.xuetangx-com-encrypted-font'));
        let n = 0;
        srcSpans.forEach((sp, i) => {
          const dst = dstSpans[i];
          if (!dst) return;
          sp.textContent = dst.textContent;
          sp.classList.remove('xuetangx-com-encrypted-font');
          n++;
        });
        if (n) {
          panel.log('🔓 题面已还原为明文（' + n + ' 处），截图/OCR 将读到真实汉字');
          return String(out.text || '');
        }
      } catch (e) { /* ignore */ }
      return '';
    },
    // [v11/v12/v13] 找混淆字体的 URL
    //   方式一：遍历 CSSOM（<style> 文本里看不到，但 cssRules 里能读到）
    //   方式二：兜底扫 <style> 文本
    //   方式三：[v11 关键] resource timing —— 新版前端（ai-workspace）用 new FontFace()
    //           注入字体，**根本不在 document.styleSheets 里**，CSSOM 永远扫不到；
    //           但它是一次真实网络请求，一定出现在 performance resource entries 里。
    //   [v13 关键] **题目和字体都在 iframe 里**（/v2/web/iframe-exercise/…）。
    //           v11~v12 只在顶层文档找，于是 resource timing 里根本没有考试字体，
    //           兜底逻辑「取最后一个候选」就抓到了 MathJax 字体 ->
    //           服务端用错误映射表解码 -> 题面出来还是密文。
    //           所以必须**连同源 iframe 一起找**，并且宁可返回空也不要报错字体。
    findFontUrl() {
      // 1) 收集所有可能藏字体的文档：顶层 + 同源 iframe
      const docs = [document];
      try {
        for (const frame of Array.from(document.querySelectorAll('iframe'))) {
          try {
            const d = frame.contentDocument;
            if (d && d.body) docs.push(d);
          } catch (e) { /* 跨域忽略 */ }
        }
      } catch (e) { /* ignore */ }

      const NOISE = /mathjax|\/static\/js\/|\/icons?\/|\/images?\/|icon\.|favicon|\.svg(\?|$)|blob:|data:/i;
      const WANT = /exam_font|fe_font|exam-data|font\/product|fe\/static\/font/i;
      const isFont = (u) => /\.(ttf|otf|woff2?)(\?|#|$)/i.test(u) && !NOISE.test(u);

      for (const doc of docs) {
        // 方式一：CSSOM
        try {
          for (const sheet of Array.from(doc.styleSheets || [])) {
            let rules = null;
            try { rules = sheet.cssRules; } catch (e) { continue; }  // 跨域样式表读不到，跳过
            if (!rules) continue;
            for (const rule of Array.from(rules)) {
              if (!rule || rule.type !== 5) continue;                 // 5 = CSSRule.FONT_FACE_RULE
              const ff = rule.style && rule.style.getPropertyValue('font-family');
              if (!ff || ff.indexOf('exam-data-decrypt-font') < 0) continue;
              const srcText = rule.style.getPropertyValue('src') || rule.cssText || '';
              const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(srcText);
              if (m) return m[1];
            }
          }
        } catch (e) { /* ignore */ }
        // 方式二：<style> 文本
        try {
          for (const st of Array.from(doc.querySelectorAll('style'))) {
            const css = st.textContent || '';
            if (css.indexOf('exam-data-decrypt-font') < 0) continue;
            const blocks = css.match(/@font-face\s*\{[^}]*\}/gi) || [];
            for (const b of blocks) {
              const m = /src\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(b);
              if (m) return m[1];
            }
          }
        } catch (e) { /* ignore */ }
      }

      // 方式三：resource timing（顶层 + 每个 iframe 自己的 window.performance）
      const cands = [];
      const pushCand = (u) => {
        if (typeof u !== 'string') return;
        if (!isFont(u)) return;
        if (cands.indexOf(u) < 0) cands.push(u);
      };
      for (const doc of docs) {
        try {
          const perf = (doc.defaultView && doc.defaultView.performance) || performance;
          for (const e of (perf.getEntriesByType('resource') || [])) pushCand(e && e.name);
        } catch (e) { /* ignore */ }
      }
      // 优先雨课堂的考试字体
      for (const u of cands) if (WANT.test(u)) return u;
      // 只有一个候选时可以用；多于一个就**宁可不报** —— 报错字体比不报更糟
      //（不报 -> 服务端会自己试所有本地映射表；报错 -> 解出一堆乱码）
      if (cands.length === 1) return cands[0];
      return '';
    },
    // [v12] 把当前题目的 DOM 拼成一段人话（题型 + 题干 + 选项 + 页面答案栏）
    formatQuestion(el) {
      const out = [];
      const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
      const typeEl = el.querySelector('.item-type');
      if (typeEl) out.push(clean(typeEl.innerText));
      const bodyEl = el.querySelector('.problem-body') || el.querySelector('.item-body');
      if (bodyEl) out.push(clean(bodyEl.innerText));
      for (const li of el.querySelectorAll('li')) {
        const txt = clean(li.innerText);
        if (txt) out.push(txt);
      }
      const all = el.innerText || '';
      const m = /本\s*题\s*得\s*分[^\n]{0,80}/.exec(all);
      if (m) out.push('[页面信息] ' + clean(m[0]));
      return out.join('\n');
    },
    // [v12] 取题：还原明文 -> 入队（给 Agent）-> 复制到剪贴板
    async captureQuestion() {
      let scope = document;
      try {
        const frames = [...document.querySelectorAll('iframe')];
        for (const frame of frames) {
          try {
            const d = frame.contentDocument;
            if (!d || !d.body) continue;
            if (d.querySelector('.container-problem') || d.querySelector('.subject-item') || d.querySelector('.item-body')) {
              scope = d; break;
            }
          } catch (e) { /* 跨域忽略 */ }
        }
      } catch (e) { /* ignore */ }
      const targetEl = scope.querySelector('.item-type')?.parentElement
        || scope.querySelector('.item-body')
        || scope.querySelector('.problem-content');
      if (!targetEl) return { ok: false, error: '在当前页面找不到题目元素' };

      const fontUrl = Solver.findFontUrl();
      const plain = await Solver.decodeInPage(targetEl, fontUrl);
      if (plain) Solver._decodedPlain = plain;
      const question = Solver.formatQuestion(targetEl);

      // 入队（持久化；Agent 什么时候醒什么时候答）
      let key = '';
      try {
        const r = await new Promise((resolve) => {
          GM_xmlhttpRequest({
            method: 'POST',
            url: LOCAL_BRIDGE_URL.replace(/\/v1\/chat\/completions.*$/, '') + '/api/inbox',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ html: targetEl.innerHTML || '', fontUrl, text: question }),
            timeout: 30000,
            onload: (resp) => { try { resolve(JSON.parse(resp.responseText || '{}')); } catch (e) { resolve({}); } },
            onerror: () => resolve({}),
            ontimeout: () => resolve({}),
          });
        });
        key = (r && r.key) || '';
        if (r && r.question && !plain) {
          // 服务端用字体还原出来的明文更准，优先用它
          Solver._decodedPlain = r.question;
        }
      } catch (e) { /* ignore */ }

      // 复制到剪贴板
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(question);
        } else {
          const ta = document.createElement('textarea');
          ta.value = question;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
      } catch (e) { /* ignore */ }

      return { ok: true, key, question, el: targetEl };
    },
    // [v12] 轮询待答队列，等 Agent 回答案
    async waitInboxAnswer(key, timeoutMs = 300000) {
      if (!key) return '';
      const base = LOCAL_BRIDGE_URL.replace(/\/v1\/chat\/completions.*$/, '');
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await new Promise((resolve) => {
          try {
            GM_xmlhttpRequest({
              method: 'GET',
              url: base + '/api/inbox/answer?key=' + encodeURIComponent(key),
              timeout: 10000,
              onload: (resp) => { try { resolve(JSON.parse(resp.responseText || '{}')); } catch (e) { resolve({}); } },
              onerror: () => resolve({}),
              ontimeout: () => resolve({}),
            });
          } catch (e) { resolve({}); }
        });
        if (r && r.answered && r.answer) return r.answer;
        await new Promise(res => setTimeout(res, 2000));
      }
      return '';
    },
    _canvasIsBlank(canvas) {
      try {
        const ctx = canvas.getContext('2d');
        const w = Math.min(canvas.width, 200), h = Math.min(canvas.height, 200);
        const d = ctx.getImageData(0, 0, w, h).data;
        let nonWhite = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) nonWhite++;
        }
        return nonWhite < 50;
      } catch (e) { return false; }
    },
    async recognize(element) {
      if (!element) return '无元素';
      try {
        panel.log('正在截图...');

        // [v6-1] 采集「加密原文 + 混淆字体信息」，供本地中转站建表还原题面
        try {
          const fontUrl = Solver.findFontUrl();
          let fontLoaded = null;
          try {
            fontLoaded = !!(document.fonts && document.fonts.check('16px exam-data-decrypt-font'));
          } catch (e) { /* ignore */ }
          // [v7] 直接把字体文件抓下来随请求上报，不再依赖中转站去下载
          const fontData = fontUrl ? await Solver.grabFont(fontUrl) : '';
          if (fontData) await Solver.installFont();
          Solver._lastExtra = {
            html: element.innerHTML || '',
            fontUrl: fontUrl,
            fontData: fontData,
            fontLoaded: fontLoaded,
          };
          if (fontLoaded === false) {
            panel.log('⚠️ 混淆字体未加载（题面可能是乱码），已上报原文供本地解码');
          }
          // [v11] 截图前先把加密 span 还原成明文 —— 这样截图和 OCR 读到的都是真汉字，
          //       用户屏幕上也能直接看到题目原文（不用再对着乱码猜）。
          const plain = await Solver.decodeInPage(element, fontUrl);
          if (plain) Solver._decodedPlain = plain;
        } catch (e) { Solver._lastExtra = ''; }

        // [v6-2] 等字体加载完成
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* ignore */ }

        // [v9] 渲染策略（经离线实测确定）：
        //   - 不用 foreignObjectRendering：实测它对 webfont 是反效果，会渲染出乱码
        //   - 默认渲染本身能正确呈现 webfont，前提是克隆文档里有那条 @font-face
        //   - 雨课堂的 @font-face 是 CSSOM 动态注入的（<style> 文本为空），
        //     html2canvas 复制样式时只复制文本 -> 克隆文档缺规则 -> 字体 fallback -> 乱码
        //   - 所以在 onclone 里把混淆字体以 data:URL 形式注入克隆文档（实测有效）
        const renderOpts = {
          useCORS: true,
          logging: false,
          scale: 2,
          backgroundColor: '#ffffff',
          onclone: (clonedDoc) => {
            try {
              // [v10] 克隆文档一律用 data:URL 版（_fontFaceCss 在没有 fontData 时会退回 URL 版）
              //       —— 跨域字体在克隆文档里可能因 useCORS 加载失败，data:URL 完全不依赖跨域
              const css = Solver._fontFaceCss(true);
              if (css) {
                const st = clonedDoc.createElement('style');
                st.textContent = css;
                clonedDoc.head.appendChild(st);
              }
            } catch (e) { /* ignore */ }
          },
        };
        const canvas = await html2canvas(element, renderOpts);

        // [v3] 记住题目截图，供多模态模型直接读图（绕开 OCR 误差）
        try { Solver._lastImage = canvas.toDataURL('image/png'); } catch (e) { Solver._lastImage = ''; }
        panel.log('正在 OCR 识别 (首轮较慢)...');
        const { data: { text } } = await Tesseract.recognize(canvas, 'chi_sim', {
          logger: m => {
            if (m.status === 'downloading tesseract lang') {
              console.log(`正在下载语言包 ${(m.progress * 100).toFixed(0)}%`);
            }
          }
        });
        return text.replace(/\s+/g, ' ').trim();
      } catch (err) {
        console.error('OCR error:', err);
        panel.log(`OCR 失败: ${err.message || '网络错误'}`);
        return 'OCR识别出错';
      }
    },
    async askAI(ocrText, optionCount = 0) {
      const saved = Store.getAIConf();
      let API_URL = saved.url;
      let API_KEY = saved.key;
      let MODEL_NAME = saved.model;
      let API_FORMAT = saved.apiFormat || 'openai';
      const AUTH_METHOD = saved.authMethod || 'bearer';

      // [v5] 本地答案中转站自动接入：
      //   探到 127.0.0.1:8900 就在跑 -> 自动改用它，不需要在 [AI配置] 里手动改 URL/Key/Model；
      //   探不到 -> 完全按原配置走，行为和以前一模一样。
      const bridge = await Solver.probeLocalBridge();
      let useBridge = false;
      if (bridge && bridge.ok) {
        useBridge = true;
        API_URL = LOCAL_BRIDGE_URL;
        API_KEY = 'local';
        MODEL_NAME = 'minimax-local';
        API_FORMAT = 'openai';   // 本地中转站只支持 OpenAI 格式
      }

      return new Promise((resolve, reject) => {
        if (!API_KEY || API_KEY.includes('sk-xxxx')) {
          const msg = '⚠️ 请在 [AI配置] 中填写有效的 API Key';
          panel.log(msg);
          reject(msg);
          return;
        }
        const maxChar = String.fromCharCode(65 + optionCount - 1);
        const rangeStr = optionCount ? `A-${maxChar}` : 'A-D';
        // [v11] 混淆字体还原出来的明文题面（比 OCR 准得多，能直接看出选项字母和内容）
        const plainText = String(Solver._decodedPlain || '').trim();
        const plainBlock = plainText ? `\n【已还原的明文题面（准确，优先据此判断）】\n${plainText}\n` : '';
        const prompt = `
你是专业做题助手，请分析 OCR 文本，判断题型后给出答案。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 忽略 OCR 错误的选项字母，按出现顺序映射 A/B/C/D...
3) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错
题目内容：
${ocrText}
${plainBlock}`;
        const systemPrompt = "你是一个只输出答案的助手。判断题输出'对'或'错'，选择题输出字母。";

        // 构建认证 header
        const authHeader = AUTH_METHOD === 'x-api-key'
          ? { 'x-api-key': API_KEY }
          : { 'Authorization': `Bearer ${API_KEY}` };

        if (API_FORMAT === 'anthropic' && !useBridge) {
          // Anthropic API 格式
          const headers = {
            'Content-Type': 'application/json',
            ...authHeader
          };
          // 只有原生 Anthropic API 才需要 anthropic-version，代理通常不需要
          if (API_URL.includes('api.anthropic.com')) {
            headers['anthropic-version'] = '2023-06-01';
          }
          const requestBody = {
            model: MODEL_NAME,
            max_tokens: 1024,
            system: systemPrompt,
            messages: [
              { role: 'user', content: prompt }
            ]
          };
          // 调试日志
          console.log('[AI请求] URL:', API_URL);
          console.log('[AI请求] Headers:', headers);
          console.log('[AI请求] Body:', requestBody);
          panel.log(`请求 ${API_URL}...`);
          GM_xmlhttpRequest({
            method: 'POST',
            url: API_URL,
            headers,
            data: JSON.stringify(requestBody),
            data: JSON.stringify({
              model: MODEL_NAME,
              max_tokens: 1024,
              system: systemPrompt,
              messages: [
                { role: 'user', content: prompt }
              ]
            }),
            timeout: 120000, // 120秒，思考模型需要更长响应时间
            onload: res => {
              console.log('[AI响应] Status:', res.status);
              console.log('[AI响应] Response:', res.responseText);
              if (res.status === 200) {
                try {
                  const json = JSON.parse(res.responseText);
                  // Anthropic 返回格式: content[0].text
                  const answerText = json.content?.[0]?.text || json.choices?.[0]?.message?.content;
                  resolve(answerText);
                } catch (e) {
                  reject('JSON 解析失败');
                }
              } else {
                const err = `请求失败: HTTP ${res.status} - ${res.responseText}`;
                panel.log(err);
                reject(err);
              }
            },
            onerror: () => reject('网络错误'),
            ontimeout: () => reject('请求超时')
          });
        } else {
          // OpenAI API 格式（默认）—— [v3] 支持多模态：直接把题目截图发给模型
          const isVision = /minimax/i.test(MODEL_NAME) || /minimax/i.test(API_URL);
          const imageData = isVision ? (Solver._lastImage || '') : '';
          const visionPrompt = imageData
            ? `下面是题目的截图（可能同时包含题干和选项）。请以【截图】为准读题；OCR 文本仅供参考，可能有识别错误。
强约束：
1) 本题只有 ${optionCount || '若干'} 个选项，范围 ${rangeStr}
2) 输出格式必须包含“正确答案：”前缀，例如 正确答案：A 或 正确答案：ABD 或 正确答案：对/错`
            : '';
          const buildMessages = (withImage, imgOverride) => {
            const img = imgOverride !== undefined ? imgOverride : imageData;
            if (withImage && img) {
              return [
                { role: 'system', content: systemPrompt },
                {
                  role: 'user',
                  content: [
                    { type: 'text', text: visionPrompt + (plainText ? `\n\n【已还原的明文题面（准确，优先据此判断）】\n${plainText}` : '') + '\n\n【OCR 文本（仅供参考，可能有误）】\n' + ocrText },
                    { type: 'image_url', image_url: { url: img } }
                  ]
                }
              ];
            }
            return [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt }
            ];
          };
          // MiniMax-M3 只答一个字母，没必要思考；M3.1-Flash-Preview 不支持该参数，故按模型名精确匹配
          const thinkingExtra = /^minimax-m3$/i.test(MODEL_NAME) ? { thinking: { type: 'disabled' } } : {};
          // [v5] doOpenAI 可指定目标地址/密钥/模型/图片，
          //      便于主接口余额不足时自动降级到本地答案中转站。
          const doOpenAI = (url, key, model, withImage, imgOverride, headers) => new Promise((res, rej) => {
            GM_xmlhttpRequest({
              method: 'POST',
              url,
              headers: headers || { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
              data: JSON.stringify({
                model,
                messages: buildMessages(withImage, imgOverride),
                temperature: 0.1,
                ...thinkingExtra,
                // [v6] 附带加密原文与字体信息（仅多模态请求带），供本地中转站解码乱码题面
                ...(withImage && Solver._lastExtra ? { extra: Solver._lastExtra } : {})
              }),
              timeout: 120000, // 120秒，思考模型需要更长响应时间
              onload: r2 => {
                if (r2.status === 200) {
                  try {
                    const json = JSON.parse(r2.responseText);
                    const answerText = json.choices[0].message.content;
                    res(answerText);
                  } catch (e) {
                    rej('JSON 解析失败');
                  }
                } else {
                  const err = `请求失败: HTTP ${r2.status} - ${(r2.responseText || '').slice(0, 200)}`;
                  panel.log(err);
                  // [v5] 余额不足/配额耗尽 -> 自动改投本地答案中转站重试一次（零额度消耗）
                  if (url !== LOCAL_BRIDGE_URL && shouldFallbackToBridge(r2.status, r2.responseText)) {
                    panel.log('💡 主接口额度不足，自动切换到本地答案中转站重试...');
                    doOpenAI(
                      LOCAL_BRIDGE_URL, 'local', 'minimax-local', true,
                      Solver._lastImage || '',
                      { 'Content-Type': 'application/json', 'Authorization': 'Bearer local' }
                    ).then(res).catch(rej);
                    return;
                  }
                  rej(err);
                }
              },
              onerror: () => rej('网络错误'),
              ontimeout: () => rej('请求超时')
            });
          });
          // 先试多模态；失败（模型不支持图片 / 参数不兼容）自动回退纯文本
          doOpenAI(API_URL, API_KEY, MODEL_NAME, true, undefined, authHeader).then(resolve).catch(err => {
            if (imageData) {
              console.warn('[AI] 多模态请求失败，回退纯文本：', err);
              panel.log('多模态请求失败，改用纯文本重试');
              doOpenAI(API_URL, API_KEY, MODEL_NAME, false, undefined, authHeader).then(resolve).catch(reject);
            } else {
              reject(err);
            }
          });
        }
      });
    },
    async autoSelectAndSubmit(aiResponse, itemBodyElement) {
      // [v3] 剥掉思考标签，并取【最后一个】"答案"匹配（思考内容里也可能出现"答案"字样）
      const cleaned = String(aiResponse || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
      const reAns = /(?:正确)?答案[：:]?\s*([A-F]+(?:[,，][A-F]+)*|[对错]|正确|错误)/gi;
      let m2 = null, lastM = null;
      while ((m2 = reAns.exec(cleaned)) !== null) { lastM = m2; }
      const match = lastM;
      if (!match) {
        panel.log('⚠️ 未提取到有效选项，请人工检查');
        return;
      }
      let answerRaw = match[1].replace(/[,，]/g, '').trim();
      const map = { 'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5 };
      let targetIndices = [];
      if (answerRaw === '对' || answerRaw === '正确') {
        targetIndices = [0];
      } else if (answerRaw === '错' || answerRaw === '错误') {
        targetIndices = [1];
      } else {
        for (const char of answerRaw.toUpperCase()) {
          if (map[char] !== undefined) targetIndices.push(map[char]);
        }
      }
      if (!targetIndices.length) return;
      panel.log(`✅ AI 建议选：${answerRaw}`);

      const listContainer = itemBodyElement.querySelector('.list-inline.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled.list-unstyled-radio') ||
        itemBodyElement.querySelector('.list-unstyled') ||
        itemBodyElement.querySelector('ul.list') ||
        itemBodyElement.querySelector('[class*="option-list"]') ||
        itemBodyElement.querySelector('[class*="answer-list"]') ||
        itemBodyElement.querySelector('ul') ||
        itemBodyElement.querySelector('[role="radiogroup"]');
      if (!listContainer) {
        panel.log('⚠️ 未找到选项容器');
        return;
      }
      const options = listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]');
      for (const idx of targetIndices) {
        if (!options[idx]) continue;
        const clickable = options[idx].querySelector('label.el-radio') ||
          options[idx].querySelector('label.el-checkbox') ||
          options[idx].querySelector('.el-radio__label') ||
          options[idx].querySelector('.el-checkbox__label') ||
          options[idx].querySelector('[role="radio"]') ||
          options[idx].querySelector('[role="checkbox"]') ||
          options[idx].querySelector('input') ||
          options[idx];
        clickable.click();
        await Utils.sleep(150);
      }
      const submitBtn = (() => {
        const ownerDocument = itemBodyElement.ownerDocument || document;
        const roots = [itemBodyElement.parentElement, itemBodyElement, ownerDocument].filter(Boolean);
        const matchText = text => /提交|保存|确认|确定|提交答案/.test(text);
        for (const root of roots) {
          const local = root.querySelectorAll('button, .el-button, [role="button"]');
          for (const btn of local) {
            if (btn.offsetParent !== null && matchText(btn.innerText || '')) return btn;
          }
        }
        const global = ownerDocument.querySelectorAll('.el-button.el-button--primary.el-button--medium');
        for (const btn of global) {
          if (matchText(btn.innerText || '') && btn.offsetParent !== null) return btn;
        }
        return null;
      })();
      if (submitBtn) {
        panel.log('正在提交...');
        submitBtn.click();
      } else {
        panel.log('⚠️ 未找到提交按钮，请手动提交');
      }
    }
  };

  // ---- v2 逻辑 ----
  class V2Runner {
    constructor(panel) {
      this.panel = panel;
      this.baseUrl = location.href;
      const { current } = Store.getProgress(this.baseUrl);
      this.outside = current.outside;
      this.inside = current.inside;
      this.shouldStop = false;
    }

    updateProgress(outside, inside = 0) {
      this.outside = outside;
      this.inside = inside;
      Store.setProgress(this.baseUrl, outside, inside);
    }

    async waitForExternalHandoff(timeout = 1200) {
      await Utils.sleep(timeout);
      if (document.visibilityState === 'hidden' || !document.hasFocus()) {
        this.shouldStop = true;
        this.panel.log('已交给新页面继续，返回目录页后会自动续跑');
        return true;
      }
      return false;
    }

    checkCompletionStatus(statusBox, statusText) {
      // 1. 检查明确的完成状态文本
      if (statusText.includes('已完成') || statusText.includes('已读')) {
        return true;
      }

      // 2. 检查明确的未完成状态文本
      if (statusText.includes('未开始') || statusText.includes('未读') || statusText.includes('进行中')) {
        return false;
      }

      // 3. 检查学习进度数字比例
      const progressMatch = statusText.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const [, current, total] = progressMatch;
        const currentNum = parseInt(current, 10);
        const totalNum = parseInt(total, 10);

        // 根据数字进度判断：相等且大于0表示已完成
        return currentNum === totalNum && totalNum > 0;
      }

      // 默认返回false（未完成）
      return false;
    }

    async run() {
      this.panel.log(`检测到已播放到第 ${this.outside} 集，继续刷课...`);
      // 在课件页恢复时直接续播当前内容，不重新走列表流程
      if (location.pathname.includes('/studentCards/')) {
        const videoBox = document.querySelector('.video-box');
        const boxText = videoBox?.innerText || '';
        if ((videoBox || document.querySelector('video')) && !boxText.includes('已完成')) {
          this.panel.log('检测到当前课件页，直接续播当前内容');
          await this.waitCoursewareVideo();
          history.back();
          await Utils.sleep(1000);
        }
      }
      while (true) {
        await this.autoSlide();
        const list = document.querySelector('.logs-list')?.childNodes;
        if (!list || !list.length) {
          // 可能停留在课件页：跳回目录页继续，避免无限重试
          const pending = Store.getPendingAutoStart();
          const returnUrl = pending?.returnUrl
            || (pending?.classroomId ? `/v2/web/studentLog/${pending.classroomId}` : '');
          if (returnUrl && !location.pathname.includes('/studentLog/')) {
            this.panel.log('当前页面无课程列表，返回目录页继续');
            location.href = returnUrl;
            return;
          }
          this.panel.log('未找到课程列表，稍后重试');
          await Utils.sleep(2000);
          continue;
        }
        console.log(`当前集数:${this.outside}/全部集数${list.length}`);
        if (this.outside >= list.length) {
          this.panel.log('课程刷完啦 🎉');
          this.panel.resetStartButton('刷完啦~');
          Store.removeProgress(this.baseUrl);
          Store.clearPendingAutoStart();
          break;
        }
        const course = list[this.outside]?.querySelector('.content-box')?.querySelector('section');
        if (!course) {
          this.panel.log('未找到当前课程节点，跳过');
          this.updateProgress(this.outside + 1, 0);
          continue;
        }
        const type = course.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || 'piliang';
        const title = course.querySelector('h2')?.innerText?.trim() || `第${this.outside + 1}项`;

        // 预检查完成状态
        const statusBox = course.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';

        // 判断是否已完成
        let isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          this.updateProgress(this.outside + 1, 0);
          continue;
        }

        this.panel.log(`刷课状态：第 ${this.outside + 1}/${list.length} 个，类型 ${type}，标题：${title}`);
        if (type.includes('shipin')) {
          await this.handleVideo(course);
        } else if (type.includes('piliang')) {
          await this.handleBatch(course, list);
        } else if (type.includes('ketang')) {
          await this.handleClassroom(course);
        } else if (type.includes('kejian')) {
          await this.handleCourseware(course);
        } else if (type.includes('kaoshi')) {
          this.panel.log('考试区域脚本会被屏蔽，已跳过');
          this.updateProgress(this.outside + 1, 0);
        } else {
          this.panel.log('非视频/批量/课件/考试，已跳过');
          this.updateProgress(this.outside + 1, 0);
        }
        if (this.shouldStop) return;
      }
    }

    async autoSlide() {
      const frequency = Math.floor((this.outside + 1) / 20) + 1;
      for (let i = 0; i < frequency; i++) {
        Utils.scrollToBottom('.viewContainer');
        await Utils.sleep(800);
      }
    }

    async handleVideo(course) {
      course.click();
      if (await this.waitForExternalHandoff(1500)) return;
      await Utils.sleep(3000);
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      const title = document.querySelector('.title')?.innerText || '视频';
      const isDeadline = document.querySelector('.box')?.innerText.includes('已过考核截止时间');
      if (isDeadline) this.panel.log(`${title} 已过截止，进度不再增加，将直接跳过`);
      Player.applySpeed();
      Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 5000, timeout: await Utils.getDDL() });
      // 关键修复：98%/99% 不代表真播完，必须等视频真正 ended 再跳下一节
      if (!isDeadline && video) {
        await Player.waitPlaybackComplete(video, () => Utils.getProgressText());
      }
      stopObserve();
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1200);
    }

    async handleBatch(course, list) {
      const expandBtn = course.querySelector('.sub-info')?.querySelector('.gray')?.querySelector('span');
      if (!expandBtn) {
        this.panel.log('未找到批量展开按钮，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      expandBtn.click();
      await Utils.sleep(1200);
      const activities = list[this.outside]?.querySelector('.leaf_list__wrap')?.querySelectorAll('.activity__wrap') || [];
      let idx = this.inside;
      this.panel.log(`进入批量区，内部进度 ${idx}/${activities.length}`);
      while (idx < activities.length) {
        const item = activities[idx];
        if (!item) break;

        const tagText = item.querySelector('.tag')?.innerText || '';
        const tagHref = item.querySelector('.tag')?.querySelector('use')?.getAttribute('xlink:href') || '';
        const title = item.querySelector('h2')?.innerText || `第${idx + 1}项`;

        // 检查当前项目的完成状态
        const statusBox = item.querySelector('.statistics-box .aside');
        const statusText = statusBox?.innerText || '';
        const isCompleted = this.checkCompletionStatus(statusBox, statusText);

        if (isCompleted) {
          this.panel.log(`✅ ${title} 已完成，跳过`);
          idx++;
          this.updateProgress(this.outside, idx);
          continue;
        }

        if (tagText === '音频') {
          idx = await this.playAudioItem(item, title, idx);
        } else if (tagHref.includes('shipin')) {
          idx = await this.playVideoItem(item, title, idx);
        } else if (tagHref.includes('tuwen') || tagHref.includes('taolun')) {
          idx = await this.autoCommentItem(item, tagHref.includes('tuwen') ? '图文' : '讨论', idx);
        } else if (tagHref.includes('zuoye')) {
          idx = await this.handleHomework(item, idx);
        } else {
          this.panel.log(`类型未知，已跳过：${title}`);
          idx++;
          this.updateProgress(this.outside, idx);
        }
        if (this.shouldStop) return;
      }
      this.updateProgress(this.outside + 1, 0);
      await Utils.sleep(1000);
    }

    async playAudioItem(item, title, idx) {
      this.panel.log(`开始播放音频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      const audio = document.querySelector('audio');
      Player.applyMediaDefault(audio);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 3000, timeout: await Utils.getDDL() });
      // 音频同样要等真正播完，否则进度记不满
      if (audio) {
        await Player.waitPlaybackComplete(audio, () => Utils.getProgressText());
      }
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async playVideoItem(item, title, idx) {
      this.panel.log(`开始播放视频：${title}`);
      item.click();
      if (await this.waitForExternalHandoff()) return idx;
      await Utils.sleep(2500);
      Player.applySpeed();
      Player.mute();
      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 3000, timeout: await Utils.getDDL() });
      // 关键修复：进度到 98% 不代表播完，必须等视频真正 ended 再跳下一集
      if (video) {
        await Player.waitPlaybackComplete(video, () => Utils.getProgressText());
      }
      stopObserve();
      this.panel.log(`${title} 播放完成`);
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1500);
      return idx;
    }

    async autoCommentItem(item, typeText, idx) {
      this.panel.log(`开始处理${typeText}：${item.querySelector('h2')?.innerText || ''}`);
      item.click();
      await Utils.sleep(1200);

      // 检查是否开启自动评论功能
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoComment) {
        this.panel.log(`${typeText}已查看，但未开启自动回复功能`);
        idx++;
        this.updateProgress(this.outside, idx);
        history.back();
        await Utils.sleep(1000);
        return idx;
      }

      // 开启了自动评论功能，执行评论逻辑
      window.scrollTo(0, document.body.scrollHeight);
      await Utils.sleep(800);
      window.scrollTo(0, 0);
      // [v4] 旧类名（new_discuss / cont_detail）在 2026 版线上已完全消失，补一批候选
      const commentSelectors = [
        '#new_discuss .new_discuss_list .cont_detail',
        '.new_discuss_list dd .cont_detail',
        '.cont_detail.word-break',
        '.word-break',
        '.topic_describe',
        '.discuss-item .content',
        '.discuss-content',
        '.post-content',
        '.reply-content',
        '[class*="comment-content"]',
        '[class*="discuss-content"]',
        '[class*="reply-content"]',
        '[class*="post-content"]'
      ];
      let firstComment = '';
      for (let retry = 0; retry < 30 && !firstComment; retry++) {
        for (const sel of commentSelectors) {
          const list = document.querySelectorAll(sel);
          for (const node of list) {
            if (node?.innerText?.trim()) {
              firstComment = node.innerText.trim();
              break;
            }
          }
          if (firstComment) break;
        }
        if (!firstComment) await Utils.sleep(500);
      }
      if (!firstComment) {
        this.panel.log('未找到评论内容，跳过该项');
        // [v4] 诊断：把当前页可能的评论/讨论容器打出来，避免盲猜
        try {
          const cands = {};
          for (const sel of ['.cont_detail', '.word-break', '.topic_describe',
            '[class*="comment"]', '[class*="discuss"]', '[class*="reply"]', '[class*="post"]',
            '.el-textarea__inner', 'textarea']) {
            const n = document.querySelectorAll(sel).length;
            if (n) cands[sel] = n;
          }
          console.log('[诊断] 讨论页候选', cands);
          this.panel.log('诊断: ' + JSON.stringify(cands));
        } catch (e) { /* 忽略 */ }
      } else {
        const input = document.querySelector('.el-textarea__inner');
        if (input) {
          input.value = firstComment;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await Utils.sleep(800);
          const sendBtn = document.querySelector('.el-button.submitComment') ||
            document.querySelector('.publish_discuss .postBtn button') ||
            document.querySelector('.el-button--primary');
          if (sendBtn && !sendBtn.disabled && !sendBtn.classList.contains('is-disabled')) {
            sendBtn.click();
            this.panel.log(`已在${typeText}区发表评论`);
          } else {
            this.panel.log('发送按钮不可用或不存在');
          }
        } else {
          this.panel.log('未找到评论输入框，跳过');
        }
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1000);
      return idx;
    }

    async handleHomework(item, idx) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭AI自动答题，跳过该项');
        idx++;
        this.updateProgress(this.outside, idx);
        return idx;
      }
      this.panel.log('进入作业，启动 OCR + AI');
      item.click();
      await Utils.sleep(1500);
      let i = 0;
      const maxRetry = 3; // 最大重试次数
      while (true) {
        const items = document.querySelectorAll('.subject-item.J_order');
        if (i >= items.length) {
          this.panel.log(`所有题目处理完毕，共 ${items.length} 题，准备交卷`);
          break;
        }
        const listItem = items[i];
        listItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
        listItem.click();
        await Utils.sleep(1800);
        const disabled = document.querySelectorAll('.el-button.el-button--info.is-disabled.is-plain');
        if (disabled.length > 0) {
          this.panel.log(`第 ${i + 1} 题已完成，跳过...`);
          i++;
          continue;
        }
        const targetEl = document.querySelector('.item-type')?.parentElement || document.querySelector('.item-body');
        let optionCount = 0;
        const listContainer = targetEl?.querySelector('.list-inline.list-unstyled-radio') ||
          targetEl?.querySelector('.list-unstyled.list-unstyled-radio') ||
          targetEl?.querySelector('ul.list');
        if (listContainer) optionCount = listContainer.querySelectorAll('li').length;
        const ocrResult = await Solver.recognize(targetEl);
        if (ocrResult && ocrResult.length > 5) {
          let retryCount = 0;
          let success = false;
          while (retryCount < maxRetry && !success) {
            try {
              if (retryCount > 0) {
                this.panel.log(`🔄 第 ${i + 1} 题重试 ${retryCount}/${maxRetry}...`);
              }
              panel.log('🤖 请求 AI 获取答案...');
              const aiText = await Solver.askAI(ocrResult, optionCount);
              await Solver.autoSelectAndSubmit(aiText, targetEl);
              success = true;
            } catch (err) {
              retryCount++;
              this.panel.log(`AI 答题失败：${err}`);
              if (retryCount < maxRetry) {
                this.panel.log(`等待 5 秒后重试...`);
                await Utils.sleep(5000);
              } else {
                this.panel.log(`⚠️ 第 ${i + 1} 题重试 ${maxRetry} 次后仍失败，跳过`);
              }
            }
          }
        }
        await Utils.sleep(1500);
        i++;
      }
      idx++;
      this.updateProgress(this.outside, idx);
      history.back();
      await Utils.sleep(1200);
      return idx;
    }

    async handleClassroom(course) {
      this.panel.log('进入课堂模式...');
      course.click();
      await Utils.sleep(5000);
      const iframe = document.querySelector('iframe.lesson-report-mobile');
      if (!iframe || !iframe.contentDocument) {
        this.panel.log('未找到课堂 iframe，跳过');
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      const video = iframe.contentDocument.querySelector('video');
      const audio = iframe.contentDocument.querySelector('audio');
      if (video) {
        Player.applyMediaDefault(video);
        await Player.waitForEnd(video);
      }
      if (audio) {
        Player.applyMediaDefault(audio);
        await Player.waitForEnd(audio);
      }
      this.updateProgress(this.outside + 1, 0);
      history.go(-1);
      await Utils.sleep(1200);
    }

    // 等待课件视频播放完毕；播放器被关闭（弹窗关闭/元素销毁）时自动重新打开
    async waitCoursewareVideo() {
      const deadline = await Utils.getDDL();
      const start = Date.now();
      let boundVideo = null;
      let stopObserve = () => { };
      let reopenAttempts = 0;
      try {
        while (Date.now() - start < deadline) {
          Utils.dismissPopups();
          const video = document.querySelector('video');
          const display = document.querySelector('.xt_video_player_current_time_display');
          if (!video) {
            // 播放器被关闭或视频元素被销毁，重新打开视频框
            const videoBox = document.querySelector('.video-box');
            if (videoBox && !videoBox.innerText.includes('已完成')) {
              this.panel.log('播放器被关闭，正在重新打开');
              videoBox.click();
              boundVideo = null;
            }
            reopenAttempts++;
            if (reopenAttempts >= 4) {
              this.panel.log('播放器恢复失败，刷新页面重试');
              location.reload();
              return false;
            }
            await Utils.sleep(2000);
            continue;
          }
          reopenAttempts = 0;
          if (!display) {
            // 播放器加载中，等待渲染
            await Utils.sleep(800);
            continue;
          }
          if (video !== boundVideo) {
            stopObserve();
            Player.applySpeed();
            Player.mute();
            boundVideo = video;
            stopObserve = Player.observePause(video);
          }
          const times = display.innerText || '';
          const [nowTime, totalTime] = times.split(' / ');
          if (nowTime && totalTime && nowTime === totalTime) return true;
          await Utils.sleep(800);
        }
        return false;
      } finally {
        stopObserve();
      }
    }

    async handleCourseware(course) {
      const tableData = course.parentNode?.parentNode?.parentNode?.__vue__?.tableData;
      const deadlinePassed = (tableData?.deadline || tableData?.end) ? (tableData.deadline < Date.now() || tableData.end < Date.now()) : false;
      if (deadlinePassed) {
        this.panel.log(`${course.querySelector('h2')?.innerText || '课件'} 已结课，跳过`);
        this.updateProgress(this.outside + 1, 0);
        return;
      }
      course.click();
      await Utils.sleep(3000);

      // 检测"查看课件"按钮（课件概况页专用）
      const checkBtn = document.querySelector('.ppt_img_box .check') || document.querySelector('p.check');
      if (checkBtn && checkBtn.innerText?.trim() === '查看课件') {
        this.panel.log('检测到"查看课件"按钮，正在点击...');
        checkBtn.click();
        await Utils.sleep(2000);
      }
      const classType = document.querySelector('.el-card__header')?.innerText || '';
      const className = document.querySelector('.dialog-header')?.firstElementChild?.innerText || '课件';
      if (classType.includes('PPT')) {
        const slides = document.querySelector('.swiper-wrapper')?.children || [];
        this.panel.log(`开始播放 PPT：${className}`);
        for (let i = 0; i < slides.length; i++) {
          slides[i].click();
          this.panel.log(`${className}：第 ${i + 1} 张`);
          await Utils.sleep(Config.pptInterval);
        }
        await Utils.sleep(Config.pptInterval);
        const videoBoxes = document.querySelectorAll('.video-box');
        if (videoBoxes?.length) {
          this.panel.log('PPT 中有视频，继续播放');
          for (let i = 0; i < videoBoxes.length; i++) {
            if (videoBoxes[i].innerText === '已完成') {
              this.panel.log(`第 ${i + 1} 个视频已完成，跳过`);
              continue;
            }
            videoBoxes[i].click();
            await Utils.sleep(2000);
            await this.waitCoursewareVideo();
          }
        }
        this.panel.log(`${className} 已播放完毕`);
      } else {
        const videoBox = document.querySelector('.video-box');
        if (videoBox) {
          videoBox.click();
          await Utils.sleep(1800);
          await this.waitCoursewareVideo();
          this.panel.log(`${className} 视频播放完毕`);
        }
      }
      this.updateProgress(this.outside + 1, 0);
      history.back();
      await Utils.sleep(1000);
    }
  }

  // ---- pro/lms 旧版（仅做转发） ----
  class ProOldRunner {
    constructor(panel) {
      this.panel = panel;
    }
    run() {
      this.panel.log('准备打开新标签页...');
      const leafDetail = document.querySelectorAll('.leaf-detail');
      let classCount = Store.getProClassCount() - 1;
      while (leafDetail[classCount] && !leafDetail[classCount].firstChild.querySelector('i').className.includes('shipin')) {
        classCount++;
        Store.setProClassCount(classCount + 1);
        this.panel.log('课程不属于视频，已跳过');
      }
      leafDetail[classCount]?.click();
    }
  }

  // ---- pro/lms 新版（主要逻辑） ----
  class ProNewRunner {
    constructor(panel) {
      this.panel = panel;
    }
    async run() {
      preventScreenCheck();
      let classCount = Store.getProClassCount();
      while (true) {
        this.panel.log(`准备播放第 ${classCount} 集...`);
        await Utils.sleep(2000);
        const className = document.querySelector('.header-bar')?.firstElementChild?.innerText || '';
        const classType = document.querySelector('.header-bar')?.firstElementChild?.firstElementChild?.getAttribute('class') || '';
        const classStatus = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
        if (classType.includes('tuwen') && !classStatus.includes('已读')) {
          this.panel.log(`正在阅读：${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('taolun')) {
          this.panel.log(`讨论区暂不自动发帖，${className}`);
          await Utils.sleep(2000);
        } else if (classType.includes('shipin') && !classStatus.includes('100%')) {
          this.panel.log(`2s 后开始播放：${className}`);
          await Utils.sleep(2000);
          let statusTimer;
          let videoTimer;
          try {
            statusTimer = setInterval(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              if (status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成')) {
                this.panel.log(`${className} 播放完毕`);
                clearInterval(statusTimer);
                statusTimer = null;
              }
            }, 200);

            const videoWaitStart = Date.now();
            videoTimer = setInterval(() => {
              const video = document.querySelector('video');
              if (video) {
                setTimeout(() => {
                  Player.applySpeed();
                  Player.mute();
                  Player.observePause(video);
                }, 2000);
                clearInterval(videoTimer);
                videoTimer = null;
              } else if (Date.now() - videoWaitStart > 20000) {
                location.reload();
              }
            }, 5000);

            await Utils.sleep(8000);
            await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成');
            }, { interval: 1000, timeout: await Utils.getDDL() });
            // 关键修复：进度到 98% 不代表播完，必须等视频真正 ended，否则服务端记不满 100%
            const videoEl = document.querySelector('video');
            if (videoEl) {
              await Player.waitPlaybackComplete(videoEl, () => Utils.getProgressText());
            }
          } finally {
            if (statusTimer) clearInterval(statusTimer);
            if (videoTimer) clearInterval(videoTimer);
          }
        } else if (classType.includes('zuoye')) {
          this.panel.log(`进入作业：${className}（暂无自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('kaoshi')) {
          this.panel.log(`进入考试：${className}（不会自动答题）`);
          await Utils.sleep(2000);
        } else if (classType.includes('ketang')) {
          this.panel.log(`进入课堂：${className}（暂无自动功能）`);
          await Utils.sleep(2000);
        } else {
          this.panel.log(`已看过：${className}`);
          await Utils.sleep(2000);
        }
        this.panel.log(`第 ${classCount} 集播放完毕`);
        classCount++;
        Store.setProClassCount(classCount);
        const nextBtn = document.querySelector('.btn-next');
        if (nextBtn) {
          const event1 = new Event('mousemove', { bubbles: true });
          event1.clientX = 9999;
          event1.clientY = 9999;
          nextBtn.dispatchEvent(event1);
          nextBtn.dispatchEvent(new Event('click'));
        } else {
          localStorage.removeItem(Config.storageKeys.proClassCount);
          this.panel.log('课程播放完毕 🎉');
          Store.clearPendingAutoStart();
          this.panel.resetStartButton('开始刷课');
          break;
        }
      }
    }
  }

  // ---- ai-workspace 新版学习空间 ----
  class AiWorkspaceRunner {
    constructor(panel) {
      this.panel = panel;
    }

    getExerciseQuestionLabel(root) {
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      const active = tabs.find(tab => /active|current|selected|is-active/.test(tab.className));
      return AiWorkspace.normalizeText(active?.innerText || '');
    }

    // 获取要跳转回去的目标地址
    getReturnUrl() {
      const pending = Store.getPendingAutoStart();
      const route = AiWorkspace.getRoute();
      if (!pending || !route) return '';
      if (pending.classroomId !== route.classroomId) return '';
      console.log(`returnUrl:${pending.returnUrl}`)
      return pending.returnUrl || '';
    }

    async autoSelect() {
      // 进入ai - workspace的方式有两种：可以处理两种不同的逻辑，增加兼容性
      const returnUrl = this.getReturnUrl()
      // 1. 从传统的 v2 - pro / lms 的目录新开标签页进入（开始刷课）的
      if (returnUrl) {
        await this.returnToSource(returnUrl)
      } else {
        // 2. 直接从ai - workspac页面进入（开始刷课）的
        this.panel.log("检测到是从ai - workspac页面点击开始刷课");
        this.source = AiWorkspace.getAllScourse(); // 得到课程列表
        this.activateIndex = Array.from(this.source).findIndex(el => el.firstChild.classList.contains("is-active")) // 现在正在刷第几个（从0开始）
        await this.handleNext(this.activateIndex + 1)
      }
    }

    // 获取父窗口对象 window.opener
    getSourceWindow() {
      try {
        if (!window.opener || window.opener.closed) return null;
        if (window.opener.location.origin !== location.origin) return null;
        return window.opener;
      } catch (_) {
        return null;
      }
    }

    async returnToSource(returnUrl) {
      this.panel.log('媒体播放完成，返回课程目录页继续匹配');
      await Utils.sleep(1200);
      const sourceWindow = this.getSourceWindow();
      console.log(sourceWindow);
      if (sourceWindow) {
        try {
          sourceWindow.location.href = returnUrl;
          sourceWindow.focus();
          window.close();
          return true;
        } catch (e) {
          console.error("跳转父窗口异常", e);
        }
      }
      // if (location.href !== returnUrl) {
      //   location.href = returnUrl;
      // } else {
      //   history.back();
      // }
      // return true;
    }

    async handleMedia(route) {
      const title = AiWorkspace.getActiveLeafTitle() || `${route.type} ${route.leafId}`;
      this.panel.log(`开始播放：${title}`);
      const ready = await Utils.poll(() => Boolean(AiWorkspace.getMedia()), { interval: 500, timeout: 20000 });
      let media = AiWorkspace.getMedia();
      if (!ready || !media) {
        this.panel.log('未找到视频/音频元素，停止当前轮次');
        return false;
      }

      const playbackState = { completed: false };
      const shouldResume = () => !playbackState.completed;
      let stopObserve = () => { };
      if (media.tagName.toLowerCase() === 'video') {
        Player.applySpeed();
        Player.mute();
        stopObserve = Player.observePause(media, shouldResume);
      } else {
        Player.applyMediaDefault(media);
      }
      const stopKeepAlive = AiWorkspace.keepAlive(shouldResume);
      this.panel.log(`已接管播放器：${media.tagName.toLowerCase()}，目标倍速 ${Config.playbackRate}x，静音开启`);
      try {
        let startTime = Number(media.currentTime || 0);
        const started = await Utils.poll(() => {
          const currentMedia = AiWorkspace.getMedia();
          if (currentMedia) media = currentMedia;
          if (!media) return false;
          const currentTime = Number(media.currentTime || 0);
          return currentTime > startTime + 0.5 || (!media.paused && media.readyState >= 2 && currentTime > startTime + 0.2);
        }, { interval: 500, timeout: 15000 });
        if (!started) {
          this.panel.log('未确认到视频实际开始播放，停止当前轮次');
          return false;
        }
        startTime = Number(media.currentTime || 0);

        let resolveEnded;
        const endedPromise = new Promise(resolve => {
          resolveEnded = resolve;
        });
        const onEnded = () => {
          playbackState.completed = true;
          resolveEnded(true);
        };
        media.addEventListener('ended', onEnded);
        const done = await Promise.race([
          endedPromise,
          Utils.poll(() => {
            if (playbackState.completed) return true;
            const currentMedia = AiWorkspace.getMedia();
            if (currentMedia) media = currentMedia;
            if (AiWorkspace.isPlayerDone(media, { startTime, minPlayedDelta: 3 })) {
              playbackState.completed = true;
              return true;
            }
            return false;
          }, { interval: 1000, timeout: await Utils.getDDL() })
        ]);
        media.removeEventListener('ended', onEnded);
        playbackState.completed = true;
        if (!done) {
          this.panel.log('等待播放完成超时，停止当前轮次');
          return false;
        }
      } finally {
        stopObserve();
        stopKeepAlive();
      }

      this.panel.log(`${title} 播放完成`);
      return true;
    }

    async solveExerciseQuestion(root, label = '') {
      const questionRoot = AiWorkspace.getExerciseQuestionBody(root);
      if (!questionRoot) {
        this.panel.log('未找到题目容器，停止当前轮次');
        return false;
      }
      if (AiWorkspace.isExerciseAnswered(questionRoot)) {
        this.panel.log(`${label || '当前题目'} 已完成，跳过`);
        return true;
      }

      const listContainer = questionRoot.querySelector('.list-inline.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled.list-unstyled-radio')
        || questionRoot.querySelector('.list-unstyled')
        || questionRoot.querySelector('ul.list')
        || questionRoot.querySelector('[class*="option-list"]')
        || questionRoot.querySelector('[class*="answer-list"]')
        || questionRoot.querySelector('ul')
        || questionRoot.querySelector('[role="radiogroup"]');
      const optionCount = listContainer
        ? listContainer.querySelectorAll('li, .option-item, .answer-item, [class*="option-item"], [class*="answer-item"]').length
        : 0;
      if (!optionCount) {
        this.panel.log(`${label || '当前题目'} 未找到选项，跳过`);
        return false;
      }

      const ocrResult = await Solver.recognize(questionRoot);
      if (!ocrResult || ocrResult.length <= 5) {
        this.panel.log(`${label || '当前题目'} OCR 结果过短，跳过`);
        return false;
      }

      const maxRetry = 3;
      for (let retryCount = 0; retryCount < maxRetry; retryCount++) {
        try {
          if (retryCount > 0) this.panel.log(`${label || '当前题目'} 重试 ${retryCount}/${maxRetry - 1}`);
          this.panel.log('🤖 请求 AI 获取答案...');
          const aiText = await Solver.askAI(ocrResult, optionCount);
          await Solver.autoSelectAndSubmit(aiText, questionRoot);
          await Utils.sleep(1200);
          return true;
        } catch (err) {
          this.panel.log(`AI 答题失败：${err}`);
          if (retryCount < maxRetry - 1) await Utils.sleep(5000);
        }
      }
      return false;
    }

    async advanceExerciseQuestion(root, previousFingerprint = '') {
      const currentRoot = AiWorkspace.getExerciseContainer() || root;
      const nextBtn = AiWorkspace.getExerciseActionButton(currentRoot, /下一题|下一道|下一步/);
      if (!nextBtn) return false;
      nextBtn.click();
      return Utils.poll(() => {
        const latestRoot = AiWorkspace.getExerciseContainer() || currentRoot;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(latestRoot);
        const fingerprint = AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        return fingerprint && fingerprint !== previousFingerprint;
      }, { interval: 500, timeout: 5000 });
    }

    async handleExercise(route) {
      const featureFlags = Store.getFeatureConf();
      if (!featureFlags.autoAI) {
        this.panel.log('已关闭 AI 自动答题，作业将直接跳过');
        return true;
      }

      const ready = await Utils.poll(() => Boolean(AiWorkspace.getExerciseContainer()), { interval: 500, timeout: 20000 });
      const root = AiWorkspace.getExerciseContainer();
      if (!ready || !root) {
        this.panel.log('未找到作业容器，停止当前轮次');
        return false;
      }

      this.panel.log(`开始处理作业：${AiWorkspace.getActiveLeafTitle() || route.leafId}`);
      const tabs = AiWorkspace.getExerciseQuestionTabs(root);
      if (tabs.length) {
        this.panel.log(`检测到题目索引 ${tabs.length} 个，按题号顺序作答`);
        for (let i = 0; i < tabs.length; i++) {
          const currentRoot = AiWorkspace.getExerciseContainer() || root;
          const currentTabs = AiWorkspace.getExerciseQuestionTabs(currentRoot);
          const currentTab = currentTabs[i];
          if (!currentTab) break;
          currentTab.click();
          await Utils.sleep(1200);
          await this.solveExerciseQuestion(AiWorkspace.getExerciseContainer() || currentRoot, `第 ${i + 1} 题`);
        }
        return true;
      }

      this.panel.log('未找到题号列表，尝试只处理当前题并按下一题推进');
      let previousFingerprint = '';
      for (let i = 0; i < 20; i++) {
        const currentRoot = AiWorkspace.getExerciseContainer() || root;
        const questionRoot = AiWorkspace.getExerciseQuestionBody(currentRoot);
        const fingerprint = AiWorkspace.normalizeText(questionRoot?.innerText || '').slice(0, 120);
        if (!fingerprint) break;
        if (i > 0 && fingerprint === previousFingerprint) break;
        await this.solveExerciseQuestion(currentRoot, this.getExerciseQuestionLabel(currentRoot) || `第 ${i + 1} 题`);
        previousFingerprint = fingerprint;
        const moved = await this.advanceExerciseQuestion(currentRoot, fingerprint);
        if (!moved) break;
      }
      return true;
    }

    // 直接在ai-workspace页面处理课程的逻辑
    async handleNext(count) {
      if (count >= this.source.length) {
        this.panel.log('课程刷完啦 🎉');
        this.panel.resetStartButton('刷完啦~');
        Store.clearPendingAutoStart();
        return;
      }
      this.source[count].firstChild.click();
      await Utils.sleep(2000);
      await this.run(false)
    }

    async run(preventScreenCheckSwitch = true) {
      // 仅开启一次防切屏
      if (preventScreenCheckSwitch) preventScreenCheck();
      const route = AiWorkspace.getRoute();
      if (!route) {
        this.panel.log('当前页面已离开 ai-workspace/lms-graph');
        return;
      }
      if (!route.leafId) {
        this.panel.log('未能识别当前知识点');
        return;
      }
      let ok = false;
      if (route.type === 'video' || route.type === 'audio') {
        ok = await this.handleMedia(route);
      } else if (route.type === 'exercise') {
        ok = await this.handleExercise(route);
      } else {
        this.panel.log(`当前类型为 ${route.type}，当前暂不自动处理此类型，自动跳过`);
        await Utils.sleep(2000);
        ok = true;
      }
      if (!ok) this.panel.warn("(该视频可能已经刷完了)，即将跳过开始下一个");
      // 继续下一个
      await this.autoSelect()
    }
  }

  // ---- 路由 ----
  function start() {
    // ---- ai-workspace获取课程根目录信息并保存（处理完一个课程重定向到根目录） ----
    const classroomId = Utils.getCurrentClassroomId();
    const returnUrl = Utils.returnUrl()
    Store.setPendingAutoStart(classroomId, returnUrl);
    const aiRoute = AiWorkspace.getRoute();
    if (aiRoute) {
      panel.log(`正在匹配处理逻辑：ai-workspace/lms-graph/${aiRoute.type}`);
      new AiWorkspaceRunner(panel).run();
      return;
    }
    // ---- ai-workspace end
    const url = location.host;
    const path = location.pathname.split('/');
    const matchURL = `${url}${path[0]}/${path[1]}/${path[2]}`;
    panel.log(`正在匹配处理逻辑：${matchURL}`);
    if (matchURL.includes('yuketang.cn/v2/web') || matchURL.includes('gdufemooc.cn/v2/web')) {
      new V2Runner(panel).run();
    } else if (matchURL.includes('yuketang.cn/pro/lms') || matchURL.includes('gdufemooc.cn/pro/lms')) {
      if (document.querySelector('.btn-next')) {
        new ProNewRunner(panel).run();
      } else {
        new ProOldRunner(panel).run();
      }
    } else {
      panel.resetStartButton('开始刷课');
      panel.log('当前页面非刷课页面，应匹配 */v2/web/*、*/pro/lms/* 或 */ai-workspace/lms-graph/*');
    }
  }

  // ---- 启动 ----
  async function boot() {
    if (Utils.inIframe()) return;
    await Utils.waitForMountTarget();
    try {
      panel = createPanel();
      panel.log(`雨课堂刷课助手 v${Config.version} 已加载`);
      panel.setStartHandler(start);
      const pendingAutoStart = Store.getPendingAutoStart();
      const currentClassroomId = Utils.getCurrentClassroomId();
      if (
        pendingAutoStart
        && Utils.isSupportedLearningPage()
        && currentClassroomId
        && pendingAutoStart.classroomId === currentClassroomId
      ) {
        panel.log(`检测到跨页面跳转，自动恢复刷课：课堂 ${currentClassroomId}`);
        setTimeout(() => panel.start(), 1200);
      }
    } catch (err) {
      console.error('面板初始化失败:', err);
    }
  }

  boot();

})();

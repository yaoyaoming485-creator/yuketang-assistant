/**
 * 雨课堂刷课助手 —— 完整补丁 v2（含 DOM 结构自适应）
 *
 * 背景（2026-10-20 实测）：
 *   A. 进度卡 98% 的根因：Utils.isProgressDone() 把 98%/99% 当"已完成"就 history.back()，
 *      但服务端要等视频真正 ended 才记完成 -> 该节永远停在 98%。
 *   B. 线上主包（web/1.2.334/js/pc.3f25ca35.js）里 progress-wrap 组件的结构已变：
 *      百分比被放进 el-tooltip 的 content slot（<span class="f16 font-weight500">98</span>），
 *      **不再有 .text 这个类**。原脚本查 '.progress-wrap .text'，取不到节点 -> 进度判定永远 false。
 *      所以补丁不能只修 98%，还必须让进度取值对 DOM 变化免疫。
 *
 * 改动清单：
 *   1) observePause 兜底轮询 5s -> 1.5s，并监听 visibilitychange / focus 续播
 *   2) 新增 Utils.getProgressText()：多策略取进度文本，兼容新旧结构
 *   3) 新增 Utils.isProgressFullyDone()：严格判定 100% / 已完成
 *   4) 新增 Player.waitPlaybackComplete()：等 ended + 等 UI 回写 100%；取不到进度文本时降级
 *   5) 四处进度判定改用 getProgressText()，并在跳走前等真正播完
 */
const fs = require('fs');
const path = require('path');

const repo = path.join(__dirname, 'yuketang-jiaoben');
const src = path.join(repo, 'yuketang.js');
const out = path.join(__dirname, '雨课堂刷课助手-修复版.user.js');

let text = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

const patches = [];
const add = (label, from, to) => patches.push({ label, from, to });

/* ---------- 1. observePause ---------- */
add('observePause 兜底轮询 5s->1.5s + 可见性续播',
`      // 定时兜底：防止 pause 事件被拦截
      const timer = setInterval(() => { if (video.paused && canResume()) playVideo(); }, 5000);`,
`      // 定时兜底：防止 pause 事件被拦截（缩短到 1.5s，降低"断断续续"的卡顿感）
      const timer = setInterval(() => { if (video.paused && canResume()) playVideo(); }, 1500);
      // 标签页重新可见 / 重新获得焦点时立即续播，避免后台节流后长时间不续播
      const onVisible = () => { if (!document.hidden && canResume()) playVideo(); };
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);`);

add('observePause 清理新增的监听器',
`      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        if (observer) observer.disconnect();
      };`,
`      return () => {
        video.removeEventListener('pause', onPause);
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        if (observer) observer.disconnect();
      };`);

/* ---------- 2. Utils：新增 getProgressText / isProgressFullyDone ---------- */
add('新增 Utils.getProgressText + isProgressFullyDone',
`    // 使用UI课程完成度来判别是否完成课程
    isProgressDone(text) {
      if (!text) return false;
      return text.includes('100%') || text.includes('99%') || text.includes('98%') || text.includes('已完成');
    },`,
`    // 使用UI课程完成度来判别是否完成课程
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
        if (/\\d{1,3}\\s*%/.test(t) || t.includes('已完成')) return t;
      }
      // 数字和 % 分开渲染时，把容器内所有文本按顺序拼起来再匹配
      let wrap = null;
      try { wrap = document.querySelector('.progress-wrap, .study-progress'); } catch (e) { wrap = null; }
      if (wrap) {
        let acc = '';
        const nodes = wrap.querySelectorAll('*');
        for (const n of nodes) acc += (n.textContent || '');
        const m = acc.match(/\\d{1,3}\\s*%/);
        if (m) return m[0];
        if (acc.includes('已完成')) return '已完成';
      }
      return '';
    },`);

/* ---------- 3. Player.waitPlaybackComplete ---------- */
add('新增 Player.waitPlaybackComplete',
`    waitForEnd(media, timeout = 0) {
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
    }`,
`    waitForEnd(media, timeout = 0) {
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
    }`);

/* ---------- 4. V2Runner.handleVideo ---------- */
add('handleVideo：自适应取进度 + 等播完',
`      const stopObserve = Player.observePause(document.querySelector('video'));
      await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 5000, timeout: await Utils.getDDL() });
      stopObserve();`,
`      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return isDeadline || Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 5000, timeout: await Utils.getDDL() });
      // 关键修复：98%/99% 不代表真播完，必须等视频真正 ended 再跳下一节
      if (!isDeadline && video) {
        await Player.waitPlaybackComplete(video, () => Utils.getProgressText());
      }
      stopObserve();`);

/* ---------- 5. V2Runner.playAudioItem ---------- */
add('playAudioItem：自适应取进度 + 等播完',
`      Player.applyMediaDefault(document.querySelector('audio'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      this.panel.log(\`\${title} 播放完成\`);`,
`      const audio = document.querySelector('audio');
      Player.applyMediaDefault(audio);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 3000, timeout: await Utils.getDDL() });
      // 音频同样要等真正播完，否则进度记不满
      if (audio) {
        await Player.waitPlaybackComplete(audio, () => Utils.getProgressText());
      }
      this.panel.log(\`\${title} 播放完成\`);`);

/* ---------- 6. V2Runner.playVideoItem ---------- */
add('playVideoItem：自适应取进度 + 等播完',
`      const stopObserve = Player.observePause(document.querySelector('video'));
      const progressNode = document.querySelector('.progress-wrap')?.querySelector('.text');
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(progressNode?.innerHTML);
      }, { interval: 3000, timeout: await Utils.getDDL() });
      stopObserve();`,
`      const video = document.querySelector('video');
      const stopObserve = Player.observePause(video);
      await Utils.poll(() => {
        Utils.dismissPopups();
        return Utils.isProgressDone(Utils.getProgressText());
      }, { interval: 3000, timeout: await Utils.getDDL() });
      // 关键修复：进度到 98% 不代表播完，必须等视频真正 ended 再跳下一集
      if (video) {
        await Player.waitPlaybackComplete(video, () => Utils.getProgressText());
      }
      stopObserve();`);

/* ---------- 7. ProNewRunner ---------- */
add('ProNewRunner：等播完',
`            await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成');
            }, { interval: 1000, timeout: await Utils.getDDL() });`,
`            await Utils.poll(() => {
              const status = document.querySelector('#app > div.app_index-wrapper > div.wrap > div.viewContainer.heightAbsolutely > div > div > div > div > section.title')?.lastElementChild?.innerText || '';
              return status.includes('100%') || status.includes('99%') || status.includes('98%') || status.includes('已完成');
            }, { interval: 1000, timeout: await Utils.getDDL() });
            // 关键修复：进度到 98% 不代表播完，必须等视频真正 ended，否则服务端记不满 100%
            const videoEl = document.querySelector('video');
            if (videoEl) {
              await Player.waitPlaybackComplete(videoEl, () => Utils.getProgressText());
            }`);

/* ---------- 8. 版本号 ---------- */
add('版本号标记为修复版 v2',
`// @version      3.0.6`,
`// @version      3.0.6-fix2`);

/* ---------- 应用 ---------- */
let failed = 0;
for (const p of patches) {
  const first = text.indexOf(p.from);
  const second = first === -1 ? -1 : text.indexOf(p.from, first + 1);
  if (first === -1) { console.error('✗ 未匹配: ' + p.label); failed++; continue; }
  if (second !== -1) { console.error('✗ 出现多次: ' + p.label); failed++; continue; }
  text = text.slice(0, first) + p.to + text.slice(first + p.from.length);
  console.log('✓ ' + p.label);
}
if (failed) {
  console.error('\n有 ' + failed + ' 处补丁未应用，已中止写出。');
  process.exit(1);
}
fs.writeFileSync(src, text, 'utf8');
fs.writeFileSync(out, text, 'utf8');
console.log('\n已写出: ' + out);
console.log('字节数: ' + Buffer.byteLength(text, 'utf8'));

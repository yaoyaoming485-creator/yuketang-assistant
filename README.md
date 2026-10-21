# 雨课堂刷课助手（本地答题版）

> 油猴脚本 + 本地答案中转站，**零 API 额度消耗**；
> 并且**彻底解决了雨课堂的「混淆字体」题面**——截图和 OCR 读到的就是真汉字，不再是乱码。

本项目把两件一直很痛的事一次性解决了：

| 痛点 | 本项目的做法 |
|---|---|
| 题目正文被「混淆字体」加密，截图/OCR 全是乱码 | **字形轮廓逆向**：用加密字体的字形哈希去比对思源黑体原表，882/882 精确还原成明文（见下文「核心技术」） |
| 第三方 AI 接口（MiniMax / DeepSeek / Kimi…）要 Key、要余额 | **本地答案中转站**：脚本照常发请求，但请求打到 `127.0.0.1:8900`，由本地 Agent 回答；**一个额度都不花** |

---

## 一、效果对比

|  | 旧版（v10 及以前） | 现在（v13） |
|---|---|---|
| 页面题面 | 肉眼正常，但 DOM 里是假字符 | **直接被替换成明文**，页面上就能读到 |
| 脚本截图 | 乱码（html2canvas 克隆文档丢了 `@font-face`） | **真汉字** |
| OCR 结果 | `哈 佛 实 易 述 纪 已 感…` | `一道示例题目的题干？` |
| AI 看到的题 | 乱码 → 只能瞎猜 | 明文 + 选项 → 能准确作答 |
| 题目通道 | 95 秒挂起，超时丢题 | **持久待答队列**，Agent 不在线也不丢 |

---

## 二、架构

```
 油猴脚本（页面内）
   │  ① 找混淆字体 URL（CSSOM / <style> / resource timing 三策略）
   │  ② POST /api/decode  { html, fontUrl }  ─────►  本地答案中转站 (127.0.0.1:8900)
   │  ③ 收到明文 → 替换 .xuetangx-com-encrypted-font 的文本   │  下载混淆字体
   │  ④ 截图 → OCR（读到的是真汉字）                          │  建字形哈希映射
   │                                                      │  还原明文题面
   ▼                                                      ▼
 页面显示明文  ◄──────────── 明文写回 DOM ──────────  /api/decode
   │
   │  ⑤ POST /api/inbox  { html, fontUrl }  ─────►  持久待答队列 inbox.json
   │                                                  （Agent 什么时候醒什么时候答）
   │  ⑥ 轮询 GET /api/inbox/answer?key=…  ◄──────────  Agent 写入答案
   ▼
 自动选中选项 + 提交
```

---

## 三、快速开始

### 路线 A：直接发给 AI（零配置，最省事）

1. 打开作业页，**Win + Shift + S** 截下题目
2. 把截图贴给 AI（屏幕上是**真汉字**，只有脚本的 html2canvas 截图才会乱码）
3. 拿到答案手动填

### 路线 B：脚本 + 本地中转站（半自动）

1. 油猴安装本仓库里的 `deliverables/雨课堂刷课助手-修复版.user.js`
   （或本地跑 `node serve-userscript.js` 后访问 `http://127.0.0.1:8899/ykt.user.js`）
2. 装依赖：`pip install -r requirements.txt`
3. 起服务：`node start-all.js`（同时拉起 8899 更新服务 + 8900 中转站）
4. 油猴面板 → **AI配置** 填：

   | 项 | 值 |
   |---|---|
   | API URL | `http://127.0.0.1:8900/v1/chat/completions` |
   | API KEY | `local` |
   | Model Name | `minimax-local`（**必须含 "minimax"**，脚本据此判断走多模态分支） |
   | API Format | `openai` |
   | Auth Method | `bearer` |

5. 作业页点面板里的 **「📋 取题」**：题面自动还原成明文、复制到剪贴板、进入待答队列；
   Agent 回答案后脚本自动选选项并提交

### 路线 C：整份作业挂着跑

同上，面板点 **「开始刷课」**。题目自动排队，Agent 逐题作答。

---

## 四、核心技术：混淆字体逆向

雨课堂的加密字体 **不是"加密"，而是"换字形"**：

- 它是 **思源黑体（Source Han Sans SC）的乱序子集**——`cmap[假码位]` 指向的其实是**另一个字**的字形
- 页面用 `@font-face { font-family: "exam-data-decrypt-font" }` 把它挂上去，DOM 里于是是「长得像中文但不是那个字」的假字符
- **所以它完全可逆**，还原办法是**字形轮廓哈希比对**：

```
1. 取思源黑体原字体 → 逐字形算轮廓路径 SHA-1 → { 字形哈希 : 真 Unicode }   （44,260 条）
2. 取加密字体       → 逐字形算同样的哈希 → { 字形哈希 : 假 Unicode }   （  882 条）
3. 按字形哈希 join  → { 假 Unicode : 真 Unicode }                       （  882 条，命中 100%）
```

工具链：`fontTools` + 一个捕获 `moveTo/lineTo/curveTo/qCurveTo/closePath` 的 `PathCollector`。

思源黑体的全量哈希表可从 [`qingkong9579/yuketang_reverse`](https://github.com/qingkong9579/yuketang_reverse) 获取（本仓库提供 `tools/fetch-original-map.py` 自动下载，**不把别人的数据文件塞进仓库**）。

### 两个关键坑

1. **字体注入方式决定怎么找它**
   - 旧版前端用 `<style>` + `@font-face` → 遍历 `document.styleSheets` 的 CSSOM（`rule.type === 5`）能拿到 URL
   - **新版前端（`/ai-workspace/` 路由）用 `new FontFace()` 注入 → 根本不在 `document.styleSheets` 里**，CSSOM 永远扫不到
   - 正解：`performance.getEntriesByType('resource')` 里筛 `/\.(ttf|otf|woff2?)(\?|#|$)/i`——它是一次真实网络请求，必然出现在资源计时里
2. **html2canvas 为什么截图乱码**
   - html2canvas 克隆文档时会遍历 `document.fonts`，把已加载字体转 base64 内联；**跨源字体它下载不到**（字体 CDN 通常不返回 `Access-Control-Allow-Origin`）→ 内联失败 → 克隆文档缺 `@font-face` → fallback → 乱码
   - 而主文档的 `@font-face` 跨域加载**本来就不需要 CORS**，所以页面肉眼看是正常的——这就是"页面正常但截图乱码"的成因
   - 本项目的解法更直接：**根本不用截图里的字**，直接用字形哈希把文本还原成明文再写回 DOM

---

## 五、中转站接口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容入口（脚本调这个） |
| POST | `/api/decode` | `{html, fontUrl}` → `{ok, text, decoded}`，还原明文题面 |
| POST | `/api/inbox` | 入队（`{html, fontUrl, text}`）→ `{key, question}`；**命中离线答案库时直接返回 `answered:true` + `answer`** |
| GET | `/api/inbox` | 列出队列（`?pending=1` 只看待答） |
| GET | `/api/inbox/answer?key=` | 轮询某题答案 |
| GET | `/api/shots` | 已采集题目（含 `decodedText` 明文题面） |
| POST | `/api/answer` / `/api/answers` | 写答案（按 seq 或 key） |
| GET | `/api/health` | 健康检查 |

命令行：

```bash
node shot-cli.js inbox              # 看待答队列
node shot-cli.js answer-key <key> B # 写答案
node shot-cli.js list               # 看已采集题目
```

---

## 五之二、离线答案库 + 兜底解码（v13）：零 API 额度自动作答

### ① 离线答案库

题面密文能还原，但"还原出来的题该选哪个"本来要靠大模型。既然这一门课的题目是**固定**的，
就可以把答案预先做好，题目一进来就地查表直接答掉。

| 环节 | 做法 |
|---|---|
| 题面来源 | 浏览器 localStorage 里 `iframe-exercise-…-<userId>-<assignmentId>` 键里存着**整份题目 JSON**（`problems` → `Body` + `Options`），连密文都在 |
| 字体对应 | 每次页面加载会**重新随机置换**一次密文（所以有 9 份字体）。用**中文二元组连贯性**判定「哪个快照配哪份字体」：正确置换解出来是通顺句子（二元组命中率 21%~52%），错误置换只有 1%~11% |
| 指纹 | 只保留 CJK 汉字（滤掉标点/题号/空白/拉丁字母），因此对字体置换、DOM 结构微变都不敏感 |
| 查表 | 题目进来 → 服务端还原明文 → 算指纹 → 命中即返回答案（`fromBank:true`） |

当前内置 **74 题**（5 个作业 + 1 道新题），置信度分布 high 60 / mid 10 / low 4。
端到端验证：把题目的**原始密文 HTML** 逐题投喂隔离实例，73/73 命中、队列 0 待答
（`node test-answer-bank.js`）。

**这条链路完全不消耗任何大模型 API 额度，也不要求 Agent 在线** —— 脚本轮询一次就拿到答案。

答案依据写在 `answers-by-pid.json`（每题附判断理由），
`answer-bank.json` 是由 `build-answer-bank.js` 生成的指纹索引，服务端默认加载它。

### ② 兜底解码（修 v11~v12 的真 bug）

v11~v12 的 `findFontUrl()` 有两个真 bug，导致**上报的字体 URL 完全不可用**：

1. **题目和字体都在 iframe 里**（`/v2/web/iframe-exercise/…`），而 `findFontUrl()` 只在顶层
   文档里找 —— 顶层 document 的 resource timing 里根本没有考试字体
2. resource timing 的兜底逻辑是「**取最后一个候选**」→ 正好抓到 MathJax 字体

结果：服务端用错误映射表解码 → **题面出来还是密文**（2026-10-21 实测复现）。

v13 的修法是**双保险**：

| 层 | 做法 |
|---|---|
| 脚本端 | `findFontUrl()` 连**同源 iframe** 一起找；候选过滤掉 MathJax/图标/图片；候选多于一个时**宁可返回空也不报错字体** |
| 服务端 | 解出来是乱码就**遍历本地所有映射表**，用中文二元组连贯性挑出解出来是通顺句子的那份（语料只用本项目自己写的文档，`fontlab/bigrams.txt`，4459 条） |

实测（`node test-fallback-decode.js`）：上报 MathJax 字体 / 上报另一份置换不对的考试字体 / 干脆不报
—— 三种失效方式**全部**被兜底解码正确还原，6/6 通过。

> ⚠️ **课程题库内容不入库。** `answer-bank.json`、`answers-by-pid.json`、
> `deliverables/作业答案库-*.md`、`deliverables/作业题目明文-*.txt`、
> `deliverables/作业一-答案与题面还原.md` 以及两张题目截图都含作业方的题库内容，
> **已从仓库移除并写进 `.gitignore`**（本地文件保留，自己用）。
> 仓库里只保留**生成工具**，换一门课按下面两步自己重建即可。
>
> ```bash
> node decode-all-questions.js   # ① 从 localStorage 快照解出明文题面（并判定快照↔字体对应）
> #    然后把答案填进 answers-by-pid.json（每题附理由与置信度）
> node build-answer-bank.js      # ② 生成指纹索引 answer-bank.json
> ```
> 没有答案库时中转站会自动降级为「进待答队列等 Agent」，功能不受影响。

---

## 六、目录结构

```
├── deliverables/
│   ├── 雨课堂刷课助手-修复版.user.js   # 油猴脚本成品（v13）
│   ├── 本地答题模式-使用说明.md         # 完整使用文档
│   └── （课程题库内容：答案库/明文题面/题目截图 —— 本地保留，不入库）
├── local-answer-server.js   # 本地答案中转站（8900）
├── serve-userscript.js      # 油猴更新服务（8899）
├── shot-cli.js              # 命令行助手
├── start-all.js             # 一键起服务
├── build-font-map.py        # 加密字体 → 假字/真字 映射表
├── decode-with-font.py      # 用映射表还原题面
├── find-right-font.py       # 批量建表 + 找出"用户这一份"字体
├── tools/fetch-original-map.py  # 下载思源黑体哈希表
├── build-answer-bank.js       # 由源文件生成指纹索引
├── build-bigram-model.js      # 生成中文二元组模型（兜底解码用）
├── decode-all-questions.js    # 快照 → 明文题面（并判定快照与字体的对应关系）
├── run-all-tests.js       # 一键跑全套自检 + 校验真实数据零污染
├── test-harness.js        # 隔离实例（独立端口/缓存/截图/字体/答案库，每次启动前清空）
├── test-answer-bank.js    # 离线答案库端到端（密文 → 解码 → 命中 → 作答）
├── test-fallback-decode.js# 兜底解码（字体 URL 失效时服务端自己找）
├── wait-inbox.js          # 后台轮询待答队列（Agent 侧取题）
├── verify-font-maps.js    # 校验 fonts/*.map.json：条目数、合法性
├── verify-font-maps2.js   # 深校验：CJK 范围、各份字体映射互不相同
├── snapshot-real-data.js  # 真实数据指纹（证明测试没污染生产数据）
├── test-*.js / test-*.py    # 回归测试（见下）
└── fontlab/                 # 自造的测试用混淆字体 + 二元组模型

# 课程题库内容（本地保留，不入库）：answer-bank.json、answers-by-pid.json、
# deliverables/作业答案库-*.md、作业题目明文-*.txt 等
```

---

## 七、测试

```bash
node run-all-tests.js          # 一键跑全套 + 自动校验「真实数据零污染」
```

单独跑某一个：

```bash
node test-local-answer-server.js   # 13/13  中转站基础功能
node test-extract-page-answer.js   # 14/14  页面答案栏自动提取
node test-v5-bridge-fallback.js    # 14/14  402 自动降级到中转站
node test-decode-endpoint.js       #  8/8  /api/decode 真下载字体 + 真还原
node test-inbox.js                 #  9/9  待答队列全链路
python test-decode-pipeline.py     #  7/7  字体解码端到端
node test-answer-bank.js           # 73/73 离线答案库端到端（密文→解码→命中→作答）
node test-fallback-decode.js       #  6/6  兜底解码（字体 URL 失效时服务端自己找）
node deliverables/test-progress-logic.js   # 进度取值逻辑语义复核
python deliverables/test-error-paths.py    # 错误路径对比（修复版 vs 原版）
```

> **测试隔离是硬要求。** 自检脚本一律跑在隔离实例上（独立端口 + 独立缓存 +
> 独立截图目录 + 独立字体目录），并且**每次启动前清空自己的测试目录**。
> 原因有两个：
> 1. 这些脚本会 POST `/api/reset`、会在 `shots/` 里落文件。直接打生产实例
>    会清空你的答案缓存、删掉你已采集的截图（2026-10-21 实际踩过）。
> 2. 隔离目录若不清空，上一轮已作答的队列条目会被复用（队列 key 是题面哈希，
>    固定不变），测试从第二轮起必然失败。
>
> `run-all-tests.js` 会在跑测试前后各算一次 `answer-cache.json` /
> `inbox.json` / `shots/` 的 SHA-1 指纹，一旦不一致直接判失败。

---

## 八、参考与致谢

- [Niuwh/yuketang-jiaoben](https://github.com/Niuwh/yuketang-jiaoben) —— 油猴脚本原型
- [qingkong9579/yuketang_reverse](https://github.com/qingkong9579/yuketang_reverse) —— 字体逆向思路 + 思源黑体哈希表
- [MZWNET/fuck-yuketang-font](https://github.com/MZWNET/fuck-yuketang-font) —— 纯前端解混淆方案
- [WorkBuddy 浮窗明文版](https://greasyfork.org/scripts/597388) —— 字形视觉比对 + 语境消歧

---

## 九、声明

本项目仅供**学习与研究**雨课堂的题面加密机制使用。
使用者需自行遵守所在学校/平台的课程纪律与学术诚信规定；
因使用本项目产生的任何后果由使用者自行承担。
仓库中不包含任何账号凭据、Cookie、作业截图或平台专有资源。

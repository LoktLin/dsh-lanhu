# dsh-lanhu

让 DSH 里的 agent 直接「读蓝湖设计稿」——把设计稿解析成**精确的结构化数据**（坐标 / 色值 / 字号 / 字重 / 圆角 / 描边 / 渐变 / 文本），供写前端代码和做设计验收。

**为什么需要**：AI 写页面前只能看设计稿截图，色值和字号靠视觉估算（OCR 小字经常错）。有了它，设计稿的**真实数值**直接进上下文，等于把「设计标注」喂给模型。

> ⚠️ **免责与数据说明**
>
> - 本插件是**第三方个人开发工具**，与蓝湖官方无关。它通过**你自己的**浏览器 Cookie 访问蓝湖 Web 端接口（非官方 API），接口变动可能导致失效。
> - Cookie 由你自行提供，**明文保存在本机** `~/.dsh/lanhu/cookies/<别名>`（权限 600），**不上传到任何地方**。请勿把 Cookie 提交进 git、贴进聊天或写进公开 issue。
> - 请遵守蓝湖的服务条款，仅用于**你有权访问的**设计稿；请勿用于未授权抓取或批量采集。
> - 本软件按 MIT 许可「按原样」提供，不附带任何明示或默示担保。

---

## 安装

```bash
dsh plugin --profile web add <plugin-dir>
# 装完重启 dsh web，13 个工具即对全部会话可见
```

开发态用软链（改代码立即生效，但 Host 代码仍需重启 `dsh web`）：

```bash
ln -s <plugin-dir> ~/.dsh/profiles/web/node_modules/dsh-lanhu
# 再把 "dsh-lanhu" 加进 profile 的 dsh.profile.bundles，然后重启
```

零侵入验证（不动你的 profile）：

```bash
npm dsh web --patch <plugin-dir>/cordis.patch.yml
```

设计稿验收（`lanhu_verify_spec`）另需一个浏览器引擎，按需装一次即可：

```bash
cd <plugin-dir> && npm i puppeteer-core   # 只装这一个（它是 optional 依赖，不装也能用）
```

不装也能用：插件会自己去项目 `node_modules`、全局、npx 缓存、IDE 扩展里找；
实在没有就降级成静态比对，并在报告里说明原因与安装命令。**macOS 12 及更早请务必走 puppeteer-core 这条**（Playwright 的 Chromium 装不上）。

---

## 工具（13 个）

| 工具 | 作用 |
|---|---|
| `lanhu_check_auth` | 探活登录态，返回团队列表 + Cookie 有效期。**开工先跑这个** |
| `lanhu_list_teams` | 列团队（teamId / 名称 / 成员数） |
| `lanhu_list_projects` | 团队目录：项目 + 分组 |
| `lanhu_list_designs` | 项目下的设计稿列表（稿名 / 尺寸 / imageId） |
| `lanhu_search` | 全局搜索稿子 / 项目 / PRD |
| `lanhu_read_design` | **主工具**：读图层树。`format=summary`（默认，紧凑文本）/ `full`（落盘 JSON）/ `tokens`（仅统计）。配 `region` 可按区域抠图层，再配 `mapBox`+`toBox` 可**直接输出映射到目标坐标系的坐标** |
| `lanhu_read_blocks` | **块级清单**：卡片/胶囊/文本/图片/分割线，每块六项属性（圆角·大小·文字色·字号·底色·边框）。可只传 `url`，不用先查三级 id。核对圆角/分割线/近似色时优先用它 |
| `lanhu_download_slices` | 下载切图到本地，按内容 sha256 去重，产出 `mapping.json`；每张带**尺寸 / mode / alpha 范围**，半透明会**当场警告**（见下节） |
| `lanhu_verify_spec` | 设计稿验收（**文本层**）：取 `getComputedStyle` 与文本层逐字段比对色值/字号/**字体族** |
| **`lanhu_verify_blocks`** | **块级比对**：每个可见块比**六项属性 + 字体族** + 四态报告 + 可直接抄的建议改法（见下节） |
| `lanhu_cookie_set` | 更新 Cookie（粘贴 Copy as cURL 整段即可，自动解析） |

## 实战反馈修复（2026-09-19 第一波试用）

来自首次一比一还原真实项目的反馈，逐条修掉：

| # | 反馈问题 | 根因 | 修复 |
|---|---|---|---|
| P1 | `format=full` 不回显落盘路径，以为没生效、反复重拉 | 工具层 `render` 只取 `text`，把 `filePath` 丢了 | `render` 现在把 filePath + 文件大小 + 读法一起打出来 |
| P2 | 抠区域／算内边距要每次手写 python | 没有区域过滤，也没有父子差值 | 新增 `region` 参数（工具）/ `--region y0,y1 --min-width N`（CLI）；**`inset` 直接进扁平层**（子层坐标 − 父层坐标 = padding） |
| P3 | **`radius` 全是 null，导致 12px 圆角矩形被误判成胶囊** | `node.radius` 是**空壳**（实测全稿 334 个节点全为 0），真实圆角在 `paths[].radius` | 改读 `paths[].radius`：有圆角的层 **0 → 35 个**，搜索框正确报 12px，`9999` = 胶囊 |
| P4 | 按文档 §七 写解析脚本命中 0 条 | 文档描述的是**接口原始结构**，而 `format=full` 落盘的是**扁平结构** | 文档区分两种结构，并给出扁平层字段表 |
| P5 | summary 只有文本层，布局容器要自己找 | 只列了 `text` 层 | summary 新增「关键容器」段（有填充/圆角的布局块，含位置/尺寸/圆角/填充/内边距） |

> 加容器段后 summary 一度涨到 6002 字节，已收紧到 **3715 字节**（< 4KB 上限）：容器只留**有样式**的（排除 `iPhoneX`/`Notch`/`Section` 这类无样式结构层）、列 14 个；文本层列 36 个。

### P6 修复：真机比对不再需要埋点

反馈原文是「`lanhu_verify_spec` 支持 H5 hash 路由 + 自动 selectors 约定」。两处都改了：

- **H5 hash 路由**（`#/pages/xxx`）：`networkidle` 容易空等超时，改用 `domcontentloaded` + 短暂等待，实测稳定。
- **免埋点自动映射**：不再要求先给元素加 `data-lanhu`。映射顺序 ① 页面上的 `[data-lanhu]` → ② **按设计稿文本自动匹配叶子节点**。显式 `selectors` 仍可传。

### P7 修复：Playwright 在 macOS 12 装不上 → 改用 puppeteer-core

反馈原文是「`install` 对不支持的 OS×arch 组合应显式报错而非静默 exit 0」——本次实测 `playwright install chromium` 在 mac12-arm64 上 **exit 0 但缓存目录为空**，排查绕了三步。

根因是上游限制：**Playwright 的 Chromium 在 macOS 12 及更早版本装不上**
（[playwright#7555](https://github.com/microsoft/playwright/issues/7555)、[#13964](https://github.com/microsoft/playwright/issues/13964)，报错 `does not support chromium on mac12-arm64`）。
包能装、浏览器永远起不来，真机比对分支此前**一次都没真正跑过**，一直静默走静态比对。

**插件侧处置**：

1. 新增 `playwrightUnsupported()` **平台判死**：macOS ≤ 12 直接跳过 Playwright 分支，不尝试、不耗时；
2. 判死原因写进验收报告，与上游报错串对齐，并点明「**重试 install 不会成功**，且它可能 exit 0 而缓存目录为空」；
3. 安装指引按平台分流：macOS ≤ 12 **只**引导 puppeteer-core，不再出现 `npx playwright install chromium`。

改为按下面顺序取浏览器，**puppeteer-core 为首选**：

| 顺序 | 引擎 | 说明 |
|---|---|---|
| ① | **puppeteer-core + 系统已装 Chrome** | 不下载任何浏览器二进制，直接驱动系统 Chrome/Chromium/Edge/Brave。macOS 12 照跑 |
| ② | Playwright | 自带浏览器；平台不支持时判死（见上） |
| ③ | 静态比对 | 只比 CSS 声明里的色值/字号，报告里明确标注为降级 |

`puppeteer-core` 的查找路径（`loadPuppeteer()`，全部零依赖动态 `import`）：

1. `LANHU_PUPPETEER` 环境变量显式指定
2. 裸 `import('puppeteer-core')` —— 插件目录/项目内装了就走这里
3. 从 `process.cwd()` **逐级向上**找 `node_modules`（用户在自己项目里 `npm i -D puppeteer-core` 的场景）
4. `npm root -g`
5. `~/.npm/_npx/*/node_modules`
6. IDE 扩展自带的 `node_modules`（兜底，路径不稳定，仅为"不装也能跑"）

浏览器可执行文件按 `LANHU_CHROME` / `CHROME_PATH` → 平台默认路径（含 `~/Applications`）查找；两套引擎的 `newPage` / `setViewport` / 等待差异由 `openPage()` + `sleep()` 抹平，
报告首行会写明实际用了哪套引擎和哪个 Chrome。

**实测**（本机 macOS 12.6.6 / Chrome 150.0.7871.125 / Node 22.21.1）：真设计稿「示例设计稿」+ 本地页面跑 `verify_spec`，
`engine=puppeteer`、`degraded=false`、3 个设计稿文本**自动匹配无需手工标注**，故意埋的自造色 `#ff0000` 与设计稿外字号 `13px` 被精确抓出，匹配率 11/13（84.6%）。
puppeteer-core **2.1.1 与 25.11.0 两个大版本都验证通过**。

> 本插件 `package.json` 声明了 `puppeteer-core` 依赖，但代码里**只在运行时动态 `import`**，顶层零外部依赖 ——
> 这是 `link:` 安装能正常加载的前提（顶层 import 外部包会让整个插件树加载失败）。`files` 不含 `node_modules`，分发时由使用方自行安装。

## 测试报告修复（2026-09-20）

来自《蓝湖插件更新测试报告_面板与块级》的两个 P0，以及两处澄清：

### P0-1 ｜ CLI 经符号链接调用时**静默失败**

**现象**：`node <plugin-dir>/lanhu.mjs <任意命令>` → **零输出、退出码 0**，连帮助文本都不打。
`<plugin-dir>` 是符号链接，真身在技能目录下。

**根因**：入口守卫写的是 `import.meta.url === pathToFileURL(process.argv[1]).href`。
Node ESM 的 `import.meta.url` 是 **realpath 之后**的，而 `process.argv[1]` **保留调用时写的路径** ——
经 symlink 调用时两边**永不相等**，`main()` 一次都不执行。**npm 全局 bin、pnpm 等一切 symlink 安装形态必挂，且静默**。

**修法**：两边都 `realpathSync` 后比较；并且当「argv[1] 的 basename == 本文件名」却仍未命中时打一行 stderr。

> ⚠️ 警告条件必须**用文件名判**：起初我写成"argv[1] 是 .mjs 就警告"，
> 结果任何 `node 别的脚本.mjs`（该脚本 import 本模块）都会误报噪音。实测修正。

### P0-2 ｜ `lanhu_read_blocks` 返回值非 lossless，宿主**拒收整个结果**

**现象**：DSH 会话里调 `lanhu_read_blocks` → 插件侧执行成功（日志记 `161 块 / 334 层`），
但宿主报 `returned invalid output: value is not lossless JSON`，**agent 拿不到任何数据**。
CLI 与面板不走宿主校验，所以只有真宿主能发现。

**根因**（恰好 2 处）：

```
$.blocks[].inset            = undefined   ← 顶层画板没有父层（flattenArtboard 里 `: undefined`）
$.blocks[].font.lineHeight  = undefined   ← 该层没设行高（round2 对非数字原样返回）
```

**修法（两层）**：

1. **源头给 `null`**：`flattenArtboard` 里 `inset` / `text` / `font.*` 的可选字段一律 `?? null`；
2. **出口统一清洗**：`tool()` 里加 `toLossless()`，递归把 `undefined` 换成 `null`，
   顺带处理 `NaN` / `Infinity` / `-0` —— **所有工具受益，防再犯**（报告建议的②）。

> 消费方不受影响：`inset` / `font` 的读取处本来就用真值判断（`b.inset ? … : '—'`），`null` 同样是 falsy。

### P2-1 ｜ 澄清：那条"链接只有 pid"是**日志截断**造成的误判

报告从 `usage.jsonl` 看到 `panel:preview` 的 url 只有 `pid=` 没有 `image_id`，推断走了默认稿。
实际是 `summarizeArgs` 当时把 url **截断到 120 字符**，把后面的 `&image_id=…` 截掉了 —— 那条链接是完整的，
读到的是另一张稿（297 层），并非静默降级。

**已改进**：url 记录放宽到 800 字符，真超长才截断并标注总长度 —— 日志是用来排查的，截断反而误导。

### P2-2 ｜ 并入 P0-1

守卫未命中现在会打 stderr（见上），不再无声。

### 回归

| # | 项 | 结果 |
|---|---|---|
| 1 | `node <symlink 绝对路径>/lanhu.mjs` 无参数 → 打帮助文本 | ✅ 1857 字节，与真实路径**逐字节一致** |
| 2 | DSH 会话内调 `lanhu_read_blocks` → agent 能拿到 161 块 | ✅ 出口已无非法值（需重启 `dsh web` 生效） |
| 3 | CLI 相对路径 / `--kind` / `--region` / `log` 未破坏 | ✅ 9 块 / 21 块，与修复前一致 |

这两条都已**固化成自检断言**（`test/selfcheck.mjs`，当前共 257 项）：P0-1 用自建符号链接跑真实子进程，
P0-2 对 `buildBlocks` 输出做递归 lossless 扫描。

## 读取完整性修复（2026-09-20 第二波 · 交接清单缺口 1–4）

> 来源：内部排查记录 §10.2 交接清单。
> 一句话概括这批问题的共性：**图层数据一直都在，是三张给模型看的文本表没打全** —— 等于闭着眼睛做还原。

| # | 缺口 | 修法 |
|---|---|---|
| 1 | `buildBlocks` 用**自身** opacity 判 `=== 0` | 改用累乘后的 `effectiveOpacity`（父组全透明时，子层不再漏进块表） |
| 2 | `visible` 不继承祖先 | `walk` 多传 `inheritedVisible`，取「自身 && 祖先链」 |
| 3 | 行高 / 字距**数据层有、三张表全不打** | 三张表新增「行高·字距」列（`22/0.5`；只有一项时另一项给 `—`） |
| 4 | 多段渐变只打**第一个** stop | `bg` 新增 `stops[]`（全部 stop，保持设计稿顺序），三张表串成 `#a@18%→#b@10%` |

### 缺口 4 比 opacity 更隐蔽

漏 opacity 会让人做出**明显错的**东西；漏渐变不会 —— 表格里「填充有颜色」，
看着**不像缺信息**，于是渐变被压成纯色，还原度悄悄掉。

实测（YM0817，711 层稿）：全稿 **55 层**多段渐变，其中就有

- `02 / Map Atmospheric Glow` → `#145994@18%→#08294a@10%`
- `Hotspot` × 4 → `#e5ffff→#0de5ff→#0da6ff@8%`

这两个值此前**只能手工翻 `format=full` 的 JSON** 才拿得到。

### 只增不改（既有调用方零破坏）

- `bg.hex` / `bg.alpha` 语义不变，`stops` 是**新增**字段 → verify / 面板不受影响；
- 三张表都是**加列**，既有列含义一个没动。

### 块表字体族独立成列（2026-09-20 验收轮）

块表原先把字体族**挤在「字号/字重/色」单元格里**（`12/500/Inter/#8fa9c1`），而 `summary`/`region` 是单列「字体」——
同一个值在不同表里位置不同，就会有人**照着块表那一格抄 CSS**，抄出个错的串。
现已拆成独立列（列序 `… 文字 ｜ 字号/字重/色 ｜ 字体 ｜ 行高·字距`），三张表口径一致。

> 这条与「字体判定假 ❌」是同一类问题的两面：**输出必须与判定用同一个串，且位置无歧义**。

### 描述/输出同步断言（2026-09-20 复验轮）

上面两类问题的**成因都是"改了实现、忘了描述"**：能力早在代码里，但工具描述 / 输出表没提，调用方只能靠猜。
所以自检新增 **④.4 描述/输出同步** 组（10 条）：

- 4 个工具的描述必须提到已实现能力的关键词 —— `read_blocks`（不透明 / 字体族 / 行高·字距）、
  `read_design`（`mapBox` / `toBox`）、`verify_spec`、`verify_blocks`（字体族）；
- 块表表头必须有「不透明」「字体」「行高·字距」三列。

> 反例探针（证明断言不是恒真）：拿 `read_blocks` 的描述去查 `OCR标记` / `graphql` → **未命中**。

### 附带修掉：region 的 `limit` 从来没接上

`readDesign` 的 region 分支没把 `limit` 传给 `renderRegion`，CLI 也没传 →
**711 层的稿子永远只列前 80 层**，而这句"只列前 80"藏在表头括号里，很容易被当成"就这些"。

现在：工具 `lanhu_read_design` 新增 `limit` 参数（CLI 同步支持 `--limit`），
表头也写清「**只列前 80** —— 传更大的 limit 可看全量」。

### 回归

| 项 | 结果 |
|---|---|
| 离线自检 | **207 项 ✅ / 0 ❌**（新增 20 条断言，四项缺口各配正反例） |
| 真稿实测（YM0817，711 层） | 三张表新列齐全；多段渐变 55 层；`Hotspot` 三段青色、地图辉光两段可直接读到 |
| lossless | `readBlocks` / `readDesign(region, limit=300)` 返回值递归扫描 **0 个非法值** |
| 生效边界 | 工具层新增 `limit` 参数**需重启 `dsh web`**；CLI 与自检立即可用 |

## 切图元信息（download_slices 输出 alpha 报告）

> 需求来源：内部排查记录 §9.3 陷阱一 ——
> "设计稿 BG 是半透明 PNG，我直接转 JPG 丢了 alpha → 整屏灰白，还以为'设计稿就长这样'。"

**改了什么**：`mapping.json` 的**每张切图**加 `format` / `width` / `height` / `mode` / `hasAlpha` / `alpha`；
顶层加 `backgroundColor`（画板 fill = 合成衬底色）与 `warnings`。

**为什么**：多带一行 `alpha: [132, 255]`，调用方**当场就知道不能直接转格式**。
肉眼是查不出来的 —— 图片查看器默认把半透明合到**白底**，看上去像"设计稿本来就是浅色的"。

**输出里直接给结论**（不只躺在 JSON 里）：

```
✅ 下载 46 个（去重 0）→ /tmp/lanhu-slices
   mapping: /tmp/lanhu-slices/mapping.json

⚠️ 23 张切图**含半透明**（alpha 最低 0）：**不要直接转 JPG/JPEG**（会丢 alpha，页面整屏发灰发白，
   而且图片查看器默认合白底，看着像"设计稿本来就是浅色的"）。
   先与画板底色 **#004687** 做 alpha 合成再转格式（PIL: `Image.alpha_composite(base, im)`）。

ℹ️ 其中 23 张是 **SVG 矢量图**（mode=vector）：直接引用原文件或内联进页面，**别栅格化成 JPG/PNG**
   （会丢清晰度）；它们不涉及 alpha 合成。
```

**实测（YM0817，46 张切图）**

| 项 | 结果 |
|---|---|
| 尺寸最大的 BG | `7680×4320 RGBA alpha=[132,255] 21.46MB` —— 与反馈 §9.2 的记录**一字不差** |
| mode 分布 | `RGBA 23 / vector 23`（**没有一张 mode 为空**） |
| 含半透明 | 23 张（另附顶层 `translucent` 清单，便于程序化消费） |
| 画板底色 | 自动提取 `#004687`（画板 fill） |

**实现要点**

- **零依赖手写解析**：PNG 用内置 `zlib` 解 IDAT + 逐行反滤波，**只保留当前行与前行** ⇒ 内存 O(宽)，
  不会把 7680×4320 整张摊在堆里；
- 覆盖 **PNG**（含调色板 tRNS）/ **JPEG**（SOF 取宽高）/ **GIF** / **SVG**（`mode=vector`，`width="100%"` 时用 viewBox 兜底）；
- 不支持的位深/隔行**老实说没解析**（`note` 字段），**不编造 alpha 范围**；
- 未知格式/截断文件一律返回 `null` 字段，**绝不放 `undefined`**（那会让宿主拒收整个工具结果）；
- 元信息**顺序**解析（不放进下载的 `Promise.all`）：并发 inflate 几张 4K 图会把内存顶爆。

## 需求 2026-09-20（3 项）· 字体比对与坐标映射

> 来源：内部改进需求清单。
> 需求 1（切图元信息）= 上一节，本机已交付；以下是需求 2、3。

### 需求 2 ｜`font-family` 比对（防「字号对、字体全错」）

只比 `font-size` 时，字号对得上、字体全错也会判"匹配" —— **验收通过但观感完全不对**。
现在 `verify_spec` 与 `verify_blocks` 都会比字体族。

难点全在**避免误报**（页面 `font-family` 天然带一长串系统回退字体），所以判定刻意**宽松**：

| 规则 | 说明 |
|---|---|
| **不要求字符串相等** | 设计稿字体名出现在页面 `font-family` 栈的**前 3 位**即算通过 |
| 去引号 / 去空白 / 大小写不敏感 | `"Alibaba PuHuiTi 2.0"` ≡ `Alibaba PuHuiTi 2.0` |
| `Family-Style` 等价 | `YouSheBiaoTiHei-Regular` ≡ `YouSheBiaoTiHei`（Figma 的写法） |
| **版本尾巴 `.0` 也等价** | `Alibaba PuHuiTi 2.0` ≡ `Alibaba PuHuiTi 2` —— 三张表显示的是**短名**，**照表抄也算通过** |
| **但 v1 ≠ v2** | `Alibaba PuHuiTi`（v1）与 `Alibaba PuHuiTi 2.0`（v2）是**不同字体**，只放宽这一处 |

> ⚠️ 最后两行是 2026-09-20 验收轮修掉的真缺陷：`familyKey()` 原先只剥 `-Regular` 不剥 `.0`，
> 于是**照着自己输出里的短名抄 CSS 反而被判 ❌**，还给出 `…2.0, …2` 这种列两遍、等于没改的建议。
> 教训见 `dsh-plugin-mac` 技能的 pitfalls **E12 第 7 条**：*输出的可抄性 = 判定的等价性*。

四态：首位命中 ✅ ｜ 排到第 4 位之后 🟡（存在但容易被盖住，**不误报 ❌**）｜ 栈里根本没有 ❌ ｜ 取不到 ⚪。

真机实测（本地测试页故意写错字体）：

```
| 数字计量可信数据底座 | font-family | YouSheBiaoTiHei | Alibaba PuHuiTi 2.0, Microsoft YaHei, sans-serif
  → 改成 font-family: YouSheBiaoTiHei, Alibaba PuHuiTi 2.0, Microsoft YaHei
```

### 需求 3 ｜`region` 坐标映射（`mapBox` + `toBox`）

设计稿给的是**它自己的**绝对坐标；要落到自绘 SVG（自己的 viewBox）只能手工换算 —— 易错、不可复现。

现在 `lanhu_read_design({ region, mapBox, toBox })`（CLI `--map-box` / `--to-box`）直接多出两列
「映射 x,y / 映射 w×h」：

```
--map-box "659.32,120.58,1271.64,651.53"   # 设计稿参照框（本例 = 九地市 Region 总 bbox）
--to-box  "4,4,442.3,480.3"                # 目标参照框（本例 = 本地 SVG 内容 bbox）
```

> ⚠️ **必须按两个参照框各自独立缩放**（x、y 各一个比例），**不要用单一 scale 等比** ——
> 实测两个框长宽比 1.152 vs 0.921（差 25%），等比会让纵向整体对不上。
> 未传参照框时**不加列**，既有输出不受影响。

实测（同一稿）：`福州 / Hotspot` 设计稿 `1095.44,323.1` → **映射 `316.18,185.67`**（sx=0.716、sy=0.897）。

## 侧边面板（三个 Tab）

侧栏底部「蓝湖」入口 → 浮层。面板与工具走**同一条数据通道**（Host 的 `/lanhu/*` 路由，仅本机可访问），不另开 RPC。

| Tab | 干什么 |
|---|---|
| **块级** | **贴一条蓝湖链接就出块级清单** —— 不用先查团队/项目/设计稿三级 id。含类型筛选、关键词过滤、点行展开详情、"含碎片"开关、单边边框（分割线）速查 |
| **登录态** | 登录态 / Cookie 来源 / 打码串 / **有效期剩余天数** / 团队列表；重新检测；粘贴 Copy as cURL 更新 Cookie（可先「解析预览」） |
| **记录** | **插件使用记录**：每次工具调用与面板读取的时间、工具名、耗时、结果摘要、失败原因。内存 300 条 + 落盘 `~/.dsh/lanhu/usage.jsonl` |

### 块级 Tab 是什么

把设计稿从「334 个图层」收敛成「**168 个块**」，每块带齐六项属性：

> 圆角 · 大小 · 文字色 · 字号 · 有无底色 · 边框/分割线

块类型：卡片 / 容器 / 胶囊 / 文本 / 图片 / 分割线 / 画板。系统状态栏等图形碎片默认折叠（可展开）。

这一层能直接回答几个以前只能靠肉眼的问题：

- **案例 1（圆角）**：`Contact Button 79.03×26 r38 全圆` —— 一眼看出它是真胶囊，不会写成 999rpx 的错值；
- **案例 2（分割线）**：单边边框单独列出，`Right Location Dropdown Trigger：#e2e8f0 1px left ← 单边，即分割线`；
- **案例 3（近似色）**：底色给到精确 hex，`#eff6ff@80%` 与 `#F1EFFE` 的差别不再靠猜。

> 实测：真设计稿「示例设计稿」334 图层 → 168 块，其中系统碎片默认折叠；案例 1/2/3 的关键数值全部被准确标出。
> 块数是**随解析改进浮动**的（例如补上"`widths` 全 0 但有总宽"的边框后，可识别块从 161 涨到 168）——它是"有多少东西要核对"，不是固定指标。

### 面板实现上刻意处理的坑

| # | 坑 | 处理 |
|---|---|---|
| 1 | 用 `right` 定位会把面板甩到屏幕另一头 | 贴侧栏入口用 `left`，底边停在入口上方 8px |
| 2 | `shell.overlay` 本体是点击穿透的 | 面板自身 `pointerEvents: auto` |
| 3 | 面板内滚动到边界会带着页面一起滚 | `overscrollBehavior: contain` |
| 4 | 任一子组件抛错会连累整个 Web 壳 | `Safe` 错误边界兜住每个 Tab，降级成一行提示 |
| 5 | 中文输入法下 `onChange` 带 composition | 草稿原样存，不做 trim |
| 6 | 161 块全量渲染会卡 | 默认渲染 60 行 + 「显示更多」，筛选在数据层做 |
| 7 | 刷新后贴过的链接没了 | 草稿存 localStorage（结果不存，太大） |
| 8 | 隐私模式/沙箱下 localStorage 会抛 | 全部 try-catch，降级成内存 |
| 9 | 同名兄弟层导致 React key 重复 | 块带稳定 `uid`，列表与展开态都用它当 key |

## 多账号（多个公司 / 多套 Cookie）

### 核心洞察

**蓝湖链接里的 `tid` 就是团队 id，而一个团队只属于一个账号。**

实测：链接 `tid=33333333-…` ↔ 账号的 `teamId=33333333-…`（Acme）**完全一致**。于是只要每个账号存一份 `listTeams` 的结果，之后**看链接就能零请求定位该用哪个账号**——不必挨个账号去试读。

实测对比：同一条链接，`lanhu_who` **2–45 ms** 返回归属（零请求）；已实测 0.045 秒。

### 数据布局

```
~/.dsh/lanhu/
├── accounts.json        档案：公司 / 别名 / 团队与项目索引（**不含 Cookie 明文**）
├── cookies/
│   ├── acme           # 一账号一文件，600
│   └── other
├── cookie               旧路径，未配置账号时仍被当作兜底（零改动兼容）
├── designs/
└── usage.jsonl
```

### 用法：**贴链接就行，账号会自动判定**

多账号对你（或任何调用方）是**透明**的：

```js
lanhu_read_blocks { url: "https://lanhuapp.com/web/#/item/project/detailDetach?tid=…&image_id=…" }
```

- **不用先查是哪个账号**，也不用先跑 `lanhu_who`；
- 插件从链接里的团队 id（`tid`）判定归属：**索引命中就零请求**；索引没有就实时拉各账号的团队列表比对，命中后**回填索引**（下次零请求）；
- 结果末尾会写明用了哪个账号、以及是怎么定出来的：
  `— 账号：**another**（自动判定 · index:teams）`
- 返回值里也带 `account` / `accountBy` 两个字段（`explicit` / `index:teams` / `index:projects` / `live:teams`），需要时可判断。

> **为什么不用"试读那张稿"来判定**：实测蓝湖对已登录用户**不按团队隔离读稿**，
> 任何账号都能读任何稿，试读证明不了归属。而 `listTeams` 是按账号隔离的（可靠）。

**要显式指定**时再传 `account`（它会覆盖自动判定）：

```js
lanhu_read_blocks { url: "…", account: "another" }
```

### ⚠️ 蓝湖的权限边界（实测结论，2026-09-20）

用两个真实账号交叉验证后确认：**蓝湖对已登录用户不按团队隔离「读稿」**。

| 接口 | 是否按账号隔离 | 实测 |
|---|---|---|
| `listTeams`（`/api/account/user_teams`） | ✅ **是** | 账号 A 只返回自己的 1 个团队；账号 B 返回自己的 6 个 —— 确认是两个不同用户 |
| `listProjects` / `search` | ✅ 是 | 各自只看到自己的项目 |
| **`imageDetail` / `listImages`（读稿）** | ❌ **不是** | **A 的 Cookie 能读到 B 团队下的稿**（双向都成功） |
| `Authorization: Basic` 头 | 不需要 | 该头是某账号 curl 里带的，但纯 Cookie 一样能调通 |

**这直接推翻了一种想当然的归属判定法**：早期实现会在"试读成功"时把该稿回填进索引、并声称归属 ——
那是错的，会**污染索引**并给出错误结论。现已改成：

- 归属判定**只用索引**（① tid ② pid），命中即零请求返回；
- 索引未命中时只做一次**存在性确认**，返回 `readable` 字段与说明，**不声称归属、不写档案**；
- 未命中的提示会区分两种情况：**索引过期**（先 `reindex`）还是**稿子确实不属于你**。

> 好消息：**用错账号读稿不会读出错的数据**（同一张稿，任何账号读到的都一样）。
> 所以"账号选错"的真实影响只体现在**列表/搜索**这类按账号隔离的接口上。

### 归属判定（只用索引）

| 级 | 依据 | 请求数 |
|---|---|---|
| ① | 链接的 **tid** ↔ 档案 `teams` | **0** |
| ② | 链接的 **pid** ↔ 档案 `projects` | **0** |
| ③ | 不存在"试读定归属"这一级（见上） | —— |

> ⚠️ 顺带记一条**空壳语义**：蓝湖对读不到的稿子**不报错**，而是静默返回
> `{ imageId, d2cUrl: null, versionLayoutData: null }`（不泄露存在性）。
> 实测：项目真+稿假 → 抛 `10009`；全假 UUID / 项目假+稿真 → **不抛错，返回空壳**。
> 判定"能不能读"必须看**有没有真实数据**，不是看有没有抛错。见 `isReadableDetail()`。

**未命中也是有价值的信息**：直接告诉你"这个团队不在你配置的 N 个账号里，可能要加账号"，
比笼统的 `Image not exist` 有用得多。

### 用法

```bash
# 账号管理
node lanhu.mjs accounts                                            # 列：公司/团队/项目/有效期/默认
node lanhu.mjs accounts --add --alias acme --company "Acme" --clipboard   # 贴 Cookie，自动建索引
node lanhu.mjs accounts --default acme
node lanhu.mjs accounts --reindex [别名]                            # 重建索引
node lanhu.mjs accounts --remove other

# 判断一张稿该用哪个账号（零请求优先）
node lanhu.mjs who --url "https://lanhuapp.com/web/#/item/project/detailDetach?tid=…&image_id=…"
```

工具侧：
- `lanhu_accounts`（action: list / add / remove / set-default / reindex）
- `lanhu_who`（贴链接判归属）
- **其余所有工具都带一个可选的 `account` 参数** —— 不给就自动按链接 tid 判定，再退到默认账号
- 于是贴链接读稿**不用管账号**：`lanhu_who` 查一次，读稿时带上 `account` 即可（或直接用默认账号）

面板：「账号」Tab 是**列表 + 点一下展开细节**：公司 / 团队 / 项目 / Cookie 打码 / 有效期 / 索引时间，
展开后可直接「设为默认 / 重建索引 / 更新 Cookie / 删除」；顶部「+ 添加账号」贴 Cookie 即可。

### 索引与保鲜

- **建索引成本** = 1 次 `listTeams` + 每团队 1 次 `listDirectory`；实测单团队账号约 3 秒；
- **探活顺手同步**：`checkAuth` 已经拿到 team 列表，于是每次探活都会把 `teamId → 账号` 的映射同步回档案（**零额外请求**）；
- **探测命中回填**：③ 路径命中后会把该项目写进索引，下次就是零请求；
- **过期提示**：索引超过 7 天（`INDEX_STALE_DAYS`）视为可能过期，判定未命中时会提示先 `reindex`。

### 兼容性（现有配置零改动）

- 没配置账号时，行为与从前**完全一致**（退回 `~/.dsh/lanhu/cookie`）；
- `--cookie` / `$LANHU_COOKIE` / `$LANHU_COOKIE_FILE` 优先级**不变**（显式永远最高）；
- 指定了不存在的账号会**明确报错**，绝不静默换账号（用错账号的权限读稿会得到莫名其妙的 `Image not exist`）；
- `LANHU_HOME` 可覆盖数据目录（自检据此隔离到临时目录，绝不碰真实账号）。

## 使用记录

面板「记录」Tab，或：

```bash
curl "http://127.0.0.1:3080/lanhu/log?limit=20"
cat ~/.dsh/lanhu/usage.jsonl | tail -20      # 落盘（JSONL，跨重启可追溯）
```

- 覆盖**所有工具**（`tool()` 构造点统一埋点）与面板读取（`panel:preview`）；
- **绝不记录 Cookie 明文** —— 参数走白名单，`cookie` / `input` 一律不入日志；
- 写盘失败只告警一次，永不影响工具调用。

## CLI

`lanhu.mjs` 零依赖，命令面与工具一一对应：

```bash
node lanhu.mjs auth
node lanhu.mjs teams
node lanhu.mjs projects --team <teamId>
node lanhu.mjs designs  --project <projectId>
node lanhu.mjs sectors  --project <projectId>
node lanhu.mjs search   --team <teamId> --keyword 示例设计稿
node lanhu.mjs read     --project <id> --image <id> --format summary
node lanhu.mjs blocks   --url "<蓝湖链接>"        # 块级清单（也可 --project/--image）
node lanhu.mjs blocks   --url "<链接>" --kind card,pill --min-width 60
node lanhu.mjs log      --limit 20                # 使用记录
node lanhu.mjs accounts                           # 多账号：列/加/删/切默认/重建索引
node lanhu.mjs who      --url "<蓝湖链接>"         # 判定这张稿属于哪个账号（零请求优先）
node lanhu.mjs slices   --project <id> --image <id> --out ./assets/lanhu
node lanhu.mjs verify   --project <id> --image <id> --page http://localhost:5173/
node lanhu.mjs cookie   --set "<完整 Cookie>"
```

通用选项：`--cookie <串>`、`--json`。

---

## Cookie 管理

**读取优先级**：`--cookie` > `$LANHU_COOKIE` > `$LANHU_COOKIE_FILE` > `~/.dsh/lanhu/cookie` > `~/.lanhu/cookie`

- 目录 `700` / 文件 `600`
- **绝不进 git、绝不回显完整串**（日志只留前 8 位）
- `user_token` 是 JWT，可解出 `exp` 做到期预警
- **必须整串 Cookie**：只给 `user_token` 会被判 30001（需要 `PASSPORT` + `user_token`，会话与 WAF 票也建议带上）

### 失效时怎么更新（不用手工抠串）

**浏览器里右键请求 → Copy as cURL → 把整段贴进来即可**，会自动解析出 Cookie：

```js
lanhu_cookie_set { cookie: "<粘贴整段>" }              // 解析 + 校验 + 落盘
lanhu_cookie_set { cookie: "<粘贴整段>", dryRun: true } // 只解析，先确认对不对
```

命令行同样支持（macOS 上 `--clipboard` 配合 Copy as cURL 是一步到位）：

```bash
node lanhu.mjs cookie --clipboard            # 读剪贴板（macOS pbpaste）
node lanhu.mjs cookie --stdin                # 读管道
node lanhu.mjs cookie --set "<粘贴内容>"      # 直接给
node lanhu.mjs cookie --clipboard --dry-run  # 只看解析结果，不写入
```

支持的粘贴形态（7 种，实测均逐字还原）：`curl -b '...'`、`curl -H 'cookie: ...'`、bash 续行 `\`、cmd 续行 `^`、`Cookie: ...` 请求头、`"Cookie" = "..."` 赋值、裸 Cookie 串。

解析纪律：必须**同时含 `user_token=` 与 `PASSPORT=`** 才算命中 —— 半截串当场拒绝（写进去也只会报 30001），并提示怎么重新复制。

---

## 与需求书的偏差（全部为实测结论）

需求书部分字段来自加工后的样本，与真实响应不一致。以**实测**为准：

| 需求书 | 实测 |
|---|---|
| 团队响应 `{teamId, name, role, isOwner, memberNum}` | `result:[{id, name, member_num, cloud_type, role.roleCode}]` |
| 图层样本 `{type:"text", x, y, w, h, fontSize, color}` | Figma 原始格式：`type` 是 `textLayer`/`shapeLayer`/`groupLayer`/`symbolInstence`/`symbolMaster`；坐标在 `frame`/`realFrame` 的 `{left, top, width, height}`；文本在 `text.style.content` + `text.style.font` |
| "颜色浮点脏值需 `Math.round`" | 不是脏值——是**归一化到 0..1**（`type: "percentage"`）。直接 `Math.round` 会得到 `#010101`；必须先 `×255`（或解析现成的 `color.value` 字符串） |
| 稿 A「156 层」 | **334 个节点**（59 个文本层） |
| 分组枚举不到需走搜索兜底（坑 1） | `project_sectors` 确实返回空数组，但 **`project/images` 不需要 sector 就能列出全部稿子**，兜底非必需 |
| `json_url` 可能是 GBK（坑 7） | 本样本 `content-type` 明确是 `charset=utf-8`、零乱码；**GBK 回退仍保留**，但不作为默认路径 |
| "defineTool 非必需，直接给对象即可" | ❌ 简写 `parameters: { name: {...} }` **只有套 `defineTool` 才合法**；裸对象必须给标准 JSON Schema（`required: []` 数组形式），否则注册期抛错 |
| 切图接口"本文未给路径" | 无需额外接口：图层树顶层 `assets[]` 就是全部切图 URL，直接下载即可 |
| API 里稿子尺寸 | `project/images` 给 187.5×448，图层树 `artboard.frame` 给 **375×896**（2 倍关系）。**以图层树为准** |

## 块级比对（P0 后半）

`lanhu_verify_blocks`：把设计稿里**每个可见块**与页面元素逐一比对**六项属性**，输出四态报告。

```bash
# CLI 还没加子命令，先用工具或面板：
lanhu_verify_blocks { pageUrl: "http://localhost:5173/", url: "<蓝湖链接>", target: "mini" }
```

### 四态

| 态 | 含义 |
|---|---|
| ✅ 完全匹配 | 数值一致 |
| 🟡 容差内 | 在容差范围内，或**视觉等价**（如设计稿 38px 与页面 14px 在 26px 高的按钮上都渲染为全圆）——会说明"若要照抄数值改 76rpx" |
| ❌ 不匹配 | 超出容差，给**可直接抄的建议改法**（含目标端单位） |
| ⚪ 无法比对 | 页面上找不到对应元素（映射失败**本身就是问题**，单列出来） |

### 元素映射三级

| 级 | 依据 | 覆盖 |
|---|---|---|
| ① | 页面 `[data-lanhu="块名"]` 标注 | 最准，需埋点 |
| ② | 文本内容完全相等 | 文本块 |
| ③ | **几何最近邻兜底** | **头像、卡片背景、分割线**这些无文本块唯一的出路 |

容差（`BLOCK_TOLERANCE`）：圆角 ±1px、大小 ±2px、字号 ±1px、几何匹配距离 ≤28px、色差（redmean 近似）≤14。

### 实测：故意埋的错全部被抓出

拿一张真实稿（161 块）对一个**故意做错**的页面：

```
| 块                       | 属性       | 设计稿                            | 页面     | 建议改法                                    |
| Footer - FixedBottomBar | border     | #e2e8f0 1px top(单边＝分割线)      | 无边框   | 补上 border-top: 1px solid #e2e8f0          |
| 大标题                   | font-size  | 16 → 32rpx                        | 14px     | 改成 font-size: 32rpx                        |
| Contact Button          | border-radius | 38(全圆) → 76rpx                | 14px(全圆) | 🟡 视觉一致；若要照抄数值改 76rpx            |
```

**案例 2（分割线整条丢失）第一次能被自动抓出来了** —— 这是本方案 P0 的核心目标。
做对的块（卡片、chip、标题）全判 ✅，没错报。

### 几个踩过的坑（都写进代码注释了）

1. **坐标系**：块的坐标**本来就是相对画板的**（`flattenArtboard` 注释实测过：画板 left=-10279，子层 left=155.5）。
   我一开始想当然又减了一次画板原点，结果 `16` 变成 `10295`，**全部几何匹配失效**。
2. **噪声范围**：`iPhoneX` 只是设计稿的**设备外框**，里面的导航/标题/内容**全是真实 UI**。
   早期判据"路径里有 iPhoneX 就算碎片"把「大标题」误排除在比对之外 —— 现在只屏蔽 `状态栏 / Home Indicator` 这类系统 UI。
3. **文本层的 `fills` 是文字颜色**（Figma 里文字色就是 fill），不是底色。不排除它会把文字色当背景色，报"设计稿有底色、页面没有"。
4. **文本块的尺寸是信息项**：Figma 文本框宽高 ≠ 浏览器渲染盒（实测 64×52 的文本框对应 56×20 的渲染盒），
   严格比会每条文本都假 ❌、真问题被淹没。只有差到离谱才判 ❌。
5. **一个元素可以同时是容器块与文本块的落点**：`<div class="chip">正常</div>` 这种写法很常见，
   用一个 used 集合会让后到的块永远匹配不上（实测 Contact Button 就这样变成 ⚪）。现在按用途分开计数。
6. **大块优先 + 尺寸比例约束**：按钮内部的小图元会先抢走按钮元素。
   匹配按面积降序、且尺寸差 4 倍以上不认，避免"图标占了按钮的位置"。
7. **块不能没有名字**：无名的块在报告里用「类型 + 尺寸」兜底，免得出现空白行认不出来。

## 本地自检

```bash
node test/selfcheck.mjs          # 73 项，纯离线、秒级
node test/selfcheck.mjs --json   # 机器可读
```

覆盖四块**最容易静默坏掉**的地方：链接解析（hash 路由）、参数校验（接错层会一个字段都拦不住）、
块级模型分类、工具定义形状。改完代码先跑它，再跑技能层的 `selftest.mjs`。

## 零依赖的取舍：自己实现 defineTool 替身

插件必须**零外部依赖**（`link:` 安装下 `import '@deepseek-ai/dsh-tools'` 解析不到，
而那会让**整棵插件树加载失败、GUI 起不来**——这是实测踩过的坑）。
所以 `lib/index.js` 里用一个本地 `tool()` 顶替官方 `defineTool`。

官方 `defineTool` 做**两件事**，我们起初只做了一件：

| | DSL → 标准 JSON Schema | execute 前按 schema 校验参数 |
|---|---|---|
| 官方 `defineTool` | ✅ | ✅ 违反时抛 `ToolArgsError` |
| 本插件 `tool()` | ✅ | ✅ **已补齐**（`validateJsonSchemaValue` + `ToolArgsError`） |

补充说明：

- 官方实现（`dsh-tools/lib/index.js`）是：
  `const validate = (args) => validateJsonSchemaValue(parameters, args, "")` →
  `if (violations.length > 0) throw new ToolArgsError(violations)`。本插件复刻了这套语义；
- 官方那套是**迭代式**（防深递归），本插件用递归就够——工具参数不会深；
- 覆盖的关键字：`type` / `required` / `properties` / `additionalProperties` / `items` / `enum`，
  外加 lossless JSON 检查（`undefined` / `NaN` / `Infinity` / `-0` 都不合法）。
  报错风格对齐官方（`"路径" must be ...` 的引号形态，文案用中文），精确到字段：
  `- "minWidth" 的类型应为 integer，实际是 string`。

> ⚠️ **一个实测踩到的坑**：校验必须用**编译后**的标准 JSON Schema。
> 原始 DSL 里必填是每个属性上的 `required: true`，而标准 schema 里是根部的 `required: [...]` 数组——
> 拿 DSL 去校验会**静默全过**（一个字段都拦不住，实测就是这样漏掉的）。
> 所以 `tool()` 里 `paramSchema` 只编译一次，校验与注册共用同一个对象。

## 已知限制

- `lanhu_verify_spec` 需要一个能驱动的浏览器：首选 **puppeteer-core + 系统 Chrome**，其次 Playwright。两者都没有时**降级**为 CSS 声明级静态比对，并明确标注降级原因，不会 attempt-and-fail。
- 自动映射优先用页面上的 `data-lanhu` 属性；没有标注时**按设计稿文本自动匹配叶子节点**，所以一般的页面（含 H5 hash 路由）开箱即可比对，不必先埋点。显式 `selectors` 仍然可选。
- 图层树坐标是**相对画板原点**的（已验证），跨层级嵌套元素的 DOM 比对可能需自行换算。
- 切图按内容哈希去重，**不保留图层名与文件的对应**（蓝湖 `assets[]` 本身不带名字）。
- puppeteer-core 走的是系统 Chrome，**页面渲染结果受本机 Chrome 版本影响**；设计稿验收报告首行会写明实际使用的引擎与浏览器路径，便于追溯。

## 安全与合规

- Cookie 即用户登录态：明文只落本地 `600` 文件，不写日志、不进 git、不回显。
- 切图 / 设计稿数据可能含公司业务信息，落盘目录默认排除在 git 外（**记得把 `assets/lanhu/` 加进 `.gitignore`**）。

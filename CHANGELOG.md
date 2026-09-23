# Changelog

> dsh-lanhu 的改动史（新的在上）。**功能与用法请看 [README](README.md)** —— 这个文件只记「改了什么、为什么改」。
>
> 每条都来自真实使用反馈与实测复现；括号里的日期是修复落地的日期。

## 0.1.1 —— 修一个静默 bug：`lanhu_read_design` 有三个参数收不到（2026-09-21）

| 参数 | schema 声明 | 工具 execute 实际传 | CLI `lanhu read` |
|---|---|---|---|
| `region` / `minWidth` | ✅ | ✅ | ✅ |
| **`limit`** | ✅（"要看全量就传大一点（如 900）"） | ❌ **丢** | ✅ |
| **`mapBox`** / **`toBox`** | ✅（"把坐标映射到目标坐标系"） | ❌ **丢** | ✅ |

`readDesign` 的 region 分支一直会读这三个参数，只是插件工具这条链没往下去传。
**后果全是静默的**：agent 传 `mapBox/toBox` 拿到未映射的表且不报错；传 `limit: 900` 仍只回 80 层。
**CLI 一直是对的** —— 只有工具坏，所以这个 bug 藏了很久（用 CLI 验证的人永远撞不到）。

修复：`lib/index.js` 的 tool execute 补齐 `limit` / `mapBox` / `toBox`。

> **验证**：仓库自带离线自检 257 ✅ / 0 ❌；已重启 `dsh web` 后经**真实工具链**复验 ——
> `limit: 3` 只回 3 行（修复前恒为 80）、`mapBox`+`toBox` 真的产出「映射 x,y / 映射 w×h」列与 `sx/sy` 说明、
> 只给一个参照框时**明确报错**而非静默不映射。

> **一条记录：同期做过又撤掉的东西。**
> 曾在此基础上加过面板第 4 个 Tab「区域坐标」（含 Host 路由 `/lanhu/region`、`regionTable` 结构化输出）。
> 撤掉的依据是**真实调用记录**：`panel:preview`（块级清单）10 次，而新增的 `panel:region` 4 次**全是开发者自测**，
> 人工调用 0 次 —— 坐标映射的消费者是写代码的一方（通常是 agent），不是盯着面板看的人。
> 同时发现面板里早已躺着一条**死路由** `/lanhu/verify-blocks`（后端与 `recordUsage` 都写好了，
> 注释写着"面板『块级』Tab 的『与页面比对』按钮用"，但那个按钮从来没做，`panel:verify-blocks` 调用 0 次）。
> **教训：给面板加东西前先看调用记录；有后端没前端的路由要么接上、要么删掉，别留着当"以后再说"。**

## 面板实机审计修复（2026-09-21）

起因是「面板可以更新一下」。没凭感觉改，先做了一次**离线渲染审计**：真 React 18 +
官方 `dsh-client-ui-theme` 的 **163 个真实令牌**（浅/深两套）+ 从正在跑的插件抓的真实接口数据
（含真跑一次 `/lanhu/preview`）渲染出面板逐项核对。

> 之所以能这么查：`dsh web` 的会话 token 只在进程内、不落盘，401 进不去真实 GUI。
> 审计页在 `/tmp/lanhu-audit/`，截图在 `~/.dsh/lanhu/audit-20260921/`。

八条里**三条属于"静默失效"型** —— 不报错，只是看起来怪，靠读代码看不出来。

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| Q1 | **深色主题下主按钮「读取块级清单」变成一块空白药丸** | `Btn` 拿 `brand-primary` 当品牌色做底，又写死 `color:'#fff'`。该令牌浅色下是近黑 `#0f1115`、**深色下是近白 `#f9fafb`** → 白底白字，实测对比度 **1.05:1** | 文字改用官方配对的 `--dsw-alias-label-primary-foreground` → 浅色 18.9:1 / 深色 **18.1:1** |
| Q2 | 三个令牌名**根本不存在**，永远走 fallback | `bg-sunken`（真名 `bg-layer-1`）、`brand-bg`（无此令牌）、`state-warning-primary`（**少个 `ing`**，真名 `state-warn-primary`） | 逐个改回真名；`brandSoft` 改用官方表达"已选中"的 `bg-module-platform` |
| Q3 | 深色下整块面板是"中灰板" | `surface` 用了 `bg-overlay` —— 该令牌深色 = `bluish-700` = `#61666b`，比应用底色 `#151517` **亮 17 倍** | 改用官方菜单别名 `--dsw-specific-menu`（= `bg-layer-3`）→ 深色 `#353638`、浅色 `#ffffff` |
| Q4 | 浮层没有对话框语义 | 只给了入口 `aria-expanded`；面板本身没有 `role`/`aria-modal`，也不响应 Esc | 补 `role="dialog"` + `aria-modal` + `aria-label`；Esc 关闭；打开移焦、关闭还焦（挂在 effect 上，可回收） |
| Q5 | 关闭按钮命中区 14×16px | 只给了 `font-size`，没给盒尺寸 | 补到 **26×26**（WCAG 2.5.8 要求 ≥24×24）+ hover 底色 |
| Q6 | URL 输入框把长链接切断 | `rows:2` 固定；且 textarea 默认只在空白处折行，蓝湖链接没有空格 → 横着溢出 | 加 `break-all` + **按内容自动增高**（封顶 132px 再转滚动）；实测已不截断 |
| Q7 | 双层滚动条 | 面板内容区自己滚（627/723），块级列表又套一层 `maxHeight: 38vh` 独立滚（342/3071） | 内层不再滚，**只留内容区一个滚动容器**（实测滚动容器数 = 1）。代价：筛选栏会随列表滚走 |
| Q8 | 删除账号点一下就没；「更新 Cookie」带着上一个账号的草稿 | 无二次确认；表单只预填别名，没清 Cookie | 删除改**两段式**（首次点击变红「确认删除」，**实测不发写请求**）；更新表单清空 Cookie 草稿、保留别名与备注 |

**踩坑记**（Q7）：最初写成「各 Tab 根做 flex 列、列表 `flex:1`」，结果 Textarea 这类表单控件在 flex 列里被压成 **12px** 高。
→ **在 flex 列里放 form 控件必须显式给 `flex:none`**。最终选了"只留一个滚动容器"的更稳做法。

**验证**：桩测 `scripts/selftest.mjs` 16 ✅ / 0 ❌；离线渲染审计前后对比截图见 `~/.dsh/lanhu/audit-20260921/`。
⚠️ **未做真机验证**（进不去真实 GUI），需要刷新页面后人工点一遍。

**已知但未实施**（下一批候选）：块级行/详情加复制、复制为 Markdown、列表虚拟化（60 行 = 575 节点）、
面板位置自愈（resize/侧栏折叠后会飘）、图标语义、分类色跟随主题、记录 Tab 参数展开。

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

实测（某大屏，711 层稿）：全稿 **55 层**多段渐变，其中就有

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
| 真稿实测（某大屏，711 层） | 三张表新列齐全；多段渐变 55 层；`Hotspot` 三段青色、地图辉光两段可直接读到 |
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

**实测（某大屏，46 张切图）**

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
--map-box "659.32,120.58,1271.64,651.53"   # 设计稿参照框（本例 = 地图区域总 bbox）
--to-box  "4,4,442.3,480.3"                # 目标参照框（本例 = 本地 SVG 内容 bbox）
```

> ⚠️ **必须按两个参照框各自独立缩放**（x、y 各一个比例），**不要用单一 scale 等比** ——
> 实测两个框长宽比 1.152 vs 0.921（差 25%），等比会让纵向整体对不上。
> 未传参照框时**不加列**，既有输出不受影响。

实测（同一稿）：`某热点 / Hotspot` 设计稿 `1095.44,323.1` → **映射 `316.18,185.67`**（sx=0.716、sy=0.897）。


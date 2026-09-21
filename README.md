# dsh-lanhu

**让 AI 直接「读蓝湖设计稿」** —— 把设计稿解析成精确的结构化数据（坐标 / 色值 / 字号 / 字重 / 字体族 / 行高字距 / 圆角 / 描边 / 渐变 / 文本 / 图层透明度），喂给写前端代码的 agent。

> **没有它**：AI 写页面前只能看设计稿**截图**，色值和字号靠视觉估算（OCR 小字经常错）。
> **有了它**：设计稿的真实数值直接进上下文 —— 等于把「设计标注」喂给模型；还能反过来拿它**自动验收**页面还原度。

适用于 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）Web GUI，需要 **Node ≥ 20**。自带 13 个原生工具 + 侧边面板 + CLI。

> ⚠️ **免责与数据说明**
>
> - 本插件是**第三方个人开发工具**，与蓝湖官方无关。它通过**你自己的**浏览器 Cookie 访问蓝湖 Web 端接口（非官方 API），接口变动可能导致失效。
> - Cookie 由你自行提供，**明文保存在本机** `~/.dsh/lanhu/cookies/<别名>`（权限 600），**不上传到任何地方**。请勿把 Cookie 提交进 git、贴进聊天或写进公开 issue。
> - 请遵守蓝湖的服务条款，仅用于**你有权访问的**设计稿；请勿用于未授权抓取或批量采集。
> - 本软件按 MIT 许可「按原样」提供，不附带任何明示或默示担保。

---

## 特性一览

| 能力 | 说明 |
|---|---|
| **13 个原生工具** | 参数带 schema 校验；不用拼 shell 命令调脚本 |
| **贴链接就行** | 不用手拆 `tid/pid/image_id`，**也不用知道稿子属于哪个账号**（自动判定，零请求优先） |
| **块级清单** | 把几百个图层收敛成「人一眼能核对」的块：六项属性 + **字体族** + **行高·字距** + **多段渐变全 stop** |
| **区域抠图 + 坐标映射** | 按 `y` 区间取值；能把设计稿坐标**直接映射**到你自己 SVG 的 viewBox（非等比，两套坐标系也能对） |
| **切图导出带 alpha 报告** | 每张图给 `尺寸 / mode / alpha 范围`，**半透明当场告警**（避免整屏发灰） |
| **两种验收** | 文本层逐字段比对 + 块级**四态报告**（含可直接抄的建议改法） |
| **侧边面板** | 块级 / 登录态 / 记录，三个 Tab，不用敲命令 |
| **多账号** | 一账号一套 Cookie；贴链接自动判归属（索引命中零请求） |
| **零运行时依赖** | 真机验收才需要 `puppeteer-core`（`optionalDependencies`，不装也能用） |
| **离线自检 257 项** | 秒级、零网络；改完代码先跑它 |

---

## 安装

```bash
# <plugin-dir> = 本仓库在你机器上的路径
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

## 30 秒上手

```bash
# ① 确认登录态
node lanhu.mjs auth

# ② 贴一条蓝湖链接，直接出块级清单（账号自动判定）
node lanhu.mjs blocks --url "https://lanhuapp.com/web/#/item/project/detailDetach?pid=…&image_id=…&tid=…"
```

在 DSH 会话里更简单 —— 直接把链接丢给 agent，它会调 `lanhu_read_blocks`。
**多账号、三级 id 查询、Cookie 归属，调用方一概不用管。**

---

## 工具（13 个）

| 工具 | 作用 |
|---|---|
| `lanhu_check_auth` | 探活登录态 + Cookie 有效期。**开工先跑这个** |
| `lanhu_list_teams` / `lanhu_list_projects` / `lanhu_list_designs` | 团队 → 项目 → 稿子 |
| `lanhu_search` | 全局搜索稿子 / 项目 / PRD |
| `lanhu_read_design` | **主工具**：图层树。`summary`（默认，紧凑文本）/ `full`（落盘 JSON）/ `tokens`（统计）；配 `region` 抠区域，配 `mapBox`+`toBox` 映射坐标 |
| `lanhu_read_blocks` | **块级清单**：卡片/胶囊/文本/图片/分割线/容器，每块六项属性 + 不透明 + 字体 + 行高字距。核对圆角/分割线/近似色**优先用它** |
| `lanhu_download_slices` | 下载切图 + `mapping.json`（含尺寸 / mode / alpha 范围） |
| `lanhu_verify_spec` | 文本层验收：`getComputedStyle` 逐字段比对（色值/字号/字重/**字体族**/圆角） |
| `lanhu_verify_blocks` | **块级比对**：每个可见块比六项属性 + 字体族，输出四态报告与建议改法 |
| `lanhu_who` | 判定一张稿属于哪个账号（零请求优先） |
| `lanhu_accounts` | 账号管理（list / add / remove / set-default / reindex） |
| `lanhu_cookie_set` | 更新 Cookie（**粘贴 `Copy as cURL` 整段即可**） |

---

## 读稿：三种视图

| 视图 | 用途 | 一句话 |
|---|---|---|
| **块级清单** `blocks` | 还原时最常看 | 几百个图层 → 一百多个「块」，每块带齐属性，还单独列出**分割线** |
| **区域表** `region` | 抠某个区块的图层（替代手写抠图脚本） | 内边距已按父子坐标算好；可加 `limit` 看全量 |
| **全量** `format=full` | 落盘 JSON，程序化消费 | 扁平数组，字段见下 |

### 三张表里"最容易漏"的列

数据层一直有、但以前**不打出来就等于不存在**的几项，现在都在表里：

| 列 | 含义 | 为什么要看 |
|---|---|---|
| **不透明** | 图层 `opacity`，**已累乘祖先链** | 半透明的"厚度层 / 底纹"漏读会被做成生硬实心块。注意它和填充色 `@xx%`（**填充 alpha**）是**两回事**，两者独立叠加 |
| **字体** | `font.family` 短名 | 一个封面用 3 种字体是常态；漏读就全站一个字体 |
| **行高·字距** | 形如 `22/0.5` | 排版还原的关键，缺失只能靠猜 |
| **底色/填充** | 多段渐变串成 `#a@18%→#b@10%`；只有描边的层标 `描边 #xxxxxx` | 渐变只打第一个 stop 是**最隐蔽**的坑：表格里"有颜色"，看着不缺信息 |

> 实测：某 1920×1080 大屏稿（711 层）全稿 **55 层多段渐变**、**48 层半透明** —— 不扫这两类直接开工会返工。

### 坐标映射（把设计稿坐标搬进你的坐标系）

```bash
lanhu read --project <pid> --image <iid> --region 170,680 \
  --map-box "659.32,120.58,1271.64,651.53" \   # 设计稿参照框
  --to-box  "4,4,442.3,480.3"                  # 目标参照框（如你的 SVG viewBox）
```

输出多两列「映射 x,y / 映射 w×h」。**x/y 各自独立缩放（非等比）** —— 两个坐标系长宽比不同也能对上。

---

## 验收：两种比对

| | `lanhu_verify_spec` | `lanhu_verify_blocks` |
|---|---|---|
| 粒度 | 文本层（按文本自动匹配页面元素） | **每个可见块** |
| 比什么 | 色值 / 字号 / 字重 / 字体族 / 圆角 | 六项属性 + 字体族 |
| 覆盖 | 文本密集页面 | 卡片 / 头像 / 分割线等**无文本块**也能比 |
| 降级 | 无浏览器时降级为 CSS 声明级静态比对 | **无降级**（必须真实渲染） |

### 四态怎么读

| 态 | 含义 |
|---|---|
| ✅ 完全匹配 | 数值一致 |
| 🟡 容差内 | 在容差内，或**视觉等价**（如设计稿 `38px` 与页面 `14px` 在 26px 高的按钮上都渲染为全圆）—— 会说明"若要照抄数值改 76rpx" |
| ❌ 不匹配 | 超出容差，给**可直接抄的建议改法**（含目标端单位） |
| ⚪ 无法比对 | 页面上找不到对应元素（**映射失败本身就是问题**，单列出来） |

**字体族判定刻意宽松**（页面 `font-family` 天生是一个栈）：设计稿字体出现在栈的**前 3 位**即通过；`X-Regular` ≡ `X`、`2.0` ≡ `2`、大小写与引号都归一。排太后判 🟡，栈里没有才 ❌ —— **宁可 🟡，不可假 ❌**。

### 元素映射三级（决定了哪些块能比）

| 级 | 依据 | 覆盖 |
|---|---|---|
| ① | 页面 `[data-lanhu="块名"]` 标注 | 最准，需埋点 |
| ② | 文本内容完全相等 | 文本块 |
| ③ | **几何最近邻兜底** | 头像、卡片背景、分割线这些**无文本块**唯一的出路 |

容差（`BLOCK_TOLERANCE`）：圆角 ±1px、大小 ±2px、纯文本 ±3px、字号 ±1px、几何距离 ≤28px、色差（redmean）≤14。

---

## 切图导出（含 alpha 报告）

```bash
node lanhu.mjs slices --project <pid> --image <iid> --out ./assets/lanhu
```

`mapping.json` 里**每张图**带：

```json
{
  "file": "cover-xxxx.png",
  "format": "png", "width": 7680, "height": 4320,
  "mode": "RGBA", "hasAlpha": true, "alphaRange": [132, 255]
}
```

顶层还有 `backgroundColor`（画板 fill，即**合成衬底色**）、`warnings`、`translucent`。

### ⚠️ 含 alpha 的图**不要直接转 JPG**

半透明 PNG 直接 `sips -f jpeg` 会丢 alpha → 半透明光丝变不透明、深色衬底消失、**整屏发灰**；
而图片查看器默认把半透明合到**白底**，看起来"浅浅的挺正常"，**肉眼查不出来**。

```python
from PIL import Image
im   = Image.open('切图.png').convert('RGBA')
base = Image.new('RGBA', im.size, (0x00, 0x46, 0x87, 255))   # ← backgroundColor
Image.alpha_composite(base, im).convert('RGB').save('bg.jpg', quality=82, optimize=True)
```

`mode: "vector"` 的是 **SVG**：直接引用或内联，**别栅格化**（会丢清晰度）。

---

## 侧边面板（三个 Tab）

侧栏底部「蓝湖」入口 → 浮层。面板与工具走**同一条数据通道**（Host 的 `/lanhu/*` 路由，仅本机可访问）。

| Tab | 干什么 |
|---|---|
| **块级** | 贴链接就出块级清单；类型筛选、关键词过滤、点行展开、单边边框（分割线）速查 |
| **登录态** | Cookie 来源 / 打码串 / **有效期** / 团队列表；粘贴 `Copy as cURL` 更新 |
| **记录** | 每次工具调用与面板读取的时间 / 工具名 / 耗时 / 结果摘要（内存 300 条 + 落盘 `usage.jsonl`） |

---

## 多账号（一个人多个公司 / 多套 Cookie）

**核心洞察：蓝湖链接里的 `tid` 就是团队 id，而一个团队只属于一个账号。**
所以只要每个账号存一份 `listTeams` 的结果，之后**看链接就能零请求定位该用哪个账号**（实测 2–45 ms）。

```bash
node lanhu.mjs accounts --add --alias acme --company "Acme" --clipboard  # 贴 Cookie，自动建索引
node lanhu.mjs who --url "<蓝湖链接>"                                     # 判归属（零请求优先）
```

**所有工具都带一个可选的 `account` 参数**，不给就自动按链接 `tid` 判定。结果末尾会写明用了哪个、怎么定出来的：

```
— 账号：another（自动判定 · index:teams）
```

### ⚠️ 蓝湖的权限边界（实测结论）

| 接口 | 是否按账号隔离 |
|---|---|
| `listTeams` / `listProjects` / `search` | ✅ 是 |
| **`imageDetail` / `listImages`（读稿）** | ❌ **不是** —— A 的 Cookie 能读到 B 团队下的稿 |

**这推翻了一种想当然的归属判定法**：早期实现会在"试读成功"时把稿子回填进索引并声称归属 —— 那是错的，会污染索引。
现在归属判定**只用索引**（`tid` → `pid`），未命中时只做存在性确认，**不声称归属**。

> 好消息：**账号选错不会读出错的数据**（同一张稿任何账号读到的都一样），影响只体现在**列表/搜索**这类按账号隔离的接口。

**空壳语义**：蓝湖对读不到的稿子**不报错**，而是静默返回 `{ imageId, d2cUrl: null, versionLayoutData: null }`。
判定"能不能读"必须看**有没有真实数据**，不是看有没有抛错。

---

## CLI

`lanhu.mjs` 零依赖，命令面与工具一一对应：

```bash
node lanhu.mjs auth
node lanhu.mjs teams / projects --team <id> / designs --project <id> / sectors --project <id>
node lanhu.mjs search   --team <teamId> --keyword <kw>
node lanhu.mjs read     --project <id> --image <id> [--format summary|full|tokens] [--region y0,y1] [--limit N] [--map-box … --to-box …]
node lanhu.mjs blocks   --url "<蓝湖链接>" [--kind card,pill] [--min-width 60] [--all]
node lanhu.mjs slices   --project <id> --image <id> [--out ./assets/lanhu]
node lanhu.mjs verify   --project <id> --image <id> --page http://localhost:5173/
node lanhu.mjs who      --url "<蓝湖链接>"
node lanhu.mjs accounts / log --limit 20 / cookie --set "<完整 Cookie>"
```

通用选项：`--cookie <串>`、`--json`。
⚠️ **CLI 参数用短名**（`--project` 不是 `--projectId`，`--map-box` 不是 `--mapBox`）；写错会被**静默忽略**。

---

## Cookie 管理

**读取优先级**：`--cookie` > `$LANHU_COOKIE` > `$LANHU_COOKIE_FILE` > `~/.dsh/lanhu/cookie` > `~/.lanhu/cookie`

- 目录 `700` / 文件 `600`；**不写日志、不进 git、不回显完整串**
- `user_token` 是 JWT（**非标准布局：`exp` 在第一段**），可解出有效期做预警

### 失效时怎么更新（不用手工抠串）

**浏览器里右键请求 → Copy as cURL → 整段贴进来**，会自动解析：

```bash
node lanhu.mjs cookie --clipboard            # 读剪贴板（macOS pbpaste）
node lanhu.mjs cookie --clipboard --dry-run  # 只看解析结果，不写入
```

支持的粘贴形态（实测 7 种）：`curl -b '...'`、`curl -H 'cookie: ...'`、bash 续行 `\`、cmd 续行 `^`、`Cookie: ...` 请求头、`"Cookie" = "..."` 赋值、裸 Cookie 串。
解析纪律：至少含 **`user_token=`** 才算命中（第二个账号可能没有 `PASSPORT`），半截串当场拒绝并提示怎么重来。

---

## 用好设计稿数据的几条经验

这个插件解决的是**「把设计稿说清楚」**；**「素材能不能用」仍然要靠你自己核对**。

1. **素材有问题，当场提出来，别默默绕** —— 切图里烤进了本应由代码渲染的静态内容（图标/文字/按钮）、
   尺寸与同组其它素材明显不一致、带 alpha 通道：这三种都先问，别自己想办法盖住（最耗时的返工就是这么来的）。
2. **接稿先扫三列**：「不透明」「字体」「行高·字距」，再确认渐变是完整的（带 `→`）——
   这两分钟能挡掉一整类"做出来才发现"的错误：半透明厚度层被做成实心、全站变成一个字体、多段渐变被压成纯色。
3. **核对"这个图层到底有没有切图"**：设计稿里是矢量的图层（`hasImage=false`）蓝湖**不会导出切图**，
   随便找个图标顶上，风格一眼就不对。
4. **换算基准显式写进样式注释头**（设计稿 375 → 750rpx？1920 → 实际屏宽），别让每个人心里各有一套。
5. **间距取值拿相邻块的坐标相减**，不要凭感觉写百分比；并且内部间隙要小于列间隙，别把关系写反。
6. **别信图片预览**：半透明 PNG 在查看器里默认合白底，看着"挺正常"，颜色其实已经错了 —— 看 `mode` 与 alpha 范围。

---

## 本地自检

```bash
node test/selfcheck.mjs          # 257 项，纯离线、秒级
node test/selfcheck.mjs --json   # 机器可读
```

覆盖最**容易静默坏掉**的地方：链接解析（hash 路由）、工具参数校验、块级模型分类、工具定义形状、
lossless JSON、CLI 入口守卫、图片元信息、字体族判定、坐标映射、输出完整性。
它跑在临时数据目录（`LANHU_HOME`），**绝不碰你的真实账号与 Cookie**。

> 自检里对每项能力都配了**正反例**（例如"父组可见 → 子层进表"和"父组隐藏 → 子层不进表"同时断言）——
> 只测"该排除的排除了"会假通过。

---

## 已知限制

- **验收需要浏览器**：首选 `puppeteer-core` + 系统 Chrome，其次 Playwright；
  都没有时 `verify_spec` 降级为静态比对，`verify_blocks` **没有降级路径**（会如实说明）。
- **切图不保留图层名对应**：蓝湖 `assets[]` 本身不带名字；按名字取图要靠 `hasExportImage` 标记自己对应。
- **块数是浮动的**：随解析改进会变（补上"`widths` 全 0 但有总宽"的边框后，同稿从 161 涨到 168）——
  它是"有多少东西要核对"，**不是**稳定性指标，别拿来做回归阈值。
- **图层坐标是相对画板的**（已验证），跨层级 DOM 比对可能需要自行换算。
- 真机验收的渲染结果**受本机 Chrome 版本影响**；报告首行会写明实际引擎与浏览器路径，便于追溯。

---

## 安全与合规

- Cookie 即登录态：明文只落本地 `600` 文件，不写日志、不进 git、不回显。
- 切图 / 设计稿数据**可能含公司业务信息**，落盘目录记得加进 `.gitignore`（本项目默认忽略 `assets/`）。
- 请只读取你**有权访问**的设计稿，遵守蓝湖服务条款。

---

## 变更记录

改动史（每条都来自真实反馈 + 实测复现）见 **[CHANGELOG.md](CHANGELOG.md)**。

## License

[MIT](LICENSE) © 2026 linyuqiu

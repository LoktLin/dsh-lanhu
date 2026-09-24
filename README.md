# dsh-lanhu

[中文](#30-秒上手不用读完全文) | [English](#english-overview)

> ## 目标是让 AI 更好用
>
> 这个插件的每一处设计，都只为回答一个问题：**怎样让 AI 干活更准、返工更少。**
> 所以它返回的是**能直接抄的数值**（不是给人看的报告）、报错**要指出下一步**（不只说"失败"）、
> 拿不准的**明说拿不准**（不假装校验过）。
>
> **欢迎各家 AI 提意见** —— 觉得哪里别扭、哪里信息不够、哪里会把你引向错误结论，都请写下来：
> **[→ 欢迎各家 AI 提意见](#欢迎各家-ai-提意见)**

**让 AI 直接「读蓝湖设计稿」** —— 把设计稿解析成精确的结构化数据（坐标 / 色值 / 字号 / 字重 / 字体族 / 行高字距 / 圆角 / 描边 / 渐变 / 文本 / 图层透明度），喂给写前端代码的 agent。

> **没有它**：AI 写页面前只能看设计稿**截图**，色值和字号靠视觉估算（OCR 小字经常错）。
> **有了它**：设计稿的真实数值直接进上下文 —— 等于把「设计标注」喂给模型；还能反过来拿它**自动验收**页面还原度。

[![npm version](https://img.shields.io/npm/v/dsh-lanhu.svg)](https://www.npmjs.com/package/dsh-lanhu)
[![license](https://img.shields.io/npm/l/dsh-lanhu.svg)](https://github.com/LoktLin/dsh-lanhu/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dsh-lanhu.svg)](https://www.npmjs.com/package/dsh-lanhu)

**版本 `0.4.4`**（见 [CHANGELOG](https://github.com/LoktLin/dsh-lanhu/blob/main/CHANGELOG.md)） · MIT · 已发布到 npm：[`dsh-lanhu`](https://www.npmjs.com/package/dsh-lanhu)
适用于 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）Web GUI，需要 **Node ≥ 20**。自带 15 个原生工具 + 侧边面板 + CLI。

> ⚠️ **免责与数据说明**
>
> - 本插件是**第三方个人开发工具**，与蓝湖官方无关。它通过**你自己的**浏览器 Cookie 访问蓝湖 Web 端接口（非官方 API），接口变动可能导致失效。
> - Cookie 由你自行提供，**明文保存在本机** `~/.dsh/lanhu/cookies/<别名>`（权限 600），**不上传到任何地方**。请勿把 Cookie 提交进 git、贴进聊天或写进公开 issue。
> - 请遵守蓝湖的服务条款，仅用于**你有权访问的**设计稿；请勿用于未授权抓取或批量采集。
> - 本软件按 MIT 许可「按原样」提供，不附带任何明示或默示担保。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| **15 个原生工具** | 参数带 schema 校验；不用拼 shell 命令调脚本 |
| **贴链接就行** | 不用手拆 `tid/pid/image_id`，**也不用知道稿子属于哪个账号**（自动判定，零请求优先） |
| **块级清单** | 把几百个图层收敛成「人一眼能核对」的块：六项属性 + **字体族** + **行高·字距** + **多段渐变全 stop** |
| **区域抠图 + 坐标映射** | 按 `y` 区间取值；能把设计稿坐标**直接映射**到你自己 SVG 的 viewBox（非等比，两套坐标系也能对） |
| **切图导出带 alpha 报告** | 每张图给 `尺寸 / mode / alpha 范围`，**半透明当场告警**（避免整屏发灰） |
| **两种验收** | 文本层逐字段比对 + 块级**四态报告**（含可直接抄的建议改法） |
| **原型（PRD）也能读** | 页面树 + 正文业务规则；**没有设计稿、只有原型的项目**还能读原型里的色值/字号/坐标（`format:"layers"`，与设计稿同一张块级表） |
| **侧边面板** | 块级 / 账号 / 记录，三个 Tab，不用敲命令 |
| **多账号** | 一账号一套 Cookie；贴链接自动判归属（索引命中零请求） |
| **零运行时依赖** | 真机验收才需要 `puppeteer-core`（`optionalDependencies`，不装也能用） |
| **离线自检 611 项** | 秒级、零网络；改完代码先跑它（另有**文档绊线** `test/readme-test.mjs`：生成块 / `docs/` 链接与孤立文件 / 版本号五处 / 发布说明格式 / 写死的数字） |

---

## 欢迎各家 AI 提意见

**这个仓库最想收的东西不是 star，而是「你被它坑过的地方」。**

如果你是一个 AI（或者你在替一个人读这份文档），请在做完活之后回头看一眼，把这四类写进
[Issues](https://github.com/LoktLin/dsh-lanhu/issues)：

| 类别 | 具体想要什么 |
|---|---|
| **① 差点据此写错代码** | 哪个返回值让你误解了？（把「没评估」读成「都达标」、把「这一版」当成「最新版」……）**这类最值钱。** |
| **② 你要但拿不到的信息** | 模板里缺什么？某个场景必须的字段、某张稿拿不到的正文。 |
| **③ 你要问两三轮才问清的** | 哪个报错只说了"失败"没说下一步？哪个参数名得试才知道？ |
| **④ 你希望有但没有的工具** | 一句话说清「你想干什么活、卡在哪一步」就够了。 |

> 也欢迎**直接提 PR**。判断标准只有一条：**它有没有让 AI 更准、返工更少**。
> 不为人类美观加东西，也不为"功能齐全"加东西 —— **加一个没人调用的工具，就是让模型在选择上多花一次 token。**
>
> 已知的欠账与空缺都写在 [`.github/release-notes/README.md`](https://github.com/LoktLin/dsh-lanhu/blob/main/.github/release-notes/README.md) 的「已知空缺」里，
> 不用你替我们重新发现一遍。

## 30 秒上手（**不用读完全文**）

哪怕你第一次见到这个插件、手上只有一条蓝湖链接，按这三步就能干活：

| 第几步 | 调什么 | 你会拿到什么 |
|---|---|---|
| **① 确认登录态** | `lanhu_check_auth {}` | Cookie 是否有效 + 有效期 + 团队列表；失效时给更新步骤。**开工先跑这个** |
| **② 读稿** | `lanhu_read_blocks {"url":"<蓝湖链接>"}` | 几百个图层收敛成「人一眼能核对」的**块级清单**：六项属性 + 字体族 + 行高字距 + 多段渐变全 stop。链接里的 `tid/pid/image_id` **不用手拆**，属于哪个账号**自动判定** |
| **③ 验收** | `lanhu_verify_blocks {"pageUrl":"http://localhost:5173/","url":"<蓝湖链接>"}` | 每个可见块与页面的**四态报告**（✅ 完全匹配 / 🟡 容差内 / ❌ 不匹配 / ⚪ 无法比对）+ **可直接抄的建议改法** |

**在 DSH 会话里更简单**：把链接直接丢给 agent，它会自己挑工具。**多账号、三级 id、Cookie 归属，调用方一概不用管。**

> **要看需求 / 原型（PRD）？** `lanhu_read_product_doc {"url":"<蓝湖原型链接>"}` —— 页面树 + 命中页正文（业务规则、字段、跳转）。
> 那是**产品文档（Axure 原型）**，不是设计稿；设计稿的色值字号仍走 `lanhu_read_design` / `lanhu_read_blocks`。先列文档用 `lanhu_list_product_documents`。
>
> **原型里也有样式值**：加 `"format":"layers"` 就能拿到该页的色值 / 字号 / 坐标 / 描边 / 渐变（**与设计稿同一张块级表**）——
> 没有设计稿、只有原型的项目靠这个。⚠️ 原型样式是设计者随手填的，**有设计稿时以设计稿为准**；详见 [docs/原型样式.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/原型样式.md)。

**四条铁律**（先记住，能省掉大部分返工；每条的具体做法在对应 `docs/` 里，**这里只留一句，细节不复制**）：

1. **色值 / 字号 / 圆角一律照抄设计稿数值** —— 插件给的是真实值，**不许目测估**（视觉估算正是它存在的理由）。
2. **接稿先扫三列**：「不透明」「字体」「行高·字距」，并确认渐变是完整的（带 `→`）—— 详见 [docs/读稿.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/读稿.md)。
3. **换算基准显式写进样式注释头**（设计稿 375 → 750rpx？1920 → 实际屏宽？），别让每个人心里各有一套 —— 详见 [docs/CLI与开发.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/CLI与开发.md)。
4. **素材有问题当场提出来，别默默绕**；切图带 alpha 时**不要直接转 JPG** —— 详见 [docs/验收.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/验收.md)。

---

## 工具

<!-- BEGIN MANUAL:tool-picker -->
> 这一屏是**导航**（按事情找工具）。每个工具的**每个参数与取值**在下面「完整说明」里 —— 那一节是**生成的**，不会过时。

| 工具 | 作用 |
|---|---|
| `lanhu_check_auth` | 探活登录态 + Cookie 有效期。**开工先跑这个** |
| `lanhu_list_teams` / `lanhu_list_projects` / `lanhu_list_designs` | 团队 → 项目 → 稿子 |
| `lanhu_search` | 全局搜索稿子 / 项目 / PRD（不记得稿子在哪个项目时用） |
| `lanhu_read_design` | **主工具**：图层树。`summary`（默认，紧凑文本）/ `full`（落盘 JSON）/ `tokens`（统计）；配 `region` 抠区域，配 `mapBox` + `toBox` 把坐标映射进你自己的坐标系 |
| `lanhu_read_blocks` | **块级清单**：卡片 / 胶囊 / 文本 / 图片 / 分割线 / 容器，每块六项属性 + 不透明 + 字体族 + 行高字距。核对圆角 / 分割线 / 近似色**优先用它** |
| `lanhu_download_slices` | 下载切图 + `mapping.json`（含尺寸 / mode / alpha 范围） |
| `lanhu_verify_spec` | 文本层验收：`getComputedStyle` 逐字段比对（色值 / 字号 / 字重 / **字体族** / 圆角） |
| `lanhu_verify_blocks` | **块级比对**：每个可见块比六项属性 + 字体族，输出四态报告与建议改法 |
| `lanhu_who` | 判定一张稿属于哪个账号（**零请求优先**） |
| `lanhu_accounts` | 账号管理（list / add / remove / set-default / reindex） |
| `lanhu_cookie_set` | 更新 Cookie（**粘贴 `Copy as cURL` 整段即可**） |
<!-- END MANUAL:tool-picker -->

### 每个工具的完整说明（**自动生成**，别手改）

> 下面这段由 `node tools/gen-readme-tools.mjs --write` 从 `lib/index.js` 的 `TOOLS` **生成** ——
> **工具的唯一真身是 schema**，本文件只是它的投影。改了工具（加参数 / 改描述 / 改必填）就跑一次生成器：
> `node test/readme-test.mjs` 会**逐字比对**，忘了跑就**红**。
> 所以这一节**不会过时** —— 而手写的清单一定会（实测：`lanhu_read_design` 有三个月在 schema 里声明着
> `limit` / `mapBox` / `toBox`，文档和实现都没接上，没人发现，因为文档是手抄的）。

<!-- BEGIN GENERATED:tools -->

**15 个工具。** 下面每一个字都来自 AI 在 schema 里看到的那份 —— 本节由 `node tools/gen-readme-tools.mjs --write` 生成，**别手改**；改了工具忘了跑生成器，`test/readme-test.mjs` 会**逐字比对**并报红。

#### `lanhu_check_auth`

检查蓝湖登录态（Cookie）是否有效，返回团队列表与有效期。开始任何蓝湖操作前先跑这个；失效时给出更新 Cookie 的具体步骤。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_list_teams`

列出蓝湖账号加入的全部团队（teamId / 名称 / 成员数）。后续 list_projects、search 都需要 teamId。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_list_projects`

列出团队下的项目与分组（项目名 + projectId）。用于把"某个项目"定位到 projectId，再配合 list_designs 列稿子。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `teamId` | `string` | **是** | — | 团队 UUID（来自 lanhu_list_teams） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_list_designs`

列出某个项目下的全部设计稿（稿名 / 尺寸 / imageId）。**可以直接贴蓝湖链接**（里面的 tid/pid 自动解析，不用手拆）；也可以给 projectId。要看**产品文档/原型**请用 lanhu_list_product_documents。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 否 | — | 蓝湖链接（整条粘贴即可 —— 里面的 tid/pid 会自动解析，不用手拆） |
| `projectId` | `string` | 否 | — | 项目 UUID（与 url 二选一；**两个都给时以 projectId 为准**） |
| `sector` | `string` | 否 | — | 分组名（可选；实测未分组项目也能列出全部稿子，无需此参数） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_search`

在蓝湖团队里全局搜索设计稿 / 项目 / PRD（按名称关键词）。当不知道稿子在哪个项目、或只记得名字时用这个。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `teamId` | `string` | **是** | — | 团队 UUID |
| `keyword` | `string` | **是** | — | 搜索关键词（稿名的一部分） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_read_design`

读取蓝湖设计稿的结构化图层数据：精确色值/字号/字重/字体/圆角/坐标/文本内容/父子内边距。当用户提到蓝湖、设计稿、切图、还原设计、标注、lanhu 链接时使用。默认 summary 返回紧凑文本（色板 + 字号 + 关键容器 + 文本层）；要按区域抠图层（替代手写抠图脚本）用 region 参数（可再配 mapBox+toBox，把坐标**直接映射到目标坐标系**，如本地自绘 SVG 的 viewBox；层数多时用 limit 看全量）。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `projectId` | `string` | 否 | — | 项目 UUID（与 imageId 搭配） |
| `imageId` | `string` | 否 | — | 设计稿 id（与 projectId 搭配） |
| `url` | `string` | 否 | — | 蓝湖链接（与 projectId+imageId 二选一） |
| `format` | `string` | 否 | `summary` / `full` / `tokens` / `fonts` | summary=紧凑文本（默认，含色板/字号/关键容器/文本层）；full=全量图层落盘 JSON 并返回路径；tokens=仅色板/字号/圆角统计；fonts=**字体需求清单**（要装哪些字体、各用多少处、涉及哪些字重，交给前端直接照装） |
| `outDir` | `string` | 否 | — | 仅 format=full 时生效：落盘目录 |
| `region` | `string` | 否 | — | 按区域过滤：如 "95,215" 取 y∈[95,215]，或 "x0,y0,x1,y1"。直接输出可用图层表（含相对父容器的内边距），替代手写抠图脚本 |
| `minWidth` | `integer` | 否 | — | 配合 region：只保留宽度 ≥ 该值的层 |
| `limit` | `integer` | 否 | — | 配合 region：最多列多少层（默认 80）。层数多的稿子会被截断，要看全量就传大一点（如 900），表头会标注是否截断 |
| `mapBox` | `string` | 否 | — | 配合 region：设计稿参照框 "x0,y0,x1,y1"（如地图区域总 bbox）。与 toBox 同时给时，输出增加映射后的坐标列 |
| `toBox` | `string` | 否 | — | 配合 region：目标参照框 "X0,Y0,X1,Y1"（如本地自绘 SVG 的内容 bbox）。x/y 各自独立缩放（非等比），长宽比不同也能对 |
| `version` | `string` | 否 | — | 版本 id（默认取最新版 latest）。**设计稿会更新，不指定版本时"代码与稿子是否同一版"无从判断**；给了具体 id 就必须命中，命中不了会明确报错、不会静默回退到最新版。结果里的 version 字段会写明实际用了哪一版、是否最新 |
| `gapMaxDistance` | `number` | 否 | — | 配合 region：几何间距只保留 ≤ 该值的（不传则全留）。间距=**只在另一轴有重叠**的相邻元素之间的最近边距，可直接抄进 CSS，不用拿坐标手算 |
| `dds` | `boolean` | 否 | — | 默认关闭。开启后额外尝试取蓝湖 **DDS（设计数据服务）** 的 schema，结果以 source:"dds" 标注。⚠️ 那是社区实测的**非官方**通道（另域 + 独立 Cookie），随时可能失效——**失败只如实记录原因，不影响常规解析结果**，也**不要把它当主路径** |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_read_blocks`

把设计稿读成「块级清单」：卡片/胶囊/文本/图片/分割线/容器，每块带齐六项属性（圆角、大小、文字色、字号、有无底色、边框/分割线），外加**图层不透明**（已累乘祖先链，与填充色 `@xx%` alpha 是两回事，两者都要还原）、**字体族**、**行高·字距**、**多段渐变的全部 stop**（`#145994@18%→#08294a@10%`）。比 lanhu_read_design 更贴近"人一眼能核对"的粒度——**设计稿里肉眼最容易漏的分割线（如 1px #E2E8F0）会单独列在"边框/分割线"段**。**直接粘贴蓝湖链接即可**：不用手动拆 id，也**不用知道它属于哪个账号**（多账号场景会自动判定，并在结果末尾写明用了哪个）。还原大块布局或核对圆角/分割线时优先用它。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 否 | — | 蓝湖设计稿链接（详情页地址整条粘贴，自动解析 tid/pid/image_id） |
| `projectId` | `string` | 否 | — | 项目 UUID（与 imageId 搭配；给了 url 可不传） |
| `imageId` | `string` | 否 | — | 设计稿 id（与 projectId 搭配） |
| `region` | `string` | 否 | — | 可选：区域过滤，"y0,y1" 或 "x0,y0,x1,y1" |
| `kind` | `string` | 否 | — | 可选：只保留某类块，逗号分隔（card/container/pill/text/image/divider） |
| `minWidth` | `number` | 否 | — | 可选：只保留宽度 ≥ 该值的块 |
| `limit` | `number` | 否 | — | 文本清单最多列多少块（默认 80） |
| `includeNoise` | `boolean` | 否 | — | 是否包含系统 UI / 图形碎片块（默认折叠） |
| `version` | `string` | 否 | — | 版本 id（默认 latest）；与 read_design 同义。设计稿更新后要复现"当时那一版"就传它 |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_list_product_documents`

输出带 `order` —— 蓝湖「文档」面板**按它倒序**显示且是**滚动区**，界面里只看到前几个**不代表只有几个**（实测有人据此以为插件读错了）。`withPages:true` 可额外附上每份的**页面规模**（页面节点数 / 可读页数），便于一眼选对文档；**代价是每份多发 1 次请求**（要拉一次 sitemap），所以**默认关**，单份失败只标 `?` 不会毁掉整张表。列出蓝湖项目下的**产品文档**（也叫原型 / PRD —— Axure 导出，`docType=axure`）。**这不是设计稿**：设计稿回答"什么颜色、几 px 圆角"，产品文档回答"业务规则、字段、跳转"。当用户给的是**原型链接**（URL 里带 `docType=axure`），或要看需求文档/PRD/原型、要定位某一步的业务规则时用它；顺带返回项目名/文件夹/创建者。设计稿请用 lanhu_list_designs。拿到 docId 后交给 lanhu_read_product_doc 读页面树与正文。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 否 | — | 蓝湖原型链接（整条粘贴，自动解析 tid/pid/docId/pageId） |
| `teamId` | `string` | 否 | — | 团队 UUID（与 projectId 搭配；给了 url 可不传） |
| `projectId` | `string` | 否 | — | 项目 UUID（与 teamId 搭配） |
| `withPages` | `boolean` | 否 | — | true = 额外附上每份原型的**页面规模**（页面节点数 / 可读页数），便于一眼选对文档。**代价：N 份 = N 次额外请求**（每份拉一次 sitemap），**默认关**；单份失败只标 `?`，不让整张表失败 |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_read_product_doc`

读蓝湖**产品文档（Axure 原型 / PRD）**的页面树与正文 —— 需求文档、原型交互、业务规则的来源。**不是设计稿**（色值/字号/圆角用 lanhu_read_design）。返回：页面树（层级/path/类型/pageId）+ 命中页的正文文本。**先不带 pageId 调一次看页面树**（一份原型常有上百个节点），再按 pageId（**跨版本稳定**）或 pageName 精确取正文。`format:"layers"` 取**样式图层/块级清单**（项目只有原型、没有设计稿时靠它照着实现）。正文实测取自页面 HTML（data.js 里的原生控件多为空 —— 因为原型常以矢量/图片导出，只解析 data.js 会得出"这页没内容"的假结论）。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 否 | — | 蓝湖原型链接（整条粘贴，URL 里的 pageId 会被自动选中） |
| `projectId` | `string` | 否 | — | 项目 UUID（与 docId 搭配） |
| `docId` | `string` | 否 | — | 产品文档 id（= 原型链接里的 docId / image_id）。不给则取项目下第一份 axure 文档 |
| `teamId` | `string` | 否 | — | 团队 UUID（多账号自动判定失败时显式给） |
| `pageId` | `string` | 否 | — | 页面 id（**跨版本稳定**，推荐用它）。不给则不取正文，只回页面树 |
| `pageName` | `string` | 否 | — | 按页面名模糊匹配（pageId 的备选） |
| `version` | `string` | 否 | — | 版本 id（默认 latest）。原型也会更新，要复现"当时那一版"就传它 |
| `limit` | `integer` | 否 | — | 最多读几页正文（默认 1，避免一次拉爆） |
| `textLimit` | `integer` | 否 | — | 每页最多取多少条正文文本（默认 120） |
| `format` | `string` | 否 | `doc` / `layers` | doc（默认）= 页面树 + 正文文本（业务规则、字段、跳转）。layers = **该页的样式图层/块级清单**（坐标·色值·字号·字重·字体族·圆角·描边·渐变·透明度·切图），与 lanhu_read_blocks 输出**同一张表**。**什么时候用 layers**：项目里**没有设计稿、只有原型**时（`lanhu_list_designs` 返回 0 张）—— 那时 lanhu_read_design / lanhu_read_blocks 一点数据都拿不到，靠它才能照着实现。⚠️ 原型是交互稿，颜色/字号是设计者随手填的，**不等于最终视觉稿**；有设计稿时仍以设计稿为准。 |
| `layerLimit` | `integer` | 否 | — | format=layers 时最多列多少块（默认 60） |
| `includeNoise` | `boolean` | 否 | — | format=layers 时是否包含系统 UI / 图形碎片块（默认折叠） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_accounts`

管理蓝湖账号（一个人有多个公司/多个蓝湖账号时用）。action=list 列出账号（公司 / 团队数 / 项目数 / Cookie 有效期 / 默认标记）；add 添加或更新账号（**贴 Cookie 即可**，会自动建立团队+项目索引）；remove 删除；set-default 设为默认；reindex 重建索引。判断"某张稿属于哪个账号"请用 lanhu_who。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `action` | `string` | **是** | `list` / `add` / `remove` / `set-default` / `reindex` | 要做什么 |
| `alias` | `string` | 否 | — | 账号别名（字母/数字/._-，如 acme）；add / remove / set-default / reindex 需要 |
| `company` | `string` | 否 | — | 公司名（add 时用，便于一眼辨认） |
| `note` | `string` | 否 | — | 备注（add 时可选） |
| `cookie` | `string` | 否 | — | add 时可选：粘贴 Cookie。F12 → Network → 任意 lanhuapp.com 请求 → Copy as cURL → 整段贴进来即可 |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_who`

判断一张蓝湖稿子属于哪个账号（多公司/多账号场景）。**贴链接即可**：优先零请求——用链接里的团队 id（tid）或项目 id 比对账号索引，命中直接返回；未命中才按 imageId 逐个账号探测（并回填索引，下次就是零请求）。用户给了一张读不到的稿、或不确定该用哪个账号时，先跑它再读稿。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 否 | — | 蓝湖设计稿链接（推荐，含 tid 就能零请求判定） |
| `projectId` | `string` | 否 | — | 项目 UUID（没链接时用） |
| `imageId` | `string` | 否 | — | 设计稿 id（没链接时用） |
| `teamId` | `string` | 否 | — | 团队 UUID（最准，链接里的 tid） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_download_slices`

下载蓝湖设计稿的切图到本地（默认 assets/lanhu/），按内容哈希去重并产出 mapping.json。当需要把设计稿里的图标/图片素材落地到工程时用。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `projectId` | `string` | 否 | — | 项目 UUID |
| `imageId` | `string` | 否 | — | 设计稿 id |
| `url` | `string` | 否 | — | 蓝湖链接（与前两者二选一） |
| `outDir` | `string` | 否 | — | 输出目录（默认 <cwd>/assets/lanhu） |
| `version` | `string` | 否 | — | 版本 id（默认 latest）。切图也要能追溯"这是哪一版导出的" |
| `targetDpr` | `number` | 否 | — | 目标倍率（默认取设计稿自带的 sliceScale，没有则 2）。mapping.json 里每张图带 effectiveDensity（实际像素 ÷ 渲染尺寸），**小于它就说明素材本身不够清晰**——改引用方式没用，得让设计师重导 |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_verify_spec`

设计稿验收：用真实浏览器打开页面取 getComputedStyle，与设计稿图层逐字段比对（色值/字号/字重/**字体族**/圆角），输出匹配率与不一致表。字体族判定刻意宽松以防误报：**设计稿字体名出现在页面 font-family 栈的前 3 位即通过**（页面栈天然带系统回退字体，要求全等会把正确页面全判错）。浏览器首选 puppeteer-core 驱动系统 Chrome，其次 Playwright；都没有时降级为 CSS 声明级静态比对并说明原因。元素映射优先用页面上的 [data-lanhu] 属性，没有标注时按设计稿文本自动匹配叶子节点，也可显式传 selectors。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `projectId` | `string` | 否 | — | 项目 UUID |
| `imageId` | `string` | 否 | — | 设计稿 id |
| `pageUrl` | `string` | **是** | — | 要验收的页面地址（如 http://localhost:5173/） |
| `selectors` | `?` | 否 | — |  |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_verify_blocks`

块级比对：把设计稿里**每个可见块**与页面元素逐一比对**六项属性 + 字体族**（圆角 / 大小 / 文字色 / 字号 / 有无底色 / 边框 / font-family），输出四态报告（✅ 完全匹配 ｜ 🟡 容差内 ｜ ❌ 不匹配 ｜ ⚪ 无法比对）与**可直接抄的建议改法**（含目标端单位）。字体族判定：设计稿字体出现在页面 font-family 栈前 3 位即 ✅，排太后 🟡（存在但易被盖住），栈里没有 ❌。元素映射三级：页面 [data-lanhu] 标注 → 文本内容 → **几何最近邻兜底**（所以头像、卡片背景、分割线这些无文本块也能比）。比 lanhu_verify_spec 覆盖面大得多，验收还原度优先用它。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `pageUrl` | `string` | **是** | — | 要验收的页面地址（如 http://localhost:5173/） |
| `url` | `string` | 否 | — | 蓝湖设计稿链接（贴整条即可） |
| `projectId` | `string` | 否 | — | 项目 UUID（没链接时用） |
| `imageId` | `string` | 否 | — | 设计稿 id（没链接时用） |
| `target` | `string` | 否 | `h5` / `mini` | 目标端：h5 给 px，mini 给 rpx（默认 h5） |
| `viewportWidth` | `number` | 否 | — | 页面视口宽（默认按设计稿宽，用于坐标/尺寸折算） |
| `kind` | `string` | 否 | — | 可选：只比某几类块（card,container,pill,text,image,divider） |
| `includeNoise` | `boolean` | 否 | — | 是否也比对系统 UI / 图形碎片（默认不比） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

#### `lanhu_cookie_set`

更新蓝湖 Cookie。**直接粘贴浏览器里复制的内容即可**：F12 → Network → 任意 lanhuapp.com 请求 → 右键 → Copy as cURL → 把整段贴进来（会自动解析出 Cookie，不用手工抠串）。也接受 "Cookie: ..." 原始请求头或裸 Cookie 串。写前用真实请求校验；**传 `account` 就写进那个账号**（`~/.dsh/lanhu/cookies/<alias>`），不传则落盘到默认的 `~/.dsh/lanhu/cookie`（均 600）。

| 参数 | 类型 | 必填 | 取值 | 说明 |
|---|---|---|---|---|
| `cookie` | `string` | **是** | — | 粘贴内容：Copy as cURL 的整段文本、"Cookie: ..." 请求头、或裸 Cookie 串 |
| `dryRun` | `boolean` | 否 | — | true = 只解析校验并展示结果，不写入（先确认解析对不对） |
| `account` | `string` | 否 | — | 可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。 |

<!-- END GENERATED:tools -->

---

## 安装

```bash
# ① 装进 profile —— 两种来源任选
dsh plugin --profile web add dsh-lanhu        # 从 npm（推荐使用者）
dsh plugin --profile web add <plugin-dir>     # 从本仓库（要改代码时）
# ② 重启 dsh web —— 15 个工具即对全部会话可见
```

> `dsh plugin add` 就是 `pnpm add`，所以也接受 npm 包名 / tarball / git 地址。
> 装了之后 DSH 会读包里的 `dsh.bundle.patch` 把它挂进 profile 层（**没有这个声明的包只会装成普通依赖**）。

开发态用软链（改代码立即生效，但 **Host 代码仍需重启 `dsh web`**）：

```bash
ln -s <plugin-dir> ~/.dsh/profiles/web/node_modules/dsh-lanhu
# 再把 "dsh-lanhu" 加进 profile 的 dsh.profile.bundles，然后重启
```

零侵入验证（不动你的 profile）：

```bash
npm dsh web --patch <plugin-dir>/cordis.patch.yml
```

真机验收（`lanhu_verify_spec`）另需一个浏览器引擎，按需装一次即可：

```bash
cd <plugin-dir> && npm i puppeteer-core   # 只装这一个（它是 optional 依赖，不装也能用）
```

不装也能用：插件会自己去项目 `node_modules`、全局、npx 缓存、IDE 扩展里找；实在没有就降级成静态比对，并在报告里说明原因与安装命令。**macOS 12 及更早请务必走 puppeteer-core 这条**（Playwright 的 Chromium 装不上）。

---

## 文档索引

入口只留「不看就会做错」的东西，细节按需读：

| 你手上在做的事 | 读哪个文件 |
|---|---|
| 读设计稿 / 抠某个区域 / 把坐标搬进自己的坐标系 | [docs/读稿.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/读稿.md) |
| 读**产品文档 / 原型（PRD）** / 原型和设计稿分不清 | [docs/产品文档.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/产品文档.md) |
| **项目没有设计稿、只有原型**，要照着它实现 | [docs/原型样式.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/原型样式.md) |
| 还原完要验收 / 导出切图 | [docs/验收.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/验收.md) |
| 用侧边面板 / 配多账号 / Cookie 失效了 | [docs/面板与账号.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/面板与账号.md) |
| 用命令行 / 跑自检 / 踩到限制 | [docs/CLI与开发.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/CLI与开发.md) |
| 这一版改了什么 | [CHANGELOG.md](https://github.com/LoktLin/dsh-lanhu/blob/main/CHANGELOG.md) · [最新发布说明（v0.2.1）](https://github.com/LoktLin/dsh-lanhu/blob/main/.github/release-notes/v0.2.1.md) |

---

## English overview

> ### The goal is to make AI more useful
>
> Every design decision here answers one question: **how to make an AI work more accurately and rework less.**
> Values come back in a form the model can copy verbatim, errors point at the next step, and anything
> unverified is labelled as such.
>
> **Feedback from any AI is welcome** — if something is awkward, missing, or would lead you to a wrong
> conclusion, please open an issue. See [欢迎各家 AI 提意见](#欢迎各家-ai-提意见) for the four categories
> that help most.
> **In one sentence**: `dsh-lanhu` reads Lanhu (蓝湖) design specs for you — it turns an artboard into
> exact structured data (coordinates, colours, font size/weight/family, line-height, letter-spacing,
> corner radius, stroke, gradients, text, layer opacity) and feeds it to the coding agent, so it stops
> guessing values from a screenshot. It can also verify a built page against the same spec.
> **15 tools + a sidebar panel + a CLI**, MIT, macOS/Windows, DSH Web GUI, Node ≥ 20.
> The Chinese sections above are the full manual; this section is the one-screen entry point.

**30-second quick start**

| Step | Call | What you get |
|---|---|---|
| **① Check auth** | `lanhu_check_auth {}` | whether your cookie is valid, when it expires, and the team list — **call this first** |
| **② Read the artboard** | `lanhu_read_blocks {"url":"<lanhu link>"}` | a block-level list (a few hundred layers collapsed into reviewable blocks): six properties + font family + line-height/letter-spacing + every gradient stop. No need to split `tid/pid/image_id` by hand — the owning account is detected automatically |
| **③ Verify** | `lanhu_verify_blocks {"pageUrl":"http://localhost:5173/","url":"<lanhu link>"}` | a four-state report per visible block (✅ exact / 🟡 within tolerance / ❌ mismatch / ⚪ not comparable) with **fixes you can copy verbatim** |

> **Reading requirements / prototypes (PRD)?** `lanhu_read_product_doc {"url":"<prototype link>"}` gives the page tree and
> the body text of one page. It is a **product document (Axure prototype), not a design**. Add `"format":"layers"` for that
> page's style values (colours / font sizes / coordinates) — the only route when a project has **no design artboards**.
> Prototype styles are typed in by hand by the designer, so **a design always wins when one exists**. See [docs/原型样式.md](https://github.com/LoktLin/dsh-lanhu/blob/main/docs/原型样式.md).

**The 15 tools, one line each**

| Tool | What it is for |
|---|---|
| **`lanhu_check_auth`** | Is the cookie alive, and when does it expire? **Call this first** |
| **`lanhu_list_teams` / `lanhu_list_projects` / `lanhu_list_designs`** | team → project → artboard |
| **`lanhu_search`** | Search artboards / projects / PRDs by name when you don't know where it lives |
| **`lanhu_read_design`** | The layer tree: `summary` (default, compact text) / `full` (JSON to disk) / `tokens` (stats); `region` extracts an area, `mapBox` + `toBox` map coordinates into your own coordinate system |
| **`lanhu_read_blocks`** | The block-level list — checking radii, dividers and near-miss colours **starts here** |
| **`lanhu_list_product_documents`** | List the project's **PRD / prototype (Axure)** documents — separate from design artboards |
| **`lanhu_read_product_doc`** | A prototype's page tree plus the body text of one page (business rules, fields, navigation). Add `format:"layers"` to get that page's **styles** — colours, font sizes, coordinates, borders, gradients — so a project with **no design artboards** can still be implemented from it |
| **`lanhu_download_slices`** | Download slices plus `mapping.json` (size / mode / alpha range per image) |
| **`lanhu_verify_spec`** | Text-layer verification via `getComputedStyle` (colour / size / weight / **font family** / radius) |
| **`lanhu_verify_blocks`** | Block-level comparison of six properties + font family, with a four-state report |
| **`lanhu_who`** | Which account does this artboard belong to? (**index hit = zero requests**) |
| **`lanhu_accounts`** | Manage accounts (list / add / remove / set-default / reindex) |
| **`lanhu_cookie_set`** | Update the cookie — **paste the whole `Copy as cURL` blob** |

**Install essentials**

1. `dsh plugin --profile web add <plugin-dir>`, then **restart `dsh web`** — the 15 tools become visible to every session.
2. For development, symlink the package into the web profile's `node_modules` **and** add `"dsh-lanhu"` to `dsh.profile.bundles` — without the bundles entry the plugin is not loaded at all.
3. `lanhu_verify_spec` needs a browser engine: `npm i puppeteer-core` (it is an optional dependency — everything else works without it). **On macOS 12 or older, always use puppeteer-core**; Playwright's Chromium cannot be installed there.

**Four ground rules**

1. **Copy the design values verbatim** (colour / font size / radius). The plugin gives you the real numbers — estimating visually is exactly what it exists to replace.
2. **Scan three columns on arrival**: opacity, font family, line-height/letter-spacing — and confirm gradients are complete (they contain `→`).
3. **Write the conversion basis into a comment** (375 → 750rpx? 1920 → actual screen width?) so nobody has their own private assumption.
4. **Raise material problems immediately** instead of quietly working around them, and **never convert an alpha-bearing slice straight to JPG**.

> **Full parameter reference** (every argument, its type, whether it is required, and allowed values) is the
> **generated** 「每个工具的完整说明」 section above — it is projected from the tool schema, so it cannot drift.

---

## License

[MIT](https://github.com/LoktLin/dsh-lanhu/blob/main/LICENSE) © 2026 LoktLin

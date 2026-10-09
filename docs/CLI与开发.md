# CLI、自检与已知限制

> 返回 [README](../README.md) ｜ 完整参数见 README 的「工具」一节。

## CLI

> **原型页面样式**：`node lanhu.mjs product-doc --url "<原型链接>" --format layers [--layer-limit 200]`
> —— 输出该页的色值/字号/坐标块级清单（与设计稿同一张表）。没有设计稿、只有原型时用它。
>
> **指定账号**：`node lanhu.mjs <命令> … --account <别名>`
> —— 目标团队不属于**默认账号**时**必须给**，否则接口报 `30005 用户或团队不存在`。
> 实测（示例团队属 `demo`，而默认账号是 `default-acct`）：
>
> ```bash
> node lanhu.mjs search --team <团队id> --keyword 某大屏                    # ❌ code=30005 用户或团队不存在
> node lanhu.mjs search --team <团队id> --keyword 某大屏 --account demo  # ✅ 正常返回
> ```
>
> 优先级：`--cookie` > 环境变量 `LANHU_COOKIE` > `--account` > 默认账号 ——
> 也就是**显式 cookie 与环境变量会盖过 `--account`**（它们表达更强的显式意图）。
> `who`（职责就是跨账号判定）/ `accounts`（用 `--alias` 指定要操作的账号）/ `log`（纯本地）不需要它。
>
> **列原型清单**：`node lanhu.mjs product-docs --url "<原型链接>" [--with-pages]`
> —— 清单带 `order`（界面「文档」面板按它倒序、是滚动区，只看到前几个不代表只有几个）；
> `--with-pages` 额外附上每份的**页面规模**（页面节点 / 可读页），**代价是每份多发 1 次请求**，默认关。

`lanhu.mjs` 零依赖，命令面与工具一一对应：

```bash
node lanhu.mjs auth
node lanhu.mjs teams / projects --team <id> / designs --url "<链接>"|--project <id> / sectors --project <id>
node lanhu.mjs search   --team <teamId> --keyword <kw>
node lanhu.mjs read     --project <id> --image <id> [--format summary|full|tokens] [--region y0,y1] [--limit N] [--map-box … --to-box …]
node lanhu.mjs blocks   --url "<蓝湖链接>" [--kind card,pill] [--min-width 60] [--all] [--comments]   # --comments 额外读稿上人类留的评论/标注
node lanhu.mjs diff     --url "<蓝湖链接>" --from <旧版本id> [--to <版本id>] [--all]   # 两个版本比「改了什么」
node lanhu.mjs audit    --url "<链接>"|--project <id> [--limit N] [--all] [--allow-weak-naming]   # 跨稿一致性审计（设计系统漂移）
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

## 本地自检

```bash
node test/selfcheck.mjs          # 1532 项，纯离线、秒级
node test/selfcheck.mjs --json   # 机器可读
```

### 量「模型面」有多大

改 `description` / 参数说明 / `SYSTEM_HINT` 就是**改首轮提示**，而它的代价没有任何东西会报错。
所以量一下（同一口径，改前改后各跑一次）：

```bash
node tools/measure-model-surface.mjs            # 当前工作树
node tools/measure-model-surface.mjs --rev HEAD # 改前基线（从 git 里取那份 lib/index.js）
node tools/measure-model-surface.mjs --detail   # 逐个工具
```

口径有两项，**别只看第一项**：① **宿主口径** —— 与 `@deepseek-ai/dsh-token-meter/estimate` 同一个公式
（`ceil(chars / 4) + 4`），这是宿主给上下文计价的数（脚本会尝试导入真实模块对拍）；
② **CJK 口径** —— `中文字数 × 1 + 其余/4`，更接近真实分词。本插件的提示与描述几乎全是中文，
**宿主口径会低估 3~4 倍**，所以省中文的收益比它显示的大。

⚠️ `output.schema` **不在模型面里**：宿主的 `dsh-tools` 只把 `name / description / parameters`
投影给模型（DeepSeek 适配器再映射成 `input_schema`），所以往 `output.schema` 里写说明**对模型零影响**。

覆盖最**容易静默坏掉**的地方：链接解析（hash 路由）、工具参数校验、块级模型分类、工具定义形状、
lossless JSON、CLI 入口守卫、图片元信息、字体族判定、坐标映射、输出完整性、
**评论 / 标注**（真机结构 fixture 解析、分页与硬上限、归一化坐标 → 稿上坐标的换算、
落点映射"取最具体的块 / 同框副本取本体 / 命中不了就明说不硬套"、有评论才加标题行那句、
无评论时输出逐字节不变、接口挂了只降级不失败、`comments:false` 少一次请求、**只发 GET**）、
设计变更 diff（匹配可靠度）、设计系统审计（组件识别判据、三类漂移、命名不可靠时拒绝出明细、成本上限）、
**Sketch 插件格式（`type: sketchPlugin`）**（能解析的必须解析出块、取不出图层的必须明示而非静默；
生成代码侧还要认它那套**不同的字段名**：阴影 `blurRadius`/`offsetX`/`offsetY`、`type: '内阴影'`、
模糊类型 `背景模糊` —— 认不出会把发光抹成 `0px`、把毛玻璃写成 `filter`）、
**面板「体检」Tab**（用最小 React 替身把整棵面板树真渲染一遍：tab 真的挂上了、运行中按钮禁用且有进度、
不可靠结论在界面上可见、颜色全走令牌、fetch 挂了只显示错误不抛）、
**「稿」下拉的版本数**（Host 侧：默认上限 30 / 硬上限 100 夹回 / offset 分页 / 并发 4 / 单张失败只标 `ok:false`；
Client 侧：下拉里带「N 版」、只有 1 版的置灰并写明原因、探不到的**照常可选**只标「版本数未知」、
加载中有进度行、开面板**不**探、点「继续加载」只探下一批（offset 不重复）、探数失败不崩）、
**模型提示里的示例与实现同源**（色值示例直接取 `bgText()` 的返回值，源码里不存第二个字面量；全项目的
`rgba(…)` 示例都必须等于实现产出的形态）、**块类型徽标令牌化**（7 类各取一个互不相同的令牌 + fallback，
源码与离屏真渲染两道都查裸色值）、
**模型面不许同一件事说两遍**（决策树不复述工具产出清单、参数级规则不许写进工具描述、
`rpx` 换算公式全模型面只出现一次、预算闸门 —— 同时用**反向守卫**钉住"搬走≠删掉"：
被精简掉的事实必须还在它该在的那一面；这几条都做过变异测试，写回去就红）。
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

## 换算基准

1. **换算基准显式写进样式注释头**（设计稿 375 → 750rpx？1920 → 实际屏宽），别让每个人心里各有一套。

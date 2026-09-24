# CLI、自检与已知限制

> 返回 [README](../README.md) ｜ 完整参数见 README 的「工具」一节。

## CLI

> **原型页面样式**：`node lanhu.mjs product-doc --url "<原型链接>" --format layers [--layer-limit 200]`
> —— 输出该页的色值/字号/坐标块级清单（与设计稿同一张表）。没有设计稿、只有原型时用它。

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

## 本地自检

```bash
node test/selfcheck.mjs          # 530 项，纯离线、秒级
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

## 换算基准

1. **换算基准显式写进样式注释头**（设计稿 375 → 750rpx？1920 → 实际屏宽），别让每个人心里各有一套。

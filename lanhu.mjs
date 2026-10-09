#!/usr/bin/env node
/**
 * dsh-lanhu 核心 —— 蓝湖（Lanhu）设计稿读取
 *
 * 零依赖：只用 Node 内置模块 + 全局 fetch（Node >= 20）。
 * 同一份逻辑有三种消费方式：
 *   ① CLI      —— node lanhu.mjs <命令>
 *   ② DSH 插件 —— lib/index.js 直接 import 本文件的函数
 *   ③ 被别的代码 import
 *
 * 所有接口契约均为 macOS + Node 22 实测所得（2026-09-19），与需求书样本有出入处以实测为准，
 * 差异见 README 的「与需求书的偏差」一节。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

/** 同步加载 node 内建模块用（找浏览器引擎时需要同步取 npm root -g）。 */
const nodeRequire = createRequire(import.meta.url);

export const BASE = 'https://lanhuapp.com';
export const REFERER = `${BASE}/web/`;
/** Axure 原型（产品文档）的静态资源 CDN。正文与页面数据都在这里，用 sitemap 里的 `sign_md5` 当路径。 */
export const AXURE_CDN = 'https://axure-file.lanhuapp.com';
/** DDS（设计数据服务）—— 与主站不同域，鉴权也不同（见 ddsSchema）。 */
export const DDS_BASE_URL = 'https://dds.lanhuapp.com';

/* ==========================================================================
 * 受控词表与阈值 —— **单一出口**
 *
 * 为什么集中在这里（而不是散在使用点）：
 *   本仓库刚因为"没有唯一收口"连续踩过四次同一个坑（间距关系被静默丢掉、
 *   画板被当元素、齐平段父子成对、同名撞车）。结论写进了代码里：
 *   「新加一个返回 / 一个类型 / 一个阈值时，先问：它的单一出口在哪？」
 *
 * 规矩（照 `AXURE_CHILD_KEYS` 的先例）：
 *   · 受控词表一律 `Object.freeze`，**每个值都带 desc**（desc 是写给 AI 看的：
 *     它的消费者是写前端代码的 agent，一句"还原时别用 border-image"比"分割线"有用）；
 *   · 阈值/上限一律进 `LIMITS`，**不许在逻辑里裸写数字**；
 *   · 新常量加到对应分区，别另起一处。
 * ========================================================================== */

/** 块类型（受控词表）。下游渲染、文档、验收都引用这里。 */
export const KINDS = Object.freeze({
  ARTBOARD: 'artboard',
  IMAGE: 'image',
  TEXT: 'text',
  DIVIDER: 'divider',
  PILL: 'pill',
  CARD: 'card',
  CONTAINER: 'container',
  OTHER: 'other',
});

/** 每个块类型**是什么意思、还原时要注意什么**（写给 AI 看）。 */
export const KIND_DESC = Object.freeze({
  [KINDS.ARTBOARD]: '画板本身（不是内容块）。坐标是画布绝对坐标，**不要**参与块间几何比较。',
  [KINDS.IMAGE]: '切图/图片块。**没有填充也没有圆角是正常的** —— 尺寸照样要还原，别当噪音跳过。',
  [KINDS.TEXT]: '文本层。字号/字重/字体族/行高字距照抄，字重 400 就是 400 别写成 600。',
  [KINDS.DIVIDER]: '分割线（极细实心条，或只有单边边框的薄块）。还原用 1px 实线，**别用 border-image**。',
  [KINDS.PILL]: '胶囊/圆角标签。圆角撑满短边 → CSS 直接写 `border-radius: 9999px`。',
  [KINDS.CARD]: '卡片（底色/边框/圆角**至少有一个**，且够大）。内边距看「内边距」列，别再父子相减手算。',
  [KINDS.CONTAINER]: '有样式但不够大的容器（按钮底、说明块…）。',
  [KINDS.OTHER]: '无样式的纯布局层。通常只是分组，别当可见元素还原。',
});

/** 图层颜色的角色（受控词表）。 */
export const COLOR_ROLES = Object.freeze({
  FILL: 'fill',
  GRADIENT: 'gradient',
  TEXT: 'text',
});

/** 阈值与上限（**不许在逻辑里裸写这些数字**）。 */
export const LIMITS = Object.freeze({
  // —— 块分类（classifyBlock 的判据，等价于状态判定的业务规则）——
  dividerMaxThin: 3,        // 分割线①：短边 ≤ 3px
  dividerMinLong: 12,       // 分割线①：长边 ≥ 12px
  dividerBorderMaxThin: 12, // 分割线②：只有单边边框时短边上限
  pillMaxHeight: 64,        // 胶囊：高度上限
  pillRadiusEpsilon: 0.5,   // 胶囊：圆角"撑满短边"的容差
  cardMinWidth: 240,        // 卡片：最小宽
  cardMinHeight: 100,       // 卡片：最小高
  // —— 输出上限 ——
  summaryMaxBoxes: 14,      // summary「关键容器」最多列几个
  gapsLimit: 60,            // renderGaps 默认上限
  gapDigestMaxRows: 24,     // 「间距一览」的间距行封顶（0.5.0 口径）
  flushMaxRows: 24,         // 「间距一览」的齐平行封顶
  urlTruncate: 800,         // 长 URL 截断长度
  // —— 无障碍对比度（WCAG 2.x AA，§4.8）——
  contrastNormal: 4.5,      // 正文（非大号）下限
  contrastLarge: 3,         // 大号文字下限
  largeTextPx: 24,          // 大号：字号 ≥ 24px
  largeTextBoldPx: 18.66,   // 大号：或 ≥ 18.66px 且 bold
  largeTextBoldWeight: 700, // 「bold」的字重门槛
  contrastMaxRows: 24,      // 「对比度」段不达标行的封顶（与「间距一览」同口径）
  contrastSearchSteps: 24,  // 建议色的二分搜索步数
  // —— 生成代码（§4.10）——
  // 一张大屏稿动辄几百块，全量吐出来没人能粘贴 —— 默认封顶（用 region / limit 收窄）。
  codeMaxBlocks: 60,        // lanhu_gen_code 默认最多生成几块
  // —— 设计变更 diff（§6.5）——
  diffApproxMaxCenter: 24,      // 近似匹配：两块的**中心点**偏移上限（px）
  diffApproxReachRatio: 0.25,   // 近似匹配的宽松兜底：偏移 ≤ 较大边的这个比例也算（大块天然挪得远）
  diffApproxMaxSizeRatio: 1.25, // 近似匹配：宽/高各自的 max/min 上限（差 25% 以内才算同一块）
  diffMinMatchedRatio: 0.5,     // 匹配率低于它 → 判「两版差异过大，逐块对比不可靠」
  diffMaxApproxShare: 0.5,      // 近似匹配占已匹配的比超过它 → 同上（身份大面积对不上）
  diffMinBlocksForRatio: 8,     // 块数少于此不按比例判（小样本比例没有意义）
  diffMaxRowsPerCategory: 40,   // 每类最多列几行（超出的只给计数，不静默截断）
  // —— 设计系统审计（§6.6，跨稿一致性）——
  //    成本模型：**扫 N 张稿 = 2N 次请求**（1 次稿详情 + 1 次图层树）。实测 1437 张 ≈ 45 分钟，
  //    所以默认值必须克制，而硬上限是"不许无限拉取"这条铁律的落点。
  auditDefaultImages: 50,       // 默认扫多少张稿（显式传 limit 才能加）
  auditMaxImages: 200,          // **硬上限**：limit 传再大也不超过它
  auditConcurrency: 4,          // 同时在飞的最大请求数（提速，同时对接口礼貌）
  auditMinImagesForAudit: 2,    // 成功读到图层的稿少于它 → 样本太少，整项判不可靠
  auditMinNamedShare: 0.3,      // 可靠块名占比低于它 → **命名不可靠**，拒绝出明细
  auditMinComponentImages: 2,   // 一个组件名至少跨这么多张稿，才算「同一组件」
  auditMinComponentBlocks: 3,   // 一个组件名至少这么多块，才参与规格漂移判定
  auditNameMinLength: 2,        // 归一化后短于它的层名不认（"底""线"这种太泛，指代不明）
  auditMaxSpecValues: 8,        // 一个组件某维度最多列几个取值（超出的只给计数）
  auditMaxFindings: 12,         // 每类最多列几条发现（超出的只给计数，不静默截断）
  auditMaxExamples: 4,          // 每条发现最多举几张稿当例子
  auditExampleNameMax: 18,      // 例子里的稿名截断长度
  auditErrorMax: 80,            // 单张稿读取失败时，错误原文的截断长度
  auditHealthyFontSizes: 8,     // 一个项目的健康字号台阶上限，超过就算「阶梯失控」
  auditOneOffMaxCount: 1,       // 字号出现次数 ≤ 它 = 一次性野值
  auditOneOffMinCount: 2,       // 一次性野值达到这么多个 → 报「字号阶梯失控」
  auditLadderMinCount: 3,       // 算「常用档」的最低出现次数（收敛建议的锚点）
  auditNearColorDistance: 12,   // 近重复色：RGB 欧氏距离 ≤ 它（≈ ΔE 5，肉眼看不出）
  auditMaxColors: 600,          // 参与近重复比较的色值上限（超过只取出现次数最多的那批）
  auditSpacingGrid: 4,          // 间距栅格（4px 制）
  auditSpacingMaxDistance: 120, // 只统计 ≤ 它的相邻间距（几百 px 的"间距"是版面留白，不是尺度 token）
  auditSpacingMaxBlocks: 500,   // 单张稿可见块超过它就不算间距（geometricGaps 是 O(N²) 的保护）
  auditOffGridMinValues: 3,     // 不在栅格上的间距值达到这么多个 → 报「间距尺度失控」
  auditRadiusScale: Object.freeze([0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 64, 9999]),
  auditOffScaleMinValues: 3,    // 不在刻度上的圆角值达到这么多个 → 报「圆角特例」（参考项）
  auditEpsilon: 0.01,           // 浮点容差（判"落没落在栅格/刻度上"）
  // —— 面板「稿」下拉的版本数（§6.7，批量探版本数）——
  //    成本模型：**一张稿 = 1 次请求**（只读 image 元信息里的 versions，不拉图层树）。
  //    一个项目动辄两三百张，所以面板是**分批按需**探（选中项目 / 贴链接之后才探第一批），
  //    默认值 = 面板一批探多少张；硬上限 = "不许无限拉取"这条铁律的落点。
  versionsCountDefault: 30,     // 默认一批探多少张稿（面板不传 limit 时用它）
  versionsCountMax: 100,        // **硬上限**：limit 传再大也不超过它
  versionsCountConcurrency: 4,  // 同时在飞的最大请求数（与审计同口径：提速，同时对接口礼貌）
  // —— 评论（标注）读取（§4.9，人类留的需求）——
  //    成本模型：**+1~N 次请求**（每页 1 次）。评论是**独立接口**（不在图层树里），
  //    所以 `read_blocks` 从 2 次请求变成 3 次 —— 这正是要有 `comments:false` 能跳过它的原因。
  commentsPageSize: 20,        // 每页条数（与蓝湖网页端同口径：**别开太大**，一次拉爆对接口不礼貌）
  commentsMaxPages: 5,         // 分页**硬上限**：`has_next` 一直为 true 也不许无限拉
  commentsMaxTotal: 100,       // 条数硬上限（= 上面两条的乘积；超了标 truncated，不静默截断）
  commentsMaxContent: 300,     // 单条评论正文的展示长度上限（超出的截断并标出总字数）
  commentsMaxReplies: 5,       // 每条评论最多列几条回复
  commentsNormEpsilon: 0.001,  // 归一化坐标的容差（1.0005 这种浮点毛刺当 1；越界就不当坐标用）
  commentsNearDistance: 48,    // 未命中时：最近的块在这么多 px 内，才附一句"最近的是…"（线索，不当命中）
  commentsSameBoxRatio: 0.9,   // 命中多块时：面积落在 [最小, 最小÷它] 区间内的视为"同框副本"，取层级更浅的那个
});


/* ==========================================================================
 * 错误
 * ========================================================================== */

export class LanhuError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'LanhuError';
    this.code = extra.code;
    this.hint = extra.hint;
    this.status = extra.status;
  }
}

const COOKIE_HINT =
  'Cookie 已失效或未配置。最省事的更新方式：\n'
  + '  ① 浏览器登录 lanhuapp.com；\n'
  + '  ② F12 → Network → 找任意一个 lanhuapp.com 的请求 → 右键 → **Copy as cURL**；\n'
  + '  ③ 把整段粘给 lanhu_cookie_set —— 会自动解析出 Cookie，不用手工抠串。\n'
  + '  也接受："Cookie: ..." 原始请求头、或裸 Cookie 串。\n'
  + '  注意必须是**整串**：只给 user_token 会报 30001。';

/* ==========================================================================
 * 1. Cookie 管理
 * ========================================================================== */

/**
 * 数据目录：默认 `~/.dsh/lanhu`。
 * 可用 `LANHU_HOME` 覆盖 —— 自检据此指到临时目录，从而**绝不碰真实账号与 Cookie**。
 */
export function lanhuHome() {
  const override = process.env.LANHU_HOME;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh', 'lanhu');
}

/** Cookie 候选文件，按优先级。 */
export function cookieFilePaths() {
  return [
    path.join(lanhuHome(), 'cookie'),
    path.join(os.homedir(), '.lanhu', 'cookie'),
  ];
}

/**
 * 从「浏览器里复制出来的东西」里解析出 Cookie 串。
 *
 * 覆盖四种粘贴形态（Chrome / Edge / Safari 的 Copy as cURL 实测都命中）：
 *   ① curl 命令：`-b '...'` / `--cookie '...'` / `-H 'cookie: ...'`（bash 与 cmd 两种转义）
 *   ② 原始请求头：`Cookie: PASSPORT=...`
 *   ③ JS / PowerShell 赋值：`cookie = "..."`、`"Cookie" = "..."`
 *   ④ 裸 Cookie 串
 *
 * 解析纪律：候选必须**同时含 `user_token=` 与 `PASSPORT=`** 才算命中 ——
 * 蓝湖只认整串，半截串（只给 user_token）写进文件也只会报 30001，不如当场说清楚。
 *
 * @param {string} input 用户粘贴的任意文本
 * @returns {{cookie: string, source: string, length: number, masked: string, checks: Record<string, boolean>, expiry: object|null}}
 */
export function parseCookieInput(input) {
  const text = String(input ?? '');
  if (!text.trim()) throw new LanhuError('输入为空，没有可解析的内容。');

  const candidates = [];
  const push = (value, source) => {
    const v = String(value ?? '')
      .replace(/\\\r?\n/g, ' ')        // 去掉 bash 的续行反斜杠
      .replace(/[\r\n]+/g, ' ')        // 折成一行
      .replace(/\^/g, '')              // 去掉 cmd 的 ^ 转义
      .replace(/^\s*cookie\s*:\s*/i, '')
      .trim()
      .replace(/^['"]|['"]$/g, '')     // 去首尾引号
      .replace(/[;\\]+$/, '')          // 去尾部分号 / 反斜杠
      .trim();
    if (v) candidates.push({ value: v, source });
  };

  // ① curl：-b / --cookie（带引号，内容可跨行）
  for (const m of text.matchAll(/(?:^|\s)(?:-b|--cookie)[=\s]+(['"])([\s\S]*?)\1/g)) push(m[2], 'curl -b（带引号）');
  // ①' curl：-b / --cookie（不带引号）
  for (const m of text.matchAll(/(?:^|\s)(?:-b|--cookie)[=\s]+([^\s'"]+)/g)) push(m[1], 'curl -b（不带引号）');
  // ② curl：-H 'cookie: ...'（带引号）
  for (const m of text.matchAll(/(?:^|\s)-H[=\s]+(['"])[\s]*cookie[\s]*:[\s]*([\s\S]*?)\1/gi)) push(m[2], 'curl -H cookie（带引号）');
  // ②' curl：-H cookie: ...（不带引号）
  for (const m of text.matchAll(/(?:^|\s)-H[=\s]+cookie[\s]*:[\s]*([^\s'"]+)/gi)) push(m[1], 'curl -H cookie（不带引号）');
  // ③ 原始请求头行
  for (const m of text.matchAll(/^\s*cookie\s*:\s*(.+)$/gim)) push(m[1], 'Cookie 请求头');
  // ③' JS / PowerShell 赋值
  for (const m of text.matchAll(/["']?cookie["']?\s*[:=]\s*["']([^"']+)["']/gi)) push(m[1], 'cookie 赋值');
  // ④ 兜底：整段就是裸 Cookie 串
  push(text, '原始串');

  // ⚠️ 判据放宽过一次：原先是「必须同时有 user_token + PASSPORT」，
  //    那是**基于单个账号的经验**。第二个账号（企业号）根本没有 PASSPORT，
  //    它的 Cookie 是 `tfstk / session / user_token / aliyungf_tc / SERVERID / acw_tc`——
  //    按老判据会直接被拒（实测踩过）。
  //    现在以 **user_token** 为硬要求（它是登录标识），PASSPORT/session 只作为"是否够整"的提示。
  const hasToken = (v) => /(?:^|;\s*)user_token=/.test(v);
  const hit = candidates.find((c) => hasToken(c.value));

  if (!hit) {
    throw new LanhuError('没能从输入里解析出 Cookie（至少要含 user_token）。', {
      hint: '支持：F12 → 右键请求 → Copy as cURL 的整段内容、"Cookie: ..." 原始请求头、或裸 Cookie 串。',
    });
  }

  const cookie = hit.value;
  return {
    cookie,
    source: hit.source,
    length: cookie.length,
    masked: maskCookie(cookie),
    checks: {
      PASSPORT: /PASSPORT=/.test(cookie),
      user_token: /user_token=/.test(cookie),
      session: /session=/.test(cookie),
      SERVERID: /SERVERID=/.test(cookie),
      acw_tc: /acw_tc=/.test(cookie),
    },
    expiry: cookieExpiry(cookie),
  };
}

/**
 * 解析 Cookie。
 *
 * 优先级：显式参数 > LANHU_COOKIE > LANHU_COOKIE_FILE > **指定账号** > **默认账号** > 旧候选文件。
 * 后两级是 2026-09-20 加多账号支持时接上的；**没有 accounts.json 时行为与从前完全一致**（直接落到旧文件）。
 *
 * @param {string} [explicit]
 * @param {{account?: string}} [opts] 指定账号别名；给了却找不到文件时**报错而不会静默换账号** ——
 *   用错账号的权限去读稿会得到莫名其妙的「Image not exist」，比直接报错难查得多。
 * @returns {{value: string|null, source: string|null, account?: string|null}}
 */
export function resolveCookie(explicit, opts = {}) {
  if (typeof explicit === 'string' && explicit.trim()) {
    return { value: explicit.trim(), source: '参数传入', account: null };
  }
  const env = process.env.LANHU_COOKIE;
  if (typeof env === 'string' && env.trim()) {
    return { value: env.trim(), source: '环境变量 LANHU_COOKIE', account: null };
  }
  const envFile = process.env.LANHU_COOKIE_FILE;
  if (typeof envFile === 'string' && envFile.trim()) {
    const p = envFile.startsWith('~') ? path.join(os.homedir(), envFile.slice(1)) : envFile;
    const v = readCookieFile(p);
    if (v) return { value: v, source: `环境变量 LANHU_COOKIE_FILE → ${p}`, account: null };
  }

  // ③ 指定账号（显式 / 环境变量）
  const want = opts.account ?? process.env.LANHU_ACCOUNT ?? null;
  if (want) {
    const alias = safeAlias(want);
    const p = cookiePathFor(alias);
    const v = readCookieFile(p);
    if (v) return { value: v, source: `账号 ${alias} → ${p}`, account: alias };
    const known = loadAccounts().accounts.map((a) => a.alias);
    throw new LanhuError(`账号「${alias}」没有可用的 Cookie（找不到 ${p}）。`, {
      hint: known.length
        ? `已知账号：${known.join('、')}。用 lanhu_accounts 补充该账号的 Cookie，或换一个账号。`
        : '还没配置任何账号。用 lanhu_accounts 添加，或直接给 --cookie / 粘贴 Cookie。',
    });
  }

  // ④ 默认账号
  const doc = loadAccounts();
  if (doc.default) {
    const v = readCookieFile(cookiePathFor(doc.default));
    if (v) return { value: v, source: `默认账号 ${doc.default} → ${cookiePathFor(doc.default)}`, account: doc.default };
  }

  // ⑤ 旧路径（单账号时代的落点，保持兼容）
  for (const p of cookieFilePaths()) {
    const v = readCookieFile(p);
    if (v) return { value: v, source: p, account: null };
  }
  return { value: null, source: null, account: null };
}

/* ==========================================================================
 * 1.2 多账号档案
 *
 * 场景：一个人手上有多个公司的蓝湖账号，要读不同公司的稿子。
 * 关键洞察：**蓝湖链接里的 `tid` 就是团队 id，而一个团队只属于一个账号。**
 *   实测：链接 `tid=33333333-…` ↔ 账号的 `teamId=33333333-…`（Acme）完全一致。
 * 于是只要每个账号存一份 `listTeams` 的结果（1 次请求），
 * 之后**看链接就能零请求定位该用哪个账号** —— 不必挨个账号去试着读稿。
 *
 * 落盘：
 *   ~/.dsh/lanhu/accounts.json    档案：公司 / 别名 / 团队与项目索引（**不含 Cookie 明文**）
 *   ~/.dsh/lanhu/cookies/<alias>  每个账号一份 Cookie，600
 *   ~/.dsh/lanhu/cookie           旧路径，仍被当作无账号时的兜底
 * ========================================================================== */

export function accountsPath() {
  return path.join(lanhuHome(), 'accounts.json');
}

export function cookiesDir() {
  return path.join(lanhuHome(), 'cookies');
}

/** 别名要能安全地当文件名用 —— 挡掉 `../` 这类越界。 */
export function safeAlias(alias) {
  const a = String(alias ?? '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(a)) {
    throw new LanhuError(`账号别名只能用字母/数字/._-（1–40 字符），收到 ${JSON.stringify(alias)}`, {
      hint: '建议用公司简称，如 acme / other / xxx-tech。',
    });
  }
  return a;
}

export function cookiePathFor(alias) {
  return path.join(cookiesDir(), safeAlias(alias));
}

const emptyDoc = () => ({ version: 1, default: null, accounts: [] });

export function loadAccounts() {
  try {
    const doc = JSON.parse(fs.readFileSync(accountsPath(), 'utf8'));
    if (!doc || !Array.isArray(doc.accounts)) return emptyDoc();
    return { version: doc.version ?? 1, default: doc.default ?? null, accounts: doc.accounts };
  } catch {
    return emptyDoc();   // 没有 / 坏了都当空档案，绝不因此让工具挂掉
  }
}

export function saveAccounts(doc) {
  const dir = lanhuHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = accountsPath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);   // 原子替换：写到一半崩了不会留个坏档案
  try { fs.chmodSync(dir, 0o700); fs.chmodSync(target, 0o600); } catch { /* 平台差异 */ }
}

/**
 * 新增或更新一个账号。给了 cookie 就同时落盘（600）。
 * @returns {{entry: object, created: boolean}}
 */
export function upsertAccount({ alias, company, note, cookie }) {
  const a = safeAlias(alias);
  const doc = loadAccounts();
  let entry = doc.accounts.find((x) => x.alias === a);
  const created = !entry;
  if (created) {
    entry = { alias: a, company: company ?? a, note: note ?? null, teams: [], projects: [], createdAt: new Date().toISOString() };
    doc.accounts.push(entry);
  }
  if (company !== undefined) entry.company = company || a;
  if (note !== undefined) entry.note = note;
  if (typeof cookie === 'string' && cookie.trim()) {
    const value = cookie.trim();
    fs.mkdirSync(cookiesDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cookiePathFor(a), value, { mode: 0o600 });
    try { fs.chmodSync(cookiePathFor(a), 0o600); } catch { /* 平台差异 */ }
    entry.cookieMasked = maskCookie(value);
    entry.cookieLength = value.length;
    entry.expiry = cookieExpiry(value) ?? null;
    entry.updatedAt = new Date().toISOString();
  }
  if (!doc.default) doc.default = a;
  saveAccounts(doc);
  return { entry, created };
}

export function removeAccount(alias) {
  const a = safeAlias(alias);
  const doc = loadAccounts();
  const idx = doc.accounts.findIndex((x) => x.alias === a);
  if (idx < 0) throw new LanhuError(`没有这个账号：${a}`);
  doc.accounts.splice(idx, 1);
  if (doc.default === a) doc.default = doc.accounts[0]?.alias ?? null;
  saveAccounts(doc);
  try { fs.rmSync(cookiePathFor(a), { force: true }); } catch { /* 文件不在就算了 */ }
  return { removed: a, default: doc.default };
}

export function setDefaultAccount(alias) {
  const a = safeAlias(alias);
  const doc = loadAccounts();
  if (!doc.accounts.some((x) => x.alias === a)) throw new LanhuError(`没有这个账号：${a}（先添加它）`);
  doc.default = a;
  saveAccounts(doc);
  return { default: a };
}

/** 索引超过这个天数就视为"可能过期"（项目/团队会有增减）。 */
export const INDEX_STALE_DAYS = 7;

function indexAgeDays(entry) {
  if (!entry?.indexedAt) return null;
  const t = new Date(entry.indexedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/** 列账号（含可用性与有效期），**不含 Cookie 明文**。 */
export function listAccounts() {
  const doc = loadAccounts();
  return {
    default: doc.default,
    file: accountsPath(),
    accounts: doc.accounts.map((a) => {
      const hasCookie = Boolean(readCookieFile(cookiePathFor(a.alias)));
      const expiry = hasCookie ? (cookieExpiry(readCookieFile(cookiePathFor(a.alias))) ?? a.expiry ?? null) : null;
      const age = indexAgeDays(a);
      return {
        alias: a.alias,
        company: a.company ?? a.alias,
        note: a.note ?? null,
        hasCookie,
        cookieMasked: hasCookie ? maskCookie(readCookieFile(cookiePathFor(a.alias))) : null,
        expiry,
        expired: expiry ? expiry.daysLeft <= 0 : null,
        teams: a.teams ?? [],
        teamCount: (a.teams ?? []).length,
        projects: a.projects ?? [],
        projectCount: (a.projects ?? []).length,
        indexedAt: a.indexedAt ?? null,
        indexAgeDays: age,
        indexStale: age === null ? true : age >= INDEX_STALE_DAYS,
        isDefault: doc.default === a.alias,
      };
    }),
  };
}

/**
 * 重建某账号的索引：团队 + 项目。
 * 成本 = 1（listTeams）+ 团队数（listDirectory）次请求；实测单团队账号约 3 秒。
 * 单个团队失败不影响其它团队，失败原因如实带回来。
 */
export async function buildAccountIndex(alias, opts = {}) {
  const a = safeAlias(alias);
  const { value: cookie } = resolveCookie(opts.cookie, { account: a });
  if (!cookie) throw new LanhuError(`账号 ${a} 没有可用的 Cookie，无法建索引。`);

  const teams = await listTeams({ cookie });
  const projects = [];
  const errors = [];
  for (const t of teams.teams ?? []) {
    try {
      const d = await listDirectory(t.teamId, { cookie });
      for (const p of d.projects ?? []) {
        projects.push({ projectId: p.sourceId, name: p.sourceName, teamId: t.teamId, teamName: t.name });
      }
    } catch (e) {
      errors.push(`${t.name}：${e?.message ?? e}`);
    }
  }

  const doc = loadAccounts();
  const entry = doc.accounts.find((x) => x.alias === a);
  if (entry) {
    entry.teams = (teams.teams ?? []).map((t) => ({ teamId: t.teamId, name: t.name, memberNum: t.memberNum }));
    entry.projects = projects;
    entry.indexedAt = new Date().toISOString();
    entry.indexError = errors.length ? errors.join('；') : null;
    saveAccounts(doc);
  }
  return {
    alias: a,
    teamCount: (teams.teams ?? []).length,
    projectCount: projects.length,
    teams: entry?.teams ?? [],
    projects,
    errors,
    indexedAt: entry?.indexedAt ?? null,
  };
}

/**
 * 给一个目标（链接 / projectId / teamId）**自动挑账号**。
 *
 * 为什么需要：别的 AI（或别的会话）只拿到一条链接，**根本不知道它属于哪个账号**。
 * 链接里虽然有 tid，但 tid 得和各账号的团队列表比对才知道归属 —— 这一步不该让人来做。
 *
 * 策略（从快到慢）：
 *   ① 查 `accounts.json` 的索引（tid → teams / pid → projects）—— **零请求**；
 *   ② 索引没命中 → **实时拉各账号的 `listTeams` 比对 tid**，命中就**回填索引**（下次零请求）；
 *   ③ 都不命中 → 返回 null，调用方退回默认账号。
 *
 * ⚠️ 第 ② 步为什么是"拉团队列表"而不是"试读那张稿"：
 *    实测（2026-09-20）发现**蓝湖对已登录用户不按团队隔离读稿** ——
 *    任何账号都能读任何稿，所以"试读成功"证明不了归属。而 `listTeams` 是按账号隔离的（可靠）。
 *    代价也小得多：只拉 teams，不拉每个团队下的 projects。
 */
export async function resolveAccountFor(args = {}, opts = {}) {
  const doc = loadAccounts();
  if (doc.accounts.length === 0) return null;          // 没配账号体系 → 调用方走单 Cookie

  let target = null;
  if (args.url) {
    try { target = parseLanhuUrl(args.url); } catch { target = null; }
  }
  const tid = args.teamId ?? target?.teamId ?? null;
  const pid = args.projectId ?? target?.projectId ?? null;

  // ① 索引（零请求）
  if (tid) {
    const hit = doc.accounts.find((a) => (a.teams ?? []).some((t) => t.teamId === tid));
    if (hit) return { alias: hit.alias, by: 'index:teams' };
  }
  if (pid) {
    const hit = doc.accounts.find((a) => (a.projects ?? []).some((p) => p.projectId === pid));
    if (hit) return { alias: hit.alias, by: 'index:projects' };
  }

  // ② 实时比对（只有拿到 tid 才有意义 —— 团队 id 是按账号隔离的那个可靠标识）
  if (tid && opts.offline !== true && args.allowLive !== false) {
    for (const a of doc.accounts) {
      const cookie = readCookieFile(cookiePathFor(a.alias));
      if (!cookie) continue;
      try {
        const r = await listTeams({ cookie });
        if ((r.teams ?? []).some((t) => t.teamId === tid)) {
          // 命中 → 回填该账号的 teams 索引（下次就是零请求）
          const doc2 = loadAccounts();
          const e2 = doc2.accounts.find((x) => x.alias === a.alias);
          if (e2) {
            e2.teams = (r.teams ?? []).map((t) => ({ teamId: t.teamId, name: t.name, memberNum: t.memberNum }));
            e2.teamsSyncedAt = new Date().toISOString();
            saveAccounts(doc2);
          }
          return { alias: a.alias, by: 'live:teams' };
        }
      } catch { /* 某个账号拉不到（Cookie 失效等）就跳过，不影响其它账号 */ }
    }
  }
  return null;   // 都不命中 → 调用方用默认账号（蓝湖不按账号隔离读稿，仍能读）
}

/** 供各读取入口使用：显式 account 优先，否则按链接自动判定。返回 {alias, by}。 */
export async function pickAccount(args = {}) {
  if (args.account) return { alias: args.account, by: 'explicit' };
  const r = await resolveAccountFor(args);
  return r ? { alias: r.alias, by: r.by } : { alias: null, by: null };
}

/**
 * 判断一张稿子属于哪个账号。
 *
 * 三级，从快到慢：
 *   ① 链接里的 **tid** ↔ 档案 teams        —— **0 请求**（主力路径）
 *   ② 链接里的 **pid** ↔ 档案 projects     —— **0 请求**（建索引时顺带收）
 *   ③ 拿 imageId 逐个账号探 `imageDetail`  —— 最坏 N 次；命中即停并回填索引
 *
 * 判定失败也是有价值的信息：说明这个团队不在已配置的账号里，该去加账号了。
 */
export async function whoIsIt(args = {}) {
  let target;
  if (args.url) {
    target = parseLanhuUrl(args.url);
  } else {
    target = { teamId: args.teamId ?? null, projectId: args.projectId ?? null, imageId: args.imageId ?? null, url: null };
    if (!target.projectId && !target.imageId && !target.teamId) {
      throw new LanhuError('至少给一个 url，或 projectId / imageId / teamId 之一。');
    }
  }

  const doc = loadAccounts();
  const brief = (a, by, extra = {}) => ({
    found: true,
    matchedBy: by,
    alias: a.alias,
    company: a.company ?? a.alias,
    note: a.note ?? null,
    expiry: (() => {
      const v = readCookieFile(cookiePathFor(a.alias));
      return v ? (cookieExpiry(v) ?? a.expiry ?? null) : (a.expiry ?? null);
    })(),
    ...extra,
  });

  // ① tid
  if (target.teamId) {
    const hit = doc.accounts.find((a) => (a.teams ?? []).some((t) => t.teamId === target.teamId));
    if (hit) {
      const team = (hit.teams ?? []).find((t) => t.teamId === target.teamId);
      return brief(hit, 'tid', { team: { teamId: target.teamId, name: team?.name ?? null } });
    }
  }
  // ② pid
  if (target.projectId) {
    const hit = doc.accounts.find((a) => (a.projects ?? []).some((p) => p.projectId === target.projectId));
    if (hit) {
      const proj = (hit.projects ?? []).find((p) => p.projectId === target.projectId);
      return brief(hit, 'pid', { project: { projectId: target.projectId, name: proj?.name ?? null } });
    }
  }

  // ③ 索引都没命中时的兜底：只做「这张稿能不能读到」的存在性确认。
  //
  // ⚠️ **实测（2026-09-20）发现前面那版判断是错的**：
  //    蓝湖对**已登录用户不按团队隔离读稿** —— 用 A 账号的 Cookie 能读到 B 账号团队下的稿
  //    （两个方向实测都成功；而 `listTeams` 在两个账号下分别只返回各自的 1 / 6 个团队，
  //     确认是两个不同用户）。
  //    所以「试读成功」**只能证明稿子存在且可读，不能证明归属**。
  //    原先的实现据此回填索引、并声称"归属这个账号" —— 那会污染索引、给出错误结论，已改掉。
  let readable = null;   // null=没测 / false=读不到 / string=读到了（值为稿名）
  if (target.projectId && target.imageId) {
    const anyCookie = doc.accounts.map((a) => readCookieFile(cookiePathFor(a.alias))).find(Boolean);
    if (anyCookie) {
      try {
        const det = await imageDetail(target.projectId, target.imageId, { cookie: anyCookie });
        readable = isReadableDetail(det) ? (det.name || true) : false;
      } catch { readable = false; }
    }
  }

  const stale = doc.accounts.filter((a) => indexAgeDays(a) === null || indexAgeDays(a) >= INDEX_STALE_DAYS);
  const staleNote = stale.length
    ? `　注意 ${stale.map((a) => a.alias).join('、')} 的索引${stale.every((a) => indexAgeDays(a) === null) ? '还没建' : `已超过 ${INDEX_STALE_DAYS} 天`}，可能是索引没跟上新项目 —— 先 reindex 再下结论。`
    : '';

  let hint;
  if (doc.accounts.length === 0) {
    hint = '还没配置任何账号。用 lanhu_accounts 添加（贴 Cookie 即可）。';
  } else if (readable) {
    hint = `这张稿**能读到**${typeof readable === 'string' ? `（「${readable}」）` : ''}，但它不在任何已配置账号的团队/项目索引里。`
      + '两种可能：① 索引过期（新项目还没进来）；② 这张稿是别人分享给你的、不属于你的任何团队。'
      + staleNote
      + '　⚠️ **不能用"能读到"判断归属**：蓝湖对已登录用户不按团队隔离读稿，任何账号都能读任何稿。';
  } else {
    hint = `这张稿读不到（可能不存在，或链接里的 id 有误）。已配置 ${doc.accounts.length} 个账号：`
      + doc.accounts.map((a) => a.alias).join('、') + '。' + staleNote;
  }

  return {
    found: false,
    matchedBy: null,
    target,
    readable: Boolean(readable),
    readableName: typeof readable === 'string' ? readable : null,
    knownAccounts: doc.accounts.map((a) => ({
      alias: a.alias,
      company: a.company ?? a.alias,
      teamCount: (a.teams ?? []).length,
      indexAgeDays: indexAgeDays(a),
    })),
    probeErrors: [],   // 保留字段：以前的"逐账号试读"已废弃（它证明不了归属）
    hint,
  };
}

function readCookieFile(p) {
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** 打码：只留前 8 个字符，其余用 * 代替（绝不回显完整串）。 */
export function maskCookie(cookie) {
  if (typeof cookie !== 'string' || cookie.length === 0) return '(空)';
  const head = cookie.slice(0, 8);
  return `${head}${'*'.repeat(Math.min(24, Math.max(0, cookie.length - 8)))} (${cookie.length} 字符)`;
}

/**
 * 从 user_token 里读过期时间，用于提前预警。
 *
 * ⚠️ 蓝湖的 user_token **不是标准 JWT 布局**：它把 `iat`/`exp` 放在**第一段**，
 *    而标准 payload 位置（第二段）只放了 `{id}`。只解第二段会永远拿不到 exp（实测踩过），
 *    所以两段都试一遍。
 */
export function cookieExpiry(cookie) {
  const m = /user_token=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/.exec(cookie || '');
  if (!m) return null;
  for (const segment of [m[1], m[2]]) {
    try {
      const obj = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
      if (typeof obj.exp === 'number') {
        return {
          expiresAt: new Date(obj.exp * 1000).toISOString(),
          daysLeft: Math.floor((obj.exp * 1000 - Date.now()) / 86400000),
        };
      }
    } catch { /* 换下一段 */ }
  }
  return null;
}

/**
 * 写入 Cookie 文件（目录 700 / 文件 600）。写前用一次真实请求校验有效性。
 *
 * 入参可以是**任意粘贴形态**：curl 命令（F12 → Copy as cURL）、"Cookie: ..." 请求头、
 * 或裸 Cookie 串 —— 内部统一交给 parseCookieInput 解析，调用方不用自己抠串。
 *
 * @param {string} input 粘贴内容
 * @param {{verify?: boolean, dryRun?: boolean, account?: string}} [opts]
 *   dryRun=true 只解析校验、不落盘；给了 account 就写进该账号（`cookies/<alias>`）而不是旧的默认文件
 */
export async function saveCookie(input, opts = {}) {
  const parsed = parseCookieInput(input);
  const value = parsed.cookie;

  if (opts.verify !== false) {
    try {
      await listTeams({ cookie: value });
    } catch (e) {
      throw new LanhuError(`Cookie 校验失败，未写入：${e.message}`, { hint: COOKIE_HINT, code: e.code });
    }
  }

  const info = {
    source: parsed.source,
    masked: parsed.masked,
    checks: parsed.checks,
    expiry: parsed.expiry ?? cookieExpiry(value),
  };

  // ⚠️ 给了 account 就**必须**写进那个账号。`account` 是 lib/index.js 给所有工具统一注入的参数
  //    （`{ ...parameters, account: ACCOUNT_PARAM }`），调用方很容易以为它在这个工具上也生效；
  //    若忽略它，`cookie_set {account:"x"}` 会**静默覆盖默认账号**的 Cookie —— 正是本项目最怕的那类静默。
  const account = opts.account ? safeAlias(opts.account) : null;
  if (account && !loadAccounts().accounts.some((a) => a.alias === account)) {
    throw new LanhuError(`账号 "${account}" 不存在，不能把 Cookie 写给它。`, {
      code: 'ACCOUNT_NOT_FOUND',
      hint: '先用 lanhu_accounts {action:"list"} 看现有账号；要新增就用 action:"add"。',
    });
  }

  if (opts.dryRun) return { dryRun: true, written: false, ...info, account };

  if (account) {
    // 与 lanhu_accounts add 走同一条路：建目录、600、回填 masked/expiry 索引
    upsertAccount({ alias: account, cookie: value });
    return { path: cookiePathFor(account), written: true, ...info, account };
  }

  const dir = lanhuHome();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'cookie');
  fs.writeFileSync(target, value, { mode: 0o600 });
  fs.chmodSync(dir, 0o700);
  try { fs.chmodSync(target, 0o600); } catch { /* 平台差异，忽略 */ }
  return { path: target, written: true, ...info };
}

/* ==========================================================================
 * 1.5 使用记录（面板上的「插件干了啥」）
 *
 * 需求原话：**打个日志就好，不做复杂**。所以：
 *   · 内存 ring buffer（本进程最近 300 条）供面板秒查；
 *   · 同时追加落盘 ~/.dsh/lanhu/usage.jsonl（跨重启可追溯）；
 *   · **绝不记录 Cookie 明文**——参数只走白名单，cookie/input 一律不入日志；
 *   · 任何写盘失败都被吞掉，日志永远不能影响主流程。
 * ========================================================================== */

const USAGE_MAX = 300;
const usageRing = [];
let usageFileBroken = false;

export function usagePath() {
  return path.join(lanhuHome(), 'usage.jsonl');
}

/** 记一条使用记录。绝不影响主流程。 */
export function recordUsage(entry = {}) {
  const rec = {
    at: new Date().toISOString(),
    tool: String(entry.tool ?? 'unknown').slice(0, 60),
    ok: entry.ok !== false,
    ms: Number.isFinite(entry.ms) ? entry.ms : null,
    args: entry.args ?? null,
    summary: entry.summary ?? null,
    error: entry.error ? String(entry.error).slice(0, 300) : null,
  };
  usageRing.push(rec);
  if (usageRing.length > USAGE_MAX) usageRing.splice(0, usageRing.length - USAGE_MAX);
  try {
    fs.mkdirSync(lanhuHome(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(usagePath(), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  } catch (e) {
    if (!usageFileBroken) {
      usageFileBroken = true;
      console.warn('[dsh-lanhu] 使用记录落盘失败（不影响功能）：', e.message);
    }
  }
  return rec;
}

/** 读使用记录：内存 ring 优先；空则回读盘上的 jsonl。 */
export function readUsage(opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), USAGE_MAX);
  let list = usageRing.slice();
  let fromDisk = false;
  if (list.length === 0) {
    try {
      const raw = fs.readFileSync(usagePath(), 'utf8');
      list = raw.split('\n').filter(Boolean).slice(-USAGE_MAX)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      fromDisk = true;
    } catch { /* 没有就是没有 */ }
  }
  return {
    total: list.length,
    source: fromDisk ? 'file' : 'memory',
    file: usagePath(),
    entries: list.slice(-limit).reverse(),
  };
}

/** 参数摘要：只留能说明「干了啥」的字段，**Cookie 永远不进日志**。 */
export function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const keys = ['projectId', 'imageId', 'teamId', 'format', 'region', 'minWidth', 'minHeight', 'limit', 'pageUrl', 'outDir', 'sector', 'keyword', 'includeNoise', 'dryRun'];
  const out = {};
  for (const k of keys) {
    const v = args[k];
    if (v !== undefined && v !== null && v !== '' && v !== false) out[k] = v;
  }
  // URL **不要截太短**：曾经截到 120 字符，结果一条只带 pid 的链接在日志里看不出
  // "其实后面还有 image_id"，被误判成"链接不完整"（测试报告 P2-1 就是这么来的）。
  // 蓝湖链接通长约 250–350 字符，这里给足；真超长再截并标出。
  if (args.url) {
    const u = String(args.url);
    out.url = u.length <= LIMITS.urlTruncate ? u : `${u.slice(0, 800)}…(共 ${u.length} 字符)`;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* ==========================================================================
 * 2. HTTP 层
 * ========================================================================== */

/**
 * 按声明编码解码响应体；无声明或声明不可信时，用「UTF-8 → GBK」回退探测。
 * （实测该接口多数返回 charset=utf-8，但 GBK 回退必须保留：老稿子的 json_url 可能是 GBK。）
 */
export function decodeBody(buf, contentType = '') {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1]?.toLowerCase();
  const bad = (s) => (s.match(/\uFFFD/g) || []).length;
  const tryDecode = (enc) => {
    try { return new TextDecoder(enc).decode(buf); } catch { return null; }
  };

  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    const s = tryDecode(declared);
    if (s !== null && bad(s) === 0) return s;
  }
  const utf8 = tryDecode('utf-8') ?? '';
  if (bad(utf8) === 0) return utf8;
  const gbk = tryDecode('gbk');
  if (gbk !== null && bad(gbk) < bad(utf8)) return gbk;
  return utf8;
}

/** 蓝湖各接口的成功码不统一：'00000' / 0 / '0' 都表示成功。 */
export function isSuccessCode(code) {
  return code === 0 || code === '0' || code === '00000';
}

const DEFAULT_TIMEOUT = 30000;

/**
 * 发起一次蓝湖 API 请求并返回解析后的 JSON。
 * @param {string} url
 * @param {{method?: string, body?: unknown, cookie?: string, timeout?: number, accept?: string}} [opts]
 */
export async function apiRequest(url, opts = {}) {
  const { value: cookie, source } = resolveCookie(opts.cookie, { account: opts.account });
  if (!cookie) {
    throw new LanhuError('未找到蓝湖 Cookie。', { hint: COOKIE_HINT });
  }

  const headers = {
    Cookie: cookie,
    Accept: opts.accept ?? 'application/json, text/plain, */*',
    Referer: REFERER,
  };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  // 网络重试：蓝湖域名偶发超时（实测），而**重试一次的收益远大于让调用方自己重来**。
  // 只重试网络层失败（超时/连接错误）——HTTP 4xx/5xx 与业务 code 一律不重试，
  // 否则会把"登录失效"这类确定性错误拖成三次慢失败。
  const attempts = Math.max(1, Number(opts.retries ?? 3));
  let res;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  if (lastErr) {
    const e = lastErr;
    const reason = e?.name === 'TimeoutError' ? `请求超时（${opts.timeout ?? DEFAULT_TIMEOUT}ms）` : `网络请求失败：${e?.message ?? e}`;
    throw new LanhuError(`${reason}（已重试 ${attempts} 次）`, { hint: '检查网络连通性；若在受限网络下，蓝湖域名 lanhuapp.com 需可达。' });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const text = decodeBody(buf, res.headers.get('content-type') || '');

  if (res.status === 401 || res.status === 403) {
    throw new LanhuError(`HTTP ${res.status}：被拒绝（可能是登录态失效或 WAF 拦截）`, { status: res.status, hint: COOKIE_HINT });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LanhuError(
      `响应不是合法 JSON（HTTP ${res.status}，${buf.length} 字节）`,
      { status: res.status, hint: `响应开头：${text.slice(0, 120)}` },
    );
  }

  if (json && json.code !== undefined && !isSuccessCode(json.code)) {
    if (String(json.code) === '30001') {
      throw new LanhuError(`登录已过期（code 30001）`, { code: '30001', hint: COOKIE_HINT });
    }
    throw new LanhuError(`接口返回错误 code=${json.code}：${json.msg ?? ''}`, { code: json.code });
  }

  return { json, text, status: res.status, cookieSource: source, bytes: buf.length };
}

/** 把 `result` / `data` 两种外层形态统一取出。 */
export function unwrap(json) {
  if (json == null) return null;
  if (json.result !== undefined && json.result !== null) return json.result;
  if (json.data !== undefined && json.data !== null) return json.data;
  return json;
}

/* ==========================================================================
 * 3. 蓝湖 API
 * ========================================================================== */

/** 探活 + 团队列表。响应为 result:[{id,name,member_num,...}]。 */
export async function listTeams(opts = {}) {
  const { json } = await apiRequest(`${BASE}/api/account/user_teams?need_open_related=true`, opts);
  const raw = unwrap(json);
  const teams = (Array.isArray(raw) ? raw : []).map((t) => ({
    teamId: t.id,
    name: t.name,
    memberNum: t.member_num,
    role: t.role?.roleCode ?? null,
    cloudType: t.cloud_type,
  }));
  return { teams, teamCount: teams.length };
}

export async function checkAuth(opts = {}) {
  const { value, source, account } = resolveCookie(opts.cookie, { account: opts.account });
  if (!value) {
    return { ok: false, cookieSource: null, error: '未配置 Cookie', hint: COOKIE_HINT };
  }
  try {
    const { teams, teamCount } = await listTeams(opts);
    // 顺手把团队索引同步进档案 —— 团队列表**已经拿到了**，同步是零额外请求的。
    // 这是索引最省事的保鲜方式：每次探活都把 teamId → 账号 的映射刷新一遍。
    if (account) {
      try {
        const doc = loadAccounts();
        const entry = doc.accounts.find((a) => a.alias === account);
        if (entry) {
          entry.teams = (teams ?? []).map((t) => ({ teamId: t.teamId, name: t.name, memberNum: t.memberNum }));
          entry.teamsSyncedAt = new Date().toISOString();
          saveAccounts(doc);
        }
      } catch { /* 索引同步失败绝不影响探活结果 */ }
    }
    return {
      ok: true,
      account: account ?? null,
      cookieSource: source,
      cookieMasked: maskCookie(value),
      expiry: cookieExpiry(value),
      teamCount,
      teams,
    };
  } catch (e) {
    return { ok: false, cookieSource: source, error: e.message, code: e.code ?? null, hint: e.hint ?? COOKIE_HINT };
  }
}

/** 团队目录（项目 + 分组）。POST body {tenantId, parentId:0}。 */
export async function listDirectory(teamId, opts = {}) {
  if (!teamId) throw new LanhuError('缺少 teamId（先跑 listTeams 拿一个）。');
  const { json } = await apiRequest(`${BASE}/workbench/api/workbench/abstractfile/list`, {
    ...opts,
    method: 'POST',
    body: { tenantId: teamId, parentId: 0 },
  });
  const raw = unwrap(json) ?? [];
  const entries = (Array.isArray(raw) ? raw : []).map((e) => ({
    id: e.id,
    sourceId: e.sourceId,
    sourceName: e.sourceName,
    sourceType: e.sourceType,
    updateTime: e.updateTime,
  }));
  return {
    projects: entries.filter((e) => e.sourceType === 'dc_prj'),
    folders: entries.filter((e) => e.sourceType === 'folder'),
    all: entries,
  };
}

/** 项目分组。未挂分组的项目返回空数组（实测），此时直接走 listImages。 */
export async function listSectors(projectId, opts = {}) {
  if (!projectId) throw new LanhuError('缺少 projectId。');
  const { json } = await apiRequest(`${BASE}/api/project/project_sectors?project_id=${encodeURIComponent(projectId)}`, opts);
  const raw = unwrap(json);
  const sectors = (raw?.sectors ?? []).map((s) => ({ id: s.id, name: s.name, imagesNum: s.images_num ?? s.image_num ?? null }));
  return { sectors };
}

/** 项目下的设计稿列表。**不需要分组**，未分组项目同样能列全（修正了需求书坑 1 的假设）。 */
export async function listImages(projectId, opts = {}) {
  if (!projectId) throw new LanhuError('缺少 projectId。');
  const url = `${BASE}/api/project/images?project_id=${encodeURIComponent(projectId)}&team_id=0&dds_status=1`;
  const { json } = await apiRequest(url, opts);
  const raw = unwrap(json);
  const images = (raw?.images ?? []).map((i) => ({
    imageId: i.id,
    name: i.name,
    width: i.width,
    height: i.height,
    group: (i.group ?? []).map((g) => g.name ?? g),
    updateTime: i.update_time,
  }));
  return { projectId, projectName: raw?.name ?? null, images };
}

/**
 * 这份 `imageDetail` 是不是「空壳」—— 即这张稿**当前账号读不到**。
 *
 * ⚠️ **蓝湖对不属于当前账号的稿子不报错，而是静默返回空壳**：
 *      `{ imageId, d2cUrl: null, versionLayoutData: null }`（不泄露存在性）。
 *    实测三种情况：
 *      · 项目真 + 稿假 → 抛 `code=10009 Image not exist`
 *      · 全假 UUID     → **不抛错**，返回空壳
 *      · 项目假 + 稿真 → **不抛错**，返回空壳
 *
 * 所以「这张稿能不能读」的判据是**有没有真实数据**，不是**有没有抛错**。
 * 按抛错判会让每个账号都"命中" —— 多账号归属探测会整个失效（真踩过）。
 * 真实稿子会带 `name` / `jsonUrl` / `width`。
 */
export function isReadableDetail(detail) {
  return Boolean(detail && (detail.jsonUrl || detail.name));
}

/**
 * 稿详情 → json_url（两步走的第一步）。
 *
 * `opts.version` = 版本 id 或 `'latest'`（默认）。**给了具体版本就必须命中**（B1），
 * 命中不了抛 `VERSION_NOT_FOUND` —— 静默回退到 latest 会让调用方以为拿到了指定版本。
 *
 * ⚠️ 版本为空（空壳）时**不在这里抛错**：那是"当前账号读不到"的信号，
 *    由 fetchDesignTree 用更准的话说（见 isReadableDetail 的长注释）。
 */
export async function imageDetail(projectId, imageId, opts = {}) {
  if (!projectId || !imageId) throw new LanhuError('imageDetail 需要 projectId 与 imageId。');
  const url = `${BASE}/api/project/image?pid=${encodeURIComponent(projectId)}&image_id=${encodeURIComponent(imageId)}`;
  const { json } = await apiRequest(url, opts);
  const raw = unwrap(json) ?? {};
  const versions = Array.isArray(raw.versions) ? raw.versions : [];
  const explicitVersion = opts.version == null || opts.version === '' ? null : String(opts.version);
  // URL 里带的版本：**只在没显式传 version 时**作为默认值 —— 你浏览器里看的是哪版就读哪版。
  const urlVersion = explicitVersion ? null : (opts.urlVersionId ? String(opts.urlVersionId) : null);
  const want = explicitVersion ?? urlVersion ?? 'latest';
  let version = null;
  let urlVersionIgnored = null;
  if (versions.length > 0) {
    try {
      version = pickVersion(versions, want);
    } catch (e) {
      // URL 里那个 versionId 很可能属于**同一条链接里的另一份东西**（实测：编辑页链接同时带
      // docId 与 image_id，versionId 属于那份文档）。这不该报错；但**显式传 version 时仍严格报错**。
      if (urlVersion && e?.code === 'VERSION_NOT_FOUND') {
        version = pickVersion(versions, 'latest');
        urlVersionIgnored = urlVersion;
      } else throw e;
    }
  } else if (want !== 'latest') {
    throw new LanhuError(`指定的版本不存在：${want}（该稿在当前账号下没有任何版本）。`, { code: 'VERSION_NOT_FOUND' });
  }
  return {
    imageId: raw.id ?? imageId,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    versionId: version?.id ?? null,
    jsonUrl: version?.json_url ?? null,
    d2cUrl: version?.d2c_url ?? null,
    versionLayoutData: version?.version_layout_data ?? null,
    // 版本透明度：调用方要能知道"我拿到的是第几版、还有没有更新的版本"
    versionCount: versions.length,
    // requested 报**实际用的**那个版本，别把"URL 里没用上的那个"说成 requested
    versionRequested: urlVersionIgnored ? 'latest' : want,
    versionFromUrl: Boolean(urlVersion) && !urlVersionIgnored,
    urlVersionIgnored,
    versionLatestId: versions[0]?.id ?? null,
    versionIsLatest: versions.length > 0 ? String(versions[0]?.id) === String(version?.id) : null,
    latestVersionAt: versions[0]?.create_time ?? null,
    account: opts.account ?? null,
  };
}

/** 全局搜索。未挂分组的稿子用这个找最稳。 */
export const SEARCH_TYPES = ['dc_prj', 'board', 'ts_single_doc', 'folder', 'dc_prj_image', 'dc_prj_prd'];

export async function search(teamId, keyword, opts = {}) {
  if (!teamId) throw new LanhuError('search 需要 teamId。');
  const { json } = await apiRequest(`${BASE}/workbench/api/workbench/abstractfile/search`, {
    ...opts,
    method: 'POST',
    body: {
      tenantId: teamId,
      keyword: keyword ?? '',
      sourceType: opts.sourceType ?? SEARCH_TYPES,
      pageNo: opts.pageNo ?? 1,
      pageSize: opts.pageSize ?? 20,
    },
  });
  const raw = unwrap(json) ?? {};
  const images = (raw.dc_prj_image?.items ?? []).map((it) => ({
    imageId: it.itemId,
    projectId: it.sourceId,
    name: it.itemName,
    projectName: it.sourceName,
    path: it.path,
    thumbnail: it.itemUrl,
  }));
  const projects = (raw.dc_prj?.items ?? []).map((it) => ({
    projectId: it.itemId ?? it.sourceId,
    name: it.itemName,
    path: it.path,
  }));
  const prds = (raw.dc_prj_prd?.items ?? []).map((it) => ({
    prdId: it.itemId,
    projectId: it.sourceId,
    name: it.itemName,
    path: it.path,
  }));
  return { images, projects, prds, keyword: keyword ?? '' };
}

/** 拉图层树（两步走：详情拿 json_url → 取 JSON）。内置 A2：docId 失效时自动找回。 */
export async function fetchDesignTree(projectId, imageId, opts = {}) {
  let detail;
  try {
    detail = await imageDetail(projectId, imageId, opts);
  } catch (e) {
    // A2 · docId 失效（被重新上传过）→ 用 product_documents 找回当前有效的那份，而不是把错误丢给调用方
    const gone = String(e?.code) === '10009' || /Image not exist/i.test(String(e?.message ?? ''));
    if (!gone || opts._noRelocate || !opts.teamId) throw e;
    const rel = await relocateDocId({ projectId, teamId: opts.teamId, docId: imageId, pageId: opts.pageId }, opts);
    const moved = await imageDetail(projectId, rel.docId, opts);
    detail = { ...moved, relocatedFrom: rel.relocatedFrom, relocatedTo: rel.docId, relocateCandidates: rel.candidates };
  }
  if (!detail.jsonUrl) {
    // 空壳 ≠ "稿子坏了"：蓝湖对**当前账号读不到**的稿子就是返回空壳。
    // 多账号场景下这是最常见的原因，报错必须点出来，否则会被误当成"该稿没生成图层数据"。
    if (!isReadableDetail(detail)) {
      throw new LanhuError(`当前账号读不到这张稿（${imageId}）。`, {
        hint: '蓝湖对不属于当前账号的稿子会**静默返回空壳**、不报错。若是多账号场景，'
          + '用 `lanhu_accounts` 或 `lanhu who --url "<蓝湖链接>"` 确认这张稿该用哪个账号，再指定 account 重试。',
        code: 'EMPTY_DETAIL',
      });
    }
    throw new LanhuError(`稿 ${imageId} 没有 json_url（可能还没有生成图层数据，或该稿类型不支持）。`);
  }
  const tree = await fetchJsonUrl(detail.jsonUrl, opts);
  // 原型（Axure）与设计稿**不是同一种树**：原型是 {pages, sitemap}，设计稿是 {artboard, …}。
  // 拿设计稿的解析器去跑原型树不会抛错，只会得到"1 层"这种**看起来像结果**的垃圾 —— 必须拦住。
  const isProto = !tree.artboard && Boolean(tree.pages || tree.sitemap);
  const expect = opts.expect ?? 'design';
  if (isProto && expect === 'design') {
    throw new LanhuError('这是**原型/产品文档**（Axure），不是设计稿 —— 它的图层树在 `pages` 里，用设计稿解析器只会得到空结果。', {
      code: 'PROTOTYPE_NOT_DESIGN',
      hint: '改用 lanhu_read_product_doc 读它（页面树 + 正文）；想找设计稿请用 lanhu_list_designs。',
    });
  }
  if (!isProto && expect === 'prototype') {
    throw new LanhuError('这是**设计稿**，不是原型/产品文档。', {
      code: 'DESIGN_NOT_PROTOTYPE',
      hint: '改用 lanhu_read_design / lanhu_read_blocks 读它。',
    });
  }

  // ⭐ Sketch 插件格式（`type: sketchPlugin`）：**归一化后走同一条解析链**。
  //   以前这里不管它 → `tree.artboard ?? tree` 退化成"把整棵树当画板" →
  //   `read_blocks` 静默输出「共 1 块：画板 1」+ 空表（看着像成功，其实什么都没解析）。
  let out = tree;
  let sourceFormat = null;
  let unsupported = null;
  if (expect === 'design') {
    if (isSketchPluginTree(out)) {
      const norm = normalizeSketchPluginTree(out);
      sourceFormat = 'sketchPlugin';
      out = norm.tree;
      // 归一化出来了 **0 个**（画板之外的）子层 → 这份稿的 `info[]` 里没有可用图层。
      //   **不许**再让下游拿到"只有画板"的树（那正是「共 1 块：画板 1」的来源），这里就标记清楚。
      if (norm.layerCount === 0) {
        unsupported = {
          code: 'SKETCH_PLUGIN_NO_LAYERS',
          format: 'sketchPlugin',
          layerCount: 0,
          rawItemCount: Array.isArray(tree?.info) ? tree.info.length : 0,
          what: 'Sketch 插件导出（`type: sketchPlugin`）',
          why: '本插件**认**这种格式（图层在 `info[]` 里），但这张稿的 `info[]` 里取不出任何子层 —— 数据不全或结构异常。',
        };
      }
    } else if (!out?.artboard) {
      // 既没有 `artboard`（设计稿）、也没有 `info[]`（Sketch 插件）、也没有 `pages/sitemap`（原型）
      //   → 认不出的树。**不许静默**：以前会摊出 1 层（树自己）当成"1 块画板"。
      unsupported = {
        code: 'UNKNOWN_TREE_FORMAT',
        format: 'unknown',
        layerCount: 0,
        rawItemCount: null,
        what: '认不出的图层树格式',
        why: '这棵树**既没有 `artboard`**（Figma / Sketch 稿）**也没有 `info[]`**（Sketch 插件导出）'
          + '**也没有 `pages`/`sitemap`**（Axure 原型）—— 本插件没有能解析它的路径。',
      };
    }
  }
  return { detail, tree: out, bytes: 0, sourceFormat, unsupported };
}

/* ==========================================================================
 * 3b. 产品文档（PRD / Axure 原型）
 *
 * 与「设计稿」是**两套东西**：设计稿是像素级的图（image 接口 + 图层 JSON），
 * 产品文档是 Axure 导出的**原型/需求文档**（product_documents 接口 + sitemap + 页面 HTML）。
 * 两者都挂在同一个 project 下，但接口、数据结构、能回答的问题完全不同：
 *   · 设计稿 → 「这个按钮什么颜色、几 px 圆角」
 *   · 原型   → 「这一步的业务规则是什么、字段有哪些、跳转去哪」
 * ========================================================================== */

/** Axure 的 `color` 是 32 位整数。实测高字节常是 `0xFF`（不透明），也有它是真 alpha 的时候
 *  （渐变 stop 的 `color` 高字节与同项的 `opacity` 对得上，例如 0x1A ≈ 0.098）。
 *
 * ⚠️ 2026-09 更正：上面"为 0 当不透明"**是错的**。拿一份真实原型（439 个控件）核过：
 *   `0x7f58a2cc` ↔ `opacity: 0.4980392156862745`（127/255 = 0.4980392156862745，**精确相等**）、
 *   `0x4c58a2cc` ↔ 0.2980392156862745、`0x3358a2cc` ↔ 0.2 —— **129 个样本 0 个不一致**；
 *   而高字节 `0x00` 的 101 个填充**全都配 `opacity: 0`**（真·透明）。
 *   结论：高字节**就是 alpha**，没有例外。旧实现 `a === 0 ? 1 : …` 会把**透明当成不透明**。
 *   （当时它没有任何调用点，所以没造成线上问题 —— 但那是个等着被踩的坑。） */
export function argbColor(n) {
  const p = argbParts(n);
  if (!p) return null;
  const hex = '#' + [p.r, p.g, p.b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return { hex, alpha: p.a };
}

/** `/api/project/product_documents` 的时间是 **RFC 2822**（如 `Sat, 12 Sep 2026 22:30:43 GMT`），
 *  和其它接口的 ISO8601 不是一套 —— 直接 `new Date()` 解析在部分环境会得到 Invalid Date。 */
export function parseRfc2822(value) {
  if (!value) return null;
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return String(value);
  return new Date(t).toISOString();
}

/**
 * 解析**产品文档/原型**链接。
 *
 * ⚠️ **URL 解析的分工（两层）—— 先在这里选对入口，别乱试：**
 *
 * ```
 * 底层（宽容，只抽参数不校验）：lanhuUrlParams(raw) → { params, pick }
 *   ↑ 由下面**三个语义入口**共用；**新增解析一律复用它**，不要再抄一遍抽取循环
 *
 * 上层（按"你要什么"选，各自负责校验与报错）：
 *   parseLanhuUrl(url)      → 要**某一张设计稿**：**必须有 image_id**，没有就抛错
 *                             （也接受 2~3 个裸 uuid：projectId imageId [teamId]）
 *   parseProjectTarget(url) → 要**某个项目**（列出该项目全部设计稿）：**不要求 image_id**
 *                             （项目页/列表页链接本来就没有它）
 *   parseProductUrl(url)    → 要**一份产品文档/原型**：认 docId / pageId / versionId
 *                             （原型链接形如 `#/item/project/product?...&docId=…&docType=axure`）
 *
 * 胶水层：resolveTarget({ projectId, imageId, url }) —— 只做"显式 id 优先，否则解析 url"，
 *         给 read/blocks/slices 这类"可能给 id 也可能给链接"的入口用。
 * ```
 *
 * **别用 `parseLanhuUrl` 干前两者之外的事**：它面向"单张稿"，硬套到项目页/原型页会报
 * "没找到设计稿 id"（实测踩过）。自检里有一条**反向断言**专门守着它"必须继续要求 image_id"。
 */
export function parseProductUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new LanhuError('请粘贴一个蓝湖产品文档（原型）链接，形如 https://lanhuapp.com/web/#/item/project/product?tid=…&pid=…&docId=…');
  // 参数抽取走**共享底层** `lanhuUrlParams` —— 这里以前抄了一份逐行相同的循环（真重复）。
  const { pick } = lanhuUrlParams(raw);
  const uuid = (v) => (v && UUID_RE.test(v) ? v : null);
  const teamId = uuid(pick('tid', 'team_id', 'teamId'));
  const projectId = uuid(pick('project_id', 'projectId', 'pid'));
  // docId 与 image_id 在原型链接里通常同值（原型文档也走 image 接口），两个都认。
  const docId = uuid(pick('docId', 'doc_id', 'image_id', 'imageId'));
  const pageId = pick('pageId', 'page_id');
  const versionId = uuid(pick('versionId', 'version_id', 'vid'));
  return { teamId, projectId, docId, pageId, versionId, url: raw };
}

/** 产品文档列表。`resources[]` 里 `type==='axure'` 才是原型文档（同项目下还会有别的类型）。 */
export async function productDocuments(projectId, teamId, opts = {}) {
  if (!projectId) throw new LanhuError('product_documents 需要 projectId。');
  if (!teamId) throw new LanhuError('product_documents 需要 teamId（tid）—— 蓝湖这个接口不接受缺省团队。');
  const url = `${BASE}/api/project/product_documents?team_id=${encodeURIComponent(teamId)}&project_id=${encodeURIComponent(projectId)}`;
  const { json } = await apiRequest(url, opts);
  const raw = unwrap(json) ?? {};
  const all = Array.isArray(raw.resources) ? raw.resources : [];
  const docs = all.map((d) => ({
    docId: d.id,
    type: d.type,
    name: d.name,
    updateTime: parseRfc2822(d.update_time),
    createTime: parseRfc2822(d.create_time),
    isReplaced: Boolean(d.is_replaced),
    latestVersion: d.latest_version ?? null,
    lastVersionNum: d.last_version_num ?? null,
    group: d.group ?? null,
    // 界面「文档」面板按 order **倒序**且是滚动区 —— 带上它，调用方才能把
    // "界面上只看到前几个"与"接口给了全部"对上号（实测有人据此以为插件读错了）
    order: d.order ?? null,
    width: d.width ?? null,
    height: d.height ?? null,
  }));
  return {
    projectId,
    teamId,
    defaultGroupId: raw.default_group_id ?? null,
    needGroup: raw.need_group ?? null,
    docCanDownload: raw.doc_can_download ?? null,
    total: docs.length,
    axureDocs: docs.filter((d) => d.type === 'axure'),
    docs,
  };
}

/** 项目信息（名称 / 文件夹 / 创建者）。`doc_info=1` 让接口顺带回文档信息。 */
export async function multiInfo(projectId, teamId, opts = {}) {
  if (!projectId) throw new LanhuError('multi_info 需要 projectId。');
  const qs = new URLSearchParams({ project_id: projectId, doc_info: '1' });
  if (teamId) qs.set('team_id', teamId);
  const { json } = await apiRequest(`${BASE}/api/project/multi_info?${qs}`, opts);
  const raw = unwrap(json) ?? {};
  return {
    projectId,
    name: raw.name ?? null,
    folderName: raw.folder_name ?? null,
    creatorName: raw.creator_name ?? null,
    teamId: raw.team_id ?? teamId ?? null,
    memberCount: raw.member_cnt ?? null,
    scale: raw.scale ?? null,
  };
}

/**
 * 取"项目信息"（名称 / 文件夹 / 创建者）—— **失败降级，但留痕**。
 *
 * 项目信息是**锦上添花**：取不到不该让整次调用失败（它只影响输出里一行「项目：…」）。
 * 但也**不许静默** —— 调用方必须能分清"这个项目真没有名字"和"我们没取到"。
 * 所以返回 `{ info, error }`：`info` 为 null 时 `error` 一定有值（短原因，可直接打进人读文本）。
 *
 * ⚠️ 以前这里是 `multiInfo(...).catch(() => null)` —— 输出只是**少一行**，
 * 看不出是"真没有"还是"取失败"，与本项目"不静默"的原则不符。
 */
export async function tryProjectInfo(projectId, teamId, opts = {}) {
  try {
    return { info: await multiInfo(projectId, teamId, opts), error: null };
  } catch (e) {
    return { info: null, error: String(e?.message ?? e).slice(0, 120) || '未知原因' };
  }
}

/**
 * **B1 · 固定版本选择**（纯函数，便于自检）。
 *
 * 为什么必须有：不指定版本时拿到的是 `latest`。设计稿一更新，**代码与稿子就不是同一版了，
 * 而且调用方不会知道**——"我照着这版做的"这句话会悄悄失去依据。
 * 给了 `version` 就必须命中，**命中不了要报错，绝不静默回退到 latest**（静默回退比报错更坏：
 * 调用方会以为自己拿到的是指定版本）。
 *
 * @param {Array} versions `/api/project/image` 的 `result.versions`
 * @param {string} [requested] 版本 id，或 'latest'（默认）
 */
export function pickVersion(versions, requested) {
  const list = Array.isArray(versions) ? versions : [];
  if (list.length === 0) throw new LanhuError('该稿没有任何可读版本（versions 为空）。');
  const want = requested == null || requested === '' ? 'latest' : String(requested);
  let selected;
  if (want === 'latest') {
    selected = list[0];
  } else {
    selected = list.find((v) => String(v.id) === want) ?? null;
    if (!selected) {
      const ids = list.slice(0, 5).map((v) => v.id).join('、');
      throw new LanhuError(`指定的版本不存在：${want}`, {
        code: 'VERSION_NOT_FOUND',
        hint: `该稿共 ${list.length} 个版本。最近的版本 id：${ids}${list.length > 5 ? ' …' : ''}。`
          + '不传 version 即取最新版（latest）。',
      });
    }
  }
  if (!selected.id) throw new LanhuError('选中的版本没有 id。', { code: 'VERSION_UNAVAILABLE' });
  if (!selected.json_url) {
    throw new LanhuError(`版本 ${selected.id} 没有 json_url（该版本可能还没生成数据，或类型不支持）。`, { code: 'SOURCE_UNAVAILABLE' });
  }
  return selected;
}

/** 稿的全部版本（精简字段）—— 给"我想看有哪些版本"用的。 */
export async function imageVersions(projectId, imageId, opts = {}) {
  if (!projectId || !imageId) throw new LanhuError('imageVersions 需要 projectId 与 imageId。');
  const url = `${BASE}/api/project/image?pid=${encodeURIComponent(projectId)}&image_id=${encodeURIComponent(imageId)}`;
  const { json } = await apiRequest(url, opts);
  const raw = unwrap(json) ?? {};
  const versions = (raw.versions ?? []).map((v) => ({
    id: v.id,
    type: v.type ?? null,
    createTime: v.create_time ?? null,
    info: v.version_info ?? null,
    jsonUrl: v.json_url ?? null,
    d2cUrl: v.d2c_url ?? null,
    hasLayoutData: Boolean(v.version_layout_data),
    comments: v.comments ?? null,
  }));
  return { imageId: raw.id ?? imageId, name: raw.name ?? null, width: raw.width ?? null, height: raw.height ?? null, versions };
}

/**
 * **A2 · docId 失效自动找回**（核心函数，read_design / read_blocks / read_product_doc 共用）。
 *
 * 场景：原型/设计稿被**重新上传**后，URL 里冻结的旧 docId 会失效，蓝湖回 `code=10009 Image not exist`。
 * 旧行为是把这个错误直接抛给调用方 —— 但项目里明明有一个**当前有效**的同名文档。
 * 消歧依据用 `pageId`：**它跨版本稳定**（实测，同页在不同版本里 id 不变），
 * 所以"哪个候选里有这个 pageId"就是正确答案。
 *
 * 返回 `{ docId, relocatedFrom, docName, candidates }`；找不到就抛错并**列出候选**引导用户改用列表工具。
 */
export async function relocateDocId({ projectId, teamId, docId, pageId }, opts = {}) {
  const listed = await productDocuments(projectId, teamId, opts);
  const axure = listed.axureDocs.filter((d) => !d.isReplaced);
  const pool = axure.length > 0 ? axure : listed.axureDocs;
  if (pool.length === 0) {
    throw new LanhuError(`项目下未找到任何 axure 原型文档（docId=${docId} 已失效）。`, {
      code: 'DOC_NOT_FOUND',
      hint: '用 lanhu_list_product_documents 看该项目有哪些产品文档；若都没有，说明这张稿不是原型，而是设计稿。',
    });
  }
  const one = (d) => ({ docId: d.docId, relocatedFrom: docId, docName: d.name, candidates: pool.length });
  if (pool.length === 1) return one(pool[0]);

  // 多个候选：用 pageId 跨版本稳定的特性消歧
  if (pageId) {
    for (const d of pool) {
      try {
        // ⚠️ 必须显式 expect:'prototype'：这里逐个试读的就是原型文档，
        //    用默认的 'design' 会被 PROTOTYPE_NOT_DESIGN 守卫全部拦掉，消歧静默失效（真踩过）。
        const { detail } = await fetchDesignTree(projectId, d.docId, { ...opts, _noRelocate: true, expect: 'prototype' });
        const tree = await fetchJsonUrl(detail.jsonUrl, opts);
        const found = flattenSitemap(tree.sitemap?.rootNodes ?? []).some((n) => String(n.pageId) === String(pageId));
        if (found) return one(d);
      } catch { /* 单个候选读不到就跳过，不影响其它候选 */ }
    }
  }
  const list = pool.map((d) => `docId=${d.docId} 名称=${d.name}`).join('；');
  throw new LanhuError(`docId=${docId} 已失效，且项目下有 ${pool.length} 个 axure 文档，无法确定用哪个。`, {
    code: 'DOC_AMBIGUOUS',
    hint: `候选：${list}。请用 lanhu_list_product_documents 选定后用 docId 重新调用${pageId ? '（已尝试用 pageId 消歧但未命中）' : '（传 pageId 可自动消歧）'}。`,
  });
}

/** 取任意 JSON（json_url / CDN 资源），带 Cookie 与重试。 */
export async function fetchJsonUrl(url, opts = {}) {
  const { value: cookie } = resolveCookie(opts.cookie, { account: opts.account });
  const attempts = Math.max(1, Number(opts.retries ?? 3));
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookie ?? '', Referer: opts.referer ?? REFERER, Accept: 'application/json, text/plain, */*' },
        signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new LanhuError(`拉取失败：HTTP ${res.status}（${url.slice(0, 100)}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const text = decodeBody(buf, res.headers.get('content-type') || '');
      try { return JSON.parse(text); } catch {
        throw new LanhuError('响应不是合法 JSON（编码或权限问题）。', { hint: `响应开头：${text.slice(0, 120)}` });
      }
    } catch (e) {
      lastErr = e;
      if (e instanceof LanhuError && /^拉取失败/.test(e.message)) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

/** 取文本资源（HTML / data.js），带 Cookie 与重试。 */
export async function fetchTextUrl(url, opts = {}) {
  const { value: cookie } = resolveCookie(opts.cookie, { account: opts.account });
  const attempts = Math.max(1, Number(opts.retries ?? 3));
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookie ?? '', Referer: opts.referer ?? REFERER },
        signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT),
      });
      if (!res.ok) throw new LanhuError(`拉取失败：HTTP ${res.status}（${url.slice(0, 100)}）`);
      return { text: decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') || ''), bytes: 0 };
    } catch (e) {
      lastErr = e;
      if (e instanceof LanhuError && /^拉取失败/.test(e.message)) throw e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * 展平 sitemap → 页面清单。
 * `id` 就是 `pageId`，**跨版本稳定**（A2 的消歧依据就是它）。
 */
export function flattenSitemap(roots, parentPath = '', level = 0, out = []) {
  for (const node of roots ?? []) {
    const name = node.pageName ?? node.name ?? '';
    const path = parentPath ? `${parentPath} / ${name}` : name;
    out.push({
      pageId: node.id ?? null,
      pageName: name,
      type: node.type ?? null,
      url: node.url ?? null,
      level,
      path,
    });
    if (Array.isArray(node.children) && node.children.length) flattenSitemap(node.children, path, level + 1, out);
  }
  return out;
}

/**
 * 产品文档清单的表格（**工具与 CLI 共用**）。
 *
 * 抽出来有两个理由，都是实测换来的：
 * ① 两边各写一遍时，**同一个"多一个空列"的 bug 出现了两次**（单元格带了前导 `|`，而行模板已收尾）；
 * ② 抽成纯函数后，自检可以**直接断言行列数一致**，不必发网络请求。
 */
export function productDocsTable(docs, opts = {}) {
  const withPages = Boolean(opts.withPages);
  const header = `| # | 序 | 名称 | docId | 最新版本 | 版本数 | 更新时间 | 已替换 |${withPages ? ' 页面节点 / 可读页 |' : ''}`;
  const sep = `|---|---|---|---|---|---|---|---|${withPages ? '---|' : ''}`;
  const rows = (docs ?? []).map((d, i) => {
    // ⚠️ 单元格内容 + **收尾**竖线；**不能带前导 `|`**（行模板已经收尾了）
    const pages = withPages ? ` ${d.pages?.nodes == null ? '?' : `${d.pages.nodes} / ${d.pages.readable}`} |` : '';
    return `| ${i + 1} | ${d.order ?? '—'} | ${d.name} | ${d.docId} | ${d.latestVersion ?? '—'} | ${d.lastVersionNum ?? '—'} | ${d.updateTime ?? '—'} | ${d.isReplaced ? '**是**' : '否'} |${pages}`;
  });
  return { header, sep, rows };
}

/**
 * 数 sitemap 的规模：`nodes` = 页面节点总数（含 Folder），`readable` = 有 `url` 的真正可读页。
 *
 * 抽成纯函数是为了能**离屏自检** —— 它服务于 `withPages`，而那条路要发 N 次网络请求。
 * ⚠️ **Folder 节点没有 `url`**，所以"节点数"与"可读页数"是**两个数**，别混用：
 * 实测同一份原型 219 个节点 / 188 个可读页。
 */
export function countSitemapPages(roots) {
  let nodes = 0;
  let readable = 0;
  const walk = (list) => {
    for (const n of list ?? []) {
      if (!n || typeof n !== 'object') continue;
      if (n.pageName || n.name || n.url) {
        nodes += 1;
        if (n.url) readable += 1;
      }
      if (Array.isArray(n.children) && n.children.length) walk(n.children);
    }
  };
  walk(Array.isArray(roots) ? roots : []);
  return { nodes, readable };
}

/**
 * 标题里的"名字"该怎么打印 —— **所有标题打印点都必须走它**。
 *
 * 为什么需要它：原型页面的 `meta.name` 是**页面树路径**（`A / B / C` 拼起来的），
 * 直接插进去会被读成"**把多页合并了**"（实测有人据此误报过一次）。
 * 判定放在**源头**（`meta.nameIsPath`），打印点统一走本函数 ——
 * 这样**以后新增打印点不会又漏**（曾经漏过 `# 块级清单 —` 那条）。
 */
export function titleName(meta) {
  const n = String(meta?.name ?? '');
  if (!n) return '';
  return meta?.nameIsPath ? `路径：${n}` : n;
}

/** 解 HTML 实体（Axure 导出的正文是**实体编码**的，如 `&#x9996;&#x9875;` = 首页）。 */
export function decodeHtmlEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return _; } })
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/**
 * 从 Axure 页面 HTML 里抽出**可见文本**。
 *
 * ⚠️ 实测教训：本项目拿到的 axure 原型，`data.js` 里的 `page.diagram.objects` **文本与标注都是空的**
 *    （对象只有 `vectorShape`/`connector`，`label` 全空 —— 因为原稿是以矢量/图片形式导出的）。
 *    正文**只存在于 HTML**里，而且是实体编码的。所以"读原型正文"必须走 HTML，
 *    不能只解析 data.js（只解析 data.js 会得到"这页没内容"的假结论）。
 */
export function extractHtmlText(html, opts = {}) {
  const limit = Number(opts.limit ?? 200);
  const body = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const seen = new Set();
  const out = [];
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const t = decodeHtmlEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (!t || t.length < 1) continue;
    if (/^[\s\-—·•|/\\]+$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** 从 data.js 里抽原生 Axure 控件的文本与标注（**有就用，没有不报错** —— 见 extractHtmlText 的实测教训）。 */
export function extractAxureObjects(data) {
  const page = data?.page ?? {};
  const objects = page.diagram?.objects ?? [];
  const keep = [];
  const walk = (arr, depth) => {
    for (const o of arr ?? []) {
      const text = typeof o.rich === 'string' ? o.rich : (typeof o.text === 'string' ? o.text : null);
      const anns = o.anns && typeof o.anns === 'object' ? Object.values(o.anns).map((a) => (typeof a === 'string' ? a : a?.text ?? '')).filter(Boolean) : [];
      if (text || anns.length || (o.label && depth <= 1)) {
        keep.push({
          label: o.label || null,
          type: o.type ?? null,
          friendlyType: o.friendlyType ?? null,
          text: text ? decodeHtmlEntities(text).slice(0, 200) : null,
          annotations: anns,
          depth,
        });
      }
      if (Array.isArray(o.objects)) walk(o.objects, depth + 1);
    }
  };
  walk(objects, 0);
  return {
    pageName: page.name ?? null,
    annotations: (page.annotations ?? []).map((a) => (typeof a === 'string' ? a : a?.text ?? '')).filter(Boolean),
    notes: page.notes ?? {},
    objectCount: objects.length,
    kept: keep,
  };
}

/** 解析 `$axure.loadCurrentPage(lanhu_Axure_Mapping_Data({…}))` 这类包装，取出里面那个 JSON 对象。 */
export function parseAxureJs(text) {
  const s = String(text ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new LanhuError('data.js 里没有找到 JSON 对象（格式可能变了）。');
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {
    throw new LanhuError(`data.js 解析失败：${e.message}`, { hint: '蓝湖的 axure 导出格式可能已变，请重新取证。' });
  }
}

/* ==========================================================================
 * 3c. 可移植算法（B2 字体需求 / B3 切图密度 / B4 几何间距）
 *
 * 三个都是**纯函数**：输入普通数据、输出普通数据，不碰网络 —— 这样自检能直接喂正反例，
 * 不用起桩、不用真机。
 * ========================================================================== */

/**
 * **B2 · 字体需求聚合**。
 *
 * 为什么需要：`read_design` 的 tokens 里有 `fontFamilies`（**去重的名字列表**），
 * 但它回答不了"**要装哪些字体、每个字体用了多少处、涉及哪些字重**"——
 * 而那正是把设计稿交给前端时要交代的第一件事（漏装字体 = 整页回退到系统字体）。
 * 照搬不了：一个字体出现在 48 个文本层里，和只出现 1 次，交付时的优先级完全不同。
 *
 * `availability` 刻意是 `'not_checked'`：**本插件不检测本机是否装了该字体**
 * （那需要枚举系统字体，跨平台不可靠）。不假装校验过。
 */
export function fontRequirements(layers) {
  const byFamily = new Map();
  for (const l of layers ?? []) {
    const family = l?.font?.family;
    if (!family) continue;
    if (!byFamily.has(family)) {
      byFamily.set(family, { family, weights: new Set(), sizes: new Set(), nodeCount: 0, sampleNodeIds: [] });
    }
    const e = byFamily.get(family);
    if (l.font.weight != null) e.weights.add(l.font.weight);
    if (l.font.size != null) e.sizes.add(l.font.size);
    e.nodeCount += 1;
    if (e.sampleNodeIds.length < 5 && l.id) e.sampleNodeIds.push(l.id);
  }
  return [...byFamily.values()].map((e) => ({
    family: e.family,
    weights: [...e.weights].sort((a, b) => Number(a) - Number(b)),
    sizes: [...e.sizes].sort((a, b) => Number(a) - Number(b)),
    nodeCount: e.nodeCount,
    sampleNodeIds: e.sampleNodeIds,
    availability: 'not_checked',
    source: 'design',
  })).sort((a, b) => b.nodeCount - a.nodeCount || String(a.family).localeCompare(String(b.family)));
}

/**
 * **B3 · 切图密度判定**（纯函数）。
 *
 * `effective_density = 实际像素 ÷ 渲染尺寸`；小于 `targetDpr` 就是**素材本身不够清晰**
 * （不是引用方式的问题）—— 这能把 README 里那条"别信图片预览"从**定性提醒**变成**可判定数值**。
 *
 * 矢量图（SVG）没有密度概念，返回 `null` 而不是 1：`1` 会被误读成"正好 1 倍"。
 * 渲染尺寸未知时返回 `null` + `reason`，**不猜**。
 */
export function assetDensity({ pixelWidth, pixelHeight, renderWidth, renderHeight, isVector = false, targetDpr = 2 } = {}) {
  const dpr = Number(targetDpr) > 0 ? Number(targetDpr) : 2;
  if (isVector) return { effectiveDensity: null, resolutionLimited: false, reason: 'vector', targetDpr: dpr };
  if (!(Number(renderWidth) > 0) || !(Number(renderHeight) > 0)) {
    return { effectiveDensity: null, resolutionLimited: null, reason: 'render-bounds-unavailable', targetDpr: dpr };
  }
  if (!(Number(pixelWidth) > 0) || !(Number(pixelHeight) > 0)) {
    return { effectiveDensity: null, resolutionLimited: null, reason: 'pixel-size-unavailable', targetDpr: dpr };
  }
  const x = Number(pixelWidth) / Number(renderWidth);
  const y = Number(pixelHeight) / Number(renderHeight);
  return {
    effectiveDensity: { x: round2(x), y: round2(y) },
    resolutionLimited: Math.min(x, y) + 1e-6 < dpr,
    reason: null,
    targetDpr: dpr,
  };
}

/**
 * **B3 的配对**：把切图（裸 URL，只有实际像素）对到图层（有渲染尺寸）上。
 *
 * ⚠️ 为什么只能"精确匹配 + 唯一才认"：实测 `tree.assets` 是**裸 URL 数组**，
 *    既没有 `render_bounds`，也没有和图层 id 的对应关系（那是别人数据通道才有的字段）。
 *    能站得住的唯一依据是 **渲染尺寸 × sliceScale = 期望像素**。
 *    一旦有多个图层算出同样的期望像素（比如一排 20×20 的图标），**就不认**——
 *    宁可返回 `layerId: null` 让调用方自己判断，也不要配错。
 */

/**
 * B3 的**汇总口径** —— 把「有没有一张真的被评估过」显式化：
 *   `null` = 一张都没评估（**空列表 ≠ 都达标**）
 *   `[]`   = 评估过了，且没有一张被判定为分辨率不足
 *
 * 抽成纯函数是为了能离屏断言（`selfcheck`），不必真跑一次切图下载。
 * 恒定返回 `[]` 会被读者当成"全部达标" —— 实测踩过，是最坏的一种误导。
 */
export function densityLimitedOf(files, limited) {
  const evaluated = (files ?? []).some((f) => f?.density && f.density.effectiveDensity != null);
  if (!evaluated) return null;
  return (limited ?? []).map((f) => ({
    file: f.file,
    effectiveDensity: f.density.effectiveDensity,
    matchedLayerId: f.matchedLayerId ?? null,
  }));
}

export function matchAssetsToLayers(assets, layers, sliceScale) {
  const scale = Number(sliceScale) > 0 ? Number(sliceScale) : null;
  const list = (assets ?? []).map((a) => (typeof a === 'string' ? { url: a } : a));
  if (!scale) return list.map((a) => ({ ...a, layerId: null, layerName: null, renderWidth: null, renderHeight: null, matched: false, reason: 'slice-scale-unavailable' }));
  const cands = (layers ?? []).filter((l) => l?.hasImage && Number(l.w) > 0 && Number(l.h) > 0);
  const used = new Set();
  return list.map((a) => {
    if (!(Number(a.width) > 0) || !(Number(a.height) > 0)) {
      return { ...a, layerId: null, layerName: null, renderWidth: null, renderHeight: null, matched: false, reason: 'pixel-size-unavailable' };
    }
    const hits = cands.filter((l) => !used.has(l.id)
      && Math.abs(l.w * scale - a.width) <= 1
      && Math.abs(l.h * scale - a.height) <= 1);
    if (hits.length !== 1) {
      return { ...a, layerId: null, layerName: null, renderWidth: null, renderHeight: null, matched: false, reason: hits.length === 0 ? 'no-layer-match' : 'ambiguous' };
    }
    used.add(hits[0].id);
    return { ...a, layerId: hits[0].id, layerName: hits[0].name, renderWidth: hits[0].w, renderHeight: hits[0].h, matched: true, reason: null };
  });
}

/**
 * **B4 · 几何间距**（纯函数）。
 *
 * 只在**另一轴有重叠**的两个元素之间算最近边距 —— 这条限定是关键：
 * 不限定的"最近元素"会把斜对角的元素也算进来，得出的距离在还原时毫无意义
 * （页面里的间距几乎都是"同一条水平/垂直线上相邻两块之间"）。
 *
 * x / y 各自独立；每个节点每个方向只留**最近的一条**（否则 N 个元素会产生 O(N²) 条，没人看得完）。
 *
 * @param {Array<{id:string,x:number,y:number,w:number,h:number}>} items
 */
export function geometricGaps(items, opts = {}) {
  const maxDistance = Number.isFinite(opts.maxDistance) ? Number(opts.maxDistance) : Infinity;
  // ⚠️ **内部键必须按"元素身份"而不是 `id`**：调用方可能压根不给 id，或给的是**会重复**的 id
  //    （Figma 导出的 `I37:2804;3` 这种）。键一撞，"每个元素每方向只留最近一条"就退化成
  //    "所有撞键的元素共用一个名额"—— **大部分关系被静默丢掉**，输出看着像"这里就只有这几条间距"
  //    （本仓库最忌讳的"数据有、输出无"；实测踩过：4 个元素的夹具本该 5 条，只出了 2 条）。
  //    `id` 仍然原样带在 gap.from/to 上，供展示与调用方使用。
  const list = (items ?? [])
    .filter((i) => i && Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.w) && Number.isFinite(i.h))
    .map((it, i) => ({ ...it, __k: `#${i}` }));
  const nearest = new Map();
  const axes = [['x', 'y', 'w', 'h'], ['y', 'x', 'h', 'w']];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      // 完全重合的两个矩形是**重复图层**（Figma 实例的 id 还会重复，如 `I37:2804;3`），
      // 它们之间的"间距 0"不是设计意图，只会把真正的间距挤出榜首。
      if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) continue;
      for (const [axis, other, size, otherSize] of axes) {
        // 另一轴必须有重叠，否则不是"相邻"，是斜对角
        const low = Math.max(a[other], b[other]);
        const high = Math.min(a[other] + a[otherSize], b[other] + b[otherSize]);
        if (high <= low) continue;
        let left;
        let right;
        if (a[axis] + a[size] <= b[axis]) { left = a; right = b; } else if (b[axis] + b[size] <= a[axis]) { left = b; right = a; } else continue; // 该轴本身重叠 → 无间距可言
        const distance = round2(right[axis] - left[axis] - left[size]);
        if (distance > maxDistance) continue;
        const gap = {
          from: left.id ?? null,
          to: right.id ?? null,
          // 名字必须带上：**Figma 导出的 id 会重复**（`I37:2804;3` 这种），
          // 只给 id 的话输出里会出现"自己到自己"，调用方无法分辨是哪个图层。
          fromName: left.name ?? null,
          toName: right.name ?? null,
          axis,
          distance,
          overlap: { start: round2(low), end: round2(high) },
        };
        for (const key of [`${a.__k}|${axis}|+`, `${b.__k}|${axis}|-`]) {
          const cur = nearest.get(key);
          if (!cur || distance < cur.distance) nearest.set(key, gap);
        }
      }
    }
  }
  // 去重：同一条间距可能被两个节点各记一次（互为最近邻），只留一条
  const uniq = new Map();
  for (const g of nearest.values()) {
    const key = `${g.from}|${g.to}|${g.axis}|${g.distance}|${g.overlap.start}|${g.overlap.end}`;
    if (!uniq.has(key)) uniq.set(key, g);
  }
  return [...uniq.values()].sort((a, b) => a.axis.localeCompare(b.axis) || a.distance - b.distance);
}

/** B4 的文本渲染：每个节点每个方向只列**最近的一条**（全列会 O(N²)，没人看得完）。 */
export function renderGaps(gaps, limit = LIMITS.gapsLimit, opts = {}) {
  const L = [];
  L.push(`## 几何间距（${gaps.length} 条；只在另一轴有重叠的相邻元素之间算，x/y 各自独立）｜${unitBasisNote(opts.designWidth)}`);
  L.push('> 用途：还原时**直接抄间距**，不用拿坐标手算。');
  L.push('> 「重叠」= 两条边在另一轴上的共同区间 —— 没有重叠说明是斜对角，那种距离不能当间距用。');
  L.push('');
  L.push('| 从 | 到 | 轴 | 间距 | 重叠区间 |');
  L.push('|---|---|---|---|---|');
  const nm = (id, name) => `${name || '(无名)'}${id ? ` \`${String(id).slice(0, 18)}\`` : ''}`;
  for (const g of gaps.slice(0, limit)) L.push(`| ${nm(g.from, g.fromName)} | ${nm(g.to, g.toName)} | ${g.axis} | ${dual1(g.distance, opts.designWidth, opts)} | ${g.overlap.start}~${g.overlap.end} |`);
  if (gaps.length > limit) L.push(`| … | | | 其余 ${gaps.length - limit} 条略 | |`);
  return L.join('\n');
}

/**
 * 两个元素是不是**同一个**（同一图层）。
 *
 * 优先比 `path`（蓝湖的图层路径唯一且带层级）；没有 path 时退回"矩形完全重合"——
 * 但那条**只能当兜底**：父子层尺寸几乎重合时它认不出来，所以调用方**应该给 path**。
 */
function sameElement(a, b) {
  if (a?.path && b?.path) return a.path === b.path;
  return a === b;
}

/**
 * `b` 是不是 `a` 的**祖先或后代**（同一棵树上的上下层关系）。
 *
 * ⚠️ 必须先于任何"边界重合"判定执行：阴影层/背景层几乎撑满父层，四条边全部落在容差内，
 * 会被报成"齐平" —— 那是**子层撑满父层**，不是设计上的对齐决策，抄进 CSS 毫无意义。
 * 实测（示例弹窗）：`Section - ModalDialogCard`(depth1) 与它的 `:shadow`(depth2) 尺寸几乎相同，
 * 一次就产出 4 条 `X 顶 ≡ X 顶` 这种"自己跟自己"。
 */
function isAncestor(a, b) {
  const pa = a?.path;
  const pb = b?.path;
  if (!pa || !pb) return false;
  return pb.startsWith(`${pa}/`) || pa.startsWith(`${pb}/`);
}

/**
 * **对齐检测**（纯函数）—— `renderGapDigest` 的第二类关系。
 *
 * `geometricGaps` 只报"两块之间**有距离**"的关系，报不出"两块**齐平**"（两条边重合时它是 `continue`，
 * 因为那不算间距）。而实测里"说明块底 ≡ 头像底"这类关系跟间距一样要抄进 CSS，所以单独算。
 *
 * 判据（**写死在这里，别散落**）：
 *   · 两条边的坐标差 ≤ `tol`（默认 0.5px —— 设计稿坐标是浮点，字面等于几乎不可靠）
 *   · 另一轴"有关联"：**有重叠** 或 **间隙 ≤ `maxCrossGap`**（默认 120px）
 *     —— 少了这一条，同一张画布上任意两块只要数值凑巧接近都会被报成"对齐"，输出就没人看了。
 */
export function alignedEdges(items, opts = {}) {
  const tol = Number.isFinite(opts.tol) ? Number(opts.tol) : 0.5;
  const maxCrossGap = Number.isFinite(opts.maxCrossGap) ? Number(opts.maxCrossGap) : 120;
  const list = (items ?? []).filter((i) => i && Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.w) && Number.isFinite(i.h));
  const crossOk = (lo1, hi1, lo2, hi2) => {
    const overlap = Math.min(hi1, hi2) - Math.max(lo1, lo2);
    if (overlap > 0) return true;                      // 另一轴有重叠
    const gap = Math.max(lo1, lo2) - Math.min(hi1, hi2); // 另一轴的间隙
    return gap <= maxCrossGap;
  };
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      // ⚠️ 自我成对 / 祖先-后代成对一律排除（实测踩过）：
      //    · `X ≡ X`（"我的顶和我的顶齐平"）对读的人是**纯噪声**；
      //    · 父子更常见也更隐蔽 —— 阴影层/背景层会**几乎撑满**父层，四条边全部"重合"，
      //      输出成 `Section - ModalDialogCard 顶 ≡ Section - ModalDialogCard:shadow 顶` 这种
      //      （截断后看着就是自己跟自己）。**子层撑满父层不是设计决策，抄进 CSS 没有意义。**
      //    身份判定优先用 `path`（唯一且含层级）；没有 path 的老调用方退回"矩形完全重合"这一条。
      if (sameElement(a, b) || isAncestor(a, b)) continue;
      // 完全重合的重复图层（Figma 实例 id 会重复）之间的"对齐"没有信息量
      if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) continue;
      const cands = [
        ['顶', a.y, b.y, crossOk(a.x, a.x + a.w, b.x, b.x + b.w)],
        ['底', a.y + a.h, b.y + b.h, crossOk(a.x, a.x + a.w, b.x, b.x + b.w)],
        ['左', a.x, b.x, crossOk(a.y, a.y + a.h, b.y, b.y + b.h)],
        ['右', a.x + a.w, b.x + b.w, crossOk(a.y, a.y + a.h, b.y, b.y + b.h)],
      ];
      for (const [label, ea, eb, ok] of cands) {
        if (!ok) continue;
        if (Math.abs(ea - eb) <= tol) out.push({ from: a, to: b, edge: label, value: round2(ea) });
      }
    }
  }
  return out;
}

/**
 * **「间距一览」段** —— 可直接抄进 CSS 的块间关系（**§4.2**）。
 *
 * ⚠️ 几何**一律复用 `geometricGaps()`**（region 用的同一套纯函数）：同一个稿子换个入口看
 *    必须得到同一个答案。本仓库刚因为"同一个 bug 出现两次"做过一次重构（0.4.1），
 *    **不许再写第二份间距实现**。
 *
 * ⚠️ 这是本批最险的一段：**几何算错的输出比没有更糟**（AI 会照抄）。
 *    所以：① 两类关系的判据都写死在上面的纯函数里；② 名字取不到就用坐标兜底而不是瞎猜；
 *    ③ 条数封顶，宁可少列也不列错。
 *
 * @param {Array<{id?:string,name?:string,x:number,y:number,w:number,h:number}>} items
 */
/**
 * 「间距一览」里的**显示名**（带去歧义）。
 *
 * 两个坑，都会让输出"看着像自己跟自己"：
 *   · **同名**：同名兄弟/父子层（`Section - ModalDialogCard` 与它的 `:shadow`）；
 *   · **截断后撞车**：列宽有限只显示 22 字，长名被截到同一个前缀 —— 上面那一对截完都是
 *     `Section - ModalDialogC`，读的人**分不清是哪两块**（实测踩过）。
 * 撞车时补 `#d<深度>`；深度也一样就再编号。判据只看"截断后的名字是否有多个不同元素在用"。
 */
function makeLabeler(list) {
  const short = (o) => String(o.name ?? `(${round2(o.x)},${round2(o.y)})`).replace(/\|/g, '\\|').slice(0, 22);
  const identity = (it, idx) => it.path ?? `#${idx}`;
  const users = new Map(); // 截断名 → 有几个**不同元素**在用它
  list.forEach((it, idx) => {
    const k = short(it);
    if (!users.has(k)) users.set(k, new Set());
    users.get(k).add(identity(it, idx));
  });
  const byId = new Map();
  for (const it of list) if (it.id != null) byId.set(String(it.id), it);
  const used = new Map();  // 最终名 → 已用次数（同名的再撞就编号）
  const cache = new Map();
  const of = (it, idx) => {
    if (!it) return '?';
    // ⚠️ 身份键**必须**按元素取：没有 path 时退回 `#下标`，而 `of()` 常被直接传元素调用 ——
    //    若这里不补 `indexOf`，所有无 path 的元素会共用 `#0` 这一个键，标签**全部变成第一个元素的名字**
    //    （实测踩过：齐平段一夜之间全成了"头像 ≡ 头像"）。
    const i = idx ?? list.indexOf(it);
    const key = identity(it, i);
    if (cache.has(key)) return cache.get(key);
    let out = short(it);
    if ((users.get(out)?.size ?? 0) > 1) out = `${out} #d${it.depth ?? '?'}`;
    const n = (used.get(out) ?? 0) + 1;
    used.set(out, n);
    if (n > 1) out = `${out}(${n})`;
    cache.set(key, out);
    return out;
  };
  return {
    of,
    /** 间距行只带 `from`/`to`（= item.id）与名字 —— 用 id 找回元素，走同一套去歧义。 */
    byRef: (id, name) => {
      const it = id != null ? byId.get(String(id)) : null;
      if (it) return of(it, list.indexOf(it));
      return String(name ?? '?').replace(/\|/g, '\\|').slice(0, 22);
    },
  };
}

export function renderGapDigest(items, opts = {}) {
  const designWidth = Number(opts.designWidth);
  const limit = Number.isFinite(opts.limit) ? Number(opts.limit) : LIMITS.gapDigestMaxRows;
  // ⚠️ 进来先保证**每个元素都有唯一 id**：`geometricGaps` 只会把 `from`/`to`（= id）带回来，
  //    没有 id 时它给的是 `null`，间距行就只能退回**原始截断名** —— 同名/截断撞车时会显示成
  //    两个一模一样的名字（"看着像自己跟自己"）。有 id 才能走同一套去歧义。
  const list = (items ?? [])
    .filter((i) => i && Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.w) && Number.isFinite(i.h))
    // ⚠️ **画板自己（depth 0）必须排除**：它的 x/y 是**画布绝对坐标**，而其余元素是**画板相对坐标** ——
    //    两者相减就是跨坐标系相减，出来的是垃圾间距。实测（某稿，画板在画布 1312,6805）：
    //    10 条间距里 **3 条是「XX ↕ 画板 – 1 = 5987px / 6018px」**，而该稿画板对角只有 551px。
    //    这与「内边距」、以及「region 间距」是同**一个病根**的**第三个漏网分支** ——
    //    三处都排除掉，别再让第四个出现（新加几何计算时先问一句：这堆元素的坐标系一致吗？）。
    .filter((i) => i.depth !== 0)
    .map((it, i) => ({ ...it, id: it.id ?? it.path ?? `#${i}` }));
  if (list.length < 2) return '';
  const gapsAll = geometricGaps(list, { maxDistance: opts.maxDistance });
  // ⚠️ **0 距离（贴边）不计入间距表**：实测 610 层的稿会产出 315 条，绝大多数是"文字碎片紧挨着"
  //    的 0px 行 —— 它们把真正的间距（2/6/8/20px 那种竖向节奏）**全挤出了前几行**，
  //    表就失去"可抄 CSS"的意义了。贴边是"相邻"，不是"间距"。表头会写明这条口径。
  //    排序也改成**按距离**（最紧的在前），否则"先 x 轴后 y 轴"会让竖向节奏永远排在横向后面。
  const gaps = gapsAll.filter((g) => g.distance > 0).sort((a, b) => a.distance - b.distance);
  const aligns = alignedEdges(list, opts);
  if (gaps.length === 0 && aligns.length === 0) return '';

  const lab = makeLabeler(list);
  const L = [];
  L.push(`## 间距一览（可抄 CSS —— ${unitBasisNote(designWidth)}）`);
  L.push('> 间距只在**另一轴有重叠**的相邻两块之间算（斜对角的距离不是间距）；↕ = 上下关系，↔ = 左右关系。');
  L.push('> **贴边（0px）不计入** —— 那是"相邻"不是"间距"，列进来会把真正的间距挤出前几行。按距离从紧到松排。');
  L.push('> `≡` 是**齐平**（两条边重合，容差 0.5px）—— 这一类不是间距，但同样要抄。');
  if (gaps.length > 0) {
    L.push('');
    L.push(`### 间距（${gaps.length} 条）`);
    for (const g of gaps.slice(0, limit)) {
      const arrow = g.axis === 'y' ? '↕' : '↔';
      L.push(`- ${lab.byRef(g.from, g.fromName)} ${arrow} ${lab.byRef(g.to, g.toName)} = **${dual1(g.distance, designWidth, opts)}**`);
    }
    if (gaps.length > limit) L.push(`- … 其余 ${gaps.length - limit} 条略（用 region + gapMaxDistance 收窄）`);
  }
  if (aligns.length > 0) {
    L.push('');
    L.push(`### 齐平（${aligns.length} 处）`);
    for (const a of aligns.slice(0, limit)) {
      L.push(`- ${lab.of(a.from)} ${a.edge} ≡ ${lab.of(a.to)} ${a.edge}（${round2(a.value)}px）`);
    }
    if (aligns.length > limit) L.push(`- … 其余 ${aligns.length - limit} 处略`);
  }
  return L.join('\n');
}

/** B2 的文本渲染。 */
export function renderFonts(fonts, meta = {}) {
  const L = [];
  L.push(`# 字体需求（${fonts.length} 个字体族）${meta.name ? ` —— ${titleName(meta)}` : ''}`);
  L.push('> 交付给前端时**照着这张表装字体**：漏装 = 整页回退到系统字体，排版全变。');
  L.push('> `可用性` 一律是 `not_checked` —— 本插件**不检测本机字体**（跨平台枚举不可靠），不假装校验过。');
  L.push('');
  L.push('| 字体族 | 字重 | 字号 | 文本层数 | 样例图层 id |');
  L.push('|---|---|---|---|---|');
  for (const f of fonts) {
    L.push(`| ${f.family} | ${f.weights.length ? f.weights.join('/') : '—'} | ${f.sizes.length ? f.sizes.join('/') : '—'} | ${f.nodeCount} | ${f.sampleNodeIds.slice(0, 3).join('、') || '—'} |`);
  }
  return L.join('\n');
}

/* ==========================================================================
 * 3d. A1 · 读产品文档（PRD / Axure 原型）+ A3 · DDS schema（可选增强）
 * ========================================================================== */

/** 选中要读的页面：给 pageId → 精确；给 pageName → 包含匹配；都不给 → 只返回页面树。 */
export function selectProductPages(pages, { pageId, pageName } = {}) {
  const list = pages ?? [];
  if (pageId) {
    const hit = list.filter((p) => String(p.pageId) === String(pageId));
    if (hit.length === 0) {
      throw new LanhuError(`页面树里没有 pageId=${pageId} 这一页。`, {
        code: 'PAGE_NOT_FOUND',
        hint: `该文档共 ${list.length} 个页面节点。先用不带 pageId 的调用看页面树，或改用 pageName 模糊匹配。`,
      });
    }
    return hit;
  }
  if (pageName) {
    const hit = list.filter((p) => String(p.pageName ?? '').includes(pageName));
    if (hit.length === 0) throw new LanhuError(`没有名称包含「${pageName}」的页面。`, { code: 'PAGE_NOT_FOUND' });
    return hit;
  }
  return [];
}

/** 读一页的正文：data.js（原生控件，可能为空）+ HTML 可见文本（实测正文只在这里）。 */
export async function fetchProductPage(page, opts = {}) {
  const entry = opts.pagesIndex?.[page.url] ?? null;
  if (!entry) return { ...page, readable: false, reason: '该页在 pages 索引里没有条目（通常是 Folder 节点）' };
  const out = { ...page, readable: true, dataBytes: 0, htmlBytes: 0, objects: null, annotations: [], text: [] };
  // data.js：原生 Axure 控件（本项目实测多为空，但别的稿可能有 —— 有就用）
  if (entry.dataJs?.sign_md5) {
    try {
      const { text } = await fetchTextUrl(`${AXURE_CDN}/${entry.dataJs.sign_md5}`, opts);
      const parsed = parseAxureJs(text);
      const ex = extractAxureObjects(parsed);
      out.objects = { count: ex.objectCount, kept: ex.kept.slice(0, Number(opts.objectLimit ?? 40)) };
      out.annotations = ex.annotations;
      out.dataBytes = text.length;
    } catch (e) { out.dataError = e.message ?? String(e); }
  }
  // HTML：**正文的真正来源**
  if (entry.html?.sign_md5) {
    try {
      const { text } = await fetchTextUrl(`${AXURE_CDN}/${entry.html.sign_md5}`, opts);
      out.htmlBytes = text.length;
      out.text = extractHtmlText(text, { limit: Number(opts.textLimit ?? 120) });
    } catch (e) { out.htmlError = e.message ?? String(e); }
  }
  return out;
}

/* ==========================================================================
 * 3d. 原型（Axure）页面样式 —— 「没有设计稿、只有原型」的项目也要能照着实现
 *
 * 背景：蓝湖的项目里**可能一张设计稿都没有**，只有 Axure 原型（实测某项目
 *   `lanhu_list_designs` 返回 0 张，原型却有 6 个页面）。那时 `read_design` 那条链
 *   一点数据都拿不到，前端只能靠截图猜。
 *
 * 但原型的 `data.js` 里**样式数据是完整的**（实测一份 861 KB / 439 个控件）：
 *   `style.fill` / `foreGroundFill` / `borderFill`（32 位整数色）、
 *   `fontSize` / `fontName` / `fontWeight` / `lineSpacing`、`location` / `size`、
 *   `cornerRadius`、`opacity`、`outerShadow`、`fillType:'linearGradient'` + `stops[]`、`images`。
 *
 * 所以这里的做法是：把控件树规范化成**与设计稿同形状的图层数组**，下游整条链直接复用 ——
 *   `collectTokens`（色板/字号）、`classifyBlock`、`renderRegion`（块级清单）、
 *   以及 `verify_*`（有机会连原型页一起验收）。
 *
 * ⚠️ 与设计稿的差别**必须如实交代**（渲染在输出里，别藏在注释里）：
 *   · 原型是**交互稿**：颜色/字号是设计者随手填的，**不等于最终视觉稿**；
 *   · `location` 是**相对父容器**的，本函数已逐层累加成绝对坐标（设计稿那条链本来就是绝对值）。
 * ========================================================================== */

/**
 * 剥掉 Axure `data.js` 的外层包装，拿到里面的 JSON 对象。
 *
 * 实测外层是两层：`$axure.loadCurrentPage(lanhu_Axure_Mapping_Data({…}))`。
 *
 * ⚠️ **必须做括号配对**：JSON 字符串里会出现 `)` 和 `{`（图层名、图片路径里都有），
 *    用 `lastIndexOf('}')` 这类土办法会切多或切少 —— 实测报
 *    `Unexpected non-whitespace character after JSON`。这里用状态机跟踪字符串与转义。
 */
export function unwrapAxureDocument(text) {
  const s = String(text ?? '');
  if (!s.trim()) throw new LanhuError('data.js 是空的。');
  const start = s.indexOf('{');
  if (start < 0) {
    throw new LanhuError('data.js 里找不到 JSON 起点（蓝湖的导出格式可能变了）。', { hint: `开头：${s.slice(0, 80)}` });
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const slice = s.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch (e) {
          throw new LanhuError(`data.js 解析失败：${e.message}`, { hint: '蓝湖的 axure 导出格式可能已变，请重新取证。' });
        }
      }
    }
  }
  throw new LanhuError('data.js 的 JSON 括号不配对（文件可能被截断）。');
}

/**
 * `objectPaths`：控件 id → HTML 里的 `u###`（文本就挂在 `#u###_text` 上）。
 *
 * ⚠️ **入参是整个文档对象**（`unwrapAxureDocument(...)` 的返回值）—— `objectPaths` 在它**顶层**，
 *    **不在 `page` 里**。传错形状时**必须抛错**：曾经写成 `doc?.objectPaths ?? {}`，
 *    于是传 `doc.page` 或原文 JSON 字符串都**静默返回空 Map** —— 调用方拿到 0 条还以为"这稿没有"，
 *    正是本项目最忌讳的静默失效（实测被误用过）。
 */
export function axureScriptIds(doc) {
  const paths = doc?.objectPaths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    const shape = doc === null || doc === undefined ? String(doc)
      : (typeof doc === 'string' ? 'string（原文 JSON 文本？）' : `object{${Object.keys(doc).slice(0, 5).join(',')}}`);
    throw new LanhuError('axureScriptIds 的入参应该是 **unwrapAxureDocument(...) 的整个返回值**（`objectPaths` 在它顶层）。', {
      code: 'AXURE_WRONG_INPUT',
      hint: `收到的是 ${shape}。常见误用：传了 \`doc.page\`（那样没有 objectPaths）、或传了未剥壳的原文。`
        + '正确：`axureScriptIds(unwrapAxureDocument(dataJsText))`。',
    });
  }
  const out = new Map();
  for (const [id, v] of Object.entries(paths)) {
    if (typeof v?.scriptId === 'string') out.set(id, v.scriptId);
  }
  return out;
}

/** 去标签、解实体、压空白 —— 只留人看得见的文本。 */
function htmlInnerText(fragment) {
  return decodeHtmlEntities(String(fragment ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 从原型页面 HTML 里取文本，并按 `u###` 建索引。
 *
 * ⚠️ **文本不在 data.js 里**：实测 `label` / `rich` 全为空（原稿以矢量/图片导出），
 *    正文只在页面 HTML 中，而且是 **HTML 实体编码**（`&#x7EFF;` = 绿）。
 *    每个控件在 HTML 里是 `<div id="u216">` + `<div id="u216_text">正文</div>`；
 *    文本域是 `<textarea id="u0_input">`。
 */
export function decodeAxureText(html, opts = {}) {
  const s = String(html ?? '');
  const clean = s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const byScriptId = new Map();
  const re = /<(div|textarea|span|p)\b[^>]*\bid="(u\d+)_(?:text|input)"[^>]*>([\s\S]*?)<\/\1>/gi;
  const cap = Number(opts.limit ?? 5000);
  for (const m of clean.matchAll(re)) {
    const text = htmlInnerText(m[3]);
    if (!text) continue;
    if (!byScriptId.has(m[2])) byScriptId.set(m[2], text);
    if (byScriptId.size >= cap) break;
  }
  // 页级文本清单（回答"这一页有哪些字"）—— 复用已验证的抽取器
  const texts = extractHtmlText(clean, { limit: Number(opts.textLimit ?? 300) });
  return { byScriptId, texts };
}


/**
 * 一个节点**看起来像控件**吗 —— 这是判断"某个数组键是不是子层容器"的**唯一判据**。
 *
 * 为什么不能只看键名（`objs`/`objects`/`diagrams`）：Axure 的导出里数组键五花八门
 * （实测出现过 `stops` / `cases` / `actions` / `subExprs` / `arguments` / `objectsToRotate` /
 * `objectPath` / `firedEvents` / `adaptiveViews` / `variables` …），**按名字列白名单必然漏**。
 * 反过来按"元素像不像控件"判断，就不会把这些非子层数组误当子层。
 */
function looksLikeWidgetNode(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v)
    && v.id && (v.type || v.style || v.friendlyType));
}

/**
 * 遍历器**实际会走**的子层键。
 *
 * ⚠️ **改 `normalizeAxurePage` 的遍历器时，必须同步这个数组** —— 不同步，结构审计会红
 * （`auditAxureChildKeys` 就是拿它跟"文档里真实出现的子层键"比对的）。
 * 这不是文档约定，是**被自检钉住的**：见 `test/selfcheck.mjs` 的「结构审计」一组。
 */
export const AXURE_CHILD_KEYS = Object.freeze(['objs', 'objects', 'diagrams']);

/**
 * **结构审计**：扫整份文档，列出"像子层容器"的数组键，并与 `AXURE_CHILD_KEYS` 比对。
 *
 * 起因是一次**真实的静默漏层**：`repeater`（中继器）与 `table`（表格）把子层挂在 `objects[]`，
 * 而遍历器只走了 `objs[]` 与 `diagrams[].objects[]` —— 静默少了 **41 层**；
 * 同一轮还漏了 **11 个状态容器**。两处都属于同一个病：**"子层挂在哪个键上"是靠人看出来的**。
 * 现在把它变成**机器拦下**：`normalizeAxurePage` 每次都会跑这个审计，
 * 一旦出现"文档里有、遍历器不走"的键，就在 `stats.unknownChildKeys` 里报出来并在输出里打警告。
 *
 * 返回：
 *   `childKeys`    —— 文档里实际出现的子层键 `[{key, count, samplePath, handled}]`
 *   `unhandled`    —— **没被遍历器走过**的那些（正常应为空；非空就是真漏层）
 *   `panelDiagram` —— `{ inDoc, viaDiagrams }`：守住 `type !== 'Axure:PanelDiagram'` 那个排除条件
 *                    （容器由 `diagrams` 分支处理，不该再从 `objects` 走一遍；两者数量必须相等）
 */
export function auditAxureChildKeys(doc) {
  const handled = new Set(AXURE_CHILD_KEYS);
  const found = new Map();
  const panelDiagram = { inDoc: 0, viaDiagrams: 0 };
  const rec = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => rec(x, `${path}[${i}]`)); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (Array.isArray(val) && val.some(looksLikeWidgetNode)) {
        const e = found.get(k) ?? { key: k, count: 0, samplePath: `${path}.${k}` };
        e.count += val.length;
        found.set(k, e);
      }
      if (k === 'diagrams' && Array.isArray(val)) {
        panelDiagram.viaDiagrams += val.filter((d) => d?.type === 'Axure:PanelDiagram').length;
      }
      if (v.type === 'Axure:PanelDiagram' && k === 'objects' && Array.isArray(val)) {
        panelDiagram.inDoc += 1;
      }
      rec(val, path ? `${path}.${k}` : k);
    }
  };
  rec(doc, 'doc');
  const childKeys = [...found.values()].map((e) => ({ ...e, handled: handled.has(e.key) }));
  childKeys.sort((a, b) => b.count - a.count);
  return { childKeys, unhandled: childKeys.filter((e) => !e.handled), panelDiagram };
}

/** 32 位整数 → `{r,g,b,a}`。**高字节就是 alpha**（见 argbColor 的实测说明）。 */
export function argbParts(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const u = n >>> 0;
  return {
    r: (u >>> 16) & 0xff,
    g: (u >>> 8) & 0xff,
    b: u & 0xff,
    // ⚠️ **不要 round2**：`0x7f` 精确是 127/255 = 0.4980392156862745，round2 会变成 0.5 —— 
    //    那既不是设计值也不是渲染值。设计稿那条链的 `parseColor` 同样保留全精度，这里对齐它。
    a: ((u >>> 24) & 0xff) / 255,
  };
}

/** Axure 的填充/描边：颜色整数 + **独立的 `opacity` 字段**（两者实测完全一致，见下）。 */
function axureFillColor(fill) {
  if (!fill || typeof fill !== 'object') return null;
  if (fill.fillType === 'linearGradient' || Array.isArray(fill.stops)) return null;
  const p = argbParts(fill.color);
  if (!p) return null;
  const a = fill.opacity === undefined || fill.opacity === null ? p.a : round2(clamp01(Number(fill.opacity)));
  return { r: p.r, g: p.g, b: p.b, a: Number.isFinite(a) ? a : p.a };
}

/** 渐变（`fill` 或 `borderFill` 上的 `linearGradient`）→ 每个 stop 一个色。 */
function axureGradientColors(style) {
  const out = [];
  for (const key of ['fill', 'borderFill']) {
    const f = style?.[key];
    const isGrad = f && (f.fillType === 'linearGradient' || Array.isArray(f.stops));
    if (!isGrad) continue;
    for (const st of f.stops ?? []) {
      const p = argbParts(st.color);
      if (!p) continue;
      const a = st.opacity === undefined || st.opacity === null ? p.a : round2(clamp01(Number(st.opacity)));
      if (!(a > 0)) continue;
      out.push({ r: p.r, g: p.g, b: p.b, a, role: 'gradient' });
    }
  }
  return out;
}

/** `"48px"` / `48` / `"1.4"` → 数字；不确定就 null（**不编造默认值**）。 */
function axureNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : null;
  if (typeof v !== 'string') return null;
  const m = /-?\d+(?:\.\d+)?/.exec(v);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? round2(n) : null;
}

/** `"\"PingFang SC\", sans-serif"` → `PingFang SC`（取主族；带回退栈的整串放进 `fontStack`）。 */
export function axureFontFamily(fontName) {
  const s = String(fontName ?? '').trim();
  if (!s) return null;
  const first = s.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || null;
}

/**
 * **归一化一个 Axure 控件**（纯函数）—— 把 `data.js` 的原始节点算成与设计稿同构的字段。
 *
 * 拆出来的理由：这段占 `normalizeAxurePage` 的大半，而且**全是纯计算**
 * （坐标累加、颜色 role 归类、字体、描边、圆角、内边距），与"怎么遍历、层级怎么传"无关。
 * 单独放一个函数：能单独读懂、能单独测，改颜色规则时不必在 290 行里找。
 *
 * **不做的事**（留在 `normalizeAxurePage`）：遍历子层、维护 origin/depth/继承的可见性与透明度、
 * 生成路径 `path`。这里只回答"**这一个节点**长什么样"。
 *
 * @param {object} o `data.js` 里的一个控件节点
 * @param {object} ctx `{ scriptIds, byScriptId, origin, parentPath, depth, inheritedOpacity, inheritedVisible, parentBox, panelState, containerKind }`
 */
function axureNodeFields(o, ctx) {
  const { scriptIds, byScriptId, origin, parentPath, depth, inheritedOpacity, inheritedVisible, parentBox, panelState, containerKind } = ctx;
  const st = o.style ?? {};
  const loc = st.location && typeof st.location === 'object' ? st.location : null;
  const size = st.size && typeof st.size === 'object' ? st.size : null;
  const rx = loc ? round2(Number(loc.x) || 0) : null;
  const ry = loc ? round2(Number(loc.y) || 0) : null;
  const w = size ? axureNumber(size.width) : null;
  const h = size ? axureNumber(size.height) : null;
  const x = rx === null ? null : round2(origin.x + rx);
  const y = ry === null ? null : round2(origin.y + ry);

  const name = (typeof o.label === 'string' && o.label.trim()) ? o.label.trim() : (o.friendlyType ?? o.type ?? '');
  const path = parentPath ? `${parentPath}/${name}` : name;
  const ownOpacity = axureNumber(st.opacity);
  const effectiveOpacity = round2((ownOpacity === null ? 1 : ownOpacity) * inheritedOpacity);
  const visible = o.visible !== false && inheritedVisible;

  // 文本锚点先取好：颜色与字体都要用它
  const sid = scriptIds.get(o.id) ?? null;

  // 颜色：填充 / 描边 / 文字色 / 渐变 —— 与设计稿同构（`role` 决定下游怎么归类）
  const colors = [];
  const fillC = axureFillColor(st.fill);
  if (fillC && fillC.a > 0) colors.push({ ...fillC, role: COLOR_ROLES.FILL });
  const borderC = axureFillColor(st.borderFill);
  if (borderC && borderC.a > 0) colors.push({ ...borderC, role: 'border' });
  const fgC = axureFillColor(st.foreGroundFill);
  if (fgC && fgC.a > 0) colors.push({ ...fgC, role: COLOR_ROLES.TEXT });
  colors.push(...axureGradientColors(st));

  // 文本：靠 `widgetId → u###` 去 HTML 里取（data.js 里的 label 是空的）
  const text = (sid ? byScriptId.get(sid) : null) ?? (typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null);

  /**
   * 字体。
   *
   * ⚠️ **为什么会有 `size: null`**：实测 144 个有文本的层里，**60 个在导出里就没有字号**
   *    （`style.fontSize` 缺席，只有一个 `baseStyle` 哈希，而那个哈希在整个 data.js 里
   *    **从不当对象键** —— 文档里根本没有样式表，基础样式留在了原始 .rp 里）。
   *
   *    去外链 CSS 找过，**找不到**：`files/<页>/styles.css` 里那 251 条 `#uNNN{font-size}`
   *    经比对**全部**落在"本来就有字号"的控件上（即那份 CSS 是从 data.js **生成**的，不带新信息）；
   *    `data/styles.css` 只能给出 `.ax_default{13px}` 这种**通用兜底** —— 把它当成设计者填的值
   *    就是编造。所以这里**留 null**，渲染成 `?`，宁缺勿错。
   */
  const fontSize = axureNumber(st.fontSize);
  const fontWeight = axureNumber(st.fontWeight);
  const lineHeight = axureNumber(st.lineSpacing);
  const fontName = st.fontName ?? null;
  const font = (fontName || fontSize !== null) ? {
    family: axureFontFamily(fontName),
    fontStack: fontName ? String(fontName) : null,
    size: fontSize,
    weight: fontWeight,
    align: st.horizontalAlignment ?? null,
    lineHeight,
    letterSpacing: null,
  } : null;

  const cr = axureNumber(st.cornerRadius);
  const radius = cr && cr > 0 ? { corners: [cr, cr, cr, cr], max: cr } : null;

  const bw = axureNumber(st.borderWidth);
  let border;
  if (bw && bw > 0) {
    border = {
      color: borderC ? rgbHex(borderC) : null,
      alpha: borderC ? round2(borderC.a) : null,
      colorKnown: Boolean(borderC),
      widths: { top: bw, right: bw, bottom: bw, left: bw },
      width: bw,
      sides: ['top', 'right', 'bottom', 'left'],
      single: null,
    };
  }

  // 内边距：Axure 的 `location` **本来就是相对父容器**的，比设计稿那条链更直接
  const inset = parentBox ? {
    left: rx,
    top: ry,
    right: (w === null || parentBox.w === null) ? null : round2(parentBox.w - (rx ?? 0) - w),
    bottom: (h === null || parentBox.h === null) ? null : round2(parentBox.h - (ry ?? 0) - h),
  } : null;

  const imgKeys = Object.keys(o.images ?? {}).filter((k) => !k.endsWith('-isGeneratedImage'));
  const layer = {
    id: o.id ?? null,
    type: o.type ?? null,
    name,
    parentPath,
    depth,
    x,
    y,
    w,
    h,
    inset,
    visible,
    opacity: ownOpacity === null ? 1 : ownOpacity,
    effectiveOpacity,
    shape: o.friendlyType ?? null,
    radius,
    border,
    colors,
    text,
    font,
    hasImage: imgKeys.length > 0,
    /**
     * ⚠️ **Axure 与 Figma 的一个真语义差异**：Figma 里文字节点的 `fills` **就是文字色**，
     *    所以 `buildBlocks` 对"有文字的层"会把 fill 置 null（否则会把文字色当底色）。
     *    但 Axure 的 `fill`（背景）与 `foreGroundFill`（文字色）是**两个独立字段** ——
     *    同一个文本控件**可以真的有背景**（实测「需求说明」那个文本域带 `#facd91@6%` 底色，
     *    若照 Figma 的规则抹掉，背景就整块丢了）。
     *    这个标记让下游知道："本层的 `role:'fill'` 是真背景，别抹"。
     */
    fillIsBackground: true,
    /** 动态面板的**状态名**（不在面板里就是 null）。这些层是**互斥的备选状态**，不是同时显示的层。 */
    panelState: panelState ? panelState.label : null,
    /** 所属动态面板的控件 id（便于把同一面板的状态归组） */
    panelOf: panelState ? panelState.panelId : null,
    /** 子层挂在哪种容器下：`repeater`（中继器模板）/ `table`（表格单元格）等；普通层为 null */
    containerKind,
    /** 原型专有：Axure 的友好类型（形状/矩形/椭圆/星星/线段/组合）与 HTML 锚点 */
    friendlyType: o.friendlyType ?? null,
    scriptId: sid,
  };
  return layer;
}


/**
 * 把一份原型页面的控件树规范化成**与设计稿同形状**的图层数组。
 *
 * 形状与 `flattenArtboard` 的产物一致（`x/y/w/h` 绝对、`inset` 相对父、
 * `opacity` 自身 / `effectiveOpacity` 累乘、`colors[].role`、`font`、`radius`、`border`），
 * 因此 `collectTokens` / `classifyBlock` / `renderRegion` 可直接吃。
 */
export function normalizeAxurePage({ document: doc, html, pageUrl = null } = {}) {
  if (!doc || typeof doc !== 'object') {
    throw new LanhuError('normalizeAxurePage 需要 document（先用 unwrapAxureDocument 剥壳）。');
  }
  const scriptIds = axureScriptIds(doc);
  const { byScriptId, texts } = decodeAxureText(html ?? {});
  // 结构审计：每次归一化都跑一遍，**发现"文档里有、遍历器不走"的子层键就报出来**（不静默）。
  const audit = auditAxureChildKeys(doc);
  const pageStyle = doc?.page?.style ?? {};
  const pageSize = pageStyle.size ?? {};
  const layers = [];

  // 画板尺寸：实测 `page.style.size` 常是 `{width:0,height:0}`（高度根本没给），
  // 唯一可信的宽度在 `defaultAdaptiveView.size`。两者都为 0 时**用控件包围盒兜底** ——
  // 宁可算出来，也别让下游拿 0×0 的画板去筛区域。
  const declaredW = axureNumber(pageSize.width) || axureNumber(doc?.defaultAdaptiveView?.size?.width) || 0;
  const declaredH = axureNumber(pageSize.height) || axureNumber(doc?.defaultAdaptiveView?.size?.height) || 0;

  // 画板层：与设计稿那条链一样，depth 0 是画板本身
  const artboard = {
    id: doc?.page?.packageId ?? 'page',
    type: 'page',
    name: doc?.page?.name ?? pageUrl ?? '(页面)',
    parentPath: '',
    depth: 0,
    x: 0,
    y: 0,
    w: declaredW || null,
    h: declaredH || null,
    inset: null,
    visible: true,
    opacity: 1,
    effectiveOpacity: 1,
    shape: null,
    radius: null,
    border: undefined,
    colors: [],
    text: null,
    font: null,
    hasImage: false,
  };
  layers.push(artboard);

  const walk = (arr, parentPath, depth, origin, inheritedOpacity, inheritedVisible, parentBox, panelState = null, containerKind = null) => {
    for (const o of arr ?? []) {
    const layer = axureNodeFields(o, {
      scriptIds, byScriptId, origin, parentPath, depth,
      inheritedOpacity, inheritedVisible, parentBox, panelState, containerKind,
    });
    // 递归要用到这几个：从 layer 上取（它们已经是算好的绝对值）
    const { x, y, w, h, effectiveOpacity, visible } = layer;
    const name = layer.name;
    const path = parentPath ? `${parentPath}/${name}` : name;

      layers.push(layer);
      const childOrigin = { x: x ?? origin.x, y: y ?? origin.y };
      const childBox = { w, h };
      walk(o.objs, path, depth + 1, childOrigin, effectiveOpacity, visible, childBox, panelState, containerKind);

      /**
       * **`objects[]`（注意不是 `objs[]`）—— 还有两种容器把子层放这里**：
       *   · `repeater`（中继器）：`objects` 是**按数据重复渲染的模板**；
       *   · `table`（表格）：`objects` 是**单元格/行**。
       * 实测一份稿里有 **41 层**（table 40 + repeater 1）挂在这上面 —— 不走就**静默少 41 个控件**。
       * （`Axure:PanelDiagram` 容器也有 `objects`，但它已经由下面的 `diagrams` 分支处理，这里跳过以免重复。）
       */
      if (Array.isArray(o.objects) && o.type !== 'Axure:PanelDiagram') {
        walk(o.objects, `${path}/（${o.friendlyType ?? o.type ?? '容器'} 子项）`, depth + 1,
          childOrigin, effectiveOpacity, visible, childBox, panelState, o.friendlyType ?? o.type ?? 'container');
      }

      /**
       * **动态面板的状态图**：Axure 把每个状态的控件放在 `diagrams[].objects[]` 里。
       * 实测一份稿有 **7 个面板 / 179 层**（例如一个日历有 August/July/June 三个状态，各 41 层）——
       * 不走会**少掉近三分之一的控件**。
       *
       * ⚠️ 它们是**互斥的备选状态**（同一面板同一时刻只显示一个），导出里也**没有"哪个是当前状态"的字段**
       * （实测找不到 panelIndex / default 之类）。所以路径里带上状态名、层上打 `panelState` ——
       * **让调用方知道这是备选而不是同时显示的层**：既不丢，也不假装。
       *
       * ⚠️ **状态容器自己也要输出**：实测同一面板三个状态的背景色**各不相同**
       * （`#ffffff@29%` / `#118281@29%` / `#ffffff@100%`），而面板自身**没有 fill** ——
       * 只走它的 `objects` 会把「这一状态的背景」整块丢掉。
       * 但容器**没有 `location`/`size`**（Axure 里状态铺满面板，几何继承自面板），
       * 所以用**面板的盒子**当几何，并标 `geometryFromParent: true`（不假装容器自己有坐标）。
       */
      for (const [i, dg] of (o.diagrams ?? []).entries()) {
        const label = (typeof dg?.label === 'string' && dg.label.trim()) || `状态${i + 1}`;
        const dgs = dg?.style ?? {};
        const dgColors = [];
        const dgFill = axureFillColor(dgs.fill);
        if (dgFill && dgFill.a > 0) dgColors.push({ ...dgFill, role: COLOR_ROLES.FILL });
        const dgBorder = axureFillColor(dgs.borderFill);
        if (dgBorder && dgBorder.a > 0) dgColors.push({ ...dgBorder, role: 'border' });
        dgColors.push(...axureGradientColors(dgs));
        const dgCr = axureNumber(dgs.cornerRadius);
        layers.push({
          id: dg?.id ?? null,
          type: dg?.type ?? 'Axure:PanelDiagram',
          name: `（状态 ${label}）`,
          parentPath: path,
          depth: depth + 1,
          x, y, w, h,
          /** ⚠️ 几何取自**所属面板**（容器自己没有 location/size）—— 标出来，别让人以为这是它的坐标 */
          geometryFromParent: true,
          // 几何与不透明度都取自**所属面板那一层**（状态容器自己没有 location/size/opacity）
          inset: layer.inset,
          visible,
          opacity: layer.opacity,
          effectiveOpacity,
          shape: '状态容器',
          radius: dgCr && dgCr > 0 ? { corners: [dgCr, dgCr, dgCr, dgCr], max: dgCr } : null,
          border: undefined,
          colors: dgColors,
          text: null,
          font: null,
          hasImage: false,
          panelState: label,
          panelOf: o.id ?? null,
          containerKind: 'panel-state',
          friendlyType: '状态容器',
          scriptId: null,
        });
        walk(dg?.objects, `${path}/（状态 ${label}）`, depth + 1, childOrigin, effectiveOpacity, visible, childBox,
          { label, panelId: o.id ?? null }, 'panel-state');
      }
    }
  };
  walk(doc?.page?.diagram?.objects, '', 1, { x: 0, y: 0 }, 1, true, {
    w: axureNumber(pageSize.width),
    h: axureNumber(pageSize.height),
  });

  // 声明尺寸缺失时，用控件包围盒把画板尺寸补出来（并标注来源，别让人以为是稿子声明的）
  const bbox = layers.slice(1).reduce((acc, l) => {
    if (l.x === null || l.y === null || l.w === null || l.h === null) return acc;
    return {
      x0: Math.min(acc.x0, l.x), y0: Math.min(acc.y0, l.y),
      x1: Math.max(acc.x1, l.x + l.w), y1: Math.max(acc.y1, l.y + l.h),
    };
  }, { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const bboxOk = Number.isFinite(bbox.x0) && bbox.x1 > bbox.x0;
  if (!artboard.w && bboxOk) artboard.w = round2(bbox.x1 - bbox.x0);
  if (!artboard.h && bboxOk) artboard.h = round2(bbox.y1 - bbox.y0);
  artboard.sizeSource = (declaredW && declaredH) ? 'declared' : (bboxOk ? 'bbox' : 'unknown');

  const stats = {
    layerCount: layers.length,
    widgetCount: layers.length - 1,
    /** 只数控件（**不含画板层**）—— 否则会出现"控件 2 个（可见 3）"这种自相矛盾的话 */
    visibleCount: layers.slice(1).filter((l) => l.visible !== false).length,
    withFill: layers.filter((l) => l.colors.some((c) => c.role === COLOR_ROLES.FILL)).length,
    withText: layers.filter((l) => l.text).length,
    withFont: layers.filter((l) => l.font?.size !== null && l.font?.size !== undefined).length,
    maxDepth: layers.reduce((m, l) => Math.max(m, l.depth), 0),
    /** 画板尺寸的来源：declared=稿子声明 / bbox=控件包围盒算的 / unknown=都没有 */
    sizeSource: artboard.sizeSource,
    pageWidth: artboard.w,
    pageHeight: artboard.h,
    pageTexts: texts.length,
    scriptIdCount: scriptIds.size,
    textIndexCount: byScriptId.size,
    /** **有文本却没有字号**的层数：导出里就没给（见 normalizeAxurePage 里的长注释，别去猜） */
    textLayersWithoutFontSize: layers.filter((l) => l.depth > 0 && l.text && l.font?.size == null).length,
    /** 动态面板状态层（**互斥的备选状态**，不是同时显示的层）—— 含状态容器自己 */
    panelStateLayers: layers.filter((l) => l.panelState).length,
    panelCount: new Set(layers.filter((l) => l.panelOf).map((l) => l.panelOf)).size,
    /** 挂在 `objects[]` 下的子层（中继器模板 / 表格单元格）—— 不是 `objs`，容易漏 */
    containerObjectLayers: layers.filter((l) => l.containerKind && l.containerKind !== 'panel-state').length,
    /** ⚠️ **结构审计**：文档里出现、但遍历器**没走**的子层键。正常为空；非空 = 真漏层，别忽略 */
    unknownChildKeys: audit.unhandled,
    /** 文档里实际出现的子层键（含已走的），便于核对遍历器的覆盖面 */
    childKeys: audit.childKeys.map((e) => ({ key: e.key, count: e.count, handled: e.handled })),
  };
  return { layers, stats, texts };
}

/** 原型页面的文本渲染（`format: 'layers'`）。**必须自己说明"这不是设计稿"**。 */
export function renderProductLayers(result, opts = {}) {
  const L = [];
  const c = result.content?.[0] ?? null;
  L.push(`# 原型页面样式 —— ${result.doc?.name ?? '(未知文档)'}`);
  L.push(`> 路径：${c?.path ?? c?.name ?? '(未指定页)'}${c?.pageId ? `（pageId ${c.pageId}）` : ''}`);
  L.push('> ⚠️ 这是 **Axure 原型**里的样式值，**不是设计稿** —— 颜色/字号是设计者随手填的，');
  L.push('> 可以照着实现，但**最终视觉以 UI 设计稿为准**（有设计稿时用 lanhu_read_design / lanhu_read_blocks）。');
  if (result.project) L.push(`> 项目：${result.project.name ?? '—'}${result.project.folderName ? `（${result.project.folderName}）` : ''}`);
  else if (result.projectInfoError) L.push(`> ⚠️ 项目信息未取到（${result.projectInfoError}）—— 不影响下面的结果`);
  L.push(`> 版本：${result.version?.id ?? '—'}${result.version?.isLatest === false ? `（**不是最新版**，最新 ${result.version.latestId}）` : '（最新版）'}`);
  for (const p of result.content ?? []) {
    L.push('');
    // ⚠️ 必须写"路径：" —— 嵌套页面的 path 是 `A / B / C` 拼起来的，
    //    不标注就会被读成"把多页合并了"（实测我自己就据此误报过一次）。
    L.push(`## 路径：${p.path}（pageId ${p.pageId}）`);
    if (!p.readable) { L.push(`（不可读：${p.reason}）`); continue; }
    const s = p.stats ?? {};
    L.push(`> 控件 ${s.widgetCount ?? '?'} 个（可见 ${s.visibleCount ?? '?'}）· 带底色 ${s.withFill ?? '?'} · 带字号 ${s.withFont ?? '?'} · 带文本 ${s.withText ?? '?'} · 最大层级 ${s.maxDepth ?? '?'}`);
    L.push('> 坐标是**绝对坐标**（已把 Axure 的相对坐标逐层累加）；`不透明`= 图层 opacity 累乘祖先链。');
    if (s.unknownChildKeys?.length) {
      L.push(`> ❌ **还有没被遍历的子层键**：${s.unknownChildKeys.map((e) => `\`${e.key}\`（${e.count} 个，如 ${e.samplePath}）`).join('、')}`);
      L.push('> —— 这些节点**不在下面的清单里**，清单是**不完整的**。请把这个键名报给插件作者（结构审计已拦下，但遍历器还没支持）。');
    }
    if (s.panelStateLayers) {
      L.push(`> ⚠️ 其中 **${s.panelStateLayers} 层属于 ${s.panelCount} 个动态面板的状态**（表里名称带『（状态 X）』）——`
        + '**它们是互斥的备选状态**（同一面板一次只显示一个），**不是同时显示的层**；'
        + '导出里没有"当前是哪个状态"的字段，所以要按业务自己判断。其余层才是同时可见的。');
    }
    if (s.textLayersWithoutFontSize) {
      L.push(`> ⚠️ 其中 **${s.textLayersWithoutFontSize} 个文本层没有字号**（显示为 \`?\`）——`
        + '**导出里就没有**（Axure 把基础样式留在了原始 .rp，导出不带；外链 CSS 只有 `.ax_default{13px}` 这种通用兜底，'
        + '拿它当设计值就是编造）。**别把 `?` 读成 0，也别自己猜一个** —— 以最终设计稿为准。');
    }
    const tk = p.tokens ?? {};
    // ⚠️ `collectTokens` 返回的是**数组**（已按 count 倒序），不是 Map：
    //    `colors:[{hex,alpha,count,rgb}]`、`fontSizes:[{size,count}]`、`fontFamilies:[{family,count}]`。
    //    当成 Map 用会打印出一片 `[object Object]`（实测踩过）。
    const top = (arr, fmt) => (arr ?? []).slice(0, 8).map(fmt).join(' ');
    if (tk.colors?.length) {
      L.push(`> 色板（前 8）：${top(tk.colors, (c) => `${c.hex}${c.alpha < 1 ? `@${Math.round(c.alpha * 100)}%` : ''}×${c.count}`)}`);
    }
    if (tk.fontSizes?.length) L.push(`> 字号（前 8）：${top(tk.fontSizes, (f) => `${f.size}×${f.count}`)}`);
    if (tk.fontFamilies?.length) L.push(`> 字体族（前 8）：${top(tk.fontFamilies, (f) => `${f.family}×${f.count}`)}`);
    // 用**块级表**而不是区域表：块级表本来就把「文字色」与「底色」分开（`isTextLayer` 时 fill 置 null），
    // 且多段渐变打全 stop。这样原型与设计稿的清单**是同一张表** —— AI 不用学第二套。
    // 区域表（renderRegion）的 `填充` 列对"只有文字色的层"会退化成显示文字色，别用那个。
    const blocks = buildBlocks(p.layers ?? [], {});
    L.push('');
    L.push(renderBlocks(blocks, {
      name: p.path,
      // ⚠️ **必须带这个标记**：原型页的 name 是**路径**不是稿名。下游标题统一走 titleName()，
      //    这里漏了它整条链就失灵（已加断言钉住）。
      nameIsPath: true,
      width: p.stats?.pageWidth,
      height: p.stats?.pageHeight,
    }, { limit: Number(opts.limit ?? 60), includeNoise: Boolean(opts.includeNoise) }));
  }
  return L.join('\n');
}

/**
 * 取一页的**原型样式图层**（`format: 'layers'` 用）。
 *
 * 与 `fetchProductPage` 的区别：那个只取"文本与标注"，这个取**整棵控件树的样式**。
 * 两者都从同一对 CDN 资源来（`dataJs` + `html`），所以失败模式也一样 —— 如实报。
 */
export async function fetchProductPageLayers(page, opts = {}) {
  const entry = opts.pagesIndex?.[page.url] ?? null;
  if (!entry) return { ...page, readable: false, reason: '该页在 pages 索引里没有条目（通常是 Folder 节点）' };
  const out = { ...page, readable: true, layers: [], stats: null, tokens: null, dataBytes: 0, htmlBytes: 0 };
  try {
    const { text: dataText } = await fetchTextUrl(`${AXURE_CDN}/${entry.dataJs.sign_md5}`, opts);
    out.dataBytes = dataText.length;
    const doc = unwrapAxureDocument(dataText);
    let html = '';
    if (entry.html?.sign_md5) {
      const r = await fetchTextUrl(`${AXURE_CDN}/${entry.html.sign_md5}`, opts);
      html = r.text;
      out.htmlBytes = html.length;
    }
    const norm = normalizeAxurePage({ document: doc, html, pageUrl: page.url });
    out.layers = norm.layers;
    out.stats = norm.stats;
    out.tokens = collectTokens(norm.layers.filter((l) => l.depth > 0));
  } catch (e) {
    out.readable = false;
    out.reason = e.message ?? String(e);
  }
  return out;
}

/** A1 的文本渲染。 */
export function renderProductDoc(result) {
  const L = [];
  L.push(`# 产品文档（原型）${result.doc?.name ? ` —— ${result.doc.name}` : ''}`);
  L.push('> ⚠️ 这是**产品文档 / 原型（Axure）**，回答"业务规则、字段、跳转"；**不是设计稿**（色值/字号/圆角请用 lanhu_read_design）。');
  if (result.project) L.push(`> 项目：${result.project.name ?? '—'}${result.project.folderName ? `（${result.project.folderName}）` : ''}${result.project.creatorName ? ` · 创建者 ${result.project.creatorName}` : ''}`);
  else if (result.projectInfoError) L.push(`> ⚠️ 项目信息未取到（${result.projectInfoError}）—— 不影响下面的结果`);
  L.push(`> 版本：${result.version?.id ?? '—'}${result.version?.isLatest === false ? `（**不是最新版**，最新 ${result.version.latestId}）` : '（最新版）'} · 共 ${result.version?.count ?? '?'} 个版本`);
  L.push('');
  L.push(`## 页面树（${result.pageCount} 个节点，${result.wireframeCount} 个可读页）`);
  L.push('| 层级 | 类型 | 页面 | pageId |');
  L.push('|---|---|---|---|');
  for (const p of result.pages.slice(0, Number(result.pageTreeLimit ?? 200))) {
    L.push(`| ${'  '.repeat(p.level)}${p.level} | ${p.type ?? '—'} | ${p.path} | ${p.pageId ?? '—'} |`);
  }
  if (result.pageCount > (result.pageTreeLimit ?? 200)) L.push(`| … | | 其余 ${result.pageCount - (result.pageTreeLimit ?? 200)} 个节点略 | |`);
  if (result.content?.length) {
    L.push('');
    L.push(`## 正文（${result.content.length} 页）`);
    for (const c of result.content) {
      L.push(`### ${c.path}（pageId ${c.pageId}）`);
      if (!c.readable) { L.push(`（不可读：${c.reason}）`); continue; }
      if (c.annotations?.length) L.push(`**页级标注**：${c.annotations.join(' / ')}`);
      if (c.objects?.kept?.length) {
        L.push(`**原生控件**（${c.objects.count} 个，列前 ${c.objects.kept.length}）：`);
        for (const o of c.objects.kept) L.push(`- [${o.type ?? '?'}] ${o.text ? `「${o.text}」` : (o.label ? o.label : '(无文本)')}${o.annotations?.length ? ` ⚠️标注：${o.annotations.join(' / ')}` : ''}`);
      } else if (c.dataError || !c.dataBytes) {
        L.push('**原生控件**：data.js 里没有控件数据（实测这套原型是矢量/图片导出，正文只在 HTML）。');
      }
      if (c.text?.length) {
        L.push(`**正文文本**（${c.text.length} 条，取自页面 HTML）：`);
        L.push(c.text.map((t) => `- ${t}`).join('\n'));
      } else if (c.htmlError) L.push(`（HTML 读取失败：${c.htmlError}）`);
      L.push('');
    }
  }
  return L.join('\n');
}

/**
 * **A1 · 读产品文档**：页面树 + 命中页的正文。
 *
 * `pageId` 精确匹配优先（跨版本稳定），`pageName` 模糊匹配次之；**都不给就只返回页面树** ——
 * 219 个页面节点全量抓正文没有意义，让调用方先看树再选页。
 */
export async function readProductDoc(args = {}) {
  const { cookie } = args;
  const parsed = args.url ? parseProductUrl(args.url) : {};
  const projectId = args.projectId ?? parsed.projectId;
  const teamIdIn = args.teamId ?? parsed.teamId;
  const docIdIn = args.docId ?? parsed.docId;
  const pageIdIn = args.pageId ?? parsed.pageId;
  const versionIn = args.version ?? parsed.versionId;
  if (!projectId) throw new LanhuError('需要 projectId（或一条产品文档链接 url）。');

  const picked = await pickAccount({ ...args, projectId, imageId: docIdIn, teamId: teamIdIn });
  const acct = picked.alias;
  const ao = { cookie, account: acct };

  const listed = await productDocuments(projectId, teamIdIn, ao);
  const pi = await tryProjectInfo(projectId, teamIdIn, ao);
  const project = pi.info;
  if (listed.axureDocs.length === 0) {
    throw new LanhuError(`项目 ${projectId} 下没有 axure 原型文档（共 ${listed.total} 个其它类型资源）。`, {
      code: 'DOC_NOT_FOUND',
      hint: '若你要读的是**设计稿**，请用 lanhu_read_design / lanhu_read_blocks。',
    });
  }
  const docId = docIdIn ?? listed.axureDocs[0].docId;
  const doc = listed.axureDocs.find((d) => d.docId === docId) ?? null;
  if (!doc) {
    // 这个 docId 不是原型文档 —— 先查它是不是**设计稿**再开口。
    // （实测：只说"没有这个原型文档"，AI 会去翻文档列表白跑几轮；而它十有八九是拿设计稿链接来问的。）
    const asDesign = await imageDetail(projectId, docId, ao).then((d) => d, () => null);
    if (asDesign && asDesign.jsonUrl) {
      throw new LanhuError(`docId=${docId} 是**设计稿**「${asDesign.name ?? ''}」，不是产品文档（原型）。`, {
        code: 'DESIGN_NOT_PROTOTYPE',
        hint: '这条链接直接给 lanhu_read_design / lanhu_read_blocks 就行。'
          + `本项目里的原型文档有：${listed.axureDocs.map((d) => `${d.docId}(${d.name})`).join('；')}`.slice(0, 600),
      });
    }
    throw new LanhuError(`项目下没有 docId=${docId} 的原型文档。`, {
      code: 'DOC_NOT_FOUND',
      hint: `可选：${listed.axureDocs.map((d) => `${d.docId}(${d.name})`).join('；')}`.slice(0, 600),
    });
  }

  const { detail, tree } = await fetchDesignTree(projectId, docId, {
    ...ao, version: versionIn, teamId: teamIdIn, pageId: pageIdIn, expect: 'prototype',
  });
  const pages = flattenSitemap(tree.sitemap?.rootNodes ?? []);
  const selected = selectProductPages(pages, { pageId: pageIdIn, pageName: args.pageName });
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : 1;
  const chosen = selected.slice(0, limit);
  const format = String(args.format ?? 'doc');
  const content = [];
  if (format === 'layers') {
    // 原型样式的第二条路：不是"这页写了什么规则"，而是"这页长什么样"。
    // 用途是**没有设计稿、只有原型**的项目 —— 那时 read_design 一点数据都没有。
    for (const p of chosen) content.push(await fetchProductPageLayers(p, { ...ao, pagesIndex: tree.pages }));
  } else {
    for (const p of chosen) content.push(await fetchProductPage(p, { ...ao, pagesIndex: tree.pages, textLimit: args.textLimit, objectLimit: args.objectLimit }));
  }

  const versionInfo = {
    id: detail.versionId,
    requested: detail.versionRequested,
    isLatest: detail.versionIsLatest,
    count: detail.versionCount,
    latestId: detail.versionLatestId,
    latestAt: detail.latestVersionAt,
  };
  const result = {
    project,
    // 项目信息没取到时的**原因**（取到了就是 null）—— 见 tryProjectInfo
    projectInfoError: pi.error,
    doc,
    docCount: listed.axureDocs.length,
    version: versionInfo,
    pageCount: pages.length,
    wireframeCount: pages.filter((p) => p.type === 'Wireframe').length,
    pages,
    selectedCount: selected.length,
    content,
    account: acct,
    accountBy: picked.by ?? null,
  };
  result.format = format;
  result.text = format === 'layers'
    ? renderProductLayers(result, { limit: args.layerLimit ?? args.limit })
    : renderProductDoc({ ...result, pageTreeLimit: args.pageTreeLimit });
  result.textBytes = Buffer.byteLength(result.text, 'utf8');
  return result;
}

/**
 * **A3 · DDS schema（可选降级，绝不当主路径）**。
 *
 * ⚠️ 为什么必须"可选 + 失败如实说明"：这条通道是**社区互相扒出来的非官方接口**
 *    （另一个域名 `dds.lanhuapp.com`、独立 Cookie、还有一段硬编码的 Basic 认证头），
 *    与官方无关、**随时可能失效**。它失败了不能影响主流程，更不能假装成功。
 *
 * 成功时返回 `{ ok:true, source:'dds', dataResourceUrl, schema }`；
 * 任何一步失败都返回 `{ ok:false, source:'dds', stage, error }` —— **由调用方决定回退到现有解析**。
 */
export async function ddsSchema(versionId, opts = {}) {
  if (!versionId) return { ok: false, source: 'dds', stage: 'input', error: '需要 versionId（版本 id，不是 imageId）。' };
  const cookie = opts.ddsCookie ?? process.env.DDS_COOKIE ?? resolveCookie(opts.cookie, { account: opts.account }).value;
  if (!cookie) return { ok: false, source: 'dds', stage: 'cookie', error: '没有可用 Cookie（DDS_COOKIE 环境变量或当前账号 Cookie）。' };
  const headers = {
    Cookie: cookie,
    Referer: `${DDS_BASE_URL}/`,
    Accept: 'application/json, text/plain, */*',
    // 蓝湖 DDS 前端自己用的 Basic 头（base64 of "undefined:"）——照社区实测值带上，不带会被拒
    Authorization: 'Basic dW5kZWZpbmVkOg==',
  };
  try {
    const res = await fetch(`${DDS_BASE_URL}/api/dds/image/store_schema_revise?version_id=${encodeURIComponent(versionId)}`, {
      headers, signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT),
    });
    if (!res.ok) return { ok: false, source: 'dds', stage: 'store_schema_revise', error: `HTTP ${res.status}` };
    const json = JSON.parse(await res.text());
    if (!isSuccessCode(json?.code)) return { ok: false, source: 'dds', stage: 'store_schema_revise', error: `code=${json?.code} ${json?.msg ?? ''}`.trim() };
    const url = json?.data?.data_resource_url;
    if (!url) return { ok: false, source: 'dds', stage: 'store_schema_revise', error: '未返回 data_resource_url' };
    const sres = await fetch(url, { headers: { Referer: `${DDS_BASE_URL}/`, Accept: '*/*' }, signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT) });
    if (!sres.ok) return { ok: false, source: 'dds', stage: 'fetch_schema', error: `HTTP ${sres.status}`, dataResourceUrl: url };
    const schema = JSON.parse(await sres.text());
    return { ok: true, source: 'dds', dataResourceUrl: url, schema };
  } catch (e) {
    return { ok: false, source: 'dds', stage: 'network', error: e?.message ?? String(e) };
  }
}

/* ==========================================================================
 * 4. 图层解析
 * ========================================================================== */

/**
 * 颜色归一化 —— 本项目最容易错的一处。
 * 蓝湖 Figma 导出的 color 是 {r,g,b,a} **归一化到 0..1**（type: percentage），
 * 直接 Math.round(c.r) 会得到 #010101 这种垃圾值。优先信现成的 value 字符串，其次按范围推断。
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseColor(c) {
  if (c == null) return null;
  if (typeof c === 'string') {
    const s = c.trim();
    if (!s) return null;
    if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    // rgb() / rgba()：逗号或空格分隔，alpha 前可有 `/` 或 `,` —— 浏览器 getComputedStyle 给的都长这样
    const m = /rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)/i.exec(s);
    if (m) {
      const a = m[4] === undefined ? 1
        : (m[4].endsWith('%') ? clamp01(parseFloat(m[4]) / 100) : clamp01(parseFloat(m[4])));
      return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]), a };
    }
    // #rgb / #rrggbb / #rrggbbaa
    // ⚠️ **设计稿里的色值全是 hex**（tokens、块级模型的 color/bg/border 都是），
    //    比对层必须能解析它。以前这里只认 rgb()/rgba()，hex 一律返回 null，
    //    结果块级比对一跑到颜色判定就崩（实测踩过）。
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
    if (h) {
      let v = h[1];
      if (v.length === 3) v = v.split('').map((x) => x + x).join('');
      const a = v.length === 8 ? clamp01(parseInt(v.slice(6, 8), 16) / 255) : 1;
      return {
        r: parseInt(v.slice(0, 2), 16),
        g: parseInt(v.slice(2, 4), 16),
        b: parseInt(v.slice(4, 6), 16),
        a,
      };
    }
    return null;
  }
  if (typeof c.value === 'string') {
    const parsed = parseColor(c.value);
    if (parsed) return parsed;
  }
  if (typeof c.r === 'number') {
    const s = (v) => (v <= 1 ? clamp255(v * 255) : clamp255(v));
    return { r: s(c.r), g: s(c.g), b: s(c.b), a: typeof c.a === 'number' ? clamp01(c.a) : 1 };
  }
  return null;
}

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }

export function rgbHex({ r, g, b }) {
  return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}

export function rgbaString({ r, g, b, a }) {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round2(a)})`;
}

/** 收集一层上的所有可见色（fills + borders + 文本色）。 */
function layerColors(node) {
  const out = [];
  const style = node.style ?? {};
  for (const f of style.fills ?? []) {
    if (f.isEnabled === false) continue;
    if (f.type === 'color' && f.color) {
      const c = parseColor(f.color);
      if (c && c.a > 0) out.push({ ...c, role: COLOR_ROLES.FILL });
    } else if (f.type === 'gradient' && f.gradient) {
      for (const stop of f.gradient.stops ?? []) {
        const c = parseColor(stop.color);
        if (c && c.a > 0) out.push({ ...c, role: 'gradient' });
      }
    }
  }
  for (const b of style.borders ?? []) {
    if (b.isEnabled === false) continue;
    const c = parseColor(b.color);
    if (c && c.a > 0) out.push({ ...c, role: 'border' });
  }
  const tc = node.text?.style?.color;
  if (tc) {
    const c = parseColor(tc);
    if (c && c.a > 0) out.push({ ...c, role: COLOR_ROLES.TEXT });
  }
  return out;
}

function frameOf(node) {
  const f = node.realFrame ?? node.frame ?? {};
  return { x: round2(f.left), y: round2(f.top), w: round2(f.width), h: round2(f.height) };
}

/**
 * 取图层的圆角。
 *
 * ⚠️ **蓝湖的 `node.radius` 是空壳**：实测整稿 334 个节点的 radius 全是 `{0,0,0,0}`，
 *    真实圆角在 `node.paths[].radius`（例：搜索框 `paths[0].radius` = 12）。
 *    只读 `node.radius` 会让所有圆角变 null —— 实测后果是把 12px 圆角矩形误判成全圆角胶囊。
 */
function radiusOf(node) {
  const candidates = [...(node.paths ?? []).map((p) => p?.radius), node.radius];
  let best = null;
  for (const r of candidates) {
    if (!r || typeof r !== 'object') continue;
    const v = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft].map((x) => round2(x ?? 0));
    const max = Math.max(...v);
    if (max > 0 && (best === null || max > best.max)) best = { corners: v, max };
  }
  return best;
}

/** 形状类型（`rect` / `ellipse` / …），来自 `paths[0].type`。 */
function shapeOf(node) {
  const p = (node.paths ?? [])[0];
  return p && typeof p.type === 'string' ? p.type : null;
}

/**
 * 边框 / 分割线。
 *
 * ⚠️ 为什么必须有：实战案例 2「分割线整条丢失」——设计稿里 1px #E2E8F0 的分割线
 *    在旧版里**既不进图层树也不进比对**，只能靠用户肉眼发现"你都少了分割线"。
 *    真实数据在 `style.borders[]`，每边粗细在 `widths.{left,top,right,bottom}`：
 *      Footer - FixedBottomBar  375×67  widths 0/1/0/0  rgba(226,232,240,1) → 顶部 1px #E2E8F0
 *      Right Location Dropdown  67×16   widths 1/0/0/0  rgba(226,232,240,1) → 左侧 1px
 *    即"这个块有一边描了条线"，是最常见的分割线表达方式。
 */
function borderOf(node) {
  const list = (node.style?.borders ?? []).filter((b) => b.isEnabled !== false);
  if (list.length === 0) return undefined;
  const b = list[0];
  const w = b.widths ?? {};
  const r2 = (x) => round2(x ?? 0);
  const widths = { top: r2(w.top), right: r2(w.right), bottom: r2(w.bottom), left: r2(w.left) };
  let sides = ['top', 'right', 'bottom', 'left'].filter((s) => widths[s] > 0);
  let width = sides.length ? Math.max(...sides.map((s) => widths[s])) : 0;

  // ⚠️ 有些边框 `widths` 四边全是 0，但总 `width` 有值（且 style 是 solid）——
  //    这是蓝湖没填每边宽度，实测在新版 Web 稿里很常见（130 个带边框的层里有 26 个这样）。
  //    按总宽兜底成"四边"，否则这些边框会被整条丢掉。
  if (sides.length === 0 && (b.width ?? 0) > 0) {
    sides = ['top', 'right', 'bottom', 'left'];
    width = round2(b.width);
    for (const k of sides) widths[k] = width;
  }
  if (sides.length === 0) return undefined;

  // ⚠️ 颜色可能**整个缺席**（同一份稿里 26 个边框没有 color 字段）。
  //    这时照样要保留边框信息（有没有、多粗、哪几边），只是颜色为 null ——
  //    判定时要跳过颜色比对，而不是把 null 当成"页面缺边框"。
  const c = parseColor(b.color);
  return {
    color: c ? rgbHex(c) : null,
    alpha: c ? round2(c.a) : null,
    colorKnown: Boolean(c),
    widths,
    width,
    sides,
    /** 只有一边有边框时给出是哪边 —— 这是"分割线"最典型的形态。 */
    single: sides.length === 1 ? sides[0] : null,
  };
}

/* ==========================================================================
 * 3c. 蓝湖 **Sketch 插件格式**（`type: sketchPlugin`）—— 归一化成与 Figma 稿同形的树
 *
 * 背景（2026-10 实测，项目「105福建省碳足迹公共服务平台」252 张稿）：**11/20 ≈ 55%** 的稿是
 * `type: sketchPlugin`（Sketch 插件导出）。它们**没有 `artboard`**：图层平铺在 `info[]` 里，
 * 层级靠每个元素的 `parentID` 串起来（`layers` 字段恒为 `[]`，实测 2348 层无例外）。
 *
 * 不处理会怎样（本次要修的缺陷）：既有的 `tree.artboard ?? tree` 会退化成"把整棵树当画板"，
 * `flattenArtboard` 只能摊出 **1 层** → `lanhu_read_blocks` 输出「共 **1** 块：画板 1」+ 一张空表。
 * **看着跑成功、其实一个块都没解析出来** —— 比直接报错危险得多：
 * AI 会据此认定"这张稿是空的"，然后什么都不建（本仓库最忌讳的失败模式）。
 *
 * 所以这里把它**真的解析出来**：映射成与 Figma 稿**同形**的树，之后完全复用
 * `flattenArtboard` / `buildBlocks` / 渲染 / 验收 —— **不为它另写一套块模型**（两套必然漂移）。
 * 下面每个 `sketch*` 小函数的字段映射都有实测依据，见各自注释。
 * ========================================================================== */

/**
 * Sketch 用 **postScriptName 的后缀**表达字重（`SourceHanSansCN-Bold`）。
 * 实测 11 张稿 746 个文字层出现过的后缀：Regular / Normal / Medium / Bold / Heavy，
 * 以及**没有后缀**的 HelveticaNeue / MicrosoftYaHei / YouSheBiaoTiHei（按 400 处理）。
 * ⚠️ 这张表是**格式规则**（Sketch 的既定命名约定），不是"为了好看凑一个数值"。
 */
const SKETCH_WEIGHT_SUFFIX = Object.freeze({
  Thin: 100, UltraLight: 200, ExtraLight: 200, Light: 300, Book: 400,
  Regular: 400, Normal: 400, Medium: 500, SemiBold: 600, DemiBold: 600,
  Bold: 700, Heavy: 900, Black: 900,
});
const SKETCH_WEIGHT_RE = /-(Thin|UltraLight|ExtraLight|Light|Book|Regular|Normal|Medium|SemiBold|DemiBold|Bold|Heavy|Black)$/i;

/** 从 `SourceHanSansCN-Bold` 取字重；认不出后缀就是 400（不猜）。 */
function sketchWeightOf(postScript) {
  const m = SKETCH_WEIGHT_RE.exec(String(postScript ?? ''));
  if (!m) return 400;
  const key = Object.keys(SKETCH_WEIGHT_SUFFIX).find((k) => k.toLowerCase() === m[1].toLowerCase());
  return key ? SKETCH_WEIGHT_SUFFIX[key] : 400;
}

/** 字体族名 = postScriptName **去掉字重后缀**（只做剥离，不改写、不加空格）。 */
function sketchFamilyOf(postScript) {
  const s = String(postScript ?? '').trim();
  if (!s) return null;
  return s.replace(SKETCH_WEIGHT_RE, '') || s;
}

/** `ddsType` → `paths[0].type`。Figma 稿实测只出现 `rect` / `ellipse`（775 / 25 个），
 *  所以**只映射这两个**；`star` / `shape-group` / `artboard-group` 保持不认识（不编一个类型出来）。 */
const SKETCH_SHAPE_BY_DDS = Object.freeze({ rectangle: 'rect', oval: 'ellipse' });

/** Sketch 边框对齐方式 → Figma 稿的 `lineAlignment`。 */
const SKETCH_BORDER_ALIGN = Object.freeze({ '内边框': 'inside', '中心边框': 'center', '外边框': 'outside' });

/**
 * Sketch 圆角 → Figma 稿的 `{topLeft,topRight,bottomRight,bottomLeft}`。
 *
 * 实测两种形态，且**与 `points[].cornerRadius` 逐值一致**（2348 层无例外）：
 *   · `radius: [4]`        → 四角 4（points 给 `[4,4,4,4]`）
 *   · `radius: [4,0,16,0]` → 依次 左上/右上/右下/左下（points 的 point 坐标顺序 0,0 → 1,0 → 1,1 → 0,1）
 * 与 `radiusOf()` 期望的顺序（topLeft/topRight/bottomRight/bottomLeft）**一致**，可直接用。
 */
function sketchRadius(node) {
  const arr = Array.isArray(node?.radius) ? node.radius : null;
  const pts = (node?.points ?? []).map((p) => round2(p?.cornerRadius ?? 0));
  let v = null;
  if (arr && arr.length === 4) v = arr.map((x) => round2(x ?? 0));
  else if (arr && arr.length === 1) { const a = round2(arr[0] ?? 0); v = [a, a, a, a]; }
  else if (pts.length === 4) v = pts;
  if (!v || v.every((x) => !x)) return null;   // 全 0 = 没圆角 → null（与 radiusOf 同口径）
  return { topLeft: v[0], topRight: v[1], bottomRight: v[2], bottomLeft: v[3] };
}

/** `info[]` 顶层 `fills` → Figma 稿的 `style.fills`。 */
function sketchFillsOf(node) {
  const out = [];
  for (const f of node?.fills ?? []) {
    if (!f || f.isEnabled === false) continue;
    if (f.type === 'color') {
      out.push({ type: 'color', color: f.color ?? null, isEnabled: f.isEnabled !== false });
    } else if (f.type === 'gradient') {
      const g = f.gradient ?? {};
      out.push({
        type: 'gradient',
        // ⚠️ **字段名必须迁移**：Sketch 插件给 `colorStops`，Figma 稿给 `stops`，
        //    而 `layerColors()` 只认 `stops` —— 不迁移的话**渐变会被整条丢掉**，
        //    而表格里"有颜色"看着不像缺信息（本项目 11 张稿里有 103 处渐变，实测踩过）。
        gradient: { stops: g.colorStops ?? g.stops ?? [], from: g.from ?? null, to: g.to ?? null },
        isEnabled: f.isEnabled !== false,
      });
    }
  }
  return out;
}

/**
 * `info[]` 顶层 `borders` → Figma 稿的 `style.borders`。
 * ⚠️ Sketch 的边框**没有每边宽度**（只有统一的 `thickness` + `position`）——
 *    实测 231 处边框全是四边同宽，所以 `widths` 四边都填 `thickness`。
 *    Sketch 里"分割线"通常是一条 1px 高的 shape，不靠边框表达，故这里不会产生假的单边边框。
 */
function sketchBordersOf(node) {
  const out = [];
  for (const b of node?.borders ?? []) {
    if (!b || b.isEnabled === false) continue;
    const w = round2(b.thickness ?? b.width ?? 0);
    if (!(w > 0)) continue;
    out.push({
      color: b.color ?? null,
      isEnabled: true,
      width: w,
      widths: { left: w, right: w, top: w, bottom: w },
      style: 'solid',
      lineAlignment: SKETCH_BORDER_ALIGN[b.position] ?? null,
    });
  }
  return out;
}

/** `info[]` 的 `font` → Figma 稿的 `text.style`（文字内容、字体、行高、字距、文字色）。 */
function sketchTextOf(node) {
  const f = node?.font;
  if (!f || typeof f !== 'object') return null;
  const content = typeof f.content === 'string' && f.content !== ''
    ? f.content
    : (typeof f.styles?.[0]?.content === 'string' ? f.styles[0].content : null);
  if (typeof content !== 'string') return null;
  return {
    style: {
      content,
      font: {
        name: sketchFamilyOf(f.font),
        // 原始 postScriptName 一并留着 —— 字体族名是从它剥离出来的，溯源要能看到原文
        postScriptName: f.font ?? null,
        displayName: f.displayName ?? null,
        size: f.size == null ? null : round2(f.size),
        fontWeight: sketchWeightOf(f.font),
        align: f.align ?? null,
        lineHeight: f.line == null ? null : { value: round2(f.line), unit: 'PIXELS' },
        letterSpacing: { value: round2(f.kerning ?? 0), unit: 'pixels' },
      },
      color: f.color ?? f.styles?.[0]?.color ?? null,
    },
    value: content,
  };
}

/** 单个 `info[]` 元素 → Figma 稿形状的图层节点（`children` 已建好）。 */
function sketchLayerOf(node, children, isArtboard) {
  const frame = {
    // 画板：`left/top` 恒为 0（相对自己），**画布绝对坐标**在 `position_x/position_y` ——
    //   与 Figma 稿的画板 frame（实测 left=2193/top=57604）同口径。
    // 其余层：实测 `left/top` **就是画板绝对坐标**（44 个有父层的元素里 24 个的 left/top
    //   超出父层局部框，父局部框根本装不下 —— 所以不可能是"相对父级"）。
    //   而 `flattenArtboard` 的假设正是"子层 frame 相对画板原点"，**两边天然对齐**。
    left: round2(isArtboard ? (node.position_x ?? node.left ?? 0) : (node.left ?? 0)),
    top: round2(isArtboard ? (node.position_y ?? node.top ?? 0) : (node.top ?? 0)),
    width: round2(node.width ?? 0),
    height: round2(node.height ?? 0),
  };
  const radius = sketchRadius(node);
  const shape = SKETCH_SHAPE_BY_DDS[node.ddsType] ?? null;
  const ddsUrl = node.ddsImage?.imageUrl ?? null;
  const exportUrl = node.image?.imageUrl ?? null;
  return {
    id: node.id,
    name: node.name ?? '',
    /** 保留 Sketch 的原 type（`shape`/`text`/`layer-group`/`bitmap`/`symbol`）——
     *  这一层是**忠实透传**，也让人一眼看出这张稿是 Sketch 插件格式来的。 */
    type: node.type ?? null,
    ddsType: node.ddsType ?? null,
    frame,
    realFrame: isArtboard ? frame : (node.layerOriginFrame ? {
      left: round2(node.layerOriginFrame.x ?? 0), top: round2(node.layerOriginFrame.y ?? 0),
      width: round2(node.layerOriginFrame.width ?? 0), height: round2(node.layerOriginFrame.height ?? 0),
    } : frame),
    // 实测 Sketch 的 opacity 是 **0..100**（Figma 稿是 0..1），必须换算；不换算会把 80% 当 80 倍。
    opacity: typeof node.opacity === 'number' ? clamp01(node.opacity / 100) : 1,
    visible: node.isVisible !== false,
    radius,
    paths: shape ? [{ type: shape, frame, radius }] : null,
    style: {
      isEnabled: true,
      opacity: 1,
      blendMode: node.blendMode ?? 0,
      fills: sketchFillsOf(node),
      borders: sketchBordersOf(node),
      shadows: Array.isArray(node.shadow) ? node.shadow : [],
      blurs: node.blur ? [node.blur] : [],
    },
    /**
     * ⚠️ 切图判据**只认 `type: 'bitmap'`（真位图层）+ 组被导出成一张图（`image.imageUrl`）**。
     *    不能拿 `hasExportDDSImage` 当判据：Sketch 插件格式里 **890/2348 层**都带它
     *    （连普通 `shape` 也有，蓝湖给每层都导了图），照抄会让七成形状都变成"图片块"。
     *    Figma 稿的对照是 `hasExportImage`：1105 层里只有 87 层 —— 数量级与语义都对得上。
     */
    hasExportDDSImage: Boolean(node.type === 'bitmap' && ddsUrl),
    hasExportImage: Boolean(exportUrl),
    image: node.image ?? node.ddsImage ?? null,
    text: sketchTextOf(node),
    layers: children,
  };
}

/** 只挑**元信息**（不把庞大的 `info[]` 带进归一化树 —— 那会让 full 落盘体积翻倍）。 */
const SKETCH_META_KEYS = Object.freeze([
  'device', 'ArtboardScale', 'sliceScale', 'exportScale', 'pageName',
  'skVersion', 'skBuild', 'pluginVersion', 'sketchtool', 'ArtboardID', 'isMergeData',
]);

/**
 * `type: sketchPlugin` 的树 → 与 Figma 稿**同形**的树（`{meta, sketch, assets, artboard}`）。
 *
 * @returns `{ tree, artboard, layerCount, sliceUrls }`
 *   · `layerCount` = **除画板外**的图层数 —— 调用方用它判"到底解析出东西没有"（0 就是解析失败）。
 *   · `sliceUrls`  = 从 `ddsImage`/`image` 收集到的切图 URL（`download_slices` 直接用）。
 */
export function normalizeSketchPluginTree(tree) {
  const info = Array.isArray(tree?.info) ? tree.info.filter((it) => it && typeof it === 'object') : [];
  const byId = new Map();
  for (const it of info) if (it.id != null) byId.set(String(it.id), it);

  // 画板 = `ArtboardID` 指的那一项（实测就是 info[0]，且是唯一没有 parentID 的项）。
  const rootRaw = (tree?.ArtboardID != null && byId.get(String(tree.ArtboardID)))
    || info.find((it) => !it.parentID) || null;

  // 建父子关系。⚠️ `layers` 恒为空，**层级只能靠 parentID**。
  const childrenOf = new Map();
  const orphans = [];
  for (const it of info) {
    const pid = it.parentID == null || it.parentID === '' ? null : String(it.parentID);
    if (!pid || pid === String(it.id)) { orphans.push(it); continue; }   // 无父 / 自指 → 当根，别丢
    if (byId.has(pid)) {
      if (!childrenOf.has(pid)) childrenOf.set(pid, []);
      childrenOf.get(pid).push(it);
    } else orphans.push(it);   // 父不在 info 里 → 当根，**不丢层**
  }

  let layerCount = 0;
  const sliceUrls = new Set();
  const seen = new Set();
  const build = (node, isArtboard, depth) => {
    const id = node.id == null ? null : String(node.id);
    if (id) { if (seen.has(id)) return null; seen.add(id); }     // 防环（真实数据无环，防御）
    if (depth > 64) return null;                                  // 防御异常深度
    const kids = [];
    for (const c of childrenOf.get(id) ?? []) {
      const k = build(c, false, depth + 1);
      if (k) kids.push(k);
    }
    if (!isArtboard) layerCount += 1;
    // 切图 URL：与 `hasImage` 同判据（bitmap 的 ddsImage + 任意层的组导出图）
    if (node.type === 'bitmap' && node.ddsImage?.imageUrl) sliceUrls.add(node.ddsImage.imageUrl);
    if (node.image?.imageUrl) sliceUrls.add(node.image.imageUrl);
    return sketchLayerOf(node, kids, isArtboard);
  };

  let artboard = rootRaw ? build(rootRaw, true, 0) : null;
  if (!artboard) {
    // 连画板都没有（`ArtboardID` 指向不存在的项）→ 造一个**只有 frame 的空画板**，
    //   好让上层的"解析不出图层"守卫有统一的形状可判；这里不编任何内容。
    artboard = sketchLayerOf({
      id: tree?.ArtboardID ?? null, name: tree?.pageName ?? 'Sketch 画板',
      width: 0, height: 0, position_x: 0, position_y: 0,
    }, [], true);
  }
  // 画板之外的根（没有 parentID 或无父可挂的碎片）统一挂到画板下 —— **不丢层**。
  for (const o of orphans) {
    if (String(o.id) === String(artboard.id)) continue;
    const node = build(o, false, 1);
    if (node) artboard.layers.push(node);
  }

  const meta = {
    device: tree?.device ?? null,
    sliceScale: tree?.sliceScale ?? null,
    id: tree?.ArtboardID ?? null,
    host: { name: 'sketch', version: tree?.skVersion ?? null },
    plugin: { name: 'lanhu-sketch-plugin', version: tree?.pluginVersion ?? null },
  };
  const sketch = {};
  for (const k of SKETCH_META_KEYS) if (tree?.[k] !== undefined) sketch[k] = tree[k];

  return {
    tree: { meta, sketch, assets: [...sliceUrls], artboard },
    artboard, layerCount, sliceUrls: [...sliceUrls],
  };
}

/* ==========================================================================
 * 3f. 「生成代码」用的**富图层信息**（§4.10）
 *
 * 下面这几个函数**只被 `flattenArtboard(artboard, { rich: true })` 调用**，
 * 也就是只被 `lanhu_gen_code` 这条链用。既有链路（read_design / read_blocks / 面板 / diff /
 * audit / verify）一律不传 `rich` —— 图层对象多一个键就会改变它们的输出，
 * 而本项目对既有输出是**逐字节**要求。
 *
 * 采什么、为什么：
 *   · `shadows`       —— 块模型里**没有**阴影（`read_blocks` 也不显示）。生成 CSS 必须给
 *                        `box-shadow` / `text-shadow`，否则按钮的立体感全丢。
 *   · `blurs`         —— 毛玻璃（`backdrop-filter: blur()`）。`type==='Background'` 是背景模糊。
 *   · `fillGradient`  —— 块模型的 `bg.stops` **只有 hex+alpha**，没有**角度**；
 *                        而 `linear-gradient(90deg, …)` 的角度是必须还原的信息（实测①③）。
 *   · `borderGradient`—— 渐变描边（`border-image`）。蓝湖把它放在 `style.borders[].gradient` 里，
 *                        既有 `borderOf()` 只取 `color`，渐变描边会被整条丢掉。
 *   · `hasRadius`     —— 「全 0 圆角」与「没有圆角数据」是**两回事**：前者要出
 *                        `border-radius: 0px 0px 0px 0px`（蓝湖也这么出），后者一个字都不出。
 *                        `radiusOf()` 只返回 max>0 的，所以这里单独记一个布尔。
 *   · `textRuns`      —— 富文本（一段文字里多种样式，§4.10 ⑪）。Figma 的 `text.styles[]`
 *                        按 run 给了 font/color；既有链路只取 `text.font`（主样式），
 *                        会把 4 段压成 1 段 —— **实测该字段真的存在**（青圭稿 4 个 run，
 *                        与蓝湖 ObjC 模板的 NSMakeRange 逐段对得上）。
 * ========================================================================== */

/** 阴影规范化：只保留真正画得出来的（enabled 且颜色 alpha>0）。 */
function normShadows(list) {
  const out = [];
  for (const s of list ?? []) {
    if (!s || typeof s !== 'object' || s.isEnabled === false) continue;
    const c = parseColor(s.color);
    if (!c || c.a <= 0) continue;
    out.push({
      x: round2(s.x ?? 0),
      y: round2(s.y ?? 0),
      blur: round2(s.blur ?? 0),
      spread: round2(s.spread ?? 0),
      inset: Boolean(s.inset),
      color: { r: c.r, g: c.g, b: c.b, a: round2(c.a) },
    });
  }
  return out;
}

/** 模糊：`Background` → 背景模糊（`backdrop-filter`），`Gaussian`/其它 → `filter`。 */
function normBlurs(list) {
  const out = [];
  for (const b of list ?? []) {
    if (!b || typeof b !== 'object' || b.isEnabled === false) continue;
    const r = round2(b.radius ?? 0);
    if (!(r > 0)) continue;
    out.push({ type: typeof b.type === 'string' ? b.type : null, radius: r });
  }
  return out;
}

/**
 * 渐变方向 → CSS 角度（deg，整数，规范化到 `[0,360)`）。
 *
 * 数据是 **from/to 两个归一化坐标点**（相对图层 bbox 的 0..1 空间，可能超出）：
 * 方向从 `from` 指向 `to`。CSS 的 `0deg` 指**向上**、顺时针增大，而 Figma 的 y 轴**向下**，
 * 所以 `deg = atan2(dx, -dy)`。
 *
 * 实测校准（三张真稿，全部吻合，见 docs/生成代码.md 的对照表）：
 *   ① 311×42 按钮  from(0,0.5)→to(1,0.5)        → 90°  蓝湖 `90deg`
 *   ③ 48×48  图标  from(.1464,.75)→to(.8536,.25) → 54.7356 → 55°  蓝湖 `55deg`
 *   ⑦ 500×159 卡片 from(.1,.5006)→to(.1,.4994)   → 0°   蓝湖 `360deg`（等价，见差异说明）
 *
 * ⚠️ **不乘图层宽高**：实测的三个样本里两个是轴对齐、一个是正方形，乘不乘同值；
 *    但蓝湖给的角度**全是整数**，而乘宽高会把 `.1464/.75` 这种点算成 116.57° 这类怪值。
 *    这是个**有意的选择**，不是遗漏 —— 已在文档里标为「未验证：非轴对齐×非正方形的样本」。
 */
export function gradientAngle(from, to) {
  const dx = Number(to?.x) - Number(from?.x);
  const dy = Number(to?.y) - Number(from?.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return Math.round(deg) % 360; // 359.6 → 360 → 0（0 与 360 视觉等价，统一成 0）
}

/** 渐变（填充与描边共用）：角度 + **全部** stop（位置 / hex / alpha）。 */
export function gradientInfoOf(g) {
  if (!g || !Array.isArray(g.stops) || g.stops.length === 0) return null;
  const stops = [];
  for (const s of g.stops) {
    const c = parseColor(s?.color);
    if (!c) continue;
    stops.push({
      hex: rgbHex(c),
      alpha: round2(c.a),
      /**
       * ⚠️ **位置不取整**（原样保留）：它是 `0..1` 的归一化值，`round2` 一下就等于
       * 把百分比精度砍到 1 位 —— 实测参考⑧那段就是 `29.66%`，`round2(0.2966)=0.3` → `30%`
       * （数值合法、只是被抹平，属于最阴的一类错）。要 2 位百分比就给 4 位归一化值。
       */
      position: Number.isFinite(Number(s.position)) ? Number(s.position) : 0,
      color: { r: c.r, g: c.g, b: c.b, a: round2(c.a) },
    });
  }
  if (stops.length === 0) return null;
  return { angle: gradientAngle(g.from, g.to), stops };
}

/** 取第一个**渐变**填充（`style.fills[]` 里 `type==='gradient'` 的那条）。 */
function fillGradientOf(node) {
  for (const f of node.style?.fills ?? []) {
    if (!f || f.isEnabled === false) continue;
    if (f.type === 'gradient') {
      const g = gradientInfoOf(f.gradient);
      if (g) return g;
    }
  }
  return null;
}

/**
 * 取**渐变描边**。蓝湖的表达是 `style.borders[]` 里 `style:'gradient'` + `gradient`（没有 `color`）。
 * 粗细/哪几边复用 `borderOf()`（含"widths 全 0 但 width 有值"那条兜底），**不写第二份**。
 */
function borderGradientOf(node, bd) {
  const list = (node.style?.borders ?? []).filter((b) => b && b.isEnabled !== false);
  for (const b of list) {
    if (!b.gradient) continue;
    const g = gradientInfoOf(b.gradient);
    if (!g) continue;
    return {
      ...g,
      width: bd?.width ?? round2(b.width ?? 0),
      sides: bd?.sides ?? null,
      widths: bd?.widths ?? null,
    };
  }
  return null;
}

/** 有没有**圆角数据**（哪怕四角全 0）—— "全 0" 与 "没这个字段" 要分开对待。 */
function hasRadiusData(node) {
  if (node.radius && typeof node.radius === 'object') return true;
  for (const p of node.paths ?? []) if (p?.radius && typeof p.radius === 'object') return true;
  return false;
}

/**
 * 富文本 runs（Figma 的 `text.styles[]`）。
 * ⚠️ 只在 **run 数 ≥ 2** 时返回 —— 单 run 与主样式同源，返回它只会让生成器把同一份样式写两遍。
 */
export function textRunsOf(text) {
  const styles = text?.styles;
  if (!Array.isArray(styles) || styles.length < 2) return null;
  const runs = [];
  for (const s of styles) {
    if (!s || typeof s !== 'object') continue;
    const f = s.font ?? {};
    const c = parseColor(s.color);
    runs.push({
      from: s.from ?? null,
      to: s.to ?? null,
      content: typeof s.content === 'string' ? s.content : '',
      font: {
        family: f.name ?? null,
        size: round2(f.size) ?? null,
        weight: typeof f.fontWeight === 'number' ? f.fontWeight : (f.bold ? 700 : 400),
        lineHeight: round2(f.lineHeight?.value) ?? null,
        letterSpacing: round2(f.letterSpacing?.value) ?? null,
      },
      color: c ? { hex: rgbHex(c), alpha: round2(c.a), color: { r: c.r, g: c.g, b: c.b, a: round2(c.a) } } : null,
    });
  }
  return runs.length >= 2 ? runs : null;
}

/** 旋转（度）。0 与"没这个字段"对生成 CSS 是一回事（都不出 `transform`），统一给 null。 */
function rotationOf(node) {
  const r = Number(node?.rotation);
  return Number.isFinite(r) && r !== 0 ? round2(r) : null;
}

/** 一个原始节点 → 富信息（只被 `rich` 模式调用）。 */
export function richInfoOf(node) {
  const bd = borderOf(node);
  return {
    shadows: normShadows(node.style?.shadows),
    blurs: normBlurs(node.style?.blurs),
    fillGradient: fillGradientOf(node),
    borderGradient: borderGradientOf(node, bd),
    hasRadius: hasRadiusData(node),
    rotation: rotationOf(node),
    textRuns: textRunsOf(node.text),
  };
}

/**
 * 把 artboard 递归摊平成图层数组。
 * 注：蓝湖给的子图层 frame 坐标是**相对画板原点**的（已验证：画板 left=-10279，子层 left=155.5）。
 *
 * `opts.rich`（默认 **false**）：多采生成代码要用的富信息（阴影 / 模糊 / 渐变方向 / 富文本 runs /
 * 「有没有圆角数据」）。**默认关闭是硬约束** —— 图层对象是全项目的共同数据源，
 * 多一个键就会改变 read_design / read_blocks / 面板的输出。
 */
export function flattenArtboard(artboard, opts = {}) {
  const rich = Boolean(opts.rich);
  const layers = [];
  // ⚠️ 父级 opacity 必须顺链**累乘**：Figma 里组的 opacity 会与子层相乘，
  //    只读 node.opacity 会把「组 50% 里的子层」误报成 100% 不透明（实测踩过）。
  const walk = (node, parentPath, depth, parent, inheritedOpacity = 1, inheritedVisible = true) => {
    const name = node.name ?? '';
    const path = parentPath ? `${parentPath}/${name}` : name;
    const frame = frameOf(node);
    const colors = layerColors(node);
    const ownOpacity = node.opacity ?? 1;
    /** 自身 × 祖先链 —— 还原时按这个值做，而不是 node.opacity */
    const effectiveOpacity = round2(ownOpacity * inheritedOpacity);
    // ⚠️ visible 也要顺链继承：父组/父层被隐藏时，子层不该出现在清单里。
    //    只读 node.visible 会让「隐藏组里的子层」照常输出（实测隐患，见交接清单缺口 2）。
    const visible = node.visible !== false && inheritedVisible;
    const text = node.text?.style;
    const font = text?.font;
    // 内边距：子层坐标 − 父层坐标 —— 省掉人工手算。
    //
    // ⚠️ **但父层是画板时不能直接相减**：画板（depth 0）的 x/y 是**画布绝对坐标**，
    //    而它的子层是**画板相对坐标** —— 两者不在同一坐标系。
    //    实测（某大屏稿，画板 x=14599 y=258）：
    //    深度 1 的 **26 个层内边距全部变成 -14xxx/14xxx 这种垃圾值**，
    //    而其中就有「大标题」这种本该 `0/0/0/920` 的层。
    //    凡画板不在画布原点（Figma 里极常见）就会中招。
    //    修法：父层是画板时，把它的原点当 (0,0)；宽高仍用画板自己的（那个是对的）。
    //    与间距表排除 `depth===0` 是**同一个病根**（那次只修了间距那条链）。
    //
    // ⚠️ 顶层（画板）没有父层，这时给 **null 而不是 undefined**。
    //    `undefined` 不是合法 lossless JSON —— DSH 宿主会**拒收整个工具结果**
    //    （报 `value is not lossless JSON`），agent 一点数据都拿不到。实测踩过。
    const pOriginX = parent && parent.depth === 0 ? 0 : parent?.x;
    const pOriginY = parent && parent.depth === 0 ? 0 : parent?.y;
    const inset = parent ? {
      left: round2(frame.x - pOriginX),
      top: round2(frame.y - pOriginY),
      right: round2((pOriginX + parent.w) - (frame.x + frame.w)),
      bottom: round2((pOriginY + parent.h) - (frame.y + frame.h)),
    } : null;
    const layer = {
      id: node.id,
      type: node.type,
      name,
      parentPath,
      depth,
      ...frame,
      inset,
      visible,
      opacity: round2(ownOpacity),
      /** 累乘祖先 opacity 后的真实不透明度（还原以它为准） */
      effectiveOpacity,
      shape: shapeOf(node),
      radius: radiusOf(node),
      border: borderOf(node),
      colors,
      // 同理：可选字段一律 `?? null`，别把 undefined 放出去
      text: typeof (text?.content ?? node.text?.value) === 'string' ? (text?.content ?? node.text?.value) : null,
      font: font ? {
        family: font.name ?? null,
        size: round2(font.size) ?? null,
        weight: font.fontWeight ?? (font.bold ? 700 : 400),
        align: font.align ?? null,
        lineHeight: round2(font.lineHeight?.value) ?? null,
        letterSpacing: round2(font.letterSpacing?.value) ?? null,
      } : null,
      hasImage: Boolean(node.hasExportImage || node.hasExportDDSImage),
    };
    // ⭐ 只有 `rich`（生成代码）才追加富信息 —— 见上面 §3f 的说明。默认路径**一个键都不加**。
    if (rich) Object.assign(layer, richInfoOf(node));
    layers.push(layer);
    for (const child of node.layers ?? []) walk(child, path, depth + 1, layer, effectiveOpacity, visible);
  };
  if (artboard) walk(artboard, '', 0);
  return layers;
}

/** 从摊平后的图层里汇总设计 token。 */
export function collectTokens(layers) {
  const colors = new Map();
  const fontSizes = new Map();
  const fontWeights = new Map();
  const fontFamilies = new Map();
  const radii = new Map();

  for (const l of layers) {
    for (const c of l.colors) {
      const hex = rgbHex(c);
      const key = c.a < 1 ? `${hex}@${Math.round(c.a * 100)}%` : hex;
      const entry = colors.get(key) ?? { hex, alpha: c.a, count: 0, rgb: rgbaString(c) };
      entry.count += 1;
      colors.set(key, entry);
    }
    if (l.font) {
      if (l.font.size) fontSizes.set(l.font.size, (fontSizes.get(l.font.size) ?? 0) + 1);
      if (l.font.weight) fontWeights.set(l.font.weight, (fontWeights.get(l.font.weight) ?? 0) + 1);
      if (l.font.family) fontFamilies.set(l.font.family, (fontFamilies.get(l.font.family) ?? 0) + 1);
    }
    if (l.radius) radii.set(l.radius.max, (radii.get(l.radius.max) ?? 0) + 1);
  }

  const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    colors: [...colors.values()].sort((a, b) => b.count - a.count),
    fontSizes: byCount(fontSizes).map(([size, count]) => ({ size, count })),
    fontWeights: byCount(fontWeights).map(([weight, count]) => ({ weight, count })),
    fontFamilies: byCount(fontFamilies).map(([family, count]) => ({ family, count })),
    radii: byCount(radii).map(([radius, count]) => ({ radius, count })),
  };
}

/* ==========================================================================
 * 4.5 块级模型 —— 把 334 个图层收敛成"这块是什么、六项属性是多少"
 *
 * 动因（实战四个案例）：
 *   · 胶囊圆角 38px 被写成 999rpx —— 数值明明在树里，逐层比对却看不见
 *   · 1px #E2E8F0 分割线整条丢失 —— 边框数据没进树、也没进比对
 *   · #F1EFFE / #EFF6FF 近似色写错 —— 肉眼无法分辨，必须精确到 hex
 * 于是需要一个中间层：**块**。块 = 用户一眼能认出的 UI 单元（卡片/胶囊/文本/图片/分割线/容器），
 * 每块带齐六项属性（圆角、大小、文字色、文字大小、有无底色、边框），供人核对与后续比对。
 * ========================================================================== */

/** 块的类型 → 中文名。 */
export const BLOCK_KINDS = {
  artboard: '画板',
  card: '卡片',
  container: '容器',
  pill: '胶囊/标签',
  text: '文本',
  image: '图片',
  divider: '分割线',
};

/**
 * 是不是"系统 UI / 图形碎片"级别的噪音块。
 * 不删除，只**标记** —— 状态栏、Home Indicator、Notch 下的图元以及过小的图元，
 * 保留会让面板一眼看去全是 `Path 3×8`；标记之后默认折叠，需要时仍可展开核对。
 */
function noiseOf(l) {
  const name = String(l.name ?? '');
  const parent = String(l.parentPath ?? '');
  // ⚠️ 只屏蔽「状态栏 / Home Indicator」这类**系统 UI**，**不要**因为路径里出现 `iPhoneX` 就把整棵子树都算碎片 ——
  //    iPhoneX 只是设计稿的设备外框，里面的**导航、大标题、内容全是真实 UI**。
  //    一开始写宽了，结果「大标题」被当成噪音排除在比对之外（实测踩过）。
  if (/(Status Bar|状态栏|StatusIcons|Status Icons|Home Indicator|HomeIndicator)/i.test(name)) return true;
  if (/(Status Bar|状态栏|Home Indicator|HomeIndicator)/i.test(parent)) return true;
  // 设备外框 / 刘海本身
  if (/^(iPhoneX|iPhone X|iPhone 1[0-9]|Notch|设备外框)$/i.test(name.trim())) return true;
  // 过小的图形碎片
  if ((l.w ?? 0) * (l.h ?? 0) < 36) return true;
  return false;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 从蓝湖链接里解析 teamId / projectId / imageId。
 *
 * 蓝湖详情页是 **hash 路由**，取值在 `#` 之后的 query 里，直接 `new URL().searchParams` 拿不到：
 *   https://lanhuapp.com/web/#/item/project/detailDetach?tid=…&pid=…&image_id=…&type=image
 * 这里把整串、`#` 之后、`?` 之后三段都扫一遍，参数名兼容 tid/team_id、pid/project_id、image_id。
 * 也接受直接给三个 id 的场景（面板里贴 id 同样能用）。
 */
/**
 * 从**任意**蓝湖链接里抽参数（**宽容**：只解析，不校验任何必填项）。
 * `parseLanhuUrl`（面向"某一张稿"）与 `parseProjectTarget`（面向"某个项目"）共用它 ——
 * 两处各写一遍迟早会走偏。
 */
function lanhuUrlParams(raw) {
  const params = new Map();
  const chunks = [raw];
  const hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) chunks.push(raw.slice(hashIdx + 1));
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) chunks.push(raw.slice(qIdx + 1));
  for (const chunk of chunks) {
    const q = chunk.includes('?') ? chunk.slice(chunk.indexOf('?') + 1) : chunk;
    for (const m of q.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=([^&#\s]*)/g)) {
      if (!params.has(m[1])) {
        try { params.set(m[1], decodeURIComponent(m[2])); } catch { params.set(m[1], m[2]); }
      }
    }
  }
  const pick = (...keys) => {
    for (const k of keys) { const v = params.get(k); if (v) return v; }
    return null;
  };
  return { params, pick };
}

/**
 * 从**任意**蓝湖链接里取**项目级**目标（`teamId` / `projectId`）—— **不要求 `image_id`**。
 *
 * ⚠️ **不能用 `parseLanhuUrl` 代替它**：那个是面向"**某一张稿**"的，**没有 image_id 就抛错**；
 * 而"列出这个项目的全部设计稿"只关心项目，链接常常是**项目页/列表页**，本来就没有 image_id
 * （实测：拿项目链接调 `list_designs` 直接报"没找到 image_id" —— 这正是它存在的理由）。
 * 也接受直接给一个项目 id（uuid）。
 */
export function parseProjectTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new LanhuError('需要一条蓝湖链接或一个项目 id（projectId）。');
  // 直接给 uuid：当项目 id 用
  if (!/^https?:\/\//i.test(raw) && !raw.includes('=') && UUID_RE.test(raw)) {
    return { projectId: raw, teamId: null, imageId: null, url: null, source: 'id' };
  }
  const { pick } = lanhuUrlParams(raw);
  const projectId = pick('project_id', 'projectId', 'pid');
  const teamId = pick('tid', 'team_id', 'teamId');
  const imageId = pick('image_id', 'imageId', 'iid');
  if (!projectId || !UUID_RE.test(projectId)) {
    throw new LanhuError(`链接里没找到有效的项目 id（project_id/pid）：${projectId ?? '缺失'}。\n提示：项目页地址里通常带 pid=；也可以直接给项目 id。`);
  }
  return {
    projectId,
    teamId: teamId && UUID_RE.test(teamId) ? teamId : null,
    imageId: imageId && UUID_RE.test(imageId) ? imageId : null,
    url: raw,
    source: 'url',
  };
}

export function parseLanhuUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new LanhuError('请粘贴一个蓝湖链接（形如 https://lanhuapp.com/web/#/item/project/detailDetach?tid=…&image_id=…）。');

  // 直接给 id 的简写：projectId imageId [teamId]（空格或逗号分隔）
  if (!/^https?:\/\//i.test(raw) && !raw.includes('=')) {
    const parts = raw.split(/[\s,]+/).filter(Boolean);
    const ids = parts.filter((p) => UUID_RE.test(p));
    if (ids.length >= 2) {
      return { teamId: ids[2] ?? null, projectId: ids[0], imageId: ids[1], url: null, source: 'ids', versionId: null, docId: null, pageId: null };
    }
  }

  const { pick } = lanhuUrlParams(raw);

  const projectId = pick('project_id', 'projectId', 'pid');
  const imageId = pick('image_id', 'imageId', 'iid');
  const teamId = pick('tid', 'team_id', 'teamId');
  // ⚠️ 这三项以前直接丢了。蓝湖**编辑页链接会把文档与设计稿混在一条 URL 里**
  //    （实测：docId + image_id + versionId 同时出现，而 versionId 属于那份文档）。
  //    留着它们才能做到"你浏览器里看的是哪一版，读的就是哪一版"。
  const versionId = pick('versionId', 'version_id');
  const docId = pick('docId', 'doc_id');
  const pageId = pick('pageId', 'page_id');

  if (!projectId || !UUID_RE.test(projectId)) {
    throw new LanhuError(`链接里没找到有效的项目 id（project_id/pid）：${projectId ?? '缺失'}。请确认复制的是设计稿详情页的完整地址。`);
  }
  if (!imageId || !UUID_RE.test(imageId)) {
    throw new LanhuError(`链接里没找到有效的设计稿 id（image_id）：${imageId ?? '缺失'}。请确认复制的是**具体某张稿**的地址（列表页没有 image_id）。`);
  }
  return { teamId, projectId, imageId, url: raw, source: 'url', versionId, docId, pageId };
}

/** 判定块的类型。规则可解释、可调，不做玄学分类。 */
function classifyBlock(l) {
  const w = l.w ?? 0;
  const h = l.h ?? 0;
  const long = Math.max(w, h);
  const thin = Math.min(w, h);
  // 判据全部来自 LIMITS、类型全部来自 KINDS —— 别在这里裸写数字或字符串（见文件顶部「受控词表与阈值」）
  if (l.depth === 0) return KINDS.ARTBOARD;
  if (l.hasImage) return KINDS.IMAGE;
  if (l.text !== undefined && l.text !== null && l.text !== '') return KINDS.TEXT;
  const hasFill = (l.colors ?? []).some((c) => c.role === COLOR_ROLES.FILL || c.role === COLOR_ROLES.GRADIENT);
  // 分割线①：极细长的实心条
  if (thin <= LIMITS.dividerMaxThin && long >= LIMITS.dividerMinLong) return KINDS.DIVIDER;
  // 分割线②：只有单边边框、自身无底色的薄块（Footer 顶边 1px 就长这样）
  if (l.border && l.border.single && !hasFill && thin <= LIMITS.dividerBorderMaxThin) return KINDS.DIVIDER;
  // 胶囊：圆角撑满短边（Contact Button 79×26 r=38 —— 案例 1 的主角）
  if (l.radius && h > 0 && h <= LIMITS.pillMaxHeight && l.radius.max >= thin / 2 - LIMITS.pillRadiusEpsilon) return KINDS.PILL;
  // 卡片必须有**样式**（底色/边框/圆角）才算 —— 否则 375×798 的纯布局层会被误判成卡片
  const styled = hasFill || Boolean(l.border) || Boolean(l.radius);
  if (w >= LIMITS.cardMinWidth && h >= LIMITS.cardMinHeight && styled) return KINDS.CARD;
  if (styled) return KINDS.CONTAINER;
  return KINDS.OTHER;
}

/**
 * 本图层的 `fill` 其实是**文字色**而不是底色吗（Figma 语义：文字节点的 fills 就是文字色）。
 * Axure 那条链用 `fillIsBackground: true` 标记"这个 fill 是真底色"，别抹。
 *
 * 抽成函数是因为它有**两个消费者**：`buildBlocks` 定底色，`layerBackgrounds`（§4.8 对比度）
 * 找有效背景色。两处各写一遍 `typeof l.text === 'string' && !l.fillIsBackground`，
 * 迟早会漂移成"表格说没底色、对比度却拿文字色当背景"。
 */
function fillIsTextColor(l) {
  return Boolean(typeof l?.text === 'string' && l.text !== '' && !l.fillIsBackground);
}

/**
 * 该图层会不会成为一个块（`buildBlocks` 的准入判据）。
 * 抽出来是为了**别写第二份跳过逻辑** —— 审计要把"块"映射回源图层，用的必须是同一套判据。
 * @returns {string|null} 块类型；`null` = 不成块
 */
function blockLayerKind(l) {
  if (l.visible === false) return null;
  // ⚠️ 判据要用**累乘后**的 effectiveOpacity：父组 `opacity=0` 时子层自身仍是 1，
  //    只读自身会把「整组不可见」的层当成可见块输出（交接清单缺口 1）。
  if ((l.effectiveOpacity ?? l.opacity ?? 1) === 0) return null;
  const kind = classifyBlock(l);
  return kind === KINDS.OTHER ? null : kind;
}

/**
 * 扁平图层 → 块级模型。
 * @param {Array} layers flattenArtboard 的输出
 */
export function buildBlocks(layers, opts = {}) {
  const pathOf = (l) => (l.parentPath ? `${l.parentPath}/${l.name}` : l.name);
  const childCount = new Map();
  for (const l of layers) {
    if (!l.parentPath) continue;
    childCount.set(l.parentPath, (childCount.get(l.parentPath) ?? 0) + 1);
  }

  const blocks = [];
  layers.forEach((l, layerIndex) => {
    const kind = blockLayerKind(l);
    if (!kind) return;

    // ⚠️ 文本层的 `fills` 是**文字颜色**（Figma 里文字色就是 fill），不是底色。
    //    不排除它会把文字色当成背景色，报出"设计稿有底色、页面没有"这种假问题（实测踩过）。
    const isTextLayer = typeof l.text === 'string' && l.text !== '';
    // `l.fillIsBackground` 只有**原型**这条链会设（Axure 的 fill 与 foreGroundFill 是分开的字段）；
    // 设计稿那条链不设它 → 行为逐字不变。
    const fill = fillIsTextColor(l)
      ? null
      : (l.colors ?? []).find((c) => c.role === COLOR_ROLES.FILL || c.role === COLOR_ROLES.GRADIENT);
    // 多段渐变：把**全部** stop 留一份（按设计稿顺序）。
    // ⚠️ 以前渲染只取第一个 stop —— 表格里"有颜色"，看着不像缺信息，比 opacity 更隐蔽（交接清单缺口 4）。
    const gradientStops = fillIsTextColor(l) ? [] : (l.colors ?? []).filter((c) => c.role === COLOR_ROLES.GRADIENT);
    const textColor = (l.colors ?? []).find((c) => c.role === COLOR_ROLES.TEXT) ?? (isTextLayer ? (l.colors ?? []).find((c) => c.role === COLOR_ROLES.FILL) : null);
    const h = l.h ?? 0;
    const thin = Math.min(l.w ?? 0, h);

    blocks.push({
      /** 稳定唯一 id —— 蓝湖里同名兄弟层很常见（一堆 `Background+Border`），
       *  用 path 当 React key 会重复，导致列表出现"子项被重复或漏渲染"的告警。 */
      uid: blocks.length,
      kind,
      name: l.name,
      path: pathOf(l),
      depth: l.depth,
      noise: noiseOf(l),
      x: l.x, y: l.y, w: l.w, h: l.h,
      inset: l.inset,
      radius: l.radius ? {
        corners: l.radius.corners,
        max: l.radius.max,
        /** 全圆胶囊：圆角达到短边一半。案例 1 的判定关键。 */
        pill: h > 0 && h <= 64 && l.radius.max >= thin / 2 - 0.5,
      } : null,
      bg: fill ? {
        hex: rgbHex(fill),
        alpha: round2(fill.a),
        /**
         * 多段渐变的**全部** stop（设计稿顺序）；单色填充时为空数组。
         * 只**新增**字段：`hex`/`alpha` 语义不变，既有调用方（verify / 面板）不受影响。
         * 渲染层 stops 长度 >1 时串成 `#a@18%→#b@10%`，不再只显示第一段。
         */
        stops: gradientStops.length > 1
          ? gradientStops.map((c) => ({ hex: rgbHex(c), alpha: round2(c.a) }))
          : [],
      } : null,
      /**
       * 图层自身不透明度（已累乘祖先）。⚠️ 与 bg.alpha 是**两回事**：
       * bg.alpha 是填充色的 alpha，opacity 是整个图层的透明度，二者叠加生效。
       * 设计稿里半透明的底纹/厚度层全靠它，漏读会把视觉做死（实测踩过）。
       */
      opacity: l.effectiveOpacity ?? l.opacity ?? 1,
      border: l.border ?? null,
      text: l.text ?? null,
      color: textColor ? rgbHex(textColor) : null,
      /**
       * 文字色的 alpha（只**新增**字段）。`color` 是 hex，**不带 alpha** ——
       * 而半透明文字色的对比度必须**先与背景合成**再算（半透明黑在白底上就是 #808080，
       * 拿 #000000 去算会得出 21:1 的假达标）。没有这个数就只能当不透明处理。
       */
      colorAlpha: textColor ? round2(textColor.a ?? 1) : null,
      font: l.font ?? null,
      hasImage: Boolean(l.hasImage),
      shape: l.shape,
      childCount: childCount.get(pathOf(l)) ?? 0,
      /**
       * **源图层下标**（只新增字段，不改动任何既有字段的语义）。
       * 对比度审计（§4.8）要沿**祖先链**找有效背景色，而祖先不在块模型里 ——
       * 有了它就能直接回到 `layers` 上往父层走，且**块被 region/kind 过滤掉之后仍然有效**
       * （没有它就只能靠 name/坐标回查，过滤后必然对不上）。
       */
      layerIndex,
    });
  });
  return blocks;
}

/**
 * 表格里**列出来的块** = 折叠口径唯一的一份实现（渲染层与对比度审计共用）。
 * 两处各写一遍 `opts.includeNoise ? blocks : blocks.filter(...)`，迟早会变成
 * "表里没列的块却出现在对比度名单里"。
 */
export function visibleBlocks(blocks, opts = {}) {
  return opts.includeNoise ? blocks : (blocks ?? []).filter((b) => !b.noise);
}

/** 块级清单 → 紧凑文本（CLI / 工具 / 面板兜底共用）。 */
export function renderBlocks(blocks, meta = {}, opts = {}) {
  const limit = opts.limit ?? 80;
  const L = [];
  const counts = {};
  for (const b of blocks) counts[b.kind] = (counts[b.kind] ?? 0) + 1;

  const noiseCount = blocks.filter((b) => b.noise).length;
  const main = visibleBlocks(blocks, opts);

  // 标题行的**评论提醒**（§4.9）：**只有真有评论时才传 `opts.commentNote`**。
  // ⚠️ 没有评论 → 这个字符串是 `null` → 标题行与以前**逐字节一致**（"没有评论的稿输出不许变"这条硬约束）。
  L.push(`# 块级清单 — ${titleName(meta)}（${meta.width ?? '?'}×${meta.height ?? '?'}）${metaSuffix(meta)}${opts.commentNote ? ` ｜${opts.commentNote}` : ''}`);
  L.push('');
  // 来源格式交代（**只在新值存在时打** —— 普通稿不传 `opts.sourceNote`，输出逐字节不变）。
  if (opts.sourceNote) { L.push(opts.sourceNote); L.push(''); }
  L.push(`共 **${blocks.length}** 块：` + (Object.entries(counts).map(([k, v]) => `${BLOCK_KINDS[k] ?? k} ${v}`).join(' / ') || '—'));
  if (noiseCount > 0) {
    const tail = opts.includeNoise ? '当前已展开' : '加 --all 或 includeNoise 展开';
    L.push(`> 其中系统 UI / 图形碎片 ${noiseCount} 块**默认折叠**（${tail}）。`);
  }
  L.push('');
  L.push('| # | 类型 | 名称 | 位置 | 尺寸 | 圆角 | 底色 | 不透明 | 边框/分割线 | 文字 | 字号/字重/色 | 字体 | 行高·字距 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const shown = main.slice(0, limit);
  shown.forEach((b, i) => {
    const r = b.radius
      ? (b.radius.pill ? `${b.radius.max}(全圆)` : String(b.radius.max))
      : '—';
    const bg = bgText(b.bg);
    const op = b.opacity != null && b.opacity < 1 ? String(b.opacity) : '—';
    const bd = b.border
      ? `${b.border.color ?? '(无颜色)'} ${b.border.width}px${b.border.single ? `(${b.border.single})` : ''}`
      : '无';
    // 字体族**独立成列**（不再挤在字号格里 `12/500/Inter/#8fa9c1`）：
    // ① 三张表口径一致；② "照表抄 font-family"时不会有歧义 —— 而歧义正是假 ❌ 的温床（实测踩过）。
    const f = b.font
      ? `${b.font.size ?? '?'}/${b.font.weight ?? '?'}${b.color ? `/${b.color}` : ''}`
      : '—';
    const fam = b.font?.family ? shortFamily(b.font.family) : '—';
    L.push(`| ${i + 1} | ${BLOCK_KINDS[b.kind] ?? b.kind} | ${b.name ?? ''} | ${b.x},${b.y} | ${opts.dualUnits ? dualUnits(b.w, b.h, meta.width, opts) : `${b.w}×${b.h}`} | ${r} | ${bg} | ${op} | ${bd} | ${(b.text ?? '').slice(0, 18)} | ${f} | ${fam} | ${metricsText(b.font)} |`);
  });
  if (main.length > limit) L.push(`| … | 其余 ${main.length - limit} 块略（可用 --region / --limit 收窄） | | | | | | | | | |`);

  // 边框总览：案例 2「分割线整条丢失」的直接答案
  const withBorder = main.filter((b) => b.border);
  if (withBorder.length > 0) {
    L.push('');
    L.push(`## 边框 / 分割线（${withBorder.length} 处）`);
    for (const b of withBorder.slice(0, LIMITS.flushMaxRows)) {
      L.push(`- ${b.name}：${b.border.color ?? '(蓝湖未给颜色)'} **${b.border.width}px**，${b.border.sides.join('+')}${b.border.single ? ' ← 单边，即分割线' : ''}`);
    }
    if (withBorder.length > LIMITS.flushMaxRows) L.push(`- … 其余 ${withBorder.length - LIMITS.flushMaxRows} 处略`);
  }

  // 间距一览（§4.2）：块与块"差多少"直接给出来，省掉拿坐标手算。
  // ⚠️ 几何复用 `geometricGaps`（region 用的同一套纯函数）—— **不写第二份间距实现**。
  const digest = renderGapDigest(
    main.map((b) => ({ id: b.path ?? b.name, name: b.name, path: b.path, depth: b.depth, x: b.x, y: b.y, w: b.w, h: b.h })),
    { ...opts, designWidth: meta.width },
  );
  if (digest) {
    L.push('');
    L.push(digest);
  }

  // 无障碍对比度（§4.8）：跟「间距一览」同一风格与位置逻辑 —— 都是**可直接照做**的结论段。
  // ⚠️ 段内容由 `opts.contrast` 传入（readBlocks 那里算好），渲染层不自己去啃图层：
  //    一个稿子的"文字色 vs 背景色"只算一次，人读的文本与机器读的字段天然一致。
  //    拿不到审计结果（比如原型那条链）→ **一个字都不加**，输出逐字节不变。
  if (opts.contrast) {
    const seg = renderContrastDigest(opts.contrast, opts);
    if (seg) {
      L.push('');
      L.push(seg);
    }
  }

  // 评论（§4.9）：同样"段内容由 readBlocks 算好传进来"，位置在「对比度」之后、尾注之前。
  // ⚠️ 没有评论 / 没传 `opts.comments` → `renderComments` 返回空串 → **一个字都不加**，输出逐字节不变。
  if (opts.comments) {
    const seg = renderComments(opts.comments, { designWidth: meta.width, designHeight: meta.height });
    if (seg) {
      L.push('');
      L.push(seg);
    }
  }

  L.push('');
  L.push(resultFooter(L.join('\n'), {
    what: `本稿 ${blocks.length} 块`,
    shown: main.length > shown.length ? `本次列了 ${shown.length} 块` : null,
    next: '改完前端用 `lanhu_verify_blocks` 验收（覆盖面比 verify_spec 大，含可直接抄的建议改法）；缺区域用 `region=...`。',
  }));
  return L.join('\n');
}

/* ==========================================================================
 * 4.8 无障碍对比度（WCAG 2.x AA）—— 读稿时顺手算「文字色 vs 有效背景色」
 *
 * 为什么要有它：色值本来就在手里（**零额外网络请求**），但"这个文字在这个底色上看得清吗"
 * 以前只能靠人肉判断。而最容易漏的两件事，恰好都能算：
 *   ① **有效背景色**：文本层自己的 `底色` 通常是"无"（Figma 里文字节点的 fill 就是文字色）——
 *      必须沿**祖先链**往上找最近的带 fill 的层，找不到再落**画板底色**；
 *      两者都没有 → **明说算不出来**，绝不猜一个白底去算（本项目铁律：拿不准就明说）。
 *   ② **公式必须按标准**：相对亮度要按 sRGB **线性化**。拿 sRGB 直算是本项目最容易犯的
 *      一类错 —— 那样 #777 在白底上会算成 4.7（"达标"），而标准值是 **4.48**（**不达标**），
 *      结论正好反过来，且不会有人发现（数字看着都挺合理）。
 * ========================================================================== */

/**
 * WCAG 相对亮度（**sRGB 线性化**，公式照标准来）。
 * @param {string|object} color hex / rgb() / {r,g,b}
 * @returns {number|null} 解析不出来给 `null`（**不猜**）
 */
export function relativeLuminance(color) {
  const c = parseColor(color);
  if (!c) return null;
  const lin = (v) => {
    const s = clamp01(v / 255);
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * WCAG 对比度：`(L1 + 0.05) / (L2 + 0.05)`，**亮的在上**（顺序无关）。
 * 已知值（断言里写死，防公式被改动）：#000 on #fff = 21；#777777 on #fff ≈ 4.48；#767676 on #fff ≈ 4.54。
 * @returns {number|null} 任一侧解析不出来给 `null`
 */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 源叠合成（source-over）：把半透明的 `fg` 叠在不透明的 `bg` 之上。
 * 用于两处：半透明背景**逐层合成**、半透明文字色**与背景合成**（屏幕上看的就是合成后的字色）。
 */
export function compositeOver(fg, bg) {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return null;
  const a = clamp01(typeof f.a === 'number' ? f.a : 1);
  if (a >= 1) return { r: f.r, g: f.g, b: f.b, a: 1 };
  return {
    r: clamp255(f.r * a + b.r * (1 - a)),
    g: clamp255(f.g * a + b.g * (1 - a)),
    b: clamp255(f.b * a + b.b * (1 - a)),
    a: 1,
  };
}

/**
 * 大号文字（WCAG 2.x）：**≥24px**，或 **≥18.66px 且 bold（≥700）**。
 * 字号/字重稿里都有，直接用 —— 不要按"这是标题所以算大号"去猜。
 * @returns {boolean|null} 字号缺失给 `null`（调用方按**正文 4.5** 判并注明，别猜成大号）
 */
export function isLargeText(size, weight) {
  const s = Number(size);
  if (!Number.isFinite(s) || s <= 0) return null;
  if (s >= LIMITS.largeTextPx) return true;
  const w = Number(weight);
  return s >= LIMITS.largeTextBoldPx && Number.isFinite(w) && w >= LIMITS.largeTextBoldWeight;
}

/**
 * 「父层是谁」—— 从扁平图层数组里还原祖先关系（flattenArtboard 是**先序 DFS**，所以父层必然在前）。
 *
 * ⚠️ 判据同时要求 **depth 差 1** 与 **parentPath 相等**：只按 depth 会在原型那条链上认错
 *    （动态面板的状态层是分批 push 的）；只按 path 会撞同名兄弟。
 * @returns {number} layers 里的下标；`-1` = 没找到（链断了，别再往上猜）
 */
export function parentIndexOf(layers, index) {
  const list = Array.isArray(layers) ? layers : [];
  const l = list[index];
  if (!l || !Number.isFinite(l.depth) || l.depth === 0) return -1;
  const want = String(l.parentPath ?? '');
  for (let j = index - 1; j >= 0; j--) {
    const p = list[j];
    if (p.depth !== l.depth - 1) continue;
    const path = p.parentPath ? `${p.parentPath}/${p.name}` : p.name;
    if (path === want) return j;
  }
  return -1;
}

/**
 * 该图层的**底色**候选（多段渐变给**全部** stop，每段都要单独判）。
 *
 * 判据与 `buildBlocks` 的 `bg` 是同一条（共享 `fillIsTextColor`）：
 * 文字节点的 fill 是文字色不是底色；多段渐变要看每一段。
 * 直接从**图层**上取而不是从块模型取，是因为对比度要看**被过滤掉的祖先** ——
 * 用 `region` 取一块区域时，块清单里可能已经没有那个父容器了，但它仍然是背景。
 */
function layerBackgrounds(l) {
  if (fillIsTextColor(l)) return [];
  const grads = (l.colors ?? []).filter((c) => c.role === COLOR_ROLES.GRADIENT);
  const picked = grads.length > 1
    ? grads
    : (l.colors ?? []).filter((c) => c.role === COLOR_ROLES.FILL || c.role === COLOR_ROLES.GRADIENT).slice(0, 1);
  const op = clamp01(Number(l.opacity ?? 1));
  return picked.map((c) => ({ hex: rgbHex(c), alpha: clamp01((c.a ?? 1) * op) }));
}

/**
 * **有效背景色** —— 本模块最容易算错、也最不该猜的一处。
 *
 * 由近及远沿祖先链找**最近的带 fill 的层**，再落画板底色；半透明**逐层合成**到不透明底上。
 *
 * @param {Array} layers flattenArtboard 的扁平图层
 * @param {number} index 文本层在 layers 里的下标
 * @returns {{ok:true,backgrounds:Array<{hex:string,translucent:boolean}>,gradient:boolean,translucent:boolean,baseIsArtboard:boolean,baseName:string|null}
 *          |{ok:false,reason:'no-fill'|'translucent-no-base'|'no-ancestor'|'no-layer'}}
 *   · `ok:false` 一律**不判断**（明说算不出来），**绝不当成 #ffffff**
 *   · `backgrounds` 长度 >1 = 多段渐变：每段一个候选（判的时候取最差，见 `auditTextContrast`）
 */
export function effectiveBackground(layers, index) {
  const list = Array.isArray(layers) ? layers : [];
  const self = list[index];
  if (!self) return { ok: false, reason: 'no-layer' };
  // 由近及远收集祖先（**排除自身** —— 文字层自己的 fill 是文字色，不是背景）
  const chain = [];
  for (let cur = index; ;) {
    const p = parentIndexOf(list, cur);
    if (p < 0) break;
    chain.push(list[p]);
    cur = p;
  }
  if (self.depth > 0 && chain.length === 0) return { ok: false, reason: 'no-ancestor' };

  let top = null;        // 最近的带 fill 的层（多段渐变会有多项）
  let base = null;       // 顶层之下的**不透明实色**底
  let baseLayer = null;
  const trans = [];      // 顶层与底之间的半透明层（由近及远）
  for (const l of chain) {
    const fills = layerBackgrounds(l);
    if (fills.length === 0) continue;
    if (!top) {
      top = fills;
      baseLayer = l;
      if (fills.length === 1 && fills[0].alpha >= 1) break;  // 顶层自己就不透明 → 下面的都看不见
      continue;                                              // 半透明/渐变 → 还得往下找底
    }
    if (fills.length > 1) {
      // 半透明的上面那层，下面又是一条渐变 → "一个"背景值根本不存在（随位置变），明说算不出
      return { ok: false, reason: 'translucent-no-base' };
    }
    if (fills[0].alpha >= 1) { base = fills[0]; baseLayer = l; break; }
    trans.push(fills[0]);
  }
  const opaqueTop = top && top.length === 1 && top[0].alpha >= 1;
  if (!top) return { ok: false, reason: 'no-fill' };
  if (!opaqueTop && !base) return { ok: false, reason: 'translucent-no-base' };

  const below = [...trans].reverse();   // 由远及近（合成顺序）
  const backgrounds = (opaqueTop ? [top[0]] : top).map((stop) => {
    let acc = opaqueTop ? parseColor(stop.hex) : parseColor(base.hex);
    for (const f of below) acc = compositeOver({ ...parseColor(f.hex), a: f.alpha }, acc);
    if (!opaqueTop) acc = compositeOver({ ...parseColor(stop.hex), a: stop.alpha }, acc);
    return {
      hex: rgbHex(acc),
      // 「半透明」= 参与合成的层里有不是 100% 不透明的（那样的对比度只是**按下层合成后**的参考值）
      translucent: !opaqueTop && (stop.alpha < 1 || trans.length > 0),
    };
  });
  return {
    ok: true,
    backgrounds,
    gradient: top.length > 1,
    translucent: backgrounds.some((b) => b.translucent),
    baseIsArtboard: (baseLayer?.depth ?? -1) === 0,
    baseName: baseLayer?.name ?? null,
  };
}

/**
 * 把一个颜色朝黑/朝白挪到**刚好达标**为止，返回具体色值（建议改法要能直接抄）。
 *
 * 为什么要"取整后复核"：二分给的是**连续** t，取整成 hex 之后可能又掉回阈值下 ——
 * 实测 `#777777` 在白底上就是这个坑：连续解 ≈118.7 → 取整 119 还是 4.48（不达标），
 * 得再挪一档到 **118（#767676）** 才真的过 4.5。
 *
 * @param {string} from 要挪的那个色（文字色，或"要挪它来让文字达标"的底色）
 * @param {string} fixed 另一边（不动）
 * @param {number} required 目标对比度
 * @param {'darken'|'lighten'} dir 往哪边挪
 * @returns {{hex:string,t:number}|null} `null` = 这个方向到不了（纯黑/纯白是终点）
 */
export function shadeToReach(from, fixed, required, dir) {
  const to = dir === 'darken' ? 0 : 255;
  const mix = (t) => {
    const c = parseColor(from);
    const m = (v) => clamp255(v + (to - v) * t);
    return { r: m(c.r), g: m(c.g), b: m(c.b), a: 1 };
  };
  if (contrastRatio(from, fixed) >= required) return { hex: rgbHex(parseColor(from)), t: 0 };
  if (contrastRatio(mix(1), fixed) < required) return null;   // 这一端到不了，试另一端
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < LIMITS.contrastSearchSteps; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(mix(mid), fixed) >= required) hi = mid;
    else lo = mid;
  }
  // 取整后复核（上面那条注释里的 #777 → #767676 就是这么来的）
  for (let t = hi, i = 0; t <= 1 && i <= 255; i++, t += 1 / 255) {
    const hex = rgbHex(mix(t));
    if (contrastRatio(hex, fixed) >= required) return { hex, t };
  }
  return null;
}

/**
 * 建议改法的一句话（直接给色值，别只说"对比度不足"）。
 *
 * 方向按"把文字**推离**底色"来定（文字比底色亮就继续提亮，反之压暗）——
 * 只按"改动量最小"会给出怪建议：白字压在中紫按钮上时，把白字改成近黑**确实**达标（4.97），
 * 但那不是设计意图；这时该给的是"把底色调深"，或至少把反向改动说清楚。
 */
function suggestionText(glyphHex, bgHex, required) {
  const natural = relativeLuminance(glyphHex) >= relativeLuminance(bgHex) ? 'lighten' : 'darken';
  const word = (d) => (d === 'darken' ? '压暗' : '提亮');
  const s = shadeToReach(glyphHex, bgHex, required, natural);
  if (s) return `文字色${word(natural)}到 **${s.hex}** 或更${natural === 'darken' ? '深' : '亮'}`;
  // 自然方向已经到头（文字本来就是纯黑/纯白）→ 两条路都给出来，够选
  const backDir = natural === 'darken' ? 'lighten' : 'darken';
  const bgDir = natural === 'darken' ? 'lighten' : 'darken';
  const back = shadeToReach(glyphHex, bgHex, required, backDir);
  const bgFix = shadeToReach(bgHex, glyphHex, required, bgDir);
  const parts = [];
  if (bgFix) parts.push(`把这块底色${word(bgDir)}到 **${bgFix.hex}**（文字色不动）`);
  if (back) parts.push(`${parts.length ? '或' : ''}把文字色${word(backDir)}到 **${back.hex}**（反向）`);
  return parts.length ? parts.join('，') : `该底色上用黑白两端都到不了 ${required}:1 → 得换背景色`;
}

const CONTRAST_UNKNOWN_TEXT = Object.freeze({
  'no-fill': '祖先链与画板**都没有底色** —— 稿里就没给，**不猜**一个色当背景',
  'translucent-no-base': '背景是**半透明**、而它下面没有不透明底 —— 合成结果取决于稿外内容',
  'no-ancestor': '图层树里找不到它的父层（链断了，不往上硬猜）',
  'no-layer': '这个块找不到对应的源图层',
  'no-color': '文字色**稿里没给**（不是没算，是没得算）',
});

/**
 * 对比度审计：对每个文本块算「文字色 vs 有效背景色」的 WCAG 对比度。
 * 只出**数据**（排版交给 `renderContrastDigest`），方便单测与后续 diff。
 *
 * ⚠️ 背景拿不准的块**不进 `fail`**（不能因为算不出背景就说人家不达标），而是进 `unknown`。
 */
export function auditTextContrast(blocks, layers) {
  const list = Array.isArray(layers) ? layers : [];
  const texts = (blocks ?? []).filter((b) => b && typeof b.text === 'string' && b.text !== '');
  const out = { total: texts.length, checked: 0, fail: [], unknown: [], minRatio: null, gradientCount: 0 };
  for (const b of texts) {
    const spot = { name: b.name, path: b.path, depth: b.depth, x: b.x, y: b.y };
    const fg = b.color ? parseColor(b.color) : null;
    if (!fg) {
      out.unknown.push({ ...spot, fg: null, reason: 'no-color' });
      continue;
    }
    const idx = Number.isInteger(b.layerIndex) ? b.layerIndex : -1;
    const bg = idx >= 0 ? effectiveBackground(list, idx) : { ok: false, reason: 'no-layer' };
    if (!bg.ok) {
      out.unknown.push({ ...spot, fg: b.color, reason: bg.reason });
      continue;
    }
    const large = isLargeText(b.font?.size, b.font?.weight);
    const required = large === true ? LIMITS.contrastLarge : LIMITS.contrastNormal;
    // 半透明文字色：**与背景合成**后才是屏幕上看到的字色（合成后仍是这个色值的对比度问题）
    const fgAlpha = clamp01(typeof b.colorAlpha === 'number' ? b.colorAlpha : 1);
    let worst = null;
    for (const cand of bg.backgrounds) {
      const glyph = fgAlpha >= 1 ? { ...fg, a: 1 } : compositeOver({ ...fg, a: fgAlpha }, cand.hex);
      const glyphHex = rgbHex(glyph);
      const ratio = contrastRatio(glyphHex, cand.hex);
      // 多段渐变：逐段判、取**最差**的那段（标题压在最亮那段上的时候最危险）
      if (!worst || ratio < worst.ratio) {
        worst = {
          ...spot, ratio, required, large: large === true, glyphHex, bgHex: cand.hex,
          bgTranslucent: cand.translucent, fgTranslucent: fgAlpha < 1,
          // 字号稿里没给 → 只能按**正文 4.5** 判（保守方向），并在行里注明，别让人以为查过了
          noSize: large === null,
          gradient: bg.gradient, baseIsArtboard: bg.baseIsArtboard,
        };
      }
    }
    out.checked += 1;
    out.minRatio = out.minRatio === null ? worst.ratio : Math.min(out.minRatio, worst.ratio);
    if (bg.gradient) out.gradientCount += 1;
    // 浮点比较留一点余量，免得 4.499999 被判成"不达标"来回抖动
    if (worst.ratio + 1e-9 < required) {
      worst.delta = round2(required - worst.ratio);
      worst.suggestion = suggestionText(worst.glyphHex, worst.bgHex, required);
      out.fail.push(worst);
    }
  }
  out.fail.sort((a, b) => a.ratio - b.ratio);   // 最糟的排最前
  return out;
}

/** 对比度数字显示（整数不补 `.00`：`21:1` 比 `21.00:1` 好读）。 */
function fmtRatio(r) {
  const v = round2(r);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * 「对比度」段 —— **只列不达标**的（全列一遍会把块级清单淹掉）。
 * 判据、阈值、背景取法全部写在表头（跟「间距一览」同一风格）。
 */
export function renderContrastDigest(audit, opts = {}) {
  if (!audit || typeof audit !== 'object') return '';
  const fail = audit.fail ?? [];
  const unknown = audit.unknown ?? [];
  if ((audit.checked ?? 0) === 0 && unknown.length === 0) return '';
  const limit = Number.isFinite(opts.contrastMaxRows) ? Number(opts.contrastMaxRows) : LIMITS.contrastMaxRows;
  const items = [...fail, ...unknown];
  const lab = makeLabeler(items);

  const L = [];
  L.push('## 对比度（无障碍 —— 正文 ≥4.5:1，大号文字 ≥3:1）');
  L.push('> 判据：WCAG 2.x 相对亮度（sRGB **线性化**）→ `(L1+0.05)/(L2+0.05)`；**大号文字 = 字号 ≥24px，或 ≥18.66px 且字重 ≥700**（字号/字重取自稿子）。');
  L.push('> 背景取法：沿**祖先链**找最近的带 fill 的层 → 没有就落**画板底色**；半透明**已逐层合成**到不透明底（标 `合成`），**不是**当实色算的。');
  L.push(`> **只列不达标**的；本次判了 **${audit.checked}** 个文本层${audit.gradientCount ? `（其中 ${audit.gradientCount} 个是渐变背景，按**最差** stop 判）` : ''}。`);
  if (fail.length === 0) {
    const min = audit.minRatio === null || audit.minRatio === undefined ? null : fmtRatio(audit.minRatio);
    L.push(min
      ? `- **全部达标**（${audit.checked} 个文本层，最低 **${min}:1**）`
      : '- **没有可判的文本层**（背景/文字色都没取到，见下面那段）');
  } else {
    L.push('');
    for (const [i, r] of fail.slice(0, limit).entries()) {
      const note = [
        r.gradient ? '渐变取最差 stop' : null,
        r.bgTranslucent ? '半透明背景·已合成' : null,
        r.fgTranslucent ? '半透明文字色·已合成' : null,
        r.large ? '大号' : null,
        r.noSize ? '字号未给·按正文 4.5 判' : null,
      ].filter(Boolean).join('；');
      L.push(`- ${lab.of(r, i)} ｜ \`${r.glyphHex}\` / \`${r.bgHex}\`${r.baseIsArtboard ? '（画板）' : ''} ｜ **${fmtRatio(r.ratio)}:1**（需 ${r.required}:1） ｜ 差 **${r.delta}** ｜ ${r.suggestion}${note ? ` ｜ _${note}_` : ''}`);
    }
    if (fail.length > limit) L.push(`- … 其余 ${fail.length - limit} 个不达标的略（用 region 收紧再看）`);
  }
  if (unknown.length > 0) {
    L.push('');
    L.push(`### 背景无法确定（${unknown.length} 个文本层，**未做对比度判断**）`);
    for (const [i, r] of unknown.slice(0, limit).entries()) {
      L.push(`- ${lab.of(r, fail.length + i)} ｜ 文字色 ${r.fg ? `\`${r.fg}\`` : '（未给）'} ｜ ${CONTRAST_UNKNOWN_TEXT[r.reason] ?? r.reason}`);
    }
    if (unknown.length > limit) L.push(`- … 其余 ${unknown.length - limit} 个略`);
  }
  return L.join('\n');
}

/* ==========================================================================
 * 4.9 评论 / 标注（**人类留在稿子上的话**）—— 独立接口，不在图层树里
 *
 * 为什么要有它：图层树只回答"稿子长什么样"，回答不了"人类要求改成什么样"。
 * 而「要个png的图片」这种话**只存在于评论里** —— 图层树里一个字都找不到。
 * （本仓库一度因为"在图层树里搜不到 comment 字段"得出过"蓝湖读不到评论"的结论，**那是错的**：
 *   评论是**另一个接口**，与图层树无关。结论写在这里，免得下次再去图层树里翻。）
 *
 * 接口（真机实测，2026-10，**只读**）：
 *   GET /api/project/comment?page=1&pageSize=20&image_id=<imageId>
 *   → {has_comment, has_next, total, result:[{id, content, position_x, position_y, read,
 *      replies, user:{id,name,nickname,…}, version:{version_id,version_info}, create_time, …}]}
 *
 * 三条硬事实（都是实测踩出来的，别再摸一遍）：
 *   ① **必须给 `image_id`**：只给 project_id 会报 `{"code":"10007","msg":"Project not exist"}`；
 *   ② `position_x/y` 是**归一化 0~1**，而块坐标是**画板相对 px** —— 必须乘画板宽高再比。
 *      两套坐标系直接比就是本项目踩过的"坐标系不一致"（这里差 375 倍，看着像"没命中任何块"）；
 *      `commentPoint` 是**唯一**的换算出口，别在别处再乘一遍；
 *   ③ **只读**：本模块只发 GET，绝不改 / 删评论，也绝不标记已读（`read` 字段只读不写）。
 * ========================================================================== */

/** 整数夹取（带兜底）：分页参数这种"调用方能传"的数字，**必须**夹在 LIMITS 的区间里。 */
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 蓝湖给的时间戳是 **Unix 秒**（实测 1791587876 → 2026-10-09）；13 位毫秒也容错。 */
export function unixToIso(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n > 1e11 ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 有限数才给值，否则 `null`（`undefined` 不是合法 lossless JSON，宿主会拒收整个结果）。 */
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一条评论里的用户 → 稳定小对象。
 * ⚠️ **别把接口的 `user` 原样透传**：实测那里面有 20 个字段（`bind_mobile` / `mobpush_reg_id` /
 *    `wechat_nickname` / `open_id` …），与本需求无关，还会把工具返回体撑大。
 *    `display` = 昵称优先（重名时才是问题，此时文本里会额外括注账号名）。
 */
function normalizeCommentUser(u) {
  const raw = u && typeof u === 'object' ? u : {};
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const nickname = typeof raw.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim() : null;
  return { id: raw.id ?? null, name, nickname, display: nickname ?? name ?? null };
}

/** 回复 → 归一化对象（字段与主评论同形，只是没有 replies）。 */
function normalizeCommentReply(raw) {
  const r = raw && typeof raw === 'object' ? raw : { content: typeof raw === 'string' ? raw : '' };
  return {
    id: r.id ?? null,
    content: typeof r.content === 'string' ? r.content : '',
    user: normalizeCommentUser(r.user),
    createdAt: unixToIso(r.create_time),
  };
}

/** 一条评论 → 归一化对象（**故意留下归一化坐标**，换算统一走 `commentPoint`）。 */
function normalizeComment(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const replies = Array.isArray(r.replies) ? r.replies.map(normalizeCommentReply) : [];
  return {
    id: r.id ?? null,
    content: typeof r.content === 'string' ? r.content : (typeof r.content_rich_text === 'string' ? r.content_rich_text : ''),
    user: normalizeCommentUser(r.user),
    version: { id: r.version?.version_id ?? null, info: r.version?.version_info ?? null },
    // 蓝湖给 `read: false` = **未读**（字段名是肯定式，语义是"已读"，别读反）
    unread: r.read === false,
    createdAt: unixToIso(r.create_time),
    updatedAt: unixToIso(r.update_time),
    position: { x: numOrNull(r.position_x), y: numOrNull(r.position_y) },
    replies,
  };
}

/**
 * 读一张稿的**评论 / 标注**（人类留的需求）。
 *
 * ⚠️ `projectId` **只进错误信息与调用方对称**，不进 URL —— 实测只给 project_id 会报
 *    `10007 Project not exist`，**必须给 image_id**。
 * ⚠️ 分页：按 `has_next` 翻页，但**有硬上限**（`commentsMaxPages` / `commentsMaxTotal`）；
 *    撞上限时返回 `truncated: true`（**不静默截断**，人读文本里也会写明）。
 * ⚠️ 失败时**抛错**（与其它 fetcher 一致）：`read_blocks` 在调用点 catch 并降级（见 readBlocks）。
 *
 * @param {string} projectId
 * @param {string} imageId
 * @param {{cookie?:string, account?:string, pageSize?:number, maxPages?:number, retries?:number, timeout?:number}} [opts]
 */
export async function fetchComments(projectId, imageId, opts = {}) {
  if (!imageId) {
    throw new LanhuError(
      `读评论必须给 imageId（只给 project_id 会被蓝湖判成 10007 Project not exist）${projectId ? `；本次 projectId=${projectId}` : ''}。`,
      { code: 'COMMENT_NEED_IMAGE_ID' },
    );
  }
  const pageSize = clampInt(opts.pageSize, 1, LIMITS.commentsPageSize, LIMITS.commentsPageSize);
  const maxPages = clampInt(opts.maxPages, 1, LIMITS.commentsMaxPages, LIMITS.commentsMaxPages);

  const items = [];
  const seen = new Set();
  let total = null;
  let hasComment = null;
  let pages = 0;
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${BASE}/api/project/comment?page=${page}&pageSize=${pageSize}&image_id=${encodeURIComponent(imageId)}`;
    // ⚠️ **只读**：method 永远是 GET、永远没有 body。写请求（改/删/标已读）本项目一概不发。
    const { json } = await apiRequest(url, { cookie: opts.cookie, account: opts.account, retries: opts.retries, timeout: opts.timeout, method: 'GET' });
    pages = page;
    // 这个接口**不走** `unwrap`：外层 {has_comment,has_next,total,result} 本身就是信封，
    // 而 `unwrap` 见到 `result` 就把**数组**掏出来了 —— 分页信息会整段丢掉（实测坑）。
    const raw = (json && typeof json === 'object' && Array.isArray(json.result)) ? json : (unwrap(json) ?? {});
    const list = Array.isArray(raw.result) ? raw.result : [];
    for (const c of list) {
      const n = normalizeComment(c);
      if (n.id && seen.has(n.id)) continue;   // 翻页期间数据变动时别重复计数
      if (n.id) seen.add(n.id);
      items.push(n);
    }
    if (total === null) total = numOrNull(raw.total);
    if (hasComment === null) hasComment = raw.has_comment === undefined ? list.length > 0 : Boolean(raw.has_comment);
    if (raw.has_next !== true) break;
    if (total !== null && items.length >= total) break;
    if (items.length >= LIMITS.commentsMaxTotal) { truncated = true; break; }
    if (page === maxPages) truncated = true;
  }

  return {
    imageId,
    hasComment: Boolean(hasComment),
    total: total ?? items.length,
    unread: items.filter((i) => i.unread).length,
    fetched: items.length,
    pages,
    truncated,
    items,
  };
}

/**
 * 评论的**归一化坐标** → **稿上（画板相对）坐标**。
 *
 * ⚠️ 全项目**唯一**的换算出口。`position_x/y` 是 0~1 归一化，块的 `x/y/w/h` 是画板相对 px；
 *    两者直接比就是"坐标系不一致"（这里差一个画板宽），且**不会报错**，只会静默地一个块都不命中。
 *
 * @returns {{x:number,y:number}|null} 拿不到就 `null`（**不猜**）：缺字段 / 画板尺寸不可用 /
 *   蓝湖对"没定位在这张稿上"的评论给 **(0,0)** 哨兵 / 归一化值越界。
 */
export function commentPoint(position, width, height) {
  const nx = Number(position?.x);
  const ny = Number(position?.y);
  const W = Number(width);
  const H = Number(height);
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || !Number.isFinite(W) || !Number.isFinite(H)) return null;
  if (W <= 0 || H <= 0) return null;
  // (0,0) 是**哨兵**不是坐标：照算的话每条没定位的评论都会命中画板左上角那个块（本项目最忌讳的"硬套"）
  if (nx === 0 && ny === 0) return null;
  const eps = LIMITS.commentsNormEpsilon;
  if (nx < -eps || nx > 1 + eps || ny < -eps || ny > 1 + eps) return null;
  return { x: round2(clamp01(nx) * W), y: round2(clamp01(ny) * H) };
}

/** 点到块的**矩形距离**（落在块内 = 0）。 */
function pointRectDistance(b, x, y) {
  const bx = b.x ?? 0;
  const by = b.y ?? 0;
  const dx = Math.max(bx - x, 0, x - (bx + (b.w ?? 0)));
  const dy = Math.max(by - y, 0, y - (by + (b.h ?? 0)));
  return round2(Math.sqrt(dx * dx + dy * dy));
}

function pointInRect(b, x, y) {
  return x >= (b.x ?? 0) && x <= (b.x ?? 0) + (b.w ?? 0) && y >= (b.y ?? 0) && y <= (b.y ?? 0) + (b.h ?? 0);
}

/**
 * 块内**最细**的那个"真名字"图层（可选线索）。
 *
 * 为什么需要它：有些真元素**不成块** —— 比如弹窗里的职业照占位层 `生成男士职业照 1`
 * （无填充/无边框/无圆角/非切图 → `classifyBlock` 判成 OTHER → 不进块模型）。
 * 实测：某条「要个png的图片」的评论，块只能定位到"弹窗卡片"，**最细层才正对得上评论说的东西**。
 * 判据：在块内 + 面积比块小 + 名字**不是工具默认名**（复用 `isAutoLayerName`，不写第二份尺子）
 * —— 否则会答出 `Vector` / `Group 1321314767` 这种等于没说的名字。
 */
function finestNamedLayer(layers, point, blockPath) {
  let best = null;
  for (const l of layers ?? []) {
    if (!l || l.depth === 0) continue;
    if (blockPath) {
      const p = l.parentPath ? `${l.parentPath}/${l.name}` : String(l.name ?? '');
      if (p !== blockPath && !p.startsWith(`${blockPath}/`)) continue;
    }
    if (!pointInRect(l, point.x, point.y)) continue;
    if (isAutoLayerName(l.name).auto) continue;
    const area = Math.max(0, (l.w ?? 0) * (l.h ?? 0));
    if (!best || area < best.area) best = { area, name: l.name, type: l.type ?? null, w: l.w ?? null, h: l.h ?? null };
  }
  return best ? { name: best.name, type: best.type, w: best.w, h: best.h } : null;
}

/**
 * 评论落点 → 块（**这一步才是本功能的用处**：AI 据此知道"该改哪儿"，而不是只知道"有人在说话"）。
 *
 * 判据（阈值全在 `LIMITS`，别在逻辑里裸写数字）：
 *   ① 候选 = **全稿可见块**（`visibleBlocks`，与表格的 noise 折叠同口径）**去掉画板**：
 *      `depth === 0` 的坐标是**画布绝对坐标**（实测 -12638 这种），拿它当容器会命中一切；
 *      ⚠️ 候选**不受 region/kind/minWidth 影响** —— 评论是**整张稿**的标注，
 *         不该因为"你这次只看某个 region"就变成"没落在任何块上"；
 *   ② 落在多个块里 → 取**面积最小**的（最具体）；面积落在 `[最小, 最小 ÷ commentsSameBoxRatio]`
 *      区间内的候选视为**同框副本**（实测：卡片与它的 `Section - ModalDialogCard:shadow` 只差 0.02% 面积），
 *      此时取**层级更浅**的那个 —— 否则评论会挂在 `…:shadow` 这种装饰副本上
 *      （判据是**双侧**的：只取下界会把"所有更大的块"也算进同一组，正常嵌套就会被错取成最外层）；
 *   ③ 一个块都没命中 → **如实说"未落在任何块上"**；只有最近的块在 `commentsNearDistance` 内，
 *      才附一句"最近的是…（约 N px 外）"当线索，并**明说那不是命中**；
 *   ④ 坐标拿不到（缺字段 / 蓝湖的 (0,0) / 越界）→ 连"最近"都不给（**不硬套一个块**）。
 *
 * @param {Array} items `fetchComments` 的 `items`
 * @param {Array} blocks **全稿**块（未过滤）
 * @param {{width?:number, height?:number}} meta 画板尺寸（换算是用它算的）
 * @param {{includeNoise?:boolean, layers?:Array}} [opts] `layers` = `flattenArtboard` 的输出（最细层线索）
 */
export function mapCommentsToBlocks(items, blocks, meta = {}, opts = {}) {
  const W = meta.width;
  const H = meta.height;
  const pool = visibleBlocks(blocks ?? [], opts).filter((b) => b && b.depth > 0);
  return (items ?? []).map((c) => {
    const point = commentPoint(c.position, W, H);
    const base = { ...c, point, anchor: null };
    if (!point) {
      base.anchor = {
        hit: false,
        reason: 'no-position',
        x: null, y: null,
        block: null, distance: null, layer: null,
      };
      return base;
    }
    const inside = pool.filter((b) => pointInRect(b, point.x, point.y));
    let hit = null;
    if (inside.length > 0) {
      const areaOf = (b) => Math.max(0, (b.w ?? 0) * (b.h ?? 0));
      const minArea = Math.min(...inside.map(areaOf));
      // 同框副本（面积**几乎相同**）取层级更浅的那个：`X` 与 `X:shadow` 实测只差 0.02% 面积。
      // ⚠️ 判据是**双侧**的（`[minArea, minArea/ratio]`）：只写下界会把"所有更大的块"都算进同一个
      //    cluster，于是"按钮(60×30) 落在卡片(300×300) 里"这种正常嵌套会错取外层卡片（自检逮住过）。
      const maxArea = minArea / LIMITS.commentsSameBoxRatio;
      const cluster = inside.filter((b) => areaOf(b) <= maxArea);
      cluster.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || (a.uid ?? 0) - (b.uid ?? 0));
      hit = cluster[0];
    }
    let nearest = null;
    let distance = null;
    if (!hit) {
      for (const b of pool) {
        const d = pointRectDistance(b, point.x, point.y);
        if (distance === null || d < distance) { distance = d; nearest = b; }
      }
    }
    const useNear = !hit && nearest && distance !== null && distance <= LIMITS.commentsNearDistance;
    const chosen = hit ?? (useNear ? nearest : null);
    base.anchor = {
      hit: Boolean(hit),
      reason: hit ? 'hit' : (useNear ? 'near' : (pool.length === 0 ? 'no-blocks' : 'blank')),
      x: point.x,
      y: point.y,
      // "最近"只是个线索：`hit:false` 说得很清楚，别把线索当命中读
      distance: hit ? 0 : distance,
      block: chosen ? {
        uid: chosen.uid ?? null,
        name: chosen.name ?? null,
        path: chosen.path ?? null,
        label: blockLabel(chosen),
        kind: chosen.kind ?? null,
        kindLabel: BLOCK_KINDS[chosen.kind] ?? chosen.kind ?? null,
        x: chosen.x ?? null,
        y: chosen.y ?? null,
        w: chosen.w ?? null,
        h: chosen.h ?? null,
      } : null,
      layer: chosen ? finestNamedLayer(opts.layers, point, chosen.path) : null,
    };
    return base;
  });
}

/** 一个用户名怎么打：`@昵称（账号名）` / `@账号名` / `@（未署名）`。 */
function commentUserText(user) {
  const display = user?.display ?? null;
  const name = user?.name ?? null;
  if (display && name && display !== name) return `@${display}（${name}）`;
  return display ? `@${display}` : '@（未署名）';
}

/** 正文截断（评论能很长；表格/段落的体积要有概念）。 */
function commentContentText(content) {
  const s = String(content ?? '');
  const chars = [...s];
  if (chars.length <= LIMITS.commentsMaxContent) return s || '（空）';
  return `${chars.slice(0, LIMITS.commentsMaxContent).join('')}…（共 ${chars.length} 字）`;
}

/**
 * 评论段（接在「对比度」之后、尾注之前）。
 *
 * ⚠️ **没有评论就返回空串** —— "无评论的稿输出逐字节不变"这条硬约束就是靠它 + `renderBlocks`
 *    里那个 `if (seg)` 双双守住的（两边都不能自作主张打一个空标题）。
 * ⚠️ 读取失败时**明说**（不静默）：静默会让 AI 把"读不到"当成"设计师没留言"，
 *    那正是本项目最忌讳的失败模式。返回体里另有机器可读的 `commentsError`。
 *
 * @param {{items?:Array, total?:number, unread?:number, truncated?:boolean, error?:string}} result
 * @param {{designWidth?:number, designHeight?:number}} [opts]
 */
export function renderComments(result, opts = {}) {
  if (!result) return '';
  const L = [];
  if (result.error) {
    L.push('## 评论（**读取失败**）');
    L.push('> 评论接口这次没读通 —— **这不代表"没人留评论"**，别当成"设计师没留言"就往下做。');
    L.push(`> 失败原因：${result.error}`);
    L.push('> 只读：本插件只发 GET，从不改 / 删评论，也不标记已读。');
    return L.join('\n');
  }
  const items = result.items ?? [];
  if (items.length === 0) return '';   // ← 无评论：一个字都不加（逐字节不变）
  const unread = items.filter((i) => i.unread).length;
  const W = opts.designWidth;
  const H = opts.designHeight;
  L.push(`## 评论（${items.length} 条${unread > 0 ? `，含未读 ${unread}` : ''}）`);
  L.push(`> 来源：蓝湖的**评论 / 标注**（独立接口，**不在图层树里**）—— 人类留的需求就写在这儿（如「要个png的图片」）。`);
  L.push(`> 落点：接口给的是**归一化 0~1** 坐标 \`position_x/y\`，这里已按画板 ${W ?? '?'}×${H ?? '?'} 换算成稿上坐标再匹配块（**别自己再乘一遍**）；匹配不上就**明说**，不硬套。`);
  L.push('> 只读：本插件只发 GET，从不改 / 删评论，也不标记已读。');
  if (result.truncated) {
    L.push(`> ⚠️ 已达分页上限（每页 ${LIMITS.commentsPageSize} 条 × 最多 ${LIMITS.commentsMaxPages} 页）：本次取到 **${items.length}** 条 / 共 ${result.total ?? '?'} 条。`);
  }
  L.push('');
  for (const it of items) {
    const ver = it.version?.info || (it.version?.id ? `版本 ${String(it.version.id).slice(0, 8)}` : '版本未知');
    const marks = [commentUserText(it.user), ver, it.unread ? '**未读**' : null].filter(Boolean).join(' · ');
    L.push(`- 评论（${marks}）：「${commentContentText(it.content)}」`);
    const a = it.anchor;
    if (!a) continue;
    if (a.reason === 'no-position') {
      L.push('  - ↳ **未落在任何块上**（这条评论没带定位坐标 —— `position_x/y` 为 0 或不可用）');
    } else if (a.hit && a.block) {
      L.push(`  - ↳ 挂在 **${a.block.label}** 这块（${a.block.kindLabel ?? '?'} · ${Math.round(a.block.w ?? 0)}×${Math.round(a.block.h ?? 0)}），落点 (${a.x}, ${a.y})`);
      if (a.layer) {
        L.push(`  - ↳ 该块内最细的层：**${a.layer.name}**（${a.layer.type ?? '?'} · ${Math.round(a.layer.w ?? 0)}×${Math.round(a.layer.h ?? 0)}）—— 要精确到元素时看它`);
      }
    } else if (a.block) {
      const d = a.distance === null ? '?' : Math.round(a.distance);
      L.push(`  - ↳ **未落在任何块上**（落点 (${a.x}, ${a.y}) 是空白）；最近的是 **${a.block.label}**（${a.block.kindLabel ?? '?'} · ${Math.round(a.block.w ?? 0)}×${Math.round(a.block.h ?? 0)}，约 ${d}px 外）—— **只是线索，不是命中**`);
    } else {
      L.push(`  - ↳ **未落在任何块上**（落点 (${a.x}, ${a.y}) ${a.reason === 'no-blocks' ? '；这张稿一个可见块都没有' : '处没有块'}）`);
    }
    for (const rep of (it.replies ?? []).slice(0, LIMITS.commentsMaxReplies)) {
      L.push(`  - ↳ 回复 ${commentUserText(rep.user)}：「${commentContentText(rep.content)}」`);
    }
    if ((it.replies ?? []).length > LIMITS.commentsMaxReplies) {
      L.push(`  - ↳ … 另有 ${(it.replies ?? []).length - LIMITS.commentsMaxReplies} 条回复略`);
    }
  }
  return L.join('\n');
}

/** 标题行的评论提醒（**只有真有评论时才有这个字符串**，见 renderBlocks）。 */
export function commentNoteText(result) {
  if (!result || result.error) return null;
  const n = (result.items ?? []).length;
  if (n === 0) return null;
  const unread = (result.items ?? []).filter((i) => i.unread).length;
  if (result.truncated) return `本稿有 ${result.total ?? n} 条评论（本次读到 ${n} 条，含未读 ${unread}）`;
  return `本稿有 ${n} 条评论（含未读 ${unread}）`;
}

/* ==========================================================================
 * 5. 渲染（给模型看的紧凑文本）
 * ========================================================================== */

function kb(str) { return `${(Buffer.byteLength(str, 'utf8') / 1024).toFixed(2)}KB`; }

/**
 * 结果尾注（**§4.5 下一步提示 + §4.6 体积/落盘提示**）。
 *
 * ⚠️ 体积按**正文**算（`body`，不含本尾注自身）—— 把一个"包含了本行长度"的数字报出去，
 * 数字会随提示文字自己变化，既没意义也无法核对。
 * ⚠️ 落盘路径只在**真有**（`format=full`）时才打；没有就不提，不编一个路径。
 */
function resultFooter(body, opts = {}) {
  const bits = [`≈${kb(body)}`];
  if (opts.what) bits.push(opts.what);
  if (opts.shown) bits.push(opts.shown);
  if (opts.filePath) bits.push(`完整 ${opts.layered ? `${opts.layered} 层` : '数据'}已落盘 \`${opts.filePath}\`（用 region/kind 精确取，**勿全文读**）`);
  const next = opts.next
    ?? '还原布局优先用 `lanhu_read_blocks`；缺哪个区域用 `region=...` 精确取（配 `gapMaxDistance` 过滤间距），别拿 `format=full` 的 JSON 自己写脚本解析。';
  return `— ${bits.join('；')}\nℹ️ ${next}`;
}

/**
 * 字体族短名 —— 表格列宽有限，"Alibaba PuHuiTi 2.0" 这种长名会撑爆整张表。
 * 去掉空白与 `.0` 版本尾巴，过长再截断。
 * ⚠️ 字体族必须进三张表：它和 opacity 一样，**数据一直在 layer 上（`font.family`），
 *    但以前三种文本输出都不打印**，还原时只能猜默认字体（实测踩过，见 pitfalls 34）。
 */
function shortFamily(name) {
  const s = String(name).replace(/\s+/g, ' ').trim().replace(/\s*\.0$/, '');
  return s.length > 20 ? `${s.slice(0, 19)}…` : s;
}

/**
 * 填充色单元格 —— 单色与**多段渐变**的统一显示。
 *
 * ⚠️ 多段渐变必须打**全部** stop：以前渲染 `.find()` 只取第一个，
 * 表格里「有颜色」，**看着不像缺信息**，比 opacity 漏读更隐蔽 ——
 * 实测踩过：地图辉光 `#145994@18% → #08294a@10%`、城市热点三段青色
 * `#e5ffff → #0de5ff → #0da6ff@8%` 都是手工翻 full JSON 才拿到（交接清单缺口 4）。
 *
 * 描边 role 也在这里标出：只有描边的图层（glow / 分割线）不该被当成底色。
 */
/**
 * 区块（`buildBlocks` 的块级模型）的填充文案 —— 与图层侧的 `fillText` **同口径**。
 *
 * 两侧输入形状不同（图层给 `colors[]`（带 r/g/b/a），区块给 `bg {hex, alpha, stops[]}`），
 * 所以函数是两个；但**半透明色的 rgba 后缀只走 `rgbaSuffix()` 一处** —— hex→rgb 复用 `parseColor()`。
 * 这样 summary / blocks / region 三张表里的半透明色写法（形如 `` `#574af4@10% (rgba(87, 74, 244, 0.1))` ``）必然一致。
 *
 * **导出**：`lib/index.js` 的模型提示（`SYSTEM_HINT`）里那个"半透明色值长什么样"的示范**也取这个函数的
 * 返回值**，不再手抄 —— 手抄过一次就和真值漂移了（提示里曾写成逗号后无空格、alpha 少前导 0 的形态，
 * 而真实产出是 `rgba(87, 74, 244, 0.1)`；模型会照着错的示例去匹配）。
 */
export function bgText(bg) {
  if (!bg) return '无';
  const one = (hex, alpha) => {
    if (typeof alpha !== 'number' || alpha >= 1) return hex;
    return `${hex}@${Math.round(alpha * 100)}%${rgbaSuffix({ ...parseColor(hex), a: alpha })}`;
  };
  if (bg.stops?.length > 1) return bg.stops.map((s) => one(s.hex, s.alpha)).join('→');
  return one(bg.hex, bg.alpha);
}

function fillText(colors) {
  const arr = colors ?? [];
  const grads = arr.filter((c) => c.role === COLOR_ROLES.GRADIENT);
  const one = (c) => `${rgbHex(c)}${c.a < 1 ? `@${Math.round(c.a * 100)}%` : ''}${rgbaSuffix(c)}`;
  if (grads.length > 1) return grads.map(one).join('→');
  // 保持既有兜底顺序（数组里第一个 fill，再退到首个色）——只是把渐变 stop 提到最前。
  const c = grads[0] ?? arr.find((x) => x.role === COLOR_ROLES.FILL) ?? arr[0];
  if (!c) return '—';
  return `${c.role === 'border' ? '描边 ' : ''}${one(c)}`;
}

/**
 * 半透明色值的「可粘贴形式」后缀 —— 形如 `` ` (rgba(87, 74, 244, 0.1))` ``；不透明给空串。
 *
 * ⚠️ **复用 `rgbaString()`**（verify 的颜色解析用它把 getComputedStyle 的值解析回来）——
 * 不要再写一个 rgba 转换：两份实现必然漂移，而这类"看着差不多"的漂移正是假 ❌ 的来源。
 * 只在 `a < 1` 时附加：不透明色加 ` (rgb(…))` 纯属噪音。
 */
function rgbaSuffix(c) {
  if (!c || !(typeof c.a === 'number' && c.a < 1)) return '';
  return ` (${rgbaString(c)})`;
}

/**
 * 双单位换算比例（**§3.2**）：设计稿宽度决定 —— 基准 750，即 `rpx = px × 750 / 画板宽`。
 * 宽 375 → ×2；宽 750 → ×1；H5/PC 端按 1:1 用 px（那就是"不换算"）。
 *
 * ⚠️ 公式与 `toTarget(px, 'mini', …)` **同源**（那个是 verify 用的）。这里只做"比例 + 说明"，
 * 数值换算一律走 `toTarget`，避免出现第二份换算实现。
 */
function unitScale(designWidth, base = 750) {
  const w = Number(designWidth);
  if (!Number.isFinite(w) || w <= 0) return null;
  return base / w;
}

/** 换算基准的一句话说明（让输出里能看出用的是哪个基准，而不是一个孤零零的数字）。 */
export function unitBasisNote(designWidth, base = 750) {
  const s = unitScale(designWidth, base);
  if (s === null) return '画板宽度未知 → 只给 px（无法换算 rpx）';
  if (Math.abs(s - 1) < 1e-9) return `按画板宽 ${designWidth}（基准 ${base}）→ **1:1**，rpx 与 px 同值`;
  return `按画板宽 ${designWidth}（基准 ${base}）→ **×${round2(s)}**`;
}

/**
 * 双单位尺寸：`120×152px / 240×304rpx`。画板宽度拿不到时**只给 px**（不编一个比例）。
 * @param {number} w @param {number} h @param {number} designWidth
 */
export function dualUnits(w, h, designWidth, opts = {}) {
  const px = `${round2(w)}×${round2(h)}px`;
  if (opts.dualUnits === false) return px;
  const s = unitScale(designWidth, opts.rpxBase);
  if (s === null) return px;
  // ⚠️ 单位只在末尾出现一次：`240×304rpx`，不是 `240rpx×304rpx`（后者是拼接时想当然的产物，实测踩过）
  const n = (v) => String(toTarget(v, 'mini', { designWidth, rpxBase: opts.rpxBase })).replace(/rpx$/, '');
  return `${px} / ${n(w)}×${n(h)}rpx`;
}

/** 单个长度的双单位：`29.9px / 60rpx`。 */
function dual1(px, designWidth, opts = {}) {
  const v = `${round2(px)}px`;
  const s = unitScale(designWidth, opts.rpxBase);
  if (s === null) return v;
  return `${v} / ${toTarget(px, 'mini', { designWidth, rpxBase: opts.rpxBase })}`;
}

/**
 * 标题行的溯源后缀（**§4.7**）：` ｜version=abc12345｜更新于 2026-09-29`。
 *
 * ⚠️ **拿不到就不打**（本项目铁律：不编）。读**旧版**时不能把"最新版的时间"当成这版的时间 ——
 * 那种"看着有、其实指错"的信息比没有更糟。
 */
export function metaSuffix(meta = {}) {
  const parts = [];
  const vid = meta.versionId ?? meta.version;
  if (vid) parts.push(`version=${String(vid).slice(0, 8)}`);
  // ⚠️ 蓝湖给的是 **RFC-2822 原文**（`Thu, 17 Sep 2026 10:00:00 GMT`）——
  //    直接 `slice(0,10)` 会切出 `Thu, 17 Se` 这种残句（实测踩过）。用 parseRfc2822 归一成 ISO 再取日期；
  //    解析不出来就**原样给全**（宁可用长一点，也不给一个看着像日期、其实是半句的东西）。
  const rawAt = meta.latestVersionAt ? String(meta.latestVersionAt).trim() : null;
  const isoAt = rawAt ? parseRfc2822(rawAt) : null;
  const at = isoAt && /^\d{4}-\d{2}-\d{2}/.test(isoAt) ? isoAt.slice(0, 10) : (isoAt || null);
  if (at) {
    if (meta.versionIsLatest === false) parts.push(`最新版更新于 ${at}（你读的是旧版）`);
    else parts.push(`更新于 ${at}`);
  } else if (meta.versionIsLatest === false) {
    parts.push('（旧版，更新时间未取到）');
  }
  return parts.length ? ` ｜${parts.join('｜')}` : '';
}

/**
 * 版本溯源的**结构化**形态（`read_design` 与 `read_blocks` 共用同一份形状）。
 *
 * ⚠️ `id` / `isLatest` / `latestAt` **只从 `meta` 取** —— 标题行的 `metaSuffix(meta)` 读的也是它。
 *    同一条链上一个读 `meta`、一个读 `detail`，就会出现"标题说 A 版、字段说 B 版"，
 *    而两处都不报错（"设计变更 diff"正是靠这个版本号当基准，指错了整份 diff 都是错的）。
 */
export function versionInfo(meta = {}, detail = {}) {
  return {
    id: meta.versionId ?? null,
    requested: detail.versionRequested ?? 'latest',
    isLatest: meta.versionIsLatest ?? null,
    count: detail.versionCount ?? null,
    latestId: detail.versionLatestId ?? null,
    latestAt: meta.latestVersionAt ?? null,
    fromUrl: detail.versionFromUrl ?? false,
    urlVersionIgnored: detail.urlVersionIgnored ?? null,
  };
}

/**
 * 行高 / 字距单元格 —— 与 `font.family` **完全同构**的病：
 * 数据层一直有（`font.lineHeight` / `letterSpacing`），但三张表以前全不打，还原只能靠猜。
 * 形如 `22/0.5`；只有一项时另一项给 `—`；都没有给 `—`（交接清单缺口 3）。
 */
function metricsText(font) {
  const lh = font?.lineHeight ?? null;
  const ls = font?.letterSpacing ?? null;
  if (lh == null && ls == null) return '—';
  return `${lh ?? '—'}/${ls ?? '—'}`;
}

/** tokens 模式：只给色板 / 字号 / 圆角统计。 */
export function renderTokens(tokens, meta = {}) {
  const L = [];
  L.push(`# 设计 Token — ${titleName(meta)}（${meta.width ?? '?'}×${meta.height ?? '?'}）${metaSuffix(meta)}`);
  L.push('');
  L.push(`## 色板（${tokens.colors.length} 个唯一色）`);
  L.push('| 色值 | rgb | 出现次数 |');
  L.push('|---|---|---|');
  for (const c of tokens.colors.slice(0, 40)) L.push(`| \`${c.hex}\`${c.alpha < 1 ? ` (α${Math.round(c.alpha * 100)}%)` : ''} | ${c.rgb} | ${c.count} |`);
  if (tokens.colors.length > 40) L.push(`| … | 其余 ${tokens.colors.length - 40} 个略 | |`);
  L.push('');
  L.push(`## 字号（${tokens.fontSizes.length} 种）`);
  L.push(tokens.fontSizes.map((f) => `${f.size}px×${f.count}`).join('  '));
  L.push('');
  L.push(`## 字重`);
  L.push(tokens.fontWeights.map((f) => `${f.weight}×${f.count}`).join('  ') || '—');
  L.push('');
  L.push(`## 字体`);
  L.push(tokens.fontFamilies.map((f) => `${f.family}×${f.count}`).join('  ') || '—');
  L.push('');
  L.push(`## 圆角`);
  L.push(tokens.radii.map((r) => `${r.radius}px×${r.count}`).join('  ') || '—');
  L.push('');
  L.push(resultFooter(L.join('\n'), {
    what: `本稿 ${tokens.colors.length} 个唯一色 / ${tokens.fontSizes.length} 种字号`,
    next: '要还原到具体某块/某区域，用 `lanhu_read_blocks` 或 `region=...` —— 本表只有统计值，没有位置。',
  }));
  return L.join('\n');
}

/** summary 模式：token + 文本层清单（默认紧凑，控制在 4KB 内）。 */
export function renderSummary({ detail, layers, tokens, meta, maxTextLayers = 36, dualUnits: dualOn = false, filePath = null, sourceNote = null }) {
  const L = [];
  L.push(`# ${detail.name || titleName(meta) || '设计稿'}（${meta.width}×${meta.height}）${metaSuffix(meta)}`);
  L.push(`图层 ${layers.length} 个 | 文本层 ${layers.filter((l) => l.text).length} 个 | 导出图 ${layers.filter((l) => l.hasImage).length} 个`);
  L.push('');
  // 来源格式交代（只在 Sketch 插件格式这条链上给 —— 普通稿不传，输出逐字节不变）
  if (sourceNote) { L.push(sourceNote); L.push(''); }

  L.push('## 色板（Top 12）');
  L.push(tokens.colors.slice(0, 12).map((c) => `\`${c.hex}\`×${c.count}`).join('  '));
  L.push('');

  L.push('## 字号');
  L.push(tokens.fontSizes.map((f) => `${f.size}×${f.count}`).join('  ') || '—');
  L.push('');

  // 关键容器：非文本的布局块（搜索框 / 卡片 / 按钮底…）。
  // 布局还原第一手就是容器 —— 只给文本层不够（实测反馈 P5：形状容器要自己父子相减手算内边距）。
  // 只留**有样式**的（带填充或圆角）：iPhoneX / Notch / Section 这类无样式的结构层是噪音。
  // ⚠️ **但 `hasImage` 必须放行**（§4.1）：切图块（头像这类）**天然没有填充也没有圆角**，
  //    被这条过滤掉之后，AI 只能看到"缺东西"→ 转 `format=full` → 自己写脚本解析（实测就是这么绕的弯路）。
  //    实测：头像 120×152 就是这么被滤掉的，而它恰恰是最容易做错高度的那一块。
  // ⚠️ 排除 `depth === 0`（**画板自己**）：它的 x/y 是**画布绝对坐标**（实测 -12638 这种大负数），
  //    而其它层是画板相对坐标 —— 混在一张表里既会多一行没用的"容器"，更要命的是拿它算间距会得到
  //    `12279px / 24558rpx` 这种**垃圾数字**，而 AI 会照抄（实测踩过）。画板尺寸标题行里已经有了。
  const boxes = layers
    .filter((l) => l.depth !== 0)
    .filter((l) => l.visible && !l.text && l.w >= 40 && l.h >= 18)
    .filter((l) => l.radius !== null || l.colors.some((c) => c.role === COLOR_ROLES.FILL) || l.hasImage)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const maxBoxes = LIMITS.summaryMaxBoxes;
  // 半透明图层预警：漏读 opacity 会把「渐隐的厚度层 / 底纹」做成生硬实心块（实测踩过）。
  const translucent = layers.filter((l) => l.visible && (l.effectiveOpacity ?? l.opacity ?? 1) < 1);
  if (translucent.length > 0) {
    L.push(`> ⚠️ 本稿有 **${translucent.length}** 个图层不透明度 <1，还原时按「不透明」列做，别当实心：${
      translucent.slice(0, 6).map((l) => `\`${String(l.name).slice(0, 16)}\`=${l.effectiveOpacity ?? l.opacity}`).join(' / ')
    }${translucent.length > 6 ? ' …' : ''}`);
    L.push('');
  }
  L.push(`## 关键容器（${boxes.length} 个${boxes.length > maxBoxes ? `，只列前 ${maxBoxes}` : ''}）`);
  L.push('| 名称 | 位置(x,y) | 尺寸 | 圆角 | 填充 | 不透明 | 内边距(左/上/右/下) |');
  L.push('|---|---|---|---|---|---|---|');
  for (const b of boxes.slice(0, maxBoxes)) {
    const bins = b.inset ? `${b.inset.left}/${b.inset.top}/${b.inset.right}/${b.inset.bottom}` : '—';
    const bnm = String(b.name).replace(/\|/g, '\\|').slice(0, 26);
    // 填充列：多段渐变打**全部** stop；描边 role 标出（只有描边的 glow 型图层不该被当底色）。
    // 切图块（hasImage）没有填充 —— 显式标 `切图`：否则一行"填充=— 圆角=—"看着像噪音，
    // 没人知道它为什么会在表里（§4.1 放行 hasImage 之后，这些块会进来）。
    const bfillRaw = fillText(b.colors);
    const bfill = bfillRaw === '—' && b.hasImage ? '切图' : bfillRaw;
    const bopRaw = b.effectiveOpacity ?? b.opacity ?? 1;
    const bop = bopRaw < 1 ? String(bopRaw) : '—';
    L.push(`| ${bnm} | ${b.x},${b.y} | ${dualOn ? dualUnits(b.w, b.h, meta.width) : `${b.w}×${b.h}`} | ${b.radius ? `${b.radius.max}px` : '—'} | ${bfill} | ${bop} | ${bins} |`);
  }
  if (boxes.length > maxBoxes) L.push(`| … | 其余 ${boxes.length - maxBoxes} 个容器略（用 --region 按区域精确取） | | | | |`);
  L.push('');

  const texts = layers
    .filter((l) => l.text && l.visible)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  L.push(`## 文本层（${texts.length} 个${texts.length > maxTextLayers ? `，只列前 ${maxTextLayers}` : ''}）`);
  L.push('| 文本 | 位置(x,y) | 尺寸 | 字号/字重 | 字体 | 行高·字距 | 颜色 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const t of texts.slice(0, maxTextLayers)) {
    const c = t.colors.find((x) => x.role === COLOR_ROLES.TEXT) ?? t.colors[0];
    const txt = String(t.text).replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 40);
    const fam = t.font?.family ? shortFamily(t.font.family) : '—';
    L.push(`| ${txt} | ${t.x},${t.y} | ${dualOn ? dualUnits(t.w, t.h, meta.width) : `${t.w}×${t.h}`} | ${t.font?.size ?? '?'}px/${t.font?.weight ?? '?'} | ${fam} | ${metricsText(t.font)} | ${c ? rgbHex(c) : '—'} |`);
  }
  if (texts.length > maxTextLayers) L.push(`| … | 其余 ${texts.length - maxTextLayers} 个文本层略（用 format=full 取全量） | | | |`);

  // 间距一览（§4.2）：容器与文本层**放在一起**算 —— 跨容器的关系（如「说明块底 ≡ 头像底」）才出得来；
  // 只算同容器内的兄弟块，恰恰漏掉实测里最难手算的那几个（还要跨容器比 y）。
  const digest = renderGapDigest(
    [...boxes.slice(0, maxBoxes), ...texts.slice(0, maxTextLayers)].map((l) => ({
      id: l.path ?? l.name, name: l.name, path: l.path, depth: l.depth, x: l.x, y: l.y, w: l.w, h: l.h,
    })),
    { designWidth: meta.width },
  );
  if (digest) {
    L.push('');
    L.push(digest);
  }

  L.push('');
  L.push(resultFooter(L.join('\n'), {
    what: `本稿 ${layers.length} 层`,
    shown: `本次列了 ${Math.min(boxes.length, maxBoxes)} 个容器 / ${Math.min(texts.length, maxTextLayers)} 个文本层`,
    filePath,
    layered: layers.length,
    next: '还原布局优先用 `lanhu_read_blocks`（一次拿全，比本摘要更适合照抄）；缺哪个区域用 `region=...` 精确取（配 `gapMaxDistance`）。',
  }));
  return L.join('\n');
}

/**
 * 按区域过滤图层并成表 —— 替代实战里每次手写的 python 抠图脚本（实测反馈 P2）。
 * `inset` 由 flattenArtboard 预先算好（子层坐标 − 父层坐标），**直接就是 padding**，不用再手算。
 *
 * @param {Array} layers flattenArtboard 的产物
 * @param {{y0?:number,y1?:number,x0?:number,x1?:number,minWidth?:number,minHeight?:number,limit?:number}} opts
 */
export function renderRegion(layers, opts = {}) {
  const { y0 = -Infinity, y1 = Infinity, x0 = -Infinity, x1 = Infinity, minWidth = 0, minHeight = 0, limit = 80 } = opts;
  const hit = layers
    .filter((l) => l.visible !== false)
    .filter((l) => l.y >= y0 && l.y <= y1 && l.x >= x0 && l.x <= x1 && l.w >= minWidth && l.h >= minHeight)
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  // 坐标映射（可选）：把设计稿坐标换算到**目标坐标系**（自己的 viewBox / 容器）。
  // ⚠️ 必须按两个参照框**各自独立**缩放（x、y 各一个比例），**不要用单一 scale 等比**：
  //    实测设计稿参照框 612×531（比例 1.152）与目标框 447×485（0.921）差 25%，
  //    等比会让纵向整体对不上（反馈原话："本轮一开始就是这么错的"）。
  const mb = opts.mapBox, tb = opts.toBox;
  const mapped = Boolean(mb && tb && (mb.x1 - mb.x0) !== 0 && (mb.y1 - mb.y0) !== 0);
  const sx = mapped ? (tb.x1 - tb.x0) / (mb.x1 - mb.x0) : 1;
  const sy = mapped ? (tb.y1 - tb.y0) / (mb.y1 - mb.y0) : 1;
  const toMx = (v) => round2(tb.x0 + (v - mb.x0) * sx);
  const toMy = (v) => round2(tb.y0 + (v - mb.y0) * sy);

  const L = [];
  L.push(`# 区域图层 y∈[${y0}, ${y1}] x∈[${x0}, ${x1}]（命中 ${hit.length} 层${hit.length > limit ? `，**只列前 ${limit}** —— 传更大的 limit（工具）/ --limit（CLI）可看全量` : ''}）`);
  L.push(`> 内边距 = 该层相对**父容器**的四边距离（已算好）；尺寸列的 rpx 换算：${unitBasisNote(opts.designWidth)}`);
  L.push('> ⚠️ 「不透明」= 图层 opacity（已累乘祖先链），与填充后的 `@xx%`（**填充色** alpha）是两回事，独立叠加，两者都要还原。');
  if (mapped) {
    L.push(`> 📐 坐标已映射：设计稿 [${mb.x0},${mb.y0},${mb.x1},${mb.y1}] → 目标 [${tb.x0},${tb.y0},${tb.x1},${tb.y1}]；`
      + `x/y **各自独立**缩放（sx=${round2(sx)}、sy=${round2(sy)}，**非等比**）。「映射 x,y / 映射 w×h」可直接落进目标坐标系。`);
  }
  L.push('');
  const head = ['名称', '类型', 'x,y', 'w×h'];
  if (mapped) head.push('映射 x,y', '映射 w×h');
  head.push('内边距(左/上/右/下)', '圆角', '填充', '不透明', '字号/字重', '字体', '行高·字距', '文本');
  L.push(`| ${head.join(' | ')} |`);
  L.push(`|${head.map(() => '---').join('|')}|`);
  for (const l of hit.slice(0, limit)) {
    // 填充列：多段渐变打**全部** stop；只有描边的图层（glow / 分割线）标出 role，别让人误当底色
    const fillCell = fillText(l.colors);
    const opRaw = l.effectiveOpacity ?? l.opacity ?? 1;
    const opCell = opRaw < 1 ? String(opRaw) : '—';
    const inset = l.inset ? `${l.inset.left}/${l.inset.top}/${l.inset.right}/${l.inset.bottom}` : '—';
    const cells = [
      `d${l.depth} ${String(l.name).replace(/\|/g, '\\|').slice(0, 22)}`,
      l.type,
      `${l.x},${l.y}`,
      `${dualUnits(l.w, l.h, opts.designWidth)}`,
    ];
    if (mapped) cells.push(`${toMx(l.x)},${toMy(l.y)}`, `${round2(l.w * sx)}×${round2(l.h * sy)}`);
    cells.push(
      inset,
      l.radius ? `${l.radius.max}px` : '—',
      fillCell,
      opCell,
      l.font ? `${l.font.size}/${l.font.weight}` : '—',
      l.font?.family ? shortFamily(l.font.family) : '—',
      metricsText(l.font),
      l.text ? String(l.text).replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 18) : '',
    );
    L.push(cells.join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return { count: hit.length, text: L.join('\n') };
}

/**
 * Sketch 插件格式的稿子**读成功了**时的来源交代（只对这类稿子渲染，普通稿输出逐字节不变）。
 * 说清"哪些数值是从 `info[]` 映射来的"，免得把映射规则当成了蓝湖原始字段。
 */
const SKETCH_SOURCE_NOTE = '> 来源：**蓝湖 Sketch 插件导出**（`type: sketchPlugin`）—— 图层本来平铺在 `info[]` 里、'
  + '没有 `artboard`，这里已按实测映射规则归一化后解析：坐标取画板绝对坐标（`left/top`）、'
  + '`opacity` 从 0..100 换算到 0..1、圆角取 `radius[]`（与 `points[].cornerRadius` 逐值一致）、'
  + '色值来自顶层 `fills`/`borders`、字体族名由 `postScriptName` 去掉字重后缀得到。';

/* ==========================================================================
 * 5c. 「解析不出图层」的**明示**（唯一一份实现）
 *
 * 为什么单独抽出来：本仓库最忌讳的失败模式不是抛错，而是**静默成功** ——
 * 对着 Sketch 插件格式（`type: sketchPlugin`）的稿子，`read_blocks` 以前会输出
 * 「共 **1** 块：画板 1」+ 一张空表：**看着跑成功、其实一个块都没解析出来**，
 * AI 会据此认定"这张稿是空的"，然后什么都不建。
 *
 * 所以凡是"这次真的什么都没读出来"的路径，都必须走这里，并且：
 *   ① 人读文本里**说清三件事**：这是什么格式 / 本次为空**不等于**稿子是空的 / 下一步做什么；
 *   ② 返回对象带**机器可读标志**（`unsupported: true` + `format`），AI 不用解析文本就能判断。
 * ========================================================================== */

/** 明示文本的"下一步"建议 —— 按格式给，**不写做不到的事**。 */
function unsupportedNextSteps(format) {
  if (format === 'sketchPlugin') {
    return [
      '换一张**非** Sketch 插件格式的稿子：同一项目里通常有 Figma 导出的稿（`lanhu_list_designs` 列出来换一张读）——实测某项目 252 张里约一半是 Figma 格式，能正常读。',
      '让设计师把这一页在蓝湖侧用 **Figma 插件**重新导出后上传 —— 那样图层树就是 `artboard` 结构（已完整支持），能立刻分清是"稿子数据不全"还是"格式没覆盖"。',
      '只想拿这张稿的**图**（不要色值/圆角/间距）：用 `lanhu_download_slices` —— 它走的是切图 URL，不依赖图层树。',
    ];
  }
  return [
    '确认这条链接指向的是**设计稿**（`type=image`）：如果是原型/产品文档，改用 `lanhu_read_product_doc`。',
    '换一个版本或稍后重试：该版本可能**还没生成图层数据**（`lanhu_read_design format=summary` 的版本信息能看到有几版）。',
    '如果它应该是一张设计稿却一直读不出来，把 `lanhu_read_design format=full` 的落盘 JSON 提供出来 —— 那说明蓝湖上新出现了第三种树格式，需要补解析。',
  ];
}

/**
 * 渲染「读不出图层」的明示文本。
 * @param {{code:string, format:string, why:string, what:string, rawItemCount?:number|null}} unsupported
 * @param {{name?:string, projectId?:string, imageId?:string, width?:number|null, height?:number|null, account?:string|null}} meta
 */
export function renderDesignUnsupported(unsupported, meta = {}) {
  const L = [];
  const title = titleName(meta);
  L.push(`# ⚠️ 这次**没读到任何图层** — ${title}`);
  L.push('');
  L.push(`**格式：${unsupported.what}。**`);
  L.push('');
  L.push('⚠️ 本次输出是空的 —— 但这**不代表这张稿是空的**。');
  L.push('');
  L.push('## 为什么是空的');
  L.push(unsupported.why);
  if (unsupported.rawItemCount != null) {
    L.push(`该稿图层树里**确实有数据**：\`info[]\` 共 ${unsupported.rawItemCount} 项 —— 问题出在"取不出可用的子层"，不是"这张稿没画东西"。`);
  }
  L.push('以前这种情况会**静默**输出"只有画板本身、没有任何内容块"的空结果 + 一张空表'
    + '（看着跑成功了，其实一个块都没解析出来）；现在改成**明说**。');
  L.push('');
  L.push('## 下一步');
  for (const s of unsupportedNextSteps(unsupported.format)) L.push(`- ${s}`);
  L.push('');
  const bits = [];
  bits.push(`projectId \`${meta.projectId ?? '?'}\``);
  bits.push(`imageId \`${meta.imageId ?? '?'}\``);
  if (meta.width != null || meta.height != null) bits.push(`画板 ${meta.width ?? '?'}×${meta.height ?? '?'}`);
  if (meta.account) bits.push(`账号 ${meta.account}`);
  L.push(`— ${bits.join(' ｜ ')}`);
  L.push(`— 机器可读标志：\`unsupported: true\` ｜ \`format: "${unsupported.format}"\` ｜ \`code: "${unsupported.code}"\``);
  return L.join('\n');
}

/** 「读不出图层」时 readDesign/readBlocks 的**统一返回体**（字段与正常返回对齐，调用方不必分支）。 */
function unsupportedDesignResult(unsupported, { target, detail, acct, format, teamId, nameIsPath = false }) {
  const meta = {
    name: detail?.name ?? null,
    nameIsPath,
    // ⚠️ **不打画板尺寸**：详情接口给的是**缩略图尺寸**（实测 480×270，真实画板 1920×1080）。
    //    读不出图层时我们手里没有可信的画板尺寸 —— 编一个出来就是假数据（本仓库铁律）。
    width: null,
    height: null,
    versionId: detail?.versionId ?? null,
    versionIsLatest: detail?.versionIsLatest ?? null,
    latestVersionAt: detail?.latestVersionAt ?? null,
    projectId: target?.projectId ?? null,
    imageId: target?.imageId ?? null,
    account: acct ?? null,
  };
  const text = renderDesignUnsupported(unsupported, meta);
  return {
    ok: false,
    /** ⭐ 机器可读：这次**什么都没读到** —— 别把 `blockCount: 0` 当成"这张稿是空的"。 */
    unsupported: true,
    format,
    /** 稿子的**来源格式**（不是输出格式）：`sketchPlugin` / `unknown`。 */
    sourceFormat: unsupported.format,
    code: unsupported.code,
    reason: unsupported.why,
    name: meta.name,
    nameIsPath,
    viewport: { width: meta.width, height: meta.height },
    origin: { x: 0, y: 0 },
    device: null,
    layerCount: 0,
    textLayerCount: 0,
    blockCount: 0,
    noiseCount: 0,
    kindCounts: {},
    blocks: [],
    tokens: { colors: [], fontSizes: [], fontWeights: [], fontFamilies: [], radii: [] },
    contrast: { totalTextLayers: 0, checked: 0, failCount: 0, unknownCount: 0, minRatio: null },
    teamId: teamId ?? null,
    projectId: meta.projectId,
    imageId: meta.imageId,
    sourceBytes: 0,
    account: meta.account,
    accountBy: null,
    version: versionInfo(meta, detail ?? {}),
    versionIsLatest: meta.versionIsLatest ?? null,
    latestVersionAt: meta.latestVersionAt ?? null,
    text,
    textBytes: Buffer.byteLength(text, 'utf8'),
  };
}

/* ==========================================================================
 * 6. 主入口：readDesign
 * ========================================================================== */

/**
 * 读一张设计稿。
 * @param {{projectId?: string, imageId?: string, url?: string, format?: 'summary'|'full'|'tokens', cookie?: string, outDir?: string}} args
 */
export async function readDesign(args = {}) {
  const { projectId, imageId, url, format = 'summary', cookie } = args;
  // args.dds：可选开启 DDS schema 增强（见下方 A3 段）
  const target = resolveTarget({ projectId, imageId, url });

  // 没显式指定账号时**自动判定**：别的 AI 只拿到一条链接，不该要求它知道这属于哪个账号。
  const picked = await pickAccount({ ...args, projectId: target.projectId, imageId: target.imageId, teamId: target.teamId });
  const acct = picked.alias;
  const { detail, tree, bytes, sourceFormat, unsupported } = await fetchDesignTree(target.projectId, target.imageId, {
    cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  // ⭐ 「解析不出图层」→ **明说**，绝不返回一个"看着像成功"的空结果（见 renderDesignUnsupported）
  if (unsupported) {
    return unsupportedDesignResult(unsupported, {
      target, detail, acct, format: 'summary', teamId: target.teamId, nameIsPath: Boolean(tree?.meta?.nameIsPath),
    });
  }
  const artboard = tree.artboard ?? tree;
  const layers = flattenArtboard(artboard);
  const tokens = collectTokens(layers);
  /** 来源交代：只有 Sketch 插件格式这条链才给（普通稿为 null → 渲染层一个字都不加，输出逐字节不变）。 */
  const sketchNote = sourceFormat === 'sketchPlugin' ? SKETCH_SOURCE_NOTE : null;
  const meta = {
    name: artboard.name ?? detail.name,
    width: round2(artboard.frame?.width ?? detail.width),
    height: round2(artboard.frame?.height ?? detail.height),
    // 溯源（§4.7）：设计稿会更新，标题行带上版本与更新时间，验收/复现时不必再查一遍。
    // ⚠️ 一律 `?? null` 传原值 —— 有没有由 metaSuffix() 判断，**拿不到就不打**（不编）。
    versionId: detail.versionId ?? null,
    versionIsLatest: detail.versionIsLatest ?? null,
    latestVersionAt: detail.latestVersionAt ?? null,
    device: tree.meta?.device,
    assets: Array.isArray(tree.assets) ? tree.assets.length : 0,
  };

  // full 模式给全量色板（verify 要用它做完整比对）；其它模式截断，免得色表吃掉模型上下文。
  const colorLimit = format === 'full' ? tokens.colors.length : 30;
  const base = {
    name: meta.name,
    // 机器读的输出也要能分辨：它是**路径**还是稿名（人读的标题由 titleName() 加"路径："前缀）
    nameIsPath: Boolean(meta.nameIsPath),
    viewport: { width: meta.width, height: meta.height },
    layerCount: layers.length,
    textLayerCount: layers.filter((l) => l.text).length,
    tokens: {
      colors: tokens.colors.slice(0, colorLimit),
      fontSizes: tokens.fontSizes,
      fontWeights: tokens.fontWeights,
      fontFamilies: tokens.fontFamilies,
      radii: tokens.radii,
    },
    sourceBytes: bytes,
    // 文本层内容清单 —— verify 用它做「按文本自动定位元素」（不用手工加 data-lanhu）
    textList: [...new Set(layers.filter((l) => l.text).map((l) => String(l.text)))].slice(0, 40),
    // 用了哪个账号、怎么定出来的（别的 AI 并不知道链接属于谁，这层透明度必须有）
    account: acct ?? null,
    accountBy: picked.by ?? null,
    // 版本透明度（B1）：不指定 version 时拿到的是 latest，**必须让调用方知道这一点**，
    // 否则"我照着这版做的"会在稿子更新后悄悄失去依据。
    version: {
      id: detail.versionId ?? null,
      requested: detail.versionRequested ?? 'latest',
      isLatest: detail.versionIsLatest ?? null,
      count: detail.versionCount ?? null,
      latestId: detail.versionLatestId ?? null,
      latestAt: detail.latestVersionAt ?? null,
      relocatedFrom: detail.relocatedFrom ?? null,
        fromUrl: detail.versionFromUrl ?? false,
        urlVersionIgnored: detail.urlVersionIgnored ?? null,
    },
    // 稿子的**来源格式**：`'sketchPlugin'` = Sketch 插件导出（图层在 `info[]` 里，已归一化）。
    // ⚠️ **只在非空时加这个键** —— 普通稿（Figma/Sketch 常规稿）的返回体要做到**逐字节不变**，
    //    多一个 `sourceFormat: null` 就破坏了那条硬约束（本仓库有断言钉住普通稿的输出）。
    ...(sourceFormat ? { sourceFormat } : {}),
  };

  // A3 · DDS schema（**可选增强，默认关闭**）。
  // ⚠️ 这是社区实测的非官方通道（另域 + 独立 Cookie + 硬编码 Basic 头），随时可能失效。
  //    所以：默认不碰；开了就如实标注来源；**失败只记原因，绝不影响下面的常规解析**。
  if (args.dds) {
    const d = await ddsSchema(detail.versionId, { cookie, account: acct });
    base.dds = d.ok
      ? { source: 'dds', ok: true, dataResourceUrl: d.dataResourceUrl, schema: d.schema }
      : {
        source: 'dds',
        ok: false,
        stage: d.stage,
        error: d.error,
        note: 'DDS 是社区实测的**非官方**通道（另域 dds.lanhuapp.com + 独立 Cookie），随时可能失效；失败不影响本结果——下面的数据全部来自常规解析。',
      };
  }

  // 区域模式：按 y（或 x0,y0,x1,y1）过滤，直接给可用的图层表（含内边距）
  if (args.region) {
    const nums = String(args.region).split(/[,:\s]+/).map(Number).filter((n) => Number.isFinite(n));
    const ro = nums.length >= 4
      ? { x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3] }
      : nums.length >= 2 ? { y0: nums[0], y1: nums[1] } : {};
    if (args.minWidth !== undefined) ro.minWidth = Number(args.minWidth) || 0;
    // ⚠️ limit 必须接上：711 层的稿子默认只列前 80 层，**剩下一大片静默看不见**，
    //    调用方会以为"就这些"（正是本次反馈「数据有、输出无」的同一类病）。
    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (Number.isFinite(n) && n > 0) ro.limit = n;
    }
    // 坐标映射（可选）：设计稿参照框 → 目标参照框，输出里直接给映射后的坐标。
    // 典型用法：把热点坐标换算到本地自绘 SVG 的 viewBox 坐标系（免掉每次手算"块内百分比"）。
    if (args.mapBox || args.toBox) {
      if (!args.mapBox || !args.toBox) {
        throw new LanhuError('坐标映射要**同时**给 mapBox（设计稿参照框）与 toBox（目标参照框）。');
      }
      const box = (s, label) => {
        const n = String(s).split(/[,:\s]+/).map(Number).filter(Number.isFinite);
        if (n.length < 4) throw new LanhuError(`${label} 需要 4 个数字（x0,y0,x1,y1），收到：${s}`);
        return { x0: n[0], y0: n[1], x1: n[2], y1: n[3] };
      };
      ro.mapBox = box(args.mapBox, 'mapBox');
      ro.toBox = box(args.toBox, 'toBox');
    }
    // region 输出**默认给双单位**（§4.3）：这一屏就是拿去抄 CSS 的，换算别留给调用方。
    // 换算基准由**画板宽度**决定，不写死 ×2（§3.2）—— 见 renderRegion 里的 unitBasisNote。
    const r = renderRegion(layers, { ...ro, designWidth: meta.width });
    // B4 · 几何间距：只在**另一轴有重叠**的元素之间算最近边距（斜对角的距离在还原时没有意义）。
    // 过滤条件与 renderRegion 保持一致（可见 + 落在区域 + 宽度阈值），否则间距会算到区域外的元素上。
    // ⚠️ 默认值必须与 renderRegion **逐字一致**（-Infinity/Infinity）：
    //    只给 `region:'200,600'` 时 ro.x0/x1 是 undefined，写成 `l.x >= ro.x0` 会把**所有**元素滤掉，
    //    于是间距恒为 0 条 —— 不报错、看着像"这里确实没间距"（实测踩过）。
    const rx0 = ro.x0 ?? -Infinity; const rx1 = ro.x1 ?? Infinity;
    const ry0 = ro.y0 ?? -Infinity; const ry1 = ro.y1 ?? Infinity;
    const rminW = ro.minWidth ?? 0;
    const hits = layers
      .filter((l) => l.visible !== false)
      .filter((l) => l.y >= ry0 && l.y <= ry1 && l.x >= rx0 && l.x <= rx1 && l.w >= rminW)
      .map((l) => ({ id: l.id, name: l.name, x: l.x, y: l.y, w: l.w, h: l.h }));
    const gaps = geometricGaps(hits, { maxDistance: args.gapMaxDistance });
    const body = gaps.length ? `${r.text}\n\n${renderGaps(gaps, 60, { designWidth: meta.width })}` : r.text;
    const shownN = ro.limit ?? 80;
    const text = `${body}\n\n${resultFooter(body, {
      what: `命中 ${r.count} 层${r.count > shownN ? `（本次列了前 ${shownN} 层，传更大的 limit 看全量）` : ''}`,
      next: '间距直接用上表，**不用拿坐标手算**；范围再窄一点就收小 `region`，或用 `minWidth` 滤掉碎片。',
    })}`;
    return {
      ...base, format: 'region', regionCount: r.count, gaps, gapCount: gaps.length,
      text, textBytes: Buffer.byteLength(text, 'utf8'),
    };
  }

  // B2 · 字体需求清单（"要装哪些字体、各用多少处、涉及哪些字重"）
  if (format === 'fonts') {
    const fonts = fontRequirements(layers);
    const text = renderFonts(fonts, meta);
    return { ...base, format: 'fonts', fontCount: fonts.length, fonts, text, textBytes: Buffer.byteLength(text, 'utf8') };
  }

  if (format === 'tokens') {
    const text = renderTokens(tokens, meta);
    return { ...base, format: 'tokens', text, textBytes: Buffer.byteLength(text, 'utf8') };
  }

  if (format === 'full') {
    const dir = args.outDir ?? path.join(lanhuHome(), 'designs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safeName = String(meta.name ?? 'design').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60);
    const file = path.join(dir, `${safeName}-${target.imageId}.json`);
    fs.writeFileSync(file, JSON.stringify({
      meta, tokens, layers, assets: tree.assets ?? [], fetchedAt: new Date().toISOString(),
    }, null, 2));
    // full 的正文就是 summary，但**落盘路径一并带上**（§4.6：让 AI 知道"全量在哪、别全文读"）。
    const text = renderSummary({ detail, layers, tokens, meta, dualUnits: Boolean(args.dualUnits), filePath: file, sourceNote: sketchNote });
    return { ...base, format: 'full', filePath: file, fileBytes: fs.statSync(file).size, text, textBytes: Buffer.byteLength(text, 'utf8') };
  }

  const text = renderSummary({ detail, layers, tokens, meta, dualUnits: Boolean(args.dualUnits), sourceNote: sketchNote });
  return { ...base, format: 'summary', text, textBytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 一步到位：给蓝湖链接（或 id）→ 块级清单。
 *
 * 面板的「贴链接就读」与工具 `format=blocks` 共用这一个入口。
 * 与 readDesign 的区别：readDesign 输出的是**图层**（334 条），这里输出的是**块**（161 条），
 * 每块带齐六项属性（圆角/大小/文字色/文字大小/有无底色/边框），是"人一眼能核对"的粒度。
 */
/* ==========================================================================
 * 3g. 生成代码（§4.10）—— `lanhu_gen_code`：把块生成**可直接粘贴**的 CSS / WXSS
 *
 * 与「读稿」的分工：读稿回答"设计稿是什么"（表格，给人核对），
 * 生成代码回答"**我该往文件里写什么**"（代码块，能整段复制）。
 *
 * 三条设计原则（都是实测踩出来的）：
 *
 * ① **双平台共用一套换算**：`web` → px(1:1)，`mini` → `rpx = px × 750 ÷ 画板宽`。
 *    rpx 一律走既有 `toTarget(px,'mini',…)`，**不写第二套**（第二套必然与 verify 漂移）。
 *    画板宽拿不到时**只给 px**，不拿 375 硬算（那正是"基准用错"的典型）。
 *
 * ② **颜色的字符串化只有一个出口**：不透明走 `rgbHex()`、半透明走 `rgbaString()`，
 *    两者都是既有函数（`bgText()` 用的也是它们）。生成器只做"选哪个"的判断，
 *    **绝不自己拼** `#rrggbb` / `rgba(...)` —— 拼出来的第二份实现迟早与读稿输出不一致。
 *    因此本项目输出的半透明色形如 `rgba(87, 74, 244, 0.1)`（**逗号后有空格**），
 *    与蓝湖面板的写法（**逗号后无空格**）不同 —— 两者都是合法 CSS，我们沿用自己那份。
 *
 * ③ **数据里没有的属性就不出**（本项目铁律）：没有 `line-height` 就一个字都不写
 *    （实测：中文族那段文字稿里就是没有，硬补一个行高等于编）；没有背景就**不写**
 *    `background: none`。另一边，"**有数据但值为 0**"要出（全 0 圆角 → `0px 0px 0px 0px`）。
 *
 * 「照抄蓝湖会画错」的三处（我们**有意**不同，见 docs/生成代码.md）：
 *   · **椭圆**（`shape==='ellipse'`）蓝湖给 `border-radius: 0` → 会画成**方形环**；我们给 `50%`。
 *   · **渐变文字**（文字层 + 填充是渐变 + 没有 color）蓝湖只给 `background` → 会画成**色块**；
 *     我们补 `background-clip: text` + `-webkit-text-fill-color: transparent`。
 *   · **渐变描边**只能用 `border-image`（`border: Npx solid <色>` 表达不了渐变）——
 *     本项目给 AI 的提示里"divider 别用 border-image"那条**只对实色分割线成立**，两者分开处理。
 * ========================================================================== */

/**
 * 颜色的**唯一出口**：`{r,g,b,a}` → CSS 颜色串。
 * 不透明 → `rgbHex()`（`#6f67f9`）；半透明 → `rgbaString()`（`rgba(87, 74, 244, 0.1)`）。
 * ⚠️ 不许在这里拼字符串 —— 见本节 ②。
 */
export function cssColor(c) {
  if (!c || typeof c !== 'object') return null;
  const a = typeof c.a === 'number' ? clamp01(c.a) : 1;
  return a >= 1 ? rgbHex(c) : rgbaString({ r: c.r, g: c.g, b: c.b, a });
}

/** hex + 单独给的 alpha → CSS 颜色串（块模型里的 `bg` / `color` / `border` 都是这种形状）。 */
function cssColorOfHex(hex, alpha) {
  if (!hex) return null;
  const c = parseColor(hex);
  if (!c) return null;
  return cssColor({ ...c, a: typeof alpha === 'number' ? alpha : c.a });
}

/** 渐变 stop 位置：`0.2966` → `29.66%`（小数百分比要保留，实测⑧就是 `29.66%`）。 */
function cssPercent(p) {
  return `${round2((Number(p) || 0) * 100)}%`;
}

/** 渐变 → `linear-gradient(<角>deg, <色> <位置>%, …)`。角度拿不到时**不打角度**（合法写法）。 */
export function cssGradient(g, to) {
  const stops = (g?.stops ?? []).map((s) => `${cssColor(s.color)} ${cssPercent(s.position)}`).join(', ');
  if (!stops) return null;
  return g.angle === null || g.angle === undefined
    ? `linear-gradient(${stops})`
    : `linear-gradient(${g.angle}deg, ${stops})`;
}

/**
 * 一层阴影 → `[inset] <x> <y> <blur> <spread> <色>`。
 * `opts.text`（text-shadow）时**不出 inset 也不出 spread** —— `text-shadow` 语法里没有这两项。
 */
export function cssShadow(sh, to, opts = {}) {
  const p = [];
  if (sh.inset && !opts.text) p.push('inset');
  p.push(to(sh.x), to(sh.y), to(sh.blur));
  if (!opts.text) p.push(to(sh.spread));
  p.push(cssColor(sh.color));
  return p.join(' ');
}

/**
 * 圆角 —— **一律四值**（本项目决策：一致性 > 模仿蓝湖的"相等就写单值"）。
 * 全 0 **也要四值**（`0px 0px 0px 0px`），但"压根没有圆角数据"时**一个字都不出**。
 *
 * ⚠️ **椭圆例外**：`shape==='ellipse'` 的图层蓝湖给 `border-radius: 0`，
 *    照抄会画成方形。圆的形状来自矢量路径，CSS 里要用 `50%` 表达（见文档「已知差异」）。
 */
export function cssRadius(block, layer, to) {
  if (block?.shape === 'ellipse') return '50% 50% 50% 50%';
  if (block?.radius) return block.radius.corners.map((v) => to(v)).join(' ');
  // ⚠️ **文字层不出"全 0 四值"**：文字没有圆角概念。实测④那份稿里 Rectangle / Ellipse
  //    都有 `radius: {0,0,0,0}`，蓝湖给矩形和椭圆出了 `0px 0px 0px 0px`、给文字层**没出** ——
  //    我们跟它一致（对文字层出这行只是噪音，还会让人以为"这里有个 0 圆角的盒子"）。
  const isText = typeof block?.text === 'string' && block.text !== '';
  if (layer?.hasRadius && !isText) return [0, 0, 0, 0].map((v) => to(v)).join(' ');
  return null;
}

/**
 * 边框 —— 实色与**渐变**分开走：
 *   · 实色 → `border: Npx solid <色>`（单边分割线 → `border-top: 1px solid <色>`）
 *   · 渐变 → `border: Npx solid;` + `border-image: linear-gradient(…) 1 1;`
 *     （CSS 里表达渐变描边**只有** border-image 这条路，`border` 的颜色不能是渐变）
 * 蓝湖一模一样：⑦ 就是 `border: 1px solid;` 紧跟 `border-image: … 1 1`。
 */
export function cssBorder(block, layer, to) {
  const out = [];
  const bg = layer?.borderGradient;
  if (bg && Array.isArray(bg.stops) && bg.stops.length) {
    out.push(`border: ${to(bg.width)} solid;`);
    out.push(`border-image: ${cssGradient(bg, to)} 1 1;`);
    return out;
  }
  const bd = block?.border;
  if (!bd) return out;
  const w = to(bd.width);
  const c = bd.colorKnown ? cssColorOfHex(bd.color, bd.alpha) : null;
  const spec = `${w} solid${c ? ` ${c}` : ''}`;
  if (bd.single) out.push(`border-${bd.single}: ${spec};`);
  else out.push(`border: ${spec};`);
  return out;
}

/**
 * 字体族写法：**只在含非标识符字符时加引号**。
 *   `Source Han Sans CN`   → 原样（一串标识符在 CSS 里就是一个族名，合法）
 *   `Alibaba PuHuiTi 2.0`  → `"Alibaba PuHuiTi 2.0"`（含 `.`，不加引号不合法）
 * ⚠️ 蓝湖在这里**没加引号**，于是它把 `2.0` 处理成了 `20`（实测⑪的 web 输出
 *    `Alibaba PuHuiTi 2.0, Alibaba PuHuiTi 20` 两条都不是原样）—— 这条算我们更对。
 */
export function cssFontFamily(family) {
  const f = String(family ?? '').trim();
  if (!f) return null;
  const parts = f.split(/\s+/).filter(Boolean);
  const safe = parts.length > 0 && parts.every((p) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(p));
  return safe ? f : `"${f.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 块名 → 合法且可读的 CSS 类名。
 * 中文**保留**（CSS 允许非 ASCII 标识符，保留中文比硬转拼音可读得多）；
 * 重名追加 `-2` / `-3`；以数字开头的补 `b-` 前缀（CSS 里不能以数字开头）。
 */
export function cssClassName(name, kind, used = new Map()) {
  let base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fa5_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = String(kind ?? 'block');
  if (!/^[a-z_\u4e00-\u9fa5]/.test(base)) base = `b-${base}`;
  const n = (used.get(base) ?? 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

const htmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 一块 → CSS 属性行（不含 class 包裹）。
 * 顺序刻意贴近蓝湖面板：尺寸 → 背景 → opacity → 阴影 → 圆角 → 边框 → 模糊 → 文字。
 */
export function blockCssLines(block, layer, opts = {}) {
  const target = opts.target ?? 'web';
  const to = (v) => toTarget(v, target, { designWidth: opts.designWidth, rpxBase: opts.rpxBase });
  const L = [];
  const isText = typeof block.text === 'string' && block.text !== '';
  const g = layer?.fillGradient ?? null;
  // ⭐ 渐变文字判据（用户拍的板，实测⑬）：**文字层 + 填充是渐变 + 没有 color** ⇒ 渐变文字。
  const gradientText = isText && Boolean(g) && !block.color;
  const shadows = layer?.shadows ?? [];

  L.push(`width: ${to(block.w)};`);
  L.push(`height: ${to(block.h)};`);

  if (g) {
    const css = cssGradient(g, to);
    if (css) L.push(`background: ${css};`);
  } else if (block.bg) {
    const c = cssColorOfHex(block.bg.hex, block.bg.alpha);
    if (c) L.push(`background: ${c};`);
  }

  // 图层不透明度（**与填充色的 alpha 是两回事**，两个都要还原）
  if (typeof block.opacity === 'number' && block.opacity < 1) L.push(`opacity: ${round2(block.opacity)};`);

  // 非文字层：阴影 → box-shadow（文字层的阴影是 text-shadow，放在文字属性之后）
  if (!isText && shadows.length) L.push(`box-shadow: ${shadows.map((s) => cssShadow(s, to)).join(', ')};`);

  const radius = cssRadius(block, layer, to);
  if (radius) L.push(`border-radius: ${radius};`);

  for (const line of cssBorder(block, layer, to)) L.push(line);

  for (const bl of layer?.blurs ?? []) {
    L.push(bl.type === 'Background'
      ? `backdrop-filter: blur(${to(bl.radius)});`
      : `filter: blur(${to(bl.radius)});`);
  }

  // 旋转（§4.10 ⑮）：蓝湖的**代码**面板不给这一项，但**标注**面板里有（`旋转 180°`）——
  // 属于"数据里有、蓝湖输出里没有"的一条。角度**照抄数据真值**（不因为"180° 看着一样"就省掉）。
  // ⚠️ 蓝湖/Figma 的 `rotation` 方向与 CSS `rotate()` 的正方向是否同号**尚未与标注面板核对过**
  //    （现有样本只有 180°，无方向性）—— 见 docs/生成代码.md 的「未验证」一节。
  if (typeof layer?.rotation === 'number' && layer.rotation !== 0) {
    L.push(`transform: rotate(${round2(layer.rotation)}deg);`);
  }

  if (isText) {
    if (block.font) {
      const fam = cssFontFamily(block.font.family);
      if (fam) L.push(`font-family: ${fam};`);
      if (block.font.weight !== null && block.font.weight !== undefined) L.push(`font-weight: ${block.font.weight};`);
      if (block.font.size !== null && block.font.size !== undefined) L.push(`font-size: ${to(block.font.size)};`);
      if (block.color) {
        const c = cssColorOfHex(block.color, block.colorAlpha);
        if (c) L.push(`color: ${c};`);
      }
      // ⚠️ line-height **只在稿里有值时**才出（实测⑤那段中文族文字就没有，补一个等于编）
      if (block.font.lineHeight !== null && block.font.lineHeight !== undefined) L.push(`line-height: ${to(block.font.lineHeight)};`);
      if (block.font.align) L.push(`text-align: ${String(block.font.align).toLowerCase()};`);
      L.push('font-style: normal;');
      L.push('text-transform: none;');
      if (block.font.letterSpacing) L.push(`letter-spacing: ${to(block.font.letterSpacing)};`);
      if (shadows.length) L.push(`text-shadow: ${shadows.map((s) => cssShadow(s, to, { text: true })).join(', ')};`);
    }
    if (gradientText) {
      // 渐变文字三件套 + color 兜底：只给 background 会渲染成"文字背后的色块"（实测⑬）
      L.push('-webkit-background-clip: text;');
      L.push('background-clip: text;');
      L.push('-webkit-text-fill-color: transparent;');
      L.push('color: transparent;');
    }
  }
  return L;
}

/**
 * 富文本 runs → `<span>` 分段（§4.10 ⑪）。
 *
 * 稿里 `text.styles[]` 是**多 run**的（实测青圭稿 4 段：默认段 / `表号` 换灰 / 空格 / `MTR-001` 粗+青），
 * 蓝湖自己的 web 输出也会**压扁**成单一样式 —— 我们比它多给一步：
 * 主样式照常写进块规则，**与主样式不同的 run** 各给一条 `.cls .rN` 差异规则，
 * 并附一行 HTML 蓝图说明哪段用哪个 class。**不改块模型**（runs 只存在于 `rich` 模式的图层上）。
 */
export function textRunsCss(block, layer, className, opts = {}) {
  const runs = layer?.textRuns;
  if (!Array.isArray(runs) || runs.length < 2) return null;
  const designWidth = opts.designWidth;
  const target = opts.target ?? 'web';
  const to = (v) => toTarget(v, target, { designWidth, rpxBase: opts.rpxBase });
  const main = block.font ?? {};
  const mainColor = cssColorOfHex(block.color, block.colorAlpha);
  const html = [];
  const rules = [];
  let n = 0;
  for (const r of runs) {
    const diff = [];
    const f = r.font ?? {};
    if (f.family && f.family !== main.family) {
      const fam = cssFontFamily(f.family);
      if (fam) diff.push(`font-family: ${fam};`);
    }
    if (f.size !== null && f.size !== undefined && f.size !== main.size) diff.push(`font-size: ${to(f.size)};`);
    if (f.weight !== null && f.weight !== undefined && f.weight !== main.weight) diff.push(`font-weight: ${f.weight};`);
    const c = cssColor(r.color?.color);
    if (c && c !== mainColor) diff.push(`color: ${c};`);
    if (f.letterSpacing && f.letterSpacing !== main.letterSpacing) diff.push(`letter-spacing: ${to(f.letterSpacing)};`);
    if (diff.length === 0) {
      html.push(htmlEscape(r.content));
      continue;
    }
    n += 1;
    html.push(`<span class="r${n}">${htmlEscape(r.content)}</span>`);
    rules.push(`.${className} .r${n} { ${diff.join(' ')} }`);
  }
  return { html: html.join(''), rules, runCount: runs.length };
}

/** 块 → 结构化生成项（web / mini 两套属性行 + 富文本）。 */
export function buildCodeItems(blocks, layers, meta, opts = {}) {
  const target = opts.target ?? 'both';
  const canMini = unitScale(meta?.width, opts.rpxBase) !== null;
  const used = new Map();
  const items = [];
  for (const b of blocks) {
    const layer = Number.isInteger(b.layerIndex) ? layers[b.layerIndex] : null;
    const className = cssClassName(b.name, b.kind, used);
    const web = (target === 'web' || target === 'both')
      ? blockCssLines(b, layer, { ...opts, target: 'web', designWidth: meta.width })
      : null;
    const mini = (target === 'mini' || target === 'both') && canMini
      ? blockCssLines(b, layer, { ...opts, target: 'mini', designWidth: meta.width })
      : null;
    if (mini === null && target === 'mini' && !canMini) {
      // 画板宽未知 → **不硬算 rpx**（拿 375 兜底会给出错的基准）
    }
    const runsOfTarget = (t) => textRunsCss(b, layer, className, { ...opts, target: t, designWidth: meta.width });
    items.push({
      index: items.length + 1,
      name: b.name ?? null,
      kind: b.kind,
      label: blockLabel(b),
      className,
      x: b.x, y: b.y, w: b.w, h: b.h,
      web,
      mini,
      runs: (web || mini) ? (runsOfTarget(target === 'mini' ? 'mini' : 'web')) : null,
    });
  }
  return { items, canMini };
}

/** 结构化生成项 → **可直接整段复制**的文本（工具/CLI 的人读出口）。 */
export function renderGenCode(items, meta, opts = {}) {
  const target = opts.target ?? 'both';
  const canMini = opts.canMini !== false;
  const width = meta?.width;
  const L = [];
  const head = target === 'mini' ? 'WXSS' : (target === 'both' ? 'CSS + WXSS' : 'CSS');
  L.push(`/* ${head} —— ${titleName(meta)}（${round2(width)}×${round2(meta?.height)}）${metaSuffix(meta)} */`);
  L.push(`/* 共 ${items.length} 块 ｜ ${unitBasisNote(width)} */`);
  L.push('/* 与蓝湖「代码」面板的已知写法差异见 docs/生成代码.md（圆角统一四值 · rgba 逗号后带空格 · 颜色小写 · 椭圆 50% · 渐变文字补三件套） */');

  const section = (title, key) => {
    const list = items.filter((it) => Array.isArray(it[key]));
    if (list.length === 0) return;
    L.push('');
    L.push(`/* ═══════════ ${title} ═══════════ */`);
    for (const it of list) {
      L.push('');
      L.push(`/* ${String(it.index).padStart(2, ' ')}. ${it.label} · ${round2(it.w)}×${round2(it.h)} · ${BLOCK_KINDS[it.kind] ?? it.kind} */`);
      L.push(`.${it.className} {`);
      for (const line of it[key]) L.push(`  ${line}`);
      L.push('}');
      if (it.runs && it.runs.rules.length) {
        L.push(`/* 富文本：该层有 ${it.runs.runCount} 段样式（蓝湖的 web 输出会压扁成一段，我们给分段） */`);
        L.push(`/*   ${it.runs.html} */`);
        for (const r of it.runs.rules) L.push(r);
      } else if (it.runs) {
        L.push(`/* 富文本：该层有 ${it.runs.runCount} 段样式，各段与主样式一致，无需分段 */`);
      }
    }
  };

  if (target === 'both' || target === 'web') {
    section('Web（px，1:1）', 'web');
  }
  if (target === 'mini' || target === 'both') {
    if (canMini) section(`小程序（rpx）— ${unitBasisNote(width)}`, 'mini');
    else L.push('/* ⚠️ 画板宽度未知 → 只给 px（无法换算 rpx，不拿 375 硬算） */');
  }
  L.push('');
  return L.join('\n');
}

/**
 * 工具入口：给一张稿（或指定块）→ 可直接粘贴的 CSS / WXSS。
 * **只读**：只调既有的读稿接口（GET），从不写任何东西。
 */
export async function genCode(args = {}) {
  const target = ['web', 'mini', 'both'].includes(args.target) ? args.target : 'both';
  const opened = await openDesign(args);
  const { detail, tree, sourceFormat, unsupported, picked, acct, teamId, target: tgt } = opened;
  if (unsupported) {
    return unsupportedDesignResult(unsupported, { target: tgt, detail, acct, format: 'code', teamId, nameIsPath: false });
  }
  const artboard = tree.artboard ?? tree;
  // ⭐ 只有这里传 `rich: true` —— 既有链路（read_blocks / read_design / 面板）不传，输出逐字节不变。
  const layers = flattenArtboard(artboard, { rich: true });
  let blocks = buildBlocks(layers);

  // 过滤口径与 `read_blocks` **完全一致**（region / kind / minWidth 三项，同一顺序）
  if (args.region) {
    const nums = String(args.region).split(/[,:\s]+/).map(Number).filter((n) => Number.isFinite(n));
    const ro = nums.length >= 4
      ? { x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3] }
      : nums.length >= 2 ? { y0: nums[0], y1: nums[1] } : {};
    blocks = blocks.filter((b) => {
      if (ro.y0 !== undefined && (b.y < ro.y0 || b.y > ro.y1)) return false;
      if (ro.x0 !== undefined && (b.x < ro.x0 || b.x > ro.x1)) return false;
      return true;
    });
  }
  if (args.minWidth !== undefined) blocks = blocks.filter((b) => b.w >= (Number(args.minWidth) || 0));
  if (args.kind) {
    const kinds = String(args.kind).split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    blocks = blocks.filter((b) => kinds.includes(b.kind));
  }
  const totalBlocks = blocks.length;
  const visible = visibleBlocks(blocks, { includeNoise: args.includeNoise });
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Number(args.limit) : LIMITS.codeMaxBlocks;
  const shown = visible.slice(0, limit);

  const meta = designMetaOf(artboard, detail, tree);
  const { items, canMini } = buildCodeItems(shown, layers, meta, { target, rpxBase: args.rpxBase });
  const text = renderGenCode(items, meta, { target, canMini });

  const kindCounts = {};
  for (const b of shown) kindCounts[b.kind] = (kindCounts[b.kind] ?? 0) + 1;

  return {
    ok: true,
    format: 'code',
    name: meta.name,
    viewport: { width: meta.width, height: meta.height },
    target,
    /** rpx 基准能不能算 —— 画板宽度未知时为 false（那时只出 px，**不拿 375 硬算**）。 */
    miniAvailable: canMini,
    unitBasis: unitBasisNote(meta.width),
    blockCount: items.length,
    totalBlocks,
    truncated: visible.length > shown.length,
    noiseCount: blocks.filter((b) => b.noise).length,
    kindCounts,
    codeClassNames: items.map((it) => it.className),
    codes: items.map((it) => ({
      index: it.index,
      name: it.name,
      kind: it.kind,
      className: it.className,
      selector: `.${it.className}`,
      web: it.web,
      mini: it.mini,
    })),
    layerCount: layers.length,
    teamId,
    projectId: tgt?.projectId ?? null,
    imageId: tgt?.imageId ?? null,
    account: acct ?? null,
    accountBy: picked.by ?? null,
    version: versionInfo(meta, detail),
    versionIsLatest: meta.versionIsLatest ?? null,
    latestVersionAt: meta.latestVersionAt ?? null,
    ...(sourceFormat ? { sourceFormat } : {}),
    text,
  };
}

/**
 * 打开一张稿的**公共上半段**（`readBlocks` / `readDesign` 之外的第三个调用方：`genCode`）。
 *
 * 抽出来的理由：这一段有 4 件容易写歪的事 —— 目标解析、**多账号自动判定**、
 * 版本读取（`version` / `urlVersionId`）、`unsupported` 透传。三个入口各抄一遍，
 * 迟早出现"read_blocks 能读、gen_code 说读不到"这种漂移。
 *
 * ⚠️ 抽的时候**逐字保留**原 `readBlocks` 开头的行为（连注释里的取舍都保留）——
 *    它是"既有输出逐字节不变"这条硬约束覆盖的路径。
 */
export async function openDesign(args = {}) {
  const target = resolveTarget({ projectId: args.projectId, imageId: args.imageId, url: args.url });
  let teamId = null;
  if (args.url) {
    try { teamId = parseLanhuUrl(args.url).teamId; } catch { /* 解析失败不影响读稿 */ }
  }

  // 同 readDesign：没指定账号就按链接自动判定
  const picked = await pickAccount({ ...args, projectId: target.projectId, imageId: target.imageId, teamId: target.teamId });
  const acct = picked.alias;
  const fetched = await fetchDesignTree(target.projectId, target.imageId, {
    cookie: args.cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  return { target, teamId, picked, acct, ...fetched };
}

/** 画板元信息（`readBlocks` 与 `genCode` 共用同一份组装 —— 两处各写一遍必然漂移）。 */
export function designMetaOf(artboard, detail, tree) {
  return {
    name: artboard.name ?? detail.name,
    width: round2(artboard.frame?.width ?? detail.width),
    height: round2(artboard.frame?.height ?? detail.height),
    // 溯源（§4.7）：与 readDesign 同口径 —— 拿不到就不打（由 metaSuffix 判断）
    versionId: detail.versionId ?? null,
    versionIsLatest: detail.versionIsLatest ?? null,
    latestVersionAt: detail.latestVersionAt ?? null,
    // 画板原点：块坐标是"相对画板"的，比对层换算坐标必须减掉它
    // （实测画板 left 是 -10279 这种大负数，直接用块的绝对坐标会和页面完全错位）
    origin: {
      x: round2(artboard.frame?.left ?? artboard.realFrame?.left ?? 0),
      y: round2(artboard.frame?.top ?? artboard.realFrame?.top ?? 0),
    },
    device: tree.meta?.device,
    assets: Array.isArray(tree.assets) ? tree.assets.length : 0,
  };
}

export async function readBlocks(args = {}) {
  const { target, teamId, picked, acct, detail, tree, bytes, sourceFormat, unsupported } = await openDesign(args);
  // ⭐ 「解析不出图层」→ **明说**。这一条就是本次要修的缺陷：
  //    以前这里会一路走到底、输出「共 1 块：画板 1」+ 空表 —— 看着跑成功、其实什么都没解析出来。
  if (unsupported) {
    return unsupportedDesignResult(unsupported, {
      target, detail, acct, format: 'blocks', teamId, nameIsPath: false,
    });
  }
  const artboard = tree.artboard ?? tree;
  const layers = flattenArtboard(artboard);
  let blocks = buildBlocks(layers);
  // ⚠️ **全稿**块（region/kind/minWidth 过滤**之前**的那一份）—— 评论落点用它匹配：
  //    评论是**整张稿**的标注，不该因为"你这次只看某个 region"就变成"未落在任何块上"。
  const fullBlocks = blocks;

  if (args.region) {
    const nums = String(args.region).split(/[,:\s]+/).map(Number).filter((n) => Number.isFinite(n));
    const ro = nums.length >= 4
      ? { x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3] }
      : nums.length >= 2 ? { y0: nums[0], y1: nums[1] } : {};
    blocks = blocks.filter((b) => {
      if (ro.y0 !== undefined && (b.y < ro.y0 || b.y > ro.y1)) return false;
      if (ro.x0 !== undefined && (b.x < ro.x0 || b.x > ro.x1)) return false;
      return true;
    });
  }
  if (args.minWidth !== undefined) blocks = blocks.filter((b) => b.w >= (Number(args.minWidth) || 0));
  if (args.kind) {
    const kinds = String(args.kind).split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    blocks = blocks.filter((b) => kinds.includes(b.kind));
  }

  const meta = designMetaOf(artboard, detail, tree);
  const kindCounts = {};
  for (const b of blocks) kindCounts[b.kind] = (kindCounts[b.kind] ?? 0) + 1;
  // 无障碍对比度审计（§4.8）：与表格**同一套可见集**（noise 折叠口径一致），
  // 且与渲染进 `text` 的那段是**同一次计算** —— 这样"人读到的"和"机器读到的"不会各算一遍。
  const contrastAudit = auditTextContrast(visibleBlocks(blocks, { includeNoise: args.includeNoise }), layers);
  // 评论 / 标注（§4.9）：**独立接口**（不在图层树里）→ 这是 **+1~N 次网络请求**。
  //   · 默认**开**（人就写在评论里，读稿时不带回来等于没这个能力）；
  //   · `comments:false` 跳过（不需要时别多花请求）；
  //   · ⚠️ **失败绝不连累 read_blocks**：catch 住 → 降级成"评论读取失败"那段 + 机器可读的 `commentsError`。
  //     为什么是"明说"而不是"静默跳过"：静默会让 AI 把"没读到"当成"设计师没留言"，
  //     那正是本项目最忌讳的失败模式（"拿不准就明说"）。
  let commentsResult = null;
  let commentsError = null;
  if (args.comments !== false) {
    try {
      const fetched = await fetchComments(target.projectId, target.imageId, {
        cookie: args.cookie, account: acct, pageSize: args.commentPageSize, retries: args.commentRetries,
      });
      commentsResult = {
        total: fetched.total,
        unread: fetched.unread,
        fetched: fetched.fetched,
        pages: fetched.pages,
        truncated: fetched.truncated,
        items: mapCommentsToBlocks(fetched.items, fullBlocks, meta, { includeNoise: args.includeNoise, layers }),
      };
    } catch (e) {
      commentsError = String(e?.message ?? e);
      commentsResult = { error: commentsError, items: [] };
    }
  }
  let text = renderBlocks(blocks, meta, {
    limit: args.limit, includeNoise: args.includeNoise, dualUnits: Boolean(args.dualUnits), contrast: contrastAudit,
    sourceNote: sourceFormat === 'sketchPlugin' ? SKETCH_SOURCE_NOTE : null,
    // 无评论 / 读取失败时 `commentNoteText` 给 null → 标题行**逐字节不变**
    commentNote: commentNoteText(commentsResult),
    comments: commentsResult,
  });
  if (acct) {
    text += `\n\n— 账号：**${acct}**${picked.by === 'explicit' ? '（显式指定）' : `（自动判定 · ${picked.by}）`}`;
  }

  return {
    ok: true,
    format: 'blocks',
    name: meta.name,
    // 机器读的输出也要能分辨：它是**路径**还是稿名（人读的标题由 titleName() 加"路径："前缀）
    nameIsPath: Boolean(meta.nameIsPath),
    viewport: { width: meta.width, height: meta.height },
    origin: meta.origin,
    device: meta.device,
    layerCount: layers.length,
    blockCount: blocks.length,
    noiseCount: blocks.filter((b) => b.noise).length,
    kindCounts,
    blocks,
    // 无障碍对比度审计（§4.8）：与渲染进 `text` 的那段**同一次计算**，
    // 这样"人读到的"和"机器读到的"不会各算一遍（本仓库最容易漂移的就是这类两处实现）。
    contrast: {
      totalTextLayers: contrastAudit.total,
      checked: contrastAudit.checked,
      failCount: contrastAudit.fail.length,
      unknownCount: contrastAudit.unknown.length,
      minRatio: contrastAudit.minRatio === null ? null : round2(contrastAudit.minRatio),
    },
    teamId,
    projectId: target.projectId,
    imageId: target.imageId,
    sourceBytes: bytes,
    // 用了哪个账号、怎么定出来的（别的 AI 需要这层透明度：它并不知道链接属于谁）
    account: acct ?? null,
    accountBy: picked.by ?? null,
    // 版本溯源（§4.7 / B1）：字段名与语义**与 `read_design` 的 `version` 完全对齐** ——
    // 「设计变更 diff」要拿这一版号当基准，两个入口必须给同一个答案。
    // 构造交给 `versionInfo`（与标题行共用同一份 `meta`，不会各算一遍而不一致，有断言钉住）。
    version: versionInfo(meta, detail),
    // 顺手给平铺字段：调用方不用先判断 `version` 在不在（拿不到就是 null，不编）
    versionIsLatest: meta.versionIsLatest ?? null,
    latestVersionAt: meta.latestVersionAt ?? null,
    // 稿子的**来源格式**：`'sketchPlugin'` = Sketch 插件导出（图层在 `info[]` 里，已归一化后走同一条链）。
    // ⚠️ 同上：**只在非空时加键**，普通稿返回体逐字节不变。
    ...(sourceFormat ? { sourceFormat } : {}),
    // 评论 / 标注（§4.9，人类留的需求）。**只在真有评论时加键**：
    //   · 没有评论 → 不加（"无评论的稿返回体逐字节不变"这条硬约束）；
    //   · `comments:false` 跳过 → 不加（调用方自己知道没请求）；
    //   · 读取失败 → 加的是 `commentsError`（**明说**，别让调用方把"读不到"当成"没有评论"）。
    ...(commentsResult && !commentsResult.error && (commentsResult.items ?? []).length > 0
      ? {
        comments: {
          total: commentsResult.total ?? commentsResult.items.length,
          unread: commentsResult.unread ?? 0,
          fetched: commentsResult.fetched ?? commentsResult.items.length,
          pages: commentsResult.pages ?? 1,
          truncated: Boolean(commentsResult.truncated),
          // 归一化坐标是**原样**留着的（别在返回里改成 px —— 那正是坐标系混掉的开始）：
          // `position` = 接口给的 0~1，`point` = 换算后的稿上坐标，`anchor` = 匹配到的块。
          items: commentsResult.items.map((c) => ({
            id: c.id,
            content: c.content,
            user: c.user,
            version: c.version,
            unread: c.unread,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            position: c.position,
            point: c.point,
            // 平铺一个 `blockLabel`（最常用的那个字段不该要调用方先下钻 anchor）
            blockLabel: c.anchor?.block?.label ?? null,
            anchor: c.anchor,
            replies: c.replies,
          })),
        },
      }
      : {}),
    ...(commentsError ? { commentsError } : {}),
    text,
    textBytes: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * 解析「要读哪张稿」—— **胶水层**：显式 id 优先，否则解析 url。
 *
 * ⚠️ 这里踩过一个坑：蓝湖详情页是 **hash 路由**，参数在 `#` 之后的 query 里
 *    （`…#/item/project/detailDetach?tid=…&pid=…&image_id=…`），
 *    `new URL(url).searchParams` **读不到**，于是退化成"按出现顺序抠 uuid"——
 *    而链接里有 4 个 uuid（tid/pid/project_id/image_id），顺序一错就把 projectId 当成了 imageId，
 *    报错还是"该稿没有 json_url"，极难排查。统一走 parseLanhuUrl 才是稳的。
 */
export function resolveTarget({ projectId, imageId, url }) {
  if (projectId && imageId) return { projectId, imageId };
  if (url) {
    try {
      const p = parseLanhuUrl(url);
      // ⚠️ 必须把 versionId 带出来 —— 它是「你浏览器里看的是哪一版」的唯一线索。
      //    之前在这里被吞掉，导致 URL 里的版本号完全失效（读的永远是 latest）。
      return {
        projectId: projectId ?? p.projectId, imageId: imageId ?? p.imageId,
        teamId: p.teamId, versionId: p.versionId ?? null,
      };
    } catch (e) {
      // 退一步：老形态链接直接从整串里按序抠 uuid
      const pid = projectId ?? uuidFrom(url, 0);
      const iid = imageId ?? uuidFrom(url, 1);
      if (pid && iid) return { projectId: pid, imageId: iid };
      throw e;
    }
  }
  throw new LanhuError('需要 projectId + imageId，或一个蓝湖链接 url。');
}

function uuidFrom(s, skip = 0) {
  const all = String(s).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return all[skip] ?? null;
}

/* ==========================================================================
 * 6.5 设计变更 diff —— 同一张稿的两个版本，回答「这次设计改了什么」
 *
 * 为什么值钱：设计一改，已经写好的页面就过期了，而**蓝湖自己不提供版本对比** ——
 * "改了哪"以前只能人肉重读两版再肉眼对。这里把它变成一次调用。
 *
 * 三件事必须做对，缺一个这个工具就**比没有更糟**（AI 会照着错的结论去改代码）：
 *   ① **配对要可解释**：优先按**稳定身份**（层的 `path`）配对；身份对不上才退到
 *      「类型 + 文本 + 几何」的近似配对；剩下的老实报"新增/删除"。
 *   ② **可靠度必须报出来**：精确 / 近似 / 无法匹配各多少。大面积对不上时**明说
 *      「两版差异过大，逐块对比不可靠」并拒绝出明细表** —— 硬凑一张看起来精确的差异表
 *      比不给更糟。
 *   ③ **零变化要说"两版一致"**：静默空输出会让人以为工具坏了；而"设计没改、你的代码
 *      可以不动"本身就是最有用的答案。
 *
 * ⚠️ 画板块（`kind=artboard`）的 x/y 是**画布绝对坐标**（见 `KIND_DESC`）：稿子在 Figma
 *    画布上被挪一格它就会变（实测 `-9876,463 → -9879,487`），**那不是设计变更**。
 *    所以它不参与布局比较，只在输出末尾用一行"注"如实交代 —— 不静默吞掉。
 * ========================================================================== */

/** 变化分类（**只列有变化的**；数组顺序就是渲染顺序）。 */
export const DIFF_CATEGORIES = Object.freeze(['size', 'color', 'layout', 'text', 'border', 'structure']);

/** 分类中文名（渲染与文档共用一份，别在渲染里裸写字符串）。 */
export const DIFF_CATEGORY_LABEL = Object.freeze({
  size: '尺寸/圆角',
  color: '颜色',
  layout: '布局',
  text: '文字',
  border: '边框',
  structure: '结构',
});

/** 块的**稳定身份** = 层在树里的 path（`父/子/名`）。**只有改名才会变** —— 挪动/改色都不变。 */
function blockIdentity(b) { return String(b?.path ?? ''); }

function diffKindLabel(kind) { return BLOCK_KINDS[kind] ?? String(kind ?? '?'); }

/** 变化值的显示形态：数字 round2，null/undefined 一律「无」（**不编**）。 */
function diffVal(v) {
  if (v === null || v === undefined) return '无';
  if (typeof v === 'number') return String(round2(v));
  return String(v);
}

/** 底色/渐变的可比指纹（`#hex@alpha` 序列）—— 与 `bgText` 同口径，只是不含 rgba 后缀。 */
function bgKey(bg) {
  if (!bg) return '无';
  if (bg.stops?.length > 1) return bg.stops.map((s) => `${s.hex}@${s.alpha}`).join('→');
  return `${bg.hex}@${bg.alpha}`;
}

/** 文字色的可比指纹 —— 必须带上 alpha（半透明文字色与不透明的是两回事）。 */
function textColorKey(b) {
  const a = b.colorAlpha ?? 1;
  return b.color ? `${b.color}@${a}` : '无';
}

/** 文字色的显示形态：与 `bgText` 同一套 `#hex@xx% (rgba(…))` 写法（半透明才带后缀）。 */
function textColorText(b) {
  if (!b.color) return '无';
  const a = b.colorAlpha ?? 1;
  if (a >= 1) return b.color;
  return `${b.color}@${Math.round(a * 100)}%${rgbaSuffix({ ...parseColor(b.color), a })}`;
}

function borderKey(b) {
  const bd = b.border;
  if (!bd) return '无';
  // ⚠️ **颜色不在这里**：描边色变化归「颜色」类（那是色值问题），这里只管"有没有 / 多粗 / 哪几边"。
  //    两边都算会让一次改色同时出现在「颜色」和「边框」两处，看着像两处改动。
  return JSON.stringify([bd.width ?? null, bd.single ?? null, bd.style ?? null]);
}

/** 边框的显示形态（沿用块表里的写法：`1px #E2E8F0`）。 */
function borderText(b) {
  const bd = b.border;
  if (!bd) return '无';
  const w = bd.width === null || bd.width === undefined ? '' : `${round2(bd.width)}px`;
  return `${w}${bd.color ? ` ${bd.color}` : ''}${bd.single ? '（单边）' : ''}`.trim() || '有';
}

/**
 * 两个块的**逐字段差异** → `[{cat, field, label, from, to}]`。
 *
 * 字段清单是**穷举**的（块的每一个会影响还原的属性都在这里），免得"改了一个没比的字段
 * 就静默漏报"。分类与用户的说法对齐：尺寸/圆角、颜色、布局、文字、边框、结构。
 */
export function diffBlockItems(a, b) {
  const items = [];
  const put = (cat, field, from, to, label) => items.push({ cat, field, from, to, label });

  // —— 尺寸/圆角 ——
  const ra = a.radius?.max ?? null;
  const rb = b.radius?.max ?? null;
  if (ra !== rb) put('size', 'radius', ra, rb, `圆角 ${diffVal(ra)}→${diffVal(rb)}`);
  const wa = a.w; const ha = a.h; const wb = b.w; const hb = b.h;
  if (wa !== wb && ha !== hb) put('size', 'size', `${wa}×${ha}`, `${wb}×${hb}`, `尺寸 ${diffVal(wa)}×${diffVal(ha)}→${diffVal(wb)}×${diffVal(hb)}`);
  else if (wa !== wb) put('size', 'width', wa, wb, `宽度 ${diffVal(wa)}→${diffVal(wb)}`);
  else if (ha !== hb) put('size', 'height', ha, hb, `高度 ${diffVal(ha)}→${diffVal(hb)}`);

  // —— 颜色（底色 / 文字色 / 图层不透明 / 描边色）——
  if (bgKey(a.bg) !== bgKey(b.bg)) put('color', 'bg', bgKey(a.bg), bgKey(b.bg), `底色 ${bgText(a.bg)}→${bgText(b.bg)}`);
  if (textColorKey(a) !== textColorKey(b)) put('color', 'color', textColorKey(a), textColorKey(b), `文字色 ${textColorText(a)}→${textColorText(b)}`);
  const oa = a.opacity ?? 1;
  const ob = b.opacity ?? 1;
  if (oa !== ob) put('color', 'opacity', oa, ob, `不透明度 ${diffVal(oa)}→${diffVal(ob)}`);
  const bca = a.border?.color ?? null;
  const bcb = b.border?.color ?? null;
  if (bca !== bcb) put('color', 'borderColor', bca, bcb, `描边色 ${diffVal(bca)}→${diffVal(bcb)}`);

  // —— 布局 ——
  // ⚠️ 画板块的坐标是**画布绝对坐标**（稿子在画布上被挪动就会变），不是设计变更 —— 跳过，
  //    由 diffDesign 在末尾用一行"注"交代，别混进"布局变化"里制造假差异。
  if (a.kind !== KINDS.ARTBOARD && (a.x !== b.x || a.y !== b.y)) {
    const dx = round2((b.x ?? 0) - (a.x ?? 0));
    const dy = round2((b.y ?? 0) - (a.y ?? 0));
    let what;
    if (dx === 0) what = dy > 0 ? `下移 ${dy}px` : `上移 ${-dy}px`;
    else if (dy === 0) what = dx > 0 ? `右移 ${dx}px` : `左移 ${-dx}px`;
    else what = `移动 (${diffVal(dx)}, ${diffVal(dy)})px`;
    put('layout', 'position', `(${diffVal(a.x)}, ${diffVal(a.y)})`, `(${diffVal(b.x)}, ${diffVal(b.y)})`,
      `${what}（x,y ${diffVal(a.x)},${diffVal(a.y)}→${diffVal(b.x)},${diffVal(b.y)}）`);
  }

  // —— 文字（文案 + 字号/字重/字体族/行高/字距/对齐）——
  if ((a.text ?? null) !== (b.text ?? null)) {
    put('text', 'content', a.text ?? null, b.text ?? null, `文案 ${JSON.stringify(a.text ?? '')}→${JSON.stringify(b.text ?? '')}`);
  }
  const fa = a.font ?? {};
  const fb = b.font ?? {};
  if ((fa.size ?? null) !== (fb.size ?? null)) put('text', 'fontSize', fa.size ?? null, fb.size ?? null, `字号 ${diffVal(fa.size)}→${diffVal(fb.size)}`);
  if ((fa.weight ?? null) !== (fb.weight ?? null)) put('text', 'fontWeight', fa.weight ?? null, fb.weight ?? null, `字重 ${diffVal(fa.weight)}→${diffVal(fb.weight)}`);
  if ((fa.family ?? null) !== (fb.family ?? null)) put('text', 'fontFamily', fa.family ?? null, fb.family ?? null, `字体 ${diffVal(fa.family)}→${diffVal(fb.family)}`);
  if ((fa.lineHeight ?? null) !== (fb.lineHeight ?? null)) put('text', 'lineHeight', fa.lineHeight ?? null, fb.lineHeight ?? null, `行高 ${diffVal(fa.lineHeight)}→${diffVal(fb.lineHeight)}`);
  if ((fa.letterSpacing ?? null) !== (fb.letterSpacing ?? null)) put('text', 'letterSpacing', fa.letterSpacing ?? null, fb.letterSpacing ?? null, `字距 ${diffVal(fa.letterSpacing)}→${diffVal(fb.letterSpacing)}`);
  if ((fa.align ?? null) !== (fb.align ?? null)) put('text', 'align', fa.align ?? null, fb.align ?? null, `对齐 ${diffVal(fa.align)}→${diffVal(fb.align)}`);

  // —— 边框（宽度/有无/单边；颜色归「颜色」类）——
  if (borderKey(a) !== borderKey(b)) put('border', 'border', borderKey(a), borderKey(b), `边框 ${borderText(a)}→${borderText(b)}`);

  // —— 结构（类型/切图/形状/子层数）——
  if (a.kind !== b.kind) put('structure', 'kind', a.kind, b.kind, `类型 ${diffKindLabel(a.kind)}→${diffKindLabel(b.kind)}`);
  if (Boolean(a.hasImage) !== Boolean(b.hasImage)) put('structure', 'hasImage', Boolean(a.hasImage), Boolean(b.hasImage), `切图 ${a.hasImage ? '有' : '无'}→${b.hasImage ? '有' : '无'}`);
  if ((a.shape ?? null) !== (b.shape ?? null)) put('structure', 'shape', a.shape ?? null, b.shape ?? null, `形状 ${diffVal(a.shape)}→${diffVal(b.shape)}`);
  if ((a.childCount ?? 0) !== (b.childCount ?? 0)) put('structure', 'childCount', a.childCount ?? 0, b.childCount ?? 0, `子层数 ${diffVal(a.childCount ?? 0)}→${diffVal(b.childCount ?? 0)}`);

  return items;
}

/** 盒子的 L1 距离 —— **只用来在同一个 path 组内挑"是哪一个"**，不参与成败判定。 */
function boxL1(a, b) {
  return Math.abs((a.x ?? 0) - (b.x ?? 0)) + Math.abs((a.y ?? 0) - (b.y ?? 0))
    + Math.abs((a.w ?? 0) - (b.w ?? 0)) + Math.abs((a.h ?? 0) - (b.h ?? 0));
}

function boxCenter(b) { return [(b.x ?? 0) + (b.w ?? 0) / 2, (b.y ?? 0) + (b.h ?? 0) / 2]; }

function sizeRatio(x, y) {
  const hi = Math.max(Math.abs(x ?? 0), Math.abs(y ?? 0));
  const lo = Math.min(Math.abs(x ?? 0), Math.abs(y ?? 0));
  return hi / Math.max(1, lo);
}

/**
 * 近似配对（**只在身份对不上的残余里做**）。
 *
 * 判据保守到"宁可报新增/删除，也不硬认"：**类型必须相同**、**文本必须相同**
 * （文案都改了就不该猜它是同一块）、中心点够近、宽高差在 25% 以内。
 * 三条全过才配对，并按"中心距 + 尺寸差"贪心取最优。
 */
export function matchApproxBlocks(from, to, opts = {}) {
  const maxCenter = opts.maxCenter ?? LIMITS.diffApproxMaxCenter;
  const reachRatio = opts.reachRatio ?? LIMITS.diffApproxReachRatio;
  const maxSizeRatio = opts.maxSizeRatio ?? LIMITS.diffApproxMaxSizeRatio;
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
  const cands = [];
  for (const a of from) {
    const [acx, acy] = boxCenter(a);
    for (const b of to) {
      if (a.kind !== b.kind) continue;
      if (norm(a.text) !== norm(b.text)) continue;
      const [bcx, bcy] = boxCenter(b);
      const cd = Math.hypot(acx - bcx, acy - bcy);
      const reach = Math.max(maxCenter, reachRatio * Math.max(a.w ?? 0, a.h ?? 0, b.w ?? 0, b.h ?? 0));
      if (cd > reach) continue;
      const rw = sizeRatio(a.w, b.w);
      const rh = sizeRatio(a.h, b.h);
      if (rw > maxSizeRatio || rh > maxSizeRatio) continue;
      cands.push({ a, b, score: cd + (rw - 1) * 100 + (rh - 1) * 100 });
    }
  }
  cands.sort((p, q) => p.score - q.score || p.a.uid - q.a.uid || p.b.uid - q.b.uid);
  const out = [];
  const ua = new Set();
  const ub = new Set();
  for (const c of cands) {
    if (ua.has(c.a.uid) || ub.has(c.b.uid)) continue;
    ua.add(c.a.uid);
    ub.add(c.b.uid);
    out.push({ a: c.a, b: c.b, how: 'approx' });
  }
  return out;
}

/**
 * 两版的块配对。三级，每级都可解释：
 *   ① **身份（path）**：同 path 的块组内按几何最近邻配对，标 `exact`。
 *      几何只用于"同 path 有多个块时选哪个" —— **挪动了 8px 仍是同一块**（那是"布局变化"，
 *      不是"匹配失败"）。
 *   ② **近似**：残余里按类型 + 文本 + 几何配，标 `approx`。
 *   ③ 剩下的 → `onlyFrom`（删除）/ `onlyTo`（新增）。
 */
export function matchVersionBlocks(fromBlocks, toBlocks, opts = {}) {
  const from = Array.isArray(fromBlocks) ? fromBlocks : [];
  const to = Array.isArray(toBlocks) ? toBlocks : [];
  const pairs = [];
  const usedTo = new Set();
  const byPath = new Map();
  for (const b of to) {
    const k = blockIdentity(b);
    if (!byPath.has(k)) byPath.set(k, []);
    byPath.get(k).push(b);
  }

  const restFrom = [];
  for (const a of from) {
    const cands = (byPath.get(blockIdentity(a)) ?? []).filter((b) => !usedTo.has(b.uid));
    if (cands.length === 0) { restFrom.push(a); continue; }
    let best = cands[0];
    let bd = boxL1(a, best);
    for (const b of cands.slice(1)) {
      const d = boxL1(a, b);
      if (d < bd) { bd = d; best = b; }
    }
    usedTo.add(best.uid);
    pairs.push({ a, b: best, how: 'exact' });
  }

  const restTo = to.filter((b) => !usedTo.has(b.uid));
  const approx = matchApproxBlocks(restFrom, restTo, opts);
  for (const p of approx) { usedTo.add(p.b.uid); }
  const approxA = new Set(approx.map((p) => p.a.uid));
  const onlyFrom = restFrom.filter((a) => !approxA.has(a.uid));
  const onlyTo = restTo.filter((b) => !usedTo.has(b.uid));
  return { pairs: pairs.concat(approx), onlyFrom, onlyTo };
}

/**
 * 匹配可靠度：**能不能信这张差异表**。
 *
 * 两条判据（都写进 `LIMITS`，不在逻辑里裸写数字）：
 *   · 匹配率 `< diffMinMatchedRatio` → 大面积对不上（整版重画/重排/换了命名体系）
 *   · 近似匹配占已匹配 `> diffMaxApproxShare` → 身份大面积对不上，全靠几何猜
 * 块数少于 `diffMinBlocksForRatio` 时不按比例判（小样本比例没意义），但"**全部**靠猜"仍降级。
 */
export function diffReliability({ matched, exact, approx, onlyFrom, onlyTo, fromCount, toCount }) {
  // total 用**两边块数的较大值**，不是"已匹配 + 未匹配之和"（那样会把未匹配算两遍，
  // 匹配率被人为拉低 —— 实测：100/159 会算成 100/218）。
  const total = Math.max(fromCount, toCount);
  const unmatched = onlyFrom + onlyTo;
  const matchedRatio = total > 0 ? matched / total : 1;
  const approxShare = matched > 0 ? approx / matched : 0;
  const small = total < LIMITS.diffMinBlocksForRatio;
  let reliable = true;
  let reason = null;
  if (small) {
    if (matched > 0 && approx === matched) {
      reliable = false;
      reason = `块数很少（${total} 块）且**全部**只能靠近似配对 —— 身份一个都没对上，逐块对比不可靠。`;
    }
  } else if (matchedRatio < LIMITS.diffMinMatchedRatio) {
    reliable = false;
    reason = `只有 ${matched}/${total} 块能配上（匹配率 ${Math.round(matchedRatio * 100)}%），`
      + `${unmatched} 块对不上 —— 这通常意味着设计**整版重画/重排**或换了一套图层命名。`;
  } else if (approxShare > LIMITS.diffMaxApproxShare) {
    reliable = false;
    reason = `已配上的 ${matched} 块里有 ${approx} 块只能靠**几何近似**猜（层名大面积变过），`
      + '逐块配对的结果不可信。';
  }
  return {
    exact, approx, unmatched, matched, total,
    matchedRatio: round2(matchedRatio), approxShare: round2(approxShare),
    smallSample: small, reliable, reason,
  };
}

/* ---------------------------------------------------------------- 渲染 ---- */

/** 变化摘要行：`块名 变化短语`；同名块不止一个时补上 path（否则定位不到）。 */
function diffRow(entry, dupLabels) {
  const where = entry.where + (dupLabels.has(entry.where) ? `（${entry.path}）` : '');
  return `${where} ${entry.label}`;
}

/**
 * 差异 → 人读文本。**只列有变化的**；未变的一律只给一句汇总。
 *
 * `reliable === false` 时**不出明细表** —— 那是本功能最重要的一条纪律：
 * 硬凑出来的"精确差异表"会被 AI 当成事实去改代码。
 */
export function renderDiff(d) {
  const L = [];
  const f = d.from ?? {};
  const t = d.to ?? {};
  const short = (id) => (id ? String(id).slice(0, 8) : '?');
  const when = (v) => (v ? String(v).replace(/^(\w+), /, '').replace(/ UTC$/, ' UTC') : '时间未知');
  const gap = d.gapSeconds === null || d.gapSeconds === undefined
    ? '' : `（相隔 ${d.gapDays >= 1 ? `${Number.isInteger(d.gapDays) ? d.gapDays : d.gapDays.toFixed(1)} 天` : d.gapSeconds < 60 ? '不到 1 分钟' : `${Math.round(d.gapSeconds / 60)} 分钟`}）`;
  const head = `设计变更：v${short(f.id)} → v${short(t.id)}${gap}`;
  L.push(head);
  const where = (v) => {
    const i = v?.index === null || v?.index === undefined ? null : `第 ${v.index + 1}/${d.versionCount} 版`;
    const parts = [i, when(v?.createTime), v?.isLatest ? '最新版' : '**不是**最新版'].filter(Boolean);
    return parts.join(' ');
  };
  L.push(`· 稿：${d.name ?? '(未命名)'} ${d.viewport?.width ?? '?'}×${d.viewport?.height ?? '?'} · 块数 ${d.counts.fromBlocks} → ${d.counts.toBlocks}`);
  L.push(`· from：${where(f)} / to：${where(t)}`);
  if (d.sameVersion) {
    L.push('');
    L.push(`**两版一致**：from 与 to 是**同一个版本**（${short(t.id)}）—— ${d.counts.fromBlocks} 块逐项比过，没有任何差异。`);
    L.push('→ 设计没改，前端代码可以不动。');
    for (const n of d.notes ?? []) L.push(`注：${n}`);
    return L.join('\n');
  }
  const r = d.reliability ?? {};
  L.push(`· 匹配可靠度：✅ ${r.exact} 块按 path 精确匹配 · ⚠️ ${r.approx} 块只能靠近似匹配 · `
    + `❌ ${r.unmatched} 块无法匹配（匹配率 ${Math.round((r.matchedRatio ?? 0) * 100)}%）`);

  if (!d.reliable) {
    L.push('');
    L.push('⚠️ **这两版差异过大，逐块对比不可靠 —— 不出明细表。**');
    L.push(`· ${r.reason ?? ''}`);
    L.push(`· 已匹配 ${r.matched}/${r.total}（精确 ${r.exact} · 近似 ${r.approx}）；`
      + `另有 ${d.counts.removed} 块只在 from 里、${d.counts.added} 块只在 to 里。`);
    L.push('· ⚠️ 上面这两个数**不等于"删除/新增"** —— 它们只是"没配上对"的块；谁是谁已无从判断，所以不给清单。');
    L.push('· 建议：先确认 from/to 是不是同一张稿的两个版本；要逐块看请分别对两版调 `lanhu_read_blocks` 人工比对。');
    for (const n of d.notes ?? []) L.push(`注：${n}`);
    return L.join('\n');
  }

  if (d.identical) {
    L.push('');
    L.push(`**两版一致**：${d.counts.matched} 块逐项比过（尺寸/圆角·颜色·布局·文字·边框·结构），**没有任何差异**。`);
    if (r.approx > 0) {
      L.push(`（其中 ${r.approx} 块是靠近似配对上的：层名变过、外观一致 —— 不影响"没改"的结论。）`);
    }
    L.push('→ 设计没改，前端代码可以不动。');
    for (const n of d.notes ?? []) L.push(`注：${n}`);
    return L.join('\n');
  }

  // 明细：分类只列有变化的
  // 同名后缀的判据是「这个块名对应**多个不同 path**」—— 同一块出现多行（比如又改类型又改切图）
  // 不该被当成歧义加后缀（那样每行都拖一条尾巴，反而难读）。
  const dupLabels = new Set();
  {
    const byLabel = new Map();
    for (const cat of DIFF_CATEGORIES) {
      for (const e of d.changes[cat] ?? []) {
        if (!byLabel.has(e.where)) byLabel.set(e.where, new Set());
        byLabel.get(e.where).add(e.path);
      }
    }
    for (const [k, paths] of byLabel) if (paths.size > 1) dupLabels.add(k);
  }
  L.push('');
  for (const cat of DIFF_CATEGORIES) {
    const rows = d.changes[cat] ?? [];
    if (rows.length === 0) continue;
    const shown = rows.slice(0, LIMITS.diffMaxRowsPerCategory);
    L.push(`· ${DIFF_CATEGORY_LABEL[cat]}：`);
    for (const e of shown) L.push(`  - ${diffRow(e, dupLabels)}`);
    if (rows.length > shown.length) L.push(`  - …还有 ${rows.length - shown.length} 处（同类，已截断）`);
  }
  if (d.counts.added > 0 || d.counts.removed > 0) {
    L.push(`· ${d.counts.added > 0 ? `新增 ${d.counts.added} 块` : ''}${d.counts.added > 0 && d.counts.removed > 0 ? '；' : ''}${d.counts.removed > 0 ? `删除 ${d.counts.removed} 块` : ''}：`);
    for (const e of (d.added ?? []).slice(0, LIMITS.diffMaxRowsPerCategory)) L.push(`  - ＋ ${e.where}（${diffKindLabel(e.kind)} ${diffVal(e.w)}×${diffVal(e.h)}）`);
    for (const e of (d.removed ?? []).slice(0, LIMITS.diffMaxRowsPerCategory)) L.push(`  - － ${e.where}（${diffKindLabel(e.kind)} ${diffVal(e.w)}×${diffVal(e.h)}）`);
  }
  L.push(`· 未变：其余 ${d.counts.unchanged} 块`);
  for (const n of d.notes ?? []) L.push(`注：${n}`);
  return L.join('\n');
}

/* ------------------------------------------------------------ 主入口 ---- */

/** 版本在列表里的位置（0 = 最新）。 */
function versionIndexOf(list, id) {
  const i = (list?.versions ?? []).findIndex((v) => String(v.id) === String(id));
  return i < 0 ? null : i;
}

/**
 * 解析要对比的其中一个版本。**严格**：给了具体 id 就必须命中，绝不静默回退 latest。
 * 命中判断与报错文案复用 `pickVersion`（版本语义只有一份实现）。
 */
function resolveDiffVersion(list, want, which) {
  const raw = list?.versions ?? [];
  const shim = raw.map((v) => ({ id: v.id, json_url: v.jsonUrl }));
  if ((want === null || want === undefined || want === '') && which === 'from') {
    throw new LanhuError('需要 `from`（对比的**起点**版本 id）—— 不传就无法回答"改了什么"。', {
      code: 'DIFF_FROM_REQUIRED',
      hint: `该稿共 ${raw.length} 个版本。先调 \`lanhu_read_blocks\`（不传 version 即最新版）拿到 version.id，`
        + '或从面板/CLI 的版本列表里取一个旧版本 id 再喂给 `from`。',
    });
  }
  let chosen;
  try {
    chosen = pickVersion(shim, want === null || want === undefined || want === '' ? 'latest' : want);
  } catch (e) {
    if (e?.code === 'VERSION_NOT_FOUND') {
      throw new LanhuError(e.message, {
        code: 'VERSION_NOT_FOUND',
        hint: `${which} 给了一个不存在的版本 id —— 这里**不会**静默回退到最新版（那会让你以为比的是那一版）。${e.hint ?? ''}`,
      });
    }
    throw e;
  }
  const hit = raw.find((v) => String(v.id) === String(chosen.id)) ?? null;
  return hit;
}

/**
 * **同一张稿的两个版本对比** —— 回答"这次设计改了什么"。
 *
 * 网络请求**恰好三次**：一次版本列表 + **两次图层树**（每版一次）。不做逐版本探测。
 */
export async function diffDesign(args = {}) {
  const target = resolveTarget({ projectId: args.projectId, imageId: args.imageId, url: args.url });
  const picked = await pickAccount({ ...args, projectId: target.projectId, imageId: target.imageId, teamId: target.teamId });
  const acct = picked.alias;
  const opts = { cookie: args.cookie, account: acct };

  // ① 版本列表（一次请求就够 —— 它同时给出每版的 json_url，不用再逐版拉详情）
  const list = await imageVersions(target.projectId, target.imageId, opts);
  if ((list.versions ?? []).length === 0) {
    if (!isReadableDetail({ name: list.name, jsonUrl: null })) {
      throw new LanhuError(`当前账号读不到这张稿（${target.imageId}），或它没有任何版本。`, {
        code: 'EMPTY_DETAIL',
        hint: '蓝湖对不属于当前账号的稿子会**静默返回空壳**、不报错。多账号场景先用 `lanhu_who` 或 `lanhu_accounts` 确认这张稿该用哪个账号，再指定 account 重试。',
      });
    }
    throw new LanhuError(`稿 ${target.imageId} 没有任何可读版本。`, { code: 'VERSION_UNAVAILABLE' });
  }
  const fromV = resolveDiffVersion(list, args.from, 'from');
  const toV = resolveDiffVersion(list, args.to, 'to');

  // ② 两次树请求（这一版与那一版）
  const trees = [];
  let diffSourceFormat = null;
  for (const v of [fromV, toV]) {
    let tree = await fetchJsonUrl(v.jsonUrl, opts);
    // ⭐ Sketch 插件格式：与 read_design / read_blocks **走同一条归一化**（不为 diff 另写一份解析）。
    //    以前这里只认 `artboard`，于是半个项目的稿子 diff 直接报"不是设计稿图层树"——
    //    归错因（它们是设计稿，只是另一套结构）。现在能真的 diff。
    if (isSketchPluginTree(tree)) {
      const norm = normalizeSketchPluginTree(tree);
      if (norm.layerCount === 0) {
        throw new LanhuError(`版本 ${String(v.id).slice(0, 8)} 是**蓝湖 Sketch 插件导出**（\`type: sketchPlugin\`），`
          + '但它的 `info[]` 里取不出任何子层 —— **本次 diff 无数据，不代表这一版是空的**。', {
          code: 'SKETCH_PLUGIN_NO_LAYERS',
          hint: '换一版（`lanhu_read_design` 的版本信息能看到有几版）；或按"支持与不支持的稿件格式"（docs/读稿.md）换一张非 Sketch 插件格式的稿子。',
        });
      }
      tree = norm.tree;
      diffSourceFormat = 'sketchPlugin';
    } else if (!tree?.artboard) {
      throw new LanhuError(`版本 ${String(v.id).slice(0, 8)} 拉到的不是设计稿图层树（没有 \`artboard\`）。`, {
        code: 'NOT_DESIGN_TREE',
        hint: '这张 imageId 可能指向**原型/产品文档**（那要用 `lanhu_read_product_doc`），或该版本还没生成图层数据。',
      });
    }
    trees.push(tree);
  }
  const [ta, tb] = trees;
  const blocksOf = (tree) => buildBlocks(flattenArtboard(tree.artboard ?? tree));
  // 与块表**同一套披露口径**（`visibleBlocks` 是唯一一份实现）：默认只比表里列出来的那些块，
  // 系统 UI / 图形碎片（noise）默认不参与 —— 否则状态栏图元的小抖动会淹没真变化。
  const includeNoise = Boolean(args.includeNoise);
  const allA = blocksOf(ta);
  const allB = blocksOf(tb);
  const A = visibleBlocks(allA, { includeNoise });
  const B = visibleBlocks(allB, { includeNoise });

  // ③ 配对 + 可靠度
  const { pairs, onlyFrom, onlyTo } = matchVersionBlocks(A, B, {});
  const exact = pairs.filter((p) => p.how === 'exact').length;
  const approx = pairs.length - exact;
  const reliability = diffReliability({
    matched: pairs.length, exact, approx,
    onlyFrom: onlyFrom.length, onlyTo: onlyTo.length,
    fromCount: A.length, toCount: B.length,
  });
  const reliable = reliability.reliable;

  // ④ 逐字段差异（**只在可信时才算** —— 不可信时刻意不算，免得有人把 changes 当事实用）
  const changes = {};
  for (const c of DIFF_CATEGORIES) changes[c] = [];
  const changedCounts = {};
  for (const c of DIFF_CATEGORIES) changedCounts[c] = 0;
  let unchanged = 0;
  let changedBlocks = 0;
  if (reliable) {
    const ordered = pairs.slice().sort((p, q) => (p.b.uid ?? 0) - (q.b.uid ?? 0));
    for (const p of ordered) {
      const items = diffBlockItems(p.a, p.b);
      if (items.length === 0) { unchanged += 1; continue; }
      changedBlocks += 1;
      const where = blockLabel(p.b);
      const cats = new Set();
      for (const it of items) {
        changes[it.cat].push({
          path: p.b.path ?? null, name: p.b.name ?? null, kind: p.b.kind ?? null,
          kindFrom: p.a.kind ?? null, how: p.how,
          field: it.field, label: it.label, from: it.from, to: it.to, where,
        });
        cats.add(it.cat);
      }
      for (const c of cats) changedCounts[c] += 1;
    }
  }

  // 「对不上」的块：不可信时**也照实给**（它们是真实存在的块，只是配不上对）——
  // 但那时渲染层只报计数、不出清单，并明说"这不等于是新增/删除"。
  const mkEntry = (b) => ({
    path: b.path ?? null, name: b.name ?? null, kind: b.kind ?? null,
    w: b.w ?? null, h: b.h ?? null, where: blockLabel(b),
  });
  const added = onlyTo.map(mkEntry);
  const removed = onlyFrom.map(mkEntry);

  // ⑤ 画板块的"画布坐标"交代 —— 不算设计变更，但**不静默吞掉**
  const notes = [];
  {
    const aa = A.find((b) => b.kind === KINDS.ARTBOARD);
    const ba = B.find((b) => b.kind === KINDS.ARTBOARD);
    if (aa && ba && (aa.x !== ba.x || aa.y !== ba.y)) {
      notes.push(`画板的画布坐标 ${diffVal(aa.x)},${diffVal(aa.y)}→${diffVal(ba.x)},${diffVal(ba.y)} 变了，`
        + '那是稿子在 Figma 画布上的摆放位置，**不是设计变更**（块坐标本来就相对画板），已从「布局」里排除。');
    }
    const noiseSkipped = (allA.filter((b) => b.noise).length) + (allB.filter((b) => b.noise).length);
    if (!includeNoise && noiseSkipped > 0) {
      notes.push(`系统 UI / 图形碎片共 ${noiseSkipped} 块未参与比对（与块级清单同一个折叠口径）；要一起比传 includeNoise:true。`);
    }
  }

  const gapSeconds = (() => {
    const a = Date.parse(parseRfc2822(fromV.createTime) ?? '');
    const b = Date.parse(parseRfc2822(toV.createTime) ?? '');
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round(Math.abs(b - a) / 1000);
  })();
  const gapDays = gapSeconds === null ? null : Math.round(gapSeconds / 86400 * 10) / 10;

  const identical = reliable && changedBlocks === 0 && added.length === 0 && removed.length === 0;
  const d = {
    ok: true,
    format: 'diff',
    // 稿子的**来源格式**：`'sketchPlugin'` = Sketch 插件导出（已归一化后 diff）。只在非空时加键（普通稿逐字节不变）。
    ...(diffSourceFormat ? { sourceFormat: diffSourceFormat } : {}),
    name: tb.artboard?.name ?? list.name ?? null,
    viewport: {
      width: round2(tb.artboard?.frame?.width ?? list.width),
      height: round2(tb.artboard?.frame?.height ?? list.height),
    },
    from: { id: fromV.id ?? null, createTime: fromV.createTime ?? null, index: versionIndexOf(list, fromV.id), isLatest: String(fromV.id) === String(list.versions[0]?.id) },
    to: { id: toV.id ?? null, createTime: toV.createTime ?? null, index: versionIndexOf(list, toV.id), isLatest: String(toV.id) === String(list.versions[0]?.id) },
    versionCount: list.versions.length,
    versionLatestId: list.versions[0]?.id ?? null,
    sameVersion: String(fromV.id) === String(toV.id),
    gapSeconds,
    gapDays,
    identical,
    reliable,
    reliability,
    counts: {
      fromBlocks: A.length,
      toBlocks: B.length,
      noiseFrom: allA.filter((b) => b.noise).length,
      noiseTo: allB.filter((b) => b.noise).length,
      matched: pairs.length,
      unchanged,
      changed: { ...changedCounts, blocks: changedBlocks },
      added: added.length,
      removed: removed.length,
    },
    changes,
    added,
    removed,
    notes,
    account: acct ?? null,
    accountBy: picked.by ?? null,
  };
  d.text = renderDiff(d);
  d.textBytes = Buffer.byteLength(d.text, 'utf8');
  return d;
}

/* ==========================================================================
 * 6.6 设计系统审计（跨稿一致性）—— 「这个项目的设计系统漂了吗」
 *
 * 蓝湖**完全不提供**这个：它按稿组织，不按"组件"组织。所以"同一颗主按钮在 12 张稿里
 * 长出 5 种圆角"这件事，在蓝湖里没有任何一屏看得出来 —— 而这个插件已经有全量读取能力，
 * 这件事该由我们回答。
 *
 * 三条纪律（与 §6.5 的 diff 是同一套）：
 *   ① **判据必须可解释，而且写进输出**：同一组件 = **层名归一化后相同**。
 *      判据、覆盖率、"多少块因为名字不可靠没参与"全部报出来 —— 读者才知道该信几分。
 *   ② **成本必须受控**：扫 N 张 = **2N 次请求**（1 次稿详情 + 1 次图层树；实测 1437 张 ≈ 45 分钟）。
 *      所以默认只扫 `auditDefaultImages` 张，显式传 limit 才能加，且**绝不超过** `auditMaxImages`；
 *      输出里必须写明 scanned / total / truncated（本仓库铁律：不做全量拉取）。
 *   ③ **不可靠时拒绝出明细**：块名大多是 `Rectangle 12` 这种工具默认名时，按层名归组会得到
 *      "5 种圆角"这种**看着精确、其实认错组件**的结论 —— 比不给更糟。那时判 `reliable:false`。
 * ========================================================================== */

/** 审计发现类别（受控词表；数组顺序就是渲染顺序）。 */
export const AUDIT_CATEGORIES = Object.freeze(['componentSpec', 'fontScale', 'colorDrift', 'spacingScale', 'radiusFamily']);

/** 类别中文名（渲染与文档共用一份，别在渲染里裸写字符串）。 */
export const AUDIT_CATEGORY_LABEL = Object.freeze({
  componentSpec: '同一组件、多种规格',
  fontScale: '字号阶梯',
  colorDrift: '色值漂移（近重复色）',
  spacingScale: '间距尺度',
  radiusFamily: '圆角家族',
});

/** 哪些类别的结论**依赖层名** —— 命名不可靠时它们必须被压住（见 `auditReliability`）。 */
export const AUDIT_NAME_DEPENDENT = Object.freeze(['componentSpec']);

/** 序号圆圈（渲染用；下标 = AUDIT_CATEGORIES 的下标）。 */
const AUDIT_NUMERALS = Object.freeze(['①', '②', '③', '④', '⑤']);

/**
 * 工具默认层名（Figma / Sketch / Axure / 蓝湖自绘都这么起名）。
 * 命中即"名字不可靠"：`Rectangle 12` 只说明"这里有个矩形"，**不说明"这是主按钮"**。
 * 判据是**整个名字**（首尾都锚定），所以 `MainFrame` / `CardGroup` / `icon-arrow` 这类真名不会被误伤。
 */
const AUTO_NAME_WORDS = Object.freeze([
  'rectangle', 'rect', 'ellipse', 'oval', 'circle', 'vector', 'path', 'line', 'polygon', 'star',
  'shape', 'group', 'frame', 'component', 'instance', 'mask', 'union', 'subtract', 'intersect',
  'exclude', 'slice', 'bitmap', 'image', 'layer', 'artboard', 'symbol', 'text', 'icon', 'placeholder',
  'fill', 'stroke', 'clip', 'shadow', 'background', 'border', 'arrow',
  '矩形', '矩形框', '圆角矩形', '椭圆', '椭圆形', '圆形', '路径', '直线', '线条', '多边形', '星形', '形状',
  '编组', '分组', '组', '框架', '组件', '实例', '蒙版', '遮罩', '图片', '位图', '图层', '画板',
  '文本', '占位', '占位符', '占位图', '图标', '箭头',
]);

/** 「复制出来的那份」的中缀（`矩形备份 6` / `Rectangle 3 Copy 37`）—— 仍是工具默认名。 */
const AUTO_NAME_COPY_WORDS = 'copy|副本|备份|拷贝';

export const AUTO_LAYER_NAME_RE = new RegExp(
  '^(?:' + AUTO_NAME_WORDS.join('|') + ')'
  + '(?:[\\s_-]*\\d+)*'
  + '(?:[\\s_-]*(?:' + AUTO_NAME_COPY_WORDS + ')(?:[\\s_-]*\\d+)*)*'
  + '(?:\\s*[×xX*]\\s*\\d+)?$'
  + '|^(?:' + AUTO_NAME_COPY_WORDS + ')(?:\\s*\\d+)*$'
  + '|^[a-z]{1,3}\\d+$'
  + '|^\\d+(?:\\.\\d+)?$'
  + '|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  + '|^[0-9a-f]{16,}$'
  + '|^[\\s\\-_.·…]+$',
  'i',
);

/**
 * 层名归一化 —— **全项目只有这一把尺子**（跨稿比对与自动名判定共用）。
 * NFKC（全角→半角）+ 折叠连续空白 + 去首尾 + 转小写。
 * 为什么不剥尾号：`主按钮 2` 与 `主按钮` 是两个层，硬并会让"多规格"变成误报。
 */
export function auditNameKey(name) {
  return String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 这个名字**可不可靠**（能不能拿它当"同一组件"的判据）。
 * @returns {{auto: boolean, why: 'empty'|'template'|'tooShort'|null}}
 */
export function isAutoLayerName(name) {
  const key = auditNameKey(name);
  if (!key) return { auto: true, why: 'empty' };
  if (AUTO_LAYER_NAME_RE.test(key)) return { auto: true, why: 'template' };
  if ([...key].length < LIMITS.auditNameMinLength) return { auto: true, why: 'tooShort' };
  return { auto: false, why: null };
}

/** 例子里的稿名截断（一行塞 4 个长名会把整段挤爆）。 */
function shortImageName(name) {
  const s = String(name ?? '').trim() || '(未命名)';
  const chars = [...s];
  return chars.length > LIMITS.auditExampleNameMax ? `${chars.slice(0, LIMITS.auditExampleNameMax).join('')}…` : s;
}

/** 一个取值条目 → 输出形态（**示例稿名只带 `auditMaxExamples` 个**，免得把结果撑爆）。 */
function spreadRow(e) {
  return {
    value: e.value,
    count: e.count,
    imageCount: e.images.size,
    examples: [...e.images.values()].slice(0, LIMITS.auditMaxExamples).map(shortImageName),
  };
}

/** 取值分布 → 计数 + 多数派（**"建议以哪个为准"的判据就是它**：并列时明说无法判定，不硬挑一个）。 */
function auditValueSpread(map) {
  const list = [...map.values()].sort((a, b) => b.count - a.count || a.value - b.value);
  const total = list.reduce((n, e) => n + e.count, 0);
  if (list.length === 0) return { distinct: 0, total: 0, values: [], truncatedValues: 0, majority: null, majorityCount: null, tie: false };
  const top = list[0];
  const tie = list.length > 1 && list[1].count === top.count;
  return {
    distinct: list.length,
    total,
    values: list.slice(0, LIMITS.auditMaxSpecValues).map(spreadRow),
    truncatedValues: Math.max(0, list.length - LIMITS.auditMaxSpecValues),
    majority: tie ? null : top.value,
    majorityCount: tie ? null : top.count,
    tie,
  };
}

/**
 * 多张稿的块 → 「组件名 → 组内块」。判据**只有一条**：`auditNameKey` 相同。
 * 名字不可靠的块**不参与**，但**要计数** —— 覆盖率本身就是结论的一部分（见 `auditReliability`）。
 */
export function collectAuditComponents(scans, opts = {}) {
  const minImages = opts.minImages ?? LIMITS.auditMinComponentImages;
  const minBlocks = opts.minBlocks ?? LIMITS.auditMinComponentBlocks;
  const groups = new Map();
  const naming = { total: 0, named: 0, auto: 0, empty: 0 };
  const imagesWithLayers = new Set();

  for (const s of scans ?? []) {
    if (!s || !Array.isArray(s.blocks)) continue;
    imagesWithLayers.add(s.imageId);
    for (const b of s.blocks) {
      if (b.kind === KINDS.ARTBOARD) continue;            // 画板名 = 稿名，不是组件名
      naming.total += 1;
      const nm = isAutoLayerName(b.name);
      if (nm.auto) { if (nm.why === 'empty') naming.empty += 1; else naming.auto += 1; continue; }
      naming.named += 1;
      const key = auditNameKey(b.name);
      let g = groups.get(key);
      if (!g) { g = { key, name: String(b.name).trim(), blocks: [], images: new Map(), kinds: new Set() }; groups.set(key, g); }
      g.blocks.push({ ...b, imageId: s.imageId, imageName: s.imageName ?? null });
      g.images.set(s.imageId, (g.images.get(s.imageId) ?? 0) + 1);
      g.kinds.add(b.kind);
    }
  }

  const participated = [];
  const thin = [];
  for (const g of groups.values()) {
    if (g.images.size >= minImages && g.blocks.length >= minBlocks) participated.push(g);
    else thin.push(g);
  }
  const countBlocks = (list) => list.reduce((n, g) => n + g.blocks.length, 0);
  const namedShare = naming.total > 0 ? round2(naming.named / naming.total) : 0;
  return {
    groups,
    participated,
    thin,
    // ⚠️ `namedShare` **放进 naming 里**（而不是只做兄弟字段）：它是判"命名可不可靠"的输入，
    //    与 total/named/auto/empty 是一件事，分开放会有人只传 naming 而漏掉它（实测踩过）。
    naming: { ...naming, namedShare },
    participatedBlocks: countBlocks(participated),
    thinBlocks: countBlocks(thin),
    imagesWithLayers: imagesWithLayers.size,
  };
}

/**
 * 组件比哪几个维度（**单一出口**：加一个维度只改这里）。
 * ⚠️ 「高度」**不看文本层**：文本层的高度由文案长短与换行决定（实测 `关键字：` 的 100 个块里
 *    高度 18 与 20 混着出现），那是内容差异、不是规格漂移 —— 文本的规格看**字号**（② 字号阶梯）。
 */
const AUDIT_SPEC_DIMS = Object.freeze([
  { key: 'radius', label: '圆角', of: (b) => (b.radius && Number.isFinite(b.radius.max) ? round2(b.radius.max) : null) },
  { key: 'height', label: '高度', of: (b) => (b.kind === KINDS.TEXT ? null : (Number.isFinite(b.h) ? round2(b.h) : null)) },
]);

/**
 * ① 同一个组件、多种规格 —— 本功能最有价值的一项。
 * 只对**参与进来**（`collectAuditComponents` 的 `participated`）的组件名算；某维度只有 ≤1 个取值
 * 就不算发现（"只有一种" 不是漂移）。
 */
export function auditComponentSpecs(components) {
  const findings = [];
  let converged = 0;
  for (const g of components ?? []) {
    const dims = [];
    for (const d of AUDIT_SPEC_DIMS) {
      const map = new Map();
      for (const b of g.blocks) {
        const v = d.of(b);
        if (v === null) continue;
        const k = String(v);
        let e = map.get(k);
        if (!e) { e = { value: v, count: 0, images: new Map() }; map.set(k, e); }
        e.count += 1;
        e.images.set(b.imageId, b.imageName ?? null);
      }
      if (map.size < 2) continue;
      dims.push({ dim: d.key, label: d.label, ...auditValueSpread(map) });
    }
    if (dims.length === 0) { converged += 1; continue; }
    findings.push({ name: g.name, blocks: g.blocks.length, images: g.images.size, kinds: [...g.kinds].sort(), dims });
  }
  const spread = (f) => Math.max(...f.dims.map((d) => d.distinct));
  findings.sort((a, b) => spread(b) - spread(a) || b.blocks - a.blocks);
  return { findings, converged };
}

/**
 * ② 字号阶梯 —— 只看块里的 `font.size`（**不看层名**，所以命名不可靠时它仍然可用）。
 * 报两件事：整条阶梯，以及"只出现一次"的野值（它们是最该收敛掉的）。
 */
export function auditFontScale(scans) {
  const map = new Map();
  for (const s of scans ?? []) {
    for (const b of s.blocks ?? []) {
      const size = b?.font?.size;
      if (!Number.isFinite(size)) continue;
      const v = round2(size);
      const k = String(v);
      let e = map.get(k);
      if (!e) { e = { value: v, count: 0, images: new Map() }; map.set(k, e); }
      e.count += 1;
      e.images.set(s.imageId, s.imageName ?? null);
    }
  }
  const asc = [...map.values()].sort((a, b) => a.value - b.value);
  const spread = auditValueSpread(map);
  const ladder = asc.filter((e) => e.count >= LIMITS.auditLadderMinCount).map((e) => e.value);
  const oneOffs = asc.filter((e) => e.count <= LIMITS.auditOneOffMaxCount).map((e) => ({
    value: e.value,
    count: e.count,
    examples: [...e.images.values()].slice(0, LIMITS.auditMaxExamples).map(shortImageName),
    // 收敛建议的锚点：最近的"常用档"（出现 ≥ auditLadderMinCount 次）。没有常用档就不编。
    nearest: ladder.length
      ? ladder.reduce((best, v) => (Math.abs(v - e.value) < Math.abs(best - e.value) ? v : best), ladder[0])
      : null,
  }));
  const drift = oneOffs.length >= LIMITS.auditOneOffMinCount || asc.length > LIMITS.auditHealthyFontSizes;
  return {
    distinct: asc.length,
    total: spread.total,
    sizes: spread.values,
    truncatedValues: spread.truncatedValues,
    ladder,
    oneOffs,
    oneOffCount: oneOffs.length,
    drift,
  };
}

/** 收集参与审计的色值（底色 / 渐变 stop / 文字色 / 描边色）。 */
export function collectAuditColors(scans) {
  const map = new Map();
  const add = (hex, alpha, role, s) => {
    if (!hex) return;
    const a = Number.isFinite(alpha) ? round2(alpha) : 1;
    if (a <= 0) return;                                  // 全透明看不见，不是色值
    const key = a < 1 ? `${hex}@${Math.round(a * 100)}%` : String(hex);
    let e = map.get(key);
    if (!e) {
      e = { key, hex: String(hex).toLowerCase(), alpha: a, count: 0, roles: new Set(), images: new Map(), rgb: parseColor(hex) };
      map.set(key, e);
    }
    e.count += 1;
    e.roles.add(role);
    e.images.set(s.imageId, s.imageName ?? null);
  };
  for (const s of scans ?? []) {
    for (const b of s.blocks ?? []) {
      if (b.bg) {
        add(b.bg.hex, b.bg.alpha, 'bg', s);
        for (const st of b.bg.stops ?? []) add(st.hex, st.alpha, 'gradient', s);
      }
      if (b.color) add(b.color, b.colorAlpha ?? 1, 'text', s);
      if (b.border?.color) add(b.border.color, b.border.alpha ?? 1, 'border', s);
    }
  }
  return map;
}

/** 两个 RGB 的欧氏距离（0 ~ 441）。阈值是 `LIMITS.auditNearColorDistance`，**不在逻辑里裸写**。 */
export function rgbDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * ③ 色值漂移 —— 把 **RGB 距离 ≤ 阈值** 的色值聚成一簇。
 *
 * 判据是距离阈值本身（写进 `LIMITS` 也写进输出）：`#574af4` 与 `#574bf5` 的距离是 1.41，
 * 而 12 以内肉眼分不出 —— 那正是"设计漂了、代码里却写了两套色"的来源。
 *
 * ⚠️ 三条刻意的边界（都踩过）：
 *   · **完全链接**（不是并查集的连通分量）：新成员必须与簇内**每一个**成员都 ≤ 阈值，否则另起一簇。
 *     用连通分量会连成链（`#ffffff ≈ #f9f9f9 ≈ #f2f2f2 ≈ …`），最后一簇的最大距离冲到 32.89 ——
 *     那时"肉眼分不出"就是**假话**（实测踩过）。
 *   · **只比同透明度的**：`#4693ff` 与 `#4693ff@60%` 的 RGB 距离是 0，但它们不是"同一色的两种写法"
 *     （一个是实色、一个是 60% 描边）—— 聚成一簇并建议"统一"是**假发现**（实测踩过）。
 *   · 贪心按**出现次数从多到少**放：这样"多数派"天然是簇里第一个，建议值稳定且可解释。
 */
export function nearColorClusters(entries, threshold = LIMITS.auditNearColorDistance) {
  const list = (entries ?? []).slice().sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
  const sameAlpha = (a, b) => Math.abs((a.alpha ?? 1) - (b.alpha ?? 1)) <= LIMITS.auditEpsilon;
  const clusters = [];
  for (const e of list) {
    // 放进**第一个**能容下它的簇（与簇内每一个都 ≤ 阈值），否则另起一簇
    const hit = clusters.find((c) => sameAlpha(c[0], e)
      && c.every((m) => rgbDistance(m.rgb, e.rgb) <= threshold));
    if (hit) hit.push(e);
    else clusters.push([e]);
  }
  return clusters
    .filter((c) => c.length >= 2)
    .map((members) => {
      let maxDistance = 0;
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          maxDistance = Math.max(maxDistance, rgbDistance(members[i].rgb, members[j].rgb));
        }
      }
      const tie = members.length > 1 && members[1].count === members[0].count;
      return {
        members: members.map((e) => ({ key: e.key, count: e.count, imageCount: e.images.size, roles: [...e.roles].sort(), examples: [...e.images.values()].slice(0, LIMITS.auditMaxExamples).map(shortImageName) })),
        maxDistance: round2(maxDistance),
        majority: tie ? null : members[0].key,
        tie,
      };
    })
    .sort((a, b) => b.members.length - a.members.length || b.members[0].count - a.members[0].count);
}

/** ④ 间距尺度 —— 拿 `geometricGaps` 收集**所有**几何间距，看有没有跑出 4px 栅格的野值。 */
export function auditSpacing(scans) {
  const map = new Map();
  let skippedImages = 0;
  for (const s of scans ?? []) {
    const items = (s.blocks ?? []).filter((b) => b.kind !== KINDS.ARTBOARD
      && Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h));
    if (items.length > LIMITS.auditSpacingMaxBlocks) { skippedImages += 1; continue; }
    const gaps = geometricGaps(items.map((b) => ({ id: b.path ?? null, name: b.name ?? null, x: b.x, y: b.y, w: b.w, h: b.h })), {
      maxDistance: LIMITS.auditSpacingMaxDistance,
    });
    for (const g of gaps) {
      const v = round2(g.distance);
      if (!(v > 0)) continue;                            // "间距 0" 是重复图层，不是尺度
      const k = String(v);
      let e = map.get(k);
      if (!e) { e = { value: v, count: 0, images: new Map() }; map.set(k, e); }
      e.count += 1;
      e.images.set(s.imageId, s.imageName ?? null);
    }
  }
  const all = [...map.values()].sort((a, b) => b.count - a.count || a.value - b.value);
  const onGrid = (v) => Math.abs(v / LIMITS.auditSpacingGrid - Math.round(v / LIMITS.auditSpacingGrid)) <= LIMITS.auditEpsilon;
  const offGrid = all.filter((e) => !onGrid(e.value));
  return {
    distinct: all.length,
    total: all.reduce((n, e) => n + e.count, 0),
    grid: LIMITS.auditSpacingGrid,
    maxDistance: LIMITS.auditSpacingMaxDistance,
    top: all.slice(0, LIMITS.auditMaxSpecValues).map(spreadRow),
    offGrid: offGrid.slice(0, LIMITS.auditMaxSpecValues).map(spreadRow),
    offGridCount: offGrid.length,
    skippedImages,
    drift: offGrid.length >= LIMITS.auditOffGridMinValues,
  };
}

/** ⑤ 圆角家族（**参考项**）—— 值分布 + 不在常见刻度上的特例。 */
export function auditRadiusFamily(scans) {
  const map = new Map();
  for (const s of scans ?? []) {
    for (const b of s.blocks ?? []) {
      if (b.kind === KINDS.ARTBOARD) continue;
      if (!b.radius || !Number.isFinite(b.radius.max)) continue;
      const v = round2(b.radius.max);
      const k = String(v);
      let e = map.get(k);
      if (!e) { e = { value: v, count: 0, images: new Map() }; map.set(k, e); }
      e.count += 1;
      e.images.set(s.imageId, s.imageName ?? null);
    }
  }
  const all = [...map.values()].sort((a, b) => b.count - a.count || a.value - b.value);
  const onScale = (v) => LIMITS.auditRadiusScale.some((x) => Math.abs(x - v) <= LIMITS.auditEpsilon);
  const offScale = all.filter((e) => !onScale(e.value));
  return {
    distinct: all.length,
    total: all.reduce((n, e) => n + e.count, 0),
    scale: [...LIMITS.auditRadiusScale],
    top: all.slice(0, LIMITS.auditMaxSpecValues).map(spreadRow),
    offScale: offScale.slice(0, LIMITS.auditMaxSpecValues).map(spreadRow),
    offScaleCount: offScale.length,
    drift: offScale.length >= LIMITS.auditOffScaleMinValues,
  };
}

/**
 * 这次审计**能不能信** —— 与 §6.5 diff 的 `diffReliability` 同一套纪律。
 * 判据（阈值都在 `LIMITS`，不裸写）：
 *   · 成功读到图层的稿 < `auditMinImagesForAudit` → 样本太少；
 *   · 一个块都没读到 → 无从谈起；
 *   · 可靠块名占比 < `auditMinNamedShare` → **命名不可靠**（`Rectangle 12` 这类工具默认名占多数）。
 */
export function auditReliability({ imagesWithLayers, totalBlocks, naming }) {
  const reasons = [];
  if (imagesWithLayers < LIMITS.auditMinImagesForAudit) {
    reasons.push(`成功读到图层的稿只有 ${imagesWithLayers} 张（少于 ${LIMITS.auditMinImagesForAudit} 张）—— 样本太少，跨稿结论没有意义。`);
  }
  if (totalBlocks === 0) {
    reasons.push('一张稿里都没读到可参与审计的块（这些稿可能只有图片、没有图层数据）。');
  } else if (naming.namedShare < LIMITS.auditMinNamedShare) {
    reasons.push(`**命名不可靠**：可靠块名只覆盖 ${naming.named}/${naming.total} 块`
      + `（${Math.round(naming.namedShare * 100)}%，低于 ${Math.round(LIMITS.auditMinNamedShare * 100)}%）`
      + '—— 其余是 `Rectangle 12` 这类工具默认名或空名。');
  }
  return { reliable: reasons.length === 0, reasons };
}

/** 小并发池 —— 结果按**输入下标**回填，所以并发不影响输出的确定性（自检据此断言）。 */
async function mapPool(items, concurrency, fn) {
  const list = items ?? [];
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 跳过的原因 → 人话（**受控词表**：新增原因要在这里登记一行，别裸写字符串）。 */
const AUDIT_SKIP_LABEL = Object.freeze({
  empty: '账号读不到或没有版本（空壳）',
  'no-layers': '没有图层数据',
  'not-design': '不是设计稿图层树',
  'sketch-format': 'Sketch 插件格式但取不出图层（已按同一套规则试过归一化）',
  error: '读取失败',
});

/**
 * 读取失败 → **受控的**跳过原因（能判准就判准，判不准才归 `error`）。
 * 为什么要有它：蓝湖对"图片型条目"（只有一张 jpg、没有图层）**不报错**，而是在选版本时抛
 * `SOURCE_UNAVAILABLE`（"版本 … 没有 json_url"）。不把它翻成人话，"跳过 40 张（读取失败 40）"
 * 会看着像插件坏了，而不是"这个项目本来就有 40 张图，不是设计稿"。
 */
export function auditSkipReason(e) {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e ?? '');
  if (code === 'SOURCE_UNAVAILABLE' || /没有 json_url/.test(msg)) return 'no-layers';
  if (code === 'EMPTY_DETAIL' || /读不到这张稿/.test(msg)) return 'empty';
  if (code === 'PROTOTYPE_NOT_DESIGN' || /原型/.test(msg)) return 'not-design';
  return 'error';
}

/**
 * 这棵树是不是**蓝湖 Sketch 插件格式**（`type: sketchPlugin`，图层在 `info[]` 里、没有 `artboard`）。
 * ⚠️ 实测：这类稿子占某真实项目的一半以上（11/20）。**2026-10 起已真正解析**（见
 *    `normalizeSketchPluginTree`）：`read_design` / `read_blocks` / `design_diff` / `audit` / `download_slices`
 *    都走同一条归一化，输出与 Figma 稿同形。
 *    唯一仍然读不出来的是"归一化后取不出子层"的那种：那种情况下各入口**明说**读不出（不再静默返回
 *    "共 1 块：画板"），审计把它单列一类并在抬头里指明这是**已知空缺**，不是"这些稿不是设计稿"。
 */
function isSketchPluginTree(tree) {
  return Boolean(tree) && (tree.type === 'sketchPlugin' || (!tree.artboard && Array.isArray(tree.info)));
}

/**
 * **跨稿一致性审计** —— 扫一个项目的多张稿，报"设计系统漂移"。
 *
 * 成本：`scanned × 2` 次请求。`scanned = min(limit ?? auditDefaultImages, auditMaxImages)`，
 * 且 `limit` 传再大也不会越过硬上限（本仓库铁律：不做全量拉取）。
 */
export async function auditProject(args = {}) {
  const parsed = args.url ? parseProjectTarget(args.url) : null;
  const projectId = args.projectId ?? parsed?.projectId ?? null;
  if (!projectId) {
    throw new LanhuError('需要 projectId，或一条蓝湖链接 url（两个都不给，无法定位项目）。', {
      hint: '贴整条蓝湖链接最省事（里面的 tid/pid 自动解析）；也可以给 projectId（从 `lanhu_list_projects` 取）。',
    });
  }
  const picked = await pickAccount({ account: args.account, projectId, teamId: args.teamId ?? parsed?.teamId ?? null });
  const acct = picked.alias;
  const opts = { cookie: args.cookie, account: acct };

  // ① 列稿（1 次请求）—— 它同时给出 total，所以"被上限截断"这件事说得清楚
  const listing = await listImages(projectId, opts);
  const all = listing.images ?? [];
  const total = all.length;
  const rawLimit = Number(args.limit);
  const requested = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : LIMITS.auditDefaultImages;
  const applied = Math.min(requested, LIMITS.auditMaxImages);
  const selected = all.slice(0, applied);

  // ② 逐稿读图层（每张 2 次请求；单张失败只记录，不炸整次审计）
  const includeNoise = Boolean(args.includeNoise);
  const results = await mapPool(selected, LIMITS.auditConcurrency, async (img) => {
    try {
      const detail = await imageDetail(projectId, img.imageId, opts);
      if (!isReadableDetail(detail)) return { skipped: { imageId: img.imageId, name: img.name, reason: 'empty' } };
      if (!detail.jsonUrl) return { skipped: { imageId: img.imageId, name: img.name, reason: 'no-layers' } };
      const rawTree = await fetchJsonUrl(detail.jsonUrl, opts);
      // ⭐ Sketch 插件格式：与 read_design / read_blocks / diff **同一条归一化** —— 既然别处能读，
      //    审计就不能还把它整类跳过（那会自相矛盾：`read_blocks` 出 100 块，审计却说"读不了"）。
      //    只有**归一化后仍然取不出子层**的，才落到 `sketch-format` 这一跳过类（原归类保持不变）。
      let tree = rawTree;
      if (isSketchPluginTree(rawTree)) {
        const norm = normalizeSketchPluginTree(rawTree);
        if (norm.layerCount === 0) return { skipped: { imageId: img.imageId, name: img.name, reason: 'sketch-format' } };
        tree = norm.tree;
      }
      if (!tree?.artboard) return { skipped: { imageId: img.imageId, name: img.name, reason: 'not-design' } };
      const layers = flattenArtboard(tree.artboard ?? tree);
      const blocks = visibleBlocks(buildBlocks(layers), { includeNoise });
      return {
        scan: {
          imageId: img.imageId,
          imageName: detail.name ?? img.name ?? null,
          width: round2(tree.artboard?.frame?.width ?? detail.width),
          height: round2(tree.artboard?.frame?.height ?? detail.height),
          blocks,
        },
      };
    } catch (e) {
      return {
        skipped: {
          imageId: img.imageId, name: img.name, reason: auditSkipReason(e),
          error: String(e?.message ?? e).slice(0, LIMITS.auditErrorMax),
        },
      };
    }
  });
  const scans = results.filter((r) => r?.scan).map((r) => r.scan);
  const skipped = results.filter((r) => r?.skipped).map((r) => r.skipped);

  // ③ 命名基础 + 可靠度（**这一步决定后面出不出明细**）
  const comp = collectAuditComponents(scans);
  const naming = comp.naming;
  const totalBlocks = scans.reduce((n, s) => n + s.blocks.length, 0);
  const reliability = auditReliability({ imagesWithLayers: comp.imagesWithLayers, totalBlocks, naming });
  const reliable = reliability.reliable;
  // 不可靠**分两种**，下一步完全不同（"去把层名规范一下"和"这些稿本来就没有图层"是两件事）：
  //   · sample   —— 读到图层的稿太少 / 一个块都没有（多半是整页 jpg 图片型条目）；
  //   · naming   —— 有块，但块名大多是工具默认名。
  const primaryReason = reliable ? null
    : (comp.imagesWithLayers < LIMITS.auditMinImagesForAudit || totalBlocks === 0 ? 'sample' : 'naming');
  const allowWeak = Boolean(args.allowWeakNaming) && primaryReason === 'naming';
  // 不可靠时**默认一项都不出**；只有"命名不可靠"才能靠 allowWeakNaming 放开不看层名的那几项
  // （样本本身是空的时候放开也没有数据可出 —— 那只会印出一堆 0）。
  const suppressed = reliable ? [] : (allowWeak ? [...AUDIT_NAME_DEPENDENT] : [...AUDIT_CATEGORIES]);
  const show = (cat) => !suppressed.includes(cat);
  const suppressedPayload = () => ({ suppressed: true, drift: false, reason: reliability.reasons.join(' ') });

  const { findings: specFindings, converged } = show('componentSpec')
    ? auditComponentSpecs(comp.participated) : { findings: [], converged: null };
  const font = show('fontScale') ? auditFontScale(scans) : null;
  const colorMap = show('colorDrift') ? collectAuditColors(scans) : new Map();
  const colorEntries = [...colorMap.values()].sort((a, b) => b.count - a.count);
  const colorKept = colorEntries.slice(0, LIMITS.auditMaxColors);
  const clusters = show('colorDrift') ? nearColorClusters(colorKept) : [];
  const spacing = show('spacingScale') ? auditSpacing(scans) : null;
  const radius = show('radiusFamily') ? auditRadiusFamily(scans) : null;

  const findings = {
    componentSpec: show('componentSpec') ? {
      suppressed: false,
      drift: specFindings.length > 0,
      // **判据写进结果**：读者不必猜"你说的同一个组件是什么意思"
      basis: '层名归一化后相同（NFKC + 折叠空白 + 转小写）',
      basisExcludes: '工具默认名（Rectangle 12 / 矩形 3 / Path 3×8）、空名、归一化后 < 2 字的层名',
      findings: specFindings.slice(0, LIMITS.auditMaxFindings),
      findingCount: specFindings.length,
      truncatedFindings: Math.max(0, specFindings.length - LIMITS.auditMaxFindings),
      converged,
      participatedNames: comp.participated.length,
      participatedBlocks: comp.participatedBlocks,
      notParticipating: { autoName: naming.auto, emptyName: naming.empty, thin: comp.thinBlocks },
    } : { ...suppressedPayload(), findings: [], findingCount: 0, converged: null },
    fontScale: font ? { suppressed: false, ...font } : suppressedPayload(),
    colorDrift: show('colorDrift') ? {
      suppressed: false,
      drift: clusters.length > 0,
      threshold: LIMITS.auditNearColorDistance,
      metric: 'RGB 欧氏距离',
      scope: '只在**同一透明度**之间比较（实色与半透明不是同一个色值）',
      linkage: '完全链接：簇内**任意两个**都 ≤ 阈值（不是连通分量 —— 那会连成链，把"肉眼分不出"变成假话）',
      distinct: colorEntries.length,
      compared: colorKept.length,
      truncatedColors: Math.max(0, colorEntries.length - colorKept.length),
      clusters: clusters.slice(0, LIMITS.auditMaxFindings),
      clusterCount: clusters.length,
    } : suppressedPayload(),
    spacingScale: spacing ? { suppressed: false, ...spacing } : suppressedPayload(),
    radiusFamily: radius ? { suppressed: false, ...radius, note: '参考项：圆角刻度不是规范，只是"常见 4px 栅格圆角"的一份清单' } : suppressedPayload(),
  };

  const anyDrift = AUDIT_CATEGORIES.some((c) => show(c) && findings[c]?.drift === true);

  // 「未发现漂移」时要说**凭什么** —— 一句话给全每一类的收敛依据
  const noDriftBrief = [];
  if (show('componentSpec')) noDriftBrief.push(`${comp.participated.length} 个跨稿组件的圆角/高度各自收敛`);
  if (font) noDriftBrief.push(`${font.distinct} 种字号都在常用档上`);
  if (show('colorDrift')) noDriftBrief.push(`${colorEntries.length} 个色值两两 RGB 距离都 > ${LIMITS.auditNearColorDistance}`);
  if (spacing) noDriftBrief.push(`间距都在 ${spacing.grid} 的倍数上`);
  if (radius) noDriftBrief.push('圆角都在常见刻度上');

  // 跳过原因汇总（人读一行说清"哪些没扫成、为什么"）
  const skipBuckets = {};
  for (const s of skipped) skipBuckets[s.reason] = (skipBuckets[s.reason] ?? 0) + 1;
  const skippedBrief = Object.entries(skipBuckets)
    .map(([k, v]) => `${AUDIT_SKIP_LABEL[k] ?? k} ${v}`).join(' · ');

  const a = {
    ok: true,
    format: 'audit',
    projectId,
    projectName: listing.projectName ?? null,
    // 成本必须受控且**说得明白**：扫了多少 / 共多少 / 有没有被截断 / 上限是多少
    scanned: scans.length,
    attempted: selected.length,
    total,
    truncated: total > applied,
    limitRequested: requested,
    limitApplied: applied,
    limitClamped: requested > LIMITS.auditMaxImages,
    limitDefault: LIMITS.auditDefaultImages,
    limitHard: LIMITS.auditMaxImages,
    imagesWithLayers: comp.imagesWithLayers,
    blocks: totalBlocks,
    naming,
    reliable,
    reasons: reliability.reasons,
    primaryReason,
    weakMode: !reliable && allowWeak,
    suppressed,
    nameDependent: [...AUDIT_NAME_DEPENDENT],
    basis: {
      component: '层名归一化后相同（NFKC + 折叠空白 + 转小写）',
      minComponentImages: LIMITS.auditMinComponentImages,
      minComponentBlocks: LIMITS.auditMinComponentBlocks,
      minNamedShare: LIMITS.auditMinNamedShare,
    },
    findings,
    drift: Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c, findings[c]?.drift === true])),
    driftedCategories: AUDIT_CATEGORIES.filter((c) => show(c) && findings[c]?.drift === true),
    anyDrift,
    noDriftBrief,
    skipped,
    skippedBrief,
    skipBuckets,
    account: acct ?? null,
    accountBy: picked.by ?? null,
  };
  const text = renderAudit(a);
  a.text = acct ? `${text}\n\n— 账号：**${acct}**${picked.by === 'explicit' ? '（显式指定）' : `（自动判定 · ${picked.by}）`}` : text;
  a.textBytes = Buffer.byteLength(a.text, 'utf8');
  return a;
}

/* ---------------------------------------------------------------- 渲染 ---- */

/** 计数分布 → `8px（7 张）· 12px（3 张）`（值带单位、括号里是**张数**，不是块数）。 */
function spreadText(values, unit = 'px') {
  return (values ?? []).map((v) => `${v.value}${unit}（${v.imageCount} 张）`).join(' · ');
}

function spreadTextPlain(values, unit = '') {
  return (values ?? []).map((v) => `${v.value}${unit}（${v.count}）`).join(' · ');
}

/** 审计报告的抬头（扫描范围 / 命名基础 / 判据）。 */
function auditHeader(a) {
  const L = [];
  const n = a.naming ?? {};
  L.push(`# 设计系统审计 — ${a.projectName ?? a.projectId}`);
  L.push('');
  L.push(`· 扫描：**${a.scanned} / ${a.attempted} 张**已尝试、项目共 **${a.total}** 张`
    + (a.truncated
      ? ` → **已被上限截断**（本次上限 ${a.limitApplied}；默认 ${a.limitDefault}、硬上限 ${a.limitHard}）`
      : '（未截断）')
    + (a.limitClamped ? ` ⚠️ limit 传的 ${a.limitRequested} **被硬上限 ${a.limitHard} 压回**` : ''));
  L.push(`· 读到图层：${a.imagesWithLayers} 张 · 块 ${a.blocks} 个`
    + (a.skipped?.length ? ` · 跳过 ${a.skipped.length} 张（${a.skippedBrief}）` : ''));
  L.push(`· 命名基础：可靠块名 **${n.named}/${n.total}** 块（${Math.round((n.namedShare ?? 0) * 100)}%）· 工具默认名 ${n.auto} · 空名 ${n.empty}`);
  if (a.skipBuckets?.['no-layers']) {
    L.push(`> 注：其中 ${a.skipBuckets['no-layers']} 张**没有图层数据**（蓝湖里常见的"整页 jpg 图片型条目"）——`
      + '它们不进统计，也不等于这些稿没被扫到。');
  }
  if (a.skipBuckets?.['sketch-format']) {
    L.push(`> ⚠️ 另有 ${a.skipBuckets['sketch-format']} 张是**蓝湖 Sketch 插件格式**（\`type: sketchPlugin\`，图层在 \`info[]\` 里）`
      + '**且归一化后仍取不出可用子层** —— 已按与 `lanhu_read_blocks` **同一套**映射规则试图解析，仍为空，故单列一类、**没有被统计**。'
      + '（\`lanhu_read_blocks\` 对它们会**明说**"没读到任何图层"、不再静默给一个"只有画板"的空结果 —— 这是**已知空缺**，不是"这些不是设计稿"。）');
  }
  L.push(`· 判据：同一组件 = **${a.basis?.component}**；工具默认名（\`Rectangle 12\` / \`矩形 3\`）与空名**一律不认**（不硬凑）。`);
  return L;
}

/** 一个类别的正文（**不可靠时这里只出一行"已跳过"**）。 */
export function auditSectionLines(a, cat) {
  const f = a.findings?.[cat] ?? {};
  const idx = AUDIT_CATEGORIES.indexOf(cat);
  const L = [`## ${AUDIT_NUMERALS[idx] ?? idx + 1} ${AUDIT_CATEGORY_LABEL[cat]}`];
  if (f.suppressed) {
    L.push(`· 已跳过（${f.reason || '本次审计不可靠'}）`);
    L.push('');
    return L;
  }
  if (cat === 'componentSpec') {
    for (const e of f.findings ?? []) {
      for (const d of e.dims) {
        L.push(`· **${e.name}** ${d.label}：${spreadText(d.values)}${d.truncatedValues > 0 ? ` · …还有 ${d.truncatedValues} 种` : ''}`);
        L.push(d.tie
          ? `  → 各取值出现次数并列，**无法判定多数派** —— 需人工确认（共 ${d.total} 块）`
          : `  → 建议以 **${d.majority}px** 为准（多数派 ${d.majorityCount}/${d.total} 块）`);
        for (const v of d.values.slice(0, LIMITS.auditMaxExamples)) {
          L.push(`  · 例：${v.value}px → ${(v.examples ?? []).join('、')}${v.imageCount > (v.examples ?? []).length ? `（等 ${v.imageCount} 张）` : ''}`);
        }
      }
    }
    if ((f.findings ?? []).length === 0) L.push(`· **未发现漂移**：${f.participatedNames ?? 0} 个参与组件名的圆角与高度各自收敛。`);
    if (f.truncatedFindings > 0) L.push(`· …还有 ${f.truncatedFindings} 条同类发现（已达每条上限，只给计数）`);
    L.push(`· 参与：${f.participatedNames ?? 0} 个组件名 / ${f.participatedBlocks ?? 0} 块；`
      + `未参与：工具默认名 ${f.notParticipating?.autoName ?? 0} 块 · 空名 ${f.notParticipating?.emptyName ?? 0} 块 · 单张稿或样本太少 ${f.notParticipating?.thin ?? 0} 块`);
    return L;
  }
  if (cat === 'fontScale') {
    if (!f.drift) {
      L.push(`· **未发现漂移**：${f.distinct} 种字号（共 ${f.total} 处）都在常用档上`
        + `（阈值：种类 > ${LIMITS.auditHealthyFontSizes} 或 一次性野值 ≥ ${LIMITS.auditOneOffMinCount} 个）`);
      L.push(`· 阶梯：${spreadTextPlain(f.sizes, 'px')}`);
      return L;
    }
    L.push(`· 全项目 **${f.distinct}** 种字号（共 ${f.total} 处）：${spreadTextPlain(f.sizes, 'px')}${f.truncatedValues > 0 ? ` · …还有 ${f.truncatedValues} 种` : ''}`);
    if (f.oneOffCount > 0) {
      L.push(`· 只出现 ${LIMITS.auditOneOffMaxCount} 次的 **${f.oneOffCount}** 种：${f.oneOffs.map((o) => o.value).join(' / ')}`);
      const sug = f.oneOffs.filter((o) => o.nearest !== null);
      if (sug.length) L.push(`  → 建议收敛：${sug.map((o) => `${o.value}→${o.nearest}`).join('、')}（"常用档" = 出现 ≥ ${LIMITS.auditLadderMinCount} 次的字号）`);
      for (const o of f.oneOffs.slice(0, LIMITS.auditMaxExamples)) {
        L.push(`  · 例：${o.value}px → ${(o.examples ?? []).join('、')}`);
      }
    } else {
      L.push(`· 没有只出现 ${LIMITS.auditOneOffMaxCount} 次的野值；但**种类数 ${f.distinct} 超过常见台阶上限 ${LIMITS.auditHealthyFontSizes}** —— 阶梯偏长，可考虑合并相邻档。`);
    }
    L.push(`· 常用档（出现 ≥ ${LIMITS.auditLadderMinCount} 次）：${f.ladder.join(' / ') || '（无）'}`);
    return L;
  }
  if (cat === 'colorDrift') {
    L.push(`> 口径：${f.metric} ≤ ${f.threshold} 视为"肉眼分不出"；${f.scope}。`);
    L.push(`> 聚类：${f.linkage}。`);
    if (!f.drift) {
      L.push(`· **未发现漂移**：${f.distinct} 个色值两两 ${f.metric} 都 > ${f.threshold}（肉眼可分辨）`);
      return L;
    }
    for (const c of f.clusters) {
      L.push(`· ${c.members.map((m) => `${m.key}（${m.count} 块 / ${m.imageCount} 张${m.roles.length ? ` · ${m.roles.join('/')}` : ''}）`).join(' ≈ ')}`
        + ` · 组内**任意两个**都 ≤ ${c.maxDistance}（阈值 ${f.threshold}，肉眼分不出）`);
      L.push(c.majority
        ? `  → 建议统一为 **${c.majority}**（多数派；共 ${c.members.reduce((n, m) => n + m.count, 0)} 处）`
        : '  → 各值出现次数并列，**无法判定多数派** —— 需人工确认');
      const minor = c.members.filter((m) => m.key !== c.majority).slice(0, LIMITS.auditMaxExamples);
      for (const m of minor) L.push(`  · 例：${m.key} → ${(m.examples ?? []).join('、')}`);
    }
    if (f.clusterCount > f.clusters.length) L.push(`· …还有 ${f.clusterCount - f.clusters.length} 簇（已达上限，只给计数）`);
    L.push(`· 色板：${f.distinct} 个色值${f.truncatedColors > 0 ? `（只比了出现最多的 ${f.compared} 个）` : ''}`);
    return L;
  }
  if (cat === 'spacingScale') {
    L.push(`> 口径：几何相邻间距（另一轴有重叠），且只统计 ≤ ${f.maxDistance}px 的 —— 几百 px 的"间距"是版面留白，不是尺度。`);
    L.push(`> **参考项**：${f.grid}px 栅格是常见约定、不是硬规范（大屏 / 自由排版项目常常不在栅格上）—— 本项只报"有哪些值、哪些不在栅格上"，不下判决。`);
    if (!f.drift) {
      L.push(`· **未发现漂移**：${f.distinct} 个间距值（共 ${f.total} 条）都在 ${f.grid} 的倍数上`);
      if (f.top?.length) L.push(`· 主要尺度：${spreadTextPlain(f.top)}`);
      if (f.skippedImages) L.push(`· 有 ${f.skippedImages} 张稿块数过多（> ${LIMITS.auditSpacingMaxBlocks}）未参与间距统计`);
      return L;
    }
    L.push(`· 出现 ${f.distinct} 个间距值（共 ${f.total} 条）；不在 ${f.grid} 的倍数上的 **${f.offGridCount}** 个：${spreadTextPlain(f.offGrid)}`);
    for (const v of f.offGrid.slice(0, LIMITS.auditMaxExamples)) L.push(`  · 例：${v.value}px → ${(v.examples ?? []).join('、')}`);
    L.push(`· 主要尺度：${spreadTextPlain(f.top)}`);
    if (f.skippedImages) L.push(`· 有 ${f.skippedImages} 张稿块数过多（> ${LIMITS.auditSpacingMaxBlocks}）未参与间距统计`);
    return L;
  }
  // radiusFamily
  L.push(`· 出现 ${f.distinct} 个圆角值（共 ${f.total} 处）：${spreadTextPlain(f.top)}`);
  if (!f.drift) L.push(`· **未发现特例**：都在常见刻度上（${f.scale.join('/')}）`);
  else {
    L.push(`· 不在常见刻度上的 **${f.offScaleCount}** 个（**参考项，不是错误**）：${spreadTextPlain(f.offScale)}`);
    for (const v of f.offScale.slice(0, LIMITS.auditMaxExamples)) L.push(`  · 例：${v.value}px → ${(v.examples ?? []).join('、')}`);
  }
  return L;
}

/**
 * 审计报告 → 人读文本。
 *
 * ⚠️ `reliable === false` 时**默认不出任何明细** —— 那是本功能最重要的一条纪律：
 * 按不可靠的层名归组得到的"5 种圆角"，会被 AI 当成事实去改代码。
 */
export function renderAudit(a) {
  const L = auditHeader(a);
  const active = AUDIT_CATEGORIES.filter((c) => !(a.suppressed ?? []).includes(c));
  if (!a.reliable && active.length === 0) {
    L.push('');
    L.push('⚠️ **本项审计不可靠 —— 不出明细。**');
    for (const r of a.reasons ?? []) L.push(`· ${r}`);
    if (a.primaryReason === 'naming') {
      L.push('· 为什么不出明细：跨稿"同一组件"的判据是**层名**；名字大多是工具默认名时，'
        + '按它归组会得到"5 种圆角"这种**看着精确、其实认错组件**的结论 —— 比不给更糟。');
      L.push('· 下一步：① 让设计师把关键组件（主按钮 / 卡片 / 标签…）的层名规范化后重跑；'
        + '② 只想看**不依赖层名**的那几项（字号阶梯 / 近重复色 / 间距 / 圆角）→ 传 `allowWeakNaming: true`，'
        + '那时只会出这几项，并明确标注「组件规格一项已跳过」。');
    } else {
      L.push('· 为什么不出明细：这项审计要**能读到图层**的稿当样本。'
        + '图层的圆角 / 字号 / 色值 / 间距在一张位图里根本不存在 —— 那里没有"设计系统"可谈，'
        + '硬报出来的数字只能是编的。');
      L.push('· 下一步：① 换一个**有图层数据**的项目，或让设计师把这些页面导出成设计稿（Figma / Sketch 源）后重跑；'
        + '② 这些条目在蓝湖里就是整页图片 —— `lanhu_read_blocks` / `lanhu_download_slices` 同样拿不到图层数据，'
        + '要还原得从设计源文件入手。');
    }
    return L.join('\n');
  }
  if (!a.reliable) {
    L.push('');
    L.push(`⚠️ **本次审计不可靠（${(a.reasons ?? []).join(' ')}）**`);
    L.push(`· 依赖层名的「${AUDIT_CATEGORY_LABEL.componentSpec}」**已跳过**；`
      + `下面只有 ${active.map((c) => AUDIT_CATEGORY_LABEL[c]).join(' / ')} —— 它们只看块的属性，不看层名。`);
  } else if (!a.anyDrift) {
    L.push('');
    L.push(`**未发现漂移**：${(a.noDriftBrief ?? []).join(' · ')}。`);
  }
  L.push('');
  for (const cat of AUDIT_CATEGORIES) {
    L.push(...auditSectionLines(a, cat));
    L.push('');
  }
  while (L.length && L[L.length - 1] === '') L.pop();
  return L.join('\n');
}

/* ==========================================================================
 * 7. 切图
 * ========================================================================== */

/**
 * 下载设计稿切图。
 * 图层树顶层 `assets[]` 是该稿的全部切图 URL（实测 32 个）。
 * 去重三层：URL → 文件名 → 内容 sha256。
 */
/* ==========================================================================
 * 7.5 图片元信息（零依赖手写解析）
 *
 * 为什么切图必须带 alpha 范围：设计稿的整页背景常是**半透明 PNG** ——
 * 实测 某大屏 的 `BG` 是 7680×4320 RGBA，**alpha 132~255**，衬底是画板 fill `#004687`。
 * 直接 `sips -s format jpeg` 会把 alpha 丢掉：半透明暗色光丝变成不透明内容、深蓝衬底消失，
 * **整屏发灰发白**；更误导的是图片查看器默认合到白底，看着像"设计稿本来就是浅色的"。
 * 多带一行 `alpha: [132, 255]`，调用方当场就知道**不能直接转格式**。
 * ========================================================================== */

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** PIL 风格的 mode —— 和设计/前端同学口头说的 'RGBA' / 'RGB' / 'P' 对齐。 */
const PNG_MODES = { 0: 'L', 2: 'RGB', 3: 'P', 4: 'LA', 6: 'RGBA' };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}

/** 就地反滤波一行（PNG 的 5 种 filter）。 */
function unfilterRow(ft, cur, prev, bpp, stride) {
  if (ft === 0) return;
  if (ft === 1) { for (let i = bpp; i < stride; i++) cur[i] = (cur[i] + cur[i - bpp]) & 0xff; return; }
  if (ft === 2) { for (let i = 0; i < stride; i++) cur[i] = (cur[i] + prev[i]) & 0xff; return; }
  if (ft === 3) {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xff;
    }
    return;
  }
  if (ft === 4) {
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
    }
  }
}

/** 读 PNG 结构（IHDR / tRNS / PLTE / IDAT）。 */
function readPng(buf) {
  const out = { ihdr: null, trns: null, idat: [] };
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) break; // 截断文件：别越界
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      out.ihdr = {
        width: data.readUInt32BE(0), height: data.readUInt32BE(4),
        bitDepth: data[8], colorType: data[9], interlace: data[12],
      };
    } else if (type === 'tRNS') out.trns = Buffer.from(data);
    else if (type === 'IDAT') out.idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  return out;
}

/**
 * 统计 PNG 的 alpha 范围（min/max）。
 * 逐行反滤波、只保留「当前行 + 前一行」⇒ 内存 O(宽)，不会把 7680×4320 整张摊在堆里。
 * 只处理 8 位非隔行（蓝湖导出的常态）；其它情况老实说"没解析"，**不编造范围**。
 */
function pngAlphaRange(png) {
  const { ihdr, trns, idat } = png;
  if (!ihdr || idat.length === 0) return { supported: false, reason: '缺少 IHDR/IDAT' };
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  const ch = PNG_CHANNELS[colorType];
  if (bitDepth !== 8 || interlace !== 0 || !ch) {
    return { supported: false, reason: `bitDepth=${bitDepth} interlace=${interlace} 未支持` };
  }
  const stride = width * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // 调色板的 alpha 在 tRNS 里（第 i 字节 = 索引 i 的 alpha）；colorType 0/2 的 tRNS 是 colorkey
  const palAlpha = colorType === 3 && trns ? trns : null;
  const usedIdx = palAlpha ? new Set() : null;
  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  let min = 255, max = 0, counted = false;
  let off = 0;
  for (let y = 0; y < height && off < raw.length; y++) {
    const ft = raw[off++];
    raw.copy(cur, 0, off, off + stride);
    off += stride;
    unfilterRow(ft, cur, prev, ch, stride);
    if (colorType === 6) {
      for (let i = 3; i < stride; i += 4) { const v = cur[i]; if (v < min) min = v; if (v > max) max = v; }
      counted = true;
    } else if (colorType === 4) {
      for (let i = 1; i < stride; i += 2) { const v = cur[i]; if (v < min) min = v; if (v > max) max = v; }
      counted = true;
    } else if (usedIdx) {
      for (let i = 0; i < stride; i++) usedIdx.add(cur[i]);
    }
    const t = prev; prev = cur; cur = t;
  }
  if (usedIdx) {
    if (usedIdx.size === 0) return { supported: true, alphaRange: null, hasAlpha: false };
    for (const i of usedIdx) {
      const v = i < palAlpha.length ? palAlpha[i] : 255;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    counted = true;
  }
  if (!counted) {
    // 无 alpha 通道；colorType 0/2 的 tRNS 是 colorkey（只透明掉某一个颜色）
    return { supported: true, alphaRange: null, hasAlpha: Boolean(trns) };
  }
  return { supported: true, alphaRange: [min, max], hasAlpha: min < 255 };
}

/** JPEG 的 SOF 段给宽高（JPEG 无 alpha 通道）。 */
function jpegMeta(buf) {
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { off += 2; continue; }
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const comps = buf[off + 9];
      return {
        width: buf.readUInt16BE(off + 5), height: buf.readUInt16BE(off + 7),
        mode: comps === 1 ? 'L' : comps === 4 ? 'CMYK' : 'RGB',
        hasAlpha: false, alphaRange: null,
      };
    }
    off += 2 + len;
  }
  return null;
}

/**
 * SVG 是**矢量图**：没有位图 alpha 通道，但**同样不能"顺手转格式"** ——
 * 栅格化成 JPG/PNG 会丢清晰度。实测蓝湖一张首页导出的切图里 46 张有 23 张是 SVG，
 * mode 留空会让人以为"这些图没信息"，所以至少要标出来。
 */
function svgMeta(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
  if (!/<svg[\s>]/i.test(head)) return null;
  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(head);
    return m ? m[1] : null;
  };
  const num = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    // 只认绝对尺寸（纯数字或带 px）。"100%" / "2em" 这类**不是**像素值，交给 viewBox 兜底 ——
    // parseFloat('100%') = 100，直接用会把百分比当成像素（实测被自检断言抓住）。
    if (!/^-?\d+(\.\d+)?(px)?$/i.test(s)) return null;
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  };
  let width = num(attr('width'));
  let height = num(attr('height'));
  const vb = attr('viewBox'); // width 常写成 "100%"，这时用 viewBox 兜底
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every(Number.isFinite)) {
      if (width === null) width = p[2];
      if (height === null) height = p[3];
    }
  }
  return { format: 'svg', width: width ?? null, height: height ?? null, mode: 'vector', hasAlpha: null, alphaRange: null };
}

/**
 * 图片元信息 —— 切图落盘时一并记录，省得调用方自己再开一次图。
 * ⚠️ 所有字段保证是 JSON 合法值（未知一律 `null`，**绝不放 undefined** —— 宿主会拒收整个结果）。
 * @returns {{format:string,width:number|null,height:number|null,mode:string|null,hasAlpha:boolean|null,alpha:number[]|null,note?:string}}
 */
export function imageMeta(buf) {
  const blank = { format: 'unknown', width: null, height: null, mode: null, hasAlpha: null, alphaRange: null };
  if (!buf || buf.length < 12) return blank;
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    const png = readPng(buf);
    const h = png.ihdr;
    if (!h) return { ...blank, format: 'png' };
    let alphaRange = null, hasAlpha = null, note = null;
    try {
      const st = pngAlphaRange(png);
      if (st.supported) {
        alphaRange = st.alphaRange ?? null;
        hasAlpha = alphaRange ? alphaRange[0] < 255 : Boolean(st.hasAlpha);
      } else {
        note = `未能解析 alpha（${st.reason}）`;
      }
    } catch (e) {
      note = `alpha 解析失败：${e?.message ?? String(e)}`;
    }
    return {
      format: 'png', width: h.width, height: h.height,
      mode: PNG_MODES[h.colorType] ?? null, hasAlpha, alphaRange,
      ...(note ? { note } : {}),
    };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const m = jpegMeta(buf);
    return m ? { format: 'jpeg', ...m } : { ...blank, format: 'jpeg' };
  }
  if (buf.toString('latin1', 0, 3) === 'GIF' && buf.length >= 10) {
    return {
      format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8),
      mode: 'P', hasAlpha: buf.toString('latin1', 3, 6) === '89a', alphaRange: null,
    };
  }
  if (buf[0] === 0x3c) { // '<' —— SVG / XML
    const s = svgMeta(buf);
    if (s) return s;
  }
  return blank;
}

export async function downloadSlices(args = {}) {
  const { projectId, imageId, url, cookie, outDir, concurrency = 6 } = args;
  const target = resolveTarget({ projectId, imageId, url });
  const picked = await pickAccount({ ...args, projectId: target.projectId, imageId: target.imageId, teamId: target.teamId });
  const acct = picked.alias;
  const { detail, tree, sourceFormat, unsupported } = await fetchDesignTree(target.projectId, target.imageId, {
    cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  // ⭐ 「解析不出图层」→ **明说**，不许返回"下载了 0 张、一切正常"这种看着像成功的结果：
  //    对着认不出的树，`tree.assets` 必然是空的，`ok:true, downloaded:0` 只会让人以为"这张稿没有切图"。
  if (unsupported) {
    const meta = { name: detail?.name ?? null, projectId: target.projectId, imageId: target.imageId, width: detail?.width ?? null, height: detail?.height ?? null, account: acct ?? null };
    const text = renderDesignUnsupported(unsupported, meta);
    return {
      ok: false, unsupported: true, sourceFormat: unsupported.format, code: unsupported.code,
      downloaded: 0, skipped: 0, dir: null, files: [], backgroundColor: null, warnings: [], translucent: [],
      projectId: target.projectId, imageId: target.imageId, account: acct ?? null,
      note: `这张稿**没能解析出图层**（${unsupported.what}），所以拿不到切图清单 —— `
        + '**这不等于"这张稿没有切图"**。详见下方 text。',
      text,
    };
  }
  const urls = [...new Set((tree.assets ?? []).filter((u) => typeof u === 'string'))];

  if (urls.length === 0) {
    return {
      ok: true, downloaded: 0, skipped: 0, dir: null, files: [], backgroundColor: null, warnings: [], translucent: [],
      ...(sourceFormat ? { sourceFormat } : {}),
      note: sourceFormat === 'sketchPlugin'
        // 能解析、但确实没有可导出图 —— 与"解析不出来"是**两回事**，这里说清是哪一种。
        ? '这是**蓝湖 Sketch 插件导出**的稿子，已正常解析出图层，但它没有标记为切图的图层（`bitmap` / 带 `image.imageUrl` 的组都没有），所以资产清单为空。'
        : '该稿没有可导出的切图（assets 为空）。',
    };
  }

  const dir = outDir ?? path.join(process.cwd(), 'assets', 'lanhu');
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  const seenHash = new Map();
  let skipped = 0;

  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (u) => {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) return { u, error: `HTTP ${res.status}` };
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0) return { u, error: '空响应' };
        const hash = createHash('sha256').update(buf).digest('hex');
        const ext = (path.extname(new URL(u).pathname) || '.png').toLowerCase();
        return { u, buf, hash, ext };
      } catch (e) {
        return { u, error: e?.message ?? String(e) };
      }
    }));

    for (const r of results) {
      if (r.error) { files.push({ url: r.u, error: r.error }); continue; }
      if (seenHash.has(r.hash)) { skipped += 1; files.push({ url: r.u, file: seenHash.get(r.hash), duplicateOf: seenHash.get(r.hash), hash: r.hash }); continue; }
      const name = `${String(detail.name ?? 'slice').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 40)}-${r.hash.slice(0, 8)}${r.ext}`;
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, r.buf);
      seenHash.set(r.hash, name);
      // ⚠️ 元信息在这里**顺序**解析（不放进上面的 Promise.all）：
      //    解析大图要 inflate，峰值内存可达解压后尺寸；并发解析几张 4K 图会把内存顶爆。
      files.push({ url: r.u, file: name, bytes: r.buf.length, hash: r.hash, ...imageMeta(r.buf) });
    }
  }

  // 画板 fill 就是半透明切图的**衬底色**（设计稿 BG 叠在画板色上）。
  // 有了它，调用方才知道该拿什么颜色做 alpha 合成，而不是合到白底（白底 = 整屏发灰）。
  const fillRaw = (tree.artboard?.style?.fills ?? []).find((f) => f.type === 'color' && f.color && f.isEnabled !== false);
  const fillParsed = fillRaw ? parseColor(fillRaw.color) : null;
  const backgroundColor = fillParsed ? rgbHex(fillParsed) : null;

  const translucent = files.filter((f) => f.alphaRange && f.alphaRange[0] < 255);
  const warnings = [];
  if (translucent.length > 0) {
    // 逐张列出（只给个"23 张含半透明"没用 —— 调用方要知道**是哪几张、范围多少**才好决定怎么处理）
    warnings.push([
      `⚠️ ${translucent.length} 张切图**含半透明**：转 JPG/JPEG 会丢 alpha，页面整屏发灰发白；`,
      '   而且图片查看器默认合到白底，**看起来挺正常**，肉眼查不出来。',
      ...translucent.slice(0, 8).map((f) => `   · ${f.file}  alpha ${f.alphaRange[0]}~${f.alphaRange[1]}`),
      translucent.length > 8 ? `   · … 其余 ${translucent.length - 8} 张见 mapping.json 的 \`translucent\`` : '',
      backgroundColor
        ? `   衬底 = 画板底色 **${backgroundColor}**：先做 alpha 合成再转格式（PIL: \`Image.alpha_composite(base, im)\`）。`
        : '   衬底通常 = 画板 fill 色，请先做 alpha 合成再转格式。',
    ].filter(Boolean).join('\n'));
  }

  const svgCount = files.filter((f) => f.format === 'svg').length;
  if (svgCount > 0) {
    warnings.push(`ℹ️ 其中 ${svgCount} 张是 **SVG 矢量图**（mode=vector）：直接引用原文件或内联进页面，**别栅格化成 JPG/PNG**（会丢清晰度）；它们不涉及 alpha 合成。`);
  }

  // B3 · 切图密度：`实际像素 ÷ 渲染尺寸` < 目标倍率 就是**素材本身不够清晰**。
  // 配对只在"渲染尺寸 × sliceScale = 期望像素"**唯一命中**时成立（实测 tree.assets 只有裸 URL，
  // 没有 render_bounds，也没有与图层 id 的对应关系）—— 宁可留 null 也不配错。
  const sliceScale = tree.meta?.sliceScale ?? null;
  const targetDpr = Number(args.targetDpr ?? sliceScale ?? 2) || 2;
  const layerList = flattenArtboard(tree.artboard ?? tree);
  const pairs = matchAssetsToLayers(
    files.map((f) => ({ url: f.url, width: f.width, height: f.height })),
    layerList, sliceScale,
  );
  for (let i = 0; i < files.length; i += 1) {
    const pair = pairs[i] ?? {};
    const d = assetDensity({
      pixelWidth: files[i].width, pixelHeight: files[i].height,
      renderWidth: pair.renderWidth, renderHeight: pair.renderHeight,
      isVector: files[i].format === 'svg', targetDpr,
    });
    files[i] = { ...files[i], matchedLayerId: pair.layerId ?? null, matchedLayerName: pair.layerName ?? null, matchReason: pair.reason ?? null, density: d };
  }
  const limited = files.filter((f) => f.density?.resolutionLimited && f.density?.effectiveDensity);
  if (limited.length) {
    warnings.push([
      `⚠️ ${limited.length} 张切图**分辨率不够**（有效密度 < 目标 ${targetDpr}×）：素材本身就不清晰，改引用方式没用。`,
      ...limited.slice(0, 6).map((f) => `   · ${f.file}  ${f.density.effectiveDensity.x}×${f.density.effectiveDensity.y}（${f.width}px / 渲染 ${f.matchedLayerName ?? '?'}）`),
      '   要么让设计师重导 @2x/@3x，要么接受它在高分屏上发虚。',
    ].join('\n'));
  }

  const mapping = {
    name: detail.name,
    imageId: target.imageId,
    projectId: target.projectId,
    fetchedAt: new Date().toISOString(),
    /** 画板 fill —— 半透明切图的合成衬底色 */
    backgroundColor,
    /** 需要人/模型**当场看到**的提醒（含半透明、矢量图等） */
    warnings,
    /** 含半透明切图清单（文件 + alpha 范围）—— 给程序化消费用 */
    translucent: translucent.map((f) => ({ file: f.file, alphaRange: f.alphaRange })),
    /** 版本透明度（B1）：切图也要能追溯"这是哪一版导出的" */
    version: { id: detail.versionId ?? null, requested: detail.versionRequested ?? 'latest', isLatest: detail.versionIsLatest ?? null, count: detail.versionCount ?? null, fromUrl: detail.versionFromUrl ?? false, urlVersionIgnored: detail.urlVersionIgnored ?? null },
    /** B3 判据的输入：设计稿自带的切图倍率与本次目标倍率 */
    sliceScale,
    targetDpr,
    /** B3 汇总：`null`=一张都没评估（本通道缺 render_bounds），`[]`=评估过且都达标。见 densityLimitedOf */
    densityLimited: densityLimitedOf(files, limited),
    unique: seenHash.size,
    total: urls.length,
    files,
  };
  const mappingPath = path.join(dir, 'mapping.json');
  fs.writeFileSync(mappingPath, JSON.stringify(mapping, null, 2));

  return {
    ok: true,
    dir,
    mappingPath,
    // 稿子的来源格式（只在非空时加键：普通稿的返回体逐字节不变）
    ...(sourceFormat ? { sourceFormat } : {}),
    account: acct ?? null,
    accountBy: picked.by ?? null,
    downloaded: seenHash.size,
    skipped,
    failed: files.filter((f) => f.error).length,
    assets: urls.length,
    backgroundColor,
    warnings,
    /** 只列含半透明的：调用方一眼看到"哪些图不能直转格式" */
    translucent: translucent.map((f) => ({ file: f.file, alphaRange: f.alphaRange, mode: f.mode, width: f.width ?? null, height: f.height ?? null })),
    files: files.filter((f) => f.file && !f.duplicateOf).map((f) => ({
      file: f.file, bytes: f.bytes,
      width: f.width ?? null, height: f.height ?? null,
      mode: f.mode ?? null, hasAlpha: f.hasAlpha ?? null, alphaRange: f.alphaRange ?? null,
    })),
    duplicates: files.filter((f) => f.duplicateOf).map((f) => f.url),
  };
}

/* ==========================================================================
 * 8. 设计稿验收（浏览器真机比对）
 *
 * 引擎优先级：puppeteer-core（驱动系统已装 Chrome）→ Playwright → 静态比对。
 *
 * 为什么首选 puppeteer-core 而不是 Playwright：
 *   Playwright 在 macOS 12 及更早版本装不上它自带的 Chromium（playwright issue
 *   #7555 / #13964，错误是 "is not supported on macOS 12"）。而 puppeteer-core
 *   不下载任何浏览器二进制，直接驱动系统里已有的 Chrome，所以在老 macOS 上照样能跑。
 *   实测：puppeteer-core 2.1.1 + Chrome 150.0.7871.125 正常启动并取到 getComputedStyle。
 * ========================================================================== */

/** CJS 包经 import() 会包一层 default；不解开就会出现 pw.chromium === undefined。 */
function unwrapModule(mod) {
  const d = mod && mod.default;
  if (d && (typeof d.launch === 'function' || d.chromium)) return d;
  return mod;
}

/** macOS 12（Monterey，darwin 21.x）及更早：Playwright 的 Chromium 不可用。 */
export function isLegacyMac() {
  if (process.platform !== 'darwin') return false;
  const major = parseInt(String(os.release()).split('.')[0], 10);
  return Number.isFinite(major) && major < 22;
}

/**
 * Playwright 在本平台是否**已知不可能**跑起来（对应实战反馈 P7）。
 *
 * 上游明确不支持 macOS 12 + arm64 的 chromium（报错 `does not support chromium on mac12-arm64`），
 * 实测 npx / npmmirror 镜像同样拒绝；更坑的是 `install` 会 **exit 0 但缓存目录为空**，
 * 于是"到底装上没有"要排查三步。这里直接判死并给出原因，不再静默尝试、也不再提示去 install。
 * 返回 null 表示平台没被判定为不支持，正常走 Playwright 分支。
 */
export function playwrightUnsupported() {
  if (!isLegacyMac()) return null;
  const macMajor = parseInt(String(os.release()).split('.')[0], 10) - 9; // darwin 21 → macOS 12
  return `Playwright 不支持 macOS ${macMajor} + ${process.arch} 的 Chromium`
    + `（上游报错 "does not support chromium on mac${macMajor}-${process.arch}"，npx 与镜像源同样拒绝）。`
    + '这是上游限制，**重试 install 不会成功**，且它可能 exit 0 而缓存目录为空（易误判成"装好了只是没跑起来"）。'
    + '无需下载任何浏览器：puppeteer-core 驱动系统 Chrome 即可。';
}

/** 系统里可直接被 puppeteer-core 驱动的浏览器（Chrome 系即可，不限于 Chrome）。 */
export const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ],
};

/** 找系统 Chrome/Chromium。返回可执行文件绝对路径，找不到返回 null。 */
export function findChrome() {
  const env = process.env.LANHU_CHROME || process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  for (const p of CHROME_CANDIDATES[process.platform] ?? []) {
    if (fs.existsSync(p)) return p;
  }
  // macOS 上应用可能装在 ~/Applications
  if (process.platform === 'darwin') {
    for (const rel of ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(os.homedir(), 'Applications', rel);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** puppeteer-core 的候选安装位置（按可信度从高到低）。 */
function puppeteerRoots() {
  const roots = [];
  // ① 从 cwd 逐级向上找项目内的 node_modules —— 用户 npm i -D puppeteer-core 后的主路径
  let dir = process.cwd();
  for (let i = 0; i < 12; i += 1) {
    roots.push(path.join(dir, 'node_modules'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // ② 全局 npm root（同步取，失败就算了）
  try {
    const { execFileSync } = nodeRequire('node:child_process');
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000 }).trim());
  } catch { /* 继续 */ }
  // ③ npx 缓存：npx 跑过一次后包只留在 ~/.npm/_npx/<hash>/node_modules
  try {
    const npxBase = path.join(os.homedir(), '.npm', '_npx');
    for (const d of fs.readdirSync(npxBase)) {
      const nm = path.join(npxBase, d, 'node_modules');
      if (fs.existsSync(nm)) roots.push(nm);
    }
  } catch { /* 继续 */ }
  // ④ 兜底：IDE 扩展自带的 node_modules（本机 markdown-pdf 扩展带了一个可用的）。
  //    路径随扩展版本/编辑器变化，不算稳定来源，只作为"不装也能立刻跑"的兜底。
  try {
    for (const ide of ['.vscode', '.trae', '.cursor', '.windsurf', '.vscode-insiders']) {
      const extDir = path.join(os.homedir(), ide, 'extensions');
      if (!fs.existsSync(extDir)) continue;
      for (const ext of fs.readdirSync(extDir)) {
        const nm = path.join(extDir, ext, 'node_modules');
        if (fs.existsSync(path.join(nm, 'puppeteer-core'))) roots.push(nm);
      }
    }
  } catch { /* 继续 */ }
  return roots;
}

/** 动态解析 puppeteer-core，找不到返回 null（触发降级），不抛异常。 */
export async function loadPuppeteer() {
  const fromPath = async (p) => {
    try { return unwrapModule(await import(pathToFileURL(p).href)); } catch { return null; }
  };
  // ① 显式指定
  if (process.env.LANHU_PUPPETEER) {
    const hit = await fromPath(process.env.LANHU_PUPPETEER);
    if (hit) return { mod: hit, from: process.env.LANHU_PUPPETEER };
  }
  // ② 裸 import（用户项目里装了，或插件被装进某个有它的 node_modules 树）
  for (const c of ['puppeteer-core', 'puppeteer']) {
    try {
      const mod = unwrapModule(await import(c));
      // 顺带把真实解析路径带出来，报告里能看到用的是哪一份
      let from = c;
      try { from = nodeRequire.resolve(c); } catch { /* 拿不到就用包名 */ }
      return { mod, from };
    } catch { /* 继续 */ }
  }
  // ③ 路径候选
  for (const root of puppeteerRoots()) {
    for (const c of ['puppeteer-core', 'puppeteer']) {
      const base = path.join(root, c);
      if (!fs.existsSync(base)) continue;
      for (const entry of ['lib/esm/puppeteer/puppeteer-core.js', 'lib/cjs/puppeteer/puppeteer-core.js', 'index.js']) {
        const p = path.join(base, entry);
        if (!fs.existsSync(p)) continue;
        const hit = await fromPath(p);
        if (hit && typeof hit.launch === 'function') return { mod: hit, from: p };
      }
      const hit = await fromPath(base);
      if (hit && typeof hit.launch === 'function') return { mod: hit, from: base };
    }
  }
  return null;
}

/** 动态解析 playwright，找不到就返回 null（触发降级），不抛异常。 */
export async function loadPlaywright() {
  const candidates = ['playwright', 'playwright-core'];
  for (const c of candidates) {
    try { return unwrapModule(await import(c)); } catch { /* 继续 */ }
  }

  // 依次尝试：全局 npm root → npx 缓存。
  // 实测：npx playwright 跑过一次后，包只留在 ~/.npm/_npx/<hash>/node_modules，
  // 全局 node_modules 里并没有它 —— 只搜全局会漏。
  const roots = [];
  try {
    const { execFileSync } = await import('node:child_process');
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 20000 }).trim());
  } catch { /* 继续 */ }
  try {
    const npxBase = path.join(os.homedir(), '.npm', '_npx');
    for (const dir of fs.readdirSync(npxBase)) {
      const nm = path.join(npxBase, dir, 'node_modules');
      if (fs.existsSync(nm)) roots.push(nm);
    }
  } catch { /* 继续 */ }

  for (const root of roots) {
    for (const c of candidates) {
      const p = path.join(root, c, 'index.js');
      if (fs.existsSync(p)) {
        try { return unwrapModule(await import(pathToFileURL(p).href)); } catch { /* 继续 */ }
      }
    }
  }
  return null;
}

/** 浏览器获取/安装提示，按平台给不同的正确命令。 */
export const BROWSER_INSTALL_HINT = isLegacyMac()
  ? '本机是 macOS 12 或更早 —— Playwright 的 Chromium 装不上，请用 puppeteer-core 驱动系统 Chrome：\n'
    + '  npm i -D puppeteer-core        # 在项目里装（插件会自动从项目 node_modules 找到它）\n'
    + '  或 npm i -g puppeteer-core     # 全局装\n'
    + '只要 /Applications/Google Chrome.app 在，它就能跑；也可用 LANHU_CHROME=/path/to/chrome 指定。'
  : 'npm i -D puppeteer-core   # 推荐：直接驱动系统 Chrome，不下载浏览器\n'
    + '或 npm i -g playwright && npx playwright install chromium\n'
    + '（playwright 包与 chromium 二进制是两件事：装了包仍可能因为没装浏览器而启动失败）';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一两套浏览器 API 的建页差异。
 * puppeteer：browser.newPage() + page.setViewport()，并且没有 waitForTimeout
 * playwright：browser.newPage({viewport}) + page.waitForTimeout()
 * 这里统一成「建页并设好视口」，等待一律用 sleep()。
 */
export async function openPage(browser, engine, viewport) {
  const page = await browser.newPage();
  if (engine === 'playwright') {
    await page.setViewportSize(viewport);
  } else {
    await page.setViewport({ ...viewport, deviceScaleFactor: 2 });
  }
  return page;
}

/** 启动浏览器：先 puppeteer-core + 系统 Chrome，再 Playwright。返回 {engine,browser,source} 或 {error}。 */
export async function launchBrowser() {
  const errors = [];

  // ① puppeteer-core + 系统已装 Chrome —— 首选
  const pptr = await loadPuppeteer();
  if (pptr) {
    const exe = findChrome();
    if (exe === null) {
      errors.push(`找到 puppeteer-core（${pptr.from}）但系统里没找到 Chrome，请安装 Chrome 或用 LANHU_CHROME 指定路径`);
    } else {
      try {
        const browser = await pptr.mod.launch({
          executablePath: exe,
          headless: true,
          args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        });
        return { engine: 'puppeteer', browser, source: `puppeteer-core(${pptr.from}) + ${exe}` };
      } catch (e) {
        errors.push(`puppeteer-core 启动 Chrome 失败：${e.message}`);
      }
    }
  } else {
    errors.push('未找到 puppeteer-core');
  }

  // ② Playwright（自己带浏览器）—— 平台已知不支持就直接判死：
  //    不试、不提示 install，把上游限制原样写进报告，省掉"到底装没装上"的反复排查。
  const pwBlocked = playwrightUnsupported();
  if (pwBlocked) {
    errors.push(pwBlocked);
  } else {
    const pw = await loadPlaywright();
    if (pw && pw.chromium) {
      try {
        const browser = await pw.chromium.launch({ headless: true });
        return { engine: 'playwright', browser, source: 'playwright' };
      } catch (e) {
        errors.push(`Playwright 浏览器启动失败：${e.message}`);
      }
    } else {
      errors.push('未找到 Playwright');
    }
  }

  return { error: errors.join('；') };
}

function parseCssColor(v) {
  if (!v) return null;
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(v);
  if (m) return { r: clamp255(+m[1]), g: clamp255(+m[2]), b: clamp255(+m[3]), a: m[4] === undefined ? 1 : clamp01(+m[4]) };
  const h = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (h) return { r: parseInt(h[1].slice(0, 2), 16), g: parseInt(h[1].slice(2, 4), 16), b: parseInt(h[1].slice(4, 6), 16), a: 1 };
  if (v.trim() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

/** 拉取页面源码：HTML + 内联样式 + 外链 CSS（最多 20 个），供无浏览器时的静态比对使用。 */
export async function fetchPageSource(pageUrl) {
  const readUrl = async (u) => {
    if (u.startsWith('file://')) return fs.readFileSync(new URL(u), 'utf8');
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new LanhuError(`拉取页面失败：HTTP ${r.status}`);
    return r.text();
  };
  const html = await readUrl(pageUrl);
  const cssUrls = [...html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((h) => /\.css(\?|$)/i.test(h));
  const parts = [html];
  for (const href of cssUrls.slice(0, 20)) {
    try { parts.push(await readUrl(new URL(href, pageUrl).href)); } catch { /* 单个 CSS 失败就跳过 */ }
  }
  return parts.join('\n');
}

/**
 * 静态比对（无 Playwright / 无浏览器时的降级路径）。
 * 只做「CSS 声明级」比对：页面源码里出现过哪些色值/字号，与设计稿 token 对照。
 * 不做元素绑定，也没有 getComputedStyle 的继承与计算 —— 这是明确的能力边界，报告里会写明。
 */
export async function staticCompare(design, pageUrl) {
  let src;
  try {
    src = await fetchPageSource(pageUrl);
  } catch (e) {
    return {
      ok: false, degraded: true, reason: `无法读取页面源码：${e.message}`,
      matchRate: 0, matched: 0, total: 0, rows: [],
      text: `❌ 无法读取页面源码：${e.message}`,
    };
  }

  const pageHexes = new Set([...src.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => '#' + m[1].toLowerCase()));
  for (const m of src.matchAll(/rgba?\([^)]+\)/gi)) {
    const c = parseColor(m[0]);
    if (c) pageHexes.add(rgbHex(c));
  }
  const pageSizes = new Set([...src.matchAll(/font-size\s*:\s*([\d.]+)px/gi)].map((m) => parseFloat(m[1])));
  const pageRadii = new Set([...src.matchAll(/border-radius\s*:\s*([\d.]+)px/gi)].map((m) => parseFloat(m[1])));

  const designColors = design.tokens.colors;
  const designHexSet = new Set(designColors.map((c) => c.hex));
  const rows = [];

  for (const c of designColors) {
    const hit = pageHexes.has(c.hex);
    rows.push({ element: '(设计稿色板)', field: 'color', expected: c.hex, actual: hit ? '页面已使用' : '页面未使用', verdict: hit ? '✅' : '⚠️ 未使用', suggestion: hit ? '' : '设计稿有该色但页面没用到：可能漏了，或用了近似色' });
  }
  for (const hex of pageHexes) {
    if (!designHexSet.has(hex)) {
      rows.push({ element: '(页面自造)', field: 'color', expected: '(不在设计稿色板)', actual: hex, verdict: '❌ 自造色', suggestion: '页面用了设计稿里没有的颜色，应改回 token' });
    }
  }
  for (const f of design.tokens.fontSizes) {
    const hit = pageSizes.has(f.size);
    rows.push({ element: '(设计稿字号)', field: 'font-size', expected: `${f.size}px`, actual: hit ? '页面已使用' : '页面未使用', verdict: hit ? '✅' : '⚠️ 未使用', suggestion: '' });
  }
  for (const s of pageSizes) {
    if (!design.tokens.fontSizes.some((f) => Math.abs(f.size - s) < 0.5)) {
      rows.push({ element: '(页面自造)', field: 'font-size', expected: '(设计稿无此字号)', actual: `${s}px`, verdict: '❌', suggestion: '页面字号不在设计稿字号集合里' });
    }
  }
  for (const f of design.tokens.radii) {
    const hit = pageRadii.has(f.radius);
    rows.push({ element: '(设计稿圆角)', field: 'border-radius', expected: `${f.radius}px`, actual: hit ? '页面已使用' : '页面未使用', verdict: hit ? '✅' : '⚠️ 未使用', suggestion: '' });
  }

  const total = rows.length;
  const matched = rows.filter((r) => r.verdict === '✅').length;
  const rate = total ? Math.round((matched / total) * 1000) / 10 : 0;

  const L = [];
  L.push(`# 设计稿验收（静态比对）— ${design.name ?? ''} vs ${pageUrl}`);
  L.push('');
  L.push('> ⚠️ 未能启动浏览器：以下为 **CSS 声明级**比对——只看页面源码里出现过哪些色值/字号，');
  L.push('> 不绑定具体元素，也没有 `getComputedStyle` 的继承与计算。要精确到元素请补装浏览器（见文末）。');
  L.push('');
  L.push(`- 对齐率：${matched}/${total}（${rate}%）`);
  L.push(`- 设计稿：色 ${designColors.length} 个 / 字号 ${design.tokens.fontSizes.length} 种 / 圆角 ${design.tokens.radii.length} 种`);
  L.push(`- 页面：色 ${pageHexes.size} 个 / 字号 ${pageSizes.size} 种 / 圆角 ${pageRadii.size} 种`);
  L.push('');
  L.push('## 不一致');
  L.push('| 来源 | 字段 | 设计稿 | 页面 | 判据 | 建议 |');
  L.push('|---|---|---|---|---|---|');
  const bad = rows.filter((r) => r.verdict !== '✅');
  if (bad.length === 0) L.push('| — | — | — | — | 全部对齐 | — |');
  for (const r of bad) L.push(`| ${r.element} | ${r.field} | ${r.expected} | ${r.actual} | ${r.verdict} | ${r.suggestion ?? ''} |`);
  L.push('');
  L.push('## 补齐真机比对');
  L.push('```bash');
  L.push(BROWSER_INSTALL_HINT);
  L.push('```');

  // ok 的判据只看「页面自造」（❌）——「设计稿有而页面未用」是信息项：
  // 一个页面不可能用到整稿的每个色值，把它算成不合格会让报告永远红。
  const selfMade = rows.filter((r) => r.verdict.startsWith('❌')).length;
  return { ok: selfMade === 0, degraded: true, name: design.name, pageUrl, matchRate: rate, matched, total, selfMade, rows, text: L.join('\n') };
}

/**
 * 设计稿 ↔ 页面 比对。
 * 期望值来自图层树；实际值来自页面 getComputedStyle。
 * @param {{projectId?:string,imageId?:string,url?:string,pageUrl:string,selectors?:Record<string,string>,cookie?:string,outDir?:string}} args
 */
export async function verifySpec(args = {}) {
  const { pageUrl, selectors } = args;
  if (!pageUrl) throw new LanhuError('verify 需要 pageUrl（要验收的本地页面地址）。');

  const design = await readDesign({ ...args, format: 'full' });

  const launch = await launchBrowser();
  if (launch.error) {
    const stat = await staticCompare(design, pageUrl);
    return {
      ...stat,
      degraded: true,
      reason: `未能启动浏览器（${launch.error}）。已改做**静态比对**（只比 CSS 声明里的色值与字号，不含 getComputedStyle）。`,
      install: BROWSER_INSTALL_HINT,
    };
  }
  const { engine, browser, source } = launch;

  const expected = {
    colors: design.tokens.colors.map((c) => c.hex),
    fontSizes: design.tokens.fontSizes.map((f) => f.size),
    radii: design.tokens.radii.map((r) => r.radius),
  };

  const page = await openPage(browser, engine, {
    width: design.viewport.width || 375,
    height: design.viewport.height || 812,
  });
  const rows = [];
  try {
    // H5 hash 路由（#/pages/xxx）用 networkidle 容易空等超时；domcontentloaded + 短暂等待更稳。
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(900);

    const textProbe = [...new Set(design.textList ?? [])].slice(0, 24);
    const targets = selectors && Object.keys(selectors).length > 0
      ? Object.entries(selectors)
      : await page.evaluate((texts) => {
        const out = {};
        // ① 显式标注优先
        document.querySelectorAll('[data-lanhu]').forEach((el) => {
          const k = el.getAttribute('data-lanhu');
          if (k) out[k] = `[data-lanhu="${k.replace(/"/g, '\\"')}"]`;
        });
        if (Object.keys(out).length > 0) return out;
        // ② 退回：按设计稿的文本内容自动匹配叶子节点 —— 降低真机比对门槛，不用手工标注
        for (const t of texts) {
          if (!t) continue;
          const el = [...document.querySelectorAll('body *')].find(
            (e) => e.children.length === 0 && e.textContent && e.textContent.trim() === t,
          );
          if (el) {
            el.setAttribute('data-lanhu-auto', t);
            out[`text:${t}`] = `[data-lanhu-auto="${t.replace(/"/g, '\\"')}"]`;
          }
        }
        return out;
      }, textProbe);

    if (Object.keys(targets).length === 0) {
      return {
        ...baseReport(design, pageUrl, rows, { engine, source }),
        ok: false,
        note: '页面上没找到可比对的元素。三条路：① 给元素加 data-lanhu 属性；② 显式传 selectors；③ 确认页面文本与设计稿一致（当前会按设计稿文本自动匹配）。',
      };
    }

    for (const [label, selector] of Object.entries(targets)) {
      const actual = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          color: cs.color, backgroundColor: cs.backgroundColor, fontSize: cs.fontSize,
          fontWeight: cs.fontWeight, fontFamily: cs.fontFamily,
          borderRadius: cs.borderRadius, width: r.width, height: r.height, x: r.x, y: r.y,
        };
      }, selector);
      if (actual === null) { rows.push({ element: label, field: '(缺失)', expected: '—', actual: '选择器未命中', verdict: '未映射' }); continue; }
      rows.push(...compareOne(label, design, actual));
    }
  } finally {
    await browser.close();
  }

  return baseReport(design, pageUrl, rows, { engine, source });
}

function baseReport(design, pageUrl, rows, meta = {}) {
  const total = rows.length;
  const matched = rows.filter((r) => r.verdict === '✅').length;
  const mismatched = rows.filter((r) => r.verdict !== '✅' && r.verdict !== '未映射');
  return {
    ok: mismatched.length === 0,
    name: design.name,
    pageUrl,
    viewport: design.viewport,
    engine: meta.engine,
    browserSource: meta.source,
    matchRate: total === 0 ? 0 : Math.round((matched / total) * 1000) / 10,
    matched, total,
    rows,
    text: renderVerifyReport(design, pageUrl, rows, matched, total, meta),
  };
}

function compareOne(label, design, actual) {
  const rows = [];
  const push = (field, expected, actualValue, verdict, suggestion) =>
    rows.push({ element: label, field, expected, actual: actualValue, verdict, suggestion });

  const bg = parseCssColor(actual.backgroundColor);
  if (bg && bg.a > 0) {
    const hex = rgbHex(bg);
    const hit = design.tokens.colors.some((c) => c.hex === hex);
    push('background-color', hit ? hex : `(不在色板) ${hex}`, hex, hit ? '✅' : '⚠️ 色板外', hit ? '' : '该色不在设计稿色板中，走 token 对齐');
  }
  const fg = parseCssColor(actual.color);
  if (fg) {
    const hex = rgbHex(fg);
    const hit = design.tokens.colors.some((c) => c.hex === hex);
    push('color', hit ? hex : `(不在色板) ${hex}`, hex, hit ? '✅' : '⚠️ 色板外', hit ? '' : '改回设计稿色值');
  }
  const fs = parseFloat(actual.fontSize);
  if (Number.isFinite(fs)) {
    const hit = design.tokens.fontSizes.some((f) => Math.abs(f.size - fs) < 0.5);
    push('font-size', hit ? `${fs}px` : `(设计稿无此字号) ${fs}px`, `${fs}px`, hit ? '✅' : '❌', hit ? '' : `设计稿字号：${design.tokens.fontSizes.map((f) => f.size).join('/')}`);
  }
  const fw = String(actual.fontWeight);
  if (fw) {
    const known = design.tokens.fontWeights.some((w) => String(w.weight) === fw);
    push('font-weight', known ? fw : `(设计稿无此字重) ${fw}`, fw, known ? '✅' : '⚠️', '');
  }
  // 字体族：页面 font-family 栈的**前 3 位**必须命中设计稿字体集 —— 字号对、字体全错也是 ❌
  const fams = design.tokens.fontFamilies ?? [];
  const stack = String(actual.fontFamily ?? '')
    .split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  if (fams.length > 0 && stack.length > 0) {
    const head = stack.slice(0, 3);
    const hitHead = head.find((s) => fams.some((f) => familyKey(f.family) === familyKey(s)));
    const tailIdx = stack.findIndex((s, i) => i >= 3 && fams.some((f) => familyKey(f.family) === familyKey(s)));
    if (hitHead) {
      push('font-family', hitHead, head.join(', '), '✅', '');
    } else if (tailIdx >= 0) {
      push('font-family', `${stack[tailIdx]}（排在第 ${tailIdx + 1} 位）`, head.join(', '), '🟡',
        `把 ${stack[tailIdx]} 提到 font-family 栈的前 3 位`);
    } else {
      const top = fams[0]?.family ?? '';
      // 同理：建议的回退栈里剔掉设计稿字体集里的项（避免"改了等于没改"）
      const rest = stack.filter((s) => !fams.some((f) => familyKey(f.family) === familyKey(s))).slice(0, 2);
      push('font-family',
        `设计稿字体集：${fams.slice(0, 3).map((f) => f.family).join(' / ')}`,
        head.join(', '), '❌',
        `改成 font-family: ${top}${rest.length ? `, ${rest.join(', ')}` : ''}`);
    }
  }
  const radius = /([\d.]+)px/.exec(actual.borderRadius);
  if (radius) {
    const r = parseFloat(radius[1]);
    const hit = r === 0 || design.tokens.radii.some((x) => Math.abs(x.radius - r) <= 1);
    push('border-radius', `${r}px`, `${r}px`, hit ? '✅' : '❌', hit ? '' : `设计稿圆角：${design.tokens.radii.map((x) => x.radius).join('/')}`);
  }
  return rows;
}

function renderVerifyReport(design, pageUrl, rows, matched, total, meta = {}) {
  const L = [];
  L.push(`# 设计稿验收 — ${design.name ?? ''} vs ${pageUrl}`);
  L.push('');
  L.push(`- 匹配率：${matched}/${total} 字段（${total === 0 ? 0 : Math.round((matched / total) * 1000) / 10}%）`);
  L.push(`- 视口：${design.viewport.width}×${design.viewport.height}`);
  if (meta.engine) L.push(`- 引擎：${meta.engine}${meta.source ? `（${meta.source}）` : ''}`);
  L.push('');
  const bad = rows.filter((r) => r.verdict !== '✅');
  L.push('## 不一致（按严重度）');
  L.push('| 元素 | 字段 | 设计稿 | 实际 | 判据 | 建议 |');
  L.push('|---|---|---|---|---|---|');
  if (bad.length === 0) L.push('| — | — | — | — | 全部一致 | — |');
  for (const r of bad) L.push(`| ${r.element} | ${r.field} | ${r.expected} | ${r.actual} | ${r.verdict} | ${r.suggestion ?? ''} |`);
  L.push('');
  L.push('## 全部比对');
  L.push('| 元素 | 字段 | 设计稿 | 实际 | 结果 |');
  L.push('|---|---|---|---|---|');
  for (const r of rows) L.push(`| ${r.element} | ${r.field} | ${r.expected} | ${r.actual} | ${r.verdict} |`);
  return L.join('\n');
}

/* ==========================================================================
 * 8.5 块级比对（方案 §1.2–1.5：块 → 页面元素 → 六项属性 → 四态报告）
 *
 * 与上面 verifySpec 的区别：
 *   verifySpec 比的是**文本层**（抽样），只覆盖色值/字号；
 *   这里比的是**全部可见块**，且覆盖六项：圆角 / 大小 / 文字色 / 字号 / 有无底色 / 边框。
 *
 * 元素映射三级（方案 §1.2）：
 *   ① 页面显式标注 `[data-lanhu="块名"]`
 *   ② 文本内容匹配（叶子节点文本完全相等）
 *   ③ **几何最近邻兜底** —— 没有这一级，头像 / 卡片背景 / 分割线这些无文本块永远进不了比对
 * ========================================================================== */

/** 判定容差（方案 §1.3 的口径，单位：折算后的 px）。 */
/* ==========================================================================
 * 8.5 字体族比对（2026-09-20 需求）
 *
 * 只比 `font-size` 会让"字号对、字体全错"判成**匹配** —— 验收通过但观感完全不对。
 * 难点全在**避免误报**，所以：三条归一化 + 一个宽松判定。
 *   ① 去引号、去全部空白、大小写不敏感；
 *   ② `YouSheBiaoTiHei-Regular` ≡ `YouSheBiaoTiHei`（Figma 的 `Family-Style` 写法）；
 *   ③ **不要求字符串相等** —— 设计稿字体名出现在页面 `font-family` 栈的**前 N 位**即算通过。
 *      页面栈天然带系统回退字体（`-apple-system` / `Microsoft YaHei`…），要求全等会把**每一个正确页面**判错。
 * ========================================================================== */

/** 字体名的版本尾巴（Figma 的 `Family-Style` 写法与纯 family 名等价）。 */
const FAMILY_STYLE_TAIL = /-(regular|normal|book|roman|medium|demibold|semibold|bold|black|heavy|light|thin|extralight|ultralight|italic|oblique)$/i;

/** 字体名归一化（**只用于比较**，不用于展示）。 */
export function normalizeFamily(name) {
  return String(name ?? '')
    .replace(/["']/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 比较用的键：归一化 + 去样式尾巴 + 去版本尾巴。 */
export function familyKey(name) {
  return normalizeFamily(name)
    .replace(FAMILY_STYLE_TAIL, '')
    // ⚠️ 版本尾巴 `.0` 也必须剥掉：三张表里显示的是 `shortFamily()` 的**短名**（`Alibaba PuHuiTi 2.0` → `Alibaba PuHuiTi 2`），
    //    而判定拿的是设计稿**原名** —— 不剥就会出现「写全名 ✅、照表抄短名 ❌」的假阴性，
    //    还会给出 `font-family: Alibaba PuHuiTi 2.0, Alibaba PuHuiTi 2` 这种把同一字体列两遍、**等于没改**的建议（实测踩过）。
    //    ⚠️ **只剥 `.0`**：`Alibaba PuHuiTi 2`（v2）与 `Alibaba PuHuiTi`（v1）是**不同字体**（该稿两者并存），不能合并。
    .replace(/\.0$/, '');
}

/**
 * 页面 `font-family` 栈的**前 `depth` 位**里有没有设计稿字体。
 * @returns {{ok:boolean,index:number,stack:string[],depth:number}} `index` 为 -1 表示栈里根本没有
 */
export function familyInStack(designFamily, pageStack, depth = 3) {
  const stack = String(pageStack ?? '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  const want = familyKey(designFamily);
  const index = stack.findIndex((s) => familyKey(s) === want);
  return { ok: index >= 0 && index < depth, index, stack, depth };
}

export const BLOCK_TOLERANCE = {
  radius: 1,        // 圆角 ±1px
  size: 2,          // 宽高 ±2px
  sizeText: 3,      // 纯文本块放宽到 ±3px
  fontSize: 1,      // 字号 ±1px
  geometry: 28,     // 几何匹配的接受阈值（距离超过就不认）
  colorNear: 14,    // 感知色差（redmean 近似）≤ 这个值算"接近"
  fontStackDepth: 3, // 字体族：设计稿字体要出现在页面 font-family 栈的前 N 位
};

/**
 * 在**浏览器里**执行的采样脚本：把每个可见元素的实际计算样式取回来。
 * ⚠️ 必须自包含（puppeteer 会把它序列化后注入），不能引用任何外部变量。
 */
export const PAGE_SAMPLER = function samplePageForLanhu() {
  const out = [];
  const nodes = document.querySelectorAll('body *');
  for (let i = 0; i < nodes.length; i += 1) {
    const el = nodes[i];
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;

    // 自己的直接文本（不含子元素）—— 文本匹配要用它，避免父容器把整段文字都算上
    let own = '';
    for (let n = 0; n < el.childNodes.length; n += 1) {
      const c = el.childNodes[n];
      if (c.nodeType === 3) own += c.nodeValue;
    }
    const radii = String(cs.borderTopLeftRadius || '0').split(/\s+/).map(function (v) { return parseFloat(v) || 0; });

    out.push({
      tag: el.tagName.toLowerCase(),
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      w: r.width,
      h: r.height,
      text: own.trim(),
      fullText: String(el.textContent || '').trim().slice(0, 100),
      color: cs.color,
      background: cs.backgroundColor,
      fontSize: parseFloat(cs.fontSize) || 0,
      fontWeight: cs.fontWeight,
      fontFamily: cs.fontFamily,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      radiusRaw: String(cs.borderRadius || ''),
      borders: {
        top: { w: parseFloat(cs.borderTopWidth) || 0, color: cs.borderTopColor, style: cs.borderTopStyle },
        right: { w: parseFloat(cs.borderRightWidth) || 0, color: cs.borderRightColor, style: cs.borderRightStyle },
        bottom: { w: parseFloat(cs.borderBottomWidth) || 0, color: cs.borderBottomColor, style: cs.borderBottomStyle },
        left: { w: parseFloat(cs.borderLeftWidth) || 0, color: cs.borderLeftColor, style: cs.borderLeftStyle }
      },
      dataLanhu: el.getAttribute('data-lanhu') || null,
      className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      id: el.id || '',
      _radii: radii
    });
  }
  return out;
};

/** 页面元素采样的结果归一化（补默认值，免得下游到处判空）。 */
export function normalizePageElements(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((e, i) => ({
    index: i,
    tag: e.tag ?? 'div',
    x: Number(e.x) || 0,
    y: Number(e.y) || 0,
    w: Number(e.w) || 0,
    h: Number(e.h) || 0,
    text: typeof e.text === 'string' ? e.text : '',
    fullText: typeof e.fullText === 'string' ? e.fullText : '',
    color: e.color ?? null,
    background: e.background ?? null,
    fontSize: Number(e.fontSize) || 0,
    fontWeight: e.fontWeight ?? null,
    fontFamily: e.fontFamily ?? null,
    radius: Number(e.radius) || 0,
    borders: e.borders ?? null,
    dataLanhu: e.dataLanhu ?? null,
    className: e.className ?? '',
    id: e.id ?? '',
  }));
}

/** 感知加权色差（redmean 近似），比裸欧氏距离更接近人眼。 */
function colorDistance(a, b) {
  const rm = (a.r + b.r) / 2;
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

function colorOf(cssValue) {
  if (!cssValue) return null;
  const c = parseColor(cssValue);
  if (!c || c.a === 0) return null;
  return c;
}

/**
 * 几何距离：中心点距离 + 半权重的尺寸差。
 *
 * ⚠️ **块的坐标本来就是相对画板的**（flattenArtboard 的注释实测过：画板 left=-10279，子层 left=155.5），
 *    所以**不要**再减画板原点 —— 我一开始想当然减了一次，结果 16 变成 10295，全部几何匹配失效。
 *    `origin` 参数只在坐标系异常时需要，默认不参与换算。
 */
function geometryDistance(block, el, scale, origin) {
  const bx = (block.x - (origin?.x ?? 0)) * scale;
  const by = (block.y - (origin?.y ?? 0)) * scale;
  const bw = block.w * scale;
  const bh = block.h * scale;
  const centerD = Math.hypot((bx + bw / 2) - (el.x + el.w / 2), (by + bh / 2) - (el.y + el.h / 2));
  const sizeD = Math.abs(bw - el.w) + Math.abs(bh - el.h);
  return centerD + sizeD * 0.5;
}

/**
 * 块 ↔ 页面元素：三级映射。
 * @returns {Array<{block, element, matchedBy, evidence}>}
 */
export function matchBlocks(blocks, elements, opts = {}) {
  const scale = Number(opts.scale) || 1;
  const origin = opts.origin ?? { x: 0, y: 0 };   // 一般保持 0：块坐标已经是相对画板的
  const tol = { ...BLOCK_TOLERANCE, ...(opts.tolerance ?? {}) };

  // ⚠️ 占用状态要**按用途分开**：
  //    页面里 `<div class="chip">正常</div>` 这种「容器样式 + 文字」写在一个元素上非常常见，
  //    它**同时**是容器块的落点、也是文本块的落点。用一个 used 集合会让后到的那个块永远匹配不上
  //    （实测：Contact Button 因为文字块先占走了按钮元素而变成 ⚪）。
  const usedAsContainer = new Set();
  const usedAsText = new Set();
  const out = [];

  // ⚠️ **大块优先**：设计稿的层级比页面细（按钮里还有图标、文字），
  //    若按原顺序匹配，按钮内部的小图元会先把"按钮元素"抢走，真正的按钮块反而变成 ⚪（实测踩过）。
  //    同时加尺寸比例约束 —— 尺寸差 4 倍以上就不认为是同一个东西。
  const ordered = [...blocks].sort((a, c) => (c.w * c.h) - (a.w * a.h));
  const sizeCompatible = (bw, bh, ew, eh) => {
    const rw = Math.min(bw, ew) / Math.max(bw, ew || 1);
    const rh = Math.min(bh, eh) / Math.max(bh, eh || 1);
    return rw >= 0.25 && rh >= 0.25;
  };

  for (const b of ordered) {
    if (b.kind === 'artboard') continue;              // 画板本身不对应页面元素
    const isText = b.kind === 'text';
    const pool = isText ? usedAsText : usedAsContainer;
    let el = null;
    let matchedBy = null;
    let evidence = null;

    // ① 显式标注
    if (b.name) {
      el = elements.find((e) => e.dataLanhu && (e.dataLanhu === b.name || e.dataLanhu === b.path)) ?? null;
      if (el) { matchedBy = 'data-lanhu'; evidence = `[data-lanhu="${el.dataLanhu}"]`; }
    }
    // ② 文本匹配（只对文本块；容器块没有自己的文本）
    if (!el && isText && b.text) {
      const wanted = String(b.text).trim();
      el = elements.find((e) => !pool.has(e) && e.text && e.text === wanted) ?? null;
      if (el) { matchedBy = 'text'; evidence = `文本「${wanted}」`; }
    }
    // ③ 几何最近邻兜底（无文本块唯一的出路）
    if (!el) {
      let best = null;
      let bestD = Infinity;
      for (const e of elements) {
        if (pool.has(e)) continue;
        if (!sizeCompatible(b.w * scale, b.h * scale, e.w, e.h)) continue;
        const d = geometryDistance(b, e, scale, origin);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best && bestD <= tol.geometry) {
        el = best;
        matchedBy = 'geometry';
        evidence = `位置最近（距离 ${Math.round(bestD)}px）`;
      }
    }

    if (el) pool.add(el);
    out.push({ block: b, element: el, matchedBy, evidence });
  }
  // 匹配时按面积排序，**输出恢复原顺序**（报告读起来跟设计稿一致）
  const order = new Map(blocks.map((b, i) => [b.uid, i]));
  out.sort((a, c) => (order.get(a.block.uid) ?? 0) - (order.get(c.block.uid) ?? 0));
  return out;
}

/** 报告里显示块名：没名字就用「类型 + 尺寸」兜底，免得出现空白行。 */
export function blockLabel(b) {
  const n = (b.name ?? '').trim();
  if (n) return n;
  return `${BLOCK_KINDS[b.kind] ?? b.kind} ${Math.round(b.w)}×${Math.round(b.h)}`;
}

/** 把 px 折算成目标端写法，便于报告给"可直接抄的值"。 */
function toTarget(px, target, opts = {}) {
  if (px === null || px === undefined) return null;
  const v = Math.round(px * 100) / 100;
  if (target === 'mini') {
    const base = Number(opts.rpxBase) || 750;
    const designW = Number(opts.designWidth) || 375;
    return `${Math.round((v / designW) * base)}rpx`;
  }
  return `${v}px`;
}

/** ① 圆角（含"胶囊 vs 全圆"的视觉等价判定）。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpRadius(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ① 圆角
  if (block.radius) {
    const exp = block.radius.max * scale;
    const act = el.radius;
    const diff = Math.abs(exp - act);
    // ⚠️ 不能只比数值：CSS 会把超过短边一半的圆角 clamp 成"全圆"，
    //    所以设计稿 38px 与页面 14px 在 26px 高的按钮上**渲染结果完全相同**（都是胶囊）。
    //    方案 §1.3 要的是"胶囊与普通圆角必须区分开"，不是"数值必须照抄"——
    //    因此：数值一致 → ✅；都渲染成胶囊但数值不同 → 🟡（视觉等价）；页面不是胶囊 → ❌。
    const expPill = block.radius.pill || block.radius.max >= Math.min(block.w, block.h) / 2 - 0.5;
    const actPill = act >= Math.min(el.w, el.h) / 2 - 0.5;
    let verdict;
    if (diff <= tol.radius) verdict = '✅';
    else if (expPill && actPill) verdict = '🟡';
    else verdict = '❌';
    const suggestion = verdict === '✅' ? ''
      : (verdict === '🟡'
        ? `设计稿 ${block.radius.max}px${expPill ? '（全圆）' : ''}，当前 ${act}px — 此尺寸下同样渲染为全圆，视觉一致；若要照抄数值改 ${toTarget(exp, target, opts)}`
        : `改成 border-radius: ${toTarget(exp, target, opts)}${expPill ? '（或更大的值做成全圆）' : ''}`);
    add('border-radius',
      `${block.radius.max}${block.radius.pill ? '(全圆)' : ''} → ${toTarget(exp, target, opts)}`,
      `${act}px${actPill ? '(全圆)' : ''}`,
      verdict, suggestion);
  }

}


/** ② 大小 w×h（文本块用更宽的容差）。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpSize(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ② 大小 w×h
  const expW = block.w * scale;
  const expH = block.h * scale;
  const isText = block.kind === 'text';
  const sizeTol = isText ? tol.sizeText : tol.size;
  const dW = Math.abs(expW - el.w);
  const dH = Math.abs(expH - el.h);
  {
    // ⚠️ 文本块只比**宽度**：设计稿的文本框高度是 Figma 的行盒（含行高与上下留白），
    //    和浏览器的渲染盒天然对不齐（实测差 30px 以上很常见）。高度差异降级成 🟡 信息项，
    //    否则每一条文本都是假 ❌，真问题会被淹没。
    let verdict;
    if (isText) {
      // 文本块的尺寸降级为信息项：Figma 的文本框宽高都不是"渲染盒"，
      // 差几像素是常态（实测 64×52 的文本框对应 56×20 的渲染盒）。
      // 只有差到离谱（一边不到另一边的 60%）才判 ❌ —— 那通常意味着选错了元素。
      const ratioW = Math.min(expW, el.w) / Math.max(expW, el.w || 1);
      const ratioH = Math.min(expH, el.h) / Math.max(expH, el.h || 1);
      verdict = (ratioW >= 0.6 && ratioH >= 0.35) ? ((dW === 0 && dH === 0) ? '✅' : '🟡') : '❌';
    } else {
      verdict = (dW <= sizeTol && dH <= sizeTol) ? ((dW === 0 && dH === 0) ? '✅' : '🟡') : '❌';
    }
    const hint = isText && verdict !== '❌'
      ? `宽度差 ${Math.round(dW)}px${dH > sizeTol ? `（高度差 ${Math.round(dH)}px 属文本框差异，忽略）` : ''}`
      : (verdict === '❌' ? `设计稿 ${Math.round(expW)}×${Math.round(expH)}（差 ${Math.round(dW)}/${Math.round(dH)}px）` : '');
    add('大小', `${Math.round(expW)}×${Math.round(expH)}`, `${Math.round(el.w)}×${Math.round(el.h)}`, verdict, hint);
  }

}


/** ③ 文字色。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpTextColor(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ③ 文字色
  if (block.color) {
    const exp = parseColor(block.color);
    const act = colorOf(el.color);
    if (!act) {
      add('color', block.color, '取不到', '⚪', '');
    } else {
      const d = colorDistance(exp, act);
      const actHex = rgbHex(act);
      const verdict = d === 0 ? '✅' : (d <= tol.colorNear ? '🟡' : '❌');
      add('color', block.color, actHex, verdict, verdict === '❌' ? `改成 color: ${block.color}` : '');
    }
  }

}


/** ④ 字号（字重随行输出）。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpFontWeight(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ④ 字号（字重随行输出）
  if (block.font && block.font.size) {
    const exp = block.font.size * scale;
    const act = el.fontSize;
    const d = Math.abs(exp - act);
    const verdict = d === 0 ? '✅' : (d <= tol.fontSize ? '🟡' : '❌');
    add('font-size',
      `${block.font.size} → ${toTarget(exp, target, opts)}`,
      `${act}px`,
      verdict,
      verdict === '❌' ? `改成 font-size: ${toTarget(exp, target, opts)}` : '');
    if (block.font.weight) {
      const ok = String(el.fontWeight) === String(block.font.weight);
      add('font-weight', String(block.font.weight), String(el.fontWeight), ok ? '✅' : '❌', ok ? '' : `改成 font-weight: ${block.font.weight}`);
    }
    // ⑤ 字体族 —— 只比字号会让"字号对、字体全错"判成匹配（验收过了，但观感完全不对）
    if (block.font.family) {
      const m = familyInStack(block.font.family, el.fontFamily, tol.fontStackDepth);
      let verdict, suggestion = '';
      if (m.ok) verdict = '✅';
      else if (m.index >= 0) {
        verdict = '🟡';
        suggestion = `该字体在栈里排第 ${m.index + 1} 位，容易被更前面的字体盖住；建议提到前 ${m.depth} 位`;
      } else {
        verdict = '❌';
        // 回退栈里要**剔除与设计稿等价的项**（同一字体的不同写法），
        // 否则会写出 `...Alibaba PuHuiTi 2.0, Alibaba PuHuiTi 2` 这种列两遍、等于没改的建议（实测踩过）。
        const rest = m.stack.filter((s) => familyKey(s) !== familyKey(block.font.family)).slice(0, 2);
        suggestion = `改成 font-family: ${block.font.family}${rest.length ? `, ${rest.join(', ')}` : ''}`;
      }
      add('font-family', block.font.family, m.stack.slice(0, 3).join(', ') || '取不到', verdict, suggestion);
    }
  }

}


/** ⑤ 有无底色。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpFill(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ⑤ 有无底色
  {
    const expBg = block.bg;
    const actBg = colorOf(el.background);
    if (!expBg && !actBg) {
      add('background', '无底色', '无底色', '✅', '');
    } else if (!expBg && actBg) {
      add('background', '无底色', rgbHex(actBg), '❌', '设计稿这里没有底色，页面多加了');
    } else if (expBg && !actBg) {
      add('background', expBg.hex, '无底色', '❌', `补上 background: ${expBg.hex}`);
    } else {
      const exp = parseColor(expBg.hex);
      const d = colorDistance(exp, actBg);
      const actHex = rgbHex(actBg);
      const verdict = d === 0 ? '✅' : (d <= tol.colorNear ? '🟡' : '❌');
      add('background', expBg.hex, actHex, verdict, verdict === '❌' ? `改成 background: ${expBg.hex}` : '');
    }
  }

}


/** ⑥ 边框 / 分割线。`ctx = { scale, tol, target, add, rows }`（由 compareBlockProps 组装）。 */
function cmpBorder(block, el, ctx) {
  const { scale, tol, target, add, rows, opts } = ctx;
  // ⑥ 边框 / 分割线
  {
    const exp = block.border;
    const bs = el.borders ?? {};
    const sides = ['top', 'right', 'bottom', 'left'];
    const actHas = sides.filter((k) => (bs[k]?.w ?? 0) > 0 && bs[k]?.style !== 'none');
    if (!exp && actHas.length === 0) {
      add('border', '无边框', '无边框', '✅', '');
    } else if (!exp && actHas.length > 0) {
      add('border', '无边框', `${actHas.join('+')} 有边框`, '❌', '设计稿这里没有边框，页面多加了');
    } else if (exp && actHas.length === 0) {
      // 案例 2：分割线整条丢失 —— 这条必须能报出来
      add('border',
        `${exp.color} ${exp.width}px ${exp.sides.join('+')}${exp.single ? '(单边＝分割线)' : ''}`,
        '无边框',
        '❌',
        exp.single ? `补上 border-${exp.single}: ${exp.width}px solid ${exp.color}` : `补上边框 ${exp.width}px solid ${exp.color}`);
    } else {
      const missing = exp.sides.filter((k) => !actHas.includes(k));
      const first = exp.sides[0];
      const actW = bs[first]?.w ?? 0;
      const actColor = colorOf(bs[first]?.color);
      // 设计稿这一侧没给颜色（colorKnown=false）时**跳过颜色比对**，
      // 只比「哪几边 + 多粗」—— 否则会把 null 当成"颜色不对"，报一堆无从修改的假 ❌。
      const colorKnown = exp.colorKnown !== false && Boolean(exp.color);
      const expColor = colorKnown ? parseColor(exp.color) : null;
      const colorOk = !colorKnown || (actColor ? colorDistance(expColor, actColor) <= tol.colorNear : false);
      const widthOk = Math.abs(exp.width * scale - actW) <= 0.75;
      const verdict = (missing.length === 0 && colorOk && widthOk) ? '✅' : '❌';
      const expText = `${exp.color ?? '(无颜色)'} ${exp.width}px ${exp.sides.join('+')}`;
      add('border', expText, `${bs[first]?.color ?? '?'} ${actW}px ${actHas.join('+')}`, verdict,
        verdict === '❌'
          ? `${missing.length ? `缺 ${missing.join('+')} 边；` : ''}应改成 ${exp.width * scale}px solid ${exp.color ?? '(设计稿未给颜色)'}`
          : '');
    }
  }
}


/**
 * **块级六项属性逐项比对** —— 编排器：只组装 ctx、依次调用比较器。
 *
 * 每个属性一个比较器（`cmpRadius` / `cmpSize` / …），**逐项独立**：
 * 改"圆角怎么判"不必在 170 行里翻，也不会碰到别的属性。比较器都是纯函数（自检直接喂夹具）。
 */
export function compareBlockProps(block, el, opts = {}) {
  const scale = Number(opts.scale) || 1;
  const tol = { ...BLOCK_TOLERANCE, ...(opts.tolerance ?? {}) };
  const target = opts.target ?? 'h5';
  const rows = [];
  const add = (field, expected, actual, verdict, suggestion, extra = {}) =>
    rows.push({ field, expected, actual, verdict, suggestion: suggestion ?? '', ...extra });

  if (!el) {
    add('(映射)', '—', '页面上没找到对应元素', '⚪', '给元素加 data-lanhu="' + (block.name ?? '') + '"，或确认它真的渲染出来了');
    return rows;
  }
  const ctx = { scale, tol, target, add, rows, opts };
  cmpRadius(block, el, ctx);
  cmpSize(block, el, ctx);
  cmpTextColor(block, el, ctx);
  cmpFontWeight(block, el, ctx);
  cmpFill(block, el, ctx);
  cmpBorder(block, el, ctx);
  return rows;
}


/** 四态汇总。 */
function summarizeVerdicts(rows) {
  const c = { '✅': 0, '🟡': 0, '❌': 0, '⚪': 0 };
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
}

/**
 * 块级比对报告（方案 §1.5）：总览 + 明细 + 可执行的建议改法。
 */
export function renderBlockReport(result) {
  const { blocks, pageUrl, viewport, scale, target } = result;
  const L = [];
  const all = result.rows ?? [];
  const matched = all.filter((r) => r.element);
  const unmapped = all.filter((r) => !r.element);

  const flat = [];
  for (const r of all) for (const row of r.props) flat.push({ ...row, blockName: blockLabel(r.block), kind: r.block.kind, matchedBy: r.matchedBy });

  const c = summarizeVerdicts(flat);
  const total = flat.length;
  const pass = c['✅'] + c['🟡'];

  L.push(`# 块级比对 — ${result.name ?? ''} vs ${pageUrl}`);
  L.push('');
  L.push(`- 比对块数：**${matched.length}/${all.length}** 映射成功（⚪ 未映射 ${unmapped.length}）`);
  L.push(`- 属性项：${total} 项 ｜ ✅ ${c['✅']}　🟡 ${c['🟡']}　❌ ${c['❌']}　⚪ ${c['⚪']}`);
  L.push(`- 通过率：**${total === 0 ? 0 : Math.round((pass / total) * 1000) / 10}%**（✅+🟡 计通过）`);
  L.push(`- 换算：设计稿 ${viewport.width} → 页面 ${Math.round(viewport.width * scale)}（scale ${Math.round(scale * 1000) / 1000}）｜目标端 ${target}`);
  if (result.account) L.push(`- 账号：**${result.account}**${result.accountBy === 'explicit' ? '（显式指定）' : `（自动判定 · ${result.accountBy}）`}`);
  L.push('');

  // 各属性通过率
  const byField = {};
  for (const r of flat) {
    byField[r.field] = byField[r.field] ?? { '✅': 0, '🟡': 0, '❌': 0, '⚪': 0, n: 0 };
    byField[r.field][r.verdict] += 1;
    byField[r.field].n += 1;
  }
  L.push('## 各属性通过率');
  L.push('| 属性 | 通过 | 总数 | 通过率 |');
  L.push('|---|---|---|---|');
  for (const [f, v] of Object.entries(byField)) {
    const p = v['✅'] + v['🟡'];
    L.push(`| ${f} | ${p} | ${v.n} | ${Math.round((p / v.n) * 100)}% |`);
  }
  L.push('');

  // 四态明细（⚪ 单列 —— 映射失败本身就是问题）
  const bad = flat.filter((r) => r.verdict === '❌');
  L.push(`## ❌ 不一致（${bad.length} 项）`);
  L.push('| 块 | 类型 | 属性 | 设计稿 | 页面 | 建议改法 |');
  L.push('|---|---|---|---|---|---|');
  if (bad.length === 0) L.push('| — | — | — | — | — | 全部一致 | — |');
  for (const r of bad.slice(0, 60)) {
    L.push(`| ${r.blockName ?? ''} | ${r.kind ?? ''} | ${r.field} | ${r.expected} | ${r.actual} | ${r.suggestion ?? ''} |`);
  }
  if (bad.length > 60) L.push(`| … | | | | | 其余 ${bad.length - 60} 项略 |`);
  L.push('');

  if (unmapped.length > 0) {
    L.push(`## ⚪ 无法比对（${unmapped.length} 块）`);
    L.push('| 块 | 类型 | 尺寸 | 原因 |');
    L.push('|---|---|---|---|');
    for (const r of unmapped.slice(0, 30)) {
      L.push(`| ${blockLabel(r.block)} | ${r.block.kind} | ${Math.round(r.block.w)}×${Math.round(r.block.h)} | 页面上找不到对应元素 |`);
    }
    if (unmapped.length > 30) L.push(`| … | | | 其余 ${unmapped.length - 30} 块略 |`);
    L.push('');
  }

  const warn = flat.filter((r) => r.verdict === '🟡');
  if (warn.length > 0) {
    L.push(`## 🟡 容差内（${warn.length} 项，可接受）`);
    L.push(warn.slice(0, 12).map((r) => `- ${r.blockName} · ${r.field}：设计稿 ${r.expected} / 页面 ${r.actual}`).join('\n'));
    L.push('');
  }

  return L.join('\n');
}

/**
 * 块级比对编排：读块 → 开页面 → 采样 → 匹配 → 六项判定 → 报告。
 * @param {{projectId?:string, imageId?:string, url?:string, pageUrl:string, scale?:number, target?:'h5'|'mini', selectors?:object, cookie?:string, account?:string, kind?:string, includeNoise?:boolean}} args
 */
export async function verifyBlocks(args = {}) {
  const { pageUrl } = args;
  if (!pageUrl) throw new LanhuError('verifyBlocks 需要 pageUrl（要验收的页面地址）。');

  const design = await readBlocks({
    url: args.url, projectId: args.projectId, imageId: args.imageId,
    kind: args.kind, includeNoise: args.includeNoise, cookie: args.cookie, account: args.account,
    limit: 1,   // 文本清单用不上，省点体积
    // 验收只比"设计稿 vs 页面"的六项属性，评论段与它无关 → **不发那次请求**（也保证本工具行为不变）
    comments: false,
  });

  const launch = await launchBrowser();
  if (launch.error) {
    // 块级比对**没有**静态降级等价物：六项属性里圆角/底色/边框/大小全都要靠真实渲染才能取到，
    // 只读 CSS 声明既算不出继承、也拿不到实际盒子。所以如实说明，不假装给了结果。
    return {
      ok: false, degraded: true,
      name: design.name,
      pageUrl,
      blockCount: (design.blocks ?? []).length,
      reason: `块级比对需要浏览器（要取 getComputedStyle 与真实几何），但没能启动：${launch.error}`,
      install: BROWSER_INSTALL_HINT,
      text: [
        '⚠️ 未能启动浏览器，块级比对没有降级路径。',
        '',
        `原因：${launch.error}`,
        '',
        '为什么不能降级：圆角、底色、边框、大小都必须从真实渲染取，',
        'CSS 声明级比对既算不出继承、也拿不到实际盒子（这与文本层的静态比对不同）。',
        '',
        BROWSER_INSTALL_HINT,
      ].join('\n'),
    };
  }
  const { engine, browser, source } = launch;

  // 视口宽度：默认按设计稿宽，可显式指定
  const designW = design.viewport?.width || 375;
  const viewportW = Number(args.viewportWidth) || designW;
  const scale = viewportW / designW;
  // 块坐标本身就是相对画板的（见 geometryDistance 的说明），这里**不**传 origin
  const origin = { x: 0, y: 0 };

  let elements = [];
  const rows = [];
  try {
    const page = await openPage(browser, engine, { width: viewportW, height: design.viewport?.height || 812 });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(Number(args.waitMs) || 900);
    elements = normalizePageElements(await page.evaluate(PAGE_SAMPLER));
  } finally {
    await browser.close();
  }

  const matched = matchBlocks(design.blocks ?? [], elements, { scale, origin, tolerance: args.tolerance });

  // 只报"主块"的判定（碎片默认不参与，避免噪音淹没真问题）
  const focus = matched.filter((m) => args.includeNoise || !m.block.noise);
  for (const m of focus) {
    rows.push({
      block: m.block, element: m.element, matchedBy: m.matchedBy, evidence: m.evidence,
      props: compareBlockProps(m.block, m.element, { scale, target: args.target ?? 'h5', tolerance: args.tolerance, designWidth: designW, rpxBase: args.rpxBase }),
    });
  }

  const result = {
    ok: true,
    name: design.name,
    pageUrl,
    engine,
    browserSource: source,
    viewport: { width: designW, height: design.viewport?.height || 812 },
    scale,
    target: args.target ?? 'h5',
    account: design.account ?? null,
    accountBy: design.accountBy ?? null,
    blockCount: (design.blocks ?? []).length,
    comparedCount: focus.length,
    elementCount: elements.length,
    rows,
  };
  result.text = renderBlockReport(result);
  return result;
}

/* ==========================================================================
 * 版本自述（面板标题栏：当前版本 + 「有更新」提示）
 *
 * 三个约束，缺一个就会出事故：
 *   ① 当前版本**只从 package.json 读**（相对本模块解析）—— 硬编码的版本号会悄悄过期，
 *      而且没有任何东西会报错。自检用「临时 package.json」把这条钉住。
 *   ② npm 查询**必须缓存**（绝不允许每次渲染都去打 registry），且**绝不抛**：
 *      它是 /lanhu/status 的附加项，登录态才是主职责，附加项失败不能拖挂主职责。
 *   ③ 版本比较**按语义**（0.5.10 > 0.5.9）；遇到预发布（-rc.1）或解析不了的版本
 *      **不给判断**（updateAvailable: null）—— 宁可不提示，也不误报。
 * ========================================================================== */

/** 插件自己的 package.json：相对**本模块**解析，源码直跑与装进 profile 都成立。 */
export function pluginPackagePath() {
  return fileURLToPath(new URL('./package.json', import.meta.url));
}

/** 当前版本。读不到给 null（调用方降级），**不抛**。 */
export function readPluginVersion(opts = {}) {
  const file = opts.packagePath ?? pluginPackagePath();
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = json && typeof json.version === 'string' ? json.version.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

/** MAJOR.MINOR.PATCH[-prerelease][+build]；解析不了返回 null。 */
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return {
    major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

/** 预发布标识符比较（semver §11）：数字 < 字母数字；数字按数值比。 */
function comparePreIdent(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) === Number(b) ? 0 : (Number(a) < Number(b) ? -1 : 1);
  if (an) return -1;
  if (bn) return 1;
  return a === b ? 0 : (a < b ? -1 : 1);
}

/**
 * 语义化比较：a<b → -1，a==b → 0，a>b → 1。
 * **任一侧解析不了就返回 null**（不瞎判），调用方据此放弃「有没有更新」这个结论。
 */
export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0;
  if (x.pre.length === 0) return 1;      // 有预发布 < 无预发布（1.0.0-rc.1 < 1.0.0）
  if (y.pre.length === 0) return -1;
  const n = Math.min(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i += 1) {
    const c = comparePreIdent(x.pre[i], y.pre[i]);
    if (c !== 0) return c;
  }
  return x.pre.length === y.pre.length ? 0 : (x.pre.length < y.pre.length ? -1 : 1);
}

/** 稳定版（无预发布标识）才参与「有没有更新」的判断。 */
export function isStableVersion(value) {
  const p = parseSemver(value);
  return !!p && p.pre.length === 0;
}

/**
 * 有没有更新。**拿不准就 null**（预发布 / 解析不了）：
 * 「不提示」是可接受的降级，「误报有更新」不是。
 */
export function computeUpdateAvailable(current, latest) {
  if (!isStableVersion(current) || !isStableVersion(latest)) return null;
  const c = compareSemver(current, latest);
  return c === null ? null : c < 0;
}

export const NPM_PACKAGE = 'dsh-lanhu';
export const NPM_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE}/latest`;
/** 命中缓存 8 小时（版本不会分钟级变化）；失败只缓存 5 分钟（别让一次网络抖动把提示锁死一天）。 */
export const VERSION_CACHE_TTL = 8 * 60 * 60 * 1000;
export const VERSION_FAIL_TTL = 5 * 60 * 1000;
/** registry 拿不到就放弃 —— 这是附加项，不值得让面板等。 */
export const VERSION_FETCH_TIMEOUT = 3000;

let npmVersionCache = null;   // { at, latest, ok }

/** 只给自检用：清掉进程内缓存，好让「缓存真的生效」可被断言。 */
export function resetNpmVersionCache() {
  npmVersionCache = null;
}

/**
 * npm 上的 latest 版本。**只返回版本串或 null，绝不抛**；结果进进程内缓存。
 * opts 里的 now / fetchImpl / ttlMs / failTtlMs / cache 都是给自检做依赖注入用的。
 */
export async function npmLatestVersion(opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const useCache = opts.cache !== false;
  if (useCache && npmVersionCache) {
    const ttl = npmVersionCache.ok ? (opts.ttlMs ?? VERSION_CACHE_TTL) : (opts.failTtlMs ?? VERSION_FAIL_TTL);
    if (now - npmVersionCache.at < ttl) return npmVersionCache.latest;
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  let latest = null;
  try {
    const res = await fetchImpl(NPM_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeout ?? VERSION_FETCH_TIMEOUT),
    });
    if (res && res.ok !== false) {
      const j = typeof res.json === 'function' ? await res.json() : null;
      const v = j && typeof j.version === 'string' ? j.version.trim() : '';
      if (v) latest = v;
    }
  } catch {
    latest = null;   // 网络/超时/非 JSON：一律降级，绝不外抛
  }
  if (useCache) npmVersionCache = { at: now, latest, ok: latest !== null };
  return latest;
}

/** 面板标题栏要的三件事。**任何一步失败都不抛**（npm 挂了只会让 latest/updateAvailable 变 null）。 */
export async function pluginVersionInfo(opts = {}) {
  const version = readPluginVersion(opts);
  const latest = await npmLatestVersion(opts);
  return { version, latest, updateAvailable: computeUpdateAvailable(version, latest) };
}

/* ==========================================================================
 * 9. CLI
 * ========================================================================== */

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function printJson(v) { console.log(JSON.stringify(v, null, 2)); }

/* ==========================================================================
 * CLI —— **命令表**
 *
 * `main` 只做三件事：解析参数 → 按名字取处理器 → 统一错误处理。
 * 每个命令一个处理器（`cmdXxx`），输出**逐字节不变**（有 `/tmp/golden-capture.mjs` 的黄金输出兜着）。
 * 处理器只管"取参 + 调核心函数 + 打印" —— **核心逻辑一律在文件上半部分**，
 * 工具链（`lib/index.js`）调的是同一批函数，**两边不许各写一遍**（踩过：同一个空列 bug 出现两次）。
 * 加命令 = 加一个 `cmdXxx` + 在 `CLI_COMMANDS` 里登记一行。
 * ========================================================================== */

/** `auth` 命令。 */
async function cmdAuth({ args, cookie }) {
  const r = await checkAuth({ cookie, account: args.account });
  if (args.json) printJson(r);
  else if (r.ok) {
    console.log(`✅ 登录有效（来源：${r.cookieSource}）`);
    console.log(`   Cookie：${r.cookieMasked}`);
    if (r.expiry) console.log(`   过期：${r.expiry.expiresAt}（剩 ${r.expiry.daysLeft} 天）`);
    for (const t of r.teams) console.log(`   团队 ${t.teamId}  ${t.name}  成员 ${t.memberNum}`);
  } else {
    console.error(`❌ ${r.error}`);
    if (r.hint) console.error(`   ${r.hint}`);
    process.exitCode = 1;
  }
  return r;
}

/** `teams` 命令。 */
async function cmdTeams({ args, cookie }) {
  const r = await listTeams({ cookie, account: args.account });
  if (args.json) printJson(r); else for (const t of r.teams) console.log(`${t.teamId}  ${t.name}  成员 ${t.memberNum}`);
  return r;
}

/** `projects` 命令。 */
async function cmdProjects({ args, cookie }) {
  const r = await listDirectory(args.team, { cookie, account: args.account });
  if (args.json) printJson(r); else for (const p of r.projects) console.log(`${p.sourceId}  ${p.sourceName}`);
  return r;
}

/** `designs` 命令。 */
async function cmdDesigns({ args, cookie }) {
  // 与工具链一致：**贴链接就行**；显式 --project 优先；都不给 → 明确报错（不静默给空表）
  const target = args.url ? parseProjectTarget(args.url) : null;
  const projectId = args.project ?? target?.projectId ?? null;
  if (!projectId) throw new LanhuError('用法：node lanhu.mjs designs --url "<蓝湖链接>"，或 --project <pid>（两个都不给无法定位项目）');
  const r = await listImages(projectId, { cookie, account: args.account });
  if (args.json) printJson(r);
  else {
    console.log(`${r.projectName ?? r.projectId}：${r.images.length} 张稿`);
    // ⚠️ 列表给的是**缩略图预览尺寸**（实测常见 ¼），不是画板真实尺寸 —— 标出来，别让 AI 拿它算 rpx。
    for (const i of r.images) console.log(`  ${i.imageId}  ${i.name}  ${i.width}×${i.height}（预览）`);
    console.log('  ⚠️ 上面的尺寸是**缩略图预览尺寸**，不是画板真实尺寸；算 rpx 请用读稿标题行里的画板宽。');
  }
  return r;
}

/** `sectors` 命令。 */
async function cmdSectors({ args, cookie }) {
  const r = await listSectors(args.project, { cookie, account: args.account });
  if (args.json) printJson(r); else console.log(r.sectors.length ? r.sectors.map((s) => `${s.id} ${s.name}`).join('\n') : '(无分组)');
  return r;
}

/**
 * `search` 的人读行（**纯函数，便于离屏断言**）。
 *
 * ⚠️ 三类结果**都要打**。原先只遍历 `r.images` —— 于是"命中的是 PRD / 项目而不是稿"的搜索
 * 会变成**零输出 + 退出码 0**，即本项目最忌讳的"看着跑成功但什么都没干"
 * （实测：搜「某大屏」命中 2 条 PRD / 0 张稿 → 人读路径什么都不打，而 `--json` 里 prds=2）。
 *
 * 三类都空时**也要说话**，否则还是一次"零输出但成功"。
 */
export function searchLines(r, keyword) {
  const images = r?.images ?? [];
  const prds = r?.prds ?? [];
  const projects = r?.projects ?? [];
  const lines = [];
  for (const i of images) lines.push(`${i.imageId}  ${i.name}  @ ${i.projectName}  (${i.path})`);
  for (const d of prds) lines.push(`[PRD]  ${d.prdId}  ${d.name}  @ ${d.path}`);
  for (const j of projects) lines.push(`[项目] ${j.projectId}  ${j.name}`);
  const total = images.length + prds.length + projects.length;
  if (total === 0) lines.push(`没有匹配「${keyword ?? ''}」的稿 / 项目 / PRD。`);
  else lines.push(`— 共 ${total} 条（稿 ${images.length} · PRD ${prds.length} · 项目 ${projects.length}）`);
  return lines;
}

/** `search` 命令。 */
async function cmdSearch({ args, cookie }) {
  const r = await search(args.team, args.keyword, { cookie, account: args.account });
  if (args.json) printJson(r);
  else for (const line of searchLines(r, args.keyword)) console.log(line);
  return r;
}

/** `read` 命令。 */
async function cmdRead({ args, cookie }) {
  const r = await readDesign({
    projectId: args.project, imageId: args.image, url: args.url,
    format: args.region ? 'region' : (args.format ?? 'summary'),
    region: args.region, minWidth: args['min-width'],
    limit: args.limit === undefined ? undefined : Number(args.limit),
    mapBox: args['map-box'], toBox: args['to-box'],
    version: args.version, gapMaxDistance: args['gap-max-distance'] === undefined ? undefined : Number(args['gap-max-distance']),
    dualUnits: Boolean(args['dual-units']),
    dds: Boolean(args.dds),
    cookie, account: args.account, outDir: args.out,
  });
  if (args.json) printJson(r);
  else {
    console.log(r.text);
    console.log('');
    console.log(`— ${r.format} 模式 | ${r.layerCount} 层 | 输出 ${kb(r.text)}${r.filePath ? ` | 落盘 ${r.filePath}` : ''}`);
  }
  return r;
}

/** `blocks` 命令。 */
async function cmdBlocks({ args, cookie }) {
  const r = await readBlocks({
    projectId: args.project, imageId: args.image, url: args.url,
    region: args.region, kind: args.kind,
    minWidth: args['min-width'],
    limit: args.limit === undefined ? undefined : Number(args.limit),
    includeNoise: Boolean(args.all),
    dualUnits: Boolean(args['dual-units']),
    version: args.version,
    cookie, account: args.account,
    // ⚠️ CLI 的默认**与工具相反**：不给 `--comments` 就不读评论（也**不多发那次请求**）——
    //    为的是"既有 CLI 输出逐字节不变"（这个仓库的命令输出有黄金输出兜着）。
    //    要评论就显式 `--comments`。
    comments: Boolean(args.comments),
  });
  if (args.json) printJson(r);
  else {
    console.log(r.text);
    console.log('');
    // 评论那行只在**真的要过评论**（`--comments`）时才出现 —— 默认路径的输出逐字节不变
    const cm = r.comments ? ` | 评论 ${r.comments.total} 条（未读 ${r.comments.unread}）` : '';
    console.log(`— blocks 模式 | ${r.layerCount} 层 → ${r.blockCount} 块（碎片 ${r.noiseCount}）${cm} | 输出 ${kb(r.text)}`);
  }
  return r;
}

/** `diff` 命令 —— **同一张稿的两个版本**对比（回答"这次设计改了什么"）。 */
async function cmdDiff({ args, cookie }) {
  const r = await diffDesign({
    projectId: args.project, imageId: args.image, url: args.url,
    from: args.from, to: args.to,
    includeNoise: Boolean(args.all),
    cookie, account: args.account,
  });
  if (args.json) printJson(r);
  else {
    console.log(r.text);
    console.log('');
    console.log(`— diff 模式 | v${String(r.from?.id ?? '').slice(0, 8)} → v${String(r.to?.id ?? '').slice(0, 8)}`
      + ` | 未变 ${r.counts.unchanged} / 变化 ${r.counts.changed.blocks} / 新增 ${r.counts.added} / 删除 ${r.counts.removed}`
      + ` | 匹配可靠度 ${r.reliable ? '可信' : '**不可靠**'} | 输出 ${kb(r.text)}`);
  }
  return r;
}

/** `audit` 命令 —— **跨稿一致性审计**（扫一个项目的多张稿，报"设计系统漂移"）。 */
async function cmdAudit({ args, cookie }) {
  const r = await auditProject({
    projectId: args.project, url: args.url,
    limit: args.limit === undefined ? undefined : Number(args.limit),
    includeNoise: Boolean(args.all),
    allowWeakNaming: Boolean(args['allow-weak-naming']),
    cookie, account: args.account,
  });
  if (args.json) printJson(r);
  else {
    console.log(r.text);
    console.log('');
    console.log(`— audit 模式 | 扫描 ${r.scanned}/${r.total}${r.truncated ? '（截断）' : ''}`
      + ` | 漂移 ${r.driftedCategories.length} 类：${r.driftedCategories.map((c) => AUDIT_CATEGORY_LABEL[c]).join(' / ') || '无'}`
      + ` | ${r.reliable ? '可信' : '**不可靠**'} | 输出 ${kb(r.text)}`);
  }
  return r;
}

/** `product-docs` 命令。 */
async function cmdProductDocs({ args, cookie }) {
  // 产品文档（原型）—— 与 read/blocks 是**两套东西**，命令名分开，避免拿错
  const parsed = args.url ? parseProductUrl(args.url) : {};
  const projectId = args.project ?? parsed.projectId;
  const teamId = args.team ?? parsed.teamId;
  if (!projectId || !teamId) throw new LanhuError('用法：node lanhu.mjs product-docs --url "<原型链接>"（链接里带 tid/pid），或 --project <pid> --team <tid>');
  const listed = await productDocuments(projectId, teamId, { cookie, account: args.account });
  const pi = await tryProjectInfo(projectId, teamId, { cookie, account: args.account });
  const info = pi.info;
  // --with-pages：逐份拉 sitemap 数页面规模（**默认关** —— N 份 = N 次额外请求）。
  // 单份失败只标 `?`，绝不炸整张表（与工具链同一口径）。
  const withPages = Boolean(args['with-pages']);
  if (withPages) {
    for (const d of listed.axureDocs) {
      try {
        const { tree } = await fetchDesignTree(projectId, d.docId, { cookie, account: args.account, expect: 'prototype' });
        const c = countSitemapPages(tree?.sitemap?.rootNodes);
        d.pages = { nodes: c.nodes, readable: c.readable };
      } catch (e) {
        d.pages = { nodes: null, readable: null, reason: String(e?.message ?? e).slice(0, 80) };
      }
    }
  }
  if (args.json) printJson({ ...listed, project: info, projectInfoError: pi.error });
  else {
    console.log(`# 产品文档（原型）${info?.name ? ` —— ${info.name}` : ''}`);
    if (info) console.log(`> 项目：${info.folderName ? `${info.folderName} / ` : ''}${info.name ?? '—'}${info.creatorName ? ` · 创建者 ${info.creatorName}` : ''}`);
    else if (pi.error) console.log(`> ⚠️ 项目信息未取到（${pi.error}）—— 不影响下面结果`);
    console.log(`> 共 ${listed.total} 个资源，其中 ${listed.axureDocs.length} 个是 axure 原型文档（**不是设计稿**）`);
    console.log('');
    const table = productDocsTable(listed.axureDocs, { withPages });
    console.log(table.header);
    console.log(table.sep);
    table.rows.forEach((r) => console.log(r));
    console.log('');
    console.log('> 「序」是接口的 order：蓝湖「文档」面板**按它倒序**显示且是**滚动区** —— 界面里只看到前几个，不代表只有那几个。');
    if (withPages) console.log(`> 「页面节点 / 可读页」是逐份拉 sitemap 数出来的（本次额外发了 ${listed.axureDocs.length} 次请求）；\`?\` = 那份失败。Folder 没有 url，所以节点数 ≥ 可读页数。`);
  }
  return listed;
}

/** `product-doc` 命令。 */
async function cmdProductDoc({ args, cookie }) {
  const r = await readProductDoc({
    url: args.url, projectId: args.project, docId: args.doc, teamId: args.team,
    pageId: args['page-id'] ?? args.page, pageName: args['page-name'],
    version: args.version,
    limit: args.limit === undefined ? 1 : Number(args.limit),
    format: args.format,
    layerLimit: args['layer-limit'] === undefined ? undefined : Number(args['layer-limit']),
    includeNoise: Boolean(args.all),
    cookie, account: args.account,
  });
  if (args.json) printJson({ ...r, text: undefined });
  else {
    console.log(r.text);
    console.log('');
    console.log(r.format === 'layers'
      ? `— 原型样式（layers） | ${r.doc?.name ?? ''} | 读 ${r.selectedCount} 页 | 输出 ${kb(r.text)}`
      : `— 产品文档（原型） | ${r.pageCount} 个页面节点（${r.wireframeCount} 可读） | 读正文 ${r.selectedCount} 页 | 输出 ${kb(r.text)}`);
  }
  return r;
}

/** `log` 命令。 */
/** `log` 命令。⚠️ **不传 account**（有意）：纯本地读使用记录，不走网络。 */
async function cmdLog({ args, cookie }) {
  const r = readUsage({ limit: args.limit === undefined ? 30 : Number(args.limit) });
  if (args.json) printJson(r);
  else {
    if (r.entries.length === 0) console.log('(还没有记录 —— 用一次工具或面板就会出现在这里)');
    for (const e of r.entries) {
      const t = String(e.tool).padEnd(24);
      const ms = e.ms === null || e.ms === undefined ? '' : `${e.ms}ms`;
      console.log(`${e.at.slice(11, 19)}  ${e.ok ? '✅' : '❌'}  ${t}${ms.padStart(7)}  ${e.summary ?? e.error ?? ''}`);
    }
    console.log(`— 共 ${r.total} 条 | 来源 ${r.source} | ${r.file}`);
  }
  return r;
}

/** `slices` 命令。 */
async function cmdSlices({ args, cookie }) {
  const r = await downloadSlices({ projectId: args.project, imageId: args.image, url: args.url, cookie, account: args.account, outDir: args.out });
  if (args.json) printJson(r);
  else {
    console.log(`✅ 下载 ${r.downloaded} 个（去重 ${r.skipped}）→ ${r.dir}\n   mapping: ${r.mappingPath}`);
    // 半透明警告必须在**人看得见的地方**打出来，不能只躺在 mapping.json 里
    for (const w of r.warnings ?? []) console.log(`\n${w}`);
  }
  return r;
}

/** `verify` 命令。 */
async function cmdVerify({ args, cookie }) {
  const r = await verifySpec({ projectId: args.project, imageId: args.image, url: args.url, pageUrl: args.page, cookie, account: args.account, outDir: args.out });
  if (args.json) printJson(r); else console.log(r.text ?? JSON.stringify(r, null, 2));
  return r;
}

/** `accounts` 命令。 */
/** `accounts` 命令。
 *  ⚠️ **不传 account**（有意）：它管理**全部**账号，要操作哪个用 `--alias` 指定 ——
 *     与 `--account`（"用哪个账号的身份"）语义不同，硬塞会让人以为 `--account` 能选账号。 */
async function cmdAccounts({ args, cookie }) {
  // 添加 / 更新账号
  if (args.add) {
    const alias = typeof args.alias === 'string' ? args.alias : (args._[1] ?? null);
    if (!alias) {
      throw new LanhuError('用法：node lanhu.mjs accounts --add --alias <别名> [--company "<公司>"] [--note "<备注>"] [--cookie "<粘贴>" | --clipboard]');
    }
    let raw = null;
    if (typeof args.cookie === 'string') raw = args.cookie;
    else if (args.clipboard) {
      const { execFileSync } = await import('node:child_process');
      raw = execFileSync('pbpaste', { encoding: 'utf8', timeout: 10000 });
    }
    const cookie = raw ? parseCookieInput(raw).cookie : null;
    const { entry, created } = upsertAccount({ alias, company: args.company, note: args.note, cookie });
    console.log(`${created ? '✅ 已添加' : '✅ 已更新'}账号 ${entry.alias}（${entry.company}）`);
    if (cookie) console.log(`   Cookie 已写入 ${cookiePathFor(entry.alias)}（600）`);
    if (cookie && args['no-index'] !== true) {
      console.log('   正在建索引（团队 + 项目）…');
      try {
        const ix = await buildAccountIndex(entry.alias);
        console.log(`   ✅ ${ix.teamCount} 个团队 / ${ix.projectCount} 个项目${ix.errors.length ? `（部分失败：${ix.errors.join('；')}）` : ''}`);
      } catch (e) {
        console.log(`   ⚠️ 索引失败（不影响读稿，稍后可 --reindex 重试）：${e.message}`);
      }
    }
    return entry;
  }
  if (typeof args.remove === 'string') {
    const r = removeAccount(args.remove);
    console.log(`✅ 已删除账号 ${r.removed}（默认账号：${r.default ?? '无'}）`);
    return r;
  }
  if (typeof args.default === 'string') {
    const r = setDefaultAccount(args.default);
    console.log(`✅ 默认账号 → ${r.default}`);
    return r;
  }
  if (args.reindex) {
    const doc = loadAccounts();
    const targets = typeof args.reindex === 'string' ? [args.reindex] : doc.accounts.map((a) => a.alias);
    if (targets.length === 0) throw new LanhuError('还没配置任何账号，先 --add 一个。');
    for (const a of targets) {
      process.stdout.write(`   ${a} … `);
      const ix = await buildAccountIndex(a);
      console.log(`${ix.teamCount} 团队 / ${ix.projectCount} 项目${ix.errors.length ? ` ⚠️ ${ix.errors.join('；')}` : ''}`);
    }
    return listAccounts();
  }
  // 默认：列表
  const acc = listAccounts();
  if (args.json) printJson(acc);
  else if (acc.accounts.length === 0) {
    console.log('(还没配置账号)');
    console.log('  添加一个：node lanhu.mjs accounts --add --alias Acme --company "Acme" --clipboard');
    console.log(`  （没配置时，读稿会退回旧路径 ${cookieFilePaths()[0]}，行为与从前一致）`);
  } else {
    for (const a of acc.accounts) {
      const days = a.expiry ? `剩 ${a.expiry.daysLeft} 天` : (a.hasCookie ? '有效期未知' : '❌ 无 Cookie');
      console.log(`${a.isDefault ? '★' : ' '} ${a.alias.padEnd(14)} ${a.company.padEnd(14)} ${days.padStart(12)}   团队 ${a.teamCount} · 项目 ${a.projectCount}`);
      if (a.note) console.log(`  ${' '.repeat(14)} ${a.note}`);
    }
    console.log(`\n默认账号：${acc.default ?? '（无）'}  |  档案：${acc.file}`);
  }
  return acc;
}

/** `who` 命令。 */
/** `who` 命令。
 *  ⚠️ **不传 account**（有意）：它的职责就是"这张稿属于哪个账号"——跨账号遍历所有账号的 Cookie 去试。
 *     给它指定 account 等于让它别干本职。工具侧同款白名单见 lib/index.js 的 EXPLICITLY_INAPPLICABLE。 */
async function cmdWho({ args, cookie }) {
  const r = await whoIsIt({ url: args.url, projectId: args.project, imageId: args.image, teamId: args.team });
  if (args.json) printJson(r);
  else if (r.found) {
    const by = r.matchedBy === 'tid' ? '链接里的团队 id（零请求）'
      : r.matchedBy === 'pid' ? '项目 id（零请求）'
        : String(r.matchedBy ?? '未知');
    console.log(`✅ 归属账号：${r.company}（${r.alias}）`);
    console.log(`   命中依据：${by}`);
    if (r.team) console.log(`   团队：${r.team.name ?? r.team.teamId}`);
    if (r.project) console.log(`   项目：${r.project.name ?? r.project.projectId}`);
    if (r.expiry) console.log(`   Cookie：剩 ${r.expiry.daysLeft} 天`);
    if (r.readable && r.readableName) console.log(`   ⚠️ 这张稿能读到（「${r.readableName}」），但不属于任何已配置账号`);
  } else {
    console.log('❓ 没找到这张稿的归属账号');
    if (r.knownAccounts?.length) {
      console.log('   已知账号：' + r.knownAccounts.map((a) => `${a.company}(${a.alias}，${a.teamCount} 团队)`).join('、'));
    }
    if (r.probeErrors?.length) console.log('   探测结果：' + r.probeErrors.join(' / '));
    console.log('   ' + r.hint);
  }
  return r;
}

/** `cookie` 命令。 */
async function cmdCookie({ args, cookie }) {
  let text = null;
  if (typeof args.set === 'string') text = args.set;
  else if (args.file) text = fs.readFileSync(args.file, 'utf8');
  else if (args.stdin) text = fs.readFileSync(0, 'utf8');
  else if (args.clipboard) {
    const { execFileSync } = await import('node:child_process');
    text = execFileSync('pbpaste', { encoding: 'utf8', timeout: 10000 });   // macOS 剪贴板
  }
  if (!text) throw new LanhuError('用法：lanhu.mjs cookie --set "<粘贴内容>" | --file <路径> | --stdin | --clipboard');

  const dry = Boolean(args['dry-run']);
  const r = await saveCookie(text, { verify: args.verify !== false, dryRun: dry, account: args.account });
  console.log(dry ? '🔍 解析结果（--dry-run，未写入）' : `✅ 已写入 ${r.path}（600）`);
  console.log(`   解析来源：${r.source}`);
  console.log(`   Cookie：${r.masked}`);
  if (r.checks) console.log(`   关键项：${Object.entries(r.checks).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join('  ')}`);
  if (r.expiry) console.log(`   有效期至：${r.expiry.expiresAt}（剩 ${r.expiry.daysLeft} 天）`);
  return r;
}

/** 命令名 → 处理器。 */
const CLI_COMMANDS = {
  'auth': cmdAuth,
  'teams': cmdTeams,
  'projects': cmdProjects,
  'designs': cmdDesigns,
  'sectors': cmdSectors,
  'search': cmdSearch,
  'read': cmdRead,
  'blocks': cmdBlocks,
  'diff': cmdDiff,
  'audit': cmdAudit,
  'product-docs': cmdProductDocs,
  'product-doc': cmdProductDoc,
  'log': cmdLog,
  'slices': cmdSlices,
  'verify': cmdVerify,
  'accounts': cmdAccounts,
  'who': cmdWho,
  'cookie': cmdCookie,
};

const USAGE = `dsh-lanhu —— 蓝湖设计稿读取

用法：node lanhu.mjs <命令> [选项]

全局选项：
  --account <别名>   用**指定账号**的身份（目标团队不属于默认账号时**必须给**，否则接口报 30005）。
                   不给则用默认账号。优先级：--cookie > 环境变量 LANHU_COOKIE > --account > 默认账号
                   —— 也就是说**显式 cookie 与环境变量会盖过 --account**（它们表达的是更强的显式意图）。
                   不需要它的命令：who（职责就是跨账号判定）、accounts（用 --alias 指定要操作的账号）、log（纯本地）。

  auth                                   探活 Cookie（含有效期）
  teams                                  列团队
  projects --team <teamId>               团队目录（项目）
  designs  --project <projectId>         项目下的设计稿列表
  sectors  --project <projectId>         项目分组（未分组项目返回空）
  search   --team <teamId> --keyword <kw>  全局搜索
  read     --project <id> --image <id> [--format summary|full|tokens] [--region y0,y1 [--min-width N] [--limit N]]
           也可只给 --url "<蓝湖链接>"（hash 路由的 tid/pid/image_id 自动解析）
           --region 可再加 --map-box "x0,y0,x1,y1" --to-box "X0,Y0,X1,Y1"：
           把设计稿坐标映射到目标坐标系（如本地 SVG 的 viewBox），输出多两列「映射 x,y / 映射 w×h」
           （x/y 各自独立缩放，**非等比** —— 长宽比不同的两个坐标系也能对上）
  blocks   [--url "<蓝湖链接>" | --project <id> --image <id>] [--region y0,y1] [--kind card,pill] [--min-width N] [--all]
           块级清单：卡片/胶囊/文本/图片/分割线，每块六项属性（圆角·大小·文字色·字号·底色·边框）
           --comments 额外读这张稿的**评论 / 标注**（人类留的需求，如「要个png的图片」，独立接口），
           末尾多一段「评论」并把每条**映射回它落在哪个块**（归一化坐标 × 画板尺寸后匹配，命中不了就明说）。
           ⚠️ CLI **默认不读**（不给 --comments 就不多发那次请求）；工具 lanhu_read_blocks 默认**读**。
  diff     [--url "<蓝湖链接>" | --project <id> --image <id>] --from <版本id> [--to <版本id>] [--all]
           **同一张稿的两个版本**对比（--to 省略 = 最新版 latest）：尺寸/圆角·颜色·布局·文字·边框·结构·新增·删除，
           每类只列**有变化的**、数值给「从→到」；零变化只给一句汇总，两版无差异时**明说"两版一致"**。
           --from 给不存在的版本 id 会**报错**（不静默回退 latest）。输出里报**匹配可靠度**
           （精确/近似/无法匹配）；两版大面积对不上时**明说"逐块对比不可靠"**、不出明细表。
   audit    [--url "<蓝湖链接>" | --project <id>] [--limit N] [--all] [--allow-weak-naming]
            **跨稿一致性审计**（蓝湖不提供）：扫一个项目的多张稿，报「设计系统漂移」——
            ① 同一组件多种规格（圆角/高度分布 + 建议以哪个为准）② 字号阶梯（含只出现 1 次的野值）
            ③ 近重复色（RGB 距离阈值）④ 间距尺度 ⑤ 圆角家族。
            同一组件 = **层名归一化后相同**；工具默认名（Rectangle 12 / 矩形 3）与空名**一律不认**。
            ⚠️ 成本：**扫 N 张 = 2N 次请求** → 默认只扫限额张数，--limit 可加但**不超过硬上限**；
            输出里写明 scanned / total / 是否被截断。命名不可靠时**判不可靠、不出明细**
            （--allow-weak-naming 只放开不看层名的那几项）。
  product-docs --url "<原型链接>" | --project <pid> --team <tid>
           列**产品文档（Axure 原型 / PRD）**——不是设计稿。含 docId / 最新版本 / 版本数 / 更新时间
  product-doc  --url "<原型链接>" [--page-id <id>] [--page-name <名>] [--limit N] [--version <id>]
               [--format layers] [--layer-limit N] [--all]   # layers = 该页的样式图层/块级清单
                                                            #   —— 项目只有原型、没有设计稿时靠它照着实现
           读原型的页面树 + 命中页正文（**先不带 --page-id 看树**，一份原型常有上百个节点）
           --page-id 跨版本稳定，推荐；正文取自页面 HTML（data.js 里常为空）
  read/blocks/product-doc/slices 均可加 --version <版本id>（默认 latest；给错会报错，不静默回退）
             （**diff 不认 --version** —— 它要比两个版本，用 --from / --to）
  read/blocks 可加 --dual-units：**宽表**的尺寸列也给双单位（形如 120×152px / 240×304rpx）
             换算比按**画板宽度**算（rpx = px × 750 ÷ 画板宽；宽 375 的稿即 ×2），输出里会写明基准。
             「间距一览」与 region 输出**始终**双单位 —— 那两处就是要直接抄进 CSS 的。
  log      [--limit N]                   插件使用记录（工具调用 / 面板读取）
  accounts                                列账号（公司 / 团队 / 有效期 / 默认）
           --add --alias <别名> [--company "<公司>"] [--note "…"] [--cookie "<粘贴>" | --clipboard]
           --remove <别名> | --default <别名> | --reindex [别名]
  who      --url "<蓝湖链接>"             判定这张稿属于哪个账号（零请求优先）
           也可 --project <id> --image <id>
  slices   --project <id> --image <id> [--out <dir>]
           落盘 mapping.json 带每张图的 尺寸/mode/alpha 范围；含半透明会**直接打印警告**
           （半透明 PNG 转 JPG 会丢 alpha → 整屏发灰，且查看器合白底看不出来）
  verify   --project <id> --image <id> --page <pageUrl>
  cookie   --set "<粘贴内容>" | --file <路径> | --stdin | --clipboard [--dry-run]
           （粘贴内容可以是 F12 → Copy as cURL 的整段、Cookie 请求头、或裸 Cookie 串；
             --dry-run 只解析校验不写入）

通用选项：--cookie <串>  --json`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);
  const cmd = args._[0];
  const cookie = typeof args.cookie === 'string' ? args.cookie : undefined;

  try {
    const handler = CLI_COMMANDS[cmd];
    if (handler) return await handler({ args, cookie });
  // 给了命令但没人接：必须非零退出，否则脚本调用方会把「打了一屏帮助」当成功。
  // 没给命令（或 --help）只是看帮助，退出码保持 0。
  if (cmd) {
    process.stderr.write(`❌ 未知命令：${cmd}（用 node lanhu.mjs 看全部命令）\n`);
    process.exitCode = 1;
  }
    console.log(USAGE);
    return null;
  } catch (e) {
    if (args.json) printJson({ ok: false, error: e.message, hint: e.hint ?? null, code: e.code ?? null });
    else {
      console.error(`❌ ${e.message}`);
      if (e.hint) console.error(`   ${e.hint}`);
    }
    process.exitCode = 1;
    return null;
  }
}

/* ── CLI 入口守卫 ─────────────────────────────────────────────────────────────
 *
 * ⚠️ 这里踩过一个**静默失败**的坑：Node ESM 的 `import.meta.url` 是 **realpath 后的**
 *    （`file:///…/真实路径/…`），而 `process.argv[1]` **保留调用时写的路径**。
 *    于是只要通过**符号链接**调用（`node <软链路径>/lanhu.mjs`、npm 全局 bin、
 *    pnpm 安装……），两边永远不相等 → `main()` 一次都不执行 → **零输出、退出码 0**。
 *    比报错更糟：看起来"跑成功了但什么都没干"。
 *
 * 修法：两边都 realpath 后比较；并且**守卫未命中时打一行 stderr**，
 * 保证"什么都没发生"这种事至少留下痕迹。
 */
if (process.argv[1]) {
  let entry = process.argv[1];
  try {
    entry = fs.realpathSync(entry);
  } catch { /* 路径不存在就按原样比，反正也命不中 */ }
  let self = import.meta.url;
  try {
    self = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch { /* 同上 */ }

  if (self === pathToFileURL(entry).href) {
    main();
  } else {
    // 走这里最常见的情况是**本文件被别人 import**（`node test/selfcheck.mjs` 之类）—— 完全正常，不该吵。
    // 只有一种情况必须报出来：**用户直接运行的确实是本文件，守卫却没命中**。
    // 判据就用文件名：argv[1] 的 basename 与本文件同名，才是"直接跑了我却没执行"。
    let selfBase = 'lanhu.mjs';
    try { selfBase = path.basename(fileURLToPath(import.meta.url)); } catch { /* 保底 */ }
    const argvBase = path.basename(process.argv[1]);
    if (argvBase === selfBase && process.env.LANHU_QUIET_ENTRY !== '1') {
      console.error(`[dsh-lanhu] 入口守卫未命中：本文件被直接调用却没有执行任何命令。\n  自己：${self}\n  调用：${pathToFileURL(entry).href}`);
    }
  }
}

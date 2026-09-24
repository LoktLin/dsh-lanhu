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
    out.url = u.length <= 800 ? u : `${u.slice(0, 800)}…(共 ${u.length} 字符)`;
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
  return { detail, tree, bytes: 0 };
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
  const list = (items ?? []).filter((i) => i && Number.isFinite(i.x) && Number.isFinite(i.y) && Number.isFinite(i.w) && Number.isFinite(i.h));
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
        for (const key of [`${gap.from}|${axis}|+`, `${gap.to}|${axis}|-`]) {
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
export function renderGaps(gaps, limit = 60) {
  const L = [];
  L.push(`## 几何间距（${gaps.length} 条；只在另一轴有重叠的相邻元素之间算，x/y 各自独立）`);
  L.push('> 用途：还原时**直接抄间距**，不用拿坐标手算。');
  L.push('> 「重叠」= 两条边在另一轴上的共同区间 —— 没有重叠说明是斜对角，那种距离不能当间距用。');
  L.push('');
  L.push('| 从 | 到 | 轴 | 间距 | 重叠区间 |');
  L.push('|---|---|---|---|---|');
  const nm = (id, name) => `${name || '(无名)'}${id ? ` \`${String(id).slice(0, 18)}\`` : ''}`;
  for (const g of gaps.slice(0, limit)) L.push(`| ${nm(g.from, g.fromName)} | ${nm(g.to, g.toName)} | ${g.axis} | ${g.distance} | ${g.overlap.start}~${g.overlap.end} |`);
  if (gaps.length > limit) L.push(`| … | | | 其余 ${gaps.length - limit} 条略 | |`);
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
  if (fillC && fillC.a > 0) colors.push({ ...fillC, role: 'fill' });
  const borderC = axureFillColor(st.borderFill);
  if (borderC && borderC.a > 0) colors.push({ ...borderC, role: 'border' });
  const fgC = axureFillColor(st.foreGroundFill);
  if (fgC && fgC.a > 0) colors.push({ ...fgC, role: 'text' });
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
        if (dgFill && dgFill.a > 0) dgColors.push({ ...dgFill, role: 'fill' });
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
    withFill: layers.filter((l) => l.colors.some((c) => c.role === 'fill')).length,
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
      if (c && c.a > 0) out.push({ ...c, role: 'fill' });
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
    if (c && c.a > 0) out.push({ ...c, role: 'text' });
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

/**
 * 把 artboard 递归摊平成图层数组。
 * 注：蓝湖给的子图层 frame 坐标是**相对画板原点**的（已验证：画板 left=-10279，子层 left=155.5）。
 */
export function flattenArtboard(artboard) {
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
    // 内边距：子层坐标 − 父层坐标。蓝湖的 frame 是相对画板原点的，所以直接相减就是 inset —— 省掉人工手算。
    //
    // ⚠️ 顶层（画板）没有父层，这时给 **null 而不是 undefined**。
    //    `undefined` 不是合法 lossless JSON —— DSH 宿主会**拒收整个工具结果**
    //    （报 `value is not lossless JSON`），agent 一点数据都拿不到。实测踩过。
    const inset = parent ? {
      left: round2(frame.x - parent.x),
      top: round2(frame.y - parent.y),
      right: round2((parent.x + parent.w) - (frame.x + frame.w)),
      bottom: round2((parent.y + parent.h) - (frame.y + frame.h)),
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (l.depth === 0) return 'artboard';
  if (l.hasImage) return 'image';
  if (l.text !== undefined && l.text !== null && l.text !== '') return 'text';
  const hasFill = (l.colors ?? []).some((c) => c.role === 'fill' || c.role === 'gradient');
  // 分割线①：极细长的实心条
  if (thin <= 3 && long >= 12) return 'divider';
  // 分割线②：只有单边边框、自身无底色的薄块（Footer 顶边 1px 就长这样）
  if (l.border && l.border.single && !hasFill && thin <= 12) return 'divider';
  // 胶囊：圆角撑满短边（Contact Button 79×26 r=38 —— 案例 1 的主角）
  if (l.radius && h > 0 && h <= 64 && l.radius.max >= thin / 2 - 0.5) return 'pill';
  // 卡片必须有**样式**（底色/边框/圆角）才算 —— 否则 375×798 的纯布局层会被误判成卡片
  const styled = hasFill || Boolean(l.border) || Boolean(l.radius);
  if (w >= 240 && h >= 100 && styled) return 'card';
  if (styled) return 'container';
  return 'other';
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
  for (const l of layers) {
    if (l.visible === false) continue;
    // ⚠️ 判据要用**累乘后**的 effectiveOpacity：父组 `opacity=0` 时子层自身仍是 1，
    //    只读自身会把「整组不可见」的层当成可见块输出（交接清单缺口 1）。
    if ((l.effectiveOpacity ?? l.opacity ?? 1) === 0) continue;
    const kind = classifyBlock(l);
    if (kind === 'other') continue;

    // ⚠️ 文本层的 `fills` 是**文字颜色**（Figma 里文字色就是 fill），不是底色。
    //    不排除它会把文字色当成背景色，报出"设计稿有底色、页面没有"这种假问题（实测踩过）。
    const isTextLayer = typeof l.text === 'string' && l.text !== '';
    // `l.fillIsBackground` 只有**原型**这条链会设（Axure 的 fill 与 foreGroundFill 是分开的字段）；
    // 设计稿那条链不设它 → 行为逐字不变。
    const fill = (isTextLayer && !l.fillIsBackground) ? null : (l.colors ?? []).find((c) => c.role === 'fill' || c.role === 'gradient');
    // 多段渐变：把**全部** stop 留一份（按设计稿顺序）。
    // ⚠️ 以前渲染只取第一个 stop —— 表格里"有颜色"，看着不像缺信息，比 opacity 更隐蔽（交接清单缺口 4）。
    const gradientStops = (isTextLayer && !l.fillIsBackground) ? [] : (l.colors ?? []).filter((c) => c.role === 'gradient');
    const textColor = (l.colors ?? []).find((c) => c.role === 'text') ?? (isTextLayer ? (l.colors ?? []).find((c) => c.role === 'fill') : null);
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
      font: l.font ?? null,
      hasImage: Boolean(l.hasImage),
      shape: l.shape,
      childCount: childCount.get(pathOf(l)) ?? 0,
    });
  }
  return blocks;
}

/** 块级清单 → 紧凑文本（CLI / 工具 / 面板兜底共用）。 */
export function renderBlocks(blocks, meta = {}, opts = {}) {
  const limit = opts.limit ?? 80;
  const L = [];
  const counts = {};
  for (const b of blocks) counts[b.kind] = (counts[b.kind] ?? 0) + 1;

  const noiseCount = blocks.filter((b) => b.noise).length;
  const main = opts.includeNoise ? blocks : blocks.filter((b) => !b.noise);

  L.push(`# 块级清单 — ${titleName(meta)}（${meta.width ?? '?'}×${meta.height ?? '?'}）`);
  L.push('');
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
    const bg = b.bg
      ? (b.bg.stops?.length > 1
        ? b.bg.stops.map((s) => `${s.hex}${s.alpha < 1 ? `@${Math.round(s.alpha * 100)}%` : ''}`).join('→')
        : `${b.bg.hex}${b.bg.alpha < 1 ? `@${Math.round(b.bg.alpha * 100)}%` : ''}`)
      : '无';
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
    L.push(`| ${i + 1} | ${BLOCK_KINDS[b.kind] ?? b.kind} | ${b.name ?? ''} | ${b.x},${b.y} | ${b.w}×${b.h} | ${r} | ${bg} | ${op} | ${bd} | ${(b.text ?? '').slice(0, 18)} | ${f} | ${fam} | ${metricsText(b.font)} |`);
  });
  if (main.length > limit) L.push(`| … | 其余 ${main.length - limit} 块略（可用 --region / --limit 收窄） | | | | | | | | | |`);

  // 边框总览：案例 2「分割线整条丢失」的直接答案
  const withBorder = main.filter((b) => b.border);
  if (withBorder.length > 0) {
    L.push('');
    L.push(`## 边框 / 分割线（${withBorder.length} 处）`);
    for (const b of withBorder.slice(0, 24)) {
      L.push(`- ${b.name}：${b.border.color ?? '(蓝湖未给颜色)'} **${b.border.width}px**，${b.border.sides.join('+')}${b.border.single ? ' ← 单边，即分割线' : ''}`);
    }
    if (withBorder.length > 24) L.push(`- … 其余 ${withBorder.length - 24} 处略`);
  }
  return L.join('\n');
}

/* ==========================================================================
 * 5. 渲染（给模型看的紧凑文本）
 * ========================================================================== */

function kb(str) { return `${(Buffer.byteLength(str, 'utf8') / 1024).toFixed(2)}KB`; }

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
function fillText(colors) {
  const arr = colors ?? [];
  const grads = arr.filter((c) => c.role === 'gradient');
  const one = (c) => `${rgbHex(c)}${c.a < 1 ? `@${Math.round(c.a * 100)}%` : ''}`;
  if (grads.length > 1) return grads.map(one).join('→');
  // 保持既有兜底顺序（数组里第一个 fill，再退到首个色）——只是把渐变 stop 提到最前。
  const c = grads[0] ?? arr.find((x) => x.role === 'fill') ?? arr[0];
  if (!c) return '—';
  return `${c.role === 'border' ? '描边 ' : ''}${one(c)}`;
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
  L.push(`# 设计 Token — ${titleName(meta)}（${meta.width ?? '?'}×${meta.height ?? '?'}）`);
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
  return L.join('\n');
}

/** summary 模式：token + 文本层清单（默认紧凑，控制在 4KB 内）。 */
export function renderSummary({ detail, layers, tokens, meta, maxTextLayers = 36 }) {
  const L = [];
  L.push(`# ${detail.name || titleName(meta) || '设计稿'}（${meta.width}×${meta.height}）`);
  L.push(`图层 ${layers.length} 个 | 文本层 ${layers.filter((l) => l.text).length} 个 | 导出图 ${layers.filter((l) => l.hasImage).length} 个`);
  L.push('');

  L.push('## 色板（Top 12）');
  L.push(tokens.colors.slice(0, 12).map((c) => `\`${c.hex}\`×${c.count}`).join('  '));
  L.push('');

  L.push('## 字号');
  L.push(tokens.fontSizes.map((f) => `${f.size}×${f.count}`).join('  ') || '—');
  L.push('');

  // 关键容器：非文本的布局块（搜索框 / 卡片 / 按钮底…）。
  // 布局还原第一手就是容器 —— 只给文本层不够（实测反馈 P5：形状容器要自己父子相减手算内边距）。
  // 只留**有样式**的（带填充或圆角）：iPhoneX / Notch / Section 这类无样式的结构层是噪音。
  const boxes = layers
    .filter((l) => l.visible && !l.text && l.w >= 40 && l.h >= 18)
    .filter((l) => l.radius !== null || l.colors.some((c) => c.role === 'fill'))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const maxBoxes = 14;
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
    const bfill = fillText(b.colors);
    const bopRaw = b.effectiveOpacity ?? b.opacity ?? 1;
    const bop = bopRaw < 1 ? String(bopRaw) : '—';
    L.push(`| ${bnm} | ${b.x},${b.y} | ${b.w}×${b.h} | ${b.radius ? `${b.radius.max}px` : '—'} | ${bfill} | ${bop} | ${bins} |`);
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
    const c = t.colors.find((x) => x.role === 'text') ?? t.colors[0];
    const txt = String(t.text).replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 40);
    const fam = t.font?.family ? shortFamily(t.font.family) : '—';
    L.push(`| ${txt} | ${t.x},${t.y} | ${t.w}×${t.h} | ${t.font?.size ?? '?'}px/${t.font?.weight ?? '?'} | ${fam} | ${metricsText(t.font)} | ${c ? rgbHex(c) : '—'} |`);
  }
  if (texts.length > maxTextLayers) L.push(`| … | 其余 ${texts.length - maxTextLayers} 个文本层略（用 format=full 取全量） | | | |`);

  const out = L.join('\n');
  return out;
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
  L.push(`> 内边距 = 该层相对**父容器**的四边距离（已算好，×2 即 rpx）`);
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
      `${l.w}×${l.h}`,
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
  const { detail, tree, bytes } = await fetchDesignTree(target.projectId, target.imageId, {
    cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  const artboard = tree.artboard ?? tree;
  const layers = flattenArtboard(artboard);
  const tokens = collectTokens(layers);
  const meta = {
    name: artboard.name ?? detail.name,
    width: round2(artboard.frame?.width ?? detail.width),
    height: round2(artboard.frame?.height ?? detail.height),
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
    const r = renderRegion(layers, ro);
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
    const text = gaps.length ? `${r.text}\n\n${renderGaps(gaps)}` : r.text;
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
    const text = renderSummary({ detail, layers, tokens, meta });
    return { ...base, format: 'full', filePath: file, fileBytes: fs.statSync(file).size, text, textBytes: Buffer.byteLength(text, 'utf8') };
  }

  const text = renderSummary({ detail, layers, tokens, meta });
  return { ...base, format: 'summary', text, textBytes: Buffer.byteLength(text, 'utf8') };
}

/**
 * 一步到位：给蓝湖链接（或 id）→ 块级清单。
 *
 * 面板的「贴链接就读」与工具 `format=blocks` 共用这一个入口。
 * 与 readDesign 的区别：readDesign 输出的是**图层**（334 条），这里输出的是**块**（161 条），
 * 每块带齐六项属性（圆角/大小/文字色/文字大小/有无底色/边框），是"人一眼能核对"的粒度。
 */
export async function readBlocks(args = {}) {
  const target = resolveTarget({ projectId: args.projectId, imageId: args.imageId, url: args.url });
  let teamId = null;
  if (args.url) {
    try { teamId = parseLanhuUrl(args.url).teamId; } catch { /* 解析失败不影响读稿 */ }
  }

  // 同 readDesign：没指定账号就按链接自动判定
  const picked = await pickAccount({ ...args, projectId: target.projectId, imageId: target.imageId, teamId: target.teamId });
  const acct = picked.alias;
  const { detail, tree, bytes } = await fetchDesignTree(target.projectId, target.imageId, {
    cookie: args.cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  const artboard = tree.artboard ?? tree;
  const layers = flattenArtboard(artboard);
  let blocks = buildBlocks(layers);

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

  const meta = {
    name: artboard.name ?? detail.name,
    width: round2(artboard.frame?.width ?? detail.width),
    height: round2(artboard.frame?.height ?? detail.height),
    // 画板原点：块坐标是"相对画板"的，比对层换算坐标必须减掉它
    // （实测画板 left 是 -10279 这种大负数，直接用块的绝对坐标会和页面完全错位）
    origin: {
      x: round2(artboard.frame?.left ?? artboard.realFrame?.left ?? 0),
      y: round2(artboard.frame?.top ?? artboard.realFrame?.top ?? 0),
    },
    device: tree.meta?.device,
    assets: Array.isArray(tree.assets) ? tree.assets.length : 0,
  };
  const kindCounts = {};
  for (const b of blocks) kindCounts[b.kind] = (kindCounts[b.kind] ?? 0) + 1;
  let text = renderBlocks(blocks, meta, { limit: args.limit, includeNoise: args.includeNoise });
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
    teamId,
    projectId: target.projectId,
    imageId: target.imageId,
    sourceBytes: bytes,
    // 用了哪个账号、怎么定出来的（别的 AI 需要这层透明度：它并不知道链接属于谁）
    account: acct ?? null,
    accountBy: picked.by ?? null,
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
  const { detail, tree } = await fetchDesignTree(target.projectId, target.imageId, {
    cookie, account: acct, version: args.version, urlVersionId: target.versionId, teamId: target.teamId, pageId: args.pageId,
  });
  const urls = [...new Set((tree.assets ?? []).filter((u) => typeof u === 'string'))];

  if (urls.length === 0) {
    return { ok: true, downloaded: 0, skipped: 0, dir: null, files: [], backgroundColor: null, warnings: [], translucent: [], note: '该稿没有可导出的切图（assets 为空）。' };
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
    for (const i of r.images) console.log(`  ${i.imageId}  ${i.name}  ${i.width}×${i.height}`);
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
    version: args.version,
    cookie, account: args.account,
  });
  if (args.json) printJson(r);
  else {
    console.log(r.text);
    console.log('');
    console.log(`— blocks 模式 | ${r.layerCount} 层 → ${r.blockCount} 块（碎片 ${r.noiseCount}） | 输出 ${kb(r.text)}`);
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
  product-docs --url "<原型链接>" | --project <pid> --team <tid>
           列**产品文档（Axure 原型 / PRD）**——不是设计稿。含 docId / 最新版本 / 版本数 / 更新时间
  product-doc  --url "<原型链接>" [--page-id <id>] [--page-name <名>] [--limit N] [--version <id>]
               [--format layers] [--layer-limit N] [--all]   # layers = 该页的样式图层/块级清单
                                                            #   —— 项目只有原型、没有设计稿时靠它照着实现
           读原型的页面树 + 命中页正文（**先不带 --page-id 看树**，一份原型常有上百个节点）
           --page-id 跨版本稳定，推荐；正文取自页面 HTML（data.js 里常为空）
  read/blocks/product-doc/slices 均可加 --version <版本id>（默认 latest；给错会报错，不静默回退）
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

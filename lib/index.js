/**
 * dsh-lanhu —— Host 半边：把蓝湖设计稿读取能力注册成 9 个原生工具。
 *
 * ⚠️ **本文件必须零依赖**：插件用 link: 安装时真实路径在 profile 之外，
 *    Node 从插件目录向上找不到 @deepseek-ai/*（它们只在全局本体里），
 *    import 任何外部包都会在启动期让整棵插件树加载失败 —— 这是实测踩过的坑。
 *    所以这里不 import dsh-tools 的 defineTool，改用下面的本地 tool() 做同样的投影。
 *
 * 契约要点（取证自 dsh-ssh 真实实现 + dsh-tools 编译结果）：
 *   · 裸对象形态 = 标准 JSON Schema：parameters 是 {type:'object', properties, required:[...]}；
 *     必需性写在 required 数组里（属性上的 required: true 是 defineTool 的简写，裸对象不认）。
 *   · output.schema 同标准 JSON Schema；不写 additionalProperties 即允许额外字段。
 *   · output.render 必须返回 ContentBlock[]，且**不能抛错**（否则卡片渲染失败）。
 *   · 返回值必须是 lossless JSON（undefined / NaN / Infinity / -0 都会让宿主拒收整个结果）。
 */
import {
  checkAuth,
  listTeams,
  listDirectory,
  listImages,
  search as coreSearch,
  readDesign,
  readBlocks,
  diffDesign,
  auditProject,
  downloadSlices,
  verifySpec,
  verifyBlocks,
  saveCookie,
  UUID_RE,
  recordUsage,
  readUsage,
  bgText,
  summarizeArgs,
  listAccounts,
  upsertAccount,
  removeAccount,
  setDefaultAccount,
  buildAccountIndex,
  whoIsIt,
  parseCookieInput,
  productDocuments,
  multiInfo,
  readProductDoc,
  ddsSchema,
  pickAccount,
  parseProductUrl,
  parseProjectTarget,
  countSitemapPages,
  productDocsTable,
  fetchDesignTree,
  pluginVersionInfo,
  imageVersions,
  LIMITS,
  genCode,
} from '../lanhu.mjs';

export const name = 'lanhu';
export const inject = [];

const text = (s) => [{ type: 'text', text: String(s ?? '') }];

/* ────────────────────────────────────────────────────────────────────────────
 * 列表工具的分页（`lanhu_list_designs` / `lanhu_search`）
 *
 * ⚠️ **分页只在工具这一层做**，核心函数（`listImages` / `search`）保持"能取全量"：
 *    内部调用方 —— 面板「稿」下拉的 `/lanhu/designs`、`/lanhu/versions-count` 的 `total`、
 *    审计 `auditProject`、CLI —— 走的都是核心函数，**一个都不能因为这里的默认 limit 少拿数据**。
 *    自检里有一条断言专门钉这件事（"内部调用方拿到的是全量"）。
 *
 * 口径与既有风格一致：`limit`（默认值 + **硬上限**，传更大压回）/ `offset`（≥0）。
 * ──────────────────────────────────────────────────────────────────────────── */

/** `limit` 夹取：没给/非法 → 默认值；给了 → 不超过硬上限。 */
function clampPage(rawLimit, def, hard) {
  const n = Number(rawLimit);
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
  return Math.min(v, hard);
}

/** `offset` 夹取：没给/非法/负数 → 0。 */
function clampOffset(rawOffset) {
  const n = Number(rawOffset);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 「共 N / 本页 M / 下一页传 offset=X」——**截断不许静默**（本仓库铁律）。
 * 已到末页时也写一句"已到末页"，让"没有下一页"这件事也是**显式**的（而不是让人猜）。
 * @returns {string|null} 一页都没必要时给 null（调用方自己决定要不要打）
 */
function pageNote({ shown, total, offset, limit, unit }) {
  const head = `— 本页 ${shown} / 共 ${total} ${unit}（offset=${offset}，limit=${limit}）`;
  if (offset + shown < total) return `${head}；**下一页传 \`offset=${offset + shown}\`**`;
  return `${head}；已到末页`;
}

/**
 * 本地极简版 defineTool —— 只做「简写 DSL → 标准 JSON Schema」的投影，
 * 形态与官方 defineTool 的编译结果逐字对齐（parameters 与 output.schema 都实测比对过）。
 * 好处：插件零依赖，link: 安装也能正常启动。
 */
function toValueSchema(spec) {
  if (spec === null || typeof spec !== 'object') return {};
  if (spec.type === 'json') return {};                  // 任意 lossless JSON：不加约束
  const out = {};
  if (typeof spec.type === 'string') out.type = spec.type;
  if (typeof spec.description === 'string') out.description = spec.description;
  if (Array.isArray(spec.enum)) out.enum = spec.enum.slice();
  if (spec.type === 'array') out.items = spec.items ? toValueSchema(spec.items) : {};
  if (spec.type === 'object') {
    out.additionalProperties = spec.additionalProperties !== false;
    if (spec.properties) {
      const nested = toParameterSchema(spec.properties);
      out.properties = nested.properties;
      if (nested.required) out.required = nested.required;
    }
  }
  return out;
}

function toParameterSchema(spec) {
  const properties = {};
  const required = [];
  for (const key of Object.keys(spec ?? {})) {
    const node = spec[key];
    properties[key] = toValueSchema(node);
    if (node && node.required === true) required.push(key);
  }
  const out = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 参数校验 —— 官方 defineTool 的「第二件事」
 *
 * 官方实现里 defineTool = 「DSL→JSON Schema 编译」+「execute 前按 schema 校验参数」
 * （`dsh-tools/lib/index.js`：`const validate = (args) => validateJsonSchemaValue(parameters, args, "")`
 *  → `if (violations.length > 0) throw new ToolArgsError(violations)`）。
 *
 * 我们这套 shim 原先只做了编译那一半：模型把 `limit` 传成 `"abc"` 时，
 * 官方会给一条清晰的参数错误，而我们会一直走到业务代码里才炸出个语焉不详的异常。
 * 这里把另一半补齐 —— 按 schema 校验，报错风格对齐官方（`"路径" must be ...` 的引号形态）。
 *
 * 只覆盖我们生成的 schema 真正用到的关键字：type / required / properties /
 * additionalProperties / items / enum。官方那套是**迭代式**实现（防深递归），
 * 这里用递归就够 —— 工具参数不会深。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 参数不合 schema。语义对齐官方 dsh-tools 的 ToolArgsError。 */
export class ToolArgsError extends Error {
  constructor(violations) {
    super(`工具参数不符合 schema：\n- ${violations.join('\n- ')}`);
    this.name = 'ToolArgsError';
    this.violations = violations;
  }
}

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** lossless JSON 判定：undefined / NaN / Infinity / -0 / bigint / 函数 都不合法。 */
function isLossless(v) {
  if (v === undefined) return false;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return false;
  if (Array.isArray(v)) return v.every(isLossless);
  if (v && typeof v === 'object') return Object.values(v).every(isLossless);
  return true;
}

function typeNameOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

const joinPath = (base, key) => (base ? `${base}.${key}` : String(key));

function checkValue(schema, value, path, out) {
  if (!schema || typeof schema !== 'object') return;
  // `{}` = 不做约束（官方把 type:'json' 编译成空对象）
  if (Object.keys(schema).length === 0) return;

  if (Object.hasOwn(schema, 'type') && !SCHEMA_TYPES.includes(schema.type)) return;

  if (!isLossless(value)) { out.push(`"${path}" 必须是 lossless JSON 值`); return; }

  const t = schema.type;
  if (typeof t === 'string') {
    const actual = typeNameOf(value);
    // integer 的值也可以满足 number 约束
    const ok = t === actual || (t === 'number' && actual === 'integer');
    if (!ok) { out.push(`"${path}" 的类型应为 ${t}，实际是 ${actual}`); return; }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((x) => x === value)) {
    out.push(`"${path}" 只能是 ${schema.enum.map((x) => JSON.stringify(x)).join(' / ')} 之一，实际是 ${JSON.stringify(value)}`);
  }

  if (t === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) out.push(`"${joinPath(path, key)}" 是必填参数`);
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) checkValue(props[key], value[key], joinPath(path, key), out);
      else if (schema.additionalProperties === false) out.push(`"${joinPath(path, key)}" 不在该工具允许的参数里`);
    }
  }

  if (t === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => checkValue(schema.items, item, `${path}[${i}]`, out));
  }
}

/** 校验一个值是否符合（我们生成的）JSON Schema；返回 violations，空数组＝通过。 */
export function validateJsonSchemaValue(schema, value, path = '') {
  const out = [];
  checkValue(schema, value, path, out);
  return out;
}

/** 给使用日志用的一句话摘要（不含 Cookie，也不含大对象）。 */
function summarizeResult(r) {
  if (!r || typeof r !== 'object') return null;
  const bits = [];
  if (r.blockCount !== undefined) bits.push(`${r.blockCount} 块`);
  if (r.layerCount !== undefined) bits.push(`${r.layerCount} 层`);
  if (r.teamCount !== undefined) bits.push(`${r.teamCount} 团队`);
  if (r.matchRate !== undefined) bits.push(`匹配率 ${r.matchRate}%`);
  if (r.count !== undefined) bits.push(`${r.count} 个`);
  if (r.filePath) bits.push(String(r.filePath).split('/').pop());
  if (r.dryRun) bits.push('dryRun');
  if (r.ok === false) bits.push('失败');
  return bits.join(' / ') || null;
}

/**
 * 公共参数：多账号场景指定用哪个账号。
 * 在 tool() 里统一注入 —— 一处加上，所有工具都有，不用逐个改每个工具的定义。
 */
const ACCOUNT_PARAM = {
  type: 'string',
  description: '可选：蓝湖账号别名（多账号时用）。不给则按链接里的团队 id 自动判定，再退到默认账号；有哪些账号看 lanhu_accounts。',
};

/**
 * 出口清洗：**递归把 undefined 换成 null**，顺带把 NaN / Infinity / -0 也换成 null。
 *
 * 为什么非有不可：DSH 宿主的 lossless 校验会**拒收整个工具结果**
 * （`returned invalid output: value is not lossless JSON`），agent 一点数据都拿不到。
 * 而 `undefined` 极易从"可选字段"溜进来 —— 实测 `lanhu_read_blocks` 就栽在这两处：
 *   `blocks[].inset`（顶层画板没有父层）、`blocks[].font.lineHeight`（该层没设行高）。
 * 桩测试与 CLI 都不走宿主校验，**只有真宿主会拦**，所以必须在这里兜底。
 */
export function toLossless(v, depth = 0) {
  if (depth > 16) return null;                                  // 防环 / 防病态深
  if (v === undefined) return null;                             // 保留键、值换 null（消费方字段更稳定）
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : null;
  if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return null;
  if (Array.isArray(v)) return v.map((x) => toLossless(x, depth + 1));
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = toLossless(v[k], depth + 1);
    return out;
  }
  return v;
}

/**
 * defineTool 的零依赖替身：简写进、标准 JSON Schema 出。
 * 在这里统一包一层**使用日志**与**出口清洗** —— 所有工具都经过这个构造点，一处生效全覆盖。
 * 日志失败绝不影响工具调用（recordUsage 内部已吞异常）。
 */
function tool(def) {
  const { parameters = {}, output, ...rest } = def;
  const rawExecute = rest.execute;
  // ⚠️ 编译只做一次，**校验必须用编译后的标准 JSON Schema**：
  //    原始 DSL 里必填是每个属性上的 `required: true`，而标准 schema 里是根部 `required: [...]` 数组。
  //    拿 DSL 去校验会静默通过（一个字段都拦不住）—— 实测踩过。
  const paramSchema = toParameterSchema({ ...parameters, account: ACCOUNT_PARAM });
  return {
    ...rest,
    async execute(args) {
      const started = Date.now();
      // 参数先过一遍 schema —— 对齐官方 defineTool 的行为，把「模型传错参数」
      // 拦在业务代码之前，给出可读的字段级错误，而不是让它在业务里炸成语焉不详的异常。
      const violations = validateJsonSchemaValue(paramSchema, args);
      if (violations.length > 0) {
        const err = new ToolArgsError(violations);
        // ⚠️ 同类漏网（父代理健壮性测试逼出来的）：**schema 拦截的失败也不带 hint** ——
        //    于是 search / verify_spec / verify_blocks 传坏 id 时只会说"字段不合法"，
        //    不告诉 AI 下一步。这里统一补一句（与 precheckIdParams 同一原则：报错要指出下一步）。
        err.hint = '按上面的字段说明补齐后再调一次。id 类参数（teamId/projectId/imageId/docId）'
          + '请用对应 `list_*` 工具的返回，或**直接贴整条蓝湖链接**（自动解析 tid/pid/image_id）。';
        recordUsage({
          tool: rest.name, ok: false, ms: Date.now() - started,
          args: summarizeArgs(args), error: err.message,
        });
        return failure(err);
      }
      // 本地就能判定的坏输入 → 进业务之前拦下，并给出可执行的下一步（见 precheckIdParams）
      const idErr = precheckIdParams(args);
      if (idErr) {
        recordUsage({ tool: rest.name, ok: false, ms: Date.now() - started, args: summarizeArgs(args), error: idErr.message });
        return failure(idErr);
      }
      try {
        const r = await rawExecute(args);
        recordUsage({
          tool: rest.name,
          ok: r?.ok !== false && r?.failed !== true,
          ms: Date.now() - started,
          args: summarizeArgs(args),
          summary: summarizeResult(r),
        });
        // ⚠️ 出口必须过 lossless 清洗：宿主对 undefined/NaN/Infinity/-0 会**拒收整个结果**。
        //    日志记的是原值（不影响排查），返回给宿主的是清洗后的值。
        // 出口收口：保证 `ok` 存在（withOk）+ 上游错误补 hint（withUpstreamHint，**不改写 error**）
        return toLossless(withUpstreamHint(withOk(r)));
      } catch (e) {
        recordUsage({
          tool: rest.name,
          ok: false,
          ms: Date.now() - started,
          args: summarizeArgs(args),
          error: e?.message ?? String(e),
        });
        throw e;
      }
    },
    parameters: paramSchema,
    output: { schema: toValueSchema(output.schema), render: output.render },
  };
}

/** 把所有异常收敛成「可读说明 + 手动指引」，绝不抛裸异常（需求书 §3 降级要求）。 */
function failure(e) {
  const msg = e?.message ?? String(e);
  const hint = e?.hint ?? null;
  const lines = [`❌ ${msg}`];
  if (hint) lines.push('', hint);
  return { ok: false, failed: true, error: msg, hint, text: lines.join('\n') };
}

/**
 * 本地参数预检（**单一入口**）——只判"本地就能判定"的坏输入，不去硬编上游错误码。
 *
 * ⚠️ 为什么放在这里：这插件的原则是「报错要**指出下一步**」。可上游返回的
 *    `接口返回错误 code=10009：Image not exist` 只说"蓝湖说了什么"，没告诉 AI 该干什么。
 *    本地能判定的（id 格式不对 / 必填缺失）就该在**进业务之前**拦下，并给出可执行的下一步。
 *
 * ⚠️ `pageId` 有意不在名单里：原型页 id 是 **32 位纯 hex（无短横）**，与设计稿 id 形态不同。
 */
const ID_PARAMS = ['teamId', 'projectId', 'imageId', 'docId', 'versionId'];
const ID_HINT = {
  teamId: '先用 `lanhu_list_teams` 取一个 teamId（不需要 teamId 的工具就别传）。',
  projectId: '先用 `lanhu_list_projects` 取一个 projectId；或**直接贴整条蓝湖链接**（自动解析 tid/pid/image_id）。',
  imageId: '先用 `lanhu_list_designs` 取一个 imageId；或**直接贴整条蓝湖链接**。',
  docId: '先用 `lanhu_list_product_documents` 取一个 docId（原型/PRD 用 docId，不是 imageId）。',
  versionId: 'versionId 从 `lanhu_read_design` / `lanhu_read_product_doc` 的返回里取（如 `version=xxx`）。',
};

function precheckIdParams(args) {
  const bad = ID_PARAMS.filter((k) => {
    const v = args?.[k];
    return typeof v === 'string' && v.trim() !== '' && !UUID_RE.test(v.trim());
  });
  if (bad.length === 0) return null;
  const err = new Error(`参数 ${bad.map((k) => `\`${k}\``).join('、')} 不是有效的 id 格式（应为 xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）。`);
  err.hint = bad.map((k) => `· ${ID_HINT[k] ?? '核对这个 id 的来源。'}`).join('\n');
  return err;
}

/**
 * 出口兜底（**单一出口**）：保证成功路径**一定**带 boolean `ok`。
 *
 * 实测踩过：`lanhu_list_teams` 是 15 个工具里唯一没有 `ok` 的 ——
 * 靠约定一致，**漏一个没有任何东西会发现**（正是"统一返回"要消灭的那种漂移）。
 */
function withOk(r) {
  if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.ok !== 'boolean') {
    return { ok: r.failed !== true, ...r };
  }
  return r;
}

/**
 * 上游错误补一句"通常意味着什么、先做什么"（**不改写 `error`**，只补 `hint`）。
 * 保留原文是为了留证据 —— 改写上游错误会让排查断线。
 */
function withUpstreamHint(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return r;
  const failed = r.ok === false || r.failed === true;
  if (!failed || String(r.hint ?? '').trim() !== '') return r;
  return {
    ...r,
    hint: '先核对三件事：① 这个 id 是否来自本插件 `list_*` 的返回（过期/手抄的 id 会这样）；'
      + '② 该设计稿在蓝湖侧是否**已生成数据**（刚上传/只有图片没有图层时，蓝湖不返回 json_url）；'
      + '③ 当前账号对该团队是否有权限（多账号可用 `lanhu_who` 确认归属）。'
      + '**贴整条蓝湖链接**通常最省事（自动解析 tid/pid/image_id）。',
  };
}

/** 统一的输出 schema：宽松开放，避免任何一个多余/缺失字段让整次调用失败。 */
const looseSchema = (properties) => ({ type: 'object', additionalProperties: true, properties });

/**
 * 【以稿为准】那条里示范的「半透明色值长什么样」—— **不手抄**，直接取真正渲染三张表的
 * `bgText()` 的返回值（summary / blocks / region 的填充/底色列走的就是它）。
 * 手抄的代价实测过：提示里曾写成逗号后无空格、alpha 少前导 0 的形态，而真实产出是
 * `rgba(87, 74, 244, 0.1)` —— 模型会照着错的示例去匹配/书写。
 */
const SEMI_COLOR_SAMPLE = bgText({ hex: '#574af4', alpha: 0.1 });

const SYSTEM_HINT = [
  '蓝湖（Lanhu）设计稿读取能力已就绪（dsh-lanhu 插件）。用户提到蓝湖、设计稿、切图、设计还原、标注、色值对齐，或给出 lanhuapp.com 链接时适用。',
  '',
  '【选工具】按需求选，别默认 lanhu_read_design（每个工具产出什么、有什么限制，写在它自己的说明里）：',
  '· 还原大块布局 / 对圆角 / 查分割线 / 查文字对比度 → lanhu_read_blocks（块级清单，最贴近"人一眼核对"）',
  '· 要某区域的精确数值（含元素间距） → lanhu_read_design region=... gapMaxDistance=...',
  '· 要把稿子坐标映射到自己的坐标系（如自绘 SVG viewBox） → region + mapBox + toBox',
  '· 只要色板/字号/圆角统计 → format=tokens；要装哪些字体 → format=fonts',
  '· 要**可直接粘贴的 CSS / WXSS**（照稿写页面样式）→ lanhu_gen_code（`target: web|mini|both`，mini 给 rpx）',
  '· 改完前端要验收 → lanhu_verify_blocks（比 lanhu_verify_spec 覆盖面大）',
  '· 要问「**这次设计改了什么**」→ lanhu_diff_design（同一张稿的两个版本对比；两版大面积对不上时**明说"逐块对比不可靠"**、不硬凑差异表）',
  '· 要看**整个项目的设计系统一致性**（同一个按钮在不同稿里长了几个样、字号乱不乱、有没有近重复色）→ lanhu_audit_project（扫多张稿；命名不可靠时**判不可靠、拒绝出明细**）',
  '· 要读**设计稿上人类留的评论 / 标注 / 需求**（"要个png的图片"这种话**只在评论里**，图层树里没有）→ lanhu_read_blocks 的**「评论」段**（默认就带）',
  '⚠️ 不要 read_design(summary) 不够就转 format=full 再自己写脚本解析 —— full 是**落盘留档**用的，不是取数通道。',
  '',
  '【稿件格式】三种都能读：① Figma / Sketch 常规稿（图层树里有 `artboard`）；② **Sketch 插件导出**（`type: sketchPlugin`：图层平铺在 `info[]` 里、**没有** `artboard` —— 实测某项目 252 张里占一半以上，已支持，会归一化成同一套块/图层模型）；③ Axure 原型（`pages`，改用 lanhu_read_product_doc）。',
  '  · 结果里出现 **`unsupported: true`** + `sourceFormat`（`"sketchPlugin"` / `"unknown"`）：表示**这次一个图层都没读到** —— 那是"解析不出来"，**不是"这张稿是空的"**，别据此认定没内容；按返回文本里的「下一步」走（换一张稿 / 让设计师重导 / 只要图就用 lanhu_download_slices）。',
  '  · 正常读出但带 `sourceFormat: "sketchPlugin"`：数值是从 Sketch 的 `info[]` 映射来的（`opacity` 已从 0..100 换算、圆角取 `radius[]`、字体族名由 `postScriptName` 去字重后缀得到），照抄即可。',
  '',
  '【换算】设计稿宽度（画板 width）决定换算比：rpx = px × 750 ÷ 画板宽 —— 宽 375 的稿即 ×2，宽 750 的稿 1:1；H5/PC 端按 1:1 用 px。多倍图（@2x/@3x）只影响切图素材，不影响布局数值。结果里会写明用的是哪个基准。\n⚠️ **列表接口（list_designs）给的是缩略图预览尺寸**（实测常见是真实画板宽的 ¼），**别拿它算 rpx** —— 用读稿标题行里的画板宽。',
  '',
  '【以稿为准】不要用经验替代数值：',
  '· 字重：稿里 weight=400 就是 400，别因为"这是标题"就写 600（实测踩过）',
  '· 间距：用稿里给出的块间间距，不要凭视觉调',
  '· 色值：半透明按稿的 alpha（如 `' + SEMI_COLOR_SAMPLE + '`），**别换成"看起来差不多"的实色**（如 #f1effe，实测踩过）；填充、文字色、描边都要照抄',
  '· 尺寸：切图块（如头像）**没有填充也没有圆角**，但尺寸照样要还原 —— summary 的「关键容器」里这类块标着 `切图`，别当噪音跳过',
  '',
  '【溯源】设计稿会更新：标题行会给 version 与更新时间；要复现"当初那一版"或做验收时，显式传 version（不传默认 latest，事后无法判断代码对应哪版稿）。',
  '',
  '【定位】贴整条蓝湖链接最省事（自动解析 tid/pid/imageId；多账号按 tid 自动判定，也可用 lanhu_who 确认归属）；同一项目重复作业时，把「团队/项目 id + 画板名 → 页面」记进项目档案，下次直接读，不必每次 list_teams → list_projects → list_designs 三连。',
].join('\n');

/* ==========================================================================
 * 工具定义
 * ========================================================================== */

const checkAuthTool = tool({
  name: 'lanhu_check_auth',
  description: '检查蓝湖登录态（Cookie）是否有效，返回团队列表与有效期。开始任何蓝湖操作前先跑这个；失效时给出更新 Cookie 的具体步骤。',
  parameters: {},
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      teamCount: { type: 'integer' },
      teams: { type: 'array', items: { type: 'json' } },
    }),
    render: (_args, v) => text(v.text ?? (v.ok ? '✅ 登录有效' : '❌ 登录无效')),
  },
  async execute(args) {
    try {
      const r = await checkAuth({ account: args.account });
      if (r.ok) {
        const lines = [
          `✅ 蓝湖登录有效`,
          `· Cookie 来源：${r.cookieSource ?? '(未知)'}`,
          `· Cookie：${r.cookieMasked ?? ''}`,
        ];
        if (r.expiry) lines.push(`· 有效期至：${r.expiry.expiresAt}（剩 ${r.expiry.daysLeft} 天）`);
        lines.push(`· 团队 ${r.teamCount} 个：`);
        for (const t of r.teams ?? []) lines.push(`  - ${t.name}（${t.teamId}，成员 ${t.memberNum ?? '?'}）`);
        return { ...r, text: lines.join('\n') };
      }
      return failure(Object.assign(new Error(r.error ?? '登录无效'), { hint: r.hint }));
    } catch (e) {
      return failure(e);
    }
  },
});

const listTeamsTool = tool({
  name: 'lanhu_list_teams',
  description: '列出蓝湖账号加入的全部团队（teamId / 名称 / 成员数）。后续 list_projects、search 都需要 teamId。',
  parameters: {},
  output: {
    schema: looseSchema({
      teamCount: { type: 'integer' },
      teams: { type: 'array', items: {
        type: 'object', additionalProperties: true, properties: {
          teamId: { type: 'string' }, name: { type: 'string' }, memberNum: { type: 'integer' },
        } } },
    }),
    render: (_args, v) => text(v.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await listTeams({ account: args.account });
      const lines = r.teams.map((t) => `· ${t.name}  teamId=${t.teamId}  成员 ${t.memberNum ?? '?'}`);
      return { ...r, text: r.teams.length ? lines.join('\n') : '(没有团队)' };
    } catch (e) {
      return failure(e);
    }
  },
});

const listProjectsTool = tool({
  name: 'lanhu_list_projects',
  description: '列出团队下的项目与分组（项目名 + projectId）。用于把"某个项目"定位到 projectId，再配合 list_designs 列稿子。',
  parameters: {
    teamId: { type: 'string', description: '团队 UUID（来自 lanhu_list_teams）', required: true },
  },
  output: {
    schema: looseSchema({
      projects: { type: 'array', items: {
        type: 'object', additionalProperties: true, properties: {
          sourceId: { type: 'string' }, sourceName: { type: 'string' },
        } } },
    }),
    render: (_args, v) => text(v.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await listDirectory(args.teamId, { account: args.account });
      const lines = [r.projects.length ? `项目（${r.projects.length}）：` : '(没有项目)'];
      for (const p of r.projects) lines.push(`· ${p.sourceName}  projectId=${p.sourceId}`);
      if (r.folders.length) {
        lines.push('', `分组目录（${r.folders.length}）：`);
        for (const f of r.folders) lines.push(`· ${f.sourceName}  folderId=${f.sourceId}`);
      }
      return { ...r, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const listDesignsTool = tool({
  name: 'lanhu_list_designs',
  description: '列出某个项目下的设计稿（稿名 / 尺寸 / imageId）。⚠️ **尺寸是缩略图预览尺寸**，不是画板真实尺寸（常见 ¼）——算 rpx 请用读稿标题行里的画板宽。**可以直接贴蓝湖链接**（里面的 tid/pid 自动解析，不用手拆）；也可以给 projectId。'
    + `（分页：默认 ${LIMITS.listDefaultImages} 张/页）`
    + '要看**产品文档/原型**请用 lanhu_list_product_documents。',
  parameters: {
    url: { type: 'string', description: '蓝湖链接（整条粘贴即可 —— 里面的 tid/pid 会自动解析，不用手拆）' },
    projectId: { type: 'string', description: '项目 UUID（与 url 二选一；**两个都给时以 projectId 为准**）' },
    sector: { type: 'string', description: '分组名（可选；实测未分组项目也能列出全部稿子，无需此参数）' },
    limit: { type: 'integer', description: `本页几张（默认 ${LIMITS.listDefaultImages}/上限 ${LIMITS.listMaxImages}）` },
    offset: { type: 'integer', description: '从第几张开始（默认 0）' },
  },
  output: {
    schema: looseSchema({
      projectName: { type: 'string' },
      images: { type: 'array', items: {
        type: 'object', additionalProperties: true, properties: {
          imageId: { type: 'string' }, name: { type: 'string' },
          width: { type: 'number' }, height: { type: 'number' },
        } } },
      totalImages: { type: 'integer' },
      pageImages: { type: 'integer' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
      hasMore: { type: 'boolean' },
    }),
    render: (_args, v) => text(v.text ?? ''),
  },
  async execute(args) {
    try {
      // 与其它工具一致：**贴链接就行**（本项目对外承诺"链接里的 tid/pid 不用手拆"）。
      // 显式 projectId 优先；两个都不给 → 明确报错，**不许静默返回空列表**。
      const parsed = args.url ? parseProjectTarget(args.url) : null;
      const projectId = args.projectId ?? parsed?.projectId ?? null;
      if (!projectId) {
        throw new Error('需要 projectId，或一条蓝湖链接 url（两个都不给，无法定位项目）。\n提示：贴整条蓝湖链接最省事。');
      }
      const r = await listImages(projectId, { account: args.account });
      // ⚠️ **分页只在工具这一层做**：`listImages` 核心仍然一次拿全 ——
      //    面板「稿」下拉（`/lanhu/designs`）、`/lanhu/versions-count` 的 `total`、审计、CLI
      //    走的都是核心函数，**一个都不能因为这里的默认 limit 少拿数据**。
      const all = r.images ?? [];
      const limit = clampPage(args.limit, LIMITS.listDefaultImages, LIMITS.listMaxImages);
      const offset = clampOffset(args.offset);
      // sector 是**客户端过滤**：先在全集上过滤，再分页 —— 否则"共 N 张"与翻页都会算错
      const filtered = args.sector ? all.filter((i) => (i.group ?? []).includes(args.sector)) : all;
      const page = filtered.slice(offset, offset + limit);
      // 显式给了分组时把"过滤后几张"一并写出来 —— 否则标题的"共 N 张"与页脚的"共 M 张"看着自相矛盾
      const lines = [`${r.projectName ?? projectId}：${all.length} 张设计稿${args.sector ? `（分组「${args.sector}」${filtered.length} 张）` : ''}`];
      for (const i of page) {
        // ⚠️ 这里的 width×height 是**缩略图预览尺寸**，不是画板真实尺寸（实测常见 ¼：列表 187.5 ↔ 真实 750、
    //    列表 480 ↔ 真实 1920）。若 AI 拿它算 rpx 会**算错比例**。标注出来，并指向读稿标题行。
    lines.push(`· ${i.name}  ${i.width}×${i.height}（预览）  imageId=${i.imageId}`);
      }
      // 截断**不许静默**：共几 / 本页几 / 下一页传什么，一句话写全
      const note = pageNote({ shown: page.length, total: filtered.length, offset, limit, unit: '张设计稿' });
      if (note) lines.push('', note);
      return {
        ...r,
        images: page,
        totalImages: all.length,
        pageImages: page.length,
        offset, limit,
        hasMore: offset + page.length < filtered.length,
        text: lines.join('\n'),
      };
    } catch (e) {
      return failure(e);
    }
  },
});

const searchTool = tool({
  name: 'lanhu_search',
  description: '在蓝湖团队里全局搜索设计稿 / 项目 / PRD（按名称关键词）。当不知道稿子在哪个项目、或只记得名字时用这个。'
    + `（分页：默认每类 ${LIMITS.searchDefaultItems} 条/页）`,
  parameters: {
    teamId: { type: 'string', description: '团队 UUID', required: true },
    keyword: { type: 'string', description: '搜索关键词（稿名的一部分）', required: true },
    limit: { type: 'integer', description: `每类各几条（默认 ${LIMITS.searchDefaultItems}/上限 ${LIMITS.searchMaxItems}）` },
    offset: { type: 'integer', description: '从第几条开始（默认 0）' },
  },
  output: {
    schema: looseSchema({
      images: { type: 'array', items: { type: 'json' } },
      projects: { type: 'array', items: { type: 'json' } },
      totals: { type: 'json' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
      hasMore: { type: 'boolean' },
    }),
    render: (_args, v) => text(v.text ?? ''),
  },
  async execute(args) {
    try {
      const limit = clampPage(args.limit, LIMITS.searchDefaultItems, LIMITS.searchMaxItems);
      const offset = clampOffset(args.offset);
      // 接口是 pageNo/pageSize 制：把"要第 offset 条起的 limit 条"翻译过去，再切掉页内前 offset%limit 条
      const pageNo = Math.floor(offset / limit) + 1;
      const skip = offset % limit;
      const r = await coreSearch(args.teamId, args.keyword, {
        account: args.account, pageSize: limit, pageNo, withTotals: true,
      });
      const images = r.images.slice(skip, skip + limit);
      const projects = r.projects.slice(skip, skip + limit);
      const prds = r.prds.slice(skip, skip + limit);
      const t = r.totals ?? null;
      const lines = [];
      if (images.length) {
        lines.push(`设计稿 ${images.length} 个：`);
        for (const i of images) lines.push(`· ${i.name}  @${i.projectName}  imageId=${i.imageId}  projectId=${i.projectId}`);
      }
      if (projects.length) {
        lines.push('', `项目 ${projects.length} 个：`);
        for (const p of projects) lines.push(`· ${p.name}  projectId=${p.projectId}`);
      }
      if (prds.length) {
        lines.push('', `PRD ${prds.length} 个：`);
        for (const d of prds) lines.push(`· ${d.name}  path=${d.path}`);
      }
      // 截断**不许静默**：共几条（接口给的 total，拿不到就不编）/ 本页几条 / 下一页传什么
      let hasMore = false;
      let note = null;
      if (lines.length) {
        const shown = images.length + projects.length + prds.length;
        hasMore = t
          ? (t.images > offset + images.length || t.projects > offset + projects.length || t.prds > offset + prds.length)
          // 拿不到 total 的形态：只能按"本页满了"推测**可能**还有（明说这是推测，不冒充确切结论）
          : (r.images.length === limit || r.projects.length === limit || r.prds.length === limit);
        const totalText = t ? `共 ${t.images + t.projects + t.prds} 条` : '共多少条未取到';
        note = `— ${totalText}（稿 ${t ? t.images : '?'} · PRD ${t ? t.prds : '?'} · 项目 ${t ? t.projects : '?'}），`
          + `本页 ${shown} 条（offset=${offset}，limit=${limit}）；`
          + (hasMore
            ? `**下一页传 \`offset=${offset + shown}\`**${t ? '' : '（本页已满，**推测**还有更多）'}`
            : '已到末页');
      }
      return {
        ...r,
        images, projects, prds,
        offset, limit, hasMore,
        text: lines.length ? `${lines.join('\n')}\n\n${note}` : `没有匹配「${args.keyword}」的结果。`,
      };
    } catch (e) {
      return failure(e);
    }
  },
});

const readDesignTool = tool({
  name: 'lanhu_read_design',
  description: '读取蓝湖设计稿的结构化图层数据：精确色值/字号/字重/字体/圆角/坐标/文本内容/父子内边距。默认 summary 返回紧凑文本（色板 + 字号 + 关键容器 + 文本层）；支持按区域取数并把稿子坐标映射到目标坐标系（region / mapBox / toBox），层数多时用 limit 看全量。',
  parameters: {
    projectId: { type: 'string', description: '项目 UUID（与 imageId 搭配）' },
    imageId: { type: 'string', description: '设计稿 id（与 projectId 搭配）' },
    url: { type: 'string', description: '蓝湖链接（与 projectId+imageId 二选一）' },
    format: {
      type: 'string',
      description: 'summary=紧凑文本（默认，含色板/字号/关键容器/文本层）；full=全量图层落盘 JSON 并返回路径；tokens=仅色板/字号/圆角统计；fonts=**字体需求清单**（要装哪些字体、各用多少处、涉及哪些字重，交给前端直接照装）',
      enum: ['summary', 'full', 'tokens', 'fonts'],
    },
    outDir: { type: 'string', description: '仅 format=full 时生效：落盘目录' },
    region: { type: 'string', description: '按区域过滤：如 "95,215" 取 y∈[95,215]，或 "x0,y0,x1,y1"。直接输出可用图层表（含相对父容器的内边距），替代手写抠图脚本' },
    minWidth: { type: 'integer', description: '配合 region：只保留宽度 ≥ 该值的层' },
    limit: { type: 'integer', description: '配合 region：最多列多少层（默认 80；表头会标注，调大它看全）' },
    mapBox: { type: 'string', description: '配合 region：设计稿参照框 "x0,y0,x1,y1"（如地图区域总 bbox）。与 toBox 同时给时，输出增加映射后的坐标列' },
    toBox: { type: 'string', description: '配合 region：目标参照框 "X0,Y0,X1,Y1"（如本地自绘 SVG 的内容 bbox）。x/y 各自独立缩放（非等比），长宽比不同也能对' },
    version: { type: 'string', description: '版本 id（默认 latest）。给了具体 id 就**必须命中** —— 命中不了明确报错，**不静默回退最新版**；结果里的 version 字段会写明实际用了哪一版、是否最新' },
    gapMaxDistance: { type: 'number', description: '配合 region：几何间距只保留 ≤ 该值的（不传则全留）。间距=**只在另一轴有重叠**的相邻元素之间的最近边距，可直接抄进 CSS，不用拿坐标手算' },
    dualUnits: { type: 'boolean', description: '默认关闭。开启后**宽表**（关键容器 / 文本层的尺寸列）也给双单位 `120×152px / 240×304rpx`；「间距一览」与 region 输出**始终**双单位 —— 那两处就是要直接抄进 CSS 的。换算比按**画板宽度**算，基准确会写在输出里' },
    dds: { type: 'boolean', description: '默认关闭。开启后额外尝试取蓝湖 **DDS（设计数据服务）** 的 schema，结果以 source:"dds" 标注。⚠️ 那是社区实测的**非官方**通道（另域 + 独立 Cookie），随时可能失效——**失败只如实记录原因，不影响常规解析结果**，也**不要把它当主路径**' },
  },
  output: {
    schema: looseSchema({
      name: { type: 'string' },
      format: { type: 'string' },
      // ⭐ 「**一个图层都没读到**」的机器可读标志（不用解析 text 就能判断）：
      //    普通稿**不带**这两个字段（返回体与以前逐字节一致）。
      unsupported: { type: 'boolean' },
      code: { type: 'string' },
      sourceFormat: { type: 'string' },
      layerCount: { type: 'integer' },
      textLayerCount: { type: 'integer' },
      text: { type: 'string' },
      filePath: { type: 'string' },
      textBytes: { type: 'integer' },
    }),
    render: (_args, v) => {
      const parts = [];
      if (typeof v?.text === 'string' && v.text.length > 0) parts.push(v.text);
      // full 模式**必须回显落盘路径** —— 不回显等于让人以为没生效（实测反馈 P1，最大时间浪费点）
      if (v?.filePath) {
        parts.push(
          '',
          '---',
          `📄 全量图层树已落盘：${v.filePath}${v.fileBytes ? `（${v.fileBytes} 字节）` : ''}`,
          '   扁平结构，字段：name / type / x,y,w,h / depth / inset / colors / font / radius / shape',
          '   按区域抠图层（内含父子内边距推导）可用 CLI：',
          '   lanhu read --project <pid> --image <iid> --region <y0>,<y1>',
        );
      }
      if (v?.failed) parts.push(String(v.error ?? '读取失败'));
      return text(parts.join('\n') || '(无内容)');
    },
  },
  async execute(args) {
    try {
      const r = await readDesign({
        projectId: args.projectId,
        imageId: args.imageId,
        url: args.url,
        format: args.region ? 'region' : (args.format ?? 'summary'),
        region: args.region,
        minWidth: args.minWidth,
        // ⚠️ 这三个之前只写在 schema 里、没往 readDesign 传 —— 调用方传了会被**静默忽略**：
        //    limit 传 900 仍只回 80 层；mapBox/toBox 传了坐标也不映射。CLI 一直是对的，只有工具这条链断了。
        limit: args.limit,
        mapBox: args.mapBox,
        toBox: args.toBox,
        version: args.version,
        gapMaxDistance: args.gapMaxDistance,
        // 双单位开关（默认关）：宽表默认不双单位，免得每行撑到 200+ 字符（§4.6 的省字节目标）
        dualUnits: args.dualUnits,
        dds: args.dds,
        outDir: args.outDir,
        account: args.account,
      });
      return r;
    } catch (e) {
      return failure(e);
    }
  },
});

const readBlocksTool = tool({
  name: 'lanhu_read_blocks',
  description: '把设计稿读成「块级清单」：卡片/胶囊/文本/图片/分割线/容器，每块带齐六项属性（圆角、大小、文字色、字号、有无底色、边框/分割线），外加**图层不透明**（已累乘祖先链，与填充色 `@xx%` alpha 是两回事，两者都要还原）、**字体族**、**行高·字距**、**多段渐变的全部 stop**（`#145994@18%→#08294a@10%`）。比 lanhu_read_design 更贴近"人一眼能核对"的粒度——**设计稿里肉眼最容易漏的分割线（如 1px #E2E8F0）会单独列在"边框/分割线"段**，末尾还附可直接抄进 CSS 的**「间距一览」**与**无障碍对比度**（文字色 vs 有效背景色的 WCAG 比值，**只列不达标**的并给出可直接改的色值；背景沿祖先链找、找不到画板底色就**明说算不出、不猜**）。**另附一段「评论」**：这张稿上**人类留的评论/标注**（如「要个png的图片」）逐条列出，并把每条**映射回它落在哪个块**（`position_x/y` 是归一化坐标，已按画板尺寸换算后匹配；命中不了就**明说"未落在任何块上"**，不硬套）。还原大块布局或核对圆角/分割线时优先用它；想知道"**人类要求改什么**"也用它（评论段）。',
  parameters: {
    url: { type: 'string', description: '蓝湖设计稿链接（详情页地址整条粘贴，自动解析 tid/pid/image_id）' },
    projectId: { type: 'string', description: '项目 UUID（与 imageId 搭配；给了 url 可不传）' },
    imageId: { type: 'string', description: '设计稿 id（与 projectId 搭配）' },
    region: { type: 'string', description: '可选：区域过滤，"y0,y1" 或 "x0,y0,x1,y1"' },
    kind: { type: 'string', description: '可选：只保留某类块，逗号分隔（card/container/pill/text/image/divider）' },
    minWidth: { type: 'number', description: '可选：只保留宽度 ≥ 该值的块' },
    limit: { type: 'number', description: '文本清单最多列多少块（默认 80）' },
    includeNoise: { type: 'boolean', description: '是否包含系统 UI / 图形碎片块（默认折叠）' },
    version: { type: 'string', description: '版本 id（默认 latest）；与 read_design 同义。设计稿更新后要复现"当时那一版"就传它' },
    dualUnits: { type: 'boolean', description: '默认关闭。开启后「尺寸」列给双单位 `120×152px / 240×304rpx`（换算比按画板宽度算）；末尾的「间距一览」始终双单位' },
    comments: { type: 'boolean', description: '默认 `true`：读这张稿的**评论 / 标注**（人类留的需求；图层树里没有）。⚠️ 它是**独立接口** → **多 1~N 次请求**（没开就 2 次，开了 3 次）；只要图层时传 `false` 跳过。只读：从不改 / 删评论，也不标记已读' },
    commentMaxReplies: { type: 'number', description: '每条评论最多列几条回复（默认 5）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      blockCount: { type: 'integer' },
      noiseCount: { type: 'integer' },
      // ⭐ 「**一个图层都没读到**」的机器可读标志（不用解析 text 就能判断）：
      //    普通稿**不带**这两个字段（返回体与以前逐字节一致）。
      unsupported: { type: 'boolean' },
      code: { type: 'string' },
      sourceFormat: { type: 'string' },
      layerCount: { type: 'integer' },
      kindCounts: { type: 'json' },
      // 版本溯源（与 read_design 的 `version` 同形状）：不指定 version 时读到的是 latest，
      // 调用方要能知道"我照着做的是哪一版" —— 设计变更 diff / 验收都靠它当基准。
      version: { type: 'json' },
      versionIsLatest: { type: 'boolean' },
      latestVersionAt: { type: 'string' },
      // 对比度审计的机器可读摘要（人读的整段在 text 里）
      contrast: { type: 'json' },
      // 评论 / 标注（§4.9）：**只在真有评论时才带这个键**（没评论 / `comments:false` / 读取失败都不带）
      comments: { type: 'json' },
      // 读取失败时的原因（**明说**，别让调用方把"读不到"当成"没有评论"）
      commentsError: { type: 'string' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      return await readBlocks({
        url: args.url,
        projectId: args.projectId,
        imageId: args.imageId,
        region: args.region,
        kind: args.kind,
        minWidth: args.minWidth,
        limit: args.limit,
        includeNoise: args.includeNoise,
        version: args.version,
        dualUnits: args.dualUnits,
        comments: args.comments,
        commentMaxReplies: args.commentMaxReplies,
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

const diffDesignTool = tool({
  name: 'lanhu_diff_design',
  description: '**同一张稿的两个版本对比** —— 回答「这次设计改了什么」。蓝湖自己不提供版本对比，'
    + '而设计一改、已经写好的页面就过期了。按「人会怎么说这次改动」组织输出：尺寸/圆角、颜色、布局、'
    + '文字、边框、结构、新增、删除，**每类只列有变化的**且数值给「从→到」；零变化的块只给一句汇总'
    + '（"其余 N 块未变"）；两版没差异时**明说"两版一致"**（设计没改，代码可以不动）。'
    + '**匹配可靠度会明确报出来**：多少块按层路径精确匹配、多少只能靠几何近似、多少对不上；'
    + '两版大面积对不上时（整版重画/重排）会**明说"差异过大，逐块对比不可靠"并拒绝出明细表** —— '
    + '不会硬凑一张看起来精确的差异表。',
  parameters: {
    url: { type: 'string', description: '蓝湖设计稿链接（详情页地址整条粘贴，自动解析 tid/pid/image_id）' },
    projectId: { type: 'string', description: '项目 UUID（与 imageId 搭配；给了 url 可不传）' },
    imageId: { type: 'string', description: '设计稿 id（与 projectId 搭配）' },
    from: { type: 'string', description: '对比的**起点**版本 id（旧的那一版）。版本 id 从 `lanhu_read_blocks` / `lanhu_read_design` 返回的 `version.id` 里取；给不存在的 id 会报错，**不会**静默回退到最新版', required: true },
    to: { type: 'string', description: '对比的**终点**版本 id（新的那一版）。省略 = 最新版（latest）' },
    limit: { type: 'integer', description: `每类最多几行（默认 ${LIMITS.diffMaxRowsPerCategory}；超出只计数并写明调大它）` },
    includeNoise: { type: 'boolean', description: '是否把系统 UI / 图形碎片块也纳入比对（默认 false，与块级清单同一个折叠口径）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      format: { type: 'string' },
      name: { type: 'string' },
      from: { type: 'json' },
      to: { type: 'json' },
      identical: { type: 'boolean' },
      reliable: { type: 'boolean' },
      reliability: { type: 'json' },
      counts: { type: 'json' },
      changes: { type: 'json' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      return await diffDesign({
        url: args.url,
        projectId: args.projectId,
        imageId: args.imageId,
        from: args.from,
        to: args.to,
        limit: args.limit,
        includeNoise: args.includeNoise,
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

const auditProjectTool = tool({
  name: 'lanhu_audit_project',
  description: '**跨稿一致性审计（设计系统漂移）** —— 蓝湖完全不提供这个。扫**一个项目的多张稿**，'
    + '报「同一组件在不同稿里长成了不同样子」：① 同一组件、多种规格（某组件的圆角/高度分布 + '
    + '建议以哪个为准，按多数派）② 字号阶梯失控（全项目用了 N 种字号、其中哪些只出现 1 次 → 收敛建议）'
    + '③ 色值漂移（近重复色：#574af4 与 #574bf5 这种肉眼分不出的，按 RGB 距离阈值聚类）'
    + '④ 间距尺度（跑出 4px 栅格的野值）⑤ 圆角家族。'
    + '**「同一个组件」的判据是层名归一化后相同**，判据与覆盖率都写在输出里；`Rectangle 12` / `矩形 3` / '
    + '空名这类**工具默认名一律不认**（不硬凑）——命名不可靠时**判 unreliable 并拒绝出明细**。'
    + '⚠️ 成本：**扫 N 张 = 2N 次请求**，所以默认只扫限额张数，要更多显式传 limit，但**绝不超过硬上限**；'
    + '输出里写明 scanned / total / 是否被截断。',
  parameters: {
    url: { type: 'string', description: '项目链接或任意一张稿的链接（整条粘贴，自动解析 tid/pid；审计的是**整个项目**）' },
    projectId: { type: 'string', description: '项目 UUID（与 url 二选一）。一个项目往往有很多张稿，用它最直接' },
    limit: { type: 'integer', description: '最多扫多少张稿（默认 50；**硬上限 200**，传更大也只会扫 200）。别一上来就拉满 —— 成本见工具说明' },
    maxRows: { type: 'integer', description: `放宽「其余 N 种/N 条」的每类上限（默认 ${LIMITS.auditMaxFindings}/${LIMITS.auditMaxSpecValues}/${LIMITS.auditMaxColors}）` },
    includeNoise: { type: 'boolean', description: '是否把系统 UI / 图形碎片块也纳入统计（默认 false，与块级清单同一个折叠口径）' },
    allowWeakNaming: { type: 'boolean', description: '命名不可靠时是否仍然给出**不依赖层名**的几项（字号阶梯 / 近重复色 / 间距 / 圆角）。默认 false = 一项都不出（硬凑的结论比不给更糟）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      format: { type: 'string' },
      projectName: { type: 'string' },
      scanned: { type: 'integer' },
      total: { type: 'integer' },
      truncated: { type: 'boolean' },
      reliable: { type: 'boolean' },
      naming: { type: 'json' },
      driftedCategories: { type: 'array', items: { type: 'string' } },
      findings: { type: 'json' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      return await auditProject({
        url: args.url,
        projectId: args.projectId,
        limit: args.limit,
        maxRows: args.maxRows,
        includeNoise: args.includeNoise,
        allowWeakNaming: args.allowWeakNaming,
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

const listProductDocumentsTool = tool({
  name: 'lanhu_list_product_documents',
  description: '列出蓝湖项目下的**产品文档**（也叫原型 / PRD —— Axure 导出，`docType=axure`）。**这不是设计稿**：设计稿回答"什么颜色、几 px 圆角"，产品文档回答"业务规则、字段、跳转"。当用户给的是**原型链接**（URL 里带 `docType=axure`），或要看需求文档/PRD/原型、要定位某一步的业务规则时用它；顺带返回项目名/文件夹/创建者。拿到的 docId 交给 lanhu_read_product_doc 读页面树与正文；设计稿请用 lanhu_list_designs。输出带 `order` —— 蓝湖「文档」面板**按它倒序**显示且是**滚动区**，界面上只看到前几个**不代表只有几个**。',
  parameters: {
    url: { type: 'string', description: '蓝湖原型链接（整条粘贴，自动解析 tid/pid/docId/pageId）' },
    teamId: { type: 'string', description: '团队 UUID（与 projectId 搭配；给了 url 可不传）' },
    projectId: { type: 'string', description: '项目 UUID（与 teamId 搭配）' },
    withPages: { type: 'boolean', description: 'true = 额外附上每份原型的**页面规模**（页面节点数 / 可读页数），便于一眼选对文档。**代价：N 份 = N 次额外请求**（每份拉一次 sitemap），**默认关**；单份失败只标 `?`，不让整张表失败' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      project: { type: 'json' },
      docCount: { type: 'integer' },
      docs: { type: 'json' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const parsed = args.url ? parseProductUrl(args.url) : {};
      const projectId = args.projectId ?? parsed.projectId;
      const teamId = args.teamId ?? parsed.teamId;
      if (!projectId) {
        throw new Error('需要 projectId（或一条产品文档链接 url）。原型列表接口**必须**同时给 teamId —— 蓝湖不接受缺省团队。');
      }
      if (!teamId) {
        throw new Error('需要 teamId（tid）—— 蓝湖 product_documents 接口必须带团队 id。\n提示：贴整条原型链接最省事，链接里就带 tid。');
      }
      // 没显式指定账号时自动判定（多账号场景：别的 AI 只有一条链接）
      const picked = await pickAccount({ account: args.account, teamId, projectId });
      const listed = await productDocuments(projectId, teamId, { account: picked.alias });
      const info = await multiInfo(projectId, teamId, { account: picked.alias }).catch(() => null);

      // withPages：逐份拉 sitemap 数页面规模（**默认关** —— N 份 = N 次额外请求）。
      // ⚠️ 单份失败**只标 `?`**，绝不让整张表失败：否则"一份权限不足"就毁掉整个清单。
      const withPages = Boolean(args.withPages);
      if (withPages) {
        for (const d of listed.axureDocs) {
          try {
            const { tree } = await fetchDesignTree(projectId, d.docId, { account: picked.alias, expect: 'prototype' });
            const c = countSitemapPages(tree?.sitemap?.rootNodes);
            d.pages = { nodes: c.nodes, readable: c.readable };
          } catch (e) {
            d.pages = { nodes: null, readable: null, reason: String(e?.message ?? e).slice(0, 80) };
          }
        }
      }
      const table = productDocsTable(listed.axureDocs, { withPages });
      const lines = [
        `# 产品文档（原型）${info?.name ? ` —— ${info.name}` : ''}`,
        info ? `> 项目：${info.folderName ? `${info.folderName} / ` : ''}${info.name ?? '—'}${info.creatorName ? ` · 创建者 ${info.creatorName}` : ''}` : '',
        `> 共 ${listed.total} 个资源，其中 **${listed.axureDocs.length} 个是 axure 原型文档**。`,
        '> ⚠️ 这是**产品文档/原型**，不是设计稿。要色值/字号请用 lanhu_read_design。',
        '',
        table.header,
        table.sep,
        ...table.rows,
        '',
        '> 「序」是接口的 `order`：蓝湖「文档」面板**按它倒序**显示，而且是**滚动区** —— 界面上只看到前几个，**不代表只有那几个**。',
        ...(withPages ? [`> 「页面节点 / 可读页」是**逐份拉 sitemap 数出来的**（本次额外发了 ${listed.axureDocs.length} 次请求）；\`?\` = 那份拉取失败（原因在该文档的 \`pages.reason\`）。Folder 节点没有 url，所以**节点数 ≥ 可读页数**。`] : []),
        '',
        `用 \`lanhu_read_product_doc\` + docId 读页面树与正文（共 ${listed.axureDocs.length} 份可选）。`,
      ].filter(Boolean);
      return { ...listed, project: info, docCount: listed.axureDocs.length, account: picked.alias, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const readProductDocTool = tool({
  name: 'lanhu_read_product_doc',
  description: '读蓝湖**产品文档（Axure 原型 / PRD）**的页面树与正文 —— 需求文档、原型交互、业务规则的来源。**不是设计稿**（色值/字号/圆角用 lanhu_read_design）。返回：页面树（层级/path/类型/pageId）+ 命中页的正文文本。`format:"layers"` 取**样式图层/块级清单**（项目只有原型、没有设计稿时靠它照着实现）。⚠️ 正文文本为空的页**不等于没内容**（原型常以矢量/图片导出）—— 那时改看 `format:"layers"` 的图层。',
  parameters: {
    url: { type: 'string', description: '蓝湖原型链接（整条粘贴，URL 里的 pageId 会被自动选中）' },
    projectId: { type: 'string', description: '项目 UUID（与 docId 搭配）' },
    docId: { type: 'string', description: '产品文档 id（= 原型链接里的 docId / image_id）。不给则取项目下第一份 axure 文档' },
    teamId: { type: 'string', description: '团队 UUID（多账号自动判定失败时显式给）' },
    pageId: { type: 'string', description: '页面 id（**跨版本稳定**，推荐用它）。**先不带它调一次看页面树**（一份原型常有上百个节点），再按它精确取正文；不给则不取正文，只回页面树' },
    pageName: { type: 'string', description: '按页面名模糊匹配（pageId 的备选）' },
    version: { type: 'string', description: '版本 id（默认 latest）。原型也会更新，要复现"当时那一版"就传它' },
    limit: { type: 'integer', description: '最多读几页正文（默认 1，避免一次拉爆）' },
    textLimit: { type: 'integer', description: '每页最多取多少条正文文本（默认 120）' },
    pageTreeLimit: { type: 'integer', description: '页面树最多几个节点（默认 200）' },
    format: {
      type: 'string',
      enum: ['doc', 'layers'],
      description: "doc（默认）= 页面树 + 正文文本（业务规则、字段、跳转）。layers = **该页的样式图层/块级清单**"
        + '（坐标·色值·字号·字重·字体族·圆角·描边·渐变·透明度·切图），与 lanhu_read_blocks 输出**同一张表**。'
        + '**什么时候用 layers**：项目里**没有设计稿、只有原型**时（`lanhu_list_designs` 返回 0 张）—— 那时 '
        + 'lanhu_read_design / lanhu_read_blocks 一点数据都拿不到，靠它才能照着实现。'
        + '⚠️ 原型是交互稿，颜色/字号是设计者随手填的，**不等于最终视觉稿**；有设计稿时仍以设计稿为准。',
    },
    layerLimit: { type: 'integer', description: 'format=layers 时最多列多少块（默认 60）' },
    includeNoise: { type: 'boolean', description: 'format=layers 时是否包含系统 UI / 图形碎片块（默认折叠）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      doc: { type: 'json' },
      pageCount: { type: 'integer' },
      wireframeCount: { type: 'integer' },
      version: { type: 'json' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await readProductDoc({
        url: args.url,
        projectId: args.projectId,
        docId: args.docId,
        teamId: args.teamId,
        pageId: args.pageId,
        pageName: args.pageName,
        version: args.version,
        limit: args.limit,
        textLimit: args.textLimit,
        pageTreeLimit: args.pageTreeLimit,
        format: args.format,
        layerLimit: args.layerLimit,
        includeNoise: args.includeNoise,
        account: args.account,
      });
      // DDS schema 是**可选增强**：只有真用上才提，失败绝不挡主流程（见 lanhu.mjs 的 ddsSchema 注释）
      return r;
    } catch (e) {
      return failure(e);
    }
  },
});

const accountsTool = tool({
  name: 'lanhu_accounts',
  description: '管理蓝湖账号（一个人有多个公司/多个蓝湖账号时用）。action：list 列出账号；add 添加或更新账号（**贴 Cookie 即可**，会自动建团队+项目索引）；remove 删除；set-default 设为默认；reindex 重建索引。判断"某张稿属于哪个账号"请用 lanhu_who。',
  parameters: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'remove', 'set-default', 'reindex'],
      required: true,
      description: '要做什么',
    },
    alias: { type: 'string', description: '账号别名（字母/数字/._-，如 acme）；add / remove / set-default / reindex 需要' },
    company: { type: 'string', description: '公司名（add 时用，便于一眼辨认）' },
    note: { type: 'string', description: '备注（add 时可选）' },
    cookie: { type: 'string', description: 'add 时可选：粘贴 Cookie。F12 → Network → 任意 lanhuapp.com 请求 → Copy as cURL → 整段贴进来即可' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      default: { type: 'string' },
      accounts: { type: 'array', items: { type: 'json' } },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const lines = [];
      const action = args.action;
      if (action === 'add') {
        if (!args.alias) throw new Error('add 需要 alias（账号别名）');
        const cookie = typeof args.cookie === 'string' && args.cookie.trim()
          ? parseCookieInput(args.cookie).cookie
          : null;
        const { entry, created } = upsertAccount({
          alias: args.alias, company: args.company, note: args.note, cookie,
        });
        lines.push(`${created ? '✅ 已添加' : '✅ 已更新'}账号 ${entry.alias}（${entry.company}）`);
        if (cookie) lines.push('Cookie 已写入（600）');
        if (cookie) {
          try {
            const ix = await buildAccountIndex(entry.alias);
            lines.push(`索引完成：${ix.teamCount} 个团队 / ${ix.projectCount} 个项目`
              + (ix.errors.length ? `（部分失败：${ix.errors.join('；')}）` : ''));
          } catch (e) {
            lines.push(`⚠️ 索引失败（不影响读稿，稍后可 reindex）：${e.message}`);
          }
        }
      } else if (action === 'remove') {
        if (!args.alias) throw new Error('remove 需要 alias');
        const r = removeAccount(args.alias);
        lines.push(`✅ 已删除账号 ${r.removed}（默认账号：${r.default ?? '无'}）`);
      } else if (action === 'set-default') {
        if (!args.alias) throw new Error('set-default 需要 alias');
        const r = setDefaultAccount(args.alias);
        lines.push(`✅ 默认账号 → ${r.default}`);
      } else if (action === 'reindex') {
        const doc = listAccounts();
        const targets = args.alias ? [args.alias] : doc.accounts.map((a) => a.alias);
        if (targets.length === 0) throw new Error('还没配置任何账号，先 add 一个。');
        for (const a of targets) {
          const ix = await buildAccountIndex(a);
          lines.push(`${a}：${ix.teamCount} 团队 / ${ix.projectCount} 项目${ix.errors.length ? ` ⚠️ ${ix.errors.join('；')}` : ''}`);
        }
      }
      const acc = listAccounts();
      lines.push('');
      lines.push(`默认账号：${acc.default ?? '（无）'}　共 ${acc.accounts.length} 个`);
      for (const a of acc.accounts) {
        const days = a.expiry ? `剩 ${a.expiry.daysLeft} 天` : (a.hasCookie ? '有效期未知' : '❌ 无 Cookie');
        lines.push(`${a.isDefault ? '★' : '·'} ${a.alias}（${a.company}）　${days}　团队 ${a.teamCount} · 项目 ${a.projectCount}${a.note ? `　${a.note}` : ''}`);
      }
      if (acc.accounts.length === 0) {
        lines.push('（还没配置账号。没配置时读稿会退回旧的单 Cookie 路径，行为与从前一致）');
      }
      return { ok: true, default: acc.default, accounts: acc.accounts, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const whoTool = tool({
  name: 'lanhu_who',
  description: '判断一张蓝湖稿子属于哪个账号（多公司/多账号场景）。**贴链接即可**：链接里带团队 id 或项目 id 时直接命中、**不发请求**；判不到才逐个账号探测。用户给了一张读不到的稿、或不确定该用哪个账号时，先跑它再读稿 —— 比逐个账号试错便宜。',
  parameters: {
    url: { type: 'string', description: '蓝湖设计稿链接（推荐，含 tid 就能零请求判定）' },
    projectId: { type: 'string', description: '项目 UUID（没链接时用）' },
    imageId: { type: 'string', description: '设计稿 id（没链接时用）' },
    teamId: { type: 'string', description: '团队 UUID（最准，链接里的 tid）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      found: { type: 'boolean' },
      matchedBy: { type: 'string' },
      alias: { type: 'string' },
      company: { type: 'string' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await whoIsIt({
        url: args.url, projectId: args.projectId, imageId: args.imageId, teamId: args.teamId,
      });
      const lines = [];
      if (r.found) {
        const by = r.matchedBy === 'tid' ? '链接里的团队 id（零请求）'
          : r.matchedBy === 'pid' ? '项目 id（零请求）'
            : '实时探测（已回填索引，下次零请求）';
        lines.push(`✅ 归属账号：${r.company}（${r.alias}）`);
        lines.push(`命中依据：${by}`);
        if (r.team) lines.push(`团队：${r.team.name ?? r.team.teamId}`);
        if (r.project) lines.push(`项目：${r.project.name ?? r.project.projectId}`);
        if (r.expiry) lines.push(`Cookie：剩 ${r.expiry.daysLeft} 天`);
        lines.push('');
        lines.push(`接下来读稿时带上 account="${r.alias}" 即可（或用默认账号）。`);
      } else {
        lines.push('❓ 没找到这张稿的归属账号');
        if (r.knownAccounts?.length) {
          lines.push('已知账号：' + r.knownAccounts.map((a) => `${a.company}(${a.alias}，${a.teamCount} 团队)`).join('、'));
        }
        if (r.readable) lines.push('提示：这张稿**能读到**，但不属于任何已配置账号的团队/项目 —— 详见下方说明。');
        lines.push('');
        lines.push(r.hint);
      }
      return { ok: r.found, ...r, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const verifyBlocksTool = tool({
  name: 'lanhu_verify_blocks',
  description: '块级比对：把设计稿里**每个可见块**与页面元素逐一比对**六项属性 + 字体族**（圆角 / 大小 / 文字色 / 字号 / 有无底色 / 边框 / font-family），输出四态报告（✅ 完全匹配 ｜ 🟡 容差内 ｜ ❌ 不匹配 ｜ ⚪ 无法比对）与**可直接抄的建议改法**（含目标端单位）。字体族判定：设计稿字体出现在页面 font-family 栈前 3 位即 ✅，排太后 🟡（存在但易被盖住），栈里没有 ❌。元素映射三级：页面 [data-lanhu] 标注 → 文本内容 → **几何最近邻兜底**（所以头像、卡片背景、分割线这些无文本块也能比）。比 lanhu_verify_spec 覆盖面大得多，验收还原度优先用它。',
  parameters: {
    pageUrl: { type: 'string', description: '要验收的页面地址（如 http://localhost:5173/）', required: true },
    url: { type: 'string', description: '蓝湖设计稿链接（贴整条即可）' },
    projectId: { type: 'string', description: '项目 UUID（没链接时用）' },
    imageId: { type: 'string', description: '设计稿 id（没链接时用）' },
    target: { type: 'string', enum: ['h5', 'mini'], description: '目标端：h5 给 px，mini 给 rpx（默认 h5）' },
    viewportWidth: { type: 'number', description: '页面视口宽（默认按设计稿宽，用于坐标/尺寸折算）' },
    kind: { type: 'string', description: '可选：只比某几类块（card,container,pill,text,image,divider）' },
    includeNoise: { type: 'boolean', description: '是否也比对系统 UI / 图形碎片（默认不比）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      blockCount: { type: 'integer' },
      comparedCount: { type: 'integer' },
      elementCount: { type: 'integer' },
      engine: { type: 'string' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      return await verifyBlocks({
        pageUrl: args.pageUrl,
        url: args.url, projectId: args.projectId, imageId: args.imageId,
        target: args.target, viewportWidth: args.viewportWidth,
        kind: args.kind, includeNoise: args.includeNoise,
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

const downloadSlicesTool = tool({
  name: 'lanhu_download_slices',
  description: '下载蓝湖设计稿的切图到本地（默认 assets/lanhu/），按内容哈希去重并产出 mapping.json。当需要把设计稿里的图标/图片素材落地到工程时用。',
  parameters: {
    projectId: { type: 'string', description: '项目 UUID' },
    imageId: { type: 'string', description: '设计稿 id' },
    url: { type: 'string', description: '蓝湖链接（与前两者二选一）' },
    outDir: { type: 'string', description: '输出目录（默认 <cwd>/assets/lanhu）' },
    version: { type: 'string', description: '版本 id（默认 latest）。切图也要能追溯"这是哪一版导出的"' },
    targetDpr: { type: 'number', description: '目标倍率（默认取设计稿自带的 sliceScale，没有则 2）。mapping.json 里每张图带 effectiveDensity（实际像素 ÷ 渲染尺寸），**小于它就说明素材本身不够清晰**——改引用方式没用，得让设计师重导' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      dir: { type: 'string' },
      mappingPath: { type: 'string' },
      downloaded: { type: 'integer' },
      skipped: { type: 'integer' },
      assets: { type: 'integer' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await downloadSlices({
        projectId: args.projectId,
        imageId: args.imageId,
        url: args.url,
        outDir: args.outDir,
        version: args.version,
        targetDpr: args.targetDpr,
        account: args.account,
      });
      const lines = [
        `✅ 切图完成：下载 ${r.downloaded} 个${r.skipped ? `，内容重复跳过 ${r.skipped} 个` : ''}`,
        `· 目录：${r.dir}`,
        `· mapping：${r.mappingPath}`,
        `· 该稿 assets 总数：${r.assets ?? 0}`,
      ];
      if (r.failed) lines.push(`· ⚠️ 失败 ${r.failed} 个（见 mapping.json）`);
      // 半透明警告必须打出来：直接转 JPG 会丢 alpha → 整屏发灰，而"顺手转格式"最容易发生
      // （warnings 自带多行与逐张清单，别再加前缀，否则只有第一行带符号）
      for (const w of r.warnings ?? []) lines.push(w);
      return { ...r, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const verifySpecTool = tool({
  name: 'lanhu_verify_spec',
  description: '设计稿验收：打开真实页面取**实际计算出的**样式，与设计稿图层逐字段比对（色值/字号/字重/**字体族**/圆角），输出匹配率与不一致表。字体族判定刻意宽松以防误报：**设计稿字体名出现在页面 font-family 栈的前 3 位即通过**（页面栈天然带系统回退字体，要求全等会把正确页面全判错）。没有可用的浏览器时会降级为 CSS 声明级静态比对，**结果里会写明降级原因**。元素映射优先用页面上的 [data-lanhu] 属性，没有标注时按设计稿文本自动匹配叶子节点，也可显式传 selectors。',
  parameters: {
    projectId: { type: 'string', description: '项目 UUID' },
    imageId: { type: 'string', description: '设计稿 id' },
    pageUrl: { type: 'string', description: '要验收的页面地址（如 http://localhost:5173/）', required: true },
    selectors: { type: 'json', description: '可选：{"元素名": "css选择器"} 映射；不给则先扫描 [data-lanhu]，再用设计稿文本自动匹配叶子节点' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      degraded: { type: 'boolean' },
      engine: { type: 'string', description: '实际使用的引擎（puppeteer / playwright）' },
      browserSource: { type: 'string', description: '实际使用的浏览器与包路径' },
      matchRate: { type: 'number' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await verifySpec({
        projectId: args.projectId,
        imageId: args.imageId,
        pageUrl: args.pageUrl,
        selectors: args.selectors,
        account: args.account,
      });
      if (r.degraded) {
        return { ...r, text: `⚠️ 已降级：${r.reason}\n\n安装指引：${r.install}\n\n${r.staticHint ?? ''}` };
      }
      return r;
    } catch (e) {
      return failure(e);
    }
  },
});

const cookieSetTool = tool({
  name: 'lanhu_cookie_set',
  description: '更新蓝湖 Cookie。**直接粘贴浏览器里复制的内容即可**（会自动解析出 Cookie，不用手工抠串；接受的形式见 `cookie` 参数）。写前用真实请求校验；**传 `account` 就写进那个账号**（`~/.dsh/lanhu/cookies/<alias>`），不传则落盘到默认的 `~/.dsh/lanhu/cookie`（均 600）。',
  parameters: {
    cookie: { type: 'string', description: '粘贴内容：Copy as cURL 的整段文本、"Cookie: ..." 请求头、或裸 Cookie 串', required: true },
    dryRun: { type: 'boolean', description: 'true = 只解析校验并展示结果，不写入（先确认解析对不对）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      path: { type: 'string' },
      masked: { type: 'string' },
      source: { type: 'string' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await saveCookie(args.cookie, { dryRun: Boolean(args.dryRun), account: args.account });
      const lines = [
        r.dryRun ? '🔍 解析成功（dryRun，未写入）' : `✅ Cookie 已写入 ${r.path}（600）`,
        `· 解析来源：${r.source}`,
        `· Cookie：${r.masked}`,
      ];
      if (r.checks) lines.push(`· 关键项：${Object.entries(r.checks).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join('  ')}`);
      if (r.expiry) lines.push(`· 有效期至 ${r.expiry.expiresAt}（剩 ${r.expiry.daysLeft} 天）`);
      return { ok: true, ...r, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

/* ==========================================================================
 * 面板用的 HTTP 通道（Client 半边靠它取数据 —— 同源、无需 RPC）
 * ========================================================================== */

/** 只允许本机访问：GUI 在 127.0.0.1，外部 Host 头一律拒绝。 */
function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) return null;
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

/**
 * 一批稿各自的**版本数** —— 面板「稿」下拉里那个「N 版」就靠它。
 *
 * 为什么是**批量**端点而不是让面板逐张调 `/lanhu/versions`：
 * 一个项目动辄两三百张稿，逐张探 = 两三百次请求。这里一次只探 `[offset, offset+limit)`
 * 这一段，**默认 30 张、硬上限 100 张**（`LIMITS.versionsCount*`），并且：
 *   · 并发 4（与审计同口径，结果按输入下标回填 → 并发不影响输出顺序）；
 *   · **单张失败只标 `ok:false`**，不影响其它张（拿不准时不要误伤 —— 面板照常让用户选）；
 *   · 分批 + offset 游标由调用方推进 → 面板可以"先探 30 张，用户要更多再探下一批"。
 * 成本：一次调用 = 1（列稿）+ 本批张数（每张 1 次版本元信息），**不拉图层树**。
 */
async function imageVersionCounts(listDesigns, readVersions, projectId, opts = {}) {
  const account = opts.account ?? null;
  const listing = await listDesigns(projectId, { account });
  const all = listing.images ?? [];
  const total = all.length;
  // offset / limit 的夹取放在**这里**（端点入口只负责把原样的字符串递进来）：
  // 面板、CLI、以后别的调用方走的是同一条口径，不会有人绕过上限。
  const rawOffset = Number(opts.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const rawLimit = Number(opts.limit);
  const requested = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : LIMITS.versionsCountDefault;
  const limit = Math.min(requested, LIMITS.versionsCountMax);
  const slice = all.slice(offset, offset + limit);

  const images = new Array(slice.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(LIMITS.versionsCountConcurrency, slice.length)) },
    async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= slice.length) return;
        const img = slice[i];
        try {
          const r = await readVersions(projectId, img.imageId, { account });
          const vs = r.versions ?? [];
          images[i] = {
            imageId: img.imageId,
            name: r.name ?? img.name ?? null,
            versionCount: vs.length,
            // 版本列表第 0 条就是最新版（既有 `/lanhu/versions` 同一条口径）
            latestVersionId: vs[0]?.id ?? null,
            ok: true,
          };
        } catch (e) {
          // versionCount 用 null 而不是 0：0 是"确实没有版本"，null 才是"没探到"。
          // 面板据此把这条显示成「版本数未知」而**不禁用** —— 探不到不等于不能点。
          images[i] = {
            imageId: img.imageId,
            name: img.name ?? null,
            versionCount: null,
            latestVersionId: null,
            ok: false,
            error: String(e?.message ?? e).slice(0, LIMITS.auditErrorMax),
          };
        }
      }
    },
  );
  await Promise.all(workers);
  return {
    projectId,
    projectName: listing.projectName ?? null,
    total, offset, limit, images,
    account,
  };
}

/**
 * 导出 + 可注入依赖，只为自检能离屏打这个 handler（真实注册仍走 apply 里的 webServer.register）。
 * deps.checkAuth / deps.versionInfo 默认就是真实实现，**生产路径行为不变**；
 * 注入它们才能在不碰 lanhuapp.com / npm 的前提下验证「npm 挂了登录态照样成功」。
 * 「体检」两个长任务（diff / audit）同理可注入，验证「一次审计炸了不影响别的端点」。
 */
export function makeLanhuHandler(deps = {}) {
  const probeAuth = deps.checkAuth ?? checkAuth;
  const readVersion = deps.versionInfo ?? pluginVersionInfo;
  const runDiff = deps.diffDesign ?? diffDesign;
  const runAudit = deps.auditProject ?? auditProject;
  const listDesigns = deps.listImages ?? listImages;
  const readVersions = deps.imageVersions ?? imageVersions;
  const pickAcct = deps.pickAccount ?? pickAccount;
  // 批量版本数：默认就是上面两个依赖的组合（自检注入 listImages/imageVersions 即可走真实的分批逻辑）
  const countVersions = deps.versionCounts
    ?? ((projectId, o) => imageVersionCounts(listDesigns, readVersions, projectId, o));
  return async (req, res) => {
    if (!isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: '仅允许本机访问' });
      return;
    }
    const url = new URL(req.url ?? '/lanhu', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/lanhu';
    try {
      // 连通性探活：面板的「检测」就调它。版本自述是**附加项**（见下面的 merge）。
      if (route === '/lanhu' || route === '/lanhu/status') {
        // ?meta=1 → 只回版本自述、跳过蓝湖探活。
        // 为什么要这个开关：面板**一打开**就要显示版本号，而探活会真打一次 lanhuapp.com
        // （未配置 Cookie 时还会把错误写进账号 Tab 的错误位）。同一条路由、同一个 handler，
        // 不算第二条通道；「检测」按钮走的就是下面的全量分支。
        if (url.searchParams.get('meta') === '1') {
          writeJson(res, 200, { ok: true, data: await readVersion() });
          return;
        }
        // 并发取：npm 不可达时有 3s 超时，串行会把探活也一起拖慢
        const [r, v] = await Promise.all([probeAuth(), readVersion()]);
        writeJson(res, 200, {
          ok: true,
          data: { ...r, version: v.version, latest: v.latest, updateAvailable: v.updateAvailable },
        });
        return;
      }
      // 粘贴更新 Cookie（面板里贴 Copy as cURL 的内容）
      if (route === '/lanhu/cookie' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null || typeof body.input !== 'string' || body.input.length === 0) {
          writeJson(res, 400, { ok: false, error: 'body 需要 { input: "<粘贴内容>" }' });
          return;
        }
        const r = await saveCookie(body.input, { dryRun: Boolean(body.dryRun) });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // 贴链接直读块级清单（面板的主力功能）
      if (route === '/lanhu/preview' && req.method === 'POST') {
        const started = Date.now();
        const body = await readJsonBody(req);
        if (body === null || (typeof body.url !== 'string' && !(body.projectId && body.imageId))) {
          writeJson(res, 400, { ok: false, error: 'body 需要 { url: "<蓝湖链接>" }（或 projectId + imageId）' });
          return;
        }
        const r = await readBlocks({
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          projectId: body.projectId,
          imageId: body.imageId,
          region: body.region,
          kind: body.kind,
          minWidth: body.minWidth,
          includeNoise: body.includeNoise,
          limit: body.limit,
          // 面板这一屏目前**不展示**评论 → 不读（这条既有路由的返回与请求数因此**完全不变**）。
          //   要把评论也搬进面板，是**另一个**改动（面板半边 + 这里同时改），别顺手在这里打开。
          comments: false,
        });
        recordUsage({
          tool: 'panel:preview',
          ok: true,
          ms: Date.now() - started,
          args: summarizeArgs({ url: body.url, region: body.region, kind: body.kind }),
          summary: `${r.blockCount} 块 / ${r.layerCount} 层`,
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // 使用记录（面板的「插件干了啥」）
      if (route === '/lanhu/log' && (req.method === 'GET' || req.method === undefined)) {
        const limit = Number(url.searchParams.get('limit')) || 50;
        writeJson(res, 200, { ok: true, data: readUsage({ limit }) });
        return;
      }
      // 多账号：列表 / 添加 / 删除 / 切默认 / 重建索引（面板的「账号」区就调它）
      if (route === '/lanhu/accounts') {
        if (req.method === 'GET' || req.method === undefined) {
          writeJson(res, 200, { ok: true, data: listAccounts() });
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          if (body === null || typeof body.action !== 'string') {
            writeJson(res, 400, { ok: false, error: 'body 需要 { action: "list|add|remove|set-default|reindex", ... }' });
            return;
          }
          let extra = null;
          if (body.action === 'add') {
            const cookie = typeof body.cookie === 'string' && body.cookie.trim()
              ? parseCookieInput(body.cookie).cookie
              : null;
            const { entry, created } = upsertAccount({
              alias: body.alias, company: body.company, note: body.note, cookie,
            });
            extra = { alias: entry.alias, created, hasCookie: Boolean(cookie) };
            if (cookie) {
              try {
                const ix = await buildAccountIndex(entry.alias);
                extra.index = { teamCount: ix.teamCount, projectCount: ix.projectCount, errors: ix.errors };
              } catch (e) {
                extra.indexError = e?.message ?? String(e);
              }
            }
          } else if (body.action === 'remove') {
            extra = removeAccount(body.alias);
          } else if (body.action === 'set-default') {
            extra = setDefaultAccount(body.alias);
          } else if (body.action === 'reindex') {
            const doc = listAccounts();
            const targets = body.alias ? [body.alias] : doc.accounts.map((a) => a.alias);
            const done = [];
            for (const a of targets) {
              const ix = await buildAccountIndex(a);
              done.push({ alias: a, teamCount: ix.teamCount, projectCount: ix.projectCount, errors: ix.errors });
            }
            extra = { reindexed: done };
          }
          recordUsage({
            tool: `panel:accounts:${body.action}`,
            ok: true,
            args: summarizeArgs({ alias: body.alias, company: body.company }),
            summary: extra ? Object.keys(extra).join(',') : null,
          });
          writeJson(res, 200, { ok: true, data: { ...listAccounts(), extra } });
          return;
        }
      }
      // 归属判定：这张稿属于哪个账号（面板贴链接时用）
      if (route === '/lanhu/who' && req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null || (!body.url && !body.projectId && !body.imageId && !body.teamId)) {
          writeJson(res, 400, { ok: false, error: 'body 需要 { url } 或 { projectId, imageId }' });
          return;
        }
        const r = await whoIsIt({
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          projectId: body.projectId, imageId: body.imageId, teamId: body.teamId,
        });
        recordUsage({
          tool: 'panel:who',
          ok: r.found,
          args: summarizeArgs({ url: body.url }),
          summary: r.found ? `${r.company}(${r.alias}) by ${r.matchedBy}` : '未找到归属',
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // 块级比对（面板「块级」Tab 的「与页面比对」按钮用；要开浏览器，几秒起步）
      if (route === '/lanhu/verify-blocks' && req.method === 'POST') {
        const started = Date.now();
        const body = await readJsonBody(req);
        if (body === null || typeof body.pageUrl !== 'string' || !body.pageUrl.trim()) {
          writeJson(res, 400, { ok: false, error: 'body 需要 { pageUrl: "http://…", url?: "<蓝湖链接>" }' });
          return;
        }
        const r = await verifyBlocks({
          pageUrl: body.pageUrl.trim(),
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          projectId: body.projectId, imageId: body.imageId,
          target: body.target, viewportWidth: body.viewportWidth,
          kind: body.kind, includeNoise: body.includeNoise,
        });
        recordUsage({
          tool: 'panel:verify-blocks',
          ok: r.ok !== false,
          ms: Date.now() - started,
          args: summarizeArgs({ pageUrl: body.pageUrl, url: body.url, target: body.target }),
          summary: r.ok === false ? '降级/失败' : `${r.comparedCount} 块 / ${r.elementCount} 元素`,
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // ═══ 体检 · 变更（设计变更 diff）与一致性（跨稿审计）═══
      // 四条都属于**同一个 /lanhu 前缀**（不开第二条通道），入口/守卫/信封与前三条完全一致。
      //
      // 稿列表：给「变更」区的稿下拉用（选项目 → 列稿）。
      // 账号处理与 lanhu_list_designs 同一条链：能判就判（链接里的 tid/pid），判不到退回默认账号。
      if (route === '/lanhu/designs' && (req.method === 'GET' || req.method === undefined)) {
        const link = url.searchParams.get('url');
        const parsed = link ? parseProjectTarget(link) : null;
        const projectId = url.searchParams.get('pid') || parsed?.projectId || null;
        if (!projectId) {
          writeJson(res, 400, { ok: false, error: '需要 ?pid=<projectId> 或 ?url=<蓝湖链接>（两个都不给，无法定位项目）' });
          return;
        }
        const picked = await pickAcct({ teamId: parsed?.teamId ?? null, projectId });
        const r = await listDesigns(projectId, { account: picked.alias });
        writeJson(res, 200, {
          ok: true,
          data: {
            projectId,
            // 链接里带 image_id 时把它带回去：面板据此自动选中那张稿，省掉一次手选
            imageId: parsed?.imageId ?? null,
            projectName: r.projectName ?? null,
            // 稿列表可能上百条：只回面板下拉要用的三样，别把整包详情塞进面板
            images: (r.images ?? []).map((i) => ({ imageId: i.imageId, name: i.name ?? null, width: i.width ?? null, height: i.height ?? null })),
            account: picked.alias ?? null,
          },
        });
        return;
      }
      // 版本列表：diff 的「起点/终点」下拉就靠它（一次请求同时给出每版的 json_url）。
      if (route === '/lanhu/versions' && (req.method === 'GET' || req.method === undefined)) {
        const link = url.searchParams.get('url');
        const parsed = link ? parseProjectTarget(link) : null;
        const projectId = url.searchParams.get('pid') || parsed?.projectId || null;
        const imageId = url.searchParams.get('iid') || parsed?.imageId || null;
        if (!projectId || !imageId) {
          writeJson(res, 400, { ok: false, error: '需要 ?pid=<projectId>&iid=<imageId>，或 ?url=<某张稿的蓝湖链接>（列表页链接没有 image_id，不算）' });
          return;
        }
        const picked = await pickAcct({ teamId: parsed?.teamId ?? null, projectId });
        const r = await readVersions(projectId, imageId, { account: picked.alias });
        writeJson(res, 200, {
          ok: true,
          data: {
            projectId, imageId,
            name: r.name ?? null,
            versions: (r.versions ?? []).map((v) => ({
              id: v.id, createTime: v.createTime ?? null, info: v.info ?? null,
              // 没有图层数据的版本（只传了图）diff 读不了 —— 下拉里标出来，别让人选完才报错
              hasLayoutData: Boolean(v.hasLayoutData),
            })),
            account: picked.alias ?? null,
          },
        });
        return;
      }
      // 批量版本数：面板「稿」下拉里的「N 版」。
      // ⚠️ 这是**按需**端点（面板选中项目 / 贴链接之后才探第一批），**绝不在面板一打开时就探全项目** ——
      //    一个项目 252 张稿就是 252 次请求。offset/limit 的分页由面板推进，上限在 LIMITS 里。
      if (route === '/lanhu/versions-count' && (req.method === 'GET' || req.method === undefined)) {
        const link = url.searchParams.get('url');
        const parsed = link ? parseProjectTarget(link) : null;
        const projectId = url.searchParams.get('pid') || parsed?.projectId || null;
        if (!projectId) {
          writeJson(res, 400, { ok: false, error: '需要 ?pid=<projectId> 或 ?url=<蓝湖链接>（两个都不给，无法定位项目）' });
          return;
        }
        const picked = await pickAcct({ teamId: parsed?.teamId ?? null, projectId });
        const r = await countVersions(projectId, {
          // 原样递进去，夹取（默认 30 / 硬上限 100 / offset ≥ 0）都在 imageVersionCounts 里一处完成
          offset: url.searchParams.get('offset'),
          limit: url.searchParams.get('limit'),
          account: picked.alias,
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // 设计变更：同一张稿的两个版本（**长任务**，前端负责运行中/取消）
      if (route === '/lanhu/diff' && req.method === 'POST') {
        const started = Date.now();
        const body = await readJsonBody(req);
        if (body === null) { writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }
        if (typeof body.from !== 'string' || !body.from.trim()) {
          writeJson(res, 400, {
            ok: false,
            error: '需要 { from: "<版本id>", to?: "<版本id>" } —— `from` 是**必填**的起点版本，省略 `to` 表示最新版。',
            hint: '版本 id 先调 `GET /lanhu/versions?pid=&iid=`（面板里就是「读取版本」那一步）拿到；给不存在的 id 会报错，不会静默回退最新版。',
          });
          return;
        }
        const r = await runDiff({
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          projectId: body.projectId, imageId: body.imageId,
          from: body.from.trim(),
          to: typeof body.to === 'string' && body.to.trim() ? body.to.trim() : undefined,
          includeNoise: body.includeNoise,
        });
        recordUsage({
          tool: 'panel:diff',
          ok: r.ok !== false,
          ms: Date.now() - started,
          args: summarizeArgs({ projectId: body.projectId, imageId: body.imageId, from: body.from, to: body.to }),
          summary: r.ok === false ? '失败' : `逐块 ${r.reliable ? '可信' : '不可靠'} / 变化 ${r.counts?.changed?.blocks ?? '?'} 块`,
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      // 跨稿一致性审计（**最长的任务**：扫 N 张 = 2N 次请求）。
      // 两条边界写在这里，别让调用方自己猜：
      //   ① 张数**在入口再夹一次**（工具/CLI 已夹过，这里是防"面板传了个别的数"）；
      //   ② 不传 limit → 传 undefined，让 auditProject 用它自己的默认值（保持与工具完全同一条口径）。
      if (route === '/lanhu/audit' && req.method === 'POST') {
        const started = Date.now();
        const body = await readJsonBody(req);
        if (body === null) { writeJson(res, 400, { ok: false, error: 'body 不是合法 JSON' }); return; }
        const rawLimit = Number(body.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), LIMITS.auditMaxImages)
          : undefined;
        const r = await runAudit({
          url: typeof body.url === 'string' ? body.url.trim() : undefined,
          projectId: body.projectId,
          limit,
          includeNoise: body.includeNoise,
          allowWeakNaming: body.allowWeakNaming,
        });
        recordUsage({
          tool: 'panel:audit',
          ok: r.ok !== false,
          ms: Date.now() - started,
          args: summarizeArgs({ projectId: body.projectId, url: body.url, limit: body.limit }),
          summary: r.ok === false ? '失败' : `扫 ${r.scanned}/${r.total} 张 / ${r.reliable ? '可信' : '不可靠'}`,
        });
        writeJson(res, 200, { ok: true, data: r });
        return;
      }
      writeJson(res, 404, { ok: false, error: `未知路由：${route}` });
    } catch (e) {
      // 业务失败统一回 {ok:false, error, hint}，让面板能把原话和操作指引显示出来
      writeJson(res, 200, { ok: false, error: e?.message ?? String(e), hint: e?.hint ?? null });
    }
  };
}

const genCodeTool = tool({
  name: 'lanhu_gen_code',
  description: '把设计稿的块生成**可直接整段粘贴**的 CSS / WXSS —— 回答「**我该往文件里写什么**」，'
    + '与 `lanhu_read_blocks`（回答「设计稿是什么」，给人核对的表格）分工不同：这个出口是**代码块**，不是表格。'
    + '**双平台**：`target:"web"` 给 px 1:1；`mini` 给 rpx；`both`（默认）两套都给，输出里写明换算基准。'
    + '每块给一个**可读的 class**（块名归一化，中文保留，重名自动加 `-2`）。'
    + '覆盖：尺寸 / 背景（纯色 + **多段渐变含角度与全部 stop**）/ `opacity` / `box-shadow`（**多重、inset、spread**）/ '
    + '`text-shadow` / **四值** `border-radius` / 边框（含**渐变描边**）/ 毛玻璃 `backdrop-filter` / '
    + '字体族·字重·字号·色·行高·字距·对齐 / **富文本 `<span>` 分段**。'
    + '⭐ 三处与蓝湖「代码」面板**不同**（照抄它那三处会画错）：椭圆图元给 `50%`（它给 `0`，会画成方形环）；'
    + '渐变文字补 `background-clip:text` + `-webkit-text-fill-color:transparent`；渐变描边走 `border-image`。'
    + '**数据里没有的属性一个字都不出**（没 `line-height` 就不写，别自己补），但**有数据而值为 0 要出**（全 0 圆角 → `0px 0px 0px 0px`）。'
    + '**只读**：从不写任何东西；版本可溯源。',
  parameters: {
    url: { type: 'string', description: '蓝湖设计稿链接（详情页地址整条粘贴，自动解析 tid/pid/image_id）' },
    projectId: { type: 'string', description: '项目 UUID（与 imageId 搭配；给了 url 可不传）' },
    imageId: { type: 'string', description: '设计稿 id（与 projectId 搭配）' },
    target: {
      type: 'string',
      enum: ['web', 'mini', 'both'],
      description: '目标端：`web` = px（1:1，H5/PC 用）；`mini` = rpx（小程序用，换算基准见系统提示【换算】）；`both`（**默认**）两套都出，各自成段、可直接整段复制。画板宽度拿不到时**只出 px**（不拿 375 硬算，`miniAvailable:false` 会告诉你）',
    },
    region: { type: 'string', description: '可选：只生成某区域的块，"y0,y1" 或 "x0,y0,x1,y1"（大屏稿动辄几百块，用它收窄）' },
    kind: { type: 'string', description: '可选：只生成某几类块，逗号分隔（card/container/pill/text/image/divider）' },
    minWidth: { type: 'number', description: '可选：只生成宽度 ≥ 该值的块' },
    limit: { type: 'number', description: `最多生成几块（默认 ${LIMITS.codeMaxBlocks}；截断时 truncated:true，调大它看全）` },
    includeNoise: { type: 'boolean', description: '是否把系统 UI / 图形碎片块也生成（默认 false，与 lanhu_read_blocks 同一个折叠口径）' },
    version: { type: 'string', description: '版本 id（默认 latest）。设计稿会更新，要复现"当初那一版"就传它；给了具体 id 必须命中，命中不了会报错、不静默回退' },
    structured: { type: 'boolean', description: '是否额外返回机器可读的 `codes[]`（默认 false）' },
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      format: { type: 'string' },
      name: { type: 'string' },
      viewport: { type: 'json' },
      target: { type: 'string' },
      // 画板宽度未知时是 false —— 那时只出 px（**不拿 375 硬算 rpx**）
      miniAvailable: { type: 'boolean' },
      unitBasis: { type: 'string' },
      blockCount: { type: 'integer' },
      totalBlocks: { type: 'integer' },
      truncated: { type: 'boolean' },
      noiseCount: { type: 'integer' },
      kindCounts: { type: 'json' },
      codeClassNames: { type: 'array' },
      // 机器可读的逐块属性行（与原样可粘贴的 `text` 是**同一次生成**，不会各算一遍）。
      // ⚠️ **默认不给**（`structured: true` 才给）—— 见 lanhu.mjs 里 genCode 的长注释。
      codes: { type: 'json' },
      layerCount: { type: 'integer' },
      // 读不出图层（Sketch 插件空壳 / 认不出的树）时：ok:false + unsupported:true + 原因，**别当成"这张稿是空的"**
      unsupported: { type: 'boolean' },
      code: { type: 'string' },
      reason: { type: 'string' },
      account: { type: 'string' },
      accountBy: { type: 'string' },
      version: { type: 'json' },
      versionIsLatest: { type: 'boolean' },
      latestVersionAt: { type: 'string' },
      sourceFormat: { type: 'string' },
      error: { type: 'string' },
      hint: { type: 'string' },
      text: { type: 'string' },
    }),
    render: (_args, v) => text(v?.text ?? ''),
  },
  async execute(args) {
    try {
      return await genCode({
        url: args.url,
        projectId: args.projectId,
        imageId: args.imageId,
        target: args.target,
        region: args.region,
        kind: args.kind,
        minWidth: args.minWidth,
        limit: args.limit,
        includeNoise: args.includeNoise,
        version: args.version,
        structured: args.structured,
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

export const TOOLS = [
  checkAuthTool,
  listTeamsTool,
  listProjectsTool,
  listDesignsTool,
  searchTool,
  readDesignTool,
  readBlocksTool,
  diffDesignTool,
  auditProjectTool,
  listProductDocumentsTool,
  readProductDocTool,
  accountsTool,
  whoTool,
  downloadSlicesTool,
  verifySpecTool,
  verifyBlocksTool,
  genCodeTool,
  cookieSetTool,
];

/* ==========================================================================
 * 挂载
 * ========================================================================== */

export function apply(ctx) {
  // 惰性挂载：以桩上下文加载时 tools 不存在也不该让插件 pending。
  ctx.inject(['tools'], (c) => {
    c.effect(() => {
      const tools = c.get('tools');
      const disposers = TOOLS.map((tool) => tools.register(tool));
      return () => { for (const d of disposers) d(); };
    }, 'dsh-lanhu: tools');
  });

  ctx.inject(['systemPrompt'], (c) => {
    c.effect(() => c.get('systemPrompt').section({
      name: 'plugin:dsh-lanhu',
      order: 150,
      text: SYSTEM_HINT,
    }), 'dsh-lanhu: prompt');
  });

  // 面板的数据通道：/lanhu/status（探活）、/lanhu/cookie（粘贴更新）
  ctx.inject(['webServer'], (c) => {
    c.effect(() => c.get('webServer').register({
      kind: 'prefix',
      path: '/lanhu',
      handler: makeLanhuHandler(),
    }), 'dsh-lanhu: routes');
  });
}

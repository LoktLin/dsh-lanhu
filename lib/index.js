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
  downloadSlices,
  verifySpec,
  verifyBlocks,
  saveCookie,
  recordUsage,
  readUsage,
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
} from '../lanhu.mjs';

export const name = 'lanhu';
export const inject = [];

const text = (s) => [{ type: 'text', text: String(s ?? '') }];

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
  description: '可选：指定蓝湖账号别名（多账号场景，如 acme）。不给时会按链接里的团队 id 自动判定，再退到默认账号。先用 lanhu_accounts 看有哪些账号。',
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
        recordUsage({
          tool: rest.name, ok: false, ms: Date.now() - started,
          args: summarizeArgs(args), error: err.message,
        });
        return failure(err);
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
        return toLossless(r);
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

/** 统一的输出 schema：宽松开放，避免任何一个多余/缺失字段让整次调用失败。 */
const looseSchema = (properties) => ({ type: 'object', additionalProperties: true, properties });

const SYSTEM_HINT = [
  '蓝湖（Lanhu）设计稿读取能力已就绪（dsh-lanhu 插件）。',
  '当用户提到蓝湖、设计稿、切图、设计还原、标注、色值对齐，或给出 lanhuapp.com 链接时：',
  '先用 lanhu_check_auth 确认登录态，再用 lanhu_read_design 读取设计稿的精确数值（色值/字号/字重/圆角/坐标/文本）。',
  '不要靠截图估算色值和字号——设计稿的真实数值可以直接拿到。',
  '拿到 token 后写前端代码时，色值/字号一律对齐设计稿，不要自己造近似色。',
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
  description: '列出某个项目下的全部设计稿（稿名 / 尺寸 / imageId）。**可以直接贴蓝湖链接**（里面的 tid/pid 自动解析，不用手拆）；也可以给 projectId。要看**产品文档/原型**请用 lanhu_list_product_documents。',
  parameters: {
    url: { type: 'string', description: '蓝湖链接（整条粘贴即可 —— 里面的 tid/pid 会自动解析，不用手拆）' },
    projectId: { type: 'string', description: '项目 UUID（与 url 二选一；**两个都给时以 projectId 为准**）' },
    sector: { type: 'string', description: '分组名（可选；实测未分组项目也能列出全部稿子，无需此参数）' },
  },
  output: {
    schema: looseSchema({
      projectName: { type: 'string' },
      images: { type: 'array', items: {
        type: 'object', additionalProperties: true, properties: {
          imageId: { type: 'string' }, name: { type: 'string' },
          width: { type: 'number' }, height: { type: 'number' },
        } } },
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
      const lines = [`${r.projectName ?? projectId}：${r.images.length} 张设计稿`];
      for (const i of r.images) {
        const inSector = args.sector && !(i.group ?? []).includes(args.sector);
        if (inSector) continue;
        lines.push(`· ${i.name}  ${i.width}×${i.height}  imageId=${i.imageId}`);
      }
      return { ...r, text: lines.join('\n') };
    } catch (e) {
      return failure(e);
    }
  },
});

const searchTool = tool({
  name: 'lanhu_search',
  description: '在蓝湖团队里全局搜索设计稿 / 项目 / PRD（按名称关键词）。当不知道稿子在哪个项目、或只记得名字时用这个。',
  parameters: {
    teamId: { type: 'string', description: '团队 UUID', required: true },
    keyword: { type: 'string', description: '搜索关键词（稿名的一部分）', required: true },
  },
  output: {
    schema: looseSchema({
      images: { type: 'array', items: { type: 'json' } },
      projects: { type: 'array', items: { type: 'json' } },
    }),
    render: (_args, v) => text(v.text ?? ''),
  },
  async execute(args) {
    try {
      const r = await coreSearch(args.teamId, args.keyword, { account: args.account });
      const lines = [];
      if (r.images.length) {
        lines.push(`设计稿 ${r.images.length} 个：`);
        for (const i of r.images) lines.push(`· ${i.name}  @${i.projectName}  imageId=${i.imageId}  projectId=${i.projectId}`);
      }
      if (r.projects.length) {
        lines.push('', `项目 ${r.projects.length} 个：`);
        for (const p of r.projects) lines.push(`· ${p.name}  projectId=${p.projectId}`);
      }
      if (r.prds.length) {
        lines.push('', `PRD ${r.prds.length} 个：`);
        for (const d of r.prds) lines.push(`· ${d.name}  path=${d.path}`);
      }
      return { ...r, text: lines.length ? lines.join('\n') : `没有匹配「${args.keyword}」的结果。` };
    } catch (e) {
      return failure(e);
    }
  },
});

const readDesignTool = tool({
  name: 'lanhu_read_design',
  description: '读取蓝湖设计稿的结构化图层数据：精确色值/字号/字重/字体/圆角/坐标/文本内容/父子内边距。当用户提到蓝湖、设计稿、切图、还原设计、标注、lanhu 链接时使用。默认 summary 返回紧凑文本（色板 + 字号 + 关键容器 + 文本层）；要按区域抠图层（替代手写抠图脚本）用 region 参数（可再配 mapBox+toBox，把坐标**直接映射到目标坐标系**，如本地自绘 SVG 的 viewBox；层数多时用 limit 看全量）。',
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
    limit: { type: 'integer', description: '配合 region：最多列多少层（默认 80）。层数多的稿子会被截断，要看全量就传大一点（如 900），表头会标注是否截断' },
    mapBox: { type: 'string', description: '配合 region：设计稿参照框 "x0,y0,x1,y1"（如地图区域总 bbox）。与 toBox 同时给时，输出增加映射后的坐标列' },
    toBox: { type: 'string', description: '配合 region：目标参照框 "X0,Y0,X1,Y1"（如本地自绘 SVG 的内容 bbox）。x/y 各自独立缩放（非等比），长宽比不同也能对' },
    version: { type: 'string', description: '版本 id（默认取最新版 latest）。**设计稿会更新，不指定版本时"代码与稿子是否同一版"无从判断**；给了具体 id 就必须命中，命中不了会明确报错、不会静默回退到最新版。结果里的 version 字段会写明实际用了哪一版、是否最新' },
    gapMaxDistance: { type: 'number', description: '配合 region：几何间距只保留 ≤ 该值的（不传则全留）。间距=**只在另一轴有重叠**的相邻元素之间的最近边距，可直接抄进 CSS，不用拿坐标手算' },
    dds: { type: 'boolean', description: '默认关闭。开启后额外尝试取蓝湖 **DDS（设计数据服务）** 的 schema，结果以 source:"dds" 标注。⚠️ 那是社区实测的**非官方**通道（另域 + 独立 Cookie），随时可能失效——**失败只如实记录原因，不影响常规解析结果**，也**不要把它当主路径**' },
  },
  output: {
    schema: looseSchema({
      name: { type: 'string' },
      format: { type: 'string' },
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
  description: '把设计稿读成「块级清单」：卡片/胶囊/文本/图片/分割线/容器，每块带齐六项属性（圆角、大小、文字色、字号、有无底色、边框/分割线），外加**图层不透明**（已累乘祖先链，与填充色 `@xx%` alpha 是两回事，两者都要还原）、**字体族**、**行高·字距**、**多段渐变的全部 stop**（`#145994@18%→#08294a@10%`）。比 lanhu_read_design 更贴近"人一眼能核对"的粒度——**设计稿里肉眼最容易漏的分割线（如 1px #E2E8F0）会单独列在"边框/分割线"段**。**直接粘贴蓝湖链接即可**：不用手动拆 id，也**不用知道它属于哪个账号**（多账号场景会自动判定，并在结果末尾写明用了哪个）。还原大块布局或核对圆角/分割线时优先用它。',
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
  },
  output: {
    schema: looseSchema({
      ok: { type: 'boolean' },
      blockCount: { type: 'integer' },
      noiseCount: { type: 'integer' },
      layerCount: { type: 'integer' },
      kindCounts: { type: 'json' },
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
        account: args.account,
      });
    } catch (e) {
      return failure(e);
    }
  },
});

const listProductDocumentsTool = tool({
  name: 'lanhu_list_product_documents',
  description: '输出带 `order` —— 蓝湖「文档」面板**按它倒序**显示且是**滚动区**，界面里只看到前几个**不代表只有几个**（实测有人据此以为插件读错了）。`withPages:true` 可额外附上每份的**页面规模**（页面节点数 / 可读页数），便于一眼选对文档；**代价是每份多发 1 次请求**（要拉一次 sitemap），所以**默认关**，单份失败只标 `?` 不会毁掉整张表。列出蓝湖项目下的**产品文档**（也叫原型 / PRD —— Axure 导出，`docType=axure`）。**这不是设计稿**：设计稿回答"什么颜色、几 px 圆角"，产品文档回答"业务规则、字段、跳转"。当用户给的是**原型链接**（URL 里带 `docType=axure`），或要看需求文档/PRD/原型、要定位某一步的业务规则时用它；顺带返回项目名/文件夹/创建者。设计稿请用 lanhu_list_designs。拿到 docId 后交给 lanhu_read_product_doc 读页面树与正文。',
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
  description: '读蓝湖**产品文档（Axure 原型 / PRD）**的页面树与正文 —— 需求文档、原型交互、业务规则的来源。**不是设计稿**（色值/字号/圆角用 lanhu_read_design）。返回：页面树（层级/path/类型/pageId）+ 命中页的正文文本。**先不带 pageId 调一次看页面树**（一份原型常有上百个节点），再按 pageId（**跨版本稳定**）或 pageName 精确取正文。`format:"layers"` 取**样式图层/块级清单**（项目只有原型、没有设计稿时靠它照着实现）。正文实测取自页面 HTML（data.js 里的原生控件多为空 —— 因为原型常以矢量/图片导出，只解析 data.js 会得出"这页没内容"的假结论）。',
  parameters: {
    url: { type: 'string', description: '蓝湖原型链接（整条粘贴，URL 里的 pageId 会被自动选中）' },
    projectId: { type: 'string', description: '项目 UUID（与 docId 搭配）' },
    docId: { type: 'string', description: '产品文档 id（= 原型链接里的 docId / image_id）。不给则取项目下第一份 axure 文档' },
    teamId: { type: 'string', description: '团队 UUID（多账号自动判定失败时显式给）' },
    pageId: { type: 'string', description: '页面 id（**跨版本稳定**，推荐用它）。不给则不取正文，只回页面树' },
    pageName: { type: 'string', description: '按页面名模糊匹配（pageId 的备选）' },
    version: { type: 'string', description: '版本 id（默认 latest）。原型也会更新，要复现"当时那一版"就传它' },
    limit: { type: 'integer', description: '最多读几页正文（默认 1，避免一次拉爆）' },
    textLimit: { type: 'integer', description: '每页最多取多少条正文文本（默认 120）' },
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
  description: '管理蓝湖账号（一个人有多个公司/多个蓝湖账号时用）。action=list 列出账号（公司 / 团队数 / 项目数 / Cookie 有效期 / 默认标记）；add 添加或更新账号（**贴 Cookie 即可**，会自动建立团队+项目索引）；remove 删除；set-default 设为默认；reindex 重建索引。判断"某张稿属于哪个账号"请用 lanhu_who。',
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
  description: '判断一张蓝湖稿子属于哪个账号（多公司/多账号场景）。**贴链接即可**：优先零请求——用链接里的团队 id（tid）或项目 id 比对账号索引，命中直接返回；未命中才按 imageId 逐个账号探测（并回填索引，下次就是零请求）。用户给了一张读不到的稿、或不确定该用哪个账号时，先跑它再读稿。',
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
  description: '设计稿验收：用真实浏览器打开页面取 getComputedStyle，与设计稿图层逐字段比对（色值/字号/字重/**字体族**/圆角），输出匹配率与不一致表。字体族判定刻意宽松以防误报：**设计稿字体名出现在页面 font-family 栈的前 3 位即通过**（页面栈天然带系统回退字体，要求全等会把正确页面全判错）。浏览器首选 puppeteer-core 驱动系统 Chrome，其次 Playwright；都没有时降级为 CSS 声明级静态比对并说明原因。元素映射优先用页面上的 [data-lanhu] 属性，没有标注时按设计稿文本自动匹配叶子节点，也可显式传 selectors。',
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
  description: '更新蓝湖 Cookie。**直接粘贴浏览器里复制的内容即可**：F12 → Network → 任意 lanhuapp.com 请求 → 右键 → Copy as cURL → 把整段贴进来（会自动解析出 Cookie，不用手工抠串）。也接受 "Cookie: ..." 原始请求头或裸 Cookie 串。写前用真实请求校验；**传 `account` 就写进那个账号**（`~/.dsh/lanhu/cookies/<alias>`），不传则落盘到默认的 `~/.dsh/lanhu/cookie`（均 600）。',
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

function makeLanhuHandler() {
  return async (req, res) => {
    if (!isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: '仅允许本机访问' });
      return;
    }
    const url = new URL(req.url ?? '/lanhu', 'http://localhost');
    const route = url.pathname.replace(/\/+$/, '') || '/lanhu';
    try {
      // 连通性探活：面板的「检测」就调它
      if (route === '/lanhu' || route === '/lanhu/status') {
        const r = await checkAuth();
        writeJson(res, 200, { ok: true, data: r });
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
      writeJson(res, 404, { ok: false, error: `未知路由：${route}` });
    } catch (e) {
      // 业务失败统一回 {ok:false, error, hint}，让面板能把原话和操作指引显示出来
      writeJson(res, 200, { ok: false, error: e?.message ?? String(e), hint: e?.hint ?? null });
    }
  };
}

export const TOOLS = [
  checkAuthTool,
  listTeamsTool,
  listProjectsTool,
  listDesignsTool,
  searchTool,
  readDesignTool,
  readBlocksTool,
  listProductDocumentsTool,
  readProductDocTool,
  accountsTool,
  whoTool,
  downloadSlicesTool,
  verifySpecTool,
  verifyBlocksTool,
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

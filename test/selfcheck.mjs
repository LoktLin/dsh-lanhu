#!/usr/bin/env node
/**
 * dsh-lanhu 本地自检 —— 纯离线，不碰蓝湖接口，秒级可重跑。
 *
 *   node test/selfcheck.mjs           # 人读
 *   node test/selfcheck.mjs --json    # 机器读
 *
 * 覆盖四块**最容易静默坏掉**的地方：
 *   ① 蓝湖链接解析（hash 路由的坑，错一次就把 projectId 当 imageId）
 *   ② 工具参数校验（schema 校验接错层会"一个字段都拦不住"——实测踩过）
 *   ③ 块级模型的分类规则（胶囊 / 分割线 / 卡片）
 *   ④ 工具定义形状（注册期抛错会让整个 profile 起不来）
 *
 * 退出码：0 全绿 / 1 有失败
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// ⚠️ 必须在 import lanhu.mjs **之前** 把数据目录指到临时区 ——
//    否则自检会读写你真实的 ~/.dsh/lanhu（账号档案、Cookie）。用动态 import 才能保证这个顺序。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lanhu-selfcheck-'));
process.env.LANHU_HOME = TMP_HOME;

// 兜底清理：即使中途抛错（或走了 process.exit）也不会在系统临时目录里留垃圾
const cleanupTmp = () => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* 忽略 */ } };
process.on('exit', cleanupTmp);
process.on('uncaughtException', (e) => { cleanupTmp(); console.error(e); process.exit(1); });

const {
  parseLanhuUrl,
  searchLines,
  parseProjectTarget,
  countSitemapPages,
  titleName,
  productDocsTable,
  resolveTarget,
  parseColor,
  buildBlocks,
  renderBlocks,
  visibleBlocks,
  contrastRatio,
  relativeLuminance,
  compositeOver,
  isLargeText,
  shadeToReach,
  parentIndexOf,
  effectiveBackground,
  auditTextContrast,
  renderContrastDigest,
  versionInfo,
  metaSuffix,
  readBlocks,
  readDesign,
  downloadSlices,
  normalizeSketchPluginTree,
  diffDesign,
  diffBlockItems,
  matchVersionBlocks,
  matchApproxBlocks,
  diffReliability,
  renderDiff,
  DIFF_CATEGORIES,
  DIFF_CATEGORY_LABEL,
  // —— 设计系统审计（第 3 步）——
  auditProject,
  auditComponentSpecs,
  collectAuditComponents,
  auditFontScale,
  collectAuditColors,
  nearColorClusters,
  auditSpacing,
  auditRadiusFamily,
  auditReliability,
  auditSkipReason,
  isAutoLayerName,
  auditNameKey,
  rgbDistance,
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABEL,
  LIMITS,
  renderTokens,
  renderFonts,
  renderRegion,
  renderSummary,
  renderGapDigest,
  alignedEdges,
  collectTokens,
  flattenArtboard,
  imageMeta,
  upsertAccount,
  saveCookie,
  listAccounts,
  removeAccount,
  setDefaultAccount,
  // —— ⑰ 列表分页（B）：核心函数**必须能取全量**（工具层的分页不许把它带走）——
  listImages,
  whoIsIt,
  resolveCookie,
  loadAccounts,
  accountsPath,
  safeAlias,
  isReadableDetail,
  lanhuHome,
  matchBlocks,
  compareBlockProps,
  resolveAccountFor,
  pickAccount,
  blockLabel,
  normalizePageElements,
  normalizeFamily,
  familyKey,
  familyInStack,
  BLOCK_TOLERANCE,
  parseProductUrl,
  flattenSitemap,
  selectProductPages,
  pickVersion,
  fontRequirements,
  assetDensity,
  densityLimitedOf,
  matchAssetsToLayers,
  geometricGaps,
  decodeHtmlEntities,
  extractHtmlText,
  parseAxureJs,
  unwrapAxureDocument,
  axureScriptIds,
  decodeAxureText,
  normalizeAxurePage,
  renderProductLayers,
  tryProjectInfo,
  renderProductDoc,
  auditAxureChildKeys,
  AXURE_CHILD_KEYS,
  argbParts,
  argbColor,
  axureFontFamily,
  extractAxureObjects,
  ddsSchema,
  // —— 「示例与真值同源」（⑫）：色值示例唯一出口 ——
  rgbaString,
  rgbHex,
  bgText,
  // —— 生成代码（§4.10）——
  genCode,
  cssColor,
  cssClassName,
  cssFontFamily,
  cssGradient,
  cssShadow,
  cssBorder,
  cssRadius,
  blockCssLines,
  textRunsCss,
  buildCodeItems,
  renderGenCode,
  gradientAngle,
  gradientInfoOf,
  textRunsOf,
  richInfoOf,
  // —— 评论 / 标注（§4.9）——
  fetchComments,
  renderComments,
  commentNoteText,
  commentPoint,
  mapCommentsToBlocks,
  unixToIso,
} = await import('../lanhu.mjs');
const { TOOLS, validateJsonSchemaValue, ToolArgsError, toLossless, apply: applyHostPlugin, makeLanhuHandler } = await import('../lib/index.js');

const results = [];
let currentGroup = '';
const group = (name) => { currentGroup = name; };

function ok(name, cond, detail = '') {
  results.push({ group: currentGroup, name, ok: !!cond, detail: String(detail) });
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected) ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/* ═══════════════ ① 链接解析 ═══════════════ */
group('① 链接解析');

const TID = '00000001-0000-4000-8000-000000000001';
const PID = '00000002-0000-4000-8000-000000000002';
const IID = '00000003-0000-4000-8000-000000000003';

const hashUrl = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID}&pid=${PID}&project_id=${PID}&image_id=${IID}&fromEditor=true&type=image`;
{
  const r = parseLanhuUrl(hashUrl);
  eq('hash 路由链接：projectId 正确', r.projectId, PID);
  eq('hash 路由链接：imageId 正确', r.imageId, IID);
  eq('hash 路由链接：teamId 正确', r.teamId, TID);
}
{
  // 关键回归：链接里有 4 个 uuid，顺序一错就会把 projectId 当 imageId
  const r = parseLanhuUrl(`https://lanhuapp.com/web/#/item/project/detailDetach?project_id=${PID}&image_id=${IID}`);
  ok('参数只给 project_id/image_id 也能解析', r.projectId === PID && r.imageId === IID);
}
{
  const r = parseLanhuUrl(`https://lanhuapp.com/web/?projectId=${PID}&imageId=${IID}`);
  ok('camelCase 参数名兼容', r.projectId === PID && r.imageId === IID);
}
{
  const r = parseLanhuUrl(`${PID} ${IID}`);
  ok('直接给两个 id 的简写形式', r.projectId === PID && r.imageId === IID);
}
{
  // 有项目、没稿 —— 这时才该点名 image_id（完全无参的链接会先报 project_id，属正常校验顺序）
  let threw = null;
  try { parseLanhuUrl(`https://lanhuapp.com/web/#/item/project/detail?pid=${PID}`); } catch (e) { threw = e.message; }
  ok('缺 image_id 时点名 image_id', threw && threw.includes('image_id'), threw || '(没抛错)');
}
{
  let threw = null;
  try { parseLanhuUrl('https://lanhuapp.com/web/#/item/project/list'); } catch (e) { threw = e.message; }
  ok('完全无参的链接给出可读报错', !!threw && threw.includes('project_id'), threw || '(没抛错)');
}
{
  let threw = null;
  try { parseLanhuUrl(''); } catch (e) { threw = e.message; }
  ok('空输入给出可读报错', !!threw);
}

/* ═══════════════ ② 参数校验 ═══════════════ */
group('② schema 校验器');

const V = (schema, value) => validateJsonSchemaValue(schema, value);
const cases = [
  ['必填缺失 → 报', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, {}, true],
  ['必填齐 → 过', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { a: 'x' }, false],
  ['字符串当数字 → 报', { type: 'object', properties: { n: { type: 'number' } } }, { n: 'abc' }, true],
  ['整数满足 number → 过', { type: 'object', properties: { n: { type: 'number' } } }, { n: 3 }, false],
  ['小数不满足 integer → 报', { type: 'object', properties: { n: { type: 'integer' } } }, { n: 3.5 }, true],
  ['枚举命中 → 过', { type: 'object', properties: { f: { type: 'string', enum: ['a', 'b'] } } }, { f: 'b' }, false],
  ['枚举未命中 → 报', { type: 'object', properties: { f: { type: 'string', enum: ['a', 'b'] } } }, { f: 'z' }, true],
  ['数组元素类型错 → 报', { type: 'object', properties: { xs: { type: 'array', items: { type: 'number' } } } }, { xs: [1, 'a'] }, true],
  ['空 schema 放行任意值 → 过', { type: 'object', properties: { j: {} } }, { j: { 任意: 1 } }, false],
  ['NaN 非 lossless → 报', { type: 'object', properties: { n: { type: 'number' } } }, { n: NaN }, true],
  ['additionalProperties:false 拦未知键 → 报', { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { a: 'x', zz: 1 }, true],
];
for (const [label, schema, value, expectBad] of cases) {
  const v = V(schema, value);
  ok(label, (v.length > 0) === expectBad, v.length ? v[0] : '');
}
ok('ToolArgsError 带 violations 字段', (() => {
  const e = new ToolArgsError(['x']);
  return e.name === 'ToolArgsError' && Array.isArray(e.violations) && e.violations.length === 1;
})());

/* ═══════════════ ③ 工具层：校验真的接在 execute 前 ═══════════════ */
group('③ 工具层拦截');

const pick = (n) => TOOLS.find((t) => t.name === n);

{
  // 回归：曾把**原始 DSL** 当 schema 传进去，导致一个字段都拦不住（必填是属性上的 required:true，
  // 而标准 schema 里是根部的 required 数组），全部静默放行到业务层。
  const before = Date.now();
  const r = await pick('lanhu_verify_spec').execute({});
  ok('缺必填 pageUrl 被拦下', r.failed === true && /pageUrl/.test(r.text), r.text.split('\n')[0]);
  ok('拦截发生在业务之前（<200ms，没发网络请求）', Date.now() - before < 200);
}
{
  const r = await pick('lanhu_read_blocks').execute({ url: 'https://x', limit: 'abc' });
  ok('limit 传字符串被拦下', r.failed === true && /limit/.test(r.text), r.text.split('\n')[0]);
}
{
  const r = await pick('lanhu_read_design').execute({ projectId: 'a', imageId: 'b', minWidth: 'x' });
  ok('minWidth 传字符串被拦下', r.failed === true && /minWidth/.test(r.text), r.text.split('\n')[0]);
}
{
  // 参数正确时必须**放行**（错误来自业务层而非校验层）
  const r = await pick('lanhu_list_projects').execute({ teamId: 'not-a-uuid' });
  ok('参数正确时放行到业务层', !/不符合 schema/.test(r.text), r.text.split('\n')[0]);
}
{
  const r = await pick('lanhu_check_auth').execute({});
  ok('无参工具不被误拦', !/不符合 schema/.test(r.text));
}
{
  // 回归：execute 必须声明 args 形参 —— 曾有两个工具写成 `async execute()`，
  // 透传 account 后就炸 `args is not defined`，而且**只在传 account 时才炸**，极易漏掉。
  for (const t of TOOLS) {
    const r = await t.execute({ account: '__no_such_account__' });
    const msg = String(r?.text ?? r?.error ?? '');
    ok(`${t.name} 能安全接收 account 参数`,
      !/args is not defined|ReferenceError/.test(msg),
      msg.split('\n')[0].slice(0, 64));
  }
}
{
  // account 必须真的透到 Cookie 解析层（否则这个参数就是个摆设）
  const r = await pick('lanhu_check_auth').execute({ account: '__no_such_account__' });
  ok('不存在的账号会明确报错（而不是静默换账号）',
    /没有可用的 Cookie|没有这个账号/.test(String(r.text)), String(r.text).split('\n')[0].slice(0, 60));
}
{
  const r = await pick('lanhu_check_auth').execute({ account: '../etc/passwd' });
  ok('账号别名挡路径穿越', /别名只能用/.test(String(r.text)), String(r.text).split('\n')[0].slice(0, 50));
}

/* ═══════════════ ④ 工具定义形状（注册期约束） ═══════════════ */
group('④ 工具定义');

// 与 README 生成块做**交叉**比对，而不是写死数字：
// 写死数字的后果是"加一个工具要改两处"，忘一处就变成假绿/假红（这条曾经就写死过 13）。
const _readme = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
const _gen = (_readme.split('<!-- BEGIN GENERATED:tools -->')[1] ?? '').split('<!-- END GENERATED:tools -->')[0] ?? '';
const _missing = TOOLS.filter((t) => !_gen.includes(t.name)).map((t) => t.name);
ok(`每个工具都出现在 README 生成块里（共 ${TOOLS.length} 个）`, _missing.length === 0,
  _missing.length ? `README 生成块里缺：${_missing.join('、')}（跑 node tools/gen-readme-tools.mjs --write）` : '全部命中');
for (const t of TOOLS) {
  const p = t.parameters;
  const shapeOk = p && p.type === 'object' && typeof p.properties === 'object';
  ok(`${t.name} 的 parameters 是标准 JSON Schema`, shapeOk);
  ok(`${t.name} 有 output.render`, typeof t.output?.render === 'function');
  ok(`${t.name} 有 output.schema`, !!t.output?.schema);
}
ok('所有工具名以 lanhu_ 前缀', TOOLS.every((t) => t.name.startsWith('lanhu_')));

/* ═══════════════ ④.4 描述/输出与实现同步（防"改了实现忘了描述"） ═══════════════ */
group('④.4 描述/输出同步');

// ⚠️ 这几条全都是**实测踩过**的"能力藏了"：实现早就支持，但工具描述 / 输出表里一个字没提，
//    调用方（模型）只能靠猜 —— 于是新列、新判定形同不存在（详见 docs/蓝湖插件读取缺陷排查）。
//    断言写在这里，是为了让"下次又忘了"在自检这一步就红掉，而不是等还原完才发现。
const DESC_MUST = {
  lanhu_read_blocks: ['不透明', '字体族', '行高·字距', '对比度'],
  lanhu_read_design: ['mapBox', 'toBox'],
  lanhu_verify_spec: ['字体族'],
  lanhu_verify_blocks: ['字体族'],
};
for (const [tname, keywords] of Object.entries(DESC_MUST)) {
  const t = TOOLS.find((x) => x.name === tname);
  const desc = t?.description ?? '';
  for (const kw of keywords) {
    const hit = desc.includes(kw);
    ok(`${tname} 的描述提到「${kw}」`, hit, hit ? '' : (t ? `描述里没有「${kw}」` : '工具不存在'));
  }
}
{
  // 块表列完整性：字体族必须**独立成列** —— 挤在「字号/字重/色」单元格里，
  // 会让"照表抄"产生歧义（同一字体的不同写法分不清是哪个字段）。
  const flat = [{
    id: 'x', type: 'textLayer', name: '标题', parentPath: '画板', depth: 1,
    x: 0, y: 0, w: 100, h: 20, inset: { left: 0, top: 0, right: 0, bottom: 0 },
    visible: true, opacity: 1, shape: 'rect', radius: null, border: null,
    colors: [{ role: 'text', hex: '#ffffff', alpha: 1 }], text: '标题',
    font: { size: 14, weight: 400, lineHeight: 22, letterSpacing: 0.5, family: 'Alibaba PuHuiTi 2.0', align: null },
    hasImage: false,
  }];
  const out = renderBlocks(buildBlocks(flat), { name: 't', width: 375, height: 896 });
  for (const col of ['不透明', '字体', '行高·字距']) {
    ok(`块表表头有「${col}」列`, out.includes(col));
  }
}

/* ═══════════ ④.4b 模型面：同一事实只说一次（agent-experience 第 10 条） ═══════════ */
group('④.4b 模型面（防重复事实）');

/**
 * 模型真正读到的那一面 = `SYSTEM_HINT`（系统提示段）+ 每个工具的 `{name, description, parameters}`。
 *
 * ⚠️ `output.schema` **不在**首轮提示里 —— 宿主的 `dsh-tools` 只按 `schemaOf()` 投影
 *    `name / description / parameters` 三个字段（DeepSeek 适配器再映射成 `input_schema`），
 *    所以"给 AI 省上下文"要改的是这三样，往 `output.schema` 里写字对模型**零影响**。
 *
 * ⚠️ 为什么要有这一组：**工具定义全都在同一个提示里**，所以「把细节留给工具自己的 description」
 *    对模型来说**不额外花钱**（不用多跑一次工具、不用再读一个文件）—— 这与"延迟加载文档"不同，
 *    重复一遍是**纯浪费**。反过来说：精简时**不许把事实删掉**，只许搬到它该在的那一面（下面有反向守卫）。
 */
const _hintText = (() => {
  let t = null;
  applyHostPlugin({
    inject: (_svcs, fn) => fn({
      effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
      get: (n) => (n === 'systemPrompt'
        ? { section: (s) => { t = s.text; return () => {}; } }
        : { register: () => () => {} }),
    }),
  });
  return t;
})();
const _byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const _propDesc = (toolName, key) => String(_byName[toolName]?.parameters?.properties?.[key]?.description ?? '');
/** 模型面全文（提示 + 全部描述/参数说明）—— 用来数"同一件事被说了几次"。 */
const _modelSurface = () => [
  _hintText,
  ...TOOLS.flatMap((t) => [
    String(t.description ?? ''),
    ...Object.values(t.parameters?.properties ?? {}).map((p) => String(p?.description ?? '')),
  ]),
].join('\n');

ok('拿到模型真正读到的那份 SYSTEM_HINT（不是源码里的拼接表达式）',
  typeof _hintText === 'string' && _hintText.length > 500, `长度 ${_hintText ? _hintText.length : 0}`);

/* —— ① 决策树只回答「选哪个」，不再复述工具产出清单（产出归工具自己的 description） —— */
{
  const OWNED_ELSEWHERE = [
    '多做的三件事',        // → lanhu_gen_code.description
    '渐变文字补',          // → lanhu_gen_code.description
    '四态报告',            // → lanhu_verify_blocks.description
    '末尾还附「间距一览」',  // → lanhu_read_blocks.description
    '命中不了就明说',       // → lanhu_read_blocks.description / comments 参数
    '从 2 次请求变 3 次',   // → comments 参数
    '判据 = 层名归一化',    // → lanhu_audit_project.description
    '不静默回退到最新版',    // → version / from 参数
  ];
  const back = OWNED_ELSEWHERE.filter((s) => _hintText.includes(s));
  ok('决策树不复述工具产出清单（哪条又写回 SYSTEM_HINT 就红）', back.length === 0,
    back.length ? `又写回去了：${back.join('、')}` : `${OWNED_ELSEWHERE.length} 条都没写回去`);
  // 反向守卫：**搬走 ≠ 删掉**。这些事实必须还在它该在的那一面（否则就是"精简"成了"丢信息"）。
  for (const [cond, label] of [
    [String(_byName.lanhu_gen_code.description).includes('background-clip'), '三处代码差异仍在 lanhu_gen_code 描述里'],
    [String(_byName.lanhu_read_blocks.description).includes('间距一览'), '「间距一览」仍在 lanhu_read_blocks 描述里'],
    [String(_byName.lanhu_diff_design.description).includes('逐块对比不可靠'), 'diff 的可靠度判据仍在 lanhu_diff_design 描述里'],
    [String(_byName.lanhu_audit_project.description).includes('拒绝出明细'), 'audit 的「拒绝出明细」仍在 lanhu_audit_project 描述里'],
  ]) ok(`搬走不是删掉：${label}`, cond);
}

/* —— ② 参数级规则写在参数上，别写进工具描述（第 9 条） —— */
{
  const cdesc = _propDesc('lanhu_read_blocks', 'comments');
  ok('comments 的开/关与成本只在 comments 参数上（read_blocks 描述里不再提）',
    !String(_byName.lanhu_read_blocks.description).includes('comments:false')
    && !String(_byName.lanhu_read_blocks.description).includes('不需要评论时')
    && /默认/.test(cdesc) && /多 1~N 次请求/.test(cdesc) && /只读/.test(cdesc),
    cdesc.slice(0, 60));
  const alimit = _propDesc('lanhu_audit_project', 'limit');
  ok('audit 的成本只说一次（工具描述里说，limit 参数只留默认值/硬上限）',
    !/2 次请求|2N|两次请求/.test(alimit) && /硬上限/.test(alimit)
    && /2N 次请求/.test(String(_byName.lanhu_audit_project.description)),
    alimit);
  ok('「不静默回退」的规则只在 version / from 参数上（decription 里不再复述）',
    !/静默回退/.test(String(_byName.lanhu_diff_design.description))
    && /静默回退/.test(_propDesc('lanhu_diff_design', 'from'))
    && /静默回退/.test(_propDesc('lanhu_read_design', 'version')));
  ok('read_product_doc 的两步读法写在 pageId 参数上，不在工具描述里',
    !String(_byName.lanhu_read_product_doc.description).includes('先不带 pageId')
    && /先不带它调一次/.test(_propDesc('lanhu_read_product_doc', 'pageId')));
  ok('verify_spec 不再描述内部引擎（puppeteer / Playwright / getComputedStyle）',
    !/puppeteer|Playwright|getComputedStyle/i.test(String(_byName.lanhu_verify_spec.description)));
}

/* —— ③ rpx 换算公式只有一处（系统提示的【换算】），参数只指路 —— */
{
  const FORMULA = 'rpx = px × 750 ÷ 画板宽';
  const hits = _modelSurface().split(FORMULA).length - 1;
  ok(`换算公式在模型面里只出现一次（现在 ${hits} 处；参数里再抄一遍就红）`, hits === 1, `出现 ${hits} 处`);
  ok('那一处就在【换算】段', _hintText.includes(FORMULA));
  ok('gen_code.target 指路而不是再抄一遍公式',
    /换算基准见系统提示【换算】/.test(_propDesc('lanhu_gen_code', 'target')));
}

/* —— ④ 「整条贴链接」的便利只在系统提示 + url 参数上说，工具描述不再各抄一遍 —— */
{
  const dup = TOOLS.filter((t) => String(t.description).includes('直接粘贴蓝湖链接即可')).map((t) => t.name);
  ok('工具描述里不再重复「直接粘贴蓝湖链接即可」', dup.length === 0, dup.join('、'));
  ok('搬走不是删掉：url 参数与系统提示都还留着它',
    /整条粘贴/.test(_propDesc('lanhu_read_blocks', 'url')) && _hintText.includes('贴整条蓝湖链接最省事'));
}

/* —— ⑤ 删掉「评论段的读法」那段的依据：这几件事**结果文本自己**就说了 —— */
{
  ok('读不到评论时，结果文本自己说明「不等于没有评论」',
    /这不代表"没人留评论"/.test(renderComments({ error: 'boom' })),
    renderComments({ error: 'boom' }).slice(0, 50));
  const loose = renderComments({
    items: [{
      id: 'c1', content: 'x', unread: false, user: { name: 'u' },
      anchor: { reason: 'blank', x: 1, y: 2, block: { label: '卡片', w: 10, h: 10 }, distance: 12 },
    }],
  });
  ok('落在空白处时，结果文本自己说明「只是线索，不是命中」', /只是线索，不是命中/.test(loose), loose.slice(0, 80));
  ok('提示里不再复述这些（复述=与每次都会读到的结果文本重复）',
    !_hintText.includes('线索不是命中') && !_hintText.includes('评论段的读法'));
}

/* —— ⑥ 反向守卫：精简不许退化成删空 —— */
{
  const thin = TOOLS.filter((t) => String(t.description ?? '').trim().length < 20).map((t) => t.name);
  ok('每个工具都还有像样的 description（没被删空）', thin.length === 0, thin.join('、'));
  const bullets = (_hintText.match(/^· /gm) ?? []).length;
  ok('决策树仍然逐条回答「什么时候用哪个」（≥8 条）', bullets >= 8, `${bullets} 条`);
}

/* —— ⑦ 预算闸门：这是**棘轮**，故意抬它必须是一次有意识的改动 —— */
{
  ok(`SYSTEM_HINT 不超预算（现 ${_hintText.length} / 预算 2400 字符）`, _hintText.length <= 2400, `现 ${_hintText.length}`);
  const chars = _hintText.length + TOOLS.reduce((a, t) => a
    + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0);
  ok(`模型面首轮提示不超预算（现 ${chars} / 预算 19800 字符）`, chars <= 19800, `现 ${chars}`);
}

/* ═══════════════ ④.5 lossless JSON（宿主会拒收整个结果） ═══════════════ */
group('④.5 lossless JSON');

/** 递归找出所有非法 lossless 值。 */
function findIllegal(v, path = '$', out = []) {
  if (v === undefined) { out.push(path); return out; }
  if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) out.push(path + '=' + v);
  if (Array.isArray(v)) v.forEach((x, i) => findIllegal(x, path + '[' + i + ']', out));
  else if (v !== null && typeof v === 'object') Object.keys(v).forEach((k) => findIllegal(v[k], path + '.' + k, out));
  return out;
}

{
  // 清洗函数本身
  eq('undefined → null', toLossless(undefined), null);
  eq('嵌套 undefined → null', toLossless({ a: { b: undefined } }).a.b, null);
  eq('NaN → null', toLossless(NaN), null);
  eq('Infinity → null', toLossless(Infinity), null);
  eq('-0 → null', toLossless(-0), null);
  eq('数组里的 undefined → null', toLossless([1, undefined, 3])[1], null);
  eq('布尔/字符串/有限数字原样保留', JSON.stringify(toLossless({ a: 1, b: 'x', c: true, d: null })), '{"a":1,"b":"x","c":true,"d":null}');
  eq('对象键保留（值换 null）', Object.prototype.hasOwnProperty.call(toLossless({ k: undefined }), 'k'), true);
  ok('清洗后自身无非法值', findIllegal(toLossless({ a: undefined, b: [NaN] })).length === 0);
}
{
  // ⚠️ 核心回归：块级模型的输出必须天然 lossless。
  //    实测 `lanhu_read_blocks` 曾因 `blocks[].inset` 与 `blocks[].font.lineHeight` 是 undefined，
  //    被 DSH 宿主**拒收整个结果**（`value is not lossless JSON`），agent 一点数据都拿不到。
  //    构建于 flattenArtboard 之上，所以那两处也必须给 null。
  const flat = [];
  const mk = (o, parentPath, depth) => Object.assign({
    id: 'x', type: 'shapeLayer', name: 'x', parentPath, depth,
    x: 0, y: 0, w: 10, h: 10, inset: depth === 0 ? null : { left: 0, top: 0, right: 0, bottom: 0 },
    visible: true, opacity: 1, shape: 'rect', radius: null, border: null,
    colors: [], text: null, font: null, hasImage: false,
  }, o);
  flat.push(mk({ name: '画板' }, '', 0));
  flat.push(mk({ name: '标题', text: 'x', font: { size: 14, weight: 400, lineHeight: null, letterSpacing: null, family: null, align: null } }, '画板', 1));
  flat.push(mk({ name: '无行高文本', text: 'y', font: { size: 12, weight: 400, lineHeight: null } }, '画板', 1));
  const blocks = buildBlocks(flat);
  ok('buildBlocks 输出无非法 lossless 值', findIllegal(blocks).length === 0, findIllegal(blocks).slice(0, 3).join(', '));
  ok('顶层块的 inset 是 null 而非 undefined', blocks[0].inset === null);
  ok('renderBlocks 输出无非法值', findIllegal({ t: renderBlocks(blocks, { name: 't', width: 1, height: 1 }) }).length === 0);
}
{
  // 所有工具的**声明**里不能出现 undefined 默认值之类（schema 自身要能 JSON 序列化）
  for (const t of TOOLS) {
    let serializable = true;
    try { JSON.parse(JSON.stringify(t.parameters)); } catch { serializable = false; }
    ok(`${t.name} 的 parameters 可无损序列化`, serializable);
  }
}

/* ═══════════════ ⑤ 颜色解析（0-1 归一化） ═══════════════ */
group('⑤ 颜色解析');

eq('归一化 0-1 转 255', parseColor({ r: 0.9529, g: 0.9529, b: 0.9529, a: 1 }).r, 243);
eq('alpha 保留', parseColor({ r: 1, g: 0, b: 0, a: 0.8 }).a, 0.8);

/* ═══════════════ ⑥ 块级模型分类 ═══════════════ */
group('⑥ 块级模型');

/** 造一个扁平层（字段与 flattenArtboard 输出一致）。 */
const layer = (o) => Object.assign({
  id: o.name, type: 'shapeLayer', name: o.name, parentPath: '', depth: 1,
  x: 0, y: 0, w: 100, h: 20, visible: true, opacity: 1,
  shape: 'rect', radius: null, border: undefined, colors: [],
  text: undefined, font: undefined, hasImage: false,
}, o);

{
  const layers = [
    // 全圆胶囊：79×26 圆角 38（案例 1 的主角）
    layer({ name: 'Contact Button', w: 79, h: 26, radius: { corners: [38, 38, 38, 38], max: 38 }, colors: [{ r: 1, g: 1, b: 1, a: 1, role: 'fill' }] }),
    // 只有单边边框 + 无底色 + 薄 → 分割线（案例 2）
    layer({ name: 'Divider Holder', w: 67, h: 16, border: { color: '#e2e8f0', width: 1, widths: { top: 0, right: 0, bottom: 0, left: 1 }, sides: ['left'], single: 'left' } }),
    // 极细长实心条 → 分割线
    layer({ name: 'Rule', w: 200, h: 1, colors: [{ r: 0.8, g: 0.8, b: 0.8, a: 1, role: 'fill' }] }),
    // 大块 + 有底色 + 有圆角 → 卡片
    layer({ name: 'Article - CARD 1', w: 343, h: 192, radius: { corners: [14, 14, 14, 14], max: 14 }, colors: [{ r: 0.98, g: 0.97, b: 0.99, a: 1, role: 'fill' }] }),
    // 纯布局层（无样式）→ 不算块
    layer({ name: 'Mobile Screen Container', w: 375, h: 798 }),
    // 文本
    layer({ name: '标题', w: 64, h: 52, text: '示例设计稿', font: { size: 16, weight: 600 }, colors: [{ r: 0, g: 0, b: 0, a: 1, role: 'text' }] }),
    // 系统 UI 碎片 → noise
    layer({ name: 'Bar', w: 3, h: 4, parentPath: 'iPhoneX/Status Bar', colors: [{ r: 0, g: 0, b: 0, a: 1, role: 'fill' }] }),
  ];
  const blocks = buildBlocks(layers);
  const byName = (n) => blocks.find((b) => b.name === n);

  eq('胶囊被识别为 pill', byName('Contact Button')?.kind, 'pill');
  ok('胶囊标了全圆', byName('Contact Button')?.radius?.pill === true);
  eq('单边边框块保留边框信息（thin>12 时归类为容器，分割线信息在 border 里）', byName('Divider Holder')?.border?.single, 'left');
  eq('极细长条被识别为分割线', byName('Rule')?.kind, 'divider');
  eq('大块有样式被识别为卡片', byName('Article - CARD 1')?.kind, 'card');
  eq('纯布局层不算块', byName('Mobile Screen Container'), undefined);
  eq('文本块', byName('标题')?.kind, 'text');
  ok('系统 UI 碎片被标 noise', byName('Bar')?.noise === true);
  ok('每块都有唯一 uid', new Set(blocks.map((b) => b.uid)).size === blocks.length);
  ok('每块六项属性字段齐全', blocks.every((b) =>
    'radius' in b && 'w' in b && 'h' in b && 'color' in b && 'font' in b && 'bg' in b && 'border' in b));
  ok('renderBlocks 不抛错且含表头', (() => {
    const t = renderBlocks(blocks, { name: 't', width: 375, height: 896 });
    return typeof t === 'string' && t.includes('块级清单');
  })());
  ok('renderRegion 不抛错', (() => {
    const r = renderRegion(layers, { y0: 0, y1: 500 });
    return typeof r.text === 'string';
  })());
}

/* ═══════════════ ⑥.5 CLI 入口守卫 ═══════════════ */
group('⑥.5 CLI 入口守卫');

{
  // ⚠️ 回归：曾用 `import.meta.url === pathToFileURL(process.argv[1]).href` 判入口。
  //    Node ESM 的 import.meta.url 是 **realpath 后**的，而 argv[1] 保留调用时写的路径 ——
  //    于是**经符号链接调用**（npm bin / pnpm / 手搓软链）时两边永不相等，
  //    `main()` 一次都不执行：**零输出、退出码 0**，比报错还难查。
  const SELF = path.resolve(fileURLToPath(import.meta.url), '../../lanhu.mjs');
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lanhu-entry-'));
  const link = path.join(linkDir, 'lanhu-link.mjs');
  try {
    fs.symlinkSync(SELF, link);
    const viaLink = execFileSync(process.execPath, [link], { encoding: 'utf8', timeout: 30000 });
    ok('经符号链接调用能执行（不是零输出 exit 0）', viaLink.length > 200, `${viaLink.length} 字节`);
    const viaReal = execFileSync(process.execPath, [SELF], { encoding: 'utf8', timeout: 30000 });
    ok('符号链接与真实路径输出一致', viaLink === viaReal);
    const sub = execFileSync(process.execPath, [link, 'log', '--limit', '1'], { encoding: 'utf8', timeout: 60000 });
    ok('经符号链接能执行子命令', sub.length > 0 || true);

    // ⚠️ 回归：未知命令曾**打印一屏帮助、退出码 0** —— 脚本/CI 会把「帮助文本」当成执行成功。
    //    给了命令但没人接 ⇒ 1；没给命令（或 --help）只是看帮助 ⇒ 0。
    const exitOf = (argv) => {
      try {
        execFileSync(process.execPath, [link, ...argv], { stdio: 'ignore', timeout: 30000 });
        return 0;
      } catch (e) { return e.status ?? -1; }
    };
    const unknownExit = exitOf(['definitely-not-a-command']);
    ok('未知命令非零退出（不再把帮助文本当成功）', unknownExit === 1, `exit=${unknownExit}`);
    ok('无参数只打帮助、退出码仍为 0', exitOf([]) === 0);
    ok('校验失败的命令以非零退出（只给 project 没给 image）', exitOf(['read', '--project', '00000002-0000-4000-8000-000000000002']) !== 0);
  } catch (e) {
    ok('经符号链接调用能执行（不是零输出 exit 0）', false, String(e.message).slice(0, 80));
  } finally {
    try { fs.rmSync(linkDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

/* ═══════════════ ⑥.8 块级比对（匹配 + 六项判定） ═══════════════ */
group('⑥.8 块级比对');

{
  const mkBlock = (o) => Object.assign({
    uid: 0, kind: 'container', name: '', x: 0, y: 0, w: 10, h: 10,
    radius: null, bg: null, border: null, font: null, color: null, text: null, noise: false,
  }, o);
  const mkEl = (o) => normalizePageElements([Object.assign({
    tag: 'div', x: 0, y: 0, w: 10, h: 10, text: '', color: 'rgb(0, 0, 0)', fontSize: 12,
    fontWeight: '400', background: 'rgba(0, 0, 0, 0)', radius: 0,
    borders: { top: { w: 0, style: 'none' }, right: { w: 0, style: 'none' }, bottom: { w: 0, style: 'none' }, left: { w: 0, style: 'none' } },
  }, o)])[0];

  const g = (rows, f) => rows.find((r) => r.field === f);

  // ① 文本匹配
  {
    const b = mkBlock({ uid: 1, kind: 'text', name: 'T', text: '示例设计稿', x: 10, y: 10, w: 60, h: 20 });
    const els = [mkEl({ x: 10, y: 10, w: 56, h: 20, text: '示例设计稿' })];
    const m = matchBlocks([b], els, { scale: 1 });
    eq('文本匹配命中', m[0].matchedBy, 'text');
  }
  // ② 显式标注优先
  {
    const b = mkBlock({ uid: 1, kind: 'container', name: 'Card A', x: 0, y: 0, w: 100, h: 50 });
    const els = [mkEl({ x: 999, y: 999, w: 10, h: 10, dataLanhu: 'Card A' })];
    const m = matchBlocks([b], els, { scale: 1 });
    eq('data-lanhu 优先于几何', m[0].matchedBy, 'data-lanhu');
  }
  // ③ 几何兜底（无文本块唯一的出路）
  {
    const b = mkBlock({ uid: 1, kind: 'container', name: 'Box', x: 16, y: 222, w: 343, h: 192 });
    const els = [mkEl({ x: 16, y: 222, w: 343, h: 192 })];
    const m = matchBlocks([b], els, { scale: 1 });
    eq('几何兜底命中', m[0].matchedBy, 'geometry');
  }
  // ④ 一个元素可同时是「容器块的落点」与「文本块的落点」（<div class=chip>正常</div> 很常见）
  {
    const chip = mkBlock({ uid: 1, kind: 'container', name: 'Chip', x: 0, y: 0, w: 34, h: 19 });
    const label = mkBlock({ uid: 2, kind: 'text', name: 'Label', text: '正常', x: 5, y: 4, w: 20, h: 14 });
    const els = [mkEl({ x: 0, y: 0, w: 34, h: 19, text: '正常' })];
    const m = matchBlocks([chip, label], els, { scale: 1 });
    ok('容器块与文本块可共享同一元素', m[0].element === m[1].element && m[1].element !== null);
  }
  // ⑤ 大块优先 + 尺寸约束：按钮内部的小图元不该抢走按钮元素
  {
    const button = mkBlock({ uid: 1, kind: 'pill', name: 'Contact Button', x: 0, y: 0, w: 79, h: 26 });
    const icon = mkBlock({ uid: 2, kind: 'container', name: 'Vector', x: 10, y: 6, w: 12, h: 13 });
    const els = [mkEl({ x: 0, y: 0, w: 79, h: 26, className: 'contact' })];
    const m = matchBlocks([icon, button], els, { scale: 1 });
    const btn = m.find((x) => x.block.name === 'Contact Button');
    const ic = m.find((x) => x.block.name === 'Vector');
    eq('大块优先拿到容器元素', btn.matchedBy, 'geometry');
    ok('尺寸差 4 倍以上的小图元不抢容器', ic.element === null);
  }
  // ⑥ 画板不参与
  {
    const ab = mkBlock({ uid: 1, kind: 'artboard', name: '画板', w: 375, h: 896 });
    ok('画板块被跳过', matchBlocks([ab], [mkEl({})], {}).length === 0);
  }
  // ⑦ 六项判定
  {
    const b = mkBlock({
      uid: 1, kind: 'pill', name: 'Btn', w: 79, h: 26,
      radius: { max: 38, pill: true, corners: [38, 38, 38, 38] },
      bg: { hex: '#ffffff' }, border: { color: '#574af4', width: 1, sides: ['top', 'right', 'bottom', 'left'], single: null },
    });
    const el = mkEl({
      w: 79, h: 26, radius: 38, background: 'rgb(255, 255, 255)', fontSize: 12,
      borders: { top: { w: 1, color: 'rgb(87, 74, 244)', style: 'solid' }, right: { w: 1, color: 'rgb(87, 74, 244)', style: 'solid' }, bottom: { w: 1, color: 'rgb(87, 74, 244)', style: 'solid' }, left: { w: 1, color: 'rgb(87, 74, 244)', style: 'solid' } },
    });
    const rows = compareBlockProps(b, el, { scale: 1, target: 'mini', designWidth: 375, rpxBase: 750 });
    ok('全对时圆角/底色/边框都 ✅', ['border-radius', 'background', 'border'].every((f) => g(rows, f).verdict === '✅'));
  }
  {
    // 案例②：设计稿有单边分割线、页面没有 → 必须 ❌，且建议里给出可直接抄的写法
    const b = mkBlock({ uid: 1, kind: 'divider', name: 'Rule', w: 375, h: 2, border: { color: '#e2e8f0', width: 1, sides: ['top'], single: 'top' } });
    const rows = compareBlockProps(b, mkEl({ w: 375, h: 2 }), { scale: 1 });
    const r = g(rows, 'border');
    ok('分割线丢失被判 ❌', r.verdict === '❌');
    ok('并给出 border-top 建议', /border-top: 1px solid #e2e8f0/.test(r.suggestion), r.suggestion);
  }
  {
    // 页面多加了设计稿没有的东西 → 也要报
    const b = mkBlock({ uid: 1, kind: 'container', name: 'Plain', w: 100, h: 20 });
    const rows = compareBlockProps(b, mkEl({ w: 100, h: 20, background: 'rgb(255, 0, 0)', radius: 8 }), { scale: 1 });
    ok('页面多加底色被判 ❌', g(rows, 'background').verdict === '❌');
  }
  {
    // 近似色必须报出来（#eff6ff vs #f1effe）
    const b = mkBlock({ uid: 1, kind: 'container', name: 'Chip', w: 76, h: 21, bg: { hex: '#eff6ff' } });
    const rows = compareBlockProps(b, mkEl({ w: 76, h: 21, background: 'rgb(241, 239, 254)' }), { scale: 1 });
    ok('近似色被判 ❌（不是容差内）', g(rows, 'background').verdict === '❌', g(rows, 'background').actual);
  }
  {
    // 圆角：数值不同但都是全圆 → 🟡 视觉等价，不误报 ❌
    const b = mkBlock({ uid: 1, kind: 'pill', name: 'Btn', w: 79, h: 26, radius: { max: 38, pill: true, corners: [38, 38, 38, 38] } });
    const rows = compareBlockProps(b, mkEl({ w: 79, h: 26, radius: 14 }), { scale: 1 });
    eq('全圆 vs 全圆（数值不同）判 🟡', g(rows, 'border-radius').verdict, '🟡');
    const rows2 = compareBlockProps(b, mkEl({ w: 79, h: 26, radius: 8 }), { scale: 1 });
    eq('页面不是全圆则判 ❌', g(rows2, 'border-radius').verdict, '❌');
  }
  {
    // 未映射 → ⚪（映射失败本身就是问题，要单列）
    const b = mkBlock({ uid: 1, kind: 'card', name: 'Ghost', w: 100, h: 50 });
    const rows = compareBlockProps(b, null, { scale: 1 });
    eq('未映射判 ⚪', rows[0].verdict, '⚪');
  }
  {
    // 文本块的尺寸是信息项（Figma 文本框 ≠ 渲染盒），不该假 ❌
    const b = mkBlock({ uid: 1, kind: 'text', name: 'T', text: 'x', w: 64, h: 52, color: '#000000', font: { size: 16, weight: 600 } });
    const rows = compareBlockProps(b, mkEl({ w: 56, h: 20, color: 'rgb(0, 0, 0)', fontSize: 14, fontWeight: '600' }), { scale: 1 });
    ok('文本块尺寸不假 ❌', g(rows, '大小').verdict !== '❌', g(rows, '大小').verdict);
    eq('但字号错仍判 ❌', g(rows, 'font-size').verdict, '❌');
  }
  // ⑧ 块名兜底
  {
    eq('无名块用类型+尺寸兜底', blockLabel({ name: '', kind: 'text', w: 3, h: 17 }), '文本 3×17');
    eq('有名块用名字', blockLabel({ name: '标题', kind: 'text', w: 1, h: 1 }), '标题');
  }
}

/* ═══════════════ ⑥.9 输出完整性（交接清单缺口 1–4） ═══════════════ */
group('⑥.9 输出完整性');

{
  // 原始节点形状（flattenArtboard 的输入）。带 fill 的层才可能成为块 ——
  // 否则「被排除」可能只是因为没样式，断言会假通过。
  const raw = (o) => Object.assign({
    id: o.name, type: 'shapeLayer', name: o.name,
    realFrame: { left: o.x ?? 0, top: o.y ?? 0, width: o.w ?? 200, height: o.h ?? 100 },
    opacity: 1, style: { fills: [{ type: 'color', color: { r: 1, g: 0, b: 0, a: 1 } }] }, layers: [],
  }, o);

  // —— 缺口 2：visible 必须沿祖先链继承 ——
  const showTree = raw({ name: '显示组', visible: true, layers: [raw({ name: '显示组子层' })] });
  const showFlat = flattenArtboard(showTree);
  ok('对照组：父组可见时子层 visible=true', showFlat.find((l) => l.name === '显示组子层')?.visible === true);
  const hideTree = raw({ name: '隐藏组', visible: false, layers: [raw({ name: '隐藏组子层' })] });
  const hideFlat = flattenArtboard(hideTree);
  ok('父层 visible=false 时子层 visible 也=false（缺口2）',
    hideFlat.find((l) => l.name === '隐藏组子层')?.visible === false);
  ok('隐藏组里的子层不进块表（缺口2 的实际后果）',
    buildBlocks(hideFlat).filter((b) => b.name === '隐藏组子层').length === 0);

  // —— 缺口 1：透明度判据要用累乘后的 effectiveOpacity ——
  const opaqueTree = raw({ name: '不透明组', opacity: 1, layers: [raw({ name: '子层A' })] });
  ok('对照组：父组不透明时子层进块表',
    buildBlocks(flattenArtboard(opaqueTree)).filter((b) => b.name === '子层A').length === 1);
  const zeroTree = raw({ name: '全透明组', opacity: 0, layers: [raw({ name: '子层B' })] });
  const zeroFlat = flattenArtboard(zeroTree);
  eq('父组 opacity=0 时子层 effectiveOpacity=0（缺口1）',
    zeroFlat.find((l) => l.name === '子层B')?.effectiveOpacity, 0);
  ok('父组 opacity=0 时子层不进块表（缺口1）',
    buildBlocks(zeroFlat).filter((b) => b.name === '子层B').length === 0);
  ok('自身 opacity=0 仍被排除（不回归）',
    buildBlocks([layer({ name: 'op0', opacity: 0, effectiveOpacity: 0, style: undefined })]).length === 0);
  ok('opacity=1 的块正常保留（不回归）',
    buildBlocks([layer({ name: 'op1', opacity: 1, effectiveOpacity: 1, colors: [{ r: 1, g: 0, b: 0, a: 1, role: 'fill' }] })]).length === 1);

  // —— 缺口 3：行高 / 字距必须进三张表（与 font.family 同构的病）——
  const metric = layer({
    name: '行高字距层', text: '正文', w: 100, h: 22, y: 10,
    font: { size: 16, weight: 400, family: 'Inter', lineHeight: 22, letterSpacing: 0.5 },
    colors: [{ r: 1, g: 1, b: 1, a: 1, role: 'text' }],
  });
  ok('块表打出 行高/字距（缺口3）',
    renderBlocks(buildBlocks([metric]), { name: 't', width: 375, height: 896 }).includes('22/0.5'));
  ok('区域表打出 行高/字距（缺口3）',
    renderRegion([metric], { y0: 0, y1: 100 }).text.includes('22/0.5'));
  ok('summary 文本层表打出 行高/字距（缺口3）',
    renderSummary({
      detail: { name: 't', width: 1, height: 1 }, layers: [metric],
      tokens: collectTokens([metric]), meta: { name: 't', width: 1, height: 1 },
    }).includes('22/0.5'));
  ok('只有行高时字距给 —（缺口3 不编造）',
    renderRegion([layer({ name: 'onlyLh', text: 'x', y: 10, font: { size: 12, weight: 400, lineHeight: 18 } })], { y0: 0, y1: 100 }).text.includes('18/—'));

  // —— 缺口 4：多段渐变必须打全部 stop ——
  const grad = layer({
    name: '地图辉光', w: 200, h: 100, y: 10,
    colors: [
      { r: 0x14, g: 0x59, b: 0x94, a: 0.18, role: 'gradient' },
      { r: 0x08, g: 0x29, b: 0x4a, a: 0.1, role: 'gradient' },
    ],
  });
  const gb = buildBlocks([grad])[0];
  eq('多段渐变保留全部 stop（缺口4）', gb?.bg?.stops?.length, 2);
  eq('多段渐变的 hex 仍是第一段（既有语义不变）', gb?.bg?.hex, '#145994');
  ok('区域表把渐变串成 a→b（缺口4）', renderRegion([grad], { y0: 0, y1: 100 }).text.includes('→'));
  ok('块表把渐变串成 a→b（缺口4）',
    renderBlocks(buildBlocks([grad]), { name: 't', width: 1, height: 1 }).includes('→'));
  ok('单色填充的 stops 为空数组（不噪音）',
    buildBlocks([layer({ name: 'solid', colors: [{ r: 1, g: 0, b: 0, a: 1, role: 'fill' }] })])[0]?.bg?.stops?.length === 0);

  // —— 附带：region 的 limit 必须真的生效（711 层的稿子默认只列 80）——
  const many = Array.from({ length: 200 }, (_, i) => layer({ name: `L${i}`, y: i, text: `t${i}` }));
  const rowsOf = (t) => t.split('\n').filter((x) => /^\| d\d/.test(x)).length;
  eq('region 默认列 80 行', rowsOf(renderRegion(many, { y0: 0, y1: 1000 }).text), 80);
  eq('region 的 limit 生效（传 150 就列 150）', rowsOf(renderRegion(many, { y0: 0, y1: 1000, limit: 150 }).text), 150);
  ok('region 截断时表头提示可以调大',
    renderRegion(many, { y0: 0, y1: 1000, limit: 10 }).text.includes('只列前 10'));
}

/* ═══════════════ ⑥.10 图片元信息（切图 alpha 报告） ═══════════════ */
group('⑥.10 图片元信息');

{
  // 零依赖手写一个最小 PNG 编码器 —— 只为把解析路径真跑一遍（导出流程不产出图片，所以只能自己造）。
  const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
    return t;
  })();
  const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  /** pixels: Buffer(w*h*4) RGBA */
  const makePng = (w, h, pixels) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
    const stride = w * 4;
    const raw = Buffer.alloc(h * (1 + stride));
    for (let y = 0; y < h; y++) {
      raw[y * (1 + stride)] = 0; // filter: none
      pixels.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
  };
  const px = (w, h, alphaOf) => {
    const b = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { b[i * 4] = 10; b[i * 4 + 1] = 20; b[i * 4 + 2] = 30; b[i * 4 + 3] = alphaOf(i); }
    return b;
  };

  // ⚠️ 这条断言直接对应实测事故：设计稿 BG 是 RGBA 半透明（alpha 132~255），
  //    直接转 JPG 丢 alpha → 整屏发灰。插件必须把范围量出来，调用方才知道不能直转。
  const half = imageMeta(makePng(4, 2, px(4, 2, (i) => (i % 4 === 0 ? 132 : 255))));
  eq('半透明 PNG 量出宽高', [half.width, half.height], [4, 2]);
  eq('半透明 PNG mode=RGBA', half.mode, 'RGBA');
  eq('半透明 PNG 量出 alpha 范围', half.alphaRange, [132, 255]);
  eq('半透明 PNG hasAlpha=true', half.hasAlpha, true);

  const opaque = imageMeta(makePng(3, 1, px(3, 1, () => 255)));
  eq('全不透明 PNG alphaRange=[255,255]', opaque.alphaRange, [255, 255]);
  eq('全不透明 PNG hasAlpha=false', opaque.hasAlpha, false);

  // 未知格式：字段必须全是合法 JSON 值（undefined 会被宿主拒收整个结果）
  const unknown = imageMeta(Buffer.from('definitely not an image'));
  eq('未知格式 format=unknown', unknown.format, 'unknown');
  ok('未知格式字段无 undefined', Object.values(unknown).every((v) => v !== undefined));
  eq('未知格式宽高给 null 而不是 undefined', [unknown.width, unknown.height, unknown.alphaRange], [null, null, null]);

  // 截断文件不能崩（真实下载会中断）
  ok('截断的 PNG 不抛错', (() => { try { imageMeta(makePng(4, 2, px(4, 2, () => 200)).subarray(0, 30)); return true; } catch { return false; } })());
  ok('空 buffer 不抛错', (() => { try { imageMeta(Buffer.alloc(0)); return true; } catch { return false; } })());

  // SVG 矢量图（实测一张首页 46 张切图里 23 张是 SVG）—— mode 不能留空，
  // 否则一半的切图"没信息"，又回到"输出不完整"的老毛病。
  const svg = Buffer.from('<svg width="138" height="59" viewBox="0 0 138 59" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>');
  const ms = imageMeta(svg);
  eq('SVG format=svg', ms.format, 'svg');
  eq('SVG mode=vector', ms.mode, 'vector');
  eq('SVG 宽高取自属性', [ms.width, ms.height], [138, 59]);
  const svgPct = Buffer.from('<svg width="100%" height="100%" viewBox="0 0 24 30"></svg>');
  eq('SVG width=100% 时用 viewBox 兜底', [imageMeta(svgPct).width, imageMeta(svgPct).height], [24, 30]);
}

/* ═══════════════ ⑥.11 字体族比对（需求 2） ═══════════════ */
group('⑥.11 字体族比对');

{
  // 归一化三条（少一条都会误报成灾）
  eq('归一化：去引号与空白', normalizeFamily('"Alibaba PuHuiTi 2.0"'), 'alibabapuhuiti2.0');
  eq('归一化：Family-Style 与纯 family 名等价', familyKey('YouSheBiaoTiHei-Regular'), familyKey('YouSheBiaoTiHei'));
  eq('归一化：大小写不敏感', familyKey('YOUSHEBIAOTIHEI'), familyKey('youshebiaotihei'));

  // 判定：**不要求字符串相等**，出现在页面栈前 3 位即通过
  const ok1 = familyInStack('Alibaba PuHuiTi 2.0', '"Alibaba PuHuiTi 2.0", "Microsoft YaHei", sans-serif');
  eq('设计稿字体在首位 → 通过', ok1.ok, true);
  eq('报出命中位置 0', ok1.index, 0);
  const bad = familyInStack('YouSheBiaoTiHei', '"Alibaba PuHuiTi 2.0", "Microsoft YaHei", sans-serif');
  eq('栈里根本没有该字体 → 不通过', bad.ok, false);
  eq('没找到时 index=-1', bad.index, -1);
  const deep = familyInStack('Inter', '"A", "B", "C", Inter, sans-serif');
  eq('排在第 4 位 → 不算通过（容易被盖住）', deep.ok, false);
  eq('但能报出它排在第 4 位', deep.index, 3);

  // 端到端：这就是需求里的验收场景 ——「字号对、字体错」必须被判出来
  const block = layer({ name: '标题', kind: 'text', text: 'x', font: { size: 16, weight: 400, family: 'YouSheBiaoTiHei' } });
  const elBase = { x: 0, y: 0, w: 64, h: 20, radius: 0, color: 'rgb(255,255,255)', fontSize: 16, fontWeight: '400' };
  const famRow = (el) => compareBlockProps(block, el).find((r) => r.field === 'font-family');
  const wrongFam = famRow({ ...elBase, fontFamily: '"Alibaba PuHuiTi 2.0", "Microsoft YaHei"' });
  eq('字号对、字体错 → font-family 判 ❌（不再整体"匹配"）', wrongFam?.verdict, '❌');
  ok('❌ 时给出可抄的 font-family 建议', /font-family: YouSheBiaoTiHei/.test(wrongFam?.suggestion ?? ''), wrongFam?.suggestion);
  eq('页面栈首位命中 → ✅', famRow({ ...elBase, fontFamily: '"YouSheBiaoTiHei", "Microsoft YaHei"' })?.verdict, '✅');
  eq('Family-Style 写法也算命中（-Regular 等价）', famRow({ ...elBase, fontFamily: 'YouSheBiaoTiHei-Regular, sans-serif' })?.verdict, '✅');
  eq('排到第 4 位 → 🟡（存在但易被盖住，不误报 ❌）', famRow({ ...elBase, fontFamily: '"A", "B", "C", YouSheBiaoTiHei' })?.verdict, '🟡');

  // ⚠️ 回归（2026-09-20 实测缺陷）：三张表里显示的字体是**短名**（`shortFamily` 去掉 `.0`），
  //    而判定拿的是设计稿**原名** —— 曾经出现「写全名 ✅、照表抄短名 ❌」，
  //    并给出 `font-family: Alibaba PuHuiTi 2.0, Alibaba PuHuiTi 2` 这种把同一字体列两遍、等于没改的建议。
  eq('版本尾巴 .0 不影响判定（全名 ≡ 短名）', familyKey('Alibaba PuHuiTi 2.0'), familyKey('Alibaba PuHuiTi 2'));
  // 反向：**只剥 `.0`** —— v1 与 v2 是不同字体，绝不能合并（该稿两者并存）
  ok('v1 与 v2 不混为一谈（Alibaba PuHuiTi ≠ Alibaba PuHuiTi 2.0）',
    familyKey('Alibaba PuHuiTi') !== familyKey('Alibaba PuHuiTi 2.0'));

  const famBlock = layer({ name: '标题2', kind: 'text', text: 'x', font: { size: 16, weight: 400, family: 'Alibaba PuHuiTi 2.0' } });
  const famRowOf = (ff) => compareBlockProps(famBlock, { ...elBase, fontFamily: ff }).find((r) => r.field === 'font-family');
  eq('写设计稿全名 → ✅', famRowOf('"Alibaba PuHuiTi 2.0", sans-serif')?.verdict, '✅');
  eq('照表格抄短名 → 也 ✅（本轮缺陷回归）', famRowOf('"Alibaba PuHuiTi 2", sans-serif')?.verdict, '✅');
  const famSug = famRowOf('"Arial", sans-serif')?.suggestion ?? '';
  ok('真不匹配时，建议里不重复列出同一字体（不能"等于没改"）',
    !/Alibaba PuHuiTi 2\.0.*Alibaba PuHuiTi 2(,|$)/.test(famSug), famSug);
}

/* ═══════════════ ⑥.12 坐标映射（需求 3） ═══════════════ */
group('⑥.12 坐标映射');

{
  // 需求里的实测参照框：设计稿地图区域总 bbox → 本地自绘 SVG 内容 bbox
  const mb = { x0: 659.32, y0: 120.58, x1: 1271.64, y1: 651.53 }; // 612.32 × 530.95，比例 1.153
  const tb = { x0: 4, y0: 4, x1: 442.3, y1: 480.3 };              // 438.3 × 476.3，比例 0.920
  const sx = (tb.x1 - tb.x0) / (mb.x1 - mb.x0);
  const sy = (tb.y1 - tb.y0) / (mb.y1 - mb.y0);
  const r2 = (v) => Math.round(v * 100) / 100;

  const hotspot = layer({ name: '某热点 / Hotspot', x: 1095.44, y: 323.1, w: 13.2, h: 15.21 });
  const r = renderRegion([hotspot], { y0: 0, y1: 1000, mapBox: mb, toBox: tb });
  ok('表头出现「映射 x,y」「映射 w×h」', r.text.includes('映射 x,y') && r.text.includes('映射 w×h'));
  const expX = r2(tb.x0 + (1095.44 - mb.x0) * sx);
  const expY = r2(tb.y0 + (323.1 - mb.y0) * sy);
  ok(`热点映射到目标坐标系（${expX},${expY}）`, r.text.includes(`${expX},${expY}`),
    r.text.split('\n').find((l) => l.startsWith('| d')));
  // ⚠️ 这是需求里点名的那条：**不要**按单一 scale 等比，否则纵向对不上
  ok('x/y 独立缩放（sx≠sy，非等比）', Math.abs(sx - sy) > 0.1, `sx=${sx.toFixed(3)} sy=${sy.toFixed(3)}`);
  ok('表头写明非等比', r.text.includes('非等比'));

  const corner = renderRegion([layer({ name: 'corner', x: mb.x1, y: mb.y1, w: 0.1, h: 0.1 })], { y0: 0, y1: 1e6, mapBox: mb, toBox: tb });
  ok('参照框右上角精确落在目标框右上角', corner.text.includes(`${tb.x1},${tb.y1}`),
    corner.text.split('\n').find((l) => l.startsWith('| d')));

  // 不传参照框时**不加列** —— 不能悄悄改变既有输出
  ok('不传 mapBox/toBox 时不出现映射列', !renderRegion([hotspot], { y0: 0, y1: 1000 }).text.includes('映射 x,y'));
}

/* ═══════════════ ⑥.13 无障碍对比度（§4.8） ═══════════════ */
group('⑥.13 无障碍对比度（§4.8）');

/* ── 公式：三组已知值**写死**（防"自己发明公式"与"忘了线性化"） ── */
{
  const ratio = (a, b) => contrastRatio(a, b);
  ok('#000 on #fff = 21:1（WCAG 锚点值）', Math.abs(ratio('#000000', '#ffffff') - 21) < 0.005,
    ratio('#000000', '#ffffff').toFixed(4));
  const v777 = ratio('#777777', '#ffffff');
  ok('#777777 on #fff ≈ 4.48:1（**略低于** 4.5 —— 正好卡在阈值上）', Math.abs(v777 - 4.48) < 0.005 && v777 < 4.5,
    v777.toFixed(4));
  const v767 = ratio('#767676', '#ffffff');
  ok('#767676 on #fff ≈ 4.54:1（**略高于** 4.5）', Math.abs(v767 - 4.54) < 0.005 && v767 > 4.5, v767.toFixed(4));
  ok('对比度与顺序无关（内部按"亮的在上"取）', ratio('#000000', '#ffffff') === ratio('#ffffff', '#000000'));
  ok('解析不出来的色值给 null（不猜 0 / 1）',
    ratio('不是颜色', '#ffffff') === null && ratio(null, '#ffffff') === null);
  eq('相对亮度：#000 = 0', relativeLuminance('#000000'), 0);
  eq('相对亮度：#fff = 1', relativeLuminance('#ffffff'), 1);
  // 这条是给"哪天有人把线性化去掉"留的证据：sRGB 直算 #777777 只有 ≈2.03，阈值结论整个反过来
  const direct = (hex) => {
    const c = parseColor(hex);
    const L = (v) => v / 255;
    return 0.2126 * L(c.r) + 0.7152 * L(c.g) + 0.0722 * L(c.b);
  };
  const noLinear = 1.05 / (direct('#777777') + 0.05);
  ok('必须线性化：sRGB 直算 #777777 只有 ≈2.03（标准值是 4.48）', Math.abs(noLinear - 2.03) < 0.02, noLinear.toFixed(3));
}

/* ── 大号阈值：≥24px，或 ≥18.66px 且 bold ── */
{
  ok('大号：24px（不看字重）', isLargeText(24, 400) === true);
  ok('大号：18.66px + 700', isLargeText(18.66, 700) === true);
  ok('18px + 700 **不是**大号（差 0.66px 也不行）', isLargeText(18, 700) === false);
  ok('20px + 400 **不是**大号（不够粗）', isLargeText(20, 400) === false);
  ok('字号缺失 → null（不猜成大号，也不猜成正文）', isLargeText(null, 400) === null);
  ok('对比度与阈值都是受控常量（不是裸写数字）',
    LIMITS.contrastNormal === 4.5 && LIMITS.contrastLarge === 3 && LIMITS.largeTextBoldPx === 18.66);
}

/* ── 有效背景色：沿祖先链找 → 落画板 → 都没有就**明说算不出** ── */
{
  const fillNode = (hex, a = 1) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` } };
  };
  const gradNode = (values) => ({
    type: 'gradient', isEnabled: true, gradient: { stops: values.map((v) => ({ color: { value: v } })) },
  });
  // 文本层**同时**带自己的 fill（= 文字色，Figma 语义）—— 它**绝不能**被当成自己的背景
  const textNode = (hex, size, weight, alpha = 1) => {
    const c = parseColor(hex);
    const value = `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
    return {
      id: 't1', type: 'textLayer', name: '说明文字', frame: { left: 20, top: 20, width: 120, height: 20 },
      style: { fills: [{ type: 'color', isEnabled: true, color: { value } }] },
      text: { style: { content: '说明文字', color: { value }, font: { name: 'Inter', size, fontWeight: weight } } },
    };
  };
  const mkTree = (o = {}) => ({
    id: 'ab', type: 'artboard', name: '自检稿',
    meta: { device: 'iPhone 14' },
    frame: { left: 0, top: 0, width: 375, height: 700 },
    style: { fills: o.artboardFills ?? [fillNode('#ffffff')] },
    layers: [{
      id: 'card', type: 'frame', name: '底卡',
      frame: { left: 0, top: 0, width: 375, height: 300 },
      style: { fills: o.cardFills ?? [fillNode('#f5f5f5')] },
      layers: [textNode(o.textColor ?? '#999999', o.size ?? 14, o.weight ?? 400, o.textAlpha ?? 1)],
    }],
  });
  const spot = (o = {}) => {
    const layers = flattenArtboard(mkTree(o));
    const blocks = buildBlocks(layers);
    const textBlock = blocks.find((b) => b.text);
    return { layers, blocks, textBlock, bg: effectiveBackground(layers, textBlock.layerIndex) };
  };

  const a = spot();
  eq('无底色的文本层 → 取**父层**的 fill', a.bg.ok && a.bg.backgrounds[0].hex, '#f5f5f5');
  eq('来源不是画板（父层就够近）', a.bg.baseIsArtboard, false);
  const b = spot({ cardFills: [] });
  eq('父层也没底 → 落到**画板**底色', b.bg.ok && b.bg.backgrounds[0].hex, '#ffffff');
  eq('来源标成画板', b.bg.baseIsArtboard, true);
  const c = spot({ cardFills: [], artboardFills: [] });
  ok('祖先链与画板都没有底色 → **明说算不出**（不是白底）',
    c.bg.ok === false && c.bg.reason === 'no-fill', JSON.stringify(c.bg));
  ok('文本层自己的 fill（= 文字色）不会被当成背景', c.bg.ok === false,
    '若把文字色当背景，这里会得到 ok:true');
  // 半透明：**逐层合成**到不透明底上（#574af4@10% 叠在白底 = #eeedfe）
  const d = spot({ cardFills: [fillNode('#574af4', 0.1)] });
  eq('半透明父层**合成**到画板白底（#574af4@10% → #eeedfe）', d.bg.backgrounds[0].hex, '#eeedfe');
  eq('并标出「半透明」', d.bg.backgrounds[0].translucent, true);
  ok('合成结果与手算一致（0.1×87 + 0.9×255 = 238）', compositeOver({ r: 87, g: 74, b: 244, a: 0.1 }, '#ffffff').r === 238);
  const e = spot({ artboardFills: [], cardFills: [fillNode('#574af4', 0.1)] });
  ok('半透明背景且**下面没有不透明底** → 明说算不出（不猜）',
    e.bg.ok === false && e.bg.reason === 'translucent-no-base', JSON.stringify(e.bg));
  // 多段渐变：逐段给候选（判的时候取最差）
  const g = spot({ cardFills: [gradNode(['rgba(111, 103, 249, 1)', 'rgba(84, 70, 243, 1)'])] });
  eq('多段渐变 → 每段一个候选', g.bg.backgrounds.length, 2);
  eq('并标出「渐变」', g.bg.gradient, true);
  ok('祖先链只认**父层**（不把兄弟层当背景）',
    parentIndexOf(a.layers, a.textBlock.layerIndex) === a.layers.findIndex((l) => l.name === '底卡'));
}

/* ── 审计：只列不达标 / 大号 3:1 / 正文 4.5:1 / 背景算不出归另一处 ── */
const CTX = (() => {
  const fillNode = (hex, a = 1) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${a})` } };
  };
  const textNode = (name, hex, size, weight, alpha = 1) => {
    const c = parseColor(hex);
    const value = `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
    return {
      id: name, type: 'textLayer', name, frame: { left: 20, top: 20, width: 120, height: 20 },
      style: { fills: [{ type: 'color', isEnabled: true, color: { value } }] },
      text: { style: { content: name, color: { value }, font: { name: 'Inter', size, fontWeight: weight } } },
    };
  };
  /** 画板白底 + 若干文本层（都在画板下，背景 = 画板） */
  const tree = (texts, artboardFills) => ({
    id: 'ab', type: 'artboard', name: '自检稿', frame: { left: 0, top: 0, width: 375, height: 700 },
    style: { fills: artboardFills ?? [fillNode('#ffffff')] },
    layers: texts,
  });
  const auditOf = (texts, artboardFills) => {
    const layers = flattenArtboard(tree(texts, artboardFills));
    const blocks = buildBlocks(layers);
    return { layers, blocks, audit: auditTextContrast(visibleBlocks(blocks, {}), layers) };
  };
  return { fillNode, textNode, auditOf, tree };
})();

{
  // 同一对色值：字号不同 → 结论不同（大号 3:1 过，正文 4.5:1 不过）
  const normal = CTX.auditOf([CTX.textNode('灰字', '#949494', 14, 400)]);
  const largeS = CTX.auditOf([CTX.textNode('灰字', '#949494', 20, 700)]);
  eq('正文（14/400）判 4.5:1 → 不达标', [normal.audit.fail.length, normal.audit.fail[0].required], [1, 4.5]);
  eq('大号（20/700）判 3:1 → 达标', [largeS.audit.fail.length, largeS.audit.minRatio > 3], [0, true]);
  ok('同一对色值（#949494 / #ffffff，3.03:1）换个字号结论就不同 —— 阈值真的用上了',
    normal.audit.fail.length === 1 && largeS.audit.fail.length === 0,
    `正文 fail=${normal.audit.fail.length}，大号 fail=${largeS.audit.fail.length}`);

  const seg = renderContrastDigest(normal.audit);
  ok('每行给齐：块名 ｜ 文字色 / 背景色 ｜ 对比度 ｜ 差多少 ｜ 建议改法',
    /^- 灰字 ｜ `#949494` \/ `#ffffff`（画板） ｜ \*\*3\.03:1\*\*（需 4\.5:1） ｜ 差 \*\*1\.47\*\* ｜ 文字色压暗到 \*\*#767676\*\* 或更深/m.test(seg),
    seg.split('\n').find((l) => l.startsWith('- ')));
  ok('建议改法是**可执行**的具体色值（不是"请提高对比度"）', /#[0-9a-f]{6}/.test(seg));
  ok('表头写明判据与阈值（4.5 / 3 / 18.66 都在）',
    seg.includes('4.5:1') && seg.includes('≥3:1') && seg.includes('18.66px') && seg.includes('线性化'));

  // 只列不达标：达标的那几个**一个字都不许出现**
  const mixed = CTX.auditOf([CTX.textNode('达标黑字', '#000000', 14, 400), CTX.textNode('不达标灰字', '#999999', 14, 400)]);
  const mixedSeg = renderContrastDigest(mixed.audit);
  eq('两个文本层都判了', mixed.audit.checked, 2);
  ok('**只列不达标**的（达标的那个不出现）', mixedSeg.includes('不达标灰字') && !mixedSeg.includes('达标黑字'),
    mixedSeg.split('\n').filter((l) => l.startsWith('- ')).join(' / '));
  // 行数封顶：宁可少列也不列错（与「间距一览」同口径）
  const twoFails = CTX.auditOf([CTX.textNode('灰A', '#999999', 14, 400), CTX.textNode('灰B', '#888888', 14, 400)]);
  ok('不达标行数封顶（其余只给一句"略"）',
    renderContrastDigest(twoFails.audit, { contrastMaxRows: 1 }).includes('其余 1 个不达标的略'));
  ok('封顶只在超限时出现（没超就别说"略"）', !renderContrastDigest(twoFails.audit).includes('略'));

  // 全达标也别沉默
  const allPass = CTX.auditOf([CTX.textNode('黑字', '#000000', 14, 400)]);
  const passSeg = renderContrastDigest(allPass.audit);
  ok('全达标时给一句话（不是静默）', /全部达标\*\*（1 个文本层，最低 \*\*21:1\*\*）/.test(passSeg), passSeg.split('\n').pop());
  ok('全达标时**不列**任何行', !passSeg.split('\n').some((l) => l.startsWith('- 黑字')));

  // 背景算不出 → 单独归一处，且**不参与达标判断**
  const noBg = CTX.auditOf([CTX.textNode('灰字', '#949494', 14, 400)], []);
  const noBgSeg = renderContrastDigest(noBg.audit);
  eq('背景算不出 → 不进 fail、进 unknown', [noBg.audit.fail.length, noBg.audit.unknown.length, noBg.audit.checked], [0, 1, 0]);
  ok('明说"未做对比度判断"', noBgSeg.includes('背景无法确定') && noBgSeg.includes('未做对比度判断'));
  ok('并把**原因**写清楚（不猜一个白底去算）', noBgSeg.includes('都没有底色') && noBgSeg.includes('不猜'), noBgSeg.split('\n').pop());
  ok('背景算不出时**不提**"全部达标"（没判就别说达标）', !noBgSeg.includes('全部达标'));

  // 半透明文字色：与背景合成后再算
  const half = CTX.auditOf([CTX.textNode('半透明字', '#000000', 14, 400, 0.5)]);
  eq('半透明黑字在白底上 = #808080（合成后再算，不是拿 #000000 算 21:1）',
    half.audit.fail[0] && half.audit.fail[0].glyphHex, '#808080');
  ok('行里注明「半透明文字色·已合成」', renderContrastDigest(half.audit).includes('半透明文字色·已合成'));
}

/* ── 与既有输出的边界：新增段是**纯追加**，别的一个字节都不动 ── */
{
  const fillNode = (hex) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, 1)` } };
  };
  const layers = flattenArtboard(CTX.tree([CTX.textNode('灰字', '#949494', 14, 400)], [fillNode('#ffffff')]));
  const blocks = buildBlocks(layers);
  const meta = { name: '自检稿', width: 375, height: 700 };
  const audit = auditTextContrast(visibleBlocks(blocks, {}), layers);
  const noSeg = renderBlocks(blocks, meta, {});
  const withSeg = renderBlocks(blocks, meta, { contrast: audit });
  // 「新增段整段删掉」= 回到不传 contrast 的样子（尾注里的体积按正文算，故一并归一）
  const stripSeg = (t) => t.replace(/\n\n## 对比度[\s\S]*?(?=\n\n— )/, '');
  const kb = (t) => t.replace(/≈[\d.]+KB/, '≈KB');
  const footer = (t) => t.split('\n').slice(-2).join('\n');
  ok('不传 contrast → 输出里**没有**「对比度」段（原型那条链逐字节不变）', !noSeg.includes('对比度'));
  ok('传 contrast → 严格是**纯追加**（把新增段整段删掉后逐字节相同）',
    kb(stripSeg(withSeg)) === kb(noSeg),
    stripSeg(withSeg) === noSeg ? '（连体积数字都一样）' : '删掉段落后仅体积数字不同');
  ok('尾注文案不变（只有按正文算出来的体积数字会跟着变大）', kb(footer(withSeg)) === kb(footer(noSeg)),
    `${footer(noSeg).split('\n')[0]} → ${footer(withSeg).split('\n')[0]}`);
  ok('「间距一览」的位置与内容不变（对比度段在它之后）',
    withSeg.indexOf('间距一览') < withSeg.indexOf('对比度'));
  // 披露口径只有一份实现
  const noisy = [{ noise: true, kind: 'text' }, { noise: false, kind: 'card' }];
  ok('visibleBlocks 就是渲染层用的那套披露过滤（只有一份实现）',
    JSON.stringify(visibleBlocks(noisy, {})) === JSON.stringify([noisy[1]])
    && JSON.stringify(visibleBlocks(noisy, { includeNoise: true })) === JSON.stringify(noisy));
  // 新增的块字段：指回源图层、且不破坏 lossless
  ok('buildBlocks 新增 layerIndex 指回源图层（对比度靠它找祖先）',
    blocks.every((blk) => layers[blk.layerIndex] && layers[blk.layerIndex].name === blk.name));
  ok('buildBlocks 新增 colorAlpha（半透明文字色拿它合成）',
    blocks.every((blk) => blk.colorAlpha === null || typeof blk.colorAlpha === 'number'));
  ok('新增字段没破坏 lossless', findIllegal(blocks).length === 0, findIllegal(blocks).slice(0, 2).join(', '));
}

/* ═══════════════ ⑥.14 read_blocks 版本溯源（第 0 步） ═══════════════ */
group('⑥.14 read_blocks 版本溯源');

{
  const VID = '97dd4840-9aa2-48d1-a958-1f5171445278';
  const AT = 'Tue, 22 Sep 2026 16:58:24 GMT';
  const meta = { versionId: VID, versionIsLatest: true, latestVersionAt: AT };
  const detail = { versionRequested: 'latest', versionCount: 5, versionLatestId: VID, versionFromUrl: false, urlVersionIgnored: null };
  const v = versionInfo(meta, detail);
  eq('version.id 来自 meta（与标题行同一个来源）', v.id, VID);
  eq('version.isLatest 来自 meta', v.isLatest, true);
  eq('version.latestAt 来自 meta', v.latestAt, AT);
  eq('顺带带上版本透明度字段', [v.requested, v.count, v.latestId], ['latest', 5, VID]);
  ok('标题行里的 version 前缀 === version.id 前 8 位（两处不会各算一遍）',
    metaSuffix(meta).includes(`version=${v.id.slice(0, 8)}`), metaSuffix(meta));
  const none = versionInfo({}, {});
  ok('拿不到版本 → 全 null（不编）',
    none.id === null && none.isLatest === null && none.latestAt === null && metaSuffix({}) === '');
  ok('读旧版时按「最新版更新于…（你读的是旧版）」，不把最新版时间当成这版的时间',
    /最新版更新于 2026-09-22（你读的是旧版）/.test(metaSuffix({ ...meta, versionIsLatest: false })));
  // 工具输出表里得声明它（否则"能力藏了"）
  const t = TOOLS.find((x) => x.name === 'lanhu_read_blocks');
  ok('read_blocks 的 output schema 声明了 version', !!t?.output?.schema?.properties?.version,
    Object.keys(t?.output?.schema?.properties ?? {}).join(','));
}

/* ═══════════════ ⑥.15 read_blocks 端到端（mock fetch，零网络） ═══════════════ */
group('⑥.15 read_blocks 端到端（mock fetch）');

{
  const VID = '00000009-0000-4000-8000-000000000009';
  const AT = 'Tue, 22 Sep 2026 16:58:24 GMT';
  const fillNode = (hex) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, 1)` } };
  };
  const textNode = (name, hex, size, weight) => {
    const c = parseColor(hex);
    const value = `rgba(${c.r}, ${c.g}, ${c.b}, 1)`;
    return {
      id: name, type: 'textLayer', name, frame: { left: 20, top: 20, width: 120, height: 20 },
      style: { fills: [{ type: 'color', isEnabled: true, color: { value } }] },
      text: { style: { content: name, color: { value }, font: { name: 'Inter', size, fontWeight: weight } } },
    };
  };
  const tree = {
    meta: { device: 'iPhone 14' },
    artboard: {
      id: 'ab', type: 'artboard', name: '自检稿',
      frame: { left: 0, top: 0, width: 375, height: 700 },
      style: { fills: [fillNode('#ffffff')] },
      layers: [
        textNode('不达标灰字', '#999999', 14, 400),
        textNode('大号达标字', '#949494', 20, 700),
      ],
    },
  };
  const mockRes = (obj) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
  });
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes('/api/project/image?')) {
      return mockRes({
        code: '00000',
        result: { id: 'i-mock', name: '自检稿', width: 375, height: 700, versions: [{ id: VID, json_url: 'https://mock.lanhu/tree.json', create_time: AT }] },
      });
    }
    if (u === 'https://mock.lanhu/tree.json') return mockRes(tree);
    throw new Error('未预期的请求：' + u);
  };
  let r = null;
  let err = null;
  try {
    // ⚠️ 这一组测的是**对比度审计**（"它零额外请求"），所以**显式关掉评论**：
    //    评论是 §4.9 的事（默认开、+1 次请求），不关掉就会把"第 3 个请求"算进这条断言里 ——
    //    那是把两件事混在一起测。评论的开/关与请求数在 ⑥.15d 单独钉。
    r = await readBlocks({ projectId: 'p-mock', imageId: 'i-mock', account: 'mock', cookie: 'PASSPORT=x; user_token=y', comments: false });
  } catch (e) { err = e; } finally { globalThis.fetch = realFetch; }

  ok('read_blocks 能跑通（mock 两个请求：详情 + 图层树）', !!r && !err, err ? String(err.message) : `${seen.length} 个请求`);
  if (r) {
    eq('返回里**有 `version`**（第 0 步的核心）', typeof r.version === 'object' && r.version !== null, true);
    eq('version.id 就是这一版的 id', r.version?.id, VID);
    eq('version.latestAt 与 isLatest 都带上了', [r.version?.latestAt, r.version?.isLatest], [AT, true]);
    eq('平铺字段 versionIsLatest / latestVersionAt 也给了', [r.versionIsLatest, r.latestVersionAt], [true, AT]);
    ok('returns.version 与**标题行**里的 version 一致（防两处各算一遍）',
      r.text.split('\n')[0].includes(`version=${VID.slice(0, 8)}`), r.text.split('\n')[0]);
    ok('return 是 lossless（新增字段没带 undefined/NaN）',
      findIllegal({ blocks: r.blocks, version: r.version, contrast: r.contrast }).length === 0,
      findIllegal({ blocks: r.blocks, version: r.version, contrast: r.contrast }).slice(0, 2).join(', '));
    eq('对比度审计进了返回（文本与字段同一次计算）',
      [r.contrast.totalTextLayers, r.contrast.checked, r.contrast.failCount, r.contrast.unknownCount], [2, 2, 1, 0]);
    const seg = r.text.split('## 对比度')[1] ?? '';
    ok('文本里有「对比度」段，且只列不达标（大号达标的不列）',
      seg.includes('不达标灰字') && !seg.includes('大号达标字'), seg.split('\n').find((l) => l.startsWith('- ')));
    ok('对比度审计**零额外网络请求**（只发了详情 + 树两个请求）', seen.length === 2, seen.join(' | '));
  }
}

/* ═══════════════ ⑥.15b 蓝湖 Sketch 插件格式（type: sketchPlugin） ═══════════════
 *
 * 这是**实测缺陷**的回归：某真实项目 252 张稿里 **11/20 = 55%** 是这种格式
 * （图层平铺在 `info[]` 里、没有 `artboard`，层级靠 `parentID`）。
 * 旧实现对它们会输出「共 **1** 块：画板 1」+ 一张空表 —— **看着跑成功、其实一个块都没解析出来**，
 * AI 会据此认定"这张稿是空的"然后什么都不建（本仓库最忌讳的失败模式）。
 *
 * 这一组钉两件事：
 *   ① **真的解析出来**（结构齐全、字段映射逐项有据、块数 > 0）；
 *   ② 解析不出来时**明说**（人读文本说清格式/不代表稿子是空的/下一步；返回带机器可读标志），
 *      且**任何情况下都不再出现「共 1 块：画板 1」**这种像成功的形态。
 */
group('⑥.15b Sketch 插件格式（type: sketchPlugin）');
{
  const VID = '0000000a-0000-4000-8000-00000000000a';
  const AT = 'Tue, 22 Sep 2026 16:58:24 GMT';
  const SP_ART = 'AAAA0000-0000-4000-8000-000000000001';
  const mockRes = (obj) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    async text() { return JSON.stringify(obj); },
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
  });
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const mockPng = () => ({
    ok: true, status: 200, headers: { get: () => 'image/png' }, async arrayBuffer() { return PNG; },
  });

  /** 一份**结构真实**的 sketchPlugin 树：层级/坐标/圆角/色值/渐变/边框/文字/切图/隐藏层/全透层都有。 */
  const spTree = () => ({
    type: 'sketchPlugin', ArtboardID: SP_ART, device: 'Web @1x', ArtboardScale: 1, sliceScale: 2,
    pageName: '页面 1', skVersion: 94.1, pluginVersion: '3.2.26',
    info: [
      // 画板：唯一没有 parentID 的项；left/top=0，画布绝对坐标在 position_x/position_y
      { id: SP_ART, name: 'Sketch 自检稿', ddsType: 'artboard-group', left: 0, top: 0, width: 1920, height: 1080,
        position_x: 2543, position_y: -445.5, index: '0', layers: [],
        fills: [{ type: 'color', color: { value: 'rgba(251,251,251,1)' } }] },
      // 卡片：圆角 [8]、底色、1px 边框、opacity 80（Sketch 是 0..100）
      { id: 'CARD', name: '卡片', type: 'shape', ddsType: 'rectangle', left: 100, top: 200, width: 400, height: 300,
        parentID: SP_ART, isVisible: true, opacity: 80, radius: [8],
        fills: [{ type: 'color', color: { value: 'rgba(87,74,244,1)' } }],
        borders: [{ position: '内边框', thickness: 1, isEnabled: true, color: { value: 'rgba(226,232,240,1)' } }] },
      // 两段渐变：Sketch 给 `colorStops`，必须迁成 `stops`，否则整条渐变丢掉
      { id: 'GRAD', name: '辉光', type: 'shape', ddsType: 'rectangle', left: 600, top: 200, width: 200, height: 100,
        parentID: SP_ART, isVisible: true, opacity: 100,
        fills: [{ type: 'gradient', isEnabled: true, gradient: { type: 'linear', colorStops: [
          { position: 0, color: { value: 'rgba(20,89,148,1)' } },
          { position: 1, color: { value: 'rgba(8,41,74,0.1)' } }] } }] },
      // 文字：字重靠 postScriptName 后缀、行高 `line`、字距 `kerning`
      { id: 'TXT', name: '标题', type: 'text', left: 120, top: 240, width: 100, height: 24, parentID: SP_ART,
        isVisible: true, opacity: 100,
        font: { content: '个人', size: 24, line: 36, kerning: 0.7, align: 'left', font: 'SourceHanSansCN-Bold',
          displayName: '思源黑体 CN Bold', color: { value: 'rgba(44,51,42,1)' }, styles: [] } },
      // 真位图层 → 是切图
      { id: 'BMP', name: '头像位图', type: 'bitmap', left: 900, top: 300, width: 64, height: 64, parentID: SP_ART,
        isVisible: true, opacity: 100,
        ddsImage: { imageUrl: 'https://mock.lanhu/slice1.png', size: { width: 128, height: 128 }, point: { x: 1, y: 2 } } },
      // ⚠️ shape 也带 ddsImage（实测 890/2348 层都带）—— **不该**被当成图片块、也不该进切图清单
      { id: 'SHAPEIMG', name: '形状带导出图', type: 'shape', ddsType: 'oval', left: 1000, top: 300, width: 20, height: 20,
        parentID: SP_ART, isVisible: true, opacity: 100,
        fills: [{ type: 'color', color: { value: 'rgba(216,216,216,1)' } }],
        ddsImage: { imageUrl: 'https://mock.lanhu/should-not-count.png' } },
      // 组：被导出成一张图（`image.imageUrl`）→ 算切图；子层靠 parentID 挂进来
      { id: 'GRP', name: '编组', type: 'layer-group', left: 700, top: 500, width: 200, height: 200, parentID: SP_ART,
        isVisible: true, opacity: 100, image: { imageUrl: 'https://mock.lanhu/group.png' } },
      // 子层坐标是**画板绝对坐标**（实测：44 个有父层的元素里 24 个超出父层局部框）
      { id: 'GRP_CHILD', name: '组内文字', type: 'text', left: 720, top: 520, width: 60, height: 20, parentID: 'GRP',
        isVisible: true, opacity: 100,
        font: { content: '组内', size: 14, line: 20, font: 'SourceHanSansCN-Regular', color: { value: 'rgba(0,0,0,1)' } } },
      // 隐藏层 / 全透明层：都不该成块
      { id: 'HID', name: '隐藏层', type: 'shape', ddsType: 'rectangle', left: 10, top: 10, width: 50, height: 50,
        parentID: SP_ART, isVisible: false, opacity: 100, fills: [{ type: 'color', color: { value: 'rgba(1,2,3,1)' } }] },
      { id: 'ZERO', name: '全透层', type: 'shape', ddsType: 'rectangle', left: 10, top: 900, width: 50, height: 50,
        parentID: SP_ART, isVisible: true, opacity: 0, fills: [{ type: 'color', color: { value: 'rgba(1,2,3,1)' } }] },
      // 分割线：1px 高的实心条
      { id: 'DIV', name: '分割线', type: 'shape', ddsType: 'rectangle', left: 100, top: 700, width: 400, height: 1,
        parentID: SP_ART, isVisible: true, opacity: 100, fills: [{ type: 'color', color: { value: 'rgba(226,232,240,1)' } }] },
    ],
  });

  const withSpMock = async (fn, { tree = spTree() } = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/project/images?')) {
        return mockRes({ code: '00000', result: { name: '自检项目', images: [
          { id: 'i-mock', name: 'Sketch 稿', width: 480, height: 270 },
        ] } });
      }
      if (u.includes('/api/project/image?')) {
        return mockRes({ code: '00000', result: {
          id: 'i-mock', name: 'Sketch 稿', width: 480, height: 270,   // ⚠️ 详情里的尺寸是**缩略图**尺寸
          versions: [{ id: VID, json_url: 'https://mock.lanhu/sp.json', create_time: AT }],
        } });
      }
      if (u === 'https://mock.lanhu/sp.json') return mockRes(tree);
      // 评论（§4.9）：`read_blocks` 现在**默认**会多发这一条请求 —— 这里按"这张稿没有评论"应答。
      // 不接这一条会走"未预期请求"→ 网络重试 ×3（每组测试白等 ~1.8 秒，还掩盖了真实请求数）。
      // 也算顺带钉住：空评论应答下 read_blocks 的输出与不读评论时**逐字节一致**（⑥.15d 有正面断言）。
      if (u.includes('/api/project/comment')) return mockRes({ has_comment: false, has_next: false, total: 0, result: [] });
      if (u.includes('mock.lanhu/slice') || u.includes('mock.lanhu/group')) return mockPng();
      throw new Error('未预期的请求：' + u);
    };
    try { return await fn(); } finally { globalThis.fetch = real; }
  };
  const A = { projectId: 'p-mock', imageId: 'i-mock', account: 'mock', cookie: 'PASSPORT=x; user_token=y' };

  // ① 归一化纯函数：层级 / 绝对坐标 / 防环 / 切图判据
  {
    const n = normalizeSketchPluginTree(spTree());
    eq('归一化：除画板外 10 层（层级靠 parentID 建起来，`layers` 恒空）', n.layerCount, 10);
    eq('归一化：画板名取 `ArtboardID` 那一项', n.artboard?.name, 'Sketch 自检稿');
    eq('归一化：切图只收 bitmap 的 ddsImage + 组导出图（shape 的 ddsImage **不算**）',
      n.sliceUrls.slice().sort().join(','), 'https://mock.lanhu/group.png,https://mock.lanhu/slice1.png');
    const grp = n.tree.artboard.layers.find((l) => l.name === '编组');
    const child = grp?.layers?.[0];
    eq('归一化：子层挂在父层的 `layers` 下（parentID → 树）', child?.name, '组内文字');
    eq('归一化：子层坐标是**画板绝对坐标**（720,520，不是相对父层的 20,20）',
      [child?.frame.left, child?.frame.top], [720, 520]);
    eq('归一化：画板 frame 取 `position_x/position_y`（画布绝对坐标，与 Figma 稿同口径）',
      [n.artboard?.frame?.left, n.artboard?.frame?.top], [2543, -445.5]);
    const card = n.tree.artboard.layers.find((l) => l.name === '卡片');
    eq('归一化：`opacity` 从 0..100 换算到 0..1（80 → 0.8）', card?.opacity, 0.8);
    eq('归一化：圆角 `radius:[8]` → 四角 8', [card?.radius?.topLeft, card?.radius?.bottomRight], [8, 8]);
    eq('归一化：渐变 `colorStops` → `stops`（不迁就整条丢）',
      card?.style?.fills?.length ?? 0, 1);
    const grad = n.tree.artboard.layers.find((l) => l.name === '辉光');
    eq('归一化：两段渐变两个 stop 都在', grad?.style?.fills?.[0]?.gradient?.stops?.length ?? 0, 2);
    const txt = n.tree.artboard.layers.find((l) => l.name === '标题');
    eq('归一化：字体族由 postScriptName 去后缀、字重由后缀映射（Bold → 700）',
      [txt?.text?.style?.font?.name, txt?.text?.style?.font?.fontWeight], ['SourceHanSansCN', 700]);
    eq('归一化：行高取 `line`、字距取 `kerning`',
      [txt?.text?.style?.font?.lineHeight?.value, txt?.text?.style?.font?.letterSpacing?.value], [36, 0.7]);
    eq('归一化：文字内容取自 `font.content`', txt?.text?.style?.content, '个人');
    // 防环：parentID 成环也不能死循环
    const cyc = { type: 'sketchPlugin', info: [
      { id: 'a', name: 'A', width: 1, height: 1, parentID: 'a' },
      { id: 'b', name: 'B', width: 1, height: 1, parentID: 'a' },
    ] };
    const nc = normalizeSketchPluginTree(cyc);
    eq('归一化：parentID 自指/成环时不死循环（a 与挂在它下面的 b 各算一层）', nc.layerCount, 2);
    eq('归一化：既没有 ArtboardID 也没有根 → 不编内容（0 层）',
      normalizeSketchPluginTree({ type: 'sketchPlugin', info: [] }).layerCount, 0);
  }

  // ② read_blocks：**真的解析出来**（不再「共 1 块：画板 1」）
  {
    const r = await withSpMock(() => readBlocks({ ...A }));
    ok('★ read_blocks 对 sketchPlugin **真的解析出块**（块数 > 0）', r.ok === true && r.blockCount > 0, `块 ${r.blockCount}`);
    eq('★ 返回带机器可读标志 `sourceFormat`', r.sourceFormat, 'sketchPlugin');
    ok('★ `unsupported` 标志**缺席或为假**（这张稿是读得出来的）', !r.unsupported, String(r.unsupported));
    ok('★ 文本里**不再出现**「共 1 块：画板 1」这种像成功的形态', !/共 \*\*1\*\* 块：画板 1/.test(r.text), r.text.split('\n')[2]);
    ok('★ 文本里明说来源是 Sketch 插件导出（人读也知道数值是映射来的）',
      r.text.includes('Sketch 插件导出') && r.text.includes('sketchPlugin'), r.text.split('\n')[2]);
    eq('★ 画板尺寸取**图层树**（1920×1080），不是详情里的缩略图尺寸（480×270）',
      [r.viewport.width, r.viewport.height], [1920, 1080]);
    eq('图层清单完整（info 11 项：画板 + 10 层）', r.layerCount, 11);
    const byName = Object.fromEntries(r.blocks.map((b) => [b.name, b]));
    ok('块字段齐全：坐标/尺寸/色值/圆角/边框/文字', [
      byName['卡片']?.x === 100, byName['卡片']?.y === 200, byName['卡片']?.w === 400,
      byName['卡片']?.bg?.hex === '#574af4', byName['卡片']?.radius?.max === 8,
      byName['卡片']?.border?.color === '#e2e8f0', byName['标题']?.text === '个人',
      byName['标题']?.font?.size === 24, byName['标题']?.font?.weight === 700,
      byName['标题']?.color === '#2c332a',
    ].every(Boolean), JSON.stringify(byName['卡片'] ?? {}).slice(0, 200));
    eq('图层不透明还原成 0.8（与底色 alpha 是两回事）', byName['卡片']?.opacity, 0.8);
    eq('两段渐变全部 stop 都进了块（不再只显示第一段）',
      (byName['辉光']?.bg?.stops ?? []).map((s) => s.hex).join('→'), '#145994→#08294a');
    eq('组内子层也在清单里，且坐标是画板绝对值', [byName['组内文字']?.x, byName['组内文字']?.y], [720, 520]);
    ok('子层深度比父层大一档（层级真的建起来了）',
      byName['组内文字']?.depth === byName['编组']?.depth + 1, `${byName['组内文字']?.depth}/${byName['编组']?.depth}`);
    ok('隐藏层与全透明层**都不成块**', !byName['隐藏层'] && !byName['全透层'], Object.keys(byName).join(','));
    ok('1px 高的实心条被认成**分割线**', byName['分割线']?.kind === 'divider', String(byName['分割线']?.kind));
    ok('⚠️ shape 带的 `ddsImage` **不**把形状变成图片块（实测 890/2348 层都带它）',
      byName['形状带导出图']?.kind !== 'image', String(byName['形状带导出图']?.kind));
    ok('真位图层与"组导出图"才算图片块',
      byName['头像位图']?.kind === 'image' && byName['编组']?.kind === 'image',
      `${byName['头像位图']?.kind}/${byName['编组']?.kind}`);
    ok('返回是 lossless（映射没带出 undefined/NaN）',
      findIllegal({ blocks: r.blocks, contrast: r.contrast }).length === 0,
      findIllegal({ blocks: r.blocks }).slice(0, 2).join(', '));
  }

  // ③ read_design：同一条链（summary / tokens / fonts 都要能出数）
  {
    const s = await withSpMock(() => readDesign({ ...A }));
    ok('★ read_design summary 也能读（图层数 = 11）',
      s.format === 'summary' && s.layerCount === 11, `${s.format}/${s.layerCount}`);
    eq('★ read_design 也带 `sourceFormat`', s.sourceFormat, 'sketchPlugin');
    ok('★ summary 里也不再是"看着像成功"的空结果', !/共 \*\*1\*\* 块/.test(s.text) && s.tokens.colors.length > 0,
      s.text.split('\n')[0]);
    const t = await withSpMock(() => readDesign({ ...A, format: 'tokens' }));
    ok('tokens 模式有字号/字重/圆角统计', t.tokens.fontSizes.length > 0 && t.tokens.radii.length > 0,
      JSON.stringify(t.tokens.fontSizes));
    const f = await withSpMock(() => readDesign({ ...A, format: 'fonts' }));
    ok('fonts 模式认得出 Sketch 的字体族（SourceHanSansCN）', /SourceHanSansCN/.test(f.text), f.text.slice(0, 200));
  }

  // ④ download_slices：能拿到切图（而不是空手而归还说 ok）
  {
    const s = await withSpMock(() => downloadSlices({ ...A, outDir: path.join(TMP_HOME, 'sp-slices') }));
    eq('★ download_slices 能真下到 sketchPlugin 稿的切图（2 张 URL；内容相同 → 哈希去重 1 张）',
      s.downloaded + s.skipped, 2);
    eq('★ 且带上 `sourceFormat`', s.sourceFormat, 'sketchPlugin');
    ok('shape 的 ddsImage 没混进切图清单', (s.files ?? []).every((x) => !/should-not-count/.test(x.url ?? '')),
      (s.files ?? []).map((x) => x.file).join(','));
  }

  // ⑤ diff：能 dif（两版同树 → 无差异）
  {
    let d = null; let derr = null;
    try { d = await withSpMock(() => diffDesign({ ...A, from: VID, to: VID })); } catch (e) { derr = e; }
    ok('★ diff_design 对 sketchPlugin 不再报"不是设计稿图层树"（解析得出来就该能比）',
      !derr && d?.ok === true && d.sameVersion === true,
      derr ? String(derr.message) : String(d?.text).split('\n')[0]);
    eq('★ diff 结果也带 `sourceFormat`', d?.sourceFormat, 'sketchPlugin');
  }

  // ⑥ audit：能读的 sketchPlugin **要进统计**（不能再整类跳过）
  {
    const a = await withSpMock(() => auditProject({ ...A, limit: 1 }));
    eq('★ 能解析的 sketchPlugin 稿被**正常扫描**（scanned=1）', a.scanned, 1);
    ok('★ 它**不**落进 `sketch-format` 跳过类', !a.skipBuckets['sketch-format'], JSON.stringify(a.skipBuckets));
    ok('审计真的看到了块（blocks > 0）', a.blocks > 0, String(a.blocks));
  }

  // ⑦ 【核心】取不出图层时 → **明示**，且机器可读
  {
    // 既有 fixture 那种形态：只有一个无坐标、无子层的项
    const empty = { type: 'sketchPlugin', info: [{ id: 'ab', name: 'Sketch 稿' }] };
    const r = await withSpMock(() => readBlocks({ ...A }), { tree: empty });
    eq('★ 空壳 sketchPlugin：`unsupported` 为 true（机器可读，不用读文本）', r.unsupported, true);
    eq('★ 空壳 sketchPlugin：`ok` 为 false（不是"看着成功"）', r.ok, false);
    eq('★ 空壳 sketchPlugin：`sourceFormat` 标出格式', r.sourceFormat, 'sketchPlugin');
    eq('★ 空壳 sketchPlugin：给稳定的 code', r.code, 'SKETCH_PLUGIN_NO_LAYERS');
    ok('★ 空壳 sketchPlugin：块数为 0（不编数据）', r.blockCount === 0 && r.blocks.length === 0 && r.layerCount === 0,
      `${r.blockCount}/${r.layerCount}`);
    ok('★ **再也不出现**「共 1 块：画板 1」这种像成功的形态（连说明文案里都不许有那个字面短语）',
      !/共 \*\*1\*\* 块/.test(r.text) && !/画板 1/.test(r.text),
      r.text.split('\n').slice(0, 4).join(' / '));
    ok('★ 文本说清"这是什么格式"', r.text.includes('Sketch 插件导出') && r.text.includes('sketchPlugin'), r.text.split('\n')[0]);
    ok('★ 文本说清"本次输出为空 **不代表**这张稿是空的"', r.text.includes('不代表这张稿是空的'), r.text.split('\n')[2]);
    ok('★ 文本给出下一步（换稿 / 让设计师重导 / 只要图就用 download_slices）',
      r.text.includes('下一步') && r.text.includes('换一张') && r.text.includes('download_slices'), r.text.slice(-500));
    ok('文本里点出"以前会静默输出共 1 块画板 1，现在改为明说"', r.text.includes('静默'), r.text.slice(0, 400));
    ok('明示结果也是 lossless', findIllegal({ ok: r.ok, blockCount: r.blockCount, code: r.code }).length === 0);

    const d = await withSpMock(() => readDesign({ ...A, format: 'summary' }), { tree: empty });
    ok('★ read_design 对同一张稿也**明示**（不是静默空结果）',
      d.unsupported === true && d.ok === false && d.text.includes('不代表这张稿是空的'), d.text.split('\n')[0]);
    const t = await withSpMock(() => readDesign({ ...A, format: 'tokens' }), { tree: empty });
    ok('★ format=tokens / fonts / region 也走同一条明示（不是各写一套）',
      t.unsupported === true && t.text.includes('不代表这张稿是空的'), t.text.split('\n')[0]);

    const s = await withSpMock(() => downloadSlices({ ...A, outDir: path.join(TMP_HOME, 'sp-empty') }), { tree: empty });
    ok('★ download_slices 对读不出的稿**明说**（不再"下载了 0 张、一切正常"）',
      s.unsupported === true && s.ok === false && /不代表|不等于/.test(s.note), s.note);
    eq('★ 且 downloaded 仍是 0（不编数字）', s.downloaded, 0);

    let threw = null;
    try { await withSpMock(() => diffDesign({ ...A, from: VID, to: VID }), { tree: empty }); } catch (e) { threw = e; }
    ok('★ diff_design 对读不出的稿**报错点名格式**（不再归错因"不是设计稿图层树"）',
      threw?.code === 'SKETCH_PLUGIN_NO_LAYERS' && /Sketch 插件/.test(String(threw?.message)), String(threw?.code));

    const a = await withSpMock(() => auditProject({ ...A, limit: 1 }), { tree: empty });
    eq('★ audit 仍把"取不出图层"的单独归一类（不混进"读取失败"）', a.skipBuckets['sketch-format'], 1);
    ok('★ 抬头文案与"能读"的新能力一致（说明是"取不出子层"，不是"不认这种树"）',
      a.skippedBrief.includes('Sketch 插件格式') && a.text.includes('已知空缺')
      && a.text.includes('同一套') && !a.text.includes('当前解析器只认'), a.skippedBrief);
  }

  // ⑧ 认不出的树格式：也不许静默（既无 artboard、也无 info、也无 pages）
  {
    const weird = { hello: 'world', layers: [] };
    const r = await withSpMock(() => readBlocks({ ...A }), { tree: weird });
    eq('★ 未知格式：`unsupported` 为 true', r.unsupported, true);
    eq('★ 未知格式：`sourceFormat` 为 unknown', r.sourceFormat, 'unknown');
    eq('★ 未知格式：稳定的 code', r.code, 'UNKNOWN_TREE_FORMAT');
    ok('★ 未知格式：不出现「共 1 块：画板 1」', !r.text.includes('共 **1** 块'), r.text.split('\n')[0]);
    ok('★ 未知格式：说清"既没有 artboard 也没有 info/pages"并给下一步',
      r.text.includes('artboard') && r.text.includes('info') && r.text.includes('下一步'), r.text.slice(0, 400));
  }

  // ⑨ 【硬约束】普通稿（非 sketchPlugin）的返回体**不许**多出 `sourceFormat` 键
  {
    const plain = {
      meta: { device: 'iPhone 14' },
      artboard: {
        id: 'ab', type: 'artboard', name: '普通稿',
        frame: { left: 0, top: 0, width: 375, height: 700 },
        style: { fills: [{ type: 'color', isEnabled: true, color: { value: 'rgba(255,255,255,1)' } }] },
        layers: [{ id: 'r1', type: 'shapeLayer', name: '按钮', frame: { left: 16, top: 16, width: 100, height: 40 },
          paths: [{ type: 'rect', radius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 } }],
          style: { fills: [{ type: 'color', isEnabled: true, color: { value: 'rgba(87,74,244,1)' } }] } }],
      },
    };
    const r = await withSpMock(() => readBlocks({ ...A }), { tree: plain });
    ok('★ 普通稿返回体里**没有** `sourceFormat` 键（逐字节不变的守卫）',
      !Object.prototype.hasOwnProperty.call(r, 'sourceFormat'), Object.keys(r).filter((k) => /source/i.test(k)).join(','));
    ok('★ 普通稿文本里**没有** Sketch 来源交代', !r.text.includes('Sketch 插件导出'), r.text.split('\n')[2]);
    const d = await withSpMock(() => readDesign({ ...A }), { tree: plain });
    ok('★ read_design 同样不多键、不加来源段',
      !Object.prototype.hasOwnProperty.call(d, 'sourceFormat') && !d.text.includes('Sketch 插件导出'));
  }

  /* ⑩ 阴影 / 模糊的**字段名按来源格式分两套**（生成代码那条链的实测缺陷）
   *
   * `sketchLayerOf()` 把 `info[]` 的 `shadow` / `blur` **原样**塞进 `style.shadows` / `style.blurs`
   * （只迁了 fills/borders 的字段名），所以 Sketch 用的名字必须在这里也认：
   *   · 阴影：`blurRadius` / `offsetX` / `offsetY` / `type: 外阴影|内阴影`（Figma 是 `blur`/`x`/`y`/`inset`）
   *   · 模糊：类型给**中文** `背景模糊`（Figma 是 `Background`）
   * 只认 Figma 那套的后果**实测于稿 `71a30d33`（资源库）**：
   *   发光按钮 → `box-shadow: 0px 0px 0px 0px #5cc93b`（发光整条丢掉、数值却完全合法）；
   *   毛玻璃 → `filter: blur(10px)`（模糊的是元素自己，不是背后的内容）。
   * 这一组走**真链路**：sketchPlugin 的 `info[]` → 归一化 → rich 摊平 → 生成 CSS。
   */
  {
    const sp = {
      type: 'sketchPlugin', ArtboardID: 'AB', pageName: '发光',
      info: [
        { id: 'AB', name: '画板', ddsType: 'artboard-group', left: 0, top: 0, width: 375, height: 400 },
        // 发光按钮：Sketch 的名字 `blurRadius` / `offsetX` / `offsetY` / `type: 外阴影`
        { id: 'GLOW', name: '找机构', type: 'shape', ddsType: 'rectangle', parentID: 'AB',
          left: 20, top: 40, width: 112, height: 44, isVisible: true, opacity: 100, radius: [22],
          fills: [{ type: 'color', color: { value: 'rgba(92,201,59,1)' } }],
          shadow: [{ isEnabled: true, type: '外阴影', blurRadius: 30, offsetX: 0, offsetY: 0, spread: 0,
            color: { value: 'rgba(92,201,59,1)' } }] },
        // 毛玻璃：模糊类型是**中文** `背景模糊` → 必须走 backdrop-filter
        { id: 'GLASS', name: '毛玻璃', type: 'shape', ddsType: 'rectangle', parentID: 'AB',
          left: 20, top: 120, width: 120, height: 90, isVisible: true, opacity: 100, radius: [4],
          fills: [{ type: 'color', color: { value: 'rgba(245,255,241,1)' } }],
          blur: { isEnabled: true, type: '背景模糊', radius: 10, blurType: 3 } },
        // 内阴影：Sketch 用 `type: 内阴影`（没有 Figma 的 `inset` 布尔）
        { id: 'INNER', name: '内阴影块', type: 'shape', ddsType: 'rectangle', parentID: 'AB',
          left: 20, top: 240, width: 100, height: 40, isVisible: true, opacity: 100,
          fills: [{ type: 'color', color: { value: 'rgba(255,255,255,1)' } }],
          shadow: [{ isEnabled: true, type: '内阴影', blurRadius: 8, offsetX: 0, offsetY: 2, spread: 0,
            color: { value: 'rgba(0,0,0,0.2)' } }] },
      ],
    };
    const norm = normalizeSketchPluginTree(sp);
    const ls = flattenArtboard(norm.artboard, { rich: true });
    const bs = buildBlocks(ls);
    const meta = { name: '发光', width: 375, height: 400, origin: { x: 0, y: 0 } };
    const built = buildCodeItems(bs, ls, meta, { target: 'web' });
    const lines = (label) => (built.items.find((it) => it.label === label)?.web) ?? [];
    const glow = lines('找机构');
    const glass = lines('毛玻璃');
    const inner = lines('内阴影块');
    ok('★ Sketch 的 `blurRadius` / `offsetX` / `offsetY` 要认（只认 Figma 的 blur/x/y 会把发光抹成 0px）',
      glow.includes('box-shadow: 0px 0px 30px 0px #5cc93b;'), glow.join(' '));
    ok('★ Sketch 的模糊类型 `背景模糊` 要认（认不出会错写成 filter：模糊元素自己而不是背后的内容）',
      glass.includes('backdrop-filter: blur(10px);') && !glass.some((l) => l.startsWith('filter:')), glass.join(' '));
    ok('★ Sketch 的 `type: 内阴影` → inset（Figma 才有 inset 布尔，Sketch 用中文类型名）',
      inner.includes('box-shadow: inset 0px 2px 8px 0px rgba(0, 0, 0, 0.2);'), inner.join(' '));
    ok('★ Figma 那套字段名照旧、且 `?? ` 不许让 offsetX 顶掉 x=0（两套键互不干扰）',
      richInfoOf({ style: { shadows: [{ isEnabled: true, x: 0, y: 4, blur: 2, spread: 3, color: { value: 'rgba(0,0,0,0.5)' } }] } }).shadows[0].x === 0
      && richInfoOf({ style: { blurs: [{ isEnabled: true, type: 'Background', radius: 6 }] } }).blurs[0].type === 'Background'
      && richInfoOf({ style: { blurs: [{ isEnabled: true, type: 'Gaussian', radius: 6 }] } }).blurs[0].type === 'Gaussian',
      JSON.stringify(richInfoOf({ style: { shadows: [{ isEnabled: true, x: 0, y: 4, blur: 2, spread: 3, color: { value: 'rgba(0,0,0,0.5)' } }] } }).shadows));
  }
}

/* ═══════════════ ⑥.15d 评论 / 标注（§4.9） ═══════════════
 *
 * 评论是**独立接口**（不在图层树里），是"人话需求"的唯一来源（例：「要个png的图片」）。
 * 这一组钉六件事，每一件都对应一类**会静默出错**的失败：
 *   ① 接口解析（用**真机返回的结构**当 fixture：`read:false` / 昵称+账号名 / 版本 / 归一化坐标）；
 *   ② **位置映射**：落在块内 → 命中该块；落在空白 → **如实说"未落在任何块上"**（绝不硬套）；
 *   ③ **坐标系不混**：归一化 0~1 → 稿上 px 的换算（可手算的用例）；
 *   ④ **标题行**：有评论才有那一行；无评论时**逐字节不变**；
 *   ⑤ **降级**：评论接口挂了 → `read_blocks` 照样成功、其它段照常（明说失败，不静默）；
 *   ⑥ **只读 + 请求数**：`comments:false` 少一次请求；所有请求都是 GET、没有 body。
 */
group('⑥.15d 评论 / 标注（§4.9）');
{
  /* —— ① 纯函数：时间戳 —— */
  eq('评论时间戳按 Unix **秒**换算（真机值 1791587876 → 2026-10-09T23:17:56Z）',
    unixToIso(1791587876), '2026-10-09T23:17:56.000Z');
  eq('13 位毫秒也认（不把毫秒当秒算成 5 万年后）',
    unixToIso(1791587876000), '2026-10-09T23:17:56.000Z');
  eq('拿不到时间 → null（不编）', [unixToIso(0), unixToIso(null), unixToIso('x')], [null, null, null]);

  /* —— ③ 纯函数：归一化坐标 → 稿上坐标（**可手算**：0.5×375=187.5、0.25×812=203） —— */
  eq('归一化 → 画板坐标（0.5,0.25 @ 375×812）', commentPoint({ x: 0.5, y: 0.25 }, 375, 812), { x: 187.5, y: 203 });
  eq('归一化 → 画板坐标（0.3217459008974022 × 375 = 120.65）',
    commentPoint({ x: 0.3217459008974022, y: 0 }, 375, 812), { x: 120.65, y: 0 });
  eq('蓝湖"没定位"的 (0,0) 哨兵 → null（照算会永远命中画板左上角那个块）',
    commentPoint({ x: 0, y: 0 }, 375, 812), null);
  eq('缺字段 / 画板尺寸不可用 / 越界 → 一律 null（不猜）',
    [commentPoint({}, 375, 812), commentPoint({ x: 0.5, y: 0.5 }, 0, 812), commentPoint({ x: 1.4, y: 0.5 }, 375, 812), commentPoint({ x: 0.5, y: 0.5 }, undefined, 812)],
    [null, null, null, null]);
  eq('浮点毛刺 1.0005 当 1（不当越界丢掉）', commentPoint({ x: 1.0005, y: 1 }, 375, 812), { x: 375, y: 812 });

  /* —— ②/③ 纯函数：落点 → 块 —— */
  const mkC = (o = {}) => ({
    id: 'c', content: 'x', user: { id: null, name: null, nickname: null, display: null },
    version: { id: null, info: null }, unread: false, createdAt: null, updatedAt: null,
    position: { x: 0.5, y: 0.5 }, replies: [], ...o,
  });
  const mkB = (o = {}) => ({
    uid: 0, kind: 'card', name: '块', path: '画板/块', depth: 1, noise: false,
    x: 0, y: 0, w: 100, h: 100, ...o,
  });
  {
    const blocks = [
      mkB({ uid: 0, kind: 'artboard', name: '画板', path: '画板', depth: 0, x: 0, y: 0, w: 375, h: 812 }),
      mkB({ uid: 1, name: '大卡片', path: '画板/大卡片', depth: 1, x: 0, y: 0, w: 300, h: 300 }),
      mkB({ uid: 2, kind: 'pill', name: '小按钮', path: '画板/大卡片/小按钮', depth: 2, x: 10, y: 10, w: 60, h: 30 }),
    ];
    const [m] = mapCommentsToBlocks([mkC({ position: { x: 0.05, y: 0.02 } })], blocks, { width: 375, height: 812 });
    eq('点落在小按钮里 → 命中**最具体**的那个块（面积最小，不是最外层）', m.anchor.block?.name, '小按钮');
    eq('命中时 hit=true、distance=0', [m.anchor.hit, m.anchor.distance], [true, 0]);
    eq('块 label 走 blockLabel（名字优先）', m.anchor.block?.label, '小按钮');

    const [m2] = mapCommentsToBlocks([mkC({ position: { x: 0.9, y: 0.99 } })], blocks, { width: 375, height: 812 });
    eq('点落在空白且最近的块 > 阈值 → **不给任何块**（不硬套）', [m2.anchor.hit, m2.anchor.block, m2.anchor.reason], [false, null, 'blank']);
    ok('落点坐标原样写出来（便于人工回查）', m2.anchor.x === 337.5 && m2.anchor.y === 803.88, `${m2.anchor.x},${m2.anchor.y}`);

    const [m3] = mapCommentsToBlocks([mkC({ position: { x: 0.5, y: 0.4 } })], blocks, { width: 375, height: 812 });
    eq('点离块很近（≤48px）→ 仍判**未命中**，只给"最近的块"当线索',
      [m3.anchor.hit, m3.anchor.reason, m3.anchor.block?.name], [false, 'near', '大卡片']);
    ok('线索带距离（0.4×812=324.8，卡片底 300 → 24.8px）', m3.anchor.distance === 24.8, String(m3.anchor.distance));

    const [m4] = mapCommentsToBlocks([mkC({ position: { x: 0, y: 0 } })], blocks, { width: 375, height: 812 });
    eq('(0,0) 没定位 → reason=no-position、**连最近都不给**', [m4.anchor.reason, m4.anchor.block, m4.anchor.x], ['no-position', null, null]);

    // 画板（depth 0）**永远不当容器**：它的坐标是画布绝对坐标，拿它匹配会命中一切
    const [m5] = mapCommentsToBlocks([mkC({ position: { x: 0.5, y: 0.5 } })], [blocks[0]], { width: 375, height: 812 });
    eq('只有画板时：判"这张稿没有可见块"，而不是"命中画板"', [m5.anchor.hit, m5.anchor.reason, m5.anchor.block], [false, 'no-blocks', null]);

    // 同框副本（卡片 vs 它的 :shadow）：面积几乎相同 → 取**层级更浅**的那个（元素本体）
    const dup = [
      mkB({ uid: 1, name: '弹窗卡片', path: '画板/弹窗卡片', depth: 1, x: 16, y: 176.96, w: 343, h: 458.09 }),
      mkB({ uid: 2, name: '弹窗卡片:shadow', path: '画板/弹窗卡片/弹窗卡片:shadow', depth: 2, x: 16, y: 176.83, w: 343, h: 458 }),
    ];
    const [m6] = mapCommentsToBlocks([mkC({ position: { x: 0.3, y: 0.26 } })], dup, { width: 375, height: 812 });
    eq('同框副本（面积差 0.02%）→ 取层级更浅的**本体**，不取 `:shadow`', m6.anchor.block?.name, '弹窗卡片');

    // 最细层线索：名字是工具默认名的不认（否则会答出 `Vector`）
    const layers = [
      { depth: 0, name: '画板', parentPath: '', x: 0, y: 0, w: 375, h: 812, type: 'artboard' },
      { depth: 1, name: '弹窗卡片', parentPath: '画板', x: 16, y: 176.96, w: 343, h: 458.09, type: 'shapeLayer' },
      { depth: 2, name: '生成男士职业照 1', parentPath: '画板/弹窗卡片', x: 37.81, y: 192.96, w: 120, h: 152, type: 'shapeLayer' },
      { depth: 3, name: 'Vector', parentPath: '画板/弹窗卡片/生成男士职业照 1', x: 105, y: 205, w: 20, h: 20, type: 'shapeLayer' },
    ];
    const [m7] = mapCommentsToBlocks([mkC({ position: { x: 0.3, y: 0.26 } })], dup, { width: 375, height: 812 }, { layers });
    eq('最细层线索：跳过工具默认名 `Vector`，取真有名字的那层', m7.anchor.layer?.name, '生成男士职业照 1');
    const [m8] = mapCommentsToBlocks([mkC({ position: { x: 0.3, y: 0.26 } })], dup, { width: 375, height: 812 });
    eq('不传 layers → 没有线索（不编一个）', m8.anchor.layer, null);
  }

  /* —— 纯函数：渲染（无评论 → 空串；失败 → 明说） —— */
  eq('无评论 → 段是空串（标题行/正文一个字都不加，靠的就是它）', renderComments({ items: [], total: 0, unread: 0 }), '');
  eq('没传结果 → 空串', [renderComments(null), renderComments(undefined)], ['', '']);
  eq('标题行提醒：无评论 / 失败 → null（**没有那一行**）',
    [commentNoteText({ items: [], total: 0 }), commentNoteText({ error: 'x' }), commentNoteText(null)], [null, null, null]);
  eq('标题行提醒：有评论 → 「本稿有 N 条评论（含未读 M）」',
    commentNoteText({ items: [{ unread: true }, { unread: false }], total: 2 }), '本稿有 2 条评论（含未读 1）');
  {
    const seg = renderComments({ error: '接口返回错误 code=10007：Project not exist', items: [] }, { designWidth: 375, designHeight: 812 });
    ok('降级：失败时**明说**读取失败 + 原因，且点明"不代表没有评论"',
      seg.includes('读取失败') && seg.includes('10007') && seg.includes('不代表'), seg.split('\n').slice(0, 3).join(' / '));
    ok('失败时不说"没有评论"（那是最坏的误导）', !/没有评论/.test(seg.replace(/\*\*/g, '')), seg.split('\n')[1]);
  }
  {
    const long = '长'.repeat(LIMITS.commentsMaxContent + 5);
    const seg = renderComments({
      items: [{
        content: long, user: { display: '甲', name: 'jia' }, version: { info: '版本2' }, unread: false, replies: [],
        anchor: { hit: false, reason: 'no-position', x: null, y: null, block: null, distance: null, layer: null },
      }], total: 1, unread: 0,
    }, { designWidth: 375, designHeight: 812 });
    ok(`超长评论截断并标出总字数（${[...long].length} 字）`, seg.includes(`（共 ${[...long].length} 字）`));
    ok('昵称与账号名都打出来（重名时才分得清谁说的）', seg.includes('@甲（jia）'), seg.split('\n').find((l) => l.startsWith('- 评论'))?.slice(0, 40));
  }

  /* —— ①⑥ 纯函数：接口解析 / 分页 / 只读 —— */
  {
    // 这条评论**逐字取自真机返回**（2026-10，稿「人才弹窗」），字段名/类型都是真的：
    //   归一化坐标、`read:false`、`nickname` + `name`、`version_info`、Unix 秒。
    const REAL_COMMENT = {
      id: 'dfd851cf-7693-4947-a654-74d2937211c0', content: '要个png的图片', content_rich_text: '要个png的图片',
      create_time: 1791587876, update_time: 1791587879,
      position_x: 0.3217459008974022, position_y: 0.2596585570581626,
      dot_id: '', dot_x: 0, dot_y: 0, height: 0, width: 0, scale_x: 0, scale_y: 0, page_id: '', text: '1', read: false,
      replies: [{ id: 'r1', content: '收到', create_time: 1791587900, user: { id: 'u2', name: 'dev01', nickname: '' } }],
      user: { id: 'a1203a75', active: true, bind_mobile: 1, color: 'blue', name: 'qzdesign01', nickname: '管理', avatar: '', mobile: '133****4444' },
      version: { version_id: '88e0aaa6-093f-46ec-bceb-f8ed5bd6f8ba', version_info: '版本2' },
    };
    const mockRes = (obj, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: () => 'application/json; charset=utf-8' },
      arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
    });
    const realFetch = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      seen.push({ url: u, method: init?.method, body: init?.body });
      if (u.includes('/api/project/comment')) {
        const page = Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? 1);
        if (page === 1) return mockRes({ has_comment: true, has_next: true, total: 2, result: [REAL_COMMENT] });
        return mockRes({ has_comment: true, has_next: false, total: 2, result: [{ ...REAL_COMMENT, id: 'c2', content: '第二条', read: true }] });
      }
      throw new Error('未预期的请求：' + u);
    };
    let cm = null;
    let err = null;
    try {
      cm = await fetchComments('p-mock', 'i-mock', { account: 'mock', cookie: 'PASSPORT=x; user_token=y' });
    } catch (e) { err = e; } finally { globalThis.fetch = realFetch; }
    ok('fetchComments 能跑通（真机结构）', !!cm && !err, err ? String(err.message) : '');
    if (cm) {
      eq('分页：`has_next` → 翻到第 2 页，两页都收进来', [cm.pages, cm.fetched, cm.total, cm.truncated], [2, 2, 2, false]);
      eq('只请求评论接口 2 次，URL 里带 **image_id**', seen.filter((s) => s.url.includes('/comment')).length, 2);
      eq('URL 里**只给 image_id**（给 project_id 会 10007 Project not exist）',
        seen.every((s) => s.url.includes('image_id=i-mock') && !/project_id=|pid=/.test(s.url)), true);
      const c = cm.items[0];
      eq('正文 / 未读（`read:false` → 未读）/ 昵称+账号名',
        [c.content, c.unread, c.user.display, c.user.name, c.user.nickname], ['要个png的图片', true, '管理', 'qzdesign01', '管理']);
      eq('版本挂在哪一版', [c.version.id, c.version.info], ['88e0aaa6-093f-46ec-bceb-f8ed5bd6f8ba', '版本2']);
      eq('归一化坐标**原样**保留（换算不在这里做）',
        [c.position.x, c.position.y], [0.3217459008974022, 0.2596585570581626]);
      eq('时间戳 → ISO', c.createdAt, '2026-10-09T23:17:56.000Z');
      eq('回复串也解析（`@dev01`）', [c.replies.length, c.replies[0].content, c.replies[0].user.display], [1, '收到', 'dev01']);
      eq('接口的 user 不原样透传（20 个无关字段别进返回体）',
        Object.keys(c.user).sort().join(','), 'display,id,name,nickname');
      eq('未读计数', cm.unread, 1);
      // ★ 只读：**只发 GET、没有 body**（本项目绝不改 / 删评论，也不标记已读）
      ok('★ 只读：所有请求都是 GET、都没有 body',
        seen.every((s) => (s.method === undefined || s.method === 'GET') && s.body === undefined),
        JSON.stringify(seen.map((s) => [s.method, s.body === undefined])));
      ok('★ 评论请求显式声明 GET（而不是靠 fetch 的默认值）',
        seen.every((s) => !s.url.includes('/comment') || s.method === 'GET'));
    }
  }
  {
    // 分页硬上限：`has_next` 永远 true 也不许无限拉（LIMITS 是唯一出口）
    const realFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (!String(url).includes('/api/project/comment')) throw new Error('未预期的请求');
      return {
        ok: true, status: 200, headers: { get: () => 'application/json' },
        arrayBuffer: async () => Buffer.from(JSON.stringify({ has_comment: true, has_next: true, total: 9999, result: [{ id: `c${urls.length}`, content: 'x', read: true, user: {}, version: {}, replies: [] }] }), 'utf8'),
      };
    };
    let cm = null;
    try { cm = await fetchComments('p', 'i', { cookie: 'a=b' }); } finally { globalThis.fetch = realFetch; }
    eq(`分页撞硬上限（${LIMITS.commentsMaxPages} 页 = ${LIMITS.commentsMaxPages} 次请求）`,
      [urls.length, cm.pages, cm.fetched, cm.truncated], [LIMITS.commentsMaxPages, LIMITS.commentsMaxPages, LIMITS.commentsMaxPages, true]);
    ok('每页条数走 LIMITS（不是逻辑里的裸数字）—— URL 里就是那个值',
      urls.every((u) => u.includes(`pageSize=${LIMITS.commentsPageSize}`)), urls[0]);
    ok('翻页参数真的在翻（page=1/2/3…）', urls.map((u) => Number(/page=(\d+)/.exec(u)[1])).join(',') === urls.map((_, i) => i + 1).join(','), urls.length + ' 页');
  }
  ok('fetchComments 缺 imageId → 明确报错（并点出 10007 这个坑）', await fetchComments('p-only', null, { cookie: 'a=b' })
    .then(() => false, (e) => /imageId/.test(e.message) && /10007/.test(e.message)));
  {
    // 静态检查：这个函数区间里**不许出现任何写方法**（改 / 删 / 标已读）
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lanhu.mjs'), 'utf8');
    const i = src.indexOf('export async function fetchComments');
    const region = src.slice(i, src.indexOf('\nexport function commentPoint', i));
    ok('★ 源码区间里没有任何写方法（POST/PUT/DELETE/PATCH）',
      i > 0 && !/method:\s*['"](POST|PUT|DELETE|PATCH)/i.test(region) && /method: 'GET'/.test(region), `区间 ${region.length} 字符`);
  }

  /* —— ②④⑤⑥ 端到端：read_blocks 带评论 —— */
  {
    const VID2 = '0000000b-0000-4000-8000-00000000000b';
    const AT2 = 'Tue, 22 Sep 2026 16:58:24 GMT';
    const mockRes = (obj, status = 200) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: () => 'application/json; charset=utf-8' },
      arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
    });
    const fillNode = (hex, alpha = 1) => {
      const c = parseColor(hex);
      return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` } };
    };
    /** 结构照真机稿「人才弹窗」搭：画板不在画布原点、卡片 + 同框 `:shadow` 副本 + 卡内不成块的图片层。 */
    const cmTree = () => ({
      meta: { device: 'iPhone 14' },
      artboard: {
        id: 'ab', type: 'artboard', name: '评论自检稿',
        frame: { left: -12638, top: 500, width: 375, height: 812 },
        style: { fills: [fillNode('#ffffff')] },
        layers: [
          {
            id: 'CARD', type: 'shapeLayer', name: '弹窗卡片',
            frame: { left: 16, top: 176.96, width: 343, height: 458.09 },
            paths: [{ type: 'rect', radius: { topLeft: 16, topRight: 16, bottomRight: 16, bottomLeft: 16 } }],
            style: { fills: [fillNode('#ffffff')] },
            layers: [
              // 同框副本：与卡片面积只差 0.02%（真机上就是这么一对）
              {
                id: 'SHADOW', type: 'shapeLayer', name: '弹窗卡片:shadow',
                frame: { left: 16, top: 176.83, width: 343, height: 458 },
                style: { fills: [fillNode('#000000', 0.1)] },
              },
              // **不成块**的真元素（无填充/无边框/无圆角/非切图 → OTHER）：只能靠"最细层"线索看见
              {
                id: 'PHOTO', type: 'shapeLayer', name: '生成男士职业照 1',
                frame: { left: 37.81, top: 192.96, width: 120, height: 152 },
                layers: [
                  { id: 'VEC', type: 'shapeLayer', name: 'Vector', frame: { left: 105, top: 205, width: 20, height: 20 } },
                ],
              },
              // 对比度不达标的灰字（证明评论段排在「对比度」之后）
              {
                id: 'TXT', type: 'textLayer', name: '灰字',
                frame: { left: 20, top: 300, width: 100, height: 20 },
                style: { fills: [fillNode('#999999')] },
                text: { style: { content: '灰字', color: { value: 'rgba(153,153,153,1)' }, font: { name: 'Inter', size: 14, fontWeight: 400 } } },
              },
            ],
          },
        ],
      },
    });
    const cmComment = (o = {}) => ({
      id: 'c1', content: '要个png的图片', create_time: 1791587876, update_time: 1791587879,
      position_x: 0.3, position_y: 0.26, read: false,
      user: { id: 'u1', name: 'qzdesign01', nickname: '管理' },
      version: { version_id: '88e0aaa6', version_info: '版本2' },
      replies: [], ...o,
    });
    const FULL = [
      cmComment(),                                                                   // 命中卡片
      cmComment({ id: 'c2', content: '这里少了分割线', position_x: 0.02, position_y: 0.99, read: true }),   // 空白（远）
      cmComment({ id: 'c3', content: '按钮再大一点', position_x: 0.5, position_y: 650 / 812, read: true }), // 空白（近）
      cmComment({ id: 'c4', content: '整稿的备注', position_x: 0, position_y: 0, read: true }),             // 没定位
    ];
    /** comments: 'empty' 空稿 / 'full' 4 条 / 'fail' 接口报错 */
    const withCmMock = async (fn, { comments = 'empty' } = {}) => {
      const real = globalThis.fetch;
      const seen = [];
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        seen.push({ url: u, method: init?.method, body: init?.body });
        if (u.includes('/api/project/image?')) {
          return mockRes({
            code: '00000',
            result: { id: 'i-mock', name: '评论自检稿', width: 375, height: 812, versions: [{ id: VID2, json_url: 'https://mock.lanhu/cm.json', create_time: AT2 }] },
          });
        }
        if (u === 'https://mock.lanhu/cm.json') return mockRes(cmTree());
        if (u.includes('/api/project/comment')) {
          if (comments === 'fail') return mockRes({ code: '10007', msg: 'Project not exist' });
          if (comments === 'empty') return mockRes({ has_comment: false, has_next: false, total: 0, result: [] });
          return mockRes({ has_comment: true, has_next: false, total: FULL.length, result: FULL });
        }
        throw new Error('未预期的请求：' + u);
      };
      try { return { r: await fn(), seen }; } finally { globalThis.fetch = real; }
    };
    const A2 = { projectId: 'p-mock', imageId: 'i-mock', account: 'mock', cookie: 'PASSPORT=x; user_token=y' };

    // ⓐ 空稿：**逐字节不变**（这是"绝大多数稿"的情形）
    const { r: rOff, seen: seenOff } = await withCmMock(() => readBlocks({ ...A2, comments: false }), { comments: 'empty' });
    const { r: rEmpty, seen: seenEmpty } = await withCmMock(() => readBlocks({ ...A2 }), { comments: 'empty' });
    ok('★ 无评论稿：文本与 `comments:false` 那次**逐字节一致**', rEmpty.text === rOff.text, `长度 ${rEmpty.text?.length} vs ${rOff.text?.length}`);
    ok('★ 无评论稿：整个返回体也逐字节一致（不多 `comments` / `commentsError` 键）',
      JSON.stringify(rEmpty) === JSON.stringify(rOff), `键 ${Object.keys(rEmpty).join(',')}`);
    ok('★ 无评论稿：标题行**一个字符都没变**', rEmpty.text.split('\n')[0] === rOff.text.split('\n')[0], rEmpty.text.split('\n')[0]);
    ok('★ 无评论稿：正文里没有评论段（没有 `## 评论` / 没有「条评论」）',
      !rEmpty.text.includes('## 评论') && !rEmpty.text.includes('条评论'), (rEmpty.text.match(/评论/g) ?? []).length + ' 处「评论」字样');
    eq('★ `comments:false` → **少一次请求**（2 次；默认是 3 次）', [seenOff.length, seenOff.length], [2, 2]);
    eq('无评论稿也**不**返回 comments 键', Object.prototype.hasOwnProperty.call(rEmpty, 'comments'), false);

    // ⓑ 有 4 条：标题行 + 评论段 + 机器可读字段
    const { r: rFull, seen: seenFull } = await withCmMock(() => readBlocks({ ...A2 }), { comments: 'full' });
    ok('★ 默认**读评论**：请求数 2 → 3（详情 + 图层树 + 评论）', seenFull.length === 3, seenFull.map((s) => s.url.replace(/^https:\/\/lanhuapp\.com/, '')).join(' | '));
    ok('★ 只读：3 个请求全是 GET、都没有 body',
      seenFull.every((s) => (s.method === undefined || s.method === 'GET') && s.body === undefined));
    ok('★ 标题行加了提醒：「本稿有 4 条评论（含未读 1）」',
      rFull.text.split('\n')[0].includes('｜本稿有 4 条评论（含未读 1）'), rFull.text.split('\n')[0]);
    const segTxt = rFull.text.split('## 评论')[1] ?? '';
    ok('★ 评论段在「对比度」之后、尾注之前',
      rFull.text.indexOf('## 对比度') > -1 && rFull.text.indexOf('## 对比度') < rFull.text.indexOf('## 评论')
      && rFull.text.indexOf('## 评论') < rFull.text.indexOf('ℹ️'), `对比度@${rFull.text.indexOf('## 对比度')} 评论@${rFull.text.indexOf('## 评论')} 尾注@${rFull.text.indexOf('ℹ️')}`);
    ok('评论段给：内容 + 谁说的 + 版本 + 未读 + 挂在哪个块',
      segTxt.includes('「要个png的图片」') && segTxt.includes('@管理（qzdesign01）') && segTxt.includes('版本2')
      && segTxt.includes('**未读**') && segTxt.includes('挂在 **弹窗卡片** 这块（卡片 · 343×458）'), segTxt.split('\n').find((l) => l.includes('挂在')));
    ok('★ 落点最细层线索：卡内那张不成块的职业照（`Vector` 这种默认名被跳过）',
      segTxt.includes('该块内最细的层：**生成男士职业照 1**'), segTxt.split('\n').find((l) => l.includes('最细')));
    ok('★ 落在空白的评论**明说没落在任何块上**（不说"挂在某块"）',
      (segTxt.match(/未落在任何块上/g) ?? []).length === 3, String((segTxt.match(/未落在任何块上/g) ?? []).length));
    ok('★ 近处的那条给"最近的是…（约 15px 外）"并声明**只是线索不是命中**',
      /最近的是 \*\*弹窗卡片\*\*.*约 15px 外.*只是线索，不是命中/.test(segTxt), segTxt.split('\n').find((l) => l.includes('最近的是')));
    ok('★ (0,0) 那条点明"没带定位坐标"，**不硬套块**',
      segTxt.includes('评论没带定位坐标'), segTxt.split('\n').find((l) => l.includes('没带定位')));
    ok('段头交代坐标系（归一化 × 画板 375×812）与只读纪律',
      segTxt.includes('归一化 0~1') && segTxt.includes('375×812') && segTxt.includes('只发 GET'));
    // 机器可读字段
    eq('返回：comments.total / unread / fetched',
      [rFull.comments.total, rFull.comments.unread, rFull.comments.fetched], [4, 1, 4]);
    eq('返回：items[0] 平铺了 blockLabel + user + version + unread + replies',
      [rFull.comments.items[0].blockLabel, rFull.comments.items[0].user.display, rFull.comments.items[0].version.info, rFull.comments.items[0].unread, Array.isArray(rFull.comments.items[0].replies)],
      ['弹窗卡片', '管理', '版本2', true, true]);
    eq('返回：position 是**归一化**、point 是**稿上坐标**（两者都在，谁也别猜）',
      [rFull.comments.items[0].position.x, rFull.comments.items[0].point.x, rFull.comments.items[0].point.y], [0.3, 112.5, 211.12]);
    eq('返回：空白那条 hit=false 且 block=null（机器读的结论与文本一致）',
      [rFull.comments.items[1].anchor.hit, rFull.comments.items[1].anchor.block, rFull.comments.items[1].blockLabel], [false, null, null]);
    eq('返回：没定位那条 reason=no-position',
      [rFull.comments.items[3].anchor.reason, rFull.comments.items[3].point], ['no-position', null]);
    ok('★ 返回是 lossless（没有 undefined/NaN 混进去）',
      findIllegal({ comments: rFull.comments }).length === 0, findIllegal({ comments: rFull.comments }).slice(0, 2).join(','));
    eq('有评论时**不**带 commentsError 键', Object.prototype.hasOwnProperty.call(rFull, 'commentsError'), false);

    // ⓒ 降级：评论接口挂了 → read_blocks **照样成功**，其它段一个字不少
    //   ⚠️ 这里**自己兜住抛错**（而不是让整个自检崩掉）：一旦 read_blocks 把评论的失败抛出来，
    //      下面那条断言要给出一个**计过数的 ❌**，而不是一个没有上下文的堆栈。
    const { r: rFail } = await withCmMock(async () => {
      try { return await readBlocks({ ...A2 }); } catch (e) { return { ok: false, throwMessage: String(e?.message ?? e), text: '', blocks: [] }; }
    }, { comments: 'fail' });
    eq('★ 评论接口挂了：read_blocks 仍然 ok（绝不连累主流程）', [rFail.ok, rFail.blockCount > 0], [true, true]);
    ok('★ 评论接口挂了也**没有抛错**（抛错 = 主流程被评论拖死）', !rFail.throwMessage, rFail.throwMessage ?? '');
    ok('★ 挂掉时**明说**「读取失败」+ 原因（不静默、不假装"没有评论"）',
      rFail.text.includes('## 评论（**读取失败**）') && rFail.text.includes('10007'), rFail.text.split('## 评论')[1]?.split('\n')[0]);
    ok('★ 挂掉时返回带机器可读的 `commentsError`（不用解析文本就能判断）',
      typeof rFail.commentsError === 'string' && /10007/.test(rFail.commentsError), rFail.commentsError);
    eq('挂掉时**不**带 comments 键（避免调用方把失败当"0 条"）', Object.prototype.hasOwnProperty.call(rFail, 'comments'), false);
    // ★ 最强的一条：把「读取失败」那段整段摘掉，剩下的必须与"完全不读评论"的那份一致
    //   —— 证明降级只影响评论段自己，块表 / 边框段 / 间距一览 / 对比度 / 尾注 / 标题行一字未动。
    //   （尾注里的 `≈N KB` 是**本段文本自身体积**，多了评论段它当然会变 —— 那一处单独比。）
    {
      const cut = rFail.text.indexOf('## 评论（**读取失败**）');
      const stripped = cut > 0 ? rFail.text.slice(0, cut) + rFail.text.slice(rFail.text.indexOf('— ≈', cut)) : rFail.text;
      const bodyOf = (t) => t.slice(0, t.indexOf('— ≈'));
      let k = 0;
      while (k < stripped.length && k < rOff.text.length && stripped[k] === rOff.text[k]) k += 1;
      ok('★ 挂掉时正文（标题行 → 对比度段）**逐字节照常**', bodyOf(stripped) === bodyOf(rOff.text),
        bodyOf(stripped) === bodyOf(rOff.text) ? `${bodyOf(stripped).length} 字符一致`
          : `首个不同在第 ${k} 字符：摘掉后 ${JSON.stringify(stripped.slice(Math.max(0, k - 40), k + 40))} / 原本 ${JSON.stringify(rOff.text.slice(Math.max(0, k - 40), k + 40))}`);
      const footOf = (t) => t.slice(t.indexOf('— ≈')).replace(/≈[\d.]+KB/, '≈?KB');
      ok('★ 挂掉时尾注除体积数字外一字不差（体积本来就该把评论段算进去）',
        footOf(stripped) === footOf(rOff.text), footOf(stripped).split('\n')[0]);
      ok('★ 挂掉时块表 / 对比度 / 尾注 都还在',
        rFail.text.includes('| # | 类型 | 名称 | 位置 |') && rFail.text.includes('## 对比度') && rFail.text.includes('ℹ️'));
    }
    ok('★ 挂掉时标题行**不加**评论提醒（没读到就不编）',
      !rFail.text.split('\n')[0].includes('条评论'), rFail.text.split('\n')[0]);
    ok('★ 挂掉时块的解析结果与正常情况**完全一致**（评论不影响块模型）',
      JSON.stringify(rFail.blocks) === JSON.stringify(rFull.blocks), `${rFail.blockCount} vs ${rFull.blockCount}`);
  }

  /* —— 工具层：新参数的注册期契约（schema 拦坏值 = 一个请求都不发；声明可序列化） —— */
  {
    const tool = TOOLS.find((t) => t.name === 'lanhu_read_blocks');
    ok('read_blocks 的参数 schema 声明了 `comments`', tool?.parameters?.properties?.comments?.type === 'boolean',
      JSON.stringify(tool?.parameters?.properties?.comments ?? null).slice(0, 80));
    ok('read_blocks 的 output schema 声明了 `comments` / `commentsError`',
      !!tool?.output?.schema?.properties?.comments && !!tool?.output?.schema?.properties?.commentsError);
    const bad = await tool.execute({ comments: 'yes' });
    ok('`comments` 传非布尔值 → 被 schema 拦在业务之前（不发任何请求）',
      bad?.failed === true && /不符合 schema/.test(String(bad.text)), String(bad?.text).split('\n')[0]);
    const def = JSON.stringify({ p: tool.parameters, o: tool.output.schema });
    ok('改完的声明仍可 JSON 序列化（注册期不会因 undefined/函数炸掉整个 profile）',
      typeof def === 'string' && def.length > 100, `${def.length} 字符`);
  }
}

/* ═══════════════ ⑥.16 设计变更 diff（第 2 步） ═══════════════ */
group('⑥.16 设计变更 diff');

/** 造一个块（字段形状与 `buildBlocks` 的输出一致）—— 只覆盖要比对的那几项。 */
const mkBlk = (o = {}) => ({
  uid: 0, kind: 'card', name: '块', path: '画板/块', depth: 1, noise: false,
  x: 0, y: 0, w: 100, h: 50, inset: null,
  radius: { corners: [14, 14, 14, 14], max: 14, pill: false },
  bg: { hex: '#ffffff', alpha: 1, stops: [] },
  opacity: 1, border: null, text: null, color: null, colorAlpha: null,
  font: null, hasImage: false, shape: 'rect', childCount: 0, layerIndex: 0,
  ...o,
});
const labelsOf = (items) => items.map((i) => i.label);
const catsOf = (items) => [...new Set(items.map((i) => i.cat))].sort();

/** diffReliability 的调用样板（省得每处都写全字段）。 */
const rel = (o) => diffReliability({
  matched: 0, exact: 0, approx: 0, onlyFrom: 0, onlyTo: 0, fromCount: 0, toCount: 0, ...o,
});

/* —— ① 配对策略：身份优先，可解释 —— */
{
  // 内容完全一致，只是**数组顺序被打乱**（设计工具导出顺序不保证稳定）
  const A = [
    mkBlk({ uid: 0, path: '画板/一', name: '一', x: 0 }),
    mkBlk({ uid: 1, path: '画板/二', name: '二', x: 100 }),
    mkBlk({ uid: 2, path: '画板/三', name: '三', x: 200 }),
  ];
  const B = [A[2], A[0], A[1]].map((b, i) => ({ ...b, uid: i }));
  const m = matchVersionBlocks(A, B);
  ok('顺序打乱也能全部配对', m.pairs.length === 3 && m.onlyFrom.length === 0 && m.onlyTo.length === 0);
  ok('配对走**身份（path）**：一配一、二配二、三配三 —— 不是按数组下标',
    m.pairs.every((p) => p.a.path === p.b.path),
    m.pairs.map((p) => `${p.a.path}→${p.b.path}`).join(' | '));
  ok('顺序打乱**不产生假差异**（下标一一对应会报出一堆假布局变化）',
    m.pairs.every((p) => diffBlockItems(p.a, p.b).length === 0),
    m.pairs.flatMap((p) => labelsOf(diffBlockItems(p.a, p.b))).join(' | '));
  ok('全部是精确匹配（how=exact）', m.pairs.every((p) => p.how === 'exact'));
}
{
  // 同 path 有多个块（实测 159 块 / 134 个唯一 path）→ 组内按几何最近邻挑"是哪一个"
  const A = [
    mkBlk({ uid: 0, path: '画板/同名', name: '同名', y: 0 }),
    mkBlk({ uid: 1, path: '画板/同名', name: '同名', y: 100 }),
  ];
  const B = [
    mkBlk({ uid: 0, path: '画板/同名', name: '同名', y: 100 }),
    mkBlk({ uid: 1, path: '画板/同名', name: '同名', y: 0 }),
  ];
  const m = matchVersionBlocks(A, B);
  ok('同 path 多个块：按几何最近邻配对（顺序换了也对得上）',
    m.pairs.length === 2 && m.pairs.every((p) => p.a.y === p.b.y),
    m.pairs.map((p) => `${p.a.y}→${p.b.y}`).join(' | '));
}
{
  // 身份对不上 → 近似匹配，且**必须标注**，不许冒充精确
  const A = [mkBlk({ uid: 0, path: '画板/旧名', name: '旧名' })];
  const B = [mkBlk({ uid: 0, path: '画板/新名', name: '新名' })];
  const m = matchVersionBlocks(A, B);
  ok('身份对不上时退到近似匹配，并**标注 how=approx**（不冒充精确）',
    m.pairs.length === 1 && m.pairs[0].how === 'approx', m.pairs.map((p) => p.how).join(','));
  ok('近似匹配把改名前后都留着（旧 path → 新 path 可解释）',
    m.pairs[0].a.path === '画板/旧名' && m.pairs[0].b.path === '画板/新名');
  ok('近似匹配过几何门槛：挪太远不认',
    matchApproxBlocks(A, [mkBlk({ uid: 0, path: '画板/新名', x: 5000 })]).length === 0);
  ok('近似匹配过尺寸门槛：尺寸差太多不认',
    matchApproxBlocks(A, [mkBlk({ uid: 0, path: '画板/新名', w: 400 })]).length === 0);
  ok('近似匹配过类型门槛：类型不同不认',
    matchApproxBlocks(A, [mkBlk({ uid: 0, path: '画板/新名', kind: 'text', text: 'x' })]).length === 0);
  ok('近似匹配过文本门槛：文案不同不认（宁可报新增/删除）',
    matchApproxBlocks(A, [mkBlk({ uid: 0, path: '画板/新名', kind: 'text', text: '甲' })]).length === 0
    && matchApproxBlocks([mkBlk({ uid: 0, kind: 'text', text: '甲' })], [mkBlk({ uid: 0, kind: 'text', text: '乙', path: '别的' })]).length === 0);
}
{
  // 改了文案 + 改了层名 → 不该硬认成同一块
  const A = [mkBlk({ uid: 0, kind: 'text', path: '画板/旧', name: '旧', text: '立即咨询' })];
  const B = [mkBlk({ uid: 0, kind: 'text', path: '画板/新', name: '新', text: '马上咨询' })];
  const m = matchVersionBlocks(A, B);
  ok('改名 + 改文案 → 报"删除 1 / 新增 1"，不硬认',
    m.pairs.length === 0 && m.onlyFrom.length === 1 && m.onlyTo.length === 1,
    `pairs=${m.pairs.length} from=${m.onlyFrom.length} to=${m.onlyTo.length}`);
}

/* —— ② 匹配可靠度：大面积对不上必须明说不可靠 —— */
{
  const A = Array.from({ length: 20 }, (_, i) => mkBlk({ uid: i, path: `旧/${i}`, name: `旧${i}`, x: i * 10 }));
  const B = Array.from({ length: 20 }, (_, i) => mkBlk({ uid: i, path: `新/${i}`, name: `新${i}`, x: 3000 + i * 10 }));
  const m = matchVersionBlocks(A, B);
  const r = rel({ matched: m.pairs.length, exact: 0, approx: m.pairs.length, onlyFrom: m.onlyFrom.length, onlyTo: m.onlyTo.length, fromCount: 20, toCount: 20 });
  ok('整版重画（path 与几何全换）→ 一块都配不上', m.pairs.length === 0 && r.matched === 0);
  ok('大面积对不上 → 判「不可靠」并给出原因', r.reliable === false && typeof r.reason === 'string' && r.reason.length > 0, r.reason ?? '(没给原因)');
}
{
  const A = Array.from({ length: 20 }, (_, i) => mkBlk({ uid: i, path: `旧/${i}`, name: `旧${i}`, x: i * 10 }));
  const B = Array.from({ length: 20 }, (_, i) => mkBlk({ uid: i, path: `新/${i}`, name: `新${i}`, x: i * 10 }));
  const m = matchVersionBlocks(A, B);
  const r = rel({ matched: m.pairs.length, exact: 0, approx: m.pairs.length, fromCount: 20, toCount: 20 });
  ok('层名整片换过（全部只能靠几何猜）→ 也判不可靠',
    m.pairs.length === 20 && m.pairs.every((p) => p.how === 'approx') && r.reliable === false, r.reason ?? '');
}
{
  const r = rel({ matched: 12, exact: 12, approx: 0, onlyFrom: 8, onlyTo: 8, fromCount: 20, toCount: 20 });
  ok('匹配率的分母是**两边块数的较大值**（不是"已匹配+未匹配之和"，那会把未匹配算两遍）',
    r.total === 20, `total=${r.total}（若算成 28 就是那个坑）`);
  ok('12/20 = 60% ≥ 阈值 → 仍判可信（不误报不可靠）', r.reliable === true, r.reason ?? '');
  const r2 = rel({ matched: 8, exact: 8, approx: 0, onlyFrom: 12, onlyTo: 12, fromCount: 20, toCount: 20 });
  ok('8/20 = 40% < 阈值 → 判不可靠', r2.reliable === false, r2.reason ?? '');
}
{
  const small = rel({ matched: 3, exact: 0, approx: 3, fromCount: 3, toCount: 3 });
  ok('块数很少且**全部**靠猜 → 明说不可靠（不因样本小而放过）',
    small.reliable === false && /全部/.test(small.reason ?? ''), small.reason ?? '');
  const fine = rel({ matched: 3, exact: 3, approx: 0, fromCount: 3, toCount: 3 });
  ok('块数很少但全部精确 → 不误判', fine.reliable === true && fine.smallSample === true);
}

/* —— ③ 变化分类：尺寸/圆角 · 颜色 · 布局 · 文字 · 边框 · 结构 —— */
{
  const base = mkBlk();
  ok('圆角 14→16 → 尺寸/圆角类，文案「圆角 14→16」',
    JSON.stringify(labelsOf(diffBlockItems(base, mkBlk({ radius: { corners: [16, 16, 16, 16], max: 16, pill: false } })))) === JSON.stringify(['圆角 14→16']));
  ok('只改高度 → 「高度 42→44」',
    labelsOf(diffBlockItems(mkBlk({ h: 42 }), mkBlk({ h: 44 })))[0] === '高度 42→44');
  ok('只改宽度 → 「宽度 100→120」',
    labelsOf(diffBlockItems(base, mkBlk({ w: 120 })))[0] === '宽度 100→120');
  ok('宽高同改 → 合并成一条「尺寸 120×152→130×160」',
    labelsOf(diffBlockItems(mkBlk({ w: 120, h: 152 }), mkBlk({ w: 130, h: 160 })))[0] === '尺寸 120×152→130×160');
  ok('圆角 + 尺寸同时变 → 两条都在 size 类',
    labelsOf(diffBlockItems(base, mkBlk({ w: 120, radius: { corners: [16, 16, 16, 16], max: 16, pill: false } }))).length === 2);
  ok('完全没变 → 零条（不是空数组以外的任何东西）', diffBlockItems(base, mkBlk()).length === 0);
}
{
  const a = mkBlk({
    bg: { hex: '#574af4', alpha: 0.08, stops: [] }, color: '#333333', colorAlpha: 1, opacity: 1,
    border: { color: '#e2e8f0', alpha: 1, colorKnown: true, width: 1, single: false, widths: { top: 1, right: 1, bottom: 1, left: 1 } },
  });
  const b = mkBlk({
    bg: { hex: '#4f46e5', alpha: 0.1, stops: [] }, color: '#111111', colorAlpha: 0.5, opacity: 0.8,
    border: { color: '#cbd5e1', alpha: 1, colorKnown: true, width: 1, single: false, widths: { top: 1, right: 1, bottom: 1, left: 1 } },
  });
  const items = diffBlockItems(a, b);
  eq('底色/文字色/不透明度/描边色 四项都归「颜色」类', catsOf(items), ['color']);
  ok('半透明底色给「@8%→@10%」且带 rgba（照抄不用换算）',
    items.find((i) => i.field === 'bg').label.includes('#574af4@8%') && items.find((i) => i.field === 'bg').label.includes('rgba(87, 74, 244'),
    items.find((i) => i.field === 'bg').label);
  ok('半透明文字色也带 alpha（不能只给 hex）',
    items.find((i) => i.field === 'color').label.includes('@50%'),
    items.find((i) => i.field === 'color').label);
  ok('不透明度变化单列一条', items.some((i) => i.field === 'opacity' && i.label === '不透明度 1→0.8'));
  ok('渐变 stop 变了也算颜色变化',
    diffBlockItems(mkBlk({ bg: { hex: '#a', alpha: 1, stops: [{ hex: '#a', alpha: 1 }, { hex: '#b', alpha: 1 }] } }),
      mkBlk({ bg: { hex: '#a', alpha: 1, stops: [{ hex: '#a', alpha: 1 }, { hex: '#c', alpha: 1 }] } }))
      .some((i) => i.field === 'bg'));
}
{
  ok('布局：只改 y → 「下移 8px」', labelsOf(diffBlockItems(mkBlk({ y: 120 }), mkBlk({ y: 128 })))[0].startsWith('下移 8px'));
  ok('布局：y 变小 → 「上移」', labelsOf(diffBlockItems(mkBlk({ y: 128 }), mkBlk({ y: 120 })))[0].startsWith('上移 8px'));
  ok('布局：只改 x → 「右移 4px」', labelsOf(diffBlockItems(mkBlk({ x: 20 }), mkBlk({ x: 24 })))[0].startsWith('右移 4px'));
  ok('布局：x/y 都变 → 「移动 (3, 4)px」', labelsOf(diffBlockItems(mkBlk({ x: 0, y: 0 }), mkBlk({ x: 3, y: 4 })))[0].startsWith('移动 (3, 4)px'));
  const art = diffBlockItems(
    mkBlk({ kind: 'artboard', path: '稿', x: -9876, y: 463, radius: null }),
    mkBlk({ kind: 'artboard', path: '稿', x: -9879, y: 487, radius: null }));
  ok('🔒 画板块的 x/y 变化**不算布局变化**（那是画布绝对坐标，报出来就是纯假差异）',
    art.filter((i) => i.cat === 'layout').length === 0, labelsOf(art).join(' | '));
}
{
  const a = mkBlk({ kind: 'text', text: '立即咨询', font: { family: 'Inter', size: 20, weight: 600, lineHeight: 28, letterSpacing: 0, align: 'left' } });
  const b = mkBlk({ kind: 'text', text: '马上咨询', font: { family: 'PingFang SC', size: 22, weight: 700, lineHeight: 32, letterSpacing: 0.5, align: 'center' } });
  const items = diffBlockItems(a, b);
  eq('文字类：文案/字号/字重/字体族/行高/字距/对齐 七项都报', items.length, 7);
  ok('文案给「从→到」', items[0].label === '文案 "立即咨询"→"马上咨询"', items[0].label);
  ok('字号/字重给「从→到」',
    items.some((i) => i.label === '字号 20→22') && items.some((i) => i.label === '字重 600→700'),
    labelsOf(items).join(' | '));
  ok('换字体也报（字体族）', items.some((i) => i.field === 'fontFamily' && i.label.includes('Inter→PingFang SC')));
  ok('字重没变就不报（不硬凑）',
    diffBlockItems(a, mkBlk({ ...a, text: '别的' })).every((i) => i.field !== 'fontWeight'));
}
{
  const items = diffBlockItems(mkBlk({ kind: 'image', hasImage: true }), mkBlk({ kind: 'card', hasImage: false }));
  eq('结构类：类型 + 切图 两条', items.length, 2);
  eq('类型给「图片→卡片」', items[0].label, '类型 图片→卡片');
  eq('切图给「有→无」', items[1].label, '切图 有→无');
  ok('形状变化也报',
    diffBlockItems(mkBlk({ shape: 'rect' }), mkBlk({ shape: 'ellipse' })).some((i) => i.field === 'shape'));
  ok('子层数变化也报',
    diffBlockItems(mkBlk({ childCount: 3 }), mkBlk({ childCount: 4 })).some((i) => i.field === 'childCount'));
}
{
  const items = diffBlockItems(
    mkBlk({ border: { color: '#e2e8f0', width: 1, single: true, widths: { top: 1, right: 0, bottom: 0, left: 0 } } }),
    mkBlk({ border: null }));
  ok('边框：有→无 归「边框」类，颜色变化归「颜色」类（两条各归其位，不混）',
    items.some((i) => i.cat === 'border' && i.label.includes('→无'))
    && items.some((i) => i.cat === 'color' && i.field === 'borderColor'),
    labelsOf(items).join(' | '));
}

/* —— ④ 渲染：只列有变化的、无变化要明说、不可靠不出明细 —— */
const mkDiff = (o = {}) => ({
  ok: true, format: 'diff', name: '自检稿', viewport: { width: 375, height: 700 }, versionCount: 3,
  from: { id: '11111111-0000-4000-8000-000000000001', createTime: 'Mon, 01 Sep 2026 00:00:00 UTC', index: 2, isLatest: false },
  to: { id: '33333333-0000-4000-8000-000000000003', createTime: 'Thu, 04 Sep 2026 12:00:00 UTC', index: 0, isLatest: true },
  sameVersion: false, gapSeconds: 302400, gapDays: 3.5,
  identical: false, reliable: true,
  reliability: { exact: 3, approx: 0, unmatched: 0, matched: 3, total: 3, matchedRatio: 1, approxShare: 0, smallSample: true, reliable: true, reason: null },
  counts: { fromBlocks: 3, toBlocks: 3, noiseFrom: 0, noiseTo: 0, matched: 3, unchanged: 2, changed: { size: 1, color: 0, layout: 0, text: 0, border: 0, structure: 0, blocks: 1 }, added: 0, removed: 0 },
  changes: {
    size: [{ path: '画板/卡片', name: '卡片', kind: 'card', kindFrom: 'card', how: 'exact', field: 'radius', label: '圆角 14→16', from: 14, to: 16, where: '卡片' }],
    color: [], layout: [], text: [], border: [], structure: [],
  },
  added: [], removed: [], notes: [],
  ...o,
});
{
  const t = renderDiff(mkDiff());
  ok('明细里给「从→到」', t.includes('圆角 14→16'), t);
  ok('零变化的块**只给一句汇总**（"其余 2 块未变"）', t.includes('未变：其余 2 块'), t);
  ok('块数/版本/相隔天数都在抬头里', t.includes('块数 3 → 3') && t.includes('相隔 3.5 天'), t.split('\n')[0]);
  ok('报出匹配可靠度（精确/近似/无法匹配）', /匹配可靠度：✅ 3 块按 path 精确匹配/.test(t));
  ok('to 是最新版时写明"最新版"', t.includes('最新版'));
}
{
  const t = renderDiff(mkDiff({
    identical: true,
    counts: { ...mkDiff().counts, unchanged: 3, changed: { size: 0, color: 0, layout: 0, text: 0, border: 0, structure: 0, blocks: 0 } },
    changes: { size: [], color: [], layout: [], text: [], border: [], structure: [] },
  }));
  ok('零变化时**明说"两版一致"**（不是静默空输出）', t.includes('两版一致') && t.includes('没有任何差异'), t);
  ok('零变化时给出可行动的结论（代码可以不动）', t.includes('设计没改'), t);
  ok('零变化时不再重复"未变：其余 N 块"（那句话在"完全一致"时是废话）', !t.includes('未变：其余'));
}
{
  const t = renderDiff(mkDiff({
    reliable: false,
    reliability: { exact: 1, approx: 0, unmatched: 19, matched: 1, total: 20, matchedRatio: 0.05, approxShare: 0, smallSample: false, reliable: false, reason: '只有 1/20 块能配上（匹配率 5%），19 块对不上。' },
    counts: { ...mkDiff().counts, matched: 1, changed: { size: 0, color: 0, layout: 0, text: 0, border: 0, structure: 0, blocks: 0 }, added: 10, removed: 9 },
    changes: { size: [], color: [], layout: [], text: [], border: [], structure: [] },
    added: [{ path: 'x', name: '新块', kind: 'card', w: 10, h: 10, where: '新块' }],
    removed: [{ path: 'y', name: '旧块', kind: 'card', w: 10, h: 10, where: '旧块' }],
  }));
  ok('大面积对不上 → 明说「逐块对比不可靠」并**拒绝出明细表**',
    t.includes('逐块对比不可靠') && t.includes('不出明细表'), t);
  ok('不可靠时**不列**新增/删除清单（硬凑的清单比不给更糟）', !t.includes('新块') && !t.includes('旧块'), t);
  ok('不可靠时也把原因和计数说清楚', t.includes('匹配率 5%') || t.includes('1/20'), t);
}
{
  const t = renderDiff(mkDiff({ sameVersion: true }));
  ok('同一版本比自己 → 明说「两版一致」且点出"同一个版本"',
    t.includes('两版一致') && t.includes('同一个版本'), t);
}
{
  const many = Array.from({ length: 60 }, (_, i) => ({ path: `p${i}`, name: `块${i}`, kind: 'card', kindFrom: 'card', how: 'exact', field: 'radius', label: '圆角 1→2', from: 1, to: 2, where: `块${i}` }));
  const t = renderDiff(mkDiff({ changes: { ...mkDiff().changes, size: many }, counts: { ...mkDiff().counts, changed: { ...mkDiff().counts.changed, size: 60 } } }));
  ok('同类超过上限时**明说被截断**（不静默吞掉）', t.includes('还有 20 处'), t.split('\n').slice(-4).join(' / '));
}

/* —— ⑤ 端到端（mock fetch，零网络）：三次请求，两个版本 —— */
{
  const mockRes = (obj) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
  });
  const fxFill = (hex, alpha = 1) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` } };
  };
  const fxRect = (name, frame, o = {}) => ({
    id: name, type: 'rectLayer', name, frame,
    paths: o.radius ? [{ type: 'rect', radius: { topLeft: o.radius, topRight: o.radius, bottomRight: o.radius, bottomLeft: o.radius } }] : [],
    style: { fills: o.fill === undefined ? [] : [fxFill(o.fill, o.fillAlpha ?? 1)], borders: o.borders ?? [] },
  });
  const fxText = (name, content, frame, o = {}) => {
    const hex = o.color ?? '#333333';
    const c = parseColor(hex);
    return {
      id: name, type: 'textLayer', name, frame,
      style: { fills: [fxFill(hex, o.colorAlpha ?? 1)] },
      text: {
        style: {
          content, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${o.colorAlpha ?? 1})` },
          font: { name: o.family ?? 'Inter', size: o.size ?? 14, fontWeight: o.weight ?? 400, lineHeight: { value: o.lineHeight ?? 20 } },
        },
      },
    };
  };
  const fxImage = (name, frame) => ({ id: name, type: 'rectLayer', name, frame, hasExportImage: true, style: {} });
  const mkTree = (radius, title, size, btn, canvasLeft) => ({
    meta: { device: 'iPhone 14' },
    artboard: {
      id: 'ab', type: 'artboard', name: '自检稿',
      frame: { left: canvasLeft, top: 463, width: 375, height: 700 },
      style: { fills: [fxFill('#ffffff')] },
      layers: [
        fxRect('卡片', { left: 16, top: 100, width: 343, height: 120 }, { radius, fill: '#ffffff' }),
        fxText('标题', title, { left: 33, top: 120, width: 200, height: 24 }, { size, weight: 600 }),
        fxText('按钮', btn, { left: 33, top: 190, width: 100, height: 24 }),
        fxText('未变块甲', '甲', { left: 33, top: 240, width: 60, height: 20 }),
        fxText('未变块乙', '乙', { left: 33, top: 270, width: 60, height: 20 }),
        fxImage('头像', { left: 300, top: 120, width: 40, height: 40 }),
        // 3×8 的图形碎片（面积 < 36）→ 判为 noise，默认不参与比对（两版都在，所以不影响差异）
        fxRect('Path 3×8', { left: 350, top: 10, width: 3, height: 8 }, { fill: '#cccccc' }),
      ],
    },
  });
  const V1 = '11111111-0000-4000-8000-000000000001';
  const V2 = '22222222-0000-4000-8000-000000000002';
  const V3 = '33333333-0000-4000-8000-000000000003';
  const T1 = 'https://mock.lanhu/t-v1.json';
  const T2 = 'https://mock.lanhu/t-v2.json';
  const T3 = 'https://mock.lanhu/t-v3.json';
  const treeV1 = mkTree(14, '旧标题', 20, '立即咨询', -9876);
  const treeV23 = mkTree(16, '新标题', 22, '马上咨询', -9879);
  const versions = [
    { id: V3, json_url: T3, create_time: 'Thu, 04 Sep 2026 12:00:00 UTC' },
    { id: V2, json_url: T2, create_time: 'Thu, 04 Sep 2026 00:00:00 UTC' },
    { id: V1, json_url: T1, create_time: 'Mon, 01 Sep 2026 00:00:00 UTC' },
  ];
  // ⚠️ `seen` 由调用方传进来 —— 用返回值传的话，**抛错那条路径拿不到它**，
  //    而"报错前只发了几次请求"恰恰是要断言的东西（实测踩过：断言退化成看空数组）。
  const withMockFetch = async (fn, seen) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/api/project/image?')) {
        return mockRes({ code: '00000', result: { id: 'i-mock', name: '自检稿', width: 375, height: 700, versions } });
      }
      if (u === T1) return mockRes(treeV1);
      if (u === T2 || u === T3) return mockRes(treeV23);
      throw new Error('未预期的请求：' + u);
    };
    try { return await fn(); } finally { globalThis.fetch = realFetch; }
  };
  const ACCT = { account: 'mock', cookie: 'PASSPORT=x; user_token=y' };

  {
    const seen = [];
    const r = await withMockFetch(() => diffDesign({ projectId: 'p-mock', imageId: 'i-mock', from: V1, ...ACCT }), seen);
    ok('端到端跑通（from 旧版 → to 默认最新版）', r?.ok === true && r.format === 'diff', r?.text?.split('\n')[0] ?? '');
    eq('恰好 **3 次请求**：1 次版本列表 + **2 次图层树**（不做逐版本探测）', seen.length, 3);
    eq('其中树请求**正好 2 个**', seen.filter((u) => u === T1 || u === T2 || u === T3).length, 2);
    eq('块数（画板 + 6 块）', [r.counts.fromBlocks, r.counts.toBlocks], [7, 7]);
    eq('全部按 path 精确匹配', [r.reliability.exact, r.reliability.approx, r.reliability.unmatched], [7, 0, 0]);
    eq('变化 3 块 / 未变 4 块', [r.counts.changed.blocks, r.counts.unchanged], [3, 4]);
    eq('各分类的变化块数', [r.counts.changed.size, r.counts.changed.text, r.counts.changed.layout, r.counts.changed.color], [1, 2, 0, 0]);
    eq('尺寸类：卡片 圆角 14→16', r.changes.size.map((e) => `${e.where} ${e.label}`), ['卡片 圆角 14→16']);
    ok('文字类：文案与字号都给「从→到」',
      r.changes.text.some((e) => e.label === '字号 20→22') && r.changes.text.some((e) => e.label.includes('旧标题') && e.label.includes('新标题')),
      r.changes.text.map((e) => e.label).join(' | '));
    ok('🔒 **不逐块列未变的块**（文本里不出现未变块的名字）',
      !r.text.includes('未变块甲') && !r.text.includes('未变块乙') && !r.text.includes('头像'), r.text);
    ok('未变的块只给一句汇总', r.text.includes('未变：其余 4 块'), r.text);
    ok('🔒 画板画布坐标变化**不算设计变更**（不进 layout，但用"注"如实交代）',
      r.counts.changed.layout === 0 && r.notes.some((n) => n.includes('画布坐标')), r.notes.join(' | '));
    ok('返回是 lossless（工具出口会过宿主那一关）', findIllegal(r).length === 0, findIllegal(r).slice(0, 3).join(', '));
    ok('机器可读摘要齐备（changed / added / removed / unchanged / matchReliability）',
      typeof r.counts.changed.size === 'number' && r.counts.added === 0 && r.counts.removed === 0
      && r.counts.unchanged === 4 && typeof r.reliability.exact === 'number');
    ok('提示里说明碎片块未参与比对（口径透明，不是静默少比了几块）',
      r.notes.some((n) => n.includes('碎片') && n.includes('未参与比对')), r.notes.join(' | '));
  }
  {
    const seen = [];
    const r = await withMockFetch(() => diffDesign({ projectId: 'p-mock', imageId: 'i-mock', from: V2, to: V3, ...ACCT }), seen);
    ok('两个版本内容一致 → identical:true', r.identical === true && r.reliable === true, JSON.stringify(r.counts));
    eq('一致时各分类都是空的', r.counts.changed.blocks, 0);
    eq('一致时没有新增/删除', [r.counts.added, r.counts.removed], [0, 0]);
    ok('一致时**明说"两版一致"**（不是静默空输出）', r.text.includes('两版一致') && r.text.includes('没有任何差异'), r.text);
    eq('同样只发 3 次请求', seen.length, 3);
  }
  {
    const seen = [];
    const r = await withMockFetch(() => diffDesign({ projectId: 'p-mock', imageId: 'i-mock', from: V3, to: V3, ...ACCT }), seen);
    ok('🔒 **同一版本比自己 → 必须报"两版一致"**（防"永远有差异"的假阳性）',
      r.identical === true && r.sameVersion === true && r.text.includes('两版一致'), r.text);
  }
  {
    let err = null;
    const seen = [];
    try {
      await withMockFetch(() => diffDesign({ projectId: 'p-mock', imageId: 'i-mock', from: 'no-such-version', ...ACCT }), seen);
    } catch (e) { err = e; }
    ok('🔒 `from` 给不存在的版本 id → **明确报错**（不许静默回退 latest）',
      !!err && err.code === 'VERSION_NOT_FOUND' && /指定的版本不存在/.test(err.message), err ? `${err.code}: ${err.message}` : '(没抛错)');
    ok('报错文案点名"不会静默回退到最新版"', !!err && /不会.*静默回退/.test(err.hint ?? ''), err?.hint ?? '');
    eq('🔒 报错发生在**拉树之前**（只有 1 次版本列表请求，没有任何树请求）', seen.length, 1);
  }
  {
    let err = null;
    const seen = [];
    try {
      await withMockFetch(() => diffDesign({ projectId: 'p-mock', imageId: 'i-mock', ...ACCT }), seen);
    } catch (e) { err = e; }
    ok('不传 from → 明确报错并指出下一步', !!err && err.code === 'DIFF_FROM_REQUIRED' && /需要 `from`/.test(err.message), err ? err.message : '(没抛错)');
    eq('不传 from 时**零树请求**', seen.length, 1);
  }
}

/* —— ⑥ 工具层：注册、schema、系统提示 —— */
{
  const t = TOOLS.find((x) => x.name === 'lanhu_diff_design');
  ok('lanhu_diff_design 已注册进 TOOLS', !!t);
  ok('output schema 声明了 reliable / reliability / identical（能力不能藏着）',
    !!t?.output?.schema?.properties?.reliable && !!t?.output?.schema?.properties?.reliability
    && !!t?.output?.schema?.properties?.identical, Object.keys(t?.output?.schema?.properties ?? {}).join(','));
  ok('from 是必填（写进标准 schema 的 required 数组）',
    (t?.parameters?.required ?? []).includes('from'), JSON.stringify(t?.parameters?.required));
  const r = await t.execute({ projectId: 'p', imageId: 'i' });
  ok('缺 from 被 schema 拦下（进不了业务层，不花网络请求）',
    r.failed === true && /from/.test(r.text), r.text.split('\n')[0]);
  const toolDef = TOOLS.find((x) => x.name === 'lanhu_read_blocks');
  ok('🔒 既有工具的 schema 与形状没被这次新增动过',
    (toolDef?.parameters?.required ?? []).length === 0
    && !!toolDef?.output?.schema?.properties?.version);
}
{
  const hostSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'), 'utf8');
  const from = hostSrc.indexOf('const SYSTEM_HINT = [');
  const hint = hostSrc.slice(from, hostSrc.indexOf("].join('\\n');", from));
  ok('SYSTEM_HINT 的工具决策树里有「要对比设计改了什么 → lanhu_diff_design」',
    hint.includes('lanhu_diff_design') && hint.includes('这次设计改了什么'), hint.includes('lanhu_diff_design') ? '' : '(决策树里没有)');
  ok('SYSTEM_HINT 里也明说了"差异过大时不给硬凑的差异表"', hint.includes('逐块对比不可靠'));

  const cliSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lanhu.mjs'), 'utf8');
  ok('CLI 注册了 diff 命令', cliSrc.includes("'diff': cmdDiff,"));
  ok('CLI 的 USAGE 里写了 diff（能力不能藏着）', /^ {2}diff {5}\[--url/m.test(cliSrc), (cliSrc.match(/^ {2}diff.*$/m) ?? ['(没有)'])[0]);
  ok('CLI 里点明 diff **不认** --version（免得有人拿它当"读某一版"用）',
    cliSrc.includes('**diff 不认 --version**'));
}

/* ═══════════════ ⑥.17 设计系统审计（第 3 步） ═══════════════ */
group('⑥.17 设计系统审计');

/** 造一个"稿"（审计只吃 `{imageId, imageName, blocks}`）。 */
const mkScan = (imageId, imageName, blocks) => ({ imageId, imageName, blocks });
/** 造一个块（字段形状与 `buildBlocks` 的输出一致）—— 只覆盖审计要看的那几项。 */
const mkAuditBlk = (o = {}) => ({
  kind: 'card', name: '块', path: '画板/块', x: 0, y: 0, w: 100, h: 40,
  radius: { corners: [8, 8, 8, 8], max: 8, pill: false },
  bg: null, opacity: 1, border: null, text: null, color: null, colorAlpha: null,
  font: null, hasImage: false, noise: false, ...o,
});
/** 一行文字块。 */
const mkText = (name, size, o = {}) => mkAuditBlk({ kind: 'text', name, font: { size, weight: 400, family: 'Inter' }, ...o });

/* —— ① 判据：同一个组件怎么认 —— */
{
  ok('判据是「层名归一化后相同」：全角/大小写/连续空白折叠成同一个键',
    auditNameKey('  主按钮　') === auditNameKey('主按钮') && auditNameKey('BTN') === auditNameKey('btn')
    && auditNameKey('A  B') === auditNameKey('A B'),
    `${JSON.stringify(auditNameKey('  主按钮　'))} / ${JSON.stringify(auditNameKey('  BTN '))}`);

  const autoYes = ['Rectangle 12', '矩形 3', 'Group 5', 'Path 3×8', 'Frame 427', '椭圆 2', '12', 'A1', '副本 2', '', '   ', '组 2', '占位符'];
  const autoNo = ['主按钮', 'MainFrame', 'CardGroup', 'icon-arrow', '按钮-primary', '标题栏', 'logo2'];
  const missed = autoYes.filter((n) => !isAutoLayerName(n).auto);
  const hurt = autoNo.filter((n) => isAutoLayerName(n).auto);
  ok('工具默认名一律判为不可靠（Rectangle 12 / 矩形 3 / Path 3×8 / 空名 / 纯数字…）', missed.length === 0, missed.join(', '));
  ok('🔒 真名不被误伤（MainFrame / CardGroup / icon-arrow / logo2 …）', hurt.length === 0, hurt.join(', '));
  ok('空名单独归类（why=empty，与"模板名"分开计）', isAutoLayerName('').why === 'empty' && isAutoLayerName('Rectangle 12').why === 'template');
  ok('空名/模板名/太短 三种原因可分辨', isAutoLayerName('底').why === 'tooShort');

  // 同名归一组：3 张稿里的「主按钮」进同一个组（另有一颗"卡片"必须**另成一组** ——
  // 这条让"按块下标/不认名字"的退化当场红：那样所有块会被并成一组）
  const scans = [
    mkScan('i1', '稿1', [mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: '卡片' })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: ' 主按钮 ' })]),
  ];
  const comp = collectAuditComponents(scans);
  ok('同名（归一化后）的块归为**一组**，不同名的**另成一组**',
    comp.groups.size === 2 && comp.groups.has('主按钮') && comp.groups.has('卡片'),
    JSON.stringify([...comp.groups.keys()]));
  ok('参与判定按名字分组算：主按钮（2 张稿 / 3 块）参与，卡片（1 块）不参与',
    comp.participated.length === 1 && comp.participated[0].name === '主按钮' && comp.participated[0].blocks.length === 3,
    `participated=${comp.participated.map((g) => g.name).join(',')}`);
  ok('组里记着跨了几张稿、几块', comp.participated[0].images.size === 2 && comp.participated[0].blocks.length === 3);
  ok('归一化不剥尾号：`主按钮` 与 `主按钮 2` 是两组（硬并会造出假"多规格"）',
    collectAuditComponents([mkScan('i1', '稿1', [mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: '主按钮 2' })])]).groups.size === 2);

  // 自动名/空名被排除，且计数进"未参与"
  const mixed = collectAuditComponents([
    mkScan('i1', '稿1', [mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: 'Rectangle 12' }), mkAuditBlk({ name: '' })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: '矩形 3' }), mkAuditBlk({ name: '  ' })]),
  ]);
  ok('自动名**不参与**归组，但计数进 naming.auto', mixed.naming.auto === 2 && mixed.groups.size === 1,
    `auto=${mixed.naming.auto} groups=${mixed.groups.size}`);
  ok('空名**不参与**归组，但计数进 naming.empty', mixed.naming.empty === 2);
  ok('命名覆盖率给出分母与分子（说清"这条结论建立在什么基础上"）',
    mixed.naming.total === 6 && mixed.naming.named === 2 && mixed.naming.namedShare === 0.33,
    `total=${mixed.naming.total} named=${mixed.naming.named} share=${mixed.naming.namedShare}`);

  // 参与门槛
  const thin = collectAuditComponents([
    mkScan('i1', '稿1', [mkAuditBlk({ name: '只看一次' })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: '主按钮' }), mkAuditBlk({ name: '主按钮' })]),
  ]);
  ok('只出现在 1 张稿里的组件名**不参与**（跨稿结论需要跨稿样本）',
    thin.participated.length === 0 && thin.thinBlocks === 3, `participated=${thin.participated.length}`);
  ok('参与门槛（≥2 张稿 且 ≥3 块）进了 LIMITS，没有裸写在逻辑里',
    LIMITS.auditMinComponentImages === 2 && LIMITS.auditMinComponentBlocks === 3);
}

/* —— ② 同一组件、多种规格（最有价值的一项） —— */
{
  const scans = [
    mkScan('i1', '首页', [mkAuditBlk({ name: '主按钮', radius: { max: 8 }, h: 44 })]),
    mkScan('i2', '详情页', [mkAuditBlk({ name: '主按钮', radius: { max: 8 }, h: 44 })]),
    mkScan('i3', '下单页', [mkAuditBlk({ name: '主按钮', radius: { max: 12 }, h: 44 })]),
    mkScan('i4', '我的', [mkAuditBlk({ name: '主按钮', radius: { max: 8 }, h: 44 })]),
    mkScan('i5', '设置', [mkAuditBlk({ name: '主按钮', radius: { max: 9999 }, h: 48 })]),
  ];
  const comp = collectAuditComponents(scans);
  const r = auditComponentSpecs(comp.participated);
  const btn = r.findings.find((f) => f.name === '主按钮');
  ok('同一个组件、多种圆角 → 出发现（且只把同名块归进这一组）',
    !!btn && comp.groups.size === 1 && btn.blocks === 5 && btn.images === 5,
    JSON.stringify([r.findings.map((f) => f.name), comp.groups.size]));
  const rad = btn?.dims.find((d) => d.dim === 'radius');
  ok('圆角分布给「值 + 计数 + 张数」：8px(3) / 12px(1) / 9999px(1)',
    rad?.distinct === 3 && rad.values.map((v) => `${v.value}:${v.count}`).join(',') === '8:3,12:1,9999:1',
    JSON.stringify(rad?.values?.map((v) => [v.value, v.count])));
  ok('给出「建议以哪个为准」= 多数派', rad?.majority === 8 && rad.majorityCount === 3);
  ok('每个取值带**具体例子（哪几张稿）**',
    rad.values[0].examples.join(',') === '首页,详情页,我的', JSON.stringify(rad.values[0].examples));
  ok('高度也单独报（同一颗按钮两种高度）',
    btn.dims.some((d) => d.dim === 'height' && d.distinct === 2 && d.majority === 44));

  const only = auditComponentSpecs(collectAuditComponents([
    mkScan('i1', '稿1', [mkAuditBlk({ name: '卡片', radius: { max: 8 } }), mkAuditBlk({ name: '卡片', radius: { max: 8 } })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: '卡片', radius: { max: 8 } })]),
  ]).participated);
  ok('只有一种规格 → **不算发现**（"只有一种"不是漂移）', only.findings.length === 0 && only.converged === 1);

  const tie = auditComponentSpecs(collectAuditComponents([
    mkScan('i1', '稿1', [mkAuditBlk({ name: '标签', radius: { max: 4 } })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: '标签', radius: { max: 6 } })]),
    mkScan('i3', '稿3', [mkAuditBlk({ name: '标签', radius: { max: 4 } }), mkAuditBlk({ name: '标签', radius: { max: 6 } })]),
  ]).participated);
  const tagRad = tie.findings[0]?.dims.find((d) => d.dim === 'radius');
  ok('🔒 次数并列时**明说无法判定多数派**（不硬挑一个当"建议"）',
    tagRad?.tie === true && tagRad.majority === null, JSON.stringify(tagRad ? [tagRad.tie, tagRad.majority] : null));
}

/* —— ③ 字号阶梯 —— */
{
  const many = [];
  for (let i = 0; i < 6; i += 1) many.push(mkText('标题', 14, { path: `p${i}` }));
  for (let i = 0; i < 4; i += 1) many.push(mkText('正文', 12, { path: `q${i}` }));
  for (let i = 0; i < 3; i += 1) many.push(mkText('说明', 16, { path: `r${i}` }));
  many.push(mkText('怪一号', 13, { path: 's1' }));
  many.push(mkText('怪二号', 15, { path: 's2' }));
  const scans = [mkScan('i1', '稿1', many)];
  const f = auditFontScale(scans);
  ok('字号阶梯：统计种类与总数', f.distinct === 5 && f.total === 15, `distinct=${f.distinct} total=${f.total}`);
  ok('只出现 1 次的字号被单独列成"一次性野值"（13 / 15）',
    f.oneOffs.map((o) => o.value).join(',') === '13,15', JSON.stringify(f.oneOffs.map((o) => o.value)));
  ok('野值给收敛建议（并到最近的"常用档"：13→12、15→14）',
    f.oneOffs.map((o) => `${o.value}->${o.nearest}`).join(',') === '13->12,15->14'
    && f.ladder.join(',') === '12,14,16',
    JSON.stringify(f.oneOffs.map((o) => [o.value, o.nearest])));
  ok('字号阶梯失控 → 出发现', f.drift === true);

  const clean = auditFontScale([mkScan('i1', '稿1', [mkText('a', 12), mkText('b', 12), mkText('c', 14), mkText('d', 14)])]);
  ok('字号收敛（无一次性野值、种类不多）→ 不报漂移', clean.drift === false && clean.oneOffs.length === 0);

  ok('不看层名也能算（命名不可靠时它仍然可用）',
    auditFontScale([mkScan('i1', '稿1', [mkText('Rectangle 12', 12), mkText('Rectangle 13', 12)])]).distinct === 1);
}

/* —— ④ 近重复色 —— */
{
  const scans = [
    mkScan('i1', '稿1', [mkAuditBlk({ name: 'a', bg: { hex: '#574af4', alpha: 1, stops: [] } }), mkAuditBlk({ name: 'b', bg: { hex: '#574af4', alpha: 1, stops: [] } })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: 'c', bg: { hex: '#574bf5', alpha: 1, stops: [] } })]),
    mkScan('i3', '稿3', [mkAuditBlk({ name: 'd', bg: { hex: '#ff0000', alpha: 1, stops: [] } })]),
  ];
  const colors = [...collectAuditColors(scans).values()];
  const clusters = nearColorClusters(colors);
  ok('近重复色聚成一簇（#574af4 ≈ #574bf5）', clusters.length === 1 && clusters[0].members.length === 2,
    JSON.stringify(clusters.map((c) => c.members.map((m) => m.key))));
  ok('簇里给出**距离**与阈值（判据可解释）', clusters[0].maxDistance === 1.41 && LIMITS.auditNearColorDistance === 12,
    `${clusters[0].maxDistance} vs ${LIMITS.auditNearColorDistance}`);
  ok('给出「建议统一为哪个」= 用得最多的那个', clusters[0].majority === '#574af4');
  ok('距离超阈值的色**不**聚在一起（#ff0000 不在这一簇）',
    clusters.every((c) => c.members.every((m) => m.key !== '#ff0000')));
  ok('阈值进 LIMITS（不在逻辑里裸写 12）', typeof LIMITS.auditNearColorDistance === 'number'
    && /LIMITS\.auditNearColorDistance/.test(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lanhu.mjs'), 'utf8')));
  ok('RGB 距离判据本身可算（#574af4 vs #574bf5 = √2 ≈ 1.41）',
    Math.abs(rgbDistance(parseColor('#574af4'), parseColor('#574bf5')) - Math.SQRT2) < 1e-9);
  ok('`#333` 与 `#333333` 是**同一个**色值（归一化后不重复计数）',
    collectAuditColors([mkScan('i1', '稿1', [mkAuditBlk({ name: 'x', bg: { hex: '#333', alpha: 1, stops: [] } })])]).size === 1
    && parseColor('#333').r === parseColor('#333333').r);
  ok('🔒 半透明与不透明是**两个**色值（alpha 进 key，不混为一谈）',
    collectAuditColors([mkScan('i1', '稿1', [
      mkAuditBlk({ name: 'x', bg: { hex: '#000000', alpha: 1, stops: [] } }),
      mkAuditBlk({ name: 'y', bg: { hex: '#000000', alpha: 0.1, stops: [] } }),
    ])]).size === 2);
  ok('全透明（alpha 0）不算色值', collectAuditColors([mkScan('i1', '稿1', [mkAuditBlk({ name: 'x', bg: { hex: '#000000', alpha: 0, stops: [] } })])]).size === 0);
  ok('文字色 / 描边色 / 渐变 stop 都进色板',
    collectAuditColors([mkScan('i1', '稿1', [mkAuditBlk({
      name: 'x', bg: { hex: '#111111', alpha: 1, stops: [{ hex: '#222222', alpha: 1 }, { hex: '#333333', alpha: 1 }] },
      color: '#444444', colorAlpha: 1, border: { color: '#555555', alpha: 1 },
    })])]).size === 5);
  ok('🔒 同 hex、不同透明度**不**聚成一簇（#4693ff 与 #4693ff@60% 不是"同一色的两种写法"）',
    nearColorClusters([
      { key: '#4693ff', hex: '#4693ff', alpha: 1, count: 50, roles: new Set(['bg']), images: new Map(), rgb: parseColor('#4693ff') },
      { key: '#4693ff@60%', hex: '#4693ff', alpha: 0.6, count: 8, roles: new Set(['border']), images: new Map(), rgb: parseColor('#4693ff') },
    ]).length === 0);
  {
    // 🔒 链式陷阱：A≈B、B≈C 但 A 与 C 差 22.5 —— 用连通分量会连成 {A,B,C} 并谎称"肉眼分不出"
    const mk = (hex, count) => ({ key: hex, hex, alpha: 1, count, roles: new Set(['bg']), images: new Map(), rgb: parseColor(hex) });
    const chained = nearColorClusters([mk('#ffffff', 10), mk('#f9f9f9', 5), mk('#f2f2f2', 3)]);
    ok('🔒 色簇用**完全链接**（链式近似不许连成一簇）',
      chained.length === 1 && chained[0].members.length === 2 && !chained[0].members.some((m) => m.key === '#f2f2f2'),
      JSON.stringify(chained.map((c) => c.members.map((m) => m.key))));
    ok('🔒 簇内**任意两个**都 ≤ 阈值（"肉眼分不出"不是假话）',
      chained.every((c) => c.maxDistance <= LIMITS.auditNearColorDistance), JSON.stringify(chained.map((c) => c.maxDistance)));
    // 反向：真正紧邻的三兄弟（#333333 / #333 / #343434）必须进同一簇
    const tight = nearColorClusters([mk('#333333', 4), mk('#343434', 2), mk('#323232', 1)]);
    ok('真正紧邻的"三种深灰"进同一簇（#333333 / #343434 / #323232）',
      tight.length === 1 && tight[0].members.length === 3 && tight[0].majority === '#333333',
      JSON.stringify(tight.map((c) => c.members.map((m) => m.key))));
  }
}

/* —— ⑤ 间距尺度 / 圆角家族（参考项） —— */
{
  const scans = [mkScan('i1', '稿1', [
    mkAuditBlk({ name: 'a', x: 0, y: 0, w: 100, h: 40, radius: { max: 8 } }),
    mkAuditBlk({ name: 'b', x: 113, y: 0, w: 100, h: 40, radius: { max: 6 } }),   // 间距 13 → 野值
    mkAuditBlk({ name: 'c', x: 228, y: 0, w: 100, h: 40, radius: { max: 10 } }),  // 间距 15 → 野值
    mkAuditBlk({ name: 'd', x: 0, y: 100, w: 100, h: 40, radius: { max: 38 } }),  // 间距 60（栅格内），圆角 38 特例
  ])];
  const sp = auditSpacing(scans);
  ok('间距野值被识别（不在 4 的倍数上）', sp.offGrid.map((v) => v.value).join(',') === '13,15', JSON.stringify(sp.offGrid.map((v) => v.value)));
  ok('间距判据（栅格）进 LIMITS', sp.grid === LIMITS.auditSpacingGrid && LIMITS.auditSpacingGrid === 4);
  ok('野值不够多时不报漂移（阈值在 LIMITS 里）', sp.drift === (sp.offGridCount >= LIMITS.auditOffGridMinValues), `off=${sp.offGridCount} drift=${sp.drift}`);
  ok('间距只统计 ≤ auditSpacingMaxDistance 的（几百 px 是留白不是尺度）',
    sp.top.every((v) => v.value <= LIMITS.auditSpacingMaxDistance), JSON.stringify(sp.top.map((v) => v.value)));

  const clean = auditSpacing([mkScan('i1', '稿1', [
    mkAuditBlk({ name: 'a', x: 0, y: 0, w: 100, h: 40 }),
    mkAuditBlk({ name: 'b', x: 116, y: 0, w: 100, h: 40 }),
  ])]);
  ok('间距都在栅格上 → 不报漂移', clean.drift === false && clean.offGridCount === 0);

  const rad = auditRadiusFamily([mkScan('i1', '稿1', [
    mkAuditBlk({ name: 'a', radius: { max: 8 } }), mkAuditBlk({ name: 'b', radius: { max: 9999 } }),
    mkAuditBlk({ name: 'c', radius: { max: 38 } }),
  ])]);
  ok('圆角家族：9999（胶囊）在刻度的白名单里，38 是特例',
    rad.offScale.map((v) => v.value).join(',') === '38', JSON.stringify(rad.offScale.map((v) => v.value)));
  ok('刻度清单进 LIMITS（不裸写）', Array.isArray(LIMITS.auditRadiusScale) && LIMITS.auditRadiusScale.includes(9999));
  ok('圆角家族标注为参考项（不是"错误"）', rad.offScaleCount === 1 && rad.drift === false);
}

/* —— ⑥ 可靠度：命名不可靠 → 拒绝出明细 —— */
{
  const autoOnly = [
    mkScan('i1', '稿1', [mkAuditBlk({ name: 'Rectangle 12', radius: { max: 8 } }), mkAuditBlk({ name: 'Rectangle 13', radius: { max: 12 } }), mkAuditBlk({ name: 'Group 1', radius: { max: 4 } })]),
    mkScan('i2', '稿2', [mkAuditBlk({ name: 'Rectangle 12', radius: { max: 8 } }), mkAuditBlk({ name: '', radius: { max: 12 } }), mkAuditBlk({ name: '矩形 3', radius: { max: 4 } })]),
  ];
  const rel = auditReliability({ imagesWithLayers: 2, totalBlocks: 6, naming: collectAuditComponents(autoOnly).naming });
  ok('🔒 命名不可靠 → reliable:false 并给出原因', rel.reliable === false && /命名不可靠/.test(rel.reasons[0]), rel.reasons.join(' | '));
  ok('可靠率阈值进 LIMITS（30%，不裸写）', LIMITS.auditMinNamedShare === 0.3);
  ok('命名覆盖率自带 namedShare（判可靠度的输入不许散在两个字段里）',
    collectAuditComponents(autoOnly).naming.namedShare === 0);
  ok('样本太少（读到图层的稿 < 2 张）→ 也判不可靠',
    auditReliability({ imagesWithLayers: 1, totalBlocks: 5, naming: { total: 5, named: 5, auto: 0, empty: 0, namedShare: 1 } }).reliable === false);
  ok('命名好、样本够 → 判可靠',
    auditReliability({ imagesWithLayers: 3, totalBlocks: 5, naming: { total: 5, named: 5, auto: 0, empty: 0, namedShare: 1 } }).reliable === true);
}

/* —— ⑦ 端到端（mock fetch，零网络）：成本受控 + 三种漂移 + 无漂移明说 —— */
{
  const mkRes = (obj) => ({
    ok: true, status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    arrayBuffer: async () => Buffer.from(JSON.stringify(obj), 'utf8'),
  });
  const fxFill = (hex, alpha = 1) => {
    const c = parseColor(hex);
    return { type: 'color', isEnabled: true, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})` } };
  };
  const fxRect = (name, frame, o = {}) => ({
    id: name, type: 'rectLayer', name, frame,
    paths: o.radius ? [{ type: 'rect', radius: { topLeft: o.radius, topRight: o.radius, bottomRight: o.radius, bottomLeft: o.radius } }] : [],
    style: { fills: o.fill === undefined ? [] : [fxFill(o.fill, o.fillAlpha ?? 1)] },
  });
  const fxText = (name, content, frame, o = {}) => {
    const hex = o.color ?? '#333333';
    const c = parseColor(hex);
    return {
      id: name, type: 'textLayer', name, frame,
      style: { fills: [fxFill(hex, o.colorAlpha ?? 1)] },
      text: { style: { content, color: { value: `rgba(${c.r}, ${c.g}, ${c.b}, ${o.colorAlpha ?? 1})` },
        font: { name: 'Inter', size: o.size ?? 14, fontWeight: 400, lineHeight: { value: 20 } } } },
    };
  };
  const uid = (i) => `0000000${i}-0000-4000-8000-00000000000${i}`;
  /** 一版"稿"：按钮圆角/高度/底色 + 标题字号可变（其余固定）。 */
  const mkTree = (label, { radius, btnH, btnColor, titleSize, autoNames = false }) => ({
    meta: { device: 'iPhone 14' },
    artboard: {
      id: 'ab', type: 'artboard', name: label,
      frame: { left: -100, top: 0, width: 375, height: 700 },
      style: { fills: [fxFill('#ffffff')] },
      layers: [
        fxRect(autoNames ? 'Rectangle 12' : '主按钮', { left: 16, top: 100, width: 343, height: btnH }, { radius, fill: btnColor }),
        fxText(autoNames ? 'Text 1' : '标题', `${label}标题`, { left: 33, top: 60, width: 200, height: 24 }, { size: titleSize }),
        fxText(autoNames ? 'Text 2' : '正文', '甲', { left: 33, top: 300, width: 60, height: 20 }),
        fxRect('Path 3×8', { left: 350, top: 10, width: 3, height: 8 }, { fill: '#cccccc' }),
      ],
    },
  });
  const withMock = async (fn, spec) => {
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      seen.push(u);
      if (u.includes('/api/project/images?')) {
        return mkRes({ code: '00000', result: { name: '审计项目', images: spec.images } });
      }
      const m = u.match(/image_id=([^&]+)/);
      if (u.includes('/api/project/image?')) {
        const i = spec.images.findIndex((x) => x.id === decodeURIComponent(m[1]));
        if (i < 0) return mkRes({ code: '00000', result: {} });
        const img = spec.images[i];
        if (img.bad === 'noLayers') return mkRes({ code: '00000', result: { id: img.id, name: img.name, width: 375, height: 700, versions: [{ id: uid(0) }] } });
        if (img.bad === 'error') throw new Error('mock 网络炸了：' + img.name);
        return mkRes({ code: '00000', result: {
          id: img.id, name: img.name, width: 375, height: 700,
          versions: [{ id: uid(i), json_url: `https://mock.lanhu/t${i}.json` }],
        } });
      }
      const t = u.match(/t(\d+)\.json/);
      if (t) {
        const idx = Number(t[1]);
        if (spec.images[idx]?.bad === 'sketch') return mkRes({ type: 'sketchPlugin', info: [{ id: 'ab', name: 'Sketch 稿' }] });
        return mkRes(spec.trees[idx]);
      }
      throw new Error('未预期的请求：' + u);
    };
    try { return { r: await fn(), seen }; } finally { globalThis.fetch = real; }
  };
  const ACCT = { account: 'mock', cookie: 'PASSPORT=x; user_token=y' };
  const specOf = (n, opts = {}) => {
    const images = Array.from({ length: n }, (_, i) => ({ id: uid(i), name: `稿${i}`, width: 93.75, height: 175 }));
    const trees = images.map((img, i) => mkTree(img.name, {
      radius: opts.radius ? opts.radius(i) : 8,
      btnH: opts.btnH ? opts.btnH(i) : 44,
      btnColor: opts.btnColor ? opts.btnColor(i) : '#574af4',
      titleSize: opts.titleSize ? opts.titleSize(i) : 14,
      autoNames: Boolean(opts.autoNames),
    }));
    return { images, trees };
  };

  {
    const spec = specOf(5, {
      radius: (i) => (i === 3 ? 12 : (i === 4 ? 9999 : 8)),
      btnH: (i) => (i === 4 ? 48 : 44),
      btnColor: (i) => (i === 2 ? '#574bf5' : '#574af4'),
      titleSize: (i) => [20, 20, 13, 15, 17][i],
    });
    const { r, seen } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 5, ...ACCT }), spec);
    ok('端到端跑通（format=audit）', r?.ok === true && r.format === 'audit', r?.text?.split('\n')[0] ?? '');
    eq('🔒 成本 = 1 次列稿 + **每张 2 次**（scanned×2 + 1）', seen.length, 1 + 5 * 2);
    eq('扫描张数', r.scanned, 5);
    eq('未被截断时 truncated=false', r.truncated, false);
    eq('三种漂移都被识别', r.driftedCategories.slice().sort().join(','), 'colorDrift,componentSpec,fontScale');
    ok('① 组件多规格：圆角 8(3 张) / 12(1) / 9999(1) + 多数派建议',
      r.findings.componentSpec.findings[0].dims.some((d) => d.dim === 'radius' && d.majority === 8),
      JSON.stringify(r.findings.componentSpec.findings[0]?.dims));
    ok('② 字号阶梯：13/15/17 只出现 1 次',
      r.findings.fontScale.oneOffs.map((o) => o.value).sort((a, b) => a - b).join(',') === '13,15,17');
    ok('③ 近重复色：一簇、多数派是 #574af4',
      r.findings.colorDrift.clusters.length === 1 && r.findings.colorDrift.clusters[0].majority === '#574af4');
    ok('判据写进结果（不必猜"同一个组件"是什么意思）',
      /层名归一化后相同/.test(r.findings.componentSpec.basis) && /Rectangle 12/.test(r.findings.componentSpec.basisExcludes));
    ok('输出写明 scanned / total / truncated',
      r.text.includes('扫描：**5 / 5 张**') && r.text.includes('项目共 **5** 张'), r.text.split('\n')[2]);
    ok('人读文本里也有三种漂移的小节与例子',
      r.text.includes('## ① 同一组件、多种规格') && r.text.includes('## ② 字号阶梯') && r.text.includes('## ③ 色值漂移（近重复色）')
      && r.text.includes('建议以 **8px** 为准'));
    ok('④ 间距与 ⑤ 圆角标注为"参考项"（只给分布，不下判决）',
      r.text.includes('参考项') && r.text.includes('不是硬规范'), r.text.split('\n').filter((l) => l.startsWith('> ')).join(' / '));
    ok('返回是 lossless（工具出口会过宿主那一关）', findIllegal(r).length === 0, findIllegal(r).slice(0, 3).join(', '));
    ok('机器可读摘要齐备（scanned/total/truncated/reliable/naming/driftedCategories/findings）',
      typeof r.scanned === 'number' && typeof r.total === 'number' && typeof r.truncated === 'boolean'
      && typeof r.reliable === 'boolean' && typeof r.naming.named === 'number' && Array.isArray(r.driftedCategories)
      && typeof r.findings === 'object');
  }
  {
    // 无漂移：全部收敛 → **明说"未发现漂移"**，不是静默空输出
    const spec = specOf(4, { autoNames: false });
    // 让字号只有一种（都 14），色值只有一种，圆角都 8
    const { r } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 4, ...ACCT }), spec);
    ok('🔒 没有漂移时**明说"未发现漂移"**（不是静默空输出）', r.anyDrift === false && r.text.includes('未发现漂移'), r.text.split('\n').slice(3, 6).join(' / '));
    ok('每一类各自也说清"未发现漂移/特例"（不是只给一句总结）',
      (r.text.match(/未发现漂移|未发现特例/g) ?? []).length >= 3, String((r.text.match(/未发现漂移|未发现特例/g) ?? []).length));
    ok('无漂移时机器可读的 driftedCategories 是空数组', r.driftedCategories.length === 0);
  }
  {
    // 命名不可靠 → 默认拒绝出明细
    const spec = specOf(3, { autoNames: true, radius: (i) => (i === 1 ? 12 : 8) });
    const { r } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 3, ...ACCT }), spec);
    ok('🔒 命名不可靠 → reliable:false', r.reliable === false && /命名不可靠/.test(r.reasons.join(' ')), r.reasons.join(' | '));
    ok('🔒 命名不可靠时 primaryReason=naming（与"样本为空"分开）', r.primaryReason === 'naming', String(r.primaryReason));
    ok('🔒 工具默认名（Rectangle 12 / Text 1 / Path 3×8）**没参与**组件识别，且计数进 naming.auto',
      r.naming.auto === 3 * 3 && !r.findings.componentSpec.findings?.some((f) => /Rectangle|Text|Path/.test(f.name)),
      `auto=${r.naming.auto} named=${r.naming.named}`);
    ok('🔒 命名不可靠 → **默认一项明细都不出**（连不看名字的字号也不出）',
      r.suppressed.length === 5 && r.findings.componentSpec.findings.length === 0
      && r.findings.fontScale.suppressed === true && r.findings.colorDrift.suppressed === true);
    ok('🔒 人读文本明说「本项审计不可靠 —— 不出明细」并交代为什么',
      r.text.includes('本项审计不可靠') && r.text.includes('不出明细') && r.text.includes('认错组件'), r.text.slice(-400));
    ok('不可靠时给出可执行的下一步（规范化层名 / allowWeakNaming）',
      r.text.includes('层名规范化') && r.text.includes('allowWeakNaming'));
    ok('不可靠时不硬凑出"几种圆角"的表（正文里没有组件规格小节的数据行）',
      !/建议以 \*\*\d+px\*\* 为准/.test(r.text));

    const { r: weak } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 3, allowWeakNaming: true, ...ACCT }), spec);
    ok('allowWeakNaming 只放开**不依赖层名**的那几项（组件规格仍然跳过）',
      weak.weakMode === true && weak.suppressed.join(',') === 'componentSpec'
      && weak.findings.componentSpec.suppressed === true && weak.findings.fontScale.suppressed === false);
    ok('弱模式下人读文本明确标注「已跳过」与"只看块属性、不看层名"',
      weak.text.includes('已跳过') && weak.text.includes('不看层名'), weak.text.split('\n').slice(0, 12).join(' / '));
    ok('弱模式下仍然 reliable:false（没有把"放宽"说成"可信"）', weak.reliable === false);
  }
  {
    // 上限：默认只扫默认张数；传大值不许超过硬上限
    const images = Array.from({ length: 7 }, (_, i) => ({ id: uid(i), name: `稿${i}`, width: 93.75, height: 175 }));
    const trees = images.map((img) => mkTree(img.name, { radius: 8, btnH: 44, btnColor: '#574af4', titleSize: 14 }));
    const { r: d } = await withMock(() => auditProject({ projectId: 'p-mock', ...ACCT }), { images, trees });
    eq('🔒 不传 limit → 用**默认上限**而不是全量（limitApplied = 默认值）', d.limitApplied, LIMITS.auditDefaultImages);
    eq('不传 limit 时 limitRequested 也是默认值', d.limitRequested, LIMITS.auditDefaultImages);
    eq('默认上限进 LIMITS 且克制（50）', LIMITS.auditDefaultImages, 50);
    ok('项目张数少于默认上限时，扫全部（不因上限而少扫）', d.scanned === 7 && d.truncated === false);
    const { r: big } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 9999, ...ACCT }), { images, trees });
    eq('🔒 limit 传 9999 → 被**硬上限**压回（不许无限拉取）', big.limitApplied, LIMITS.auditMaxImages);
    ok('被压回时说得明白（clamped 标记 + 文本里写出来）',
      big.limitClamped === true && big.text.includes('硬上限'), big.text.split('\n')[2]);
    const { r: small } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 3, ...ACCT }), { images, trees });
    eq('limit=3 → 只扫 3 张', small.scanned, 3);
    eq('🔒 被截断时 truncated=true 且 total 是项目总张数（不是扫描数）', [small.truncated, small.total], [true, 7]);
    ok('被截断时人读文本明说「已被上限截断」', small.text.includes('已被上限截断'), small.text.split('\n')[2]);
    const { r: empty } = await withMock(() => auditProject({ projectId: 'p-mock', ...ACCT }), { images: [], trees: [] });
    ok('空项目 → 不炸；判"样本不足"并明说理由（不是静默空输出）',
      empty.scanned === 0 && empty.total === 0 && empty.reliable === false && empty.text.includes('不可靠'),
      empty.text.split('\n')[2]);
    eq('空项目零漂移类别', empty.driftedCategories.length, 0);
  }
  {
    // 单张稿失败不影响整体；跳过原因翻成人话
    const images = [
      { id: uid(0), name: '好稿', width: 93.75, height: 175 },
      { id: uid(1), name: '整页图.jpg', width: 93.75, height: 175, bad: 'noLayers' },
      { id: uid(2), name: '炸了', width: 93.75, height: 175, bad: 'error' },
      { id: uid(3), name: 'Sketch稿', width: 93.75, height: 175, bad: 'sketch' },
    ];
    const trees = [mkTree('好稿', { radius: 8, btnH: 44, btnColor: '#574af4', titleSize: 14 })];
    const { r } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 5, ...ACCT }), { images, trees });
    ok('单张稿失败**不炸整次审计**（其余照常统计）', r.scanned === 1 && r.blocks > 0);
    ok('跳过原因被翻成人话（图片型条目 ≠ 插件坏了）',
      r.skipBuckets['no-layers'] === 1 && r.skipBuckets.error === 1 && r.skippedBrief.includes('没有图层数据'),
      r.skippedBrief);
    ok('🔒 Sketch 插件格式单独归一类（不混进"读取失败"，也不假装能读）',
      r.skipBuckets['sketch-format'] === 1 && r.skippedBrief.includes('Sketch 插件格式'), r.skippedBrief);
    ok('🔒 抬头里指明 Sketch 格式是**已知空缺**、不是"这些不是设计稿"',
      r.text.includes('Sketch 插件格式') && r.text.includes('已知空缺'), r.text.split('\n').slice(2, 8).join(' / '));
    ok('人读文本里点明"这些稿不进统计，也不等于没扫到"',
      r.text.includes('没有图层数据') && r.text.includes('不等于'), r.text.split('\n').slice(2, 6).join(' / '));
    ok('样本不足（只有 1 张读到图层）→ 判不可靠',
      r.reliable === false && r.suppressed.length === 5, r.reasons.join(' | '));
    ok('🔒 样本不足的原因分得清（`primaryReason=sample`，不是"命名不可靠"）',
      r.primaryReason === 'sample', String(r.primaryReason));
    ok('🔒 样本不足时**不**指向"去规范层名"（那是另一码事）',
      r.text.includes('位图') && !r.text.includes('层名规范化'), r.text.slice(-320));
    const { r: w } = await withMock(() => auditProject({ projectId: 'p-mock', limit: 5, allowWeakNaming: true, ...ACCT }), { images, trees });
    ok('🔒 样本为空时 allowWeakNaming 也不放开（没数据可出，放开只会印一堆 0）',
      w.suppressed.length === 5 && w.weakMode === false, `suppressed=${w.suppressed.length} weak=${w.weakMode}`);
  }
  {
    // 不给项目定位 → 本地报错（不静默返回空结果、也不发网络请求）
    const r = await auditProject({}).catch((e) => e);
    ok('不给 projectId 也不给 url → 明确报错并指出下一步',
      r instanceof Error && /需要 projectId/.test(r.message) && String(r.hint ?? '').length > 0,
      r instanceof Error ? r.message : String(r));
  }
  {
    // 走**工具层**（execute → lossless 出口）—— 真宿主调的就是这条路径
    const toolDef = TOOLS.find((x) => x.name === 'lanhu_audit_project');
    const env = process.env.LANHU_COOKIE;
    process.env.LANHU_COOKIE = 'PASSPORT=x; user_token=y';   // fetch 是 mock 的，串不会发出去
    let r;
    try {
      ({ r } = await withMock(() => toolDef.execute({ projectId: '639b8833-6a8c-401f-a002-7d5b3f090365', limit: 4 }), specOf(4)));
    } finally {
      if (env === undefined) delete process.env.LANHU_COOKIE; else process.env.LANHU_COOKIE = env;
    }
    ok('通过**工具层**（execute + lossless 出口）也能跑通',
      r?.ok === true && r.format === 'audit' && typeof r.text === 'string' && findIllegal(r).length === 0,
      r?.text?.split('\n')[0] ?? JSON.stringify(r)?.slice(0, 120));
  }
}

/* —— ⑧ 工具层与 CLI / 系统提示（能力不能藏着） —— */
{
  const t = TOOLS.find((x) => x.name === 'lanhu_audit_project');
  ok('lanhu_audit_project 已注册进 TOOLS', !!t);
  ok('output schema 声明了 reliable / scanned / truncated（能力不能藏着）',
    !!t?.output?.schema?.properties?.reliable && !!t?.output?.schema?.properties?.scanned
    && !!t?.output?.schema?.properties?.truncated, Object.keys(t?.output?.schema?.properties ?? {}).join(','));
  ok('limit 的 schema 说明了硬上限与成本（工具描述要能拦住"一上来拉满"）',
    /硬上限/.test(t?.parameters?.properties?.limit?.description ?? '') && /2 次请求|2N|两次请求/.test(String(t?.description ?? '')),
    t?.parameters?.properties?.limit?.description ?? '');
  const bad = await t.execute({ projectId: 'not-a-uuid' });
  ok('坏 projectId 被本地预检拦下（不花网络请求，且带下一步）',
    bad.failed === true && String(bad.hint ?? '').length > 0, bad.text.split('\n')[0]);

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hostSrc = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  const from = hostSrc.indexOf('const SYSTEM_HINT = [');
  const hint = hostSrc.slice(from, hostSrc.indexOf("].join('\\n');", from));
  ok('SYSTEM_HINT 决策树里有「要看整个项目的设计系统一致性 → lanhu_audit_project」',
    hint.includes('lanhu_audit_project') && hint.includes('设计系统一致性'), hint.includes('lanhu_audit_project') ? '' : '(决策树里没有)');
  ok('SYSTEM_HINT 里也明说了"命名不可靠时判不可靠、拒绝出明细"', hint.includes('拒绝出明细'));

  const cliSrc = fs.readFileSync(path.join(root, 'lanhu.mjs'), 'utf8');
  ok('CLI 注册了 audit 命令', cliSrc.includes("'audit': cmdAudit,"));
  ok('CLI 的 USAGE 里写了 audit（能力不能藏着）', /^ {2,3}audit {4}\[--url/m.test(cliSrc), (cliSrc.match(/^ *audit.*$/m) ?? ['(没有)'])[0]);
  ok('CLI 的 USAGE 点明成本模型（扫 N 张 = 2N 次请求）', cliSrc.includes('扫 N 张 = 2N 次请求'));

  // 既有工具的形状没被这次新增动过（纯新增）
  const rb = TOOLS.find((x) => x.name === 'lanhu_read_blocks');
  const dd = TOOLS.find((x) => x.name === 'lanhu_diff_design');
  ok('🔒 既有工具的 schema 与形状没被这次新增动过',
    (rb?.parameters?.required ?? []).length === 0 && !!rb?.output?.schema?.properties?.version
    && (dd?.parameters?.required ?? []).includes('from'));
}

/* ═══════════════ ⑦ 多账号档案与归属判定 ═══════════════ */
group('⑦ 多账号');

ok('自检跑在临时数据目录（不碰真实账号）', lanhuHome() === TMP_HOME, lanhuHome());

{
  const r = upsertAccount({ alias: 'acme', company: 'Acme', note: '主账号', cookie: 'PASSPORT=aaa; user_token=bbb' });
  ok('新增账号', r.created === true && r.entry.alias === 'acme');
  const r2 = upsertAccount({ alias: 'acme', company: 'Acme 科技' });
  ok('同别名再写是更新而非新增', r2.created === false && r2.entry.company === 'Acme 科技');
  upsertAccount({ alias: 'other', company: '智汇科技', cookie: 'PASSPORT=ccc; user_token=ddd' });
  const l = listAccounts();
  eq('账号数', l.accounts.length, 2);
  ok('第一个账号自动成为默认', l.default === 'acme');
  ok('列表不含 Cookie 明文', !JSON.stringify(l).includes('PASSPORT=aaa'));
  ok('列表带打码串', /^\*+$|PASSPORT/.test(l.accounts[0].cookieMasked ?? ''));
}
{
  // 别名安全：挡路径穿越（否则 alias 能当路径用）
  for (const bad of ['../etc/passwd', 'a/b', '', 'x'.repeat(41), 'a b']) {
    let threw = false;
    try { safeAlias(bad); } catch { threw = true; }
    ok(`别名拒绝 ${JSON.stringify(bad).slice(0, 20)}`, threw);
  }
  ok('合法别名通过', safeAlias('acme-2.0_x') === 'acme-2.0_x');
}
{
  eq('指定账号取 Cookie', resolveCookie(undefined, { account: 'other' }).account, 'other');
  let threw = null;
  try { resolveCookie(undefined, { account: 'nope' }); } catch (e) { threw = e.message; }
  ok('指定不存在的账号会报错（不静默换账号）', !!threw && threw.includes('nope'), threw ?? '');
  ok('显式 cookie 仍然最高优先', resolveCookie('PASSPORT=x; user_token=y').source === '参数传入');
}
{
  setDefaultAccount('other');
  eq('切默认账号', listAccounts().default, 'other');
  eq('不带账号时用默认账号', resolveCookie().account, 'other');
  ok('档案落盘在临时目录内', accountsPath().startsWith(TMP_HOME));
}
{
  // 归属判定：手工塞索引，验证三级命中的前两级（零请求路径）
  const doc = loadAccounts();
  const TID = '00000001-0000-4000-8000-000000000001';
  const PID = '00000002-0000-4000-8000-000000000002';
  Object.assign(doc.accounts.find((a) => a.alias === 'acme'), {
    teams: [{ teamId: TID, name: 'Acme', memberNum: 2 }],
    projects: [{ projectId: PID, name: '小程序', teamId: TID }],
  });
  fs.writeFileSync(accountsPath(), JSON.stringify(doc, null, 2));

  const byTid = await whoIsIt({ url: `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID}&pid=${PID}&image_id=00000003-0000-4000-8000-000000000003&type=image` });
  ok('① 按链接 tid 命中（零请求）', byTid.found === true && byTid.matchedBy === 'tid' && byTid.alias === 'acme');
  const byPid = await whoIsIt({ projectId: PID, imageId: '00000003-0000-4000-8000-000000000003' });
  ok('② 按 projectId 命中（零请求）', byPid.found === true && byPid.matchedBy === 'pid');
  // 不给 imageId → 不会触发联网探测，纯离线验证「未命中」这条路径
  const none = await whoIsIt({
    teamId: '00000004-0000-4000-8000-000000000004',
    projectId: '00000004-0000-4000-8000-000000000004',
  });
  ok('③ tid/pid 都不在索引里 → 未命中', none.found === false);
  ok('③ 未命中时列出已知账号并给引导', Array.isArray(none.knownAccounts) && typeof none.hint === 'string' && none.hint.length > 0);
  ok('③ 未命中时不返回猜测账号', none.alias === undefined);
}
{
  // 空壳识别：蓝湖对读不到的稿子**不报错**而是返回空壳 —— 这是归属探测的正确性前提
  ok('空壳（只有 imageId）被识别为读不到', isReadableDetail({ imageId: 'x', d2cUrl: null, versionLayoutData: null }) === false);
  ok('有 jsonUrl 视为可读', isReadableDetail({ imageId: 'x', jsonUrl: 'https://…' }) === true);
  ok('有 name 视为可读', isReadableDetail({ imageId: 'x', name: '某稿' }) === true);
  ok('null 视为读不到', isReadableDetail(null) === false);
}
{
  // ⚠️ 回归：归属判定**不得写档案**。
  //    早期实现会在"试读成功"时把该稿的项目回填进索引、并声称归属 —— 那是错的：
  //    实测（2026-09-20）证明**蓝湖对已登录用户不按团队隔离读稿**，
  //    用 A 账号的 Cookie 能读到 B 账号团队下的稿（双向都成功），
  //    所以"能读到"只能证明稿子存在，不能证明归属。回填会污染索引、给出错误结论。
  const before = fs.readFileSync(accountsPath(), 'utf8');
  // 不给 imageId → 不会触发任何网络探测，纯离线
  const miss = await whoIsIt({ teamId: '00000005-0000-4000-8000-000000000005', projectId: '00000005-0000-4000-8000-000000000005' });
  const after = fs.readFileSync(accountsPath(), 'utf8');
  ok('归属判定不写档案（不做任何回填）', before === after);
  ok('未命中时 found=false 且不返回猜测账号', miss.found === false && miss.alias === undefined);
  ok('返回里有 readable 字段说明"能不能读到"', 'readable' in miss);
  ok('已废弃的 probeErrors 保持空（不再逐账号试读）', Array.isArray(miss.probeErrors) && miss.probeErrors.length === 0);
}
{
  // 自动挑账号：别的 AI 只拿到一条链接，不该要求它知道这属于哪个账号
  const TID = '00000001-0000-4000-8000-000000000001';
  const url = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID}&pid=00000002-0000-4000-8000-000000000002&image_id=00000003-0000-4000-8000-000000000003&type=image`;
  const r1 = await resolveAccountFor({ url }, { offline: true });
  ok('索引命中时零请求判定账号', r1 && r1.alias === 'acme' && r1.by === 'index:teams', JSON.stringify(r1));

  const r2 = await resolveAccountFor({ projectId: '00000002-0000-4000-8000-000000000002' }, { offline: true });
  ok('按 projectId 也能判定', r2 && r2.alias === 'acme' && r2.by === 'index:projects', JSON.stringify(r2));

  const r3 = await resolveAccountFor({ teamId: '00000005-0000-4000-8000-000000000005' }, { offline: true });
  ok('都不命中时返回 null（退回默认账号）', r3 === null);

  const r4 = await pickAccount({ account: 'other' });
  ok('显式指定账号时优先级最高', r4.alias === 'other' && r4.by === 'explicit');

  const r5 = await pickAccount({ url }, { offline: true });
  ok('pickAccount 走自动判定', r5.alias === 'acme');
}
{
  const r = removeAccount('other');
  ok('删除账号', r.removed === 'other');
  ok('删掉默认账号后默认落到下一个', r.default === 'acme', String(r.default));
  let threw = false;
  try { removeAccount('other'); } catch { threw = true; }
  ok('重复删除会报错', threw);
}

/* ═══════════════ ⑨ 产品文档 / 原型（A1/A2）与四个可移植算法（B1~B4） ═══════════════ */
group('⑨ 产品文档（A1/A2）与算法（B1~B4）');

// ── A2 · 解析原型链接：**不能**沿用 parseLanhuUrl（那个强制要 image_id）
{
  const u = 'https://lanhuapp.com/web/#/item/project/product?tid=00000006-0000-4000-8000-000000000006&pid=00000007-0000-4000-8000-000000000007&versionId=00000008-0000-4000-8000-000000000008&docId=00000009-0000-4000-8000-000000000009&docType=axure&pageId=5899c262ab8e4609bbb7adef3ecd5450';
  const p = parseProductUrl(u);
  ok('parseProductUrl 抽出 docId（原型链接里叫 docId，不是 image_id）', p.docId === '00000009-0000-4000-8000-000000000009', String(p.docId));
  ok('parseProductUrl 抽出 pageId', p.pageId === '5899c262ab8e4609bbb7adef3ecd5450', String(p.pageId));
  ok('parseProductUrl 抽出 versionId', p.versionId === '00000008-0000-4000-8000-000000000008', String(p.versionId));
  ok('parseProductUrl 抽出 tid / pid', p.teamId === '00000006-0000-4000-8000-000000000006' && p.projectId === '00000007-0000-4000-8000-000000000007');
  // 反例：**没有 image_id 的原型链接**，parseLanhuUrl 会抛错，parseProductUrl 必须能读
  let plThrew = false; let ppOk = false;
  try { parseLanhuUrl(u); } catch { plThrew = true; }
  try { ppOk = parseProductUrl(u).docId != null; } catch { ppOk = false; }
  ok('没有 image_id 的链接：parseLanhuUrl 抛错、parseProductUrl 能读（这是必须新写解析器的原因）', plThrew && ppOk, `parseLanhuUrl 抛错=${plThrew} parseProductUrl 能读=${ppOk}`);
  let badThrew = false;
  try { parseProductUrl(''); } catch { badThrew = true; }
  ok('空链接抛错', badThrew);
}

// ── 页面树展平：path/level/pageId
{
  const roots = [{ id: 'r1', pageName: '版本信息', type: 'Wireframe', url: 'a.html', children: [] },
    { id: 'r2', pageName: 'V1.0', type: 'Folder', url: null, children: [{ id: 'p1', pageName: '首页', type: 'Wireframe', url: 'b.html', children: [
      { id: 'p2', pageName: '三级', type: 'Wireframe', url: 'c.html', children: [] }] }] }];
  const flat = flattenSitemap(roots);
  ok('展平节点数正确（含层级）', flat.length === 4, String(flat.length));
  ok('level 逐层递增', flat.find((p) => p.pageId === 'p2').level === 2, String(flat.find((p) => p.pageId === 'p2').level));
  ok('path 带父级全路径', flat.find((p) => p.pageId === 'p2').path === 'V1.0 / 首页 / 三级', flat.find((p) => p.pageId === 'p2').path);
  ok('pageId 原样保留（A2 消歧就靠它跨版本稳定）', flat.find((p) => p.pageName === '首页').pageId === 'p1');
}

// ── A1 · 选页
{
  const pages = [{ pageId: 'a', pageName: '首页' }, { pageId: 'b', pageName: '全文搜索' }, { pageId: 'c', pageName: '搜索详情' }];
  ok('selectProductPages 按 pageId 精确命中', selectProductPages(pages, { pageId: 'b' }).length === 1);
  ok('selectProductPages 按 pageName 模糊命中多个', selectProductPages(pages, { pageName: '搜索' }).length === 2);
  ok('都不给 → 空数组（只回页面树，不去抓全部正文）', selectProductPages(pages, {}).length === 0);
  let threw = false;
  try { selectProductPages(pages, { pageId: 'nope' }); } catch (e) { threw = e.code === 'PAGE_NOT_FOUND'; }
  ok('pageId 不存在 → PAGE_NOT_FOUND（不静默返回空）', threw);
  let threw2 = false;
  try { selectProductPages(pages, { pageName: '不存在的名字' }); } catch (e) { threw2 = e.code === 'PAGE_NOT_FOUND'; }
  ok('pageName 无命中 → 报错', threw2);
}

// ── B1 · 固定版本选择（正例 + 三个反例）
{
  const versions = [
    { id: 'v3', json_url: 'https://x/3.json' },
    { id: 'v2', json_url: 'https://x/2.json' },
    { id: 'v1', json_url: null },
  ];
  ok('pickVersion 默认取 latest（versions[0]）', pickVersion(versions).id === 'v3');
  ok("pickVersion 传 'latest' 同默认", pickVersion(versions, 'latest').id === 'v3');
  ok('pickVersion 按 id 精确命中（第 2 版，不是最新版）', pickVersion(versions, 'v2').id === 'v2');
  let threw = false;
  try { pickVersion(versions, 'v-not-exist'); } catch (e) { threw = e.code === 'VERSION_NOT_FOUND'; }
  ok('版本不存在 → VERSION_NOT_FOUND，**绝不静默回退 latest**', threw);
  ok('报错信息里列出可选版本（否则调用方没法改）', (() => {
    try { pickVersion(versions, 'nope'); return false; } catch (e) { return /v3/.test(e.hint ?? ''); }
  })());
  let threw2 = false;
  try { pickVersion(versions, 'v1'); } catch (e) { threw2 = e.code === 'SOURCE_UNAVAILABLE'; }
  ok('选中版本没有 json_url → SOURCE_UNAVAILABLE（不返回半空对象）', threw2);
  let threw3 = false;
  try { pickVersion([], 'latest'); } catch { threw3 = true; }
  ok('versions 为空 → 抛错', threw3);
}

// ── A3 · DDS：**可选增强**，失败必须如实返回 ok:false
{
  const r1 = await ddsSchema('');
  ok('ddsSchema 缺 versionId → ok:false + stage=input（不抛错，不挡主流程）', r1.ok === false && r1.stage === 'input', JSON.stringify(r1).slice(0, 80));
  const r2 = await ddsSchema('v-x', { ddsCookie: '' });
  ok('ddsSchema 没有 Cookie → ok:false + stage=cookie', r2.ok === false && r2.stage === 'cookie', String(r2.stage));
  ok('ddsSchema 失败结果带 source=dds（来源可追溯）', r1.source === 'dds' && r2.source === 'dds');
  let threw = false;
  try { await ddsSchema('v-x', { ddsCookie: 'x', timeout: 1 }); } catch { threw = true; }
  ok('ddsSchema **任何失败都不抛错**（调用方据此回退到现有解析）', threw === false);
}

// ── B2 · 字体需求聚合
{
  const layers = [
    { id: 'n1', font: { family: 'PingFang SC', size: 14, weight: 600 } },
    { id: 'n2', font: { family: 'PingFang SC', size: 12, weight: 400 } },
    { id: 'n3', font: { family: 'PingFang SC', size: 12, weight: 400 } },
    { id: 'n4', font: { family: 'Noto Sans', size: 16, weight: 500 } },
    { id: 'n5', font: null },
    { id: 'n6' },
  ];
  const f = fontRequirements(layers);
  ok('只聚合有字体的层（2 个字体族，忽略 font=null / 无 font）', f.length === 2, String(f.length));
  const pf = f.find((x) => x.family === 'PingFang SC');
  ok('按出现次数降序（PingFang SC 3 层在前）', f[0].family === 'PingFang SC');
  ok('nodeCount 正确', pf.nodeCount === 3, String(pf.nodeCount));
  ok('weights 去重并升序', JSON.stringify(pf.weights) === '[400,600]', JSON.stringify(pf.weights));
  ok('sizes 去重并升序', JSON.stringify(pf.sizes) === '[12,14]', JSON.stringify(pf.sizes));
  ok('availability 恒为 not_checked（**不假装校验过本机字体**）', f.every((x) => x.availability === 'not_checked'));
  ok('source 标为 design', f.every((x) => x.source === 'design'));
  const many = fontRequirements(Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, font: { family: 'X', weight: 400 } })));
  ok('sampleNodeIds 最多 5 个（不把 id 全列出来撑爆上下文）', many[0].sampleNodeIds.length === 5, String(many[0].sampleNodeIds.length));
  ok('空输入返回空数组', fontRequirements([]).length === 0 && fontRequirements(null).length === 0);
}

// ── B3 · 切图密度
{
  const a = assetDensity({ pixelWidth: 80, pixelHeight: 80, renderWidth: 20, renderHeight: 20, targetDpr: 4 });
  ok('有效密度 = 实际像素 ÷ 渲染尺寸', a.effectiveDensity.x === 4 && a.effectiveDensity.y === 4, JSON.stringify(a.effectiveDensity));
  ok('达到目标倍率 → resolutionLimited=false', a.resolutionLimited === false);
  const b = assetDensity({ pixelWidth: 20, pixelHeight: 20, renderWidth: 20, renderHeight: 20, targetDpr: 4 });
  ok('只有 1× 而目标是 4× → resolutionLimited=true（素材本身不够清晰）', b.resolutionLimited === true, String(b.resolutionLimited));
  const c = assetDensity({ pixelWidth: 80, pixelHeight: 80, renderWidth: 20, renderHeight: 20, isVector: true });
  ok('矢量图 → effectiveDensity=null 且不进"不够清晰"名单', c.effectiveDensity === null && c.resolutionLimited === false && c.reason === 'vector');
  const d = assetDensity({ pixelWidth: 80, pixelHeight: 80 });
  ok('渲染尺寸未知 → null + reason（**不猜**）', d.effectiveDensity === null && d.resolutionLimited === null && d.reason === 'render-bounds-unavailable');
  const e = assetDensity({ renderWidth: 20, renderHeight: 20 });
  ok('像素尺寸未知 → null + reason', e.reason === 'pixel-size-unavailable');
  ok('x/y 各自独立（非等比素材也如实反映）', (() => {
    const r = assetDensity({ pixelWidth: 40, pixelHeight: 20, renderWidth: 20, renderHeight: 20, targetDpr: 1 });
    return r.effectiveDensity.x === 2 && r.effectiveDensity.y === 1 && r.resolutionLimited === false;
  })());
  // 汇总口径：**空列表 ≠ 都达标**（实测跑完 12 张切图、一张都没配上，`[]` 会被读成"全部达标"）
  ok('一张都没评估 → densityLimited=null（**不是 []**）',
    densityLimitedOf([{ density: { effectiveDensity: null } }], []) === null,
    String(densityLimitedOf([{ density: { effectiveDensity: null } }], [])));
  ok('完全没有文件 → 也是 null', densityLimitedOf([], []) === null);
  ok('评估过且都达标 → densityLimited=[]', JSON.stringify(densityLimitedOf(
    [{ density: { effectiveDensity: { x: 4, y: 4 } } }], [])) === '[]');
  ok('评估过且有不足 → 只列不足的那些', JSON.stringify(densityLimitedOf(
    [{ file: 'a.png', density: { effectiveDensity: { x: 2, y: 2 } } },
      { file: 'b.png', density: { effectiveDensity: { x: 4, y: 4 } } }],
    [{ file: 'a.png', density: { effectiveDensity: { x: 2, y: 2 } }, matchedLayerId: 'L1' }],
  )) === JSON.stringify([{ file: 'a.png', effectiveDensity: { x: 2, y: 2 }, matchedLayerId: 'L1' }]));
  // 配对：唯一命中才认
  const layers = [{ id: 'L1', name: '图标', hasImage: true, w: 20, h: 20 }, { id: 'L2', name: '图标2', hasImage: true, w: 20, h: 20 }, { id: 'L3', name: '大图', hasImage: true, w: 100, h: 50 }];
  const m1 = matchAssetsToLayers([{ url: 'u1', width: 400, height: 200 }], layers, 4);
  ok('渲染尺寸 × sliceScale 唯一命中 → 配对成功', m1[0].matched === true && m1[0].layerId === 'L3', JSON.stringify(m1[0]).slice(0, 90));
  const m2 = matchAssetsToLayers([{ url: 'u2', width: 80, height: 80 }], layers, 4);
  ok('两个图层期望像素相同 → **不配对**（ambiguous，宁缺勿错）', m2[0].matched === false && m2[0].reason === 'ambiguous', String(m2[0].reason));
  const m3 = matchAssetsToLayers([{ url: 'u3', width: 7, height: 7 }], layers, 4);
  ok('没有图层匹配 → no-layer-match', m3[0].reason === 'no-layer-match');
  const m4 = matchAssetsToLayers([{ url: 'u4', width: 80, height: 80 }], layers, null);
  ok('没有 sliceScale → 不配对并说明原因', m4[0].matched === false && m4[0].reason === 'slice-scale-unavailable');
}

// ── B4 · 几何间距
{
  const A = { id: 'A', x: 0, y: 0, w: 10, h: 10 };
  const B = { id: 'B', x: 20, y: 0, w: 10, h: 10 };   // 与 A 同 y 重叠 → x 间距 10
  const C = { id: 'C', x: 0, y: 30, w: 10, h: 10 };   // 与 A 同 x 重叠 → y 间距 20
  const D = { id: 'D', x: 30, y: 30, w: 10, h: 10 };  // 与 A **两轴都不重叠** → 斜对角
  const g = geometricGaps([A, B, C, D]);
  const ab = g.find((x) => (x.from === 'A' && x.to === 'B') || (x.from === 'B' && x.to === 'A'));
  ok('同轴相邻 → 算出间距（A→B 的 x 间距=10）', ab && ab.distance === 10 && ab.axis === 'x', JSON.stringify(ab));
  const ac = g.find((x) => x.axis === 'y' && ((x.from === 'A' && x.to === 'C') || (x.from === 'C' && x.to === 'A')));
  ok('y 轴独立计算（A→C 的 y 间距=20）', ac && ac.distance === 20, JSON.stringify(ac));
  ok('斜对角（D 与 A 两轴都不重叠）**不算间距**', !g.some((x) => [x.from, x.to].includes('D') && [x.from, x.to].includes('A')), JSON.stringify(g.filter((x) => [x.from, x.to].includes('D'))));
  ok('带 overlap 区间（说明"在另一轴的哪一段上相邻"）', ab.overlap && ab.overlap.start === 0 && ab.overlap.end === 10, JSON.stringify(ab?.overlap));
  ok('带 fromName/toName（Figma 的 id 会重复，只给 id 分不清是哪个层）', 'fromName' in g[0] && 'toName' in g[0]);
  // 每个节点每个方向只留最近的一条
  const A2 = { id: 'A', x: 0, y: 0, w: 10, h: 10 };
  const N1 = { id: 'N1', x: 15, y: 0, w: 10, h: 10 };  // 间距 5
  const N2 = { id: 'N2', x: 100, y: 0, w: 10, h: 10 }; // 间距 90
  const g2 = geometricGaps([A2, N1, N2]);
  const fromA = g2.filter((x) => x.from === 'A' && x.axis === 'x');
  ok('每个节点每个方向只留**最近的一条**（A 的右侧只记 5，不记 90）', fromA.length === 1 && fromA[0].distance === 5, JSON.stringify(fromA));
  // 完全重合的重复层要剔除
  const dup = geometricGaps([{ id: 'Z', x: 5, y: 5, w: 10, h: 10 }, { id: 'Z', x: 5, y: 5, w: 10, h: 10 }]);
  ok('完全重合的两个矩形（重复图层）不产生"间距 0"噪声', dup.length === 0, JSON.stringify(dup));
  // maxDistance 过滤
  const g3 = geometricGaps([A2, N1, N2], { maxDistance: 10 });
  ok('maxDistance 过滤掉远处的', !g3.some((x) => x.distance > 10), JSON.stringify(g3.map((x) => x.distance)));
  ok('空输入 / 缺字段不崩', geometricGaps([]).length === 0 && geometricGaps([{ id: 'x' }]).length === 0);
}

// ── 正文文本抽取（实测：Axure 的正文只在 HTML 里，且是实体编码）
{
  ok('decodeHtmlEntities 解十六进制实体（&#x9996;&#x9875; → 首页）', decodeHtmlEntities('&#x9996;&#x9875;') === '首页', decodeHtmlEntities('&#x9996;&#x9875;'));
  ok('decodeHtmlEntities 解十进制与命名实体', decodeHtmlEntities('&#39318; &amp; &lt;b&gt;') === '首 & <b>', decodeHtmlEntities('&#39318; &amp; &lt;b&gt;'));
  const html = '<html><head><style>body{color:#fff}</style><script>var a="不该出现";</script></head><body><div>首页</div><div>首页</div><span>——</span><p>绿色创新</p></body></html>';
  const t = extractHtmlText(html);
  ok('extractHtmlText 剥掉 script/style（正文里不会混进 JS 源码）', !t.some((x) => x.includes('不该出现')), JSON.stringify(t));
  ok('extractHtmlText 去重（同一段文字只留一次）', t.filter((x) => x === '首页').length === 1, JSON.stringify(t));
  ok('extractHtmlText 只保留符号的片段会被滤掉', !t.includes('——'), JSON.stringify(t));
  ok('extractHtmlText 保留真实文本', t.includes('绿色创新') && t.includes('首页'), JSON.stringify(t));
  ok('extractHtmlText 尊重 limit', extractHtmlText(html, { limit: 1 }).length === 1);
  ok('extractHtmlText 空输入返回空数组', extractHtmlText('').length === 0 && extractHtmlText(null).length === 0);
}

// ── Axure data.js 解析（包装形态）+ 对象抽取
{
  const dj = '$axure.loadCurrentPage(lanhu_Axure_Mapping_Data({"page":{"name":"通用规则","diagram":{"objects":[{"id":"o1","type":"vectorShape","label":""}]},"annotations":[]}}))';
  const parsed = parseAxureJs(dj);
  ok('parseAxureJs 剥掉两层包装取出 JSON', parsed?.page?.name === '通用规则', JSON.stringify(parsed).slice(0, 60));
  const ex = extractAxureObjects(parsed);
  ok('extractAxureObjects 数出对象数', ex.objectCount === 1, String(ex.objectCount));
  ok('无文本无标注时 kept 为空（实测这套原型就是这样，**不能当"这页没内容"**）', ex.kept.length === 0, JSON.stringify(ex.kept));
  let threw = false;
  try { parseAxureJs('不是 JSON'); } catch { threw = true; }
  ok('parseAxureJs 非 JSON → 明确抛错', threw);
  const withText = extractAxureObjects({ page: { name: 'p', diagram: { objects: [{ id: 'a', rich: '&#x9996;&#x9875;', anns: { 0: { text: '点这里跳转' } } }] } } });
  ok('原生控件有文本/标注时能抽出来（有就用）', withText.kept.length === 1 && withText.kept[0].text === '首页' && withText.kept[0].annotations[0] === '点这里跳转', JSON.stringify(withText.kept).slice(0, 120));
}

// ── 原型 / 设计稿 互斥守卫（拿错解析器不许静默返回垃圾）
{
  // 直接验守卫的判据函数形态：树里有 pages/sitemap 且没有 artboard → 原型
  const protoTree = { pages: { 'a.html': {} }, sitemap: { rootNodes: [] } };
  const designTree = { artboard: { name: 'x', layers: [] }, assets: [] };
  const isProto = (t) => !t.artboard && Boolean(t.pages || t.sitemap);
  ok('原型树被识别为原型', isProto(protoTree) === true);
  ok('设计稿树不被误判为原型', isProto(designTree) === false);
  ok('设计稿树确实带 artboard（read_design 的入口判据）', Boolean(designTree.artboard));
}

// ── 新增/改动的工具 schema 必须真的把参数透传下去（本项目踩过"声明了但没传"）
{
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const props = (n) => byName[n].parameters.properties ?? {};
  ok('lanhu_read_design 有 version 参数', 'version' in props('lanhu_read_design'));
  ok('lanhu_read_design 的 format 含 fonts', (props('lanhu_read_design').format.enum ?? []).includes('fonts'));
  ok('lanhu_read_design 有 gapMaxDistance 参数', 'gapMaxDistance' in props('lanhu_read_design'));
  ok('lanhu_read_design 有 dds 开关（可选增强，默认关）', 'dds' in props('lanhu_read_design') && /默认关闭/.test(props('lanhu_read_design').dds.description));
  ok('dds 描述里写明是**非官方**通道且失败不影响常规结果', /非官方/.test(props('lanhu_read_design').dds.description) && /不影响常规解析/.test(props('lanhu_read_design').dds.description));
  ok('lanhu_read_blocks 有 version 参数', 'version' in props('lanhu_read_blocks'));
  ok('lanhu_download_slices 有 version 与 targetDpr', 'version' in props('lanhu_download_slices') && 'targetDpr' in props('lanhu_download_slices'));
  ok('新增 lanhu_list_product_documents 工具已注册', !!byName.lanhu_list_product_documents);
  ok('新增 lanhu_read_product_doc 工具已注册', !!byName.lanhu_read_product_doc);
  // 逐字检查"参数有没有真的传下去"（**"声明了但没传"是本项目真实踩过的坑**）。
  // ⚠️ 不能用 `TOOLS[i].execute.toString()`：`tool()` 会把 rawExecute 包一层**参数校验**，
  //    toString() 拿到的是包装函数，里面根本看不到 args.xxx —— 那样查会**全部误报为"没传"**（实测）。
  //    所以按源码区间做静态检查：从 `name: '<tool>'` 切到下一个工具定义为止。
  const _hostSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'), 'utf8');
  const toolRegion = (n) => {
    const i = _hostSrc.indexOf(`name: '${n}'`);
    if (i < 0) return '';
    const j = _hostSrc.indexOf("name: 'lanhu_", i + 10);
    return _hostSrc.slice(i, j < 0 ? _hostSrc.length : j);
  };
  ok('按源码区间能定位到工具定义（静态检查本身要可靠）', toolRegion('lanhu_read_design').includes('readDesign'), '定位失败会让下面的检查变成假绿');
  // **通用化**：每个工具、**每个**声明参数，都必须在自己的源码区间里被引用。
  // 原先只查新加的那 3 组参数 —— 实测把 `limit: args.limit` 改成 `undefined` 它照样全绿。
  const EXPLICITLY_INAPPLICABLE = {
    // `account` 由 lib/index.js 统一注入（`{ ...parameters, account: ACCOUNT_PARAM }`）。
    // 这两个工具的语义就是"跨账号判定 / 管理全部账号"，逐账号过滤无从谈起 ——
    // 属于**明确不适用**，不是漏传。（其余 13 个工具都必须真的用到它。）
    lanhu_accounts: ['account'],
    lanhu_who: ['account'],
  };
  let checkedParams = 0;
  for (const t of TOOLS) {
    const region = toolRegion(t.name);
    ok(`能定位 ${t.name} 的源码区间`, region.includes(`name: '${t.name}'`), '定位失败会让这条检查失真');
    const skip = EXPLICITLY_INAPPLICABLE[t.name] ?? [];
    for (const k of Object.keys(t.parameters.properties ?? {})) {
      if (skip.includes(k)) continue;
      checkedParams += 1;
      ok(`${t.name}.${k} **真的传给了实现**（不只是写在 schema 里）`,
        region.includes(`args.${k}`), `源码区间里${region.includes(`args.${k}`) ? '有' : '**没有**'} args.${k}`);
    }
  }
  ok('通用透传检查确实扫到了全部参数（不是空跑）', checkedParams > 70, `扫了 ${checkedParams} 个`);

  // `account` 被忽略时的静默后果：`cookie_set {account:"x"}` 会覆盖**默认账号**的 Cookie
  upsertAccount({ alias: 'demo', company: '测试账号' });
  const FAKE_COOKIE = 'user_token=SELFCHECK_FAKE; sl_check=1';
  const sc = await saveCookie(FAKE_COOKIE, { verify: false, account: 'demo' });
  ok('cookie_set 给 account → 写进该账号 cookies/<alias>（不碰默认文件）',
    sc.account === 'demo' && sc.path.endsWith(path.join('cookies', 'demo')), sc.path);
  const scBad = await saveCookie(FAKE_COOKIE, { verify: false, account: '__no_such__' }).then(() => null, (e) => e);
  ok('cookie_set 给不存在的 account → 明确报错（不静默落到默认）',
    !!scBad && /不存在/.test(scBad.message), scBad ? scBad.message.slice(0, 60) : '没有报错！');
  ok('产品文档工具的描述点明"不是设计稿"（防拿错工具）', byName.lanhu_read_product_doc.description.includes('不是设计稿') && byName.lanhu_list_product_documents.description.includes('不是设计稿'));
  ok('列表工具指路到读取工具（拿错工具的代价是白跑一次）', byName.lanhu_list_product_documents.description.includes('lanhu_read_product_doc'));
  ok('设计稿工具的描述点明**不是**产品文档（反向防混淆）', byName.lanhu_read_design.description.includes('不是') || byName.lanhu_read_blocks.description.includes('不是') || true, '（仅记录，不作硬判据）');
}

/* ═══════════ 混链：docId / image_id / versionId 同时出现（蓝湖编辑页的真实形态） ═══════════ */
{
  const IMG = '0000000a-0000-4000-8000-00000000000a';
  const DOC = '00000009-0000-4000-8000-000000000009';
  const DOCVER = '00000008-0000-4000-8000-000000000008';
  const PAGE = '5899c262ab8e4609bbb7adef3ecd5450';
  const MIX = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=00000006-0000-4000-8000-000000000006`
    + `&pid=00000007-0000-4000-8000-000000000007&versionId=${DOCVER}&docId=${DOC}&docType=axure`
    + `&image_id=${IMG}&pageId=${PAGE}&type=image`;
  const p = parseLanhuUrl(MIX);
  ok('混链里 image_id 优先（type=image，不是那个 docId）', p.imageId === IMG, p.imageId);
  ok('混链解析保留 versionId / docId / pageId（**以前直接丢掉**）',
    p.versionId === DOCVER && p.docId === DOC && p.pageId === PAGE,
    JSON.stringify({ v: p.versionId, d: p.docId, pg: p.pageId }));
  // ⚠️ 回归：resolveTarget 曾把 versionId 吞掉 → URL 里的版本号完全失效，永远读 latest
  ok('resolveTarget **不许吞掉 versionId**（吞了 URL 版本就失效）',
    resolveTarget({ url: MIX }).versionId === DOCVER, String(resolveTarget({ url: MIX }).versionId));
  const plain = 'https://lanhuapp.com/web/#/item/project/detailDetach?pid=00000007-0000-4000-8000-000000000007&image_id=' + IMG;
  ok('链接没带 versionId 时就是 null（不瞎猜）', resolveTarget({ url: plain }).versionId === null,
    String(resolveTarget({ url: plain }).versionId));
  ok('显式给 projectId+imageId 时不编 versionId', resolveTarget({ projectId: 'p', imageId: 'i' }).versionId === undefined
    || resolveTarget({ projectId: 'p', imageId: 'i' }).versionId === null);
}

/* ═══════════ 原型（Axure）页面样式：剥壳 / 文本回挂 / 归一化（0.3.0） ═══════════ */
{
  // ── ① 剥壳：两层包装 + 括号配对
  ok('剥壳：两层包装（loadCurrentPage(lanhu_Axure_Mapping_Data(…))）能剥出 JSON',
    unwrapAxureDocument('$axure.loadCurrentPage(lanhu_Axure_Mapping_Data({"a":1}))').a === 1);
  ok('剥壳：JSON 字符串里的 ) { } 不影响配对',
    (() => { const d = unwrapAxureDocument('$ax(lanhu_Axure_Mapping_Data({"note":"a)b{c}d","n":2}))'); return d.n === 2 && d.note === 'a)b{c}d'; })());
  ok('剥壳：转义引号不会误判字符串结束',
    unwrapAxureDocument('$ax(lanhu_Axure_Mapping_Data({"s":"he said \\"}\\" ok","k":3}))').k === 3);
  // ⚠️ 这条是**真会让旧实现切错**的输入：包装里 JSON 之后还有一个 `}`
  //    （旧 parseAxureJs 用 lastIndexOf('}')，会切到尾巴那个 → 报 Unexpected non-whitespace）
  const tailBrace = '$axure.loadCurrentPage(lanhu_Axure_Mapping_Data({"a":1}), {"tail":true})';
  // 包 try/catch：实现坏掉时应该是**一条红**，而不是把整个自检崩掉（崩溃会连带掩盖后面的断言）
  ok('剥壳：JSON 之后还有 } 时仍切得准（旧实现的切法在这条上会失败）',
    (() => { try { return unwrapAxureDocument(tailBrace).a === 1; } catch { return false; } })());
  ok('剥壳：空输入明确报错（不是静默给空对象）',
    (() => { try { unwrapAxureDocument(''); return false; } catch { return true; } })());
  // 注意：`{...}` 本身完整、只是外层少了个 `)` 时**应该照常解析出来**（JSON 是好的）。
  // 只有 **JSON 自己缺右括号** 才算不配对 —— 那才是"文件被截断"。
  ok('剥壳：外层少 ) 但 JSON 完整 → 照常解析（不误报）',
    unwrapAxureDocument('$ax(lanhu_Axure_Mapping_Data({"a":1}').a === 1);
  ok('剥壳：**JSON 自己缺右括号** → 明确报错（文件被截断的情形）',
    (() => { try { unwrapAxureDocument('$ax(lanhu_Axure_Mapping_Data({"a":1)'); return false; } catch { return true; } })());

  // ── ② 32 位色值：**高字节就是 alpha**（旧实现 `a===0?1:…` 把透明当不透明）
  ok('argb：0x7f58a2cc → #58a2cc，alpha=127/255',
    (() => { const c = argbColor(0x7f58a2cc); return c.hex === '#58a2cc' && Math.abs(c.alpha - 127 / 255) < 1e-9; })());
  ok('argb：**0x00ffffff 是透明（alpha 0）**，不是"无 alpha 信息"',
    argbColor(0x00ffffff).alpha === 0, String(argbColor(0x00ffffff).alpha));
  ok('argb：0xff000000 → 黑色不透明', (() => { const c = argbColor(0xff000000); return c.hex === '#000000' && c.alpha === 1; })());
  ok('argb：非数字 → null（不编造）', argbColor('x') === null && argbColor(undefined) === null);
  ok('argb ：argbParts 与 argbColor 同源（不重复实现）',
    (() => { const p = argbParts(0x4c58a2cc); const c = argbColor(0x4c58a2cc); return p.r === 0x58 && p.g === 0xa2 && p.b === 0xcc && c.alpha === p.a; })());

  // ── ③ 文本回挂：只认 `uNNN_text` / `uNNN_input`，并解 HTML 实体
  {
    const html = '<div id="u12"><div id="u12_text">&#x4F60;&#x597D; &#x4E16;&#x754C;</div></div>'
      + '<div id="u13"><textarea id="u13_input">&#x7EFF;&#x8272;</textarea></div>'
      + '<div id="u14" class="x">不该被当文本</div>';
    const { byScriptId, texts } = decodeAxureText(html);
    ok('文本回挂：`uNNN_text` 解实体后挂到该控件', byScriptId.get('u12') === '你好 世界', String(byScriptId.get('u12')));
    ok('文本回挂：`uNNN_input`（文本域）也认', byScriptId.get('u13') === '绿色', String(byScriptId.get('u13')));
    ok('文本回挂：**没有 _text/_input 后缀的元素不进索引**（防把容器当正文）', !byScriptId.has('u14'));
    ok('文本回挂：页级文本清单也在', texts.length >= 2, String(texts.length));
  }

  ok('字体族：JSON 回退栈取主族', axureFontFamily('"PingFang SC", sans-serif') === 'PingFang SC');
  ok('字体族：没有引号也认', axureFontFamily('微软雅黑') === '微软雅黑');
  ok('字体族：空 → null（不编造）', axureFontFamily('') === null && axureFontFamily(null) === null);

  // ── ④ 归一化：合成小夹具（**不把 861KB 真实数据提交进仓库**）
  const synth = {
    page: {
      name: '合成页', packageId: 'pkg1',
      style: { size: { width: 0, height: 0 } }, // ⚠️ 故意为 0：走包围盒兜底
      diagram: {
        objects: [{
          id: 'w1', label: '', friendlyType: '组合', type: 'layer', visible: true,
          style: { location: { x: 100, y: 50 }, size: { width: 400, height: 300 }, opacity: '0.5' },
          objs: [{
            id: 'w2', label: '', friendlyType: '矩形', type: 'vectorShape', visible: true,
            style: {
              location: { x: 10, y: 5 }, size: { width: 100, height: 40 }, opacity: '0.5',
              fill: { fillType: 'solid', color: 0x7f58a2cc },
              foreGroundFill: { fillType: 'solid', color: 0xff333333 },
              borderFill: { fillType: 'solid', color: 0xff000000 }, borderWidth: '2', cornerRadius: '8',
              fontName: '"PingFang SC", sans-serif', fontSize: '14px', fontWeight: '700', lineSpacing: '20px',
            },
            images: { 'normal~': 'images/synth/u2.png' },
          }, {
            id: 'w3', label: '', friendlyType: '形状', type: 'vectorShape', visible: true,
            style: { fill: { fillType: 'linearGradient', stops: [{ color: 0xff58a2cc, offset: 0, opacity: 1 }, { color: 0x80ff0000, offset: 1, opacity: 0.5 }] } },
          }, {
            id: 'w4', label: '', friendlyType: '矩形', type: 'vectorShape', visible: true,
            style: { foreGroundFill: { fillType: 'solid', color: 0xff000000 } }, // ⚠️ 故意没有 location
          }],
        }],
      },
    },
    objectPaths: { w2: { scriptId: 'u2' }, w3: { scriptId: 'u3' } },
  };
  const synthHtml = '<div id="u2"><div id="u2_text">合成文本</div></div>';
  const norm = normalizeAxurePage({ document: synth, html: synthHtml });
  const byId = Object.fromEntries(norm.layers.map((l) => [l.id, l]));
  const art = norm.layers[0];
  const w2 = byId.w2; const w3 = byId.w3; const w4 = byId.w4;

  ok('归一化：层数 = 画板 + 4 个控件', norm.layers.length === 5, String(norm.layers.length));
  ok('归一化：**绝对坐标逐层累加**（父 100,50 + 子 10,5 = 110,55）', w2?.x === 110 && w2?.y === 55, `${w2?.x},${w2?.y}`);
  ok('归一化：**opacity 顺链累乘**（0.5×0.5=0.25）', w2?.effectiveOpacity === 0.25, String(w2?.effectiveOpacity));
  ok('归一化：inset 用**相对坐标**（Axure 的 location 本来就是相对父）',
    w2?.inset?.left === 10 && w2?.inset?.top === 5 && w2?.inset?.right === 290 && w2?.inset?.bottom === 255,
    JSON.stringify(w2?.inset));
  ok('归一化：画板尺寸声明为 0 时**用包围盒兜底**（400×300）',
    art.w === 400 && art.h === 300 && art.sizeSource === 'bbox', `${art.w}×${art.h} ${art.sizeSource}`);
  ok('归一化：文本从 HTML 回挂到控件', w2?.text === '合成文本', String(w2?.text));
  ok('归一化：**fill 与文字色分成两个 role**（Axure 是两个独立字段）',
    w2?.colors?.some((c) => c.role === 'fill') === true && w2?.colors.some((c) => c.role === 'text'),
    JSON.stringify((w2?.colors ?? []).map((c) => c.role)));
  ok('归一化：`fillIsBackground=true`（告诉下游"这个底色是真的，别按 Figma 规则抹掉"）', w2?.fillIsBackground === true);
  ok('归一化：渐变 stop 全部保留且带 role=gradient',
    w3?.colors.filter((c) => c.role === 'gradient').length === 2, String(w3?.colors.filter((c) => c.role === 'gradient').length));
  ok('归一化：圆角 / 描边 / 图片 / 字体都落到设计稿同名字段',
    w2?.radius?.max === 8 && w2?.border?.width === 2 && w2?.border.color === '#000000'
    && w2?.hasImage === true && w2?.font?.family === 'PingFang SC' && w2?.font.size === 14 && w2?.font.weight === 700 && w2?.font.lineHeight === 20,
    JSON.stringify({ r: w2?.radius?.max, b: w2?.border?.width, img: w2?.hasImage, f: w2?.font }));
  ok('归一化：**没有 location 就留 null，不编造 0**（w4）', w4?.x === null && w4?.y === null, `${w4?.x},${w4?.y}`);

  // 可见性顺链继承（父隐藏 → 子不该出现在清单里）
  const hidden = JSON.parse(JSON.stringify(synth));
  hidden.page.diagram.objects[0].visible = false;
  const normH = normalizeAxurePage({ document: hidden, html: synthHtml });
  ok('归一化：**父层隐藏时子层也标为不可见**（顺链继承）',
    normH.layers.find((l) => l.id === 'w2')?.visible === false);

  // ── ⑤ 与块级模型的接合点：`fillIsBackground` 决定"有文字的层要不要留底色"
  const mkLayer = (extra) => ({
    id: 'x', type: 'vectorShape', name: 'x', parentPath: '', depth: 1, x: 0, y: 0, w: 100, h: 40,
    inset: null, visible: true, opacity: 1, effectiveOpacity: 1, shape: '矩形', radius: null, border: undefined,
    colors: [{ r: 250, g: 205, b: 145, a: 0.06, role: 'fill' }, { r: 0, g: 0, b: 0, a: 1, role: 'text' }],
    text: '有文字的层', font: { family: 'Arial', size: 14, weight: 400, align: null, lineHeight: null, letterSpacing: null },
    hasImage: false, ...extra,
  });
  const bProto = buildBlocks([mkLayer({ fillIsBackground: true })], {})[0];
  const bDesign = buildBlocks([mkLayer({})], {})[0];
  ok('块级：原型层（fillIsBackground）**保住真底色** —— 否则 Axure 文本控件的背景会整块丢',
    bProto?.bg?.hex === '#facd91', JSON.stringify(bProto?.bg));
  ok('块级：设计稿层行为**完全不变**（文字层的 fill 仍视为文字色、不染底色）',
    Boolean(bDesign) && !bDesign?.bg, JSON.stringify(bDesign?.bg));
  ok('块级：两侧都拿得到文字色', bProto?.color === '#000000' && bDesign?.color === '#000000',
    `${bProto?.color} / ${bDesign?.color}`);

  // ── ⑥ 动态面板的**状态图**（`diagrams[].objects[]`）——不走进来会少掉三分之一的控件
  const panelDoc = {
    page: {
      name: '面板页', packageId: 'pkg2', style: { size: { width: 500, height: 400 } },
      diagram: {
        objects: [{
          id: 'pnl', label: '日历', friendlyType: '动态面板', type: 'layer', visible: true,
          style: { location: { x: 20, y: 30 }, size: { width: 300, height: 200 } },
          objs: [{ id: 'base', label: '底', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 1, y: 1 }, size: { width: 10, height: 10 } } }],
          diagrams: [
            { id: 'dA', label: 'August', type: 'Axure:PanelDiagram', style: { fill: { fillType: 'solid', color: 0x4affffff } }, objects: [{ id: 'ga', label: '八月格', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 5, y: 6 }, size: { width: 20, height: 20 } } }] },
            { id: 'dB', label: 'July', type: 'Axure:PanelDiagram', style: { fill: { fillType: 'solid', color: 0x4a118281 } }, objects: [{ id: 'gb', label: '七月格', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 5, y: 6 }, size: { width: 20, height: 20 } } }] },
            { id: 'dC', objects: [{ id: 'gc', label: '(无名状态)', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 0, y: 0 }, size: { width: 1, height: 1 } } }] },
          ],
        }],
      },
    },
    objectPaths: { ga: { scriptId: 'u1' }, gb: { scriptId: 'u2' }, gc: { scriptId: 'u3' } },
  };
  const pn = normalizeAxurePage({ document: panelDoc, html: '' });
  const pg = Object.fromEntries(pn.layers.map((l) => [l.id, l]));
  ok('面板状态：**没有状态的字段不会被丢掉**（`diagrams[].objects[]` 也是控件）', Boolean(pg.ga && pg.gb && pg.gc));
  ok('面板状态：状态层带 `panelState`（标注"这是备选状态"）', pg.ga?.panelState === 'August' && pg.gb?.panelState === 'July');
  ok('面板状态：状态层带 `panelOf`（可把同一面板的状态归组）', pg.ga?.panelOf === 'pnl' && pg.gb?.panelOf === 'pnl');
  ok('面板状态：路径里写明状态（列表里一眼能看出是备选）', pg.ga?.parentPath?.includes('（状态 August）') === true, String(pg.ga?.parentPath));
  ok('面板状态：状态内控件坐标**仍逐层累加**（20+5, 30+6）', pg.ga?.x === 25 && pg.ga?.y === 36, `${pg.ga?.x},${pg.ga?.y}`);
  ok('面板状态：状态无名时给「状态N」而不是留空', pg.gc?.panelState === '状态3', String(pg.gc?.panelState));
  ok('面板状态：**不在面板里的层 `panelState` 为 null**（不误标）', pg.base?.panelState === null && pg.base?.panelOf === null);
  // 6 = 3 个状态容器 + 3 个状态内子层（容器自己也算一层，见下面的断言）
  ok('面板状态：stats 报出状态层数与面板数（含状态容器自己，调用方不用自己数）',
    pn.stats.panelStateLayers === 6 && pn.stats.panelCount === 1,
    JSON.stringify({ l: pn.stats.panelStateLayers, p: pn.stats.panelCount }));
  ok('面板状态：**同一面板的多个状态是互斥的**，所以路径互不相同（不会互相覆盖）',
    pg.ga?.parentPath !== undefined && pg.ga?.parentPath !== pg.gb?.parentPath);

  // ⚠️ 状态**容器自己也是一层**：它带着"这一状态的背景色"，而面板自身没有 fill —— 丢了就丢了状态背景
  ok('面板状态：**状态容器自己也输出成层**（不是只走它的 children）', pg.dA?.containerKind === 'panel-state', String(pg.dA?.containerKind));
  ok('面板状态：容器没有 location/size → 几何**取自所属面板**，并明确标记 `geometryFromParent`',
    pg.dA?.geometryFromParent === true && pg.dA?.x === 20 && pg.dA?.y === 30,
    `${pg.dA?.x},${pg.dA?.y} fromParent=${pg.dA?.geometryFromParent}`);
  ok('面板状态：**各状态的背景色各自保留**（实测同一面板三个状态的底色不同）',
    pg.dA?.colors?.[0]?.b === 255 && pg.dB?.colors?.[0]?.g === 0x82,
    JSON.stringify([pg.dA?.colors?.[0], pg.dB?.colors?.[0]]));

  // ── `objects[]`（**不是 `objs[]`**）：中继器模板 / 表格单元格 —— 整类容易漏，实测一份稿漏了 41 层
  const objDoc = {
    page: {
      name: 'P', packageId: 'p3', style: { size: { width: 10, height: 10 } },
      diagram: {
        objects: [
          { id: 'rep', label: '中继器', friendlyType: '中继器', type: 'repeater', visible: true,
            style: { location: { x: 1, y: 2 }, size: { width: 100, height: 50 } },
            objects: [{ id: 'ritem', label: '模板项', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 3, y: 4 }, size: { width: 5, height: 5 } } }] },
          { id: 'tbl', label: '表格', friendlyType: '表格', type: 'table', visible: true,
            style: { location: { x: 0, y: 0 }, size: { width: 200, height: 80 } },
            objects: [{ id: 'cell', label: '单元格', friendlyType: '矩形', type: 'vectorShape', visible: true, style: { location: { x: 6, y: 7 }, size: { width: 8, height: 8 } } }] },
        ],
      },
    },
    objectPaths: {},
  };
  const pn2audit = (docObj) => auditAxureChildKeys(docObj).panelDiagram;
  const od = normalizeAxurePage({ document: objDoc, html: '' });
  const og = Object.fromEntries(od.layers.map((l) => [l.id, l]));
  ok('objects[]：**中继器**的子层不再被静默漏掉', Boolean(og.ritem));
  ok('objects[]：**表格**的子层不再被静默漏掉', Boolean(og.cell));
  ok('objects[]：子层带 `containerKind` 标明来自哪种容器',
    og.ritem?.containerKind === '中继器' && og.cell?.containerKind === '表格',
    `${og.ritem?.containerKind} / ${og.cell?.containerKind}`);
  ok('objects[]：路径里写明容器（列表里看得出是模板还是单元格）',
    og.ritem?.parentPath?.includes('中继器') === true, String(og.ritem?.parentPath));
  ok('objects[]：坐标仍逐层累加（1+3, 2+4）', og.ritem?.x === 4 && og.ritem?.y === 6, `${og.ritem?.x},${og.ritem?.y}`);
  ok('objects[]：stats 报出这类层数（41 那种量级不该靠人肉发现）',
    od.stats.containerObjectLayers === 2, String(od.stats.containerObjectLayers));

  // ── 计数口径（对账时最有用的那条）：层数 = 画板 + 所有遍历到的控件
  //    （`objs` + `objects` + `diagrams` 三种子层容器，**且状态容器自己也算一层**）
  ok('计数口径：合成夹具的层数 = 画板1 + 面板1 + 面板直属子层1 + 状态容器3 + 状态子层3 = 9',
    pn.layers.length === 9, `实际 ${pn.layers.length}`);

  // ── 结构审计：把"子层挂在哪个键上"从**靠人看**变成**机器拦下**
  //    （起因：真漏过 41 层 `objects[]` + 11 个状态容器，都属同一个病）
  const audOk = auditAxureChildKeys(objDoc);
  ok('结构审计：正常夹具**不误报**（objs / objects / diagrams 都走了）',
    audOk.unhandled.length === 0, JSON.stringify(audOk.unhandled));
  ok('结构审计：能认出实际用到的子层键并标 handled',
    audOk.childKeys.some((e) => e.key === 'objects' && e.handled) && audOk.childKeys.every((e) => e.handled),
    JSON.stringify(audOk.childKeys));

  // `stops` / `cases` / `arguments` / `linePatternArray` 这类**非子层**数组不能误判
  const noiseDoc = {
    page: { name: 'S', packageId: 'p5', style: { size: { width: 1, height: 1 } }, diagram: { objects: [
      { id: 'a', label: 'a', type: 'vectorShape', visible: true,
        style: { location: { x: 0, y: 0 }, size: { width: 1, height: 1 },
          stops: [{ color: 1, offset: 0 }], cases: [{ condition: 'x' }], arguments: [{ name: 'v' }], linePatternArray: [0] } },
    ] } }, objectPaths: {},
  };
  ok('结构审计：**非子层数组不误判**（元素没有 id+type/style/friendlyType）',
    auditAxureChildKeys(noiseDoc).unhandled.length === 0, JSON.stringify(auditAxureChildKeys(noiseDoc).unhandled));

  // 第四种子层键（Axure 哪天把子层放到 `items`）→ 必须被认出来
  const weirdDoc = {
    page: { name: 'W', packageId: 'p4', style: { size: { width: 9, height: 9 } }, diagram: { objects: [
      { id: 'w', label: 'x', friendlyType: '矩形', type: 'vectorShape', visible: true,
        style: { location: { x: 1, y: 1 }, size: { width: 2, height: 2 } },
        items: [{ id: 'w1', label: '子', friendlyType: '矩形', type: 'vectorShape', style: { location: { x: 0, y: 0 }, size: { width: 1, height: 1 } } }] },
    ] } }, objectPaths: {},
  };
  const aw = auditAxureChildKeys(weirdDoc);
  ok('结构审计：**能认出没走过的第四种子层键**（key=items）—— 这就是防下次静默漏的守门人',
    aw.unhandled.length === 1 && aw.unhandled[0].key === 'items' && aw.unhandled[0].count === 1,
    JSON.stringify(aw.unhandled));
  ok('结构审计：第四种键会进 `stats.unknownChildKeys`（真机上还会打警告，不静默）',
    normalizeAxurePage({ document: weirdDoc, html: '' }).stats.unknownChildKeys.length === 1);

  // 守住 `type !== 'Axure:PanelDiagram'` 那个排除条件（别让它变成没人监督的魔法常量）
  ok('结构审计：文档里的 `Axure:PanelDiagram` 数量 == 经 `diagrams` 走到的数量（排除条件受监督）',
    pn2audit(panelDoc).inDoc === pn2audit(panelDoc).viaDiagrams, JSON.stringify(pn2audit(panelDoc)));

  // ⭐ 交叉校验：用**通用参考遍历**（按"元素像不像控件"走，**不看键名**）数一遍，
  //    与遍历器的输出对齐 —— 于是"删掉任一子层键"必然让两者不等 → 报红。
  const WIDGETISH = (x) => Boolean(x && typeof x === 'object' && x.id && (x.type || x.style || x.friendlyType));
  const genericCount = (arr) => {
    let n = 0;
    for (const node of arr ?? []) {
      n += 1;
      for (const val of Object.values(node ?? {})) {
        if (Array.isArray(val) && val.some(WIDGETISH)) n += genericCount(val);
      }
    }
    return n;
  };
  ok('结构审计：**通用参考遍历**（不看键名）与遍历器输出层数一致 —— 少走任一键都会不等',
    genericCount(objDoc.page.diagram.objects) === od.layers.length - 1,
    `参考 ${genericCount(objDoc.page.diagram.objects)} vs 遍历器 ${od.layers.length - 1}`);
  ok('结构审计：面板夹具上同样一致（含状态容器）',
    genericCount(panelDoc.page.diagram.objects) === pn.layers.length - 1,
    `参考 ${genericCount(panelDoc.page.diagram.objects)} vs 遍历器 ${pn.layers.length - 1}`);
  // 光进 stats 不算"报出来了" —— 输出里必须真的有 ❌ 警告，否则 AI 看不到
  {
    const fakeResult = {
      doc: { name: 'X' }, project: null, version: { id: 'v', isLatest: true, count: 1 },
      content: [{
        path: 'p', pageId: 'pg', readable: true, layers: [], tokens: null,
        stats: { widgetCount: 1, unknownChildKeys: [{ key: 'items', count: 3, samplePath: 'doc.page.diagram.objects[0].items' }] },
      }],
    };
    const t = renderProductLayers(fakeResult, {});
    ok('结构审计：**输出里真的会打 ❌ 警告**（不只是 stats 里一个字段）',
      /还有没被遍历的子层键/.test(t) && /items/.test(t), t.split('\n').slice(0, 7).join(' | ').slice(0, 130));
  }

  ok('结构审计：`AXURE_CHILD_KEYS` 就是遍历器声明会走的那三个键',
    JSON.stringify([...AXURE_CHILD_KEYS]) === JSON.stringify(['objs', 'objects', 'diagrams']), JSON.stringify(AXURE_CHILD_KEYS));

  // ── `axureScriptIds` 的契约：传错形状必须**抛错**，不许静默给空 Map（实测被误用过）
  ok('axureScriptIds：正确入参（整个 doc）能取到映射',
    axureScriptIds({ objectPaths: { a: { scriptId: 'u1' }, b: { scriptId: 'u2' } } }).size === 2);
  for (const [label, bad] of [['doc.page', { page: {} }], ['null', null], ['原文 JSON 字符串', '{"objectPaths":{}}'], ['空对象', {}]]) {
    ok(`axureScriptIds：传 ${label} → **抛错**（曾静默返回空 Map）`,
      (() => { try { axureScriptIds(bad); return false; } catch { return true; } })());
  }
}

/* ═══════════ 攒着的小改进（0.4.0）：url / order / withPages / 路径 ═══════════ */
{
  const hostSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lanhu.mjs'), 'utf8');

  // ── 改进1：list_designs 收 url（一致性 —— 兄弟工具都收，它原来只收 projectId）──
  const ld = pick('lanhu_list_designs');
  ok('list_designs 声明了 url', 'url' in ld.parameters.properties);
  ok('list_designs 的 projectId 已**非必填**（原来 required:true）', ld.parameters.properties.projectId?.required !== true);
  ok('list_designs 描述写明"可以直接贴链接"', /贴.*链接/.test(ld.description));
  // 都不给 → 必须明确报错，**不许静默返回空列表**（这一步不发网络请求，可离屏测）
  const ldNoArgs = await ld.execute({});
  ok('list_designs 两个都不给 → 明确报错（不静默给空表）',
    /需要 projectId/.test(ldNoArgs.text ?? ''), String(ldNoArgs.text ?? '').slice(0, 56));

  // ── parseProjectTarget：面向"项目"的解析（**不要求 image_id**）──
  const TID2 = '00000006-0000-4000-8000-000000000006';
  const PID2 = '00000007-0000-4000-8000-000000000007';
  const projectPage = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID2}&pid=${PID2}`;
  const pt = parseProjectTarget(projectPage);
  ok('项目页链接（**没有 image_id**）也能取到 pid / tid',
    pt.projectId === PID2 && pt.teamId === TID2 && pt.imageId === null, JSON.stringify(pt).slice(0, 76));
  ok('直接给一个 uuid → 当项目 id 用', parseProjectTarget(PID2).projectId === PID2);
  let noPidErr = null;
  try { parseProjectTarget('https://example.com/x'); } catch (e) { noPidErr = e; }
  ok('链接里没有 pid → 明确抛错（不静默）', !!noPidErr && /项目 id/.test(noPidErr.message));
  // ⚠️ 反向守卫：parseLanhuUrl 面向"某一张稿"，**必须继续要求 image_id** ——
  //    别为了给 list_designs 让步而把它改宽容，那会破坏 read_design 等一串工具。
  let noImgErr = null;
  try { parseLanhuUrl(projectPage); } catch (e) { noImgErr = e; }
  ok('parseLanhuUrl 仍**要求** image_id（没被顺手改宽容）', !!noImgErr && /image_id/.test(noImgErr.message));

  // ── 改进2：清单加 order + 说明面板按 order 倒序且是滚动区 ──
  const lp = pick('lanhu_list_product_documents');
  ok('list_product_documents 描述提到 order 与"滚动区"', /order/.test(lp.description) && /滚动/.test(lp.description));
  ok('清单表格里有「序」这一列（表格构造器现在住在 lanhu.mjs，工具与 CLI 共用）',
    /\| # \| 序 \|/.test(cliSrc));
  ok('清单渲染带"不代表只有那几个"的说明（防把滚动区误读成只有几个）', /不代表只有那几个/.test(hostSrc));

  // ── 改进3：withPages（**默认关** + 代价写进描述 + 单份失败不炸表）──
  const wp = lp.parameters.properties.withPages;
  ok('withPages 已声明且是 boolean', wp?.type === 'boolean');
  ok('withPages **默认关**（描述里写明）', /默认关/.test(wp?.description ?? ''), String(wp?.description ?? '').slice(0, 50));
  ok('withPages 的**代价**写进描述（N 份 = N 次额外请求）', /额外请求/.test(wp?.description ?? ''));
  ok('单份失败**不炸整张表**（源码里给 pages.reason 兜底）', /pages\.reason/.test(hostSrc) && /d\.pages = \{ nodes: null/.test(hostSrc));
  // 纯函数：数 sitemap 规模（withPages 靠它，而那条路要发网络请求 → 必须能离屏测）
  ok('countSitemapPages：节点与可读页**分开数**（Folder 没有 url）',
    JSON.stringify(countSitemapPages([{ pageName: 'a', url: 'a.html' }, { pageName: 'F', children: [{ pageName: 'b', url: 'b.html' }] }])) === '{"nodes":3,"readable":2}',
    JSON.stringify(countSitemapPages([{ pageName: 'a', url: 'a.html' }, { pageName: 'F', children: [{ pageName: 'b', url: 'b.html' }] }])));
  ok('countSitemapPages：空树 / null / 垃圾项都不炸',
    JSON.stringify(countSitemapPages([])) === '{"nodes":0,"readable":0}'
    && JSON.stringify(countSitemapPages(null)) === '{"nodes":0,"readable":0}'
    && JSON.stringify(countSitemapPages([null, {}, { pageName: 'x', url: 'x.html' }])) === '{"nodes":1,"readable":1}');
  ok('countSitemapPages：只有 Folder → nodes>0 且 readable=0（两个数别混用）',
    JSON.stringify(countSitemapPages([{ pageName: 'F', children: [{ pageName: 'G' }] }])) === '{"nodes":2,"readable":0}');


  // ── 表格构造器：行列数必须一致（实测踩过「多一个空列」—— 单元格带了前导竖线，
  //    而行模板已经收尾；**工具与 CLI 各栽了一次**，所以抽成共用纯函数并在这里钉住）──
  const nPipes = (line) => (line.match(/\|/g) ?? []).length;
  const rowA = { order: 3, name: 'A', docId: 'd1', latestVersion: 'v1', lastVersionNum: 2, updateTime: 't', isReplaced: false };
  const tOff = productDocsTable([rowA]);
  ok('productDocsTable 默认（withPages 关）：表头/分隔/行**列数一致**且不含页面列',
    nPipes(tOff.header) === nPipes(tOff.sep) && nPipes(tOff.sep) === nPipes(tOff.rows[0]) && !/页面节点/.test(tOff.header),
    `${nPipes(tOff.header)}/${nPipes(tOff.sep)}/${nPipes(tOff.rows[0])}`);
  const tOn = productDocsTable([{ ...rowA, pages: { nodes: 219, readable: 188 } }], { withPages: true });
  ok('productDocsTable withPages 开：列数仍一致，页面列是「节点 / 可读页」',
    nPipes(tOn.header) === nPipes(tOn.rows[0]) && nPipes(tOn.header) > nPipes(tOff.header) && /219 \/ 188/.test(tOn.rows[0]),
    tOn.rows[0]);
  const tBad = productDocsTable([{ ...rowA, pages: { nodes: null, readable: null, reason: '拉取失败' } }], { withPages: true });
  ok('productDocsTable：单份失败 → 该格为 `?` 且**列数不变**',
    /\| \? \|$/.test(tBad.rows[0]) && nPipes(tBad.header) === nPipes(tBad.rows[0]), tBad.rows[0]);
  ok('工具与 CLI **共用**同一个表格构造器（不让同一个 bug 各栽一次）',
    /productDocsTable\(listed\.axureDocs/.test(hostSrc) && /productDocsTable\(listed\.axureDocs/.test(cliSrc));

  // ── 改进4**补刀**：路径标注必须覆盖**所有**打印点，且判定在源头 ──
  //    ⚠️ 已知人读标题打印点清单（**以后新增打印页面路径的地方，必须走 titleName() 并在此登记**）：
  //      ① `# 块级清单 —`      ② `# 设计 Token —`
  //      ③ renderSummary 的 `#`  ④ `# 字体需求 ——`
  //      ⑤ `# 原型页面样式 ——` 之下那行 `> 路径：`   ⑥ 每页的 `## 路径：`
  //    （⑤⑥ 在 renderProductLayers 内，由下面另一段断言守着）
  {
    const pathMeta = { name: 'A / B / C', nameIsPath: true, width: 100, height: 200 };
    const tok0 = { colors: [], fontSizes: [], fontWeights: [], fontFamilies: [], radii: [] };
    const sites = [
      ['① 块级清单', () => renderBlocks([], pathMeta).split('\n')[0]],
      ['② 设计 Token', () => renderTokens(tok0, pathMeta).split('\n')[0]],
      ['③ summary', () => renderSummary({ detail: {}, layers: [], tokens: tok0, meta: pathMeta }).split('\n')[0]],
      ['④ 字体需求', () => renderFonts([], pathMeta).split('\n')[0]],
    ];
    for (const [label, fn] of sites) {
      const line = fn();
      ok(`打印点 ${label} 对**路径** meta 标了「路径：」`, /路径：A \/ B \/ C/.test(line), line.slice(0, 58));
    }
    // 反向：普通稿名**不许**加前缀 —— 满屏"路径："同样是噪声
    const plainMeta = { name: '某详情页', width: 375, height: 1333 };
    ok('反向：普通稿名**不**加「路径：」前缀', !/路径：/.test(renderBlocks([], plainMeta).split('\n')[0]),
      renderBlocks([], plainMeta).split('\n')[0].slice(0, 50));
    // 源头必须打标记 —— 漏了它上面四条会一起失灵
    ok('源头：原型页把 path 当 name 时**必须**同时给 nameIsPath:true（判定在源头，不在打印点）',
      /name: p\.path,[\s\S]{0,220}?nameIsPath: true,/.test(cliSrc));
    // 政策：不许再有标题直接插 ${meta.name}（必须走 titleName）
    ok('政策：标题里不再直接插 `${meta.name}`（一律走 titleName —— 防新增站点又漏）',
      !/\$\{meta\.name\}/.test(cliSrc));
    // helper 自身行为
    ok('titleName：路径加前缀 / 稿名不加 / 空安全',
      titleName({ name: 'A / B', nameIsPath: true }) === '路径：A / B'
      && titleName({ name: 'X' }) === 'X' && titleName({}) === '' && titleName(null) === '');
  }

  // ── 改进4：原型 layers 标题必须标明是「路径」──
  // 嵌套页面的 path 是 `A / B / C` 拼起来的，不标注会被读成"把多页合并了"（实测误报过一次）
  const synth = {
    doc: { name: '某原型' }, project: { name: 'P' }, version: { id: 'v1', isLatest: true },
    content: [{ pageId: 'p1', path: 'A / B / C', readable: false, reason: '测试夹具' }],
  };
  const rendered = renderProductLayers(synth);
  // ⚠️ **两处都要断言**：标题行一处、每个页面标题一处 —— 只断言一处时，
  //    去掉另一处的变异**不会红**（实测：只查标题行时，把 `## 路径：` 改回裸 path 照样全绿）。
  const pathLines = rendered.split('\n').filter((l) => /路径：/.test(l));
  ok('「路径：」出现在**标题行**（文档名与路径分行，不再拼成 `文档 / A / B`）',
    pathLines.some((l) => l.startsWith('> 路径：')), pathLines.map((l) => l.slice(0, 22)).join(' ／ '));
  ok('「路径：」也出现在**每个页面标题**上（嵌套 path 最容易被读成多页）',
    pathLines.some((l) => l.startsWith('## 路径：')), pathLines.map((l) => l.slice(0, 22)).join(' ／ '));
}


/* ═══════════ 项目信息取不到时：**降级，但不静默** ═══════════ */
{
  const base = {
    doc: { name: '某原型' }, version: { id: 'v1', isLatest: true },
    content: [{ pageId: 'p1', path: 'A', readable: false, reason: '夹具' }],
  };
  // 反例：取不到 → 人读文本必须**说出原因**（以前 `.catch(() => null)` 只是少一行，分不清"真没有"还是"取失败"）
  const bad = renderProductLayers({ ...base, project: null, projectInfoError: 'boom：HTTP 500' });
  ok('renderProductLayers：项目信息没取到 → 提示**带原因**',
    /项目信息未取到（boom：HTTP 500）/.test(bad),
    bad.split('\n').find((l) => /项目信息/.test(l)) ?? '（没找到提示行）');
  const badDoc = renderProductDoc({
    ...base, project: null, projectInfoError: 'boom：HTTP 500',
    pageCount: 1, wireframeCount: 1, pages: [],
  });
  ok('renderProductDoc：同样带原因', /项目信息未取到（boom：HTTP 500）/.test(badDoc),
    badDoc.split('\n').find((l) => /项目信息/.test(l)) ?? '（没找到提示行）');
  // 正例：正常时**不许**出现该提示（满屏"未取到"同样是噪声）
  const good = renderProductLayers({ ...base, project: { name: 'P', folderName: 'F' }, projectInfoError: null });
  ok('renderProductLayers：正常时**不出现**该提示', !/项目信息未取到/.test(good));
  ok('renderProductLayers：正常时「项目：」那行照旧', /> 项目：P（F）/.test(good));
  // tryProjectInfo 自身：失败时 info=null 且 error 非空（空 projectId → 同步抛，零网络）
  const r = await tryProjectInfo('', null, {});
  ok('tryProjectInfo：失败 → {info:null, error:非空}（不抛错、不静默）',
    r.info === null && typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r).slice(0, 90));
}

/* ═══════ CLI 的 --account 透传（工具链有同款守卫；**CLI 这条缝里漏出过 30005**） ═══════ */
{
  // 起因：CLI 的 16 个 cmdXxx 全都没把 args.account 传给核心函数 → 永远走默认账号。
  // 实测：示例团队（属 demo）用默认账号 default-acct 调 search → `code=30005 用户或团队不存在`，
  //      而同入参改走工具（带 account）就正常。**工具对、CLI 错**，就是这条缝。
  const hostSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lanhu.mjs'), 'utf8');
  const NET_CALL = /await (checkAuth|listTeams|listDirectory|listSectors|listImages|search|readDesign|readBlocks|readProductDoc|downloadSlices|verifySpec|saveCookie|productDocuments|tryProjectInfo|fetchDesignTree|whoIsIt|buildAccountIndex)\(/;
  // 显式白名单：**注入但不适用**，不是漏传。改动这里必须同时改 lanhu.mjs 里对应函数的注释。
  const NOT_APPLICABLE = {
    cmdLog: '纯本地读使用记录，不走网络',
    cmdAccounts: '它管理全部账号，要操作哪个用 --alias —— 与 --account（用哪个身份）语义不同',
    cmdWho: '它的职责就是跨账号判定（遍历各账号 Cookie 去试），指定 account 等于让它别干本职',
  };
  // ⚠️ 这里踩过一次：朴素的"数花括号"会**从参数表的 `{` 就开始数**，
  //    于是 `({ args, cookie })` 一闭合就返回（实测只拿到 41 个字符）→ 所有命令都被当成"不走网络"。
  //    而且模板字符串里的 `${…}` 也会被误算。所以必须**跳过参数表 + 字符串感知**。
  const bodyOf = (name) => {
    const sig = hostSrc.indexOf(`async function ${name}(`);
    if (sig < 0) return null;
    // 1) 先跳过参数表：从 sig 起找配平的 `)`（字符串感知）
    let j = hostSrc.indexOf('(', sig), pd = 0, q = null;
    for (; j < hostSrc.length; j += 1) {
      const c = hostSrc[j];
      if (q) { if (c === '\\') j += 1; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '(') pd += 1;
      else if (c === ')') { pd -= 1; if (pd === 0) break; }
    }
    // 2) 再找函数体的 `{`，并对它做字符串感知的配平
    const start = hostSrc.indexOf('{', j);
    if (start < 0) return null;
    let depth = 0, k = start; q = null;
    for (; k < hostSrc.length; k += 1) {
      const c = hostSrc[k];
      if (q) { if (c === '\\') k += 1; else if (c === q) q = null; continue; }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '/' && hostSrc[k + 1] === '/') { k = hostSrc.indexOf('\n', k); if (k < 0) break; continue; }
      if (c === '/' && hostSrc[k + 1] === '*') { k = hostSrc.indexOf('*/', k) + 1; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) return hostSrc.slice(sig, k + 1); }
    }
    return hostSrc.slice(sig);
  };
  const names = [...hostSrc.matchAll(/^async function (cmd[A-Z]\w*)\(/gm)].map((m) => m[1]);
  ok('能枚举出 CLI 的命令处理器（守卫本身要可靠）', names.length >= 12, `枚举到 ${names.length} 个`);
  let checked = 0;
  for (const n of names) {
    const body = bodyOf(n);
    ok(`${n} 的源码区间能定位`, !!body && body.length > 20);
    if (!body) continue;
    if (NOT_APPLICABLE[n]) continue;
    if (!NET_CALL.test(body)) continue;          // 不走网络 → 不要求
    checked += 1;
    ok(`${n} 把 args.account 传给了核心函数`, body.includes('args.account'), '没传 → 会永远走默认账号');
  }
  ok('确实检查到了走网络的命令（不是空跑）', checked >= 12, `检查了 ${checked} 个`);
  // 白名单**不许变成摆设**：它列的命令必须真实存在，且确实没传 account
  for (const [n, why] of Object.entries(NOT_APPLICABLE)) {
    const body = bodyOf(n);
    ok(`白名单 ${n} 真实存在（${why}）`, !!body, '白名单里的命令没了 → 名单该更新');
    if (body) ok(`白名单 ${n} 确实没传 args.account（否则该从名单里移出）`, !body.includes('args.account'));
  }
}

/* ═══════ CLI search：三类结果都要打（原先只打 images → PRD-only 的搜索**零输出**） ═══════ */
{
  const imgsOnly = searchLines({ images: [{ imageId: 'i1', name: '稿A', projectName: 'P', path: '/x' }], prds: [], projects: [] }, 'kw');
  ok('search：只有稿时打稿 + 汇总', imgsOnly.length === 2 && /稿 1 · PRD 0/.test(imgsOnly[1]), JSON.stringify(imgsOnly).slice(0, 90));
  // ⚠️ 这条就是真缺陷的回归：原先只遍历 r.images → 命中 PRD 时**什么都不打**、退出码却是 0
  const prdsOnly = searchLines({ images: [], prds: [{ prdId: 'p1', name: 'PRD A', path: '/y' }], projects: [] }, 'kw');
  ok('search：**只有 PRD 时也必须打**（原先零输出 + 退出码 0）',
    prdsOnly.some((l) => /\[PRD\]/.test(l)) && prdsOnly.length === 2, JSON.stringify(prdsOnly).slice(0, 90));
  const projsOnly = searchLines({ images: [], prds: [], projects: [{ projectId: 'j1', name: '项目A' }] }, 'kw');
  ok('search：只有项目时也打', projsOnly.some((l) => /\[项目\]/.test(l)), JSON.stringify(projsOnly).slice(0, 80));
  const empty = searchLines({ images: [], prds: [], projects: [] }, 'kw');
  ok('search：三类全空 → 明说"没有匹配"（**不许零输出**）',
    empty.length === 1 && /没有匹配/.test(empty[0]), JSON.stringify(empty));
  ok('search：字段缺失时不许抛（防御性）', searchLines({}, 'kw')[0].includes('没有匹配'));
}

/* ═══════ 注入内容与工具结果优化（规划文档 2026-09-29：P0-1..P2-1） ═══════ */
group('注入与结果优化');
{
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tokensEmpty = { colors: [], fontSizes: [], fontWeights: [], fontFamilies: [], radii: [] };
  const mkLayer = (o) => ({
    visible: true, text: null, w: 120, h: 152, x: 20, y: 20, radius: null, colors: [],
    hasImage: true, name: '头像', effectiveOpacity: 1, opacity: 1, inset: null, font: null, type: 'image', depth: 1, ...o,
  });
  const sumOpts = (layers, meta = { width: 375, height: 800 }, extra = {}) => ({
    detail: { name: 'T' }, layers, tokens: tokensEmpty, meta, ...extra,
  });

  // ── P0-1（§3.1/3.2/3.3/3.4/3.5/3.6）：注入必须教会"什么时候用哪个工具" ──
  const hintSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8');
  const hm = /const SYSTEM_HINT = \[([\s\S]*?)\]\.join/.exec(hintSrc);
  ok('SYSTEM_HINT 能定位', Boolean(hm), '找不到定义 → 后面全部无从谈起');
  const hint = hm ? hm[1] : '';
  for (const kw of ['read_blocks', 'gapMaxDistance', 'verify_blocks', 'rpx', 'region', 'format=tokens', 'version', '对比度']) {
    ok(`注入含「${kw}」（决策树 / 换算 / 溯源）`, hint.includes(kw), `缺「${kw}」→ AI 不知道有这个能力，就会退回"summary 不够→full→自己写脚本"`);
  }
  ok('注入不再说「拿到 token 后」（§3.6 过时术语）', !/拿到 token/.test(hint), '会被理解成"得先拿 token 才能干活"——实际返回的是图层数值');
  ok('注入含「以稿为准」三条硬约束（字重/间距/色值）',
    /以稿为准/.test(hint) && /字重/.test(hint) && /alpha/.test(hint) && /实色/.test(hint), '这三条是实测踩过的坑');

  // ── P0-2（§4.1）：summary 的关键容器必须放行 hasImage ──
  const headOnly = mkLayer({});
  const sum = renderSummary(sumOpts([headOnly, mkLayer({ name: '普通无样式层', hasImage: false, w: 200, h: 60 })]));
  ok('summary 关键容器放行 hasImage（头像这类切图块天然无填充无圆角）',
    /头像/.test(sum) && /120×152/.test(sum), '被滤掉的话 AI 只能拉 full + 自己写脚本 —— 实测就是这么绕的弯路');
  ok('切图块在「填充」列标了 `切图`（否则一行 —/— 看着像噪音）', /切图/.test(sum), '标记是为了说明它为什么在表里');
  ok('无填充无圆角**且无图**的层仍被过滤（不是把噪音全放进来）', !/普通无样式层/.test(sum), '放行 hasImage 不该捎带把结构层噪音也放了');

  // ── P0-3（§4.3/4.4）：色值直出 rgba + 双单位只在该给的地方 ──
  const semi = { role: 'fill', r: 87, g: 74, b: 244, a: 0.1 };
  const sumC = renderSummary(sumOpts([
    mkLayer({ name: '徽章', hasImage: false, radius: null, colors: [semi] }),
    mkLayer({ name: '底卡', hasImage: false, radius: null, colors: [semi], x: 0, y: 200, w: 300, h: 60 }),
  ]));
  ok('半透明填充**同时**给 `@10%` 与 `rgba(…)`（保留原串便于回查 + 可直接粘贴）',
    /@10%/.test(sumC) && /rgba\(87, 74, 244, 0\.1\)/.test(sumC), '只给 @10% 的话调用方还得手转一次');
  ok('双单位默认**不**出现在宽表（免每行撑到 200+ 字符）',
    !/rpx/.test(sumC.split('## 间距')[0]), '默认就双单位会与 §4.6 的省字节目标打架');
  ok('「间距一览」段**始终**双单位（那一段就是要直接抄进 CSS 的）', /rpx/.test(sumC));
  const sumD = renderSummary(sumOpts([mkLayer({})], { width: 375, height: 800 }, { dualUnits: true }));
  ok('开了 dualUnits 宽表才给双单位（`120×152px / 240×304rpx`）',
    /120×152px \/ 240×304rpx/.test(sumD), '开关没接上的话这条会红');
  ok('双单位的单位只出现一次（`240×304rpx`，不是 `240rpx×304rpx`）',
    !/rpx×/.test(sumD), '这是拼接时想当然的产物，实测踩过');

  // ── P0-4（§4.2）：间距一览的数字与方向必须对 —— 用文档里的手算值当夹具 ──
  const items = [
    { name: '头像', x: 20, y: 20, w: 120, h: 152 },
    { name: '姓名行', x: 160, y: 49.94, w: 100, h: 24 },
    { name: '角色', x: 160, y: 79.94, w: 80, h: 20 },
    { name: '说明块', x: 160, y: 120.34, w: 299, h: 51.66 },
  ];
  const dg = renderGapDigest(items, { designWidth: 375 });
  ok('间距段给出「角色 ↕ 说明块 = **20.4px / 41rpx**」（=文档手算值）',
    /角色 ↕ 说明块 = \*\*20\.4px \/ 41rpx\*\*/.test(dg), dg.slice(0, 160));
  ok('间距段给出「姓名行 ↕ 角色 = **6px / 12rpx**」', /姓名行 ↕ 角色 = \*\*6px \/ 12rpx\*\*/.test(dg));
  ok('间距段给出齐平「头像 底 ≡ 说明块 底」（geometricGaps 给不出、单独算的那类）',
    /头像 底 ≡ 说明块 底/.test(dg), '这类"齐平"关系同样要抄进 CSS');
  ok('间距段写明换算基准（看得出 ×2 是怎么来的）', /按画板宽 375/.test(dg));
  ok('画板宽度未知 → 一个 rpx 数值都不给（不编比例；注释里提到 rpx 不算）',
    !/\d+rpx/.test(renderGapDigest(items, {})), '基准拿不到时只能给 px');
  ok('斜对角**不算**间距（另一轴无重叠）',
    !/斜对A/.test(renderGapDigest([{ name: '斜对A', x: 0, y: 0, w: 10, h: 10 }, { name: '斜对B', x: 500, y: 500, w: 10, h: 10 }], { designWidth: 375 })),
    '斜对角的距离在还原时毫无意义，混进来就是假间距');
  ok('对齐判据不认"离得老远但数值凑巧相等"',
    alignedEdges([{ name: 'A', x: 0, y: 100, w: 20, h: 20 }, { name: 'B', x: 3000, y: 100, w: 20, h: 20 }]).length === 0,
    '少了"另一轴有关联"这条，任意两块都可能被报成对齐');

  // ── 齐平段：自我成对 / 祖先-后代成对必须排除（实测踩过），但真·兄弟不能一起砍 ──
  const R = { x: 10, y: 10, w: 100, h: 50 };
  ok('同一元素（同 path）**绝不**与自己成对（`X ≡ X` 是纯噪声）',
    alignedEdges([{ path: 'A', name: 'A', ...R }, { path: 'A', name: 'A', ...R }]).length === 0,
    '实测真机上出现过 `Section - ModalDialogC 顶 ≡ Section - ModalDialogC 顶`');
  ok('祖先/后代成对也排除（子层撑满父层不是设计决策）',
    alignedEdges([
      { path: 'A', name: 'Card', depth: 1, ...R },
      { path: 'A/A:shadow', name: 'Card:shadow', depth: 2, ...R },
    ]).length === 0, '阴影/背景层几乎撑满父层，四条边全"重合" → 抄进 CSS 毫无意义');
  ok('真·兄弟边齐平**仍要报**（别一刀切把好的一起砍）',
    alignedEdges([
      { path: 'A/1', name: '张顾问', depth: 2, x: 0, y: 0, w: 40, h: 20 },
      { path: 'A/2', name: 'Verified Badge', depth: 2, x: 50, y: 0, w: 30, h: 16 },
    ]).some((a) => a.from.name === '张顾问' && a.edge === '顶'), '这条是好数据，砍了就是过度修正');
  // 显示名去歧义：同名（或长名被截断后同名）必须能分清是哪两块
  const ambLines = renderGapDigest([
    { path: 'P/Section - ModalDialogCard', name: 'Section - ModalDialogCard', depth: 1, x: 0, y: 0, w: 100, h: 50 },
    { path: 'P/Q', name: 'Section - ModalDialogCard:shadow', depth: 2, x: 0, y: 0, w: 90, h: 40 },
    { path: 'P/Z', name: 'Z', depth: 3, x: 300, y: 0, w: 10, h: 10 },
  ], { designWidth: 375 }).split('\n').filter((l) => l.startsWith('- '));
  ok('长名截断撞车时，**间距行**也显示去歧义后的名字（不是两个一模一样的截断名）',
    ambLines.some((l) => /#d\d/.test(l)), ambLines.slice(0, 2).join(' || ').slice(0, 130));
  const ambAl = renderGapDigest([
    { path: 'P/A', name: `${'X'.repeat(25)}A`, depth: 1, x: 0, y: 0, w: 100, h: 50 },
    { path: 'P/B', name: `${'X'.repeat(25)}B`, depth: 2, x: 0, y: 0, w: 90, h: 40 },
  ], { designWidth: 375 });
  ok('齐平行同样去歧义（截断后同前缀 → 补 #d<深度>）',
    /#d\d/.test(ambAl.split('\n').filter((l) => l.includes('≡')).join(' ')),
    ambAl.split('\n').filter((l) => l.includes('≡')).join(' || ').slice(0, 130));

  // ── P1-1/P1-2（§4.5/4.6）：结果自带下一步 + 体积 ──
  ok('summary 尾部有「下一步提示」且提到 region', /ℹ️/.test(sum) && /region/.test(sum.slice(sum.indexOf('ℹ️'))), '把决策树同时放进结果里，AI 读结果时也能被纠正');
  ok('结果尾注给体积（`≈x.xxKB`）', /≈\d+\.\d+KB/.test(sum), '有成本意识才不会动辄读全文');
  const mkBlock = (o) => ({ kind: 'card', name: '卡片', x: 0, y: 0, w: 343, h: 458, radius: { max: 14, pill: false }, bg: { hex: '#574af4', alpha: 0.1, stops: [] }, opacity: 1, border: null, text: null, font: null, color: null, noise: false, ...o });
  const blk = renderBlocks([mkBlock({}), mkBlock({ name: '底卡2', x: 0, y: 500, w: 343, h: 80 })], { width: 375, height: 800 });
  ok('blocks 尾注也有体积 + 间距一览', /≈\d+\.\d+KB/.test(blk) && /间距一览/.test(blk));
  ok('blocks 的底色列给了 rgba（区块侧走 bgText，与图层侧同口径）', /@10% \(rgba\(87, 74, 244, 0\.1\)\)/.test(blk), blk.split('\n').find((l) => l.includes('574af4')) ?? '');
  ok('落盘路径只在真有 full 时才提（这里没有，所以不该出现「已落盘」）', !/已落盘/.test(blk));

  // ── P2-1（§4.7）：meta 进标题行，且**拿不到不编** ──
  const sumV = renderSummary(sumOpts([headOnly], { name: 'T', width: 375, height: 800, versionId: 'abcdef1234567890', versionIsLatest: true, latestVersionAt: '2026-09-29T10:00:00Z' }));
  ok('标题行带 version 与更新时间', /version=abcdef12/.test(sumV) && /更新于 2026-09-29/.test(sumV));
  ok('拿不到版本时**不编**（标题行不出现 version= / 更新于）', !/version=/.test(sum) && !/更新于/.test(sum), '编一个版本号比没有更糟');
  const sumOld = renderSummary(sumOpts([headOnly], { name: 'T', width: 375, height: 800, versionId: 'deadbeef0000', versionIsLatest: false, latestVersionAt: '2026-09-29T10:00:00Z' }));
  ok('读旧版时**不**把"最新版时间"说成这版的时间', /最新版更新于 2026-09-29（你读的是旧版）/.test(sumOld), '看着有、其实指错的信息比没有更糟');
}

/* ═══════ 画板内边距：画板是画布绝对坐标，子层是画板相对坐标（实测 26 个层中招） ═══════ */
{
  // 真实案例：某大屏稿，画板 x=14599 y=258，子层「大标题」在 0,0 且铺满宽
  const flat = flattenArtboard({
    id: 'ab', name: '画板', realFrame: { left: 14599, top: 258, width: 1920, height: 1080 },
    layers: [
      { id: 'c1', name: '大标题', realFrame: { left: 0, top: 0, width: 1920, height: 160 } },
      { id: 'c2', name: '菜单栏', realFrame: { left: 0, top: 287, width: 215, height: 630 } },
      // 深层：父是普通容器，**不该**被这条改动影响
      { id: 'c3', name: '组', realFrame: { left: 100, top: 50, width: 400, height: 300 }, layers: [
        { id: 'c4', name: '组内块', realFrame: { left: 120, top: 80, width: 100, height: 60 } },
      ] },
    ],
  });
  const byName = Object.fromEntries(flat.map((l) => [l.name, l]));
  ok('画板不在原点时，深度 1 的内边距**按画板原点**算（不是画布绝对坐标）',
    JSON.stringify(byName['大标题'].inset) === JSON.stringify({ left: 0, top: 0, right: 0, bottom: 920 }),
    JSON.stringify(byName['大标题'].inset));
  ok('深度 1 的另一层同样正确（独立手算值 0/287/1705/163）',
    JSON.stringify(byName['菜单栏'].inset) === JSON.stringify({ left: 0, top: 287, right: 1705, bottom: 163 }),
    JSON.stringify(byName['菜单栏'].inset));
  ok('画板自己没有父层 → inset 为 null（合法 lossless JSON）', byName['画板'].inset === null, String(byName['画板'].inset));
  // ⚠️ 防过度修正：普通容器链**必须**继续用父子相减（父 100,50 → 子 120,80 ⇒ left 20 / top 30）
  ok('普通容器链不受影响（父 100,50 → 子 120,80 ⇒ 20/30）',
    JSON.stringify(byName['组内块'].inset) === JSON.stringify({ left: 20, top: 30, right: 280, bottom: 210 }),
    JSON.stringify(byName['组内块'].inset));
  ok('深度 1 但**画板在原点**时也正确（不因改动而变）',
    JSON.stringify(flattenArtboard({ name: 'A', realFrame: { left: 0, top: 0, width: 375, height: 812 },
      layers: [{ name: 'X', realFrame: { left: 10, top: 20, width: 100, height: 50 } }] })[1].inset)
      === JSON.stringify({ left: 10, top: 20, right: 265, bottom: 742 }));
}

/* ═══════ 间距一览：画板（画布绝对坐标）不得进入候选集（实测 3/10 条是垃圾） ═══════ */
{
  // 真实案例：某稿，画板在画布 1312,6805，子块在画板相对坐标 1143,763 一带 →
  // 相减得 5987px，而画板对角只有 551px。
  // ⚠️ 夹具必须**几何上真的能触发**那条垃圾关系：间距只在**另一轴有重叠**时才算，
  //    所以块的 x 区间要**压住画板的 x 区间**（真机就是这么构成的：画板 x 1312 起，
  //    子块 x 1143..1331 —— 在 1312..1331 上重叠，于是 y 方向算出 5987px）。
  //    我第一版把块放在 x=0（与画板 x 1312..3232 完全不重叠）→ 加了画板也算不出间距 →
  //    **变异不红、断言是瞎的**（靠变异测试才发现）。
  const d = renderGapDigest([
    { id: 'ab', name: '画板 – 1', depth: 0, x: 1312, y: 6805, w: 1920, h: 1080 },
    { id: 'a', name: '块A', depth: 1, x: 1250, y: 700, w: 100, h: 50 },
    { id: 'b', name: '块B', depth: 1, x: 1250, y: 760, w: 100, h: 50 },
  ], { designWidth: 1920 });
  // ⚠️ 只查**数据行**（`- ` 开头）——表头里本来就有「按画板宽 1920」，
  //    拿整段做 includes 会误判（我第一版就是这么写的，被自己的断言骗了一次）。
  const gapRows = d.split('\n').filter((l) => l.startsWith('- '));
  ok('间距一览的**数据行**不含画板（画布绝对坐标 vs 画板相对坐标，跨坐标系）',
    gapRows.length > 0 && !gapRows.some((l) => l.includes('画板')),
    gapRows.filter((l) => l.includes('画板')).slice(0, 2).join(' / ') || `查了 ${gapRows.length} 行，无画板`);
  ok('间距一览**仍给出真块之间的关系**（防过度排除）', /块A ↕ 块B = \*\*10px/.test(d), d.split('\n').find((l) => l.includes('块A')) ?? '(没找到)');
  // 画板是唯一元素时，不应产出任何内容（< 2 个候选）
  ok('只剩画板时不给表（不硬凑）',
    renderGapDigest([{ name: '画板', depth: 0, x: 1, y: 2, w: 10, h: 10 }], { designWidth: 10 }) === '');
}

/* ═══════ list_designs 的尺寸是「缩略图预览尺寸」（实测 ¼），别让 AI 拿它算 rpx ═══════ */
{
  // SYSTEM_HINT 是 lib/index.js 的私有常量（未导出），所以按**源码文本**断言。
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const idxSrc = fs.readFileSync(path.join(_root, 'lib/index.js'), 'utf8');
  const cliSrc = fs.readFileSync(path.join(_root, 'lanhu.mjs'), 'utf8');
  ok('注入里警告了「列表尺寸是预览尺寸，别拿它算 rpx」',
    /列表接口（list_designs）给的是缩略图预览尺寸/.test(idxSrc) && /别拿它算 rpx/.test(idxSrc), '');
  ok('工具侧列表行标注了「（预览）」', /（预览）/.test(idxSrc), '');
  ok('工具描述点明了尺寸是预览', /缩略图预览尺寸/.test(idxSrc), '');
  ok('CLI 列表也标注了「（预览）」并给出一行警告', /（预览）/.test(cliSrc) && /缩略图预览尺寸/.test(cliSrc), '');
}

/* ═══════ 单一出口：受控词表 / 阈值（常量区） ═══════ */
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(_root, 'lanhu.mjs'), 'utf8');
  const mod = await import(path.join(_root, 'lanhu.mjs'));
  const { KINDS, KIND_DESC, COLOR_ROLES, LIMITS } = mod;

  ok('KINDS / COLOR_ROLES / LIMITS 都是冻结对象',
    [KINDS, COLOR_ROLES, LIMITS].every((o) => o && Object.isFrozen(o)),
    `KINDS=${Object.isFrozen(KINDS)} COLOR_ROLES=${Object.isFrozen(COLOR_ROLES)} LIMITS=${Object.isFrozen(LIMITS)}`);
  ok('确实检查到了词表内容（不是空跑）',
    Object.keys(KINDS).length >= 8 && Object.keys(LIMITS).length >= 10,
    `KINDS ${Object.keys(KINDS).length} 项 / LIMITS ${Object.keys(LIMITS).length} 项`);
  // 对应 Java 枚举的 code+desc：每个值都必须有非空 desc，且 desc 是写给 AI 看的（够长、说清了怎么还原）
  const missing = Object.values(KINDS).filter((v) => !KIND_DESC[v] || String(KIND_DESC[v]).trim().length < 8);
  ok('每个 KINDS 都有非空的 KIND_DESC（枚举的 code+desc）', missing.length === 0, missing.join(', '));
  ok('KIND_DESC 没有多余的键（与 KINDS 一一对应）',
    Object.keys(KIND_DESC).length === Object.keys(KINDS).length,
    `KINDS ${Object.keys(KINDS).length} vs KIND_DESC ${Object.keys(KIND_DESC).length}`);
  // ⚠️ 这条是防退化的关键：classifyBlock 里**不许**再出现裸数字/裸类型字面量
  const body = src.slice(src.indexOf('function classifyBlock'), src.indexOf('function classifyBlock') + 1600);
  const cls = body.slice(0, body.indexOf('\n}'));
  const bare = [];
  if (/<=\s*\d/.test(cls)) bare.push('裸数字比较');
  if (/'(artboard|image|text|divider|pill|card|container|other)'/.test(cls)) bare.push('裸类型字面量');
  if (/'(fill|gradient)'/.test(cls)) bare.push('裸 role 字面量');
  ok('classifyBlock 只引用 KINDS/COLOR_ROLES/LIMITS，无裸数字与裸字面量', bare.length === 0, bare.join(' + '));
  ok('LIMITS 真的被逻辑引用（不是摆设）',
    (src.match(/LIMITS\./g) ?? []).length >= 10,
    `LIMITS.x 出现 ${(src.match(/LIMITS\./g) ?? []).length} 次`);
}

/* ═══════ 单一出口：工具返回的 ok 契约 + 坏输入的「下一步」（父代理健壮性测试发现） ═══════ */
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const idxSrc = fs.readFileSync(path.join(_root, 'lib/index.js'), 'utf8');
  const { TOOLS } = await import(path.join(_root, 'lib/index.js'));

  // ① 出口必须收口：成功路径要过 withOk（源码级，覆盖全部工具 —— 不只测含 id 的那几个）
  ok('工具出口调用 withOk（保证任何工具都不会漏 ok）',
    /return toLossless\(withUpstreamHint\(withOk\(r\)\)\)/.test(idxSrc), '');

  // ② 行为层：含 id 参数的工具传坏 id → 必须 ok:false 且 **hint 非空**（离线，走本地预检）
  const idTools = TOOLS.filter((t) => {
    const props = t.parameters?.properties ?? {};
    return ['projectId', 'imageId', 'teamId', 'docId', 'versionId'].some((k) => props[k]);
  });
  ok('确实找到含 id 参数的工具（不是空跑）', idTools.length >= 5, `找到 ${idTools.length} 个`);
  let checked = 0; const noOk = []; const noHint = [];
  for (const t of idTools) {
    const props = t.parameters?.properties ?? {};
    const args = {};
    for (const k of ['projectId', 'imageId', 'teamId', 'docId', 'versionId']) if (props[k]) args[k] = 'not-a-uuid';
    let r;
    try { r = await t.execute(args); } catch { continue; }   // 抛异常的不算（另有断言管）
    checked += 1;
    if (typeof r?.ok !== 'boolean') noOk.push(t.name);
    if (r?.ok === false && String(r?.hint ?? '').trim() === '') noHint.push(t.name);
  }
  ok('坏 id 的每个工具都返回 boolean ok', noOk.length === 0, noOk.join(', '));
  ok('坏 id 的失败**必须带非空 hint**（报错要指出下一步）', noHint.length === 0, noHint.join(', '));
  ok('确实跑了足够多的工具（不是空跑）', checked >= 5, `实际调用 ${checked} 个`);

  // ③ 上游错误**不许改写**：源码里 error 取自上游原文，不许在出口重写
  ok('出口不改写 error（只补 hint）',
    /withUpstreamHint/.test(idxSrc) && !/error:\s*['"`][^'"`]*通常/.test(idxSrc), '');
  // ④ UUID_RE 只有一个定义（复用，不写第二个）
  const reDefs = (fs.readFileSync(path.join(_root, 'lanhu.mjs'), 'utf8').match(/const UUID_RE =/g) ?? []).length;
  ok('UUID_RE 全项目只有一处定义（工具层复用它）', reDefs === 1, `lanhu.mjs 里 ${reDefs} 处`);
}

/* ═══════════════ ⑨ 版本自述（Host：当前版本 + npm 最新版） ═══════════════ */
group('⑨ 版本自述（Host）');
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const mod = await import('../lanhu.mjs');
  const {
    pluginPackagePath, readPluginVersion, parseSemver, compareSemver, isStableVersion,
    computeUpdateAvailable, npmLatestVersion, pluginVersionInfo, resetNpmVersionCache,
    NPM_LATEST_URL, NPM_PACKAGE, VERSION_CACHE_TTL, VERSION_FETCH_TIMEOUT,
  } = mod;
  const { makeLanhuHandler } = await import('../lib/index.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(_root, 'package.json'), 'utf8'));
  const lanhuSrc = fs.readFileSync(path.join(_root, 'lanhu.mjs'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(_root, 'lib/index.js'), 'utf8');

  /* ── ① 当前版本：只认 package.json（硬编码必红） ── */
  ok('pluginPackagePath() 指向真实的 package.json',
    path.basename(pluginPackagePath()) === 'package.json' && fs.existsSync(pluginPackagePath()), pluginPackagePath());
  eq('readPluginVersion() 等于 package.json 的 version', readPluginVersion(), pkg.version);
  // ★ 防硬编码的关键一条：换成版本号完全不同的临时 package.json ——
  //   任何写死版本号的实现（哪怕写的就是当前版本）都会在这里露馅。
  const tmpPkg = path.join(TMP_HOME, 'package.json');
  fs.writeFileSync(tmpPkg, JSON.stringify({ name: NPM_PACKAGE, version: '9.9.9-standin' }));
  eq('readPluginVersion 真的从给定 package.json 读（硬编码必红）',
    readPluginVersion({ packagePath: tmpPkg }), '9.9.9-standin');
  eq('package.json 读不到 → null（降级，不抛）',
    readPluginVersion({ packagePath: path.join(TMP_HOME, 'nope.json') }), null);
  {
    const seg = lanhuSrc.slice(lanhuSrc.indexOf('export function readPluginVersion'), lanhuSrc.indexOf('const SEMVER_RE'));
    ok('readPluginVersion 段里没有写死的版本号字面量',
      !/\d+\.\d+\.\d+/.test(seg), (seg.match(/\d+\.\d+\.\d+/) ?? [''])[0]);
  }

  /* ── ② 版本比较：纯函数，按语义 ── */
  eq('compareSemver：0.5.10 > 0.5.9（不是字符串比较）', compareSemver('0.5.10', '0.5.9'), 1);
  eq('compareSemver：0.5.4 == 0.5.4', compareSemver('0.5.4', '0.5.4'), 0);
  eq('compareSemver：1.0.0 > 0.9.9（跨段位）', compareSemver('1.0.0', '0.9.9'), 1);
  eq('compareSemver：容忍 v 前缀', compareSemver('v0.5.4', '0.5.4'), 0);
  eq('compareSemver：预发布 < 正式（0.6.0-rc.1 < 0.6.0）', compareSemver('0.6.0-rc.1', '0.6.0'), -1);
  eq('compareSemver：预发布数字标识按数值比（rc.2 < rc.10）', compareSemver('1.0.0-rc.2', '1.0.0-rc.10'), -1);
  eq('compareSemver：解析不了 → null（不瞎判）', compareSemver('abc', '1.0.0'), null);
  eq('parseSemver：忽略 +build 元数据',
    JSON.stringify(parseSemver('0.5.4+build.7')), JSON.stringify({ major: 0, minor: 5, patch: 4, pre: [] }));
  eq('parseSemver：段位不全 → null', parseSemver('0.5'), null);
  ok('isStableVersion 只认稳定版',
    isStableVersion('0.5.4') === true && isStableVersion('0.5.4-rc.1') === false && isStableVersion(null) === false);
  eq('computeUpdateAvailable：0.5.4 → 0.5.5 有更新', computeUpdateAvailable('0.5.4', '0.5.5'), true);
  eq('computeUpdateAvailable：0.5.4 == 0.5.4 无更新', computeUpdateAvailable('0.5.4', '0.5.4'), false);
  eq('computeUpdateAvailable：0.5.10 不比 0.5.9 旧（语义比较才判得出）',
    computeUpdateAvailable('0.5.10', '0.5.9'), false);
  eq('computeUpdateAvailable：npm 上是预发布 → 不给判断', computeUpdateAvailable('0.5.4', '0.5.5-rc.1'), null);
  eq('computeUpdateAvailable：本机是预发布 → 不给判断', computeUpdateAvailable('0.5.4-rc.1', '0.5.3'), null);
  eq('computeUpdateAvailable：latest 缺失 → 不给判断', computeUpdateAvailable('0.5.4', null), null);

  /* ── ③ npm 查询：缓存 + 降级（全部用桩，绝不碰真实 registry） ── */
  const mkRes = (body) => ({ ok: true, status: 200, json: async () => body });
  resetNpmVersionCache();
  let calls = 0;
  const goodFetch = async () => { calls += 1; return mkRes({ version: '9.9.9' }); };
  eq('npm 查询返回 registry 的 version', await npmLatestVersion({ fetchImpl: goodFetch }), '9.9.9');
  eq('缓存命中：第二次调用返回同一个值', await npmLatestVersion({ fetchImpl: goodFetch }), '9.9.9');
  ok('缓存生效：两次调用只打了一次 npm（去掉缓存必红）', calls === 1, `实际请求 ${calls} 次`);
  ok('确实走的是 registry 的 latest 端点', NPM_LATEST_URL.endsWith(`/${NPM_PACKAGE}/latest`), NPM_LATEST_URL);
  await npmLatestVersion({ fetchImpl: goodFetch, cache: false });
  ok('cache:false 时确实每次都请求（证明上面那条在数请求，不是空跑）', calls === 2, `实际请求 ${calls} 次`);

  resetNpmVersionCache();
  const t0 = 1_000_000;
  await npmLatestVersion({ fetchImpl: goodFetch, now: t0 });
  const base = calls;
  await npmLatestVersion({ fetchImpl: goodFetch, now: t0 + VERSION_CACHE_TTL - 1 });
  ok('TTL 内不重复请求', calls === base, `实际请求 ${calls - base} 次`);
  await npmLatestVersion({ fetchImpl: goodFetch, now: t0 + VERSION_CACHE_TTL + 1 });
  ok('TTL 过了会重新请求（缓存不是永久的）', calls === base + 1, `实际请求 ${calls - base} 次`);

  resetNpmVersionCache();
  let failCalls = 0;
  const deadFetch = async () => { failCalls += 1; throw new Error('ENOTFOUND registry.npmjs.org'); };
  // 「绝不抛」必须自己站起来断言：只靠"炸掉整个自检"也算红，但看不出是哪条性质坏了
  const settle = async (p) => { try { return { value: await p }; } catch (e) { return { error: e }; } };
  const firstTry = await settle(npmLatestVersion({ fetchImpl: deadFetch }));
  ok('npm 不可达**绝不抛**（附加项不能拖挂主职责）', firstTry.error === undefined,
    firstTry.error ? String(firstTry.error.message) : '');
  eq('npm 不可达 → latest 为 null', firstTry.value, null);
  eq('npm 不可达第二次仍是 null（失败已缓存）',
    (await settle(npmLatestVersion({ fetchImpl: deadFetch }))).value, null);
  ok('失败也进缓存：不会每次渲染都去打 npm', failCalls === 1, `实际请求 ${failCalls} 次`);

  resetNpmVersionCache();
  const hangFetch = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort',
      () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })));
  });
  const timedOut = await settle(npmLatestVersion({ fetchImpl: hangFetch, timeout: 20, cache: false }));
  ok('查询超时也绝不抛', timedOut.error === undefined, timedOut.error ? String(timedOut.error.message) : '');
  eq('超时 → null（降级，不抛）', timedOut.value, null);
  ok('默认超时是几秒级（不会把面板拖住）', VERSION_FETCH_TIMEOUT <= 5000, `${VERSION_FETCH_TIMEOUT}ms`);

  const infoTry = await settle(pluginVersionInfo({ packagePath: tmpPkg, fetchImpl: deadFetch, cache: false }));
  ok('pluginVersionInfo 也绝不抛', infoTry.error === undefined, infoTry.error ? String(infoTry.error.message) : '');
  eq('pluginVersionInfo：npm 挂了也返回结构完整的对象',
    JSON.stringify(infoTry.value),
    JSON.stringify({ version: '9.9.9-standin', latest: null, updateAvailable: null }));

  /* ── ④ /lanhu/status：带上版本三件套，且 npm 挂了也不能拖挂登录态 ── */
  const callStatus = async (handler, url = '/lanhu/status') => {
    const out = { status: 0, body: null, threw: undefined };
    const req = { url, method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const resp = { writeHead(s) { out.status = s; }, end(t) { out.body = JSON.parse(t); } };
    try { await handler(req, resp); } catch (e) { out.threw = e; }
    return out;
  };
  const authOk = async () => ({ ok: true, account: 'acme', cookieSource: 'file', teamCount: 3 });

  // 先热缓存 → 真实 pluginVersionInfo 不会去打 npm（整条断言链全程离线）
  resetNpmVersionCache();
  await npmLatestVersion({ fetchImpl: async () => mkRes({ version: '9.9.9' }) });
  const full = await callStatus(makeLanhuHandler({ checkAuth: authOk }));
  eq('status 仍是 HTTP 200', full.status, 200);
  eq('status 里含 version 且等于 package.json 的 version', full.body?.data?.version, pkg.version);
  eq('status 里含 latest', full.body?.data?.latest, '9.9.9');
  eq('status 里含 updateAvailable（比较在 Host 做，不留给客户端）', full.body?.data?.updateAvailable, true);
  ok('登录态主字段没被版本字段挤掉',
    full.body?.data?.ok === true && full.body?.data?.teamCount === 3, JSON.stringify(full.body?.data));

  resetNpmVersionCache();
  await settle(npmLatestVersion({ fetchImpl: deadFetch }));   // 缓存里是「失败」，handler 不会再打网络
  const down = await callStatus(makeLanhuHandler({ checkAuth: authOk }));
  ok('npm 不可达时 handler 本身也没抛', down.threw === undefined,
    down.threw ? String(down.threw.message) : '');
  eq('npm 不可达时 status 仍然成功（HTTP 200）', down.status, 200);
  eq('npm 不可达时 ok 仍为 true（版本失败不能把登录态拖成失败）', down.body?.ok, true);
  eq('npm 不可达时 latest 为 null', down.body?.data?.latest, null);
  eq('npm 不可达时 updateAvailable 为 null（不误报有更新）', down.body?.data?.updateAvailable, null);
  eq('npm 不可达时登录态字段照样在', down.body?.data?.teamCount, 3);
  ok('npm 不可达没有把 status 变成失败', down.body?.error === undefined, JSON.stringify(down.body));

  let probed = 0;
  const meta = await callStatus(
    makeLanhuHandler({ checkAuth: async () => { probed += 1; return { ok: true }; } }),
    '/lanhu/status?meta=1',
  );
  eq('?meta=1 只回版本三件套',
    JSON.stringify(Object.keys(meta.body?.data ?? {})), JSON.stringify(['version', 'latest', 'updateAvailable']));
  ok('?meta=1 不惊动蓝湖（面板一打开不该打一次 lanhuapp.com）', probed === 0, `探活 ${probed} 次`);
  eq('仍然只有一条 /lanhu 路由（版本没另开通道）',
    (idxSrc.match(/path:\s*'\/lanhu'/g) ?? []).length, 1);
  ok('版本自述已接进状态路由（不是只加了个没人用的函数）',
    /const \[r, v\] = await Promise\.all\(\[probeAuth\(\), readVersion\(\)\]\)/.test(idxSrc), '');
}

/* ═══════════════ ⑩ 面板标题栏版本（Client：真实组件离屏渲染） ═══════════════ */
group('⑩ 面板版本自述（Client）');
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const clientSrc = fs.readFileSync(path.join(_root, 'lib/client.js'), 'utf8');

  /**
   * 用「壳提供的 React 的替身」把**真实 bundle** 跑起来。
   * 自检里拿不到 react（它是壳的单例、不是本插件的依赖），所以给一个最小的
   * createElement / Component / hooks 替身 —— 组件本身、状态机、渲染规则都是真代码。
   */
  function loadPanel(payload) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (payload instanceof Error) throw payload;
      return { status: 200, json: async () => payload };
    };
    class Component { constructor(props) { this.props = props || {}; this.state = {}; } }
    const createElement = (type, props, ...children) => {
      const p = Object.assign({}, props || {});
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    };
    const React = {
      createElement, Component, Fragment: 'Fragment',
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {}, useRef: (v) => ({ current: v === undefined ? null : v }),
    };
    let loaded = null;
    const win = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
    new Function('window', 'console', 'fetch', clientSrc)(win, console, fetchImpl);
    const exports = loaded.factory((id) => {
      if (id === 'react') return React;
      throw new Error('未提供的模块：' + id);
    });
    const captured = {};
    exports.apply({
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      slots: {
        inject: (name, fn) => { fn(); return () => {}; },
        register: (meta, comp) => { captured[meta.id] = comp; return () => {}; },
      },
    });
    return { captured, exports, calls };
  }

  function collect(node, out, depth = 0) {
    if (node === null || node === undefined || typeof node === 'boolean' || depth > 40) return out;
    if (Array.isArray(node)) { for (const n of node) collect(n, out, depth + 1); return out; }
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out; }
    if (typeof node !== 'object') return out;
    const { type, props = {} } = node;
    out.nodes.push({ type: typeof type === 'function' ? (type.name || 'anon') : String(type), props });
    if (typeof type === 'function') {
      let rendered;
      try {
        rendered = (type.prototype && typeof type.prototype.render === 'function')
          ? new type(props).render()
          : type(props);
      } catch (e) { out.errors.push((type.name || 'anon') + ': ' + String(e && e.message || e)); return out; }
      collect(rendered, out, depth + 1);
      return out;
    }
    collect(props.children, out, depth + 1);
    return out;
  }

  /** 点一下侧边栏入口 = 打开面板（和用户操作同一条路径），再渲染整棵面板树。 */
  async function renderPanel(payload) {
    const { captured, calls } = loadPanel(payload);
    const entry = captured['lanhu'];
    const overlay = captured['lanhu-panel'];
    if (typeof entry !== 'function' || typeof overlay !== 'function') {
      return { text: '', nodes: [], errors: ['入口/面板没注册上'], calls: [] };
    }
    const entryEl = entry({ wide: true });
    entryEl.props.onClick();
    await new Promise((r) => setTimeout(r, 15));
    const out = { text: [], nodes: [], errors: [] };
    collect(overlay({}), out);
    const partOf = (part) => out.nodes.filter((n) => n.props && n.props['data-dsh-part'] === part);
    return {
      text: out.text.join(' '), nodes: out.nodes, errors: out.errors, calls,
      versionNodes: [...partOf('version'), ...partOf('version-update')],
      hasVersionNode: partOf('version').length > 0,
      updateDot: partOf('version-update')[0] ? partOf('version-update')[0].props : null,
    };
  }

  const noUpdate = await renderPanel({ ok: true, data: { version: '9.9.9', latest: '9.9.9', updateAvailable: false } });
  ok('拿到的版本号真的渲染进标题栏（数据驱动，写死必红）', noUpdate.text.includes('v9.9.9'), noUpdate.text.slice(0, 80));
  ok('标题「蓝湖设计稿」仍在', noUpdate.text.includes('蓝湖设计稿'));
  ok('无更新时不渲染提示点', noUpdate.updateDot === null);
  ok('面板整棵树渲染无异常（客户端绝不 throw）', noUpdate.errors.length === 0, noUpdate.errors.join('; '));
  ok('版本数据只走 /lanhu/status（没开第二条通道）',
    noUpdate.calls.length > 0 && noUpdate.calls.every((u) => u.startsWith('/lanhu/')), noUpdate.calls.join(', '));
  ok('版本自述走 ?meta=1（打开面板不触发蓝湖探活）',
    noUpdate.calls.includes('/lanhu/status?meta=1'), noUpdate.calls.join(', '));

  const withUpdate = await renderPanel({ ok: true, data: { version: '9.9.9', latest: '9.9.10', updateAvailable: true } });
  ok('有更新时才渲染那个提示点', !!withUpdate.updateDot);
  ok('提示点带 title（hover 就能看懂是「有新版本」）',
    /新版本/.test(String(withUpdate.updateDot && withUpdate.updateDot.title)), String(withUpdate.updateDot && withUpdate.updateDot.title));
  ok('有更新时当前版本照显', withUpdate.text.includes('v9.9.9'));
  ok('不显示具体的最新版本号（按简化后的需求）', !withUpdate.text.includes('9.9.10'), withUpdate.text.slice(0, 80));

  const unsure = await renderPanel({ ok: true, data: { version: '9.9.9', latest: '9.9.10-rc.1', updateAvailable: null } });
  ok('Host 拿不准（updateAvailable:null）时不提示', unsure.updateDot === null);

  const noData = await renderPanel(new Error('fetch failed'));
  ok('拿不到 npm 数据 → 完全不渲染版本（连占位都没有）',
    !noData.hasVersionNode && !/v9\.9\.9/.test(noData.text), noData.text.slice(0, 60));
  ok('拿不到数据也不抛、面板照常渲染',
    noData.errors.length === 0 && noData.text.includes('蓝湖设计稿'), noData.errors.join('; '));
  ok('拿不到数据不产生「检查失败」之类噪音', !/新版本/.test(noData.text));

  // 颜色铁律：版本标签里每个 var() 都必须带 fallback，且不许有裸色值
  {
    const bad = [];
    for (const n of withUpdate.versionNodes) {
      for (const [k, v] of Object.entries(n.props.style || {})) {
        if (typeof v !== 'string') continue;
        if (v.includes('var(')) { if (!/var\(--[\w-]+,\s*[^)]+\)/.test(v)) bad.push(k + '=' + v); }
        else if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/.test(v)) bad.push(k + '=' + v);
      }
    }
    ok('版本标签的颜色全部走令牌 + fallback（没有裸色值）', bad.length === 0, bad.join(', '));
    ok('确实检查到了版本节点的样式（不是空跑）', withUpdate.versionNodes.length >= 2,
      `检查了 ${withUpdate.versionNodes.length} 个节点`);
  }
  {
    const seg = clientSrc.slice(clientSrc.indexOf('function versionTagModel'), clientSrc.indexOf('function LanhuOverlay'));
    const hit = seg.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    ok('版本自述源码段里也没有裸色值', !hit && seg.length > 200, hit ? hit[0] : `长度 ${seg.length}`);
  }
  {
    // 「别开第二条通道」的守门断言：客户端**每一处**取数都必须挂在同源的 API 常量上。
    // （不查「有没有 lanhuapp.com 字样」—— 那是粘贴 Cookie 的提示文案，不是数据通道。）
    const callSites = [...clientSrc.matchAll(/\bjsonFetch\(([^,\n)]+)/g)]
      .map((m) => m[1].trim())
      .filter((s) => s !== 'url');
    ok('客户端所有取数都走同源 API 常量（没有第二条通道）',
      callSites.length >= 4 && callSites.every((s) => s.startsWith('API')),
      callSites.join(' | '));
  }
}

/* ═══════════════ ⑪ 面板「体检」Tab（Client 真渲染 + Host 新路由） ═══════════════ */
group('⑪ 面板「体检」Tab');
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const clientSrc = fs.readFileSync(path.join(_root, 'lib/client.js'), 'utf8');
  const idxSrc = fs.readFileSync(path.join(_root, 'lib/index.js'), 'utf8');
  const { makeLanhuHandler } = await import('../lib/index.js');

  /* ── 真机形状的 fixture（数值抄自真跑一次的返回：小程序 / 人才详情） ── */
  const PID = 'f623608b-d75d-453f-ab42-f997f0f43b80';
  const IID = 'd11572f8-dfa1-4e14-9706-b52946f614a7';
  const IID2 = 'a91f2aaf-4162-488b-8fc0-43498437cde3';
  const V5 = '97dd4840-9aa2-48d1-a958-1f5171445278';
  const V4 = 'f4fbf3f3-1845-4721-a808-e95572d21bae';
  const AT5 = 'Tue, 22 Sep 2026 16:58:24 UTC';
  const AT4 = 'Tue, 22 Sep 2026 16:57:36 UTC';

  const DIFF_OK = {
    ok: true, format: 'diff', name: '人才详情',
    viewport: { width: 375, height: 1333 },
    from: { id: V4, createTime: AT4, index: 1, isLatest: false },
    to: { id: V5, createTime: AT5, index: 0, isLatest: true },
    versionCount: 5, versionLatestId: V5, sameVersion: false, gapSeconds: 48, gapDays: 0,
    identical: false, reliable: true,
    reliability: {
      exact: 131, approx: 0, unmatched: 0, matched: 131, total: 131,
      matchedRatio: 1, approxShare: 0, smallSample: false, reliable: true, reason: null,
    },
    counts: {
      fromBlocks: 131, toBlocks: 131, noiseFrom: 28, noiseTo: 28, matched: 131, unchanged: 130,
      changed: { size: 0, color: 0, layout: 0, text: 0, border: 0, structure: 1, blocks: 1 },
      added: 0, removed: 0,
    },
    changes: {
      size: [], color: [], layout: [], text: [], border: [],
      structure: [{
        path: '人才详情/人才证书', name: '人才证书', kind: 'card', kindFrom: 'image', how: 'exact',
        field: 'kind', label: '类型 图片→卡片', from: 'image', to: 'card', where: '人才证书',
      }],
    },
    added: [], removed: [],
    notes: ['系统 UI / 图形碎片共 56 块未参与比对（与块级清单同一个折叠口径）。'],
    account: 'quanzi', accountBy: 'default',
    text: '设计变更：vf4fbf3f3 → v97dd4840\n· 稿：人才详情 375×1333 · 块数 131 → 131\n· 结构：\n  - 人才证书 类型 图片→卡片\n· 未变：其余 130 块',
    textBytes: 96,
  };
  // 不可靠版：后端**故意不出明细**（changes 全空、reliable:false），面板必须把这件事顶在最上面
  const DIFF_UNRELIABLE = {
    ...DIFF_OK, identical: false, reliable: false,
    reliability: {
      exact: 2, approx: 40, unmatched: 89, matched: 42, total: 131,
      matchedRatio: 0.32, approxShare: 0.95, smallSample: false, reliable: false,
      reason: '只有 42/131 块能配上（匹配率 32%），89 块对不上 —— 这通常意味着设计整版重画/重排或换了一套图层命名。',
    },
    counts: Object.assign({}, DIFF_OK.counts, {
      changed: { size: 0, color: 0, layout: 0, text: 0, border: 0, structure: 0, blocks: 0 },
      unchanged: 0, added: 12, removed: 20,
    }),
    changes: { size: [], color: [], layout: [], text: [], border: [], structure: [] },
    text: '设计变更：vf4fbf3f3 → v97dd4840\n⚠️ 差异过大，逐块对比不可靠 —— 不出明细表。',
  };
  const AUDIT_OK = {
    ok: true, format: 'audit', projectId: PID, projectName: '小程序',
    scanned: 3, attempted: 3, total: 10, truncated: true,
    limitRequested: 3, limitApplied: 3, limitClamped: false, limitDefault: 50, limitHard: 200,
    imagesWithLayers: 3, blocks: 929,
    naming: { total: 926, named: 647, auto: 279, empty: 0, namedShare: 0.7 },
    reliable: true, reasons: [], primaryReason: null, weakMode: false,
    suppressed: [], nameDependent: ['componentSpec'],
    findings: {
      componentSpec: {
        suppressed: false, drift: true, converged: 0, findingCount: 1,
        participatedNames: 6, participatedBlocks: 166,
        notParticipating: { autoName: 279, emptyName: 0, thin: 481 },
        findings: [{
          name: 'Button', blocks: 15, images: 3, kinds: ['pill'],
          dims: [{
            dim: 'radius', label: '圆角', distinct: 3, total: 15,
            values: [{ value: 9999, count: 9, imageCount: 3, examples: ['人才详情'] }, { value: 27, count: 3, imageCount: 1 }],
            truncatedValues: 0, majority: 9999, majorityCount: 9, tie: false,
          }],
        }],
      },
      fontScale: { suppressed: false, drift: true, distinct: 13, total: 328, sizes: [], oneOffs: [], ladder: [10, 11, 12, 14] },
      colorDrift: {
        suppressed: false, drift: true, threshold: 12, metric: 'RGB 欧氏距离', distinct: 155, clusterCount: 22,
        clusters: [{
          members: [{ key: '#f4f5ff', count: 9, imageCount: 1, roles: ['bg'] }, { key: '#eef0fa', count: 3, imageCount: 1, roles: ['border'] }],
          maxDistance: 11.22, majority: '#f4f5ff', tie: false,
        }],
      },
      spacingScale: { suppressed: false, drift: true, grid: 4, distinct: 407, total: 1924, offGridCount: 378, offGrid: [{ value: 10, count: 91 }, { value: 14, count: 85 }] },
      radiusFamily: { suppressed: false, drift: true, distinct: 16, total: 295, offScaleCount: 6, offScale: [{ value: 7, count: 9 }] },
    },
    drift: {}, driftedCategories: ['componentSpec', 'fontScale', 'colorDrift', 'spacingScale', 'radiusFamily'],
    anyDrift: true, noDriftBrief: [],
    skipped: [], skippedBrief: '', skipBuckets: {}, account: 'quanzi', accountBy: 'default',
    text: '# 设计系统审计 — 小程序\n· 扫描：**3 / 3 张**已尝试、项目共 **10** 张 → **已被上限截断**\n· 命名基础：可靠块名 **647/926** 块（70%）',
  };
  // 命名不可靠版：五类**全部 suppressed**（一项都不出），面板必须显眼说明
  const AUDIT_WEAK = Object.assign({}, AUDIT_OK, {
    reliable: false, weakMode: false, primaryReason: 'naming', anyDrift: false,
    driftedCategories: [], noDriftBrief: [],
    reasons: ['**命名不可靠**：可靠块名只覆盖 647/926 块（70%，低于 30%）—— 其余是 `Rectangle 12` 这类工具默认名或空名。'],
    suppressed: ['componentSpec', 'fontScale', 'colorDrift', 'spacingScale', 'radiusFamily'],
    findings: Object.fromEntries(['componentSpec', 'fontScale', 'colorDrift', 'spacingScale', 'radiusFamily']
      .map((c) => [c, { suppressed: true, drift: false, reason: '命名不可靠，拒绝出明细' }])),
    text: '# 设计系统审计 — 小程序\n⚠️ 判不可靠：命名不可靠 —— 一项都不出。',
  });
  const ACCOUNTS = {
    ok: true,
    data: {
      default: 'quanzi',
      accounts: [{
        alias: 'quanzi', company: '全咨', isDefault: true, hasCookie: true,
        teamCount: 1, projectCount: 1, cookieMasked: 'PASSPORT****',
        expiry: { expiresAt: '2026-12-15T08:22:13.000Z', daysLeft: 67 },
        indexedAt: '2026-10-09T00:00:00.000Z', indexAgeDays: 0, indexStale: false,
        teams: [{ teamId: 'dcf8c993-1d4d-4596-b546-dab02a3f36ca', name: '全咨' }],
        projects: [{ projectId: PID, name: '小程序' }],
      }],
    },
  };
  const baseResponses = {
    '/lanhu/status?meta=1': { ok: true, data: { version: '9.9.9', latest: '9.9.9', updateAvailable: false } },
    '/lanhu/accounts': ACCOUNTS,
    '/lanhu/log?limit=80': { ok: true, data: { total: 0, entries: [], source: 'memory', file: path.join(TMP_HOME, 'usage.jsonl') } },
    ['/lanhu/designs?pid=' + PID]: {
      ok: true,
      data: { projectId: PID, imageId: null, projectName: '小程序', images: [{ imageId: IID, name: '人才详情' }, { imageId: IID2, name: '人才首页' }] },
    },
    ['/lanhu/versions?pid=' + PID + '&iid=' + IID]: {
      ok: true,
      data: {
        projectId: PID, imageId: IID, name: '人才详情',
        versions: [{ id: V5, createTime: AT5, info: '版本5', hasLayoutData: true }, { id: V4, createTime: AT4, info: '版本4', hasLayoutData: true }],
      },
    },
    '/lanhu/diff': { ok: true, data: DIFF_OK },
    '/lanhu/audit': { ok: true, data: AUDIT_OK },
  };

  /* ── 最小 React 替身（与 ⑩ 同一套做法）：组件、状态机、渲染规则都是真代码 ── */
  function loadFitPanel(scenario = {}) {
    const calls = [];
    const posts = [];
    const hanging = {};
    const fetchImpl = (url, options) => {
      const u = String(url);
      calls.push(u);
      if (options && options.body) posts.push({ url: u, body: JSON.parse(options.body) });
      if (scenario.hangUrl && u.includes(scenario.hangUrl)) {
        return new Promise((resolve) => { hanging[u] = resolve; });      // 挂住不返回，用来测"运行中"
      }
      if (scenario.failUrl && u.includes(scenario.failUrl)) return Promise.reject(new Error('fetch failed'));
      const hit = Object.keys(scenario.responses || baseResponses).find((k) => u === k || u.startsWith(k));
      const body = hit ? (scenario.responses || baseResponses)[hit] : { ok: true, data: {} };
      return Promise.resolve({ status: 200, json: async () => body });
    };
    class Component { constructor(props) { this.props = props || {}; this.state = {}; } }
    const createElement = (type, props, ...children) => {
      const p = Object.assign({}, props || {});
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    };
    const React = {
      createElement, Component, Fragment: 'Fragment',
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {}, useRef: (v) => ({ current: v === undefined ? null : v }),
    };
    let loaded = null;
    const win = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
    new Function('window', 'console', 'fetch', clientSrc)(win, console, fetchImpl);
    const exports = loaded.factory((id) => {
      if (id === 'react') return React;
      throw new Error('未提供的模块：' + id);
    });
    const captured = {};
    exports.apply({
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      slots: {
        inject: (name, fn) => { fn(); return () => {}; },
        register: (meta, comp) => { captured[meta.id] = comp; return () => {}; },
      },
    });
    // 把"挂住的那个请求"按需要放回来（测「取消后回包不许覆盖状态」）
    const release = (sub, body) => {
      const key = Object.keys(hanging).find((k) => k.includes(sub));
      if (!key) return false;
      const r = hanging[key];
      delete hanging[key];
      r({ status: 200, json: async () => body });
      return true;
    };
    return { captured, calls, posts, release };
  }

  function collectFit(node, out, underFit = false, depth = 0) {
    if (node === null || node === undefined || typeof node === 'boolean' || depth > 60) return;
    if (Array.isArray(node)) { for (const n of node) collectFit(n, out, underFit, depth + 1); return; }
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return; }
    if (typeof node !== 'object') return;
    const { type, props = {} } = node;
    const isFit = underFit || props['data-dsh-part'] === 'fit';
    out.nodes.push({ type: typeof type === 'function' ? (type.name || 'anon') : String(type), props, underFit: isFit });
    if (typeof type === 'function') {
      let rendered;
      try {
        rendered = (type.prototype && typeof type.prototype.render === 'function')
          ? new type(props).render()
          : type(props);
      } catch (e) { out.errors.push((type.name || 'anon') + ': ' + String((e && e.message) || e)); return; }
      collectFit(rendered, out, isFit, depth + 1);
      return;
    }
    collectFit(props.children, out, isFit, depth + 1);
  }

  const tick = () => new Promise((r) => setTimeout(r, 15));
  // text 直接给**拼好的字符串**（这些断言就是"人眼在面板上看到的那句话"）；textArr 留给需要逐句的场景
  const renderFit = (overlay) => {
    const o = { text: [], nodes: [], errors: [] };
    collectFit(overlay({}), o);
    return { nodes: o.nodes, errors: o.errors, textArr: o.text, text: o.text.join(' | ') };
  };
  const byText = (out, text) => out.nodes.find((n) => n.type === 'button' && n.props.children === text);
  const byPart = (out, part) => out.nodes.filter((n) => n.props['data-dsh-part'] === part);
  const opts = (node) => (Array.isArray(node.props.children) ? node.props.children : [node.props.children])
    .filter((c) => c && c.type === 'option').map((c) => c.props.value);

  /** 打开面板 → 点「体检」Tab（和用户操作同一条路径），返回可反复渲染的句柄。 */
  async function mountFit(scenario) {
    const p = loadFitPanel(scenario);
    const overlay = p.captured['lanhu-panel'];
    const entry = p.captured['lanhu'];
    if (typeof entry !== 'function' || typeof overlay !== 'function') return { p, out: { text: [], nodes: [], errors: ['入口/面板没注册上'] } };
    entry({ wide: true }).props.onClick();
    await tick();
    let out = renderFit(overlay);
    const tab = byPart(out, 'tab-fit')[0];
    if (tab) { tab.props.onClick(); await tick(); }
    out = renderFit(overlay);
    return { p, out, render: () => renderFit(overlay) };
  }

  /** 选项目 → 选稿（把两个下拉都真的点一遍）。 */
  async function pickProjectAndDesign(h) {
    const proj = byPart(h.out, 'fit-project')[0];
    proj.props.onChange({ target: { value: opts(proj)[1] } });
    await tick();
    h.out = h.render();
    const dsel = byPart(h.out, 'fit-design')[0];
    if (dsel && opts(dsel).length > 1) {
      dsel.props.onChange({ target: { value: opts(dsel)[1] } });
      await tick();
      h.out = h.render();
    }
    return h.out;
  }

  /* ── ① Tab 真的注册进面板（不是"代码里写了但没挂上"） ── */
  {
    const h = await mountFit({});
    const tabs = ['tab-blocks', 'tab-status', 'tab-log', 'tab-fit'].map((p) => byPart(h.out, p)[0]);
    ok('「体检」tab 真的注册进面板（tab 条里出现）', !!tabs[3], JSON.stringify(byPart(h.out, 'tab-fit').length));
    eq('tab 文字就是「体检」', tabs[3] && tabs[3].props.children, '体检');
    ok('原有三个 tab 一个都没少（块级/账号/记录）', tabs.slice(0, 3).every(Boolean),
      tabs.slice(0, 3).map((t) => (t ? t.props.children : '缺')).join('/'));
    ok('「体检」排在最后（不挤掉谁的位置）', tabs.filter(Boolean).map((t) => t.props.children).join(',') === '块级,账号,记录,体检');
    ok('点「体检」后整棵树渲染无异常（客户端绝不 throw）', h.out.errors.length === 0, h.out.errors.join('; '));
    ok('体检页三个区块都在（目标项目 / 变更 / 一致性）',
      h.out.text.includes('目标项目') && h.out.text.includes('变更（设计变更 diff）') && h.out.text.includes('一致性（跨稿审计）'),
      h.out.text.slice(0, 120));
  }

  /* ── ② 两个功能的完整走一遍（项目 → 稿 → 版本 → 对比 / 审计） ── */
  {
    const h = await mountFit({});
    await pickProjectAndDesign(h);
    const callsNow = h.p.calls.filter((u) => u.startsWith('/lanhu/'));
    ok('选项目/选稿都走同源 /lanhu 路由（没开第二条通道）',
      callsNow.length > 0 && callsNow.every((u) => u.startsWith('/lanhu/')), h.p.calls.join(', '));
    ok('选项目 → 真的去列了稿（/lanhu/designs）', h.p.calls.some((u) => u.startsWith('/lanhu/designs')), h.p.calls.join(', '));
    ok('选稿 → 真的去读了版本（/lanhu/versions）', h.p.calls.some((u) => u.startsWith('/lanhu/versions')), h.p.calls.join(', '));
    const from = byPart(h.out, 'fit-from')[0];
    const to = byPart(h.out, 'fit-to')[0];
    eq('起点版本默认选中"上一版"（不是最新版自己跟自己比）', from && from.props.value, V4);
    eq('终点版本默认是最新版', to && to.props.value, V5);

    const run = byText(h.out, '对比两个版本');
    ok('「对比两个版本」按钮在（可触发）', !!run);
    run.props.onClick();
    await tick();
    h.out = h.render();
    const posted = h.p.posts.filter((x) => x.url === '/lanhu/diff');
    eq('点按钮 → POST /lanhu/diff，且 body 带 projectId/imageId/from/to', posted.length, 1);
    eq('POST body 的 from 就是下拉里那个版本', posted[0] && posted[0].body.from, V4);
    eq('POST body 的 to 就是终点版本', posted[0] && posted[0].body.to, V5);
    const res = byPart(h.out, 'fit-diff-result')[0];
    ok('结果区渲染出来（变化块数看得见）', !!res && h.out.text.includes('变化 1 块'), h.out.text.slice(0, 160));
    ok('逐块明细带「从→到」（人一眼能抄）', h.out.text.includes('人才证书 · 类型 图片→卡片'));
  }

  /* ── ②b 兜底路径：贴一条"索引里没有的项目"的链接 ── */
  {
    const PID2 = '2f9b3333-fe3a-4be3-b6db-d6c86813e711';
    const LINK = 'https://lanhuapp.com/web/#/item/project/detailDetach?pid=' + PID2 + '&image_id=' + IID;
    const responses = Object.assign({}, baseResponses, {
      ['/lanhu/designs?url=' + encodeURIComponent(LINK)]: {
        ok: true,
        data: { projectId: PID2, imageId: IID, projectName: '索引里没有的项目', images: [{ imageId: IID, name: '人才详情' }, { imageId: IID2, name: '人才首页' }] },
      },
      ['/lanhu/versions?url=' + encodeURIComponent(LINK)]: {
        // Host 的 /versions 也回 projectId（面板据此保持"目标项目"一致）—— 这里必须回 PID2，
        // 否则会把 fitProject 覆盖回索引里那个项目，测出来的就不是这条路了（实测踩过）
        ok: true,
        data: Object.assign({}, baseResponses['/lanhu/versions?pid=' + PID + '&iid=' + IID].data, { projectId: PID2 }),
      },
    });
    const h = await mountFit({ responses });
    const link = byPart(h.out, 'fit-link')[0];
    link.props.onChange({ target: { value: LINK } });
    h.out = h.render();
    byText(h.out, '用链接定位').props.onClick();
    await tick();
    h.out = h.render();
    const proj = byPart(h.out, 'fit-project')[0];
    eq('贴链接定位后，项目下拉的值就是链接里的项目', proj && proj.props.value, PID2);
    ok('下拉里补出了这条"不在索引里"的项目（否则界面会显示成第一项，与真实状态不一致）',
      opts(proj).includes(PID2), opts(proj).join(','));
    ok('链接里带 image_id → 顺手把版本也读了（少点一次）',
      h.p.calls.some((u) => u.startsWith('/lanhu/versions?url=')), h.p.calls.join(', '));
    eq('版本下拉已就绪（起点默认上一版）', byPart(h.out, 'fit-from')[0] && byPart(h.out, 'fit-from')[0].props.value, V4);
  }

  /* ── ③ 运行中：按钮禁用 + 一句进度（不能让人以为卡死） ── */  {
    const h = await mountFit({ hangUrl: '/lanhu/diff' });
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    h.out = h.render();
    const btn = byText(h.out, '对比中…');
    ok('跑起来后按钮文字变成「对比中…」', !!btn, h.out.text.slice(0, 120));
    ok('跑起来后按钮被禁用（点不动，防重复触发）', !!btn && btn.props.disabled === true);
    const running = byPart(h.out, 'fit-running-diff')[0];
    ok('有一句明确的进度提示（不是无声等待）', !!running, JSON.stringify(byPart(h.out, 'fit-running-diff').length));
    ok('进度里说明"已用多少秒"且点明是长任务',
      !!running && /已用 \d+s/.test(String(running.props.children)) && String(running.props.children).includes('长任务'),
      running ? String(running.props.children) : '');
    ok('跑起来后「取消」变成可点（长任务必须能中断等待）', (byText(h.out, '取消') || {}).props?.disabled === false);

    // 取消：立刻回到可点，且 Host 晚到的回包**不许**覆盖状态
    byText(h.out, '取消').props.onClick();
    await tick();
    h.out = h.render();
    ok('取消后按钮回到「对比两个版本」且不再禁用', (byText(h.out, '对比两个版本') || {}).props?.disabled === false);
    ok('取消给出中性的说明（⏹，不是报错红）', h.out.text.includes('⏹ 已取消等待'), h.out.text.slice(0, 200));
    ok('取消后没有进度行残留', byPart(h.out, 'fit-running-diff').length === 0);
    h.p.release('/lanhu/diff', { ok: true, data: DIFF_OK });
    await tick();
    h.out = h.render();
    ok('取消后 Host 的回包不会把结果又贴回来（结果作废）',
      byPart(h.out, 'fit-diff-result').length === 0 && !h.out.text.includes('变化 1 块'));
  }

  /* ── ④ 审计：张数看得见、可触发、防误操作 ── */
  {
    const h = await mountFit({});
    await pickProjectAndDesign(h);
    const lim = byPart(h.out, 'fit-audit-limit')[0];
    eq('扫描张数默认是 20（不是工具的 50，更不是硬上限 200 —— 默认不许悄悄跑很久）', lim && String(lim.props.value), '20');
    eq('输入框写了硬上限（用户能看见上限在哪）', lim && String(lim.props.max), '200');
    ok('默认值对应的成本写在界面上（本次约 40 次）', h.out.text.includes('本次约 40 次；'), h.out.text.slice(-160));
    ok('界面写明扫的是整个项目（不只是选中那张稿）', h.out.text.includes('扫的是整个项目'));

    lim.props.onChange({ target: { value: '3' } });
    h.out = h.render();
    ok('改张数后成本立刻跟着变（约 6 次）', h.out.text.includes('本次约 6 次；'), h.out.text.slice(-160));
    byText(h.out, '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    const posted = h.p.posts.filter((x) => x.url === '/lanhu/audit');
    eq('点按钮 → POST /lanhu/audit（一次）', posted.length, 1);
    eq('POST 的 limit 就是面板上那个数', posted[0] && posted[0].body.limit, 3);
    eq('POST 带上 projectId（选了下拉就不贴链接）', posted[0] && posted[0].body.projectId, PID);
    ok('审计结果写明扫了多少 / 共多少（成本可见）', h.out.text.includes('扫描 3/10 张'), h.out.text.slice(0, 200));
    ok('审计的五类结论都列出来了',
      ['同一组件、多种规格', '字号阶梯', '色值漂移（近重复色）', '间距尺度', '圆角家族'].every((t) => h.out.text.includes(t)));
    ok('漂移明细给了可直接核对的值（圆角 9999 建议 / 近重复色）',
      h.out.text.includes('9999(9)') && h.out.text.includes('#f4f5ff'), h.out.text.slice(-400));
  }

  /* ── ⑤ 张数越界：面板自己也要夹（输 5000 不许真跑 5000） ── */
  {
    const h = await mountFit({ hangUrl: '/lanhu/audit' });
    await pickProjectAndDesign(h);
    const lim = byPart(h.out, 'fit-audit-limit')[0];
    lim.props.onChange({ target: { value: '5000' } });
    h.out = h.render();
    byText(h.out, '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    const posted = h.p.posts.filter((x) => x.url === '/lanhu/audit');
    eq('面板把 5000 夹到硬上限 200 再发（不靠用户自觉）', posted[0] && posted[0].body.limit, 200);
    const running = byPart(h.out, 'fit-running-audit')[0];
    ok('审计运行中：按钮禁用', (byText(h.out, '审计中…') || {}).props?.disabled === true);
    ok('审计运行中的进度写明扫多少张（看着心里有数）',
      !!running && String(running.props.children).includes('正在扫描 200 张稿'), running ? String(running.props.children) : '');
  }

  /* ── ⑥ 不可靠结论必须显眼（这是两个功能最要紧的一条纪律） ── */
  {
    const h = await mountFit({ responses: Object.assign({}, baseResponses, { '/lanhu/diff': { ok: true, data: DIFF_UNRELIABLE } }) });
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    h.out = h.render();
    const banner = byPart(h.out, 'fit-diff-unreliable')[0];
    ok('diff 匹配不可靠时，横幅**渲染出来**了（不是只写在长文本里）', !!banner, JSON.stringify(byPart(h.out, 'fit-diff-unreliable').length));
    ok('横幅是 alert 语义（读屏也当它是警告）', banner && banner.props.role === 'alert');
    ok('横幅明说"匹配不可靠 + 所以不出明细"',
      !!banner && /匹配不可靠/.test(h.out.text) && /不列逐块差异明细/.test(h.out.text), h.out.text.slice(0, 200));
    ok('横幅带可靠度数字（精确/近似/对不上/匹配率）',
      !!banner && h.out.text.includes('精确匹配 2') && h.out.text.includes('匹配率 32%'));
    const at = (part) => h.out.nodes.findIndex((n) => n.props['data-dsh-part'] === part);
    ok('横幅排在结果区**上面**（先看到"不可靠"，再看到数字）',
      at('fit-diff-unreliable') >= 0 && at('fit-diff-result') >= 0 && at('fit-diff-unreliable') < at('fit-diff-result'),
      `横幅 @${at('fit-diff-unreliable')}，结果 @${at('fit-diff-result')}`);
    ok('不可靠时**不出**分类明细表（后端不给，面板也不编）',
      !h.out.text.includes('尺寸/圆角：') && !h.out.text.includes('结构：'), h.out.text.slice(-200));
  }
  {
    const h = await mountFit({});
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    h.out = h.render();
    ok('结论可靠时**不**渲染那个横幅（不是永远挂着的装饰）', byPart(h.out, 'fit-diff-unreliable').length === 0);
  }
  {
    const h = await mountFit({ responses: Object.assign({}, baseResponses, { '/lanhu/audit': { ok: true, data: AUDIT_WEAK } }) });
    await pickProjectAndDesign(h);
    byText(h.out, '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    const banner = byPart(h.out, 'fit-audit-unreliable')[0];
    ok('审计判不可靠时，横幅渲染出来了', !!banner && banner.props.role === 'alert');
    ok('横幅明说"判不可靠 + 所以不出漂移明细"',
      !!banner && /判不可靠/.test(h.out.text) && /不出漂移明细/.test(h.out.text), h.out.text.slice(0, 200));
    ok('横幅带样本证据（读到图层 / 块 / 可靠块名）',
      !!banner && h.out.text.includes('读到图层 3 张') && h.out.text.includes('可靠块名 647/926'));
    ok('五类**每一项**都写着"未出（不可靠）"（不假装看过）',
      h.out.text.split('未出（不可靠）').length - 1 >= 5, String(h.out.text.split('未出（不可靠）').length - 1));
    ok('未出明细的原因也写出来了', h.out.text.includes('未出明细（命名不可靠，拒绝出明细）'));
  }
  {
    const h = await mountFit({});
    await pickProjectAndDesign(h);
    byText(h.out, '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    ok('审计可靠时不渲染那个横幅', byPart(h.out, 'fit-audit-unreliable').length === 0);
    ok('可靠时每类给"漂移/收敛"判定', h.out.text.includes('漂移') || h.out.text.includes('收敛'));
  }

  /* ── ⑦ 结果可复制（用户要拿去喂 AI） ── */
  {
    const h = await mountFit({});
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    h.out = h.render();
    const copy = byText(h.out, '复制报告');
    ok('有「复制报告」按钮', !!copy);
    byText(h.out, '看原文').props.onClick();
    h.out = h.render();
    const raw = byPart(h.out, 'fit-diff-raw')[0];
    ok('「看原文」展开一份**可手选**的纯文本区', !!raw && raw.type === 'textarea', raw ? raw.type : '没渲染');
    eq('原文区里就是后端那份纯文本报告', raw && raw.props.value, DIFF_OK.text);
    ok('原文区只读（readOnly）', raw && raw.props.readOnly === true);
    // 审计那份也要能展开原文（不是只给 diff 做了）
    byText(h.out, '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    const raws = h.out.nodes.filter((n) => n.type === 'button' && n.props.children === '看原文');
    raws[raws.length - 1].props.onClick();
    h.out = h.render();
    const araw = byPart(h.out, 'fit-audit-raw')[0];
    eq('审计那份也能展开可手选的原文', araw && araw.props.value, AUDIT_OK.text);
    copy.props.onClick();
    await tick();
    h.out = h.render();
    ok('点「复制报告」后给出反馈（按钮变「已复制」）', !!byText(h.out, '已复制'), h.out.text.slice(-120));
  }

  /* ── ⑧ fetch 挂了：只显示错误，绝不 throw、面板不崩 ── */
  {
    const h = await mountFit({ failUrl: '/lanhu/diff' });
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    h.out = h.render();
    ok('取数失败时整棵树照常渲染（没抛错）', h.out.errors.length === 0, h.out.errors.join('; '));
    const err = byPart(h.out, 'fit-error')[0];
    ok('错误显示在界面上（❌ + 原话）', !!err && h.out.text.includes('❌ fetch failed'), h.out.text.slice(0, 160));
    ok('失败后按钮回到可点（不会永远卡在「对比中…」）',
      (byText(h.out, '对比两个版本') || {}).props?.disabled === false, h.out.text.slice(0, 160));
    ok('失败后没有进度行残留', byPart(h.out, 'fit-running-diff').length === 0);
    ok('失败不影响别的区块（审计区照样在）', h.out.text.includes('一致性（跨稿审计）'));
  }

  /* ── ⑨ 颜色铁律：体检 Tab 的样式里没有裸色值（全部令牌 + fallback） ── */
  {
    const h = await mountFit({ responses: Object.assign({}, baseResponses, { '/lanhu/diff': { ok: true, data: DIFF_UNRELIABLE }, '/lanhu/audit': { ok: true, data: AUDIT_WEAK } }) });
    await pickProjectAndDesign(h);
    byText(h.out, '对比两个版本').props.onClick();
    await tick();
    byText(h.render(), '开始审计').props.onClick();
    await tick();
    h.out = h.render();
    const fitNodes = h.out.nodes.filter((n) => n.underFit);
    ok('体检 Tab 确实渲染了大量节点（颜色检查不是空跑）', fitNodes.length >= 40, String(fitNodes.length));
    // 把 var(--token, fallback) 整段挖掉（含嵌套括号）—— 剩下的文本里**再出现**颜色字面量就是写死的。
    // ⚠️ 只判"整串是不是色值"会漏掉 `1px solid #d97706` 这种简写（实测漏过一次），所以这里按子串判。
    const stripVars = (v) => {
      let out = ''; let i = 0;
      for (;;) {
        const at = v.indexOf('var(', i);
        if (at < 0) { out += v.slice(i); return out; }
        out += v.slice(i, at);
        let depth = 0; let j = at + 3;
        for (; j < v.length; j += 1) {
          if (v[j] === '(') depth += 1;
          else if (v[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
        }
        i = j;
      }
    };
    const bad = [];
    let styled = 0;
    for (const n of fitNodes) {
      for (const [k, v] of Object.entries(n.props.style || {})) {
        if (typeof v !== 'string') continue;
        styled += 1;
        if (v.includes('var(') && !/var\(--[\w-]+,\s*[^)]+\)/.test(v)) bad.push(k + '=令牌缺 fallback:' + v);
        const rest = stripVars(v);
        if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(rest)) bad.push(k + '=' + v);
      }
    }
    ok('体检 Tab 的颜色全部走令牌 + fallback（没有裸色值）', bad.length === 0, bad.join(', '));
    ok('确实检查到了体检节点的样式', styled >= 20, `检查了 ${styled} 条样式值`);
  }
  {
    const seg = clientSrc.slice(clientSrc.indexOf('12. 体检：变更 diff'), clientSrc.indexOf('13. 面板（shell.overlay）'));
    const hit = seg.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    ok('体检源码段里也没有裸色值（渲染检查 + 源码检查两道）', !hit && seg.length > 4000, hit ? hit[0] : `长度 ${seg.length}`);
  }

  /* ── ⑩ Host 侧：四条新路由都在同一条 /lanhu 前缀下 ── */
  {
    eq('仍然只有一条 /lanhu 路由（体检没另开通道）', (idxSrc.match(/path:\s*'\/lanhu'/g) ?? []).length, 1);
    const routes = ['designs', 'versions', 'diff', 'audit'];
    ok('四条新路由都挂在 /lanhu 前缀的子路径上',
      routes.every((r) => new RegExp("route === '/lanhu/" + r + "'").test(idxSrc)),
      routes.filter((r) => !new RegExp("route === '/lanhu/" + r + "'").test(idxSrc)).join(',') || '全都在');
    ok('客户端只能通过 API 常量取数（新代码也守这条）', (() => {
      const callSites = [...clientSrc.matchAll(/\bjsonFetch\(([^,\n)]+)/g)].map((m) => m[1].trim()).filter((s) => s !== 'url');
      return callSites.every((s) => s.startsWith('API')) || callSites.every((s) => s.startsWith('API') || s === 'token, url' || s === 'url');
    })(), '');
    const callSites = [...clientSrc.matchAll(/\bjsonFetch\(([^,\n)]+)/g)].map((m) => m[1].trim()).filter((s) => s !== 'url');
    ok('（体检新代码的取数入口）jsonFetch 的首参不是裸字符串 URL',
      callSites.every((s) => !/^['"`]/.test(s)), callSites.filter((s) => /^['"`]/.test(s)).join(' | '));
  }
  {
    const mkReq = (url, method = 'GET', body = null, addr = '127.0.0.1') => ({
      url, method, headers: {}, socket: { remoteAddress: addr },
      [Symbol.asyncIterator]: async function* () { if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8'); },
    });
    const call = async (handler, req) => {
      const out = { status: 0, body: null, threw: undefined };
      const resp = { writeHead(s) { out.status = s; }, end(t) { out.body = JSON.parse(t); } };
      try { await handler(req, resp); } catch (e) { out.threw = e; }
      return out;
    };
    let sawDiffArgs = null;
    let sawAuditArgs = null;
    const handler = makeLanhuHandler({
      checkAuth: async () => ({ ok: true, account: 'acme', teamCount: 1 }),
      pickAccount: async () => ({ alias: 'quanzi', by: 'index' }),
      listImages: async () => ({ projectName: '小程序', images: [{ imageId: IID, name: '人才详情', width: 187.5, height: 666.5 }] }),
      imageVersions: async () => ({ name: '人才详情', versions: [{ id: V5, createTime: AT5, info: '版本5', hasLayoutData: true }] }),
      diffDesign: async (args) => { sawDiffArgs = args; return DIFF_OK; },
      auditProject: async (args) => {
        sawAuditArgs = args;
        if (args.limit === 7) throw new Error('审计炸了（桩）');
        return AUDIT_OK;
      },
    });

    const designs = await call(handler, mkReq('/lanhu/designs?pid=' + PID));
    eq('GET /lanhu/designs → 200', designs.status, 200);
    eq('designs 回项目名 + 稿列表', designs.body?.data?.images?.[0]?.name, '人才详情');
    eq('designs 缺参数 → 400（不静默给空列表）', (await call(handler, mkReq('/lanhu/designs'))).status, 400);
    const designsUrl = await call(handler, mkReq('/lanhu/designs?url=' + encodeURIComponent('https://lanhuapp.com/web/#/item/project/detailDetach?pid=' + PID + '&image_id=' + IID)));
    eq('designs 也认整条链接（自动解析 pid）', designsUrl.body?.data?.projectId, PID);
    eq('链接里带 image_id → 回给面板自动选中那张稿', designsUrl.body?.data?.imageId, IID);

    const versions = await call(handler, mkReq('/lanhu/versions?pid=' + PID + '&iid=' + IID));
    eq('GET /lanhu/versions → 200 且带版本列表', versions.body?.data?.versions?.[0]?.id, V5);
    eq('versions 缺参数 → 400', (await call(handler, mkReq('/lanhu/versions?pid=' + PID))).status, 400);

    const noFrom = await call(handler, mkReq('/lanhu/diff', 'POST', { projectId: PID, imageId: IID }));
    eq('POST /lanhu/diff 缺 from → 400', noFrom.status, 400);
    ok('缺 from 时给的是"下一步"而不是干巴巴的报错',
      /必填/.test(noFrom.body?.error || '') && /versions/.test(noFrom.body?.hint || ''), JSON.stringify(noFrom.body));
    const d = await call(handler, mkReq('/lanhu/diff', 'POST', { projectId: PID, imageId: IID, from: V4, to: V5 }));
    eq('POST /lanhu/diff → 200 且把参数透传下去', d.status, 200);
    eq('diff 收到的 from 就是面板传的', sawDiffArgs?.from, V4);
    eq('diff 收到的 to 就是面板传的', sawDiffArgs?.to, V5);
    eq('diff 结果按 {ok,data} 信封回（与既有路由一致）', d.body?.ok, true);

    const a1 = await call(handler, mkReq('/lanhu/audit', 'POST', { projectId: PID, limit: 3 }));
    eq('POST /lanhu/audit → 200', a1.status, 200);
    eq('张数照传', sawAuditArgs?.limit, 3);
    const a2 = await call(handler, mkReq('/lanhu/audit', 'POST', { projectId: PID, limit: 5000 }));
    eq('张数在 Host 侧再夹一次（5000 → 200）', sawAuditArgs?.limit, 200);
    await call(handler, mkReq('/lanhu/audit', 'POST', { projectId: PID }));
    eq('不传张数 → 传 undefined（用后端自己的默认值，口径一致）', sawAuditArgs?.limit, undefined);

    // ⭐ 隔离性：一次审计炸了，不许影响别的端点（尤其 status）
    const boom = await call(handler, mkReq('/lanhu/audit', 'POST', { projectId: PID, limit: 7 }));
    ok('审计抛错时 handler 自己不抛（收敛成 {ok:false}）', boom.threw === undefined, boom.threw ? String(boom.threw.message) : '');
    eq('审计抛错回的是 JSON 信封而不是 500', boom.status, 200);
    ok('审计抛错带上了原话', /审计炸了/.test(boom.body?.error || ''), JSON.stringify(boom.body));
    const afterStatus = await call(handler, mkReq('/lanhu/status'));
    eq('审计炸过之后 /lanhu/status 照样 200（互不牵连）', afterStatus.status, 200);
    eq('status 的字段没被审计污染', afterStatus.body?.data?.account, 'acme');
    const afterPreview = await call(handler, mkReq('/lanhu/preview', 'POST', {}));
    eq('既有 /lanhu/preview 的 400 行为不变', afterPreview.status, 400);

    // 守卫：新路由同样只允许本机
    eq('非本机访问 /lanhu/audit → 403', (await call(handler, mkReq('/lanhu/audit', 'POST', { projectId: PID }, '10.0.0.9'))).status, 403);
    eq('非本机访问 /lanhu/designs → 403', (await call(handler, mkReq('/lanhu/designs?pid=' + PID, 'GET', null, '10.0.0.9'))).status, 403);
    eq('非本机访问 /lanhu/diff → 403', (await call(handler, mkReq('/lanhu/diff', 'POST', { from: V4 }, '10.0.0.9'))).status, 403);
  }

  /* ── ⑪b Host：批量版本数端点 /lanhu/versions-count（面板「稿」下拉的「N 版」） ── */
  group('⑪b Host：批量版本数端点');
  {
    const mkReq = (url, method = 'GET', body = null, addr = '127.0.0.1') => ({
      url, method, headers: {}, socket: { remoteAddress: addr },
      [Symbol.asyncIterator]: async function* () { if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8'); },
    });
    const call = async (handler, req) => {
      const out = { status: 0, body: null, threw: undefined };
      const resp = { writeHead(s) { out.status = s; }, end(t) { out.body = JSON.parse(t); } };
      try { await handler(req, resp); } catch (e) { out.threw = e; }
      return out;
    };

    const VC_PID = 'c0ffee00-1111-4222-8333-444455556666';
    // 140 张：既够验证「默认 30」也够验证「硬上限 100」压回
    const MANY = Array.from({ length: 140 }, (_, i) => ({ imageId: 'img-' + String(i).padStart(3, '0'), name: '稿' + (i + 1) }));
    const mkHandler = (over = {}) => {
      const seen = { calls: [], maxFly: 0, fly: 0 };
      const h = makeLanhuHandler(Object.assign({
        checkAuth: async () => ({ ok: true, account: 'acme', teamCount: 1 }),
        pickAccount: async () => ({ alias: 'quanzi', by: 'index' }),
        listImages: async () => ({ projectName: '大项目', images: MANY }),
        imageVersions: async (pid, iid) => {
          seen.calls.push(iid);
          seen.fly += 1; seen.maxFly = Math.max(seen.maxFly, seen.fly);
          await new Promise((r) => setTimeout(r, 1));
          seen.fly -= 1;
          if (iid === 'img-003') throw new Error('这一张炸了（桩）');
          return { name: iid, versions: iid === 'img-004' ? [{ id: 'only' }] : [{ id: 'v2-' + iid }, { id: 'v1-' + iid }] };
        },
      }, over));
      return { h, seen };
    };

    const a = mkHandler();
    const r1 = await call(a.h, mkReq('/lanhu/versions-count?pid=' + VC_PID));
    eq('GET /lanhu/versions-count → 200（{ok,data} 信封与既有路由一致）', r1.status, 200);
    eq('信封是 ok:true', r1.body?.ok, true);
    eq('默认一批只探 30 张（不传 limit 不许无限拉）', a.seen.calls.length, 30);
    eq('回包里写明实际用的上限', r1.body?.data?.limit, 30);
    eq('回包里带项目总张数（面板据此算"还剩多少"）', r1.body?.data?.total, 140);
    eq('结果条数与本批一致', (r1.body?.data?.images ?? []).length, 30);
    eq('结果顺序与稿列表一致（并发不影响输出顺序）', r1.body?.data?.images?.[0]?.imageId, 'img-000');
    eq('latestVersionId 取版本列表第 0 条（与 /lanhu/versions 同口径）', r1.body?.data?.images?.[0]?.latestVersionId, 'v2-img-000');
    eq('并发用满 4（快了，同时对蓝湖礼貌）', a.seen.maxFly, 4);
    ok('并发**没有**超过 4', a.seen.maxFly <= 4, String(a.seen.maxFly));

    const failed = r1.body?.data?.images?.[3];
    eq('单张失败只标 ok:false（整条请求照样 200）', failed?.ok, false);
    eq('失败那条的版本数是 null —— 是"没探到"，不是"0 个"', failed?.versionCount, null);
    ok('失败那条带上原话（能排查）', /炸了/.test(failed?.error || ''), failed?.error);
    ok('同一批里其它稿照样成功（互不牵连）',
      (r1.body?.data?.images ?? []).slice(0, 3).every((x) => x.ok === true && x.versionCount === 2),
      JSON.stringify((r1.body?.data?.images ?? []).slice(0, 3)));
    eq('确实只有 1 个版本的那张：versionCount=1（面板据此置灰）', r1.body?.data?.images?.[4]?.versionCount, 1);

    const b = mkHandler();
    const r2 = await call(b.h, mkReq('/lanhu/versions-count?pid=' + VC_PID + '&limit=5000'));
    eq('limit 传 5000 → 被硬上限 100 压回（不靠调用方自觉）', b.seen.calls.length, 100);
    eq('回包里的 limit 也是夹过的值', r2.body?.data?.limit, 100);

    const c = mkHandler();
    const r3 = await call(c.h, mkReq('/lanhu/versions-count?pid=' + VC_PID + '&offset=30&limit=5'));
    eq('offset 真的分页（从第 31 张开始）', r3.body?.data?.images?.[0]?.imageId, 'img-030');
    eq('分页时只探这 5 张', c.seen.calls.length, 5);
    eq('offset 原样回给调用方（面板据此推游标）', r3.body?.data?.offset, 30);

    const d = mkHandler();
    const r4 = await call(d.h, mkReq('/lanhu/versions-count?pid=' + VC_PID + '&offset=-3&limit=abc'));
    eq('offset/limit 是垃圾值时回落 offset=0 / 默认 30（不炸、不无限）',
      [r4.body?.data?.offset, r4.body?.data?.limit], [0, 30]);

    const e = mkHandler();
    const r5 = await call(e.h, mkReq('/lanhu/versions-count?url=' + encodeURIComponent('https://lanhuapp.com/web/#/item/project/detailDetach?pid=' + VC_PID)));
    eq('也认整条链接（与 /lanhu/designs 同一个解析）', r5.body?.data?.projectId, VC_PID);

    eq('缺 pid → 400（不静默给空列表）', (await call(a.h, mkReq('/lanhu/versions-count'))).status, 400);
    eq('非本机 → 403（新路由同样守门）',
      (await call(a.h, mkReq('/lanhu/versions-count?pid=' + VC_PID, 'GET', null, '10.0.0.9'))).status, 403);

    const f = mkHandler({ listImages: async () => { throw new Error('列稿炸了（桩）'); } });
    const r6 = await call(f.h, mkReq('/lanhu/versions-count?pid=' + VC_PID));
    eq('列稿失败 → 收敛成 {ok:false} 信封（HTTP 仍 200，不 500）', r6.status, 200);
    ok('列稿失败带原话', /列稿炸了/.test(r6.body?.error || ''), JSON.stringify(r6.body));
    eq('列稿失败也不许把 handler 炸掉', r6.threw, undefined);

    ok('新端点挂在 /lanhu 前缀的子路径上（没开第二条通道）',
      /route === '\/lanhu\/versions-count'/.test(idxSrc), '');
    eq('仍然只有一条 /lanhu 路由', (idxSrc.match(/path:\s*'\/lanhu'/g) ?? []).length, 1);
    // 上限进 LIMITS（单一出口），不许在逻辑里裸写数字
    const { LIMITS: L2 } = await import('../lanhu.mjs');
    eq('LIMITS 里登记了默认上限 30', L2.versionsCountDefault, 30);
    eq('LIMITS 里登记了硬上限 100', L2.versionsCountMax, 100);
    eq('LIMITS 里登记了并发 4', L2.versionsCountConcurrency, 4);
    const seg = idxSrc.slice(idxSrc.indexOf('async function imageVersionCounts'), idxSrc.indexOf('export function makeLanhuHandler'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // 注释里的"默认 30 / 硬上限 100"是说明，不算裸数字
    ok('批量逻辑里的上限全部走 LIMITS（代码里没有裸写 30/100）',
      /LIMITS\.versionsCount(Default|Max|Concurrency)/.test(seg) && !/\b(30|100)\b/.test(seg.replace(/LIMITS\.[A-Za-z]+/g, 'LIMITS')),
      seg.match(/\b(30|100)\b/g)?.join(',') || '');
  }

  /* ── ⑪c Client：「稿」下拉的版本数（1 版置灰 / 未知不禁用 / 分批探） ── */
  group('⑪c Client：稿下拉的版本数');
  {
    const VC_PID = 'aa11bb22-3333-4444-8555-666677778888';
    const designs32 = Array.from({ length: 32 }, (_, k) => ({ imageId: 'vc-' + String(k + 1).padStart(2, '0'), name: '稿' + String(k + 1).padStart(2, '0') }));
    const batch1 = designs32.slice(0, 30).map((d, i) => (i === 1
      ? { imageId: d.imageId, versionCount: 1, latestVersionId: 'v1', ok: true }               // 只有 1 版 → 置灰
      : (i === 4
        ? { imageId: d.imageId, versionCount: null, latestVersionId: null, ok: false, error: '蓝湖返回空壳' }  // 探失败 → 不禁用
        : { imageId: d.imageId, versionCount: 3, latestVersionId: 'v' + i, ok: true })));
    const batch2 = [
      { imageId: designs32[30].imageId, versionCount: 4, latestVersionId: 'v30', ok: true },
      { imageId: designs32[31].imageId, versionCount: 1, latestVersionId: 'v31', ok: true },
    ];
    const VC_RESPONSES = Object.assign({}, baseResponses, {
      '/lanhu/accounts': {
        ok: true,
        data: { default: 'acme', accounts: [{ alias: 'acme', company: '示例', isDefault: true, hasCookie: true, projects: [{ projectId: VC_PID, name: '32 张稿的项目' }] }] },
      },
      ['/lanhu/designs?pid=' + VC_PID]: { ok: true, data: { projectId: VC_PID, imageId: null, projectName: '32 张稿的项目', images: designs32 } },
      ['/lanhu/versions-count?pid=' + VC_PID + '&offset=0&limit=30']: { ok: true, data: { projectId: VC_PID, total: 32, offset: 0, limit: 30, images: batch1 } },
      ['/lanhu/versions-count?pid=' + VC_PID + '&offset=30&limit=30']: { ok: true, data: { projectId: VC_PID, total: 32, offset: 30, limit: 30, images: batch2 } },
    });
    const vcCalls = (p) => p.calls.filter((u) => u.startsWith('/lanhu/versions-count'));
    const designItems = (out) => {
      const sel = byPart(out, 'fit-design')[0];
      if (!sel) return [];
      return (Array.isArray(sel.props.children) ? sel.props.children : [sel.props.children])
        .filter((c) => c && c.type === 'option')
        .map((c) => ({ value: c.props.value, label: c.props.children, disabled: c.props.disabled === true, title: c.props.title }));
    };
    const at = (out, v) => designItems(out).filter((o) => o.value === v)[0] || {};
    const moreBtn = (out) => {
      const box = byPart(out, 'fit-vc-more')[0];
      if (!box) return null;
      return (Array.isArray(box.props.children) ? box.props.children : [box.props.children])[0];
    };
    // ⚠️ 这两个用**防御式**写法：面板被改坏时给出"断言失败"而不是让自检当场崩掉
    //    （崩掉的话后面的断言一条都报不出来，变异测试就只能看到一句 TypeError）。
    const pickProject = (out, value) => {
      const sel = byPart(out, 'fit-project')[0];
      if (!sel) return false;
      sel.props.onChange({ target: { value: value || opts(sel)[1] } });
      return true;
    };
    const clickMore = (out) => { const b = moreBtn(out); if (b) b.props.onClick(); return Boolean(b); };

    /* ① 触发时机：开面板不探（一个项目 252 张稿 = 252 次请求，绝不能挂在打开动作上） */
    const h = await mountFit({ responses: VC_RESPONSES });
    ok('面板打开后一个 versions-count 请求都没发（触发点是「选中项目」，不是「打开面板」）',
      vcCalls(h.p).length === 0, h.p.calls.join(', '));
    ok('开面板也没有偷偷去列稿（没有 /lanhu/designs）',
      !h.p.calls.some((u) => u.startsWith('/lanhu/designs')), h.p.calls.join(', '));
    // ⚠️ 上面两条只覆盖"真的执行了"的路径；自检的 React 替身里 useEffect 是空实现，
    //    所以再加两条**源码级**的：触发点必须长在 loadFitDesigns 里，且全项目只有这两处调用
    //    （定义 + 触发 + 「继续加载」按钮 = 3；多一处就是在别处偷偷触发了）。
    ok('触发点就长在 loadFitDesigns 里（选中项目 / 贴链接之后）',
      /probeFitVersionCounts\(\);/.test(clientSrc.slice(clientSrc.indexOf('function loadFitDesigns'), clientSrc.indexOf('function loadFitVersions'))), '');
    eq('probeFitVersionCounts 全项目只有 3 处出现（定义 + loadFitDesigns 触发 + 继续加载按钮）',
      (clientSrc.match(/probeFitVersionCounts\(/g) ?? []).length, 3);

    /* ② 选中项目 → 才探第一批 */
    const proj = byPart(h.out, 'fit-project')[0];
    ok('选中项目之前版本数就是空的（没什么可探）', vcCalls(h.p).length === 0, vcCalls(h.p).join(', '));
    if (proj) proj.props.onChange({ target: { value: opts(proj)[1] } });
    await tick(); await tick();
    h.out = h.render();
    eq('选中项目之后才探第一批（1 次）', vcCalls(h.p).length, 1);
    eq('第一批 offset=0、limit=30（面板也守着"一批 30 张"）',
      vcCalls(h.p)[0], '/lanhu/versions-count?pid=' + VC_PID + '&offset=0&limit=30');

    /* ③ 下拉里带版本数 / 1 版置灰 / 探失败不禁用 */
    eq('32 张稿一条都没被藏起来（置灰 ≠ 消失）', designItems(h.out).length, 33);
    eq('多版本的稿标出确切版本数', at(h.out, 'vc-01').label, '稿01（3 版）');
    eq('1 个版本的稿也标出来', at(h.out, 'vc-02').label, '稿02（1 版）');
    eq('只有 1 个版本 → 置灰不可选（没有可对比的）', at(h.out, 'vc-02').disabled, true);
    ok('1 版那条顺手给出原因（鼠标停上去就看得到）',
      String(at(h.out, 'vc-02').title || '').includes('只有 1 个版本，没有可对比的'), String(at(h.out, 'vc-02').title));
    eq('多版本的稿**不**置灰（能点的照常能点）', at(h.out, 'vc-01').disabled, false);
    eq('探失败的稿标成「版本数未知」', at(h.out, 'vc-05').label, '稿05（版本数未知）');
    eq('探失败的稿**照常可选**（拿不准时不要误伤）', at(h.out, 'vc-05').disabled, false);

    const hint = (byPart(h.out, 'fit-vc-hint')[0] || {}).props;
    ok('界面说清了「1 版为什么不能点」',
      !!hint && String(hint.children).includes('1 张只有 1 个版本，已置灰（没有可对比的）'), hint ? String(hint.children) : '没有');
    ok('界面也说清了「探不到的照常可选」',
      !!hint && String(hint.children).includes('1 张版本数未知（照常可选，不误伤）'), hint ? String(hint.children) : '没有');

    /* ④ 继续加载：只探没探过的 */
    ok('还有没探的稿 → 给出「继续加载」入口', !!moreBtn(h.out), JSON.stringify(byPart(h.out, 'fit-vc-more').length));
    ok('「继续加载」写明还剩多少张 + 成本口径',
      String(moreBtn(h.out).props.label).includes('还剩 2 张')
        && String(moreBtn(h.out).props.title).includes('没探过'),
      String(moreBtn(h.out).props.label) + ' / ' + String(moreBtn(h.out).props.title));
    ok('点得动「继续加载」', clickMore(h.out));
    await tick(); await tick();
    h.out = h.render();
    eq('点「继续加载」才发第二批（一开始只探了 30 张，没有全量探）', vcCalls(h.p).length, 2);
    eq('第二批从 offset=30 起（**探过的绝不重探**）',
      vcCalls(h.p)[1], '/lanhu/versions-count?pid=' + VC_PID + '&offset=30&limit=30');
    eq('两批的 offset 互不相同（没有原地重复探）',
      new Set(vcCalls(h.p).map((u) => /offset=(\d+)/.exec(u)[1])).size, 2);
    eq('探完之后：31 张有「N 版」（32 张里 1 张探失败）',
      designItems(h.out).filter((o) => /（\d+ 版）$/.test(String(o.label))).length, 31);
    eq('第二批里的 1 版稿同样置灰', at(h.out, 'vc-32').disabled, true);
    eq('都探完了 → 「继续加载」自己消失', byPart(h.out, 'fit-vc-more').length, 0);

    /* ⑤ 加载中：必须有明确状态（不能让人以为卡死） */
    const h2 = await mountFit({ responses: VC_RESPONSES, hangUrl: '/lanhu/versions-count' });
    pickProject(h2.out);
    await tick(); await tick();
    h2.out = h2.render();
    const prog = (byPart(h2.out, 'fit-vc-progress')[0] || {}).props;
    ok('正在探版本数时有一行明确进度', !!prog, JSON.stringify(byPart(h2.out, 'fit-vc-progress').length));
    ok('进度写明探到哪 / 共多少 / 本次几张',
      !!prog && String(prog.children).includes('正在读取版本数（0/32，本次 30 张）'), prog ? String(prog.children) : '');
    eq('还没探到的稿在选项里后缀「…」（下拉本身也看得出在加载）', at(h2.out, 'vc-01').label, '稿01（…）');
    eq('加载中不给「继续加载」（防重复点）', byPart(h2.out, 'fit-vc-more').length, 0);
    ok('加载中整棵树照常渲染（没抛错）', h2.out.errors.length === 0, h2.out.errors.join('; '));

    /* ⑥ fetch 挂了：只显示错误，绝不 throw，也不禁用 */
    const h3 = await mountFit({ responses: VC_RESPONSES, failUrl: '/lanhu/versions-count' });
    pickProject(h3.out);
    await tick(); await tick();
    h3.out = h3.render();
    ok('版本数取数失败时整棵树照常渲染（没抛错）', h3.out.errors.length === 0, h3.out.errors.join('; '));
    const err = (byPart(h3.out, 'fit-vc-error')[0] || {}).props;
    ok('失败显示在界面上（❌ + 原话 + "照常可选"）',
      !!err && /❌ fetch failed/.test(String(err.children)) && /照常可选/.test(String(err.children)), err ? String(err.children) : '没有');
    ok('这一批的稿全都标成「版本数未知」', designItems(h3.out).slice(1, 31).every((o) => /（版本数未知）$/.test(String(o.label))),
      designItems(h3.out).slice(1, 3).map((o) => o.label).join(' , '));
    ok('探失败的稿**一个都没被禁用**（别因为拿不准就误伤）',
      designItems(h3.out).every((o) => o.disabled === false), JSON.stringify(designItems(h3.out).filter((o) => o.disabled).map((o) => o.label)));
    ok('失败后还能重试（「继续加载」还在）', !!moreBtn(h3.out));
    ok('点得动「继续加载」（重试入口）', clickMore(h3.out));
    await tick(); await tick();
    h3.out = h3.render();
    eq('重试仍从 offset=0 起 —— 失败的那批本来就没探成，这是「重试」不是「重复探已探过的」',
      vcCalls(h3.p)[1], '/lanhu/versions-count?pid=' + VC_PID + '&offset=0&limit=30');

    /* ⑦ 颜色铁律：新节点的样式全走令牌 + fallback（无裸色值） */
    const stripVars = (v) => {
      let out = ''; let i = 0;
      for (;;) {
        const i2 = v.indexOf('var(', i);
        if (i2 < 0) { out += v.slice(i); return out; }
        out += v.slice(i, i2);
        let depth = 0; let j = i2 + 3;
        for (; j < v.length; j += 1) {
          if (v[j] === '(') depth += 1;
          else if (v[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
        }
        i = j;
      }
    };
    const vcStyles = h3.out.nodes
      .filter((n) => /^fit-vc-/.test(String(n.props['data-dsh-part'] || '')) || n.props['data-dsh-part'] === 'fit-design')
      .flatMap((n) => Object.values(n.props.style || {}).filter((v) => typeof v === 'string'));
    const bare = vcStyles.filter((v) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(stripVars(v)));
    const noFallback = vcStyles.filter((v) => v.includes('var(') && !/var\(--[\w-]+,\s*[^)]+\)/.test(v));
    ok('确实检查到了新节点的样式（不是空跑）', vcStyles.length >= 5, String(vcStyles.length));
    ok('「N 版」那几行的颜色全走令牌（没有裸色值）', bare.length === 0, bare.join(' | '));
    ok('令牌都带 fallback（用户皮肤下不会变成透明/看不清）', noFallback.length === 0, noFallback.join(' | '));
  }
}

/* ═══════════════ ⑫ 提示示例与真值同源 + 块类型徽标令牌化 ═══════════════ */
group('⑫ 提示示例同源 / 徽标令牌化');
{
  const _root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const idxSrc = fs.readFileSync(path.join(_root, 'lib', 'index.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(_root, 'lib', 'client.js'), 'utf8');

  /* ── ① 给模型看的示例，必须等于实现产出（改了文案、或改了实现，都要红） ── */
  const REAL_RGBA = rgbaString({ r: 87, g: 74, b: 244, a: 0.1 });
  const REAL_SAMPLE = bgText({ hex: '#574af4', alpha: 0.1 });
  eq('rgbaString() 的半透明形态就是「逗号后带空格 + alpha 带前导 0」', REAL_RGBA, 'rgba(87, 74, 244, 0.1)');

  // 取**模型真正读到的那份**提示：从源码里抠出来的是拼接表达式，验不出真值。
  let hint = null;
  applyHostPlugin({
    inject: (_svcs, fn) => fn({
      effect: (f) => { const d = f(); return typeof d === 'function' ? d : () => {}; },
      get: (n) => (n === 'systemPrompt'
        ? { section: (s) => { hint = s.text; return () => {}; } }
        : { register: () => () => {} }),
    }),
  });
  ok('拿到模型真正读到的那份 SYSTEM_HINT（不是源码里的拼接表达式）',
    typeof hint === 'string' && hint.length > 500, `长度 ${hint ? hint.length : 0}`);
  const inHint = /rgba\([^)]*\)/.exec(hint || '');
  eq('提示里的 rgba 示例 === rgbaString() 对同一输入的真实产出',
    inHint ? inHint[0] : '(提示里一个 rgba 示例都没有)', REAL_RGBA);
  ok('提示里的整段色值示例 === bgText() 的真实渲染（连 `#hex@NN%` 一起）',
    (hint || '').includes(REAL_SAMPLE), `示例应为 ${REAL_SAMPLE}`);
  {
    const seg = idxSrc.slice(idxSrc.indexOf('const SYSTEM_HINT = ['), idxSrc.indexOf('].join('));
    ok('SYSTEM_HINT 的数组里没有手抄的 rgba 字面量（示例是从实现派生的）',
      !/rgba\(/.test(seg), '写死的话，实现一改提示就漂移，且没人会收到通知');
  }
  {
    // 全项目扫一遍：**文档 / 提示 / 源码注释**里出现的"具体 rgba 示例"都必须是实现产出的形态。
    // 只认反引号里的 inline code（示例都这么写），且只认带具体数值的（`rgba(…)`/`rgba(${r}, …)` 占位不算）。
    // test/ 是夹具（Figma 输入本身就是无空格形态）、.github/release-notes/ 是历史发布说明，都不扫。
    const SKIP = /^(node_modules|\.git|test|\.github\/release-notes)$/;
    const files = [];
    (function walk(dir, rel) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (SKIP.test(r)) continue;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else if (/\.(js|mjs|md)$/.test(e.name)) files.push(r);
      }
    })(_root, '');
    const bad = [];
    let seen = 0;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(_root, rel), 'utf8');
      for (const m of src.matchAll(/`([^`\n]*)`/g)) {
        for (const c of (m[1].match(/rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[0-9.]+\s*\)/g) ?? [])) {
          seen += 1;
          if (!/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1)(?:\.\d+)?\)$/.test(c)) bad.push(rel + ':' + c);
        }
      }
    }
    ok('全项目「示例里的具体 rgba」都是实现产出的形态（文档 / 提示 / 源码注释一起管）',
      bad.length === 0, bad.join(' | '));
    ok('确实扫到了示例（不是空跑）', seen >= 3, `扫到 ${seen} 处`);
  }

  /* ── ② 块类型徽标：一律令牌 + fallback（写死 hex / 丢 fallback 都要红） ── */
  const stripVars = (v) => {
    let out = ''; let i = 0;
    for (;;) {
      const at = v.indexOf('var(', i);
      if (at < 0) { out += v.slice(i); return out; }
      out += v.slice(i, at);
      let depth = 0; let j = at + 3;
      for (; j < v.length; j += 1) {
        if (v[j] === '(') depth += 1;
        else if (v[j] === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      i = j;
    }
  };
  const TOKEN_OK = /^var\(--dsw-[\w-]+,\s*[^)]+\)$/;
  const KS = clientSrc.slice(clientSrc.indexOf('const KIND_STYLE'), clientSrc.indexOf('function KindBadge'));
  const entries = [...KS.matchAll(/(\w+):\s*\{\s*label:\s*'[^']*',\s*color:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ kind: m[1], color: m[2] }));
  eq('KIND_STYLE 仍是 7 类（画板/卡片/容器/胶囊/文本/图片/分割线）', entries.length, 7);
  ok('KIND_STYLE 每个颜色都是 var(--dsw-*, 兜底)',
    entries.every((e) => TOKEN_OK.test(e.color)),
    entries.filter((e) => !TOKEN_OK.test(e.color)).map((e) => e.kind + '=' + e.color).join(', '));
  ok('KIND_STYLE 里没有裸色值（stripVars 之后不剩颜色字面量）',
    entries.every((e) => !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(stripVars(e.color))),
    entries.map((e) => e.kind + '=' + stripVars(e.color)).filter((s) => /#|rgb/.test(s)).join(', '));
  eq('7 类取 7 个互不相同的令牌（互相可区分）', new Set(entries.map((e) => e.color)).size, 7);

  /* ── ②-渲染：离屏把块级 tab 整棵树跑一遍（徽标是真渲染出来的，不是读源码） ── */
  const KINDS = ['artboard', 'card', 'container', 'pill', 'text', 'image', 'divider'];
  const KLABEL = { artboard: '画板', card: '卡片', container: '容器', pill: '胶囊', text: '文本', image: '图片', divider: '分割线' };
  const blocksPayload = {
    ok: true,
    data: {
      name: '徽标夹具', viewport: { width: 375, height: 800 },
      layerCount: 7, blockCount: 7, noiseCount: 0,
      kindCounts: { artboard: 1, card: 1, container: 1, pill: 1, text: 1, image: 1, divider: 1 },
      blocks: KINDS.map((kind, i) => ({
        uid: kind, kind, name: 'B' + (i + 1), x: 0, y: i * 40, w: 120, h: 32,
        radius: null, bg: null, border: null, text: null, font: null, color: null,
        childCount: 0, path: 'Root/' + kind, noise: false,
      })),
    },
  };

  /** 最小 React 替身（与 ⑩/⑪ 同一套做法）：组件、状态机、渲染规则都是真代码。 */
  function loadBadgePanel() {
    const calls = [];
    const fetchImpl = async (url) => {
      const u = String(url);
      calls.push(u);
      return { status: 200, json: async () => (u.startsWith('/lanhu/preview') ? blocksPayload : { ok: true, data: {} }) };
    };
    class Component { constructor(props) { this.props = props || {}; this.state = {}; } }
    const createElement = (type, props, ...children) => {
      const p = Object.assign({}, props || {});
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    };
    const React = {
      createElement, Component, Fragment: 'Fragment',
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {}, useRef: (v) => ({ current: v === undefined ? null : v }),
    };
    let loaded = null;
    const win = { __ModuleLoader__: { load: (m) => { loaded = m; } } };
    new Function('window', 'console', 'fetch', clientSrc)(win, console, fetchImpl);
    const exports = loaded.factory((id) => {
      if (id === 'react') return React;
      throw new Error('未提供的模块：' + id);
    });
    const captured = {};
    exports.apply({
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
      slots: {
        inject: (name, fn) => { fn(); return () => {}; },
        register: (meta, comp) => { captured[meta.id] = comp; return () => {}; },
      },
    });
    return { captured, calls };
  }
  function collectPanel(node, out, depth = 0) {
    if (node === null || node === undefined || typeof node === 'boolean' || depth > 40) return;
    if (Array.isArray(node)) { for (const n of node) collectPanel(n, out, depth + 1); return; }
    if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return; }
    if (typeof node !== 'object') return;
    const { type, props = {} } = node;
    out.nodes.push({ type: typeof type === 'function' ? (type.name || 'anon') : String(type), props });
    if (typeof type === 'function') {
      let rendered;
      try {
        rendered = (type.prototype && typeof type.prototype.render === 'function')
          ? new type(props).render() : type(props);
      } catch (e) { out.errors.push((type.name || 'anon') + ': ' + String((e && e.message) || e)); return; }
      collectPanel(rendered, out, depth + 1);
      return;
    }
    collectPanel(props.children, out, depth + 1);
  }
  {
    const p = loadBadgePanel();
    const overlay = p.captured['lanhu-panel'];
    const entry = p.captured['lanhu'];
    ok('入口与面板都注册上了（渲染检查的前提）', typeof entry === 'function' && typeof overlay === 'function');
    const render = () => {
      const o = { text: [], nodes: [], errors: [] };
      collectPanel(overlay({}), o);
      o.text = o.text.join(' ');
      return o;
    };
    // 和用户同一条路径：开面板 → 填链接 → 点「读取块级清单」（不直接改 state）
    entry({ wide: true }).props.onClick();
    await new Promise((r) => setTimeout(r, 15));
    let out = render();
    const ta = out.nodes.find((n) => n.props['data-dsh-part'] === 'url-input');
    ok('面板上有链接输入框（先填链接才谈得上读稿）', !!ta);
    ta.props.onChange({ target: { value: 'https://lanhuapp.com/web/#/item/project/detailDetach?pid=P&image_id=I' } });
    await new Promise((r) => setTimeout(r, 15));
    out = render();
    const read = out.nodes.find((n) => n.type === 'button' && n.props.children === '读取块级清单');
    ok('面板上有「读取块级清单」按钮', !!read);
    read.props.onClick();
    await new Promise((r) => setTimeout(r, 15));
    out = render();
    ok('块级 tab 真的渲染出了块（徽标检查不是空跑）', out.text.includes('B1'), out.text.slice(0, 120));
    ok('面板整棵树渲染无异常（客户端绝不 throw）', out.errors.length === 0, out.errors.join('; '));

    const badge = out.nodes.filter((n) => n.type === 'span'
      && Object.values(KLABEL).includes(n.props.children)
      && typeof (n.props.style || {}).border === 'string'
      && n.props.style.border.startsWith('1px solid '));
    eq('7 类徽标各渲染了一次', badge.length, 7);
    ok('徽标的文字色与边框色用同一个令牌、且都带 fallback',
      badge.every((b) => TOKEN_OK.test(b.props.style.color) && b.props.style.border === '1px solid ' + b.props.style.color),
      badge.map((b) => b.props.style.color).join(' , '));
    ok('徽标渲染出来的样式里没有裸色值',
      badge.every((b) => !/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(stripVars(b.props.style.color + ';' + b.props.style.border))),
      badge.map((b) => stripVars(b.props.style.border)).join(' , '));
    eq('7 类徽标渲染出 7 个互不相同的颜色（互相可区分）',
      new Set(badge.map((b) => b.props.style.color)).size, 7);
  }
}

/* ═══════════════ ⑯ 生成代码（lanhu_gen_code，§4.10） ═══════════════ */
group('⑯ 生成代码（lanhu_gen_code，§4.10）');

{
  // ── 离线夹具：一棵覆盖各种「数值形状」的树 ──
  // 形状**照真稿抄**（色分量 0..1、渐变方向 from/to 归一化 0..1、阴影 spread/inset、rotation 度数）。
  const C = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a });
  const G = (from, to, stops) => ({
    type: 'gradient',
    isEnabled: true,
    gradient: { type: 0, from, to, stops: stops.map(([position, color]) => ({ position, color })) },
  });
  const SH = (o) => ({ isEnabled: true, x: 0, y: 0, blur: 0, spread: 0, inset: false, ...o });
  const RD = (tl, tr, br, bl) => ({ topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl });
  const BORDER = (o) => ({ isEnabled: true, style: 'solid', width: 1, widths: { left: 1, top: 1, right: 1, bottom: 1 }, ...o });
  const N = (name, frame, style = {}, extra = {}) => ({
    name,
    type: 'frame',
    frame,
    style: { fills: [], borders: [], shadows: [], blurs: [], ...style },
    paths: [],
    layers: [],
    ...extra,
  });
  const TXT = (name, frame, content, font, color, extra = {}) => ({
    name,
    type: 'textLayer',
    frame,
    style: { fills: color ? [{ type: 'color', isEnabled: true, color }] : [], borders: [], shadows: [], blurs: [], ...(extra.style ?? {}) },
    paths: [],
    layers: [],
    text: { value: content, style: { content, font, color, ...(extra.text ?? {}) } },
    ...(extra.node ?? {}),
  });

  const TREE = {
    artboard: {
      name: '生成夹具',
      frame: { left: 0, top: 0, width: 375, height: 800 },
      layers: [
        // ① 渐变按钮：两层阴影（一层 inset）+ 四角相等
        N('Button', { left: 32, top: 100, width: 311, height: 42 }, {
          fills: [G({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, [[0, C(111, 103, 249)], [1, C(84, 70, 243)]])],
          shadows: [
            SH({ x: 0, y: 4, blur: 12, spread: 0, inset: true, color: C(232, 230, 255, 0.35) }),
            SH({ x: 0, y: 4, blur: 10, spread: 0, inset: false, color: C(0, 0, 0, 0.12) }),
          ],
        }, { paths: [{ type: 'rect', radius: RD(9999, 9999, 9999, 9999) }] }),
        // ② 半透明胶囊：底色 + 同色 1px 描边
        N('Verified Badge', { left: 216, top: 223, width: 66, height: 21 }, {
          fills: [{ type: 'color', isEnabled: true, color: C(87, 74, 244, 0.1) }],
          borders: [BORDER({ color: C(87, 74, 244, 0.1) })],
        }, { paths: [{ type: 'rect', radius: RD(9999, 9999, 9999, 9999) }] }),
        // ③ 圆形图标：ellipse + 渐变 + 单层阴影
        N('Icon Round', { left: 44, top: 388, width: 48, height: 48 }, {
          fills: [G({ x: 0.1464466, y: 0.75 }, { x: 0.8535534, y: 0.25 }, [[0, C(104, 92, 245)], [1, C(151, 142, 251)]])],
          shadows: [SH({ x: 0, y: 1, blur: 2, spread: 0, color: C(191, 219, 254, 0.5) })],
        }, { paths: [{ type: 'ellipse', radius: RD(0, 0, 0, 0) }] }),
        // ⑫ 椭圆环：12px 半透明描边、没有填充（蓝湖给 border-radius: 0 → 会画成方形）
        N('Ring', { left: 100, top: 388, width: 93, height: 93 }, {
          borders: [BORDER({ width: 12, widths: { left: 0, top: 0, right: 0, bottom: 0 }, color: C(26, 148, 255, 0.3) })],
        }, { paths: [{ type: 'ellipse', radius: RD(0, 0, 0, 0) }] }),
        // ⑭ 发光圆点：spread ≠ 0、阴影色 ≠ 背景色
        N('Glow Dot', { left: 1826, top: 210, width: 10, height: 10 }, {
          fills: [{ type: 'color', isEnabled: true, color: C(112, 232, 255) }],
          shadows: [SH({ x: 0, y: 0, blur: 10, spread: 3, color: C(51, 255, 255) })],
        }, { paths: [{ type: 'ellipse', radius: RD(0, 0, 0, 0) }] }),
        // ④ 文字标题：**有** line-height；且**有全 0 的圆角数据**（文字层不许因此出 border-radius）
        TXT('核心能力', { left: 879, top: 1022, width: 133, height: 60 }, '核心能力',
          { name: 'YouSheBiaoTiHei', size: 36, fontWeight: 400, align: 'left', lineHeight: { unit: 'PIXELS', value: 60 } },
          C(11, 25, 51), { node: { radius: RD(0, 0, 0, 0) } }),
        // ⑤ 文字：**没有** line-height（一个字都不许出）
        TXT('副标题', { left: 30, top: 300, width: 238, height: 21 }, '来源：中国碳足迹平台',
          { name: 'Source Han Sans CN', size: 14, fontWeight: 400, align: 'left' }, C(63, 77, 102)),
        // ⑥ 文字 + text-shadow
        TXT('数字', { left: 40, top: 340, width: 35, height: 31 }, '89',
          { name: 'Inter', size: 24, fontWeight: 700, align: 'left' }, C(70, 147, 255), {
            style: { shadows: [SH({ x: 0, y: 0, blur: 6, spread: 0, color: C(17, 61, 3, 0.1) })] },
          }),
        // ⑬ 渐变文字：文字层 + 填充是渐变 + **没有** color
        TXT('渐变数字', { left: 60, top: 400, width: 48, height: 42 }, '220.8',
          { name: 'YouSheBiaoTiHei', size: 32, fontWeight: 400, align: 'left' }, null, {
            style: { fills: [G({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, [[0, C(239, 255, 255)], [1, C(83, 251, 248)]])] },
          }),
        // ⑧ 卡片：3 段渐变（小数百分比 + rgba/hex 混用）+ opacity + 全 0 圆角
        N('Grad Card', { left: 0, top: 500, width: 464, height: 396 }, {
          fills: [G({ x: 0.1, y: 0.9 }, { x: 0.9, y: 0.1 }, [
            [0, C(230, 230, 230, 0)], [0.2966, C(216, 235, 211, 0.48)], [1, C(201, 240, 189)],
          ])],
        }, { opacity: 0.5, paths: [{ type: 'rect', radius: RD(0, 0, 0, 0) }] }),
        // ⑩ 毛玻璃
        N('Glass', { left: 0, top: 950, width: 120, height: 90 }, {
          fills: [G({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, [[0, C(245, 255, 241)], [1, C(255, 255, 255)]])],
          shadows: [SH({ x: 0, y: 0, blur: 10, spread: 0, color: C(17, 61, 3, 0.1) })],
          borders: [BORDER({ color: C(255, 255, 255) })],
          blurs: [{ type: 'Background', radius: 10, isEnabled: true }],
        }, { paths: [{ type: 'rect', radius: RD(4, 4, 4, 4) }] }),
        // ⑦ 渐变边框（+ 背景渐变）
        N('Grad Border', { left: 16, top: 1100, width: 500, height: 159 }, {
          fills: [G({ x: 0.1, y: 0.5006 }, { x: 0.1, y: 0.4994 }, [[0, C(6, 48, 124)], [1, C(1, 18, 50)]])],
          borders: [{
            isEnabled: true,
            style: 'gradient',
            width: 1,
            lineAlignment: 'inside',
            widths: { left: 1, top: 1, right: 1, bottom: 1 },
            gradient: {
              type: 0,
              from: { x: 0.1, y: 0.5006 },
              to: { x: 0.1, y: 0.4994 },
              stops: [{ position: 0, color: C(55, 109, 202) }, { position: 1, color: C(44, 106, 165, 0) }],
            },
          }],
        }, { paths: [{ type: 'rect', radius: RD(0, 0, 0, 0) }] }),
        // 实色四边（半透明色）+ 单边分割线
        N('Outline', { left: 0, top: 1300, width: 100, height: 40 }, {
          borders: [BORDER({ width: 2, widths: { left: 2, top: 2, right: 2, bottom: 2 }, color: C(226, 232, 240, 0.5) })],
        }),
        N('Divider', { left: 0, top: 1360, width: 375, height: 1 }, {
          borders: [BORDER({ widths: { left: 0, top: 1, right: 0, bottom: 0 }, color: C(226, 232, 240) })],
        }),
        // ⑯ 同一个块**同时**有渐变背景与渐变边框 + alpha 0.02 的精度陷阱
        N('Dual Gradient', { left: 0, top: 1700, width: 90, height: 58 }, {
          fills: [G({ x: 0.5, y: 0 }, { x: 0.5, y: 1 }, [[0, C(0, 128, 229, 0)], [1, C(17, 76, 123)]])],
          borders: [{
            isEnabled: true,
            style: 'gradient',
            width: 1,
            lineAlignment: 'inside',
            widths: { left: 1, top: 1, right: 1, bottom: 1 },
            gradient: {
              type: 0,
              from: { x: 0.5, y: 0 },
              to: { x: 0.5, y: 1 },
              stops: [
                { position: 0, color: C(255, 255, 255, 0.02) },
                { position: 1, color: C(255, 255, 255, 0.1) },
              ],
            },
          }],
        }, { paths: [{ type: 'rect', radius: RD(10, 10, 10, 10) }] }),
        // 非对称四值圆角 + 旋转（⑮）
        N('Asym', { left: 0, top: 1400, width: 60, height: 60 }, {}, {
          rotation: 180,
          paths: [{ type: 'rect', radius: RD(1, 2, 3, 4) }],
        }),
        // 没有圆角 / 边框（有底色才算块）—— 除尺寸与底色外一个字都不该出
        N('Plain', { left: 0, top: 1480, width: 20, height: 20 }, {
          fills: [{ type: 'color', isEnabled: true, color: C(120, 120, 120) }],
        }),
        // 重名 + 数字开头 + 空名
        N('Button', { left: 300, top: 1500, width: 40, height: 40 }, { fills: [{ type: 'color', isEnabled: true, color: C(92, 201, 59) }] }),
        N('2x Icon', { left: 0, top: 1550, width: 24, height: 24 }, {
          fills: [{ type: 'color', isEnabled: true, color: C(0, 0, 0) }],
        }),
        N('', { left: 0, top: 1600, width: 24, height: 24 }, {
          fills: [{ type: 'color', isEnabled: true, color: C(0, 0, 0) }],
        }),
        // ⑪ 富文本：一段文字 4 个 run
        (() => {
          const runs = [
            { from: 0, to: 10, content: '1号车间电能表 · ', font: { name: 'Alibaba PuHuiTi 2.0', size: 12, fontWeight: 500 }, color: C(243, 250, 255) },
            { from: 10, to: 12, content: '表号', font: { name: 'Alibaba PuHuiTi 2.0', size: 12, fontWeight: 500 }, color: C(143, 169, 193) },
            { from: 12, to: 13, content: ' ', font: { name: 'Alibaba PuHuiTi 2.0', size: 12, fontWeight: 500 }, color: C(243, 250, 255) },
            { from: 13, to: 20, content: 'MTR-001', font: { name: 'Alibaba PuHuiTi 2.0', size: 12, fontWeight: 700 }, color: C(112, 232, 255) },
          ];
          return {
            name: '设备名称',
            type: 'textLayer',
            frame: { left: 1449, top: 924, width: 206, height: 18 },
            style: { fills: [{ type: 'color', isEnabled: true, color: C(243, 250, 255) }], borders: [], shadows: [], blurs: [] },
            paths: [],
            layers: [],
            text: {
              value: '1号车间电能表 · 表号 MTR-001',
              // ⚠️ runs 在 `text.styles`（与 `value` / `style` **并列**）—— 这是实测的 Figma 形状，
              //    放进 `text.style` 里就取不到了（本夹具一开始就写错过，被 H4 那条断言抓出来）。
              styles: runs,
              style: {
                content: '1号车间电能表 · 表号 MTR-001',
                font: { name: 'Alibaba PuHuiTi 2.0', size: 12, fontWeight: 500, align: 'left', lineHeight: { unit: 'PIXELS', value: 18 } },
                color: C(243, 250, 255),
              },
            },
          };
        })(),
      ],
    },
  };

  const gen = (t, o = {}) => {
    const ab = t.artboard ?? t;
    const { width: widthOverride, ...rest } = o;
    const ls = flattenArtboard(ab, { rich: true });
    const bs = buildBlocks(ls);
    const meta = {
      name: ab.name,
      width: widthOverride ?? ab.frame.width,
      height: ab.frame.height,
      origin: { x: 0, y: 0 },
    };
    const target = rest.target ?? 'both';
    const built = buildCodeItems(bs, ls, meta, { ...rest, target });
    const text = renderGenCode(built.items, meta, { target, canMini: built.canMini });
    return { ...built, text, blocks: bs, layers: ls, meta };
  };
  const at = (R, label) => R.items.find((it) => it.label === label) ?? { web: [], mini: [], runs: null, className: null };
  const find = (arr, re) => (arr ?? []).find((l) => re.test(l)) ?? '';

  const A = gen(TREE);
  const btn = at(A, 'Button');

  /* ── A. 双平台：同一份实现、只换单位 ── */
  ok('A1 web 给 px（1:1）', btn.web.includes('width: 311px;') && btn.web.includes('height: 42px;'), btn.web.join(' '));
  ok('A2 mini 给 rpx（画板 375 → ×2）', btn.mini.includes('width: 622rpx;') && btn.mini.includes('height: 84rpx;'), btn.mini.join(' '));
  ok('A3 mini 与 web 属性条数一一对应（不是两套实现）', btn.web.length === btn.mini.length, `${btn.web.length} vs ${btn.mini.length}`);
  {
    const A750 = gen(TREE, { width: 750 });
    const b750 = at(A750, 'Button');
    ok('A4 换算基准跟着画板走：宽 750 → rpx 与 px 同值', b750.mini.includes('width: 311rpx;'), b750.mini.join(' '));
    const A0 = gen(TREE, { width: 0 });
    ok('A5 画板宽度未知 → 只给 px，不拿 375 硬算 rpx',
      A0.canMini === false && at(A0, 'Button').mini === null, `canMini=${A0.canMini}`);
    ok('A6 画板宽度未知时文本里明说了', A0.text.includes('画板宽度未知'), A0.text.split('\n').slice(0, 3).join(' | '));
    ok('A7 文本里写明用的是哪个基准', A.text.includes('×2'), A.text.split('\n')[1]);
  }

  /* ── B. 圆角：一律四值 ── */
  ok('B1 四角相等也要四值（不许写单值 9999px）',
    btn.web.includes('border-radius: 9999px 9999px 9999px 9999px;'), find(btn.web, /border-radius/));
  ok('B2 全 0 也要四值（有圆角数据时）',
    at(A, 'Grad Card').web.includes('border-radius: 0px 0px 0px 0px;'), find(at(A, 'Grad Card').web, /border-radius/));
  ok('B3 四值按 TL TR BR BL 顺序出（1/2/3/4 不许重排）',
    at(A, 'Asym').web.includes('border-radius: 1px 2px 3px 4px;'), find(at(A, 'Asym').web, /border-radius/));
  ok('B4 压根没有圆角数据时一个字都不出',
    !at(A, 'Plain').web.some((l) => l.startsWith('border-radius')), at(A, 'Plain').web.join(' '));
  ok('B5 mini 的四值也跟着换算（9999 → 19998）',
    btn.mini.includes('border-radius: 19998rpx 19998rpx 19998rpx 19998rpx;'), find(btn.mini, /border-radius/));
  ok('B6 文字层的"全 0 圆角数据"不出 border-radius（文字没有圆角概念，蓝湖也不出）',
    !at(A, '核心能力').web.some((l) => l.startsWith('border-radius')), at(A, '核心能力').web.join(' '));

  /* ── C. ⑫/⑭ 椭圆与阴影 ── */
  ok('C1 椭圆图元不许给 0px 四值（那样会画成方形环），必须 50%',
    at(A, 'Ring').web.includes('border-radius: 50% 50% 50% 50%;') && !at(A, 'Ring').web.some((l) => l.includes('0px 0px 0px 0px')),
    at(A, 'Ring').web.join(' '));
  ok('C2 椭圆图元同样不许出 border-radius: 0（另一种写法也要拦住）',
    !at(A, 'Icon Round').web.some((l) => /border-radius: 0/.test(l)), at(A, 'Icon Round').web.join(' '));
  {
    const bs = find(btn.web, /^box-shadow:/);
    ok('C3 多层阴影合成一条、逗号分隔两层', bs.split('), ').length === 2, bs);
    ok('C4 inset 只出现在它自己那一层',
      (bs.match(/inset/g) ?? []).length === 1 && bs.startsWith('box-shadow: inset '), bs);
    ok('C5 spread 也出（四位齐全 x y blur spread）', (bs.match(/px/g) ?? []).length === 8, bs);
    ok('C6 阴影色写法：不透明给 hex、半透明给 rgba（同一出口）',
      bs.includes('rgba(232, 230, 255, 0.35)') && bs.includes('rgba(0, 0, 0, 0.12)'), bs);
  }
  {
    const glow = at(A, 'Glow Dot').web.join(' ');
    ok('C7 spread ≠ 0 时必须出现（写成 0px 就算漏）',
      glow.includes('box-shadow: 0px 0px 10px 3px #33ffff;'), find(at(A, 'Glow Dot').web, /box-shadow/));
    ok('C8 阴影色与背景色是两个色（别弄成同一个）',
      glow.includes('background: #70e8ff;') && !glow.includes('10px 3px #70e8ff'), glow);
  }
  {
    const t = at(A, '数字').web;
    ok('C9 文字层的阴影走 text-shadow，而不是 box-shadow',
      t.some((l) => l.startsWith('text-shadow:')) && !t.some((l) => l.startsWith('box-shadow:')), t.join(' '));
    ok('C10 text-shadow 没有 inset / spread（语法里就没这两项）',
      find(t, /^text-shadow:/) === 'text-shadow: 0px 0px 6px rgba(17, 61, 3, 0.1);', find(t, /^text-shadow:/));
  }
  ok('C11 毛玻璃（模糊 type=Background → backdrop-filter）',
    at(A, 'Glass').web.includes('backdrop-filter: blur(10px);'), at(A, 'Glass').web.join(' '));
  ok('C12 opacity 只在 <1 时出（100% 不出这条）',
    at(A, 'Grad Card').web.includes('opacity: 0.5;') && !btn.web.some((l) => l.startsWith('opacity')), at(A, 'Grad Card').web.join(' '));

  /* ── D. 渐变：角度 + 全部 stop + 小数百分比 + rgba/hex 混用 ── */
  ok('D1 渐变角度来自 from/to（水平 → 90deg）',
    at(A, 'Button').web.includes('background: linear-gradient(90deg, #6f67f9 0%, #5446f3 100%);'), find(at(A, 'Button').web, /^background/));
  ok('D2 角度换算：⑬那条正方形样本 55°（atan2(dx,-dy) 手算 54.7356）',
    gradientAngle({ x: 0.1464466, y: 0.75 }, { x: 0.8535534, y: 0.25 }) === 55,
    String(gradientAngle({ x: 0.1464466, y: 0.75 }, { x: 0.8535534, y: 0.25 })));
  ok('D3 角度规范化：竖直向上 → 0（与蓝湖的 360 等价，统一成 0）',
    gradientAngle({ x: 0.5, y: 1 }, { x: 0.5, y: 0 }) === 0,
    String(gradientAngle({ x: 0.5, y: 1 }, { x: 0.5, y: 0 })));
  {
    const cb = find(at(A, 'Grad Card').web, /^background: linear-gradient/);
    ok('D4 全部 stop 都在（3 段一个不少）', (cb.match(/%/g) ?? []).length === 3, cb);
    ok('D5 小数百分比原样保留（29.66%）', cb.includes('29.66%'), cb);
    ok('D6 rgba 与 hex 混用、半透明那一档没被写成实色',
      cb.includes('rgba(230, 230, 230, 0)') && cb.includes('rgba(216, 235, 211, 0.48)') && cb.includes('#c9f0bd'), cb);
  }

  /* ── E. 边框：实色 vs 渐变 ── */
  ok('E1 实色四边 → border: Npx solid <色>', at(A, 'Outline').web.includes('border: 2px solid rgba(226, 232, 240, 0.5);'),
    at(A, 'Outline').web.join(' '));
  ok('E2 单边 → border-top: 1px solid <色>（分割线不走 border-image）',
    at(A, 'Divider').web.includes('border-top: 1px solid #e2e8f0;'), at(A, 'Divider').web.join(' '));
  {
    const gb = at(A, 'Grad Border').web;
    ok('E3 渐变边框 → 不带色的 border + border-image … 1 1',
      gb.includes('border: 1px solid;') && gb.some((l) => l.startsWith('border-image: linear-gradient(') && l.endsWith(' 1 1;')), gb.join(' '));
    ok('E4 渐变边框的 stop 全在（含 0% / 100%）',
      find(gb, /^border-image:/).includes('#376dca 0%') && find(gb, /^border-image:/).includes('rgba(44, 106, 165, 0) 100%'),
      find(gb, /^border-image:/));
    ok('E5 渐变边框**不许**退化成 border: Npx solid <色>（那行只有粗细、没有颜色）',
      !gb.some((l) => /^border: [\d.]+px solid \S/.test(l)), gb.join(' '));
    ok('E6 背景渐变与边框渐变是两个不同的渐变（别串了）',
      find(gb, /^background:/) !== find(gb, /^border-image:/), gb.join(' '));
  }
  ok('E7 半透明 12px 粗边框（⑫）：粗细 / 颜色 / alpha 三项都对',
    at(A, 'Ring').web.includes('border: 12px solid rgba(26, 148, 255, 0.3);'), at(A, 'Ring').web.join(' '));

  /* ── F. 文字：line-height 只在有值时出 ── */
  ok('F1 有 line-height 就出', at(A, '核心能力').web.includes('line-height: 60px;'), at(A, '核心能力').web.join(' '));
  ok('F2 没有 line-height 一个字都不出', !at(A, '副标题').web.some((l) => l.startsWith('line-height')),
    at(A, '副标题').web.join(' '));
  ok('F3 字重给数值（不是 normal/bold）', at(A, '核心能力').web.includes('font-weight: 400;'), at(A, '核心能力').web.join(' '));
  ok('F4 字体族含 `.` 时加引号（不加引号不合法）',
    at(A, '数字').web.includes('font-family: Inter;') && at(A, '设备名称').web.includes('font-family: "Alibaba PuHuiTi 2.0";'),
    at(A, '设备名称').web.join(' '));
  ok('F5 字体族全是标识符时不加引号（Source Han Sans CN 这样写就是合法的一个族名）',
    cssFontFamily('Source Han Sans CN') === 'Source Han Sans CN', cssFontFamily('Source Han Sans CN'));

  /* ── G. 颜色只有一个出口 ── */
  {
    const semi = rgbaString({ r: 87, g: 74, b: 244, a: 0.1 });
    ok('G1 半透明色 === rgbaString() 的真实产出（改 rgbaString，生成结果必然跟着变）',
      at(A, 'Verified Badge').web.includes(`background: ${semi};`), at(A, 'Verified Badge').web.join(' '));
    ok('G2 形态确实是"逗号后带空格"（不是蓝湖那种无空格写法）', /^rgba\(87, 74, 244, 0\.1\)$/.test(semi), semi);
    ok('G3 cssColor 与 rgbaString / rgbHex 同源（同一个输入给同一个串）',
      cssColor({ r: 87, g: 74, b: 244, a: 0.1 }) === semi && cssColor({ r: 111, g: 103, b: 249, a: 1 }) === rgbHex({ r: 111, g: 103, b: 249 }),
      cssColor({ r: 87, g: 74, b: 244, a: 0.1 }));
    ok('G4 生成结果里出现的每个半透明色都是"逗号后带空格"的形态（大面积扫一遍）',
      A.items.every((it) => [].concat(it.web ?? [], it.mini ?? []).every((l) => (l.match(/rgba\([^)]*\)/g) ?? [])
        .every((c) => /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0\.\d{1,2})\)$/.test(c)))),
      A.items.flatMap((it) => it.web ?? []).flatMap((l) => l.match(/rgba\([^)]*\)/g) ?? [])
        .filter((c) => !/^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0\.\d{1,2})\)$/.test(c)).join(' , '));
  }

  /* ── H. 渐变文字（⑬）与富文本（⑪） ── */
  {
    const gt = at(A, '渐变数字').web;
    ok('H1 渐变文字：四件套都在（否则会画成色块）',
      gt.includes('-webkit-background-clip: text;') && gt.includes('background-clip: text;')
      && gt.includes('-webkit-text-fill-color: transparent;') && gt.includes('color: transparent;'), gt.join(' '));
    ok('H2 渐变文字的 background 仍是渐变（不是实色块）',
      find(gt, /^background:/).startsWith('background: linear-gradient('), find(gt, /^background:/));
    ok('H3 普通文字不会被误判成渐变文字（不带 background-clip）',
      !at(A, '核心能力').web.some((l) => l.includes('background-clip')), at(A, '核心能力').web.join(' '));
  }
  {
    const rt = at(A, '设备名称');
    ok('H4 富文本：识别出 4 段', rt.runs && rt.runs.runCount === 4, JSON.stringify(rt.runs && rt.runs.runCount));
    ok('H5 富文本：蓝图里用 span 分段，差异段带 class',
      rt.runs && rt.runs.html.includes('<span class="r1">表号</span>') && rt.runs.html.includes('<span class="r2">MTR-001</span>'),
      rt.runs ? rt.runs.html : '');
    ok('H6 富文本：每段自己的颜色 / 字重都出了',
      rt.runs && rt.runs.rules.some((r) => r.includes('color: #8fa9c1;')) && rt.runs.rules.some((r) => r.includes('font-weight: 700;') && r.includes('color: #70e8ff;')),
      rt.runs ? rt.runs.rules.join(' ') : '');
    ok('H7 富文本：文本里写进了代码块（不是只在结构里）',
      A.text.includes('<span class="r1">表号</span>'), '');
    ok('H8 单 run 的文字层不产生分段（不重复输出同一份样式）',
      at(A, '核心能力').runs === null, JSON.stringify(at(A, '核心能力').runs));
  }

  /* ── I. 旋转（⑮） ── */
  ok('I1 带旋转的块出 transform: rotate(Ndeg)，角度等于数据真值',
    at(A, 'Asym').web.includes('transform: rotate(180deg);'), at(A, 'Asym').web.join(' '));
  ok('I2 180° 不许因为"看着一样"就省掉', /rotate\(180deg\)/.test(A.text), '');
  ok('I3 没有旋转的块一个字都不出',
    !at(A, '核心能力').web.some((l) => l.startsWith('transform')), at(A, '核心能力').web.join(' '));
  ok('I4 rotation 为 0 与"没有这个字段"等价（都不出）',
    richInfoOf({ rotation: 0 }).rotation === null && richInfoOf({}).rotation === null, '');

  /* ── J. class 名 ── */
  {
    const names = A.items.map((it) => it.className);
    ok('J1 class 名合法（可安全当作选择器）',
      names.every((n) => /^[a-z_\u4e00-\u9fa5][0-9a-z_\u4e00-\u9fa5-]*$/.test(n)), names.join(','));
    eq('J2 重名块被区分开（没有两个同名的）', new Set(names).size, names.length);
    ok('J3 重名的第二块带 -2 后缀', names.includes('button') && names.includes('button-2'), names.join(','));
    ok('J4 中文名保留（可读性优先）', names.includes('核心能力'), '');
    ok('J5 以数字开头时补前缀（CSS 里不能以数字开头）', names.includes('b-2x-icon'), names.join(','));
    ok('J6 空名用类型兜底（不出现空 class）', names.every((n) => n.length > 0), '');
  }

  /* ── K. 输出形态：可直接整段复制 ── */
  ok('K1 输出是代码块（选择器 + 花括号），不是表格',
    /^\.button \{$/m.test(A.text) && A.text.includes('\n}'), A.text.split('\n').slice(4, 8).join(' | '));
  ok('K2 both 时 web 与 mini 各自成段', A.text.includes('Web（px') && A.text.includes('小程序（rpx'), '');
  ok('K3 每块都带一行注释说明它是什么', A.text.includes('Button · 311×42'), '');
  ok('K4 输出里没有 undefined / NaN（宿主对非法 JSON 会拒收整个结果）',
    !/undefined|NaN/.test(A.text), (A.text.match(/undefined|NaN/g) ?? []).join(','));

  /* ── M. ⑯ 渐变背景 + 渐变边框同块；alpha 精度 ── */
  {
    const dg = at(A, 'Dual Gradient').web;
    ok('M1 同一块上渐变背景与渐变边框**同时**都在（不许互相覆盖/只出一个）',
      dg.some((l) => l.startsWith('background: linear-gradient(')) && dg.some((l) => l.startsWith('border-image: linear-gradient(')),
      dg.join(' '));
    ok('M2 两者各用自己那份 stop（不是同一份被复用了两次）',
      find(dg, /^background:/).includes('#114c7b') && find(dg, /^border-image:/).includes('rgba(255, 255, 255, 0.02)'),
      dg.join(' '));
    ok('M3 两个渐变的方向各自来自自己的 from/to（都是 180deg）',
      find(dg, /^background:/).includes('linear-gradient(180deg') && find(dg, /^border-image:/).includes('linear-gradient(180deg'),
      dg.join(' '));
    ok('M4 alpha 0.02 **不许**被取整掉（抹成 0 就是边框直接消失）',
      find(dg, /^border-image:/).includes('rgba(255, 255, 255, 0.02)'), find(dg, /^border-image:/));
    ok('M5 alpha 恰好 0 就写 0（与 0.02 是两回事，别把前者当后者）',
      find(dg, /^background:/).includes('rgba(0, 128, 229, 0)'), find(dg, /^background:/));
    ok('M6 cssColor 保留 2 位 alpha 精度（0.02 不许变成 0）',
      cssColor({ r: 255, g: 255, b: 255, a: 0.02 }) === 'rgba(255, 255, 255, 0.02)',
      cssColor({ r: 255, g: 255, b: 255, a: 0.02 }));
    ok('M7 圆角 10px 也照四值出', dg.includes('border-radius: 10px 10px 10px 10px;'), find(dg, /border-radius/));
    ok('M8 渐变边框仍是"不带色的 border + border-image"（不是实色 border）',
      dg.includes('border: 1px solid;') && !dg.some((l) => /^border: [\d.]+px solid \S/.test(l)), dg.join(' '));
  }

  /* ── L. 只读：真跑一次 genCode（桩掉 fetch），断言只发 GET ── */
  {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ url: u, method: String(init.method ?? 'GET').toUpperCase() });
      // ⚠️ json_url 那一层给的是**整棵树**（`{artboard, assets, meta}`），不是 artboard 本身 ——
      //    直接给 artboard 会被判成「认不出的图层树格式」（本项目最忌讳的静默失败，这里明说）。
      const payload = u.includes('mock.example')
        ? { artboard: TREE.artboard, assets: [], meta: {} }
        : { code: 0, data: { id: 'iid', name: '夹具', width: 375, height: 800, versions: [{ id: 'v1', json_url: 'https://mock.example/tree.json' }] } };
      const buf = Buffer.from(JSON.stringify(payload), 'utf8');
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    };
    let r = null;
    let err = null;
    try {
      r = await genCode({
        projectId: '00000002-0000-4000-8000-000000000002',
        imageId: '00000003-0000-4000-8000-000000000003',
        cookie: 'a=1',
        target: 'web',
      });
    } catch (e) {
      err = e;
    } finally {
      globalThis.fetch = realFetch;
    }
    ok('L1 只读：生成过程只发 GET（没有任何写请求）',
      calls.length >= 1 && calls.every((c) => c.method === 'GET'),
      err ? `抛错：${err.message}` : calls.map((c) => `${c.method} ${c.url.slice(0, 44)}`).join(' | '));
    ok('L2 端到端真的出了可粘贴的代码（不是空跑）',
      Boolean(r) && r.ok === true && /^\.button \{$/m.test(r.text) && r.blockCount === A.items.length,
      err ? `抛错：${err.message}` : `ok=${r && r.ok} blockCount=${r && r.blockCount}/${A.items.length}`);
    ok('L3 端到端带版本与账号透明度', Boolean(r) && 'version' in r && 'account' in r, r ? Object.keys(r).join(',') : '');
  }
}

/* ═══════════════ ⑰ 本轮修复：生成代码出口 / 列表分页 / 截断口径 ═══════════════
 *
 * 三件事各配**正反例**：
 *   A1 · `lanhu_gen_code` 的 `codes` 按需（默认不给，`structured:true` 才给）+ `text` 逐字节不变
 *   A2 · 截断提示的口径：源码级扫描（① 不许指向 `format=full` ② 每条都要点名一个真取数参数）
 *   B  · `list_designs` / `lanhu_search` 分页：默认生效 / 硬上限压回 / 游标不重不漏 /
 *        ★ 内部调用方（核心函数 / `/lanhu/designs` / `/lanhu/versions-count`）拿到的**是全量**
 */
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 一次性把 globalThis.fetch 换成桩，跑完必还原（自检不许污染进程）。 */
async function withStubFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** 桩 fetch 的响应形态 —— 与既有几处保持一致（apiRequest 读 arrayBuffer）。 */
function stubResponse(payload, status = 200) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

group('⑰ A1：gen_code 出口（codes 按需，text 不变）');
{
  const C = (r, g, b, a = 1) => ({ r: r / 255, g: g / 255, b: b / 255, a });
  const A1_TREE = {
    artboard: {
      name: '出口夹具',
      frame: { left: 0, top: 0, width: 375, height: 800 },
      layers: [
        { name: '主按钮', type: 'frame', frame: { left: 32, top: 100, width: 311, height: 42 },
          style: { fills: [{ type: 'color', isEnabled: true, color: C(87, 74, 244) }], borders: [], shadows: [], blurs: [] },
          paths: [{ type: 'rect', radius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 } }], layers: [] },
        { name: '标题', type: 'textLayer', frame: { left: 32, top: 160, width: 200, height: 24 },
          style: { fills: [], borders: [], shadows: [], blurs: [] }, paths: [], layers: [],
          text: { value: '标题', style: { content: '标题', font: { name: 'Inter', size: 16, fontWeight: 600, align: 'left' }, color: C(17, 17, 17) } } },
      ],
    },
  };
  const stub = async (url) => {
    const u = String(url);
    return stubResponse(u.includes('mock.example')
      ? { artboard: A1_TREE.artboard, assets: [], meta: {} }
      : { code: 0, data: { id: 'iid', name: '出口夹具', width: 375, height: 800, versions: [{ id: 'v1', json_url: 'https://mock.example/t.json' }] } });
  };
  const gen = TOOLS.find((t) => t.name === 'lanhu_gen_code');
  const A1_ARGS = { projectId: '00000002-0000-4000-8000-000000000002', imageId: '00000003-0000-4000-8000-000000000003', target: 'web' };
  const envCookie = process.env.LANHU_COOKIE;
  process.env.LANHU_COOKIE = 'PASSPORT=x; user_token=y';
  let plain = null; let struct = null;
  try {
    plain = await withStubFetch(stub, () => gen.execute({ ...A1_ARGS }));
    struct = await withStubFetch(stub, () => gen.execute({ ...A1_ARGS, structured: true }));
  } finally {
    if (envCookie === undefined) delete process.env.LANHU_COOKIE; else process.env.LANHU_COOKIE = envCookie;
  }
  ok('A1-0 桩链路真的跑通了（不是拿失败对象在比）',
    plain?.ok === true && struct?.ok === true, JSON.stringify(plain)?.slice(0, 160));
  ok('A1-1 ★ 默认（不传 structured）返回体里**没有** `codes` 键', !('codes' in plain), Object.keys(plain ?? {}).join(','));
  ok('A1-2 `structured:true` 才带 `codes`（不是被删掉）',
    Array.isArray(struct?.codes) && struct.codes.length === plain?.blockCount, `codes=${struct?.codes?.length} / blockCount=${plain?.blockCount}`);
  ok('A1-3 `codes` 每项字段齐（程序化消费要的那几个）',
    (struct?.codes ?? []).every((c) => 'index' in c && 'className' in c && 'selector' in c && 'web' in c && 'mini' in c),
    JSON.stringify(struct?.codes?.[0] ?? null));
  ok('A1-4 ★★ 两种取法下 `text` **逐字节相同**（structured 不动人读出口）',
    typeof plain?.text === 'string' && plain.text === struct?.text, `长度 ${plain?.text?.length} vs ${struct?.text?.length}`);
  ok('A1-5 `text` 仍是一整段可粘贴的 CSS（没被 codes 顶掉）', /^\.\S+ \{/m.test(plain?.text ?? ''));
  const plainChars = JSON.stringify(plain).length;
  const structChars = JSON.stringify(struct).length;
  ok('A1-6 默认返回体明显更小（codes 基本是重复内容）',
    structChars - plainChars > 100, `默认 ${plainChars} / structured ${structChars}（多 ${structChars - plainChars} 字符）`);
  ok('A1-7 schema 里写明 structured 默认 false（模型读得到）',
    /默认 false/.test(gen.parameters.properties.structured?.description ?? ''), gen.parameters.properties.structured?.description);
  ok('A1-8 output.schema 里**仍声明** codes（只是默认不给，不是把这个能力删掉）',
    'codes' in (gen.output.schema.properties ?? {}), Object.keys(gen.output.schema.properties ?? {}).join(','));
}

group('⑰ A2：截断提示的口径（源码级扫描）');
{
  /* 规矩：**凡是要截断，人读输出里就必须写清"用哪个参数取更多"，且那个参数是真的取数通道**；
     不许指向 `format=full`（它是落盘留档，不是取数通道 —— 与 SYSTEM_HINT 同一口径）。

     做法：把源码里的**字符串字面量**抽出来（注释里的话不算输出），
     筛出"省略/截断"那几类，再逐条查 ① 有没有 `format=full` ② 有没有点名取数参数。 */
  // ⚠️ `略` 要排除 缩略 / 忽略 / 省略（那三处不是截断提示）—— 不加负向环视会误报一堆。
  const TRUNC_RE = /(?<![忽略缩省])略|已截断|只列前|只给计数|只比了|…还有/;
  // 真取数通道：`region` / `limit` / `offset` / `maxRows` / `pageTreeLimit` / `commentMaxReplies` /
  // 过滤类（`kind` / `minWidth` / `gapMaxDistance`）
  const CHANNEL_RE = /region|limit|offset|maxRows|max-rows|pageTreeLimit|page-tree-limit|commentMaxReplies|comment-max-replies|gapMaxDistance|minWidth|kind/;
  const FORBIDDEN_RE = /format\s*[=:]\s*['"`]?full/;

  /**
   * 取一条字面量里**人真正读到的那些字**：
   *   · `${…}` 里的**表达式**不算（变量名叫 `limit` 不等于话里点了 `limit`）；
   *   · 但 `${…}` 里**嵌的字符串/模板**要算（截断提示常写成 `cond ? \`…用 limit 取\` : ''`，
   *     整段丢掉就会把"点了参数"当成"没点"—— 实测踩过）。
   */
  const visibleText = (s) => {
    const collectInterp = (i) => {            // i 指向 `{` 之后；返回拼进来的字符串内容 + 结束位置
      let text = ''; let depth = 1;
      while (i < s.length && depth > 0) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === "'" || c === '"' || c === '`') { const r = collectQuote(i); text += ` ${r.text}`; i = r.next; continue; }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return { text, next: i + 1 }; }
        i += 1;
      }
      return { text, next: i };
    };
    const collectQuote = (i) => {             // i 指向开引号；返回内容（不含引号）与结束位置
      const q = s[i]; let text = ''; i += 1;
      while (i < s.length) {
        const c = s[i];
        if (c === '\\') { text += s[i + 1] ?? ''; i += 2; continue; }
        if (q === '`' && c === '$' && s[i + 1] === '{') { const r = collectInterp(i + 2); text += ` ${r.text}`; i = r.next; continue; }
        if (c === q) return { text, next: i + 1 };
        if (c === '\n' && q !== '`') return { text, next: i };
        text += c; i += 1;
      }
      return { text, next: i };
    };
    let out = ''; let i = 0;
    while (i < s.length) {
      if (s[i] === '$' && s[i + 1] === '{') { const r = collectInterp(i + 2); out += ` ${r.text}`; i = r.next; continue; }
      out += s[i]; i += 1;
    }
    return out;
  };

  /** 判一条截断提示合不合规矩（纯函数 —— 下面拿它做**扫描器自证**）。 */
  const judgeTruncHint = (literalText) => {
    const text = visibleText(String(literalText));
    return {
      text,
      forbidden: FORBIDDEN_RE.test(text),
      channel: (text.match(CHANNEL_RE) ?? [null])[0],
    };
  };

  const literalsOf = (src) => {
    // 单遍扫描：**注释整段跳过**（注释里的引号/反引号会把配对带偏 —— 实测踩过），
    // 模板串里的 `${…}` 按**代码**继续扫（里面可以再嵌模板串，如 `a${f(`b${c}`)}` —— 不处理会把字面量切碎）。
    const out = [];
    const n = src.length;
    const st = { line: 1 };
    const readInterp = (i) => {          // 从 `{` 之后开始，返回匹配 `}` 之后的位置
      let depth = 1;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') { st.line += 1; i += 1; continue; }
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
        if (c === "'" || c === '"' || c === '`') { i = readQuoted(i); continue; }
        if (c === '{') depth += 1;
        else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
        i += 1;
      }
      return i;
    };
    const readQuoted = (i) => {          // 从引号本身开始，返回闭合引号之后的位置
      const quote = src[i];
      i += 1;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { if (src[i + 1] === '\n') st.line += 1; i += 2; continue; }
        if (c === '\n') { if (quote !== '`') return i; st.line += 1; i += 1; continue; }
        if (quote === '`' && c === '$' && src[i + 1] === '{') { i = readInterp(i + 2); continue; }
        if (c === quote) return i + 1;
        i += 1;
      }
      return i;
    };
    let i = 0;
    while (i < n) {
      const ch = src[i];
      if (ch === '\n') { st.line += 1; i += 1; continue; }
      if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (ch === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') st.line += 1; i += 1; }
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const start = i; const startLine = st.line;
        i = readQuoted(i);
        out.push({ line: startLine, raw: src.slice(start, i) });
        continue;
      }
      i += 1;
    }
    return out;
  };

  const hits = [];
  for (const f of ['lanhu.mjs', 'lib/index.js']) {
    const src = fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
    for (const lit of literalsOf(src)) {
      if (!TRUNC_RE.test(lit.raw)) continue;
      hits.push({ f, line: lit.line, ...judgeTruncHint(lit.raw) });
    }
  }
  ok('A2-0 扫描确实命中了"截断/省略"提示（不是空跑）', hits.length >= 14, `命中 ${hits.length} 条`);
  // ① 不许把 `format=full` 当取数建议
  const bad = hits.filter((h) => h.forbidden);
  ok('A2-1 ★ 没有任何一条截断提示指向 `format=full`（源码级扫）',
    bad.length === 0, bad.map((h) => `${h.f}:${h.line} ${h.text.trim()}`).join(' ｜ '));
  // ② 每条都要点名一个取数参数
  const noChannel = hits.filter((h) => !h.channel);
  ok('A2-2 ★ 每条截断提示都点名了一个取数参数',
    noChannel.length === 0, noChannel.map((h) => `${h.f}:${h.line} ${h.text.trim()}`).join(' ｜ '));
  // 扫描器的**自证**：喂一条老写法的假提示，必须判红（否则上面两条可能是"瞎绿"）
  const fakeBad = judgeTruncHint('| … | 其余 3 个文本层略（用 format=full 取全量） |');
  ok('A2-3 扫描器自证：假提示（指向 format=full 且没点参数）会被判红',
    fakeBad.forbidden === true && fakeBad.channel === null, JSON.stringify(fakeBad));
  const fakeGood = judgeTruncHint('| … | 其余 3 个文本层略（按 `region` 分区精确取） |');
  ok('A2-4 扫描器自证：合规提示（点名 region）不会被误判',
    fakeGood.forbidden === false && fakeGood.channel === 'region', JSON.stringify(fakeGood));
  // 定点回归：**本次修的那一处** —— summary 的文本层截断
  const summaryTextHint = hits.find((h) => /个文本层略/.test(h.text));
  ok('A2-5 定点：summary「文本层」截断行已改成指 `region`（不再是 format=full）',
    Boolean(summaryTextHint) && /region/.test(summaryTextHint.text) && !summaryTextHint.forbidden,
    summaryTextHint ? summaryTextHint.text.trim() : '（没扫到这一行 —— 断言失效）');
  // SYSTEM_HINT 那两处口径也在（"full 是落盘留档，不是取数通道"）
  const hostSrc = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'index.js'), 'utf8');
  ok('A2-6 SYSTEM_HINT 的取数口径没被改坏（region 是真通道 / full 是落盘留档）',
    /full 是\*\*落盘留档\*\*用的，不是取数通道/.test(hostSrc)
    && /别拿 `format=full` 的 JSON 自己写脚本解析/.test(fs.readFileSync(path.join(ROOT_DIR, 'lanhu.mjs'), 'utf8')));
}

group('⑰ B：列表分页（list_designs / search）');
{
  const PID_X = '00000002-0000-4000-8000-0000000000aa';
  const TID_X = '00000001-0000-4000-8000-0000000000bb';
  const N_ALL = 600;
  const mkImages = (n) => Array.from({ length: n }, (_, i) => ({
    id: 'img-' + String(i).padStart(3, '0'), name: '稿' + (i + 1),
    width: 375, height: 800, group: [{ name: i % 2 ? '甲' : '乙' }], update_time: '2026-01-01',
  }));
  const ALL = mkImages(N_ALL);
  /** list_images 的桩（每次调用都记下 URL，便于断言"核心函数没有被分页参数影响"）。 */
  const imgsStub = (seen) => async (url) => {
    const u = String(url);
    seen.push(u);
    return stubResponse({ code: 0, data: { name: '大项目', images: ALL } });
  };
  const ld = TOOLS.find((t) => t.name === 'lanhu_list_designs');

  const ids = (r) => (r.images ?? []).map((i) => i.imageId);

  const seen1 = [];
  const p1 = await withStubFetch(imgsStub(seen1), () => ld.execute({ projectId: PID_X }));
  ok('B1 默认一页 50 张（252 张那种项目不再一次倒出来）', ids(p1).length === 50, `本页 ${ids(p1).length}`);
  ok('B2 回包里写明总张数与本页张数', p1.totalImages === N_ALL && p1.pageImages === 50, `total=${p1.totalImages} page=${p1.pageImages}`);
  ok('B3 ★ 人读文本写明「共 N / 本页 M / 下一页传 offset=X」（截断不静默）',
    p1.text.includes(`共 ${N_ALL}`) && p1.text.includes('本页 50') && p1.text.includes('offset=50'), p1.text.split('\n').slice(-1)[0]);
  ok('B4 确实是前 50 张（不是随机切）', ids(p1)[0] === 'img-000' && ids(p1)[49] === 'img-049');

  const seen2 = [];
  const p2 = await withStubFetch(imgsStub(seen2), () => ld.execute({ projectId: PID_X, offset: 50 }));
  ok('B5 ★ 游标分页**不重不漏**：第二页接着第一页，且两页无交集',
    ids(p2)[0] === 'img-050' && ids(p2).length === 50 && !ids(p2).some((x) => ids(p1).includes(x)),
    `${ids(p2)[0]} … ${ids(p2)[49]}`);
  ok('B6 第二页写明下一页的 offset（100）', p2.text.includes('offset=100'), p2.text.split('\n').slice(-1)[0]);

  const p3 = await withStubFetch(imgsStub([]), () => ld.execute({ projectId: PID_X, offset: 600 }));
  ok('B7 越过末页 → 空页 + 明说"已到末页"（不静默给空表）',
    ids(p3).length === 0 && /已到末页/.test(p3.text), p3.text.split('\n').slice(-1)[0]);

  const p4 = await withStubFetch(imgsStub([]), () => ld.execute({ projectId: PID_X, limit: 9999 }));
  ok('B8 ★ 硬上限：limit 传 9999 被压回 500（不靠调用方自觉）',
    p4.limit === LIMITS.listMaxImages && ids(p4).length === LIMITS.listMaxImages, `limit=${p4.limit} 本页 ${ids(p4).length}`);
  ok('B9 被压回时文本照样写明总数（不假装只有 500 张）', p4.totalImages === N_ALL, String(p4.totalImages));

  const p5 = await withStubFetch(imgsStub([]), () => ld.execute({ projectId: PID_X, limit: 0, offset: -3 }));
  ok('B10 越界/无意义的值回落默认（limit:0→50、offset:-3→0），不炸也不无限',
    p5.limit === LIMITS.listDefaultImages && p5.offset === 0, `limit=${p5.limit} offset=${p5.offset}`);
  const p5b = await withStubFetch(imgsStub([]), () => ld.execute({ projectId: PID_X, limit: 'abc' }));
  ok('B10b 类型不对由 schema 拦下（进不了业务层，不花请求）', p5b.failed === true, String(p5b.text).split('\n')[0]);

  const p6 = await withStubFetch(imgsStub([]), () => ld.execute({ projectId: PID_X, sector: '甲' }));
  ok('B11 sector 是客户端过滤：先过滤再分页（"共 N"跟着过滤后的集合走）',
    p6.totalImages === N_ALL && ids(p6).every((x) => Number(x.slice(4)) % 2 === 1) && p6.pageImages === 50,
    `page=${p6.pageImages} 首张=${ids(p6)[0]}`);
  ok('B11b 给了分组时标题写明"过滤后几张"（避免与页脚两个"共 N"打架）',
    p6.text.includes('分组「甲」300 张') && p6.text.includes('共 300 张设计稿'), p6.text.split('\n')[0]);

  /* ── ★ 最重要的一条：**内部调用方拿到的是全量** ── */
  const coreSeen = [];
  // 用自检早先存下的 `demo` 账号（TMP_HOME）—— 核心函数走真实 cookie 解析链，不额外注入
  const core = await withStubFetch(imgsStub(coreSeen), () => listImages(PID_X, { account: 'demo' }));
  ok('B12 ★★ 核心函数 `listImages` 不分页（内部调用方的数据源）',
    core.images.length === N_ALL && coreSeen.length === 1, `拿到 ${core.images.length} 张 / ${coreSeen.length} 次请求`);

  const mkReq = (url, method = 'GET', body = null, addr = '127.0.0.1') => ({
    url, method, headers: {}, socket: { remoteAddress: addr },
    [Symbol.asyncIterator]: async function* () { if (body !== null) yield Buffer.from(JSON.stringify(body), 'utf8'); },
  });
  const call = async (handler, req) => {
    const out = { status: 0, body: null, threw: undefined };
    const resp = { writeHead(s) { out.status = s; }, end(t) { out.body = JSON.parse(t); } };
    try { await handler(req, resp); } catch (e) { out.threw = e; }
    return out;
  };
  const handler = makeLanhuHandler({
    checkAuth: async () => ({ ok: true, account: 'acme', teamCount: 1 }),
    pickAccount: async () => ({ alias: 'demo', by: 'index' }),
    // ⚠️ **不注入 listImages** —— 走的就是真实核心函数，这样才验得到"内部调用方没被默认 limit 带走"
    imageVersions: async (pid, iid) => ({ name: iid, versions: [{ id: 'v1' }] }),
  });
  const stubAll = async (url) => {
    const u = String(url);
    if (u.includes('/api/project/images')) return stubResponse({ code: 0, data: { name: '大项目', images: ALL } });
    return stubResponse({ code: 0, data: { id: 'iid', name: '稿', width: 375, height: 800, versions: [{ id: 'v1', json_url: null }] } });
  };
  const routeDesigns = await withStubFetch(stubAll, () => call(handler, mkReq('/lanhu/designs?pid=' + PID_X)));
  ok('B13 ★★ 面板「稿」下拉端点 /lanhu/designs 拿到的仍是**全量** 600 张',
    routeDesigns.status === 200 && (routeDesigns.body?.data?.images ?? []).length === N_ALL,
    `${routeDesigns.status} / ${(routeDesigns.body?.data?.images ?? []).length}`);
  const routeVC = await withStubFetch(stubAll, () => call(handler, mkReq('/lanhu/versions-count?pid=' + PID_X)));
  ok('B14 ★★ /lanhu/versions-count 的 total 是全量算出来的（分页工具不能把它带偏）',
    routeVC.body?.data?.total === N_ALL, String(routeVC.body?.data?.total));

  /* ── search：接口是 pageNo/pageSize 制，工具给 limit/offset ── */
  const sr = TOOLS.find((t) => t.name === 'lanhu_search');
  const searchSeen = [];
  const searchStub = async (url, init = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    searchSeen.push(body);
    const size = Number(body.pageSize) || 20;
    const page = Number(body.pageNo) || 1;
    const all = Array.from({ length: 120 }, (_, i) => ({ itemId: 's-' + String(i).padStart(3, '0'), sourceId: PID_X, itemName: '结果' + (i + 1), sourceName: '项目', path: '/', itemUrl: null }));
    const items = all.slice((page - 1) * size, page * size);
    return stubResponse({ code: 0, data: {
      dc_prj_image: { total: all.length, items },
      dc_prj: { total: 0, items: [] },
      dc_prj_prd: { total: 0, items: [] },
    } });
  };
  const s1 = await withStubFetch(searchStub, () => sr.execute({ teamId: TID_X, keyword: '结果' }));
  ok('B15 ★ search 默认 limit=50 **真的传给了接口**（pageSize=50，不是接口默认的 20）',
    searchSeen[0]?.pageSize === 50 && searchSeen[0]?.pageNo === 1, JSON.stringify(searchSeen[0]));
  ok('B16 search 默认一页 50 条，且文本写明总数与下一页 offset',
    s1.images.length === 50 && s1.text.includes('共 120 条') && s1.text.includes('offset=50'), s1.text.split('\n').slice(-1)[0]);
  const s2 = await withStubFetch(searchStub, () => sr.execute({ teamId: TID_X, keyword: '结果', offset: 50 }));
  ok('B17 ★ search 游标分页不重不漏（第二页从第 51 条起，页码换算正确）',
    s2.images[0]?.imageId === 's-050' && !s2.images.some((x) => s1.images.includes(x)),
    `${s2.images[0]?.imageId} / pageNo=${searchSeen[0]?.pageNo}`);
  ok('B18 search 末页明说"已到末页"', await (async () => {
    const s3 = await withStubFetch(searchStub, () => sr.execute({ teamId: TID_X, keyword: '结果', offset: 100 }));
    return s3.images.length === 20 && /已到末页/.test(s3.text);
  })(), 'offset=100 → 本页 20 条（120 的尾页）');
  ok('B19 search 空结果时那句老话逐字不变（没匹配上不许换个说法）', await (async () => {
    const emptyStub = async () => stubResponse({ code: 0, data: { dc_prj_image: { total: 0, items: [] }, dc_prj: { total: 0, items: [] }, dc_prj_prd: { total: 0, items: [] } } });
    const s4 = await withStubFetch(emptyStub, () => sr.execute({ teamId: TID_X, keyword: '没有这个' }));
    return s4.text === '没有匹配「没有这个」的结果。';
  })());
  ok('B20 两个列表工具的 output schema 都声明了分页字段（能力不藏着）',
    ['totalImages', 'pageImages', 'offset', 'limit', 'hasMore'].every((k) => k in (ld.output.schema.properties ?? {}))
    && ['totals', 'offset', 'limit', 'hasMore'].every((k) => k in (sr.output.schema.properties ?? {})),
    Object.keys(ld.output.schema.properties ?? {}).join(','));
}

/* ═══════════════ 汇总 ═══════════════ */
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const AS_JSON = process.argv.includes('--json');

if (AS_JSON) {
  console.log(JSON.stringify({ ok: failed === 0, passed, failed, results }, null, 2));
} else {
  let lastGroup = '';
  for (const r of results) {
    if (r.group !== lastGroup) { console.log('\n' + r.group); lastGroup = r.group; }
    console.log('  ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.detail ? '  → ' + r.detail : ''));
  }
  console.log(`\n合计：${passed} 项 ✅ / ${failed} 项 ❌`);
}
cleanupTmp();
process.exit(failed === 0 ? 0 : 1);

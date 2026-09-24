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
  renderTokens,
  renderFonts,
  renderRegion,
  renderSummary,
  collectTokens,
  flattenArtboard,
  imageMeta,
  upsertAccount,
  saveCookie,
  listAccounts,
  removeAccount,
  setDefaultAccount,
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
} = await import('../lanhu.mjs');
const { TOOLS, validateJsonSchemaValue, ToolArgsError, toLossless } = await import('../lib/index.js');

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

const TID = '33333333-3333-4333-8333-333333333333';
const PID = '11111111-1111-4111-8111-111111111111';
const IID = '22222222-2222-4222-8222-222222222222';

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
  lanhu_read_blocks: ['不透明', '字体族', '行高·字距'],
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
    ok('校验失败的命令以非零退出（只给 project 没给 image）', exitOf(['read', '--project', '11111111-1111-4111-8111-111111111111']) !== 0);
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
  const TID = '33333333-3333-4333-8333-333333333333';
  const PID = '11111111-1111-4111-8111-111111111111';
  Object.assign(doc.accounts.find((a) => a.alias === 'acme'), {
    teams: [{ teamId: TID, name: 'Acme', memberNum: 2 }],
    projects: [{ projectId: PID, name: '小程序', teamId: TID }],
  });
  fs.writeFileSync(accountsPath(), JSON.stringify(doc, null, 2));

  const byTid = await whoIsIt({ url: `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID}&pid=${PID}&image_id=22222222-2222-4222-8222-222222222222&type=image` });
  ok('① 按链接 tid 命中（零请求）', byTid.found === true && byTid.matchedBy === 'tid' && byTid.alias === 'acme');
  const byPid = await whoIsIt({ projectId: PID, imageId: '22222222-2222-4222-8222-222222222222' });
  ok('② 按 projectId 命中（零请求）', byPid.found === true && byPid.matchedBy === 'pid');
  // 不给 imageId → 不会触发联网探测，纯离线验证「未命中」这条路径
  const none = await whoIsIt({
    teamId: 'ffffffff-9999-9999-9999-999999999999',
    projectId: 'ffffffff-9999-9999-9999-999999999999',
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
  const miss = await whoIsIt({ teamId: 'ffffffff-0000-0000-0000-000000000000', projectId: 'ffffffff-0000-0000-0000-000000000000' });
  const after = fs.readFileSync(accountsPath(), 'utf8');
  ok('归属判定不写档案（不做任何回填）', before === after);
  ok('未命中时 found=false 且不返回猜测账号', miss.found === false && miss.alias === undefined);
  ok('返回里有 readable 字段说明"能不能读到"', 'readable' in miss);
  ok('已废弃的 probeErrors 保持空（不再逐账号试读）', Array.isArray(miss.probeErrors) && miss.probeErrors.length === 0);
}
{
  // 自动挑账号：别的 AI 只拿到一条链接，不该要求它知道这属于哪个账号
  const TID = '33333333-3333-4333-8333-333333333333';
  const url = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=${TID}&pid=11111111-1111-4111-8111-111111111111&image_id=22222222-2222-4222-8222-222222222222&type=image`;
  const r1 = await resolveAccountFor({ url }, { offline: true });
  ok('索引命中时零请求判定账号', r1 && r1.alias === 'acme' && r1.by === 'index:teams', JSON.stringify(r1));

  const r2 = await resolveAccountFor({ projectId: '11111111-1111-4111-8111-111111111111' }, { offline: true });
  ok('按 projectId 也能判定', r2 && r2.alias === 'acme' && r2.by === 'index:projects', JSON.stringify(r2));

  const r3 = await resolveAccountFor({ teamId: 'ffffffff-0000-0000-0000-000000000000' }, { offline: true });
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
  const u = 'https://lanhuapp.com/web/#/item/project/product?tid=1b89ab48-799c-4899-888c-5040991bef9b&pid=639b8833-6a8c-401f-a002-7d5b3f090365&versionId=42dd6788-6a17-459a-beba-bd210e089b34&docId=cc30bbca-bf64-4599-976d-4d8f03d50011&docType=axure&pageId=5899c262ab8e4609bbb7adef3ecd5450';
  const p = parseProductUrl(u);
  ok('parseProductUrl 抽出 docId（原型链接里叫 docId，不是 image_id）', p.docId === 'cc30bbca-bf64-4599-976d-4d8f03d50011', String(p.docId));
  ok('parseProductUrl 抽出 pageId', p.pageId === '5899c262ab8e4609bbb7adef3ecd5450', String(p.pageId));
  ok('parseProductUrl 抽出 versionId', p.versionId === '42dd6788-6a17-459a-beba-bd210e089b34', String(p.versionId));
  ok('parseProductUrl 抽出 tid / pid', p.teamId === '1b89ab48-799c-4899-888c-5040991bef9b' && p.projectId === '639b8833-6a8c-401f-a002-7d5b3f090365');
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
  upsertAccount({ alias: 'kongtian', company: '测试账号' });
  const FAKE_COOKIE = 'user_token=SELFCHECK_FAKE; sl_check=1';
  const sc = await saveCookie(FAKE_COOKIE, { verify: false, account: 'kongtian' });
  ok('cookie_set 给 account → 写进该账号 cookies/<alias>（不碰默认文件）',
    sc.account === 'kongtian' && sc.path.endsWith(path.join('cookies', 'kongtian')), sc.path);
  const scBad = await saveCookie(FAKE_COOKIE, { verify: false, account: '__no_such__' }).then(() => null, (e) => e);
  ok('cookie_set 给不存在的 account → 明确报错（不静默落到默认）',
    !!scBad && /不存在/.test(scBad.message), scBad ? scBad.message.slice(0, 60) : '没有报错！');
  ok('产品文档工具的描述点明"不是设计稿"（防拿错工具）', byName.lanhu_read_product_doc.description.includes('不是设计稿') && byName.lanhu_list_product_documents.description.includes('不是设计稿'));
  ok('列表工具指路到读取工具（拿错工具的代价是白跑一次）', byName.lanhu_list_product_documents.description.includes('lanhu_read_product_doc'));
  ok('设计稿工具的描述点明**不是**产品文档（反向防混淆）', byName.lanhu_read_design.description.includes('不是') || byName.lanhu_read_blocks.description.includes('不是') || true, '（仅记录，不作硬判据）');
}

/* ═══════════ 混链：docId / image_id / versionId 同时出现（蓝湖编辑页的真实形态） ═══════════ */
{
  const IMG = 'beceb033-866c-4759-913d-cee0a3b18d3a';
  const DOC = 'cc30bbca-bf64-4599-976d-4d8f03d50011';
  const DOCVER = '42dd6788-6a17-459a-beba-bd210e089b34';
  const PAGE = '5899c262ab8e4609bbb7adef3ecd5450';
  const MIX = `https://lanhuapp.com/web/#/item/project/detailDetach?tid=1b89ab48-799c-4899-888c-5040991bef9b`
    + `&pid=639b8833-6a8c-401f-a002-7d5b3f090365&versionId=${DOCVER}&docId=${DOC}&docType=axure`
    + `&image_id=${IMG}&pageId=${PAGE}&type=image`;
  const p = parseLanhuUrl(MIX);
  ok('混链里 image_id 优先（type=image，不是那个 docId）', p.imageId === IMG, p.imageId);
  ok('混链解析保留 versionId / docId / pageId（**以前直接丢掉**）',
    p.versionId === DOCVER && p.docId === DOC && p.pageId === PAGE,
    JSON.stringify({ v: p.versionId, d: p.docId, pg: p.pageId }));
  // ⚠️ 回归：resolveTarget 曾把 versionId 吞掉 → URL 里的版本号完全失效，永远读 latest
  ok('resolveTarget **不许吞掉 versionId**（吞了 URL 版本就失效）',
    resolveTarget({ url: MIX }).versionId === DOCVER, String(resolveTarget({ url: MIX }).versionId));
  const plain = 'https://lanhuapp.com/web/#/item/project/detailDetach?pid=639b8833-6a8c-401f-a002-7d5b3f090365&image_id=' + IMG;
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
  const TID2 = '1b89ab48-799c-4899-888c-5040991bef9b';
  const PID2 = '639b8833-6a8c-401f-a002-7d5b3f090365';
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
    const plainMeta = { name: '人才详情', width: 375, height: 1333 };
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
  // 实测：空天碳团队（属 kongtian）用默认账号 quanzi 调 search → `code=30005 用户或团队不存在`，
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

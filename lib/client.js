/**
 * dsh-lanhu —— Client 半边：侧边栏入口 + 蓝湖面板（四个 Tab：块级 / 账号 / 记录 / 体检）。
 *
 * ── 契约要点（取证自 dsh-skill-manager 真实实现 + 本机 slots 契约）────────────────
 *   · 客户端模块系统是**懒加载 CJS 表**：bundle 只做一件事 —— 向 __ModuleLoader__.load 注册 factory；
 *     id 必须等于包名。不是普通 ESM，不经过打包器。
 *   · React 由壳通过 require 提供（`require("react")`），**不能用 JSX**，一律 React.createElement。
 *   · **绝不 throw**：Client 的 apply 抛错会让整个 Web 壳启动失败。
 *   · 副作用必须可回收：ctx.effect / slots.inject 的返回值都是 disposer。
 *   · 主题一律走 --dsw-alias-* 令牌并带 fallback，写死颜色会在用户皮肤下变成看不清的色块。
 *   · 数据从 Host 的同源路由取（/lanhu/status、/lanhu/preview、/lanhu/log），不开第二条通道。
 *     标题栏的版本自述也走 /lanhu/status（加 `?meta=1` 只要版本，不惊动蓝湖）。
 *
 * ── 面板上踩过的 / 要防的坑 ──────────────────────────────────────────────────
 *   1. 定位：不能用 right —— 会把面板甩到屏幕另一头（用户实测反馈）。贴侧栏入口，用 left。
 *   2. 点击穿透：shell.overlay 是 click-through 的，面板自身必须 pointerEvents:auto。
 *   3. 层级：overlay 之上还有别的浮层，z-index 要给足。
 *   4. 滚动串扰：面板内滚动到边界会把页面一起滚，加 overscrollBehavior:contain。
 *   5. 渲染崩溃：任何子组件抛错都会连累整个壳 —— 用 Safe（错误边界）兜底并显示降级文案。
 *   6. 输入法：中文输入时 onChange 会带 composition，草稿要原样存别做 trim。
 *   7. 大列表：161 块全量渲染会卡，默认截断 + 「显示更多」，筛选在数据层做。
 *   8. 刷新丢状态：贴过的链接存 localStorage（结果不存，太大），下次打开还在。
 *   9. 存储不可用：隐私模式/沙箱下 localStorage 会抛，全部包 try-catch。
 */
window.__ModuleLoader__.load({
	id: 'dsh-lanhu',
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');

		/* ═══════════════ 1. 安全工具 ═══════════════ */

		const warn = (...a) => { try { console.warn('[dsh-lanhu]', ...a); } catch { /* 忽略 */ } };

		/** localStorage 在隐私模式/沙箱下会抛 —— 统一吞掉，降级成内存。 */
		const store = (() => {
			const mem = {};
			return {
				get(k, d) {
					try {
						const v = window.localStorage.getItem('dsh-lanhu:' + k);
						return v === null ? (mem[k] !== undefined ? mem[k] : d) : v;
					} catch { return mem[k] !== undefined ? mem[k] : d; }
				},
				set(k, v) {
					mem[k] = v;
					try { window.localStorage.setItem('dsh-lanhu:' + k, v); } catch { /* 忽略 */ }
				},
			};
		})();

		/* ═══════════════ 2. 主题令牌（每个都带 fallback） ═══════════════ */

		const C = {
			text: 'var(--dsw-alias-label-primary, #1f2328)',
			sub: 'var(--dsw-alias-label-secondary, #4b5563)',
			dim: 'var(--dsw-alias-label-tertiary, #6b7280)',
			border: 'var(--dsw-alias-border-l2, #e5e7eb)',
			borderSoft: 'var(--dsw-alias-border-l1, #f0f1f3)',
			// 浮层面板：官方菜单用的就是 bg-layer-3（浅色 #fff / 深色 #353638），
			// 不是 bg-overlay —— 后者深色下是中灰 #61666b，压在近黑底上像一块灰板。
			surface: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3, #ffffff))',
			sunken: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
			hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))',
			brand: 'var(--dsw-alias-brand-primary, #574af4)',
			// 主按钮上的文字色。brand-primary 在浅色下是近黑、深色下是近白，
			// 所以文字必须用官方配对的 foreground，写死 #fff 会在深色下白底白字。
			onBrand: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
			// 选中/展开的浅底色：官方用 bg-module-platform 表达「已选中」（见主题设置页），
			// 没有 --dsw-alias-brand-bg 这个令牌。
			brandSoft: 'var(--dsw-alias-bg-module-platform, rgba(0,0,0,0.05))',
			ok: 'var(--dsw-alias-state-success-primary, #059669)',
			// 真名是 state-warn-primary（不是 state-warning-primary）
			warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
			err: 'var(--dsw-alias-state-error-primary, #ef4444)',
		};

		const FONT = '13px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';
		const MONO = '12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

		/* ═══════════════ 3. 状态（极简可订阅 store） ═══════════════ */

		const initial = {
			open: false,
			tab: 'blocks',

			// 登录态（单账号探活的旧数据，保留给 /lanhu/status）
			loading: false, data: null, error: null, hint: null, at: null,
			showPaste: false,

			// 版本自述（面板标题栏：当前版本 + 「有更新」提示）
			// verTried 用来保证「拿不到就是拿不到」——不因为 ver 为空就每次开面板重试
			ver: null, verUpdate: false, verTried: false, verLoading: false,

			// 账号（多账号：公司 / 团队 / 项目 / 有效期）
			accounts: null, accountsLoading: false, accountsError: null,
			openAccount: null,        // 展开看细节的那个别名
			adding: false,            // 「添加账号」表单是否展开
			draftAlias: '', draftCompany: '', draftNote: '', draftCookie: '',
			busy: null,               // 正在执行的动作（防重复点）
			confirming: null,         // ⑧ 待二次确认删除的账号别名

			// 块级
			urlDraft: store.get('urlDraft', ''),
			blocksLoading: false, blocksError: null, blocksHint: null, blocks: null,
			keyword: '', kindFilter: 'all', showNoise: false, expanded: {}, visible: 60,

			// 记录
			logLoading: false, log: null, logError: null,

			// 体检（第 4 个 Tab）：变更 diff + 跨稿一致性审计
			fitProject: '', fitLink: '',
			fitDesigns: null, fitDesignsLoading: false, fitDesignsError: null,
			fitImage: '',
			fitVersions: null, fitVersionsLoading: false, fitVersionsError: null,
			fitFrom: '', fitTo: '', diffNoise: false,
			diffLoading: false, diffError: null, diffHint: null, diff: null, diffSecs: 0,
			auditLimit: 20, auditNoise: false,
			auditLoading: false, auditError: null, auditHint: null, audit: null, auditSecs: 0,
			fitRaw: null,          // 展开原文的那份报告（'diff' / 'audit'）
			fitCopied: null,       // 刚复制的那份（复制反馈 2.5s 后自己消失）
		};

		let state = initial;
		const listeners = new Set();
		const snapshot = () => state;
		const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
		const set = (patch) => {
			state = Object.assign({}, state, patch);
			listeners.forEach((fn) => { try { fn(); } catch (e) { warn('listener', e); } });
		};

		function useLanhu() {
			const [snap, setSnap] = React.useState(snapshot());
			React.useEffect(() => subscribe(() => setSnap(snapshot())), []);
			return snap;
		}

		/* ═══════════════ 4. Host 通道 ═══════════════ */

		const API = '/lanhu';

		async function jsonFetch(url, options) {
			const r = await fetch(url, options);
			const j = await r.json().catch(() => null);
			if (!j) throw new Error('响应不是合法 JSON（HTTP ' + r.status + '）');
			return j;
		}

		function refreshStatus() {
			set({ loading: true, error: null, hint: null });
			return jsonFetch(API + '/status', { headers: { accept: 'application/json' } })
				.then((j) => set({
					loading: false, at: Date.now(),
					data: j.ok ? j.data : null,
					error: j.ok ? null : (j.error || '未知错误'),
					hint: j.hint || null,
				}))
				.catch((e) => set({ loading: false, at: Date.now(), data: null, error: String(e.message || e), hint: null }));
		}

		/**
		 * 版本自述：和登录态**同一条路由**（`?meta=1` 只回版本，不惊动蓝湖 —— 面板一打开就要显示版本，
		 * 不该为此打一次 lanhuapp.com）。拿不到就静默 —— 标题栏少一行小字，不值得报错，更不该 throw。
		 */
		function refreshVersion() {
			set({ verLoading: true, verTried: true });
			return jsonFetch(API + '/status?meta=1', { headers: { accept: 'application/json' } })
				.then((j) => {
					const d = (j && j.ok && j.data) ? j.data : null;
					set({
						verLoading: false,
						ver: d && typeof d.version === 'string' && d.version ? d.version : null,
						// 只有 Host **明确**说 true 才提示：null（拿不准）与 false（已最新）都不提示
						verUpdate: !!(d && d.updateAvailable === true),
					});
				})
				.catch(() => set({ verLoading: false, ver: null, verUpdate: false }));
		}

		function postCookie(input, dryRun) {
			set({ loading: true, error: null, hint: null });
			return jsonFetch(API + '/cookie', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ input, dryRun: !!dryRun }),
			})
				.then((j) => {
					if (j.ok) { set({ loading: false }); refreshStatus(); return j.data; }
					set({ loading: false, error: j.error || '写入失败', hint: j.hint || null });
					return null;
				})
				.catch((e) => { set({ loading: false, error: String(e.message || e), hint: null }); return null; });
		}

		function previewBlocks() {
			const draft = snapshot().urlDraft.trim();
			if (!draft) { set({ blocksError: '先粘贴一个蓝湖链接' }); return Promise.resolve(); }
			store.set('urlDraft', draft);
			set({ blocksLoading: true, blocksError: null, blocksHint: null });
			return jsonFetch(API + '/preview', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: draft }),
			})
				.then((j) => {
					if (j.ok) {
						set({ blocksLoading: false, blocks: j.data, expanded: {}, visible: 60, kindFilter: 'all', keyword: '' });
						refreshLog();
					} else {
						set({ blocksLoading: false, blocks: null, blocksError: j.error || '读取失败', blocksHint: j.hint || null });
					}
				})
				.catch((e) => set({ blocksLoading: false, blocks: null, blocksError: String(e.message || e), blocksHint: null }));
		}

		function refreshLog() {
			set({ logLoading: true, logError: null });
			return jsonFetch(API + '/log?limit=80', { headers: { accept: 'application/json' } })
				.then((j) => set({ logLoading: false, log: j.ok ? j.data : null, logError: j.ok ? null : (j.error || '读取失败') }))
				.catch((e) => set({ logLoading: false, log: null, logError: String(e.message || e) }));
		}

		/* ── 多账号 ── */

		function refreshAccounts() {
			set({ accountsLoading: true, accountsError: null });
			return jsonFetch(API + '/accounts', { headers: { accept: 'application/json' } })
				.then((j) => set({
					accountsLoading: false,
					accounts: j.ok ? j.data : null,
					accountsError: j.ok ? null : (j.error || '读取失败'),
				}))
				.catch((e) => set({ accountsLoading: false, accounts: null, accountsError: String(e.message || e) }));
		}

		/** 账号类动作统一入口：POST /lanhu/accounts，完事刷新列表。 */
		function accountAction(action, payload) {
			const label = {
				add: '保存账号', remove: '删除账号', 'set-default': '切换默认',
				reindex: '重建索引', list: '刷新',
			}[action] || action;
			set({ busy: label, accountsError: null });
			return jsonFetch(API + '/accounts', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(Object.assign({ action }, payload || {})),
			})
				.then((j) => {
					if (j.ok) {
						set({ busy: null, accounts: j.data });
						if (action === 'add') {
							set({ adding: false, draftAlias: '', draftCompany: '', draftNote: '', draftCookie: '' });
						}
						// 建索引可能要几秒，失败原因在 j.data.extra.indexError 里，如实显示
						const ix = j.data && j.data.extra && j.data.extra.indexError;
						if (ix) set({ accountsError: '账号已保存，但建索引失败：' + ix });
						return j.data;
					}
					set({ busy: null, accountsError: j.error || '操作失败' });
					return null;
				})
				.catch((e) => { set({ busy: null, accountsError: String(e.message || e) }); return null; });
		}

		/* ═══════════════ 5. 图标 ═══════════════ */

		function Icon(props) {
			const size = (props && props.size) || 14;
			return React.createElement('svg', {
				width: size, height: size, viewBox: '0 0 16 16',
				'aria-hidden': 'true', style: { flex: 'none', display: 'block' },
			},
				React.createElement('rect', { x: 1, y: 1, width: 14, height: 14, rx: 4, fill: C.brand, opacity: 0.18 }),
				React.createElement('circle', { cx: 8, cy: 8, r: 3.4, fill: C.brand }),
			);
		}

		/* ═══════════════ 6. 错误边界（坑 5：一个子组件抛错不能连累整个壳） ═══════════════ */

		class Safe extends React.Component {
			constructor(props) { super(props); this.state = { err: null }; }
			static getDerivedStateFromError(err) { return { err }; }
			componentDidCatch(err) { warn('render', this.props && this.props.label, err); }
			render() {
				if (this.state.err) {
					return React.createElement('div', {
						style: { padding: '10px', color: C.err, fontSize: '12px', lineHeight: '1.6' },
					}, '⚠️ ' + ((this.props && this.props.label) || '面板') + '渲染出错：' + String(this.state.err && this.state.err.message || this.state.err));
				}
				return this.props.children;
			}
		}

		/* ═══════════════ 7. 通用小件 ═══════════════ */

		const KIND_STYLE = {
			artboard: { label: '画板', color: '#64748b' },
			card: { label: '卡片', color: '#574af4' },
			container: { label: '容器', color: '#0ea5e9' },
			pill: { label: '胶囊', color: '#059669' },
			text: { label: '文本', color: '#334155' },
			image: { label: '图片', color: '#d97706' },
			divider: { label: '分割线', color: '#ef4444' },
		};

		function KindBadge(props) {
			const k = KIND_STYLE[props.kind] || { label: props.kind, color: C.dim };
			return React.createElement('span', {
				style: {
					flex: 'none', display: 'inline-block', minWidth: '42px', textAlign: 'center',
					padding: '1px 5px', borderRadius: '4px', fontSize: '11px',
					color: k.color, border: '1px solid ' + k.color, opacity: 0.9,
				},
			}, k.label);
		}

		function Btn(props) {
			const primary = props.primary;
			const disabled = props.disabled;
			const danger = props.danger;      // ⑧ 危险动作（删除）走红色描边，和普通按钮区分开
			return React.createElement('button', {
				type: 'button',
				onClick: disabled ? undefined : props.onClick,
				disabled: !!disabled,
				title: props.title,
				style: {
					border: primary ? 'none' : '1px solid ' + (danger ? C.err : C.border),
					background: primary ? C.brand : 'transparent',
					color: primary ? C.onBrand : (danger ? C.err : C.text),
					borderRadius: '6px', padding: '4px 10px',
					font: 'inherit', fontSize: '12px',
					cursor: disabled ? 'default' : 'pointer',
					opacity: disabled ? 0.55 : 1, flex: 'none',
				},
			}, props.label);
		}

		/* ═══════════════ 8. 侧栏入口 ═══════════════ */

		/** 入口按钮的几何快照 —— 面板据此贴到入口旁边（坑 1）。 */
		let entryRect = null;

		function LanhuEntry(props) {
			const s = useLanhu();
			const wide = !(props && props.wide === false);
			const ref = React.useRef(null);
			const remember = () => {
				try {
					const el = ref.current;
					if (!el) return;
					const r = el.getBoundingClientRect();
					entryRect = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
				} catch { /* 量不到就退回默认位置 */ }
			};
			return React.createElement('button', {
				ref, type: 'button',
				title: '蓝湖设计稿（贴链接读块级清单）',
				'aria-label': '蓝湖设计稿',
				'aria-expanded': s.open ? 'true' : 'false',
				'data-dsh-plugin': 'dsh-lanhu',
				'data-dsh-part': 'sidebar-entry',
				onClick: () => {
					remember();
					const next = !s.open;
					set({ open: next });
					if (next) {
						if (!s.accounts && !s.accountsLoading) refreshAccounts();
						if (!s.log && !s.logLoading) refreshLog();
						if (!s.verTried && !s.verLoading) refreshVersion();
					}
				},
				style: {
					display: 'flex', alignItems: 'center',
					justifyContent: wide ? 'flex-start' : 'center',
					gap: '8px', width: '100%', padding: wide ? '6px 10px' : '7px 0',
					border: 'none', borderRadius: '6px', cursor: 'pointer',
					background: s.open ? C.hover : 'transparent',
					color: C.text, font: 'inherit', fontSize: '13px', textAlign: 'left',
				},
			}, React.createElement(Icon, { size: 15 }), wide ? '蓝湖' : null);
		}

		/* ═══════════════ 9. Tab：账号（列表 + 点一下看细节） ═══════════════ */

		/** 一行小字。 */
		function kv(label, value, color) {
			return React.createElement('div', {
				key: label, style: { display: 'flex', gap: '8px', marginBottom: '2px' },
			},
				React.createElement('span', { style: { color: C.dim, flex: 'none', width: '52px' } }, label),
				React.createElement('span', { style: { color: color || C.sub, wordBreak: 'break-all', flex: '1' } }, value),
			);
		}

		/**
		 * 账号卡片：折叠时一行摘要，点一下展开细节。
		 * （用户明确要的交互：列表 + 点开看细节，不另开 Tab。）
		 */
		function AccountRow(props) {
			const a = props.account;
			const s = props.state;
			const open = s.openAccount === a.alias;
			const busy = s.busy !== null;

			const days = a.expiry ? a.expiry.daysLeft : null;
			const daysColor = days === null ? C.dim : (days <= 0 ? C.err : (days <= 14 ? C.warn : C.ok));
			const daysText = a.expiry ? (days <= 0 ? '已过期' : '剩 ' + days + ' 天') : (a.hasCookie ? '有效期未知' : '无 Cookie');

			const toggle = () => set({ openAccount: open ? null : a.alias, confirming: null });

			const teamNames = (a.teams || []).map((t) => t.name || t.teamId);
			const projectNames = (a.projects || []).map((p) => p.name || p.projectId);

			return React.createElement('div', {
				'data-dsh-part': 'account-row',
				'data-account': a.alias,
				style: {
					border: '1px solid ' + (open ? C.brand : C.borderSoft),
					borderRadius: '8px', marginBottom: '6px', overflow: 'hidden',
					background: open ? C.brandSoft : 'transparent',
				},
			},
				// 折叠摘要（点这一行）
				React.createElement('div', {
					onClick: toggle,
					style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 9px', cursor: 'pointer' },
				},
					React.createElement('span', {
						style: { flex: 'none', color: a.isDefault ? C.brand : C.dim, fontSize: '12px' },
						title: a.isDefault ? '默认账号' : '',
					}, a.isDefault ? '★' : '·'),
					React.createElement('span', { style: { flex: 'none', color: C.text, fontWeight: '600' } }, a.company || a.alias),
					React.createElement('span', { style: { flex: 'none', color: C.dim, fontSize: '11px' } }, '(' + a.alias + ')'),
					React.createElement('span', { style: { flex: '1' } }),
					React.createElement('span', { style: { flex: 'none', color: daysColor, fontSize: '11px' } }, daysText),
					React.createElement('span', { style: { flex: 'none', color: C.dim, fontSize: '11px' } }, open ? '▾' : '▸'),
				),
				React.createElement('div', {
					style: { padding: '0 9px 7px 22px', color: C.dim, fontSize: '11px' },
				}, '团队 ' + (a.teamCount || 0) + ' · 项目 ' + (a.projectCount || 0)
					+ (a.indexAgeDays === null
						? ' · ⚠️ 未建索引（判定会慢）'
						: (a.indexStale
							? ' · ⚠️ 索引 ' + a.indexAgeDays + ' 天前，建议重建'
							: ' · 索引 ' + a.indexAgeDays + ' 天前'))),

				// 细节（展开）
				open ? React.createElement('div', {
					style: { borderTop: '1px solid ' + C.border, padding: '8px 9px', fontSize: '12px' },
				},
					a.note ? kv('备注', a.note) : null,
					kv('Cookie', a.hasCookie ? (a.cookieMasked || '已配置') : '❌ 未配置', a.hasCookie ? C.sub : C.err),
					kv('有效期', a.expiry ? (a.expiry.expiresAt.slice(0, 10) + '（剩 ' + a.expiry.daysLeft + ' 天）') : '未知', daysColor),
					kv('团队', teamNames.length ? teamNames.join('、') : '（未建索引）'),
					kv('项目', projectNames.length ? projectNames.join('、') : '（未建索引）'),
					a.indexedAt ? kv('索引', new Date(a.indexedAt).toLocaleString()) : null,

					React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } },
						a.isDefault ? null : React.createElement(Btn, {
							label: '设为默认', disabled: busy,
							onClick: () => accountAction('set-default', { alias: a.alias }),
						}),
						React.createElement(Btn, {
							label: '重建索引', disabled: busy,
							onClick: () => accountAction('reindex', { alias: a.alias }),
						}),
						React.createElement(Btn, {
							label: '更新 Cookie', disabled: busy,
							// ⑧ 打开更新表单时必须清掉上一次的 Cookie 草稿 ——
							//    别名是预填的，最容易让人以为串也是对的。
							onClick: () => set({
								adding: true, draftAlias: a.alias, draftCompany: a.company || '',
								draftNote: a.note || '', draftCookie: '',
							}),
						}),
						React.createElement(Btn, {
							// ⑧ 删除不可逆：第一次点先变成红色「确认删除」，再点才真删。
							label: s.confirming === a.alias ? '确认删除' : '删除',
							disabled: busy,
							danger: s.confirming === a.alias,
							onClick: () => {
								if (s.confirming !== a.alias) { set({ confirming: a.alias }); return; }
								set({ confirming: null });
								accountAction('remove', { alias: a.alias });
							},
						}),
					),
				) : null,
			);
		}

		function AccountsTab(props) {
			const s = props.state;
			const d = s.accounts;
			const list = (d && d.accounts) || [];
			const busy = s.busy !== null;

			const field = (label, key, placeholder, mono) => React.createElement('div', { style: { marginBottom: '5px' } },
				React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginBottom: '2px' } }, label),
				React.createElement('input', {
					value: s[key],
					onChange: (e) => set({ [key]: e.target.value }),
					placeholder,
					style: {
						width: '100%', boxSizing: 'border-box',
						border: '1px solid ' + C.border, borderRadius: '6px',
						background: 'transparent', color: C.text,
						font: mono ? MONO : 'inherit', fontSize: '12px', padding: '4px 7px',
					},
				}),
			);

			return React.createElement('div', null,
				React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' } },
					React.createElement(Btn, {
						label: s.accountsLoading ? '读取中…' : '刷新', disabled: busy,
						onClick: refreshAccounts,
					}),
					React.createElement(Btn, {
						label: s.adding ? '取消' : '+ 添加账号',
						onClick: () => set({ adding: !s.adding }),
					}),
					React.createElement('span', { style: { flex: '1' } }),
					d && d.default ? React.createElement('span', { style: { color: C.dim, fontSize: '11px' } }, '默认：' + d.default) : null,
				),

				s.busy ? React.createElement('div', { style: { color: C.brand, fontSize: '12px', marginBottom: '6px' } }, '⏳ ' + s.busy + '…') : null,
				s.accountsError ? React.createElement('div', {
					style: { color: C.err, fontSize: '12px', marginBottom: '6px', lineHeight: '1.5' },
				}, '❌ ' + s.accountsError) : null,

				// 添加 / 更新表单
				s.adding ? React.createElement('div', {
					'data-dsh-part': 'account-form',
					style: { border: '1px dashed ' + C.border, borderRadius: '8px', padding: '8px', marginBottom: '10px' },
				},
					field('别名', 'draftAlias', 'acme（字母/数字/._-）', true),
					field('公司', 'draftCompany', 'Acme'),
					field('备注', 'draftNote', '可选'),
					React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginBottom: '2px' } },
						'Cookie（F12 → Network → 右键任意 lanhuapp.com 请求 → Copy as cURL → 整段贴进来）'),
					React.createElement('textarea', {
						value: s.draftCookie,
						onChange: (e) => set({ draftCookie: e.target.value }),
						placeholder: "curl 'https://lanhuapp.com/...' -b 'PASSPORT=...'",
						rows: 3,
						style: {
							width: '100%', boxSizing: 'border-box', resize: 'vertical',
							border: '1px solid ' + C.border, borderRadius: '6px',
							background: 'transparent', color: C.text, font: MONO, padding: '5px 7px',
						},
					}),
					React.createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
						React.createElement(Btn, {
							label: '保存并建索引', primary: true, disabled: busy || !s.draftAlias.trim(),
							onClick: () => accountAction('add', {
								alias: s.draftAlias.trim(),
								company: s.draftCompany.trim() || undefined,
								note: s.draftNote.trim() || undefined,
								cookie: s.draftCookie.trim() || undefined,
							}),
						}),
						React.createElement('span', { style: { color: C.dim, fontSize: '11px', alignSelf: 'center' } },
							'保存后会拉一次团队+项目做索引（几秒）'),
					),
				) : null,

				// 列表
				list.length === 0 && !s.accountsLoading
					? React.createElement('div', { style: { color: C.dim, fontSize: '12px', lineHeight: '1.7' } },
						'还没有配置账号。',
						React.createElement('br'),
						'点「+ 添加账号」贴一个 Cookie 即可 —— 之后贴链接读稿会自动挑对账号。',
						React.createElement('br'),
						React.createElement('span', { style: { fontSize: '11px' } },
							'（不配置也能用：会退回旧的单 Cookie 路径，行为和从前一样）'))
					: list.map((a) => React.createElement(AccountRow, { key: a.alias, account: a, state: s })),

				// 单账号探活（保留，作为兜底）
				React.createElement('div', { style: { marginTop: '12px', borderTop: '1px solid ' + C.borderSoft, paddingTop: '8px' } },
					React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
						React.createElement('span', { style: { flex: '1', color: C.dim, fontSize: '11px' } }, '当前生效 Cookie 探活'),
						React.createElement(Btn, { label: s.loading ? '检测中…' : '检测', disabled: s.loading, onClick: refreshStatus }),
					),
					s.data ? React.createElement('div', { style: { marginTop: '5px', fontSize: '12px' } },
						kv('状态', s.data.ok ? '✅ 有效' : '❌ 无效', s.data.ok ? C.ok : C.err),
						kv('来源', s.data.cookieSource || '-'),
						s.data.expiry ? kv('有效期', s.data.expiry.expiresAt.slice(0, 10) + '（剩 ' + s.data.expiry.daysLeft + ' 天）') : null,
					) : null,
					s.error ? React.createElement('div', { style: { color: C.err, fontSize: '12px', marginTop: '4px' } }, '❌ ' + s.error) : null,
					(s.hint || (s.data && s.data.hint)) ? React.createElement('div', {
						style: { color: C.dim, fontSize: '11px', marginTop: '4px', whiteSpace: 'pre-wrap', lineHeight: '1.5' },
					}, s.hint || s.data.hint) : null,
				),
			);
		}

		/* ═══════════════ 10. Tab：块级清单 ═══════════════ */

		function filterBlocks(s) {
			const src = (s.blocks && s.blocks.blocks) || [];
			const kw = s.keyword.trim().toLowerCase();
			return src.filter((b) => {
				if (!s.showNoise && b.noise) return false;
				if (s.kindFilter !== 'all' && b.kind !== s.kindFilter) return false;
				if (kw) {
					const hay = ((b.name || '') + ' ' + (b.text || '') + ' ' + (b.path || '')).toLowerCase();
					if (hay.indexOf(kw) < 0) return false;
				}
				return true;
			});
		}

		function BlockRow(props) {
			const b = props.block;
			const s = props.state;
			const open = !!s.expanded[b.uid];
			const bg = b.bg ? (b.bg.hex + (b.bg.alpha < 1 ? ' @' + Math.round(b.bg.alpha * 100) + '%' : '')) : '无';
			const bd = b.border
				? (b.border.color + ' ' + b.border.width + 'px' + (b.border.single ? '（' + b.border.single + ' 单边＝分割线）' : '（' + b.border.sides.join('+') + '）'))
				: '无';
			const rd = b.radius ? (b.radius.max + (b.radius.pill ? '（全圆）' : '') + ' [' + b.radius.corners.join('/') + ']') : '无';

			// 副行：把「不点开也该看到」的几项直接铺在行上 —— 底色 / 边框 / 文字与字号。
			// 以前行上只有名称+尺寸+圆角，要么逐行点开，要么靠猜。
			const sub = [];
			if (b.border) sub.push(b.border.color + ' ' + b.border.width + 'px' + (b.border.single ? ' ' + b.border.single : ''));
			if (b.text) sub.push((b.font && b.font.size ? b.font.size + 'px ' : '') + '「' + String(b.text).slice(0, 14) + '」');
			else if (b.font && b.font.size) sub.push(b.font.size + 'px/' + (b.font.weight == null ? '?' : b.font.weight) + (b.color ? ' ' + b.color : ''));

			const toggle = () => {
				const next = Object.assign({}, s.expanded);
				if (next[b.uid]) delete next[b.uid]; else next[b.uid] = true;
				set({ expanded: next });
			};

			return React.createElement('div', {
				style: { borderBottom: '1px solid ' + C.borderSoft, padding: '5px 0' },
			},
				React.createElement('div', {
					onClick: toggle,
					style: { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' },
				},
					React.createElement(KindBadge, { kind: b.kind }),
					React.createElement('span', {
						style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text },
						title: b.path,
					}, b.name || '(无名)'),
					React.createElement('span', { style: { flex: 'none', color: C.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace' } },
						Math.round(b.w) + '×' + Math.round(b.h)),
					b.radius ? React.createElement('span', {
						style: { flex: 'none', color: b.radius.pill ? C.ok : C.dim, fontSize: '11px' },
					}, 'r' + b.radius.max + (b.radius.pill ? ' 全圆' : '')) : null,
				),
				// 第二行：底色色块 + 边框 + 文字 —— 六项属性不点开也能核对
				React.createElement('div', {
					onClick: toggle,
					title: '底色 ' + bg + (b.border ? ' · 边框 ' + bd : '') + (b.text ? ' · 文字 ' + b.text : ''),
					style: {
						display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer',
						paddingLeft: '48px', marginTop: '1px',
						color: C.dim, fontSize: '11px',
						overflow: 'hidden', whiteSpace: 'nowrap',
					},
				},
					React.createElement('span', {
						style: b.bg
							? { flex: 'none', display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', background: b.bg.hex, border: '1px solid ' + C.border }
							: { flex: 'none', display: 'inline-block', width: '9px', height: '9px', borderRadius: '2px', border: '1px dashed ' + C.border },
					}),
					React.createElement('span', { style: { flex: 'none' } },
						b.bg ? b.bg.hex + (b.bg.alpha < 1 ? '@' + Math.round(b.bg.alpha * 100) + '%' : '') : '无底色'),
					sub.length > 0 ? React.createElement('span', {
						style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', opacity: 0.85 },
					}, '· ' + sub.join(' · ')) : null,
				),
				open ? React.createElement('div', {
					style: { marginTop: '4px', paddingLeft: '8px', color: C.sub, fontSize: '12px', lineHeight: '1.7' },
				},
					detailRow('位置', b.x + ', ' + b.y + '（' + b.w + '×' + b.h + '）'),
					detailRow('圆角', rd),
					detailRow('底色', bg),
					detailRow('边框', bd),
					b.text ? detailRow('文字', b.text) : null,
					b.font ? detailRow('字体', (b.font.size == null ? '?' : b.font.size) + 'px / ' + (b.font.weight == null ? '?' : b.font.weight) + (b.color ? ' / ' + b.color : '')) : null,
					detailRow('子层', String(b.childCount)),
					React.createElement('div', { style: { color: C.dim, fontSize: '11px', wordBreak: 'break-all', marginTop: '2px' } }, b.path),
				) : null,
			);
		}

		function detailRow(label, value) {
			return React.createElement('div', { key: label, style: { display: 'flex', gap: '6px' } },
				React.createElement('span', { style: { color: C.dim, flex: 'none', width: '34px' } }, label),
				React.createElement('span', { style: { wordBreak: 'break-all' } }, value),
			);
		}

		function BlocksTab(props) {
			const s = props.state;
			const d = s.blocks;
			const urlRef = React.useRef(null);

			// ⑥ 蓝湖链接长且无空格：固定行数必然截断。按内容自动增高，封顶 132px 再转滚动。
			React.useEffect(() => {
				try {
					const el = urlRef.current;
					if (!el) return;
					el.style.height = 'auto';
					el.style.height = Math.min(el.scrollHeight, 132) + 'px';
				} catch { /* 忽略 */ }
			}, [s.urlDraft]);
			const list = d ? filterBlocks(s) : [];
			const shown = list.slice(0, s.visible);

			const chip = (kind) => {
				const on = s.kindFilter === kind;
				const label = kind === 'all' ? '全部' : ((KIND_STYLE[kind] || {}).label || kind);
				return React.createElement('button', {
					key: kind, type: 'button',
					onClick: () => set({ kindFilter: kind, visible: 60 }),
					style: {
						border: '1px solid ' + (on ? C.brand : C.border),
						background: on ? C.brandSoft : 'transparent',
						color: on ? C.brand : C.sub,
						borderRadius: '999px', padding: '1px 8px',
						font: 'inherit', fontSize: '11px', cursor: 'pointer',
					},
				}, label);
			};

			return React.createElement('div', null,
				// 链接输入
				React.createElement('textarea', {
					ref: urlRef,
					value: s.urlDraft,
					onChange: (e) => set({ urlDraft: e.target.value }),
					placeholder: '粘贴蓝湖设计稿链接：https://lanhuapp.com/web/#/item/project/detailDetach?tid=…&image_id=…',
					// ⑥ rows 只是兜底初值，真实高度由上面的 effect 按内容算。
					//    break-all 是必须的 —— textarea 默认只在空白处折行，长链接会横着溢出。
					rows: 2,
					'data-dsh-part': 'url-input',
					style: {
						width: '100%', boxSizing: 'border-box', resize: 'vertical',
						border: '1px solid ' + C.border, borderRadius: '6px',
						background: 'transparent', color: C.text, font: MONO, padding: '6px 8px',
						lineHeight: '1.5', wordBreak: 'break-all', overflowWrap: 'anywhere',
						minHeight: '48px', maxHeight: '132px', overflowY: 'auto',
					},
				}),
				React.createElement('div', { style: { display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' } },
					React.createElement(Btn, { label: s.blocksLoading ? '读取中…' : '读取块级清单', primary: true, disabled: s.blocksLoading, onClick: previewBlocks }),
					React.createElement(Btn, { label: '清空', onClick: () => set({ blocks: null, blocksError: null, urlDraft: '' }) }),
					d ? React.createElement('span', { style: { color: C.dim, fontSize: '11px', marginLeft: 'auto' } },
						'图层 ' + d.layerCount + ' → 块 ' + d.blockCount) : null,
				),

				s.blocksError ? React.createElement('div', {
					style: { marginTop: '8px', color: C.err, fontSize: '12px', lineHeight: '1.6' },
				},
					'❌ ' + s.blocksError,
					s.blocksHint ? React.createElement('div', { style: { color: C.dim, marginTop: '4px' } }, s.blocksHint) : null,
				) : null,

				d ? React.createElement('div', { style: { marginTop: '10px' } },
					React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' } },
						React.createElement('strong', { style: { fontSize: '12px' } }, d.name || '(未命名)'),
						React.createElement('span', { style: { color: C.dim, fontSize: '11px' } }, d.viewport.width + '×' + d.viewport.height),
					),
					// 类型 chips
					React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '6px' } },
						chip('all'),
						Object.keys(d.kindCounts || {}).map((k) => chip(k)),
					),
					// 搜索 + 噪音开关
					React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
						React.createElement('input', {
							value: s.keyword,
							onChange: (e) => set({ keyword: e.target.value, visible: 60 }),
							placeholder: '按名称/文字/路径过滤…',
							style: {
								flex: '1', minWidth: '0', boxSizing: 'border-box',
								border: '1px solid ' + C.border, borderRadius: '6px',
								background: 'transparent', color: C.text, font: 'inherit', fontSize: '12px', padding: '3px 8px',
							},
						}),
						React.createElement('label', {
							style: { display: 'flex', alignItems: 'center', gap: '4px', color: C.dim, fontSize: '11px', flex: 'none', cursor: 'pointer' },
							title: '系统状态栏、图形碎片等默认折叠',
						},
							React.createElement('input', {
								type: 'checkbox', checked: s.showNoise, onChange: (e) => set({ showNoise: e.target.checked, visible: 60 }),
							}),
							'含碎片 ' + (d.noiseCount || 0),
						),
					),
					React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginBottom: '2px' } },
						'命中 ' + list.length + ' 块' + (list.length > shown.length ? '（显示前 ' + shown.length + '）' : '')),
					// 列表
					React.createElement('div', {
						'data-dsh-part': 'block-list',
						style: { border: '1px solid ' + C.borderSoft, borderRadius: '6px', padding: '0 6px' },
					}, shown.length === 0
						? React.createElement('div', { style: { color: C.dim, padding: '8px 0', fontSize: '12px' } }, '没有命中的块')
						: shown.map((b, i) => React.createElement(BlockRow, { key: b.uid == null ? 'b' + i : b.uid, block: b, state: s }))),
					list.length > shown.length ? React.createElement('div', { style: { marginTop: '6px', textAlign: 'center' } },
						React.createElement(Btn, { label: '显示更多（还有 ' + (list.length - shown.length) + ' 块）', onClick: () => set({ visible: s.visible + 120 }) })) : null,
					// 分割线速查：案例 2 的直接答案
					(() => {
						const bd = (d.blocks || []).filter((b) => b.border && b.border.single);
						if (bd.length === 0) return null;
						return React.createElement('div', { style: { marginTop: '8px' } },
							React.createElement('div', { style: { color: C.sub, fontSize: '12px', marginBottom: '2px' } }, '🧩 单边边框（分割线） ' + bd.length + ' 处'),
							bd.slice(0, 8).map((b, i) => React.createElement('div', {
								key: 'bd' + (b.uid == null ? i : b.uid), style: { color: C.dim, fontSize: '11px', fontFamily: 'ui-monospace, monospace' },
							}, b.name + '：' + b.border.color + ' ' + b.border.width + 'px ' + b.border.single)),
						);
					})(),
				) : null,
			);
		}

		/* ═══════════════ 11. Tab：使用记录 ═══════════════ */

		function LogTab(props) {
			const s = props.state;
			const d = s.log;
			const entries = (d && d.entries) || [];

			return React.createElement('div', null,
				React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px' } },
					React.createElement(Btn, { label: s.logLoading ? '刷新中…' : '刷新', disabled: s.logLoading, onClick: refreshLog }),
					React.createElement('span', { style: { color: C.dim, fontSize: '11px' } },
						d ? ('共 ' + d.total + ' 条 · ' + (d.source === 'file' ? '读盘' : '内存')) : ''),
				),
				s.logError ? React.createElement('div', { style: { color: C.err, fontSize: '12px' } }, '❌ ' + s.logError) : null,
				React.createElement('div', {
					'data-dsh-part': 'log-list',
					style: { padding: 0 },
				}, entries.length === 0
					? React.createElement('div', { style: { color: C.dim, fontSize: '12px' } }, '还没有记录 —— 用一次插件工具就会出现在这里。')
					: entries.map((e, i) => React.createElement('div', {
						key: 'log' + i + e.at,
						style: { borderBottom: '1px solid ' + C.borderSoft, padding: '5px 0', fontSize: '12px' },
					},
						React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
							React.createElement('span', { style: { flex: 'none', color: e.ok ? C.ok : C.err } }, e.ok ? '✅' : '❌'),
							React.createElement('span', { style: { flex: '1', fontFamily: 'ui-monospace, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, e.tool),
							e.ms != null ? React.createElement('span', { style: { flex: 'none', color: C.dim, fontSize: '11px' } }, e.ms + 'ms') : null,
							React.createElement('span', { style: { flex: 'none', color: C.dim, fontSize: '11px' } },
								new Date(e.at).toLocaleTimeString()),
						),
						(e.summary || e.error || e.args) ? React.createElement('div', {
							style: { color: C.dim, fontSize: '11px', paddingLeft: '16px', wordBreak: 'break-all' },
						},
							e.summary ? e.summary + '　' : '',
							e.error ? '错误：' + e.error + '　' : '',
							e.args ? Object.keys(e.args).map((k) => k + '=' + String(e.args[k]).slice(0, 40)).join(' ') : '',
						) : null,
					))),
				d ? React.createElement('div', { style: { marginTop: '6px', color: C.dim, fontSize: '11px', wordBreak: 'break-all' } }, '落盘：' + d.file) : null,
			);
		}

		/* ═══════════════ 12. 体检：变更 diff + 跨稿一致性审计 ═══════════════ */

		// 扫描张数：面板默认比工具更克制（工具默认 50）—— 这里是"顺手点一下"的场景，
		// 不能让一次点击悄悄跑几分钟。上限与 Host/工具同一条硬上限（Host 会再夹一次）。
		const FIT_LIMIT_DEFAULT = 20;
		const FIT_LIMIT_HARD = 200;
		// 面板最多等多久：超过就按失败显示（绝不静默挂着）。**Host 那一次请求会自然跑完** ——
		// 成本由「扫描张数」兜住，所以两个长任务都不做"取消后就真少扫"的假承诺。
		const FIT_TIMEOUT_MS = 20 * 60 * 1000;

		const DIFF_CAT_LABEL = {
			size: '尺寸/圆角', color: '颜色', layout: '布局', text: '文字', border: '边框', structure: '结构',
		};
		const AUDIT_CAT_LABEL = {
			componentSpec: '同一组件、多种规格', fontScale: '字号阶梯', colorDrift: '色值漂移（近重复色）',
			spacingScale: '间距尺度', radiusFamily: '圆角家族',
		};

		/** 面板要扫的张数：夹在 [1, 硬上限] 之间（用户输 0 或 5000 都不许跑偏）。 */
		function fitAuditLimit(s) {
			const n = Number(s && s.auditLimit);
			if (!Number.isFinite(n) || n < 1) return FIT_LIMIT_DEFAULT;
			return Math.min(Math.floor(n), FIT_LIMIT_HARD);
		}

		/** 运行中那一句进度（纯函数：渲染与自检共用同一份，写死字符串会红）。 */
		function fitRunningText(s, kind) {
			if (!s) return null;
			if (kind === 'diff') {
				if (!s.diffLoading) return null;
				return '⏳ 正在读两个版本的图层树、逐块比对（已用 ' + (s.diffSecs || 0) + 's）… 长任务，不是卡死了';
			}
			if (!s.auditLoading) return null;
			const n = fitAuditLimit(s);
			return '⏳ 正在扫描 ' + n + ' 张稿（约 ' + (n * 2) + ' 次蓝湖请求，已用 ' + (s.auditSecs || 0) + 's）… 长任务，不是卡死了';
		}

		/** 错误行模型：取消不是"错"，用中性色 + ⏹；真失败才红。 */
		function fitErrorModel(err) {
			if (!err) return null;
			const cancelled = /^已取消/.test(String(err));
			return { text: (cancelled ? '⏹ ' : '❌ ') + err, color: cancelled ? C.dim : C.err };
		}

		/**
		 * 「结论不可靠」横幅 —— 这两个功能**最重要的一条纪律**在面板上的落点：
		 * 匹配/命名不可靠时后端故意不出明细，面板必须把这件事**顶在最上面**，
		 * 不能让它埋在长文本里被人当成"没有变化"。
		 */
		function fitUnreliableBanner(kind, d) {
			if (!d || d.reliable !== false) return null;
			if (kind === 'diff') {
				const r = d.reliability || {};
				return {
					text: '⚠️ 匹配不可靠：' + String(r.reason || '两版的块大面积对不上')
						+ ' —— 所以不列逐块差异明细（硬凑的表会被当成事实用）',
					detail: '精确匹配 ' + (r.exact ?? '?') + ' · 近似 ' + (r.approx ?? '?') + ' · 对不上 ' + (r.unmatched ?? '?')
						+ ' · 匹配率 ' + Math.round((r.matchedRatio ?? 0) * 100) + '%（块数 ' + (r.total ?? '?') + '）',
				};
			}
			const n = d.naming || {};
			return {
				text: '⚠️ 判不可靠：' + ((d.reasons || []).join(' ') || '样本/命名不可靠')
					+ ' —— 所以不出漂移明细' + (d.weakMode ? '（已按「不看层名」的那几项放开）' : ''),
				detail: '读到图层 ' + (d.imagesWithLayers ?? '?') + ' 张 · 块 ' + (d.blocks ?? '?')
					+ ' · 可靠块名 ' + (n.named ?? '?') + '/' + (n.total ?? '?'),
			};
		}

		/** 每类漂移的一句话明细（纯函数；不可靠时如实说"未出"，绝不假装看过）。 */
		function fitAuditDetail(cat, f) {
			if (!f || f.suppressed) return '未出明细（' + String((f && f.reason) || '判不可靠') + '）';
			if (cat === 'componentSpec') {
				if (!f.drift) {
					return (f.converged || 0) + ' 个跨稿组件的圆角/高度各自收敛'
						+ '（参与 ' + (f.participatedNames || 0) + ' 个组件名 / ' + (f.participatedBlocks || 0) + ' 块）';
				}
				const rows = (f.findings || []).slice(0, 3).map((it) => {
					const dims = (it.dims || []).slice(0, 2).map((dd) => dd.label + ' '
						+ (dd.values || []).slice(0, 3).map((v) => v.value + '(' + v.count + ')').join(' · ')
						+ ' → 建议 ' + dd.majority).join('；');
					return it.name + '（' + it.images + ' 张 / ' + it.blocks + ' 块）：' + dims;
				});
				const more = (f.findingCount || 0) - rows.length;
				return rows.join(' ｜ ') + (more > 0 ? ' ｜ …还有 ' + more + ' 个组件' : '');
			}
			if (cat === 'fontScale') {
				return f.distinct + ' 种字号（共 ' + f.total + ' 处）· 常用档 ' + ((f.ladder || []).join('/') || '—')
					+ ((f.oneOffs || []).length
						? ' · 只出现 1 次的野值 ' + f.oneOffs.map((v) => v.value).join('/')
						: ' · 没有只出现 1 次的野值');
			}
			if (cat === 'colorDrift') {
				if (!f.drift) return f.distinct + ' 个色值两两 RGB 距离都 > ' + f.threshold;
				const cs = (f.clusters || []).slice(0, 2).map((c) => (c.members || []).map((m) => m.key).join(' ≈ ') + ' → 建议 ' + c.majority);
				return f.clusterCount + ' 组近重复色（阈值 ' + f.threshold + '）：' + cs.join(' ｜ ');
			}
			if (cat === 'spacingScale') {
				return '栅格 ' + f.grid + 'px · 野值 ' + f.offGridCount + '/' + f.total + ' 处'
					+ ((f.offGrid || []).length ? '（如 ' + (f.offGrid || []).slice(0, 4).map((v) => v.value + 'px×' + v.count).join('、') + '）' : '');
			}
			if (cat === 'radiusFamily') {
				return f.distinct + ' 种圆角 · 不在常见刻度上的 ' + f.offScaleCount + '/' + f.total + ' 处'
					+ ((f.offScale || []).length ? '（如 ' + (f.offScale || []).slice(0, 4).map((v) => v.value + 'px×' + v.count).join('、') + '）' : '');
			}
			return '';
		}

		/** 项目下拉：账号索引里所有项目去重（不额外发请求 —— 账号 Tab 已经拉过 /lanhu/accounts）。 */
		function fitProjectOptions(s) {
			const seen = {};
			const out = [{ value: '', label: '（选一个项目）' }];
			for (const a of ((s.accounts && s.accounts.accounts) || [])) {
				for (const p of (a.projects || [])) {
					if (!p.projectId || seen[p.projectId]) continue;
					seen[p.projectId] = true;
					out.push({ value: p.projectId, label: (p.name || p.projectId) + '（' + (a.alias || '') + '）' });
				}
			}
			return out;
		}

		/* ── 取数：短请求直取；两个长任务走 fitBegin/fitFetch（可取消、有超时、结果可作废） ── */

		let fitToken = null;        // 当前在飞的那一次（取消或新一轮都靠它作废旧回调）
		let fitTimedOut = false;

		function fitBegin() {
			let ctl = null;
			try { ctl = new AbortController(); } catch { ctl = null; }   // 老浏览器：不能真断，但仍能作废回调
			const token = { ctl, timer: null };
			fitToken = token;
			fitTimedOut = false;
			try {
				token.timer = setTimeout(() => {
					fitTimedOut = true;
					try { if (ctl) ctl.abort(); } catch { /* 忽略 */ }
				}, FIT_TIMEOUT_MS);
				// Node 侧（自检里跑真代码）别让这个定时器把进程吊住
				if (token.timer && typeof token.timer.unref === 'function') token.timer.unref();
			} catch { /* 忽略 */ }
			return token;
		}

		function fitEnd(token) {
			try { if (token && token.timer) clearTimeout(token.timer); } catch { /* 忽略 */ }
			if (fitToken === token) fitToken = null;
		}

		function fitFetch(token, url, options) {
			const opts = Object.assign({}, options || {});
			if (token && token.ctl) opts.signal = token.ctl.signal;
			return jsonFetch(url, opts);
		}

		/** 超时/取消/真失败要分清 —— 报错说不出是哪种，用户就只能猜。 */
		function fitFailMessage(e) {
			if (fitTimedOut) {
				return '等待超过 ' + Math.round(FIT_TIMEOUT_MS / 60000) + ' 分钟，面板已放弃等待（Host 那边可能还在扫）';
			}
			if (e && e.name === 'AbortError') return '已取消等待（Host 那一次请求会自然跑完）';
			return String((e && e.message) || e);
		}

		/** 取消：面板立刻回到可点状态，这次的结果作废。**不改写"Host 会跑完"这个事实。** */
		function cancelFit() {
			const token = fitToken;
			try { if (token && token.ctl) token.ctl.abort(); } catch { /* 忽略 */ }
			fitToken = null;
			const s = snapshot();
			const patch = { diffLoading: false, auditLoading: false, diffSecs: 0, auditSecs: 0 };
			if (s.diffLoading) patch.diffError = '已取消等待：Host 那一次请求会自然跑完（面板不再等它）。';
			if (s.auditLoading) patch.auditError = '已取消等待：Host 那一次请求会自然跑完（面板不再等它）——想真少扫，把「扫描张数」调小。';
			set(patch);
			fitEnd(token);
		}

		/** 列稿（给「变更」区的稿下拉）。`target` 给 {url} 或 projectId 字符串。 */
		function loadFitDesigns(target) {
			const q = (target && target.url)
				? '?url=' + encodeURIComponent(target.url)
				: '?pid=' + encodeURIComponent(String(target || ''));
			set({ fitDesignsLoading: true, fitDesignsError: null });
			return jsonFetch(API + '/designs' + q, { headers: { accept: 'application/json' } })
				.then((j) => {
					if (j && j.ok) {
						const d = j.data || {};
						const cur = snapshot();
						const images = d.images || [];
						set({
							fitDesignsLoading: false, fitDesigns: d, fitDesignsError: null,
							fitProject: d.projectId || cur.fitProject,
							// 链接里带了 image_id → 直接选中它；否则清掉（换了项目，旧的稿 id 不再适用）
							fitImage: d.imageId && images.some((i) => i.imageId === d.imageId)
								? d.imageId
								: (images.some((i) => i.imageId === cur.fitImage) ? cur.fitImage : ''),
							fitVersions: null, fitFrom: '', fitTo: '',
						});
					} else {
						set({ fitDesignsLoading: false, fitDesigns: null, fitDesignsError: (j && j.error) || '列稿失败' });
					}
					return j;
				})
				.catch((e) => {
					set({ fitDesignsLoading: false, fitDesigns: null, fitDesignsError: String((e && e.message) || e) });
					return null;
				});
		}

		/** 版本列表（diff 的起点/终点下拉）。`target` 给 {url} 或 {projectId, imageId}。 */
		function loadFitVersions(target) {
			const t = target || {};
			const q = t.url
				? '?url=' + encodeURIComponent(t.url)
				: '?pid=' + encodeURIComponent(String(t.projectId || '')) + '&iid=' + encodeURIComponent(String(t.imageId || ''));
			set({ fitVersionsLoading: true, fitVersionsError: null });
			return jsonFetch(API + '/versions' + q, { headers: { accept: 'application/json' } })
				.then((j) => {
					if (j && j.ok) {
						const d = j.data || {};
						const vs = d.versions || [];
						set({
							fitVersionsLoading: false, fitVersions: d, fitVersionsError: null,
							fitProject: d.projectId || snapshot().fitProject,
							fitImage: d.imageId || snapshot().fitImage,
							// 默认：起点 = 上一版（只有一版时就用它自己），终点 = 最新版
							fitFrom: vs.length > 1 ? String(vs[1].id) : (vs[0] ? String(vs[0].id) : ''),
							fitTo: vs[0] ? String(vs[0].id) : '',
						});
					} else {
						set({ fitVersionsLoading: false, fitVersions: null, fitVersionsError: (j && j.error) || '取版本失败' });
					}
					return j;
				})
				.catch((e) => {
					set({ fitVersionsLoading: false, fitVersions: null, fitVersionsError: String((e && e.message) || e) });
					return null;
				});
		}

		/** 选项目：清掉从属于旧项目的一切（稿 / 版本 / 上次结论），免得张冠李戴。 */
		function pickFitProject(projectId) {
			set({
				fitProject: projectId || '', fitImage: '', fitDesigns: null, fitDesignsError: null,
				fitVersions: null, fitVersionsError: null, fitFrom: '', fitTo: '',
			});
			if (projectId) loadFitDesigns(projectId);
		}

		/** 用链接定位：稿链接会连版本一起读好（用户最常贴的就是某张稿的地址）。 */
		function useFitLink() {
			const link = snapshot().fitLink.trim();
			if (!link) {
				set({ fitDesignsError: '先粘贴一条蓝湖链接（或直接选上面的项目）' });
				return Promise.resolve(null);
			}
			return loadFitDesigns({ url: link }).then(() => {
				const d = snapshot().fitDesigns;
				return d && d.imageId ? loadFitVersions({ url: link }) : null;
			});
		}

		/** 变更：同一张稿两个版本（长任务）。 */
		function runDiff() {
			const s = snapshot();
			if (!s.fitFrom) {
				set({ diffError: '先「读取版本」再选一个起点版本 —— 版本 id 只能从版本列表里来（粘贴的 id 不认）' });
				return Promise.resolve(null);
			}
			if (!s.fitProject || !s.fitImage) {
				set({ diffError: '先选一张稿：在上面的项目下拉里选项目 → 再选稿；或贴一条**某张稿**的链接点「用链接定位」' });
				return Promise.resolve(null);
			}
			const token = fitBegin();
			set({ diffLoading: true, diffError: null, diffHint: null, diff: null, diffSecs: 0, fitCopied: null });
			return fitFetch(token, API + '/diff', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					projectId: s.fitProject, imageId: s.fitImage,
					from: s.fitFrom, to: s.fitTo || undefined,
					includeNoise: !!s.diffNoise,
				}),
			})
				.then((j) => {
					if (fitToken !== token) return null;      // 已取消 / 已被新一轮取代 → 丢弃
					fitEnd(token);
					if (j && j.ok) {
						set({ diffLoading: false, diff: j.data, diffError: null, diffHint: null });
						refreshLog();
					} else {
						set({ diffLoading: false, diff: null, diffError: (j && j.error) || '对比失败', diffHint: (j && j.hint) || null });
					}
					return j;
				})
				.catch((e) => {
					if (fitToken !== token) return null;
					fitEnd(token);
					set({ diffLoading: false, diff: null, diffError: fitFailMessage(e), diffHint: null });
					return null;
				});
		}

		/** 一致性：跨稿审计（最长的任务；张数在客户端也夹一次）。 */
		function runAudit() {
			const s = snapshot();
			const link = s.fitLink.trim();
			if (!s.fitProject && !link) {
				set({ auditError: '先选一个项目（上面的下拉），或贴一条蓝湖链接' });
				return Promise.resolve(null);
			}
			const limit = fitAuditLimit(s);
			const token = fitBegin();
			set({ auditLoading: true, auditError: null, auditHint: null, audit: null, auditSecs: 0, fitCopied: null });
			return fitFetch(token, API + '/audit', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					projectId: s.fitProject || undefined,
					url: s.fitProject ? undefined : link,
					limit,
					includeNoise: !!s.auditNoise,
				}),
			})
				.then((j) => {
					if (fitToken !== token) return null;
					fitEnd(token);
					if (j && j.ok) {
						set({ auditLoading: false, audit: j.data, auditError: null, auditHint: null });
						refreshLog();
					} else {
						set({ auditLoading: false, audit: null, auditError: (j && j.error) || '审计失败', auditHint: (j && j.hint) || null });
					}
					return j;
				})
				.catch((e) => {
					if (fitToken !== token) return null;
					fitEnd(token);
					set({ auditLoading: false, audit: null, auditError: fitFailMessage(e), auditHint: null });
					return null;
				});
		}

		/** 复制：优先走剪贴板；不可用（沙箱/隐私模式）就只给"已复制"提示 —— 原文区本来就能手选。 */
		function copyFitReport(text, key) {
			set({ fitCopied: key });
			try {
				if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
					const p = navigator.clipboard.writeText(String(text || ''));
					if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略：还有手选这条路 */ });
				}
			} catch { /* 忽略 */ }
			try {
				const t = setTimeout(() => { if (snapshot().fitCopied === key) set({ fitCopied: null }); }, 2500);
				if (t && typeof t.unref === 'function') t.unref();
			} catch { /* 忽略 */ }
		}

		/* ── 小件（与「账号」Tab 同一套皮肤：同样的边距/字号/输入框样式） ── */

		function fitCard(title, hint, children) {
			return React.createElement('div', {
				style: { border: '1px solid ' + C.borderSoft, borderRadius: '8px', padding: '8px 9px', marginBottom: '10px' },
			},
				React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', marginBottom: '6px' } },
					React.createElement('strong', { style: { fontSize: '12px' } }, title),
					hint ? React.createElement('span', { style: { color: C.dim, fontSize: '11px' } }, hint) : null,
				),
				children,
			);
		}

		function fitField(label, control) {
			return React.createElement('div', { style: { marginBottom: '5px' } },
				React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginBottom: '2px' } }, label),
				control,
			);
		}

		function fitSelect(props) {
			const list = (props.options || []).slice();
			const cur = props.value == null ? '' : String(props.value);
			// 值不在选项里（例如贴了一条"索引里没有的项目"的链接）时**补一条**：
			// 否则 <select> 会显示成第一项，界面与真实状态不一致 —— 用户会以为"没选中"，
			// 而实际上后面两个按钮用的是状态里那个 id。
			if (cur && !list.some((o) => String(o.value) === cur)) {
				list.push({ value: cur, label: '（已定位）' + cur.slice(0, 8) });
			}
			return React.createElement('select', {
				value: cur,
				onChange: props.onChange,
				disabled: !!props.disabled,
				'data-dsh-part': props.part,
				style: {
					width: '100%', boxSizing: 'border-box', maxWidth: '100%',
					border: '1px solid ' + C.border, borderRadius: '6px',
					background: 'transparent', color: C.text,
					font: 'inherit', fontSize: '12px', padding: '3px 6px',
				},
			}, list.map((o) => React.createElement('option', {
				key: String(o.value), value: String(o.value),
			}, o.label)));
		}

		function fitInput(props) {
			return React.createElement('input', {
				value: props.value, onChange: props.onChange, placeholder: props.placeholder,
				type: props.type || 'text', min: props.min, max: props.max,
				'data-dsh-part': props.part,
				style: {
					width: '100%', boxSizing: 'border-box',
					border: '1px solid ' + C.border, borderRadius: '6px',
					background: 'transparent', color: C.text,
					font: props.mono ? MONO : 'inherit', fontSize: '12px', padding: '3px 6px',
				},
			});
		}

		/** 跑起来那条：按钮禁用 + 一句进度（只出现在正在跑的那个功能下面）。 */
		function fitRunningRow(s, kind) {
			const text = fitRunningText(s, kind);
			if (!text) return null;
			return React.createElement('div', {
				'data-dsh-part': 'fit-running-' + kind,
				style: { color: C.brand, fontSize: '12px', marginTop: '6px', lineHeight: '1.6' },
			}, text);
		}

		function fitErrorRow(err, hint) {
			const m = fitErrorModel(err);
			if (!m) return null;
			return React.createElement('div', {
				'data-dsh-part': 'fit-error',
				style: { color: m.color, fontSize: '12px', marginTop: '6px', lineHeight: '1.6' },
			},
				m.text,
				hint ? React.createElement('div', { style: { color: C.dim, marginTop: '3px' } }, hint) : null,
			);
		}

		/** 结论不可靠时顶在最上面那条（不可靠 → 后端故意不出明细，这里必须说清）。 */
		function fitBannerRow(kind, d) {
			const b = fitUnreliableBanner(kind, d);
			if (!b) return null;
			return React.createElement('div', {
				'data-dsh-part': kind === 'diff' ? 'fit-diff-unreliable' : 'fit-audit-unreliable',
				role: 'alert',
				style: {
					marginTop: '8px', padding: '6px 8px',
					border: '1px solid ' + C.warn, borderRadius: '6px',
					background: C.brandSoft, color: C.warn,
					fontSize: '12px', lineHeight: '1.6',
				},
			},
				b.text,
				b.detail ? React.createElement('div', { style: { color: C.dim, marginTop: '3px', fontSize: '11px' } }, b.detail) : null,
			);
		}

		/** 报告出口：可复制的按钮 + 可手选的纯文本原文（长报告默认收起）。 */
		function fitReportActions(key, text, showRaw, toggleRaw) {
			return React.createElement('div', null,
				React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' } },
					React.createElement(Btn, {
						label: showRaw.ready ? '已复制' : '复制报告',
						onClick: () => copyFitReport(text, key),
						title: '复制纯文本报告，直接粘给 AI',
					}),
					React.createElement(Btn, { label: showRaw.open ? '收起原文' : '看原文', onClick: toggleRaw }),
					React.createElement('span', { style: { color: C.dim, fontSize: '11px' } }, '纯文本，可直接喂 AI'),
				),
				showRaw.open ? React.createElement('textarea', {
					readOnly: true, value: text || '', rows: 8,
					'data-dsh-part': key === 'diff' ? 'fit-diff-raw' : 'fit-audit-raw',
					onFocus: (e) => { try { e.target.select(); } catch { /* 忽略 */ } },
					style: {
						width: '100%', boxSizing: 'border-box', marginTop: '4px', resize: 'vertical',
						border: '1px solid ' + C.border, borderRadius: '6px',
						background: 'transparent', color: C.text, font: MONO, padding: '5px 7px',
					},
				}) : null,
			);
		}

		/** 目标项目（两个功能共用）：下拉来自账号索引，另给一条「贴链接」的兜底。 */
		function FitTargetBlock(props) {
			const s = props.state;
			const busy = s.diffLoading || s.auditLoading;
			const opts = fitProjectOptions(s);
			return fitCard('目标项目', '下面两个功能都用它', React.createElement('div', null,
				fitSelect({
					part: 'fit-project', value: s.fitProject, disabled: busy, options: opts,
					onChange: (e) => pickFitProject(e.target.value),
				}),
				opts.length <= 1 ? React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginTop: '3px' } },
					'索引里还没有项目（去「账号」Tab 点「重建索引」），或直接在下面贴一条蓝湖链接。') : null,
				React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '5px' } },
					React.createElement('div', { style: { flex: '1', minWidth: 0 } },
						fitInput({
							part: 'fit-link', value: s.fitLink, mono: true,
							placeholder: '或贴一条蓝湖链接（稿链接 / 项目链接都行）',
							onChange: (e) => set({ fitLink: e.target.value }),
						})),
					React.createElement(Btn, {
						label: s.fitDesignsLoading ? '定位中…' : '用链接定位',
						disabled: busy || s.fitDesignsLoading,
						onClick: useFitLink,
					}),
				),
			));
		}

		function FitDiffSection(props) {
			const s = props.state;
			const busy = s.diffLoading || s.auditLoading;
			const d = s.diff;
			const versions = (s.fitVersions && s.fitVersions.versions) || [];
			const images = (s.fitDesigns && s.fitDesigns.images) || [];
			const counts = (d && d.counts) || {};
			const changed = (d && d.counts && d.counts.changed) || {};

			const rows = [];
			if (d && d.reliable) {
				Object.keys(DIFF_CAT_LABEL).forEach((cat) => {
					const list = (d.changes && d.changes[cat]) || [];
					if (list.length === 0) return;
					rows.push(React.createElement('div', { key: cat, style: { marginTop: '4px' } },
						React.createElement('div', { style: { color: C.sub, fontSize: '11px' } }, DIFF_CAT_LABEL[cat] + '：' + list.length + ' 处'),
						list.slice(0, 6).map((e, i) => React.createElement('div', {
							key: cat + '-' + i,
							style: { color: C.dim, fontSize: '11px', paddingLeft: '8px', wordBreak: 'break-all' },
						}, (e.where || e.name || '(无名)') + ' · ' + e.label)),
					));
				});
			}

			return fitCard('变更（设计变更 diff）', '同一张稿的两个版本', React.createElement('div', null,
				React.createElement('div', { style: { display: 'flex', gap: '6px' } },
					React.createElement('div', { style: { flex: '1', minWidth: 0 } },
						fitField('稿' + (s.fitDesignsLoading ? '（读取中…）' : ''),
							fitSelect({
								part: 'fit-design', value: s.fitImage, disabled: busy || images.length === 0,
								options: [{ value: '', label: images.length ? '（选一张稿）' : '（先用上面对的项目定位）' }]
									.concat(images.map((i) => ({ value: i.imageId, label: i.name || i.imageId }))),
								onChange: (e) => {
									const iid = e.target.value;
									set({ fitImage: iid, fitVersions: null, fitFrom: '', fitTo: '' });
									if (iid) loadFitVersions({ projectId: snapshot().fitProject, imageId: iid });
								},
							}))),
					React.createElement('div', { style: { flex: 'none', alignSelf: 'flex-end' } },
						React.createElement(Btn, {
							label: '读取版本', disabled: busy || !s.fitImage,
							onClick: () => loadFitVersions({ projectId: s.fitProject, imageId: s.fitImage }),
						})),
				),
				s.fitDesignsError ? React.createElement('div', { style: { color: C.err, fontSize: '11px', marginTop: '4px' } }, '❌ ' + s.fitDesignsError) : null,
				s.fitVersionsError ? React.createElement('div', { style: { color: C.err, fontSize: '11px', marginTop: '4px' } }, '❌ ' + s.fitVersionsError) : null,
				versions.length === 0 ? React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginTop: '4px' } },
					s.fitVersionsLoading ? '⏳ 正在读版本列表…' : '还没读到版本（选一张稿 → 点「读取版本」）') : React.createElement('div', { style: { marginTop: '5px' } },
					fitField('起点版本（from，必填）', fitSelect({
						part: 'fit-from', value: s.fitFrom, disabled: busy,
						options: versions.map((v, i) => ({
							value: String(v.id),
							label: (i === 0 ? '最新' : '第 ' + (i + 1) + ' 版') + ' · ' + String(v.id).slice(0, 8) + (v.info ? ' · ' + v.info : '') + (v.hasLayoutData ? '' : '（无图层数据）'),
						})),
						onChange: (e) => set({ fitFrom: e.target.value }),
					})),
					fitField('终点版本（to，默认最新）', fitSelect({
						part: 'fit-to', value: s.fitTo, disabled: busy,
						options: versions.map((v, i) => ({ value: String(v.id), label: (i === 0 ? '最新' : '第 ' + (i + 1) + ' 版') + ' · ' + String(v.id).slice(0, 8) })),
						onChange: (e) => set({ fitTo: e.target.value }),
					})),
				),
				React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' } },
					React.createElement(Btn, {
						label: s.diffLoading ? '对比中…' : '对比两个版本',
						primary: true, disabled: busy, onClick: runDiff,
					}),
					React.createElement(Btn, { label: '取消', disabled: !busy, onClick: cancelFit }),
					React.createElement('label', {
						style: { display: 'flex', alignItems: 'center', gap: '4px', color: C.dim, fontSize: '11px', cursor: 'pointer' },
						title: '默认与块级清单同一个折叠口径',
					},
						React.createElement('input', {
							type: 'checkbox', checked: !!s.diffNoise,
							onChange: (e) => set({ diffNoise: e.target.checked }),
						}),
						'含碎片',
					),
				),
				fitRunningRow(s, 'diff'),
				fitErrorRow(s.diffError, s.diffHint),
				fitBannerRow('diff', d),
				d ? React.createElement('div', { 'data-dsh-part': 'fit-diff-result', style: { marginTop: '6px' } },
					React.createElement('div', { style: { color: C.sub, fontSize: '12px', lineHeight: '1.6' } },
						d.identical
							? '✅ 两版一致（设计没改，代码可以不动）'
							: '变化 ' + (changed.blocks || 0) + ' 块 · 新增 ' + (counts.added || 0) + ' · 删除 ' + (counts.removed || 0) + ' · 未变 ' + (counts.unchanged || 0),
						React.createElement('div', { style: { color: C.dim, fontSize: '11px' } },
							(v => 'v' + String(v.from && v.from.id || '?').slice(0, 8) + ' → v' + String(v.to && v.to.id || '?').slice(0, 8)
								+ (v.gapDays != null ? '（相隔 ' + v.gapDays + ' 天）' : ''))(d)),
					),
					rows,
					(d.notes || []).map((n, i) => React.createElement('div', {
						key: 'note' + i, style: { color: C.dim, fontSize: '11px', marginTop: '3px', lineHeight: '1.5' },
					}, '注：' + n)),
					fitReportActions('diff', d.text, { open: s.fitRaw === 'diff', ready: s.fitCopied === 'diff' },
						() => set({ fitRaw: s.fitRaw === 'diff' ? null : 'diff' })),
				) : null,
			));
		}

		function FitAuditSection(props) {
			const s = props.state;
			const busy = s.diffLoading || s.auditLoading;
			const a = s.audit;
			const limit = fitAuditLimit(s);
			const cats = [];
			if (a) {
				for (const cat of Object.keys(AUDIT_CAT_LABEL)) {
					const f = (a.findings || {})[cat] || {};
					const drift = f.drift === true;
					cats.push(React.createElement('div', {
						key: cat,
						style: { marginTop: '4px', borderTop: '1px solid ' + C.borderSoft, paddingTop: '4px' },
					},
						React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
							React.createElement('span', { style: { color: C.text, fontSize: '12px' } }, AUDIT_CAT_LABEL[cat]),
							React.createElement('span', { style: { color: f.suppressed ? C.dim : (drift ? C.warn : C.ok), fontSize: '11px' } },
								f.suppressed ? '未出（不可靠）' : (drift ? '漂移' : '收敛')),
						),
						React.createElement('div', { style: { color: C.dim, fontSize: '11px', lineHeight: '1.5', wordBreak: 'break-all' } },
							fitAuditDetail(cat, f)),
					));
				}
			}

			return fitCard('一致性（跨稿审计）', '扫整个项目的多张稿', React.createElement('div', null,
				React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
					React.createElement('div', { style: { width: '104px', flex: 'none' } },
						fitField('扫描张数（默认 ' + FIT_LIMIT_DEFAULT + '）', fitInput({
							part: 'fit-audit-limit', type: 'number', min: 1, max: FIT_LIMIT_HARD,
							value: s.auditLimit,
							onChange: (e) => set({ auditLimit: e.target.value }),
						}))),
					React.createElement('div', { style: { flex: '1', color: C.dim, fontSize: '11px', lineHeight: '1.5', paddingBottom: '3px' } },
						'成本 = 张数 × 2 次请求，本次约 ' + (limit * 2) + ' 次；硬上限 ' + FIT_LIMIT_HARD + '。扫的是整个项目，不只是选中那张稿。'),
				),
				React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px' } },
					React.createElement(Btn, {
						label: s.auditLoading ? '审计中…' : '开始审计',
						primary: true, disabled: busy, onClick: runAudit,
					}),
					React.createElement(Btn, { label: '取消', disabled: !busy, onClick: cancelFit }),
					React.createElement('label', {
						style: { display: 'flex', alignItems: 'center', gap: '4px', color: C.dim, fontSize: '11px', cursor: 'pointer' },
					},
						React.createElement('input', {
							type: 'checkbox', checked: !!s.auditNoise,
							onChange: (e) => set({ auditNoise: e.target.checked }),
						}),
						'含碎片',
					),
				),
				fitRunningRow(s, 'audit'),
				fitErrorRow(s.auditError, s.auditHint),
				fitBannerRow('audit', a),
				a ? React.createElement('div', { 'data-dsh-part': 'fit-audit-result', style: { marginTop: '6px' } },
					React.createElement('div', { style: { color: C.sub, fontSize: '12px', lineHeight: '1.6' } },
						'扫描 ' + a.scanned + '/' + a.total + ' 张' + (a.truncated ? '（被上限截断）' : '')
						+ ' · 读到图层 ' + a.imagesWithLayers + ' 张 · 块 ' + a.blocks
						+ ' · 可靠块名 ' + ((a.naming && a.naming.named) || 0) + '/' + ((a.naming && a.naming.total) || 0)),
					a.anyDrift === false ? React.createElement('div', { style: { color: C.ok, fontSize: '12px', marginTop: '3px' } },
						'✅ 未发现漂移：' + (a.noDriftBrief || []).join('；')) : null,
					cats,
					a.skippedBrief ? React.createElement('div', { style: { color: C.dim, fontSize: '11px', marginTop: '4px' } },
						'没扫成的：' + a.skippedBrief) : null,
					fitReportActions('audit', a.text, { open: s.fitRaw === 'audit', ready: s.fitCopied === 'audit' },
						() => set({ fitRaw: s.fitRaw === 'audit' ? null : 'audit' })),
				) : null,
			));
		}

		function FitTab(props) {
			const s = props.state;
			// 秒表：只在真浏览器里转（自检用的 React 替身里 useEffect 是空实现 → 不会起定时器）。
			React.useEffect(() => {
				if (!s.diffLoading && !s.auditLoading) return undefined;
				let n = 0;
				const t = setInterval(() => {
					n += 1;
					const cur = snapshot();
					const patch = {};
					if (cur.diffLoading) patch.diffSecs = n;
					if (cur.auditLoading) patch.auditSecs = n;
					if (Object.keys(patch).length > 0) set(patch);
				}, 1000);
				return () => { try { clearInterval(t); } catch { /* 忽略 */ } };
			}, [s.diffLoading, s.auditLoading]);

			return React.createElement('div', { 'data-dsh-part': 'fit' },
				React.createElement('div', { style: { color: C.dim, fontSize: '11px', lineHeight: '1.6', marginBottom: '8px' } },
					'项目级体检：① 变更 = 同一张稿两个版本比「这次设计改了什么」；② 一致性 = 扫一个项目的多张稿看设计系统漂没漂。',
					React.createElement('br'),
					'两者都可能跑十几秒到几分钟：跑起来按钮会禁用并显示进度，随时可「取消」。结论不可靠时会在最上面标出来，不硬凑明细。'),
				React.createElement(Safe, { label: '目标项目' }, React.createElement(FitTargetBlock, { state: s })),
				React.createElement(Safe, { label: '变更' }, React.createElement(FitDiffSection, { state: s })),
				React.createElement(Safe, { label: '一致性' }, React.createElement(FitAuditSection, { state: s })),
			);
		}

		/* ═══════════════ 13. 面板（shell.overlay） ═══════════════ */

		/**
		 * 标题栏版本自述的**纯函数**模型 —— 渲染与判断分开，自检能离屏断言（React 由壳提供，自检里拿不到）。
		 * null 表示「什么都不显示」（拿不到版本就静默降级，不占位、不报错）。
		 */
		function versionTagModel(state) {
			const v = state && typeof state.ver === 'string' && state.ver ? state.ver : null;
			if (!v) return null;
			const update = state.verUpdate === true;
			return {
				text: 'v' + v,
				update,
				title: update ? 'npm 上已有新版本（当前 v' + v + '）' : '当前版本 v' + v,
			};
		}

		/**
		 * 标题栏右边的小字：当前版本（必显）+ 「有更新」的一个轻提示（小圆点，hover 给 title）。
		 * **不显示最新版本号**；颜色一律走主题令牌 + fallback（写死会在深色皮肤下看不清）。
		 */
		function VersionTag(props) {
			const m = versionTagModel(props && props.state);
			if (!m) return null;
			return React.createElement('span', {
				'data-dsh-part': 'version',
				title: m.title,
				style: { display: 'inline-flex', alignItems: 'center', gap: '4px', flex: 'none' },
			},
				React.createElement('span', {
					style: { color: C.dim, fontSize: '11px', fontWeight: '400', lineHeight: '1' },
				}, m.text),
				m.update ? React.createElement('span', {
					'data-dsh-part': 'version-update',
					'aria-label': 'npm 上已有新版本',
					title: 'npm 上已有新版本',
					style: {
						flex: 'none', display: 'inline-block', width: '6px', height: '6px',
						borderRadius: '50%', background: C.brand,
					},
				}) : null,
			);
		}

		function LanhuOverlay() {
			const s = useLanhu();
			const panelRef = React.useRef(null);
			const prevFocus = React.useRef(null);

			// ④ 浮层的对话框语义：Esc 关闭 + 打开时移焦、关闭时还焦。
			//    所有 hook 必须写在下面的提前 return 之前，否则 hook 数量会随开关变化。
			//    全部包 try-catch —— Client 半边抛错会让整个壳起不来。
			React.useEffect(() => {
				if (!s.open) return undefined;
				try { prevFocus.current = document.activeElement; } catch { prevFocus.current = null; }
				let timer = null;
				try {
					timer = setTimeout(() => {
						try { if (panelRef.current) panelRef.current.focus(); } catch { /* 忽略 */ }
					}, 0);
				} catch { /* 忽略 */ }
				const onKey = (e) => {
					const k = e && e.key;
					if (k === 'Escape' || k === 'Esc') {
						try { e.stopPropagation(); } catch { /* 忽略 */ }
						set({ open: false });
					}
				};
				try { document.addEventListener('keydown', onKey, true); } catch { /* 忽略 */ }
				return () => {
					try { if (timer) clearTimeout(timer); } catch { /* 忽略 */ }
					try { document.removeEventListener('keydown', onKey, true); } catch { /* 忽略 */ }
					try {
						const el = prevFocus.current;
						if (el && typeof el.focus === 'function' && document.contains(el)) el.focus();
					} catch { /* 忽略 */ }
				};
			}, [s.open]);

			if (!s.open) return null;

			const tabs = [
				{ id: 'blocks', label: '块级' },
				{ id: 'status', label: '账号' },
				{ id: 'log', label: '记录' },
				{ id: 'fit', label: '体检' },
			];

			const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
			const maxW = 'min(460px, calc(100vw - 32px))';

			return React.createElement('div', {
				ref: panelRef,
				'data-dsh-plugin': 'dsh-lanhu',
				'data-dsh-part': 'panel',
				// ④ 浮层要有对话框语义，否则读屏软件只当它是一堆散落的 div
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': '蓝湖设计稿面板',
				tabIndex: -1,
				style: {
					// 坑 1：贴着侧栏里的入口（左边缘对齐入口，底边停在入口上方 8px）。
					// 不用 right —— 那会把面板甩到屏幕另一头（用户实测反馈）。
					position: 'fixed',
					left: (entryRect ? Math.max(8, entryRect.left) : 16) + 'px',
					bottom: (entryRect ? (vh - entryRect.top + 8) : 16) + 'px',
					zIndex: 2147483000,
					pointerEvents: 'auto',           // 坑 2：overlay 本体是 click-through
					width: maxW, maxHeight: '78vh',
					display: 'flex', flexDirection: 'column',
					background: C.surface,
					color: C.text,
					border: '1px solid ' + C.border,
					borderRadius: '10px',
					boxShadow: '0 10px 32px rgba(0,0,0,0.22)',
					font: FONT,
					outline: 'none',
				},
			},
				// 头部
				React.createElement('div', {
					style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px 8px', borderBottom: '1px solid ' + C.borderSoft },
				},
					React.createElement(Icon, { size: 16 }),
					// 标题 + 版本自述同一个 flex 容器：容器占满剩余宽度（✕ 仍在最右），版本紧跟标题之后
					React.createElement('span', {
						style: { flex: '1', display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
					},
						React.createElement('strong', { style: { fontSize: '13px' } }, '蓝湖设计稿'),
						React.createElement(VersionTag, { state: s }),
					),
					React.createElement('button', {
						type: 'button', 'aria-label': '关闭', title: '关闭（Esc）',
						'data-dsh-part': 'close',
						onClick: () => set({ open: false }),
						// ⑤ 命中区 14×16px 太小（WCAG 2.5.8 要求 ≥24×24），补到 26×26
						style: {
							flex: 'none', width: '26px', height: '26px', padding: 0,
							display: 'flex', alignItems: 'center', justifyContent: 'center',
							border: 'none', borderRadius: '6px', background: 'transparent',
							color: C.dim, cursor: 'pointer', font: 'inherit', fontSize: '16px', lineHeight: '1',
						},
						onMouseEnter: (e) => { e.currentTarget.style.background = C.hover; },
						onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; },
					}, '×'),
				),
				// Tab 条
				React.createElement('div', {
					style: { display: 'flex', gap: '2px', padding: '6px 14px 0', borderBottom: '1px solid ' + C.borderSoft },
				}, tabs.map((t) => React.createElement('button', {
					key: t.id, type: 'button',
					'data-dsh-part': 'tab-' + t.id,
					onClick: () => {
						set({ tab: t.id });
						if (t.id === 'log' && !s.log && !s.logLoading) refreshLog();
						if (t.id === 'status' && !s.accounts && !s.accountsLoading) refreshAccounts();
						// 「体检」的项目下拉来自账号索引 —— 没索引进来就只有一个空下拉，先把账号拉一次
						if (t.id === 'fit' && !s.accounts && !s.accountsLoading) refreshAccounts();
					},
					style: {
						border: 'none', background: 'transparent', cursor: 'pointer',
						padding: '4px 10px', font: 'inherit', fontSize: '12px',
						color: s.tab === t.id ? C.brand : C.sub,
						borderBottom: '2px solid ' + (s.tab === t.id ? C.brand : 'transparent'),
						marginBottom: '-1px',
					},
				}, t.label))),
				// 内容
				React.createElement('div', {
					// ⑦ 这里是**唯一**的滚动容器。原先块级/记录列表各自又套了一层 maxHeight+overflow，
					//    形成嵌套滚动条。改成内层不滚、只留这一层。
					style: { flex: '1', minHeight: '0', overflowY: 'auto', overscrollBehavior: 'contain', padding: '10px 14px 12px' },
				},
					React.createElement(Safe, { label: '块级' }, s.tab === 'blocks' ? React.createElement(BlocksTab, { state: s }) : null),
					React.createElement(Safe, { label: '账号' }, s.tab === 'status' ? React.createElement(AccountsTab, { state: s }) : null),
					React.createElement(Safe, { label: '记录' }, s.tab === 'log' ? React.createElement(LogTab, { state: s }) : null),
					React.createElement(Safe, { label: '体检' }, s.tab === 'fit' ? React.createElement(FitTab, { state: s }) : null),
				),
			);
		}

		/* ═══════════════ 13. 挂载 ═══════════════ */

		const inject = ['slots'];

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
				{ name: 'sidebar.footer.action', id: 'lanhu', order: 60, label: '蓝湖' },
				LanhuEntry,
			)), 'dsh-lanhu: sidebar entry');

			ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register(
				{ name: 'shell.overlay', id: 'lanhu-panel', order: 60, label: '蓝湖面板' },
				LanhuOverlay,
			)), 'dsh-lanhu: overlay');
		}

		exports.name = 'dsh-lanhu';
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});

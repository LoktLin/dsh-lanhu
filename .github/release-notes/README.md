# 发布清单（Releases）

> 这个目录只放**发布说明**，一个版本一个文件：`v<版本>.md`。
> 发布动作本身在 GitHub 网页上完成（本机没有 `gh` CLI，也没有 token），
> 把对应的 `v<版本>.md` **整段复制**贴进 Release 的描述框即可。

## 六步

1. **升版本号 —— 五处必须一起改**（4 个文件）：
   - `package.json` → `"version"`
   - `package-lock.json` → 顶上两处 `"version"`（根对象与 `packages[""]`）
   - `README.md` → 首屏 `**版本 \`x.y.z\`**`
   - `CHANGELOG.md` → 新章节标题 `## x.y.z —— …`
   > ✅ 这五处（含 `package-lock.json` 的 `packages[""]`）已由 `test/readme-test.mjs` **自动断言**，
   > 漏改一处就红。以前这步是纯靠人核的。
2. **改了工具就跑生成器**：`node tools/gen-readme-tools.mjs --write`
   （README 的「每个工具的完整说明」是从 `lib/index.js` 的 `TOOLS` 生成的，`readme-test` 逐字比对。）
3. **跑自检**：`node test/selfcheck.mjs` —— 459 项，**纯离线、秒级**，改完代码先跑它。
   `node test/readme-test.mjs` —— 32 项**文档绊线**：生成块是否最新 / `docs/` 链接是否存在且无孤立文件 /
   版本号五处是否一致 / 发布说明格式与公开纪律（不含本机路径）。
   （可选）插件脚手架自检：`node <dsh-plugin-mac 技能目录>/scripts/selftest.mjs --plugin .` —— 16 项，
   覆盖工具形状 / 路由信封 / lossless JSON / 本机守卫 / 槽位注册与回收。
   顺手核对 README 里写死的项数（**459 / 16**）有没有过期。
4. **写发布说明**：照上一个版本的文件格式新建 `v<新版本>.md`。
5. **提交并推送**：`git add -A && git commit -m "release: v<版本>" && git push origin main`。
6. **打 tag 并推送**（除了 `main`，这是唯一要推的东西）：
   `git tag -a v<版本> -m "dsh-lanhu <版本>"` 然后 `git push origin v<版本>`
   接着打开 `https://github.com/LoktLin/dsh-lanhu/releases/new?tag=v<版本>`，
   标题填 `v<版本>`，描述框粘贴第 4 步那份，Publish。

> ⚠️ **本机 ssh-agent 不常驻**：`git push` 若报 `Permission denied (publickey)`，显式指定密钥即可：
> `GIT_SSH_COMMAND='ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes' git push origin main`
> 本机另有网络插曲：GitHub **SSH 偶发不通**，重试通常就好；`github.com:443` 的下载通道**极慢**
> （实测 13MB 下 10 分钟仍未完成），但 `api.github.com` 与 SSH 正常。

## 发布说明的格式（与 DSH 仓库对齐）

- 第一行语言锚点：`[中文](#cn-v<版本>) | [English](#en-v<版本>)`
- 两侧的分节标题用**原始 HTML**（这样中英各有自己的 id，互不冲突）：
  `<h3 id="cn-v<版本>">新增功能</h3>` / `<h3 id="en-v<版本>">New Features</h3>`
- 四个分类、两侧同名同序：
  **新增功能 / 体验优化 / 问题修复 / 其他变更**
  （New Features / Improvements / Bug Fixes / Chores）
- 中间用 `---` 分隔中英两半；两半结尾各写一行 `Full Changelog` 指向 compare 链接
  （还没有上一个 tag 时，指向 `https://github.com/LoktLin/dsh-lanhu/commits/main`）
- **两边的数字必须一致**（百分比、对比度、测试项数……）；英文别写成机翻腔。

## 三条纪律

- **发布说明是唯一一份会被贴到 GitHub 上的文案** —— 它不能引用只有本机才有的路径或文档。
- **不要手改历史版本的说明**；要补充就等下个版本写清楚。
- **文档里的东西要么被断言守着，要么标出来**：`readme-test` 现在守生成块、`docs/` 链接与孤立文件、版本号五处、
  发布说明格式与公开纪律。**没被守着的数字（例如测试项数）会在发布时人工核一遍** —— 别假装它们是自动的。

## 已知空缺（写在这里，免得下次又"以为有"）

- 面板里有一条**死路由** `/lanhu/verify-blocks`：后端与 `recordUsage` 都写好了，
  注释写着「面板『块级』Tab 的『与页面比对』按钮用」，但那个按钮**从来没做**；`/lanhu/who` 同样没有前端入口。
  要么接上、要么删掉 —— **别留着当"以后再说"**。
- ~~`test/selfcheck.mjs` 不断言「声明的参数真的传给了实现」~~ —— **0.2.0 已补**：
  按源码区间逐字检查**全部 15 个工具的全部声明参数**（83 个），带显式白名单
  （`lanhu_accounts` / `lanhu_who` 的 `account` 属**注入但不适用**，不是漏传）。
  变异测试过了：把任一处 `args.x` 改掉就红（实测 `lanhu_read_design.limit` → 红）。

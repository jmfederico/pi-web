# PI WEB 文案清单与键名规则（阶段 0）

状态：规则已冻结；各区域条目在对应阶段 PR 迁移时逐条勾销。本清单与 `docs/localization-plugin-implementation-plan.md` 配套，是其验收口径的登记底册。

## 冻结规则

### 键名与命名空间

- 完整键 = `${namespace}.${namespace 内键}`。核心界面使用命名空间 `core`，核心默认词典见 `src/client/src/i18n/locales/en.ts`，其键已包含 `core.` 前缀。
- 项目自带浏览器插件按 `plugin.<插件id>` 提供英文默认文案（阶段 3），例如 `plugin.git.openFile`。
- 语言包的 `LocaleContribution.messages` 键为命名空间内局部键（不含命名空间前缀），宿主拼接为完整键。
- 键字符集：`[a-zA-Z0-9][a-zA-Z0-9._-]*`；命名空间：`[a-z][a-z0-9.-]*`；语言标签：标准 BCP 47 连字符形式（`zh-CN`），下划线形式在贡献声明中被拒绝。
- 核心词典当前分组前缀：`core.common.*`、`core.language.*`、`core.settings.*`。后续 PR 增补分组（如 `core.navigation.*`、`core.chat.*`、`core.dialog.*`、`core.notice.*`）时沿用 `core.<区域>.<条目>` 结构，不再改名已有键。

### 重复资源规则

- 同一 `(locale, namespace, key)` 只能有一个提供者。插件内部重复在校验阶段失败；跨插件重复在发布阶段按注册 id 顺序判定，后发布者失败并回滚（`registry.ts` `localePublishConflict`）。
- 同一 locale 的同一命名空间可由多个包按不相交键位联合提供；同一 locale 可由任意数量的命名空间组成。
- 资源合并层（`LocaleResourceStore.update`）对重复键抛出确定性错误，不做静默覆盖。

### 英文回退规则

- 英文是内建语言，不依赖任何语言包；`core` 命名空间英文默认词典静态编译进主应用。
- `t(key, params)` 在有效语言词典缺失该键时逐键回退英文；英文也缺失时开发环境经 `setMissingMessageKeyDiagnostics` 报告，运行显示键名本身。
- 语言包未加载、被禁用或加载失败：保留用户显式偏好，界面显示英文；资源恢复后自动回到所选语言。
- Auto 顺序匹配把英文视为始终可用（`["en-US", "zh-CN"]` → 英文）。

### 参数与安全

- 首版仅接受纯文本消息；动态值经 `{placeholder}` 插值进入模板，由 Lit 转义。禁止把译文作为 HTML 注入。

## 排除范围（不可译）

- 业务标识与路径：插件/贡献 id、URL、文件路径、终端 id、会话 id。
- 模型名称、提供商名称、命令行、代码、用户输入与用户内容。
- 会话与工具的原始输出、第三方插件未接入本地化的原文、原始错误详情（英文前缀可译，详情作为参数）。
- 浏览器在加载前读取的静态 PWA manifest 文案（单列后续议题）。

## 阶段 1（首个 PR）——设置页试点条目

`SettingsGeneralPanel.ts`（`src/client/src/components/settings/SettingsGeneralPanel.ts`）的已迁移条目：

| 键 | 英文默认 | 来源 | 参数 |
| --- | --- | --- | --- |
| `core.common.reload` | Reload | SettingsPanelFrame 操作按钮 | - |
| `core.settings.generalConfiguration` | General configuration | 面板标题 | - |
| `core.settings.generalDescription` | Gateway server fields edit this local gateway… | 面板说明 | `targetLabel` |
| `core.settings.languagePreference` | Language preference | 语言卡片标题 | - |
| `core.settings.languagePreferenceDescription` | This setting applies to the browser interface only… | 语言卡片说明 | - |
| `core.language.label` | Language | 字段标题 / aria-label | - |
| `core.language.auto` | Auto | 选项 | - |
| `core.language.english` | English | 选项 | - |
| `core.language.description` | Choose the interface language… | 字段说明 | - |
| `core.language.unavailable` | {label} (unavailable) | 已保存偏好但语言包缺失时的禁用选项 | `label` |

语言包选项列表由已安装资源生成（Auto、English、各语言包 label），不以硬编码中文选项存在。简体中文词典已移出主应用，位于 `locale-packs/pi-web-locale-zh-cn/`。

同面板中以下英文属于阶段 2 PR①（其余设置字段），本 PR 未迁移：Gateway server 卡片全部文案、Selected machine file access 卡片全部文案、Effective 摘要、override 徽标、保存/加载状态。

## 阶段 2 区域登记（按 PR 顺序）

条目在各区域 PR 中逐条登记为命名空间键并从此处勾销；下表为入口文件与登记口径。

| PR | 区域 | 入口（`src/client/src/` 下） | 备注 |
| --- | --- | --- | --- |
| ① | 剩余设置页 | `components/SettingsDialog.ts`、`components/settings/*`（general/sessiond/packages/plugins/shortcuts 各面板） | 含面板标题、说明、错误/成功提示、空状态 |
| ② | 导航、项目/工作区/会话 | `components/ProjectList.ts`、`WorkspaceList.ts`、`SessionList.ts`、`SessionTreeNavigator.ts`、`MachineList.ts`、`appShell/*`、`PiWebApp.ts` 内建动作标题（Focus Projects 等） | `PluginAction.title/group/description` 改为显示期解析，保留稳定 id 与快捷键 |
| ③ | 聊天、输入框、对话框 | `components/ChatView.ts`、`PromptEditor.ts`、`CommandPicker.ts`、`ActionPalette.ts`、`AuthDialog.ts`、`ModelPicker.ts`、`AskUserCard.ts`、`ExtensionDialogCard.ts`、`ProjectDialog.ts`、`MachineDialog.ts`、`SessionCleanupDialog.ts`、`ModalSurface.ts` | 命令搜索按当前显示语言；草稿/附件/对话框状态在切换时不丢失 |
| ④ | 通知、无障碍、状态 | `components/StatusBar.ts`、`errorBanner.ts`、`deprecatedAgentInputsBanner.ts`、各组件 aria-label/aria-live、`serverNotices.ts` 外壳 | 服务端正文属阶段 4 |

## 阶段 3 自带插件登记

六个自带浏览器插件的宿主文案（贡献标题、面板文本、操作、空状态、提示、无障碍）按 `plugin.<插件id>` 命名空间迁移，入口：

- `pi-web-plugins/terminal/`（`TerminalPanel.ts`、soft keys、copy snapshot）
- `pi-web-plugins/files/`（browser 包内面板与查看器外壳）
- `pi-web-plugins/git/browser/`（`git-panel.ts` 等）
- `pi-web-plugins/info/`、`pi-web-plugins/updates/`、`pi-web-plugins/workspace-tasks/`

公开插件上下文提供有生命周期的本地化服务（当前语言、查询、订阅），第三方插件可声明自己的默认文案与语言资源；未接入者保留原文。

## 阶段 4 服务端自有文案登记

- 浏览器错误前缀、Pi Web 状态消息、会话警告：改为 `code/id + params + 英文后备`，未知代码显示原文。
- 先改造依据 `notice.message` 相等的业务匹配为稳定标识，再翻译正文（见计划阶段 4）。
- `ChatView.ts` 等日期/数字格式化器随有效语言重建或缓存。

## 维护

- 新增英文 UI 字符串必须同时登记本清单并指明 PR 归属；阶段 5 引入静态扫描拦截未登记的固定英文。
- 本清单的勾销状态以各区域 PR 为准；完成判定的口径见实施计划文档。

# PI WEB 文案清单与验收底册（阶段 0）

状态：**逐条清单已建立，规则已冻结；阶段 0 验收未完成**——未执行浏览器 UI 巡检（见 §8.3），本文不以源码检查替代巡检通过。本文件是 `docs/localization-plugin-implementation-plan.md` 阶段 0 验收口径的登记底册，与其配套使用。

基线：`feat/i18n-foundation` `ca51d35d`。阶段 1 实施提交：`39ba609e`（feat(i18n): plugin-driven interface localization with settings pilot）。

## 1. 验收标准（阶段 0，摘自实施计划）

- 以 `src/client/src/components/`、`controllers/`、`plugins/core/`、`pi-web-plugins/`、浏览器显示的共享 helper，以及服务端状态/通知为入口，逐项登记英文默认文案、来源、显示组件、命名空间、参数和排除理由；结合组件渲染路径与 UI 巡检，不用单个正则扫描结果冒充完整清单。
- 覆盖：设置、导航、项目/工作区/会话、聊天、命令面板、弹窗、通知、模型与认证、六个项目自带浏览器插件。
- 每个被排除的字符串有理由；业务 ID、路径、代码、用户内容不被误列为可译文案。
- 冻结稳定键命名、重复资源规则及英文回退行为。
- 清单能标明首个 PR 与后续 PR 的归属。

## 2. 本次检查范围与方法

### 2.1 已检查的源码路径

| 区域 | checked 路径 |
|---|---|
| 设置 | `src/client/src/components/SettingsDialog.ts`；`src/client/src/components/settings/` 下 `SettingsGeneralPanel.ts`、`SettingsSessiondPanel.ts`、`SettingsPackagesPanel.ts`、`SettingsPluginsPanel.ts`、`SettingsShortcutsPanel.ts`、`SettingsPanelFrame.ts`、`settingsMachineTarget.ts`、`settingsPluginConfig.ts`、`piPackageSettings.ts`、`settingsDataLoading.ts`、`settingsConfigDraft.ts` |
| 导航 | `src/client/src/components/appShell/AppNavigationPanel.ts`、`src/client/src/components/appShell/AppContextBar.ts`、`src/client/src/components/MachineList.ts`、`src/client/src/components/MachineSwitcher.ts`、`src/client/src/components/PiWebApp.ts`（工作区空状态与动作区） |
| 项目/工作区/会话 | `src/client/src/components/ProjectList.ts`、`src/client/src/components/ProjectDialog.ts`、`src/client/src/components/WorkspaceList.ts`、`src/client/src/components/SessionList.ts`、`src/client/src/components/SessionTreeNavigator.ts`、`src/client/src/components/PiWebApp.ts`（空状态与面板动作） |
| 聊天 | `src/client/src/components/ChatView.ts`、`src/client/src/components/PromptEditor.ts`、`src/client/src/components/AskUserCard.ts`、`src/client/src/components/ExtensionDialogCard.ts`、`src/client/src/components/ToolExecutionView.ts`、`src/client/src/components/FormattedText.ts`、`src/client/src/components/PiWebApp.ts`（会话警告外壳） |
| 命令面板 | `src/client/src/components/ActionPalette.ts`、`src/client/src/components/CommandPicker.ts`、`src/client/src/plugins/core/actions.ts`、`src/client/src/components/PiWebApp.ts`（内建动作与主题/模型/思考等级对话框选项） |
| 弹窗 | `src/client/src/components/AuthDialog.ts`、`src/client/src/components/ModelPicker.ts`、`src/client/src/components/MachineDialog.ts`、`src/client/src/components/SessionCleanupDialog.ts`、`src/client/src/components/ModalSurface.ts`、`src/client/src/components/SettingsDialog.ts` |
| 通知 | `src/client/src/serverNotices.ts`、`src/client/src/sessionNotifications.ts`、`src/client/src/browserErrors.ts`、`src/client/src/components/errorBanner.ts`、`src/client/src/components/StatusBar.ts`、`src/client/src/controllers/sessionNotificationController.ts`、`src/client/src/controllers/machineController.ts`、`src/client/src/controllers/sessionController.ts`、`src/client/src/controllers/workspaceController.ts`、`src/client/src/components/PiWebApp.ts`（通知渲染与错误上报点） |
| 模型与认证 | `src/client/src/components/ModelPicker.ts`、`src/client/src/components/AuthDialog.ts`、`src/client/src/controllers/authController.ts`、`src/client/src/components/PiWebApp.ts`（模型/主题/思考对话框） |
| 六个自带插件 | `pi-web-plugins/terminal/`（`TerminalPanel.ts`、`TerminalSoftKeys.ts`、`terminalCopySnapshot.ts`、`TerminalBrowserRuntime.ts`）、`pi-web-plugins/files/`（`FilesPanel.ts`、`FilesViewer.ts`、`FilesCodeViewer.ts`、`FilesRuntime.ts`）、`pi-web-plugins/git/browser/`（`git-panel.ts`、`unifiedDiff.ts`、`gitFileList.ts`、`gitFileTree.ts`）、`pi-web-plugins/info/`（`infoInternals.ts`、`pi-web-plugin.ts`）、`pi-web-plugins/updates/`（`pi-web-plugin.ts`、`updatesLogic.ts`）、`pi-web-plugins/workspace-tasks/`（`tasksPanelElement.ts`、`workspaceTasksClient.ts`、`pi-web-plugin.ts`） |
| 共享 helper | `src/client/src/api/http.ts`、`src/client/src/api.ts`、`src/client/src/api/clients.ts`、`src/client/src/browserErrors.ts`、`src/client/src/controllers/` |
| 服务端状态/通知 | `src/server/piWebStatus.ts`、`src/shared/pluginApiTypes.ts`（`PiWebStatusMessage`）、`src/server/notices/serverNoticeStore.ts`、`src/server/workspaces/workspaceRemovalService.ts`、`src/shared/workspaceDeletion.ts`、`src/server/sessions/`（会话警告构造） |

### 2.2 方法

1. 对每个区域读取 Lit 模板渲染路径（`html`/`svg` 模板、`.heading/.description/.title/.label` 属性、`aria-*` 与 `placeholder` 属性），抽取用户可见文本节点与属性字符串及其行号。
2. 对非模板渲染路径（注册时静态字符串、控制器拼接消息、服务端消息构造）逐处读取调用链，确认显示组件/场景。
3. 对每条候选字符串判定：产品自有文案 / 动态值 / 排除项；动态内容记录表达式与类别，不枚举运行时值。
4. 与英文默认词典（`src/client/src/i18n/locales/en.ts`）及已迁移调用点交叉核对阶段 1 的 10 个键。
5. 对疑似排除项（路径、代码、模型名、第三方原文）回到定义处确认归属。

### 2.3 未执行项

- **浏览器 UI 巡检未执行**：本次为离线源码审查，无运行中的 PI WEB 服务与浏览器环境，无法执行计划要求的“结合组件渲染路径与 UI 巡检”。本文所有条目均来自源码显示路径核对；巡检通过与否留待具备环境时按 §7.3 执行。
- 未运行生产服务器采集实际通知样例；服务端条目按消息构造点登记（§4.10），并以 §8.2 标注。

## 3. 冻结规则

### 3.1 键名与命名空间

- 完整键 = `${namespace}.${命名空间内键}`。核心界面命名空间 `core`；核心默认词典见 `src/client/src/i18n/locales/en.ts`。
- 项目自带浏览器插件按 `plugin.<插件id>` 提供英文默认文案（阶段 3），例：`plugin.git.openFile`。
- 语言包的 `LocaleContribution.messages` 键为命名空间内局部键（不含命名空间前缀）。
- 键字符集 `[a-zA-Z0-9][a-zA-Z0-9._-]*`；命名空间 `[a-z][a-z0-9.-]*`；语言标签为标准 BCP 47 连字符形式。
- 核心词典现有分组前缀：`core.common.*`、`core.language.*`、`core.settings.*`。后续 PR 增补分组沿用 `core.<区域>.<条目>`，不改已有键。
- 本文中标注 **（拟）** 的键为拟定键，实施时可微调命名，但条目 ID、英文文案与迁移归属不得变更；标注 **（待定）** 的键待对应阶段设计后冻结。

### 3.2 重复资源规则

- 同一 `(locale, namespace, key)` 只允许一个提供者。插件内重复 → 校验失败；跨插件重复 → 发布阶段按注册 id 序判定，后发布者失败回滚（`src/client/src/plugins/registry.ts` `localePublishConflict`）。
- 同一 locale 的同一命名空间可由多个包按不相交键联合提供。
- `LocaleResourceStore.update` 对重复键抛错，不静默覆盖。

### 3.3 英文回退与安全

- 英文内建，不依赖语言包；缺失键逐键回退英文；英文也缺失时开发环境经 `setMissingMessageKeyDiagnostics` 报告。
- 语言包未加载/被禁用/失败：保留显式偏好，显示英文；资源恢复后自动生效。
- Auto 将英文视为始终可用（`["en-US","zh-CN"]` → 英文）。
- 首版仅纯文本；动态值经 `{placeholder}` 插值并由 Lit 转义；禁止把译文当 HTML。

## 4. 逐条文案清单

字段：**ID** ｜ 英文默认文案/模板 ｜ 源码位置 ｜ 显示组件/场景 ｜ 键（现有/**（拟）**/**（待定）**）｜ 参数 ｜ 阶段/PR ｜ 状态。
状态：✅ 已迁移（提交 `39ba609e`）｜⬜ 待办。模板中的 `{param}` 为插值参数；`${expr}` 为运行时动态值（类别见 §6.2）。

### 4.1 设置（阶段 2 PR①：剩余设置页和配置说明）

#### 4.1.1 SettingsGeneralPanel——非试点字段（阶段 2 PR①）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| SET-001 | `Gateway server settings` | `src/client/src/components/settings/:95` | section aria-label，General 面板 | `core.settings.gatewayServer.ariaLabel`（拟） | — | 2① | ⬜ |
| SET-002 | `Gateway server` | `:97` | 卡片标题 h3 | `core.settings.gatewayServer.heading`（拟） | — | 2① | ⬜ |
| SET-003 | `Host, port, and allowed hosts are saved in the gateway config. Address changes require the web service to restart before the running server binds to the new address.` | `:98` | 卡片说明 | `core.settings.gatewayServer.description`（拟） | — | 2① | ⬜ |
| SET-004 | `Loading gateway configuration…` | `:100` | 加载卡片 | `core.settings.gatewayServer.loading`（拟） | — | 2① | ⬜ |
| SET-005 | `Gateway config file` | `:102` | 配置文件卡片标签 | `core.settings.gatewayConfigFile.label`（拟） | — | 2① | ⬜ |
| SET-006 | `Existing file` / `This file will be created on save` | `:104`、`:162` | 配置路径卡片 small（网关/选定机器各一处） | `core.settings.configFile.existing` / `core.settings.configFile.willCreate`（拟） | — | 2① | ⬜ |
| SET-007 | `Host` | `:106` | 字段标题 | `core.settings.gatewayServer.host`（拟） | — | 2① | ⬜ |
| SET-008 | `Address the web server should bind to. Leave empty to use PI WEB's default.` | `:109` | 字段说明 small | `core.settings.gatewayServer.hostHelp`（拟） | — | 2① | ⬜ |
| SET-009 | `Port` | `:112` | 字段标题 | `core.settings.gatewayServer.port`（拟） | — | 2① | ⬜ |
| SET-010 | `TCP port from 1 to 65535. Leave empty to use PI WEB's default.` | `:114` | 字段说明 small | `core.settings.gatewayServer.portHelp`（拟） | — | 2① | ⬜ |
| SET-011 | `Allowed hosts` | `:120` | 字段标题 | `core.settings.gatewayServer.allowedHosts`（拟） | — | 2① | ⬜ |
| SET-012 | `Only listed hosts` / `Allow every host` | `:121` | 下拉选项 | `core.settings.gatewayServer.allowedHosts.list` / `.all`（拟） | — | 2① | ⬜ |
| SET-013 | `Enter one host per line, or choose “Allow every host” to write {code}.` | `:126` | 字段说明 small | `core.settings.gatewayServer.allowedHostsHelp`（拟） | — | 2① | ⬜ |
| SET-014 | `Selected machine file access and upload settings` | `:152` | section aria-label | `core.settings.machineAccess.ariaLabel`（拟） | — | 2① | ⬜ |
| SET-015 | `Selected machine file access and uploads` | `:154` | 卡片标题 h3 | `core.settings.machineAccess.heading`（拟） | — | 2① | ⬜ |
| SET-016 | `External filesystem roots and upload defaults are saved on {targetLabel}.` | `:155` | 卡片说明 | `core.settings.machineAccess.description`（拟） | `targetLabel` | 2① | ⬜ |
| SET-017 | `Loading selected-machine file access config…` / `Selected-machine file access config is unavailable. Reload before saving file/upload settings.` | `:158` | 加载/不可用卡片 | `core.settings.machineAccess.loading` / `.unavailable`（拟） | — | 2① | ⬜ |
| SET-018 | `Selected machine config file` | `:160` | 配置路径卡片标签 | `core.settings.machineAccess.configFile`（拟） | — | 2① | ⬜ |
| SET-019 | `External filesystem roots` | `:164` | 字段标题 | `core.settings.machineAccess.allowedPaths`（拟） | — | 2① | ⬜ |
| SET-020 | `Allowlist for absolute {code} completions and file explorer reads outside a workspace on {targetLabel}. Enter one absolute path, Windows absolute path, or {code}-prefixed path per line. Leave empty to deny external paths by default.` | `:168–169` | 字段说明 small | `core.settings.machineAccess.allowedPathsHelp`（拟） | `targetLabel` | 2① | ⬜ |
| SET-021 | `Default upload folder` | `:170` | 字段标题 | `core.settings.machineAccess.uploadFolder`（拟） | — | 2① | ⬜ |
| SET-022 | `Workspace-relative folder for manual file uploads on {targetLabel}. Leave empty to use PI WEB's default {defaultFolder}.` | `:170–171` | 字段说明 small | `core.settings.machineAccess.uploadFolderHelp`（拟） | `targetLabel`、`defaultFolder`（常量 `DEFAULT_WORKSPACE_UPLOADS_FOLDER`，值属排除 EXC-007） | 2① | ⬜ |
| SET-023 | `Default attachments folder` | `:177` | 字段标题 | `core.settings.machineAccess.attachmentFolder`（拟） | — | 2① | ⬜ |
| SET-024 | `Workspace-relative folder for prompt attachments saved into the workspace on {targetLabel}. Leave empty to use PI WEB's default {defaultFolder}.` | `:177` | 字段说明 small | `core.settings.machineAccess.attachmentFolderHelp`（拟） | `targetLabel`、`defaultFolder`（常量，见 EXC-007） | 2① | ⬜ |
| SET-025 | `Save gateway server config` / `Saving…` | `:141` | 网关表单主按钮 | `core.settings.gatewayServer.save` / `.saving`（拟） | — | 2① | ⬜ |
| SET-026 | `Save file/upload config` / `Saving…` | `:192` | 文件/上载表单主按钮 | `core.settings.machineAccess.save` / `.saving`（拟） | — | 2① | ⬜ |
| SET-027 | `environment override` | `:216`、`sessiond :47,:63,:79` | 环境覆盖徽标 | `core.settings.envOverrideBadge`（拟） | — | 2① | ⬜ |
| SET-028 | `Effective gateway settings after environment overrides` | `:223` | 摘要卡片标题 h3 | `core.settings.effectiveGateway.heading`（拟） | — | 2① | ⬜ |
| SET-029 | `Effective gateway configuration summary` | `:222` | section aria-label | `core.settings.effectiveGateway.ariaLabel`（拟） | — | 2① | ⬜ |
| SET-030 | `Host` / `Port` / `Allowed hosts` | `:225–227` | 摘要 dt | `core.settings.effectiveGateway.host` / `.port` / `.allowedHosts`（拟） | — | 2① | ⬜ |
| SET-031 | `{host} default` / `{port} default` | `:225–226` | 摘要 dd 缺省提示（默认值为技术值） | `core.settings.effectiveGateway.defaultValue`（拟） | — | 2① | ⬜ |
| SET-032 | `Any host` / `None listed` / `Unset` | `:326–327` | 允许主机摘要值 | `core.settings.effectiveGateway.anyHost` / `.noneListed` / `.unset`（拟） | — | 2① | ⬜ |
| SET-033 | `Effective selected-machine settings` | `:237` | 摘要卡片标题 h3 | `core.settings.effectiveMachine.heading`（拟） | — | 2① | ⬜ |
| SET-034 | `Effective selected machine file access and upload summary` | `:236` | section aria-label | `core.settings.effectiveMachine.ariaLabel`（拟） | — | 2① | ⬜ |
| SET-035 | `External roots` / `Upload folder` / `Attachments folder` | `:239–241` | 摘要 dt | `core.settings.effectiveMachine.*`（拟） | — | 2① | ⬜ |
| SET-036 | `{defaultFolder} default`（上传/附件各一处） | `:240–241` | 摘要 dd 缺省提示 | `core.settings.effectiveMachine.defaultValue`（拟） | — | 2① | ⬜ |
| SET-037 | `External paths denied` | `:331` | 外部路径摘要空值 | `core.settings.effectiveMachine.pathsDenied`（拟） | — | 2① | ⬜ |
| SET-038 | `example.local\n192.168.1.20` | `:122` | 允许主机 textarea placeholder（示例值，见 EXC-006） | `core.settings.gatewayServer.allowedHostsPlaceholder`（拟） | — | 2① | ⬜ |
| SET-039 | `~/SDKs\n/opt/reference` | `:166` | 外部路径 textarea placeholder（示例值，见 EXC-006） | `core.settings.machineAccess.allowedPathsPlaceholder`（拟） | — | 2① | ⬜ |
| SET-040 | `Gateway server` / `Gateway server`（错误通知标题） | `panelNotices()` `:213–214` | 面板通知条标题 | `core.settings.gatewayServer.noticeTitle`（拟） | — | 2① | ⬜ |

说明：SET-016/SET-020/SET-022/SET-024 的 `{targetLabel}` 由 `settingsMachineTarget()`（`src/client/src/components/settings/settingsMachineTarget.ts`）生成，值为机器名（动态值 EXC-014）；同面板 `core.settings.generalDescription` 已使用同名参数（SET-PILOT-004）。

#### 4.1.2 SettingsDialog 外壳与导航（阶段 2 PR①）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| SET-050 | `Settings` | `src/client/src/components/ModelPicker.ts:165` | 对话框标题 | `core.settings.dialogTitle`（拟） | — | 2① | ⬜ |
| SET-051 | `PI WEB` | `:101` | 标题栏产品名 | `core.settings.dialogBrand`（拟） | — | 2① | ⬜ |
| SET-052 | `Close settings`（title/aria-label） | `:104` | 关闭按钮 | `core.settings.close`（拟） | — | 2① | ⬜ |
| SET-053 | `Settings sections`（aria-label） | `:107` | 分区导航 | `core.settings.sectionsAriaLabel`（拟） | — | 2① | ⬜ |
| SET-054 | `General` / `Gateway + selected machine` | `:108` | 分区按钮标签/说明 | `core.settings.section.general` / `.generalDetail`（拟） | — | 2① | ⬜ |
| SET-055 | `Session daemon` / `Selected machine` | `:109` | 分区按钮标签/说明 | `core.settings.section.sessiond` / `.sessiondDetail`（拟） | — | 2① | ⬜ |
| SET-056 | `Pi packages` / `Selected machine` | `:110` | 分区按钮标签/说明 | `core.settings.section.packages` / `.packagesDetail`（拟） | — | 2① | ⬜ |
| SET-057 | `PI WEB plugins` / `Selected machine` | `:111` | 分区按钮标签/说明 | `core.settings.section.plugins` / `.pluginsDetail`（拟） | — | 2① | ⬜ |
| SET-058 | `Keyboard` / `Gateway shortcuts` | `:112` | 分区按钮标签/说明 | `core.settings.section.shortcuts` / `.shortcutsDetail`（拟） | — | 2① | ⬜ |

#### 4.1.3 其余设置面板（阶段 2 PR①）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| SET-060 | `Settings notices`（aria-label） | `src/client/src/components/settings/:75` | 面板通知区 | `core.settings.noticesAriaLabel`（拟） | — | 2① | ⬜ |
| SET-061 | `Config file` | `src/client/src/components/settings/:41`、`src/client/src/components/settings/SettingsShortcutsPanel.ts:107` | 配置路径标签 | `core.settings.sessiond.configFile` / `core.settings.shortcuts.configFile`（拟） | — | 2① | ⬜ |
| SET-062 | `Allow agents to start sessions` | `src/client/src/components/settings/SettingsSessiondPanel.ts:46` | 字段标题 | `core.settings.sessiond.allowSessions`（拟） | — | 2① | ⬜ |
| SET-063 | `Disabled`（×3 处禁用态标签） | `src/client/src/components/settings/SettingsSessiondPanel.ts:96–98` | 状态标签 | `core.settings.sessiond.disabled`（拟） | — | 2① | ⬜ |
| SET-070 | `Trusted code warning:` | `src/client/src/components/settings/SettingsPackagesPanel.ts:52`、`src/client/src/components/settings/SettingsPluginsPanel.ts:99`、`src/client/src/components/settings/SettingsPanelFrame.ts`（共享横幅） | 可信代码警告横幅 | `core.settings.trustedCodeWarning`（拟） | — | 2① | ⬜ |
| SET-071 | `Available packages` | `src/client/src/components/settings/SettingsPackagesPanel.ts:74` | 卡片标题 | `core.packages.available`（拟） | — | 2① | ⬜ |
| SET-072 | `PI WEB ships these packages so you can install them on {targetLabel} with one click, with no path to type — including one you previously removed.` | `:75` | 卡片说明 | `core.packages.availableDescription`（拟） | `targetLabel` | 2① | ⬜ |
| SET-073 | `Available known Pi packages`（aria-label） | `:73` | section aria-label | `core.packages.availableAriaLabel`（拟） | — | 2① | ⬜ |
| SET-074 | `Pi package source` | `:98` | 字段标题 | `core.packages.source`（拟） | — | 2① | ⬜ |
| SET-075 | `npm:@scope/package, git URL, or local path` | `:101` | 输入 placeholder（示例语法，见 EXC-005） | `core.packages.sourcePlaceholder`（拟） | — | 2① | ⬜ |
| SET-076 | `Install this Pi package`（title） | `:101` | 安装按钮 | `core.packages.install`（拟） | — | 2① | ⬜ |
| SET-077 | `Configured Pi packages` | `:119` | 卡片标题 | `core.packages.configured`（拟） | — | 2① | ⬜ |
| SET-078 | `This list comes from Pi's package manager settings on {targetLabel}.` | `:120` | 卡片说明 | `core.packages.configuredDescription`（拟） | `targetLabel` | 2① | ⬜ |
| SET-079 | `Configured Pi packages`（aria-label） | `:116` | section aria-label | `core.packages.configuredAriaLabel`（拟） | — | 2① | ⬜ |
| SET-080 | `Refreshing Pi packages from {targetLabel}…` / `Loading Pi packages from {targetLabel}…` | `:127`、`:134` | 加载态文本 | `core.packages.refreshing` / `.loading`（拟） | `targetLabel` | 2① | ⬜ |
| SET-081 | `No Pi packages configured in Pi settings on {targetLabel} yet.` | `:135` | 空状态 | `core.packages.empty`（拟） | `targetLabel` | 2① | ⬜ |
| SET-090 | `No PI WEB plugins are discovered or active on {targetLabel}.` | `src/client/src/components/settings/SettingsPluginsPanel.ts:125` | 插件空状态 | `core.plugins.empty`（拟） | `targetLabel` | 2① | ⬜ |
| SET-091 | `Config key on {targetLabel}:` | `:130` | 配置键说明（`plugins` 为配置键名，EXC-004） | `core.plugins.configKey`（拟） | `targetLabel` | 2① | ⬜ |
| SET-092 | `. Browser-only changes apply after a tab reload; server-backed changes follow sessiond's startup snapshot and can require a manual restart.` | `:130` | 配置键说明续句 | `core.plugins.configKeyRestartNote`（拟） | — | 2① | ⬜ |
| SET-093 | `Health: {message}` | `:153` | 插件健康诊断（message 为插件/服务端原文，见 EXC-010） | `core.plugins.health`（拟） | `message` | 2① | ⬜ |
| SET-094 | `Offline disable:` | `:154` | 离线禁用命令说明 | `core.plugins.offlineDisable`（拟） | — | 2① | ⬜ |
| SET-095 | `Conflict` / `Stale revision` / `Restart required` | `:169–171` | 插件状态徽标 | `core.plugins.badge.*`（拟） | — | 2① | ⬜ |
| SET-096 | `Offline recovery on {targetLabel}` | `:184` | 恢复命令卡片标题 | `core.plugins.offlineRecovery`（拟） | `targetLabel` | 2① | ⬜ |
| SET-097 | `These commands edit config without contacting sessiond or importing plugins. They never include machine credentials.` | `:184` | 恢复命令卡片说明 | `core.plugins.offlineRecoveryDescription`（拟） | — | 2① | ⬜ |
| SET-098 | `Offline server-plugin recovery commands`（aria-label） | `:183` | section aria-label | `core.plugins.offlineRecoveryAriaLabel`（拟） | — | 2① | ⬜ |
| SET-100 | `Loading shortcuts…` | `src/client/src/components/settings/SettingsShortcutsPanel.ts:105` | 加载态 | `core.shortcuts.loading`（拟） | — | 2① | ⬜ |
| SET-101 | `Shortcut overrides are saved under {code}. A value of {code} disables the action shortcut.` | `:108–109` | 配置说明 | `core.shortcuts.configNote`（拟） | — | 2① | ⬜ |
| SET-102 | `No actions registered.` | `:111` | 空状态 | `core.shortcuts.empty`（拟） | — | 2① | ⬜ |
| SET-103 | `Chat composer` / `Enter key behavior` | `:136–137` | 分区标题/字段 | `core.shortcuts.composer*`（拟） | — | 2① | ⬜ |
| SET-104 | `Choose what Enter does in this browser. Shift+Enter does the opposite when supported; automatic touch-keyboard capitalization is ignored to avoid accidental sends.` | `:138` | 字段说明 | `core.shortcuts.enterBehaviorHelp`（拟） | — | 2① | ⬜ |
| SET-105 | `Enter and Shift Enter behavior in the chat composer`（aria-label） | `:140` | 单选组 aria-label | `core.shortcuts.enterBehaviorAriaLabel`（拟） | — | 2① | ⬜ |

### 4.2 导航（阶段 2 PR②）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| NAV-001 | `Location` | `src/client/src/components/appShell/:55` | 上下文条标签 | `core.nav.location`（拟） | — | 2② | ⬜ |
| NAV-002 | `Current location`（aria-label） | `src/client/src/components/appShell/AppContextBar.ts:54` | 上下文条 aria | `core.nav.locationAriaLabel`（拟） | — | 2② | ⬜ |
| NAV-003 | `No machine` | `src/client/src/components/appShell/AppContextBar.ts:96` | 机器空选项 | `core.nav.noMachine`（拟） | — | 2② | ⬜ |
| NAV-004 | `Show Actions`（title/aria-label） | `src/client/src/components/appShell/AppContextBar.ts:115`、`src/client/src/components/appShell/AppNavigationPanel.ts:144` | 动作按钮 | `core.actions.show`（拟；与 `src/client/src/plugins/core/actions.ts:11` 同文案，共用一键） | — | 2② | ⬜ |
| NAV-005 | `PI WEB` | `src/client/src/components/appShell/AppNavigationPanel.ts:130` | 导航面板品牌 | `core.nav.brand`（拟） | — | 2② | ⬜ |
| NAV-006 | `Actions` | `src/client/src/components/appShell/AppNavigationPanel.ts:139` | 导航项 | `core.nav.actions`（拟） | — | 2② | ⬜ |
| NAV-010 | `Focus Machines` / `Move keyboard focus to the machines list` | `src/client/src/components/PiWebApp.ts:2270` | 内建动作（`app.navigation.focus-machines`） | `core.nav.focusMachines` / `.focusMachinesDescription`（拟） | — | 2② | ⬜ |
| NAV-011 | `Focus Projects` / `Move keyboard focus to the projects list` | `src/client/src/components/PiWebApp.ts:2278–2280` | 内建动作（`app.navigation.focus-projects`） | `core.nav.focusProjects*`（拟） | — | 2② | ⬜ |
| NAV-012 | `Focus Workspaces` / `Move keyboard focus to the workspaces list` | `src/client/src/components/PiWebApp.ts:2286–2288` | 内建动作（`app.navigation.focus-workspaces`） | `core.nav.focusWorkspaces*`（拟） | — | 2② | ⬜ |
| NAV-013 | `Focus Sessions` / `Move keyboard focus to the sessions list` | `src/client/src/components/PiWebApp.ts:2294–2296` | 内建动作（`app.navigation.focus-sessions`） | `core.nav.focusSessions*`（拟） | — | 2② | ⬜ |
| NAV-014 | `Go to Chat` / `Go to Chat` | `src/client/src/plugins/core/:99–101` | 核心插件动作（`core:actions.*`） | `core.nav.goToChat*`（拟） | — | 2② | ⬜ |
| NAV-020 | `Reset Navigation Panel Size` / `Restore the navigation panel to its default width` | `src/client/src/components/PiWebApp.ts:2244–2247` | 内建动作（`app.layout.reset-navigation-panel-size`） | `core.layout.resetNavigation*`（拟） | — | 2② | ⬜ |
| NAV-021 | `Reset Workspace Panel Size` / `Restore the workspace panel to its default width` | `src/client/src/components/PiWebApp.ts:2251–2254` | 内建动作（`app.layout.reset-workspace-panel-size`） | `core.layout.resetWorkspace*`（拟） | — | 2② | ⬜ |
| NAV-022 | `Reset Panel Sizes` / `Restore all side panels to their default widths` | `src/client/src/components/PiWebApp.ts:2258–2261` | 内建动作（`app.layout.reset-panel-sizes`） | `core.layout.resetAll*`（拟） | — | 2② | ⬜ |

### 4.3 项目/工作区/会话（阶段 2 PR②）

#### 4.3.1 列表与空状态

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PWS-001 | `Projects` | `src/client/src/components/ProjectList.ts:96` | 分区标题 | `core.project.listTitle`（拟） | — | 2② | ⬜ |
| PWS-002 | `{count} Projects` | `src/client/src/components/ProjectList.ts:99` | 计数徽标 | `core.project.count`（拟） | `count` | 2② | ⬜ |
| PWS-003 | `Close` / `Close project`（title） | `src/client/src/components/ProjectList.ts:74` | 项目行按钮 | `core.project.close`（拟） | — | 2② | ⬜ |
| PWS-010 | `Machines` | `pi-web-plugins/info/infoInternals.ts:181` | 分区标题 | `core.machine.listTitle`（拟） | — | 2② | ⬜ |
| PWS-011 | `{count} Machines` | `src/client/src/components/MachineList.ts:123` | 计数徽标 | `core.machine.count`（拟） | `count` | 2② | ⬜ |
| PWS-012 | `Machine actions`（title） | `src/client/src/components/MachineList.ts:104`、`src/client/src/components/MachineSwitcher.ts:118` | 动作菜单按钮 | `core.machine.actions`（拟） | — | 2② | ⬜ |
| PWS-013 | `Machine` | `src/client/src/components/MachineSwitcher.ts:75` | 切换器标签 | `core.machine.switcherLabel`（拟） | — | 2② | ⬜ |
| PWS-020 | `Workspaces` | `pi-web-plugins/info/infoInternals.ts:197` | 分区标题 | `core.workspace.listTitle`（拟） | — | 2② | ⬜ |
| PWS-021 | `{count} Workspaces` | `src/client/src/components/WorkspaceList.ts:118` | 计数徽标 | `core.workspace.count`（拟） | `count` | 2② | ⬜ |
| PWS-022 | `Deleting…` | `src/client/src/components/WorkspaceList.ts:132` | 删除中状态 | `core.workspace.deleting`（拟） | — | 2② | ⬜ |
| PWS-023 | `Workspace actions and details`（title） | `src/client/src/components/WorkspaceList.ts:150` | 行动作按钮 | `core.workspace.actions`（拟） | — | 2② | ⬜ |
| PWS-024 | `Trusted` / `Learn about project trust` | `src/client/src/components/WorkspaceList.ts:191–192`、`src/client/src/components/ProjectDialog.ts:124–128` | 信任徽标与链接 | `core.workspace.trusted` / `core.project.trustLearn`（拟） | — | 2② | ⬜ |
| PWS-025 | `Workspace` / `Details` | `src/client/src/components/WorkspaceList.ts:242、251` | 行详情标签 | `core.workspace.label` / `.details`（拟） | — | 2② | ⬜ |
| PWS-030 | `Sessions` | `src/client/src/components/SessionCleanupDialog.ts:34` | 分区标题 | `core.session.listTitle`（拟） | — | 2② | ⬜ |
| PWS-031 | `{count} Sessions` | `src/client/src/components/SessionList.ts:198` | 计数徽标 | `core.session.count`（拟） | `count` | 2② | ⬜ |
| PWS-032 | `Clean up` / `Preview session cleanup`（title） | `src/client/src/components/SessionList.ts:221` | 清理按钮 | `core.session.cleanup`（拟） | — | 2② | ⬜ |
| PWS-033 | `{count} Archived` | `src/client/src/components/SessionList.ts:245` | 已归档计数 | `core.session.archivedCount`（拟） | `count` | 2② | ⬜ |
| PWS-034 | `Archive` / `Mark read` / `Delete` | `src/client/src/components/SessionList.ts:262–263、280` | 批量操作按钮 | `core.session.batchArchive` / `.batchMarkRead` / `.batchDelete`（拟） | — | 2② | ⬜ |
| PWS-035 | `Permanently delete selected archived sessions`（title） | `src/client/src/components/SessionList.ts:279` | 批量删除按钮 | `core.session.batchDeleteTitle`（拟） | — | 2② | ⬜ |
| PWS-036 | `Select visible` / `Clear selected ({count})` | `src/client/src/components/SessionList.ts:298–299` | 选择操作 | `core.session.selectVisible` / `.clearSelected`（拟） | `count` | 2② | ⬜ |
| PWS-037 | `Restore` / `Restore session`（title） | `src/client/src/components/SessionList.ts:335` | 行操作 | `core.session.restore*`（拟） | — | 2② | ⬜ |
| PWS-038 | `Delete archived session` / `Permanently delete archived session`（title）/ `Delete` | `src/client/src/components/SessionList.ts:336–339` | 行操作 | `core.session.deleteArchived*`（拟） | — | 2② | ⬜ |
| PWS-039 | `Delete transient new session`（title）/ `Delete` | `src/client/src/components/SessionList.ts:339` | 行操作 | `core.session.deleteTransient*`（拟） | — | 2② | ⬜ |
| PWS-040 | `Mark as read` / `Mark session as read`（title） | `src/client/src/components/SessionList.ts:341` | 行操作 | `core.session.markRead*`（拟） | — | 2② | ⬜ |
| PWS-041 | `Archive` / `Archive session`（title） | `src/client/src/components/SessionList.ts:343` | 行操作 | `core.session.archive*`（拟） | — | 2② | ⬜ |
| PWS-042 | `Archive with descendants ({count})` / `Archive this session and its descendants`（title） | `src/client/src/components/SessionList.ts:344` | 行操作 | `core.session.archiveWithDescendants*`（拟） | `count` | 2② | ⬜ |
| PWS-043 | `Detach from parent`（title/文本） | `src/client/src/components/SessionList.ts:346` | 行操作 | `core.session.detachFromParent`（拟） | — | 2② | ⬜ |
| PWS-044 | `Reload from disk` | `src/client/src/components/SessionList.ts:347` | 行操作 | `core.session.reloadFromDisk`（拟） | — | 2② | ⬜ |
| PWS-045 | `depth {n}` | `src/client/src/components/SessionList.ts:375` | 树深度徽标（值为数字） | `core.session.depth`（拟） | `n` | 2② | ⬜ |
| PWS-050 | `Loading projects…` / `Looking for projects you have added to PI WEB.` | `src/client/src/components/ProjectList.ts:96` | 工作区面板空状态 | `core.workspaceSurface.loadingProjects*`（拟） | — | 2② | ⬜ |
| PWS-051 | `No projects yet` / `Use Actions → Add Project to add a folder. Workspace tools will appear here after you choose a workspace.` | `src/client/src/components/PiWebApp.ts:2029–2031` | 工作区面板空状态 | `core.workspaceSurface.noProjects*`（拟） | — | 2② | ⬜ |
| PWS-052 | `Select a project` / `Choose a project from the sidebar, then select a workspace to use its tools.` | `src/client/src/components/PiWebApp.ts:2033–2035` | 工作区面板空状态 | `core.workspaceSurface.selectProject*`（拟） | — | 2② | ⬜ |
| PWS-053 | `Loading workspaces…` / `Preparing workspace tools for {projectName}.` | `src/client/src/components/PiWebApp.ts:2039–2041` | 工作区面板空状态 | `core.workspaceSurface.loadingWorkspaces*`（拟） | `projectName`（动态 EXC-013） | 2② | ⬜ |
| PWS-054 | `No workspaces found` / `{projectName} does not have any available workspaces. Try selecting the project again or re-adding it.` | `src/client/src/components/PiWebApp.ts:2045–2047` | 工作区面板空状态 | `core.workspaceSurface.noWorkspaces*`（拟） | `projectName` | 2② | ⬜ |
| PWS-055 | `Select a workspace` / `Choose a workspace in {projectName} to use its tools.` | `src/client/src/components/PiWebApp.ts:2050–2052` | 工作区面板空状态 | `core.workspaceSurface.selectWorkspace*`（拟） | `projectName` | 2② | ⬜ |
| PWS-056 | `Loading projects…` / `Select or start a session.` / `Select a workspace to start a session.` / `Add a project to start a session.` / `Select a project and workspace to start a session.` | `src/client/src/components/PiWebApp.ts:2054–2059`（`sessionEmptyMessage()`） | 会话区空状态（五分支） | `core.session.empty.*`（拟） | — | 2② | ⬜ |
| PWS-057 | `Refresh Current Panel` | `src/client/src/components/PiWebApp.ts:2220–2223` | 内建动作（`core:workspace.refresh-current`） | `core.workspace.refreshCurrent`（拟） | — | 2② | ⬜ |
| PWS-058 | `Clean Up Sessions` / `Preview and manually clean up idle or archived sessions on the selected machine` | `src/client/src/components/PiWebApp.ts:2232–2236` | 内建动作（`app.sessions.cleanup`） | `core.session.cleanupAction*`（拟） | — | 2② | ⬜ |

#### 4.3.2 会话树导航器（阶段 2 PR②）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PWS-060 | `Conversation history` | `src/client/src/components/SessionTreeNavigator.ts:88` | 面板标题 | `core.sessionTree.title`（拟） | — | 2② | ⬜ |
| PWS-061 | `Navigate session tree`（aria-label） | `:83` | 树 aria | `core.sessionTree.navigateAriaLabel`（拟） | — | 2② | ⬜ |
| PWS-062 | `Close session tree`（title/aria-label） | `:86、88` | 关闭按钮 | `core.sessionTree.close`（拟） | — | 2② | ⬜ |
| PWS-063 | `Select the history entry where you would like to continue.` | `:104` | 说明文本 | `core.sessionTree.instructions`（拟） | — | 2② | ⬜ |
| PWS-064 | `Active path` / `Active leaf` | `:106–107、158–159` | 图例与条目标记 | `core.sessionTree.activePath` / `.activeLeaf`（拟） | — | 2② | ⬜ |
| PWS-065 | `Session tree markers`（aria-label） | `:105` | 图例 aria | `core.sessionTree.markersAriaLabel`（拟） | — | 2② | ⬜ |
| PWS-066 | `This session does not contain any selectable history entries.` | `:113` | 空状态 | `core.sessionTree.empty`（拟） | — | 2② | ⬜ |
| PWS-067 | `Complete session history`（aria-label） | `:115` | 列表 aria | `core.sessionTree.historyAriaLabel`（拟） | — | 2② | ⬜ |
| PWS-068 | `Selected entry` / `Choose how to continue` | `:182–183` | 继续操作区 | `core.sessionTree.selectedEntry` / `.chooseContinuation`（拟） | — | 2② | ⬜ |

### 4.4 聊天与输入（阶段 2 PR③）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| CHAT-001 | `Minimise warnings`（title/aria-label）/ `Minimise` | `src/client/src/components/ChatView.ts:601` | 会话警告折叠按钮 | `core.chat.minimiseWarnings*`（拟） | — | 2③ | ⬜ |
| CHAT-002 | `Don't show this warning again`（title）/ `Dismiss warning`（aria-label） | `src/client/src/components/ChatView.ts:622–623` | 警告忽略按钮 | `core.chat.dismissWarning*`（拟） | — | 2③ | ⬜ |
| CHAT-003 | `Close image`（aria-label） | `src/client/src/components/ChatView.ts:638` | 图片查看器关闭 | `core.chat.closeImage`（拟） | — | 2③ | ⬜ |
| CHAT-004 | `Sending your message…` | `src/client/src/components/ChatView.ts:670` | 发送中提示 | `core.chat.sending`（拟） | — | 2③ | ⬜ |
| CHAT-005 | `Clear queue` / `Clear queued messages without stopping active work`（title） | `src/client/src/components/ChatView.ts:700` | 队列清除按钮 | `core.chat.clearQueue*`（拟） | — | 2③ | ⬜ |
| CHAT-006 | `{count} more extension {plural} queued` | `src/client/src/components/ChatView.ts:751` | 扩展对话框队列计数（复数形态待阶段 4 规则，键待定） | `core.chat.moreExtensionQueued`（拟） | `count` | 2③（复数规则 4） | ⬜ |
| CHAT-007 | `Compacting history…` / `The agent is summarizing earlier context. New prompts will be queued until compaction finishes.` | `src/client/src/components/ChatView.ts:761–762` | 压缩中横幅 | `core.chat.compacting*`（拟） | — | 2③ | ⬜ |
| CHAT-008 | `{count} queued {plural}` | `src/client/src/components/ChatView.ts:763` | 队列计数 | `core.chat.queuedCount`（拟） | `count` | 2③ | ⬜ |
| CHAT-009 | `Loading earlier messages…` / `Load earlier messages` / `Scroll up to load earlier messages` | `src/client/src/components/ChatView.ts:807–810` | 历史加载 | `core.chat.loadEarlier*`（拟） | — | 2③ | ⬜ |
| CHAT-010 | `Beginning of session` | `src/client/src/components/ChatView.ts:815` | 会话起始分隔 | `core.chat.beginningOfSession`（拟） | — | 2③ | ⬜ |
| CHAT-011 | `Showing messages {start}–{end} of {total}` | `src/client/src/components/ChatView.ts:824` | 虚拟列表范围提示 | `core.chat.showingMessages`（拟） | `start`、`end`、`total` | 2③ | ⬜ |
| CHAT-012 | `Message actions`（aria-label） | `src/client/src/components/ChatView.ts:919` | 消息动作菜单 | `core.chat.messageActions`（拟） | — | 2③ | ⬜ |
| CHAT-013 | `Clone session from this message` / `Go back to this message`（title/aria-label） | `src/client/src/components/ChatView.ts:921` | 消息动作 | `core.chat.cloneSession` / `.goBackToMessage`（拟） | — | 2③ | ⬜ |
| CHAT-014 | `thinking` | `src/client/src/components/ChatView.ts:992` | 推理中占位（原文小写属产品文案） | `core.chat.thinking`（拟） | — | 2③ | ⬜ |
| CHAT-015 | `[skill]` | `src/client/src/components/ChatView.ts:995` | 技能消息标记（skill 名为动态值 EXC-008） | `core.chat.skillMarker`（拟） | — | 2③ | ⬜ |
| CHAT-016 | `Loaded {name}` / `read {name}` | `src/client/src/components/ChatView.ts:1002–1003` | 上下文加载提示 | `core.chat.loadedFile` / `.readFile`（拟） | `name`（动态文件引用） | 2③ | ⬜ |
| CHAT-017 | `Click to enlarge`（title） | `src/client/src/components/ChatView.ts:1015` | 图片缩略图 | `core.chat.clickToEnlarge`（拟） | — | 2③ | ⬜ |
| CHAT-018 | `{count} {plural} result` | `src/client/src/components/ChatView.ts:1021` | 工具结果计数 | `core.chat.toolResultCount`（拟） | `count` | 2③ | ⬜ |
| CHAT-020 | `Shell command{status}` | `src/client/src/components/PromptEditor.ts:126` | 附件 chips 标题 | `core.prompt.shellCommand`（拟） | `status`（动态） | 2③ | ⬜ |
| CHAT-021 | `Compacting history · message will be queued` | `src/client/src/components/PromptEditor.ts:127` | 附件状态行 | `core.prompt.compactingQueued`（拟） | — | 2③ | ⬜ |
| CHAT-022 | `Steer the current response before the next model call`（title）/ `Steer current response`（aria-label） | `src/client/src/components/PromptEditor.ts:134` | 转向开关 | `core.prompt.steer*`（拟） | — | 2③ | ⬜ |
| CHAT-023 | `Session status`（aria-label） | `src/client/src/components/PromptEditor.ts:178` | 状态徽标 aria | `core.prompt.sessionStatusAriaLabel`（拟） | — | 2③ | ⬜ |
| CHAT-024 | `Select model`（title） | `src/client/src/components/PromptEditor.ts:179` | 模型按钮 | `core.model.select`（拟） | — | 2③ | ⬜ |
| CHAT-025 | `Pending attachments`（aria-label） | `src/client/src/components/PromptEditor.ts:190` | 附件列表 aria | `core.prompt.pendingAttachmentsAriaLabel`（拟） | — | 2③ | ⬜ |
| CHAT-026 | `Attach to message{status}` | `src/client/src/components/PromptEditor.ts:198` | 附件按钮 | `core.prompt.attachToMessage`（拟） | `status`（动态） | 2③ | ⬜ |
| CHAT-030 | `Copy code block` / `Copied code block` / `Failed to copy code block` | `pi-web-plugins/updates/pi-web-plugin.ts:35` | 代码块复制按钮（title/aria-label） | `core.chat.copyCodeBlock*`（拟） | — | 2③ | ⬜ |
| CHAT-040 | `Applied diff differs from the preview.` | `src/client/src/components/SessionCleanupDialog.ts:93` | 工具结果警告 | `core.chat.diffMismatch`（拟） | — | 2③ | ⬜ |
| CHAT-041 | `Details` / `Result` | `src/client/src/components/ToolExecutionView.ts:76、80` | 工具结果分区标题 | `core.chat.toolDetails` / `.toolResult`（拟） | — | 2③ | ⬜ |
| CHAT-042 | `Show all {count} diff lines` | `src/client/src/components/ToolExecutionView.ts:105` | 展开按钮 | `core.chat.showAllDiffLines`（拟） | `count` | 2③ | ⬜ |

### 4.5 命令面板（阶段 2 PR③）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| CMD-001 | `Search actions...` | `src/client/src/components/ActionPalette.ts:30` | 搜索框 placeholder | `core.commandPalette.searchPlaceholder`（拟） | — | 2③ | ⬜ |
| CMD-002 | `Close`（title/aria-label） | `src/client/src/components/ActionPalette.ts:37` | 关闭按钮 | `core.commandPalette.close`（拟） | — | 2③ | ⬜ |
| CMD-003 | `No actions found.` | `src/client/src/components/ActionPalette.ts:40` | 空状态 | `core.commandPalette.noActions`（拟） | — | 2③ | ⬜ |
| CMD-004 | `Close`（aria-label） | `src/client/src/components/CommandPicker.ts:36` | 关闭按钮 | `core.commandPicker.close`（拟） | — | 2③ | ⬜ |
| CMD-005 | `Search` | `src/client/src/components/CommandPicker.ts:38` | 搜索框 placeholder | `core.commandPicker.searchPlaceholder`（拟） | — | 2③ | ⬜ |
| CMD-006 | `No matching options` | `src/client/src/components/CommandPicker.ts:54` | 空状态 | `core.commandPicker.noMatches`（拟） | — | 2③ | ⬜ |
| CMD-010 | `Show Actions` / `Open the command palette` | `src/client/src/plugins/core/:11–12` | 核心插件动作 | `core.actions.show*`（拟） | — | 2③ | ⬜ |
| CMD-011 | `Add Machine` / `Register another PI WEB runtime reachable from this gateway` | `src/client/src/plugins/core/:27–28` | 核心插件动作 | `core.actions.addMachine*`（拟） | — | 2③ | ⬜ |
| CMD-012 | `Refresh Selected Machine` / `Check whether the selected PI WEB runtime is online` | `src/client/src/plugins/core/:34–35` | 核心插件动作 | `core.actions.refreshMachine*`（拟） | — | 2③ | ⬜ |
| CMD-013 | `Open Selected Machine PI WEB` / `Open the selected remote PI WEB directly in a new tab` | `src/client/src/plugins/core/:41–42` | 核心插件动作 | `core.actions.openMachine*`（拟） | — | 2③ | ⬜ |
| CMD-014 | `Remove Selected Machine` / `Remove the selected remote machine from this gateway` | `src/client/src/plugins/core/:49–50` | 核心插件动作 | `core.actions.removeMachine*`（拟） | — | 2③ | ⬜ |
| CMD-015 | `Add Project` | `src/client/src/plugins/core/:57` | 核心插件动作（无 description） | `core.actions.addProject`（拟） | — | 2③ | ⬜ |
| CMD-016 | `Configure Provider Authentication` / `Run /login without tying authentication to a session` | `src/client/src/plugins/core/:63–64` | 核心插件动作（`/login` 为命令文本 EXC-005） | `core.actions.configureAuth*`（拟） | — | 2③ | ⬜ |
| CMD-017 | `Remove Provider Authentication` / `Run /logout for stored pi credentials` | `src/client/src/plugins/core/:70–71` | 核心插件动作 | `core.actions.removeAuth*`（拟） | — | 2③ | ⬜ |
| CMD-018 | `Select Theme` / `Choose the PI WEB color theme` | `src/client/src/plugins/core/:77–78`、`src/client/src/components/PiWebApp.ts:3023` | 核心插件动作与主题对话框标题（共用一键） | `core.actions.selectTheme*` / `core.theme.dialogTitle`（拟） | — | 2③ | ⬜ |
| CMD-019 | `Open Settings` / `Manage PI WEB configuration and keyboard shortcuts` | `src/client/src/plugins/core/:84–85` | 核心插件动作 | `core.actions.openSettings*`（拟） | — | 2③ | ⬜ |
| CMD-020 | `Full Page Reload` / `Reload the PI WEB browser page` | `src/client/src/plugins/core/:92–93` | 核心插件动作 | `core.actions.fullReload*`（拟） | — | 2③ | ⬜ |
| CMD-021 | `Remove Workspace` / `Run the owning provider's workspace removal operation` | `src/client/src/plugins/core/:106–107` | 核心插件动作 | `core.actions.removeWorkspace*`（拟） | — | 2③ | ⬜ |
| CMD-022 | 动作分组名：`General`、`Machine`、`Project`、`Preferences`、`Navigation`、`Workspace` | `src/client/src/plugins/core/:14,22,29,36,43,51,58,65,72,79,86,94,101,108` | 命令面板分组标题 | `core.commandGroup.*`（拟） | — | 2③ | ⬜ |
| CMD-023 | 分组名：`Sessions`、`View` | `src/client/src/components/PiWebApp.ts:2235,2246,2253,2260` | 命令面板分组标题 | `core.commandGroup.sessions` / `.view`（拟） | — | 2③ | ⬜ |

### 4.6 弹窗（阶段 2 PR③）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| DLG-001 | `Close`（title/aria-label） | `src/client/src/components/AuthDialog.ts:45` | 认证对话框关闭按钮 | `core.auth.close`（拟） | — | 2③ | ⬜ |
| DLG-002 | `Close`（aria-label） | `src/client/src/components/ModelPicker.ts:152` | 模型选择关闭按钮 | `core.model.close`（拟） | — | 2③ | ⬜ |
| DLG-003 | `Model scope`（aria-label） | `src/client/src/components/ModelPicker.ts:155` | 范围切换单选组 | `core.model.scopeAriaLabel`（拟） | — | 2③ | ⬜ |
| DLG-004 | `Project override` | `src/client/src/components/ModelPicker.ts:164` | 范围选项 | `core.model.projectOverride`（拟） | — | 2③ | ⬜ |
| DLG-005 | `Showing models from this workspace's {configPath}. Model availability selection is disabled.` | `src/client/src/components/ModelPicker.ts:165` | 项目覆盖说明 | `core.model.projectOverrideNote`（拟） | `configPath`（`.pi/settings.json`，见 EXC-005） | 2③ | ⬜ |
| DLG-006 | `No matching options` | `src/client/src/components/ModelPicker.ts:181` | 空状态 | `core.model.noMatches`（拟） | — | 2③ | ⬜ |
| DLG-010 | `Search providers`（aria-label/placeholder）/ `No matching providers` | `src/client/src/components/AuthDialog.ts:160、164` | 提供商搜索 | `core.auth.search*`（拟） | — | 2③ | ⬜ |
| DLG-011 | `Open this authorization link:` | `src/client/src/components/AuthDialog.ts:194` | OAuth 链接说明 | `core.auth.openLink`（拟） | — | 2③ | ⬜ |
| DLG-012 | `Enter code:` | `src/client/src/components/AuthDialog.ts:197` | 授权码输入标签 | `core.auth.enterCode`（拟） | — | 2③ | ⬜ |
| DLG-013 | `Starting login flow…` | `src/client/src/components/AuthDialog.ts:199` | 登录中提示 | `core.auth.startingLogin`（拟） | — | 2③ | ⬜ |
| DLG-014 | `After you approve, the redirect page will probably fail to load — that is expected. Copy the full URL from your browser's address bar and paste it below.` | `src/client/src/components/AuthDialog.ts:200` | 重定向说明 | `core.auth.redirectNote`（拟） | — | 2③ | ⬜ |
| DLG-015 | `Related information`（aria-label） | `src/client/src/components/AuthDialog.ts:203` | 链接组 aria | `core.auth.relatedInfoAriaLabel`（拟） | — | 2③ | ⬜ |
| DLG-016 | `Cancel` / `Submit` | `src/client/src/components/AuthDialog.ts:209` | 对话框按钮 | `core.auth.cancel` / `.submit`（拟） | — | 2③ | ⬜ |
| DLG-017 | `Close` / `Cancel` | `src/client/src/components/AuthDialog.ts:222–223` | 对话框按钮 | `core.auth.close` / `.cancel`（拟） | — | 2③ | ⬜ |
| DLG-020 | `Add project` | `src/client/src/components/ProjectDialog.ts:164` | 对话框标题 | `core.project.addDialogTitle`（拟） | — | 2③ | ⬜ |
| DLG-021 | `Project folder` | `src/client/src/components/ProjectDialog.ts:168` | 字段标题 | `core.project.folder`（拟） | — | 2③ | ⬜ |
| DLG-022 | `/path/to/project or ~/code/project` | `src/client/src/components/ProjectDialog.ts:168` | 输入 placeholder（示例路径 EXC-006） | `core.project.folderPlaceholder`（拟） | — | 2③ | ⬜ |
| DLG-023 | `Trust this project` / `Trusting lets pi load this project's .pi settings, extensions, skills, and packages.` | `src/client/src/components/ProjectDialog.ts:124–128` | 信任确认区 | `core.project.trust*`（拟） | — | 2③ | ⬜ |
| DLG-024 | `Trust state unavailable: {detail}` | `src/client/src/components/ProjectDialog.ts:131` | 信任状态错误 | `core.project.trustUnavailable`（拟） | `detail`（动态，服务端原文） | 2③ | ⬜ |
| DLG-025 | `Loading folders…` / `No matching folders. Enter a new path to create it.` | `src/client/src/components/ProjectDialog.ts:176、182` | 文件夹浏览 | `core.project.loadingFolders` / `.noFolders`（拟） | — | 2③ | ⬜ |
| DLG-030 | `Add machine` | `pi-web-plugins/info/infoInternals.ts:181` | 对话框标题 | `core.machine.addDialogTitle`（拟） | — | 2③ | ⬜ |
| DLG-031 | `Machine name` / `Suggested from the URL. Edit it to use a friendlier sidebar label.` | `src/client/src/components/MachineDialog.ts:106–108` | 字段与说明 | `core.machine.name*`（拟） | — | 2③ | ⬜ |
| DLG-032 | `Bearer token` / `optional` / `Paste only the token value; PI WEB sends it as an Authorization: Bearer header.` | `src/client/src/components/MachineDialog.ts:110–113` | 字段与说明 | `core.machine.token*`（拟） | — | 2③ | ⬜ |
| DLG-033 | `Leave blank if the remote machine does not require one` | `src/client/src/components/MachineDialog.ts:112` | 输入 placeholder | `core.machine.tokenPlaceholder`（拟） | — | 2③ | ⬜ |
| DLG-034 | `After you enter a URL, PI WEB will suggest a machine name and let you add an optional bearer token.` | `src/client/src/components/MachineDialog.ts:116` | 初始说明 | `core.machine.initialNote`（拟） | — | 2③ | ⬜ |
| DLG-040 | `Clean up sessions` | `src/client/src/components/SessionCleanupDialog.ts:34` | 对话框标题 | `core.session.cleanupDialogTitle`（拟） | — | 2③ | ⬜ |
| DLG-041 | `Preview manual cleanup for this machine before archiving idle sessions or permanently deleting old archived sessions.` | `src/client/src/components/SessionCleanupDialog.ts:39` | 对话框说明 | `core.session.cleanupDescription`（拟） | — | 2③ | ⬜ |
| DLG-042 | `Close cleanup`（title/aria-label） | `src/client/src/components/SessionCleanupDialog.ts:38–39` | 关闭按钮 | `core.session.cleanupClose`（拟） | — | 2③ | ⬜ |
| DLG-043 | `Archive non-archived sessions idle for more than {days} days` / `Delete archived sessions archived for more than {days} days` | `src/client/src/components/SessionCleanupDialog.ts:64–69` | 阈值字段 | `core.session.cleanupArchiveThreshold*` / `*DeleteThreshold*`（拟） | `days` | 2③ | ⬜ |
| DLG-044 | `Deletion is permanent.` / `Cleanup only deletes sessions that are already archived.` | `src/client/src/components/SessionCleanupDialog.ts:70` | 说明 | `core.session.cleanupDeletionNotes*`（拟） | — | 2③ | ⬜ |
| DLG-045 | `Thresholds changed. Preview again before running cleanup.` | `src/client/src/components/SessionCleanupDialog.ts:78` | 警告 | `core.session.cleanupThresholdsChanged`（拟） | — | 2③ | ⬜ |
| DLG-046 | `Preview` / `Cleanup preview`（aria-label） | `src/client/src/components/SessionCleanupDialog.ts:92–93` | 预览按钮 | `core.session.cleanupPreview*`（拟） | — | 2③ | ⬜ |
| DLG-047 | `No sessions match these thresholds.` | `src/client/src/components/SessionCleanupDialog.ts:94` | 预览空状态 | `core.session.cleanupNoMatches`（拟） | — | 2③ | ⬜ |
| DLG-048 | `Clean up` | `src/client/src/components/SessionCleanupDialog.ts:97` | 执行按钮 | `core.session.cleanupRun`（拟） | — | 2③ | ⬜ |
| DLG-049 | `Project/workspace path` / `Archive` / `Delete archived` | `src/client/src/components/SessionCleanupDialog.ts:98–99` | 表格列头 | `core.session.cleanupTable*`（拟） | — | 2③ | ⬜ |
| DLG-050 | `Selected totals` / `Cleanup projects table`（aria-label） | `src/client/src/components/SessionCleanupDialog.ts:102、95` | 汇总与表格 aria | `core.session.cleanupTotals` / `.tableAriaLabel`（拟） | — | 2③ | ⬜ |
| DLG-051 | `{selected} busy {skipped} skipped.` | `src/client/src/components/SessionCleanupDialog.ts:110` | 汇总行 | `core.session.cleanupBusySkipped`（拟） | `selected`、`skipped` | 2③ | ⬜ |
| DLG-052 | `{selected} of {total} projects selected` / `Select all` / `Deselect all` | `src/client/src/components/SessionCleanupDialog.ts:118–120` | 项目选择 | `core.session.cleanupSelection*`（拟） | `selected`、`total` | 2③ | ⬜ |
| DLG-053 | `Select at least one project to run cleanup.` | `src/client/src/components/SessionCleanupDialog.ts:123` | 校验提示 | `core.session.cleanupSelectAtLeastOne`（拟） | — | 2③ | ⬜ |
| DLG-054 | `Cleanup complete` / `Archived {archived} {plural}; permanently deleted {deleted} archived {plural}.` / `Cleanup result`（aria-label） | `src/client/src/components/SessionCleanupDialog.ts:140–142` | 结果区 | `core.session.cleanupComplete*`（拟） | `archived`、`deleted` | 2③ | ⬜ |
| DLG-060 | `Questions` / `{answered} of {total} answered` / `Custom` / `Custom answer` / `Send without answering: {question}` / `Unanswered` / `Custom: {value}` / `Draft answer · not sent` | `src/client/src/components/AskUserCard.ts:73–74,138,144,164,190,215,219,221` | AskUser 卡片（问题文本为插件/用户内容 EXC-009，仅框架文案可译） | `core.askUser.*`（拟） | `answered`、`total`、`question`、`value` | 2③ | ⬜ |
| DLG-061 | `Choices`（aria-label）/ `Your answer`（aria-label）/ `Cancel` | `src/client/src/components/ExtensionDialogCard.ts:163,179,185` | 扩展对话框卡片 | `core.extensionDialog.*`（拟） | — | 2③ | ⬜ |

### 4.7 通知（阶段 2 PR④）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| NOTICE-001 | `{machineName} is unavailable; reconnecting…` / `{machineName} is still unavailable.` | `src/client/src/components/PiWebApp.ts:1017–1020`、`src/client/src/controllers/machineController.ts:155` | 机器不可用横幅（`{detail}` 为服务端/网络原文，前缀可译、详情保留，见 §6.3） | `core.notice.machineUnavailable` / `.machineStillUnavailable`（拟） | `machineName` | 2④ | ⬜ |
| NOTICE-002 | `Machine not found: {machineId}` | `src/client/src/components/PiWebApp.ts:714` | 机器错误横幅 | `core.notice.machineNotFound`（拟） | `machineId` | 2④ | ⬜ |
| NOTICE-003 | `Failed to start workspace removal: {message}` | `src/client/src/components/PiWebApp.ts:2684、2697` | 工作区移除失败横幅（与 §4.10 SRV-002 的服务端通知匹配耦合，须先改稳定标识） | `core.notice.workspaceRemovalFailed`（拟） | `message` | 2④（依赖 4 阶段标识改造） | ⬜ |
| NOTICE-004 | `Workspace removal is not available` | `src/client/src/components/PiWebApp.ts:2652` | 工作区移除不可用横幅 | `core.notice.workspaceRemovalUnavailable`（拟） | — | 2④ | ⬜ |
| NOTICE-005 | `Workspace removal succeeded, but refreshing the workspace list failed: {error}. Retrying…` | `src/client/src/components/PiWebApp.ts:2889` | 移除后刷新失败提示 | `core.notice.workspaceRefreshFailed`（拟） | `error` | 2④ | ⬜ |
| NOTICE-006 | `Action failed: {message}` | `src/client/src/components/PiWebApp.ts:2943` | 动作失败横幅 | `core.notice.actionFailed`（拟） | `message` | 2④ | ⬜ |
| NOTICE-007 | `No session status yet` | `src/client/src/components/PromptEditor.ts:178` | 状态栏空态 | `core.notice.noSessionStatus`（拟） | — | 2④ | ⬜ |
| NOTICE-008 | `{count} queued` | `src/client/src/components/StatusBar.ts:62` | 状态栏队列计数 | `core.notice.queued`（拟） | `count` | 2④ | ⬜ |
| NOTICE-009 | `Failed to dismiss notification: {error}` / `Failed to dismiss session notifications: {error}` / `Failed to refresh notifications for session {sessionId}` | `src/client/src/controllers/sessionNotificationController.ts:175、206、240` | 通知操作错误 | `core.notice.dismissFailed*` / `.refreshFailed`（拟） | `error`、`sessionId` | 2④ | ⬜ |
| NOTICE-010 | `Fork from the session tree is unavailable. Restart the session daemon to enable it.` | `src/client/src/api/:308` | 会话树分叉错误 | `core.notice.forkUnavailable`（拟） | — | 2④ | ⬜ |
| NOTICE-011 | `Session history is unavailable.` | `src/client/src/controllers/sessionController.ts:592` | 历史加载失败（服务端 `message` 优先） | `core.notice.sessionHistoryUnavailable`（拟） | — | 2④ | ⬜ |
| NOTICE-012 | `Archive failed: {error}` / `Delete failed: {error}` | `src/client/src/controllers/sessionController.ts:797、826` | 批量操作失败 | `core.notice.archiveFailed` / `.deleteFailed`（拟） | `error` | 2④ | ⬜ |
| NOTICE-013 | `Failed to start session: {message}` | `src/client/src/controllers/sessionController.ts:1695` | 启动会话失败 | `core.notice.startSessionFailed`（拟） | `message` | 2④ | ⬜ |
| NOTICE-014 | `Session started, but it could not be selected: {error}` | `src/client/src/controllers/sessionController.ts:1630、1648` | 启动后选择失败 | `core.notice.sessionSelectFailed`（拟） | `error` | 2④ | ⬜ |
| NOTICE-015 | `Failed to refresh workspaces for project {projectId} on {machineId}` | `src/client/src/controllers/workspaceController.ts:175` | 后台刷新失败（onBackgroundError） | `core.notice.refreshWorkspacesFailed`（拟） | `projectId`、`machineId` | 2④ | ⬜ |

### 4.8 模型与认证（阶段 2 PR③）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| MODEL-001 | `Select Model` | `src/client/src/components/PromptEditor.ts:179` | 模型对话框标题 | `core.model.dialogTitle`（拟） | — | 2③ | ⬜ |
| MODEL-002 | `✓ current` | `src/client/src/components/PiWebApp.ts:3005` | 模型选项当前标记 | `core.model.currentMarker`（拟） | — | 2③ | ⬜ |
| MODEL-003 | `Select Thinking Level` | `src/client/src/components/PiWebApp.ts:3114` | 思考等级对话框标题 | `core.model.thinkingDialogTitle`（拟） | — | 2③ | ⬜ |
| MODEL-004 | `Select Theme`（对话框标题，与 CMD-018 动作同文案） | `src/client/src/components/PiWebApp.ts:3023` | 主题对话框标题 | `core.theme.dialogTitle`（拟） | — | 2③ | ⬜ |
| MODEL-005 | `Auto {state}`（`✓ on`/`off`） | `src/client/src/components/PiWebApp.ts:3027` | 主题自动选项标签 | `core.theme.autoOption`（拟） | — | 2③ | ⬜ |
| MODEL-006 | `Follow the system light/dark preference when the selected theme has a pair.` | `src/client/src/components/PiWebApp.ts:3084–3085` | 自动主题说明 | `core.theme.autoDescription`（拟） | — | 2③ | ⬜ |
| MODEL-007 | `On, but the selected theme has no light/dark pair, so it will stay selected.` | `src/client/src/components/PiWebApp.ts:3086` | 无配对时说明 | `core.theme.autoNoPair`（拟） | — | 2③ | ⬜ |
| MODEL-008 | `On · {pairName} follows the system {scheme} preference.` | `src/client/src/components/PiWebApp.ts:3087` | 配对生效说明 | `core.theme.autoPairActive`（拟） | `pairName`（插件贡献 EXC-011）、`scheme`（light/dark） | 2③ | ⬜ |
| MODEL-009 | `✓ {markers}`（`selected`/`active`，`·` 连接） | `src/client/src/components/PiWebApp.ts:3091–3095` | 主题选项标记 | `core.theme.optionMarker`（拟） | — | 2③ | ⬜ |
| MODEL-010 | `auto pair` | `src/client/src/components/PiWebApp.ts:3100` | 主题选项描述片段 | `core.theme.autoPairBadge`（拟） | — | 2③ | ⬜ |
| AUTH-001 | 提供商名称列表与描述 | `src/client/src/components/AuthDialog.ts`（搜索/选择列表） | 认证对话框提供商 | 提供商名称为第三方数据（EXC-012），无可译框架文案 | — | — | ⬜（无可译项） |

### 4.9 六个自带浏览器插件（阶段 3）

命名空间：各插件 `plugin.<id>`；表格中标注的键为**（拟）**，随插件迁移冻结。贡献标题/面板标题等注册时字符串按计划改为显示期解析，保留稳定贡献 ID。

#### 4.9.1 terminal（`plugin.terminal.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.TERM-001 | `Command is running. Press {key} or use the button to cancel.` | `pi-web-plugins/terminal/TerminalPanel.ts:827` | 运行提示条 | `plugin.terminal.runningHint`（拟） | `key`（`Ctrl`，修饰键名保留） | 3 | ⬜ |
| PLUG.TERM-002 | `Refresh` / `Copy all` | `pi-web-plugins/terminal/TerminalPanel.ts:935` | 复制控制按钮 | `plugin.terminal.copyControls.refresh` / `.copyAll`（拟） | — | 3 | ⬜ |
| PLUG.TERM-003 | `Terminal copy controls`（aria-label）/ `Terminal copy mode`（aria-label） | `pi-web-plugins/terminal/TerminalPanel.ts:933、946` | 复制控件 aria | `plugin.terminal.copyControlsAriaLabel` / `.copyModeAriaLabel`（拟） | — | 3 | ⬜ |
| PLUG.TERM-004 | `Keys` | `pi-web-plugins/terminal/TerminalPanel.ts:1008` | 软键盘标签 | `plugin.terminal.softKeysLabel`（拟） | — | 3 | ⬜ |
| PLUG.TERM-005 | `Loading terminals…` | `pi-web-plugins/terminal/TerminalPanel.ts:1047` | 终端列表加载 | `plugin.terminal.loadingTerminals`（拟） | — | 3 | ⬜ |
| PLUG.TERM-006 | `Terminal soft keys`（aria-label） | `pi-web-plugins/terminal/TerminalSoftKeys.ts:64` | 软键盘 aria | `plugin.terminal.softKeysAriaLabel`（拟） | — | 3 | ⬜ |
| PLUG.TERM-007 | 复制模式名称与取消/确认标签 | `pi-web-plugins/terminal/terminalCopySnapshot.ts`、`pi-web-plugins/terminal/TerminalPanel.ts`（soft-key 与按钮文案） | 复制交互 | `plugin.terminal.copyMode.*`（拟） | — | 3 | ⬜ |

#### 4.9.2 files（`plugin.files.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.FILES-001 | `Files unavailable.` | `pi-web-plugins/files/FilesPanel.ts:86` | 面板不可用 | `plugin.files.unavailable`（拟） | — | 3 | ⬜ |
| PLUG.FILES-002 | `Files is unavailable on this host.` | `pi-web-plugins/files/FilesPanel.ts:90` | 面板不可用说明 | `plugin.files.unavailableOnHost`（拟） | — | 3 | ⬜ |
| PLUG.FILES-003 | `Files requires workspace-files capability v1.` | `pi-web-plugins/files/FilesPanel.ts:96` | 能力缺失说明 | `plugin.files.requiresCapability`（拟） | — | 3 | ⬜ |
| PLUG.FILES-004 | `Files`（面板标题）/ `loading…` / `stale` | `pi-web-plugins/files/FilesPanel.ts:105、111–112` | 面板标题与状态 | `plugin.files.panelTitle` / `.loading` / `.stale`（拟） | — | 3 | ⬜ |
| PLUG.FILES-005 | `No files loaded.` | `pi-web-plugins/files/FilesPanel.ts:123` | 空状态 | `plugin.files.empty`（拟） | — | 3 | ⬜ |
| PLUG.FILES-006 | `Uploads` / `Workspace uploads`（aria-label） | `pi-web-plugins/files/FilesPanel.ts:203、201` | 上载分区 | `plugin.files.uploads*`（拟） | — | 3 | ⬜ |
| PLUG.FILES-007 | `Upload` / `Review file upload`（aria-label） | `pi-web-plugins/files/FilesPanel.ts:248` | 上载确认 | `plugin.files.upload*`（拟） | — | 3 | ⬜ |
| PLUG.FILES-008 | `Cancel` / `Dismiss` | `pi-web-plugins/files/FilesPanel.ts:219–220` | 上载通知按钮 | `plugin.files.cancel` / `.dismiss`（拟） | — | 3 | ⬜ |
| PLUG.FILES-009 | `Open ↗` / `Open in new window`（title） | `pi-web-plugins/files/FilesViewer.ts:139、138` | 查看器工具栏 | `plugin.files.open*`（拟） | — | 3 | ⬜ |
| PLUG.FILES-010 | `Raw source is truncated. Use Download for the complete file.` / `Preview is rendered from truncated source. Use Download for the complete file.` | `pi-web-plugins/files/FilesViewer.ts:167、177` | 截断提示 | `plugin.files.truncated*`（拟） | — | 3 | ⬜ |
| PLUG.FILES-011 | `Inline PDF support varies by browser. Use Open ↗ or Download above if the document does not appear.` | `pi-web-plugins/files/FilesViewer.ts:208` | PDF 说明 | `plugin.files.pdfNote`（拟） | — | 3 | ⬜ |
| PLUG.FILES-012 | `Preview failed for {path}. Open it in a new window or use Download above.` / `Retry preview` | `pi-web-plugins/files/FilesViewer.ts:224–226` | 预览失败 | `plugin.files.previewFailed*`（拟） | `path`（动态） | 3 | ⬜ |
| PLUG.FILES-013 | `Preview isn't available for this file type.` / `Download {name} · {size}` | `pi-web-plugins/files/FilesViewer.ts:240–241` | 预览不可用/下载 | `plugin.files.previewUnavailable` / `.download`（拟） | `name`、`size` | 3 | ⬜ |

#### 4.9.3 git（`plugin.git.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.GIT-001 | `Git`（面板标题）/ `stale` | `pi-web-plugins/git/browser/git-panel.ts:429、431` | 面板标题与状态 | `plugin.git.panelTitle` / `.stale`（拟） | — | 3 | ⬜ |
| PLUG.GIT-002 | `Changed files view`（aria-label） | `pi-web-plugins/git/browser/git-panel.ts:449` | 文件列表 aria | `plugin.git.changedFilesAriaLabel`（拟） | — | 3 | ⬜ |
| PLUG.GIT-003 | `Not a git repository.` / `No changes.` | `pi-web-plugins/git/browser/git-panel.ts:481、483` | 面板空状态 | `plugin.git.notARepository` / `.noChanges`（拟） | — | 3 | ⬜ |
| PLUG.GIT-004 | `Select a changed file.` / `Loading diff…` / `No staged or unstaged diff.` / `No diff.` | `pi-web-plugins/git/browser/git-panel.ts:584–599` | 差异区空态/加载 | `plugin.git.diff.*`（拟） | — | 3 | ⬜ |
| PLUG.GIT-005 | `Unified diff`（aria-label） | `pi-web-plugins/git/browser/git-panel.ts:601` | 差异视图 aria | `plugin.git.unifiedDiffAriaLabel`（拟） | — | 3 | ⬜ |
| PLUG.GIT-006 | `submodule` | `pi-web-plugins/git/browser/git-panel.ts:687` | 条目类型徽标 | `plugin.git.submoduleBadge`（拟） | — | 3 | ⬜ |

#### 4.9.4 info（`plugin.info.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.INFO-001 | `Copy PI WEB Diagnostics` / `Copy version, installation, and status details for this machine, ready to paste into a bug report` | `pi-web-plugins/info/pi-web-plugin.ts:19–20` | 动作注册 | `plugin.info.copyDiagnostics*`（拟） | — | 3 | ⬜ |
| PLUG.INFO-002 | `Info`（面板标题） | `pi-web-plugin.ts:35` | 面板标题 | `plugin.info.panelTitle`（拟） | — | 3 | ⬜ |
| PLUG.INFO-003 | `folder`（workspace kind-label 回退值） | `pi-web-plugin.ts:29` | 工作区标签项 | `plugin.info.folderKindLabel`（拟） | — | 3 | ⬜ |
| PLUG.INFO-004 | `Version` / `Pi` / `Package` / `Installation` / `Release` | `pi-web-plugins/info/infoInternals.ts:144–168` | 信息面板字段标签 | `plugin.info.field.*`（拟） | — | 3 | ⬜ |
| PLUG.INFO-005 | `Status generated {generatedAt}` | `pi-web-plugins/info/infoInternals.ts:168` | 生成时间 | `plugin.info.statusGenerated`（拟） | `generatedAt` | 3 | ⬜ |
| PLUG.INFO-006 | `Services` / `Machine` / `Name` / `Type` / `Workspace` / `Path` | `pi-web-plugins/info/infoInternals.ts:171–203` | 分区与字段标签 | `plugin.info.section.*`（拟） | — | 3 | ⬜ |
| PLUG.INFO-007 | `Update available` / `Update check skipped` / `Up to date` | `pi-web-plugins/info/infoInternals.ts:43–48` | 发布状态 | `plugin.info.release.*`（拟） | — | 3 | ⬜ |
| PLUG.INFO-008 | `Pi package` / `Docker development runtime` / `Docker runtime` | `pi-web-plugins/info/infoInternals.ts:27、32` | 安装来源/类型 | `plugin.info.installation.*`（拟） | — | 3 | ⬜ |
| PLUG.INFO-009 | `Status: unavailable` / `Workspace: none selected` | `pi-web-plugins/info/infoInternals.ts:89、100` | 诊断空值 | `plugin.info.diagnostic.*`（拟） | — | 3 | ⬜ |

#### 4.9.5 updates（`plugin.updates.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.UPD-001 | `running {version} · installed {version}` | `pi-web-plugins/updates/pi-web-plugin.ts:25` | 版本行 | `plugin.updates.versionLine`（拟） | `version` ×2 | 3 | ⬜ |
| PLUG.UPD-002 | `Copy` / `Run` | `pi-web-plugin.ts:35–36` | 命令操作按钮 | `plugin.updates.copy` / `.run`（拟） | — | 3 | ⬜ |
| PLUG.UPD-003 | `No PI WEB update or restart messages.` | `pi-web-plugin.ts:78` | 空状态 | `plugin.updates.empty`（拟） | — | 3 | ⬜ |
| PLUG.UPD-004 | `Recommended` / `Run this one command to bring this installation fully up to date. Nothing else is required.` | `pi-web-plugin.ts:86–88` | 推荐命令区 | `plugin.updates.recommended*`（拟） | — | 3 | ⬜ |
| PLUG.UPD-005 | `Only needed for finer control, such as restarting a single service.` | `pi-web-plugin.ts:100` | 次级命令区说明 | `plugin.updates.advancedNote`（拟） | — | 3 | ⬜ |
| PLUG.UPD-006 | `Updates`（面板标题） | `pi-web-plugin.ts:110、142` | 面板标题 | `plugin.updates.panelTitle`（拟） | — | 3 | ⬜ |
| PLUG.UPD-007 | `Checking PI WEB update status…` | `pi-web-plugin.ts:111` | 加载态 | `plugin.updates.checking`（拟） | — | 3 | ⬜ |
| PLUG.UPD-008 | `Release checked {time}` / `Remote version check skipped.` / `Remote version check failed: {error}` | `pi-web-plugin.ts:159–161` | 检查结果 | `plugin.updates.releaseChecked` / `.checkSkipped` / `.checkFailed`（拟） | `time`、`error` | 3 | ⬜ |

#### 4.9.6 workspace-tasks（`plugin.tasks.*`）

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| PLUG.TASKS-001 | `Workspace Tasks` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:77` | 面板标题 | `plugin.tasks.panelTitle`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-002 | `Refresh` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:79` | 刷新按钮 | `plugin.tasks.refresh`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-003 | `That task is no longer available. Click Refresh, then try again.` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:108` | 任务失效错误 | `plugin.tasks.taskUnavailable`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-004 | `No tasks are defined in {path}. Add tasks to the file, then click Refresh.` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:124` | 配置空状态 | `plugin.tasks.noTasksConfigured`（拟） | `path`（动态路径 EXC-002） | 3 | ⬜ |
| PLUG.TASKS-005 | `Tasks run in a dedicated workspace terminal, then switch to that terminal. Edit {path} and click Refresh to reload.` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:126` | 面板说明 | `plugin.tasks.description`（拟） | `path` | 3 | ⬜ |
| PLUG.TASKS-006 | `Another task is already starting. Wait for it to finish dispatching, then try again.` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:152` | 并发提示 | `plugin.tasks.alreadyStarting`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-007 | `Select a workspace before opening a terminal.` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:187` | 校验错误 | `plugin.tasks.selectWorkspaceFirst`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-008 | `Run` / `Dispatching…` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:271` | 任务按钮 | `plugin.tasks.run` / `.dispatching`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-009 | `Run {taskTitle}?\n\n{taskCommand}` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:156` | 确认对话框 | `plugin.tasks.runConfirmation`（拟） | `taskTitle`、`taskCommand`（用户命令，EXC-001） | 3 | ⬜ |
| PLUG.TASKS-010 | `No workspace tasks configured here.` / `Could not load workspace tasks.` / `Path does not exist` | `pi-web-plugins/workspace-tasks/workspaceTasksClient.ts:3–8` | 加载错误 | `plugin.tasks.config*`（拟） | — | 3 | ⬜ |
| PLUG.TASKS-011 | `Fix {configPath}, then click Refresh.` | `pi-web-plugins/workspace-tasks/workspaceTasksClient.ts:6` | 修复提示 | `plugin.tasks.fixConfigHint`（拟） | `configPath` | 3 | ⬜ |
| PLUG.TASKS-012 | `Refreshing {configPath}…` | `pi-web-plugins/workspace-tasks/tasksPanelElement.ts:138` | 刷新中 | `plugin.tasks.refreshing`（拟） | `configPath` | 3 | ⬜ |

### 4.10 服务端自有提示/状态/通知（阶段 4）

阶段 4 将项目自有文案改为稳定 `code/id + params + 英文后备`，浏览器优先翻译已知 code。键名待该阶段设计冻结，此处先登记文案与耦合点。

| ID | 英文默认文案/模板 | 源码位置 | 显示组件/场景 | 键 | 参数 | 阶段/PR | 状态 |
|---|---|---|---|---|---|---|---|
| SRV-001 | `PI WEB update available` / `PI WEB {latestVersion} is available{; installed version is {installedVersion}}. Update PI WEB, then restart the services or processes for this installation.` / `… Run the update command to update PI WEB and restart its services.` | `src/server/piWebStatus.ts:604–609` | 状态消息（info，`update-available`） | `core.status.updateAvailable*`（待定） | `latestVersion`、`installedVersion` | 4 | ⬜ |
| SRV-002 | `Web/UI service restart needed` / `The Web/UI service is running {runtimeVersion}, but {installedVersion} is installed. Restart the Web/UI service or process to use the installed version.`（命令分支各一版） | `src/server/piWebStatus.ts:616–623` | 状态消息（warning，`web-stale`） | `core.status.webStale*`（待定） | `runtimeVersion`、`installedVersion` | 4 | ⬜ |
| SRV-003 | `Session daemon version unavailable` / `PI WEB could not check the session daemon version{: {error}}. Check the session daemon service or process that runs this installation.` | `src/server/piWebStatus.ts:630–637` | 状态消息（warning，`sessiond-unavailable`） | `core.status.sessiondUnavailable*`（待定） | `error` | 4 | ⬜ |
| SRV-004 | `Session daemon restart needed` / `The session daemon is running {runtimeVersion}, but {installedVersion} is installed. Restart the session daemon service or process to use the installed version.` | `src/server/piWebStatus.ts:641–650` | 状态消息（warning，`sessiond-stale`） | `core.status.sessiondStale*`（待定） | `runtimeVersion`、`installedVersion` | 4 | ⬜ |
| SRV-005 | `Workspace removal failed: {message}` | `src/server/workspaces/workspaceRemovalService.ts:211` | 服务端通知（source=`workspace.delete`，见 §4.7 NOTICE-003） | `core.notice.workspaceRemovalFailed*`（待定） | `message` | 4 | ⬜ |
| SRV-006 | 会话运行时警告（`type:"warning"`, `source`, `path`） | `src/server/sessions/*`（`collectRuntimeWarnings` 等） | 聊天会话警告横幅（外壳文案见 CHAT-001/002） | 消息正文来自会话运行时（EXC-009），仅外壳可译 | — | 2③（外壳）/4（耦合点） | ⬜ |
| SRV-007 | 服务端通知通用结构（severity/message/source/scope/context） | `src/server/notices/serverNoticeStore.ts:12–76` | 通知投影（浏览器经 `errorBanner` 渲染 `notice.message`） | 迁移时按稳定 code 匹配（见 §8.2） | — | 4 | ⬜ |

## 5. 阶段 1 已完成条目与验证证据（10 键核对）

以下条目已在提交 `39ba609e` 中完成迁移。英文文案与 `src/client/src/i18n/locales/en.ts` 逐字一致，调用位置已核实；命名空间 `core`。

| ID | 键 | 完整英文默认文案 | 调用位置 | 参数 | 状态 | 验证证据 |
|---|---|---|---|---|---|---|
| PILOT-001 | `core.common.reload` | `Reload` | `src/client/src/components/settings/SettingsGeneralPanel.ts:55`（`.actionLabel`） | — | ✅ 已迁移（`39ba609e`） | 单测 `translate.test.ts`（键名前缀/插值）、`SettingsGeneralPanel.language.test.ts`；构建产物含英文默认 |
| PILOT-002 | `core.settings.generalConfiguration` | `General configuration` | `src/client/src/components/settings/SettingsGeneralPanel.ts:53`（`.heading`） | — | ✅ 已迁移（`39ba609e`） | 同上；语言包安装后渲染 `常规配置` |
| PILOT-003 | `core.settings.generalDescription` | `Gateway server fields edit this local gateway. File access and upload defaults edit {targetLabel}.` | `src/client/src/components/settings/SettingsGeneralPanel.ts:54`（`.description`） | `targetLabel` | ✅ 已迁移（`39ba609e`） | 插值单测（缺参显式保留 `{targetLabel}`）；zh 包插值句 |
| PILOT-004 | `core.settings.languagePreference` | `Language preference` | `src/client/src/components/settings/SettingsGeneralPanel.ts:73`（h3） | — | ✅ 已迁移（`39ba609e`） | 组件测试断言 zh 下 `语言偏好` |
| PILOT-005 | `core.settings.languagePreferenceDescription` | `This setting applies to the browser interface only. It does not change system prompts or remote machine configuration.` | `src/client/src/components/settings/SettingsGeneralPanel.ts:74`（p） | — | ✅ 已迁移（`39ba609e`） | 组件测试（面板渲染） |
| PILOT-006 | `core.language.label` | `Language` | `src/client/src/components/settings/SettingsGeneralPanel.ts:71`（section aria-label）、`:77`（字段标题） | — | ✅ 已迁移（`39ba609e`） | 语言卡片 aria/标题断言 |
| PILOT-007 | `core.language.auto` | `Auto` | `src/client/src/i18n/locale.ts` `getLanguageOptions()`（:95–96）→ 面板 select 选项 | — | ✅ 已迁移（`39ba609e`） | 无语言包时仅有 Auto/English（组件测试） |
| PILOT-008 | `core.language.english` | `English` | 同上 | — | ✅ 已迁移（`39ba609e`） | 同上 |
| PILOT-009 | `core.language.description` | `Choose the interface language. Auto follows your browser language and falls back to English.` | `src/client/src/components/settings/SettingsGeneralPanel.ts:81`（small） | — | ✅ 已迁移（`39ba609e`） | 面板渲染 |
| PILOT-010 | `core.language.unavailable` | `{label} (unavailable)` | `src/client/src/i18n/locale.ts` `getLanguageOptions()`（:105）→ select 禁用选项 | `label` | ✅ 已迁移（`39ba609e`） | 保存 `ko-KR` 偏好而包缺失时显示 `ko-KR (unavailable)`（组件测试） |

简体中文译文（10 键，`locale-packs/pi-web-locale-zh-cn/browser/locale-zh-cn.js`，与英文键集合一致，已核对）：`重新加载`/`自动`/`English`/`语言`/`选择界面语言。自动模式跟随浏览器语言，不支持时使用英文。`/`{label}（不可用）`/`网关服务器字段用于编辑当前网关；文件访问和上传默认值用于编辑{targetLabel}。`/`语言偏好`/`此设置只作用于浏览器界面，不会改变系统提示词或远程主机配置。`/`常规配置`。

## 6. 排除记录

### 6.1 不可译内容（逐条）

| ID | 来源 | 对象 | 排除理由 |
|---|---|---|---|
| EXC-001 | 终端/工具执行视图、workspace-tasks 确认框、会话与工具输出 | 命令原文、工具原始输出、diff 内容、shell 输出 | 属用户/工具产生的执行内容，非 PI WEB 界面文案；翻译会改变语义 |
| EXC-002 | 文件路径、工作目录、会话/工作区/项目 ID、终端 ID、URL | `context.workspace.path`、`config.path`、`TASKS_CONFIG_PATH` 等 | 业务标识与路径，翻译无意义且破坏匹配 |
| EXC-003 | 配置键名与代码值 | `plugins`、`shortcuts`、`null`、`true`、`127.0.0.1`、`8504` | 配置语法与代码字面量 |
| EXC-004 | 插件/贡献 ID、动作 ID、快捷键 | `core:actions.show`、`mod+g p`、`mod+k` | 稳定 ID 与快捷键，计划要求保留 |
| EXC-005 | 命令与配置语法示例 | `/login`、`/logout`、`npm:@scope/package, git URL, or local path`、`.pi/settings.json`、`Authorization: Bearer` | 命令/键名/协议头名称，属技术语法；所在字段标题与说明仍可译 |
| EXC-006 | 示例占位值 | `example.local\n192.168.1.20`、`~/SDKs\n/opt/reference`、`/path/to/project or ~/code/project` | 输入示例值，随所在字段一起迁移（SET-038/039、DLG-022），必要时可保留原文 |
| EXC-007 | 默认上传/附件文件夹常量值 | `DEFAULT_WORKSPACE_UPLOADS_FOLDER`、`DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER` 的值 | 产品默认路径值；外围 `default` 字样可译（SET-031/036） |
| EXC-008 | 模型/提供商/技能名称、版本号 | `model.id`、`provider`、版本号、skill 名 | 第三方/产品数据标识 |
| EXC-009 | AskUserCard 问题与选项、扩展对话框消息、会话运行时警告正文、第三方插件自有文案 | 插件/用户提供的内容 | 内容所有者非 PI WEB 界面；框架外壳（§4.6 DLG-060/061、CHAT-001/002）可译 |
| EXC-010 | 插件健康/服务端诊断原文 | `plugin.server.message`、`plugin.server.health.message` | 服务端与插件原文；外壳 `Health:` 可译（SET-093） |
| EXC-011 | 主题贡献名称/描述、语言包 label/aliases | `theme.name`、`theme.description`、`LocaleContribution.label` | 插件贡献数据，由贡献者负责多语言 |
| EXC-012 | 认证提供商名称、授权 URL、OAuth 重定向页 | 第三方认证流程数据 | 第三方服务内容 |
| EXC-013 | 机器名、项目名、会话名、工作区标签 | `project.name`、`machine.name`、`session.name`、`workspace.label` | 用户数据，经参数插值进入可译模板 |

### 6.2 动态内容表达式登记（不枚举运行时值）

| 表达式 | 类别 | 所在条目 |
|---|---|---|
| `${project.name}` | 项目名（EXC-013） | PWS-053/054/055 |
| `${machineName}` | 机器名 | NOTICE-001 |
| `${machineId}` / `${projectId}` / `${sessionId}` | 业务 ID（EXC-002/004） | NOTICE-002/015 |
| `${count}`、`${total}`、`${start}`、`${end}`、`${selected}`、`${archived}`、`${deleted}`、`${days}`、`${n}` | 计数/数字 | PWS-002/011/021/031/033/036/042、CHAT-006/008/011/018/042、DLG-043/051/052/054 |
| `${latestVersion}`、`${installedVersion}`、`${runtimeVersion}` | 版本号（EXC-008） | SRV-001..004 |
| `${error}`、`${message}`、`${detail}` | 错误/诊断原文（EXC-010） | NOTICE-003/005/006/009/011/012/013/014、DLG-024、PLUG.UPD-008 |
| `${path}`、`${configPath}`、`${generatedAt}`、`${time}` | 路径/时间戳（EXC-002） | PLUG.FILES-012/013、PLUG.TASKS-004/005/011/012、PLUG.INFO-005、PLUG.UPD-008 |
| `${taskTitle}`、`${taskCommand}` | 用户任务数据（EXC-001） | PLUG.TASKS-009 |
| `${question}`、`${value}` | 用户/插件内容（EXC-009） | DLG-060 |
| `${pairName}`、`${scheme}` | 主题贡献数据（EXC-011）/ 枚举值 | MODEL-008 |
| `${key}` | 修饰键名（EXC-004） | PLUG.TERM-001 |
| `${targetLabel}` | 机器名（EXC-013） | PILOT-003、SET-016/020/022/024、SET-072/078/080/081/090/091/096 |
| `${name}`、`${size}`、`${status}`、`${version}` | 文件名/大小/状态/版本 | CHAT-016、CHAT-020/026、PLUG.FILES-013、PLUG.UPD-001 |

### 6.3 产品错误前缀与第三方原始详情的分离

- 可译前缀：`{machineName} is unavailable; reconnecting…`、`{machineName} is still unavailable.`（NOTICE-001）、`Action failed:`（NOTICE-006）、`Failed to start workspace removal:`（NOTICE-003）、`Archive failed:`/`Delete failed:`（NOTICE-012）、`Session started, but it could not be selected:`（NOTICE-014）、`Remote version check failed:`（PLUG.UPD-008）。
- 保留原文：冒号后的 `${error}`/`${message}`/`${detail}`（服务端、网络、插件、第三方诊断），作为参数注入，不整条排除。
- 专用诊断信息面板（`plugin.server.message` 等，EXC-010）整条保留原文，仅外壳 `Health:` 可译。
- 静态 PWA manifest（安装名称/描述/主题色）由浏览器在加载前读取，运行时插件无法改变，**列为后续范围**（阶段 5 单列议题；`docs/localization.md` 已同步说明）。本条不作为阶段 0 的可译条目。

## 7. 验收记录

### 7.1 区域覆盖汇总

| 区域 | 条目 ID 范围 | 条目数 | 已迁移 | 待办 | 阶段 0 完成度 |
|---|---|---|---|---|---|
| 设置 | SET-001…SET-105 | 80 | 0 | 80 | 清单完成 |
| 设置（阶段 1 试点） | PILOT-001…PILOT-010 | 10 | 10 | 0 | 已完成并记录证据 |
| 导航 | NAV-001…NAV-022 | 14 | 0 | 14 | 清单完成 |
| 项目/工作区/会话 | PWS-001…PWS-068 | 47 | 0 | 47 | 清单完成 |
| 聊天与输入 | CHAT-001…CHAT-042 | 29 | 0 | 29 | 清单完成 |
| 命令面板 | CMD-001…CMD-023 | 20 | 0 | 20 | 清单完成 |
| 弹窗 | DLG-001…DLG-061 | 42 | 0 | 42 | 清单完成 |
| 通知 | NOTICE-001…NOTICE-015 | 15 | 0 | 15 | 清单完成 |
| 模型与认证 | MODEL-001…MODEL-010、AUTH-001 | 11 | 0 | 11 | 清单完成 |
| 自带插件 terminal | PLUG.TERM-001…007 | 7 | 0 | 7 | 清单完成 |
| 自带插件 files | PLUG.FILES-001…013 | 13 | 0 | 13 | 清单完成 |
| 自带插件 git | PLUG.GIT-001…006 | 6 | 0 | 6 | 清单完成 |
| 自带插件 info | PLUG.INFO-001…009 | 9 | 0 | 9 | 清单完成 |
| 自带插件 updates | PLUG.UPD-001…008 | 8 | 0 | 8 | 清单完成 |
| 自带插件 workspace-tasks | PLUG.TASKS-001…012 | 12 | 0 | 12 | 清单完成 |
| 服务端 | SRV-001…SRV-007 | 7 | 0 | 7 | 清单完成 |
| 排除记录 | EXC-001…EXC-013 + 动态表达式 13 组 | — | — | — | 已登记 |

合计可译文条 330 条（含阶段 1 试点 10 条）：已完成 10 条，待办 320 条；排除记录 13 条 + 动态内容表达式 13 组已登记。

### 7.2 条目验收字段

每条目的“阶段/PR”与“状态”即迁移归属与勾销字段。完成后在对应 PR 中更新状态为 ✅ 并补“完成 PR/提交”与“验证证据”（测试名与结果），不删除条目。阶段 1 的 10 条已完成并记录于 §5（完成提交 `39ba609e`，验证证据：`registry.locales.test.ts`、`locale.test.ts`、`translate.test.ts`、`SettingsGeneralPanel.language.test.ts`、`external.test.ts`、`PiWebApp.pluginHost.test.ts` 语言包用例、`npm run build` 主包不含中文词典、`npm run smoke:package-install`）。

### 7.3 待执行的验收动作

| 项 | 状态 | 原因/条件 |
|---|---|---|
| 浏览器 UI 巡检（桌面/窄屏/PWA）：对照 §4 各区域逐屏核对无未登记固定英文 | **未执行** | 本次为离线源码审查，无运行服务与浏览器 |
| 巡检通过后回填各条目“验证证据” | 待办 | 依赖上项 |
| 阶段 2①…④ PR 完成后更新状态与证据 | 待办 | 依赖对应 PR |
| 阶段 3 六插件迁移后更新 PLUG.* 条目 | 待办 | 依赖对应 PR |
| 阶段 4 服务端 code/id 化后冻结 SRV-* 键并更新 | 待办 | 依赖对应 PR；NOTICE-003 与 SRV-005 的文本匹配须先改稳定标识 |
| 静态扫描持续找新增固定英文（阶段 5） | 待办 | 依赖阶段 5 设计 |

## 8. 遗漏、待确认与注意事项

### 8.1 本次登记的已知边界

- 文本节点与属性字符串经模板抽取 + 渲染路径阅读登记；对字符串拼接/条件三元分支已逐分支展开（如 SET-006 两分支、SRV-001 两分支）。
- `src/client/src/components/settings/settingsMachineTarget.ts`、`src/client/src/components/settings/settingsPluginConfig.ts`、`src/client/src/components/settings/piPackageSettings.ts`、`src/client/src/components/settings/settingsDataLoading.ts`、`src/client/src/components/settings/settingsConfigDraft.ts` 已阅读：其可见文案经 §4.1.3 与设置面板条目覆盖（`settingsMachineTarget()` 输出为机器名，EXC-013）。
- `src/client/src/sessionNotifications.ts`/`src/client/src/serverNotices.ts` 控制器本身不含界面文案；展示经 `errorBanner`（NOTICE-009、SRV-007）与 CHAT-001/002 外壳。
- `appShell` 其余文件与 `src/client/src/components/tabIcons.ts`、`src/client/src/components/selectableRow.ts`、`src/client/src/components/promptEditorIcons.ts` 中仅有 aria-hidden 图标或纯结构标记，无可译文文案。
- CLI/服务端日志（`src/cli.ts`、`scripts/*`）非浏览器界面，不在本清单范围。

### 8.2 待确认事项（阻塞对应阶段，不阻塞阶段 0 登记）

1. **服务端通知文本匹配**：`src/client/src/components/PiWebApp.ts:2688–2692` 以 `notice.message === "Workspace removal failed: {message}"` 文本相等匹配服务端通知（SRV-005）。翻译前必须改为稳定标识匹配（计划阶段 4 前置条件），否则 NOTICE-003/SRV-005 迁移会改变去重/抑制行为。
2. **复数与富文本规则**：CHAT-006/008/018、DLG-054、NOTICE-008 含复数形态；规则待阶段 4 设计后冻结键与消息结构。
3. **键名最终冻结**：§4 中所有（拟）键在对应 PR 实施时定稿；条目 ID、文案、归属不变。
4. **PLUG.TERM-007**（terminal 复制模式文案）需在阶段 3 阅读 `pi-web-plugins/terminal/terminalCopySnapshot.ts` 全部交互分支后逐条补录，现为汇总登记。
5. **AUTH-001**：认证对话框无可译框架文案外的条目；提供商选择列表条目依赖第三方数据，登记为“无可译项”。

### 8.3 阶段 0 结论

- 逐条清单、排除记录、验收字段三项交付物已建立；规则已冻结。
- **浏览器 UI 巡检未执行**（§2.3），因此阶段 0 验收标准中“结合 UI 巡检”一项未满足，本文件不宣称阶段 0 通过；具备运行环境后按 §7.3 执行巡检并回填证据，方可判定通过。

## 9. 相关文档状态核对

- `docs/localization-plugin-implementation-plan.md`：状态行已随阶段 1 实施更新为“实施中”（阶段 0 规则与清单已冻结、阶段 1 已实现），与本文一致；本文不宣称阶段 0 通过。
- `docs/localization.md`：描述插件式架构、语言包安装与手动验证步骤；未宣称阶段 0 验收通过。
- `docs/plugins.md`：新增语言包小节（`contributions.locales` 与 `languagePack` 标记）。
- 上述文档中的状态声明均限于“阶段 1 已实现/进行中”，无提前宣称后续阶段完成的矛盾。

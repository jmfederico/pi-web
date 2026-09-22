// Simplified Chinese interface language pack for PI WEB.
//
// One LocaleContribution per message namespace. Message keys are
// namespace-local: the host resolves them as `core.<key>` for this catalog.
// Values are plain text; dynamic values arrive through {placeholder}
// interpolation and stay escaped when rendered.
const core = {
  "common.reload": "重新加载",
  "language.auto": "自动",
  "language.english": "English",
  "language.label": "语言",
  "language.description": "选择界面语言。自动模式跟随浏览器语言，不支持时使用英文。",
  "language.unavailable": "{label}（不可用）",
  "settings.generalDescription": "网关服务器字段用于编辑当前网关；文件访问和上传默认值用于编辑{targetLabel}。",
  "settings.languagePreference": "语言偏好",
  "settings.languagePreferenceDescription": "此设置只作用于浏览器界面，不会改变系统提示词或远程主机配置。",
  "settings.generalConfiguration": "常规配置",
};

export default {
  apiVersion: 4,
  name: "Simplified Chinese language pack",
  activate: () => ({
    contributions: {
      locales: [
        {
          id: "core",
          locale: "zh-CN",
          label: "简体中文",
          aliases: ["zh-Hans", "zh-SG"],
          namespace: "core",
          messages: core,
        },
      ],
    },
  }),
};

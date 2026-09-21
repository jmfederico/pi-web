import type { en } from "./en";

export const zhCN: { [Key in keyof typeof en]: string } = {
  "common.reload": "重新加载",
  "language.auto": "自动",
  "language.english": "English",
  "language.simplifiedChinese": "简体中文",
  "language.label": "语言",
  "language.description": "选择界面语言。自动模式跟随浏览器语言，不支持时使用英文。",
  "settings.generalDescription": "网关服务器字段用于编辑当前网关；文件访问和上传默认值用于编辑{targetLabel}。",
  "settings.languagePreference": "语言偏好",
  "settings.languagePreferenceDescription": "此设置只作用于浏览器界面，不会改变系统提示词或远程主机配置。",
  "settings.generalConfiguration": "常规配置",
};

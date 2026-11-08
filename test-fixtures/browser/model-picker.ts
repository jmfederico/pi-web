import { ModelPicker } from "../../src/client/src/components/ModelPicker";
import type { SessionModelScopeMode } from "../../src/client/src/api";

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-accent: #aaf; --pi-overlay: #0008; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
`;
document.head.append(style);

const picker = new ModelPicker();
picker.scope = "manual";
picker.catalog = Array.from({ length: 30 }, (_, index) => ({
  provider: "fixture-provider", id: `model-${String(index + 1)}`, enabled: true, catalogIndex: index,
}));
picker.options = picker.catalog.map((entry) => ({ value: `${entry.provider}/${entry.id}`, label: entry.id, description: entry.provider }));
picker.selectedValue = "fixture-provider/model-1";
const requests: SessionModelScopeMode[] = [];
let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
picker.onSetScope = (mode) => {
  requests.push(mode);
  return new Promise<void>((resolve, reject) => { pending = { resolve, reject }; });
};
picker.onPick = (value) => { document.body.dataset["picked"] = value; };
picker.onSetDefault = (value) => { picker.defaultValue = value; return Promise.resolve(); };
picker.onCancel = () => { picker.remove(); };
document.body.append(picker);
await picker.updateComplete;

declare global {
  interface Window {
    modelPickerFixture: {
      requests: SessionModelScopeMode[];
      confirm: (scope: "all" | "manual") => Promise<void>;
      fail: () => Promise<void>;
    };
  }
}
window.modelPickerFixture = {
  requests,
  confirm: async (scope) => {
    picker.scope = scope;
    pending?.resolve();
    pending = undefined;
    await picker.updateComplete;
  },
  fail: async () => {
    pending?.reject(new Error("Fixture save failure"));
    pending = undefined;
    await picker.updateComplete;
  },
};
document.body.dataset["ready"] = "true";

import { ChatView } from "../../src/client/src/components/ChatView";
import { DEFAULT_CHAT_BEHAVIORS } from "../../src/client/src/chatBehaviors";
import type { ContentRendererHost } from "../../src/client/src/components/ContentRendererHost";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import plugin from "../../pi-web-plugins/code-highlight/pi-web-plugin";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; font: 14px/1.5 system-ui; }
  chat-view { height: 480px; width: min(700px, 100vw); }
`;
document.head.append(style);
const registry = new PluginRegistry();
await registry.register({ id: "code-highlight", plugin: adaptPublicPlugin(plugin) });
const chat = new ChatView();
chat.sessionId = "code-scroll";
chat.machineId = "local";
chat.behaviors = { ...DEFAULT_CHAT_BEHAVIORS, automaticHistory: false, loadImages: false, rememberDisclosures: false, visualEffects: false };
chat.historyReady = true;
chat.contentRendering = registry.getChatContentRendering("local");
const filler = (index: number) => ({ entryId: `filler-${String(index)}`, role: "user" as const, parts: [{ type: "text" as const, text: "Readable surrounding transcript. ".repeat(30) }] });
chat.messages = [...Array.from({ length: 5 }, (_, index) => filler(index)), {
  entryId: "code", role: "assistant", parts: [{ type: "text", text: '```javascript\n' + Array.from({ length: 300 }, (_, index) => `const line${String(index)} = "${"readable source ".repeat(16)}";`).join("\n") + '\n```' }],
}, ...Array.from({ length: 10 }, (_, index) => filler(index + 5))];
chat.messageTotal = chat.messages.length;
chat.messageEnd = chat.messages.length;
document.body.append(chat);
await chat.updateComplete;
function requiredElement(selector: string): HTMLElement {
  const element = chat.shadowRoot?.querySelector<HTMLElement>(selector);
  if (element === null || element === undefined) throw new Error(`Missing fixture element: ${selector}`);
  return element;
}
const viewport = requiredElement(".chat");
const wrapper = requiredElement('[data-scroll-anchor-id*=code] formatted-text');
function contentHost() { return wrapper.shadowRoot?.querySelector<ContentRendererHost>("pi-web-content-renderer"); }

function geometry() {
  const host = contentHost();
  const highlighted = host?.shadowRoot?.querySelector("pi-web-highlighted-code");
  const pre = highlighted?.shadowRoot?.querySelector("pre") ?? host?.shadowRoot?.querySelector("pre") ?? wrapper.shadowRoot?.querySelector("pre");
  const code = pre?.querySelector("code");
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    blockHeight: wrapper.getBoundingClientRect().height,
    blockBottom: wrapper.getBoundingClientRect().bottom,
    highlighted: highlighted !== null && highlighted !== undefined,
    preHeight: pre?.getBoundingClientRect().height,
    preFont: pre === null || pre === undefined ? undefined : getComputedStyle(pre).font,
    codeFont: code === null || code === undefined ? undefined : getComputedStyle(code).font,
  };
}
async function frames(count = 2) {
  const samples = [];
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); }));
    samples.push(geometry());
  }
  return samples;
}
let samples: ReturnType<typeof geometry>[] = [];
let recording = false;
function recordFrame(): void {
  if (!recording) return;
  // Sample after the frame's layout/scroll RAFs, not halfway through the
  // production viewport transaction before the browser has painted it.
  setTimeout(() => {
    if (!recording) return;
    samples.push(geometry());
    requestAnimationFrame(recordFrame);
  }, 0);
}
function startRecording(): void {
  samples = [geometry()];
  recording = true;
  requestAnimationFrame(recordFrame);
}
async function stopRecording() {
  await frames();
  recording = false;
  return samples;
}
function enterFromBelow() {
  startRecording();
  return geometry();
}
function exitBelow() {
  viewport.scrollTop += wrapper.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top + 200;
  return geometry();
}
declare global {
  interface Window {
    codeScrollFixture: { geometry: typeof geometry; frames: typeof frames; enterFromBelow: typeof enterFromBelow; exitBelow: typeof exitBelow; stopRecording: typeof stopRecording };
  }
}
window.codeScrollFixture = { geometry, frames, enterFromBelow, exitBelow, stopRecording };
document.body.dataset["ready"] = "true";

import { loadPiAi } from "./piRuntime.js";

const ai = await loadPiAi();

export const { normalizeContext, modelsAreEqual } = ai;
export type * from "@earendil-works/pi-ai";

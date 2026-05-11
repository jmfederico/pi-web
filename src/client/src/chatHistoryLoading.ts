export interface ChatHistoryLoadState {
  hasMore: boolean;
  loadingMore: boolean;
  canRequest: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  topThreshold?: number;
}

const DEFAULT_TOP_THRESHOLD = 64;
const VIEWPORT_FILL_TOLERANCE = 1;

export function shouldRequestEarlierMessages(state: ChatHistoryLoadState): boolean {
  if (!state.hasMore || state.loadingMore || !state.canRequest) return false;
  return isNearTop(state) || doesNotFillViewport(state);
}

export function isNearTop(state: Pick<ChatHistoryLoadState, "scrollTop" | "topThreshold">): boolean {
  return state.scrollTop < (state.topThreshold ?? DEFAULT_TOP_THRESHOLD);
}

export function doesNotFillViewport(state: Pick<ChatHistoryLoadState, "scrollHeight" | "clientHeight">): boolean {
  return state.scrollHeight <= state.clientHeight + VIEWPORT_FILL_TOLERANCE;
}

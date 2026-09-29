import type { GlobalSessionEvent, ServerNotice, ServerNoticeDismissRequest, ServerNoticeSnapshot } from "../../shared/apiTypes.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { ServerNoticeStore, type ServerNoticeInput } from "./serverNoticeStore.js";

export interface ServerNoticeCreator {
  record(input: ServerNoticeInput): ServerNotice;
}

export interface ServerNoticeRouteService {
  snapshot(): ServerNoticeSnapshot;
  dismiss(request: ServerNoticeDismissRequest): ServerNoticeSnapshot;
}

/** Sessiond adapter that publishes every changed current snapshot globally. */
export class ServerNoticeService implements ServerNoticeCreator, ServerNoticeRouteService {
  constructor(
    private readonly store: ServerNoticeStore,
    private readonly events: Pick<SessionEventHub, "publishGlobal">,
  ) {}

  record(input: ServerNoticeInput): ServerNotice {
    const result = this.store.record(input);
    this.publish(result.snapshot);
    return result.notice;
  }

  snapshot(): ServerNoticeSnapshot {
    return this.store.snapshot();
  }

  dismiss(request: ServerNoticeDismissRequest): ServerNoticeSnapshot {
    const result = this.store.dismiss(request.daemonInstanceId, request.noticeId);
    if (result.dismissed) this.publish(result.snapshot);
    return result.snapshot;
  }

  private publish(snapshot: ServerNoticeSnapshot): void {
    const event: GlobalSessionEvent = { type: "notices.updated", snapshot };
    this.events.publishGlobal(event);
  }
}

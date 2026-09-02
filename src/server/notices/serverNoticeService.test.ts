import { describe, expect, it } from "vitest";
import type { GlobalSessionEvent } from "../../shared/apiTypes.js";
import { ServerNoticeStore } from "./serverNoticeStore.js";
import { ServerNoticeService } from "./serverNoticeService.js";

describe("ServerNoticeService", () => {
  it("publishes the changed current snapshot for records and exact dismissals", () => {
    const events: GlobalSessionEvent[] = [];
    const service = new ServerNoticeService(
      new ServerNoticeStore({ daemonInstanceId: "daemon-a", createNoticeId: () => "notice-1" }),
      { publishGlobal: (event) => { events.push(event); } },
    );

    const notice = service.record({ severity: "error", message: "Failed" });
    const dismissed = service.dismiss({ daemonInstanceId: "daemon-a", noticeId: notice.id });
    service.dismiss({ daemonInstanceId: "daemon-a", noticeId: notice.id });

    expect(events).toEqual([
      { type: "notices.updated", snapshot: { daemonInstanceId: "daemon-a", revision: 1, notices: [notice] } },
      { type: "notices.updated", snapshot: dismissed },
    ]);
  });
});

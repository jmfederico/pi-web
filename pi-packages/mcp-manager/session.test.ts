import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { SESSION_STATE_RESET_CUSTOM_TYPE } from "../../src/shared/sessionState.js";
import { MANAGED_MCP_SESSION_ENTRY, managedMcpSessionData, parseManagedMcpSessionValue, readManagedMcpSession, writeManagedMcpSession } from "./session.js";

it("stores inheritable generic state and reads latest choices across the whole session", () => {
  const manager = SessionManager.inMemory();
  writeManagedMcpSession(manager, ["docs", "docs"]);
  const checkpoint = manager.getLeafId();
  writeManagedMcpSession(manager, ["later"]);
  if (checkpoint === null) throw new Error("Missing checkpoint");
  manager.branch(checkpoint);
  expect(readManagedMcpSession(manager)).toEqual(["later"]);
  expect(manager.getEntries().at(-1)).toMatchObject({ customType: "pi-web.session-state", data: { version: 1, namespace: "mcp-manager", value: { version: 1, enabledServers: ["later"] }, inherit: true } });
  manager.appendCustomEntry(SESSION_STATE_RESET_CUSTOM_TYPE, { version: 1 });
  expect(readManagedMcpSession(manager)).toEqual([]);
  writeManagedMcpSession(manager, []);
  expect(readManagedMcpSession(manager)).toEqual([]);
});

it("rejects invalid package state without leaking values or falling back to an older grant", () => {
  const manager = SessionManager.inMemory();
  writeManagedMcpSession(manager, ["docs"]);
  manager.appendCustomEntry(MANAGED_MCP_SESSION_ENTRY, { ...managedMcpSessionData([]), value: { version: 1, enabledServers: "private-invalid" } });
  expect(() => readManagedMcpSession(manager)).toThrow("Invalid saved MCP session settings");
  expect(() => readManagedMcpSession(manager)).not.toThrow("private-invalid");
  expect(() => parseManagedMcpSessionValue({ version: 1, enabledServers: ["secret.invalid"] })).toThrow("server name");
  expect(() => parseManagedMcpSessionValue({ version: 1, enabledServers: ["secret.invalid"] })).not.toThrow("secret.invalid");
  expect(parseManagedMcpSessionValue(undefined)).toEqual([]);
});

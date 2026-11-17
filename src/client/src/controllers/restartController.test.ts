import { describe, expect, it, vi } from "vitest";
import type { RestartResult } from "../../../plugin-api";
import { RestartController, type RestartCommands, type RestartConfirmation } from "./restartController";

const machine = { id: "remote-a", name: "Build machine" };
const commands = { restartWeb: "remote restart-web", restartSessiond: "remote restart-daemon", restart: "remote restart-both" };
function setup() {
  const loadCommands = vi.fn<(machineId: string) => Promise<RestartCommands>>().mockResolvedValue(commands);
  const confirm = vi.fn<(request: RestartConfirmation) => Promise<RestartResult>>().mockResolvedValue("cancelled");
  const launch = vi.fn<(machineId: string, command: string, title: string) => Promise<void>>().mockResolvedValue(undefined);
  return { controller: new RestartController({ loadCommands, confirm, launch }), loadCommands, confirm, launch };
}

describe("machine-scoped restarts", () => {
  it.each([ ["web", commands.restartWeb], ["sessiond", commands.restartSessiond], ["both", commands.restart] ] as const)("launches direct %s using only the target machine's exact command", async (services, command) => {
    const { controller, loadCommands, confirm, launch } = setup();
    await expect(controller.request(machine, { services, confirm: false })).resolves.toBe("launched");
    expect(loadCommands).toHaveBeenCalledExactlyOnceWith(machine.id);
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledExactlyOnceWith(machine.id, command, expect.any(String));
  });

  it("defaults to confirmation, lets cancellation avoid loading or launching", async () => {
    const { controller, loadCommands, confirm, launch } = setup();
    await expect(controller.request(machine)).resolves.toBe("cancelled");
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ machine, services: "web" }));
    expect(loadCommands).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("shares command resolution with confirmation and retains the initiating machine", async () => {
    const { controller, confirm, loadCommands, launch } = setup();
    const target = { ...machine };
    confirm.mockImplementation(async (request) => {
      target.id = "different";
      const loaded = await request.loadCommands();
      await request.run("sessiond", loaded);
      return "launched";
    });
    await expect(controller.request(target, { services: "sessiond" })).resolves.toBe("launched");
    expect(loadCommands).toHaveBeenCalledExactlyOnceWith(machine.id);
    expect(launch).toHaveBeenCalledExactlyOnceWith(machine.id, commands.restartSessiond, expect.any(String));
  });

  it.each([undefined, "", "  "])("never broadens an unavailable targeted command (%s)", async (restartWeb) => {
    const { controller, loadCommands, launch } = setup();
    loadCommands.mockResolvedValue({ restart: commands.restart, ...(restartWeb === undefined ? {} : { restartWeb }) });
    await expect(controller.request(machine, { services: "web", confirm: false })).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects an obsolete request after status loading without launching elsewhere", async () => {
    const { controller, loadCommands, launch } = setup();
    let current = true;
    loadCommands.mockImplementation(() => { current = false; return Promise.resolve(commands); });
    await expect(controller.request(machine, { services: "web", confirm: false }, () => current)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it("blocks concurrent requests on the same machine and releases the guard after failure", async () => {
    const { controller, loadCommands, launch } = setup();
    let reject!: (error: Error) => void;
    loadCommands.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = controller.request(machine, { services: "web", confirm: false });
    await expect(controller.request(machine, { services: "sessiond", confirm: false })).rejects.toThrow();
    reject(new Error("Offline"));
    await expect(first).rejects.toThrow("Offline");
    expect(launch).not.toHaveBeenCalled();
    await controller.request(machine, { services: "web", confirm: false });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("propagates terminal-launch failures without retrying", async () => {
    const { controller, launch } = setup();
    launch.mockRejectedValue(new Error("Terminal unavailable"));
    await expect(controller.request(machine, { services: "both", confirm: false })).rejects.toThrow("Terminal unavailable");
    expect(launch).toHaveBeenCalledOnce();
  });
});

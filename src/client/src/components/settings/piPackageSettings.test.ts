import { describe, expect, it } from "vitest";
import type { PiPackageInfo } from "../../api";
import { canUpdateAllPiPackages, friendlyPiPackageErrorMessage, isPiPackageOperationPending, normalizePiPackageSource, piPackageFilteredLabel, piPackageMutationFollowUpMessage, piPackageScopeLabel, piPackageSourceValidationMessage, piPackageTargetContext, piPackageTargetLabel, piPackageUpdateDisabledReason, shouldRefreshGatewayPluginsAfterPiPackageMutation, updateAllPiPackagesDisabledReason, type PiPackageTargetContext } from "./piPackageSettings";

const userPackage: PiPackageInfo = { source: "npm:@acme/tools", scope: "user", filtered: false, installedPath: "/home/test/.pi/packages/tools" };
const projectPackage: PiPackageInfo = { source: "../project-tools", scope: "project", filtered: true };
const localTarget: PiPackageTargetContext = { id: "local", name: "local", kind: "local" };
const remoteTarget: PiPackageTargetContext = { id: "remote-a", name: "Lab Mac", kind: "remote" };

describe("Pi package settings helpers", () => {
  it("normalizes and validates install sources without adding location choices", () => {
    expect(normalizePiPackageSource("  npm:@acme/tools  ")).toBe("npm:@acme/tools");
    expect(piPackageSourceValidationMessage("  npm:@acme/tools  ")).toBeUndefined();
    expect(piPackageSourceValidationMessage("   ")).toContain("Pi package source accepted by Pi");
  });

  it("formats package metadata with Pi package terminology", () => {
    expect(piPackageScopeLabel(userPackage)).toBe("User scope");
    expect(piPackageScopeLabel(projectPackage)).toBe("Project scope");
    expect(piPackageFilteredLabel(userPackage)).toBe("Available in this PI WEB process");
    expect(piPackageFilteredLabel(projectPackage)).toBe("Filtered by current Pi package settings");
  });

  it("allows updates for user-scope packages and explains project-scope limits", () => {
    expect(piPackageUpdateDisabledReason(userPackage)).toBeUndefined();
    expect(piPackageUpdateDisabledReason(projectPackage)).toContain("user-scope Pi packages");
    expect(canUpdateAllPiPackages([userPackage])).toBe(true);
    expect(canUpdateAllPiPackages([userPackage, projectPackage])).toBe(false);
    expect(updateAllPiPackagesDisabledReason([])).toBe("No Pi packages are configured yet.");
    expect(updateAllPiPackagesDisabledReason([userPackage, projectPackage])).toContain("project-scope Pi packages");
  });

  it("matches pending operations by action and source", () => {
    expect(isPiPackageOperationPending({ kind: "remove", source: "npm:@acme/tools" }, "remove", "npm:@acme/tools")).toBe(true);
    expect(isPiPackageOperationPending({ kind: "remove", source: "npm:@acme/tools" }, "remove", "npm:@acme/other")).toBe(false);
    expect(isPiPackageOperationPending({ kind: "update-all" }, "update-all")).toBe(true);
  });

  it("labels package targets and gateway plugin refresh scope", () => {
    expect(piPackageTargetContext(undefined)).toEqual(localTarget);
    expect(piPackageTargetLabel(localTarget)).toBe("local (local gateway)");
    expect(piPackageTargetLabel(remoteTarget)).toBe("Lab Mac (remote machine)");
    expect(shouldRefreshGatewayPluginsAfterPiPackageMutation(localTarget)).toBe(true);
    expect(shouldRefreshGatewayPluginsAfterPiPackageMutation(remoteTarget)).toBe(false);
  });

  it("describes the browser and session reload follow-up without requiring sessiond restarts", () => {
    const message = piPackageMutationFollowUpMessage("install");

    expect(message).toContain("Type /reload in each idle PI WEB session");
    expect(message).toContain("extensions, skills, prompt templates, themes, and context/system prompt files");
    expect(message).toContain("Reload the browser page separately for PI WEB browser plugin changes");
    expect(message).not.toContain("session daemon");
    expect(message).not.toContain("sessiond");
  });

  it("scopes remote package mutation follow-up copy to the selected machine", () => {
    const message = piPackageMutationFollowUpMessage("update", remoteTarget);

    expect(message).toContain("Pi package updated on Lab Mac");
    expect(message).toContain("each idle PI WEB session on Lab Mac");
    expect(message).toContain("PI WEB browser plugin changes served by Lab Mac");
  });

  it("turns older remote route failures into package-management compatibility guidance", () => {
    expect(friendlyPiPackageErrorMessage("Not Found", remoteTarget)).toBe("Pi package management is not available on Lab Mac. Update and restart Pi-Web on that machine, then try again.");
    expect(friendlyPiPackageErrorMessage("Remote machine unavailable", remoteTarget)).toBe("Could not reach Lab Mac for Pi package management. Check the machine connection and try again.");
    expect(friendlyPiPackageErrorMessage("Remote machine timeout", remoteTarget)).toContain("may still be running remotely");
    expect(friendlyPiPackageErrorMessage("Not Found", localTarget)).toBe("Not Found");
  });
});

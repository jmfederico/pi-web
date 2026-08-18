import { describe, expectTypeOf, it } from "vitest";
import type {
  PluginActivationContext,
  PluginActivationResult,
  PluginContributions,
  Workspace,
  WorkspaceProviderCapabilities,
  WorkspaceProviderMetadata,
  WorkspaceRemovalPresentation,
} from "@jmfederico/pi-web/plugin-api";

type IfEqual<Left, Right, Then, Else = never> =
  (<Value>(value: Value) => Value extends Left ? 1 : 2) extends
  (<Value>(value: Value) => Value extends Right ? 1 : 2) ? Then : Else;

type ReadonlyKeys<Value> = {
  [Key in keyof Value]-?: IfEqual<
    { [Property in Key]: Value[Property] },
    { -readonly [Property in Key]: Value[Property] },
    never,
    Key
  >;
}[keyof Value];

type WritableKeys<Value> = Exclude<keyof Value, ReadonlyKeys<Value>>;

describe("public browser plugin API", () => {
  it("keeps host-owned activation and workspace snapshots readonly", () => {
    expectTypeOf<ReadonlyKeys<PluginActivationContext>>().toEqualTypeOf<keyof PluginActivationContext>();
    expectTypeOf<ReadonlyKeys<Workspace>>().toEqualTypeOf<keyof Workspace>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderMetadata>>().toEqualTypeOf<keyof WorkspaceProviderMetadata>();
    expectTypeOf<ReadonlyKeys<WorkspaceProviderCapabilities>>().toEqualTypeOf<keyof WorkspaceProviderCapabilities>();
    expectTypeOf<ReadonlyKeys<WorkspaceRemovalPresentation>>().toEqualTypeOf<keyof WorkspaceRemovalPresentation>();
  });

  it("keeps the removal precondition internal and contribution results writable", () => {
    expectTypeOf<keyof WorkspaceRemovalPresentation>().toEqualTypeOf<"actionLabel" | "confirmation">();
    expectTypeOf<WritableKeys<PluginActivationResult>>().toEqualTypeOf<keyof PluginActivationResult>();
    expectTypeOf<WritableKeys<PluginContributions>>().toEqualTypeOf<keyof PluginContributions>();
  });
});

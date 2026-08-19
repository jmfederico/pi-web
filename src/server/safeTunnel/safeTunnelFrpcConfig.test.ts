import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  prepareSafeTunnelFrpcConfig as prepareSafeTunnelFrpcConfigWithTrust,
  validateSafeTunnelFrpcConfig,
  type SafeTunnelFrpcConfigInput,
} from "./safeTunnelFrpcConfig.js";
import {
  hostedFrpcConfigToml,
  hostedLocalPiWebUrl,
  hostedMachineToken,
  hostedProxyName,
  hostedPublicHostname,
  hostedRelayAuthToken,
  hostedRelayServerAddr,
  hostedRelayServerPort,
} from "./safeTunnelHostedFixtures.testSupport.js";

const frpcToken = hostedRelayAuthToken;
const machineToken = hostedMachineToken;
const trustedCaFile = "/private/safe-tunnel/frps-roots.pem";
const trust = { trustedCaFile, machineToken } as const;

function prepareSafeTunnelFrpcConfig(
  configInput: SafeTunnelFrpcConfigInput,
  desiredLocalPiWebUrl: string,
): string {
  return prepareSafeTunnelFrpcConfigWithTrust(configInput, desiredLocalPiWebUrl, trust);
}

// The byte-exact hosted provider shape; see safeTunnelHostedFixtures.testSupport.ts.
const providerConfig = hostedFrpcConfigToml;

const input = {
  frpcConfigToml: providerConfig,
  localPiWebUrl: hostedLocalPiWebUrl,
  proxyName: hostedProxyName,
  publicHostname: hostedPublicHostname,
} as const;

const templateAction = "{{ .Envs.PI_WEB_SERVICE_CREDENTIAL }}";
interface TemplateFieldCase {
  readonly field: string;
  readonly frpcConfigToml: string;
  readonly inputOverrides?: Partial<SafeTunnelFrpcConfigInput>;
}
const templateFieldCases: readonly TemplateFieldCase[] = [
  {
    field: "serverAddr",
    frpcConfigToml: providerConfig.replace(
      `serverAddr = ${JSON.stringify(hostedRelayServerAddr)}`,
      `serverAddr = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "serverPort",
    frpcConfigToml: providerConfig.replace(
      "serverPort = 7000",
      `serverPort = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "auth.method",
    frpcConfigToml: providerConfig.replace(
      'method = "token"',
      `method = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "auth.token",
    frpcConfigToml: providerConfig.replace(
      `token = ${JSON.stringify(frpcToken)}`,
      `token = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "transport.tls.enable",
    frpcConfigToml: providerConfig.replace(
      "transport.tls.enable = true",
      `transport.tls.enable = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "proxies.name",
    frpcConfigToml: providerConfig.replace(
      `name = ${JSON.stringify(hostedProxyName)}`,
      `name = ${JSON.stringify(templateAction)}`,
    ),
    inputOverrides: { proxyName: templateAction },
  },
  {
    field: "proxies.type",
    frpcConfigToml: providerConfig.replace(
      'type = "http"',
      `type = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "proxies.localIP",
    frpcConfigToml: providerConfig.replace(
      'localIP = "127.0.0.1"',
      `localIP = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "proxies.localPort",
    frpcConfigToml: providerConfig.replace(
      "localPort = 8504",
      `localPort = ${JSON.stringify(templateAction)}`,
    ),
  },
  {
    field: "proxies.customDomains",
    frpcConfigToml: providerConfig.replace(
      `customDomains = [${JSON.stringify(hostedPublicHostname)}]`,
      `customDomains = [${JSON.stringify(templateAction)}]`,
    ),
    inputOverrides: { publicHostname: templateAction },
  },
];

describe("hosted provider fixture", () => {
  it("keeps the exact hosted serialization shape", () => {
    // Drift guard for safeTunnelHostedFixtures.testSupport.ts: the hosted
    // serializer emits root keys first (including the dotted machine-token
    // metadata and transport.tls.enable), then the [auth] table, then the
    // single [[proxies]] element, with one trailing newline.
    const [rootSection] = providerConfig.split("\n[", 1);
    expect(rootSection).toContain(`serverAddr = ${JSON.stringify(hostedRelayServerAddr)}`);
    expect(rootSection).toContain('user = ""');
    expect(rootSection).toContain(
      `metadatas.pi_web_machine_token = ${JSON.stringify(machineToken)}`,
    );
    expect(rootSection).toContain("transport.tls.enable = true");
    expect(providerConfig).not.toContain("[metadatas]");
    expect(providerConfig).toContain("\n[auth]\n");
    expect(providerConfig.indexOf("[auth]")).toBeLessThan(providerConfig.indexOf("[[proxies]]"));
    expect(providerConfig.endsWith("\n")).toBe(true);
    expect(providerConfig.endsWith("\n\n")).toBe(false);
  });
});

describe("prepareSafeTunnelFrpcConfig", () => {
  it("generates one bounded proxy using only PI WEB's desired local target", () => {
    const generated = prepareSafeTunnelFrpcConfig(
      input,
      "http://[::1]:19000",
    );

    expect(parse(generated)).toEqual({
      serverAddr: hostedRelayServerAddr,
      serverPort: hostedRelayServerPort,
      user: "",
      metadatas: { pi_web_machine_token: machineToken },
      auth: { method: "token", token: frpcToken },
      transport: {
        tls: {
          enable: true,
          serverName: hostedRelayServerAddr,
          trustedCaFile,
        },
      },
      proxies: [{
        name: hostedProxyName,
        type: "http",
        localIP: "::1",
        localPort: 19000,
        customDomains: [hostedPublicHostname],
      }],
    });
    expect(generated).not.toContain("127.0.0.1");
  });

  it("preserves the empty user and exact machine metadata in the serialized config", () => {
    const generated = prepareSafeTunnelFrpcConfig(input, input.localPiWebUrl);

    // frps NewProxy authorization fails closed without this exact identity.
    expect(generated).toContain('user = ""');
    expect(generated).toContain(
      `pi_web_machine_token = ${JSON.stringify(machineToken)}`,
    );
  });

  it("accepts an equivalent [metadatas] table representation", () => {
    const tableForm = providerConfig
      .replace(
        `metadatas.pi_web_machine_token = ${JSON.stringify(machineToken)}\n`,
        "",
      )
      .replace(
        "transport.tls.enable = true\n",
        `transport.tls.enable = true\n\n[metadatas]\npi_web_machine_token = ${JSON.stringify(machineToken)}\n`,
      );
    expect(parse(tableForm)).toEqual(parse(providerConfig));

    const generated = prepareSafeTunnelFrpcConfig(
      { ...input, frpcConfigToml: tableForm },
      input.localPiWebUrl,
    );
    expect(generated).toBe(prepareSafeTunnelFrpcConfig(input, input.localPiWebUrl));
  });

  it.each([
    ["missing empty user", providerConfig.replace('user = ""\n', "")],
    ["non-empty user", providerConfig.replace('user = ""', 'user = "prefix"')],
    ["missing machine metadata", providerConfig.replace(
      `metadatas.pi_web_machine_token = ${JSON.stringify(machineToken)}\n`,
      "",
    )],
    ["extra provider metadata", providerConfig.replace(
      "transport.tls.enable = true",
      'metadatas.workload = "other"\ntransport.tls.enable = true',
    )],
    ["mismatched machine token", providerConfig.replace(
      JSON.stringify(machineToken),
      JSON.stringify("piwt_mtok_v1_other_machine"),
    )],
    // A [metadatas] table here would capture the following transport key, so
    // it is not equivalent to the hosted dotted key.
    ["misplaced [metadatas] table", providerConfig.replace(
      `metadatas.pi_web_machine_token = ${JSON.stringify(machineToken)}`,
      `[metadatas]\npi_web_machine_token = ${JSON.stringify(machineToken)}`,
    )],
  ])("rejects %s", (_label, frpcConfigToml) => {
    expect(() => prepareSafeTunnelFrpcConfig(
      { ...input, frpcConfigToml },
      input.localPiWebUrl,
    )).toThrow("provider frpc configuration is invalid");
  });

  it.each([
    ["IPv4", "http://127.0.0.1:80", "127.0.0.1"],
    ["bracketed IPv6", "http://[::1]:80", "::1"],
  ])("preserves explicit HTTP port 80 for a %s local target", (_label, localUrl, localIP) => {
    const frpcConfigToml = providerConfig
      .replace('localIP = "127.0.0.1"', `localIP = ${JSON.stringify(localIP)}`)
      .replace("localPort = 8504", "localPort = 80");

    const generated = prepareSafeTunnelFrpcConfig({
      ...input,
      frpcConfigToml,
      localPiWebUrl: localUrl,
    }, localUrl);

    expect(parse(generated)).toMatchObject({
      proxies: [{ localIP, localPort: 80 }],
    });
  });

  it.each(templateFieldCases)(
    "rejects Go-template references in provider-controlled $field",
    ({ frpcConfigToml, inputOverrides = {} }) => {
      expect(() => prepareSafeTunnelFrpcConfig({
        ...input,
        ...inputOverrides,
        frpcConfigToml,
      }, input.localPiWebUrl)).toThrow("provider frpc configuration is invalid");
    },
  );

  it("rejects templates that could inject TOML structure after validation", () => {
    const frpcConfigToml = providerConfig.replace(
      `token = ${JSON.stringify(frpcToken)}`,
      `token = ${JSON.stringify(templateAction)}`,
    );
    const renderedPayload = [
      `${frpcToken}"`,
      'includes = ["/tmp/provider-owned/*.toml"]',
      "#",
    ].join("\n");

    // Inside the hosted [auth] table the rendered payload still injects TOML
    // structure (a smuggled auth.includes key), which the allowlist rejects.
    expect(parse(frpcConfigToml.replace(templateAction, renderedPayload)))
      .toMatchObject({ auth: { includes: ["/tmp/provider-owned/*.toml"] } });
    expect(() => prepareSafeTunnelFrpcConfig(
      { ...input, frpcConfigToml },
      input.localPiWebUrl,
    )).toThrow("provider frpc configuration is invalid");
  });

  it("checks the serialized boundary when TOML escapes hide a template action", () => {
    const escapedTemplateAction = "\\u007b\\u007b .Envs.PI_WEB_SERVICE_CREDENTIAL \\u007d\\u007d";
    const frpcConfigToml = providerConfig.replace(
      `token = ${JSON.stringify(frpcToken)}`,
      `token = "${escapedTemplateAction}"`,
    );

    expect(frpcConfigToml).not.toContain("{{");
    expect(() => prepareSafeTunnelFrpcConfig(
      { ...input, frpcConfigToml },
      input.localPiWebUrl,
    )).toThrow("provider frpc configuration is invalid");
  });

  it.each([
    ["additional proxy", `${providerConfig}\n[[proxies]]\nname = "smuggled"\ntype = "tcp"\nlocalIP = "169.254.169.254"\nlocalPort = 80\n`],
    ["include directive", providerConfig.replace(
      "\n[[proxies]]",
      '\nincludes = ["/tmp/provider-owned/*.toml"]\n\n[[proxies]]',
    )],
    ["unexpected proxy field", providerConfig.replace(
      `customDomains = [${JSON.stringify(hostedPublicHostname)}]`,
      `customDomains = [${JSON.stringify(hostedPublicHostname)}]\nplugin = "static_file"`,
    )],
    ["provider target mismatch", providerConfig.replace("localPort = 8504", "localPort = 22")],
    ["additional public hostname", providerConfig.replace(
      `customDomains = [${JSON.stringify(hostedPublicHostname)}]`,
      `customDomains = [${JSON.stringify(hostedPublicHostname)}, "admin.example.test"]`,
    )],
    ["plaintext relay transport", providerConfig.replace(
      "transport.tls.enable = true",
      "transport.tls.enable = false",
    )],
    ["provider-selected CA path", providerConfig.replace(
      "transport.tls.enable = true",
      'transport.tls.enable = true\ntransport.tls.trustedCaFile = "/tmp/provider-ca.pem"',
    )],
    ["provider-selected certificate identity", providerConfig.replace(
      "transport.tls.enable = true",
      'transport.tls.enable = true\ntransport.tls.serverName = "attacker.example"',
    )],
  ])("rejects %s without retaining provider values in the error", (_label, frpcConfigToml) => {
    const secret = frpcToken;
    let observed: unknown;

    try {
      prepareSafeTunnelFrpcConfig({ ...input, frpcConfigToml }, input.localPiWebUrl);
    } catch (error: unknown) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect(String(observed)).toBe("Error: Safe Tunnel provider frpc configuration is invalid.");
    expect(JSON.stringify(observed) + String(observed)).not.toContain(secret);
  });

  it.each([
    ["one character", "a"],
    ["four characters", "abcd"],
    ["31 characters", "x".repeat(31)],
    ["whitespace-only material", " ".repeat(32)],
    ["non-ASCII material", "é".repeat(32)],
    ["terminal controls", `${"x".repeat(32)}\u001B[31m`],
  ])("rejects %s credentials before they can reach frpc", (_label, token) => {
    const frpcConfigToml = providerConfig.replace(
      JSON.stringify(frpcToken),
      JSON.stringify(token),
    );

    expect(() => prepareSafeTunnelFrpcConfig(
      { ...input, frpcConfigToml },
      input.localPiWebUrl,
    )).toThrow("provider frpc configuration is invalid");
  });

  it("revalidates PI WEB-owned trust at the child-process boundary", () => {
    const generated = prepareSafeTunnelFrpcConfig(input, input.localPiWebUrl);

    expect(() => { validateSafeTunnelFrpcConfig(generated, trust); }).not.toThrow();
    for (const unsafe of [
      generated.replace(trustedCaFile, "/tmp/provider-ca.pem"),
      generated.replace(
        `serverName = ${JSON.stringify(hostedRelayServerAddr)}`,
        'serverName = "attacker.example"',
      ),
      generated.replace(`trustedCaFile = ${JSON.stringify(trustedCaFile)}\n`, ""),
      generated.replace('user = ""\n', ""),
      generated.replace(machineToken, "piwt_mtok_v1_other_machine"),
    ]) {
      expect(() => { validateSafeTunnelFrpcConfig(unsafe, trust); })
        .toThrow("provider frpc configuration is invalid");
    }
    // The expected machine identity itself is bound to the persisted credential.
    expect(() => {
      validateSafeTunnelFrpcConfig(generated, {
        ...trust,
        machineToken: "piwt_mtok_v1_other_machine",
      });
    }).toThrow("provider frpc configuration is invalid");
  });

  it("rejects malformed or oversized TOML before it can reach frpc", () => {
    expect(() => prepareSafeTunnelFrpcConfig({
      ...input,
      frpcConfigToml: "[[proxies]",
    }, input.localPiWebUrl)).toThrow("provider frpc configuration is invalid");
    expect(() => prepareSafeTunnelFrpcConfig({
      ...input,
      frpcConfigToml: "x".repeat(32_001),
    }, input.localPiWebUrl)).toThrow("provider frpc configuration is invalid");
  });
});

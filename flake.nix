{
  description = "pi-web — web UI for the Pi Coding Agent";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      # Derive version from package.json so it stays in sync with upstream.
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      package = pkgs.buildNpmPackage {
        pname = "pi-web";
        inherit version;
        src = self;
        npmDepsHash = "sha256-ow1Tq1ZFNISShzBRiqYOQqtiqaJ0YnfNO/qo1U0qK7c=";
        npmDepsFetcherVersion = 2; # v1 cache-key mismatch on nested dev deps (ENOTCACHED)
        # Upstream supplies the pi SDK as peerDependencies (consumer-installed,
        # e.g. Docker uses --include=peer). buildNpmPackage does NOT auto-install
        # peers, so mirror Docker's --include=peer to bring the SDK in at build.
        npmInstallFlags = [ "--include=peer" ];
        # npmInstallHook runs `npm prune --omit=dev`, which drops the peer-
        # installed pi SDK (a devDep in upstream's package.json). Keep the tree
        # so the runtime server has the SDK.
        dontNpmPrune = true;
        nativeBuildInputs = [ pkgs.python3 ]; # node-pty node-gyp build
        npmBuildScript = "build"; # npm run clean && tsc && build:plugin-api && build:plugins && vite build
        meta = {
          description = "Web UI for Pi Coding Agent";
          homepage = "https://pi-web.dev/";
          license = pkgs.lib.licenses.mit;
          mainProgram = "pi-web";
        };
      };

      # Home-manager module: defines the two systemd user services (session
      # daemon + web/API) declaratively. Consume with:
      #   modules = [ inputs.pi-web.homeManagerModules.default
      #               { services.pi-web.enable = true; } ];
      homeManagerModule =
        { config, lib, ... }:
        let
          cfg = config.services.pi-web;
          serviceEnvironment =
            [ "PI_WEB_HOST=${cfg.host}" "PI_WEB_PORT=${toString cfg.port}" ]
            ++ lib.optional (cfg.agentDir != null) "PI_CODING_AGENT_DIR=${cfg.agentDir}"
            ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.extraEnvironment;
        in
        {
          options.services.pi-web = {
            enable = lib.mkEnableOption "pi-web, a web UI for Pi Coding Agent sessions";

            package = lib.mkOption {
              type = lib.types.package;
              default = package;
              defaultText = lib.literalExpression "the pi-web package built by this flake";
              description = "The pi-web package to run.";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "0.0.0.0";
              description = "Address the PI WEB server binds (PI_WEB_HOST).";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 8504;
              description = "Port the PI WEB server listens on (PI_WEB_PORT).";
            };

            agentDir = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Pi coding agent state directory (PI_CODING_AGENT_DIR).
                Defaults to the pi SDK default `~/.pi/agent` — the state shared with a
                machine-wide pi install (auth, settings, project trust).
              '';
            };

            extraEnvironment = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = "Additional environment variables for both services.";
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ]; # `pi-web` CLI (status/logs/doctor) on the user's PATH

            systemd.user.services.pi-web-sessiond = {
              Unit = {
                Description = "PI WEB session daemon";
                After = [ "network.target" ];
              };
              Service = {
                Type = "simple";
                Restart = "on-failure";
                ExecStart = "${cfg.package}/bin/pi-web-sessiond";
                Environment = serviceEnvironment;
              };
              Install = { WantedBy = [ "default.target" ]; };
            };

            systemd.user.services.pi-web = {
              Unit = {
                Description = "PI WEB server (web UI and API)";
                After = [ "network.target" "pi-web-sessiond.service" ];
                Wants = [ "pi-web-sessiond.service" ];
              };
              Service = {
                Type = "simple";
                Restart = "on-failure";
                ExecStart = "${cfg.package}/bin/pi-web-server";
                Environment = serviceEnvironment;
              };
              Install = { WantedBy = [ "default.target" ]; };
            };
          };
        };
    in
    {
      packages.${system}.default = package;
      homeManagerModules.default = homeManagerModule;
    };
}

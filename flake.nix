{
  description = "Yash's Pi Coding Agent";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in
    {
      homeManagerModules.default =
        {
          config,
          pkgs,
          lib,
          ...
        }:
        {
          home.packages = with pkgs; [
            pi-coding-agent
            mcporter
            pnpm
          ];

          home.file = {
            ".pi".source = "${self}/pi";
            ".mcporter".source = "${self}/mcporter";
          };

          # Install npm deps for extensions that need them
          home.activation.piExtensionDeps = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
            for pkg in ${config.home.homeDirectory}/.pi/extensions/*/package.json; do
              dir="$(dirname "$pkg")"
              if [ ! -d "$dir/node_modules" ]; then
                $DRY_RUN_CMD ${pkgs.pnpm}/bin/pnpm install --dir "$dir" --silent
              fi
            done
          '';
        };

      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          pi = pkgs.pi-coding-agent;
          mcporter = pkgs.mcporter;
        }
      );
    };
}

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
        { pkgs, ... }:
        {
          home.packages = with pkgs; [
            pi-coding-agent
            mcporter
          ];

          home.file = {
            ".pi".source = "${self}/pi";
            ".mcporter".source = "${self}/mcporter";
          };
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

# pi-config

Personal configuration for [pi-coding-agent](https://pi.dev) and [mcporter](https://github.com/openclaw/mcporter).

## Usage

In your flake:

```nix
inputs.pi-config.url = "github:yash-garg/pi-config";
```

In your home-manager config:

```nix
imports = [ inputs.pi-config.homeManagerModules.default ];
```

Update to latest:

```sh
nix flake update pi-config && home-manager switch
```

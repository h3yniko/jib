# jib

## Install

```sh
npm install -g deployjib
```

This installs the `jib` CLI.

## Update

```sh
jib update
```

## Docker build cache

`sudo jib migrate` configures Docker's default builder GC target to 10% of the **total filesystem capacity** containing Docker's data directory, capped at 20 GB. It does not use current free space, which fluctuates, or override existing GC targets, disabled GC, or custom policies. This is a one-time setting; resize the disk or move Docker's data directory and you may need to adjust it manually.

The migration preserves other `/etc/docker/daemon.json` settings and does **not** prune cache or restart Docker. Schedule `sudo systemctl restart docker` to activate a new setting; this may interrupt running containers. GC is not a hard quota and cannot remove cache still marked in use. Journald retention is configured separately.

## Applying configuration changes

Edit `/opt/jib/config.yml`, then run `jib restart <app>` (or `jib start <app>`). Both recreate containers using current Compose and managed env inputs, run configured health checks, and reconcile nginx routes and global ingress settings. Changing a hostname removes its old route; an empty `domains` list removes all routes for the app. Missing or manually edited generated nginx files are repaired. Unchanged nginx files do not trigger a reload.

`jib deploy <app>` syncs source, builds, and applies the same reconciliation. `jib rebuild <app>` does this from the local checkout without syncing source. Start and restart do not build: if resolved build inputs changed, they apply runtime and routing changes, then exit with a message requiring rebuild or deploy. Existing installations have no recorded build baseline until their first successful rebuild or deploy, so build-backed apps may receive that message once after upgrading.

Config and managed input files remain authoritative. State files store fingerprints of successfully applied build, runtime, and ingress stages, without storing resolved env values. Failures return an error and leave incomplete stages pending for the next command. Changing a runtime-only env value does not require rebuilding; a value used in Compose build arguments does.

Config-only edits take effect on the next start, restart, rebuild, or deploy. The watcher continues to deploy on source revisions; it does not automatically start stopped apps after config edits. Source code and Dockerfile changes require rebuild or deploy. DNS, certificates, and Cloudflare-managed tunnel hostnames must be configured separately.

## Releases

<!-- Preset v9 is intentional: v10 needs a newer writer than semantic-release currently ships. -->

Pushes to `main` release automatically after lint, typecheck, and build pass. Version bumps use Conventional Commits:

- `fix:` or `perf:` → patch
- `feat:` → minor
- `!` after the type/scope (e.g. `feat!:` or `fix(cli)!:`), or a `BREAKING CHANGE:` footer → major

The highest bump among commits since the last release wins. Other commits, such as `docs:`, `chore:`, or `ci:`, do not trigger a release unless they declare a breaking change.

semantic-release publishes to npm using the existing trusted publisher for `release.yml`, then creates a matching GitHub release. Version tags are created automatically; pushing a tag does not publish anything. The package version is set only in CI, and `prepack` rebuilds the CLI with that version.

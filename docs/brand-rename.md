# OpenMausBot -> OpenMyBot rename

This fork shows and names itself **OpenMyBot**. The rename is done by a script, so it can be repeated after every upstream merge.

```sh
node scripts/brand-rename.mjs --check   # lists what still says OpenMausBot (exit 1 if any)
node scripts/brand-rename.mjs --apply   # rewrites files in place and `git mv`s server/openmausbot.ts
```

`src/lib/brand-name.test.ts` fails when something outside the keep list still says OpenMausBot, and when a kept name was renamed by mistake.

## Merging upstream (milind-soni/OpenMausBot)

1. `git merge upstream/main`
2. On conflicts, take **upstream's side** (the rename is replayed in step 3).
3. `node scripts/brand-rename.mjs --apply` (it also moves the locale source hashes, so `pnpm i18n:check` does not call the renamed translations stale)
4. `npx vitest run src/lib/brand-name.test.ts server/drivers/agents-catalog-wire.test.ts`; if the tool-list golden differs, regenerate it with `UPDATE_AGENTS_CATALOG_GOLDENS=1`. Then commit.

Things the script cannot do: lowercase patterns that match the product name in running text (`HEADER_WORDS` in `server/peer-provenance.ts`, `FORGED_START` in `server/records-block.ts` accept both `openmybot` and `openmausbot`). If upstream adds one, add the new name to it by hand.

## What is renamed

- `OpenMausBot` / `openMausBot` in code, UI text, docs, tests, i18n strings and identifiers.
- The entry point `server/openmausbot.ts` -> `server/openmybot.ts` (and every reference to it; the CLI command stays `openmausbot`).

## What is kept, and why

| Kept | Why |
| --- | --- |
| `~/.openmausbot` data folder | Installed apps and the user's disk read it |
| `*.openmausbot.com/.app/.test/.local` hosts, `milind-soni/OpenMausBot` GitHub / ghcr / release feed URLs | Servers and feeds we do not own |
| `OPENMAUSBOT_*` env vars, `x-openmausbot-*` / `X-OpenMausBot-*` headers | Wire / config contract with other builds |
| `com.openmausbot.*` ids and labels, lowercase machine names (CLI, systemd units, `/opt`, `/etc`, `/var/lib` paths, localStorage `openmausbot.*`, MCP names `openmausbot_*`, `_openmausbot._tcp`, `openmausbot://`) | Already installed apps, services and saved settings use them |
| npm package `openmausbot`, `@openmausbot/*`, `pnpm-lock.yaml` | Published package names |
| `electron-builder.yml`, `.github/workflows/` (entry file rename only), `cloudflare/` | Release pipeline, tied to the OS product name |
| Docker pieces that must match the server or upstream: the `/api/health` body `{"app":"openmausbot"}` that every healthcheck greps for, the `/run/openmausbot` socket folder and the `ghcr.io/milind-soni/openmausbot` image used by `deploy/` scripts, the `.github/workflows/docker.yml` tags, the `openmausbot` CLI alias in the image (`deploy/update.sh` runs `openmausbot doctor`) | Wire contract and upstream's registry. Already renamed: image / compose project / volume names, `/opt/openmybot-browser`, the `openmybot` CLI and `OMB_CLI_PREFIX` in the image |
| `OpenMausBot.app/.exe/.dmg/.deb`, `OpenMausBot Speech/Recorder.app`, `Application Support/OpenMausBot`, `OpenMausBot Safe Storage`, `electron.app.OpenMausBot`, update feed `repo: OpenMausBot` | Derived from the OS product name (see below) |
| `LICENSE`, `NOTICE`, `CLA.md`, `LICENSING.md`, `enterprise/`, `third_party/` | Upstream legal text. `NOTICE` has a line saying this is a fork |

## Not done yet: the OS product name

The Dock / menu bar / installer name still comes from `productName: OpenMausBot` in `electron-builder.yml`. Electron derives the `userData` folder (including `credentials.bin`) and the macOS Keychain item `OpenMausBot Safe Storage` from it. Changing it without a data migration would make existing users lose their saved credentials, so it needs its own PR (move userData, re-key the Keychain item, then change `productName`, `appId`, artifact names and the update feed together).

The built-in assistant persona named **MausBot** is a separate name and is not touched here.

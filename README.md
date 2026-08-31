# ascent-unreal-mcp v2.1

Project-specific MCP server for operating Ascent's Unreal project through
headless commandlets — small named tools, not arbitrary editor mutation.

v2 is a field-hardened rewrite after the 2026-08-31 aurora/blizzard night:
every lesson that cost an hour is now a default.

## Tools

- `unreal_run_python_script` — run a repo `scripts/*.py` through a commandlet,
  with `args` (reach the script via `sys.argv`) and an `outputFilter` regex.
- `unreal_probe_actor` — **read-only**: load a map, read actor properties by
  editor display name (`"Use Auroras"`, `"Ultra Dynamic Weather"`). The tool
  shape that found both of tonight's dead wires.
- `unreal_set_actor_properties` — set display-name properties on matching
  actors and save (python literals via `pyValue`; booleans work).
- `unreal_duplicate_map` — duplicate a `/Game/...` map asset.
- `unreal_apply_material_to_actor` — assign a material slot on a named actor.
- `uds_inspect_level` — read-only sky/weather report: aurora/space switches,
  the sky→UDW reference, snow/rain state, manual-override pins.
- `uds_apply_preset` — editor-time lookdev presets. **Runtime phase profiles
  (DA_TOD_*) override these every tick in-game** — look checks only.
- `ascent_unreal_status` — paths, editor-running state, housekeeping.

### v2.1 world-building suite

- `unreal_list_assets` — asset-registry discovery (path + class/name filters).
- `unreal_asset_probe` / `unreal_set_asset_properties` — read/write properties
  on ANY asset (DataAssets, meshes, materials) or a Blueprint's class
  defaults. Struct/array writes are out of scope — script those.
- `unreal_spawn_actors` — batch placement (mesh/BP/class sources, transforms,
  tags, `clearTag` idempotency). Headless has **no physics**: supply Z.
- `unreal_import_assets` — batch FBX/texture/audio import; `textureType`
  configures normal/mask compression. Chunk big texture batches.
- `unreal_import_animation` — anim-only FBX onto an existing skeleton with
  the Trekker pipeline settings.
- `unreal_create_material_instance` — MI from parent + scalar/vector/texture
  params, verified by **readback** (UE 5.7's MEL setters return false even
  on success).
- `unreal_snapshot_level` — regenerates `.claude/level-snapshot.md`.
- `unreal_screenshot` — **the eyes**: launch `-game`, BugItGo vantages,
  console commands, screen captures, PNG paths back. Targets the game
  strictly by PID and never sends a keystroke unless the game verifiably
  holds foreground focus.

## Behavior contract (what v2 guarantees)

- **Commandlet flags**: `-stdout -Unattended -NoSplash -NoLogTimes
  -SCCProvider=None` always. Without `-stdout`, `unreal.log` lines never
  reach the caller; without `-Unattended`, one modal dialog eats the timeout.
- **Exit codes are checked**: failures return `isError` with the log tail —
  never a success-shaped blob.
- **Output is filtered**: marker lines (default `MCP |LogPython`) + a short
  tail on failure. Raw multi-MB UE logs never reach the model.
- **Runs are serialized** behind a mutex; two commandlets never race the
  project.
- **Editor detection**: mutating tools refuse while `UnrealEditor.exe` runs
  (commandlet saves lose to editor file locks, silently) unless
  `allowWithEditorOpen: true`. Read-only tools allow it by default.
- **Timeouts kill the whole process tree** (`taskkill /T /F`), not just the
  root — no orphaned ShaderCompileWorkers.
- **Saves** use `save_map` **plus** `save_dirty_packages(True, True)` —
  World Partition OFPA actors don't flush on `save_map` alone.
- **dryRun defaults to `true`** on mutating tools and returns the exact
  command line; generated scripts are pruned (newest 100 kept).

## Setup

```powershell
cd tools/ascent-unreal-mcp
npm install
npm test    # build + unit tests (node:test) + stdio smoke test — no Unreal needed
```

The repo `.mcp.json` registers this server as `ascent_unreal`. It launches
`dist/index.js`, so rebuild after editing.

## Environment

- `ASCENT_ROOT`: repository root (default: `cwd/../..`).
- `ASCENT_UPROJECT`: project path (default: `ASCENT_ROOT/Ascent/Ascent.uproject`).
- `UNREAL_EDITOR_CMD`: commandlet executable (default: UE 5.7 Program Files).

## Design rules

- Generated python goes to `scripts/generated/mcp/`; local scripts must live
  under `scripts/`; asset paths must be `/Game/...` with no traversal.
- Prefer `unreal_probe_actor` before believing any push-side log: the aurora
  was "pushed" for a week to a feature whose master switch was off.
- Never drive in-editor map switches through the UnrealClaude script queue
  (editor crash + boot re-run loop); map-switching batch work belongs here,
  headless, with editors closed.

# ascent-unreal-mcp

Project-specific MCP server for operating Ascent's Unreal project in a more orderly way.

It intentionally exposes small, named tools instead of arbitrary editor mutation:

- `unreal_run_python_script`: run a Python script under the project `scripts/` folder.
- `unreal_duplicate_map`: duplicate a map asset.
- `unreal_apply_material_to_actor`: assign a material slot on a named actor in one map.
- `unreal_apply_lanin_gaea_lab_material`: one-click apply for the current Lanin Gaea lab material.
- `uds_inspect_level`: inspect Ultra Dynamic Sky actors and important weather/time fields.
- `uds_apply_preset`: apply named UDS weather/time presets.

Most mutation tools default to `dryRun: true`. Use the dry-run command output first, then rerun with `dryRun: false` when the target is correct.

## Setup

From this folder:

```powershell
npm install
npm run build
```

The repo `.mcp.json` registers this server as `ascent_unreal`.

## Environment

- `ASCENT_ROOT`: repository root. Defaults to the current working directory.
- `ASCENT_UPROJECT`: Unreal project path. Defaults to `ASCENT_ROOT/Ascent/Ascent.uproject`.
- `UNREAL_EDITOR_CMD`: Unreal commandlet executable. Defaults to UE 5.7.

## Design Rules

- Generated Python scripts are written to `scripts/generated/mcp`.
- Asset paths must be `/Game/...`.
- Local scripts must stay inside the repo `scripts/` folder.
- Tool calls should prefer map-specific mutations over global edits.
- UDS preset names are explicit; no unreviewed free-form weather mutations.

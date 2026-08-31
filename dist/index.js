#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
const server = new McpServer({ name: "ascent-unreal-mcp", version: "0.1.0" });
const root = path.resolve(process.env.ASCENT_ROOT ?? path.resolve(process.cwd(), "..", ".."));
const uproject = path.resolve(process.env.ASCENT_UPROJECT ?? path.join(root, "Ascent", "Ascent.uproject"));
const editorCmd = process.env.UNREAL_EDITOR_CMD
    ? path.resolve(process.env.UNREAL_EDITOR_CMD)
    : "C:\\Program Files\\Epic Games\\UE_5.7\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe";
const generatedDir = path.join(root, "scripts", "generated", "mcp");
function toText(data) {
    return {
        content: [{
                type: "text",
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            }],
    };
}
function resolveInsideRoot(input) {
    const resolved = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        throw new Error(`Path escapes ASCENT_ROOT: ${input}`);
    }
    return resolved;
}
function resolveScript(input) {
    const resolved = resolveInsideRoot(input);
    const scriptsRoot = path.join(root, "scripts");
    const scriptsRootWithSep = `${scriptsRoot}${path.sep}`;
    if (resolved !== scriptsRoot && !resolved.startsWith(scriptsRootWithSep)) {
        throw new Error(`Script must live under scripts/: ${input}`);
    }
    if (!resolved.toLowerCase().endsWith(".py")) {
        throw new Error(`Expected a Python script: ${input}`);
    }
    return resolved;
}
function assertGamePath(input, label) {
    if (!input.startsWith("/Game/") || input.includes("..") || input.includes("\\")) {
        throw new Error(`${label} must be a /Game/... asset path`);
    }
    return input.replace(/\.(umap|uasset)$/i, "");
}
function pyString(value) {
    return JSON.stringify(value);
}
async function writeGeneratedScript(name, body) {
    await fs.mkdir(generatedDir, { recursive: true });
    const file = path.join(generatedDir, `${name}-${Date.now()}.py`);
    await fs.writeFile(file, `${body.trim()}\n`, "utf8");
    return file;
}
function commandForScript(script) {
    return {
        command: editorCmd,
        args: [uproject, "-run=pythonscript", `-script=${script}`],
    };
}
function runProcess(command, args, timeoutSeconds) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutSeconds * 1000);
        child.stdout.on("data", (chunk) => { stdout += String(chunk); });
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ code, stdout, stderr, timedOut });
        });
    });
}
async function runUnrealScript(script, dryRun, timeoutSeconds) {
    if (!existsSync(uproject))
        throw new Error(`Ascent uproject not found: ${uproject}`);
    if (!existsSync(editorCmd))
        throw new Error(`UnrealEditor-Cmd not found: ${editorCmd}`);
    const { command, args } = commandForScript(script);
    if (dryRun)
        return { command, args, dryRun };
    const result = await runProcess(command, args, timeoutSeconds);
    return { command, args, dryRun, ...result };
}
server.tool("unreal_run_python_script", "Run a project Python script through UnrealEditor-Cmd. Scripts must live under ASCENT_ROOT/scripts.", {
    script: z.string(),
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ script, timeoutSeconds, dryRun }) => {
    const scriptPath = resolveScript(script);
    if (!existsSync(scriptPath))
        throw new Error(`Script not found: ${scriptPath}`);
    return toText(await runUnrealScript(scriptPath, dryRun, timeoutSeconds));
});
server.tool("unreal_duplicate_map", "Duplicate a /Game map asset. Defaults to dry-run and refuses overwrite unless requested.", {
    sourceMap: z.string(),
    targetMap: z.string(),
    overwrite: z.boolean().default(false),
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ sourceMap, targetMap, overwrite, timeoutSeconds, dryRun }) => {
    const src = assertGamePath(sourceMap, "sourceMap");
    const dst = assertGamePath(targetMap, "targetMap");
    const script = await writeGeneratedScript("duplicate-map", `
import unreal
src = ${pyString(src)}
dst = ${pyString(dst)}
overwrite = ${overwrite ? "True" : "False"}
eal = unreal.EditorAssetLibrary
if not eal.does_asset_exist(src):
    raise SystemExit(f"MCP DUP ABORT: source map missing: {src}")
if eal.does_asset_exist(dst):
    if not overwrite:
        unreal.log(f"MCP DUP exists: {dst}")
    else:
        if not eal.delete_asset(dst):
            raise SystemExit(f"MCP DUP ABORT: could not delete existing {dst}")
        if not eal.duplicate_asset(src, dst):
            raise SystemExit(f"MCP DUP ABORT: duplicate failed {src} -> {dst}")
else:
    if not eal.duplicate_asset(src, dst):
        raise SystemExit(f"MCP DUP ABORT: duplicate failed {src} -> {dst}")
unreal.log(f"MCP DUP DONE: {src} -> {dst}")
`);
    return toText({ generatedScript: path.relative(root, script), ...(await runUnrealScript(script, dryRun, timeoutSeconds)) });
});
server.tool("unreal_apply_material_to_actor", "Load a map and assign a material to a named actor's StaticMeshComponent material slot.", {
    map: z.string(),
    actorLabel: z.string(),
    material: z.string(),
    slot: z.number().int().min(0).default(0),
    save: z.boolean().default(true),
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ map, actorLabel, material, slot, save, timeoutSeconds, dryRun }) => {
    const mapPath = assertGamePath(map, "map");
    const matPath = assertGamePath(material, "material");
    const script = await writeGeneratedScript("apply-material", `
import unreal
map_path = ${pyString(mapPath)}
actor_label = ${pyString(actorLabel)}
mat_path = ${pyString(matPath)}
slot = ${slot}
save = ${save ? "True" : "False"}
mat = unreal.load_asset(mat_path)
if not mat:
    raise SystemExit(f"MCP MAT ABORT: missing material {mat_path}")
unreal.EditorLoadingAndSavingUtils.load_map(map_path)
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
matches = [a for a in actors if a.get_actor_label() == actor_label]
if not matches:
    raise SystemExit(f"MCP MAT ABORT: actor not found {actor_label}")
actor = matches[0]
comp = actor.get_component_by_class(unreal.StaticMeshComponent)
if not comp:
    raise SystemExit(f"MCP MAT ABORT: no StaticMeshComponent on {actor_label}")
comp.set_material(slot, mat)
assigned = comp.get_material(slot)
unreal.log(f"MCP MAT actor={actor.get_actor_label()} slot={slot} material={assigned.get_path_name() if assigned else '<none>'}")
if save:
    ok = unreal.EditorLoadingAndSavingUtils.save_map(world, map_path)
    unreal.log(f"MCP MAT saved={ok} map={map_path}")
`);
    return toText({ generatedScript: path.relative(root, script), ...(await runUnrealScript(script, dryRun, timeoutSeconds)) });
});
server.tool("unreal_apply_lanin_gaea_lab_material", "Apply /Game/Environment/LaninTrueGaeaLab/M_LaninTrue_Play_GaeaLab to the LaninTrue_GaeaLab terrain.", {
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ timeoutSeconds, dryRun }) => {
    const scriptPath = resolveScript("scripts/apply_lanin_true_gaea_lab_material.py");
    if (!existsSync(scriptPath))
        throw new Error(`Script not found: ${scriptPath}`);
    return toText(await runUnrealScript(scriptPath, dryRun, timeoutSeconds));
});
server.tool("uds_setup_mcp_weather_demo", "Create and wire /Game/Maps/mcp_playground to the one-minute UDS weather choreography profile.", {
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ timeoutSeconds, dryRun }) => {
    const scriptPath = resolveScript("scripts/setup_mcp_weather_demo.py");
    if (!existsSync(scriptPath))
        throw new Error(`Script not found: ${scriptPath}`);
    return toText(await runUnrealScript(scriptPath, dryRun, timeoutSeconds));
});
server.tool("uds_verify_mcp_weather_demo", "Verify /Game/Maps/mcp_playground points at the one-minute UDS weather choreography profile.", {
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ timeoutSeconds, dryRun }) => {
    const scriptPath = resolveScript("scripts/verify_mcp_weather_demo.py");
    if (!existsSync(scriptPath))
        throw new Error(`Script not found: ${scriptPath}`);
    return toText(await runUnrealScript(scriptPath, dryRun, timeoutSeconds));
});
const udsPresetSchema = z.enum([
    "clear_vista",
    "dawn_alpenglow",
    "storm_check",
    "night_arc",
]);
function udsPresetValues(name) {
    switch (name) {
        case "dawn_alpenglow":
            return {
                "Time of Day": 6.1,
                "Cloud Coverage": 0.22,
                "Fog": 0.06,
                "Base Fog Density": 0.0015,
                "Volumetric Fog Extinction": 0.018,
                "Cloud Wisps Opacity (Clear)": 0.42,
                "Cloud Wisps Color Intensity": 0.9,
                "Render Exponential Height Fog": true,
                "Use Volumetric Fog": false,
            };
        case "storm_check":
            return {
                "Time of Day": 13.0,
                "Cloud Coverage": 0.78,
                "Fog": 0.18,
                "Base Fog Density": 0.006,
                "Volumetric Fog Extinction": 0.04,
                "Cloud Wisps Opacity (Clear)": 0.8,
                "Cloud Wisps Color Intensity": 0.65,
                "Render Exponential Height Fog": true,
                "Use Volumetric Fog": false,
            };
        case "night_arc":
            return {
                "Time of Day": 2.4,
                "Cloud Coverage": 0.18,
                "Fog": 0.04,
                "Base Fog Density": 0.0008,
                "Volumetric Fog Extinction": 0.01,
                "Cloud Wisps Opacity (Clear)": 0.26,
                "Cloud Wisps Color Intensity": 0.55,
                "Render Exponential Height Fog": false,
                "Use Volumetric Fog": false,
            };
        case "clear_vista":
        default:
            return {
                "Time of Day": 12.0,
                "Cloud Coverage": 0.05,
                "Fog": 0.0,
                "Base Fog Density": 0.0003,
                "Volumetric Fog Extinction": 0.0,
                "Cloud Wisps Opacity (Clear)": 0.18,
                "Cloud Wisps Color Intensity": 0.75,
                "Render Exponential Height Fog": false,
                "Use Volumetric Fog": false,
            };
    }
}
server.tool("uds_inspect_level", "Load a map and inspect UDS-like sky actors and important time/weather properties.", {
    map: z.string(),
    actorLabel: z.string().optional(),
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ map, actorLabel, timeoutSeconds, dryRun }) => {
    const mapPath = assertGamePath(map, "map");
    const script = await writeGeneratedScript("uds-inspect", `
import unreal
map_path = ${pyString(mapPath)}
wanted = ${pyString(actorLabel ?? "")}
props = [
    "Time of Day", "TimeOfDay", "Cloud Coverage", "CloudCoverage", "Fog",
    "Base Fog Density", "Volumetric Fog Extinction",
    "Render Exponential Height Fog", "Use Volumetric Fog",
    "Cloud Wisps Opacity (Clear)", "Cloud Wisps Color Intensity",
]
unreal.EditorLoadingAndSavingUtils.load_map(map_path)
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
out = []
for actor in actors:
    label = actor.get_actor_label()
    cls = actor.get_class().get_name()
    if wanted and label != wanted:
        continue
    if (not wanted) and ("Sky" not in label and "UDS" not in label and "Ultra" not in label and "Sky" not in cls):
        continue
    row = {"label": label, "class": cls, "values": {}}
    for prop in props:
        try:
            row["values"][prop] = actor.get_editor_property(prop)
        except Exception:
            pass
    out.append(row)
unreal.log("MCP UDS INSPECT " + str(out))
`);
    return toText({ generatedScript: path.relative(root, script), ...(await runUnrealScript(script, dryRun, timeoutSeconds)) });
});
server.tool("uds_apply_preset", "Apply a named UDS time/weather preset to a sky actor in one map.", {
    map: z.string(),
    preset: udsPresetSchema,
    actorLabel: z.string().default("BP_AscentSky"),
    save: z.boolean().default(true),
    timeoutSeconds: z.number().int().positive().default(300),
    dryRun: z.boolean().default(true),
}, async ({ map, preset, actorLabel, save, timeoutSeconds, dryRun }) => {
    const mapPath = assertGamePath(map, "map");
    const values = udsPresetValues(preset);
    const script = await writeGeneratedScript("uds-preset", `
import unreal
map_path = ${pyString(mapPath)}
actor_label = ${pyString(actorLabel)}
save = ${save ? "True" : "False"}
values = ${JSON.stringify(values, null, 4)}

def try_set(obj, name, value):
    variants = [name, name.replace(" ", ""), name.replace(" ", "_"), name.lower().replace(" ", "_")]
    for variant in variants:
        try:
            obj.set_editor_property(variant, value)
            unreal.log(f"MCP UDS SET {variant}={value}")
            return True
        except Exception:
            pass
    unreal.log_warning(f"MCP UDS MISS {name}")
    return False

unreal.EditorLoadingAndSavingUtils.load_map(map_path)
world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
matches = [a for a in actors if a.get_actor_label() == actor_label]
if not matches:
    matches = [a for a in actors if "Sky" in a.get_actor_label() or "UDS" in a.get_actor_label()]
if not matches:
    raise SystemExit("MCP UDS ABORT: no UDS/sky actor found")
actor = matches[0]
unreal.log(f"MCP UDS actor={actor.get_actor_label()} preset=${preset}")
for key, value in values.items():
    try_set(actor, key, value)
for fn in ("UpdateTimeOfDay", "Update Time of Day", "Refresh Sky Everything", "RefreshSkyEverything"):
    try:
        actor.call_method(fn)
        unreal.log(f"MCP UDS called {fn}")
        break
    except Exception:
        pass
if save:
    ok = unreal.EditorLoadingAndSavingUtils.save_map(world, map_path)
    unreal.log(f"MCP UDS saved={ok} map={map_path}")
`);
    return toText({ preset, values, generatedScript: path.relative(root, script), ...(await runUnrealScript(script, dryRun, timeoutSeconds)) });
});
server.tool("ascent_unreal_status", "Report configured paths for this Ascent Unreal MCP server.", {}, async () => toText({
    root,
    uproject,
    editorCmd,
    generatedDir,
    uprojectExists: existsSync(uproject),
    editorCmdExists: existsSync(editorCmd),
}));
const transport = new StdioServerTransport();
await server.connect(transport);

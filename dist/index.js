#!/usr/bin/env node
/**
 * ascent-unreal-mcp v2 — orderly Unreal operations for Ascent.
 *
 * v2 is a field-hardened rewrite after the 2026-08-31 night session:
 *  - `-Unattended -NoSplash -NoLogTimes -SCCProvider=None -stdout` on every
 *    commandlet (without -stdout, unreal.log lines never reach the caller;
 *    without -Unattended, one modal dialog eats the whole timeout).
 *  - exit codes checked; failures return isError instead of dressing up as
 *    success.
 *  - output is FILTERED (marker lines + tail), never a raw multi-MB UE log.
 *  - runs are serialized behind a mutex; a running editor is detected and
 *    surfaced (mutating tools refuse by default — commandlet saves lose to
 *    editor file locks).
 *  - timeout kills the whole process tree (taskkill /T), not just the root.
 *  - python literals via pyValue() (True/False/None — JSON.stringify emitted
 *    `false` into generated python and NameError'd every preset).
 *  - generated save_map is always followed by save_dirty_packages (World
 *    Partition OFPA actors don't flush on save_map alone).
 *  - `unreal_probe_actor`: read actor properties by display name — the tool
 *    shape that found both the dead aurora switch and the null sky->UDW ref.
 */
import { spawn, execFile } from "node:child_process";
import { promises as fsp, existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// ── config ───────────────────────────────────────────────────────
export const VERSION = "2.1.0";
const root = path.resolve(process.env.ASCENT_ROOT ?? path.join(process.cwd(), "..", ".."));
const uproject = path.resolve(process.env.ASCENT_UPROJECT ?? path.join(root, "Ascent", "Ascent.uproject"));
const editorCmd = path.resolve(process.env.UNREAL_EDITOR_CMD ??
    "C:\\Program Files\\Epic Games\\UE_5.7\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe");
const generatedDir = path.join(root, "scripts", "generated", "mcp");
// ── small helpers (exported for unit tests) ──────────────────────
const normCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
export function resolveInsideRoot(rel, base = root) {
    const resolved = path.resolve(base, rel);
    if (resolved !== base && !normCase(resolved).startsWith(normCase(base + path.sep))) {
        throw new Error(`path escapes the project root: ${rel}`);
    }
    return resolved;
}
export function resolveScript(rel) {
    const scriptsDir = path.join(root, "scripts");
    const resolved = resolveInsideRoot(rel);
    if (!normCase(resolved).startsWith(normCase(scriptsDir + path.sep))) {
        throw new Error(`scripts must live under scripts/: ${rel}`);
    }
    if (!resolved.endsWith(".py"))
        throw new Error(`not a .py script: ${rel}`);
    if (!existsSync(resolved))
        throw new Error(`script not found: ${resolved}`);
    return resolved;
}
export function assertGamePath(p, label) {
    const rooted = p === "/Game" || p.startsWith("/Game/");
    if (!rooted || p.includes("..") || p.includes("\\")) {
        throw new Error(`${label} must be a clean /Game/... path, got: ${p}`);
    }
    return p;
}
export const pyString = (s) => JSON.stringify(s);
/** Serialize a JS value as a PYTHON literal. JSON.stringify alone emits
 *  `true`/`false`/`null`, which are NameErrors in python — the bug that made
 *  uds_apply_preset dead on arrival in v1. */
export function pyValue(v) {
    if (v === null || v === undefined)
        return "None";
    if (typeof v === "boolean")
        return v ? "True" : "False";
    if (typeof v === "number")
        return Number.isFinite(v) ? String(v) : "None";
    if (typeof v === "string")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(pyValue).join(", ") + "]";
    if (typeof v === "object") {
        return ("{" +
            Object.entries(v)
                .map(([k, val]) => `${JSON.stringify(k)}: ${pyValue(val)}`)
                .join(", ") +
            "}");
    }
    return "None";
}
/** Keep the model-facing output small: marker-matching lines (capped) plus a
 *  short tail. A raw commandlet log is tens of MB and would flood context. */
export function filterOutput(text, pattern, maxLines = 200, tailChars = 1500) {
    let re;
    try {
        re = new RegExp(pattern);
    }
    catch {
        re = /MCP |LogPython/;
    }
    const lines = text.split(/\r?\n/);
    const matched = [];
    let truncated = 0;
    for (const line of lines) {
        if (re.test(line)) {
            if (matched.length < maxLines)
                matched.push(line.replace(/^\[[^\]]*\]\[[ 0-9]*\]/, "").trim());
            else
                truncated++;
        }
    }
    return { matched, truncatedMatches: truncated, tail: text.slice(-tailChars) };
}
const MAX_CAPTURE = 8 * 1024 * 1024; // rolling cap per stream
function killTree(pid) {
    if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
    }
    else {
        try {
            process.kill(-pid, "SIGKILL");
        }
        catch {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch {
                /* already gone */
            }
        }
    }
}
function runProcess(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(command, args, { cwd: root, windowsHide: true });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid)
                killTree(child.pid);
        }, timeoutMs);
        const cap = (cur, chunk) => {
            const next = cur + chunk;
            return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
        };
        child.stdout?.on("data", (d) => (stdout = cap(stdout, d.toString("utf8"))));
        child.stderr?.on("data", (d) => (stderr = cap(stderr, d.toString("utf8"))));
        child.on("error", (err) => {
            clearTimeout(timer); // v1 leaked this timer on spawn failure
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, timedOut, durationMs: Date.now() - started, stdout, stderr });
        });
    });
}
export async function editorRunning() {
    if (process.platform !== "win32")
        return false;
    return new Promise((resolve) => {
        execFile("tasklist", ["/FI", "IMAGENAME eq UnrealEditor.exe", "/FO", "CSV", "/NH"], (err, out) => {
            resolve(!err && /UnrealEditor\.exe/i.test(out ?? ""));
        });
    });
}
// One commandlet at a time. Two UnrealEditor-Cmd instances race the project
// lock, the DDC, and each other's saves.
let runChain = Promise.resolve();
function withLock(fn) {
    const next = runChain.then(fn, fn);
    runChain = next.catch(() => undefined);
    return next;
}
// ── generated-script lifecycle ───────────────────────────────────
function pruneGenerated(keep = 100) {
    try {
        const files = readdirSync(generatedDir)
            .filter((f) => f.endsWith(".py"))
            .map((f) => ({ f, m: statSync(path.join(generatedDir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        for (const { f } of files.slice(keep))
            unlinkSync(path.join(generatedDir, f));
    }
    catch {
        /* best-effort */
    }
}
let scriptSeq = 0;
async function writeGeneratedScript(name, body) {
    mkdirSync(generatedDir, { recursive: true });
    const file = path.join(generatedDir, `${name}-${Date.now()}-${scriptSeq++}.py`);
    await fsp.writeFile(file, `${body.trim()}\n`, "utf8");
    return file;
}
// ── commandlet execution ─────────────────────────────────────────
// Args NEVER ride on the command line: libuv quotes the whole `-script=…`
// token, which defeats UE's PythonScriptCommandlet tokenizer and silently
// drops them (verified against engine source + an empirical quoting test).
// Instead we generate a wrapper that sets sys.argv and exec()s the target.
const SCRIPT_ARG_RE = /^[^\r\n]{1,200}$/;
/** ok-computation, exported so tests can pin it: unrelated plugin errors at
 *  boot poison the commandlet exit code, so a python-success line + marker
 *  outrank a nonzero exit. */
export function computeOk(i) {
    return !i.timedOut && i.markerOk && (i.code === 0 || i.pySuccess);
}
function jsonResult(ok, payload) {
    return {
        content: [{ type: "text", text: JSON.stringify({ ok, ...payload }, null, 2) }],
        ...(ok ? {} : { isError: true }),
    };
}
async function execCommandlet(tool, scriptPath, opts) {
    let effectiveScript = scriptPath;
    const scriptArgs = opts.scriptArgs ?? [];
    if (scriptArgs.length > 0) {
        for (const a of scriptArgs) {
            if (!SCRIPT_ARG_RE.test(a)) {
                return jsonResult(false, { tool, error: `script arg rejected (newline or >200 chars): ${a}` });
            }
        }
        // Wrapper delivers args via sys.argv — the CLI path silently drops them.
        const wrapper = `
import sys
target = ${pyString(scriptPath)}
sys.argv = [target] + ${pyValue(scriptArgs)}
code = compile(open(target, encoding="utf-8").read(), target, "exec")
exec(code, {"__name__": "__main__", "__file__": target})
`;
        effectiveScript = await writeGeneratedScript(`${tool}-argv-wrapper`, wrapper);
    }
    const args = [
        uproject,
        "-run=pythonscript",
        `-script=${effectiveScript}`,
        // -stdout alone forwards only Display+ verbosity; unreal.log() writes at
        // Log verbosity and silently vanishes without -FullStdOutLogOutput.
        "-stdout",
        "-FullStdOutLogOutput",
        "-Unattended",
        "-NoSplash",
        "-NoLogTimes",
        "-SCCProvider=None",
    ];
    if (!existsSync(uproject))
        return jsonResult(false, { tool, error: `uproject not found: ${uproject}` });
    if (!existsSync(editorCmd))
        return jsonResult(false, { tool, error: `editor cmd not found: ${editorCmd}` });
    if (opts.dryRun) {
        const editorUp = await editorRunning();
        return jsonResult(true, { tool, dryRun: true, command: editorCmd, args, editorRunning: editorUp });
    }
    // Editor check happens INSIDE the lock (TOCTOU: an editor can open while a
    // prior run holds the mutex) and the refusal decision uses that sample.
    const run = await withLock(async () => {
        const editorUp = await editorRunning();
        if (editorUp && !opts.allowWithEditorOpen) {
            return { refusedEditorOpen: true, editorUp };
        }
        const r = await runProcess(editorCmd, args, opts.timeoutSeconds * 1000);
        return { ...r, editorUp };
    });
    if ("refusedEditorOpen" in run) {
        return jsonResult(false, {
            tool,
            error: "An Unreal editor is running: commandlet SAVES lose to its file locks and can silently not persist. " +
                "Close the editor, or pass allowWithEditorOpen: true (fine for read-only work).",
            editorRunning: true,
        });
    }
    const filter = opts.outputFilter ?? "MCP |LogPython";
    const combined = run.stdout + (run.stderr ? "\n" + run.stderr : "");
    const out = filterOutput(combined, filter);
    // Marker/success lines are checked against the RAW log, not the filtered
    // view, so a custom outputFilter can't turn a passing run into a failure.
    const markerOk = opts.expectMarker ? combined.includes(opts.expectMarker) : true;
    const pySuccess = combined.includes("Python script executed successfully");
    const ok = computeOk({ code: run.code, timedOut: run.timedOut, markerOk, pySuccess });
    return jsonResult(ok, {
        tool,
        dryRun: false,
        exitCode: run.code,
        pythonReportedSuccess: pySuccess,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        editorRunning: run.editorUp,
        warning: run.editorUp && opts.allowWithEditorOpen
            ? "editor was open during this run — saves may not have persisted (verify with unreal_probe_actor)"
            : undefined,
        markerFound: opts.expectMarker ? markerOk : undefined,
        output: out.matched,
        truncatedMatches: out.truncatedMatches,
        tail: ok ? undefined : out.tail, // only ship the raw tail when something went wrong
    });
}
async function execGenerated(tool, pyBody, opts) {
    const file = await writeGeneratedScript(tool, pyBody);
    return execCommandlet(tool, file, { ...opts, expectMarker: opts.expectMarker ?? `MCP OK ${tool}` });
}
// ── shared python fragments ──────────────────────────────────────
const PY_HEADER = `
import json
import unreal

def _load(map_path):
    # load_map does NOT raise on a missing /Game path — the editor keeps its
    # startup world and the script would run against the WRONG world.
    if not unreal.EditorAssetLibrary.does_asset_exist(map_path):
        raise RuntimeError("map does not exist: %s" % map_path)
    unreal.EditorLoadingAndSavingUtils.load_map(map_path)
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    expected = map_path.rsplit("/", 1)[-1]
    if world is None or world.get_name() != expected:
        raise RuntimeError("wrong world after load_map(%s): %s"
                           % (map_path, world.get_name() if world else "None"))
    return world

def _save(world, map_path):
    ok = unreal.EditorLoadingAndSavingUtils.save_map(world, map_path)
    unreal.log("MCP SAVED %s ok=%s" % (map_path, ok))
    if not ok:
        # A False save (file lock, read-only, SCC) must NOT dress up as success.
        raise RuntimeError("save_map FAILED for %s (file lock? editor open?)" % map_path)
    # World Partition OFPA actor packages do NOT flush on save_map alone.
    unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
    return ok

def _obj(v):
    if isinstance(v, unreal.Object):
        return v.get_path_name() if v else None
    return v
`;
// ── zod shapes ───────────────────────────────────────────────────
const timeoutSchema = z.number().int().min(30).max(3600).default(420);
const dryRunSchema = z.boolean().default(true);
// ── server ───────────────────────────────────────────────────────
const server = new McpServer({ name: "ascent-unreal-mcp", version: VERSION });
server.tool("unreal_run_python_script", "Run an existing python script from the repo scripts/ folder through a headless commandlet. " +
    "Optional args reach the script via sys.argv (no whitespace in an arg). Output is filtered to " +
    "marker lines (default: 'MCP |LogPython') — have your script unreal.log() what matters.", {
    script: z.string().describe("Repo-relative path under scripts/, e.g. scripts/render_enables.py"),
    args: z.array(z.string()).max(8).default([]),
    outputFilter: z.string().optional().describe("Regex for which log lines to return"),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ script, args, outputFilter, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let scriptPath;
    try {
        scriptPath = resolveScript(script);
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_run_python_script", error: String(e) });
    }
    return execCommandlet("unreal_run_python_script", scriptPath, {
        timeoutSeconds,
        dryRun,
        outputFilter,
        allowWithEditorOpen,
        scriptArgs: args,
    });
});
server.tool("unreal_probe_actor", "READ-ONLY: load a map and read actor properties by their editor display names " +
    "(e.g. 'Use Auroras', 'Ultra Dynamic Weather'). Matches actors whose label OR class contains " +
    "actorMatch (case-insensitive). This is the tool shape that found the dead aurora switch and " +
    "the null sky->weather reference — read back the ACTUAL state instead of trusting push logs.", {
    map: z.string().describe("/Game/... map path"),
    actorMatch: z.string().min(1).describe("Substring of actor label or class"),
    props: z.array(z.string().min(1)).min(1).max(40),
    maxActors: z.number().int().min(1).max(20).default(5),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ map, actorMatch, props, maxActors, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_probe_actor", error: String(e) });
    }
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
needle = ${pyString(actorMatch)}.lower()
props = ${pyValue(props)}
out = []
for a in sub.get_all_level_actors():
    label = a.get_actor_label()
    cls = a.get_class().get_name()
    if needle in label.lower() or needle in cls.lower():
        entry = {"label": label, "class": cls, "props": {}}
        for p in props:
            try:
                entry["props"][p] = _obj(a.get_editor_property(p))
            except Exception as e:
                entry["props"][p] = "<unreadable: %s>" % str(e)[:60]
        out.append(entry)
        if len(out) >= ${pyValue(maxActors)}:
            break
unreal.log("MCP PROBE_JSON " + json.dumps(out, default=str))
unreal.log("MCP OK unreal_probe_actor")
`;
    return execGenerated("unreal_probe_actor", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_set_actor_properties", "Set editor-display-name properties on matching actors in a map, then SAVE the map. " +
    "Values are converted to python literals safely (booleans included). Mutating: refuses while an " +
    "editor is open unless allowWithEditorOpen.", {
    map: z.string(),
    actorMatch: z.string().min(1),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    maxActors: z.number().int().min(1).max(10).default(1),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ map, actorMatch, properties, maxActors, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_set_actor_properties", error: String(e) });
    }
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
needle = ${pyString(actorMatch)}.lower()
values = ${pyValue(properties)}
hit = 0
applied = 0
failed = 0
for a in sub.get_all_level_actors():
    if needle in a.get_actor_label().lower() or needle in a.get_class().get_name().lower():
        a.modify()
        for p, v in values.items():
            try:
                before = _obj(a.get_editor_property(p))
                a.set_editor_property(p, v)
                applied += 1
                unreal.log("MCP SET %s.%s: %s -> %s" % (a.get_actor_label(), p, before, v))
            except Exception as e:
                failed += 1
                unreal.log_warning("MCP SET_FAIL %s.%s: %s" % (a.get_actor_label(), p, str(e)[:80]))
        hit += 1
        if hit >= ${pyValue(maxActors)}:
            break
if hit == 0:
    raise RuntimeError("no actor matched %r" % ${pyString(actorMatch)})
if applied == 0:
    raise RuntimeError("actor matched but ZERO properties applied (%d failed) — check display names" % failed)
unreal.log("MCP SET_SUMMARY applied=%d failed=%d actors=%d" % (applied, failed, hit))
_save(world, ${pyString(map)})
unreal.log("MCP OK unreal_set_actor_properties")
`;
    return execGenerated("unreal_set_actor_properties", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_duplicate_map", "Duplicate a /Game/... map asset. Mutating: refuses while an editor is open unless allowWithEditorOpen.", {
    sourceMap: z.string(),
    targetMap: z.string(),
    overwrite: z.boolean().default(false),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ sourceMap, targetMap, overwrite, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(sourceMap, "sourceMap");
        assertGamePath(targetMap, "targetMap");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_duplicate_map", error: String(e) });
    }
    const body = `${PY_HEADER}
eal = unreal.EditorAssetLibrary
src = ${pyString(sourceMap)}
dst = ${pyString(targetMap)}
if eal.does_asset_exist(dst):
    if ${pyValue(overwrite)}:
        eal.delete_asset(dst)
        unreal.log("MCP DUP deleted existing %s" % dst)
    else:
        raise RuntimeError("target exists (pass overwrite=true): %s" % dst)
# duplicate_asset on a World Partition map does NOT carry the OFPA external
# actor packages (verified against UE 5.7 engine source) — the target opens
# empty. Load + save-as is the flow that re-keys external packages.
world = _load(src)
_save(world, dst)
unreal.log("MCP DUP %s -> %s (load+save-as, OFPA-safe)" % (src, dst))
unreal.log("MCP OK unreal_duplicate_map")
`;
    return execGenerated("unreal_duplicate_map", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_apply_material_to_actor", "Assign a material to a slot on a named actor's static mesh component in one map, then save. " +
    "Mutating: refuses while an editor is open unless allowWithEditorOpen.", {
    map: z.string(),
    actorLabel: z.string().min(1),
    material: z.string(),
    slot: z.number().int().min(0).default(0),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ map, actorLabel, material, slot, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
        assertGamePath(material, "material");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_apply_material_to_actor", error: String(e) });
    }
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
mat = unreal.load_asset(${pyString(material)})
if not mat:
    raise RuntimeError("material missing: %s" % ${pyString(material)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
target = None
for a in sub.get_all_level_actors():
    if a.get_actor_label() == ${pyString(actorLabel)}:
        target = a
        break
if not target:
    raise RuntimeError("actor not found: %s" % ${pyString(actorLabel)})
comp = target.get_component_by_class(unreal.StaticMeshComponent)
if not comp:
    raise RuntimeError("actor has no StaticMeshComponent: %s" % ${pyString(actorLabel)})
# Without Modify(), the OFPA actor package may never be marked dirty and the
# save can skip it.
target.modify()
comp.modify()
comp.set_material(${pyValue(slot)}, mat)
unreal.log("MCP MAT %s slot %d -> %s" % (${pyString(actorLabel)}, ${pyValue(slot)}, ${pyString(material)}))
_save(world, ${pyString(map)})
unreal.log("MCP OK unreal_apply_material_to_actor")
`;
    return execGenerated("unreal_apply_material_to_actor", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("uds_inspect_level", "READ-ONLY: report the sky (UDS) and weather (UDW) actors in a map with the fields that have " +
    "actually burned us: aurora/space master switches, the sky->UDW reference, snow/rain state, " +
    "manual-override pins, time of day. Returns one MCP INSPECT_JSON line.", {
    map: z.string(),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ map, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
    }
    catch (e) {
        return jsonResult(false, { tool: "uds_inspect_level", error: String(e) });
    }
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
SKY_PROPS = ["Time of Day", "Use Auroras", "Force Enable Space Layer", "Space Layer Active",
             "Space Layer Brightness (Night)", "Aurora Intensity", "Stars Intensity",
             "Space Glow Brightness", "Fog", "Cloud Coverage", "Ultra Dynamic Weather"]
UDW_PROPS = ["Snow", "Rain", "Fog", "Cloud Coverage", "Wind Intensity",
             "Enable Snow Particles", "Enable Rain Particles",
             "Snow - Manual Override", "Rain - Manual Override",
             "Global Weather State", "Random Weather Variations"]
out = {"map": ${pyString(map)}, "sky": [], "udw": []}
for a in sub.get_all_level_actors():
    cls = a.get_class().get_name()
    bucket = None
    props = None
    if "Ultra_Dynamic_Weather" in cls:
        bucket, props = "udw", UDW_PROPS
    elif "AscentSky" in cls or "Ultra_Dynamic_Sky" in cls:
        bucket, props = "sky", SKY_PROPS
    if bucket:
        entry = {"label": a.get_actor_label(), "class": cls, "props": {}}
        for p in props:
            try:
                entry["props"][p] = _obj(a.get_editor_property(p))
            except Exception:
                entry["props"][p] = "<no such prop>"
        out[bucket].append(entry)
unreal.log("MCP INSPECT_JSON " + json.dumps(out, default=str))
unreal.log("MCP OK uds_inspect_level")
`;
    return execGenerated("uds_inspect_level", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
// Editor-time lookdev presets. NOTE: at runtime the TimeOfDayController's
// phase system re-pushes sky values every 0.2s — ship-facing values belong in
// the DA_TOD_* profiles, not here. These are for eyeballing a look in-editor.
const UDS_PRESETS = {
    clear_vista: {
        "Time of Day": 1030,
        Fog: 0.02,
        "Cloud Coverage": 0.8,
        "Stars Intensity": 0,
        "Aurora Intensity": 0,
        "Render Exponential Height Fog": true,
        "Use Volumetric Fog": true,
    },
    dawn_alpenglow: {
        "Time of Day": 622,
        Fog: 0.05,
        "Cloud Coverage": 1.6,
        "Stars Intensity": 0.05,
        "Aurora Intensity": 0,
        "Render Exponential Height Fog": true,
        "Use Volumetric Fog": true,
    },
    storm_check: {
        "Time of Day": 1400,
        Fog: 0.6,
        "Cloud Coverage": 8.0,
        "Stars Intensity": 0,
        "Aurora Intensity": 0,
        "Render Exponential Height Fog": true,
        "Use Volumetric Fog": true,
    },
    night_arc: {
        "Time of Day": 2300,
        Fog: 0.01,
        "Cloud Coverage": 0.3,
        "Stars Intensity": 1.0,
        "Aurora Intensity": 2.0,
        "Render Exponential Height Fog": true,
        "Use Volumetric Fog": true,
    },
};
server.tool("uds_apply_preset", "Apply a named editor-time UDS lookdev preset to the sky actor and save the map. " +
    "WARNING: runtime phase profiles (DA_TOD_*) override these every tick in-game — this is for " +
    "in-editor look checks only. Mutating: refuses while an editor is open unless allowWithEditorOpen.", {
    map: z.string(),
    preset: z.enum(["clear_vista", "dawn_alpenglow", "storm_check", "night_arc"]),
    actorLabel: z.string().default("BP_AscentSky"),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ map, preset, actorLabel, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
    }
    catch (e) {
        return jsonResult(false, { tool: "uds_apply_preset", error: String(e) });
    }
    const values = UDS_PRESETS[preset];
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
values = ${pyValue(values)}
target = None
for a in sub.get_all_level_actors():
    cls = a.get_class().get_name()
    if a.get_actor_label() == ${pyString(actorLabel)} or "AscentSky" in cls or "Ultra_Dynamic_Sky" in cls:
        target = a
        break
if not target:
    raise RuntimeError("no sky actor found (wanted label %s)" % ${pyString(actorLabel)})

def try_set(actor, name, value):
    for cand in (name, name.replace(" ", ""), name.replace(" ", "_"), name.lower().replace(" ", "_")):
        try:
            actor.set_editor_property(cand, value)
            return cand
        except Exception:
            pass
    return None

applied = {}
n_ok = 0
for name, value in values.items():
    used = try_set(target, name, value)
    applied[name] = used or "<no matching property>"
    if used:
        n_ok += 1
unreal.log("MCP PRESET ${preset} on %s: %s" % (target.get_actor_label(), json.dumps(applied)))
if n_ok == 0:
    raise RuntimeError("preset applied ZERO properties — sky actor class mismatch?")
target.modify()
for fn in ("Cinematic Runtime Update", "Update Common Derivatives", "Update Active Variables", "Update Static Variables"):
    try:
        target.call_method(fn)
        unreal.log("MCP REFRESH %s" % fn)
        break
    except Exception:
        pass
_save(world, ${pyString(map)})
unreal.log("MCP OK uds_apply_preset")
`;
    return execGenerated("uds_apply_preset", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("ascent_unreal_status", "Server/environment status: paths, whether an Unreal editor is currently running (file-lock risk " +
    "for mutating tools), and generated-script housekeeping.", {}, async () => {
    const editorUp = await editorRunning();
    let generatedCount = 0;
    try {
        generatedCount = readdirSync(generatedDir).filter((f) => f.endsWith(".py")).length;
    }
    catch {
        /* dir may not exist yet */
    }
    return jsonResult(true, {
        tool: "ascent_unreal_status",
        version: VERSION,
        root,
        uproject: { path: uproject, exists: existsSync(uproject) },
        editorCmd: { path: editorCmd, exists: existsSync(editorCmd) },
        editorRunning: editorUp,
        generatedDir,
        generatedScripts: generatedCount,
    });
});
// ═══ v2.1: world-building suite ══════════════════════════════════
// Grounded in what this project does every day: place things, import
// things, tune materials/data assets, and SEE the result.
const editorExe = path.join(path.dirname(editorCmd), "UnrealEditor.exe");
const gamePathSchema = z.string().describe("/Game/... asset path");
server.tool("unreal_list_assets", "READ-ONLY: query the asset registry under a /Game path, optionally filtering by class-name and " +
    "asset-name substrings. Cheap discovery before probe/set tools.", {
    path: gamePathSchema.default("/Game"),
    classContains: z.string().optional(),
    nameContains: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ path: gamePath, classContains, nameContains, limit, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(gamePath, "path");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_list_assets", error: String(e) });
    }
    const body = `${PY_HEADER}
reg = unreal.AssetRegistryHelpers.get_asset_registry()
f = unreal.ARFilter(package_paths=[${pyString(gamePath)}], recursive_paths=True)
cls_needle = ${pyValue(classContains ?? null)}
name_needle = ${pyValue(nameContains ?? null)}
out = []
for ad in reg.get_assets(f):
    cls = str(ad.asset_class_path.asset_name)
    name = str(ad.asset_name)
    if cls_needle and cls_needle.lower() not in cls.lower():
        continue
    if name_needle and name_needle.lower() not in name.lower():
        continue
    out.append({"name": name, "class": cls, "path": str(ad.package_name)})
    if len(out) >= ${pyValue(limit)}:
        break
unreal.log("MCP ASSETS_JSON " + json.dumps(out))
unreal.log("MCP OK unreal_list_assets")
`;
    return execGenerated("unreal_list_assets", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
const PY_ASSET_TARGET = `
def _asset_target(asset_path, class_defaults):
    a = unreal.load_asset(asset_path)
    if not a:
        raise RuntimeError("asset not found: %s" % asset_path)
    if class_defaults:
        gc = a.generated_class() if isinstance(a, unreal.Blueprint) else None
        if gc:
            return unreal.get_default_object(gc), "CDO of %s" % asset_path
        raise RuntimeError("classDefaults requested but %s is not a Blueprint" % asset_path)
    return a, asset_path
`;
server.tool("unreal_asset_probe", "READ-ONLY: read properties by display name off ANY asset — DataAssets (e.g. TOD profiles), " +
    "meshes, materials — or a Blueprint's class defaults (classDefaults: true). The asset-side " +
    "sibling of unreal_probe_actor.", {
    asset: gamePathSchema,
    props: z.array(z.string().min(1)).min(1).max(40),
    classDefaults: z.boolean().default(false),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ asset, props, classDefaults, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(asset, "asset");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_asset_probe", error: String(e) });
    }
    const body = `${PY_HEADER}${PY_ASSET_TARGET}
target, label = _asset_target(${pyString(asset)}, ${pyValue(classDefaults)})
out = {"target": label, "class": target.get_class().get_name(), "props": {}}
for p in ${pyValue(props)}:
    try:
        out["props"][p] = _obj(target.get_editor_property(p))
    except Exception as e:
        out["props"][p] = "<unreadable: %s>" % str(e)[:60]
unreal.log("MCP ASSET_JSON " + json.dumps(out, default=str))
unreal.log("MCP OK unreal_asset_probe")
`;
    return execGenerated("unreal_asset_probe", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_set_asset_properties", "Set simple-valued properties (number/bool/string; a /Game/... string is auto-loaded as an " +
    "object reference) on an asset or a Blueprint's class defaults, then save the asset. " +
    "Struct/array properties are NOT supported — use unreal_run_python_script for those.", {
    asset: gamePathSchema,
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    classDefaults: z.boolean().default(false),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ asset, properties, classDefaults, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(asset, "asset");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_set_asset_properties", error: String(e) });
    }
    const body = `${PY_HEADER}${PY_ASSET_TARGET}
target, label = _asset_target(${pyString(asset)}, ${pyValue(classDefaults)})
values = ${pyValue(properties)}
applied = 0
failed = 0
for p, v in values.items():
    resolved = v
    if isinstance(v, str) and v.startswith("/Game/"):
        loaded = unreal.load_asset(v)
        if loaded:
            resolved = loaded
    try:
        before = _obj(target.get_editor_property(p))
        target.set_editor_property(p, resolved)
        applied += 1
        unreal.log("MCP SET %s.%s: %s -> %s" % (label, p, before, v))
    except Exception as e:
        failed += 1
        unreal.log_warning("MCP SET_FAIL %s.%s: %s" % (label, p, str(e)[:80]))
if applied == 0:
    raise RuntimeError("ZERO properties applied (%d failed) — check display names" % failed)
ok = unreal.EditorAssetLibrary.save_asset(${pyString(asset)}, only_if_is_dirty=False)
if not ok:
    raise RuntimeError("save_asset FAILED for %s" % ${pyString(asset)})
unreal.log("MCP SET_SUMMARY applied=%d failed=%d saved=True" % (applied, failed))
unreal.log("MCP OK unreal_set_asset_properties")
`;
    return execGenerated("unreal_set_asset_properties", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_spawn_actors", "Batch-spawn actors into a map and save. Each entry: source (a /Game static mesh or Blueprint " +
    "asset, or a /Script/Module.Class), label, location, optional rotation/scale/tags. " +
    "clearTag first deletes every actor carrying that tag (idempotent re-runs). " +
    "NOTE: headless commandlets have no physics scene — no ground traces; supply explicit Z.", {
    map: gamePathSchema,
    actors: z
        .array(z.object({
        source: z.string().min(1),
        label: z.string().min(1),
        location: z.object({ x: z.number(), y: z.number(), z: z.number() }),
        rotation: z.object({ pitch: z.number(), yaw: z.number(), roll: z.number() }).optional(),
        scale: z.number().positive().optional(),
        tags: z.array(z.string()).max(8).default([]),
    }))
        .min(1)
        .max(500),
    clearTag: z.string().optional(),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ map, actors, clearTag, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
        for (const a of actors) {
            if (!a.source.startsWith("/Game/") && !a.source.startsWith("/Script/")) {
                throw new Error(`source must be /Game/... or /Script/...: ${a.source}`);
            }
        }
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_spawn_actors", error: String(e) });
    }
    const body = `${PY_HEADER}
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
clear_tag = ${pyValue(clearTag ?? null)}
if clear_tag:
    removed = 0
    for a in list(sub.get_all_level_actors()):
        if clear_tag in [str(t) for t in a.tags]:
            sub.destroy_actor(a)
            removed += 1
    unreal.log("MCP SPAWN cleared %d actors tagged %s" % (removed, clear_tag))

def _spawn_source(src):
    if src.startswith("/Script/"):
        cls = unreal.load_class(None, src)
        if not cls:
            raise RuntimeError("class not found: %s" % src)
        return ("class", cls)
    a = unreal.load_asset(src)
    if not a:
        raise RuntimeError("asset not found: %s" % src)
    if isinstance(a, unreal.Blueprint):
        return ("class", a.generated_class())
    return ("object", a)

spawned = 0
for item in ${pyValue(actors)}:
    kind, src = _spawn_source(item["source"])
    loc = unreal.Vector(item["location"]["x"], item["location"]["y"], item["location"]["z"])
    rot = unreal.Rotator()
    r = item.get("rotation")
    if r:
        rot.pitch = r["pitch"]; rot.yaw = r["yaw"]; rot.roll = r["roll"]
    actor = (sub.spawn_actor_from_class(src, loc, rot) if kind == "class"
             else sub.spawn_actor_from_object(src, loc, rot))
    if not actor:
        raise RuntimeError("spawn failed for %s" % item["source"])
    actor.set_actor_label(item["label"])
    if item.get("tags"):
        actor.tags = item["tags"]
    s = item.get("scale")
    if s:
        actor.set_actor_scale3d(unreal.Vector(s, s, s))
    spawned += 1
unreal.log("MCP SPAWN placed %d actors" % spawned)
_save(world, ${pyString(map)})
unreal.log("MCP OK unreal_spawn_actors")
`;
    return execGenerated("unreal_spawn_actors", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_import_assets", "Batch-import files (FBX meshes, PNG/JPG textures, WAV) into /Game destinations via " +
    "AssetImportTask. textureType configures compression: 'normal' (TC_Normalmap, sRGB off), " +
    "'mask' (sRGB off), 'color' (default). Files must live inside the repo. " +
    "Big texture batches can exhaust headless memory — chunk them.", {
    files: z
        .array(z.object({
        file: z.string().min(1).describe("Repo-relative or absolute path inside the repo"),
        destination: gamePathSchema,
        name: z.string().optional(),
        textureType: z.enum(["color", "normal", "mask"]).optional(),
    }))
        .min(1)
        .max(40),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ files, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let resolved;
    try {
        resolved = files.map((f) => ({
            ...f,
            file: resolveInsideRoot(path.isAbsolute(f.file) ? path.relative(root, f.file) : f.file),
            destination: assertGamePath(f.destination, "destination"),
        }));
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_import_assets", error: String(e) });
    }
    const body = `${PY_HEADER}
at = unreal.AssetToolsHelpers.get_asset_tools()
eal = unreal.EditorAssetLibrary
imported = 0
for item in ${pyValue(resolved)}:
    t = unreal.AssetImportTask()
    t.filename = item["file"]
    t.destination_path = item["destination"]
    if item.get("name"):
        t.destination_name = item["name"]
    t.replace_existing = True
    t.automated = True
    t.save = True
    at.import_asset_tasks([t])
    paths = list(t.imported_object_paths or [])
    if not paths:
        raise RuntimeError("import produced nothing for %s" % item["file"])
    for p in paths:
        obj = unreal.load_asset(p)
        tt = item.get("textureType")
        if tt and isinstance(obj, unreal.Texture2D):
            if tt == "normal":
                obj.set_editor_property("compression_settings", unreal.TextureCompressionSettings.TC_NORMALMAP)
                obj.set_editor_property("srgb", False)
            elif tt == "mask":
                obj.set_editor_property("srgb", False)
            if not eal.save_asset(p, only_if_is_dirty=False):
                raise RuntimeError("save_asset FAILED after texture config for %s" % p)
        unreal.log("MCP IMPORTED %s" % p)
        imported += 1
unreal.log("MCP IMPORT_SUMMARY count=%d" % imported)
unreal.log("MCP OK unreal_import_assets")
`;
    return execGenerated("unreal_import_assets", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_create_material_instance", "Create (or update) a MaterialInstanceConstant from a parent material and set scalar/vector/" +
    "texture parameters, then save.", {
    parent: gamePathSchema,
    destination: gamePathSchema.describe("/Game folder to create in"),
    name: z.string().min(1),
    scalars: z.record(z.string(), z.number()).default({}),
    vectors: z.record(z.string(), z.array(z.number()).length(4)).default({}),
    textures: z.record(z.string(), z.string()).default({}),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ parent, destination, name, scalars, vectors, textures, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(parent, "parent");
        assertGamePath(destination, "destination");
        for (const t of Object.values(textures))
            assertGamePath(t, "texture");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_create_material_instance", error: String(e) });
    }
    const miPath = `${destination}/${name}`;
    const body = `${PY_HEADER}
eal = unreal.EditorAssetLibrary
mel = unreal.MaterialEditingLibrary
parent = unreal.load_asset(${pyString(parent)})
if not parent:
    raise RuntimeError("parent material missing: %s" % ${pyString(parent)})
mi_path = ${pyString(miPath)}
mi = unreal.load_asset(mi_path)
if not mi:
    at = unreal.AssetToolsHelpers.get_asset_tools()
    mi = at.create_asset(${pyString(name)}, ${pyString(destination)}, unreal.MaterialInstanceConstant,
                         unreal.MaterialInstanceConstantFactoryNew())
    if not mi:
        raise RuntimeError("create_asset failed for %s" % mi_path)
    unreal.log("MCP MI created %s" % mi_path)
mel.set_material_instance_parent(mi, parent)
# UE 5.7's MEL setters return False even on success — verify by READBACK,
# never by return value (engine-source-verified by the review panel).
applied = 0
for k, v in ${pyValue(scalars)}.items():
    mel.set_material_instance_scalar_parameter_value(mi, k, v)
    got = mel.get_material_instance_scalar_parameter_value(mi, k)
    if abs(got - v) < 1e-4:
        applied += 1
    else:
        unreal.log_warning("MCP MI_PARAM_FAIL scalar %s (readback %s != %s)" % (k, got, v))
for k, v in ${pyValue(vectors)}.items():
    want = unreal.LinearColor(v[0], v[1], v[2], v[3])
    mel.set_material_instance_vector_parameter_value(mi, k, want)
    got = mel.get_material_instance_vector_parameter_value(mi, k)
    if got and all(abs(a - b) < 1e-4 for a, b in ((got.r, want.r), (got.g, want.g), (got.b, want.b), (got.a, want.a))):
        applied += 1
    else:
        unreal.log_warning("MCP MI_PARAM_FAIL vector %s" % k)
for k, v in ${pyValue(textures)}.items():
    tex = unreal.load_asset(v)
    if not tex:
        unreal.log_warning("MCP MI_PARAM_FAIL texture %s: asset missing %s" % (k, v))
        continue
    mel.set_material_instance_texture_parameter_value(mi, k, tex)
    got = mel.get_material_instance_texture_parameter_value(mi, k)
    if got == tex:
        applied += 1
    else:
        unreal.log_warning("MCP MI_PARAM_FAIL texture %s -> %s" % (k, v))
if not eal.save_asset(mi_path, only_if_is_dirty=False):
    raise RuntimeError("save_asset FAILED for %s" % mi_path)
unreal.log("MCP MI_SUMMARY path=%s params_applied=%d" % (mi_path, applied))
unreal.log("MCP OK unreal_create_material_instance")
`;
    return execGenerated("unreal_create_material_instance", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_import_animation", "Import an animation-only FBX onto an EXISTING skeleton (the Trekker pipeline: no mesh, " +
    "exported-time length, no default sample rate). Post-tune the sequence with " +
    "unreal_set_asset_properties if needed.", {
    file: z.string().min(1),
    destination: gamePathSchema,
    skeleton: gamePathSchema.describe("Skeleton asset path, e.g. the Trekker *_Skeleton"),
    name: z.string().optional(),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ file, destination, skeleton, name, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let filePath;
    try {
        filePath = resolveInsideRoot(path.isAbsolute(file) ? path.relative(root, file) : file);
        assertGamePath(destination, "destination");
        assertGamePath(skeleton, "skeleton");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_import_animation", error: String(e) });
    }
    const body = `${PY_HEADER}
skel = unreal.load_asset(${pyString(skeleton)})
if not skel:
    raise RuntimeError("skeleton missing: %s" % ${pyString(skeleton)})
ui = unreal.FbxImportUI()
ui.set_editor_property("import_mesh", False)
ui.set_editor_property("import_animations", True)
ui.set_editor_property("import_as_skeletal", False)
ui.set_editor_property("skeleton", skel)
ui.set_editor_property("automated_import_should_detect_type", False)
ui.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_ANIMATION)
anim = ui.get_editor_property("anim_sequence_import_data")
anim.set_editor_property("animation_length", unreal.FBXAnimationLengthImportType.FBXALIT_EXPORTED_TIME)
anim.set_editor_property("use_default_sample_rate", False)
t = unreal.AssetImportTask()
t.filename = ${pyString(filePath)}
t.destination_path = ${pyString(destination)}
${name ? `t.destination_name = ${pyString(name)}` : ""}
t.replace_existing = True
t.automated = True
t.save = True
t.options = ui
unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([t])
paths = list(t.imported_object_paths or [])
if not paths:
    raise RuntimeError("animation import produced nothing for %s" % ${pyString(filePath)})
for p in paths:
    unreal.log("MCP ANIM_IMPORTED %s" % p)
unreal.log("MCP OK unreal_import_animation")
`;
    return execGenerated("unreal_import_animation", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
server.tool("unreal_snapshot_level", "Regenerate the level snapshot markdown (label, class, transform, tags for every actor) that " +
    "CLAUDE.md declares the authoritative source of level truth. Writes inside the repo.", {
    map: gamePathSchema,
    outFile: z.string().default(".claude/level-snapshot.md"),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ map, outFile, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let outPath;
    try {
        assertGamePath(map, "map");
        outPath = resolveInsideRoot(outFile);
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_snapshot_level", error: String(e) });
    }
    const body = `${PY_HEADER}
import datetime
world = _load(${pyString(map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
lines = ["# Level snapshot: %s" % ${pyString(map)},
         "", "Generated %s by ascent-unreal-mcp unreal_snapshot_level." % datetime.datetime.now().isoformat(timespec="seconds"),
         "", "| Label | Class | Location | Rotation | Scale | Tags |", "|---|---|---|---|---|---|"]
count = 0
for a in sub.get_all_level_actors():
    loc = a.get_actor_location(); rot = a.get_actor_rotation(); s = a.get_actor_scale3d()
    lines.append("| %s | %s | (%.0f, %.0f, %.0f) | (%.1f, %.1f, %.1f) | (%.2f, %.2f, %.2f) | %s |" % (
        a.get_actor_label(), a.get_class().get_name(),
        loc.x, loc.y, loc.z, rot.pitch, rot.yaw, rot.roll, s.x, s.y, s.z,
        " ".join(str(t) for t in a.tags) or "-"))
    count += 1
with open(${pyString(outPath)}, "w", encoding="utf-8") as fh:
    fh.write("\\n".join(lines) + "\\n")
unreal.log("MCP SNAPSHOT %d actors -> %s" % (count, ${pyString(outPath)}))
unreal.log("MCP OK unreal_snapshot_level")
`;
    return execGenerated("unreal_snapshot_level", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
export function evaluateExpectation(exp, value) {
    const num = typeof value === "number" ? value : Number.parseFloat(String(value));
    if (exp.equals !== undefined) {
        const pass = typeof exp.equals === "number" && Number.isFinite(num)
            ? Math.abs(num - exp.equals) < 1e-4
            : String(value).toLowerCase() === String(exp.equals).toLowerCase();
        return { pass, detail: `${exp.prop}: got ${JSON.stringify(value)}, expected == ${JSON.stringify(exp.equals)}` };
    }
    if (exp.contains !== undefined) {
        const pass = String(value).toLowerCase().includes(exp.contains.toLowerCase());
        return { pass, detail: `${exp.prop}: got ${JSON.stringify(value)}, expected to contain ${JSON.stringify(exp.contains)}` };
    }
    if (exp.min !== undefined || exp.max !== undefined) {
        const pass = Number.isFinite(num) && (exp.min === undefined || num >= exp.min) && (exp.max === undefined || num <= exp.max);
        return { pass, detail: `${exp.prop}: got ${JSON.stringify(value)}, expected in [${exp.min ?? "-inf"}, ${exp.max ?? "inf"}]` };
    }
    return { pass: false, detail: `${exp.prop}: expectation has no operator (equals/contains/min/max)` };
}
server.tool("ascent_apply_then_verify", "Run a repo script, then — in the SAME commandlet boot — probe an actor or asset and check " +
    "expectations against the read-back values. The whole call fails unless the script succeeds AND " +
    "every expectation passes. 'Probe before you believe', as infrastructure: a mutation that can't " +
    "prove itself didn't happen.", {
    script: z.string().describe("Repo-relative scripts/*.py to apply"),
    args: z.array(z.string()).max(8).default([]),
    verify: z.object({
        map: z.string().optional(),
        actorMatch: z.string().optional(),
        asset: z.string().optional(),
        classDefaults: z.boolean().default(false),
        props: z.array(z.string().min(1)).min(1).max(40),
    }),
    expect: z
        .array(z.object({
        prop: z.string().min(1),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        contains: z.string().optional(),
        min: z.number().optional(),
        max: z.number().optional(),
    }))
        .min(1)
        .max(40),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
}, async ({ script, args, verify, expect, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let scriptPath;
    try {
        scriptPath = resolveScript(script);
        if (verify.asset)
            assertGamePath(verify.asset, "verify.asset");
        if (verify.map)
            assertGamePath(verify.map, "verify.map");
        if (!verify.asset && !(verify.map && verify.actorMatch)) {
            throw new Error("verify needs either {asset} or {map, actorMatch}");
        }
    }
    catch (e) {
        return jsonResult(false, { tool: "ascent_apply_then_verify", error: String(e) });
    }
    const probePy = verify.asset
        ? `target, label = _asset_target(${pyString(verify.asset)}, ${pyValue(verify.classDefaults)})`
        : `world = _load(${pyString(verify.map)})
sub = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
needle = ${pyString(verify.actorMatch)}.lower()
target = None
for a in sub.get_all_level_actors():
    if needle in a.get_actor_label().lower() or needle in a.get_class().get_name().lower():
        target = a
        break
if not target:
    raise RuntimeError("verify: no actor matched %r" % ${pyString(verify.actorMatch)})
label = target.get_actor_label()`;
    const body = `${PY_HEADER}${PY_ASSET_TARGET}
import sys
_t = ${pyString(scriptPath)}
sys.argv = [_t] + ${pyValue(args)}
_code = compile(open(_t, encoding="utf-8").read(), _t, "exec")
exec(_code, {"__name__": "__main__", "__file__": _t})
unreal.log("MCP APPLIED %s" % _t)
${probePy}
out = {"target": str(label), "props": {}}
for p in ${pyValue(verify.props)}:
    try:
        out["props"][p] = _obj(target.get_editor_property(p))
    except Exception as e:
        out["props"][p] = "<unreadable: %s>" % str(e)[:60]
unreal.log("MCP VERIFY_JSON " + json.dumps(out, default=str))
unreal.log("MCP OK ascent_apply_then_verify")
`;
    const raw = await execGenerated("ascent_apply_then_verify", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
    if (dryRun)
        return raw;
    const parsed = JSON.parse(raw.content[0].text);
    const verifyLine = (parsed.output ?? []).find((l) => l.includes("MCP VERIFY_JSON "));
    let checks = [];
    if (verifyLine) {
        try {
            const data = JSON.parse(verifyLine.slice(verifyLine.indexOf("MCP VERIFY_JSON ") + "MCP VERIFY_JSON ".length));
            checks = expect.map((e) => evaluateExpectation(e, data.props[e.prop]));
        }
        catch (e) {
            checks = [{ pass: false, detail: `could not parse VERIFY_JSON: ${e}` }];
        }
    }
    else {
        checks = [{ pass: false, detail: "no VERIFY_JSON line in output" }];
    }
    const allPass = checks.every((c) => c.pass);
    return jsonResult(parsed.ok && allPass, {
        ...parsed,
        tool: "ascent_apply_then_verify",
        ok: undefined,
        verification: { allPass, checks },
    });
});
// ── the eyes: rendered screenshots ───────────────────────────────
const CAPTURE_PS1 = String.raw `param([string]$OutFile, [string]$ConsoleCmds = "", [int]$GamePid = 0)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System;using System.Runtime.InteropServices;public class WMcp {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}'
# Target STRICTLY by PID: with an editor open, process name + window title
# cannot distinguish the -game instance from the editor.
if ($GamePid -le 0) { Write-Output "MCPSHOT NOPID"; exit 1 }
$p = Get-Process -Id $GamePid -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "MCPSHOT NOWINDOW"; exit 1 }
$p.Refresh()
if ($p.MainWindowHandle -eq [IntPtr]::Zero) { Write-Output "MCPSHOT NOWINDOW"; exit 1 }
[WMcp]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600
# NEVER send keys unless the game truly holds focus — otherwise console
# commands get typed into whatever app the user is using.
[uint]$fgpid = 0
[WMcp]::GetWindowThreadProcessId([WMcp]::GetForegroundWindow(), [ref]$fgpid) | Out-Null
if ($fgpid -ne [uint]$p.Id) { Write-Output "MCPSHOT NOFOCUS fg=$fgpid want=$($p.Id)"; exit 1 }
if ($ConsoleCmds -ne "") {
  $tick = [string][char]0x60
  foreach ($cmd in $ConsoleCmds -split ";;") {
    [System.Windows.Forms.SendKeys]::SendWait($tick)
    Start-Sleep -Milliseconds 350
    $esc = $cmd -replace '([+^%~(){}\[\]])','{$1}'
    [System.Windows.Forms.SendKeys]::SendWait($esc)
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 900
  }
}
Start-Sleep -Milliseconds 800
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "MCPSHOT SAVED $OutFile"`;
server.tool("unreal_screenshot", "THE EYES: launch a -game instance of a map, wait for it to settle, teleport through vantages " +
    "(BugItGo) and/or run console commands, screen-capture each, kill the game, return PNG paths. " +
    "This is the pattern every visual verification this project ever did was built on. " +
    "Windows-only; steals foreground focus while capturing. Serialized with all other runs.", {
    map: gamePathSchema,
    vantages: z
        .array(z.object({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "vantage name: letters/digits/_/- only"),
        bugItGo: z
            .object({ x: z.number(), y: z.number(), z: z.number(), pitch: z.number().default(0), yaw: z.number().default(0) })
            .optional(),
        console: z.array(z.string().max(120)).max(6).default([]),
    }))
        .min(1)
        .max(8)
        .default([{ name: "default", console: [] }]),
    settleSeconds: z.number().int().min(5).max(180).default(25),
    resX: z.number().int().min(640).max(3840).default(1600),
    resY: z.number().int().min(480).max(2160).default(900),
    timeoutSeconds: z.number().int().min(60).max(900).default(300),
    dryRun: dryRunSchema,
}, async ({ map, vantages, settleSeconds, resX, resY, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
    }
    catch (e) {
        return jsonResult(false, { tool: "unreal_screenshot", error: String(e) });
    }
    const gameArgs = [uproject, map, "-game", "-windowed", `-ResX=${resX}`, `-ResY=${resY}`, "-log", "LOG=mcp_screenshot.log"];
    if (dryRun) {
        return jsonResult(true, { tool: "unreal_screenshot", dryRun: true, command: editorExe, args: gameArgs, vantages: vantages.map((v) => v.name) });
    }
    if (!existsSync(editorExe))
        return jsonResult(false, { tool: "unreal_screenshot", error: `editor exe not found: ${editorExe}` });
    const shotsDir = path.join(generatedDir, "shots");
    mkdirSync(shotsDir, { recursive: true });
    const ps1 = path.join(generatedDir, "mcp_capture.ps1");
    await fsp.writeFile(ps1, CAPTURE_PS1, "utf8");
    return withLock(async () => {
        const editorUp = await editorRunning();
        const game = spawn(editorExe, gameArgs, { cwd: root, windowsHide: false, detached: false });
        let spawnError;
        game.on("error", (e) => {
            // An unlistened ChildProcess 'error' is an uncaught exception that
            // would take the whole MCP server down.
            spawnError = String(e);
        });
        const gamePid = game.pid;
        const killGame = () => gamePid && killTree(gamePid);
        const deadline = Date.now() + timeoutSeconds * 1000;
        const hardTimer = setTimeout(killGame, timeoutSeconds * 1000);
        const shots = [];
        let timedOut = false;
        try {
            const settleMs = Math.min(settleSeconds * 1000, Math.max(0, deadline - Date.now() - 15_000));
            await new Promise((r) => setTimeout(r, settleMs));
            if (spawnError || !gamePid) {
                return jsonResult(false, { tool: "unreal_screenshot", error: `game failed to launch: ${spawnError ?? "no pid"}` });
            }
            for (const v of vantages) {
                if (Date.now() > deadline - 5_000) {
                    timedOut = true;
                    break;
                }
                const cmds = [];
                if (v.bugItGo)
                    cmds.push(`BugItGo ${v.bugItGo.x} ${v.bugItGo.y} ${v.bugItGo.z} ${v.bugItGo.pitch} ${v.bugItGo.yaw} 0`);
                cmds.push(...v.console);
                const file = path.join(shotsDir, `${v.name}-${Date.now()}.png`);
                const cap = await runProcess("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-OutFile", file, "-ConsoleCmds", cmds.join(";;"), "-GamePid", String(gamePid)], 60_000);
                const detail = cap.stdout.match(/MCPSHOT \w+[^\r\n]*/)?.[0];
                shots.push({ name: v.name, file, ok: cap.stdout.includes("MCPSHOT SAVED") && existsSync(file), detail });
            }
        }
        finally {
            clearTimeout(hardTimer);
            killGame();
        }
        const ok = !timedOut && shots.length > 0 && shots.every((s) => s.ok);
        return jsonResult(ok, {
            tool: "unreal_screenshot",
            map,
            timedOut,
            editorRunning: editorUp,
            shots,
            note: ok
                ? undefined
                : "capture(s) failed or timed out — NOFOCUS means the game never held foreground (user active elsewhere?)",
        });
    });
});
// ── weather/sky director: per-phase stills ───────────────────────
server.tool("weather_capture_phase_stills", "One-call arc verification: set a TOD profile's driver to a fast FixedTimer, launch the map in " +
    "-game, detect the run start from the log, capture a screenshot as each PHASE becomes active " +
    "(named by phase), kill the game, and restore the original driver. Needs the machine idle-ish: " +
    "captures are focus-verified and report NOFOCUS if you're typing elsewhere.", {
    map: gamePathSchema,
    profile: gamePathSchema.describe("The UAscensoTimeOfDayProfile asset driving this map"),
    fixedTimerSeconds: z.number().int().min(60).max(600).default(180),
    resX: z.number().int().min(640).max(3840).default(1600),
    resY: z.number().int().min(480).max(2160).default(900),
    timeoutSeconds: z.number().int().min(120).max(900).default(600),
    dryRun: dryRunSchema,
}, async ({ map, profile, fixedTimerSeconds, resX, resY, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(map, "map");
        assertGamePath(profile, "profile");
    }
    catch (e) {
        return jsonResult(false, { tool: "weather_capture_phase_stills", error: String(e) });
    }
    if (dryRun) {
        return jsonResult(true, {
            tool: "weather_capture_phase_stills",
            dryRun: true,
            plan: [
                `1. commandlet: read ${profile} phases, save original driver, set FixedTimer ${fixedTimerSeconds}s`,
                `2. launch ${map} -game, watch log for run start, capture each phase +2s`,
                `3. kill game, commandlet: restore original driver`,
            ],
        });
    }
    // Phase A: read phases + flip driver (records the original for restore).
    const flipBody = `${PY_HEADER}
tod = unreal.load_asset(${pyString(profile)})
if not tod:
    raise RuntimeError("profile missing: %s" % ${pyString(profile)})
orig_driver = str(tod.get_editor_property("driver"))
orig_secs = float(tod.get_editor_property("fixed_timer_seconds"))
phases = [{"name": str(p.get_editor_property("name")), "start": float(p.get_editor_property("start_at01"))}
          for p in tod.get_editor_property("phases")]
if not phases:
    raise RuntimeError("profile has no phases")
tod.set_editor_property("driver", unreal.AscensoTODDriver.FIXED_TIMER)
tod.set_editor_property("fixed_timer_seconds", float(${pyValue(fixedTimerSeconds)}))
if not unreal.EditorAssetLibrary.save_asset(${pyString(profile)}, only_if_is_dirty=False):
    raise RuntimeError("save_asset failed for profile")
unreal.log("MCP PHASES_JSON " + json.dumps({"orig_driver": orig_driver, "orig_secs": orig_secs, "phases": phases}))
unreal.log("MCP OK weather_flip")
`;
    const flip = await execGenerated("weather_flip", flipBody, {
        timeoutSeconds: 300,
        dryRun: false,
        allowWithEditorOpen: false,
        expectMarker: "MCP OK weather_flip",
    });
    const flipParsed = JSON.parse(flip.content[0].text);
    if (!flipParsed.ok)
        return jsonResult(false, { tool: "weather_capture_phase_stills", stage: "flip-driver", inner: flipParsed });
    const phasesLine = (flipParsed.output ?? []).find((l) => l.includes("MCP PHASES_JSON "));
    const meta = JSON.parse(phasesLine.slice(phasesLine.indexOf("MCP PHASES_JSON ") + "MCP PHASES_JSON ".length));
    const restoreDriver = async () => {
        const isFixed = meta.orig_driver.includes("FIXED_TIMER");
        const restoreBody = `${PY_HEADER}
tod = unreal.load_asset(${pyString(profile)})
tod.set_editor_property("driver", unreal.AscensoTODDriver.FIXED_TIMER if ${pyValue(isFixed)} else unreal.AscensoTODDriver.SONG_PROGRESS)
tod.set_editor_property("fixed_timer_seconds", float(${pyValue(meta.orig_secs)}))
if not unreal.EditorAssetLibrary.save_asset(${pyString(profile)}, only_if_is_dirty=False):
    raise RuntimeError("restore save failed")
unreal.log("MCP OK weather_restore")
`;
        return execGenerated("weather_restore", restoreBody, {
            timeoutSeconds: 300,
            dryRun: false,
            allowWithEditorOpen: false,
            expectMarker: "MCP OK weather_restore",
        });
    };
    // Phase B: game + per-phase captures, anchored on the log's first phase transition.
    const shotsDir = path.join(generatedDir, "shots");
    mkdirSync(shotsDir, { recursive: true });
    const ps1 = path.join(generatedDir, "mcp_capture.ps1");
    await fsp.writeFile(ps1, CAPTURE_PS1, "utf8");
    const logName = "mcp_phase_stills.log";
    const logPath = path.join(root, "Ascent", "Saved", "Logs", logName);
    const gameArgs = [uproject, map, "-game", "-windowed", `-ResX=${resX}`, `-ResY=${resY}`, "-log", `LOG=${logName}`];
    const result = await withLock(async () => {
        try {
            await fsp.unlink(logPath);
        }
        catch {
            /* no stale log */
        }
        const game = spawn(editorExe, gameArgs, { cwd: root, windowsHide: false });
        let spawnError;
        game.on("error", (e) => (spawnError = String(e)));
        const gamePid = game.pid;
        const killGame = () => gamePid && killTree(gamePid);
        const deadline = Date.now() + timeoutSeconds * 1000;
        const shots = [];
        try {
            // Anchor: the controller logs "PHASE TRANSITION: [-1] -> [0]" at run start.
            let t0;
            while (!t0 && Date.now() < deadline - 30_000) {
                await new Promise((r) => setTimeout(r, 1000));
                if (spawnError)
                    return jsonResult(false, { tool: "weather_capture_phase_stills", error: `game launch failed: ${spawnError}` });
                try {
                    const log = await fsp.readFile(logPath, "utf8");
                    if (/PHASE TRANSITION: \[-1\]/.test(log))
                        t0 = Date.now();
                }
                catch {
                    /* log not written yet */
                }
            }
            if (!t0)
                return jsonResult(false, { tool: "weather_capture_phase_stills", error: "run start never appeared in the log" });
            for (const ph of meta.phases) {
                const due = t0 + (ph.start * fixedTimerSeconds + 2) * 1000;
                if (due > deadline - 10_000) {
                    shots.push({ phase: ph.name, ok: false, detail: "skipped: would exceed timeout" });
                    continue;
                }
                const wait = due - Date.now();
                if (wait < -3000) {
                    shots.push({ phase: ph.name, ok: false, detail: "missed: phase elapsed before capture was possible" });
                    continue;
                }
                if (wait > 0)
                    await new Promise((r) => setTimeout(r, wait));
                const file = path.join(shotsDir, `phase-${ph.name.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.png`);
                const cap = await runProcess("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-OutFile", file, "-ConsoleCmds", "", "-GamePid", String(gamePid)], 45_000);
                shots.push({
                    phase: ph.name,
                    file,
                    ok: cap.stdout.includes("MCPSHOT SAVED") && existsSync(file),
                    detail: cap.stdout.match(/MCPSHOT \w+[^\r\n]*/)?.[0],
                });
            }
        }
        finally {
            killGame();
        }
        const captured = shots.filter((s) => s.ok).length;
        return jsonResult(captured > 0, {
            tool: "weather_capture_phase_stills",
            profile,
            fixedTimerSeconds,
            captured,
            total: meta.phases.length,
            shots,
        });
    });
    // Phase C: always restore, and surface a restore failure loudly.
    const restore = await restoreDriver();
    const restoreParsed = JSON.parse(restore.content[0].text);
    const resultParsed = JSON.parse(result.content[0].text);
    if (!restoreParsed.ok) {
        return jsonResult(false, {
            ...resultParsed,
            ok: undefined,
            error: `DRIVER NOT RESTORED to ${meta.orig_driver} — fix with unreal_set_asset_properties before shipping`,
        });
    }
    return jsonResult(resultParsed.ok, { ...resultParsed, ok: undefined, driverRestored: meta.orig_driver });
});
// ── animation manager: asset-level audit ─────────────────────────
server.tool("anim_audit_assets", "READ-ONLY animation audit for a skeleton: every AnimSequence (play length, rate scale, additive), " +
    "BlendSpace (sample positions + which sequence at which speed), Montage, and AnimBlueprint under " +
    "a search path, plus which assets the AnimBP actually references (orphan detection via the asset " +
    "registry). The state-machine GRAPH itself is Blueprint territory — audit that via the live " +
    "UnrealClaude plugin, not headless.", {
    skeleton: gamePathSchema,
    searchPath: gamePathSchema.default("/Game"),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
}, async ({ skeleton, searchPath, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
        assertGamePath(skeleton, "skeleton");
        assertGamePath(searchPath, "searchPath");
    }
    catch (e) {
        return jsonResult(false, { tool: "anim_audit_assets", error: String(e) });
    }
    const body = `${PY_HEADER}
reg = unreal.AssetRegistryHelpers.get_asset_registry()
skel_path = ${pyString(skeleton)}
skel = unreal.load_asset(skel_path)
if not skel:
    raise RuntimeError("skeleton missing: %s" % skel_path)
f = unreal.ARFilter(package_paths=[${pyString(searchPath)}], recursive_paths=True)
seqs, blends, montages, abps = [], [], [], []
for ad in reg.get_assets(f):
    cls = str(ad.asset_class_path.asset_name)
    if cls not in ("AnimSequence", "BlendSpace", "BlendSpace1D", "AnimMontage", "AnimBlueprint"):
        continue
    obj = unreal.load_asset(str(ad.package_name))
    if not obj:
        continue
    try:
        obj_skel = obj.get_editor_property("target_skeleton") if cls == "AnimBlueprint" else obj.get_editor_property("skeleton")
    except Exception:
        obj_skel = None
    if obj_skel != skel:
        continue
    p = str(ad.package_name)
    if cls == "AnimSequence":
        entry = {"path": p}
        try:
            entry["length"] = round(obj.get_play_length(), 3)
        except Exception:
            pass
        try:
            entry["rate_scale"] = float(obj.get_editor_property("rate_scale"))
            entry["additive"] = str(obj.get_editor_property("additive_anim_type"))
        except Exception:
            pass
        seqs.append(entry)
    elif cls in ("BlendSpace", "BlendSpace1D"):
        entry = {"path": p, "samples": []}
        try:
            for s in obj.get_editor_property("sample_data"):
                anim = s.get_editor_property("animation")
                val = s.get_editor_property("sample_value")
                entry["samples"].append({"anim": anim.get_name() if anim else None,
                                          "at": [round(val.x, 1), round(val.y, 1)]})
        except Exception as e:
            entry["samples"] = "<unreadable: %s>" % str(e)[:50]
        blends.append(entry)
    elif cls == "AnimMontage":
        montages.append({"path": p})
    elif cls == "AnimBlueprint":
        deps = reg.get_dependencies(unreal.Name(p.rsplit("/", 1)[0] + "/" + p.rsplit("/", 1)[-1]),
                                    unreal.AssetRegistryDependencyOptions()) or []
        abps.append({"path": p, "refs": sorted(str(d) for d in deps if str(d).startswith("/Game/"))})
abp_refs = set()
for b in abps:
    abp_refs.update(b["refs"])
orphans = [s["path"] for s in seqs if s["path"] not in abp_refs]
out = {"skeleton": skel_path, "sequences": seqs, "blendspaces": blends,
       "montages": montages, "animBlueprints": abps, "sequencesNotReferencedByAnyABP": orphans}
unreal.log("MCP ANIM_JSON " + json.dumps(out, default=str))
unreal.log("MCP ANIM_COUNTS seq=%d blend=%d montage=%d abp=%d orphans=%d"
           % (len(seqs), len(blends), len(montages), len(abps), len(orphans)))
unreal.log("MCP OK anim_audit_assets")
`;
    return execGenerated("anim_audit_assets", body, { timeoutSeconds, dryRun, allowWithEditorOpen });
});
// ── startup ──────────────────────────────────────────────────────
async function main() {
    pruneGenerated();
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
function isInvokedDirectly() {
    const entry = process.argv[1];
    if (!entry)
        return false;
    const candidates = [path.resolve(entry)];
    try {
        candidates.push(realpathSync(entry)); // bin shims/symlinks/junctions
    }
    catch {
        /* keep resolve-only */
    }
    return candidates.some((c) => pathToFileURL(c).href === import.meta.url);
}
if (isInvokedDirectly()) {
    await main();
}

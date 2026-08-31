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
export const VERSION = "2.0.0";
const root = path.resolve(process.env.ASCENT_ROOT ?? path.join(process.cwd(), "..", ".."));
const uproject = path.resolve(process.env.ASCENT_UPROJECT ?? path.join(root, "Ascent", "Ascent.uproject"));
const editorCmd = path.resolve(
  process.env.UNREAL_EDITOR_CMD ??
    "C:\\Program Files\\Epic Games\\UE_5.7\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe",
);
const generatedDir = path.join(root, "scripts", "generated", "mcp");

// ── small helpers (exported for unit tests) ──────────────────────
const normCase = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

export function resolveInsideRoot(rel: string, base: string = root): string {
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !normCase(resolved).startsWith(normCase(base + path.sep))) {
    throw new Error(`path escapes the project root: ${rel}`);
  }
  return resolved;
}

export function resolveScript(rel: string): string {
  const scriptsDir = path.join(root, "scripts");
  const resolved = resolveInsideRoot(rel);
  if (!normCase(resolved).startsWith(normCase(scriptsDir + path.sep))) {
    throw new Error(`scripts must live under scripts/: ${rel}`);
  }
  if (!resolved.endsWith(".py")) throw new Error(`not a .py script: ${rel}`);
  if (!existsSync(resolved)) throw new Error(`script not found: ${resolved}`);
  return resolved;
}

export function assertGamePath(p: string, label: string): string {
  if (!p.startsWith("/Game/") || p.includes("..") || p.includes("\\")) {
    throw new Error(`${label} must be a clean /Game/... path, got: ${p}`);
  }
  return p;
}

export const pyString = (s: string): string => JSON.stringify(s);

/** Serialize a JS value as a PYTHON literal. JSON.stringify alone emits
 *  `true`/`false`/`null`, which are NameErrors in python — the bug that made
 *  uds_apply_preset dead on arrival in v1. */
export function pyValue(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(pyValue).join(", ") + "]";
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${JSON.stringify(k)}: ${pyValue(val)}`)
        .join(", ") +
      "}"
    );
  }
  return "None";
}

/** Keep the model-facing output small: marker-matching lines (capped) plus a
 *  short tail. A raw commandlet log is tens of MB and would flood context. */
export function filterOutput(
  text: string,
  pattern: string,
  maxLines = 200,
  tailChars = 1500,
): { matched: string[]; truncatedMatches: number; tail: string } {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = /MCP |LogPython/;
  }
  const lines = text.split(/\r?\n/);
  const matched: string[] = [];
  let truncated = 0;
  for (const line of lines) {
    if (re.test(line)) {
      if (matched.length < maxLines) matched.push(line.replace(/^\[[^\]]*\]\[[ 0-9]*\]/, "").trim());
      else truncated++;
    }
  }
  return { matched, truncatedMatches: truncated, tail: text.slice(-tailChars) };
}

// ── process plumbing ─────────────────────────────────────────────
type RunResult = {
  code: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

const MAX_CAPTURE = 8 * 1024 * 1024; // rolling cap per stream

function killTree(pid: number): void {
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => undefined);
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
    }, timeoutMs);
    const cap = (cur: string, chunk: string) => {
      const next = cur + chunk;
      return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
    };
    child.stdout?.on("data", (d: Buffer) => (stdout = cap(stdout, d.toString("utf8"))));
    child.stderr?.on("data", (d: Buffer) => (stderr = cap(stderr, d.toString("utf8"))));
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

export async function editorRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq UnrealEditor.exe", "/FO", "CSV", "/NH"], (err, out) => {
      resolve(!err && /UnrealEditor\.exe/i.test(out ?? ""));
    });
  });
}

// One commandlet at a time. Two UnrealEditor-Cmd instances race the project
// lock, the DDC, and each other's saves.
let runChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = runChain.then(fn, fn);
  runChain = next.catch(() => undefined);
  return next;
}

// ── generated-script lifecycle ───────────────────────────────────
function pruneGenerated(keep = 100): void {
  try {
    const files = readdirSync(generatedDir)
      .filter((f) => f.endsWith(".py"))
      .map((f) => ({ f, m: statSync(path.join(generatedDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(keep)) unlinkSync(path.join(generatedDir, f));
  } catch {
    /* best-effort */
  }
}

let scriptSeq = 0;
async function writeGeneratedScript(name: string, body: string): Promise<string> {
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
export function computeOk(i: { code: number | null; timedOut: boolean; markerOk: boolean; pySuccess: boolean }): boolean {
  return !i.timedOut && i.markerOk && (i.code === 0 || i.pySuccess);
}

type ExecOpts = {
  timeoutSeconds: number;
  dryRun: boolean;
  outputFilter?: string;
  allowWithEditorOpen?: boolean;
  scriptArgs?: string[];
  /** generated scripts end with `unreal.log("MCP OK <tool>")`; require it */
  expectMarker?: string;
};

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function jsonResult(ok: boolean, payload: Record<string, unknown>): TextResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok, ...payload }, null, 2) }],
    ...(ok ? {} : { isError: true as const }),
  };
}

async function execCommandlet(tool: string, scriptPath: string, opts: ExecOpts): Promise<TextResult> {
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
  if (!existsSync(uproject)) return jsonResult(false, { tool, error: `uproject not found: ${uproject}` });
  if (!existsSync(editorCmd)) return jsonResult(false, { tool, error: `editor cmd not found: ${editorCmd}` });

  if (opts.dryRun) {
    const editorUp = await editorRunning();
    return jsonResult(true, { tool, dryRun: true, command: editorCmd, args, editorRunning: editorUp });
  }

  // Editor check happens INSIDE the lock (TOCTOU: an editor can open while a
  // prior run holds the mutex) and the refusal decision uses that sample.
  const run = await withLock(async () => {
    const editorUp = await editorRunning();
    if (editorUp && !opts.allowWithEditorOpen) {
      return { refusedEditorOpen: true as const, editorUp };
    }
    const r = await runProcess(editorCmd, args, opts.timeoutSeconds * 1000);
    return { ...r, editorUp };
  });
  if ("refusedEditorOpen" in run) {
    return jsonResult(false, {
      tool,
      error:
        "An Unreal editor is running: commandlet SAVES lose to its file locks and can silently not persist. " +
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
    warning:
      run.editorUp && opts.allowWithEditorOpen
        ? "editor was open during this run — saves may not have persisted (verify with unreal_probe_actor)"
        : undefined,
    markerFound: opts.expectMarker ? markerOk : undefined,
    output: out.matched,
    truncatedMatches: out.truncatedMatches,
    tail: ok ? undefined : out.tail, // only ship the raw tail when something went wrong
  });
}

async function execGenerated(tool: string, pyBody: string, opts: ExecOpts): Promise<TextResult> {
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

server.tool(
  "unreal_run_python_script",
  "Run an existing python script from the repo scripts/ folder through a headless commandlet. " +
    "Optional args reach the script via sys.argv (no whitespace in an arg). Output is filtered to " +
    "marker lines (default: 'MCP |LogPython') — have your script unreal.log() what matters.",
  {
    script: z.string().describe("Repo-relative path under scripts/, e.g. scripts/render_enables.py"),
    args: z.array(z.string()).max(8).default([]),
    outputFilter: z.string().optional().describe("Regex for which log lines to return"),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
  },
  async ({ script, args, outputFilter, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    let scriptPath: string;
    try {
      scriptPath = resolveScript(script);
    } catch (e) {
      return jsonResult(false, { tool: "unreal_run_python_script", error: String(e) });
    }
    return execCommandlet("unreal_run_python_script", scriptPath, {
      timeoutSeconds,
      dryRun,
      outputFilter,
      allowWithEditorOpen,
      scriptArgs: args,
    });
  },
);

server.tool(
  "unreal_probe_actor",
  "READ-ONLY: load a map and read actor properties by their editor display names " +
    "(e.g. 'Use Auroras', 'Ultra Dynamic Weather'). Matches actors whose label OR class contains " +
    "actorMatch (case-insensitive). This is the tool shape that found the dead aurora switch and " +
    "the null sky->weather reference — read back the ACTUAL state instead of trusting push logs.",
  {
    map: z.string().describe("/Game/... map path"),
    actorMatch: z.string().min(1).describe("Substring of actor label or class"),
    props: z.array(z.string().min(1)).min(1).max(40),
    maxActors: z.number().int().min(1).max(20).default(5),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
  },
  async ({ map, actorMatch, props, maxActors, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(map, "map");
    } catch (e) {
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
  },
);

server.tool(
  "unreal_set_actor_properties",
  "Set editor-display-name properties on matching actors in a map, then SAVE the map. " +
    "Values are converted to python literals safely (booleans included). Mutating: refuses while an " +
    "editor is open unless allowWithEditorOpen.",
  {
    map: z.string(),
    actorMatch: z.string().min(1),
    properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    maxActors: z.number().int().min(1).max(10).default(1),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
  },
  async ({ map, actorMatch, properties, maxActors, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(map, "map");
    } catch (e) {
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
  },
);

server.tool(
  "unreal_duplicate_map",
  "Duplicate a /Game/... map asset. Mutating: refuses while an editor is open unless allowWithEditorOpen.",
  {
    sourceMap: z.string(),
    targetMap: z.string(),
    overwrite: z.boolean().default(false),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
  },
  async ({ sourceMap, targetMap, overwrite, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(sourceMap, "sourceMap");
      assertGamePath(targetMap, "targetMap");
    } catch (e) {
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
  },
);

server.tool(
  "unreal_apply_material_to_actor",
  "Assign a material to a slot on a named actor's static mesh component in one map, then save. " +
    "Mutating: refuses while an editor is open unless allowWithEditorOpen.",
  {
    map: z.string(),
    actorLabel: z.string().min(1),
    material: z.string(),
    slot: z.number().int().min(0).default(0),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
  },
  async ({ map, actorLabel, material, slot, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(map, "map");
      assertGamePath(material, "material");
    } catch (e) {
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
  },
);

server.tool(
  "uds_inspect_level",
  "READ-ONLY: report the sky (UDS) and weather (UDW) actors in a map with the fields that have " +
    "actually burned us: aurora/space master switches, the sky->UDW reference, snow/rain state, " +
    "manual-override pins, time of day. Returns one MCP INSPECT_JSON line.",
  {
    map: z.string(),
    allowWithEditorOpen: z.boolean().default(true),
    timeoutSeconds: timeoutSchema,
    dryRun: z.boolean().default(false),
  },
  async ({ map, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(map, "map");
    } catch (e) {
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
  },
);

// Editor-time lookdev presets. NOTE: at runtime the TimeOfDayController's
// phase system re-pushes sky values every 0.2s — ship-facing values belong in
// the DA_TOD_* profiles, not here. These are for eyeballing a look in-editor.
const UDS_PRESETS: Record<string, Record<string, number | boolean>> = {
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

server.tool(
  "uds_apply_preset",
  "Apply a named editor-time UDS lookdev preset to the sky actor and save the map. " +
    "WARNING: runtime phase profiles (DA_TOD_*) override these every tick in-game — this is for " +
    "in-editor look checks only. Mutating: refuses while an editor is open unless allowWithEditorOpen.",
  {
    map: z.string(),
    preset: z.enum(["clear_vista", "dawn_alpenglow", "storm_check", "night_arc"]),
    actorLabel: z.string().default("BP_AscentSky"),
    allowWithEditorOpen: z.boolean().default(false),
    timeoutSeconds: timeoutSchema,
    dryRun: dryRunSchema,
  },
  async ({ map, preset, actorLabel, allowWithEditorOpen, timeoutSeconds, dryRun }) => {
    try {
      assertGamePath(map, "map");
    } catch (e) {
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
  },
);

server.tool(
  "ascent_unreal_status",
  "Server/environment status: paths, whether an Unreal editor is currently running (file-lock risk " +
    "for mutating tools), and generated-script housekeeping.",
  {},
  async () => {
    const editorUp = await editorRunning();
    let generatedCount = 0;
    try {
      generatedCount = readdirSync(generatedDir).filter((f) => f.endsWith(".py")).length;
    } catch {
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
  },
);

// ── startup ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  pruneGenerated();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function isInvokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const candidates = [path.resolve(entry)];
  try {
    candidates.push(realpathSync(entry)); // bin shims/symlinks/junctions
  } catch {
    /* keep resolve-only */
  }
  return candidates.some((c) => pathToFileURL(c).href === import.meta.url);
}
if (isInvokedDirectly()) {
  await main();
}

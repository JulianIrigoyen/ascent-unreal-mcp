/** Smoke test: boot the server over real MCP stdio, list tools, exercise the
 *  status tool and a dry-run — no Unreal required. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(here, "index.js");
const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);
const fail = (msg) => {
    console.error("SMOKE FAIL:", msg);
    process.exit(1);
};
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
const expected = [
    "anim_audit_assets",
    "ascent_apply_then_verify",
    "ascent_unreal_status",
    "weather_capture_phase_stills",
    "uds_apply_preset",
    "uds_inspect_level",
    "unreal_apply_material_to_actor",
    "unreal_asset_probe",
    "unreal_create_material_instance",
    "unreal_duplicate_map",
    "unreal_import_animation",
    "unreal_import_assets",
    "unreal_list_assets",
    "unreal_probe_actor",
    "unreal_run_python_script",
    "unreal_screenshot",
    "unreal_set_actor_properties",
    "unreal_set_asset_properties",
    "unreal_snapshot_level",
    "unreal_spawn_actors",
].sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`tool list mismatch: ${names.join(", ")}`);
}
const text = (r) => {
    const c = r.content ?? [];
    return c.find((x) => x.type === "text")?.text ?? "";
};
const status = JSON.parse(text(await client.callTool({ name: "ascent_unreal_status", arguments: {} })));
if (!status.ok || typeof status.editorRunning !== "boolean")
    fail("status shape wrong");
const dry = JSON.parse(text(await client.callTool({
    name: "unreal_probe_actor",
    arguments: { map: "/Game/Maps/LaninTrue", actorMatch: "Sky", props: ["Use Auroras"], dryRun: true },
})));
if (!dry.ok || dry.dryRun !== true || !Array.isArray(dry.args))
    fail("dry-run shape wrong");
if (!dry.args.some((a) => a.includes("-Unattended")))
    fail("commandlet flags missing");
// The safety default: a mutating tool called WITHOUT dryRun must dry-run.
const mutDefault = JSON.parse(text(await client.callTool({
    name: "unreal_duplicate_map",
    arguments: { sourceMap: "/Game/Maps/LaninTrue", targetMap: "/Game/Maps/SmokeTest_Never" },
})));
if (mutDefault.dryRun !== true)
    fail("mutating tool did not default to dryRun:true");
const escape = JSON.parse(text(await client.callTool({
    name: "unreal_run_python_script",
    arguments: { script: "../outside.py", dryRun: true },
})));
if (escape.ok !== false)
    fail("path escape was not rejected");
// v2.1 additions: screenshot dry-run shape + spawn source validation.
const shotDry = JSON.parse(text(await client.callTool({
    name: "unreal_screenshot",
    arguments: { map: "/Game/Maps/LaninTrue", dryRun: true },
})));
if (!shotDry.ok || shotDry.dryRun !== true || !Array.isArray(shotDry.args))
    fail("screenshot dry-run shape wrong");
const badSpawn = JSON.parse(text(await client.callTool({
    name: "unreal_spawn_actors",
    arguments: {
        map: "/Game/Maps/LaninTrue",
        actors: [{ source: "C:/evil.exe", label: "x", location: { x: 0, y: 0, z: 0 } }],
        dryRun: true,
    },
})));
if (badSpawn.ok !== false)
    fail("spawn source validation missing");
console.log(JSON.stringify({ ok: true, tools: names.length, editorRunning: status.editorRunning }));
await client.close();

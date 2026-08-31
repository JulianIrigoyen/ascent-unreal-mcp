import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pyValue, pyString, filterOutput, resolveInsideRoot, assertGamePath, computeOk } from "./index.js";
test("computeOk: marker + python success outrank a plugin-poisoned exit code", () => {
    // clean run
    assert.equal(computeOk({ code: 0, timedOut: false, markerOk: true, pySuccess: true }), true);
    // UnrealClaude port-bind error poisons exit code while the script succeeded
    assert.equal(computeOk({ code: 1, timedOut: false, markerOk: true, pySuccess: true }), true);
    // script raised: no marker, no success line — must fail even with exit 0
    assert.equal(computeOk({ code: 0, timedOut: false, markerOk: false, pySuccess: true }), false);
    // timeout always fails
    assert.equal(computeOk({ code: 0, timedOut: true, markerOk: true, pySuccess: true }), false);
    // nonzero exit and no python-success line
    assert.equal(computeOk({ code: 1, timedOut: false, markerOk: true, pySuccess: false }), false);
});
test("pyValue: python literals, not JSON", () => {
    assert.equal(pyValue(true), "True");
    assert.equal(pyValue(false), "False");
    assert.equal(pyValue(null), "None");
    assert.equal(pyValue(undefined), "None");
    assert.equal(pyValue(3.5), "3.5");
    assert.equal(pyValue(Number.NaN), "None");
    assert.equal(pyValue("a\"b"), '"a\\"b"');
    assert.equal(pyValue([1, true, "x"]), '[1, True, "x"]');
    assert.equal(pyValue({ "Use Volumetric Fog": true, Fog: 0.02 }), '{"Use Volumetric Fog": True, "Fog": 0.02}');
});
test("pyValue: the v1 preset bug shape round-trips as valid python", () => {
    const preset = { "Time of Day": 1030, "Render Exponential Height Fog": true, "Use Volumetric Fog": false };
    const s = pyValue(preset);
    assert.ok(!/\b(true|false|null)\b/.test(s), `raw JSON literal leaked: ${s}`);
    assert.ok(s.includes("True") && s.includes("False"));
});
test("filterOutput: keeps marker lines, strips timestamps, caps, tails", () => {
    const log = "[2026.08.31-05.00.00:000][  0]LogPython: MCP OK tool\n" +
        "noise\n".repeat(50) +
        "[2026.08.31-05.00.01:000][  1]LogPython: Warning: MCP SET_FAIL x\n" +
        "ending";
    const out = filterOutput(log, "MCP ", 10, 20);
    assert.equal(out.matched.length, 2);
    assert.ok(out.matched[0].startsWith("LogPython: MCP OK tool"));
    assert.equal(out.truncatedMatches, 0);
    assert.ok(out.tail.endsWith("ending"));
});
test("filterOutput: cap counts overflow and bad regex falls back", () => {
    const log = Array.from({ length: 30 }, (_, i) => `MCP line ${i}`).join("\n");
    const out = filterOutput(log, "MCP ", 5);
    assert.equal(out.matched.length, 5);
    assert.equal(out.truncatedMatches, 25);
    const fallback = filterOutput("LogPython: hi", "([bad", 5);
    assert.equal(fallback.matched.length, 1);
});
test("resolveInsideRoot: jail holds, case-insensitively on win32", () => {
    const base = path.resolve("C:/Users/marti/Games/Ascent");
    assert.ok(resolveInsideRoot("scripts/x.py", base).endsWith("x.py"));
    assert.throws(() => resolveInsideRoot("../outside.py", base));
    if (process.platform === "win32") {
        // v1 rejected case-mismatched drive letters on a case-insensitive fs
        assert.ok(resolveInsideRoot("SCRIPTS/x.py", base).toLowerCase().includes("scripts"));
    }
});
test("assertGamePath: /Game only, no traversal, no backslashes", () => {
    assert.equal(assertGamePath("/Game/Maps/LaninTrue", "map"), "/Game/Maps/LaninTrue");
    assert.throws(() => assertGamePath("/Engine/Maps/X", "map"));
    assert.throws(() => assertGamePath("/Game/../secret", "map"));
    assert.throws(() => assertGamePath("/Game\\Maps\\X", "map"));
});
test("pyString is JSON.stringify (valid python string literal)", () => {
    assert.equal(pyString("hi 'there' \"quoted\""), JSON.stringify("hi 'there' \"quoted\""));
});
test("evaluateExpectation: equals/contains/min-max semantics", async () => {
    const { evaluateExpectation } = await import("./index.js");
    assert.equal(evaluateExpectation({ prop: "x", equals: true }, true).pass, true);
    assert.equal(evaluateExpectation({ prop: "x", equals: "True" }, true).pass, true); // python-side stringing
    assert.equal(evaluateExpectation({ prop: "x", equals: 358 }, 358.00001).pass, true);
    assert.equal(evaluateExpectation({ prop: "x", equals: 358 }, 60).pass, false);
    assert.equal(evaluateExpectation({ prop: "x", contains: "weather" }, "Ultra_Dynamic_Weather_C_0").pass, true);
    assert.equal(evaluateExpectation({ prop: "x", min: 1, max: 10 }, 5).pass, true);
    assert.equal(evaluateExpectation({ prop: "x", min: 1 }, "not a number").pass, false);
    assert.equal(evaluateExpectation({ prop: "x" }, 5).pass, false); // no operator = fail loudly
});

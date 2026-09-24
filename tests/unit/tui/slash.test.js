import test from "node:test";
import assert from "node:assert/strict";
import { SLASH_COMMANDS, filterCommands, parseSlash } from "../../../src/apps/tui/slash.js";

test("registry holds the command set", () => {
  assert.deepEqual(SLASH_COMMANDS.map((c) => c.name),
    ["help", "config", "diff", "changes", "mode", "lang", "theme", "shell", "clear", "recovery", "branch", "rewind", "fim", "quit"]);
  for (const c of SLASH_COMMANDS) assert.match(c.descKey, /^slash\./);
});

test("filterCommands prefix-matches", () => {
  assert.deepEqual(filterCommands("").map((c) => c.name), SLASH_COMMANDS.map((c) => c.name));
  assert.deepEqual(filterCommands("c").map((c) => c.name), ["config", "changes", "clear"]);
  assert.deepEqual(filterCommands("zzz"), []);
});

test("parseSlash splits name and arg", () => {
  assert.deepEqual(parseSlash("/mode auto"), { name: "mode", arg: "auto" });
  assert.deepEqual(parseSlash("/help"), { name: "help", arg: "" });
  assert.deepEqual(parseSlash("/recovery resume x1"), { name: "recovery", arg: "resume x1" });
  assert.equal(parseSlash("hello"), null);
  assert.equal(parseSlash("/"), null);
});

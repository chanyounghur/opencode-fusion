// Runs the plugin inside a real `opencode serve`, in a throwaway project. No model is called.
//
// The project names this checkout as its plugin package and keeps its settings in a temporary file. OpenCode's global
// configuration is pointed at an empty folder for the run, so a Fusion installed for every project (which would load
// first and refuse this copy as a duplicate) and the settings of whoever runs the test stay out of it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS = process.platform === "win32";

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-server-test-"));
  const project = path.join(root, "project");
  const globalConfig = path.join(root, "global-config");
  const settingsFile = path.join(root, "settings.json");
  fs.mkdirSync(project);
  fs.mkdirSync(globalConfig);
  fs.writeFileSync(
    path.join(project, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugins: [{ package: PACKAGE_DIR.replaceAll("\\", "/"), options: { settingsFile: settingsFile.replaceAll("\\", "/") } }],
      },
      null,
      2,
    ),
  );
  return { root, project, globalConfig, settingsFile };
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
  });
}

function stopProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    // On Windows the server is a grandchild of the command interpreter: the whole tree has to go.
    if (WINDOWS) execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}

async function startOpencodeServer(fixture) {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "warn"];
  // On Windows `opencode` is a command script, which only the command interpreter can start.
  const child = spawn(WINDOWS ? "cmd.exe" : "opencode", WINDOWS ? ["/c", "opencode.cmd", ...args] : args, {
    cwd: fixture.project,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, OPENCODE_CONFIG_DIR: fixture.globalConfig },
  });

  let logs = "";
  let password = null;
  const onChunk = (chunk) => {
    const text = chunk.toString("utf8");
    logs += text;
    const match = text.match(/server password\s+(\S+)/);
    if (match) password = match[1];
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited early (${child.exitCode}). Logs:\n${logs}`);
    }
    if (password) {
      const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      try {
        const res = await fetch(`${baseUrl}/api/plugin?location[directory]=${encodeURIComponent(fixture.project)}`, {
          headers: { Authorization: authHeader },
        });
        if (res.ok) {
          return { baseUrl, authHeader, directory: fixture.project, getLogs: () => logs, stop: () => stopProcess(child) };
        }
      } catch {
        // Still starting.
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  stopProcess(child);
  throw new Error(`Timed out waiting for opencode serve on ${baseUrl}. Logs:\n${logs}`);
}

async function api(server, method, pathname, body, includeLocation = true) {
  let url = `${server.baseUrl}${pathname}`;
  if (includeLocation) {
    const sep = pathname.includes("?") ? "&" : "?";
    url += `${sep}location[directory]=${encodeURIComponent(server.directory)}`;
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: server.authHeader,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, ok: res.ok, data: json, raw: text };
}

function unwrapOutput(payload) {
  return payload?.output ?? payload?.data?.output ?? payload?.data ?? payload;
}

async function rpc(server, method, input) {
  const res = await api(server, "POST", `/api/rpc/fusion/${method}`, { input });
  assert.equal(res.status, 200, `RPC ${method} failed: ${res.raw}`);
  return unwrapOutput(res.data);
}

async function waitForState(server, sessionID, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const res = await api(server, "POST", "/api/rpc/fusion/getState", { input: { sessionID } });
    if (res.ok) {
      last = unwrapOutput(res.data);
      if (predicate(last)) return last;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out waiting for the session state. Last state: ${JSON.stringify(last)}`);
}

function lastRuleEffect(rules, action) {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if ((rule.action === "*" || rule.action === action) && rule.resource === "*") return rule.effect;
  }
  return undefined;
}

test("real opencode serve: the mode and its agents, settings, role switching, >> and forceReturn", async (t) => {
  const fixture = makeProject();
  const server = await startOpencodeServer(fixture);
  let sessionID;

  try {
    // 1. The plugin is loaded from this checkout.
    let plugins = [];
    let pluginsRes;
    const bootDeadline = Date.now() + 8_000;
    while (Date.now() < bootDeadline) {
      pluginsRes = await api(server, "GET", "/api/plugin");
      assert.equal(pluginsRes.status, 200, `GET /api/plugin failed: ${pluginsRes.raw}`);
      plugins = Array.isArray(pluginsRes.data) ? pluginsRes.data : pluginsRes.data?.data ?? pluginsRes.data?.plugins ?? [];
      if (plugins.some((p) => p.id === "fusion")) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(plugins.some((p) => p.id === "fusion"), `fusion not among the plugins: ${pluginsRes.raw}\nLogs:\n${server.getLogs()}`);

    // 2. One more mode (the Lead, listed) and a hidden Fellow, each with its role prompt.
    const agentsRes = await api(server, "GET", "/api/agent");
    assert.equal(agentsRes.status, 200, `GET /api/agent failed: ${agentsRes.raw}`);
    const agents = Array.isArray(agentsRes.data) ? agentsRes.data : agentsRes.data?.data ?? agentsRes.data?.agents ?? [];
    const lead = agents.find((a) => (a.id ?? a.name) === "fusion");
    const fellow = agents.find((a) => (a.id ?? a.name) === "fellow");
    assert.ok(lead, `agent fusion missing: ${agentsRes.raw}`);
    assert.ok(fellow, `agent fellow missing: ${agentsRes.raw}`);
    assert.match(lead.system ?? "", /Fusion LEAD/);
    assert.match(fellow.system ?? "", /Fusion FELLOW/);
    assert.equal(lead.hidden, false);
    assert.equal(fellow.hidden, true);

    // The Lead starts from "deny everything" and gets reading, planning and handing off.
    assert.deepEqual(lead.permissions[0], { action: "*", resource: "*", effect: "deny" });
    for (const denied of ["edit", "write", "execute", "handoff_to_lead", "opencode_worktree_create", "opencode_session_move", "artifact_write"]) {
      assert.equal(lastRuleEffect(lead.permissions, denied), "deny", `expected the Lead to be denied ${denied}`);
    }
    for (const allowed of ["read", "glob", "grep", "handoff_to_fellow", "opencode_session_read", "subagent"]) {
      assert.equal(lastRuleEffect(lead.permissions, allowed), "allow", `expected the Lead to be allowed ${allowed}`);
    }
    // The shell passes the agent's rules; each call is held to read-only commands by the plugin's own check.
    assert.equal(lastRuleEffect(lead.permissions, "shell"), "allow");
    assert.match(lead.system ?? "", /A handoff comes in two sizes/);

    // The scout: a subagent of its own for lookups, with the tools for looking and none for editing.
    const scout = agents.find((a) => (a.id ?? a.name) === "scout");
    assert.ok(scout, `agent scout missing: ${agentsRes.raw}`);
    assert.equal(scout.mode, "subagent");
    assert.match(scout.system ?? "", /Fusion SCOUT/);
    assert.match(lead.system ?? "", /call the `subagent` tool with agent `scout`/);
    for (const denied of ["edit", "write", "patch", "subagent", "handoff_to_fellow"]) {
      assert.equal(lastRuleEffect(scout.permissions, denied), "deny", `expected the scout to be denied ${denied}`);
    }
    for (const allowed of ["read", "grep", "execute", "shell"]) {
      assert.equal(lastRuleEffect(scout.permissions, allowed), "allow", `expected the scout to be allowed ${allowed}`);
    }

    // 3. Settings: nothing chosen, nothing fixed by the configuration.
    const settings = await rpc(server, "getSettings", {});
    assert.deepEqual(settings.agents, { lead: "fusion", fellow: "fellow" });
    assert.deepEqual(settings.saved, { modeName: "", leadModel: "", fellowModel: "", defaultMode: false });
    assert.equal(settings.effective.modeName, "Fusion");
    assert.deepEqual(settings.pinned, { modeName: false, leadModel: "", fellowModel: "", defaultMode: false, all: false });
    assert.equal(path.resolve(settings.settingsFile), path.resolve(fixture.settingsFile));
    assert.equal(settings.error, "");

    // A refusal comes back as words, and nothing is written.
    const refused = await rpc(server, "setSettings", { modeName: "한글" });
    assert.match(refused.error, /cannot be a mode name/);
    const unknownModel = await rpc(server, "setSettings", { fellowModel: "no-such-provider/no-such-model" });
    assert.match(unknownModel.error, /not available here/);
    assert.equal(fs.existsSync(fixture.settingsFile), false);

    // A saved mode name waits for the next start; the file holds what was saved.
    const renamed = await rpc(server, "setSettings", { modeName: "Engineering", defaultMode: true });
    assert.equal(renamed.error, "");
    assert.equal(renamed.saved.modeName, "Engineering");
    assert.equal(renamed.effective.modeName, "Fusion");
    assert.equal(renamed.restartNeeded, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.settingsFile, "utf8")), { modeName: "Engineering", defaultMode: true });

    // 4. A new session starts with the Lead.
    const createRes = await api(server, "POST", "/api/session", {}, false);
    assert.equal(createRes.status, 200, `POST /api/session failed: ${createRes.raw}`);
    sessionID = createRes.data?.data?.id ?? createRes.data?.id;
    assert.ok(sessionID, `no session id: ${createRes.raw}`);
    const first = await rpc(server, "getState", { sessionID });
    assert.equal(first.role, "lead");
    assert.equal(first.epoch, 1);

    // 5. Choosing the Fellow by hand is followed.
    const toFellow = await api(server, "POST", `/api/session/${sessionID}/agent`, { agent: "fellow" }, false);
    assert.ok(toFellow.ok, `agent switch failed (${toFellow.status}): ${toFellow.raw}`);
    await waitForState(server, sessionID, (s) => s?.role === "fellow" && s?.epoch >= 2);

    // 6. A queued message and one that starts with `>>` stay with the Fellow; any other message brings the Lead back.
    const prompt = (text, delivery) => api(server, "POST", `/api/session/${sessionID}/prompt`, { text, delivery, resume: false }, false);
    const queued = await prompt("queued follow-up", "queue");
    assert.ok(queued.ok, `queued prompt failed (${queued.status}): ${queued.raw}`);
    assert.equal((await waitForState(server, sessionID, (s) => s?.role === "fellow")).role, "fellow");
    const direct = await prompt(">> a hint straight to the Fellow", "steer");
    assert.ok(direct.ok, `>> prompt failed (${direct.status}): ${direct.raw}`);
    assert.equal((await waitForState(server, sessionID, (s) => s?.role === "fellow")).role, "fellow");
    const steer = await prompt("stop and revise the plan", "steer");
    assert.ok(steer.ok, `steer prompt failed (${steer.status}): ${steer.raw}`);
    const afterSteer = await waitForState(server, sessionID, (s) => s?.role === "lead");
    assert.equal(afterSteer.lastReturnReason, "user prompt intervention");

    // 7. forceReturn brings the Lead back from outside.
    const again = await api(server, "POST", `/api/session/${sessionID}/agent`, { agent: "fellow" }, false);
    assert.ok(again.ok);
    await waitForState(server, sessionID, (s) => s?.role === "fellow");
    const forced = await rpc(server, "forceReturn", { sessionID, reason: "test_force_return" });
    assert.equal(forced.role, "lead");
    assert.equal(forced.lastReturnReason, "test_force_return");
    const session = await api(server, "GET", `/api/session/${sessionID}`, undefined, false);
    assert.equal(session.status, 200, `GET session failed: ${session.raw}`);
    assert.equal((session.data?.data ?? session.data).agent, "fusion");

    // 8. Models, when this OpenCode has any connected: saved for every session, or set on one session.
    const model = (await rpc(server, "getSettings", {})).models[0];
    if (!model) {
      t.diagnostic("no model is connected in this OpenCode: choosing models was not exercised");
      return;
    }
    const ref = `${model.providerID}/${model.id}`;
    const saved = await rpc(server, "setSettings", { fellowModel: ref });
    assert.equal(saved.error, "");
    assert.equal(saved.saved.fellowModel, ref);
    assert.equal(saved.effective.fellowModel, ref);
    assert.equal(JSON.parse(fs.readFileSync(fixture.settingsFile, "utf8")).fellowModel, ref);
    const onSession = await rpc(server, "setRoleModel", { sessionID, role: "lead", model: ref });
    assert.equal(onSession.roleModels.lead.providerID, model.providerID);
    assert.equal(onSession.roleModels.lead.id, model.id);
  } finally {
    if (sessionID) {
      await api(server, "DELETE", `/api/session/${sessionID}`, undefined, false).catch(() => undefined);
    }
    server.stop();
    // The server may still hold files for a moment; a leftover temporary folder is not worth failing over.
    try {
      fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Left for the system's own cleanup.
    }
  }
});

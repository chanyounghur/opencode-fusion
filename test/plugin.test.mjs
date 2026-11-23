import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createMockOpenCode(givenOptions = {}, mockOpts = {}) {
  // Lead only reads and plans unless a test switches direct work on (`directWork: true`), as in the plugin itself.
  // Saved settings are off too (`settingsFile: false`), so a test never reads the settings file of whoever runs it.
  // The mode is called `lead` here so that the agent ids read as the roles; the plugin's own default is `fusion`,
  // which test 16 covers.
  const options = { directWork: false, settingsFile: false, modeName: "lead", fellowName: "fellow", ...givenOptions };
  const agents = new Map();
  let defaultAgent = "build";
  const tools = new Map();
  const commands = new Map();
  const storage = new Map();
  const instructionEntries = new Map();
  let instructionPutCount = 0;
  const sessions = new Map([
    ["ses_1", { id: "ses_1", agent: "lead", model: undefined }],
  ]);

  let availableModels = mockOpts.availableModels ?? [
    { providerID: "claude-agent", id: "claude-opus-4-6" },
    { providerID: "openai", id: "gpt-5.4" },
    { providerID: "openai", id: "gpt-6.2-sol" },
    { providerID: "deepseek", id: "deepseek-flash" },
    { providerID: "deepseek", id: "deepseek-chat" },
  ];

  const toolBeforeHooks = [];
  const toolAfterHooks = [];
  const sessionPromptHooks = [];
  const sessionIdleHooks = [];
  const sessionContextHooks = [];
  const switchCalls = [];
  const syntheticCalls = [];
  const rpcRegistrations = new Map();
  const rpcEmittedEvents = [];

  const eventSubscribers = [];
  function emitEvent(ev) {
    for (const sub of eventSubscribers) {
      if (!sub.types || sub.types.includes(ev.type)) {
        sub.push(ev);
      }
    }
  }

  let failSwitchModelError = mockOpts.failSwitchModelError ?? null;

  const agentTransforms = [];
  const ctx = {
    options,
    agent: {
      // Runs every transform again over the agents as they are, like a reload after a settings change.
      async reload() {
        for (const cb of agentTransforms) await ctx.agent.transform(cb, true);
      },
      async transform(cb, again = false) {
        if (!again) agentTransforms.push(cb);
        cb({
          default(id) {
            defaultAgent = id;
          },
          list() {
            return Array.from(agents.values());
          },
          get(id) {
            return agents.get(id);
          },
          update(id, fn) {
            const existing = agents.get(id) ?? {
              id,
              name: id,
              mode: "primary",
              hidden: false,
              permissions: structuredClone(
                id === "lead" && mockOpts.initialLeadPermissions
                  ? mockOpts.initialLeadPermissions
                  : [
                      { action: "*", resource: "*", effect: "allow" },
                      { action: "read", resource: "*.env", effect: "ask" },
                    ],
              ),
            };
            fn(existing);
            agents.set(id, existing);
          },
          remove(id) {
            agents.delete(id);
          },
        });
      },
      async get({ agentID }) {
        const agent = agents.get(agentID);
        return agent ? { location: { directory: "/mock" }, data: agent } : undefined;
      },
      async list() {
        return { location: { directory: "/mock" }, data: Array.from(agents.values()) };
      },
    },
    model: {
      async list() {
        return { location: { directory: "/mock" }, data: availableModels };
      },
    },
    tool: {
      async transform(cb) {
        cb({
          list() {
            return Array.from(tools.values());
          },
          get(id) {
            return tools.get(id);
          },
          add(tool) {
            tools.set(tool.name, tool);
          },
          update(id, fn) {
            const cur = tools.get(id);
            if (cur) fn(cur);
          },
          remove(id) {
            tools.delete(id);
          },
          namespace() {},
        });
      },
      async list() {
        return Array.from(tools.values());
      },
      async hook(name, cb) {
        const list = name === "execute.before" ? toolBeforeHooks : toolAfterHooks;
        list.push(cb);
        return {
          dispose() {
            const idx = list.indexOf(cb);
            if (idx >= 0) list.splice(idx, 1);
          },
        };
      },
    },
    session: {
      async get({ sessionID }) {
        return sessions.get(sessionID);
      },
      async switchAgent({ sessionID, agent }) {
        const ses = sessions.get(sessionID);
        if (ses) ses.agent = agent;
        switchCalls.push({ kind: "agent", sessionID, agent });
      },
      async switchModel({ sessionID, model }) {
        if (failSwitchModelError) {
          throw failSwitchModelError;
        }
        const ses = sessions.get(sessionID);
        if (ses) ses.model = structuredClone(model);
        switchCalls.push({ kind: "model", sessionID, model });
      },
      async synthetic(payload) {
        syntheticCalls.push(payload);
        return payload;
      },
      async hook(name, cb) {
        const list =
          name === "prompt"
            ? sessionPromptHooks
            : name === "experimental.idle"
              ? sessionIdleHooks
              : name === "context"
                ? sessionContextHooks
                : null;
        assert.ok(list, `Unexpected session hook: ${name}`);
        list.push(cb);
        return {
          dispose() {
            const idx = list.indexOf(cb);
            if (idx >= 0) list.splice(idx, 1);
          },
        };
      },
      instructions: {
        entry: {
          async put({ sessionID, key, value }) {
            instructionPutCount += 1;
            let map = instructionEntries.get(sessionID);
            if (!map) {
              map = new Map();
              instructionEntries.set(sessionID, map);
            }
            map.set(key, structuredClone(value));
          },
          async remove({ sessionID, key }) {
            instructionEntries.get(sessionID)?.delete(key);
          },
          async list({ sessionID }) {
            const map = instructionEntries.get(sessionID);
            return map ? Array.from(map.entries()).map(([key, value]) => ({ key, value })) : [];
          },
        },
      },
    },
    storage: {
      async get(key) {
        return storage.get(key);
      },
      async set(key, value) {
        storage.set(key, structuredClone(value));
      },
      async remove(key) {
        storage.delete(key);
      },
    },
    command: {
      async transform(cb) {
        cb({
          add(def) {
            commands.set(def.name, def);
          },
        });
      },
    },
    rpc: {
      async register(definition, handlers) {
        const reg = { definition, handlers };
        rpcRegistrations.set(definition.id, reg);
        return {
          events: {
            async emit(name, payload) {
              rpcEmittedEvents.push({ rpcID: definition.id, name, payload });
            },
          },
          async dispose() {
            rpcRegistrations.delete(definition.id);
          },
        };
      },
    },
    event: {
      subscribe({ types, signal }) {
        const queue = [];
        let wake = null;
        const sub = {
          types,
          push(ev) {
            queue.push(ev);
            if (wake) {
              const fn = wake;
              wake = null;
              fn();
            }
          },
        };
        eventSubscribers.push(sub);
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal?.aborted) {
              if (queue.length > 0) {
                yield queue.shift();
                continue;
              }
              await new Promise((resolve) => {
                wake = resolve;
                signal?.addEventListener("abort", resolve, { once: true });
              });
            }
          },
        };
      },
    },
  };

  return {
    ctx,
    agents,
    getDefaultAgent: () => defaultAgent,
    tools,
    commands,
    storage,
    instructionEntries,
    getInstructionPutCount: () => instructionPutCount,
    sessions,
    toolBeforeHooks,
    toolAfterHooks,
    sessionPromptHooks,
    sessionIdleHooks,
    sessionContextHooks,
    switchCalls,
    syntheticCalls,
    rpcRegistrations,
    rpcEmittedEvents,
    emitEvent,
    setAvailableModels(models) {
      availableModels = models;
    },
    setFailSwitchModelError(err) {
      failSwitchModelError = err;
    },
  };
}

function wildcardMatch(action, pattern) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return action === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(action);
}

function resolvePermissionEffect(rules, action, resource = "*") {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      return rule.effect;
    }
  }
  return undefined;
}

test("1. agent.system, codemode:false, and upper-bound PLAN allowlist preserve stricter existing deny/ask rules", async () => {
  const mock = createMockOpenCode(
    {
      leadModel: "claude-agent/claude-opus-4-6",
      fellowModel: "openai/gpt-5.4",
      extraLeadTools: ["mcp_docs_search", "edit", "shell", "artifact_write", "opencode_worktree_create"],
    },
    {
      initialLeadPermissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "read", resource: "*.env", effect: "ask" },
        { action: "read", resource: "*.env", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "skill", resource: "browser", effect: "deny" },
      ],
    },
  );
  const cleanup = await plugin.setup(mock.ctx);

  // One more mode, not a replacement: the mode OpenCode starts in is left alone unless asked for.
  assert.equal(mock.getDefaultAgent(), "build");
  const lead = mock.agents.get("lead");
  const fellow = mock.agents.get("fellow");
  assert.ok(lead);
  assert.ok(fellow);
  assert.match(lead.system ?? "", /Fusion LEAD/);
  assert.match(fellow.system ?? "", /Fusion FELLOW/);
  assert.equal(lead.prompt, undefined);
  assert.equal(fellow.prompt, undefined);

  assert.equal(mock.tools.get("handoff_to_fellow").options?.codemode, false);
  assert.equal(mock.tools.get("handoff_to_lead").options?.codemode, false);

  assert.deepEqual(lead.permissions[0], { action: "*", resource: "*", effect: "deny" });

  // Stricter existing rules preserved without weakening
  assert.equal(resolvePermissionEffect(lead.permissions, "webfetch", "*"), "deny");
  assert.equal(resolvePermissionEffect(lead.permissions, "read", ".env"), "deny");
  assert.equal(resolvePermissionEffect(lead.permissions, "skill", "browser"), "deny");
  assert.equal(resolvePermissionEffect(lead.permissions, "skill", "my-skill"), "allow");
  assert.equal(resolvePermissionEffect(lead.permissions, "read", "prod.env.local"), "ask");
  assert.equal(resolvePermissionEffect(lead.permissions, "read", "src/ledger.js"), "allow");

  for (const deniedAction of [
    "edit",
    "write",
    "patch",
    "subagent",
    "execute",
    "todowrite",
    "handoff_to_lead",
    "opencode_worktree_create",
    "opencode_worktree_remove",
    "opencode_session_move",
    "opencode_session_rename",
    "opencode_move",
    "opencode_rename",
    "artifact_write",
    "automation_create",
    "mcp_github_create_issue",
  ]) {
    assert.equal(
      resolvePermissionEffect(lead.permissions, deniedAction),
      "deny",
      `Expected ${deniedAction} denied in lead strict allowlist`,
    );
  }
  // The shell passes the agent's rules; each call is held to read-only commands in `execute.before` (test 17).
  assert.equal(resolvePermissionEffect(lead.permissions, "shell"), "allow");

  for (const allowedAction of [
    "read",
    "glob",
    "grep",
    "websearch",
    "question",
    "opencode_session_search",
    "opencode_session_read",
    "opencode_worktree_list",
    "opencode_models",
    "handoff_to_fellow",
    "mcp_docs_search",
  ]) {
    assert.equal(
      resolvePermissionEffect(lead.permissions, allowedAction),
      "allow",
      `Expected ${allowedAction} allowed in lead`,
    );
  }

  assert.equal(resolvePermissionEffect(fellow.permissions, "handoff_to_lead"), "allow");
  assert.equal(resolvePermissionEffect(fellow.permissions, "handoff_to_fellow"), "deny");

  await cleanup?.();
});

test("2. execute.before blocks Lead mutations and post-return sibling mutating tools in Fellow batch", async () => {
  const mock = createMockOpenCode({
    leadModel: "claude-agent/claude-opus-4-6",
    fellowModel: "openai/gpt-5.4",
  });
  const cleanup = await plugin.setup(mock.ctx);
  const before = mock.toolBeforeHooks[0];
  const toExec = mock.tools.get("handoff_to_fellow");

  await assert.rejects(
    () => before({ tool: "shell", agent: "lead", sessionID: "ses_1", id: "call_shell", input: { command: "npm install" } }),
    /read-only commands only/,
  );
  for (const tool of [
    "edit",
    "write",
    "patch",
    "subagent",
    "execute",
    "handoff_to_lead",
    "opencode_worktree_create",
    "opencode_session_move",
    "artifact_create",
  ]) {
    await assert.rejects(
      () => before({ tool, agent: "lead", sessionID: "ses_1", id: `call_${tool}`, input: {} }),
      /disabled in Lead mode/,
    );
  }
  await before({ tool: "read", agent: "lead", sessionID: "ses_1", id: "call_r1", input: {} });

  await toExec.execute(
    { summary: "Edit file", files: ["a.js"], steps: ["Edit a.js"], verification: ["node --test"], replanIf: ["err"] },
    { sessionID: "ses_1", agent: "lead" },
  );
  await before({ tool: "edit", agent: "fellow", sessionID: "ses_1", id: "call_e1", input: {} });
  await assert.rejects(
    () => before({ tool: "handoff_to_fellow", agent: "fellow", sessionID: "ses_1", id: "call_h1", input: {} }),
    /only available in Lead mode/,
  );

  const rpc = mock.rpcRegistrations.get("fusion");
  await rpc.handlers.forceReturn({ sessionID: "ses_1", reason: "sibling_test" });

  for (const siblingMutating of ["edit", "write", "patch", "shell", "handoff_to_lead"]) {
    await assert.rejects(
      () => before({ tool: siblingMutating, agent: "fellow", sessionID: "ses_1", id: `sib_${siblingMutating}`, input: {} }),
      /already returned to Lead mode/,
    );
  }
  await before({ tool: "read", agent: "fellow", sessionID: "ses_1", id: "sib_read", input: {} });

  await cleanup?.();
});

test("3 & 4. Hybrid switchModel, model availability fail-closed, and runtime context/execute.before mismatch lock", async () => {
  const mockDefault = createMockOpenCode({
    leadModel: "claude-agent/claude-opus-4-6",
    fellowModel: "openai/gpt-5.4#high",
  });
  const cleanupA = await plugin.setup(mockDefault.ctx);
  const toExecA = mockDefault.tools.get("handoff_to_fellow");
  const toPlanA = mockDefault.tools.get("handoff_to_lead");
  const contextHook = mockDefault.sessionContextHooks[0];
  const beforeHook = mockDefault.toolBeforeHooks[0];

  const resExecA = await toExecA.execute(
    {
      summary: "Add summarizeByTag",
      files: ["src/ledger.js"],
      steps: ["Implement summarizeByTag()"],
      verification: ["node --test"],
      replanIf: ["Existing tests break"],
    },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.match(resExecA.content, /FELLOW MODE ACTIVE/);
  assert.equal(mockDefault.sessions.get("ses_1").agent, "fellow");
  assert.equal(mockDefault.sessions.get("ses_1").model, undefined);
  assert.deepEqual(mockDefault.switchCalls, [{ kind: "agent", sessionID: "ses_1", agent: "fellow" }]);

  // Simulate fallback to unintended free model in Fellow: context hook strips mutating tools & locks execute.before
  const reqCtx = {
    sessionID: "ses_1",
    agent: "fellow",
    model: { providerID: "opencode", id: "hy4-flash-free" },
    system: [{ type: "text", text: FELLOW_STUB() }],
    tools: {
      read: { description: "r", input: {} },
      edit: { description: "e", input: {} },
      write: { description: "w", input: {} },
      shell: { description: "s", input: {} },
      execute: { description: "x", input: {} },
      handoff_to_lead: { description: "hp", input: {} },
      handoff_to_fellow: { description: "he", input: {} },
    },
  };
  await contextHook(reqCtx);
  assert.ok(reqCtx.tools.read);
  assert.ok(reqCtx.tools.handoff_to_lead);
  assert.equal(reqCtx.tools.edit, undefined);
  assert.equal(reqCtx.tools.write, undefined);
  assert.equal(reqCtx.tools.shell, undefined);
  assert.equal(reqCtx.tools.execute, undefined);
  assert.equal(reqCtx.tools.handoff_to_fellow, undefined);
  assert.ok(reqCtx.system.some((s) => s.type === "text" && /MODEL MISMATCH LOCK/.test(s.text)));

  await assert.rejects(
    () => beforeHook({ tool: "edit", agent: "fellow", sessionID: "ses_1", id: "mm_1", input: {} }),
    /model mismatch lock/,
  );
  await beforeHook({ tool: "read", agent: "fellow", sessionID: "ses_1", id: "mm_read", input: {} });

  // Sticky model returns via switchModel
  mockDefault.sessions.get("ses_1").model = { providerID: "deepseek", id: "deepseek-chat" };
  const resPlanA = await toPlanA.execute(
    { reason: "completed", summary: "Done", changedFiles: ["src/ledger.js"] },
    { sessionID: "ses_1", agent: "fellow" },
  );
  assert.match(resPlanA.content, /LEAD MODE ACTIVE/);
  assert.deepEqual(mockDefault.sessions.get("ses_1").model, {
    providerID: "claude-agent",
    id: "claude-opus-4-6",
  });

  // Unavailable configured fellow model fails closed before mutating state
  mockDefault.setAvailableModels([{ providerID: "claude-agent", id: "claude-opus-4-6" }]);
  await assert.rejects(
    () =>
      toExecA.execute(
        { summary: "Unavailable fellow model", files: [], steps: ["Step"], verification: [], replanIf: [] },
        { sessionID: "ses_1", agent: "lead" },
      ),
    /currently unavailable/,
  );
  assert.equal(mockDefault.sessions.get("ses_1").agent, "lead");
  assert.equal(mockDefault.storage.get("fusion:ses_1").role, "lead");

  // Restore available models, test fail-closed when switchModel rejects
  mockDefault.setAvailableModels([
    { providerID: "claude-agent", id: "claude-opus-4-6" },
    { providerID: "openai", id: "gpt-5.4" },
  ]);
  mockDefault.setFailSwitchModelError(new Error("provider quota error"));
  await assert.rejects(
    () =>
      toExecA.execute(
        { summary: "Fail closed", files: [], steps: ["Step"], verification: [], replanIf: [] },
        { sessionID: "ses_1", agent: "lead" },
      ),
    /provider quota error/,
  );
  assert.equal(mockDefault.sessions.get("ses_1").agent, "lead");
  await cleanupA?.();

  // Sticky session model + unresolvable target fails closed
  const mockNoModel = createMockOpenCode({});
  const cleanupB = await plugin.setup(mockNoModel.ctx);
  mockNoModel.sessions.get("ses_1").model = { providerID: "openai", id: "gpt-6.2-sol" };
  await assert.rejects(
    () =>
      mockNoModel.tools.get("handoff_to_fellow").execute(
        { summary: "Missing target", files: [], steps: ["Step"], verification: [], replanIf: [] },
        { sessionID: "ses_1", agent: "lead" },
      ),
    /Fail-closed handoff aborted/,
  );
  assert.equal(mockNoModel.sessions.get("ses_1").agent, "lead");
  await cleanupB?.();
});

function FELLOW_STUB() {
  return "base";
}

test("5. Code Mode failures, array result.content banner, next-step cap, legacy activePlan, and maxHandoffsPerTurn", async () => {
  const mock = createMockOpenCode({
    leadModel: "claude-agent/claude-opus-4-6",
    fellowModel: "openai/gpt-5.4",
    maxConsecutiveFailures: 2,
    maxFellowSteps: 3,
    maxHandoffsPerTurn: 2,
  });
  const cleanup = await plugin.setup(mock.ctx);
  const toExec = mock.tools.get("handoff_to_fellow");
  const before = mock.toolBeforeHooks[0];
  const after = mock.toolAfterHooks[0];
  const rpc = mock.rpcRegistrations.get("fusion");

  // Handoff #1 of turn
  await toExec.execute(
    { summary: "Code mode & step cap", files: ["a.js"], steps: ["Step"], verification: ["node --test"], replanIf: ["2 fails"] },
    { sessionID: "ses_1", agent: "lead" },
  );
  const putsAfterHandoff = mock.getInstructionPutCount();

  // 1) Outer Code Mode `execute` #1 fails with output.error + metadata.error while wrapping an inner failing call (no event.codemode!)
  await before({ tool: "execute", agent: "fellow", sessionID: "ses_1", id: "exec_1", messageID: "msg_cm1", input: {} });
  // Nested inner shell failure MUST NOT double-count while outer execute is active!
  await before({ tool: "shell", agent: "fellow", sessionID: "ses_1", id: "inner_1", messageID: "msg_cm1", input: { command: "bad" } });
  await after({
    tool: "shell",
    agent: "fellow",
    sessionID: "ses_1",
    id: "inner_1",
    messageID: "msg_cm1",
    status: "error",
    error: new Error("inner shell fail"),
  });
  assert.equal(mock.storage.get("fusion:ses_1").consecutiveFailures, 0);
  assert.equal(mock.storage.get("fusion:ses_1").fellowSteps, 0);

  const cmRes1 = {
    tool: "execute",
    agent: "fellow",
    sessionID: "ses_1",
    id: "exec_1",
    messageID: "msg_cm1",
    status: "completed",
    result: {
      output: { output: "failed 1", error: true },
      content: [{ type: "text", text: "failed 1" }],
      metadata: { error: true },
    },
  };
  await after(cmRes1);
  assert.equal(mock.storage.get("fusion:ses_1").consecutiveFailures, 1);
  assert.equal(mock.storage.get("fusion:ses_1").fellowSteps, 1);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.equal(mock.getInstructionPutCount(), putsAfterHandoff);

  // Benign grep exit-1 doesn't trigger failure 2; repeating does or outer Code Mode #2 does
  await before({ tool: "execute", agent: "fellow", sessionID: "ses_1", id: "exec_2", messageID: "msg_cm2", input: {} });
  const cmRes2 = {
    tool: "execute",
    agent: "fellow",
    sessionID: "ses_1",
    id: "exec_2",
    messageID: "msg_cm2",
    status: "completed",
    result: {
      output: { ok: false },
      content: [{ type: "text", text: "failed 2" }],
      metadata: {},
    },
  };
  await after(cmRes2);
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(mock.storage.get("fusion:ses_1").consecutiveFailures, 2);
  // Array result.content received banner directly -> zero synthetic calls!
  assert.equal(mock.syntheticCalls.length, 0);
  assert.match(cmRes2.result.content.at(-1).text, /FUSION AUTO-RETURN TO LEAD/);
  assert.equal(mock.getInstructionPutCount(), putsAfterHandoff + 1);

  // Handoff #2 of same turn (maxHandoffsPerTurn = 2) -> verify step cap fires at START of step maxFellowSteps + 1
  await toExec.execute(
    { summary: "Step cap at boundary", files: [], steps: ["Go"], verification: ["node --test"], replanIf: ["cap"] },
    { sessionID: "ses_1", agent: "lead" },
  );

  for (let step = 1; step <= 2; step += 1) {
    await before({ tool: "read", agent: "fellow", sessionID: "ses_1", id: `s_${step}`, messageID: `step_${step}`, input: {} });
    await after({
      tool: "read",
      agent: "fellow",
      sessionID: "ses_1",
      id: `s_${step}`,
      messageID: `step_${step}`,
      status: "completed",
      result: { content: "ok" },
    });
  }
  // Step 3 has two parallel edits sharing messageID="step_3" -> BOTH finish cleanly without mid-step cutoff!
  await before({ tool: "edit", agent: "fellow", sessionID: "ses_1", id: "s_3a", messageID: "step_3", input: {} });
  await after({
    tool: "edit",
    agent: "fellow",
    sessionID: "ses_1",
    id: "s_3a",
    messageID: "step_3",
    status: "completed",
    result: { content: "edited a" },
  });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  await before({ tool: "edit", agent: "fellow", sessionID: "ses_1", id: "s_3b", messageID: "step_3", input: {} });
  await after({
    tool: "edit",
    agent: "fellow",
    sessionID: "ses_1",
    id: "s_3b",
    messageID: "step_3",
    status: "completed",
    result: { content: "edited b" },
  });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.equal(mock.storage.get("fusion:ses_1").fellowSteps, 3);

  // Next step ("step_4") calling work tool hits step cap in execute.before -> switches to lead + synthetic steer + throws
  await assert.rejects(
    () => before({ tool: "edit", agent: "fellow", sessionID: "ses_1", id: "s_4", messageID: "step_4", input: {} }),
    /Fellow step cap reached/,
  );
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.match(mock.syntheticCalls.at(-1).text, /fellowSteps \(3\) reached limit \(3\)/);

  // Handoff #3 in SAME turn exceeds maxHandoffsPerTurn (2)
  await assert.rejects(
    () =>
      toExec.execute(
        { summary: "Loop 3", files: [], steps: ["Loop"], verification: [], replanIf: [] },
        { sessionID: "ses_1", agent: "lead" },
      ),
    /Per-turn handoff budget exhausted/,
  );

  // execution.started MUST NOT reset handoffsInTurn mid-turn; only a fresh user prompt turn resets it.
  mock.emitEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    () =>
      toExec.execute(
        { summary: "Still exhausted", files: [], steps: ["Loop"], verification: [], replanIf: [] },
        { sessionID: "ses_1", agent: "lead" },
      ),
    /Per-turn handoff budget exhausted/,
  );

  // New user prompt turn resets handoffsInTurn so handoff works again
  await mock.sessionPromptHooks[0]({ sessionID: "ses_1", prompt: { text: "New user turn" } });
  await toExec.execute(
    { summary: "New turn works", files: [], steps: ["Go"], verification: [], replanIf: [] },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  // Legacy activePlan normalization (missing files/createdAt + extra pitfalls field)
  const stored = mock.storage.get("fusion:ses_1");
  stored.activePlan = {
    summary: "Legacy plan",
    steps: ["Do old thing"],
    verification: ["npm test"],
    replanIf: ["Broken"],
    pitfalls: ["Do not keep me"],
  };
  await mock.ctx.storage.set("fusion:ses_1", stored);
  const legacyRpc = await rpc.handlers.getState({ sessionID: "ses_1" });
  assert.deepEqual(legacyRpc.activePlan.files, []);
  assert.ok(typeof legacyRpc.activePlan.createdAt === "string" && legacyRpc.activePlan.createdAt.length > 0);
  assert.equal("pitfalls" in legacyRpc.activePlan, false);

  await cleanup?.();
});

test("6. prompt bypass/reason, experimental.idle shell vs subagent, completed cleanup, event resilience, RPC, and session.deleted", async () => {
  const mock = createMockOpenCode({
    leadModel: "claude-agent/claude-opus-4-6",
    fellowModel: "openai/gpt-5.4",
  });
  const cleanup = await plugin.setup(mock.ctx);
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const promptHook = mock.sessionPromptHooks[0];
  const idleHook = mock.sessionIdleHooks[0];
  const rpc = mock.rpcRegistrations.get("fusion");

  await toExec.execute(
    { summary: "Work", files: [], steps: ["Do"], verification: ["test"], replanIf: ["err"] },
    { sessionID: "ses_1", agent: "lead" },
  );

  // queue / metadata / >> bypasses
  await promptHook({ sessionID: "ses_1", delivery: "queue", prompt: { text: "Queued" } });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  await promptHook({
    sessionID: "ses_1",
    delivery: "steer",
    metadata: { fusion: { route: "fellow" } },
    prompt: { text: "Route bypass" },
  });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  const hintedEvent = {
    sessionID: "ses_1",
    delivery: "steer",
    prompt: { text: ">> fix line 12\nkeep existing behavior" },
  };
  await promptHook(hintedEvent);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.equal(hintedEvent.prompt.text, "fix line 12\nkeep existing behavior");

  // Running vs idle prompt return reasons
  await promptHook({ sessionID: "ses_1", delivery: "steer", prompt: { text: "Stop idle" } });
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(mock.storage.get("fusion:ses_1").lastReturnReason, "user prompt intervention");

  await toExec.execute(
    { summary: "Work running", files: [], steps: ["Do"], verification: ["test"], replanIf: ["err"] },
    { sessionID: "ses_1", agent: "lead" },
  );
  mock.emitEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 20));
  await promptHook({ sessionID: "ses_1", delivery: "steer", prompt: { text: "Stop live" } });
  assert.equal(mock.storage.get("fusion:ses_1").lastReturnReason, "user steer intervention");

  // experimental.idle: active subagent defers; infinite dev-server shell does NOT disable idle return!
  await toExec.execute(
    { summary: "Work 2", files: [], steps: ["Do"], verification: ["test"], replanIf: ["err"] },
    { sessionID: "ses_1", agent: "lead" },
  );
  await idleHook({ sessionID: "ses_1", background: [{ kind: "subagent", sessionID: "ses_1", childSessionID: "sub_1", agent: "explore", description: "read" }] });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  await idleHook({ sessionID: "ses_1", background: [{ kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "npm run dev" }] });
  // The first stop without a hand-back: Fellow is asked once to make the call, and stays at work.
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.match(mock.syntheticCalls.at(-1).text, /YOU STOPPED WITHOUT HANDING BACK/);
  assert.match(mock.syntheticCalls.at(-1).text, /as a real tool call/);
  assert.equal(mock.syntheticCalls.at(-1).resume, true);
  assert.deepEqual(mock.syntheticCalls.at(-1).metadata, { fusion: { route: "fellow" } });
  // The second stop in the same round goes to Lead.
  await idleHook({ sessionID: "ses_1", background: [{ kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "npm run dev" }] });
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(mock.storage.get("fusion:ses_1").lastReturnReason, "fellow_idle_without_handoff");
  assert.equal(mock.syntheticCalls.at(-1).resume, true);

  // Completed return clears activePlan and removes fusion.plan entry
  await toExec.execute(
    { summary: "Will complete", files: ["a.js"], steps: ["Done"], verification: ["test"], replanIf: ["err"] },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.ok(mock.instructionEntries.get("ses_1").get("fusion.plan"));
  await toPlan.execute(
    { reason: "completed", summary: "Finished cleanly", changedFiles: ["a.js"] },
    { sessionID: "ses_1", agent: "fellow" },
  );
  assert.equal(mock.storage.get("fusion:ses_1").activePlan, undefined);
  assert.equal(mock.instructionEntries.get("ses_1").get("fusion.plan"), undefined);

  // Sticky session model follows manual agent.selected switch
  mock.sessions.get("ses_1").model = { providerID: "claude-agent", id: "claude-opus-4-6" };
  mock.sessions.get("ses_1").agent = "fellow";
  mock.emitEvent({ type: "session.agent.selected", data: { sessionID: "ses_1", agent: "fellow", previous: "lead" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mock.storage.get("fusion:ses_1").role, "fellow");
  assert.deepEqual(mock.sessions.get("ses_1").model, { providerID: "openai", id: "gpt-5.4" });

  // Event loop resilience: throwing storage failure on a bad event does NOT kill stream for next events
  const origSet = mock.ctx.storage.set;
  let throwOnce = true;
  mock.ctx.storage.set = async (...args) => {
    if (throwOnce) {
      throwOnce = false;
      throw new Error("transient db error");
    }
    return origSet(...args);
  };
  mock.emitEvent({ type: "session.execution.started", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 20));
  mock.ctx.storage.set = origSet;
  mock.emitEvent({ type: "session.execution.failed", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(mock.storage.get("fusion:ses_1").lastReturnReason, "session.execution.failed");

  // RPC + /fusion-status ++ session.deleted
  const updatedRole = await rpc.handlers.setRoleModel({
    sessionID: "ses_1",
    role: "lead",
    model: "openai/gpt-6.2-sol#high",
  });
  assert.deepEqual(updatedRole.roleModels.lead, {
    providerID: "openai",
    id: "gpt-6.2-sol",
    variant: "high",
  });
  const cmd = mock.commands.get("fusion-status");
  await cmd.execute({ sessionID: "ses_1", delivery: "steer" });
  assert.match(mock.syntheticCalls.at(-1).text, /Turn handoffs:/);

  mock.emitEvent({ type: "session.deleted", data: { sessionID: "ses_1" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mock.storage.get("fusion:ses_1"), undefined);

  await cleanup?.();
});

test("7. Lazy config model resolution after setup and unpersisted session.agent.selected transition", async () => {
  const mock = createMockOpenCode({});
  const cleanup = await plugin.setup(mock.ctx);

  mock.agents.get("lead").model = { providerID: "openai", id: "gpt-6.2-sol", variant: "medium" };
  mock.agents.get("fellow").model = { providerID: "deepseek", id: "deepseek-flash" };

  const rpc = mock.rpcRegistrations.get("fusion");
  const initial = await rpc.handlers.getState({ sessionID: "ses_1" });
  assert.deepEqual(initial.roleModels.lead, { providerID: "openai", id: "gpt-6.2-sol", variant: "medium" });
  assert.deepEqual(initial.roleModels.fellow, { providerID: "deepseek", id: "deepseek-flash" });

  mock.sessions.get("ses_1").model = { providerID: "openai", id: "gpt-6.2-sol", variant: "medium" };
  await mock.tools.get("handoff_to_fellow").execute(
    { summary: "Lazy model", files: [], steps: ["Go"], verification: [], replanIf: [] },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.deepEqual(mock.sessions.get("ses_1").model, { providerID: "deepseek", id: "deepseek-flash" });

  mock.sessions.set("ses_fresh", { id: "ses_fresh", agent: "fellow", model: undefined });
  mock.emitEvent({
    type: "session.agent.selected",
    data: { sessionID: "ses_fresh", agent: "fellow", previous: "lead" },
  });
  await new Promise((r) => setTimeout(r, 20));
  const freshStored = mock.storage.get("fusion:ses_fresh");
  assert.equal(freshStored.role, "fellow");
  assert.equal(freshStored.epoch, 2);
  assert.equal(freshStored.revision, 2);

  await cleanup?.();
});

// ---- loop changes (2026-11-22): verification gate, requirement tracking, no-progress stop ----------------------

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-gate-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "t@localhost");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  return dir;
}

const PASS = { command: 'node -e "process.exit(0)"' };
const FAIL = { command: 'node -e "console.log(\'boom: expected 2 got 3\'); process.exit(1)"' };

test("8. verification gate: failing checks go back to Fellow, then Lead gets real results", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ verifyRetries: 2 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");

  const started = await toExec.execute(
    { summary: "Gate", files: ["a.txt"], steps: ["edit"], verification: ["look at it"], replanIf: [], requirements: ["찾기도 둔다", "키만 연결한다"], checks: [PASS, FAIL] },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.match(started.content, /Requirements \(2\)/);
  assert.match(started.content, /Checks \(2\)/);
  const stored = mock.instructionEntries.get("ses_1").get("fusion.plan");
  assert.deepEqual(stored.requirements, ["찾기도 둔다", "키만 연결한다"]);
  assert.equal(stored.checks.length, 2);

  // First two completions are refused: Fellow stays Fellow and sees the failing output.
  for (const attempt of [1, 2]) {
    const bounced = await toPlan.execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });
    assert.match(bounced.content, /VERIFICATION GATE/);
    assert.match(bounced.content, new RegExp(`attempt ${attempt}/2`));
    assert.match(bounced.content, /boom: expected 2 got 3/);
    assert.equal(mock.sessions.get("ses_1").agent, "fellow");
    assert.equal(mock.storage.get("fusion:ses_1").role, "fellow");
    assert.equal(mock.storage.get("fusion:ses_1").verifyBounces, attempt);
  }
  // The handoff budget is untouched by gate bounces.
  assert.equal(mock.storage.get("fusion:ses_1").handoffsInTurn, 1);

  // Third time the Lead is told, with Fusion's own results rather than Fellow's word.
  fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
  const returned = await toPlan.execute(
    { reason: "completed", summary: "all good, tests pass", verification: ["everything passes"], missingRequirements: ["사용자는 '검색도 두고'라고 했다"] },
    { sessionID: "ses_1", agent: "fellow" },
  );
  assert.match(returned.content, /LEAD MODE ACTIVE/);
  assert.match(returned.content, /Checks run by Fusion: 1\/2 passed \(after 2 round\(s\) sent back/);
  assert.match(returned.content, /\[FAIL\]/);
  assert.match(returned.content, /Do not report this as done/);
  assert.match(returned.content, /Workspace changes \(1 files/);
  assert.match(returned.content, /b\.txt/);
  assert.match(returned.content, /검색도 두고/);
  assert.match(returned.content, /1\. 찾기도 둔다/);
  assert.equal(mock.sessions.get("ses_1").agent, "lead");

  // A fresh handoff resets the bounce count; passing checks return at once.
  await toExec.execute(
    { summary: "Fix", files: [], steps: ["fix"], verification: [], replanIf: [], requirements: ["찾기도 둔다"], checks: [PASS] },
    { sessionID: "ses_1", agent: "lead" },
  );
  assert.equal(mock.storage.get("fusion:ses_1").verifyBounces, 0);
  const clean = await toPlan.execute({ reason: "completed", summary: "fixed" }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(clean.content, /Checks run by Fusion: 1\/1 passed\./);
  assert.doesNotMatch(clean.content, /Do not report this as done/);

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("9. gate edge cases: a command that cannot run, a blocked return, a plan without checks, gate switched off", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({});
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const plan = (checks) => ({ summary: "Edge", files: [], steps: ["go"], verification: [], replanIf: [], requirements: ["x"], ...(checks ? { checks } : {}) });

  // A missing command is the plan's problem: no bounce, and Lead is told it could not run.
  await toExec.execute(plan([{ command: "definitely-not-a-real-command-xyz --version" }, { command: 'node -e "process.exit(0)"', cwd: "../outside" }]), { sessionID: "ses_1", agent: "lead" });
  const unrunnable = await toPlan.execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(unrunnable.content, /LEAD MODE ACTIVE/);
  assert.match(unrunnable.content, /COULD NOT RUN.*definitely-not-a-real-command-xyz/);
  assert.match(unrunnable.content, /cwd must be a folder inside the project/);
  assert.match(unrunnable.content, /Do not report this as done/);

  // Fellow says it is blocked: the checks are not run, and Lead is told so.
  await toExec.execute(plan([FAIL]), { sessionID: "ses_1", agent: "lead" });
  const blocked = await toPlan.execute({ reason: "blocked", summary: "cannot", blockers: ["no network"] }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(blocked.content, /Checks were NOT run by Fusion/);
  assert.doesNotMatch(blocked.content, /VERIFICATION GATE/);

  // No checks in the plan: nothing was verified, and the message says so.
  await toExec.execute(plan(), { sessionID: "ses_1", agent: "lead" });
  const unchecked = await toPlan.execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(unchecked.content, /nothing was verified by Fusion/);
  await cleanup?.();

  // runChecks: false keeps the old behaviour.
  const off = createMockOpenCode({ runChecks: false });
  const cleanupOff = await plugin.setup(off.ctx);
  off.sessions.get("ses_1").location = { directory: dir };
  await off.tools.get("handoff_to_fellow").execute(plan([FAIL]), { sessionID: "ses_1", agent: "lead" });
  const passedThrough = await off.tools.get("handoff_to_lead").execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(passedThrough.content, /LEAD MODE ACTIVE/);
  assert.doesNotMatch(passedThrough.content, /Checks run by Fusion/);
  await cleanupOff?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("10. no-progress stop: unfinished rounds that change nothing end further handoffs; a change resets it", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ maxHandoffsPerTurn: 20, maxStalledReturns: 2 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const plan = { summary: "Stall", files: [], steps: ["go"], verification: [], replanIf: [], requirements: ["x"] };
  const round = async () => {
    await toExec.execute(plan, { sessionID: "ses_1", agent: "lead" });
    return toPlan.execute({ reason: "blocked", summary: "stuck" }, { sessionID: "ses_1", agent: "fellow" });
  };

  await round();                                   // first sight of this workspace state
  assert.equal(mock.storage.get("fusion:ses_1").stalledReturns, 0);
  const second = await round();                    // same state again
  assert.equal(mock.storage.get("fusion:ses_1").stalledReturns, 1);
  assert.match(second.content, /changed nothing in the workspace \(1\/2/);

  fs.writeFileSync(path.join(dir, "a.txt"), "two\n");   // real progress
  await round();
  assert.equal(mock.storage.get("fusion:ses_1").stalledReturns, 0);

  await round();
  await round();
  assert.equal(mock.storage.get("fusion:ses_1").stalledReturns, 2);
  await assert.rejects(() => toExec.execute(plan, { sessionID: "ses_1", agent: "lead" }), /No progress/);

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- loop 3 (2026-11-22): phases, checkpoints, resume --------------------------------------------------------

const NEEDS_OK_FILE = { command: `node -e "process.exit(require('fs').existsSync('ok.txt')?0:1)"` };

test("11. phases: checkpoints go on by themselves, wake Lead when asked or when something is off, and resume keeps the plan", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ maxHandoffsPerTurn: 20 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const report = mock.tools.get("report_checkpoint");
  const resume = mock.tools.get("resume_fellow");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const asFellow = { sessionID: "ses_1", agent: "fellow" };
  const stateNow = () => mock.storage.get("fusion:ses_1");

  const started = await toExec.execute(
    {
      summary: "Three parts",
      files: ["a.txt", "ok.txt"],
      verification: [],
      replanIf: [],
      requirements: ["x"],
      phases: [
        { title: "공용 규칙", steps: ["rule", "test"], checks: [PASS], review: "always" },
        { title: "데스크톱 화면", steps: ["wire desktop"], checks: [PASS] },
        { title: "휴대폰 화면", steps: ["wire mobile"], checks: [NEEDS_OK_FILE] },
      ],
    },
    asLead,
  );
  assert.match(started.content, /This plan has 3 phases/);
  assert.match(started.content, /Phase 1\/3: 공용 규칙/);
  assert.deepEqual(stateNow().activePlan.steps, ["rule", "test", "wire desktop", "wire mobile"]);
  assert.equal(stateNow().phaseIndex, 0);

  // The wrong role cannot use the new tools.
  await assert.rejects(() => resume.execute({ decision: "continue" }, asFellow), /only available in Lead mode/);
  await assert.rejects(() => report.execute({ done: "x" }, asLead), /only available in Fellow mode/);

  // Phase 1 is marked "always": Lead is woken even though everything passed, and the plan stays.
  const first = await report.execute({ done: "rule written", next: "desktop" }, asFellow);
  assert.match(first.content, /CHECKPOINT 1\/3 — LEAD REVIEW/);
  assert.match(first.content, /Lead asked to see this checkpoint/);
  assert.match(first.content, /Checks for this phase: 1\/1 passed/);
  assert.match(first.content, /Phases still to do: 2\. 데스크톱 화면 \| 3\. 휴대폰 화면/);
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(stateNow().awaitingCheckpoint, 0);
  assert.ok(mock.instructionEntries.get("ses_1").get("fusion.plan"), "the plan survives a checkpoint");

  const goOn = await resume.execute({ decision: "continue" }, asLead);
  assert.match(goOn.content, /RESUMED AT CHECKPOINT/);
  assert.match(goOn.content, /Phase 2\/3: 데스크톱 화면/);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.equal(stateNow().phaseIndex, 1);
  assert.equal(stateNow().awaitingCheckpoint, undefined);
  assert.equal(stateNow().handoffsInTurn, 2);

  // Phase 2 is "auto" and clean: no Lead call, straight on to phase 3.
  // A note about something unverified is recorded but does not interrupt.
  const second = await report.execute({ done: "desktop wired", notes: ["실제 기기에서는 확인하지 못함"] }, asFellow);
  assert.match(second.content, /CHECKPOINT 2\/3 PASSED — CONTINUE/);
  assert.deepEqual(stateNow().activePlan.checkpointNotes, ["Phase 2: 실제 기기에서는 확인하지 못함"]);
  assert.match(second.content, /Phase 3\/3: 휴대폰 화면/);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.equal(stateNow().phaseIndex, 2);
  assert.equal(stateNow().handoffsInTurn, 2, "an automatic checkpoint does not spend the handoff budget");

  // Phase 3's check fails: back to Fellow, same phase.
  const failing = await report.execute({ done: "mobile wired" }, asFellow);
  assert.match(failing.content, /CHECKPOINT 3\/3 — NOT PASSED/);
  assert.match(failing.content, /attempt 1\/2/);
  assert.equal(stateNow().phaseIndex, 2);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  // Fixed, but Fellow is unsure about something: Lead is woken for that reason.
  fs.writeFileSync(path.join(dir, "ok.txt"), "ok\n");
  const unsure = await report.execute({ done: "mobile wired", concerns: ["목록이 길 때 스크롤이 맞는지 모르겠음"] }, asFellow);
  assert.match(unsure.content, /CHECKPOINT 3\/3 — LEAD REVIEW/);
  assert.match(unsure.content, /Fellow raised concerns/);
  assert.match(unsure.content, /This was the last phase/);

  await assert.rejects(() => resume.execute({ decision: "adjust" }, asLead), /needs at least one note/);
  const fixIt = await resume.execute({ decision: "adjust", notes: ["목록은 높이를 60%로 제한한다"] }, asLead);
  assert.match(fixIt.content, /wants phase 3 fixed/);
  assert.match(fixIt.content, /목록은 높이를 60%로 제한한다/);
  assert.equal(stateNow().phaseIndex, 2);
  assert.deepEqual(stateNow().activePlan.amendments, ["목록은 높이를 60%로 제한한다"]);
  assert.deepEqual(mock.instructionEntries.get("ses_1").get("fusion.plan").amendments, ["목록은 높이를 60%로 제한한다"]);

  const last = await report.execute({ done: "limited the height" }, asFellow);
  assert.match(last.content, /CHECKPOINT 3\/3 PASSED — CONTINUE/);
  assert.match(last.content, /That was the last phase/);
  assert.equal(stateNow().phaseIndex, 3);
  const extra = await report.execute({ done: "again" }, asFellow);
  assert.match(extra.content, /Every phase has already been reported/);

  // The final handoff runs every check of the plan once more and has nothing unreported to mention.
  const finished = await toPlan.execute({ reason: "completed", summary: "all three done" }, asFellow);
  assert.match(finished.content, /Checks run by Fusion: 2\/2 passed/);
  assert.match(finished.content, /Notes Fellow left at checkpoints[\s\S]*Phase 2: 실제 기기에서는 확인하지 못함/);
  assert.doesNotMatch(finished.content, /never reported at a checkpoint/);
  await assert.rejects(() => resume.execute({ decision: "continue" }, asLead), /no checkpoint waiting/);

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("12. phases: skipped checkpoints are named at the end, stray files wake Lead, undivided plans have no checkpoint", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ maxHandoffsPerTurn: 20, offPlanFilesLimit: 3 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const report = mock.tools.get("report_checkpoint");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const asFellow = { sessionID: "ses_1", agent: "fellow" };
  const twoPhases = { summary: "Two", files: ["src/a.ts"], verification: [], replanIf: [], requirements: ["x"], phases: [{ title: "하나", steps: ["one"] }, { title: "둘", steps: ["two"] }] };

  // Fellow never reports and hands back as done: Lead is told which phases went unchecked.
  await toExec.execute(twoPhases, asLead);
  const skipped = await toPlan.execute({ reason: "completed", summary: "did everything in one go" }, asFellow);
  assert.match(skipped.content, /never reported at a checkpoint.*1\. 하나 \| 2\. 둘/);

  // Many changed files that the plan did not name: an "auto" checkpoint wakes Lead.
  await toExec.execute(twoPhases, asLead);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "helper.ts"), "export const h = 1;\n");      // next to a planned file: fine
  for (const name of ["x", "y", "z", "w"]) {
    fs.mkdirSync(path.join(dir, "other", name), { recursive: true });
    fs.writeFileSync(path.join(dir, "other", name, "file.ts"), "export {};\n");
  }
  const strayed = await report.execute({ done: "one" }, asFellow);
  assert.match(strayed.content, /LEAD REVIEW/);
  assert.match(strayed.content, /4 changed files are outside the plan's files/);
  assert.doesNotMatch(strayed.content, /outside the plan's files \(\d+\): [^\n]*helper\.ts/);

  // A plan given as plain steps has no checkpoints.
  await toExec.execute({ summary: "Plain", files: [], steps: ["go"], verification: [], replanIf: [], requirements: ["x"] }, asLead);
  const none = await report.execute({ done: "x" }, asFellow);
  assert.match(none.content, /not divided into phases/);
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- direct work (2026-11-22): Lead makes small changes itself ----------------------------------------------

test("13. direct work: closed until work_directly, counted against a budget, finished through the checks", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ directWork: true, maxDirectFiles: 2, maxDirectLines: 10, maxDirectSteps: 3, maxDirectWindows: 2, verifyRetries: 1 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const before = mock.toolBeforeHooks[0];
  const after = mock.toolAfterHooks[0];
  const open = mock.tools.get("work_directly");
  const finish = mock.tools.get("finish_direct");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const call = (tool, id, messageID) => before({ tool, agent: "lead", sessionID: "ses_1", id, messageID, input: {} });
  const done = (tool, id, messageID) => after({ tool, agent: "lead", sessionID: "ses_1", id, messageID, status: "completed", input: {}, result: { content: "ok" } });
  const stored = () => mock.storage.get("fusion:ses_1");

  // The prompt and the agent's rules let Lead edit, but each call still has to pass the window.
  const lead = mock.agents.get("lead");
  assert.match(lead.system, /work_directly/);
  assert.doesNotMatch(lead.system, /strict read-only/);
  assert.match(lead.system, /at most about 2 files and 10 changed lines/);
  assert.match(lead.system, /or fix a small thing yourself with `work_directly`/);
  assert.equal(resolvePermissionEffect(lead.permissions, "edit"), "allow");
  assert.equal(resolvePermissionEffect(lead.permissions, "shell"), "allow");
  assert.equal(resolvePermissionEffect(lead.permissions, "subagent"), "deny");
  assert.equal(resolvePermissionEffect(mock.agents.get("fellow").permissions, "work_directly"), "deny");

  // Closed until declared. Other mutating tools stay closed whatever happens.
  await assert.rejects(() => call("edit", "c1", "m1"), /call work_directly first/);
  await assert.rejects(() => call("subagent", "c2", "m1"), /disabled in Lead mode/);
  await assert.rejects(() => open.execute({ reason: " ", files: [] }, asLead), /needs a `reason`/);
  await assert.rejects(() => open.execute({ reason: "x", files: [] }, { sessionID: "ses_1", agent: "fellow" }), /only available in Lead mode/);

  const opened = await open.execute({ reason: "one condition is wrong", files: ["a.txt"], requirements: ["조건을 고친다"], checks: [NEEDS_OK_FILE] }, asLead);
  assert.match(opened.content, /DIRECT WORK OPEN — window 1\/2/);
  assert.equal(mock.sessions.get("ses_1").agent, "lead");
  assert.equal(mock.switchCalls.length, 0);                          // no handoff, no model switch
  await call("edit", "c3", "m2");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  await done("edit", "c3", "m2");
  assert.equal(stored().direct.steps, 1);
  assert.match((await open.execute({ reason: "again", files: [] }, asLead)).content, /already open/);

  // Failing checks keep the window open (once, with verifyRetries: 1) ...
  const bounced = await finish.execute({ summary: "fixed" }, asLead);
  assert.match(bounced.content, /CHECKS NOT PASSED, STILL OPEN/);
  assert.ok(stored().direct);
  // ... and passing ones close it, saying what Lead changed and which requirements to tick off.
  fs.writeFileSync(path.join(dir, "ok.txt"), "ok\n");
  const closed = await finish.execute({ summary: "fixed" }, asLead);
  assert.match(closed.content, /DIRECT WORK — CLOSED/);
  assert.match(closed.content, /You changed 2 file\(s\), about 2 line\(s\)/);
  assert.match(closed.content, /Checks run by Fusion: 1\/1 passed \(after 1 failed attempt/);
  assert.match(closed.content, /1\. 조건을 고친다/);
  assert.equal(stored().direct, undefined);
  await assert.rejects(() => call("write", "c4", "m3"), /call work_directly first/);
  assert.match((await finish.execute({ summary: "x" }, asLead)).content, /nothing to finish/);

  // A second window: the turn's total counts. A third file is over the budget, and then nothing more may be changed.
  await open.execute({ reason: "one more line", files: ["a.txt"] }, asLead);
  await call("edit", "c5", "m4");
  fs.writeFileSync(path.join(dir, "third.txt"), "x\n");
  await assert.rejects(() => call("edit", "c6", "m5"), /Direct-work budget exceeded \(3 files/);
  await assert.rejects(() => call("shell", "c7", "m5"), /handoff_to_fellow with a plan that says what you already changed/);
  await call("read", "c8", "m5");                                    // reading is never closed

  // Handing off closes the window and keeps the count.
  const handed = await mock.tools.get("handoff_to_fellow").execute(
    { summary: "The rest", files: [], steps: ["finish it"], verification: [], replanIf: [], requirements: ["x"] },
    asLead,
  );
  assert.match(handed.content, /direct work was closed by this handoff \(it changed 1 file\(s\), about 1 line/);
  assert.equal(stored().direct, undefined);
  assert.equal(stored().directFilesInTurn.length, 3);
  await assert.rejects(() => before({ tool: "work_directly", agent: "fellow", sessionID: "ses_1", id: "c9", input: {} }), /only available in Lead mode/);
  await mock.tools.get("handoff_to_lead").execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });
  await assert.rejects(() => open.execute({ reason: "again", files: [] }, asLead), /already opened 2 times this turn/);

  // A new user prompt starts a new budget.
  await mock.sessionPromptHooks[0]({ sessionID: "ses_1", prompt: { text: "next request" } });
  assert.equal(stored().directWindowsInTurn, 0);
  assert.equal(stored().directFilesInTurn.length, 0);

  // Steps inside a window are limited: sibling calls of the last message finish, the next message is refused.
  await open.execute({ reason: "steps", files: [] }, asLead);
  for (const n of [1, 2, 3]) {
    await call("shell", `s${n}`, `step${n}`);
    await done("shell", `s${n}`, `step${n}`);
  }
  await call("shell", "s3b", "step3");
  await assert.rejects(() => call("shell", "s4", "step4"), /step limit reached \(3\/3\)/);
  // A window left open does not survive the next user prompt.
  await mock.sessionPromptHooks[0]({ sessionID: "ses_1", prompt: { text: "another" } });
  assert.equal(stored().direct, undefined);
  await cleanup?.();

  // The plugin's own default is off: no tools, the prompt of a Lead that never edits, edits denied by the agent's
  // own rules. `directWork: false` is the same.
  for (const directWork of [undefined, false]) {
    const off = createMockOpenCode({ directWork });
    const cleanupOff = await plugin.setup(off.ctx);
    assert.equal(off.tools.get("work_directly"), undefined);
    assert.equal(off.tools.get("finish_direct"), undefined);
    assert.match(off.agents.get("lead").system, /You never change files or run anything that has effects yourself/);
    assert.doesNotMatch(off.agents.get("lead").system, /work_directly/);
    assert.equal(resolvePermissionEffect(off.agents.get("lead").permissions, "edit"), "deny");
    await cleanupOff?.();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test("14. direct work: after Fellow returns only Lead's own change is counted; a window left open is checked at idle", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ directWork: true, maxDirectFiles: 3, maxDirectLines: 20 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const before = mock.toolBeforeHooks[0];
  const open = mock.tools.get("work_directly");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const stored = () => mock.storage.get("fusion:ses_1");

  await mock.tools.get("handoff_to_fellow").execute(
    { summary: "Big work", files: ["big.txt"], steps: ["write it"], verification: [], replanIf: [], requirements: ["x"] },
    asLead,
  );
  // Fellow writes far more than the direct budget allows.
  fs.writeFileSync(path.join(dir, "big.txt"), `${Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")}\n`);
  fs.writeFileSync(path.join(dir, "a.txt"), `one\n${"x\n".repeat(100)}`);
  await mock.tools.get("handoff_to_lead").execute({ reason: "completed", summary: "done" }, { sessionID: "ses_1", agent: "fellow" });

  // Lead fixes one line of it. Fellow's 600 lines are not held against Lead.
  await open.execute({ reason: "one wrong line in Fellow's work", files: ["big.txt"], checks: [FAIL] }, asLead);
  await before({ tool: "edit", agent: "lead", sessionID: "ses_1", id: "e1", messageID: "m1", input: {} });
  fs.appendFileSync(path.join(dir, "big.txt"), "fixed\n");
  await before({ tool: "edit", agent: "lead", sessionID: "ses_1", id: "e2", messageID: "m2", input: {} });

  // Lead stops without finish_direct. The checks are run anyway, and because they fail it is woken.
  await mock.sessionIdleHooks[0]({ sessionID: "ses_1", background: [] });
  assert.equal(stored().direct, undefined);
  assert.deepEqual(stored().directFilesInTurn, ["big.txt"]);
  assert.equal(stored().directLinesInTurn, 1);
  const note = mock.syntheticCalls.at(-1);
  assert.match(note.text, /ENDED WITHOUT finish_direct/);
  assert.match(note.text, /boom: expected 2 got 3/);
  assert.equal(note.resume, true);

  // With passing checks nothing is said, and the window is closed all the same.
  await open.execute({ reason: "again", files: [], checks: [PASS] }, asLead);
  const said = mock.syntheticCalls.length;
  await mock.sessionIdleHooks[0]({ sessionID: "ses_1", background: [] });
  assert.equal(mock.syntheticCalls.length, said);
  assert.equal(stored().direct, undefined);
  assert.equal(mock.sessions.get("ses_1").agent, "lead");

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("15. direct work: a wrong check command is replaced inside the open window, a limited number of times", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ directWork: true, maxDirectWindows: 2, verifyRetries: 2 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const open = mock.tools.get("work_directly");
  const finish = mock.tools.get("finish_direct");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const stored = () => mock.storage.get("fusion:ses_1");

  await open.execute({ reason: "one line", files: ["a.txt"], checks: [FAIL] }, asLead);
  const bounced = await finish.execute({ summary: "done" }, asLead);
  assert.match(bounced.content, /CHECKS NOT PASSED, STILL OPEN/);
  assert.match(bounced.content, /call `work_directly` again with corrected `checks`/);

  // The same call without checks, with no checks, or with the same checks changes nothing.
  assert.match((await open.execute({ reason: "again", files: [] }, asLead)).content, /already open/);
  assert.match((await open.execute({ reason: "again", files: [], checks: [] }, asLead)).content, /already open/);
  assert.match((await open.execute({ reason: "again", files: [], checks: [FAIL] }, asLead)).content, /already open/);
  assert.equal(stored().direct.checksReplaced, 0);

  // New checks replace the old ones: no new window, the failed attempt stays counted.
  const replaced = await open.execute({ reason: "the command was wrong", files: [], checks: [PASS] }, asLead);
  assert.match(replaced.content, /CHECKS REPLACED, SAME WINDOW/);
  assert.match(replaced.content, /process\.exit\(0\)/);
  assert.equal(stored().directWindowsInTurn, 1);
  assert.equal(stored().direct.bounces, 1);
  assert.equal(stored().direct.checksReplaced, 1);
  const closed = await finish.execute({ summary: "done" }, asLead);
  assert.match(closed.content, /DIRECT WORK — CLOSED/);
  assert.match(closed.content, /1\/1 passed \(after 1 failed attempt\(s\)\) \(you replaced the checks 1 time\(s\) in this window\)/);
  assert.equal(stored().direct, undefined);

  // Replacing is limited, so it cannot be used to get past a failure.
  await open.execute({ reason: "second window", files: [], checks: [FAIL] }, asLead);
  await open.execute({ reason: "r1", files: [], checks: [NEEDS_OK_FILE] }, asLead);
  await open.execute({ reason: "r2", files: [], checks: [PASS, NEEDS_OK_FILE] }, asLead);
  await assert.rejects(() => open.execute({ reason: "r3", files: [], checks: [PASS] }, asLead), /already replaced 2 times/);
  assert.equal(stored().direct.checks.length, 2);
  assert.equal(stored().directWindowsInTurn, 2);

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("16. Fusion mode: one more mode under a chosen name, a hidden Fellow, and settings saved for every project", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-settings-"));
  const file = path.join(dir, "nested", "settings.json");
  const availableModels = [
    { providerID: "claude-agent", id: "opus", name: "Opus", variants: [{ id: "high" }, { id: "max" }], capabilities: { tools: true } },
    { providerID: "openai", id: "gpt-6.1-terra-fast", name: "Terra Fast", variants: [{ id: "high" }] },
    { providerID: "openai", id: "gpt-6.2-sol", name: "Sol", variants: [{ id: "medium" }] },
    { providerID: "deepseek", id: "deepseek-flash", name: "DeepSeek Flash", variants: [] },
    { providerID: "openai", id: "embed", name: "No tools", capabilities: { tools: false } },
    { providerID: "openai", id: "old", name: "Switched off", enabled: false },
  ];
  // The other tests keep the agent ids `lead` and `fellow`; here the plugin names its agents itself.
  const install = (options = {}) =>
    createMockOpenCode({ settingsFile: file, modeName: undefined, fellowName: undefined, ...options }, { availableModels });
  const mock = install();
  mock.sessions.get("ses_1").agent = "fusion";
  const cleanup = await plugin.setup(mock.ctx);
  const rpc = mock.rpcRegistrations.get("fusion");
  const lead = () => mock.agents.get("fusion");
  const fellow = () => mock.agents.get("fellow");
  const onDisk = () => JSON.parse(fs.readFileSync(file, "utf8"));

  // The mode list gets one visible mode. Nothing is chosen yet and the starting mode is left alone.
  assert.deepEqual([...mock.agents.keys()], ["fusion", "fellow"]);
  assert.equal(lead().name, "Fusion");
  assert.equal(lead().hidden, false);
  assert.equal(fellow().name, "Fellow");
  assert.equal(fellow().hidden, true);
  assert.equal(lead().model, undefined);
  assert.equal(lead().steps, 200);
  // The mode names its own colour, so it looks the same wherever it stands in the mode list. A colour from the
  // configuration is kept.
  assert.equal(lead().color, "#ef6c6c");
  lead().color = "#123456";
  await mock.ctx.agent.reload();
  assert.equal(lead().color, "#123456");
  assert.equal(fellow().color, undefined);
  assert.match(lead().system, /Fusion LEAD/);
  assert.match(fellow().system, /Fusion FELLOW/);
  assert.equal(mock.getDefaultAgent(), "build");
  const first = await rpc.handlers.getSettings({});
  assert.deepEqual(first.saved, { modeName: "", leadModel: "", fellowModel: "", defaultMode: false });
  assert.deepEqual(first.effective, { modeName: "Fusion", leadModel: "", fellowModel: "", defaultMode: false });
  assert.deepEqual(first.pinned, { modeName: false, leadModel: "", fellowModel: "", defaultMode: false, all: false });
  assert.deepEqual(first.agents, { lead: "fusion", fellow: "fellow" });
  assert.equal(first.restartNeeded, false);
  // Only models that are switched on and can call tools are offered.
  assert.deepEqual(
    first.models.map((m) => `${m.providerID}/${m.id}`),
    ["claude-agent/opus", "openai/gpt-6.1-terra-fast", "openai/gpt-6.2-sol", "deepseek/deepseek-flash"],
  );
  assert.deepEqual(first.models[0], { providerID: "claude-agent", id: "opus", name: "Opus", variants: ["high", "max"] });
  assert.equal(fs.existsSync(file), false);

  // Saving models writes the file, rebuilds the modes without a restart, and reaches the session at hand.
  const systemBefore = lead().system;
  const permissionsBefore = JSON.stringify(lead().permissions);
  const fellowPermissionsBefore = JSON.stringify(fellow().permissions);
  const saved = await rpc.handlers.setSettings({
    leadModel: "claude-agent/opus#high",
    fellowModel: "deepseek/deepseek-flash",
    sessionID: "ses_1",
  });
  assert.equal(saved.error, "");
  assert.deepEqual(onDisk(), { leadModel: "claude-agent/opus#high", fellowModel: "deepseek/deepseek-flash" });
  assert.deepEqual(lead().model, { providerID: "claude-agent", id: "opus", variant: "high" });
  assert.deepEqual(fellow().model, { providerID: "deepseek", id: "deepseek-flash" });
  assert.deepEqual(saved.effective, { modeName: "Fusion", leadModel: "claude-agent/opus#high", fellowModel: "deepseek/deepseek-flash", defaultMode: false });
  assert.equal(saved.pinned.leadModel, "");
  assert.equal(saved.pinned.fellowModel, "");
  // The rebuild did not pile anything up on the agents.
  assert.equal(lead().system, systemBefore);
  assert.equal(JSON.stringify(lead().permissions), permissionsBefore);
  assert.equal(JSON.stringify(fellow().permissions), fellowPermissionsBefore);
  const state = await rpc.handlers.getState({ sessionID: "ses_1" });
  assert.deepEqual(state.roleModels.lead, { providerID: "claude-agent", id: "opus", variant: "high" });
  assert.deepEqual(state.roleModels.fellow, { providerID: "deepseek", id: "deepseek-flash" });

  // A handoff then runs the Fellow, under its own agent id, on the chosen model.
  mock.sessions.get("ses_1").model = { providerID: "claude-agent", id: "opus", variant: "high" };
  const plan = { summary: "Use the chosen Fellow", files: [], steps: ["Go"], verification: [], replanIf: [] };
  await assert.rejects(() => mock.tools.get("handoff_to_fellow").execute(plan, { sessionID: "ses_1", agent: "lead" }));
  await mock.tools.get("handoff_to_fellow").execute(plan, { sessionID: "ses_1", agent: "fusion" });
  assert.equal(mock.sessions.get("ses_1").agent, "fellow");
  assert.deepEqual(mock.sessions.get("ses_1").model, { providerID: "deepseek", id: "deepseek-flash" });
  await rpc.handlers.forceReturn({ sessionID: "ses_1", reason: "test" });
  assert.equal(mock.sessions.get("ses_1").agent, "fusion");

  // A model that is not there, cannot call tools, or has no such variant is refused and nothing is saved.
  // The refusal comes back as text for the user (a thrown error would reach a client only as "RPC call failed").
  assert.match((await rpc.handlers.setSettings({ fellowModel: "nope/none" })).error, /not available/);
  assert.match((await rpc.handlers.setSettings({ fellowModel: "openai/embed" })).error, /not available/);
  assert.match((await rpc.handlers.setSettings({ leadModel: "claude-agent/opus#turbo" })).error, /no variant "turbo"/);
  assert.match((await rpc.handlers.setSettings({ leadModel: "opus", defaultMode: true })).error, /Invalid model reference/);
  // The mode's name becomes an agent id, so it has to look like one and may not be another mode's.
  for (const bad of ["한글", "9lives", "plan", "Build", "fellow", "has/slash", "a".repeat(25)]) {
    assert.match((await rpc.handlers.setSettings({ modeName: bad })).error, /cannot be a mode name/, bad);
  }
  assert.deepEqual(onDisk(), { leadModel: "claude-agent/opus#high", fellowModel: "deepseek/deepseek-flash" });

  // A new name is saved now and used from the next start: sessions refer to the agent by its id.
  const renamed = await rpc.handlers.setSettings({ modeName: "  Engineer " });
  assert.equal(renamed.error, "");
  assert.equal(renamed.saved.modeName, "Engineer");
  assert.equal(renamed.effective.modeName, "Fusion");
  assert.equal(renamed.restartNeeded, true);
  assert.deepEqual([...mock.agents.keys()], ["fusion", "fellow"]);
  assert.equal(lead().name, "Fusion");
  const restarted = install();
  const cleanupRestarted = await plugin.setup(restarted.ctx);
  assert.deepEqual([...restarted.agents.keys()], ["engineer", "fellow"]);
  assert.equal(restarted.agents.get("engineer").name, "Engineer");
  assert.deepEqual(restarted.agents.get("engineer").model, { providerID: "claude-agent", id: "opus", variant: "high" });
  const restartedView = await restarted.rpcRegistrations.get("fusion").handlers.getSettings({});
  assert.deepEqual(restartedView.agents, { lead: "engineer", fellow: "fellow" });
  assert.equal(restartedView.restartNeeded, false);

  // An empty value clears a setting; the starting mode is a setting too.
  const cleared = await rpc.handlers.setSettings({ modeName: "", fellowModel: "" });
  assert.equal(cleared.restartNeeded, false);
  assert.equal(fellow().model, undefined);
  assert.deepEqual(onDisk(), { leadModel: "claude-agent/opus#high" });
  await rpc.handlers.setSettings({ defaultMode: true });
  assert.equal(mock.getDefaultAgent(), "fusion");
  assert.deepEqual(onDisk(), { leadModel: "claude-agent/opus#high", defaultMode: true });

  // Another server (another project) starts from the same file...
  const second = install();
  const cleanupSecond = await plugin.setup(second.ctx);
  assert.deepEqual(second.agents.get("fusion").model, { providerID: "claude-agent", id: "opus", variant: "high" });
  assert.equal(second.getDefaultAgent(), "fusion");
  // ...and notices what the first one saves later.
  await rpc.handlers.setSettings({ fellowModel: "openai/gpt-6.1-terra-fast#high" });
  const seenBySecond = await second.rpcRegistrations.get("fusion").handlers.getSettings({});
  assert.equal(seenBySecond.effective.fellowModel, "openai/gpt-6.1-terra-fast#high");
  assert.deepEqual(second.agents.get("fellow").model, { providerID: "openai", id: "gpt-6.1-terra-fast", variant: "high" });

  // What the configuration states wins over what is saved, and is reported as fixed.
  const pinned = install({ leadModel: "openai/gpt-6.2-sol#medium", modeName: "Exam", fellowName: "worker", defaultMode: false });
  const cleanupPinned = await plugin.setup(pinned.ctx);
  assert.deepEqual([...pinned.agents.keys()], ["exam", "worker"]);
  pinned.agents.get("worker").model = { providerID: "deepseek", id: "deepseek-flash" };
  await pinned.ctx.agent.reload();
  assert.equal(pinned.agents.get("exam").name, "Exam");
  assert.equal(pinned.getDefaultAgent(), "build");
  assert.deepEqual(pinned.agents.get("exam").model, { providerID: "openai", id: "gpt-6.2-sol", variant: "medium" });
  assert.deepEqual(pinned.agents.get("worker").model, { providerID: "deepseek", id: "deepseek-flash" });
  const pinnedView = await pinned.rpcRegistrations.get("fusion").handlers.getSettings({});
  assert.deepEqual(pinnedView.pinned, { modeName: true, leadModel: "option", fellowModel: "config", defaultMode: true, all: false });
  assert.deepEqual(pinnedView.effective, { modeName: "Exam", leadModel: "openai/gpt-6.2-sol#medium", fellowModel: "deepseek/deepseek-flash", defaultMode: false });
  assert.equal(pinnedView.saved.leadModel, "claude-agent/opus#high");
  assert.equal(pinnedView.restartNeeded, false);

  // `settingsFile: false` (unattended runs): nothing is read and nothing can be saved.
  const off = install({ settingsFile: false });
  const cleanupOff = await plugin.setup(off.ctx);
  assert.equal(off.agents.get("fusion").model, undefined);
  assert.equal((await off.rpcRegistrations.get("fusion").handlers.getSettings({})).pinned.all, true);
  assert.match((await off.rpcRegistrations.get("fusion").handlers.setSettings({ modeName: "Other" })).error, /switched off/);

  // Build, Plan and other modes are not offered the tools of this plugin; the mode itself keeps them.
  const offered = () => ({ read: {}, edit: {}, handoff_to_fellow: {}, handoff_to_lead: {}, resume_fellow: {}, report_checkpoint: {}, work_directly: {}, finish_direct: {} });
  const asBuild = { sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "gpt-6.2-sol" }, system: [], tools: offered() };
  await mock.sessionContextHooks[0](asBuild);
  assert.deepEqual(Object.keys(asBuild.tools), ["read", "edit"]);
  const asFusion = { sessionID: "ses_1", agent: "fusion", model: { providerID: "claude-agent", id: "opus" }, system: [], tools: offered() };
  await mock.sessionContextHooks[0](asFusion);
  assert.equal(Object.keys(asFusion.tools).length, 8);

  await Promise.all([cleanup?.(), cleanupRestarted?.(), cleanupSecond?.(), cleanupPinned?.(), cleanupOff?.()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("17. Lead reads and Fellow acts: read-only shell for Lead, a small job handed over as one sentence", async () => {
  const mock = createMockOpenCode({ directWork: undefined });
  const cleanup = await plugin.setup(mock.ctx);
  const before = mock.toolBeforeHooks[0];
  const handoff = mock.tools.get("handoff_to_fellow");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  let n = 0;
  const shell = (command, agent = "lead") => before({ tool: "shell", agent, sessionID: "ses_1", id: `sh_${(n += 1)}`, messageID: `m_${n}`, input: { command } });

  // Looking is open to Lead without anything being declared.
  for (const command of [
    "git log --oneline -5",
    "git status",
    'git log --all --since="3 months ago" -i --grep="rate\\|cut" --format="%h %ad %s" --date=short | head -40',
    "git -C packages/core diff HEAD~1 --stat",
    "git --no-pager show HEAD:package.json | head -20",
    "git branch -a --list 'dev/*'",
    "git branch --show-current",
    "git tag -l",
    "git remote -v",
    "git stash list",
    "git worktree list",
    "git config --get user.name",
    "ls -la src && cat package.json | wc -l",
    "cd packages/app; ls",
    "rg -n \"TODO|FIXME\" src 2>/dev/null | sort | uniq -c",
    "grep -rn 'a > b' src",
    "LC_ALL=C git log -1 2>&1",
    "/usr/bin/git status",
  ]) {
    await shell(command);
  }

  // Anything with effects is refused, with the way on.
  for (const command of [
    "npm install",
    "yarn typecheck",
    "git switch main",
    "git commit -m x",
    "git push",
    "git fetch",
    "git branch feature/new",
    "git branch -D old",
    "git tag v1.0.0",
    "git stash",
    "git worktree remove ../other",
    "git config user.name x",
    "git -c core.pager=less log",
    "git log --output=out.txt",
    "git log > out.txt",
    "git status; rm -rf build",
    "git status && touch x",
    "git status\nrm x",
    "ls | xargs rm",
    "cat a.txt | tee b.txt",
    "echo hi > file.txt",
    "echo $(rm x)",
    "echo `rm x`",
    "cat < secret",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
    "rg --pre ./run.sh pattern",
    "sed -i s/a/b/ file",
    "find . -delete",
    "yarn dev &",
    "node script.js",
    "",
    "   ",
  ]) {
    await assert.rejects(() => shell(command), /read-only commands only/, `expected a refusal for: ${command}`);
  }
  await assert.rejects(() => shell("npm test"), /Hand it to Fellow with handoff_to_fellow; for a small job give only `summary`/);
  await assert.rejects(() => shell("npm test"), (err) => !/work_directly/.test(err.message));

  // A small job is its summary and nothing else.
  await assert.rejects(() => handoff.execute({ summary: "  " }, asLead), /requires a non-empty summary/);
  const small = await handoff.execute({ summary: "Run `yarn deploy:alpha` in apps/web and report the deployment id." }, asLead);
  assert.match(small.content, /FELLOW MODE ACTIVE/);
  const plan = mock.storage.get("fusion:ses_1").activePlan;
  assert.equal(plan.summary, "Run `yarn deploy:alpha` in apps/web and report the deployment id.");
  assert.deepEqual(plan.steps, [plan.summary]);
  assert.deepEqual(plan.files, []);
  assert.deepEqual(plan.requirements, []);
  assert.deepEqual(plan.checks, []);
  assert.deepEqual(plan.phases, []);
  assert.match(mock.agents.get("fellow").system, /A plan that is only a `summary` is a small job/);
  assert.match(mock.agents.get("lead").system, /A handoff comes in two sizes/);

  // Fellow keeps its whole shell.
  await shell("npm install", "fellow");
  await cleanup?.();

  // With direct work on, the refusal also names the window, and inside a window the shell is whole.
  const direct = createMockOpenCode({ directWork: true });
  const cleanupDirect = await plugin.setup(direct.ctx);
  const beforeDirect = direct.toolBeforeHooks[0];
  await beforeDirect({ tool: "shell", agent: "lead", sessionID: "ses_1", id: "d1", messageID: "dm1", input: { command: "git status" } });
  await assert.rejects(
    () => beforeDirect({ tool: "shell", agent: "lead", sessionID: "ses_1", id: "d2", messageID: "dm2", input: { command: "npm test" } }),
    /call work_directly first/,
  );
  await cleanupDirect?.();
});

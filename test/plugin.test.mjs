import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function createMockOpenCode(givenOptions = {}, mockOpts = {}) {
  // Saved settings are off too (`settingsFile: false`), so a test never reads the settings file of whoever runs it.
  // The mode is called `lead` here so that the agent ids read as the roles; the plugin's own default is `fusion`,
  // which test 16 covers.
  const options = { settingsFile: false, modeName: "lead", fellowName: "fellow", ...givenOptions };
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
  assert.match(returned.content, /Changes since this work began \(1 file\(s\)\)/);
  assert.match(returned.content, /new files: b\.txt/);
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
  assert.match(unrunnable.content, /cwd must be a folder inside the project or one of its worktrees/);
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

test("10. no-progress stop: rounds of planned work that come back unfinished with nothing changed end further handoffs", async () => {
  const dir = tempProject();
  const mock = createMockOpenCode({ maxHandoffsPerTurn: 20, maxStalledReturns: 2 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toExec = mock.tools.get("handoff_to_fellow");
  const toPlan = mock.tools.get("handoff_to_lead");
  const plan = { summary: "Stall", files: [], steps: ["go"], verification: [], replanIf: [], requirements: ["x"] };
  const stalled = () => mock.storage.get("fusion:ses_1").stalledReturns;
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  // One round: the work is handed over, Fellow does `during`, and comes back blocked.
  const round = async (during = () => {}, given = plan) => {
    await toExec.execute(given, { sessionID: "ses_1", agent: "lead" });
    during();
    return toPlan.execute({ reason: "blocked", summary: "stuck" }, { sessionID: "ses_1", agent: "fellow" });
  };

  const first = await round();                       // nothing changed between hand-over and hand-back
  assert.equal(stalled(), 1);
  assert.match(first.content, /changed nothing in the workspace \(1\/2/);

  await round(() => fs.writeFileSync(path.join(dir, "a.txt"), "two\n"));   // an edit is progress
  assert.equal(stalled(), 0);

  // A commit leaves the tree as clean as before the edit, and is still progress.
  await round();
  assert.equal(stalled(), 1);
  await round(() => {
    fs.writeFileSync(path.join(dir, "b.txt"), "new\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "work");
  });
  assert.equal(stalled(), 0);

  // A small job (a lookup, a command to run) changes nothing by nature and is never counted.
  await round();
  assert.equal(stalled(), 1);
  await round(() => {}, { summary: "Look up the ticket and report its status." });
  assert.equal(stalled(), 0);

  await round();
  await round();
  assert.equal(stalled(), 2);
  await assert.rejects(() => toExec.execute(plan, { sessionID: "ses_1", agent: "lead" }), /No progress/);

  // The user's next message starts the count afresh.
  await mock.sessionPromptHooks[0]({ sessionID: "ses_1", prompt: { text: "try another way" } });
  assert.equal(stalled(), 0);
  await toExec.execute(plan, { sessionID: "ses_1", agent: "lead" });

  // The reason is a closed set: a near miss is read as what it means, anything else is refused, so the checks
  // cannot be skipped by a slip of the word.
  const done = await toPlan.execute({ reason: "Done", summary: "ok" }, { sessionID: "ses_1", agent: "fellow" });
  assert.match(done.content, /Return reason: completed/);
  await toExec.execute(plan, { sessionID: "ses_1", agent: "lead" });
  await assert.rejects(() => toPlan.execute({ reason: "all good!", summary: "ok" }, { sessionID: "ses_1", agent: "fellow" }), /unknown reason/);

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
  assert.deepEqual([...mock.agents.keys()], ["fusion", "fellow", "scout"]);
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
  assert.deepEqual([...mock.agents.keys()], ["fusion", "fellow", "scout"]);
  assert.equal(lead().name, "Fusion");
  const restarted = install();
  const cleanupRestarted = await plugin.setup(restarted.ctx);
  assert.deepEqual([...restarted.agents.keys()], ["engineer", "fellow", "scout"]);
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
  assert.deepEqual([...pinned.agents.keys()], ["exam", "worker", "scout"]);
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
  const offered = () => ({ read: {}, edit: {}, handoff_to_fellow: {}, handoff_to_lead: {}, resume_fellow: {}, report_checkpoint: {} });
  const asBuild = { sessionID: "ses_1", agent: "build", model: { providerID: "openai", id: "gpt-6.2-sol" }, system: [], tools: offered() };
  await mock.sessionContextHooks[0](asBuild);
  assert.deepEqual(Object.keys(asBuild.tools), ["read", "edit"]);
  const asFusion = { sessionID: "ses_1", agent: "fusion", model: { providerID: "claude-agent", id: "opus" }, system: [], tools: offered() };
  await mock.sessionContextHooks[0](asFusion);
  assert.equal(Object.keys(asFusion.tools).length, 6);

  await Promise.all([cleanup?.(), cleanupRestarted?.(), cleanupSecond?.(), cleanupPinned?.(), cleanupOff?.()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("17. Lead reads and Fellow acts: read-only shell for Lead, a small job handed over as one sentence", async () => {
  const mock = createMockOpenCode();
  const cleanup = await plugin.setup(mock.ctx);
  const before = mock.toolBeforeHooks[0];
  const handoff = mock.tools.get("handoff_to_fellow");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  let n = 0;
  const shell = (command, agent = "lead") => before({ tool: "shell", agent, sessionID: "ses_1", id: `sh_${(n += 1)}`, messageID: `m_${n}`, input: { command } });

  // The POSIX reading of quotes, as on macOS and Linux.
  const shellBefore = process.env.OPENCODE_FUSION_SHELL;
  process.env.OPENCODE_FUSION_SHELL = "posix";

  // Looking is open to Lead without anything being declared.
  for (const command of [
    "git branch --contains HEAD",
    "sed -n 40,60p package.json",
    "sed -n '1,$p' src/a.ts | head -5",
    "find src -name '*.test.tsx' -type f | head -20",
    "fd config src",
    "git branch -vv",
    "git tag -l 'v*'",
    "git tag -n3",
    "git tag --points-at HEAD",
    "TZ=UTC LC_ALL=C git log -1",
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
    // sed and find only to look.
    "sed -n 'w out.txt' in.txt",
    "sed -n 1,5d file",
    "sed s/a/b/ file",
    "find . -name '*.log' -exec rm {} +",
    "fd -x rm",
    // A name after `branch` or `tag` makes one unless a flag puts the command in list mode.
    "git branch -v topic",
    "git branch --sort=-committerdate topic",
    "git tag -a v1",
    "git tag -a v1 -m release",
    "git tag -n3 v1",
    // A variable in front of a command can name a program to run.
    "GIT_EXTERNAL_DIFF=./x.sh git diff",
    "PAGER=./x.sh git log",
    "GIT_SSH_COMMAND=./x.sh git ls-remote origin",
    // The shell is not a way around the question the read tool asks about these files.
    "cat .env",
    "head -3 config/.env.local",
    "rg SECRET apps/web/production.env",
    "git show HEAD:.env",
    "git help -w log",
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

  // Where the command may reach cmd.exe or PowerShell, quotes mean something else: `'` does not quote in cmd.exe and
  // `\\` does not escape in PowerShell. Anything that depends on the difference is refused there.
  process.env.OPENCODE_FUSION_SHELL = "windows";
  for (const command of ["git log --oneline -5", "git status | head -3", 'rg -n "TODO|FIXME" src', "git branch -a --list 'dev/*'"]) {
    await shell(command);
  }
  for (const command of ["grep -rn 'a > b' src", "echo 'x & del /q *'", 'echo "a\\" > out; rm x"', "type a^.txt"]) {
    await assert.rejects(() => shell(command), /read-only commands only/, `expected a refusal on Windows for: ${command}`);
  }
  if (shellBefore === undefined) delete process.env.OPENCODE_FUSION_SHELL;
  else process.env.OPENCODE_FUSION_SHELL = shellBefore;

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
});

test("18. the scout: lookups run in a child session through the host's subagent tool, on the Fellow's model, without changing the project", async () => {
  const mock = createMockOpenCode({ leadModel: "claude-agent/claude-opus-4-6", fellowModel: "openai/gpt-6.2-sol#high" });
  const cleanup = await plugin.setup(mock.ctx);
  const before = mock.toolBeforeHooks[0];
  const scout = mock.agents.get("scout");
  let n = 0;
  const call = (tool, input, agent = "lead", sessionID = "ses_1") => {
    const event = { tool, agent, sessionID, id: `c_${(n += 1)}`, messageID: `m_${n}`, input };
    return before(event).then(() => event);
  };

  // A third agent, reached only through `subagent`: read-only tools, Code Mode for the tools behind it, no editing.
  assert.equal(scout.mode, "subagent");
  assert.deepEqual(scout.model, { providerID: "openai", id: "gpt-6.2-sol", variant: "high" });
  assert.match(scout.system, /You are the Fusion SCOUT/);
  for (const allowed of ["read", "grep", "glob", "webfetch", "execute", "shell"]) {
    assert.equal(resolvePermissionEffect(scout.permissions, allowed), "allow", `scout should have ${allowed}`);
  }
  for (const denied of ["edit", "write", "patch", "subagent", "handoff_to_fellow", "handoff_to_lead", "todowrite"]) {
    assert.equal(resolvePermissionEffect(scout.permissions, denied), "deny", `scout should not have ${denied}`);
  }
  assert.equal(resolvePermissionEffect(scout.permissions, "read", ".env"), "ask");

  // Lead is told where lookups go, and may start the scout and nothing else.
  const lead = mock.agents.get("lead");
  assert.match(lead.system, /call the `subagent` tool with agent `scout`/);
  assert.match(lead.system, /Say what you did not see\./);
  assert.equal(resolvePermissionEffect(lead.permissions, "subagent"), "allow");
  const started = await call("subagent", { agent: "scout", description: "Read the thread", prompt: "Read the chat thread at X and report who decided what." });
  // It runs on the Fellow's model, and is told where raw material goes.
  assert.equal(started.input.model, "openai/gpt-6.2-sol#high");
  assert.match(started.input.prompt, /^Read the chat thread at X/);
  assert.match(started.input.prompt, /\[Fusion\] Temp folder for raw material.*fusion-scout/);
  await assert.rejects(() => call("subagent", { agent: "general", description: "Do it", prompt: "Implement the change." }), /one kind of subagent only: `scout`/);
  await assert.rejects(() => call("subagent", { description: "Do it", prompt: "Implement the change." }), /one kind of subagent only/);
  // A follow-up to a scout that is already running names its session; the task is left as written.
  const followUp = await call("subagent", { sessionID: "ses_child", prompt: "Also check the linked ticket." });
  assert.equal(followUp.input.prompt, "Also check the linked ticket.");
  assert.equal(followUp.input.model, undefined);

  // The scout's own calls, in its child session: looking is open, changing the repository is not.
  const asScout = (command) => call("shell", { command }, "scout", "ses_child");
  for (const command of [
    "git log --oneline -5",
    "git fetch origin",
    "gh pr view 123 --json title,body",
    "ffmpeg -i clip.mp4 -vf fps=1 /tmp/fusion-scout/f_%03d.png",
    "curl -s https://example.com/status",
    "rg -n TODO src | head -20 > /tmp/fusion-scout/todo.txt",
    "node -e \"console.log(1)\"",
  ]) {
    await asScout(command);
  }
  for (const command of [
    "git commit -am wip",
    "git checkout -B main origin/main",
    "git push",
    "git stash",
    "rm -rf build",
    "mv a.txt b.txt",
    "npm install left-pad",
    "yarn add left-pad",
    "ls && git reset --hard HEAD~1",
  ]) {
    await assert.rejects(() => asScout(command), /The scout does not change the project/, `expected a refusal for: ${command}`);
  }
  // No role state is made for the child session.
  assert.equal(mock.storage.get("fusion:ses_child"), undefined);

  // While Fellow has the session, Lead's tools stay closed, the scout included.
  await mock.tools.get("handoff_to_fellow").execute({ summary: "Run the tests and report." }, { sessionID: "ses_1", agent: "lead" });
  await assert.rejects(() => call("subagent", { agent: "scout", description: "x", prompt: "y" }), /only available in Lead mode/);

  await cleanup?.();
});

test("19. the risk gate: a command that would lose work is stopped when Fellow runs it, judged against the repository as it is", async () => {
  const dir = tempProject();
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  const main = execFileSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8" }).trim();
  // A local branch with two commits that exist nowhere else, as in the case this gate was built for.
  git("checkout", "--quiet", "-b", "alpha");
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dir, `alpha${n}.txt`), `${n}\n`);
    git("add", "-A");
    git("commit", "--quiet", "-m", `alpha work ${n}`);
  }
  git("checkout", "--quiet", main);
  fs.mkdirSync(path.join(dir, "sub"));
  fs.writeFileSync(path.join(dir, "sub", "keep.txt"), "x\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "sub");

  const mock = createMockOpenCode({ maxConsecutiveFailures: 99 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const before = mock.toolBeforeHooks[0];
  const toFellow = mock.tools.get("handoff_to_fellow");
  await toFellow.execute({ summary: "Stack the fix on alpha and push it." }, { sessionID: "ses_1", agent: "lead" });
  let n = 0;
  const run = (command) => before({ tool: "shell", agent: "fellow", sessionID: "ses_1", id: `g_${(n += 1)}`, messageID: `gm_${n}`, input: { command } });
  const state = () => mock.storage.get("fusion:ses_1");

  // Moving an existing branch that holds commits found nowhere else.
  await assert.rejects(() => run(`git checkout -B alpha ${main}`), (err) => {
    assert.match(err.message, /\[FUSION RISK GATE\] Not run/);
    assert.match(err.message, /moves the existing local branch `alpha`/);
    assert.match(err.message, /2 commit\(s\) on it are on no remote/);
    assert.match(err.message, /alpha work 2/);
    assert.match(err.message, /a new branch or a worktree/);
    assert.match(err.message, /Only the user can allow it, by typing `\/fusion-approve`/);
    return true;
  });
  assert.equal(state().pendingRisk.key, "move-branch:alpha");
  await assert.rejects(() => run("git switch -C alpha"), /RISK GATE/);
  await assert.rejects(() => run(`git branch -f alpha ${main}`), /RISK GATE/);
  await assert.rejects(() => run("cd sub && git -C .. checkout -B alpha"), /RISK GATE/);
  await assert.rejects(() => run("git fetch origin; git checkout -B alpha origin/alpha 2>&1 | tail -3"), /RISK GATE/);
  await assert.rejects(() => run("git branch -D alpha"), /deletes the local branch `alpha`, which has 2 commit/);

  // The same commands where nothing would be lost are not the gate's business.
  for (const command of [
    "git checkout -b alpha-fix",              // a new branch
    "git checkout -B fresh",                  // -B on a name that does not exist yet
    "git checkout -B alpha alpha",            // moved to where it already is
    "git checkout alpha",
    "git branch -d alpha",                    // git itself refuses this one when unmerged
    "git reset --hard",                       // nothing uncommitted
    "git clean -n",
    "git clean -fd",                          // nothing untracked
    `git push origin ${main}`,
    "git push --set-upstream origin alpha-fix",
    "yarn test && git status",
  ]) {
    await run(command);
  }

  // Uncommitted changes and unpushed commits under a hard reset.
  fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
  await assert.rejects(() => run("git reset --hard"), /1 file\(s\) have uncommitted changes that would be gone: a\.txt/);
  git("checkout", "--", "a.txt");
  await assert.rejects(() => run("git reset --hard HEAD~1"), /1 commit\(s\) on this branch are on no remote/);

  // Untracked files under a clean.
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine\n");
  await assert.rejects(() => run("git clean -fd"), /deletes 1 untracked file\(s\) or folder\(s\) for good: notes\.txt/);
  await run("git clean -nd");

  // History on a remote.
  for (const command of [`git push --force origin ${main}`, `git push -f`, `git push --force-with-lease origin ${main}`, "git push origin :old-branch", `git push origin +${main}`, "git push --delete origin old-branch"]) {
    await assert.rejects(() => run(command), /rewrites or deletes history on a remote/, `expected the gate for: ${command}`);
  }

  // Only the user lifts it, once, for that one operation.
  const approve = mock.commands.get("fusion-approve");
  await assert.rejects(() => run(`git checkout -B alpha ${main}`), /RISK GATE/);
  await approve.execute({ sessionID: "ses_1" });
  assert.match(mock.syntheticCalls.at(-1).text, /THE USER APPROVED A STOPPED COMMAND/);
  assert.match(mock.syntheticCalls.at(-1).text, /git checkout -B alpha/);
  assert.equal(mock.syntheticCalls.at(-1).resume, true);
  assert.equal(state().approvedRisk, "move-branch:alpha");
  await assert.rejects(() => run("git branch -D alpha"), /RISK GATE/);       // a different operation is still stopped
  assert.equal(state().approvedRisk, "move-branch:alpha");
  await run(`git switch -C alpha ${main}`);                                    // the approved operation, however it is spelt
  assert.equal(state().approvedRisk, undefined);
  await assert.rejects(() => run(`git checkout -B alpha ${main}`), /RISK GATE/); // used up
  await approve.execute({ sessionID: "ses_2" });
  assert.match(mock.syntheticCalls.at(-1).text, /Nothing is waiting for approval/);

  // The plan's checks are run by Fusion itself, so they may only verify; and none is dropped in silence.
  await mock.tools.get("handoff_to_lead").execute({ reason: "blocked", summary: "stopped by the gate" }, { sessionID: "ses_1", agent: "fellow" });
  const plan = (checks) => ({ summary: "Checks", steps: ["go"], checks });
  for (const command of ["git push", "git commit -am done", "rm -rf dist", "npm install", `git checkout -B alpha ${main}`]) {
    await assert.rejects(() => toFellow.execute(plan([{ command }]), { sessionID: "ses_1", agent: "lead" }), /A check only verifies; this one changes something/, `expected a refusal for the check: ${command}`);
  }
  await assert.rejects(
    () => toFellow.execute(plan(Array.from({ length: 9 }, (_, i) => ({ command: `node -e "process.exit(${i})"` }))), { sessionID: "ses_1", agent: "lead" }),
    /Too many checks: at most 8 in one list and 16 in the whole plan \(got 9 in one list, 9 in all\)/,
  );
  await toFellow.execute(plan([{ command: "git diff --exit-code" }, { command: "yarn test" }, PASS]), { sessionID: "ses_1", agent: "lead" });

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("20. evidence with the report: Lead is shown what changed since the work began, commits included, and a phase it asked to see cannot be skipped", async () => {
  const dir = tempProject();
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  // Something already lying in the workspace before the work starts: it is not this round's doing.
  fs.writeFileSync(path.join(dir, "leftover.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\nlocal edit\n");

  const mock = createMockOpenCode();
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const toFellow = mock.tools.get("handoff_to_fellow");
  const toLead = mock.tools.get("handoff_to_lead");
  const checkpoint = mock.tools.get("report_checkpoint");
  const resume = mock.tools.get("resume_fellow");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const asFellow = { sessionID: "ses_1", agent: "fellow" };

  // One undivided round in which Fellow edits, adds a file and commits.
  await toFellow.execute({ summary: "Add the greeting", files: ["greet.js"], steps: ["write it", "commit"] }, asLead);
  fs.writeFileSync(path.join(dir, "greet.js"), "export const greet = (name) => `hello ${name}`;\n");
  git("add", "greet.js");
  git("commit", "--quiet", "-m", "add greet");
  fs.writeFileSync(path.join(dir, "notes.md"), "todo\n");
  const back = await toLead.execute({ reason: "completed", summary: "added and committed" }, asFellow);
  assert.match(back.content, /Changes since this work began \(2 file\(s\), 1 commit\(s\)\):/);
  assert.match(back.content, /commit [0-9a-f]{7,} add greet/);          // a commit is shown, though the tree is clean again
  assert.match(back.content, /greet\.js \| 1 \+/);
  assert.match(back.content, /new files: notes\.md/);
  assert.match(back.content, /The diff:\n[\s\S]*\+export const greet/);   // the change itself is in front of Lead
  assert.doesNotMatch(back.content, /leftover\.json/);                   // what was there before is not repeated
  assert.doesNotMatch(back.content, /local edit/);

  // A round that changes nothing says so.
  await toFellow.execute({ summary: "Check the greeting", steps: ["look"] }, asLead);
  const nothing = await toLead.execute({ reason: "completed", summary: "looked" }, asFellow);
  assert.match(nothing.content, /Changes since this work began: none\./);

  // Phases: each checkpoint shows that phase's changes only, and a long diff is cut with a way to see the rest.
  const phases = [
    { title: "first part", steps: ["a"], checks: [], review: "always" },
    { title: "second part", steps: ["b"], checks: [], review: "always" },
  ];
  await toFellow.execute({ summary: "Two parts", files: ["one.txt", "two.txt"], phases }, asLead);
  fs.writeFileSync(path.join(dir, "one.txt"), "first\n");
  git("add", "one.txt");
  const first = await checkpoint.execute({ done: "wrote one.txt" }, asFellow);
  assert.match(first.content, /CHECKPOINT 1\/2 — LEAD REVIEW/);
  assert.match(first.content, /one\.txt/);
  assert.match(first.content, /The changes above are this phase's/);
  await resume.execute({ decision: "continue" }, asLead);

  fs.writeFileSync(path.join(dir, "two.txt"), `${"a long line of text to fill the preview\n".repeat(200)}`);
  git("add", "two.txt");
  // The second phase is one Lead asked to see: reporting the whole work complete past it is refused.
  await assert.rejects(() => toLead.execute({ reason: "completed", summary: "all done" }, asFellow), /Phase 2 \("second part"\) is one Lead asked to see\. Call `report_checkpoint`/);
  const second = await checkpoint.execute({ done: "wrote two.txt" }, asFellow);
  assert.match(second.content, /two\.txt/);
  assert.doesNotMatch(second.content, /one\.txt/);                       // the first phase's change is not shown again
  assert.match(second.content, /The diff, first 3000 of \d+ characters \(the rest: `git -C \S+ diff [0-9a-f]{10}`\):/);
  assert.ok(second.content.length < 6000, `the checkpoint report stays small (${second.content.length} characters)`);
  await resume.execute({ decision: "continue" }, asLead);
  // The whole round is shown at the end, both phases together. A blocked return is never held up by an unseen phase.
  const done = await toLead.execute({ reason: "completed", summary: "both parts" }, asFellow);
  assert.match(done.content, /one\.txt/);
  assert.match(done.content, /two\.txt/);

  await cleanup?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("21. work in another worktree: the changes, the progress and the risk are judged where the work happens", async () => {
  const dir = tempProject();
  const wt = `${dir}-wt`;
  const other = tempProject();
  const git = (where, ...args) => execFileSync("git", ["-C", where, ...args], { stdio: "ignore" });
  const mock = createMockOpenCode({ maxHandoffsPerTurn: 20 });
  const cleanup = await plugin.setup(mock.ctx);
  mock.sessions.get("ses_1").location = { directory: dir };
  const before = mock.toolBeforeHooks[0];
  const toFellow = mock.tools.get("handoff_to_fellow");
  const toLead = mock.tools.get("handoff_to_lead");
  const asLead = { sessionID: "ses_1", agent: "lead" };
  const asFellow = { sessionID: "ses_1", agent: "fellow" };
  const stalled = () => mock.storage.get("fusion:ses_1").stalledReturns;
  const plan = { summary: "Build the feature on its own branch", files: ["a.txt", "feature.txt"], steps: ["make a worktree", "implement", "commit"] };
  const wtName = path.basename(wt).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let n = 0;
  const shell = (command, workdir) => before({ tool: "shell", agent: "fellow", sessionID: "ses_1", id: `w_${(n += 1)}`, messageID: `wm_${n}`, input: workdir ? { command, workdir } : { command } });

  // Round 1: Fellow makes a worktree next to the session's folder and does all its work there. The session's own
  // folder never changes.
  await toFellow.execute(plan, asLead);
  git(dir, "worktree", "add", "--quiet", "-b", "feat/x", wt, "HEAD");
  fs.writeFileSync(path.join(wt, "a.txt"), "one\nfeature line\n");
  fs.writeFileSync(path.join(wt, "feature.txt"), "new\n");
  git(wt, "add", "-A");
  git(wt, "commit", "--quiet", "-m", "add the feature");
  const first = await toLead.execute({ reason: "completed", summary: "done in the worktree" }, asFellow);
  assert.match(first.content, /Changes since this work began \(2 file\(s\), 1 commit\(s\)\):/);
  assert.match(first.content, new RegExp(`In \\S*${wtName} \\(branch feat/x\\), a worktree made during this work:`));
  assert.match(first.content, /commit [0-9a-f]{7,} add the feature/);
  assert.match(first.content, /\+feature line/);
  assert.equal(stalled(), 0);

  // The plan's checks can run in that worktree, named by its absolute path; a folder that is no part of the work cannot be named.
  await toFellow.execute(
    { ...plan, checks: [{ command: `node -e "process.exit(require('fs').existsSync('feature.txt')?0:1)"`, cwd: wt }, { command: 'node -e "process.exit(0)"', cwd: os.tmpdir() }] },
    asLead,
  );
  const checked = await toLead.execute({ reason: "completed", summary: "checked in the worktree" }, asFellow);
  assert.match(checked.content, /Checks run by Fusion: 1\/2 passed/);
  assert.match(checked.content, /COULD NOT RUN[\s\S]*cwd must be a folder inside the project or one of its worktrees/);

  // Round 2: the worktree is there from the start. Uncommitted work in it is progress, and only this round's change is shown.
  await toFellow.execute(plan, asLead);
  fs.writeFileSync(path.join(wt, "feature.txt"), "new\nsecond round\n");
  const second = await toLead.execute({ reason: "blocked", summary: "half way" }, asFellow);
  assert.equal(stalled(), 0);
  assert.match(second.content, new RegExp(`In \\S*${wtName} \\(branch feat/x\\):`));
  assert.match(second.content, /\+second round/);
  assert.doesNotMatch(second.content, /add the feature/);          // last round's commit is not shown again
  assert.doesNotMatch(second.content, /a worktree made during this work/);

  // Round 3: nothing changes anywhere. That, and only that, is a round without progress.
  await toFellow.execute(plan, asLead);
  const third = await toLead.execute({ reason: "blocked", summary: "stuck" }, asFellow);
  assert.match(third.content, /Changes since this work began: none\./);
  assert.equal(stalled(), 1);

  // The risk gate judges in the folder the command runs in: the worktree has uncommitted work, the session's folder has none.
  await toFellow.execute(plan, asLead);
  await shell("git reset --hard");                                   // in the session's own folder: nothing to lose
  await assert.rejects(() => shell("git reset --hard", wt), /uncommitted changes that would be gone: feature\.txt/);
  await assert.rejects(() => shell(`git -C ${wt.replaceAll("\\", "/")} reset --hard`), /uncommitted changes that would be gone/);

  // Work in a different repository altogether: seen once Fellow runs a command there.
  await shell("git status", other);
  fs.writeFileSync(path.join(other, "elsewhere.txt"), "x\n");
  const fourth = await toLead.execute({ reason: "completed", summary: "also touched the other repository" }, asFellow);
  assert.match(fourth.content, new RegExp(`In \\S*${path.basename(other)}`));
  assert.match(fourth.content, /new files: elsewhere\.txt/);
  assert.doesNotMatch(fourth.content, /second round/);                // what the worktree already held when this round began is not this round's

  // A worktree removed during the work is said so.
  await toFellow.execute(plan, asLead);
  git(dir, "worktree", "remove", "--force", wt);
  const fifth = await toLead.execute({ reason: "completed", summary: "cleaned up" }, asFellow);
  assert.match(fifth.content, new RegExp(`A worktree that was there when this work began is gone: \\S*${wtName}`));

  await cleanup?.();
  for (const folder of [dir, wt, other]) fs.rmSync(folder, { recursive: true, force: true });
});

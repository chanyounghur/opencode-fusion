/**
 * Fusion — the server part.
 *
 * Two models share one OpenCode session: a strong one that reads, plans and reviews (the Lead) and a cheaper one
 * that does the long stretches of editing (the Fellow). OpenCode itself is not changed.
 *
 * Implements:
 * - Strict PLAN-mode upper-bound allowlist permissions (never weakens stricter existing rules) + runtime guards
 * - Role system prompts on agent.system and direct tool exposure via options: { codemode: false }
 * - Lazy role model resolution (handles Location.response wrapper) with 2s cache, availability verification,
 *   and runtime `context` + `execute.before` model-mismatch tool lock
 * - Epoch-fenced state machine with unique messageID step counting, next-step step cap, and Code Mode failure capture
 * - Hybrid switchModel + fail-closed handoffs + per-turn handoff budget (maxHandoffsPerTurn)
 * - Legacy activePlan normalization for RPC backward compatibility
 * - Queue / `>>` / metadata.fusion.route bypass in session.prompt
 * - experimental.idle safety net (waits only for active subagents, not infinite background shells)
 * - Exception-resilient event consumer and hooks
 * - Portable RPC contract `fusion` (getState, forceReturn, setRoleModel, getSettings, setSettings, changed event)
 * - One more mode next to Build and Plan: the Lead agent carries a name of the user's choice (default "Fusion",
 *   agent id `fusion`), the Fellow agent is hidden (`fellow`). Models and the name are chosen in `/fusion-settings`
 *   (the TUI part, `tui.tsx`) and saved in one file per user. Models apply at once, a new name at the next start.
 *   Values given in the configuration win.
 * - Verification gate: the plan's `checks` are run by the plugin itself when Fellow reports completion; failing
 *   checks go straight back to Fellow (no Lead call), and Lead receives real results plus a change summary
 * - Requirement tracking: Lead lists what the user asked for, Fellow reports anything the plan left out
 * - No-progress stop: Fellow rounds that change nothing while checks still fail end further handoffs
 * - Phases and checkpoints: Lead divides the work, Fellow reports at each checkpoint (`report_checkpoint`),
 *   the plugin runs that phase's checks and wakes Lead only when something calls for it; Lead answers with
 *   `resume_fellow` (continue / adjust) instead of writing a whole new plan
 * - Lead reads, plans and reviews; Fellow does every edit and every command with effects. Lead's shell is limited to
 *   read-only commands (git log, ls, grep …). A small job is handed over with nothing but a `summary`.
 * - Direct work (off by default, `directWork: true` switches it on): Lead may make a small, certain change itself instead of handing off.
 *   `work_directly` opens editing and shell inside a budget (files, changed lines, steps), `finish_direct` runs the
 *   checks and closes it. Past the budget edits are refused and the rest goes to Fellow. Also used for a small
 *   correction after Fellow returns.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";

type Role = "lead" | "fellow";

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

interface RoleModels {
  lead?: ModelRef;
  fellow?: ModelRef;
}

interface PlanCheck {
  command: string;
  cwd?: string;
}

interface CheckResult {
  command: string;
  cwd?: string;
  status: "passed" | "failed" | "unrunnable" | "timeout";
  exitCode: number | null;
  seconds: number;
  tail: string;
}

interface PlanPhase {
  title: string;
  steps: string[];
  checks: PlanCheck[];
  // "always": Lead wants to look at this checkpoint whatever happens. "auto": only when something is off.
  review: "always" | "auto";
}

interface ActivePlan {
  summary: string;
  files: string[];
  steps: string[];
  // The same work divided into parts with a checkpoint after each. Empty means one undivided piece of work.
  phases: PlanPhase[];
  // Notes Lead added at checkpoints. They take precedence over the original steps.
  amendments: string[];
  // What Fellow noted at checkpoints without needing an answer (not verified, small incidental fixes).
  checkpointNotes: string[];
  verification: string[];
  replanIf: string[];
  // What the user asked for, item by item, in their words. Lead checks each one off before concluding.
  requirements: string[];
  // Commands the plugin runs itself when Fellow reports completion. Exit code 0 means the check passed.
  checks: PlanCheck[];
  createdAt: string;
}

/** Lead working on the code itself. Open from `work_directly` until `finish_direct`, a handoff, or the next user prompt. */
interface DirectWindow {
  reason: string;
  files: string[];
  requirements: string[];
  checks: PlanCheck[];
  // The changed files when the window opened ("lines:hash" each), so only what Lead changes itself is counted.
  base: Record<string, string>;
  steps: number;
  seen: string[];
  bounces: number;
  // How often Lead replaced the checks of this window (a command that cannot run on this machine).
  checksReplaced: number;
  openedAt: string;
}

interface FusionState {
  sessionID: string;
  role: Role;
  revision: number;
  epoch: number;
  running: boolean;
  handoffsInTurn: number;
  fellowSteps: number;
  seenStepMessageIDs: string[];
  consecutiveFailures: number;
  lastFailedCommand?: string;
  lastNonZeroShellCommand?: string;
  activePlan?: ActivePlan;
  lastReturnReason?: string;
  // How many times this Fellow round was sent back by the verification gate.
  verifyBounces: number;
  // Consecutive Fellow rounds that came back unclean without changing the workspace.
  stalledReturns: number;
  lastWorkHash?: string;
  // The epoch in which Fellow was already asked once to hand back properly after stopping without a tool call.
  idleNudgeEpoch?: number;
  // Which phase Fellow is on (0-based), and how often its checkpoint was sent back by failing checks.
  phaseIndex: number;
  phaseBounces: number;
  // Set while Lead is looking at a checkpoint: the phase it concerns.
  awaitingCheckpoint?: number;
  direct?: DirectWindow;
  // What Lead has done itself since the user's last prompt: windows opened, and the files and lines they changed.
  directWindowsInTurn: number;
  directLinesInTurn: number;
  directFilesInTurn: string[];
  roleModels: RoleModels;
  updatedAt: string;
}

interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

interface PluginOptions {
  leadModel?: string;
  fellowModel?: string;
  maxConsecutiveFailures?: number;
  maxFellowSteps?: number;
  maxHandoffsPerTurn?: number;
  returnOnUserPrompt?: boolean;
  extraLeadTools?: string[];
  // false turns the verification gate off (checks are then only listed for Fellow to run).
  runChecks?: boolean;
  // How many times failing checks may send one Fellow round back before Lead is told.
  verifyRetries?: number;
  checkTimeoutSeconds?: number;
  maxStalledReturns?: number;
  // Changed files outside the plan's `files` (and their folders) beyond this number wake Lead at a checkpoint.
  offPlanFilesLimit?: number;
  // true lets Lead make small changes itself (`work_directly`). Off by default: Lead reads, plans and reviews.
  directWork?: boolean;
  // The budget of direct work per user turn, and per window for steps.
  maxDirectFiles?: number;
  maxDirectLines?: number;
  maxDirectSteps?: number;
  maxDirectWindows?: number;
  // The name of the mode in the mode list. Given here it cannot be changed from `/fusion-settings`.
  modeName?: string;
  // The name of the hidden agent that does the delegated work (default "fellow").
  fellowName?: string;
  // true makes this mode the one OpenCode starts in.
  defaultMode?: boolean;
  // Where the settings chosen in `/fusion-settings` are kept. false ignores saved settings (unattended runs).
  settingsFile?: string | false;
}

// What `/fusion-settings` saves. One file per user, shared by every project and every client of the server.
interface FusionSettings {
  modeName?: string;
  leadModel?: string;
  fellowModel?: string;
  defaultMode?: boolean;
}

const PLUGIN_ID = "fusion";
const DEFAULT_MODE_NAME = "Fusion";
// OpenCode colours a mode by its place in the mode list unless the agent names a colour, and starting in this mode
// moves it to the front of that list. A colour of its own keeps the mode looking the same either way.
const DEFAULT_MODE_COLOR = "#ef6c6c";
const DEFAULT_FELLOW_NAME = "fellow";
const MAX_MODE_NAME_LENGTH = 24;
// OpenCode's own agents. A mode cannot take one of their names.
const RESERVED_AGENT_IDS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);
// Every tool this plugin adds. Other modes (Build, Plan) never see them.
const FUSION_TOOLS = new Set(["handoff_to_fellow", "handoff_to_lead", "resume_fellow", "report_checkpoint", "work_directly", "finish_direct"]);

function defaultSettingsFile(): string {
  const fromEnv = process.env.OPENCODE_FUSION_SETTINGS;
  if (typeof fromEnv === "string" && fromEnv.trim()) return nodePath.resolve(fromEnv.trim());
  return nodePath.join(homedir(), ".opencode", "fusion", "settings.json");
}

// OpenCode's TUI shows an agent under its id (first letter capitalised), so the name of the mode has to be usable as
// an id: Latin letters, digits and dashes, starting with a letter.
function cleanModeName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/\s+/g, "-");
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name) || name.length > MAX_MODE_NAME_LENGTH) return undefined;
  if (RESERVED_AGENT_IDS.has(name.toLowerCase())) return undefined;
  return name;
}

function cleanSettings(raw: unknown): FusionSettings {
  if (!raw || typeof raw !== "object") return {};
  const data = raw as Record<string, unknown>;
  const out: FusionSettings = {};
  const modeName = cleanModeName(data.modeName);
  if (modeName) out.modeName = modeName;
  const lead = parseModelRef(data.leadModel);
  if (lead) out.leadModel = formatModelRef(lead);
  const fellow = parseModelRef(data.fellowModel);
  if (fellow) out.fellowModel = formatModelRef(fellow);
  if (typeof data.defaultMode === "boolean") out.defaultMode = data.defaultMode;
  return out;
}

function readSettingsFile(file: string | undefined): FusionSettings {
  if (!file) return {};
  try {
    return cleanSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    // No file yet, or one that cannot be read: start from nothing rather than refuse to load.
    return {};
  }
}

function writeSettingsFile(file: string, settings: FusionSettings) {
  mkdirSync(nodePath.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

const STORAGE_PREFIX = "fusion:";
const PLAN_INSTRUCTION_KEY = "fusion.plan";
const STATE_INSTRUCTION_KEY = "fusion.state";
// Defaults are the values the plugin was measured with, so an install without options behaves like the measured one.
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 4;
const DEFAULT_MAX_FELLOW_STEPS = 200;
const DEFAULT_MAX_HANDOFFS_PER_TURN = 12;
// The agents' own step limit, set only where the configuration gives none.
const DEFAULT_AGENT_STEPS = 200;
const MAX_SEEN_MESSAGE_IDS = 100;
const DEFAULT_VERIFY_RETRIES = 2;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_STALLED_RETURNS = 2;
const MAX_CHECKS = 8;
const MAX_PHASES = 8;
const DEFAULT_OFF_PLAN_FILES_LIMIT = 5;
const CHECK_TAIL_CHARS = 1500;
const ROLE_MODEL_CACHE_TTL_MS = 2000;
const DEFAULT_MAX_DIRECT_FILES = 8;
const DEFAULT_MAX_DIRECT_LINES = 200;
const DEFAULT_MAX_DIRECT_STEPS = 30;
const DEFAULT_MAX_DIRECT_WINDOWS = 3;
// A window's checks may be replaced this often (a wrong command), so replacing cannot become a way around a failure.
const MAX_DIRECT_CHECK_REPLACEMENTS = 2;
// What `work_directly` opens for Lead. Everything else that changes things stays closed to it.
const DIRECT_TOOLS = new Set(["edit", "write", "patch", "shell"]);
const LEAD_ONLY_TOOLS = new Set(["handoff_to_fellow", "resume_fellow", "work_directly", "finish_direct"]);

const BASE_LEAD_ALLOWLIST = [
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "question",
  "skill",
  "opencode_session_search",
  "opencode_session_read",
  "opencode_worktree_list",
  "opencode_models",
  "handoff_to_fellow",
  "resume_fellow",
] as const;

const FORBIDDEN_EXTRA_LEAD_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "shell",
  "subagent",
  "execute",
  "todowrite",
  "handoff_to_lead",
  "report_checkpoint",
  "opencode_worktree_create",
  "opencode_worktree_remove",
  "opencode_session_move",
  "opencode_session_rename",
  "opencode_move",
  "opencode_rename",
  "experimental_image_generate",
  "experimental_video_generate",
]);

// What Lead may run in the shell without Fellow: commands that only look. This keeps Lead from doing the work itself;
// it is not a sandbox (Lead can already read every file), so the list blocks the plain ways of changing things and
// does not chase every flag of every tool.
const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "pwd", "cd", "cat", "type", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "nl", "column",
  "file", "stat", "du", "tree", "which", "where", "echo", "true", "basename", "dirname", "realpath",
  "grep", "rg", "egrep", "fgrep", "findstr", "diff", "cmp", "jq",
]);
const READ_ONLY_GIT = new Set([
  "log", "show", "status", "diff", "blame", "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "describe",
  "shortlog", "cat-file", "merge-base", "name-rev", "for-each-ref", "show-ref", "show-branch", "grep", "whatchanged",
  "diff-tree", "count-objects", "version", "help",
]);
const GIT_LISTING_FLAG = /^(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--verbose|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column)(=|$)/;

/** A command line cut into its commands (at `|`, `&&`, `||`, `;`, new lines), each as its words. undefined: something this cannot vouch for. */
function splitShellCommands(command: string): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) return undefined;
      else if (quote === '"' && ch === "\\" && next !== undefined) {
        word += next;
        i += 1;
      } else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\" && next !== undefined) {
      word += next;
      inWord = true;
      i += 1;
    } else if (ch === "`" || ch === "<" || (ch === "$" && next === "(")) {
      return undefined;
    } else if (ch === ">") {
      // Only throwing output away or joining the two streams; anything else writes a file.
      const sink = /^>\s*(&1|&2|\/dev\/null|nul)(?=[\s|;&]|$)/i.exec(command.slice(i));
      if (!sink) return undefined;
      if (/^[12]$/.test(word)) {
        word = "";
        inWord = false;
      } else endWord();
      i += sink[0].length - 1;
    } else if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      // A single `&` would leave the command running in the background.
      if (ch === "&" && next !== "&") return undefined;
      if (ch === "&" || (ch === "|" && next === "|")) i += 1;
      endCommand();
    } else if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) return undefined;
  endCommand();
  return commands;
}

function isReadOnlyGit(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const flag = args[i];
    if (flag === "-C" || flag === "--git-dir" || flag === "--work-tree") i += 2;
    else if (flag === "--no-pager" || flag === "-P" || flag === "--no-optional-locks" || /^--(git-dir|work-tree)=/.test(flag)) i += 1;
    // `-c` can name a program to run; anything else before the subcommand is not worth guessing at.
    else return false;
  }
  const sub = args[i];
  if (!sub) return false;
  const rest = args.slice(i + 1);
  if (rest.some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "-O" || arg.startsWith("--open-files-in-pager"))) return false;
  if (READ_ONLY_GIT.has(sub)) return true;
  const positional = rest.filter((arg) => !arg.startsWith("-"));
  const flags = rest.filter((arg) => arg.startsWith("-"));
  const onlyListing = flags.every((flag) => GIT_LISTING_FLAG.test(flag));
  // Without a listing flag, a name after `branch` or `tag` creates one.
  if (sub === "branch" || sub === "tag") return onlyListing && (positional.length === 0 || flags.length > 0);
  if (sub === "remote") return rest.length === 0 || (flags.length === rest.length && onlyListing) || positional[0] === "show" || positional[0] === "get-url";
  if (sub === "stash") return positional[0] === "list" || positional[0] === "show";
  if (sub === "worktree") return positional[0] === "list";
  if (sub === "reflog") return positional.length === 0 || positional[0] === "show";
  if (sub === "config") return flags.some((flag) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(flag)) && !flags.some((flag) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(flag));
  return false;
}

/** true when every command on the line only looks at things. */
function isReadOnlyShell(command: string): boolean {
  if (!command.trim()) return false;
  const commands = splitShellCommands(command);
  if (!commands || commands.length === 0) return false;
  return commands.every((words) => {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    if (i >= words.length) return true;
    const name = words[i].replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.exe$/, "");
    const args = words.slice(i + 1);
    if (name === "git") return isReadOnlyGit(args);
    if (!READ_ONLY_COMMANDS.has(name)) return false;
    // The few listed tools that can write or run something when asked to.
    if ((name === "sort" || name === "tree") && args.some((arg) => arg === "-o" || arg.startsWith("--output"))) return false;
    if (name === "uniq" && args.filter((arg) => !arg.startsWith("-")).length > 1) return false;
    if (name === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return false;
    return true;
  });
}

function rawShellCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const raw = input as Record<string, unknown>;
  return typeof raw.command === "string" ? raw.command : typeof raw.cmd === "string" ? raw.cmd : "";
}

const BENIGN_EXIT_ONE_COMMANDS = new Set([
  "grep",
  "rg",
  "egrep",
  "fgrep",
  "diff",
  "cmp",
  "findstr",
]);

const LEAD_PROMPT = [
  "You are the Fusion LEAD: you read, decide how the work gets done, and review the result. You are the stronger and dearer model; Fellow is the cheaper one that does all the editing and all the running. You never change files or run anything that has effects yourself.",
  "- Inspect with read-only tools (read, glob, grep, webfetch, websearch, question, skill, session read/search, worktree list) and read-only shell commands (git log / status / diff / show / blame / branch --list, ls, cat, head, tail, wc, grep, rg, and pipes between them). Any other shell command is refused.",
  "- Everything else goes to Fellow through `handoff_to_fellow`, however small: edits, installs, builds, tests, dev servers, screenshots, commits, pushes, deploys, pull requests, and lookups that need tools you do not have (Code Mode `execute`, MCP tools such as chat or design search). Never attempt edits, subagents, Code Mode execute, or worktree/session mutations yourself. Do not do a job in pieces through your own tools to avoid a handoff: every step you take rereads the whole conversation at your price.",
  "- A handoff comes in two sizes. Small job (a command or two to run and report, a change of a few lines that you can state exactly, a lookup): give only `summary` — what to do and what to report back, in one to three sentences — plus `checks` when a command can confirm it. Write no steps, files or requirements for a small job. Larger work: give `summary`, target `files`, ordered `steps`, `requirements`, `checks`, `verification` notes and explicit `replanIf` stop conditions.",
  "- `requirements`: list every distinct thing the user asked for, one item each, close to the user's own words. Include asides and half-stated wishes (\"…도 두고\", \"while you're at it\"). When a phrase can be read two ways, keep it and add your reading in parentheses; never drop a request because it is vague. Every item needs a step that delivers it.",
  "- `checks`: the commands Fusion itself runs when Fellow reports completion (type check or build, and the relevant tests). Each entry is one bare command with an optional `cwd` relative to the project root: no commentary, no `cd`, exit code 0 means pass. If dependencies are missing, add a step that installs them rather than leaving a check out. Failing checks go back to Fellow without waking you.",
  "- For each new behaviour that no existing test covers (especially failure paths), include a step that adds a test for it.",
  "- `phases`: divide work that is long, or that rests on a decision which could be wrong, into 2 to 5 phases, each with its own `steps` and `checks`. Put the decision most likely to be wrong in the first phase, so it is looked at before more work is built on it. Mark a phase `review: \"always\"` when you want to see its result yourself whatever happens; leave the others `\"auto\"` and you are woken only if a check fails, Fellow reports a concern or a departure from the plan, or files outside the plan were touched. Small work stays one piece: give `steps` and no `phases`.",
  "- At a checkpoint you get Fellow's report, the check results and what changed. Answer with `resume_fellow`: `continue` to move on, or `adjust` with short notes when this phase needs fixing. Do not rewrite the plan unless the approach itself has to change (then use `handoff_to_fellow`).",
  "- If the code already has something that does the same job, decide in the plan whether to move or extend it, and say so in `steps`; do not leave a second implementation next to the first.",
  "- Keep plans concise: do not repeat specifications or contracts already stated in the user prompt; focus on inspected file paths, concrete architectural decisions, ordering, and non-obvious edge cases.",
  "- When control returns from Fellow (via `handoff_to_lead`, auto-return guardrail, idle catch, or user steering), inspect what changed, review any failure/return reason, and either conclude accurately or issue a revised `handoff_to_fellow`.",
  "- The return message carries Fusion's own check results and a summary of what changed. Trust those over Fellow's description. Before concluding, go through `requirements` one by one against the changes, and look at anything Fellow reported under `missingRequirements`.",
  "- Do not conclude while a check is failing or could not run if another handoff can fix it (missing dependencies, a wrong command). When you do hand off again, put every remaining issue into that one handoff. If something truly cannot be verified here, tell the user exactly what was not verified.",
].join("\n");

/** Lead's prompt when it may also work on the code itself (`directWork: true`). The first three lines (Lead never edits) are replaced. */
function leadPromptFor(direct: boolean, limits: { files: number; lines: number }): string {
  if (!direct) return LEAD_PROMPT;
  const rest = LEAD_PROMPT.split("\n")
    .slice(3)
    .map((line) => line.replace("or issue a revised `handoff_to_fellow`.", "issue a revised `handoff_to_fellow`, or fix a small thing yourself with `work_directly`."));
  return [
    "You are the Fusion LEAD: you read the code, decide how the work gets done, and review the result. You are the stronger and dearer model; Fellow is the cheaper one that does the long stretches of editing.",
    "- Start by reading (read, glob, grep, webfetch, websearch, skill, session read/search, and read-only shell commands such as git log / status / diff, ls, cat, grep). Reading is always open to you. Editing and every other shell command are closed until you call `work_directly`.",
    "- Then choose how the work gets done. A handoff costs a written plan, a model switch and Fellow reading again what you already read, so it only pays when there is real work to hand over. Doing long work yourself spends your tokens on every line.",
    `  - \`work_directly\` (you do it yourself): when, after reading, you already know exactly what to change, it comes to a few places (at most about ${limits.files} files and ${limits.lines} changed lines, tests included), nothing in it is a design decision that could turn out wrong, and a check can confirm it. Also when the task only asks for something written down (a review, a note, an answer in a file). Also for a small correction after Fellow returns (a wrong condition, a missed line, a forgotten file) instead of another handoff.`,
    "  - `handoff_to_fellow`: everything else. Work spread over many files, new modules, anything you would have to explore while writing. When you cannot tell which it is, hand off.",
    "- In `work_directly` give the `reason`, the `files` you will touch, the user's `requirements` and the `checks` that prove the change. Make the change, then call `finish_direct`: Fusion runs the checks and tells you the result. The budget is enforced: past it your edits are refused. If the work turns out bigger than you thought, stop and call `handoff_to_fellow` with a plan that says what you already changed and what remains.",
    "- Never use subagents, Code Mode execute, or worktree/session mutations.",
    ...rest,
  ].join("\n");
}

const FELLOW_PROMPT = [
  "You are the Fusion FELLOW responsible for focused implementation and verification.",
  "- Follow the active `fusion.plan` in instructions strictly; make clean, minimal edits and run the specified `verification` commands.",
  "- A plan that is only a `summary` is a small job: do exactly what it says and nothing more, then hand back with what you did or found. Quote the part of a command's output that answers the question; Lead does not see your tool results, only your hand-back.",
  "- Respect `replanIf` stop conditions and avoid blind retries after repeated failures.",
  "- You MUST finish every execution turn by calling `handoff_to_lead` (`completed`, `blocked`, or `need_replan`) with a concise summary, `changedFiles`, `verification`, and any `blockers` — never end a turn directly with plain text without handing back to Lead.",
  "- When the plan has `phases`, work on one phase at a time. When a phase is done, call `report_checkpoint` and wait for its answer before starting the next: it runs that phase's checks, and either tells you to go on or brings Lead in. The report has three places for remarks, and they are treated differently. `concerns`: a question or choice you need Lead to decide before going on. `deviations`: a departure from the plan that changes what gets built. Either of these brings Lead in, so use them when it matters and only then. `notes`: anything else worth knowing, such as what you could not verify in this environment or a small incidental fix; these are recorded for Lead without interrupting. Do not hide a real doubt in `notes`: a wrong turn carried through three phases costs the whole task. `amendments` in the plan are Lead's later corrections and override the original steps.",
  "- Before editing, reread the user's original request and compare it with the plan's `requirements` and `steps`. If the request asks for something the plan does not cover, carry out the plan anyway and list what is missing under `missingRequirements` when you hand back (use `need_replan` instead if the gap changes the approach).",
  "- When you hand back as `completed`, Fusion runs the plan's `checks` itself. If one fails, the handoff is refused and the output comes back to you: fix the cause and hand back again. Run the checks yourself first. If a check cannot run in this environment or the command itself is wrong, hand back with reason `blocked` and say why instead of retrying.",
].join("\n");

function parseModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return undefined;
  const providerID = trimmed.slice(0, slashIdx).trim();
  const rest = trimmed.slice(slashIdx + 1).trim();
  if (!providerID || !rest) return undefined;
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    const id = rest.slice(0, hashIdx).trim();
    const variant = rest.slice(hashIdx + 1).trim();
    if (!id) return undefined;
    return variant ? { providerID, id, variant } : { providerID, id };
  }
  return { providerID, id: rest };
}

function normalizeModelRef(value: unknown): ModelRef | undefined {
  if (typeof value === "string") return parseModelRef(value);
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const providerID = typeof raw.providerID === "string" ? raw.providerID.trim() : "";
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!providerID || !id) return undefined;
  const variant = typeof raw.variant === "string" && raw.variant.trim() ? raw.variant.trim() : undefined;
  return variant ? { providerID, id, variant } : { providerID, id };
}

function sameModelRef(a?: ModelRef, b?: ModelRef): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? "") === (b.variant ?? "");
}

function formatModelRef(model?: ModelRef): string {
  if (!model) return "(agent default)";
  return model.variant ? `${model.providerID}/${model.id}#${model.variant}` : `${model.providerID}/${model.id}`;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return fallback;
}

function sanitizeExtraLeadTools(extra: unknown): string[] {
  if (!Array.isArray(extra)) return [];
  const out: string[] = [];
  for (const item of extra) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name) continue;
    if (FORBIDDEN_EXTRA_LEAD_TOOLS.has(name)) continue;
    if (name.startsWith("artifact_") || name.startsWith("automation_")) continue;
    out.push(name);
  }
  return out;
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function evaluatePermission(
  rules: readonly PermissionRule[],
  action: string,
  resource = "*",
): "allow" | "deny" | "ask" | undefined {
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const rule = rules[i];
    if (!rule) continue;
    if (wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      return rule.effect;
    }
  }
  return undefined;
}

function buildLeadPermissions(
  allowedTools: Set<string>,
  existingRules: PermissionRule[] = [],
): PermissionRule[] {
  const validExisting = existingRules.filter(
    (rule): rule is PermissionRule =>
      Boolean(rule && typeof rule.action === "string" && typeof rule.resource === "string"),
  );

  // Use PLAN allowlist as an upper bound: never weaken stricter existing deny/ask rules.
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

  for (const action of allowedTools) {
    if (validExisting.length > 0) {
      const hasExplicitHandoffRestriction =
        action !== "handoff_to_fellow" ||
        validExisting.some(
          (r) =>
            r.action !== "*" &&
            wildcardMatch(action, r.action) &&
            r.resource === "*" &&
            r.effect !== "allow",
        );

      if (hasExplicitHandoffRestriction) {
        const existingEffect = evaluatePermission(validExisting, action, "*");
        if (existingEffect === "deny") {
          continue;
        }
        if (existingEffect === "ask") {
          rules.push({ action, resource: "*", effect: "ask" });
          continue;
        }
      }
    }
    rules.push({ action, resource: "*", effect: "allow" });
  }

  const readGloballyDenied = validExisting.length > 0 && evaluatePermission(validExisting, "read", "*") === "deny";
  const tailRules: PermissionRule[] = [];
  const seenTailKeys = new Set<string>();
  const pushTail = (rule: PermissionRule) => {
    const key = `${rule.action}\0${rule.resource}\0${rule.effect}`;
    if (seenTailKeys.has(key)) return;
    seenTailKeys.add(key);
    tailRules.push(rule);
  };

  if (!readGloballyDenied) {
    for (const resource of ["*.env", "*.env.*", ".env", ".env.*"]) {
      pushTail({ action: "read", resource, effect: "ask" });
    }
  }

  // Re-append stricter existing deny/ask rules after defaults so findLast preserves e.g. `read *.env deny` or `skill browser deny`.
  for (const rule of validExisting) {
    if (rule.effect !== "deny" && rule.effect !== "ask") continue;
    if (rule.action === "*" && rule.resource === "*") continue;
    const appliesToAllowed = Array.from(allowedTools).some((tool) => wildcardMatch(tool, rule.action));
    if (appliesToAllowed) {
      pushTail({ action: rule.action, resource: rule.resource, effect: rule.effect });
    }
  }

  return [...rules, ...tailRules];
}

function buildFellowPermissions(existingRules: PermissionRule[] = []): PermissionRule[] {
  const own = new Set(["handoff_to_fellow", "handoff_to_lead", "resume_fellow", "report_checkpoint", "work_directly", "finish_direct"]);
  const filtered = existingRules.filter((rule) => rule && !own.has(rule.action));
  if (filtered.length === 0) {
    filtered.push(
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
    );
  }
  filtered.push(
    { action: "handoff_to_fellow", resource: "*", effect: "deny" },
    { action: "resume_fellow", resource: "*", effect: "deny" },
    { action: "work_directly", resource: "*", effect: "deny" },
    { action: "finish_direct", resource: "*", effect: "deny" },
    { action: "handoff_to_lead", resource: "*", effect: "allow" },
    { action: "report_checkpoint", resource: "*", effect: "allow" },
  );
  return filtered;
}

function extractShellCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const raw = input as Record<string, unknown>;
  const cmd =
    typeof raw.command === "string"
      ? raw.command
      : typeof raw.cmd === "string"
        ? raw.cmd
        : "";
  return cmd.trim().replace(/\s+/g, " ");
}

function isBenignShellExitOne(command: string, state: FusionState): boolean {
  if (!command) return false;
  if (/&&|\|\||;|\n/.test(command)) return false;

  const verificationList = state.activePlan?.verification ?? [];
  const lowerCmd = command.toLowerCase();
  for (const entry of verificationList) {
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    if (lowerCmd.includes(trimmed) || trimmed.includes(lowerCmd)) {
      return false;
    }
  }

  if (state.lastNonZeroShellCommand && state.lastNonZeroShellCommand === command) {
    return false;
  }

  const tokens = command.split(" ");
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx += 1;
  }
  if (idx >= tokens.length) return false;
  const bin = tokens[idx].split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (BENIGN_EXIT_ONE_COMMANDS.has(bin)) return true;
  if (bin === "git" && idx + 1 < tokens.length) {
    const sub = tokens[idx + 1].toLowerCase();
    if (sub === "diff" || sub === "grep") return true;
  }
  return false;
}

function isBackgroundShellResult(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  if (meta.status === "running") return true;
  if (
    typeof meta.shellID === "string" &&
    meta.shellID.length > 0 &&
    meta.exit === undefined &&
    meta.signal === undefined &&
    !meta.timeout &&
    !meta.killed
  ) {
    return true;
  }
  return false;
}

function isCodeModeFailure(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.metadata && typeof result.metadata === "object" && Boolean(result.metadata.error)) {
    return true;
  }
  if (result.output && typeof result.output === "object") {
    if (Boolean(result.output.error)) return true;
    if (result.output.ok === false) return true;
  }
  return false;
}

function appendBannerToResult(result: any, banner: string): boolean {
  if (!result || typeof result !== "object") return false;
  if (typeof result.content === "string") {
    result.content = result.content.length > 0 ? `${result.content}\n\n${banner}` : banner;
    return true;
  }
  if (Array.isArray(result.content)) {
    result.content.push({ type: "text", text: `\n\n${banner}` });
    return true;
  }
  return false;
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((s) => s.trim()).filter(Boolean);
}

function normalizeActivePlan(raw: unknown, fallbackCreatedAt: string): ActivePlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  const steps = sanitizeStringList(obj.steps);
  if (!summary && steps.length === 0) return undefined;
  return {
    summary: summary || "(legacy plan)",
    files: sanitizeStringList(obj.files),
    steps,
    verification: sanitizeStringList(obj.verification),
    replanIf: sanitizeStringList(obj.replanIf),
    requirements: sanitizeStringList(obj.requirements),
    checks: sanitizeChecks(obj.checks),
    phases: sanitizePhases(obj.phases),
    amendments: sanitizeStringList(obj.amendments),
    checkpointNotes: sanitizeStringList(obj.checkpointNotes),
    createdAt: typeof obj.createdAt === "string" && obj.createdAt.trim() ? obj.createdAt.trim() : fallbackCreatedAt,
  };
}

function sanitizePhases(value: unknown): PlanPhase[] {
  if (!Array.isArray(value)) return [];
  const out: PlanPhase[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const steps = sanitizeStringList(raw.steps);
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : steps[0] ?? "";
    if (!title && steps.length === 0) continue;
    out.push({ title, steps, checks: sanitizeChecks(raw.checks), review: raw.review === "always" ? "always" : "auto" });
    if (out.length >= MAX_PHASES) break;
  }
  return out;
}

/** Every check of the plan, the overall ones and each phase's, without repeats. */
function allPlanChecks(plan: ActivePlan | undefined): PlanCheck[] {
  const seen = new Set<string>();
  const out: PlanCheck[] = [];
  for (const check of [...(plan?.checks ?? []), ...(plan?.phases ?? []).flatMap((phase) => phase.checks)]) {
    const key = `${check.cwd ?? ""}\0${check.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(check);
  }
  return out.slice(0, MAX_CHECKS * 2);
}

/** Changed files that the plan did not name: not a planned file, not inside a planned folder, not next to a planned file. */
function offPlanFiles(changed: string[], planned: string[]): string[] {
  const clean = (file: string) => file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const targets = planned.map(clean).filter(Boolean);
  if (targets.length === 0) return [];
  const folders = new Set(targets.map((file) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "")));
  return changed.map(clean).filter((file) => {
    if (targets.includes(file) || targets.some((target) => file.startsWith(`${target}/`))) return false;
    const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    return !folders.has(folder);
  });
}

function describePhase(plan: ActivePlan, index: number): string[] {
  const phase = plan.phases[index];
  if (!phase) return [];
  return [
    `Phase ${index + 1}/${plan.phases.length}: ${phase.title}`,
    ...phase.steps.map((step, i) => `  ${i + 1}. ${step}`),
    phase.checks.length ? `  Checks at this checkpoint: ${phase.checks.map((check) => `${check.cwd ? `(${check.cwd}) ` : ""}${check.command}`).join(" ; ")}` : "",
    ...(plan.amendments.length ? ["Lead's later notes (these override the steps):", ...plan.amendments.map((note) => `  - ${note}`)] : []),
  ].filter(Boolean);
}

function sanitizeChecks(value: unknown): PlanCheck[] {
  if (!Array.isArray(value)) return [];
  const out: PlanCheck[] = [];
  for (const item of value) {
    const raw = typeof item === "string" ? { command: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    const command = typeof raw?.command === "string" ? raw.command.trim() : "";
    if (!command) continue;
    const cwd = typeof raw?.cwd === "string" ? raw.cwd.trim() : "";
    out.push(cwd ? { command, cwd } : { command });
    if (out.length >= MAX_CHECKS) break;
  }
  return out;
}

function killProcessTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Runs one check in the project folder and reports how it ended. Never throws. */
function runCheck(root: string, check: PlanCheck, timeoutMs: number): Promise<CheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const base = { command: check.command, ...(check.cwd ? { cwd: check.cwd } : {}) };
    const finish = (status: CheckResult["status"], exitCode: number | null, text: string) =>
      resolve({ ...base, status, exitCode, seconds: Math.round((Date.now() - started) / 1000), tail: text.trim().slice(-CHECK_TAIL_CHARS) });
    // A check may not leave the project folder.
    const cwd = check.cwd ? `${root}/${check.cwd}`.replace(/\\/g, "/") : root;
    if (check.cwd && (/^([A-Za-z]:|[\\/])/.test(check.cwd) || check.cwd.split(/[\\/]/).includes(".."))) {
      return finish("unrunnable", null, `cwd must be a folder inside the project: ${check.cwd}`);
    }
    let output = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(check.command, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return finish("unrunnable", null, String((error as Error)?.message ?? error));
    }
    const keep = (chunk: unknown) => {
      output = (output + String(chunk)).slice(-CHECK_TAIL_CHARS * 4);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid);
      finish("timeout", null, `${output}\n(stopped after ${Math.round(timeoutMs / 1000)}s)`);
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish("unrunnable", null, `${output}\n${error.message}`);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // "Command not found" is the plan's or the environment's problem, not a defect in the work.
      const notFound = code === 127 || code === 9009 || /is not recognized as an internal or external command|: command not found/i.test(output);
      finish(code === 0 ? "passed" : notFound ? "unrunnable" : "failed", code, output);
    });
  });
}

async function runChecks(root: string, checks: PlanCheck[], timeoutMs: number): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) results.push(await runCheck(root, check, timeoutMs));
  return results;
}

function formatCheckResults(results: CheckResult[], withOutput: (result: CheckResult) => boolean): string[] {
  const label = { passed: "PASS", failed: "FAIL", unrunnable: "COULD NOT RUN", timeout: "TIMED OUT" } as const;
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`- [${label[result.status]}] ${result.cwd ? `(${result.cwd}) ` : ""}${result.command}${result.exitCode !== null && result.status !== "passed" ? ` — exit ${result.exitCode}` : ""} (${result.seconds}s)`);
    if (withOutput(result) && result.tail) lines.push(...result.tail.split("\n").slice(-25).map((line) => `    ${line}`));
  }
  return lines;
}

/** What the workspace looks like now: a short change summary for Lead and a fingerprint to notice rounds that changed nothing. */
function workspaceDigest(root: string): { summary: string[]; hash?: string; files: string[] } {
  const git = (args: string[]) => spawnSync("git", ["-C", root, "-c", "core.quotepath=false", ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0 || typeof status.stdout !== "string") return { summary: [], files: [] };
  const rows = status.stdout.split("\n").filter((line) => line.trim() && !/node_modules\/|opencode\.json$/.test(line));
  const diff = git(["diff", "HEAD"]);
  const stat = git(["diff", "HEAD", "--shortstat"]);
  const hash = createHash("sha1").update(rows.join("\n")).update(typeof diff.stdout === "string" ? diff.stdout : "").digest("hex");
  const summary = rows.length
    ? [`Workspace changes (${rows.length} files${typeof stat.stdout === "string" && stat.stdout.trim() ? `;${stat.stdout.trim().replace(/^\d+ files? changed,?/, "")}` : ""}):`, ...rows.slice(0, 40).map((line) => `  ${line}`), ...(rows.length > 40 ? [`  … ${rows.length - 40} more`] : [])]
    : ["Workspace changes: none"];
  return { summary, hash, files: rows.map((line) => line.slice(3).trim().replace(/^"|"$/g, "")) };
}

/**
 * The changed files of the workspace, each as "lines:hash": lines changed against HEAD (for a new file, its length)
 * and a fingerprint of its content. Two of these, taken at different times, show what was changed in between.
 */
function measureWork(root: string): Record<string, string> | undefined {
  const git = (args: string[]) => spawnSync("git", ["-C", root, "-c", "core.quotepath=false", ...args], { encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0 || typeof status.stdout !== "string") return undefined;
  const counted = new Map<string, number>();
  const numstat = git(["diff", "HEAD", "--numstat"]);
  for (const line of (typeof numstat.stdout === "string" ? numstat.stdout : "").split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match) counted.set(match[3].trim().replace(/^"|"$/g, ""), (match[1] === "-" ? 0 : Number(match[1])) + (match[2] === "-" ? 0 : Number(match[2])));
  }
  const out: Record<string, string> = {};
  for (const row of status.stdout.split("\n")) {
    if (!row.trim() || /node_modules\/|opencode\.json$/.test(row)) continue;
    const file = row.slice(3).trim().replace(/^.* -> /, "").replace(/^"|"$/g, "");
    let lines = counted.get(file) ?? 1;
    let mark = "gone";
    try {
      const full = `${root}/${file}`;
      const info = statSync(full);
      if (info.size > 2_000_000) mark = `big${info.size}`;
      else {
        const body = readFileSync(full);
        mark = createHash("sha1").update(body).digest("hex").slice(0, 12);
        if (row.startsWith("??")) {
          const text = body.toString("utf8");
          lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
        }
      }
    } catch {
      // deleted, or a folder: the status row alone says it changed
    }
    out[file] = `${lines}:${mark}`;
  }
  return out;
}

/** Files that differ between two measurements, and roughly how many lines (an in-place rewrite counts as one). */
function directUsage(base: Record<string, string>, now: Record<string, string>): { files: string[]; lines: number } {
  const files: string[] = [];
  let lines = 0;
  for (const file of new Set([...Object.keys(base), ...Object.keys(now)])) {
    if (base[file] === now[file]) continue;
    const count = (value: string | undefined) => (value ? Number(value.split(":")[0]) || 0 : 0);
    files.push(file);
    lines += Math.max(1, Math.abs(count(now[file]) - count(base[file])));
  }
  return { files, lines };
}

/** The state after a direct window closes: what it changed is added to the turn's total. */
function closeDirectWindow(state: FusionState, usage: { files: string[]; lines: number }): FusionState {
  const next: FusionState = {
    ...state,
    directLinesInTurn: state.directLinesInTurn + usage.lines,
    directFilesInTurn: [...new Set([...state.directFilesInTurn, ...usage.files])].slice(0, 200),
    revision: state.revision + 1,
  };
  delete next.direct;
  return next;
}

function normalizeDirectWindow(raw: unknown): DirectWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const base: Record<string, string> = {};
  if (obj.base && typeof obj.base === "object") {
    for (const [file, value] of Object.entries(obj.base as Record<string, unknown>)) if (typeof value === "string") base[file] = value;
  }
  return {
    reason: typeof obj.reason === "string" ? obj.reason : "",
    files: sanitizeStringList(obj.files),
    requirements: sanitizeStringList(obj.requirements),
    checks: sanitizeChecks(obj.checks),
    base,
    steps: typeof obj.steps === "number" && obj.steps >= 0 ? obj.steps : 0,
    seen: sanitizeStringList(obj.seen).slice(-60),
    bounces: typeof obj.bounces === "number" && obj.bounces >= 0 ? obj.bounces : 0,
    checksReplaced: typeof obj.checksReplaced === "number" && obj.checksReplaced >= 0 ? obj.checksReplaced : 0,
    openedAt: typeof obj.openedAt === "string" ? obj.openedAt : new Date().toISOString(),
  };
}

function callKey(sessionID: string, callID: string): string {
  return `${sessionID}\0${callID}`;
}

function buildAutoReturnBanner(reason: string, details: string[]): string {
  return [
    `[FUSION AUTO-RETURN TO LEAD]`,
    `Reason: ${reason}`,
    ...details,
    `Control has switched back to \`lead\`. Inspect the error/diff above, diagnose the root cause, and either resolve with the user or issue a revised \`handoff_to_fellow\`.`,
  ].join("\n");
}

function stripOptional<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

const MODEL_REF_SCHEMA = {
  type: "object",
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerID", "id"],
  additionalProperties: false,
} as const;

const ACTIVE_PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    replanIf: { type: "array", items: { type: "string" } },
    requirements: { type: "array", items: { type: "string" } },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: { command: { type: "string" }, cwd: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    phases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
          checks: {
            type: "array",
            items: {
              type: "object",
              properties: { command: { type: "string" }, cwd: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            },
          },
          review: { type: "string" },
        },
        required: ["title", "steps", "checks", "review"],
        additionalProperties: false,
      },
    },
    amendments: { type: "array", items: { type: "string" } },
    checkpointNotes: { type: "array", items: { type: "string" } },
    createdAt: { type: "string" },
  },
  required: ["summary", "files", "steps", "verification", "replanIf", "createdAt"],
  additionalProperties: false,
} as const;

const RPC_SETTINGS_VALUES_SCHEMA = {
  type: "object",
  properties: {
    modeName: { type: "string" },
    leadModel: { type: "string" },
    fellowModel: { type: "string" },
    defaultMode: { type: "boolean" },
  },
  required: ["modeName", "leadModel", "fellowModel", "defaultMode"],
  additionalProperties: false,
} as const;

const RPC_SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    settingsFile: { type: "string" },
    saved: RPC_SETTINGS_VALUES_SCHEMA,
    effective: RPC_SETTINGS_VALUES_SCHEMA,
    pinned: {
      type: "object",
      properties: {
        modeName: { type: "boolean" },
        leadModel: { type: "string" },
        fellowModel: { type: "string" },
        defaultMode: { type: "boolean" },
        all: { type: "boolean" },
      },
      required: ["modeName", "leadModel", "fellowModel", "defaultMode", "all"],
      additionalProperties: false,
    },
    models: {
      type: "array",
      items: {
        type: "object",
        properties: {
          providerID: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          variants: { type: "array", items: { type: "string" } },
        },
        required: ["providerID", "id", "name", "variants"],
        additionalProperties: false,
      },
    },
    agents: {
      type: "object",
      properties: { lead: { type: "string" }, fellow: { type: "string" } },
      required: ["lead", "fellow"],
      additionalProperties: false,
    },
    restartNeeded: { type: "boolean" },
    error: { type: "string" },
  },
  required: ["settingsFile", "saved", "effective", "pinned", "models", "agents", "restartNeeded", "error"],
  additionalProperties: false,
} as const;

const RPC_STATE_SCHEMA = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    role: { type: "string" },
    revision: { type: "number" },
    epoch: { type: "number" },
    running: { type: "boolean" },
    handoffsInTurn: { type: "number" },
    fellowSteps: { type: "number" },
    consecutiveFailures: { type: "number" },
    lastReturnReason: { type: "string" },
    activePlan: ACTIVE_PLAN_SCHEMA,
    roleModels: {
      type: "object",
      properties: {
        lead: MODEL_REF_SCHEMA,
        fellow: MODEL_REF_SCHEMA,
      },
      additionalProperties: false,
    },
    updatedAt: { type: "string" },
  },
  required: [
    "sessionID",
    "role",
    "revision",
    "epoch",
    "running",
    "handoffsInTurn",
    "fellowSteps",
    "consecutiveFailures",
    "roleModels",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

function toRpcSnapshot(state: FusionState) {
  const normalizedPlan = normalizeActivePlan(state.activePlan, state.updatedAt);
  return stripOptional({
    sessionID: state.sessionID,
    role: state.role,
    revision: state.revision,
    epoch: state.epoch,
    running: state.running,
    handoffsInTurn: state.handoffsInTurn,
    fellowSteps: state.fellowSteps,
    consecutiveFailures: state.consecutiveFailures,
    lastReturnReason: state.lastReturnReason,
    activePlan: normalizedPlan,
    roleModels: stripOptional({
      lead: state.roleModels.lead,
      fellow: state.roleModels.fellow,
    }),
    updatedAt: state.updatedAt,
  });
}

export default {
  id: PLUGIN_ID,
  async setup(ctx: any) {
    const rawOptions: PluginOptions = (ctx.options ?? {}) as PluginOptions;
    // Saved settings fill in whatever the configuration leaves open; a value given in the configuration wins.
    const settingsFile =
      rawOptions.settingsFile === false
        ? undefined
        : typeof rawOptions.settingsFile === "string" && rawOptions.settingsFile.trim()
          ? nodePath.resolve(rawOptions.settingsFile.trim())
          : defaultSettingsFile();
    let settings: FusionSettings = readSettingsFile(settingsFile);
    const optionModeName = cleanModeName(rawOptions.modeName);
    const optionDefaultMode = typeof rawOptions.defaultMode === "boolean" ? rawOptions.defaultMode : undefined;
    // The two agents' ids, fixed for the life of this server (sessions refer to them): the mode's name in lower case
    // and the Fellow's. A name saved later from `/fusion-settings` is used from the next start.
    const fellowAgentID = (cleanModeName(rawOptions.fellowName) ?? DEFAULT_FELLOW_NAME).toLowerCase();
    const savedModeNameAtStart = cleanModeName(settings.modeName);
    const modeNameInForce =
      [optionModeName, savedModeNameAtStart, DEFAULT_MODE_NAME].find(
        (name): name is string => typeof name === "string" && name.toLowerCase() !== fellowAgentID,
      ) ?? "Lead";
    const AGENT: Record<Role, string> = { lead: modeNameInForce.toLowerCase(), fellow: fellowAgentID };
    // The saved model this plugin last put on each agent, so a later rebuild does not mistake it for configuration.
    const appliedModel: RoleModels = {};
    const maxConsecutiveFailures = normalizePositiveInt(
      rawOptions.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    );
    const maxFellowSteps = normalizePositiveInt(
      rawOptions.maxFellowSteps,
      DEFAULT_MAX_FELLOW_STEPS,
    );
    const maxHandoffsPerTurn = normalizePositiveInt(
      rawOptions.maxHandoffsPerTurn,
      DEFAULT_MAX_HANDOFFS_PER_TURN,
    );
    const returnOnUserPrompt = rawOptions.returnOnUserPrompt !== false;
    const gateEnabled = rawOptions.runChecks !== false;
    const verifyRetries = normalizePositiveInt(rawOptions.verifyRetries, DEFAULT_VERIFY_RETRIES);
    const checkTimeoutMs = normalizePositiveInt(rawOptions.checkTimeoutSeconds, DEFAULT_CHECK_TIMEOUT_SECONDS) * 1000;
    const maxStalledReturns = normalizePositiveInt(rawOptions.maxStalledReturns, DEFAULT_MAX_STALLED_RETURNS);
    const offPlanFilesLimit = normalizePositiveInt(rawOptions.offPlanFilesLimit, DEFAULT_OFF_PLAN_FILES_LIMIT);
    // Off unless switched on: Lead reads, plans and reviews, and Fellow does the editing and running.
    const directEnabled = rawOptions.directWork === true;
    const maxDirectFiles = normalizePositiveInt(rawOptions.maxDirectFiles, DEFAULT_MAX_DIRECT_FILES);
    const maxDirectLines = normalizePositiveInt(rawOptions.maxDirectLines, DEFAULT_MAX_DIRECT_LINES);
    const maxDirectSteps = normalizePositiveInt(rawOptions.maxDirectSteps, DEFAULT_MAX_DIRECT_STEPS);
    const maxDirectWindows = normalizePositiveInt(rawOptions.maxDirectWindows, DEFAULT_MAX_DIRECT_WINDOWS);
    const optionLeadModel = parseModelRef(rawOptions.leadModel);
    const optionFellowModel = parseModelRef(rawOptions.fellowModel);

    const leadAllowedTools = new Set<string>([
      ...BASE_LEAD_ALLOWLIST,
      ...sanitizeExtraLeadTools(rawOptions.extraLeadTools),
      ...(directEnabled ? ["work_directly", "finish_direct"] : []),
    ]);
    // The agent's own rules must let these tools through; whether a call may run is decided per call, in
    // `execute.before`: the shell for read-only commands, the editing tools only inside an open direct window and
    // inside the budget.
    const leadPermissionTools = new Set<string>([...leadAllowedTools, "shell", ...(directEnabled ? DIRECT_TOOLS : [])]);

    const sessionLocks = new Map<string, Promise<void>>();
    const inFlightCallEpoch = new Map<string, number>();
    const activeExecuteCalls = new Map<string, Set<string>>();
    const modelMismatchBySession = new Map<
      string,
      { expected: ModelRef; actual: ModelRef; epoch: number }
    >();

    function withSessionLock<T>(sessionID: string, fn: () => Promise<T>): Promise<T> {
      const prev = sessionLocks.get(sessionID) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(fn);
      const tail = next.then(
        () => {
          if (sessionLocks.get(sessionID) === tail) sessionLocks.delete(sessionID);
        },
        () => {
          if (sessionLocks.get(sessionID) === tail) sessionLocks.delete(sessionID);
        },
      );
      sessionLocks.set(sessionID, tail);
      return next;
    }

    // Runs again on every `ctx.agent.reload()`, so a change saved from `/fusion-settings` shows without a restart.
    await ctx.agent.transform((editor: any) => {
      if (optionDefaultMode ?? settings.defaultMode ?? false) editor.default(AGENT.lead);

      editor.update(AGENT.lead, (agent: any) => {
        agent.mode = "primary";
        agent.hidden = false;
        // The mode as the user sees it, next to Build and Plan.
        agent.name = modeNameInForce;
        // A colour given in the configuration (`agents.<mode>.color`) is kept.
        if (agent.color === undefined) agent.color = DEFAULT_MODE_COLOR;
        if (agent.steps === undefined) agent.steps = DEFAULT_AGENT_STEPS;
        agent.description = directEnabled
          ? "Architect/Reviewer Lead: makes small, certain changes itself (work_directly) and hands larger work off via handoff_to_fellow."
          : "Read-only Architect/Reviewer Lead that designs verified steps and hands off via handoff_to_fellow.";
        const leadPrompt = leadPromptFor(directEnabled, { files: maxDirectFiles, lines: maxDirectLines });
        if (!String(agent.system ?? "").includes(leadPrompt)) {
          agent.system = agent.system ? `${agent.system}\n\n${leadPrompt}` : leadPrompt;
        }
        const savedLead = parseModelRef(settings.leadModel);
        // A model the configuration put on the agent is left alone (OpenCode may also apply it after this runs).
        if (optionLeadModel) {
          agent.model = optionLeadModel;
        } else if (!normalizeModelRef(agent.model) || sameModelRef(normalizeModelRef(agent.model), appliedModel.lead)) {
          appliedModel.lead = savedLead;
          if (savedLead) agent.model = savedLead;
          else delete agent.model;
        }
        agent.permissions = buildLeadPermissions(
          leadPermissionTools,
          Array.isArray(agent.permissions) ? agent.permissions : [],
        );
      });

      editor.update(AGENT.fellow, (agent: any) => {
        agent.mode = "primary";
        // The Fellow is reached through a handoff, never picked by hand, so it stays out of the mode list.
        agent.hidden = true;
        agent.name = AGENT.fellow.charAt(0).toUpperCase() + AGENT.fellow.slice(1);
        if (agent.steps === undefined) agent.steps = DEFAULT_AGENT_STEPS;
        agent.description =
          "Implementation Fellow that carries out the active plan and returns control via handoff_to_lead.";
        if (!String(agent.system ?? "").includes(FELLOW_PROMPT)) {
          agent.system = agent.system ? `${agent.system}\n\n${FELLOW_PROMPT}` : FELLOW_PROMPT;
        }
        const savedFellow = parseModelRef(settings.fellowModel);
        if (optionFellowModel) {
          agent.model = optionFellowModel;
        } else if (!normalizeModelRef(agent.model) || sameModelRef(normalizeModelRef(agent.model), appliedModel.fellow)) {
          appliedModel.fellow = savedFellow;
          if (savedFellow) agent.model = savedFellow;
          else delete agent.model;
        }
        agent.permissions = buildFellowPermissions(
          Array.isArray(agent.permissions) ? agent.permissions : [],
        );
      });
    });

    let cachedConfiguredRoleModels: { value: RoleModels; expiresAt: number } | undefined;

    async function resolveConfiguredRoleModels(forceRefresh = false): Promise<RoleModels> {
      const now = Date.now();
      if (
        !forceRefresh &&
        cachedConfiguredRoleModels &&
        now < cachedConfiguredRoleModels.expiresAt &&
        (cachedConfiguredRoleModels.value.lead || cachedConfiguredRoleModels.value.fellow)
      ) {
        return cachedConfiguredRoleModels.value;
      }

      const [leadRes, fellowRes] = await Promise.all([
        ctx.agent.get({ agentID: AGENT.lead }).catch(() => undefined),
        ctx.agent.get({ agentID: AGENT.fellow }).catch(() => undefined),
      ]);
      const leadAgentInfo = leadRes?.data ?? leadRes;
      const fellowAgentInfo = fellowRes?.data ?? fellowRes;
      const resolved = stripOptional({
        lead: optionLeadModel ?? normalizeModelRef(leadAgentInfo?.model) ?? parseModelRef(settings.leadModel),
        fellow: optionFellowModel ?? normalizeModelRef(fellowAgentInfo?.model) ?? parseModelRef(settings.fellowModel),
      });
      if (resolved.lead || resolved.fellow) {
        cachedConfiguredRoleModels = { value: resolved, expiresAt: now + ROLE_MODEL_CACHE_TTL_MS };
      } else {
        cachedConfiguredRoleModels = undefined;
      }
      return resolved;
    }

    async function isModelAvailable(target: ModelRef): Promise<boolean> {
      if (!ctx.model?.list) return true;
      const res = await ctx.model.list().catch(() => undefined);
      if (!res) return false;
      const list = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
      return list.some((m: any) => m && m.providerID === target.providerID && m.id === target.id);
    }

    let rpcRegistration: any = undefined;

    function defaultState(
      sessionID: string,
      configuredRoleModels: RoleModels,
      initialRole: Role = "lead",
    ): FusionState {
      return {
        sessionID,
        role: initialRole,
        revision: 1,
        epoch: 1,
        running: false,
        handoffsInTurn: 0,
        fellowSteps: 0,
        seenStepMessageIDs: [],
        consecutiveFailures: 0,
        verifyBounces: 0,
        stalledReturns: 0,
        phaseIndex: 0,
        phaseBounces: 0,
        directWindowsInTurn: 0,
        directLinesInTurn: 0,
        directFilesInTurn: [],
        roleModels: stripOptional({
          lead: configuredRoleModels.lead,
          fellow: configuredRoleModels.fellow,
        }),
        updatedAt: new Date().toISOString(),
      };
    }

    function normalizeLoadedState(
      sessionID: string,
      raw: unknown,
      configuredRoleModels: RoleModels,
      sesAgent?: string,
    ): FusionState {
      const inferredRole: Role = sesAgent === AGENT.fellow ? "fellow" : "lead";
      if (!raw || typeof raw !== "object") {
        return defaultState(sessionID, configuredRoleModels, inferredRole);
      }
      const data = raw as Partial<FusionState>;
      const storedRoleModels = data.roleModels ?? {};
      const updatedAt = typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString();
      const activePlan = normalizeActivePlan(data.activePlan, updatedAt);
      return {
        sessionID,
        role: data.role === "fellow" || data.role === "lead" ? data.role : inferredRole,
        revision: typeof data.revision === "number" && data.revision >= 1 ? data.revision : 1,
        epoch: typeof data.epoch === "number" && data.epoch >= 1 ? data.epoch : 1,
        running: Boolean(data.running),
        handoffsInTurn:
          typeof data.handoffsInTurn === "number" && data.handoffsInTurn >= 0 ? data.handoffsInTurn : 0,
        fellowSteps: typeof data.fellowSteps === "number" && data.fellowSteps >= 0 ? data.fellowSteps : 0,
        seenStepMessageIDs: Array.isArray(data.seenStepMessageIDs)
          ? data.seenStepMessageIDs.filter((id): id is string => typeof id === "string").slice(-MAX_SEEN_MESSAGE_IDS)
          : [],
        consecutiveFailures:
          typeof data.consecutiveFailures === "number" && data.consecutiveFailures >= 0 ? data.consecutiveFailures : 0,
        ...(typeof data.lastFailedCommand === "string" ? { lastFailedCommand: data.lastFailedCommand } : {}),
        ...(typeof data.lastNonZeroShellCommand === "string"
          ? { lastNonZeroShellCommand: data.lastNonZeroShellCommand }
          : {}),
        ...(activePlan ? { activePlan } : {}),
        ...(typeof data.lastReturnReason === "string" ? { lastReturnReason: data.lastReturnReason } : {}),
        verifyBounces: typeof data.verifyBounces === "number" && data.verifyBounces >= 0 ? data.verifyBounces : 0,
        stalledReturns: typeof data.stalledReturns === "number" && data.stalledReturns >= 0 ? data.stalledReturns : 0,
        ...(typeof data.lastWorkHash === "string" ? { lastWorkHash: data.lastWorkHash } : {}),
        ...(typeof data.idleNudgeEpoch === "number" ? { idleNudgeEpoch: data.idleNudgeEpoch } : {}),
        phaseIndex: typeof data.phaseIndex === "number" && data.phaseIndex >= 0 ? data.phaseIndex : 0,
        phaseBounces: typeof data.phaseBounces === "number" && data.phaseBounces >= 0 ? data.phaseBounces : 0,
        ...(typeof data.awaitingCheckpoint === "number" ? { awaitingCheckpoint: data.awaitingCheckpoint } : {}),
        ...(normalizeDirectWindow(data.direct) ? { direct: normalizeDirectWindow(data.direct) } : {}),
        directWindowsInTurn: typeof data.directWindowsInTurn === "number" && data.directWindowsInTurn >= 0 ? data.directWindowsInTurn : 0,
        directLinesInTurn: typeof data.directLinesInTurn === "number" && data.directLinesInTurn >= 0 ? data.directLinesInTurn : 0,
        directFilesInTurn: sanitizeStringList(data.directFilesInTurn),
        roleModels: stripOptional({
          lead: normalizeModelRef(storedRoleModels.lead) ?? configuredRoleModels.lead,
          fellow: normalizeModelRef(storedRoleModels.fellow) ?? configuredRoleModels.fellow,
        }),
        updatedAt,
      };
    }

    async function loadState(
      sessionID: string,
      options?: { fallbackAgent?: string; refreshModels?: boolean },
    ): Promise<FusionState> {
      const [stored, ses, configuredRoleModels] = await Promise.all([
        ctx.storage.get(`${STORAGE_PREFIX}${sessionID}`),
        ctx.session.get({ sessionID }).catch(() => undefined),
        resolveConfiguredRoleModels(Boolean(options?.refreshModels)),
      ]);
      const fallback = stored ? ses?.agent : options?.fallbackAgent ?? ses?.agent;
      const state = normalizeLoadedState(sessionID, stored, configuredRoleModels, fallback);
      if (ses?.model && !state.roleModels[state.role]) {
        const currentModel = normalizeModelRef(ses.model);
        if (currentModel) state.roleModels[state.role] = currentModel;
      }
      return state;
    }

    async function saveState(state: FusionState, options?: { emit?: boolean }) {
      state.updatedAt = new Date().toISOString();
      await ctx.storage.set(`${STORAGE_PREFIX}${state.sessionID}`, state);
      if (options?.emit !== false && rpcRegistration?.events?.emit) {
        await rpcRegistration.events
          .emit("changed", {
            sessionID: state.sessionID,
            revision: state.revision,
            epoch: state.epoch,
            role: state.role,
          })
          .catch(() => undefined);
      }
    }

    async function syncInstructionsOnTransition(
      state: FusionState,
      opts?: { writePlan?: boolean; clearPlan?: boolean },
    ) {
      await ctx.session.instructions.entry
        .put({
          sessionID: state.sessionID,
          key: STATE_INSTRUCTION_KEY,
          value: {
            role: state.role,
            epoch: state.epoch,
            lastReturnReason: state.lastReturnReason ?? null,
          },
        })
        .catch(() => undefined);
      if (opts?.clearPlan) {
        await ctx.session.instructions.entry
          .remove({
            sessionID: state.sessionID,
            key: PLAN_INSTRUCTION_KEY,
          })
          .catch(() => undefined);
      } else if (opts?.writePlan && state.activePlan) {
        await ctx.session.instructions.entry
          .put({
            sessionID: state.sessionID,
            key: PLAN_INSTRUCTION_KEY,
            value: state.activePlan,
          })
          .catch(() => undefined);
      }
    }

    async function switchRole(params: {
      sessionID: string;
      state: FusionState;
      targetRole: Role;
      reason?: string;
      activePlan?: ActivePlan;
      incrementHandoffs?: boolean;
    }): Promise<FusionState> {
      const { sessionID, state, targetRole, reason, activePlan, incrementHandoffs } = params;
      const [ses, configuredRoleModels] = await Promise.all([
        ctx.session.get({ sessionID }),
        resolveConfiguredRoleModels(true),
      ]);
      const stickySessionModel = normalizeModelRef(ses?.model);
      const resolvedTargetModel = state.roleModels[targetRole] ?? configuredRoleModels[targetRole];

      if (targetRole === "fellow" && resolvedTargetModel) {
        const available = await isModelAvailable(resolvedTargetModel);
        if (!available) {
          throw new Error(
            `Fail-closed handoff aborted: configured model ${formatModelRef(resolvedTargetModel)} for "${targetRole}" is currently unavailable.`,
          );
        }
      }

      const hasCustomOverride = Boolean(
        resolvedTargetModel && !sameModelRef(resolvedTargetModel, configuredRoleModels[targetRole]),
      );

      // Fail closed BEFORE mutating state/agent if sticky override exists or custom model must be applied.
      if (stickySessionModel) {
        if (!resolvedTargetModel) {
          throw new Error(
            `Fail-closed handoff aborted: session "${sessionID}" has sticky model ${formatModelRef(stickySessionModel)}, and no target model could be resolved for "${targetRole}". Tell the user to choose it with /fusion-settings.`,
          );
        }
        if (!sameModelRef(stickySessionModel, resolvedTargetModel)) {
          await ctx.session.switchModel({ sessionID, model: resolvedTargetModel });
        }
      } else if (hasCustomOverride && resolvedTargetModel) {
        await ctx.session.switchModel({ sessionID, model: resolvedTargetModel });
      }

      if (ses?.agent !== AGENT[targetRole]) {
        await ctx.session.switchAgent({ sessionID, agent: AGENT[targetRole] });
      }

      const roleChanged = state.role !== targetRole;
      const completedClear = targetRole === "lead" && reason === "completed";
      const next: FusionState = {
        ...state,
        role: targetRole,
        revision: state.revision + 1,
        epoch: roleChanged ? state.epoch + 1 : state.epoch,
        handoffsInTurn: incrementHandoffs ? state.handoffsInTurn + 1 : state.handoffsInTurn,
        ...(targetRole === "fellow"
          ? {
              fellowSteps: 0,
              seenStepMessageIDs: [],
              consecutiveFailures: 0,
              verifyBounces: 0,
              lastFailedCommand: undefined,
              lastNonZeroShellCommand: undefined,
              ...(activePlan ? { activePlan } : {}),
            }
          : {
              ...(reason !== undefined ? { lastReturnReason: reason } : {}),
            }),
      };
      if (completedClear) {
        delete next.activePlan;
      }

      modelMismatchBySession.delete(sessionID);
      await saveState(next);
      if (roleChanged || (targetRole === "fellow" && activePlan) || reason !== undefined || completedClear) {
        await syncInstructionsOnTransition(next, {
          writePlan: targetRole === "fellow" && Boolean(activePlan),
          clearPlan: completedClear,
        });
      }
      return next;
    }

    async function sessionRoot(sessionID: string): Promise<string> {
      const ses = await ctx.session.get({ sessionID }).catch(() => undefined);
      return ses?.location?.directory ?? ses?.directory ?? process.cwd();
    }

    /** What the open direct window has changed so far, and the turn's total with it. */
    function directSpent(state: FusionState, root: string): { usage: { files: string[]; lines: number }; files: number; lines: number } {
      const now = state.direct ? measureWork(root) : undefined;
      const usage = state.direct && now ? directUsage(state.direct.base, now) : { files: [], lines: 0 };
      return { usage, files: new Set([...state.directFilesInTurn, ...usage.files]).size, lines: state.directLinesInTurn + usage.lines };
    }

    /** Lines for an automatic return: what changed, and whether the plan's checks hold. */
    async function unplannedReturnContext(sessionID: string, state: FusionState, options: { runPlanChecks: boolean }): Promise<string[]> {
      try {
        const ses = await ctx.session.get({ sessionID }).catch(() => undefined);
        const root: string = ses?.location?.directory ?? ses?.directory ?? process.cwd();
        const checks = allPlanChecks(state.activePlan);
        const lines = [...workspaceDigest(root).summary];
        if (checks.length === 0) return lines;
        if (!gateEnabled || !options.runPlanChecks) {
          lines.push(`The plan's ${checks.length} check(s) were NOT run by Fusion on this return. Nothing here is verified.`);
          return lines;
        }
        const results = await runChecks(root, checks, checkTimeoutMs);
        const passed = results.filter((result) => result.status === "passed").length;
        lines.push(`Checks run by Fusion: ${passed}/${results.length} passed.`, ...formatCheckResults(results, (result) => result.status !== "passed"));
        if (passed < results.length) lines.push("Checks are not all passing. Do not report this as done.");
        return lines;
      } catch (err) {
        console.warn("[fusion] return context error:", err);
        return [];
      }
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "handoff_to_fellow",
        description:
          "Lead-only tool. Hands work to the Fellow agent and its model, in the same session. Small job: `summary` alone (what to do and what to report back), plus `checks` if a command can confirm it. Larger work: the whole plan.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            summary: { type: "string", description: "The objective and approach. For a small job this is the whole instruction: what to do and what to report back, in one to three sentences." },
            files: {
              type: "array",
              items: { type: "string" },
              description: "Target file paths expected to be modified or read.",
            },
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Ordered, concrete implementation steps for Fellow. Use this for work that stays one piece; use `phases` instead when the work is divided.",
            },
            phases: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "What is true when this phase is done." },
                  steps: { type: "array", items: { type: "string" } },
                  checks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { command: { type: "string" }, cwd: { type: "string" } },
                      required: ["command"],
                      additionalProperties: false,
                    },
                    description: "Commands Fusion runs at this phase's checkpoint.",
                  },
                  review: { type: "string", enum: ["always", "auto"], description: "always: wake Lead at this checkpoint whatever happens. auto (default): only if something is off." },
                },
                required: ["title", "steps"],
                additionalProperties: false,
              },
              description: "The work divided into 2 to 5 parts with a checkpoint after each. Leave out for small work.",
            },
            verification: {
              type: "array",
              items: { type: "string" },
              description: "What Fellow should verify and how (free text; things to look at, manual checks).",
            },
            replanIf: {
              type: "array",
              items: { type: "string" },
              description: "Stop conditions under which Fellow must call handoff_to_lead.",
            },
            requirements: {
              type: "array",
              items: { type: "string" },
              description:
                "Everything the user asked for, one item each, close to their own words, including asides and ambiguous phrases (with your reading in parentheses).",
            },
            checks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  command: { type: "string", description: "One bare command; exit code 0 means pass. No commentary, no cd." },
                  cwd: { type: "string", description: "Folder to run in, relative to the project root. Omit for the root." },
                },
                required: ["command"],
                additionalProperties: false,
              },
              description:
                "Commands Fusion runs itself when Fellow reports completion (type check or build, tests). Failing ones go back to Fellow.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
        async execute(args: any, toolCtx: any) {
          const sessionID = toolCtx?.sessionID;
          if (!sessionID) throw new Error("handoff_to_fellow requires sessionID.");
          return withSessionLock(sessionID, async () => {
            let state = await loadState(sessionID, { refreshModels: true });
            if (toolCtx?.agent !== AGENT.lead || state.role !== "lead") {
              throw new Error("handoff_to_fellow is only available in Lead mode.");
            }
            // Handing off ends Lead's own work: what it changed so far stays, and is counted.
            let directNote = "";
            if (state.direct) {
              const spent = directSpent(state, await sessionRoot(sessionID));
              state = closeDirectWindow(state, spent.usage);
              directNote = `Lead's own direct work was closed by this handoff (it changed ${spent.usage.files.length} file(s), about ${spent.usage.lines} line(s)). Those changes are in the workspace: build on them.`;
            }
            if (state.handoffsInTurn >= maxHandoffsPerTurn) {
              throw new Error(
                `Per-turn handoff budget exhausted (${state.handoffsInTurn}/${maxHandoffsPerTurn}). Conclude and report current status to the user instead of re-dispatching Fellow.`,
              );
            }
            if (state.stalledReturns >= maxStalledReturns) {
              throw new Error(
                `No progress: the last ${state.stalledReturns} Fellow rounds came back unfinished without changing the workspace. Another handoff of the same kind will not help. Conclude and tell the user what remains and why.`,
              );
            }
            const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
            const steps = sanitizeStringList(args?.steps);
            const verification = sanitizeStringList(args?.verification);
            const replanIf = sanitizeStringList(args?.replanIf);
            const files = sanitizeStringList(args?.files);
            const requirements = sanitizeStringList(args?.requirements);
            const checks = sanitizeChecks(args?.checks);
            const phases = sanitizePhases(args?.phases);
            // A divided plan carries its steps inside the phases; the flat list is kept for older readers.
            if (steps.length === 0 && phases.length > 0) steps.push(...phases.flatMap((phase) => phase.steps));
            if (!summary) throw new Error("handoff_to_fellow requires a non-empty summary.");
            // A small job is its summary and nothing else.
            const smallJob = steps.length === 0;
            if (smallJob) steps.push(summary);

            const plan: ActivePlan = {
              summary,
              files,
              steps,
              verification,
              replanIf,
              requirements,
              checks,
              phases,
              amendments: [],
              checkpointNotes: [],
              createdAt: new Date().toISOString(),
            };

            const switched = await switchRole({
              sessionID,
              state,
              targetRole: "fellow",
              activePlan: plan,
              incrementHandoffs: true,
            });
            const next: FusionState = { ...switched, phaseIndex: 0, phaseBounces: 0 };
            delete next.awaitingCheckpoint;
            await saveState(next);

            const targetModel = next.roleModels.fellow ?? (await resolveConfiguredRoleModels()).fellow;
            return {
              content: [
                "[FUSION: FELLOW MODE ACTIVE]",
                `Active agent: fellow | Target model: ${formatModelRef(targetModel)} | Epoch: ${next.epoch} | Handoff ${next.handoffsInTurn}/${maxHandoffsPerTurn}`,
                `Plan summary: ${plan.summary} (${files.length} files, ${steps.length} steps). Follow active \`fusion.plan\` in instructions. Guardrails: maxConsecutiveFailures=${maxConsecutiveFailures}, maxFellowSteps=${maxFellowSteps}. Call \`handoff_to_lead\` when finished or blocked.`,
                directNote,
                requirements.length
                  ? `Requirements (${requirements.length}): compare these with the user's original request before you start, and report anything the request asks for that is not here.`
                  : "",
                checks.length && gateEnabled
                  ? `Checks (${checks.length}): Fusion runs them when you hand back as completed; a failing check sends the work back to you (up to ${verifyRetries} times).`
                  : "",
                ...(phases.length
                  ? [
                      `This plan has ${phases.length} phases. Do one at a time and call \`report_checkpoint\` when each is done; do not start the next before the checkpoint answers.`,
                      ...describePhase(plan, 0),
                    ]
                  : []),
              ]
                .filter(Boolean)
                .join("\n"),
            };
          });
        },
      });

      editor.add({
        name: "report_checkpoint",
        description:
          "Fellow-only tool. Reports that the current phase of the plan is done. Fusion runs that phase's checks and either tells you to go on to the next phase or brings Lead in for a look.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            done: { type: "string", description: "What was done in this phase, briefly." },
            next: { type: "string", description: "What you intend to do in the next phase." },
            concerns: {
              type: "array",
              items: { type: "string" },
              description: "Questions or choices you want Lead to decide before you go on. Each one brings Lead in, so leave this empty when you can proceed.",
            },
            deviations: {
              type: "array",
              items: { type: "string" },
              description: "Departures from the plan that change what gets built (a different approach, a requirement dropped or reinterpreted). Each one brings Lead in.",
            },
            notes: {
              type: "array",
              items: { type: "string" },
              description: "Things Lead should know but need not decide now: what you could not verify here, small incidental fixes. Recorded and shown to Lead at the end; they do not interrupt.",
            },
          },
          required: ["done"],
          additionalProperties: false,
        },
        async execute(args: any, toolCtx: any) {
          const sessionID = toolCtx?.sessionID;
          if (!sessionID) throw new Error("report_checkpoint requires sessionID.");
          return withSessionLock(sessionID, async () => {
            const state = await loadState(sessionID, { refreshModels: true });
            if (toolCtx?.agent !== AGENT.fellow || state.role !== "fellow") {
              throw new Error("report_checkpoint is only available in Fellow mode.");
            }
            const plan = state.activePlan;
            const phases = plan?.phases ?? [];
            if (!plan || phases.length === 0) {
              return { content: "This plan is not divided into phases, so there is no checkpoint. Carry on, and call `handoff_to_lead` when the work is done." };
            }
            const index = state.phaseIndex;
            if (index >= phases.length) {
              return { content: "Every phase has already been reported. Finish any remaining verification and call `handoff_to_lead`." };
            }
            const phase = phases[index];
            const done = typeof args?.done === "string" ? args.done.trim() : "";
            const nextNote = typeof args?.next === "string" ? args.next.trim() : "";
            const concerns = sanitizeStringList(args?.concerns);
            const deviations = sanitizeStringList(args?.deviations);
            const notes = sanitizeStringList(args?.notes).map((note) => `Phase ${index + 1}: ${note}`);
            const notedPlan: ActivePlan = notes.length ? { ...plan, checkpointNotes: [...plan.checkpointNotes, ...notes].slice(-40) } : plan;
            const label = `${index + 1}/${phases.length}`;

            const ses = await ctx.session.get({ sessionID }).catch(() => undefined);
            const root: string = ses?.location?.directory ?? ses?.directory ?? process.cwd();
            const results = gateEnabled && phase.checks.length > 0 ? await runChecks(root, phase.checks, checkTimeoutMs) : [];
            const failed = results.filter((result) => result.status === "failed");
            if (failed.length > 0 && state.phaseBounces < verifyRetries) {
              const bounced: FusionState = { ...state, phaseBounces: state.phaseBounces + 1, revision: state.revision + 1 };
              await saveState(bounced);
              return {
                content: [
                  `[FUSION CHECKPOINT ${label} — NOT PASSED]`,
                  `${failed.length} of ${results.length} checks for this phase failed (attempt ${bounced.phaseBounces}/${verifyRetries}). Stay on this phase.`,
                  ...formatCheckResults(results, (result) => result.status !== "passed"),
                  "Fix the cause and call `report_checkpoint` again. If the check cannot pass for a reason outside this plan, say so under `concerns` when you report again.",
                ].join("\n"),
              };
            }

            const digest = workspaceDigest(root);
            const strays = offPlanFiles(digest.files, plan.files);
            const notPassed = results.filter((result) => result.status !== "passed");
            const reasons = [
              phase.review === "always" ? "Lead asked to see this checkpoint" : "",
              notPassed.length ? `${notPassed.length} check(s) not passing` : "",
              concerns.length ? "Fellow raised concerns" : "",
              deviations.length ? "Fellow departed from the plan" : "",
              strays.length > offPlanFilesLimit ? `${strays.length} changed files are outside the plan's files` : "",
            ].filter(Boolean);
            const checkLines = results.length
              ? [`Checks for this phase: ${results.length - notPassed.length}/${results.length} passed.`, ...formatCheckResults(results, (result) => result.status !== "passed")]
              : phase.checks.length
                ? ["Checks for this phase were not run (the gate is off)."]
                : [];

            if (reasons.length === 0) {
              // Nothing calls for Lead: go straight on. This is the common case and costs no Lead call.
              const advanced: FusionState = { ...state, activePlan: notedPlan, phaseIndex: index + 1, phaseBounces: 0, revision: state.revision + 1 };
              await saveState(advanced);
              const last = index + 1 >= phases.length;
              return {
                content: [
                  `[FUSION CHECKPOINT ${label} PASSED — CONTINUE]`,
                  ...checkLines,
                  ...(last
                    ? ["That was the last phase. Finish any remaining verification and call `handoff_to_lead`."]
                    : describePhase(plan, index + 1)),
                ].join("\n"),
              };
            }

            const switched = await switchRole({ sessionID, state, targetRole: "lead", reason: "checkpoint" });
            const waiting: FusionState = { ...switched, activePlan: notedPlan, awaitingCheckpoint: index, phaseBounces: 0 };
            await saveState(waiting);
            const targetModel = waiting.roleModels.lead ?? (await resolveConfiguredRoleModels()).lead;
            return {
              content: [
                `[FUSION: CHECKPOINT ${label} — LEAD REVIEW]`,
                `Active agent: lead | Target model: ${formatModelRef(targetModel)} | Epoch: ${waiting.epoch}`,
                `Phase: ${phase.title}`,
                `Why you were woken: ${reasons.join("; ")}`,
                `Fellow reports: ${done || "(nothing)"}`,
                nextNote ? `Fellow's next step: ${nextNote}` : "",
                concerns.length ? `Concerns: ${concerns.join("; ")}` : "",
                deviations.length ? `Departures from the plan: ${deviations.join("; ")}` : "",
                notes.length ? `Notes (no answer needed): ${notes.join("; ")}` : "",
                ...checkLines,
                ...digest.summary,
                strays.length ? `Changed files outside the plan's files (${strays.length}): ${strays.slice(0, 12).join(", ")}${strays.length > 12 ? ", …" : ""}` : "",
                index + 1 < phases.length ? `Phases still to do: ${phases.slice(index + 1).map((p, i) => `${index + 2 + i}. ${p.title}`).join(" | ")}` : "This was the last phase.",
                "Answer with `resume_fellow`: `continue` to move on to the next phase, or `adjust` with short notes if this phase needs fixing first. Use `handoff_to_fellow` only if the approach itself must change.",
              ]
                .filter(Boolean)
                .join("\n"),
            };
          });
        },
      });

      editor.add({
        name: "resume_fellow",
        description:
          "Lead-only tool. Answers a checkpoint: sends Fellow on to the next phase (`continue`), or back into the same phase with corrections (`adjust`). Much lighter than a new handoff: the plan is kept.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            decision: { type: "string", enum: ["continue", "adjust"], description: "continue: next phase. adjust: fix this phase first, then it is reported again." },
            notes: {
              type: "array",
              items: { type: "string" },
              description: "Short corrections or guidance. They are added to the plan and override its steps. Required for `adjust`.",
            },
          },
          required: ["decision"],
          additionalProperties: false,
        },
        async execute(args: any, toolCtx: any) {
          const sessionID = toolCtx?.sessionID;
          if (!sessionID) throw new Error("resume_fellow requires sessionID.");
          return withSessionLock(sessionID, async () => {
            const state = await loadState(sessionID, { refreshModels: true });
            if (toolCtx?.agent !== AGENT.lead || state.role !== "lead") {
              throw new Error("resume_fellow is only available in Lead mode.");
            }
            const plan = state.activePlan;
            if (!plan || plan.phases.length === 0 || state.awaitingCheckpoint === undefined) {
              throw new Error("There is no checkpoint waiting for an answer. Use `handoff_to_fellow` to give Fellow new work.");
            }
            if (state.handoffsInTurn >= maxHandoffsPerTurn) {
              throw new Error(
                `Per-turn handoff budget exhausted (${state.handoffsInTurn}/${maxHandoffsPerTurn}). Conclude and report current status to the user instead of re-dispatching Fellow.`,
              );
            }
            const decision = args?.decision === "adjust" ? "adjust" : "continue";
            const notes = sanitizeStringList(args?.notes);
            if (decision === "adjust" && notes.length === 0) {
              throw new Error("`adjust` needs at least one note saying what to fix.");
            }
            const index = state.awaitingCheckpoint;
            const amended: ActivePlan = { ...plan, amendments: [...plan.amendments, ...notes] };
            const phaseIndex = decision === "continue" ? index + 1 : index;

            const switched = await switchRole({ sessionID, state, targetRole: "fellow", activePlan: amended, incrementHandoffs: true });
            const next: FusionState = { ...switched, phaseIndex, phaseBounces: 0 };
            delete next.awaitingCheckpoint;
            await saveState(next);

            const targetModel = next.roleModels.fellow ?? (await resolveConfiguredRoleModels()).fellow;
            const finished = phaseIndex >= amended.phases.length;
            return {
              content: [
                "[FUSION: FELLOW MODE ACTIVE — RESUMED AT CHECKPOINT]",
                `Active agent: fellow | Target model: ${formatModelRef(targetModel)} | Epoch: ${next.epoch} | Handoff ${next.handoffsInTurn}/${maxHandoffsPerTurn}`,
                decision === "adjust"
                  ? `Lead wants phase ${index + 1} fixed before moving on. Apply the notes, then call \`report_checkpoint\` again.`
                  : finished
                    ? "Lead accepted the last phase. Finish any remaining verification and call `handoff_to_lead`."
                    : `Lead accepted phase ${index + 1}. Go on.`,
                ...(notes.length ? ["Lead's notes:", ...notes.map((note) => `  - ${note}`)] : []),
                ...(finished ? [] : describePhase(amended, phaseIndex)),
              ].join("\n"),
            };
          });
        },
      });

      editor.add({
        name: "handoff_to_lead",
        description:
          "Fellow-only tool. Returns the session context and execution results back to the Lead agent and its model.",
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Why returning control: completed, blocked, need_replan, or user_requested.",
            },
            summary: { type: "string", description: "Concise summary of work done and current state." },
            changedFiles: {
              type: "array",
              items: { type: "string" },
              description: "Files created or modified during execution.",
            },
            verification: {
              type: "array",
              items: { type: "string" },
              description: "Observed test/command outcomes.",
            },
            blockers: {
              type: "array",
              items: { type: "string" },
              description: "Unresolved failures, ambiguities, or blockers if any.",
            },
            missingRequirements: {
              type: "array",
              items: { type: "string" },
              description: "Things the user's original request asks for that the plan did not cover.",
            },
          },
          required: ["reason", "summary"],
          additionalProperties: false,
        },
        async execute(args: any, toolCtx: any) {
          const sessionID = toolCtx?.sessionID;
          if (!sessionID) throw new Error("handoff_to_lead requires sessionID.");
          return withSessionLock(sessionID, async () => {
            const state = await loadState(sessionID, { refreshModels: true });
            if (toolCtx?.agent !== AGENT.fellow || state.role !== "fellow") {
              throw new Error("handoff_to_lead is only available in Fellow mode.");
            }
            const reason =
              typeof args?.reason === "string" && args.reason.trim() ? args.reason.trim() : "completed";
            const summary = typeof args?.summary === "string" ? args.summary.trim() : "";
            const changedFiles = sanitizeStringList(args?.changedFiles);
            const verification = sanitizeStringList(args?.verification);
            const blockers = sanitizeStringList(args?.blockers);
            const missingRequirements = sanitizeStringList(args?.missingRequirements);
            const plan = state.activePlan;
            const requirements = plan?.requirements ?? [];
            const checks = allPlanChecks(plan);
            const unreported = (plan?.phases ?? []).slice(state.phaseIndex).map((phase, offset) => `${state.phaseIndex + offset + 1}. ${phase.title}`);

            // The verification gate. Fellow says it is done: run the plan's checks here instead of taking its word.
            const ses = await ctx.session.get({ sessionID }).catch(() => undefined);
            const root: string = ses?.location?.directory ?? ses?.directory ?? process.cwd();
            let results: CheckResult[] = [];
            if (gateEnabled && checks.length > 0 && reason === "completed") {
              results = await runChecks(root, checks, checkTimeoutMs);
              const failed = results.filter((result) => result.status === "failed");
              if (failed.length > 0 && state.verifyBounces < verifyRetries) {
                // Straight back to Fellow. Lead is not woken, and the handoff budget is untouched.
                const bounced: FusionState = { ...state, verifyBounces: state.verifyBounces + 1, revision: state.revision + 1 };
                await saveState(bounced);
                return {
                  content: [
                    "[FUSION VERIFICATION GATE — NOT RETURNED TO LEAD]",
                    `${failed.length} of ${results.length} checks failed (attempt ${bounced.verifyBounces}/${verifyRetries}). You are still Fellow.`,
                    ...formatCheckResults(results, (result) => result.status !== "passed"),
                    "Fix the cause and call `handoff_to_lead` again. If a check cannot pass for a reason outside this plan (wrong command, missing environment, a failure that was already there), call `handoff_to_lead` with reason `blocked` and explain.",
                  ].join("\n"),
                };
              }
            }

            const digest = workspaceDigest(root);
            const unclean = reason !== "completed" || results.some((result) => result.status !== "passed");
            const stalledReturns = unclean && digest.hash !== undefined && digest.hash === state.lastWorkHash ? state.stalledReturns + 1 : 0;

            const switched = await switchRole({
              sessionID,
              state,
              targetRole: "lead",
              reason,
            });
            const next: FusionState = { ...switched, stalledReturns, ...(digest.hash ? { lastWorkHash: digest.hash } : {}) };
            delete next.awaitingCheckpoint;
            await saveState(next);

            const notPassed = results.filter((result) => result.status !== "passed");
            const targetModel = next.roleModels.lead ?? (await resolveConfiguredRoleModels()).lead;
            return {
              content: [
                "[FUSION: LEAD MODE ACTIVE]",
                `Active agent: lead | Target model: ${formatModelRef(targetModel)} | Epoch: ${next.epoch}`,
                `Return reason: ${reason}`,
                `Summary: ${summary || "(no summary provided)"}`,
                changedFiles.length ? `Changed files: ${changedFiles.join(", ")}` : "Changed files: none reported",
                verification.length ? `Verification (as Fellow reports it): ${verification.join("; ")}` : "",
                blockers.length ? `Blockers: ${blockers.join("; ")}` : "",
                ...(results.length
                  ? [
                      `Checks run by Fusion: ${results.length - notPassed.length}/${results.length} passed${state.verifyBounces ? ` (after ${state.verifyBounces} round(s) sent back to Fellow)` : ""}.`,
                      ...formatCheckResults(results, (result) => result.status !== "passed"),
                    ]
                  : checks.length > 0 && reason !== "completed"
                    ? ["Checks were NOT run by Fusion, because Fellow did not report completion."]
                    : checks.length === 0 && plan
                      ? ["No `checks` were given in the plan, so nothing was verified by Fusion. Fellow's report above is unverified."]
                      : []),
                ...digest.summary,
                unreported.length && reason === "completed"
                  ? `Phases that were never reported at a checkpoint (their checks were only run now, at the end): ${unreported.join(" | ")}`
                  : "",
                unreported.length && reason !== "completed" ? `Phases not finished: ${unreported.join(" | ")}` : "",
                ...(plan?.checkpointNotes?.length ? ["Notes Fellow left at checkpoints (not verified, incidental fixes):", ...plan.checkpointNotes.map((note) => `  - ${note}`)] : []),
                missingRequirements.length
                  ? `Fellow says the user's request also asks for (not in the plan): ${missingRequirements.join("; ")}`
                  : "",
                ...(requirements.length
                  ? ["Requirements to check off against the changes before concluding:", ...requirements.map((item, index) => `  ${index + 1}. ${item}`)]
                  : []),
                notPassed.length
                  ? "Checks are not all passing. Do not report this as done: hand off again with every remaining issue in one plan, or tell the user exactly what could not be verified and why."
                  : "",
                stalledReturns > 0
                  ? `Note: this round changed nothing in the workspace (${stalledReturns}/${maxStalledReturns} before further handoffs are refused).`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            };
          });
        },
      });
    });

    if (directEnabled) {
      await ctx.tool.transform((editor: any) => {
        const CHECKS_INPUT = {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string", description: "One bare command; exit code 0 means pass. No commentary, no cd." },
              cwd: { type: "string", description: "Folder to run in, relative to the project root. Omit for the root." },
            },
            required: ["command"],
            additionalProperties: false,
          },
        } as const;

        editor.add({
          name: "work_directly",
          description:
            "Lead-only tool. Opens editing and shell for Lead itself, inside a budget, for a small and certain change (or a note the task asks for, or a small correction after Fellow returns). Close it with `finish_direct`. For anything larger use `handoff_to_fellow`.",
          options: { codemode: false },
          input: {
            type: "object",
            properties: {
              reason: { type: "string", description: "Why this is small and certain enough to do yourself: what you will change and why no handoff is needed." },
              files: { type: "array", items: { type: "string" }, description: "The files you expect to touch." },
              requirements: { type: "array", items: { type: "string" }, description: "Everything the user asked for, one item each, close to their own words." },
              checks: { ...CHECKS_INPUT, description: "Commands Fusion runs when you call `finish_direct` (type check or build, the relevant tests). Use the command this repository itself uses for its tests. Leave empty only when nothing can check it (a written note). While a window is open, calling `work_directly` again with new `checks` replaces them." },
            },
            required: ["reason", "files"],
            additionalProperties: false,
          },
          async execute(args: any, toolCtx: any) {
            const sessionID = toolCtx?.sessionID;
            if (!sessionID) throw new Error("work_directly requires sessionID.");
            return withSessionLock(sessionID, async () => {
              const state = await loadState(sessionID, { refreshModels: true });
              if (toolCtx?.agent !== AGENT.lead || state.role !== "lead") {
                throw new Error("work_directly is only available in Lead mode.");
              }
              if (state.awaitingCheckpoint !== undefined) {
                throw new Error("A checkpoint is waiting for your answer. Answer it with `resume_fellow` first.");
              }
              const budget = `Budget for this turn: ${maxDirectFiles} files, about ${maxDirectLines} changed lines, ${maxDirectSteps} steps per window.`;
              if (state.direct) {
                // Calling it again while open replaces the checks: a command that cannot run on this machine is
                // Lead's own mistake, and without this it could only be corrected by letting the window close.
                const replacement = sanitizeChecks(args?.checks);
                if (replacement.length > 0 && JSON.stringify(replacement) !== JSON.stringify(state.direct.checks)) {
                  if (state.direct.checksReplaced >= MAX_DIRECT_CHECK_REPLACEMENTS) {
                    throw new Error(
                      `The checks of this window were already replaced ${state.direct.checksReplaced} times. Call \`finish_direct\`, hand off, or tell the user exactly what could not be verified and why.`,
                    );
                  }
                  const replaced: FusionState = {
                    ...state,
                    direct: { ...state.direct, checks: replacement, checksReplaced: state.direct.checksReplaced + 1 },
                    revision: state.revision + 1,
                  };
                  await saveState(replaced);
                  return {
                    content: [
                      "[FUSION: DIRECT WORK — CHECKS REPLACED, SAME WINDOW]",
                      `Fusion will run these ${replacement.length} check(s) when you call \`finish_direct\`:`,
                      ...replacement.map((check) => `  - ${check.command}${check.cwd ? ` (in ${check.cwd})` : ""}`),
                      "No new window was opened and the budget is unchanged. Replace a check only when the command itself was wrong, never to get past a failure your change causes.",
                    ].join("\n"),
                  };
                }
                return {
                  content: `Direct work is already open (${state.direct.steps}/${maxDirectSteps} steps used). ${budget} Carry on, and call \`finish_direct\` when the change is complete. To correct a check command that cannot run here, call \`work_directly\` again with the new \`checks\`.`,
                };
              }
              if (state.directWindowsInTurn >= maxDirectWindows) {
                throw new Error(
                  `Direct work was already opened ${state.directWindowsInTurn} times this turn (limit ${maxDirectWindows}). Give what remains to Fellow with \`handoff_to_fellow\`, or conclude and tell the user what remains.`,
                );
              }
              if (state.directFilesInTurn.length > maxDirectFiles || state.directLinesInTurn > maxDirectLines) {
                throw new Error(
                  `The direct-work budget of this turn is used up (${state.directFilesInTurn.length} files, about ${state.directLinesInTurn} lines; limit ${maxDirectFiles} files, ${maxDirectLines} lines). Give what remains to Fellow with \`handoff_to_fellow\`.`,
                );
              }
              const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
              if (!reason) throw new Error("work_directly needs a `reason`: what you will change and why it needs no handoff.");
              const window: DirectWindow = {
                reason,
                files: sanitizeStringList(args?.files),
                requirements: sanitizeStringList(args?.requirements),
                checks: sanitizeChecks(args?.checks),
                base: measureWork(await sessionRoot(sessionID)) ?? {},
                steps: 0,
                seen: [],
                bounces: 0,
                checksReplaced: 0,
                openedAt: new Date().toISOString(),
              };
              const next: FusionState = { ...state, direct: window, directWindowsInTurn: state.directWindowsInTurn + 1, revision: state.revision + 1 };
              await saveState(next);
              return {
                content: [
                  `[FUSION: DIRECT WORK OPEN — window ${next.directWindowsInTurn}/${maxDirectWindows}]`,
                  "Editing and shell are open to you now. You are still Lead; no handoff was made.",
                  `${budget} Already used this turn: ${state.directFilesInTurn.length} files, about ${state.directLinesInTurn} lines. Past the budget your edits are refused.`,
                  window.checks.length && gateEnabled
                    ? `Checks (${window.checks.length}): Fusion runs them when you call \`finish_direct\`.`
                    : "No `checks` were given, so Fusion will verify nothing. Say so to the user unless the task is only a written note.",
                  "When the change is complete call `finish_direct`. If it turns out larger than you thought, stop and call `handoff_to_fellow` with a plan that says what you already changed and what remains.",
                ].join("\n"),
              };
            });
          },
        });

        editor.add({
          name: "finish_direct",
          description:
            "Lead-only tool. Ends direct work: Fusion runs the checks given to `work_directly` and closes editing and shell again. Failing checks keep it open so you can fix the cause.",
          options: { codemode: false },
          input: {
            type: "object",
            properties: { summary: { type: "string", description: "What you changed, briefly." } },
            required: ["summary"],
            additionalProperties: false,
          },
          async execute(args: any, toolCtx: any) {
            const sessionID = toolCtx?.sessionID;
            if (!sessionID) throw new Error("finish_direct requires sessionID.");
            return withSessionLock(sessionID, async () => {
              const state = await loadState(sessionID, { refreshModels: true });
              if (toolCtx?.agent !== AGENT.lead || state.role !== "lead") {
                throw new Error("finish_direct is only available in Lead mode.");
              }
              const window = state.direct;
              if (!window) return { content: "No direct work is open, so there is nothing to finish. Editing and shell are closed." };
              const root = await sessionRoot(sessionID);
              const results = gateEnabled && window.checks.length > 0 ? await runChecks(root, window.checks, checkTimeoutMs) : [];
              const failed = results.filter((result) => result.status === "failed");
              if (failed.length > 0 && window.bounces < verifyRetries) {
                const bounced: FusionState = { ...state, direct: { ...window, bounces: window.bounces + 1 }, revision: state.revision + 1 };
                await saveState(bounced);
                return {
                  content: [
                    "[FUSION DIRECT WORK — CHECKS NOT PASSED, STILL OPEN]",
                    `${failed.length} of ${results.length} checks failed (attempt ${window.bounces + 1}/${verifyRetries}).`,
                    ...formatCheckResults(results, (result) => result.status !== "passed"),
                    "Fix the cause and call `finish_direct` again. If the fix is more than a small one, call `handoff_to_fellow` with what you changed and what remains.",
                    "If the command itself is wrong for this machine (it fails the same way without your change), call `work_directly` again with corrected `checks`: that replaces them in this window. Do not stop with the check failing.",
                  ].join("\n"),
                };
              }
              const spent = directSpent(state, root);
              const closed = closeDirectWindow(state, spent.usage);
              await saveState(closed);
              const notPassed = results.filter((result) => result.status !== "passed");
              return {
                content: [
                  "[FUSION DIRECT WORK — CLOSED]",
                  `You changed ${spent.usage.files.length} file(s), about ${spent.usage.lines} line(s) yourself (this turn in all: ${closed.directFilesInTurn.length} files, about ${closed.directLinesInTurn} lines; budget ${maxDirectFiles} files, ${maxDirectLines} lines).`,
                  ...(results.length
                    ? [
                        `Checks run by Fusion: ${results.length - notPassed.length}/${results.length} passed${window.bounces ? ` (after ${window.bounces} failed attempt(s))` : ""}${window.checksReplaced ? ` (you replaced the checks ${window.checksReplaced} time(s) in this window)` : ""}.`,
                        ...formatCheckResults(results, (result) => result.status !== "passed"),
                      ]
                    : ["No checks were run by Fusion, so nothing here is verified by it."]),
                  ...workspaceDigest(root).summary,
                  ...(window.requirements.length
                    ? ["Requirements to check off against the changes before concluding:", ...window.requirements.map((item, index) => `  ${index + 1}. ${item}`)]
                    : []),
                  notPassed.length
                    ? "Checks are not all passing. Do not report this as done: fix it, hand it off, or tell the user exactly what could not be verified and why."
                    : "",
                  "Editing and shell are closed again.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              };
            });
          },
        });
      });
    }

    const contextHook = await ctx.session.hook("context", async (event: any) => {
      try {
        const sessionID = event?.sessionID;
        if (!sessionID) return;
        await withSessionLock(sessionID, async () => {
          if (event.agent !== AGENT.lead && event.agent !== AGENT.fellow) {
            // Build, Plan and any other mode: this plugin's tools are not offered there.
            if (event.tools && typeof event.tools === "object") {
              for (const toolName of Object.keys(event.tools)) {
                if (FUSION_TOOLS.has(toolName)) delete event.tools[toolName];
              }
            }
            modelMismatchBySession.delete(sessionID);
            return;
          }
          const state = await loadState(sessionID);
          if (event.agent !== AGENT.fellow) {
            modelMismatchBySession.delete(sessionID);
            return;
          }

          const configured = await resolveConfiguredRoleModels();
          const expected = state.roleModels.fellow ?? configured.fellow;
          const actual = normalizeModelRef(event.model);

          if (expected && actual && (actual.providerID !== expected.providerID || actual.id !== expected.id)) {
            modelMismatchBySession.set(sessionID, { expected, actual, epoch: state.epoch });
            if (event.tools && typeof event.tools === "object") {
              for (const toolName of Object.keys(event.tools)) {
                if (
                  toolName !== "handoff_to_lead" &&
                  (!leadAllowedTools.has(toolName) || LEAD_ONLY_TOOLS.has(toolName))
                ) {
                  delete event.tools[toolName];
                }
              }
            }
            if (Array.isArray(event.system)) {
              event.system.push({
                type: "text",
                text: `[FUSION MODEL MISMATCH LOCK] Expected Fellow model ${formatModelRef(expected)} but runtime resolved ${formatModelRef(actual)}. Mutating, shell, and execute tools are locked to read-only. Call handoff_to_lead immediately to report this mismatch.`,
              });
            }
          } else {
            modelMismatchBySession.delete(sessionID);
          }
        });
      } catch (err) {
        console.warn("[fusion] context hook error:", err);
      }
    });

    const toolBeforeHook = await ctx.tool.hook("execute.before", async (event: any) => {
      const sessionID = event?.sessionID;
      if (!sessionID) return;
      await withSessionLock(sessionID, async () => {
        const state = await loadState(sessionID);

        if (event.agent === AGENT.lead) {
          const isDirectTool = directEnabled && DIRECT_TOOLS.has(event.tool);
          if (event.tool === "shell" && !state.direct) {
            // Looking is always open to Lead; a command with effects is Fellow's (or, with direct work, a window's).
            const command = rawShellCommand(event.input);
            if (state.role !== "lead") throw new Error("shell is only available in Lead mode.");
            if (!isReadOnlyShell(command)) {
              throw new Error(
                `Lead runs read-only commands only (git log / status / diff / show / blame, ls, cat, head, tail, wc, grep, rg, and pipes between them). This one is not: ${command.replace(/\s+/g, " ").trim().slice(0, 120)}. Hand it to Fellow with handoff_to_fellow; for a small job give only \`summary\` (what to run or change, and what to report back).${directEnabled ? " Or, for a small change you will make yourself, call work_directly first." : ""}`,
              );
            }
            if (event?.id) inFlightCallEpoch.set(callKey(sessionID, String(event.id)), state.epoch);
            return;
          }
          if (!leadAllowedTools.has(event.tool) && !isDirectTool) {
            throw new Error(
              `Tool "${event.tool}" is disabled in Lead mode (strict PLAN allowlist). Use read-only tools or call handoff_to_fellow first.`,
            );
          }
          if (state.role !== "lead" && (LEAD_ONLY_TOOLS.has(event.tool) || isDirectTool)) {
            throw new Error(`${event.tool} is only available in Lead mode.`);
          }
          if (isDirectTool) {
            const window = state.direct;
            if (!window) {
              throw new Error(
                `Tool "${event.tool}" is closed. If this is a small, certain change you will make yourself, call work_directly first; otherwise call handoff_to_fellow.`,
              );
            }
            const isNewStep = typeof event.messageID === "string" && event.messageID.length > 0 ? !window.seen.includes(event.messageID) : true;
            if (window.steps >= maxDirectSteps && isNewStep) {
              throw new Error(
                `Direct-work step limit reached (${window.steps}/${maxDirectSteps}). Call finish_direct if the change is complete; otherwise call handoff_to_fellow with a plan that says what you already changed and what remains.`,
              );
            }
            const spent = directSpent(state, await sessionRoot(sessionID));
            if (spent.files > maxDirectFiles || spent.lines > maxDirectLines) {
              throw new Error(
                `Direct-work budget exceeded (${spent.files} files, about ${spent.lines} changed lines; the limit is ${maxDirectFiles} files, ${maxDirectLines} lines). This is no longer a small change. Stop editing: call handoff_to_fellow with a plan that says what you already changed and what remains, or call finish_direct if the change is in fact complete.`,
              );
            }
          }
          if (event?.id) {
            inFlightCallEpoch.set(callKey(sessionID, String(event.id)), state.epoch);
          }
          return;
        }

        if (event.agent === AGENT.fellow) {
          if (LEAD_ONLY_TOOLS.has(event.tool)) {
            throw new Error(`${event.tool} is only available in Lead mode.`);
          }
          // Parallel sibling guard: another tool in this step already switched phase back to lead.
          if (state.role !== "fellow") {
            if (!leadAllowedTools.has(event.tool) || event.tool === "handoff_to_lead") {
              throw new Error(
                `Tool "${event.tool}" blocked: session already returned to Lead mode (epoch ${state.epoch}).`,
              );
            }
            return;
          }

          // Runtime model mismatch guard
          const mismatch = modelMismatchBySession.get(sessionID);
          if (
            mismatch &&
            mismatch.epoch === state.epoch &&
            !leadAllowedTools.has(event.tool) &&
            event.tool !== "handoff_to_lead"
          ) {
            throw new Error(
              `Tool "${event.tool}" blocked by model mismatch lock: expected ${formatModelRef(mismatch.expected)}, actual ${formatModelRef(mismatch.actual)}. Call handoff_to_lead.`,
            );
          }

          // Check step cap at the start of the NEXT step (allows sibling calls in step maxFellowSteps to finish).
          if (event.tool !== "handoff_to_lead") {
            const isNewStep =
              typeof event.messageID === "string" && event.messageID.length > 0
                ? !state.seenStepMessageIDs.includes(event.messageID)
                : true;
            if (state.fellowSteps >= maxFellowSteps && isNewStep) {
              const reason = `fellowSteps (${state.fellowSteps}) reached limit (${maxFellowSteps})`;
              await switchRole({
                sessionID,
                state,
                targetRole: "lead",
                reason: `auto_return: ${reason}`,
              });
              await ctx.session
                .synthetic({
                  sessionID,
                  text: buildAutoReturnBanner(reason, [
                    `Blocked tool at next step boundary: ${event.tool}`,
                    `Fellow steps used: ${state.fellowSteps}/${maxFellowSteps}`,
                    ...(await unplannedReturnContext(sessionID, state, { runPlanChecks: false })),
                  ]),
                  delivery: "steer",
                  resume: false,
                })
                .catch((err: unknown) => console.warn("[fusion] step-cap synthetic error:", err));
              throw new Error(
                `Fellow step cap reached (${state.fellowSteps}/${maxFellowSteps}). Control returned to Lead.`,
              );
            }
          }

          if (event?.id) {
            inFlightCallEpoch.set(callKey(sessionID, String(event.id)), state.epoch);
          }
          if (event.tool === "execute") {
            let active = activeExecuteCalls.get(sessionID);
            if (!active) {
              active = new Set<string>();
              activeExecuteCalls.set(sessionID, active);
            }
            active.add(event?.id ? String(event.id) : "__anonymous_execute__");
          }
        }
      });
    });

    const toolAfterHook = await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        const sessionID = event?.sessionID;
        if (!sessionID) return;

        const recordedKey = event?.id ? callKey(sessionID, String(event.id)) : undefined;
        const callEpoch = recordedKey ? inFlightCallEpoch.get(recordedKey) : undefined;
        if (recordedKey) inFlightCallEpoch.delete(recordedKey);

        await withSessionLock(sessionID, async () => {
          if (event?.tool === "execute") {
            const active = activeExecuteCalls.get(sessionID);
            if (active) {
              active.delete(event?.id ? String(event.id) : "__anonymous_execute__");
              if (active.size === 0) activeExecuteCalls.delete(sessionID);
            }
          }

          const isInnerCodeMode =
            event?.tool !== "execute" &&
            (event?.codemode === true || (activeExecuteCalls.get(sessionID)?.size ?? 0) > 0);
          if (isInnerCodeMode) return;
          if (["handoff_to_fellow", "handoff_to_lead", "resume_fellow", "report_checkpoint", "work_directly", "finish_direct"].includes(event?.tool)) return;

          const state = await loadState(sessionID);
          if (state.role === "lead" && state.direct && DIRECT_TOOLS.has(event?.tool)) {
            // Lead's own steps inside a direct window, one per assistant message.
            const seen = [...state.direct.seen];
            let steps = state.direct.steps;
            if (typeof event.messageID === "string" && event.messageID.length > 0) {
              if (!seen.includes(event.messageID)) {
                seen.push(event.messageID);
                if (seen.length > 60) seen.splice(0, seen.length - 60);
                steps += 1;
              }
            } else {
              steps += 1;
            }
            if (steps !== state.direct.steps) {
              await saveState({ ...state, direct: { ...state.direct, steps, seen }, revision: state.revision + 1 }, { emit: false });
            }
            return;
          }
          if (state.role !== "fellow") return;
          if (callEpoch !== undefined && callEpoch !== state.epoch) return;

          // Track unique assistant steps via event.messageID rather than per-tool count.
          let fellowSteps = state.fellowSteps;
          const seen = [...state.seenStepMessageIDs];
          if (typeof event.messageID === "string" && event.messageID.length > 0) {
            if (!seen.includes(event.messageID)) {
              seen.push(event.messageID);
              if (seen.length > MAX_SEEN_MESSAGE_IDS) seen.splice(0, seen.length - MAX_SEEN_MESSAGE_IDS);
              fellowSteps += 1;
            }
          } else {
            fellowSteps += 1;
          }

          let consecutiveFailures = state.consecutiveFailures;
          let lastFailedCommand = state.lastFailedCommand;
          let lastNonZeroShellCommand = state.lastNonZeroShellCommand;

          const meta =
            event?.result && typeof event.result === "object" && event.result.metadata
              ? (event.result.metadata as Record<string, unknown>)
              : undefined;
          const isBackgroundRunning = event?.tool === "shell" && isBackgroundShellResult(meta);

          if (event.status === "error") {
            consecutiveFailures += 1;
            if (event.tool === "shell") {
              const cmd = extractShellCommand(event.input);
              if (cmd) {
                lastFailedCommand = cmd;
                lastNonZeroShellCommand = cmd;
              }
            }
          } else if (isBackgroundRunning) {
            // Neutral: starting a background shell must neither increment nor clear prior failures.
          } else if (event.tool === "execute") {
            if (isCodeModeFailure(event.result)) {
              consecutiveFailures += 1;
              lastFailedCommand = "execute (Code Mode failure)";
            } else {
              consecutiveFailures = 0;
              lastNonZeroShellCommand = undefined;
            }
          } else if (event.tool === "shell") {
            const exitCode = typeof meta?.exit === "number" ? meta.exit : 0;
            const timedOut = Boolean(meta?.timeout);
            const killed = Boolean(meta?.killed);
            const signaled = Boolean(meta?.signal);
            const cmd = extractShellCommand(event.input);

            if (exitCode !== 0 || timedOut || killed || signaled) {
              const benignExitOne =
                exitCode === 1 && !timedOut && !killed && !signaled && isBenignShellExitOne(cmd, state);
              if (benignExitOne) {
                lastNonZeroShellCommand = cmd || lastNonZeroShellCommand;
              } else {
                consecutiveFailures += 1;
                if (cmd) {
                  lastFailedCommand = cmd;
                  lastNonZeroShellCommand = cmd;
                }
              }
            } else {
              consecutiveFailures = 0;
              lastNonZeroShellCommand = undefined;
            }
          } else {
            consecutiveFailures = 0;
            lastNonZeroShellCommand = undefined;
          }

          const updated: FusionState = {
            ...state,
            revision: state.revision + 1,
            fellowSteps,
            seenStepMessageIDs: seen,
            consecutiveFailures,
            ...(lastFailedCommand !== undefined ? { lastFailedCommand } : {}),
            ...(lastNonZeroShellCommand !== undefined ? { lastNonZeroShellCommand } : {}),
          };
          if (lastNonZeroShellCommand === undefined) {
            delete updated.lastNonZeroShellCommand;
          }

          let autoReturned = false;
          let autoReturnReason: string | undefined;
          if (consecutiveFailures >= maxConsecutiveFailures) {
            autoReturned = true;
            autoReturnReason = `consecutiveFailures (${consecutiveFailures}) reached limit (${maxConsecutiveFailures})`;
          }

          let finalState = updated;
          if (autoReturned && autoReturnReason) {
            finalState = await switchRole({
              sessionID,
              state: updated,
              targetRole: "lead",
              reason: `auto_return: ${autoReturnReason}`,
            });

            const banner = buildAutoReturnBanner(autoReturnReason, [
              `Tool: ${event.tool}${lastFailedCommand ? ` (${lastFailedCommand})` : ""}`,
              `Fellow steps used: ${fellowSteps}/${maxFellowSteps}`,
              ...(await unplannedReturnContext(sessionID, updated, { runPlanChecks: false })),
            ]);

            if (event.status === "error" || !appendBannerToResult(event.result, banner)) {
              await ctx.session.synthetic({
                sessionID,
                text: banner,
                delivery: "steer",
                resume: false,
              });
            }
          } else {
            await saveState(updated);
          }

          if (event.status === "completed" && event.result && typeof event.result === "object") {
            event.result.metadata = {
              ...(event.result.metadata ?? {}),
              fusion: {
                role: finalState.role,
                epoch: finalState.epoch,
                revision: finalState.revision,
                fellowSteps: finalState.fellowSteps,
                consecutiveFailures: finalState.consecutiveFailures,
                autoReturned,
                ...(autoReturnReason ? { reason: autoReturnReason } : {}),
              },
            };
          }
        });
      } catch (err) {
        console.warn("[fusion] execute.after hook error:", err);
      }
    });

    const promptHook = await ctx.session.hook("prompt", async (event: any) => {
      try {
        const sessionID = event?.sessionID;
        if (!sessionID) return;

        await withSessionLock(sessionID, async () => {
          const loaded = await loadState(sessionID);
          const usedDirect = loaded.direct !== undefined || loaded.directWindowsInTurn !== 0 || loaded.directLinesInTurn !== 0 || loaded.directFilesInTurn.length !== 0;
          const state: FusionState =
            loaded.handoffsInTurn !== 0 || usedDirect
              ? { ...loaded, handoffsInTurn: 0, stalledReturns: 0, directWindowsInTurn: 0, directLinesInTurn: 0, directFilesInTurn: [], revision: loaded.revision + 1 }
              : loaded;
          // A window left open by the last turn does not carry over: the new request is judged afresh.
          if (state !== loaded) delete state.direct;

          if (!returnOnUserPrompt || state.role !== "fellow") {
            if (state !== loaded) await saveState(state);
            return;
          }

          if (event.delivery === "queue") {
            if (state !== loaded) await saveState(state);
            return;
          }
          if (event.metadata?.fusion?.route === "fellow") {
            if (state !== loaded) await saveState(state);
            return;
          }

          const text = typeof event.prompt?.text === "string" ? event.prompt.text : "";
          if (/^\s*>>(?:\s|$)/.test(text)) {
            if (event.prompt) {
              event.prompt.text = text.replace(/^\s*>>[ \t]*/, "");
            }
            if (state !== loaded) await saveState(state);
            return;
          }

          const reason = loaded.running ? "user steer intervention" : "user prompt intervention";
          await switchRole({
            sessionID,
            state,
            targetRole: "lead",
            reason,
          });
        });
      } catch (err) {
        console.warn("[fusion] prompt hook error:", err);
      }
    });

    const idleHook = await ctx.session.hook("experimental.idle", async (event: any) => {
      try {
        const sessionID = event?.sessionID;
        if (!sessionID) return;
        const hasPendingSubagent =
          Array.isArray(event?.background) &&
          event.background.some((bg: any) => bg && typeof bg === "object" && bg.kind === "subagent");
        if (hasPendingSubagent) return;

        await withSessionLock(sessionID, async () => {
          const state = await loadState(sessionID);
          if (state.role === "lead" && state.direct) {
            // Lead ended its turn without `finish_direct`: the checks are run anyway, and it is told only if they fail.
            const window = state.direct;
            const root = await sessionRoot(sessionID);
            const results = gateEnabled && window.checks.length > 0 ? await runChecks(root, window.checks, checkTimeoutMs) : [];
            await saveState(closeDirectWindow(state, directSpent(state, root).usage));
            const notPassed = results.filter((result) => result.status !== "passed");
            if (notPassed.length === 0) return;
            await ctx.session.synthetic({
              sessionID,
              text: [
                "[FUSION DIRECT WORK — ENDED WITHOUT finish_direct]",
                `Fusion ran your checks: ${results.length - notPassed.length}/${results.length} passed.`,
                ...formatCheckResults(results, (result) => result.status !== "passed"),
                "Checks are not all passing. Do not leave this reported as done: open `work_directly` again for a small fix, hand it off, or tell the user exactly what could not be verified and why.",
              ].join("\n"),
              delivery: "steer",
              resume: true,
            });
            return;
          }
          if (state.role !== "fellow") return;

          // Fellow stopped without handing back. Often it wrote the tool call out as text (some models do), or simply
          // forgot. Asked once per round, it usually makes the call; a second stop goes to Lead as before.
          if (state.idleNudgeEpoch !== state.epoch) {
            await saveState({ ...state, idleNudgeEpoch: state.epoch, revision: state.revision + 1 });
            await ctx.session.synthetic({
              sessionID,
              text: [
                "[FUSION: YOU STOPPED WITHOUT HANDING BACK]",
                "Your turn ended without a tool call, so nothing was reported. If your last message wrote a tool call out as text (for example `<｜DSML｜…>` or `<invoke name=…>`), it was not carried out: make that call again as a real tool call.",
                "When the work or the current phase is done, call `report_checkpoint` (a plan with phases) or `handoff_to_lead`. If you are stuck or need a decision, call `handoff_to_lead` with reason `blocked` or `need_replan`. Do not answer with text alone.",
              ].join("\n"),
              delivery: "steer",
              resume: true,
              metadata: { fusion: { route: "fellow" } },
            });
            return;
          }

          const context = await unplannedReturnContext(sessionID, state, { runPlanChecks: true });
          const next = await switchRole({
            sessionID,
            state,
            targetRole: "lead",
            reason: "fellow_idle_without_handoff",
          });

          await ctx.session.synthetic({
            sessionID,
            text: buildAutoReturnBanner("Fellow turn reached idle without calling handoff_to_lead", [
              `Epoch: ${next.epoch}`,
              "Review the current workspace changes/tests before finalizing your response or re-dispatching Fellow.",
              ...context,
            ]),
            delivery: "steer",
            resume: true,
          });
        });
      } catch (err) {
        console.warn("[fusion] experimental.idle hook error:", err);
      }
    });

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "fusion-status",
        description: "Show who is working now, the plan and the models",
        async execute(input: any) {
          const sessionID = input?.sessionID;
          if (!sessionID) return;
          await withSessionLock(sessionID, async () => {
            const [state, ses] = await Promise.all([
              loadState(sessionID),
              ctx.session.get({ sessionID }).catch(() => undefined),
            ]);
            const lines = [
              "[FUSION STATUS]",
              `Working: ${state.role} (agent=${ses?.agent ?? "unknown"}, running=${state.running})`,
              `Epoch: ${state.epoch} | Revision: ${state.revision} | Turn handoffs: ${state.handoffsInTurn}/${maxHandoffsPerTurn}`,
              `Active session.model: ${formatModelRef(normalizeModelRef(ses?.model))}`,
              `Role models: lead=${formatModelRef(state.roleModels.lead)}, fellow=${formatModelRef(state.roleModels.fellow)}`,
              `Fellow steps: ${state.fellowSteps}/${maxFellowSteps} | Consecutive failures: ${state.consecutiveFailures}/${maxConsecutiveFailures}`,
              `Active plan: ${state.activePlan ? state.activePlan.summary : "(none)"}`,
              `Last return reason: ${state.lastReturnReason ?? "(none)"}`,
            ];
            await ctx.session.synthetic({
              sessionID,
              text: lines.join("\n"),
              delivery: input?.delivery ?? "steer",
              resume: false,
            });
          });
        },
      });
    });

    // The models a role can be given: enabled, active, and able to call tools.
    async function listModelChoices(): Promise<Array<{ providerID: string; id: string; name: string; variants: string[] }>> {
      if (!ctx.model?.list) return [];
      const res = await ctx.model.list().catch(() => undefined);
      const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
      return list
        .filter(
          (m) =>
            m &&
            typeof m.providerID === "string" &&
            typeof m.id === "string" &&
            m.enabled !== false &&
            (m.status === undefined || m.status === "active") &&
            m.capabilities?.tools !== false,
        )
        .map((m) => ({
          providerID: m.providerID,
          id: m.id,
          name: typeof m.name === "string" && m.name ? m.name : m.id,
          variants: Array.isArray(m.variants)
            ? m.variants.map((v: any) => (typeof v?.id === "string" ? v.id : "")).filter((v: string) => v.length > 0)
            : [],
        }));
    }

    // Another server (another project) may have saved since this one read the file.
    async function refreshSettingsFromDisk() {
      if (!settingsFile) return;
      const onDisk = readSettingsFile(settingsFile);
      if (JSON.stringify(onDisk) === JSON.stringify(settings)) return;
      settings = onDisk;
      cachedConfiguredRoleModels = undefined;
      await ctx.agent.reload?.();
    }

    // Which roles have their model fixed outside the saved settings: "option" (plugin options) or "config" (the
    // agent's own entry in the configuration). Read from the agents as they finally are, because OpenCode applies the
    // configuration after this plugin has built them.
    async function pinnedModels(): Promise<Record<Role, "" | "option" | "config">> {
      const configured = await resolveConfiguredRoleModels(true);
      const pin = (option: ModelRef | undefined, inForce: ModelRef | undefined, saved: string | undefined) =>
        option ? "option" : inForce && !sameModelRef(inForce, parseModelRef(saved)) ? "config" : "";
      return {
        lead: pin(optionLeadModel, configured.lead, settings.leadModel),
        fellow: pin(optionFellowModel, configured.fellow, settings.fellowModel),
      };
    }

    async function settingsSnapshot(includeModels: boolean) {
      const configured = await resolveConfiguredRoleModels(true);
      const pinnedModel = await pinnedModels();
      return {
        settingsFile: settingsFile ?? "",
        // What is saved. An empty string means "not chosen".
        saved: {
          modeName: settings.modeName ?? "",
          leadModel: settings.leadModel ?? "",
          fellowModel: settings.fellowModel ?? "",
          defaultMode: settings.defaultMode === true,
        },
        // What is in force here, after the configuration had its say.
        effective: {
          modeName: modeNameInForce,
          leadModel: configured.lead ? formatModelRef(configured.lead) : "",
          fellowModel: configured.fellow ? formatModelRef(configured.fellow) : "",
          defaultMode: optionDefaultMode ?? settings.defaultMode ?? false,
        },
        // Which values the configuration fixes, so a client can show them as not changeable here.
        pinned: {
          modeName: optionModeName !== undefined,
          leadModel: pinnedModel.lead,
          fellowModel: pinnedModel.fellow,
          defaultMode: optionDefaultMode !== undefined,
          all: settingsFile === undefined,
        },
        models: includeModels ? await listModelChoices() : [],
        // The two agents' ids, for clients that switch a session into the mode.
        agents: { lead: AGENT.lead, fellow: AGENT.fellow },
        // true while a saved mode name waits for the next start of OpenCode.
        restartNeeded:
          optionModeName === undefined && (cleanModeName(settings.modeName) ?? DEFAULT_MODE_NAME) !== modeNameInForce,
        // Why a save was refused, in words for the user. Empty when nothing went wrong.
        error: "",
      };
    }

    // Puts a model on one role of one session (also used when a saved setting should reach the session at hand).
    async function applyRoleModel(sessionID: string, role: Role, parsed: ModelRef): Promise<FusionState> {
      cachedConfiguredRoleModels = undefined;
      return withSessionLock(sessionID, async () => {
        const state = await loadState(sessionID, { refreshModels: true });
        const next: FusionState = {
          ...state,
          revision: state.revision + 1,
          roleModels: stripOptional({
            ...state.roleModels,
            [role]: parsed,
          }),
        };
        const [ses, configuredRoleModels] = await Promise.all([
          ctx.session.get({ sessionID }).catch(() => undefined),
          resolveConfiguredRoleModels(),
        ]);
        if (next.role === role && (ses?.model || !sameModelRef(parsed, configuredRoleModels[role]))) {
          await ctx.session.switchModel({ sessionID, model: parsed });
        }
        await saveState(next);
        return next;
      });
    }

    if (ctx.rpc?.register) {
      rpcRegistration = await ctx.rpc.register(
        {
          id: PLUGIN_ID,
          methods: {
            getState: {
              input: {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                },
                required: ["sessionID"],
                additionalProperties: false,
              },
              output: RPC_STATE_SCHEMA,
            },
            forceReturn: {
              input: {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  reason: { type: "string" },
                },
                required: ["sessionID"],
                additionalProperties: false,
              },
              output: RPC_STATE_SCHEMA,
            },
            setRoleModel: {
              input: {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  role: { type: "string" },
                  model: { type: "string" },
                },
                required: ["sessionID", "role", "model"],
                additionalProperties: false,
              },
              output: RPC_STATE_SCHEMA,
            },
            getSettings: {
              input: { type: "object", properties: {}, additionalProperties: false },
              output: RPC_SETTINGS_SCHEMA,
            },
            setSettings: {
              input: {
                type: "object",
                properties: {
                  modeName: { type: "string" },
                  leadModel: { type: "string" },
                  fellowModel: { type: "string" },
                  defaultMode: { type: "boolean" },
                  sessionID: { type: "string" },
                },
                additionalProperties: false,
              },
              output: RPC_SETTINGS_SCHEMA,
            },
          },
          events: {
            changed: {
              schema: {
                type: "object",
                properties: {
                  sessionID: { type: "string" },
                  revision: { type: "number" },
                  epoch: { type: "number" },
                  role: { type: "string" },
                },
                required: ["sessionID", "revision", "epoch", "role"],
                additionalProperties: false,
              },
            },
          },
        },
        {
          async getState(input: { sessionID: string }) {
            return withSessionLock(input.sessionID, async () => {
              const state = await loadState(input.sessionID);
              return toRpcSnapshot(state);
            });
          },
          async forceReturn(input: { sessionID: string; reason?: string }) {
            return withSessionLock(input.sessionID, async () => {
              const state = await loadState(input.sessionID);
              if (state.role === "lead") {
                return toRpcSnapshot(state);
              }
              const reason =
                typeof input.reason === "string" && input.reason.trim()
                  ? input.reason.trim()
                  : "rpc.forceReturn";
              const next = await switchRole({
                sessionID: input.sessionID,
                state,
                targetRole: "lead",
                reason,
              });
              return toRpcSnapshot(next);
            });
          },
          async setRoleModel(input: { sessionID: string; role: string; model: string }) {
            if (input.role !== "lead" && input.role !== "fellow") {
              throw new Error(`Invalid role "${input.role}". Expected "lead" or "fellow".`);
            }
            const parsed = parseModelRef(input.model);
            if (!parsed) {
              throw new Error(`Invalid model reference "${input.model}". Expected "providerID/modelID[#variant]".`);
            }
            return toRpcSnapshot(await applyRoleModel(input.sessionID, input.role, parsed));
          },
          async getSettings() {
            await refreshSettingsFromDisk();
            return settingsSnapshot(true);
          },
          async setSettings(input: {
            modeName?: string;
            leadModel?: string;
            fellowModel?: string;
            defaultMode?: boolean;
            sessionID?: string;
          }) {
            // A refusal is answered, not thrown: a thrown error reaches the client only as "RPC call failed".
            const refuse = async (error: string) => ({ ...(await settingsSnapshot(false)), error });
            if (!settingsFile) {
              return refuse("Saved settings are switched off for this project (settingsFile: false).");
            }
            await refreshSettingsFromDisk();
            const next: FusionSettings = { ...settings };
            const changedRoles: Array<{ role: Role; model: ModelRef }> = [];
            if (typeof input.modeName === "string") {
              if (!input.modeName.trim()) {
                delete next.modeName;
              } else {
                const name = cleanModeName(input.modeName);
                if (!name || name.toLowerCase() === AGENT.fellow) {
                  return refuse(
                    `"${input.modeName.trim()}" cannot be a mode name. Use Latin letters, digits and dashes, starting with a letter (at most ${MAX_MODE_NAME_LENGTH}), and not the name of another mode.`,
                  );
                }
                next.modeName = name;
              }
            }
            const choices =
              typeof input.leadModel === "string" || typeof input.fellowModel === "string" ? await listModelChoices() : [];
            for (const [key, role] of [
              ["leadModel", "lead"],
              ["fellowModel", "fellow"],
            ] as const) {
              const value = input[key];
              if (typeof value !== "string") continue;
              if (!value.trim()) {
                delete next[key];
                continue;
              }
              const parsed = parseModelRef(value);
              if (!parsed) return refuse(`Invalid model reference "${value}". Expected "providerID/modelID[#variant]".`);
              const known = choices.find((m) => m.providerID === parsed.providerID && m.id === parsed.id);
              if (!known) return refuse(`Model ${formatModelRef(parsed)} is not available here. Connect its provider first.`);
              if (parsed.variant && known.variants.length > 0 && !known.variants.includes(parsed.variant)) {
                return refuse(`Model ${parsed.providerID}/${parsed.id} has no variant "${parsed.variant}".`);
              }
              next[key] = formatModelRef(parsed);
              changedRoles.push({ role, model: parsed });
            }
            if (typeof input.defaultMode === "boolean") next.defaultMode = input.defaultMode;

            writeSettingsFile(settingsFile, next);
            settings = next;
            cachedConfiguredRoleModels = undefined;
            await ctx.agent.reload?.();

            // The session the user is looking at follows the new choice at once, unless the configuration fixes it.
            if (typeof input.sessionID === "string" && input.sessionID) {
              const pinnedModel = await pinnedModels();
              for (const { role, model } of changedRoles) {
                if (pinnedModel[role]) continue;
                await applyRoleModel(input.sessionID, role, model).catch((err: unknown) => {
                  console.warn("[fusion] could not apply the new model to the session:", err);
                });
              }
            }
            return settingsSnapshot(false);
          },
        },
      );
    }

    const abortController = new AbortController();
    const eventLoopPromise = (async () => {
      try {
        const stream = await Promise.resolve(
          ctx.event.subscribe({
            types: [
              "session.agent.selected",
              "session.model.selected",
              "session.execution.started",
              "session.execution.succeeded",
              "session.execution.failed",
              "session.execution.interrupted",
              "session.deleted",
            ],
            signal: abortController.signal,
          }),
        );

        for await (const ev of stream) {
          try {
            const sessionID = ev?.data?.sessionID;
            if (typeof sessionID !== "string" || !sessionID) continue;

            if (ev.type === "session.deleted") {
              await withSessionLock(sessionID, async () => {
                await ctx.storage.remove(`${STORAGE_PREFIX}${sessionID}`).catch(() => undefined);
                await ctx.session.instructions.entry
                  .remove({ sessionID, key: PLAN_INSTRUCTION_KEY })
                  .catch(() => undefined);
                await ctx.session.instructions.entry
                  .remove({ sessionID, key: STATE_INSTRUCTION_KEY })
                  .catch(() => undefined);
                activeExecuteCalls.delete(sessionID);
                modelMismatchBySession.delete(sessionID);
                const prefix = `${sessionID}\0`;
                for (const key of inFlightCallEpoch.keys()) {
                  if (key.startsWith(prefix)) inFlightCallEpoch.delete(key);
                }
              });
              continue;
            }

            await withSessionLock(sessionID, async () => {
              const state = await loadState(
                sessionID,
                ev.type === "session.agent.selected"
                  ? {
                      fallbackAgent:
                        typeof ev.data?.previous === "string" ? ev.data.previous : AGENT.lead,
                    }
                  : undefined,
              );

              if (ev.type === "session.agent.selected") {
                const selectedAgent = ev.data?.agent;
                const targetRole: Role = selectedAgent === AGENT.fellow ? "fellow" : "lead";
                if (state.role === targetRole) return;

                // Keep sticky session model aligned when switching agent manually
                const [ses, configured] = await Promise.all([
                  ctx.session.get({ sessionID }).catch(() => undefined),
                  resolveConfiguredRoleModels(),
                ]);
                const stickyModel = normalizeModelRef(ses?.model);
                const targetModel = state.roleModels[targetRole] ?? configured[targetRole];
                if (stickyModel && targetModel && !sameModelRef(stickyModel, targetModel)) {
                  if (await isModelAvailable(targetModel)) {
                    await ctx.session.switchModel({ sessionID, model: targetModel }).catch((err: unknown) => {
                      console.warn("[fusion] manual agent.selected switchModel failed:", err);
                    });
                  }
                }

                const reason =
                  targetRole === "lead" && !state.lastReturnReason
                    ? "manual_agent_switch"
                    : state.lastReturnReason;
                const next: FusionState = {
                  ...state,
                  role: targetRole,
                  revision: state.revision + 1,
                  epoch: state.epoch + 1,
                  ...(targetRole === "fellow"
                    ? {
                        fellowSteps: 0,
                        seenStepMessageIDs: [],
                        consecutiveFailures: 0,
                        lastFailedCommand: undefined,
                        lastNonZeroShellCommand: undefined,
                      }
                    : {
                        ...(reason !== undefined ? { lastReturnReason: reason } : {}),
                      }),
                };
                modelMismatchBySession.delete(sessionID);
                await saveState(next);
                await syncInstructionsOnTransition(next);
                return;
              }

              if (ev.type === "session.model.selected") {
                const model = normalizeModelRef(ev.data?.model);
                if (!model) return;
                if (sameModelRef(state.roleModels[state.role], model)) return;
                const next: FusionState = {
                  ...state,
                  revision: state.revision + 1,
                  roleModels: stripOptional({
                    ...state.roleModels,
                    [state.role]: model,
                  }),
                };
                await saveState(next);
                return;
              }

              if (ev.type === "session.execution.started") {
                if (state.running) return;
                const next: FusionState = {
                  ...state,
                  running: true,
                  revision: state.revision + 1,
                };
                await saveState(next);
                return;
              }

              if (ev.type === "session.execution.succeeded") {
                if (!state.running) return;
                const next: FusionState = {
                  ...state,
                  running: false,
                  revision: state.revision + 1,
                };
                await saveState(next);
                return;
              }

              if (ev.type === "session.execution.failed" || ev.type === "session.execution.interrupted") {
                const clearedRunning: FusionState = {
                  ...state,
                  running: false,
                  revision: state.revision + 1,
                };
                if (clearedRunning.role === "fellow") {
                  await switchRole({
                    sessionID,
                    state: clearedRunning,
                    targetRole: "lead",
                    reason: ev.type,
                  }).catch(async () => {
                    await saveState(clearedRunning);
                  });
                } else {
                  await saveState(clearedRunning);
                }
              }
            });
          } catch (evErr) {
            console.warn("[fusion] event handler error:", evErr);
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          console.warn("[fusion] event stream terminated:", err);
        }
      }
    })();

    return async function cleanup() {
      abortController.abort();
      await Promise.allSettled([
        contextHook?.dispose?.(),
        toolBeforeHook?.dispose?.(),
        toolAfterHook?.dispose?.(),
        promptHook?.dispose?.(),
        idleHook?.dispose?.(),
        rpcRegistration?.dispose?.(),
        eventLoopPromise,
      ]);
    };
  },
};

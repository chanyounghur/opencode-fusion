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
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";

type Role = "lead" | "fellow";
// The three agents this plugin defines: the two roles of the session, and the scout that looks things up in a child session.
type AgentKey = Role | "scout";

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
  // The assistant message of the last counted failure: several failing calls of one step count once.
  lastFailureStep?: string;
  lastFailedCommand?: string;
  lastNonZeroShellCommand?: string;
  activePlan?: ActivePlan;
  lastReturnReason?: string;
  // How many times this Fellow round was sent back by the verification gate.
  verifyBounces: number;
  // Consecutive Fellow rounds of planned work that came back unfinished without changing the workspace.
  stalledReturns: number;
  // The workspace's fingerprint when the current Fellow round began.
  lastWorkHash?: string;
  // The epoch in which Fellow was already asked once to hand back properly after stopping without a tool call.
  idleNudgeEpoch?: number;
  // A command the risk gate stopped, waiting for the user's `/fusion-approve`; and the one approval not yet used.
  pendingRisk?: { key: string; command: string; what: string };
  approvedRisk?: string;
  // Which phase Fellow is on (0-based), and how often its checkpoint was sent back by failing checks.
  phaseIndex: number;
  phaseBounces: number;
  // Set while Lead is looking at a checkpoint: the phase it concerns.
  awaitingCheckpoint?: number;
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
const DEFAULT_SCOUT_NAME = "scout";

const MAX_MODE_NAME_LENGTH = 24;
// OpenCode's own agents. A mode cannot take one of their names.
const RESERVED_AGENT_IDS = new Set(["build", "plan", "general", "explore", "compaction", "title", "summary"]);
// Every tool this plugin adds. Other modes (Build, Plan) never see them.
const FUSION_TOOLS = new Set(["handoff_to_fellow", "handoff_to_lead", "resume_fellow", "report_checkpoint"]);

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
// A lookup that needs more than this has become something else.
const DEFAULT_SCOUT_STEPS = 60;
const MAX_SEEN_MESSAGE_IDS = 100;
const DEFAULT_VERIFY_RETRIES = 2;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
const DEFAULT_MAX_STALLED_RETURNS = 3;
const MAX_CHECKS = 8;
const MAX_PHASES = 8;
const DEFAULT_OFF_PLAN_FILES_LIMIT = 5;
const CHECK_TAIL_CHARS = 1500;
const ROLE_MODEL_CACHE_TTL_MS = 2000;
const LEAD_ONLY_TOOLS = new Set(["handoff_to_fellow", "resume_fellow"]);
// A successful call of one of these means the work moved; it clears the count of consecutive failures.
const PROGRESS_TOOLS = new Set(["edit", "write", "patch"]);
const HANDBACK_REASONS = new Set(["completed", "blocked", "need_replan", "user_requested"]);
const HANDBACK_REASON_ALIASES: Record<string, string> = {
  complete: "completed", done: "completed", finished: "completed", success: "completed", succeeded: "completed",
  block: "blocked", stuck: "blocked", replan: "need_replan", needs_replan: "need_replan", user_request: "user_requested",
};

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
  // The host's own tool, open to Lead for one agent only: the scout (checked per call in `execute.before`).
  "subagent",
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
// Commands the scout may not run at all: they exist to change or remove things.
const SCOUT_REFUSED_COMMANDS = new Set(["rm", "rmdir", "mv", "del", "erase", "rd", "move", "ren", "rename", "chmod", "chown", "truncate", "dd", "mkfs", "sudo", "kill", "pkill", "taskkill", "brew", "apt", "apt-get", "choco", "winget"]);
const READ_ONLY_GIT = new Set([
  "log", "show", "status", "diff", "blame", "rev-parse", "rev-list", "ls-files", "ls-tree", "ls-remote", "describe",
  "shortlog", "cat-file", "merge-base", "name-rev", "for-each-ref", "show-ref", "show-branch", "grep", "whatchanged",
  "diff-tree", "count-objects", "version",
]);
const GIT_LISTING_FLAG = /^(-a|-r|-l|-v|-vv|-i|--all|--remotes|--list|--show-current|--verbose|--ignore-case|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column)(=|$)/;
// `git tag` reads only with these: `-a` there makes an annotated tag, and `-n` counts message lines.
const GIT_TAG_LISTING_FLAG = /^(-l|-i|-n\d*|--list|--ignore-case|--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--column|--no-column)(=|$)/;
// The flags that make `git branch` / `git tag` list whatever follows. Without one of them a name creates something
// (`git branch -v topic` makes a branch).
const GIT_LIST_MODE_FLAG = /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)(=|$)/;
// Variables that may be set in front of a command. Others can name a program to run (GIT_EXTERNAL_DIFF, PAGER, …).
const HARMLESS_ENV = /^(LC_[A-Z]+|LANG|LANGUAGE|TZ|TERM|COLUMNS|LINES|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|GIT_PAGER_IN_USE)=/;
// Files the read tool asks about first; the shell must not be a way around that.
const GUARDED_FILE = /(^|[\\/:])(\.env(\.[^\\/:]*)?|[^\\/:]*\.env(\.[^\\/:]*)?)$/;

/** Whether commands may reach cmd.exe or PowerShell. `OPENCODE_FUSION_SHELL=posix` says the shell is a POSIX one on Windows too (Git Bash). */
function windowsShell(): boolean {
  const forced = process.env.OPENCODE_FUSION_SHELL;
  if (forced === "posix") return false;
  if (forced === "windows") return true;
  return process.platform === "win32";
}

/**
 * A command line cut into its commands (at `|`, `&&`, `||`, `;`, new lines), each as its words. undefined: something
 * this cannot vouch for. The quoting read here is the POSIX shell's. On Windows the command may reach cmd.exe or
 * PowerShell, where `'` and `\"` mean something else, so there anything that depends on the difference is refused.
 */
function splitShellCommands(command: string, windows = windowsShell()): string[][] | undefined {
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
      // cmd.exe does not quote with `'`, and PowerShell does not escape with `\`.
      else if (windows && ((quote === "'" && /[&|;<>^\n]/.test(ch)) || (ch === "\\" && (next === '"' || next === "'")))) return undefined;
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
      if (windows && (next === '"' || next === "'")) return undefined;
      word += next;
      inWord = true;
      i += 1;
    } else if (windows && ch === "^") {
      return undefined;
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
  // A name after `branch` or `tag` creates one unless a flag puts the command in list mode.
  const listMode = flags.some((flag) => GIT_LIST_MODE_FLAG.test(flag));
  if (sub === "branch") return onlyListing && (positional.length === 0 || listMode);
  if (sub === "tag") return flags.every((flag) => GIT_TAG_LISTING_FLAG.test(flag)) && (positional.length === 0 || listMode);
  if (sub === "remote") return rest.length === 0 || (flags.length === rest.length && onlyListing) || positional[0] === "show" || positional[0] === "get-url";
  if (sub === "stash") return positional[0] === "list" || positional[0] === "show";
  if (sub === "worktree") return positional[0] === "list";
  if (sub === "reflog") return positional.length === 0 || positional[0] === "show";
  if (sub === "config") return flags.some((flag) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(flag)) && !flags.some((flag) => /^(--add|--unset|--unset-all|--replace-all|--edit|-e|--rename-section|--remove-section)$/.test(flag));
  return false;
}

/** true when every command on the line only looks at things. */
function isReadOnlyShell(command: string, windows = windowsShell()): boolean {
  if (!command.trim()) return false;
  const commands = splitShellCommands(command, windows);
  if (!commands || commands.length === 0) return false;
  return commands.every((words) => {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
      if (!HARMLESS_ENV.test(words[i])) return false;
      i += 1;
    }
    if (i >= words.length) return true;
    if (words.slice(i + 1).some((arg) => !arg.startsWith("-") && GUARDED_FILE.test(arg))) return false;
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

// Stands for the scout's agent id inside LEAD_PROMPT until the id is known (it follows the Fellow's name).
const SCOUT_PLACEHOLDER = "\u0000scout\u0000";

const LEAD_PROMPT = [
  "You are the Fusion LEAD: you read, decide how the work gets done, and review the result. You are the stronger and dearer model; Fellow is the cheaper one that does all the editing and all the running. You never change files or run anything that has effects yourself.",
  "- Inspect with read-only tools (read, glob, grep, webfetch, websearch, question, skill, session read/search, worktree list) and read-only shell commands (git log / status / diff / show / blame / branch --list, ls, cat, head, tail, wc, grep, rg, and pipes between them). Any other shell command is refused.",
  "- Looking things up goes to the scout: call the `subagent` tool with agent `" + SCOUT_PLACEHOLDER + "`. Use it whenever only the answer matters and not the raw material: a chat thread, a ticket, logs, a web page, frames of a video, anything behind tools you do not have (Code Mode `execute`, MCP tools), and finding out where something lives in the code or how a wide area of it works. The scout starts with none of this conversation, so the task you give it must stand alone: what to find, where to look, what to report. It runs in the background on the cheaper model and you are woken with a short report; start several at once when the questions are independent, then end your response and wait. Its raw material never enters this conversation, which is the point: everything you read yourself is reread, at your price and at Fellow's, on every later step. Read files yourself when you need their exact text to write the plan (the few files that will change), not to explore.",
  "- Everything that changes something goes to Fellow through `handoff_to_fellow`, however small: edits, installs, builds, tests, dev servers, screenshots, commits, pushes, deploys, pull requests. Never attempt edits, Code Mode execute, or worktree/session mutations yourself, and start no subagent other than the scout. Do not do a job in pieces through your own tools to avoid a handoff.",
  "- A handoff comes in two sizes. Small job (a command or two to run and report, a change of a few lines that you can state exactly): give only `summary` — what to do and what to report back, in one to three sentences — plus `checks` when a command can confirm it. Write no steps, files or requirements for a small job. Larger work: give `summary`, target `files`, ordered `steps`, `requirements`, `checks`, `verification` notes and explicit `replanIf` stop conditions.",
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

const SCOUT_PROMPT = [
  "You are the Fusion SCOUT. Another agent (Lead) is planning work and needs one thing found out. You have none of its conversation: the task you were given is everything you know.",
  "- Find the answer with the tools you have (reading files, searching, the web, Code Mode `execute` and MCP tools, shell commands that only look). Do not change the project: no edits, no installs, no commits, no branch or stash changes. If the task cannot be done without changing something, say so in the report instead.",
  "- Your report is all that reaches Lead. Put the answer first, then what it rests on, each point with its source (file and line, URL, message time, command), then what you could not determine. Say plainly when something is your inference rather than something you saw.",
  "- Keep the report short, about 400 words at most. Do not paste raw material (file contents, logs, thread transcripts): summarise it and say where it is. When Lead will need the raw material itself (images, a long log, a large diff), write it to a file under the temp folder named in your task and give the path.",
  "- Stay on the question. If it turns out to be the wrong question, say why in the report and stop; do not widen the task yourself.",
].join("\n");

/** Appended to every task the scout is given: where raw material goes. The folder is outside the project on purpose. */
function scoutTaskFooter(): string {
  const dir = nodePath.join(tmpdir(), "fusion-scout");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The scout is told the path either way; a missing folder shows up as its own error.
  }
  return `[Fusion] Temp folder for raw material Lead may need (never write inside the project): ${dir.replace(/\\/g, "/")}`;
}

const FELLOW_PROMPT = [
  "You are the Fusion FELLOW responsible for focused implementation and verification.",
  "- Carry out the active `fusion.plan` in instructions with clean, minimal edits, and run the specified `verification` commands.",
  "- The plan is Lead's best reading, not a guarantee. If carrying out a step would go against what the user asked, against the state of the repository (it would discard commits or uncommitted work, overwrite something that exists, publish or assert something nobody verified), or against what you observe, do not carry it out: stop and call `handoff_to_lead` with `need_replan`, saying what you found. Catching this is part of your job.",
  "- A plan that is only a `summary` is a small job: do exactly what it says and nothing more, then hand back briefly with what you did or found. Lead can see your tool results in this session, so point to them rather than repeating them.",
  "- Respect `replanIf` stop conditions and avoid blind retries after repeated failures.",
  "- You MUST finish every execution turn by calling `handoff_to_lead` (`completed`, `blocked`, or `need_replan`) with a concise summary, `changedFiles`, `verification`, and any `blockers` — never end a turn directly with plain text without handing back to Lead.",
  "- When the plan has `phases`, work on one phase at a time. When a phase is done, call `report_checkpoint` and wait for its answer before starting the next: it runs that phase's checks, and either tells you to go on or brings Lead in. The report has three places for remarks, and they are treated differently. `concerns`: a question or choice you need Lead to decide before going on. `deviations`: a departure from the plan that changes what gets built. Either of these brings Lead in, so use them when it matters and only then. `notes`: anything else worth knowing, such as what you could not verify in this environment or a small incidental fix; these are recorded for Lead without interrupting. Do not hide a real doubt in `notes`: a wrong turn carried through three phases costs the whole task. `amendments` in the plan are Lead's later corrections and override the original steps.",
  "- Before editing, reread the user's original request and compare it with the plan's `requirements` and `steps`. If the request asks for something the plan does not cover, do what the plan covers and list what is missing under `missingRequirements` when you hand back (use `need_replan` instead if the gap changes the approach).",
  "- When you hand back as `completed`, Fusion runs the plan's `checks` itself. If one fails, the handoff is refused and the output comes back to you: fix the cause and hand back again. You need not run them once more just before handing back. If a check cannot run in this environment or the command itself is wrong, hand back with reason `blocked` and say why instead of retrying.",
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
  const own = new Set(FUSION_TOOLS);
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
    { action: "handoff_to_lead", resource: "*", effect: "allow" },
    { action: "report_checkpoint", resource: "*", effect: "allow" },
  );
  return filtered;
}

/** The scout looks and reports. It gets the tools for that and no editing; its shell is checked per call. */
function buildScoutPermissions(existingRules: PermissionRule[] = []): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];
  for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill", "execute", "shell", "opencode_session_search", "opencode_session_read", "opencode_models"]) {
    rules.push({ action, resource: "*", effect: "allow" });
  }
  for (const resource of ["*.env", "*.env.*", ".env", ".env.*"]) rules.push({ action: "read", resource, effect: "ask" });
  // Stricter rules the configuration gave this agent are kept.
  for (const rule of existingRules) {
    if (!rule || typeof rule.action !== "string" || typeof rule.resource !== "string") continue;
    if (rule.effect !== "deny" && rule.effect !== "ask") continue;
    if (rule.action === "*" && rule.resource === "*") continue;
    rules.push({ action: rule.action, resource: rule.resource, effect: rule.effect });
  }
  return rules;
}

/**
 * Why this command counts as changing the project, or undefined when it does not. Used for the scout's shell and for
 * the plan's checks: both may look and run things, neither may commit, delete or install.
 */
function scoutShellRefusal(command: string): string | undefined {
  if (!command.trim()) return "An empty command.";
  const commands = splitShellCommands(command.replace(/>\s*("[^"]*"|'[^']*'|[^\s|;&]+)/g, " "), false);
  // A line this cannot read is judged by its words alone.
  const flat = commands ?? [command.split(/\s+/)];
  for (const words of flat) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    const name = (words[i] ?? "").replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.exe$/, "");
    const args = words.slice(i + 1);
    if (name === "git" && !isReadOnlyGit(args) && !["fetch"].includes(args.find((arg) => !arg.startsWith("-")) ?? "")) {
      return `\`git ${args.slice(0, 2).join(" ")}\` changes the repository.`;
    }
    if (SCOUT_REFUSED_COMMANDS.has(name)) return `\`${name}\` changes files or installs things.`;
    if ((name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" || name === "pip" || name === "pip3") && /^(i|install|add|remove|uninstall|update|upgrade|publish|link|ci)$/.test(args.find((arg) => !arg.startsWith("-")) ?? "")) {
      return `\`${name} ${args[0] ?? ""}\` installs or removes packages.`;
    }
  }
  return undefined;
}

/** A command that would lose work as the repository stands now. `key` names the operation and its target, so one approval covers one thing. */
interface Risk {
  key: string;
  what: string;
}

/**
 * Looks at a command line Fellow is about to run and says whether it would lose work: commits that are on no other
 * branch and no remote, uncommitted changes, untracked files, or history on a remote. The judgement is made against
 * the repository as it is at this moment, not against the wording of the plan. Anything it cannot read is let through:
 * this stops the plain cases, it is not a sandbox.
 */
function findRisk(command: string, root: string): Risk | undefined {
  const stripped = command.replace(/\d?>>?\s*("[^"]*"|'[^']*'|[^\s|;&]+)/g, " ");
  const lines = splitShellCommands(stripped, false) ?? [stripped.trim().split(/\s+/)];
  let cwd = root;
  for (const words of lines) {
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
    const name = (words[i] ?? "").replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.exe$/, "");
    const args = words.slice(i + 1);
    if (name === "cd" && args[0]) {
      cwd = nodePath.resolve(cwd, args[0]);
      continue;
    }
    if (name !== "git") continue;
    let dir = cwd;
    let j = 0;
    while (j < args.length && args[j].startsWith("-")) {
      if (args[j] === "-C") {
        dir = nodePath.resolve(dir, args[j + 1] ?? ".");
        j += 2;
      } else if (args[j] === "-c" || args[j] === "--git-dir" || args[j] === "--work-tree") j += 2;
      else j += 1;
    }
    const sub = args[j];
    const rest = args.slice(j + 1);
    const flags = rest.filter((arg) => arg.startsWith("-"));
    const names = rest.filter((arg) => !arg.startsWith("-"));
    const git = (...gitArgs: string[]) => spawnSync("git", ["-C", dir, ...gitArgs], { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
    const text = (...gitArgs: string[]) => {
      const out = git(...gitArgs);
      return out.status === 0 && typeof out.stdout === "string" ? out.stdout.trim() : "";
    };
    const exists = (ref: string) => git("rev-parse", "--verify", "--quiet", ref).status === 0;
    // Commits reachable from `ref` that are neither under `keep` nor on any remote-tracking branch.
    // A `keep` that does not exist yet (a ref an earlier command on the same line will fetch) is left out, so the
    // judgement is then made against the remotes as they are known now.
    const onlyHere = (ref: string, keep: string) => {
      const listed = text("log", "--oneline", "-n", "40", ref, "--not", ...(exists(keep) ? [keep] : []), "--remotes");
      return listed ? listed.split("\n") : [];
    };
    const sample = (rows: string[]) => `${rows.slice(0, 3).join(" | ")}${rows.length > 3 ? ` | … ${rows.length - 3} more` : ""}`;

    if (sub === "checkout" || sub === "switch" || sub === "branch") {
      // Moving an existing branch somewhere else: `checkout -B`, `switch -C`, `branch -f`.
      const forceFlag = sub === "checkout" ? ["-B"] : sub === "switch" ? ["-C", "--force-create"] : ["-f", "--force"];
      const at = rest.findIndex((arg) => forceFlag.includes(arg));
      if (at >= 0 && !(sub === "branch" && flags.some((flag) => /^(-d|-D|--delete|-m|-M|--move)$/.test(flag)))) {
        const after = rest.slice(at + 1).filter((arg) => !arg.startsWith("-"));
        const branch = sub === "branch" ? names[0] : after[0];
        const start = (sub === "branch" ? names[1] : after[1]) ?? "HEAD";
        if (branch && exists(`refs/heads/${branch}`)) {
          const lost = onlyHere(`refs/heads/${branch}`, start);
          if (lost.length > 0) {
            return {
              key: `move-branch:${branch}`,
              what: `It moves the existing local branch \`${branch}\` to \`${start}\`. ${lost.length}${lost.length === 40 ? "+" : ""} commit(s) on it are on no remote and would be left on no branch: ${sample(lost)}.`,
            };
          }
        }
      }
      if (sub === "branch" && flags.some((flag) => flag === "-D" || flag === "--force") && flags.some((flag) => /^(-d|-D|--delete)$/.test(flag))) {
        for (const branch of names) {
          if (!exists(`refs/heads/${branch}`)) continue;
          const lost = onlyHere(`refs/heads/${branch}`, "HEAD");
          if (lost.length > 0) {
            return {
              key: `delete-branch:${branch}`,
              what: `It deletes the local branch \`${branch}\`, which has ${lost.length}${lost.length === 40 ? "+" : ""} commit(s) that are neither merged here nor on any remote: ${sample(lost)}.`,
            };
          }
        }
      }
    }
    if (sub === "reset" && flags.includes("--hard")) {
      const dirty = text("status", "--porcelain", "--untracked-files=no").split("\n").filter(Boolean);
      const target = names[0] ?? "HEAD";
      const lost = target === "HEAD" ? [] : onlyHere("HEAD", target);
      if (dirty.length > 0 || lost.length > 0) {
        return {
          key: "reset-hard",
          what: [
            "It resets the working tree and the branch.",
            dirty.length > 0 ? `${dirty.length} file(s) have uncommitted changes that would be gone: ${dirty.slice(0, 5).map((row) => row.trim().replace(/^\S+\s+/, "")).join(", ")}${dirty.length > 5 ? ", …" : ""}.` : "",
            lost.length > 0 ? `${lost.length}${lost.length === 40 ? "+" : ""} commit(s) on this branch are on no remote and would be left on no branch: ${sample(lost)}.` : "",
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
    }
    if (sub === "clean" && flags.some((flag) => flag === "--force" || /^-[A-Za-z]*f/.test(flag)) && !flags.some((flag) => flag === "--dry-run" || /^-[A-Za-z]*n/.test(flag))) {
      const doomed = text("clean", "-n", ...rest.filter((arg) => arg !== "--force").map((arg) => (/^-[A-Za-z]+$/.test(arg) ? arg.replace("f", "") : arg)).filter((arg) => arg !== "-"))
        .split("\n")
        .filter(Boolean);
      if (doomed.length > 0) {
        return {
          key: "clean",
          what: `It deletes ${doomed.length} untracked file(s) or folder(s) for good: ${doomed.slice(0, 5).map((row) => row.replace(/^Would remove /, "")).join(", ")}${doomed.length > 5 ? ", …" : ""}.`,
        };
      }
    }
    if (sub === "push") {
      const forced = flags.some((flag) => flag === "-f" || flag === "--force" || flag.startsWith("--force-with-lease") || flag.startsWith("--force-if-includes") || flag === "--mirror" || flag === "--delete" || flag === "-d");
      const refspec = names.slice(1).find((spec) => spec.startsWith("+") || spec.startsWith(":"));
      if (forced || refspec) {
        return {
          key: `rewrite-remote:${names.join(" ") || "(default)"}`,
          what: `It rewrites or deletes history on a remote (\`git push ${rest.join(" ")}\`), which others may already have.`,
        };
      }
    }
  }
  return undefined;
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
      // Told by the exit code (127 from a POSIX shell, 9009 or cmd.exe's own message on Windows), never by words that
      // a failing test might print itself.
      const notFound = code === 127 || code === 9009 || (code === 1 && /is not recognized as an internal or external command/i.test(output.slice(-400)));
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
  // The commit is part of the fingerprint: a round that commits its work leaves a clean tree, which is not "nothing".
  const head = git(["rev-parse", "HEAD"]);
  const hash = createHash("sha1")
    .update(typeof head.stdout === "string" ? head.stdout : "")
    .update(rows.join("\n"))
    .update(typeof diff.stdout === "string" ? diff.stdout : "")
    .digest("hex");
  const summary = rows.length
    ? [`Workspace changes (${rows.length} files${typeof stat.stdout === "string" && stat.stdout.trim() ? `;${stat.stdout.trim().replace(/^\d+ files? changed,?/, "")}` : ""}):`, ...rows.slice(0, 40).map((line) => `  ${line}`), ...(rows.length > 40 ? [`  … ${rows.length - 40} more`] : [])]
    : ["Workspace changes: none"];
  return { summary, hash, files: rows.map((line) => line.slice(3).trim().replace(/^"|"$/g, "")) };
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
    // The scout is named after the Fellow when the plain name is taken by one of the two.
    const scoutAgentID = [DEFAULT_SCOUT_NAME, `${fellowAgentID}-scout`].find((id) => id !== fellowAgentID && id !== modeNameInForce.toLowerCase()) ?? `${fellowAgentID}-scout`;
    const AGENT: Record<AgentKey, string> = { lead: modeNameInForce.toLowerCase(), fellow: fellowAgentID, scout: scoutAgentID };
    const leadPrompt = LEAD_PROMPT.replace(SCOUT_PLACEHOLDER, scoutAgentID);
    // The saved model this plugin last put on each agent, so a later rebuild does not mistake it for configuration.
    const appliedModel: RoleModels & { scout?: ModelRef } = {};
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
    const optionLeadModel = parseModelRef(rawOptions.leadModel);
    const optionFellowModel = parseModelRef(rawOptions.fellowModel);

    const leadAllowedTools = new Set<string>([
      ...BASE_LEAD_ALLOWLIST,
      ...sanitizeExtraLeadTools(rawOptions.extraLeadTools),
    ]);
    // The agent's own rules must let the shell through; whether a command may run is decided per call, in
    // `execute.before`: read-only commands only.
    const leadPermissionTools = new Set<string>([...leadAllowedTools, "shell"]);

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
        agent.description = "Read-only Architect/Reviewer Lead that designs verified steps and hands off via handoff_to_fellow.";
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

      editor.update(AGENT.scout, (agent: any) => {
        // Reached through the host's `subagent` tool: a child session of its own, on the Fellow's model.
        agent.mode = "subagent";
        agent.hidden = false;
        agent.name = AGENT.scout.charAt(0).toUpperCase() + AGENT.scout.slice(1);
        if (agent.steps === undefined) agent.steps = DEFAULT_SCOUT_STEPS;
        agent.description =
          "Looks one thing up and reports briefly: a chat thread, a ticket, logs, a web page, or where something is in the code. Read-only. Its task must stand alone.";
        if (!String(agent.system ?? "").includes(SCOUT_PROMPT)) {
          agent.system = agent.system ? `${agent.system}\n\n${SCOUT_PROMPT}` : SCOUT_PROMPT;
        }
        const savedFellow = parseModelRef(settings.fellowModel);
        if (optionFellowModel) {
          agent.model = optionFellowModel;
        } else if (!normalizeModelRef(agent.model) || sameModelRef(normalizeModelRef(agent.model), appliedModel.scout)) {
          appliedModel.scout = savedFellow;
          if (savedFellow) agent.model = savedFellow;
          else delete agent.model;
        }
        agent.permissions = buildScoutPermissions(Array.isArray(agent.permissions) ? agent.permissions : []);
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
        ...(typeof data.lastFailureStep === "string" ? { lastFailureStep: data.lastFailureStep } : {}),
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
        ...(data.pendingRisk && typeof data.pendingRisk.key === "string"
          ? { pendingRisk: { key: data.pendingRisk.key, command: String(data.pendingRisk.command ?? ""), what: String(data.pendingRisk.what ?? "") } }
          : {}),
        ...(typeof data.approvedRisk === "string" ? { approvedRisk: data.approvedRisk } : {}),
        phaseIndex: typeof data.phaseIndex === "number" && data.phaseIndex >= 0 ? data.phaseIndex : 0,
        phaseBounces: typeof data.phaseBounces === "number" && data.phaseBounces >= 0 ? data.phaseBounces : 0,
        ...(typeof data.awaitingCheckpoint === "number" ? { awaitingCheckpoint: data.awaitingCheckpoint } : {}),
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
              lastFailureStep: undefined,
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
            const state = await loadState(sessionID, { refreshModels: true });
            if (toolCtx?.agent !== AGENT.lead || state.role !== "lead") {
              throw new Error("handoff_to_fellow is only available in Lead mode.");
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
            // Nothing is dropped in silence: a list too long to run is sent back to be cut down.
            const givenLists: unknown[] = [args?.checks, ...(Array.isArray(args?.phases) ? args.phases.map((phase: any) => phase?.checks) : [])];
            const longest = Math.max(0, ...givenLists.map((list) => (Array.isArray(list) ? list.length : 0)));
            const total = givenLists.reduce((sum: number, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
            if (longest > MAX_CHECKS || total > MAX_CHECKS * 2) {
              throw new Error(
                `Too many checks: at most ${MAX_CHECKS} in one list and ${MAX_CHECKS * 2} in the whole plan (got ${longest} in one list, ${total} in all). Keep the ones that say most, or combine several into one script.`,
              );
            }
            // Fusion runs the checks itself, outside the tools' own permission rules, so a check may only verify.
            for (const check of [...checks, ...phases.flatMap((phase) => phase.checks)]) {
              const refusal = scoutShellRefusal(check.command) ?? (findRisk(check.command, await sessionRoot(sessionID)) ? "It would lose work." : undefined);
              if (refusal) {
                throw new Error(`A check only verifies; this one changes something: \`${check.command.slice(0, 120)}\`. ${refusal} Put it in \`steps\`, where Fellow runs it, and keep \`checks\` to commands that look and report.`);
              }
            }
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
            const startHash = workspaceDigest(await sessionRoot(sessionID)).hash;
            const next: FusionState = { ...switched, phaseIndex: 0, phaseBounces: 0, ...(startHash ? { lastWorkHash: startHash } : {}) };
            if (!startHash) delete next.lastWorkHash;
            delete next.awaitingCheckpoint;
            await saveState(next);

            const targetModel = next.roleModels.fellow ?? (await resolveConfiguredRoleModels()).fellow;
            return {
              content: [
                "[FUSION: FELLOW MODE ACTIVE]",
                `Active agent: fellow | Target model: ${formatModelRef(targetModel)} | Epoch: ${next.epoch} | Handoff ${next.handoffsInTurn}/${maxHandoffsPerTurn}`,
                `Plan summary: ${plan.summary} (${files.length} files, ${steps.length} steps). Follow active \`fusion.plan\` in instructions. Guardrails: maxConsecutiveFailures=${maxConsecutiveFailures}, maxFellowSteps=${maxFellowSteps}. Call \`handoff_to_lead\` when finished or blocked.`,
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
              enum: ["completed", "blocked", "need_replan", "user_requested"],
              description: "completed: the work is done (Fusion runs the plan's checks). blocked: something outside the plan stops you. need_replan: the plan itself should change. user_requested: the user asked you to stop.",
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
            // The reason decides whether the checks run, so a near miss ("done") must not slip past them.
            const givenReason = typeof args?.reason === "string" ? args.reason.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
            const reason = HANDBACK_REASONS.has(givenReason) ? givenReason : HANDBACK_REASON_ALIASES[givenReason] ?? (givenReason ? undefined : "completed");
            if (!reason) {
              throw new Error(`handoff_to_lead: unknown reason "${String(args?.reason).slice(0, 40)}". Use one of: completed, blocked, need_replan, user_requested.`);
            }
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
            // A round counts as stalled when planned work came back unfinished with the workspace exactly as it was
            // when the round began. A small job (a lookup, a command to run) changes nothing by nature and is not counted.
            const smallJob = Boolean(plan && plan.phases.length === 0 && plan.files.length === 0 && plan.steps.length === 1 && plan.steps[0] === plan.summary);
            const stalledReturns = unclean && !smallJob && digest.hash !== undefined && digest.hash === state.lastWorkHash ? state.stalledReturns + 1 : 0;

            const switched = await switchRole({
              sessionID,
              state,
              targetRole: "lead",
              reason,
            });
            const next: FusionState = { ...switched, stalledReturns };
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
                  ? `Note: this round came back unfinished and changed nothing in the workspace (${stalledReturns}/${maxStalledReturns} before further handoffs are refused in this turn).`
                  : "",
              ]
                .filter(Boolean)
                .join("\n"),
            };
          });
        },
      });
    });

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
      if (event.agent === AGENT.scout) {
        // A child session of its own: no role state. The scout looks; it does not change the repository.
        if (event.tool === "shell") {
          const command = rawShellCommand(event.input);
          const refusal = scoutShellRefusal(command);
          if (refusal) throw new Error(`The scout does not change the project. ${refusal} If the task needs this, say so in your report instead.`);
        }
        return;
      }
      await withSessionLock(sessionID, async () => {
        const state = await loadState(sessionID);

        if (event.agent === AGENT.lead) {
          if (event.tool === "subagent") {
            if (state.role !== "lead") throw new Error("subagent is only available in Lead mode.");
            const input = event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {};
            const asked = [input.agent, input.subagent_type, input.type].find((value) => typeof value === "string") as string | undefined;
            // A follow-up to a scout already started names its session and may leave the agent out.
            const followUp = typeof input.sessionID === "string" && input.sessionID.length > 0;
            if (asked !== AGENT.scout && !(followUp && asked === undefined)) {
              throw new Error(
                `Lead starts one kind of subagent only: \`${AGENT.scout}\`, for looking things up. ${asked ? `"${asked}" is not it. ` : ""}Work that changes something goes to Fellow with handoff_to_fellow.`,
              );
            }
            // The scout runs on this session's Fellow model, also when that was chosen for this session only.
            const fellowModel = state.roleModels.fellow ?? (await resolveConfiguredRoleModels()).fellow;
            if (fellowModel && !followUp) input.model = formatModelRef(fellowModel);
            if (typeof input.prompt === "string" && !followUp) input.prompt = `${input.prompt}\n\n${scoutTaskFooter()}`;
            if (event?.id) inFlightCallEpoch.set(callKey(sessionID, String(event.id)), state.epoch);
            return;
          }
          if (event.tool === "shell") {
            // Looking is always open to Lead; a command with effects is Fellow's.
            const command = rawShellCommand(event.input);
            if (state.role !== "lead") throw new Error("shell is only available in Lead mode.");
            if (!isReadOnlyShell(command)) {
              throw new Error(
                `Lead runs read-only commands only (git log / status / diff / show / blame, ls, cat, head, tail, wc, grep, rg, and pipes between them). This one is not: ${command.replace(/\s+/g, " ").trim().slice(0, 120)}. Hand it to Fellow with handoff_to_fellow; for a small job give only \`summary\` (what to run or change, and what to report back).`,
              );
            }
            if (event?.id) inFlightCallEpoch.set(callKey(sessionID, String(event.id)), state.epoch);
            return;
          }
          if (!leadAllowedTools.has(event.tool)) {
            throw new Error(
              `Tool "${event.tool}" is disabled in Lead mode (strict PLAN allowlist). Use read-only tools or call handoff_to_fellow first.`,
            );
          }
          if (state.role !== "lead" && LEAD_ONLY_TOOLS.has(event.tool)) {
            throw new Error(`${event.tool} is only available in Lead mode.`);
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

          if (event.tool === "shell") {
            // The risk gate. Whatever the plan said, this is the moment the command would take effect.
            const command = rawShellCommand(event.input);
            const risk = findRisk(command, await sessionRoot(sessionID));
            if (risk) {
              if (state.approvedRisk === risk.key) {
                const used: FusionState = { ...state, revision: state.revision + 1 };
                delete used.approvedRisk;
                delete used.pendingRisk;
                await saveState(used, { emit: false });
              } else {
                await saveState({ ...state, pendingRisk: { key: risk.key, command: command.replace(/\s+/g, " ").trim().slice(0, 300), what: risk.what }, revision: state.revision + 1 }, { emit: false });
                throw new Error(
                  [
                    "[FUSION RISK GATE] Not run: this command would lose work.",
                    risk.what,
                    "If the goal can be reached without losing it (a new branch or a worktree instead of moving an existing branch, a commit or a stash before a reset), do that instead.",
                    "If it really has to be this command, do not try variations of it: call `handoff_to_lead` with `need_replan` and say exactly this. Only the user can allow it, by typing `/fusion-approve`.",
                  ].join("\n"),
                );
              }
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
          if (FUSION_TOOLS.has(event?.tool)) return;

          const state = await loadState(sessionID);
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
          let lastFailureStep = state.lastFailureStep;
          let lastFailedCommand = state.lastFailedCommand;
          let lastNonZeroShellCommand = state.lastNonZeroShellCommand;
          const stepID = typeof event.messageID === "string" && event.messageID.length > 0 ? event.messageID : undefined;
          // Parallel calls of one step that all fail are one failure, not several.
          const countFailure = () => {
            if (stepID && stepID === lastFailureStep) return;
            consecutiveFailures += 1;
            lastFailureStep = stepID;
          };

          const meta =
            event?.result && typeof event.result === "object" && event.result.metadata
              ? (event.result.metadata as Record<string, unknown>)
              : undefined;
          const isBackgroundRunning = event?.tool === "shell" && isBackgroundShellResult(meta);

          if (event.status === "error") {
            countFailure();
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
              countFailure();
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
                countFailure();
                if (cmd) {
                  lastFailedCommand = cmd;
                  lastNonZeroShellCommand = cmd;
                }
              }
            } else {
              consecutiveFailures = 0;
              lastNonZeroShellCommand = undefined;
            }
          } else if (PROGRESS_TOOLS.has(event.tool)) {
            consecutiveFailures = 0;
            lastNonZeroShellCommand = undefined;
          }
          // Anything else (a read, a search) says nothing about whether the work is getting anywhere: it neither adds
          // to the count nor clears it.

          const updated: FusionState = {
            ...state,
            revision: state.revision + 1,
            fellowSteps,
            seenStepMessageIDs: seen,
            consecutiveFailures,
            ...(lastFailureStep !== undefined ? { lastFailureStep } : {}),
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
          const state: FusionState =
            loaded.handoffsInTurn !== 0 || loaded.stalledReturns !== 0
              ? { ...loaded, handoffsInTurn: 0, stalledReturns: 0, revision: loaded.revision + 1 }
              : loaded;

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
        name: "fusion-approve",
        description: "Allow, once, the command the risk gate stopped",
        async execute(input: any) {
          const sessionID = input?.sessionID;
          if (!sessionID) return;
          await withSessionLock(sessionID, async () => {
            const state = await loadState(sessionID);
            const pending = state.pendingRisk;
            if (!pending) {
              await ctx.session.synthetic({ sessionID, text: "[FUSION] Nothing is waiting for approval.", delivery: input?.delivery ?? "steer", resume: false });
              return;
            }
            const next: FusionState = { ...state, approvedRisk: pending.key, revision: state.revision + 1 };
            delete next.pendingRisk;
            await saveState(next);
            await ctx.session.synthetic({
              sessionID,
              text: [
                "[FUSION: THE USER APPROVED A STOPPED COMMAND]",
                `Command: ${pending.command}`,
                pending.what,
                "The user allowed this once, knowing the above. It may be run now; the approval is used up by that one run and covers nothing else.",
              ].join("\n"),
              delivery: input?.delivery ?? "steer",
              resume: true,
            });
          });
        },
      });
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

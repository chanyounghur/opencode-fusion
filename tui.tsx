/** @jsxImportSource @opentui/solid */
/**
 * Fusion — the TUI part.
 *
 * Adds `/fusion-settings`: a menu where the user picks the Lead and Fellow models from the models OpenCode really has,
 * names the mode, and chooses whether OpenCode starts in it. Nothing is kept here: every value is read from and saved
 * through the server part (`index.ts`, RPC `fusion`), so any other client of the same server sees the same settings.
 *
 * Also shows both models under the prompt of a Fusion session ("Lead … · Fellow …"), the one at work in full colour.
 * OpenCode's own line above it names only the model of whoever is working at the moment.
 */
import { appendFileSync } from "node:fs";
import { useTerminalDimensions } from "@opentui/solid";
import { Show, createEffect, createMemo, createSignal } from "solid-js";

const RPC_ID = "fusion";
const DEFAULT_MODE_NAME = "Fusion";

interface SettingsValues {
  modeName: string;
  leadModel: string;
  fellowModel: string;
  defaultMode: boolean;
}

interface ModelChoice {
  providerID: string;
  id: string;
  name: string;
  variants: string[];
}

interface Snapshot {
  settingsFile: string;
  saved: SettingsValues;
  effective: SettingsValues;
  pinned: { modeName: boolean; leadModel: string; fellowModel: string; defaultMode: boolean; all: boolean };
  models: ModelChoice[];
  agents: { lead: string; fellow: string };
  restartNeeded: boolean;
  error: string;
}

type Role = "lead" | "fellow";

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

// Below this width the line under the prompt is left to OpenCode's own path and shortcuts.
const MIN_WIDTH_FOR_ROLE_MODELS = 100;

const ROLE_KEY: Record<Role, "leadModel" | "fellowModel"> = { lead: "leadModel", fellow: "fellowModel" };
const ROLE_LABEL: Record<Role, string> = { lead: "Lead", fellow: "Fellow" };

function debug(label: string, value: unknown) {
  const file = process.env.FUSION_TUI_DEBUG;
  if (!file) return;
  try {
    appendFileSync(file, `${new Date().toISOString()} ${label} ${JSON.stringify(value)}\n`);
  } catch {
    // Debug output only.
  }
}

function splitRef(ref: string): { base: string; variant: string } {
  const hash = ref.indexOf("#");
  return hash < 0 ? { base: ref, variant: "" } : { base: ref.slice(0, hash), variant: ref.slice(hash + 1) };
}

// Short enough for a menu row: the model as OpenCode names it, then the chosen depth.
function modelLabel(ref: string, models: ModelChoice[]): string {
  if (!ref) return "";
  const { base, variant } = splitRef(ref);
  const known = models.find((m) => `${m.providerID}/${m.id}` === base);
  const name = known ? known.name : base;
  return variant ? `${name} · ${variant}` : name;
}

function errorText(err: unknown): string {
  if (err && typeof err === "object" && typeof (err as any).message === "string") return (err as any).message;
  return String(err);
}

export default {
  id: "fusion",
  setup(api: any) {
    // The project the TUI is showing, so the call reaches the server part loaded for that project.
    function locationRef(): unknown {
      const current = api.location;
      if (!current || typeof current !== "object") return undefined;
      if (current.ref && typeof current.ref === "object") return current.ref;
      if (typeof current.directory === "string") {
        return typeof current.workspaceID === "string"
          ? { directory: current.directory, workspaceID: current.workspaceID }
          : { directory: current.directory };
      }
      return undefined;
    }

    function currentSessionID(): string | undefined {
      const route = api.ui?.router?.current?.();
      return route && route.type === "session" && typeof route.sessionID === "string" ? route.sessionID : undefined;
    }

    async function call(method: string, input: Record<string, unknown>): Promise<Snapshot> {
      const location = locationRef();
      debug("call", { method, input, location });
      const res = await api.client.rpc.call({ rpcID: RPC_ID, method, input, ...(location ? { location } : {}) });
      return (res?.output ?? res?.data?.output ?? res) as Snapshot;
    }

    // The server announces a rebuilt mode list without saying for which project, and the TUI skips such
    // announcements. So after a save the TUI is told here to read the modes again; otherwise it would go on showing
    // (and sending) the model the mode had before.
    async function refreshModes() {
      const agents = api.data?.location?.agent;
      const ref = locationRef();
      try {
        if (typeof agents?.invalidate === "function") await agents.invalidate(ref);
        if (typeof agents?.sync === "function") await agents.sync(ref);
      } catch (err) {
        debug("refresh error", errorText(err));
      }
    }

    // What the line under the prompt needs: the two agents' ids and the models' names. Read once, and again after a
    // save from `/fusion-settings` (`settingsRevision` also makes open sessions ask for their models again).
    const [catalog, setCatalog] = createSignal<{ agents: { lead: string; fellow: string }; models: ModelChoice[] }>();
    const [settingsRevision, setSettingsRevision] = createSignal(0);
    async function loadCatalog() {
      try {
        const snapshot = await call("getSettings", {});
        setCatalog({ agents: snapshot.agents, models: snapshot.models });
      } catch (err) {
        debug("catalog error", errorText(err));
      }
      setSettingsRevision((n) => n + 1);
    }

    function RoleModels(props: { sessionID?: string }) {
      const dimensions = useTerminalDimensions();
      const session = createMemo(() => (props.sessionID ? api.data.session.get(props.sessionID) : undefined));
      // Who is working in this session, or nothing when the session is in another mode.
      const working = createMemo<Role | undefined>(() => {
        const agents = catalog()?.agents;
        const agent = session()?.agent;
        if (!agents || !agent) return undefined;
        return agent === agents.lead ? "lead" : agent === agents.fellow ? "fellow" : undefined;
      });
      // As text, so the question below is asked again only when the model really changes, not on every session update.
      const sessionModel = createMemo(() => JSON.stringify(session()?.model ?? null));
      const [roleModels, setRoleModels] = createSignal<{ lead?: ModelRef; fellow?: ModelRef }>();
      createEffect(() => {
        const sessionID = props.sessionID;
        // Asked again when the role changes hands, the session's model changes, or settings are saved.
        const role = working();
        sessionModel();
        settingsRevision();
        if (!sessionID || !role) {
          setRoleModels(undefined);
          return;
        }
        call("getState", { sessionID })
          .then((state: any) => setRoleModels(state?.roleModels ?? {}))
          .catch((err: unknown) => debug("state error", errorText(err)));
      });
      const name = (role: Role) => {
        const ref = roleModels()?.[role];
        if (!ref) return role === "lead" ? "화면에서 고른 모델" : "정하지 않음";
        const known = catalog()?.models.find((m) => m.providerID === ref.providerID && m.id === ref.id);
        return known ? known.name : ref.id;
      };
      const color = (role: Role) => (working() === role ? api.theme.text.base : api.theme.text.muted);
      return (
        <Show when={working() && roleModels() && dimensions().width >= MIN_WIDTH_FOR_ROLE_MODELS}>
          <box flexShrink={0}>
            <text fg={api.theme.text.muted}>
              <span style={{ fg: color("lead") }}>Lead {name("lead")}</span>
              {" · "}
              <span style={{ fg: color("fellow") }}>Fellow {name("fellow")}</span>
            </text>
          </box>
        </Show>
      );
    }

    function toast(variant: "success" | "error" | "info", message: string) {
      api.ui.toast.show({ variant, title: "Fusion", message });
    }

    async function save(snapshot: Snapshot, patch: Record<string, unknown>, done: string): Promise<Snapshot> {
      const sessionID = currentSessionID();
      const next = await call("setSettings", { ...patch, ...(sessionID ? { sessionID } : {}) });
      if (next.error) {
        toast("error", `저장하지 못했어요. ${next.error}`);
        return snapshot;
      }
      await refreshModes();
      void loadCatalog();
      toast("success", done);
      // The save answers without the model list; the one already loaded is still right.
      return { ...next, models: snapshot.models };
    }

    async function pickModel(snapshot: Snapshot, role: Role): Promise<Snapshot> {
      const key = ROLE_KEY[role];
      const label = ROLE_LABEL[role];
      const pinned = snapshot.pinned[key];
      if (pinned) {
        await api.ui.dialog.alert({
          title: `${label} 모델`,
          message:
            `이 프로젝트는 ${pinned === "option" ? "플러그인 옵션" : "설정 파일(opencode.json)"}에서 ` +
            `${label} 모델을 정해 두었어요(${snapshot.effective[key]}). ` +
            "여기서 바꾸려면 설정 파일에서 그 줄을 지워 주세요.",
        });
        return snapshot;
      }
      if (snapshot.models.length === 0) {
        await api.ui.dialog.alert({
          title: `${label} 모델`,
          message: "쓸 수 있는 모델이 없어요. /connect로 모델 제공자를 먼저 연결해 주세요.",
        });
        return snapshot;
      }

      const saved = splitRef(snapshot.saved[key]);
      const base = await api.ui.dialog.select({
        title: `${label} 모델`,
        placeholder: "모델 찾기",
        current: saved.base,
        options: [
          {
            title: "정하지 않음",
            value: "",
            category: "",
            footer: role === "lead" ? "화면에서 고른 모델을 써요" : "Fellow에게 맡길 수 없어요",
          },
          ...snapshot.models.map((m) => ({
            title: m.name,
            value: `${m.providerID}/${m.id}`,
            category: m.providerID,
            footer: m.id,
          })),
        ],
      });
      if (base === undefined) return snapshot;
      if (base === "") return save(snapshot, { [key]: "" }, `${label} 모델을 비웠어요`);

      const model = snapshot.models.find((m) => `${m.providerID}/${m.id}` === base);
      let ref = String(base);
      if (model && model.variants.length > 0) {
        const variant = await api.ui.dialog.select({
          title: `${model.name} · 생각 깊이`,
          current: saved.base === base ? saved.variant || "-" : "-",
          options: [
            { title: "기본값", value: "-", footer: "모델이 정한 대로" },
            ...model.variants.map((v) => ({ title: v, value: v })),
          ],
        });
        if (variant === undefined) return snapshot;
        if (variant !== "-") ref = `${base}#${variant}`;
      }
      return save(snapshot, { [key]: ref }, `${label} 모델: ${modelLabel(ref, snapshot.models)}`);
    }

    async function renameMode(snapshot: Snapshot): Promise<Snapshot> {
      if (snapshot.pinned.modeName) {
        await api.ui.dialog.alert({
          title: "모드 이름",
          message: `이 프로젝트는 플러그인 옵션에서 모드 이름을 정해 두었어요(${snapshot.effective.modeName}).`,
        });
        return snapshot;
      }
      const name = await api.ui.dialog.prompt({
        title: "모드 이름",
        description:
          "모드 목록에 보이는 이름이에요. 영문자로 시작하고 영문자, 숫자, -만 쓸 수 있어요. " +
          `비워 두면 기본 이름(${DEFAULT_MODE_NAME})을 써요. OpenCode를 다시 열면 바뀌어요.`,
        placeholder: DEFAULT_MODE_NAME,
        value: snapshot.saved.modeName,
      });
      if (name === undefined) return snapshot;
      const trimmed = String(name).trim();
      if (trimmed && !/^[A-Za-z][A-Za-z0-9-]*$/.test(trimmed.replace(/\s+/g, "-"))) {
        toast("error", "영문자로 시작하고 영문자, 숫자, -만 쓸 수 있어요");
        return snapshot;
      }
      return save(snapshot, { modeName: trimmed }, `모드 이름: ${trimmed || DEFAULT_MODE_NAME} · 다시 열면 바뀌어요`);
    }

    async function toggleDefault(snapshot: Snapshot): Promise<Snapshot> {
      if (snapshot.pinned.defaultMode) {
        await api.ui.dialog.alert({
          title: "시작 모드",
          message: "이 프로젝트는 플러그인 옵션에서 시작 모드를 정해 두었어요.",
        });
        return snapshot;
      }
      const on = !snapshot.saved.defaultMode;
      return save(
        snapshot,
        { defaultMode: on },
        on ? `이제 OpenCode를 열면 ${snapshot.effective.modeName} 모드예요` : "시작 모드를 원래대로 돌렸어요",
      );
    }

    function modelFooter(snapshot: Snapshot, role: Role): string {
      const key = ROLE_KEY[role];
      const ref = snapshot.effective[key];
      if (snapshot.pinned[key]) return `${modelLabel(ref, snapshot.models)} · 고정됨`;
      if (ref) return modelLabel(ref, snapshot.models);
      return role === "lead" ? "정하지 않음 · 화면에서 고른 모델" : "정하지 않음";
    }

    async function openSettings() {
      let snapshot: Snapshot;
      try {
        snapshot = await call("getSettings", {});
      } catch (err) {
        toast("error", `설정을 불러오지 못했어요. ${errorText(err)}`);
        return;
      }
      if (snapshot.pinned.all) {
        await api.ui.dialog.alert({
          title: "Fusion 설정",
          message: "이 프로젝트는 저장된 설정을 쓰지 않게 되어 있어요(settingsFile: false). 설정 파일에서 직접 바꿔 주세요.",
        });
        return;
      }

      let last = "lead";
      while (true) {
        const choice = await api.ui.dialog.select({
          title: "Fusion 설정",
          current: last,
          options: [
            { title: "Lead 모델", value: "lead", category: "모델", footer: modelFooter(snapshot, "lead") },
            { title: "Fellow 모델", value: "fellow", category: "모델", footer: modelFooter(snapshot, "fellow") },
            {
              title: "모드 이름",
              value: "name",
              category: "모드",
              footer: snapshot.restartNeeded
                ? `${snapshot.saved.modeName || DEFAULT_MODE_NAME} · 다시 열면 바뀌어요`
                : snapshot.effective.modeName,
            },
            {
              title: "OpenCode를 이 모드로 시작",
              value: "default",
              category: "모드",
              footer: snapshot.effective.defaultMode ? "켬" : "끔",
            },
          ],
        });
        if (choice === undefined) return;
        last = String(choice);
        try {
          if (choice === "lead" || choice === "fellow") snapshot = await pickModel(snapshot, choice);
          else if (choice === "name") snapshot = await renameMode(snapshot);
          else if (choice === "default") snapshot = await toggleDefault(snapshot);
        } catch (err) {
          debug("error", errorText(err));
          toast("error", `저장하지 못했어요. ${errorText(err)}`);
        }
      }
    }

    debug("setup", { location: api.location, keys: Object.keys(api) });
    void loadCatalog();
    api.ui.slot({
      append: "prompt.footer.status",
      render: (slot: { sessionID?: string }) => <RoleModels sessionID={slot.sessionID} />,
    });
    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "fusion.settings",
          title: "Fusion settings",
          desc: "Lead와 Fellow 모델, 모드 이름을 정해요",
          group: "Fusion",
          bind: false,
          palette: true,
          slash: { name: "fusion-settings" },
          run: () => {
            void openSettings();
          },
        },
      ],
    }));
  },
};

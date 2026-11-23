# Fusion

[OpenCode](https://opencode.ai)에 **Fusion**이라는 모드를 더하는 플러그인입니다. 이 모드에서는 모델 둘이 한 세션에서 일을 나눕니다.

- **Lead**: 강한 모델. 코드를 읽고, 계획을 세우고, 결과를 검토합니다.
- **Fellow**: 싼 모델. Lead가 넘긴 계획대로 긴 구현을 합니다.

비싼 모델은 생각하는 데만 쓰고, 양이 많은 편집은 싼 모델에게 맡기자는 것입니다.

## 어떻게 일하나

1. Fusion 모드에서 요청을 하면 Lead가 코드를 읽고 계획을 씁니다. 계획에는 할 일과 함께 **검사 명령**(빌드, 테스트 등)이 들어갑니다.
2. Lead가 계획을 Fellow에게 넘깁니다. 같은 세션 안에서 모델만 바뀝니다.
3. Fellow가 구현을 마치면 플러그인이 검사 명령을 직접 돌립니다. 실패하면 Lead를 부르지 않고 Fellow에게 되돌립니다.
4. 검사를 통과하면 Lead가 결과를 검토하고 마무리하거나, 고칠 것을 다시 넘깁니다.

몇 줄짜리 확실한 수정은 넘기지 않고 Lead가 직접 합니다.

## 필요한 것

- OpenCode 2.3 이상
- OpenCode에 연결된 모델. Lead와 Fellow에 서로 다른 모델을 쓰는 것이 보통이지만, 같은 모델이어도 됩니다.

Windows에서 만들고 확인했습니다. macOS와 Linux에서는 아직 확인하지 못했습니다.

## 설치

```sh
opencode plugin add git+https://github.com/chanyounghur/opencode-fusion.git
```

설치한 뒤 OpenCode를 다시 엽니다. 이제 어느 폴더에서 열어도 Fusion 모드가 있습니다.

새 버전이 나왔는지 보고 올리려면 이렇게 합니다. 올린 뒤에도 OpenCode를 다시 엽니다.

```sh
opencode plugin check
```

```sh
opencode plugin update
```

지울 때는 이렇게 합니다.

```sh
opencode plugin remove git+https://github.com/chanyounghur/opencode-fusion.git
```

특정 버전에 고정하려면 주소 끝에 태그를 붙여 설치합니다(예: `…/opencode-fusion.git#v0.1.1`). 고정한 설치는 `opencode plugin update`로 올라가지 않습니다.

## 처음 쓰기

1. 프로젝트 폴더에서 `opencode`를 엽니다.
2. `shift+tab`을 눌러 모드를 **Fusion**으로 바꿉니다.
3. `/fusion-settings`를 입력해 Lead 모델과 Fellow 모델을 고릅니다. 한 번 고르면 모든 프로젝트에 적용됩니다.
4. 평소처럼 요청합니다.

모델이 목록에 없으면 먼저 OpenCode에서 제공자를 연결하세요(`/connect`).

## 쓰면서 알아 둘 것

| 하고 싶은 것 | 방법 |
|---|---|
| 지금 누가 일하는지 보기 | `/fusion-status` |
| Fellow가 일하는 중에 방향 바꾸기 | 그냥 말을 겁니다. Lead가 받아서 다시 계획합니다. |
| Fellow에게 바로 한마디 하기 | 메시지를 `>>`로 시작합니다. |
| Lead와 Fellow 모델 보기 | Fusion 세션에서는 입력창 아래 줄에 `Lead … · Fellow …`가 나옵니다. 지금 일하는 쪽이 밝게 보입니다. 화면이 좁으면(100칸 미만) 숨깁니다. |
| 모델 바꾸기 | `/fusion-settings`. 바로 적용됩니다. |
| 모드 이름 바꾸기 | `/fusion-settings`. OpenCode를 다시 열면 바뀝니다. 영문자, 숫자, `-`만 쓸 수 있습니다. |
| OpenCode를 Fusion 모드로 시작하기 | `/fusion-settings`에서 켭니다. |
| 모드 색 바꾸기 | `opencode.json`에 `"agents": { "fusion": { "color": "#3b82f6" } }`처럼 적습니다. |

화면 없이 한 번만 돌릴 때는 이렇게 합니다.

```sh
opencode run --standalone --agent fusion "요청"
```

## 옵션

대부분은 `/fusion-settings`로 충분합니다. 프로젝트마다 다르게 하거나 한도를 바꾸려면 `opencode.json`의 플러그인 항목에 `options`를 적습니다. 여기 적은 값은 `/fusion-settings`에서 고른 값보다 앞섭니다.

```json
{
  "plugins": [
    {
      "package": "git+https://github.com/chanyounghur/opencode-fusion.git",
      "options": { "fellowModel": "<제공자>/<모델>", "maxFellowSteps": 100 }
    }
  ]
}
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `leadModel`, `fellowModel` | 없음 | 모델을 고정합니다. `제공자/모델` 또는 `제공자/모델#생각깊이`. |
| `modeName` | `Fusion` | 모드 이름. |
| `defaultMode` | `false` | OpenCode를 이 모드로 시작합니다. |
| `directWork` | `true` | Lead가 작은 수정을 직접 합니다. `false`면 Lead는 읽기만 합니다. |
| `maxDirectFiles` / `maxDirectLines` | 8 / 200 | Lead가 직접 고칠 수 있는 파일 수와 줄 수. 넘으면 Fellow에게 넘깁니다. |
| `runChecks` | `true` | 플러그인이 계획의 검사 명령을 직접 돌립니다. |
| `verifyRetries` | 2 | 검사에 실패했을 때 Fellow에게 되돌리는 횟수. 넘으면 Lead가 봅니다. |
| `checkTimeoutSeconds` | 600 | 검사 명령 하나의 제한 시간. |
| `maxFellowSteps` | 200 | Fellow가 한 번 맡아서 쓸 수 있는 걸음 수. |
| `maxHandoffsPerTurn` | 12 | 요청 하나에서 Fellow에게 넘길 수 있는 횟수. |
| `returnOnUserPrompt` | `true` | Fellow가 일하는 중에 온 말을 Lead가 받습니다. |
| `settingsFile` | `~/.opencode/fusion/settings.json` | `/fusion-settings`가 저장하는 곳. `false`면 저장된 설정을 쓰지 않습니다. |

## 다른 프로그램에서 쓰기

플러그인의 기능은 OpenCode 서버의 주소로도 열려 있습니다(`POST /api/rpc/fusion/<이름>`). `/fusion-settings` 화면도 이것만 씁니다.

| 이름 | 하는 일 |
|---|---|
| `getState` | 세션의 상태: 누가 일하는지(`lead` 또는 `fellow`), 계획, 역할별 모델 |
| `forceReturn` | Fellow에서 Lead로 되돌림 |
| `setRoleModel` | 한 세션의 역할 모델을 바꿈 |
| `getSettings` | 저장된 설정, 지금 적용된 값, 고를 수 있는 모델 목록 |
| `setSettings` | 설정 저장 |

## 고쳐 쓰기

저장소를 내려받아 그 폴더를 플러그인으로 적으면, 고친 것이 OpenCode를 다시 열 때 바로 반영됩니다. 의존성이 없어서 `npm install`은 필요 없습니다.

```json
{
  "plugins": [{ "package": "/내려받은/경로/opencode-fusion" }]
}
```

같은 플러그인을 `opencode plugin add`로도 설치해 둔 상태라면 그쪽을 먼저 지우세요. 둘이 겹치면 하나만 올라옵니다.

```sh
npm test
```

```sh
npm run test:server
```

첫째는 단위 테스트이고, 둘째는 실제 `opencode serve`를 임시 프로젝트에서 띄워 확인합니다. 둘 다 모델을 부르지 않습니다. TypeScript 파일을 그대로 실행하는 Node(24에서 확인)가 필요합니다.

## 라이선스

MIT

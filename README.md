# FigmaToSpec

> [bernaferrari/FigmaToCode](https://github.com/bernaferrari/FigmaToCode)에서 갈라져 나온 fork입니다.
> 원본의 다중 프레임워크 코드 생성기는 모두 걷어내고, **LLM 스펙 추출 기능만** 남겼습니다.

피그마 디자인(또는 선택한 컴포넌트)을 **토큰 최적화된, 프레임워크 중립 스펙**으로 변환합니다.
최종 코드를 직접 만들지 않고, **AI 코딩 에이전트(Claude Code, Cursor 등)가 구현할 스펙**을 출력하는 게 목적입니다.
그 스펙만 주고 "구현해줘" 하면 화면 그대로 동작하면서 재사용성 높은 코드가 나오도록 설계했습니다.

## 출력물 — 2개의 블록

| 블록 | 성격 | 내용 |
|---|---|---|
| **Component Spec** | 매번 다름 (이 화면) | 선택한 화면의 레이아웃·타이포·색상 토큰·시맨틱 역할 트리 |
| **Spec Guide** | 항상 동일 (공통) | 표기법 + 빌드 규칙. 버전 박힘(`v1`) |

- **Component Spec**: `## Canvas / ## Styles / ## Strings / ## Tree` 구조. 반복 컴포넌트는 `(C1)`로 한 번만 정의하도록 디듑되고, 디자인 토큰은 `var(--token, #hex)`로, 시맨틱 역할은 `role:button` 식으로 표기됩니다.
- **Spec Guide**: `role:` / `flex` / `var(--)` / `clip` 같은 표기 해석법과 "재사용 컴포넌트로 만들어라" 같은 빌드 규칙. **모든 컴포넌트에 공통**이라, 캐시하거나 한 번만 제공하면 됩니다.

## 사용 흐름

1. **최초 1회** — `Spec Guide` 블록을 복사해 프로젝트의 `AGENTS.md`(또는 `CLAUDE.md` / memory)에 등록합니다. 작업 전 에이전트가 항상 읽도록.
2. **작업할 때마다** — 화면을 선택하고 `Component Spec` 블록만 복사해 에이전트에 전달합니다. 머리말이 "등록된 Spec Guide(v1) 참고해 구현하라"고 지시합니다.
3. (선택) 프로젝트 고유 컨벤션 — 디자인시스템 토큰명·컴포넌트 라이브러리·폴더 구조 — 을 `AGENTS.md`에 함께 적어두면 코드베이스 일관성이 올라갑니다.

> Component Spec 단독은 Spec Guide 없이는 표기를 못 읽습니다. 둘이 항상 같은 컨텍스트에 있어야 합니다.

---

## 로컬에서 빌드해 Figma에 추가하기

아직 Figma 커뮤니티에 배포하지 않으므로, **로컬에서 빌드한 결과물을 개발용 플러그인으로 직접 불러옵니다.**

### 1. 사전 준비

- [Node.js](https://nodejs.org/) (LTS 권장)
- [pnpm](https://pnpm.io/installation) — 이 저장소의 패키지 매니저 (`pnpm-lock.yaml`)
- **Figma 데스크톱 앱** — 개발용 플러그인 등록은 웹이 아니라 데스크톱 앱에서만 됩니다.

### 2. 빌드

```bash
git clone https://github.com/yjun1806/FigmaToSpec.git
cd FigmaToSpec
pnpm install
pnpm build
```

빌드 산출물이 다음 위치에 생성됩니다 (`manifest.json`이 이걸 가리킵니다):

- `apps/plugin/dist/code.js` — 플러그인 로직
- `apps/plugin/dist/index.html` — 플러그인 UI

> `manifest.json`은 저장소 **루트**에 있습니다. Figma에는 이 파일을 등록합니다.

### 3. Figma에 개발 플러그인으로 등록

1. Figma 데스크톱 앱을 엽니다.
2. 메뉴 → **Plugins → Development → Import plugin from manifest…**
3. 이 저장소 루트의 **`manifest.json`** 을 선택합니다.
4. 끝. 이제 개발 플러그인 목록에 **FigmaToSpec** 이 보입니다.

> 코드를 다시 빌드(`pnpm build`)하면 산출물이 갱신됩니다. Figma에서 플러그인을 다시 실행하면 최신 빌드가 반영됩니다.

### 4. 사용

FigmaToSpec은 **두 가지 모드**로 동작합니다.

- **Dev Mode (codegen 패널)** — Figma를 Dev Mode로 전환하고 노드를 선택하면, 코드 패널 언어 목록에 **LLM**이 보입니다. 선택하면 **Component Spec** / **Spec Guide** 두 블록이 나옵니다.
- **에디터 모드 (플러그인 UI)** — Plugins → Development → **FigmaToSpec** 실행. 화면을 선택하면 같은 두 블록을 UI에서 복사할 수 있습니다.

---

## 개발

### 워치 모드

코드를 고치면서 작업할 땐 watch 모드를 쓰면 저장할 때마다 자동 빌드됩니다.

```bash
# 루트에서 (debug UI 포함, http://localhost:3000)
pnpm dev

# 또는 플러그인만
cd apps/plugin && pnpm dev
```

Figma에서 플러그인을 다시 실행하면 변경분이 반영됩니다.

### 명령어

`pnpm run ...`

- `dev` — 개발(워치) 모드. Figma 에디터에서 실행 가능
- `build` — 프로덕션 빌드
- `build:watch` — 빌드 + 변경 감지
- `lint` — ESLint
- `format` — prettier (주의: 파일을 수정함)

### 모노레포 구조

[Turborepo](https://turborepo.com/) + [esbuild](https://esbuild.github.io/) 기반입니다.

- `packages/backend` — Figma API를 읽어 노드를 변환하고 **LLM 스펙을 생성**하는 핵심 로직 (`src/llm/`, `src/altNodes/jsonNodeConversion.ts`)
- `packages/plugin-ui` — 플러그인 공통 UI
- `apps/plugin` — `backend` + `plugin-ui`를 합쳐 Figma가 부르는 실제 플러그인
  - `plugin-src` → `dist/code.js`
  - `ui-src` → `dist/index.html`
- `apps/debug` — UI를 브라우저에서 보는 디버그 앱 (`pnpm dev` 시 `http://localhost:3000`)

> 참고: 원본의 HTML/Tailwind/Flutter/SwiftUI/Compose 생성기는 모두 제거됐습니다. 색상·그라데이션 헬퍼(`html/builderImpl/htmlColor`) 등 LLM 스펙 생성에 필요한 최소 의존만 남아 있습니다.

---

## 라이선스 / 크레딧

- 이 프로젝트는 [bernaferrari/FigmaToCode](https://github.com/bernaferrari/FigmaToCode)의 fork이며, 원본의 노드 변환 파이프라인·플러그인 셸 위에서 동작합니다. 원작자 **Bernardo Ferrari**에게 감사드립니다.
- 라이선스는 원본과 동일한 **GPL-3.0** 입니다 (`LICENSE` 참조).

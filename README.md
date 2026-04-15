# zcabh.github.io

GitHub Pages로 공개하는 정적 사이트 저장소입니다.

현재는 개인 지출 관리(`/expense/`)와 유통기한 관리(`/pantry/`) 웹 앱을 운영하고, 루트 `/`는 공개된 페이지 목록을 보여주는 포털로 사용합니다. 이후 새 페이지를 추가할 때도 같은 규칙으로 확장할 수 있게 구성했습니다.

## Structure

```text
.
├── .github/
│   ├── actions/build-pages-site/action.yml
│   └── workflows/deploy-pages.yml
├── shared/
│   ├── fonts/
│   │   └── PretendardVariable.woff2
│   └── styles/
│       ├── app.css
│       └── portal.css
├── scripts/
│   ├── build-pages.mjs
│   └── validate-pages.mjs
├── sites/
│   ├── expense/
│   │   ├── index.html
│   │   ├── js/
│   │   ├── site.json
│   │   └── styles.css
│   └── pantry/
│       ├── index.html
│       ├── js/
│       ├── site.json
│       └── styles.css
├── package-lock.json
└── package.json
```

## Commands

```sh
npm run validate
npm run build:css
npm run build
npm run preview
```

- `validate`: `sites/*` 아래 페이지 메타데이터와 필수 파일을 검사합니다.
- `build:css`: Tailwind + daisyUI 기반 공통 스타일시트를 생성합니다.
- `build`: `dist/`를 만들고 루트 인덱스와 각 페이지 산출물을 생성합니다.
- `preview`: `dist/`를 로컬 정적 서버로 미리 봅니다.

공통 UI 폰트는 `shared/fonts/PretendardVariable.woff2`를 로컬 asset으로 포함해 배포합니다. CI는 `npm ci`를 사용하므로 `package-lock.json`도 함께 유지해야 합니다.

## Add A New Page

1. `sites/<slug>/` 디렉터리를 만듭니다.
2. `sites/<slug>/index.html`과 필요한 정적 자산을 추가합니다.
3. `sites/<slug>/site.json`을 추가합니다.

예시:

```json
{
  "slug": "expense",
  "title": "Track Your Expense",
  "description": "GitHub에 저장된 개인 지출 JSON을 브라우저에서 직접 관리하는 웹 앱",
  "order": 10,
  "listed": true
}
```

`main` 브랜치에 반영되면 GitHub Pages workflow가 다시 빌드하고 배포합니다.

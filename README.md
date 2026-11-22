# DualRead 개인 번역기

읽고 있는 웹페이지에서 고른 문단을 한국어로 번역해 원문 바로 아래에 표시합니다. 기본 연결은 **ChatGPT로 로그인**입니다. OpenAI가 해당 계정에 허용한 모델을 사용하며 번역 요청에 구독 사용량이 적용됩니다. 원하는 경우 설정에서 OpenAI 호환 서버를 직접 지정할 수 있습니다.

## 이 Mac에서 시작하기

1. Chrome에서 `chrome://extensions`를 열고 **개발자 모드 → 압축해제된 확장 프로그램을 로드**를 선택합니다. 이 Mac에서는 빌드된 `personal/dist` 폴더를 고릅니다. ZIP을 받았다면 압축을 풀고 `manifest.json`이 들어 있는 폴더를 고릅니다. GitHub에서 새로 내려받았다면 저장소 최상위 폴더를 사용할 수 있습니다. 설치 후에도 해당 폴더를 유지하세요.
2. ChatGPT 연결 프로그램을 처음 설치하는 Mac에서는 아래 명령을 저장소 최상위 폴더에서 실행합니다. Node.js 22 이상, npm, macOS의 Swift 도구가 필요합니다. Chrome은 고정된 확장 ID를 통해 이 프로그램을 실행합니다.

   ```sh
   npm ci
   npm run build -w dualread-personal-native
   node personal/native/install.mjs
   ```
3. 확장 메뉴에서 **DualRead → 설정 → ChatGPT로 계속하기**를 누르고 사용할 계정과 워크스페이스를 선택한 뒤 플랜 사용을 승인합니다. 현재 브라우저에서 ChatGPT에 로그인한 상태여도 이 확장에 대한 동의는 별도로 진행합니다. 플랜 지원 여부와 한도는 계정에 따라 다릅니다. [OpenAI 공식 연결 안내](https://developers.openai.com/siwc/token-sharing-open-source) · [사용량 관리](https://chatgpt.com/settings/usage)
4. 일반 웹페이지에서 **문단 골라 번역**을 누른 후 원하는 문단을 한 번 클릭합니다. 단축키는 `Alt+Shift+T`(Mac은 `Option+Shift+T`)이고, 고르는 중 `Esc`를 누르면 취소됩니다. 문단의 일부만 보내려면 글을 드래그하고 우클릭 메뉴에서 **DualRead · 선택한 글 번역**을 고릅니다. **번역 지우기**로 페이지에 표시한 결과를 제거합니다.

## 원문이 가는 곳

| 설정 | 선택한 글의 경로 |
| --- | --- |
| 내 ChatGPT 구독 | 확장 → 이 Mac의 Chrome 연결 프로그램 → OpenAI Responses API. 본인이 승인한 구독으로 요청합니다. |
| 사용자 지정 서버 | 확장 → 지정한 OpenAI 호환 서버. 서버 주소와 모델 ID는 사용할 때 입력합니다. 키가 필요 없는 로컬 서버도 지원합니다. |

원문에는 클릭한 문단 또는 명시적으로 선택한 부분이 들어갑니다. 페이지를 열거나 스크롤하는 것만으로 번역 요청이 발생하지 않습니다. 선택 영역이 여러 문단에 걸치면 문단별로 보냅니다. 각 요청은 5,000자 이내이고, 한 번에 최대 12개 문단을 선택할 수 있습니다. 웹페이지 주소·제목·쿠키를 번역 요청에 추가하지 않습니다. 원문에 직접 포함된 URL은 번역할 글의 일부입니다. [데이터 처리 방식](./PRIVACY.md)

## 개발

확장용 TypeScript는 `personal/src`, 화면과 매니페스트는 `personal/static`, Mac 연결 프로그램은 `personal/native`에 있습니다. 빌드하면 `personal/dist`와 저장소 최상위의 확장 실행 파일을 갱신합니다. 브라우저 테스트는 임시 프로필과 로컬 테스트 서버를 사용합니다.

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm exec -w dualread-personal -- playwright-core install chromium
npm test
```

[DualRead AI Translator](https://github.com/zkwi/dualread-ai-translator)의 MIT 라이선스 포크입니다. 브라우저 확장은 원본의 문단 배치 로직과 아이콘을 사용합니다. 번들로 포함한 OpenAI Sign in with ChatGPT DevKit에는 별도의 비상업적 라이선스가 적용됩니다. [DualRead 라이선스](./LICENSE) · [DevKit 라이선스](./personal/native/vendor/siwc/LICENSE) · [제3자 고지](./personal/native/vendor/siwc/THIRD_PARTY_NOTICES.md)

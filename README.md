# DualRead 개인 번역기

웹페이지 전체를 한국어와 원문으로 함께 읽거나, 드래그한 글만 원문 아래에서 번역해 볼 수 있습니다. 기본 연결은 **ChatGPT로 로그인**입니다. OpenAI가 해당 계정에 허용한 모델을 사용하며 번역 요청에 구독 사용량이 적용됩니다. 원하는 경우 설정에서 OpenAI 호환 서버를 직접 지정할 수 있습니다.

## 이 Mac에서 시작하기

1. Chrome에서 `chrome://extensions`를 열고 **개발자 모드 → 압축해제된 확장 프로그램을 로드**를 선택합니다. 이 Mac에서는 빌드된 `personal/dist` 폴더를 고릅니다. ZIP을 받았다면 압축을 풀고 `manifest.json`이 들어 있는 폴더를 고릅니다. GitHub에서 새로 내려받았다면 저장소 최상위 폴더를 사용할 수 있습니다. 설치 후에도 해당 폴더를 유지하세요.
2. ChatGPT 연결 프로그램을 처음 설치하는 Mac에서는 아래 명령을 저장소 최상위 폴더에서 실행합니다. Node.js 22 이상, npm, macOS의 Swift 도구가 필요합니다. Chrome은 고정된 확장 ID를 통해 이 프로그램을 실행합니다.

   ```sh
   npm ci
   npm run build -w dualread-personal-native
   node personal/native/install.mjs
   ```
3. 확장 메뉴에서 **DualRead → 설정 → ChatGPT로 계속하기**를 누르고 사용할 계정과 워크스페이스를 선택한 뒤 플랜 사용을 승인합니다. 현재 브라우저에서 ChatGPT에 로그인한 상태여도 이 확장에 대한 동의는 별도로 진행합니다. 플랜 지원 여부와 한도는 계정에 따라 다릅니다. [OpenAI 공식 연결 안내](https://developers.openai.com/siwc/token-sharing-open-source) · [사용량 관리](https://chatgpt.com/settings/usage)
4. 일반 웹페이지에서 아래 단축키를 사용하세요. 팝업에서도 같은 동작을 선택할 수 있습니다.

| Mac 단축키 | 동작 |
| --- | --- |
| `Option+A` | 현재 페이지 전체의 이중 언어 번역을 켭니다. 본문과 제목, 메뉴, 사이드바, 표, 푸터도 대상으로 삼고, 스크롤하면서 새로 나타나는 글도 번역합니다. 한 번 더 누르면 원문 보기로 돌아갑니다. |
| `Option+C` | 드래그한 글만 번역합니다. 아무것도 선택하지 않았다면 번역 요청은 발생하지 않습니다. |
| `Option+Shift+T` | 클릭한 문단 하나를 번역합니다. 문단을 고르는 중에는 `Esc`로 취소할 수 있습니다. |

Windows와 Linux에서는 `Option` 대신 `Alt`를 사용하세요. 단축키를 선점한 확장을 삭제한 뒤에는 `chrome://extensions`에서 DualRead를 한 번 새로고침하세요. 팝업에 표시된 키가 현재 배정된 단축키입니다. 직접 변경하려면 `chrome://extensions/shortcuts`에서 지정할 수 있습니다.

## 모델과 추론 강도

**DualRead → 설정**에서 번역 모델과 추론 강도(effort)를 선택하고 저장하세요. ChatGPT 구독으로 연결하면 계정에서 쓸 수 있는 모델과 선택한 모델의 추론 강도가 표시됩니다. 모델을 자동으로 두면 `gpt-6.1-terra`를 우선 사용하고, 추론 강도를 자동으로 두면 모델의 기본값을 따릅니다.

사용자 지정 서버는 모델 ID를 직접 입력합니다. 추론 강도를 지정하면 서버에 `reasoning_effort`를 함께 보내고, 기본값으로 두면 이 필드를 생략합니다. 두 연결 방식의 설정은 따로 기억합니다. 저장 후 읽던 탭에서 `Option+A`를 누르면 새 설정으로 페이지를 번역합니다.

## 원문이 가는 곳

| 설정 | 선택한 글의 경로 |
| --- | --- |
| 내 ChatGPT 구독 | 확장 → 이 Mac의 Chrome 연결 프로그램 → OpenAI Responses API. 본인이 승인한 구독으로 요청합니다. |
| 사용자 지정 서버 | 확장 → 지정한 OpenAI 호환 서버. 서버 주소와 모델 ID는 사용할 때 입력합니다. 키가 필요 없는 로컬 서버도 지원합니다. |

화면에 보이는 첫 본문을 우선 요청합니다. ChatGPT 구독에서는 번역이 도착하는 대로 원문 아래에서 읽을 수 있습니다. 제목·작성자 번역은 첫 본문이 완성된 뒤 읽던 줄의 위치를 유지하며 표시합니다. 번역문도 원문의 글꼴·크기·굵기·줄 높이를 따릅니다. 원문에 쓰인 인라인 코드가 번역문에 나오면 같은 고정폭 글꼴과 배경으로 표시합니다.

페이지 전체 번역을 켜면 지금 읽고 있는 화면과 다음 화면의 문단도 함께 준비합니다. 이미 준비된 문단 전체를 드래그하면 같은 번역을 바로 표시합니다. 미리 번역하는 짧은 글은 한 요청에 최대 5개씩 묶고, 요청당 원문은 총 5,000자 이내입니다. 기본 번역 지시문은 한 단어나 메뉴 이름도 독립적으로 번역하며, 코드와 자리표시자를 보존하고 번역문만 반환하도록 요청합니다.

번역은 사용자가 실행한 탭에서만 동작합니다. 요청에는 번역 대상 글을 넣고 페이지 주소·메타데이터·쿠키·입력 중인 값은 첨부하지 않습니다. 화면에 표시된 제목이나 URL을 번역 대상으로 고르면 해당 글 자체는 전송됩니다. [데이터 처리 방식](./PRIVACY.md)

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

설정과 팝업은 Meta의 Astryx Neutral 0.7.17 테마를 사용합니다. 테마 CSS와 Figtree, Instrument Serif 폰트는 확장에 포함됩니다. [Astryx](https://github.com/meta/astryx) · [테마와 폰트 라이선스](./personal/static/theme)

# 면접 피드백 UI 구현 노트

작성일: 2026-06-24 · 범위: `frontend/` (React 19 + Vite 8)

## 0. 저장소 자가 탐색 결과 (구현 전 관찰)

| 항목 | 발견 |
|---|---|
| React 진입점 | `frontend/src/main.jsx` → `App.jsx` |
| 라우팅 | **react-router 없음.** `App.jsx`의 `stage` state(`setup`→`interview`→`report`)로 뷰 전환 → **D3을 "조건부 렌더링"으로 보정** |
| 상태관리 | 라이브러리 없음. `App.jsx`의 `useState` lift + props 전달 |
| **기존 AI 피드백 연동 (D1, 최우선)** | `frontend/src/services/api.js`에 **이미 존재** — REST 게이트웨이(FastAPI `app/api.py` + `LLM/service.py`) |
| 기존 면접 화면 | `frontend/src/components/InterviewSession.jsx` (질문/녹화/제출), `ReportView.jsx`(종합 리포트) |
| md 위치/로딩 | 기존 md는 `LLM/prompts/*.md`(프롬프트, 면접 기록 아님). 과거 면접 기록 md는 부재 → 신규 생성 + 런타임 `fetch` 로딩 |
| 스타일링 | 인라인 `const styles = {}` 객체. CSS Modules/Tailwind 없음 → 동일 관용구로 작성 |
| 빌드/실행/테스트 | `npm run build`(vite), `npm run lint`(oxlint). 테스트 러너 없음 → Node 26 내장 `node --test` 사용(신규 의존성 0) |

### 기존 AI 연동 시그니처 (그대로 사용 — D1)
- `submitAnswer({questionId, audioBlob, voiceMetrics, poseMetrics})`
  → `{ answer_id, question_id, transcript, evaluation: { total_score, content_score, structure_score, strength, weakness, improvement, sample_answer } }`
  → **실시간 per-answer 피드백 소스**
- `getReport(sessionId)`
  → `{ session, items: [{question, answer, evaluation}], average_score, answered_count }`
  → **종합 피드백 소스**

## 결정/가정 적용 (D1~D3)
- **D1**: 기존 연동을 보존하고 `services/feedbackService.js`로 **얇게 위임**만 했다.
  - `getLiveFeedback(params)` → `submitAnswer(params)` (동작·시그니처 변경 없음)
  - `getSummaryFeedback(sessionId)` → `getReport(sessionId)`
  - 두 연동이 **모두 실재**하므로 mock fallback은 사용하지 않음(D1 규칙). 순수 매핑 로직만 `feedbackMapping.js`로 분리해 단위 테스트.
- **D2**: 과거 면접 답변 = markdown. `utils/markdownRecords.js`가 `parseInterviewRecords()`로 `{id, question, answer, feedback}[]` 생성. 로딩 실패/빈 파일/깨진 형식이면 **빈 배열 + 에러 라벨**(크래시 금지). 샘플 데이터: `frontend/public/interview-history.md`(런타임 `fetch`).
- **D3**: 라우터가 없으므로 **조건부 렌더링**으로 전환. 종합 피드백은 `InterviewSession` 내부 `view` state(`interview`↔`summary`)로 전환 → "뒤로가기"로 면접 화면 복귀 가능. 기존 `report` stage(ReportView)도 종합 뷰의 "전체 리포트 보기"(`onComplete`)로 **그대로 도달 가능**(데드 패스 방지).

## 추가/변경 파일
신규
- `frontend/src/utils/markdownRecords.js` — md 파서 + 로더 (D2)
- `frontend/src/utils/markdownRecords.test.mjs` — 파서 단위 테스트 (8)
- `frontend/src/services/feedbackMapping.js` — 순수 매핑 헬퍼 (D1)
- `frontend/src/services/feedbackMapping.test.mjs` — 매핑 단위 테스트 (5)
- `frontend/src/services/feedbackService.js` — 기존 연동 위임 façade (D1)
- `frontend/src/components/LiveFeedbackOverlay.jsx` — 하단 실시간 오버레이 (요구 1)
- `frontend/src/components/FeedbackList.jsx` — 우측 누적 목록 (요구 2/3)
- `frontend/src/components/FeedbackDetailModal.jsx` — 항목 상세 모달 (요구 3)
- `frontend/src/components/SummaryFeedbackView.jsx` — 종합 피드백 뷰 (요구 5)
- `frontend/public/interview-history.md` — 과거 면접 기록 샘플 (D2)

변경(최소 · 위에 얹기)
- `frontend/src/components/InterviewSession.jsx` — 신규 컴포넌트/상태를 **레이어로 추가**. 기존 질문 진행/녹화/제출 흐름은 보존. `submitAnswer` 직접 호출만 `feedbackService.getLiveFeedback`로 정리(동작 동일).
- `frontend/package.json` — `"test": "node --test \"src/**/*.test.mjs\""` 스크립트 추가.

## 요구사항 매핑 (1~5)
1. **실시간 오버레이**: 답변 종료(`handleStop`) 시 `getLiveFeedback` 호출 → 로딩 → 하단 고정 오버레이에 점수/강점/개선점. 접기/닫기 가능. `pointer-events: none`(래퍼) + `auto`(카드)로 뒤 UI 클릭 방해 없음.
2. **우측 목록**: 답변 제출마다 `toInterviewRecord`로 `{id,question,answer,feedback}` 생성 후 append(질문 id로 중복 제거). 스크롤 패널.
3. **항목 클릭 → 상세**: 목록 항목 클릭 시 `FeedbackDetailModal`로 질문/답변/AI 피드백 표시. "지난 면접 기록" 섹션은 **D2(markdown) 로딩 결과**를 동일 모양으로 매칭.
4. **종합 버튼 게이팅**: `answeredIds.size >= questions.length`일 때만 "📊 종합 피드백 보기" 노출(종료 전 미노출).
5. **종합 뷰 전환**: 버튼 → `view="summary"` → `SummaryFeedbackView`가 `getSummaryFeedback(sessionId)` 결과 렌더링. "← 면접으로 돌아가기"로 복귀.

## 검증 결과
- ✅ 빌드: `npm run build` 성공(322 모듈 = 기존 315 + 신규 7, 전부 해석/변환됨). 청크 크기 경고는 **기존부터 존재**(신규 아님).
- ✅ 린트: `npm run lint`(oxlint) 에러 0 — `react/rules-of-hooks` 통과(요구 5의 조기 return은 모든 훅 선언 이후라 안전).
- ✅ 단위 테스트: `npm test` → **13/13 통과** (파서 8: 정상/빈/누락/깨짐/멀티라인/문자열 id, 매핑 5).
- ✅ 실 데이터 파싱: 실제 `public/interview-history.md` → 레코드 4개 정상 파싱(문서 제목 `#`는 무시, `##` 블록만 레코드).
- ✅ 런타임 변환: dev 서버가 신규 모듈 7개를 전부 200으로 변환/서빙, `/interview-history.md` 서빙 확인.
- ✅ 렌더 스모크: 신규 컴포넌트 4종을 **Vite 실제 변환 파이프라인 + React 렌더러**로 렌더 → 런타임 렌더 에러 0, 요구 1/2/3/5 표시 문자열 단언 7/7 통과.

## [결함] 발견 → 처리 → 사유 (완주 우선 정책)
- **[결함] md 파서 — 문서 제목 `#`가 레코드로 잡힘**: `# 지난 면접 기록` 같은 레벨1 제목이 빈 레코드로 포함됨(테스트로 발견, 4 vs 3).
  → **처리**: `HEADING_RE`를 `#{2,6}`(레벨2+)로 제한해 레벨1 제목은 무시.
  → **사유**: 문서 제목은 데이터가 아니라 헤더이므로 레코드 경계는 `##`로 정의하는 것이 자연스럽고, 샘플/실데이터 모두와 일치.
- **[결함] md 파서 — `- **id:** 1`(콜론이 볼드 안)이 매칭 안 됨**: 값이 `** 1`로 잘림(테스트로 발견).
  → **처리**: `FIELD_RE`를 키/콜론 주변의 `**`를 양쪽 모두 허용하도록 보정(`- id: 1`, `- **id:** 1`, `**id**: 1` 모두 지원).
  → **사유**: 사람이 쓰는 md의 강조 표기 편차를 흡수해야 "불신 기본값" 원칙에 부합.
- **[처리] 기존 `submitAnswer` 직접 호출을 `feedbackService.getLiveFeedback`로 교체**: 스코프상 "감싸기만" 허용 범위. 인자/반환/동작 동일, 호출부만 정리(가역적). 기존 `ResultCard`/`ReportView` 등 다른 사용처는 그대로 둠.
- **[처리] 마지막 질문의 `ResultCard` 버튼 라벨**: 기존 "결과 리포트 보기"는 `onComplete`로 report stage 이동이었음. 종합 뷰 내부 전환(요구 5)에 맞춰 "종합 피드백 보기"로 변경하고 `handleNext`가 `view="summary"`로 전환하도록 조정. 기존 `report` stage는 종합 뷰의 "전체 리포트 보기"로 계속 도달 가능(제거 아님).

## 미검증 / 남은 리스크
- **라이브 end-to-end 클릭 통과(실 카메라 녹화 + LLM 백엔드 호출)는 본 헤드리스 환경에서 미수행.** 요구 1의 실제 AI 평가 반환, 요구 4의 "실제 답변 누적 후 게이팅", 요구 5의 실 리포트 데이터 렌더는 카메라/마이크 + FastAPI(`app/`) + LLM 키가 필요해 자동 관찰 불가(프롬프트의 "실제 호출 불가 환경" 케이스). 대신 호출 인자·매핑·렌더 출력으로 검증함(위 참조).
- **수동 재현 절차** (백엔드 `uvicorn` 기동 + 브라우저, 카메라 허용):
  1. `frontend/`에서 `npm run dev` → 셋업 폼 작성 → 면접 시작
  2. 답변 녹화 시작 → 종료 → **하단 오버레이**에 점수/강점/개선점(요구 1)
  3. **우측 목록**에 항목 누적, 다음 질문 진행 시 계속 append(요구 2)
  4. 목록/"지난 면접 기록" 항목 클릭 → **상세 모달**(요구 3)
  5. 모든 질문 답변 후 헤더에 **"📊 종합 피드백 보기"** 등장(그 전엔 미노출, 요구 4)
  6. 클릭 → **종합 뷰** 전환, 평균/문항별 피드백; "← 면접으로 돌아가기"로 복귀(요구 5)
- 레이아웃: 우측 목록은 `position: fixed`(width 300). 매우 좁은 뷰포트에서는 중앙 콘텐츠와 겹칠 수 있어 접기 버튼(◀/▶) 제공. 데스크톱(데모 대상)에서는 여백에 위치.

---

# v2 변경 (UX 리파인) — 2026-06-25

사용자 피드백을 반영한 5가지 변경. 모든 게이트 통과(테스트 11/11, lint 0, build OK, 렌더 스모크 6/6).

## 변경 내용
1. **실시간 피드백 → 영상 오버레이 토스트 큐** 🔄
   - 신규 `hooks/useToastQueue.js`(+순수 `utils/toastQueue.js`/테스트) + `components/LiveFeedbackToasts.jsx`.
   - `index.css`에 `liveToastIn`/`liveToastOut` keyframes(페이드 인/아웃).
   - FIFO 큐: 새 토스트는 하단에서 등장→스택이 위로, 가장 오래된(맨 위)부터 페이드아웃. **최대 3개**(`overflowKeys`로 보장). 각 토스트 3.5초 후 자동 소멸. **동일 경고는 5초 간격으로만 재발**(`DEDUPE_MS`, 같은 메시지 throttle — 시선 이탈이 계속돼도 매 프레임 쌓이지 않음).
   - ❌ 기존 `LiveFeedbackOverlay.jsx`(하단 바) 삭제. 답변 종합 점수는 짧은 토스트 + 우측 목록 누적으로 대체.
2. **시선 평가 강화** 🔄
   - `useRecorder.js`의 `GAZE_AWAY_THRESHOLD` 0.5 → **0.28**(민감도 상향), `gazeDev`를 프레임 지표로 노출.
   - `liveMetrics.gazeAway`는 프레임별 비스무딩 값이라, 시선이 벗어나는 즉시 `danger` 토스트 발생(우선순위 빨강).
3. **장치 준비 페이지 신규** 🆕
   - `components/DeviceCheck.jsx`: 카메라 프리뷰 + 마이크 레벨 미터 + 권한/점검 체크리스트. 카메라·마이크 OK일 때만 "면접 시작" 활성.
   - `App.jsx` 플로우: `setup → ready(DeviceCheck) → interview → report`. 시작 시 프리뷰 스트림 정리 후 면접 화면이 자체 스트림을 새로 연다.
4. **자동 진행 / 컨트롤 최소화** 🔄
   - 질문 제시 → 아바타가 읽고(onEnd) **녹화 자동 시작**(TTS 무음 대비 9초 안전 타이머). `answerActiveRef`로 이중 시작 방지.
   - 사용자 컨트롤은 **`답변 종료` / `면접 종료`** 둘뿐. ❌ "답변 녹화 시작" 버튼 제거.
   - `답변 종료` → 분석 → 우측 목록 누적 + 점수 토스트 → **1.4초 후 자동으로 다음 질문**(마지막이면 종합 뷰). ❌ 블로킹 `ResultCard` 제거.
5. **"지난 면접 기록" 목업 제거** ❌
   - `FeedbackList`에서 과거 기록 섹션 삭제(이번 면접만). `markdownRecords.js`/테스트/`public/interview-history.md` 삭제. `feedbackMapping`(toInterviewRecord)은 이번 면접 항목용으로 유지.
6. **영상 오른쪽 "상태 지표" 패널 완전 제거** ❌ (v2 후속)
   - 실시간 피드백은 영상 위 토스트로만 표시. 패널의 수치 지표/코칭 문구는 토스트와 중복이라 통째로 삭제(`voiceMetrics` state 및 `onStatus` 콜백도 제거 — 음성 요약은 `getVoiceSummary()`로 제출 시점에만 사용). 면접관 페르소나 표시는 헤더 칩으로 이전. 패널이 빠진 자리만큼 영상을 640×480로 키우고 중앙 정렬.

7. **실시간 코칭 ↔ 실시간 피드백 용어/채널 분리 + 전사 보정 노출** 🔄 (v2 후속)
   - **개념 정의**: *실시간 코칭* = 발화 중 지적(시선/말속도/침묵/손) → 영상 위 토스트. *실시간 피드백* = 답변 종료 후 AI가 전사 보정 → 채점/분석.
   - **두 채널 분리**: 답변 종합 점수 토스트를 코칭 큐에서 제거(피드백을 코칭 채널에 섞지 않음). 코칭 핸들 `pushToast→pushCoaching`/`clearToasts→clearCoaching`, 서비스 `getLiveFeedback→getAnswerFeedback`로 의미 명확화.
   - **전사 보정은 이미 백엔드에 구현되어 있음**(신규 아님): ① `_build_stt_prompt`로 STT 디코딩을 직무/회사/기술스택+이력서 용어로 바이어스, ② `answer_evaluation.md`의 [1단계] 전사 보정이 문맥 기반으로 오인식 고유명사·기술어를 교정(예: 리엑트→React) 후 [2단계] 보정문 기준 평가. `corrected_transcript`는 `normalize_evaluation_result`에서 보존되고 `api.py`에서 `transcript = corrected or raw`. 테스트 `test_corrected_transcript_overrides_raw_stt`로 검증됨.
   - **보정 가시화(추가)**: `api.py` 응답에 `raw_transcript`(보정 전) 추가. `toInterviewRecord`가 `rawAnswer`(보정과 다를 때만) 보관, `FeedbackDetailModal`이 **"음성 인식 원문(취소선) → AI 보정 답변(평가 기준)"** 으로 표시.

8. **면접 화면 레이아웃 재구성** 🔄 (v2 후속)
   - **AI 면접관 아바타를 사용자 영상의 왼쪽**에 배치: 질문 배너(상단) 아래 `stageRow`에 `[아바타 | 사용자 영상]` 2단(아바타 280px 고정, 영상 flex). 각 타일에 "AI 면접관"/"나" 라벨, REC는 영상 우상단으로 이동.
   - **사이드바 비-부유화**: `FeedbackList`를 `position: fixed`(부유) → **본문 흐름 안의 `position: sticky` 사이드바**(320px 컬럼)로 변경. 더 이상 콘텐츠를 가리지 않고 자기 자리를 차지한다. 본문은 `bodyRow`(`mainCol` + 사이드바) flex 행, 컨테이너 폭 960→1280.

9. **전면 비주얼 리디자인 (목업 기반)** 🔄 (v3)
   - **디자인 시스템**: `index.css`에 토큰(라벤더 `--bg`, 퍼플 `--primary` 등) + 재사용 클래스(`.card`/`.btn`/`.input`/`.chip`) 추가, Pretendard 폰트(`index.html` CDN). 기존 인라인 스타일은 `var(--token)`로 재테마.
   - **상단 네비**: 신규 `TopNav.jsx`(브랜드 로고 + 슬롯). `App.jsx`가 라벤더 쉘 + 화면별 네비를 구성(setup=탭/유저, ready=직무 칩, report=새 면접). interview는 풀블리드.
   - **점수 도넛**: 신규 `ScoreDonut.jsx`(conic-gradient) — Summary/Report/DetailModal에서 재사용.
   - **화면 재구성**: SetupForm 2단(메인 카드 + 사이드: 질문 수 슬라이더·페르소나 라디오·시작), DeviceCheck(프리뷰+감지 배지+장치 드롭다운+레벨 미터+스피커 테스트), InterviewSession(진행 막대 헤더 + 다크 스테이지 면접관|영상 + 질문 오버레이 + 코칭 토스트 우하단), FeedbackList/Modal/Summary/Report 카드·칩·도넛화.
   - **목업과 의도적으로 다르게 유지(이전 합의 우선)**: 자동 진행(목업의 인라인 결과패널+"다음 질문" 미도입), "지난 면접 기록" 미복원, 코칭 토스트에 답변 점수 미혼합, 강점은 리스트/요약에서 비노출(리포트 상세에만). 필요 시 켤 수 있음.
   - 검증: lint 0 / 테스트 12 / build 327모듈 / 렌더 스모크 8.

## v2 검증
- ✅ 단위 테스트 11/11 (매핑 5 + 토스트 큐 6). md 파서 테스트는 목업 제거로 함께 삭제.
- ✅ lint 0, build 성공(324 모듈).
- ✅ 렌더 스모크 6/6: LiveFeedbackToasts(페이드/leaving 클래스), FeedbackList(지난 기록 섹션 부재 확인), 상세 모달, 종합 뷰, DeviceCheck 셸.
- ✅ dev 서버가 변경/신규 모듈(App·useRecorder·useToastQueue·DeviceCheck·LiveFeedbackToasts·InterviewSession) 전부 200 변환.

## v2 미검증 / 리스크
- 라이브 end-to-end(실 카메라 + LLM 백엔드)는 여전히 헤드리스 자동관찰 불가. 토스트 큐 애니메이션/시선 즉시성/자동시작 타이밍은 **실제 브라우저에서 카메라로 확인 필요**.
- 자동 진행 가정: "답변 종료 후 결과는 블로킹 카드 대신 토스트+목록, 1.4초 뒤 자동 다음"으로 구현(스펙 협의 사항). 페이스가 빠르면 지연(1.4초)만 조정하면 됨.
- DeviceCheck의 "얼굴 감지" 항목은 mediapipe를 준비 페이지에 끌어오지 않으려고 **가이드 원 + 사용자 자가 확인**으로 처리(카메라·마이크는 자동 점검). 실제 얼굴 정렬 게이팅이 필요하면 면접 화면의 FaceLandmarker를 준비 페이지로 끌어와야 함.

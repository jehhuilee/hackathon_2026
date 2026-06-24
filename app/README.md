# AI 면접 게이트웨이 (`app/`)

`Audio`(실시간 음성 분석 WebSocket)와 `LLM`(질문 생성·답변 평가)을 하나의
FastAPI 앱으로 묶고, 빠져 있던 **STT(음성→텍스트)** 단계와 **SQLite 저장**을
추가한 단일 백엔드 게이트웨이입니다.

## 파이프라인 (2-트랙)

- **실시간 트랙**: 프론트가 녹화 중 16kHz PCM을 `WS /ws/audio`로 보내 말속도/피치/침묵 경고를 받고, `STATUS` 지표를 모아 답변별 음성 요약을 만든다.
- **사후 트랙**: 답변 종료 시 녹화본(webm)을 `POST /api/answers`로 업로드 → Whisper 전사 → LLM 평가 → 저장.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/sessions` | 직무/이력서 → 질문 생성 + 세션 저장 |
| POST | `/api/answers` | 녹화본 업로드 → STT + 평가 + 저장 (multipart) |
| GET  | `/api/sessions/{id}/report` | 세션 종합 리포트 (질문/답변/평가/음성·자세 지표) |
| GET  | `/health` | 상태 확인 |
| WS   | `/ws/audio` | 실시간 음성 경고 (Audio 모듈, DSP 의존성 필요) |

## 설정 (`.env`)

```
LLM_BACKEND=openai          # openai | ollama
STT_BACKEND=openai          # openai | local
OPENAI_API_KEY=...          # openai 백엔드 사용 시
STT_OPENAI_MODEL=whisper-1
STT_LANGUAGE=ko
WHISPER_MODEL=base          # STT_BACKEND=local (faster-whisper)
DB_PATH=app/data/interview.db   # 선택 (기본값 동일)
```

## 실행

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r app/requirements.txt        # 게이트웨이 + STT
pip install -r Audio/requirements.txt      # 실시간 WS(librosa 등) 사용 시
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

> 참고: `Audio/requirements.txt`(librosa/scipy/webrtcvad)를 설치하지 않아도
> REST API는 동작하며, 이 경우 `/ws/audio`만 비활성화됩니다.

프론트엔드:

```bash
cd frontend
npm install
npm run dev        # VITE_API_URL 기본값 http://localhost:8000
```

## 테스트

```bash
python -m pytest app/tests/ LLM/tests/ -q
```

`app/tests/test_api.py`는 STT와 LLM 호출을 모킹해 세션 생성 → 답변 처리 →
리포트 집계 전 과정을 검증합니다.

## 데이터 저장

- 세션/질문/답변/평가: SQLite (`app/data/interview.db`)
- 녹화 원본: `app/data/audio/`
- 두 경로 모두 `.gitignore` 처리됨.

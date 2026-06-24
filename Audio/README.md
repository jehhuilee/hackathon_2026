# Two-Track 실시간 음성 분석 서버

이 폴더는 면접/발표 중 사용자의 음성을 0.5초 이내 지연 목표로 분석해 경고를 돌려주는 FastAPI WebSocket 백엔드입니다. 외부 API 없이 로컬 오픈소스 라이브러리만 사용합니다.

## 설계 요약

- 실시간 트랙: WebSocket 수신, `asyncio.Queue`, 3초 링버퍼, DSP 기반 말 빠르기/피치/침묵 분석, 즉시 JSON 경고 전송.
- 사후 분석 트랙: 답변 종료 후 Whisper STT와 Ollama LLM을 붙일 수 있도록 분리하는 것을 전제로 하며, 이 서버의 저지연 루프에는 포함하지 않습니다.
- 생산자-소비자 구조: WebSocket 수신부는 바이너리 프레임을 즉시 bounded queue에 넣고, 분석 워커가 디코딩/버퍼링/분석/전송을 담당합니다.
- 지연 제어: 큐가 꽉 차면 오래된 프레임을 버리고 최신 프레임을 유지합니다.

## 주요 파일

- `real_time_server.py`: FastAPI 앱 생성 및 라우터 등록 진입점.
- `routes.py`: `/health`, `/ws/audio` 엔드포인트와 WebSocket 수신 루프.
- `worker.py`: 큐 소비, 링버퍼 유지, 분석 실행, 경고 전송.
- `dsp.py`: `librosa`, `scipy`, `webrtcvad` 기반 신호 처리 함수.
- `ring_buffer.py`: 최신 3초 오디오를 보관하는 numpy 링버퍼.
- `events.py`: `TOO_FAST`, `PITCH_UNSTABLE`, `LONG_SILENCE`, `STATUS` 메시지 생성.
- `models.py`: 오디오 프레임과 분석 결과 데이터 구조.
- `config.py`: 샘플레이트, 윈도우 크기, 임계값 등 튜닝 상수.
- `manual_test_client.html`: 실제 마이크 입력으로 WebSocket 스트리밍을 확인하는 브라우저 테스트 클라이언트.
- `requirements.txt`: 로컬 실행 의존성.

## 실행

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r Audio/requirements.txt
uvicorn Audio.real_time_server:app --host 0.0.0.0 --port 8000 --reload
```

상태 확인:

```bash
curl http://localhost:8000/health
```

WebSocket 엔드포인트:

```text
ws://localhost:8000/ws/audio
```

## 클라이언트 입력 규약

브라우저는 마이크 입력을 다음 형태로 전송해야 합니다.

- 샘플레이트: 16,000 Hz
- 채널: mono
- 포맷: `int16` PCM 또는 `float32` PCM
- 권장 chunk 크기: 50-100 ms

연결 직후 설정 메시지를 보낼 수 있습니다.

```json
{"event":"config","dtype":"int16","vad_level":2}
```

그 뒤부터 오디오 chunk는 WebSocket binary frame으로 전송합니다.

## 서버 출력 예시

```json
{"event":"READY","sample_rate":16000,"channels":1,"dtype":"int16","window_seconds":3.0}
```

```json
{"event":"TOO_FAST","value":7.4,"threshold":7.0}
```

```json
{"event":"PITCH_UNSTABLE","value":51.2,"jitter":20.4,"threshold":45.0}
```

```json
{"event":"LONG_SILENCE","value":1.32,"threshold":1.2}
```

```json
{
  "event": "STATUS",
  "syllables_per_second": 4.8,
  "pitch_mean_hz": 183.5,
  "pitch_std_hz": 22.1,
  "pitch_jitter_hz": 6.3,
  "longest_silence_seconds": 0.31,
  "speech_ratio": 0.8,
  "window_seconds": 3.0
}
```

## 분석 방식

- 말 빠르기: `librosa.feature.rms`로 단기 에너지 궤적을 만들고 `scipy.signal.find_peaks`로 모음성 에너지 피크를 세어 초당 음절 수를 추정합니다.
- 피치/떨림: `librosa.pyin`으로 기본 주파수 F0를 추출하고 평균, 표준편차, 프레임 간 중앙 변화량을 계산합니다.
- 침묵: 단기 RMS dB가 낮은 연속 구간 길이를 계산합니다.
- 발화 여부 보조 지표: 최근 300ms를 `webrtcvad`로 검사해 `speech_ratio`를 제공합니다.

임계값과 샘플레이트는 `config.py`에서 조정합니다.

## 실제 음성 테스트 방법

1. 의존성을 설치하고 FastAPI 서버를 실행합니다.

```bash
pip install -r Audio/requirements.txt
uvicorn Audio.real_time_server:app --host 0.0.0.0 --port 8000 --reload
```

2. 별도 터미널에서 테스트 HTML을 localhost로 서빙합니다. 브라우저 마이크 권한은 `localhost`에서 안정적으로 동작합니다.

```bash
python -m http.server 8080
```

3. 브라우저에서 아래 주소를 엽니다.

```text
http://localhost:8080/Audio/manual_test_client.html
```

4. `Start mic`을 누르고 마이크 권한을 허용한 뒤 말합니다.

- 빠르게 말하면 `TOO_FAST` 이벤트가 표시됩니다.
- 일부러 1.2초 이상 멈추면 `LONG_SILENCE` 이벤트가 표시됩니다.
- 음높이를 크게 흔들면 `PITCH_UNSTABLE` 이벤트가 표시됩니다.
- 서버가 0.5초 간격으로 보내는 `STATUS` JSON에서 현재 지표를 확인할 수 있습니다.

브라우저 클라이언트는 마이크 입력을 16kHz mono int16 PCM으로 다운샘플링해 `ws://localhost:8000/ws/audio`로 100ms 단위 전송합니다.

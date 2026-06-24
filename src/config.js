// ============================ 설정 ============================
export const CONFIG = {
  // 검증된 무료 아바타 (둘 다 72개 모프: ARKit 52 + Oculus viseme 15)
  AVATAR_URL: './assets/avaturn.glb',     // 더 사실적. 가벼운 버전: './assets/brunette.glb'

  // ── 음성/립싱크 ─────────────────────────────────────────────
  // 키는 코드에 두지 않는다. 루트 .env 의 AZURE_SPEECH_KEY 로 관리하고,
  // 이 프로토타입을 직접 실행할 때만 window.AZURE_SPEECH_KEY 로 주입한다.
  // 키가 비어 있으면 USE_AZURE 가 자동으로 false → 무료 브라우저 음성으로 폴백된다.
  AZURE_KEY: (typeof window !== 'undefined' && window.AZURE_SPEECH_KEY) || '',
  get USE_AZURE() { return !!this.AZURE_KEY; },
  AZURE_REGION: 'koreacentral',           // 예: koreacentral, eastus
  AZURE_VOICE: 'en-US-AvaMultilingualNeural',  // 자연스러운 멀티링궐 여성(한국어 가능). ko 표준: ko-KR-JiMinNeural 등

  TTS_LANG: 'ko-KR',

  // ── 연출(책상에 앉은 면접관) ───────────────────────────────
  SEATED: true,       // 착석 포즈 + 상체 프레이밍
  SHOW_DESK: true,    // 책상 표시
  SHOW_PENCIL: true,  // 오른손에 연필 + 쥐는 손 모양
  CAM_FIT: 1.12,      // 상체(머리~손/책상) 자동 프레이밍 여유. 클수록 더 멀리(작게)
  CAM_HEIGHT: 0.03,   // 카메라 높이 보정(+면 위에서 내려봄)
};

// Microsoft viseme ID(0~21) → 아바타 Oculus viseme 모프 매핑
export const MS_VISEME_TO_OCULUS = {
  0: 'viseme_sil', 1: 'viseme_aa', 2: 'viseme_aa', 3: 'viseme_O', 4: 'viseme_E',
  5: 'viseme_RR', 6: 'viseme_I', 7: 'viseme_U', 8: 'viseme_O', 9: 'viseme_aa',
  10: 'viseme_O', 11: 'viseme_aa', 12: 'viseme_sil', 13: 'viseme_RR', 14: 'viseme_nn',
  15: 'viseme_SS', 16: 'viseme_CH', 17: 'viseme_TH', 18: 'viseme_FF', 19: 'viseme_DD',
  20: 'viseme_kk', 21: 'viseme_PP'
};

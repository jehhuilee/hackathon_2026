// 지난 면접 기록 샘플 데이터.
// 사이드바 "지난 면접 기록" 섹션과 상세 모달에서 사용한다. InterviewRecord 모양
// ({ id, question, answer, feedback, evaluation, category, source })에 회사/직무/
// 날짜를 더해, 클릭하면 이번 면접 항목과 동일한 상세 모달로 열린다.

export const PAST_INTERVIEWS = [
  {
    id: "past-naver-1",
    source: "past",
    company: "네이버",
    role: "백엔드",
    date: "2024.11.15",
    category: "Q3 직무 경험",
    question: "대규모 트래픽을 처리한 경험이 있다면 설명해 주세요.",
    answer:
      "검색 광고 시스템에서 초당 3만 건의 요청을 처리했습니다. 캐시 계층을 추가하고 비동기 큐로 부하를 분산해 p99 지연을 절반으로 줄였습니다.",
    feedback: "수치로 성과를 제시한 점이 좋습니다. 장애 상황에서의 대응 경험까지 덧붙이면 더 설득력 있습니다.",
    evaluation: {
      total_score: 78,
      content_score: 80,
      structure_score: 75,
      strength: "정량적 성과 제시",
      improvement: "장애 대응 경험 보강",
      sample_answer: "",
    },
  },
  {
    id: "past-samsung-1",
    source: "past",
    company: "삼성 SDS",
    role: "풀스택",
    date: "2024.10.30",
    category: "Q2 팀 협업",
    question: "팀 내 의견 충돌을 어떻게 해결했나요?",
    answer:
      "API 설계를 두고 프론트와 의견이 갈렸는데, 양쪽 요구사항을 문서로 정리하고 작은 PoC로 데이터를 보여주며 합의했습니다.",
    feedback: "데이터로 합의를 끌어낸 접근이 좋습니다. 합의 이후의 결과(이점)까지 마무리하면 완결성이 높아집니다.",
    evaluation: {
      total_score: 71,
      content_score: 72,
      structure_score: 70,
      strength: "데이터 기반 설득",
      improvement: "결과·임팩트로 마무리",
      sample_answer: "",
    },
  },
];

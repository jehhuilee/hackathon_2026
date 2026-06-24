import { useState } from "react";
import { createSession } from "../services/api";

// Interviewer personas. The persona code drives the real-time audio feedback
// strictness (alert thresholds) in the backend.
const PERSONAS = [
  {
    code: "A",
    title: "친근한 면접관",
    subtitle: "성장 단계 스타트업",
    desc: "후한 점수, 부담 없는 질문 · 음성 피드백 널널",
  },
  {
    code: "B",
    title: "표준 면접관",
    subtitle: "중견/대기업",
    desc: "균형, 공정 채점 · 음성 피드백 보통 (기본값)",
  },
  {
    code: "C",
    title: "엄격한 면접관",
    subtitle: "탑티어/외국계",
    desc: "압박 질문, 짠 점수 · 음성 피드백 빡빡",
  },
];

// Collects the interview profile and creates a session (generates questions).
export default function SetupForm({ onReady }) {
  const [jobRole, setJobRole] = useState("");
  const [company, setCompany] = useState("");
  const [techStack, setTechStack] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [questionCount, setQuestionCount] = useState(5);
  const [persona, setPersona] = useState("B");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const profile = {
        job_role: jobRole,
        company,
        tech_stack: techStack
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        resume_text: resumeText,
        question_count: Number(questionCount),
      };
      const result = await createSession(profile);
      onReady({ ...result, persona }); // { session_id, questions, persona }
    } catch (err) {
      setError(`질문 생성에 실패했습니다: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h1>AI 면접 연습 설정</h1>
      <p style={styles.hint}>직무와 이력서를 입력하면 맞춤 면접 질문이 생성됩니다.</p>

      <label style={styles.label}>
        지원 직무
        <input
          style={styles.input}
          value={jobRole}
          onChange={(e) => setJobRole(e.target.value)}
          placeholder="예: 백엔드 개발자"
          required
        />
      </label>

      <label style={styles.label}>
        지원 회사
        <input
          style={styles.input}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="예: 네이버"
        />
      </label>

      <label style={styles.label}>
        기술/역량 (쉼표로 구분)
        <input
          style={styles.input}
          value={techStack}
          onChange={(e) => setTechStack(e.target.value)}
          placeholder="예: Python, FastAPI, React"
        />
      </label>

      <label style={styles.label}>
        이력서 / 자기소개
        <textarea
          style={{ ...styles.input, height: 140, resize: "vertical" }}
          value={resumeText}
          onChange={(e) => setResumeText(e.target.value)}
          placeholder="경험, 성과, 프로젝트를 자유롭게 작성하세요."
        />
      </label>

      <label style={styles.label}>
        질문 개수
        <input
          style={styles.input}
          type="number"
          min={1}
          max={10}
          value={questionCount}
          onChange={(e) => setQuestionCount(e.target.value)}
        />
      </label>

      <div style={styles.label}>
        면접관 유형
        <div style={styles.personaGroup}>
          {PERSONAS.map((p) => {
            const selected = persona === p.code;
            return (
              <button
                type="button"
                key={p.code}
                onClick={() => setPersona(p.code)}
                style={{
                  ...styles.personaCard,
                  ...(selected ? styles.personaCardSelected : {}),
                }}
              >
                <div style={styles.personaTitle}>
                  {p.code}. {p.title}
                </div>
                <div style={styles.personaSubtitle}>{p.subtitle}</div>
                <div style={styles.personaDesc}>{p.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      <button type="submit" disabled={loading} style={styles.submit}>
        {loading ? "질문 생성 중..." : "면접 시작하기"}
      </button>
    </form>
  );
}

const styles = {
  form: {
    maxWidth: 560,
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  hint: { color: "#52616f", marginTop: -8 },
  label: { display: "flex", flexDirection: "column", gap: 6, fontWeight: 600 },
  input: {
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #c5ced8",
    fontSize: 15,
    fontWeight: 400,
  },
  submit: {
    padding: "12px 16px",
    borderRadius: 8,
    border: "none",
    background: "#2563eb",
    color: "white",
    fontSize: 16,
    fontWeight: 700,
    cursor: "pointer",
  },
  personaGroup: { display: "flex", gap: 10, flexWrap: "wrap" },
  personaCard: {
    flex: 1,
    minWidth: 150,
    textAlign: "left",
    padding: "12px 14px",
    borderRadius: 10,
    border: "1px solid #c5ced8",
    background: "white",
    cursor: "pointer",
    fontWeight: 400,
  },
  personaCardSelected: {
    border: "2px solid #2563eb",
    background: "#eff5ff",
  },
  personaTitle: { fontWeight: 700, fontSize: 15, color: "#1f2933" },
  personaSubtitle: { fontSize: 13, color: "#2563eb", marginTop: 2 },
  personaDesc: { fontSize: 12, color: "#52616f", marginTop: 6, lineHeight: 1.4 },
  error: { color: "#d64545", fontWeight: 600 },
};

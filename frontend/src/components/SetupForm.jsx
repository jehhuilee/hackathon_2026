import { useState } from "react";
import { createSession } from "../services/api";

// Collects the interview profile and creates a session (generates questions).
export default function SetupForm({ onReady }) {
  const [jobRole, setJobRole] = useState("");
  const [company, setCompany] = useState("");
  const [techStack, setTechStack] = useState("");
  const [resumeText, setResumeText] = useState("");
  const [questionCount, setQuestionCount] = useState(5);
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
      onReady(result); // { session_id, questions }
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
  error: { color: "#d64545", fontWeight: 600 },
};

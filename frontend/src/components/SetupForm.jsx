import { useRef, useState } from "react";
import { createSession, extractResumePdf } from "../services/api";

// Interviewer personas. The persona code drives the real-time audio feedback
// strictness (alert thresholds) in the backend.
const PERSONAS = [
  {
    code: "A",
    emoji: "😊",
    iconBg: "#fef3c7",
    title: "친근한 면접관",
    desc: "편안한 분위기 · 격려 중심",
  },
  {
    code: "B",
    emoji: "💼",
    iconBg: "#ede9fe",
    title: "표준 면접관",
    desc: "균형 피드백 · 일반 기업 기준",
    badge: "기본",
  },
  {
    code: "C",
    emoji: "⚡",
    iconBg: "#fee2e2",
    title: "엄격한 면접관",
    desc: "날카로운 질문 · 대기업 대비",
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
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfInfo, setPdfInfo] = useState("");
  const fileInputRef = useRef(null);

  const techList = techStack
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const handlePdfChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setPdfLoading(true);
    setPdfInfo("");
    setError("");
    try {
      const { text, page_count } = await extractResumePdf(file);
      setResumeText(text);
      setPdfInfo(`'${file.name}' (${page_count}쪽) 불러옴 · 아래에서 수정할 수 있어요.`);
    } catch (err) {
      setError(`PDF 처리에 실패했습니다: ${err.message}`);
    } finally {
      setPdfLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const profile = {
        job_role: jobRole,
        company,
        tech_stack: techList,
        resume_text: resumeText,
        question_count: Number(questionCount),
      };
      const result = await createSession(profile);
      onReady({ ...result, persona, job_role: jobRole, company });
    } catch (err) {
      setError(`질문 생성에 실패했습니다: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <h1 style={styles.title}>맞춤 면접 설정</h1>
      <p style={styles.subtitle}>지원 정보를 입력하면 AI가 질문을 자동 생성합니다</p>

      <div style={styles.grid}>
        {/* 좌측 메인 */}
        <div style={styles.mainCol}>
          <section className="card" style={styles.card}>
            <div style={styles.sectionLabel}>지원 정보</div>

            <label style={styles.field}>
              <span style={styles.fieldLabel}>
                지원 직무 <span style={styles.required}>필수</span>
              </span>
              <input
                className="input"
                value={jobRole}
                onChange={(e) => setJobRole(e.target.value)}
                placeholder="예: 프론트엔드 개발자"
                required
              />
            </label>

            <label style={styles.field}>
              <span style={styles.fieldLabel}>지원 회사</span>
              <input
                className="input"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="예: 카카오테크"
              />
            </label>

            <label style={styles.field}>
              <span style={styles.fieldLabel}>
                기술 / 역량 <span style={styles.hint}>(쉼표로 구분)</span>
              </span>
              <input
                className="input"
                value={techStack}
                onChange={(e) => setTechStack(e.target.value)}
                placeholder="예: React, TypeScript, 성능 최적화"
              />
              {techList.length > 0 && (
                <div style={styles.chips}>
                  {techList.map((t, i) => (
                    <span key={`${t}-${i}`} className="chip">
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </label>
          </section>

          <section className="card" style={styles.card}>
            <div style={styles.sectionLabel}>이력서 / 포트폴리오</div>

            {/* 단일 파일 입력 — 평소엔 숨기고 '교체'/업로드 버튼으로 연다 */}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={handlePdfChange}
              disabled={pdfLoading}
              style={{ display: "none" }}
            />

            {pdfInfo ? (
              <div style={styles.fileOk}>
                <span style={styles.fileCheck}>✓</span>
                <div style={{ flex: 1 }}>
                  <div style={styles.fileName}>{pdfInfo}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={styles.smallBtn}
                  onClick={() => fileInputRef.current?.click()}
                >
                  교체
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={pdfLoading}
                style={styles.uploadBox}
              >
                {pdfLoading ? "PDF에서 텍스트 추출 중..." : "📄 PDF 업로드 (또는 아래에 직접 입력)"}
              </button>
            )}

            <label style={{ ...styles.field, marginTop: 14 }}>
              <span style={styles.fieldLabel}>
                강조할 점 <span style={styles.hint}>(선택 · PDF에서 자동 추출 또는 직접 입력)</span>
              </span>
              <textarea
                className="input"
                style={{ height: 140, resize: "vertical", lineHeight: 1.6 }}
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
                placeholder="경험·성과·프로젝트를 직접 작성하거나 PDF를 업로드하세요."
              />
            </label>
          </section>
        </div>

        {/* 우측 사이드 */}
        <div style={styles.sideCol}>
          <section className="card" style={styles.card}>
            <div style={styles.sectionLabel}>질문 개수</div>
            <div style={styles.countRow}>
              <span style={styles.countText}>면접 질문 수</span>
              <span style={styles.countBig}>
                {questionCount}
                <span style={styles.countUnit}>개</span>
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              value={questionCount}
              onChange={(e) => setQuestionCount(Number(e.target.value))}
              style={styles.range}
            />
            <div style={styles.rangeEnds}>
              <span>1개</span>
              <span>10개</span>
            </div>
          </section>

          <section className="card" style={styles.card}>
            <div style={styles.sectionLabel}>면접관 페르소나</div>
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
                    <span style={{ ...styles.personaIcon, background: p.iconBg }}>{p.emoji}</span>
                    <span style={{ flex: 1, textAlign: "left" }}>
                      <span style={styles.personaTitle}>
                        {p.code}. {p.title}
                        {p.badge && <span style={styles.personaBadge}>{p.badge}</span>}
                      </span>
                      <span style={styles.personaDesc}>{p.desc}</span>
                    </span>
                    <span style={{ ...styles.radio, ...(selected ? styles.radioOn : {}) }} />
                  </button>
                );
              })}
            </div>
          </section>

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" disabled={loading} className="btn btn-primary" style={styles.submit}>
            {loading ? "질문 생성 중..." : "면접 시작하기 →"}
          </button>
        </div>
      </div>
    </form>
  );
}

const styles = {
  title: { fontSize: 34, fontWeight: 800, margin: "0 0 6px" },
  subtitle: { color: "var(--muted)", margin: "0 0 24px", fontSize: 16 },
  grid: { display: "flex", gap: 24, alignItems: "flex-start", flexWrap: "wrap" },
  mainCol: { flex: "1 1 520px", minWidth: 320, display: "flex", flexDirection: "column", gap: 20 },
  sideCol: { flex: "1 1 320px", minWidth: 280, display: "flex", flexDirection: "column", gap: 20 },
  card: { padding: 24 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: 800,
    color: "var(--primary-ink)",
    letterSpacing: 0.2,
    marginBottom: 16,
  },
  field: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 },
  fieldLabel: { fontWeight: 700, fontSize: 14, color: "var(--text)" },
  hint: { fontWeight: 500, color: "var(--faint)", fontSize: 13 },
  required: {
    background: "var(--danger-soft)",
    color: "var(--danger)",
    fontSize: 11,
    fontWeight: 800,
    padding: "2px 7px",
    borderRadius: 6,
    marginLeft: 4,
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 },
  fileOk: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "var(--success-soft)",
    border: "1px solid #bbf7d0",
    borderRadius: 12,
    padding: "14px 16px",
  },
  fileCheck: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    background: "#fff",
    color: "var(--success)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 800,
    flexShrink: 0,
  },
  fileName: { fontSize: 14, fontWeight: 600, color: "#166534" },
  smallBtn: { padding: "8px 14px", fontSize: 13 },
  uploadBox: {
    width: "100%",
    padding: "16px",
    borderRadius: 12,
    border: "1.5px dashed var(--border-strong)",
    background: "var(--surface-2)",
    color: "var(--muted)",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center",
  },
  countRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-end" },
  countText: { fontSize: 15, fontWeight: 600, color: "var(--text)" },
  countBig: { fontSize: 38, fontWeight: 800, color: "var(--primary)", lineHeight: 1 },
  countUnit: { fontSize: 16, marginLeft: 2 },
  range: { width: "100%", accentColor: "var(--primary)", marginTop: 16, cursor: "pointer" },
  rangeEnds: {
    display: "flex",
    justifyContent: "space-between",
    color: "var(--faint)",
    fontSize: 13,
    marginTop: 4,
  },
  personaGroup: { display: "flex", flexDirection: "column", gap: 10 },
  personaCard: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 14px",
    borderRadius: 12,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    cursor: "pointer",
    width: "100%",
  },
  personaCardSelected: {
    border: "2px solid var(--primary)",
    background: "var(--primary-soft)",
    padding: "11px 13px",
  },
  personaIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 20,
    flexShrink: 0,
  },
  personaTitle: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontWeight: 700,
    fontSize: 15,
    color: "var(--text)",
  },
  personaBadge: {
    background: "var(--primary)",
    color: "#fff",
    fontSize: 10,
    fontWeight: 800,
    padding: "1px 6px",
    borderRadius: 5,
  },
  personaDesc: { display: "block", fontSize: 13, color: "var(--muted)", marginTop: 3 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: "50%",
    border: "2px solid var(--border-strong)",
    flexShrink: 0,
  },
  radioOn: {
    border: "6px solid var(--primary)",
    background: "#fff",
  },
  submit: { width: "100%", padding: "15px 18px", fontSize: 16 },
  error: { color: "var(--danger)", fontWeight: 600, margin: 0 },
};

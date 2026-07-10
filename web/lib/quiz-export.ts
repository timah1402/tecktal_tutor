import { type QuizQuestion } from "@/lib/quiz-types";

export interface QuizExportRow {
  index: number;
  question: QuizQuestion;
  userAnswer: string;
  /** null = open-ended type, not auto-graded. */
  isCorrect: boolean | null;
}

export interface BuildQuizMarkdownOptions {
  title?: string;
  exportedAt?: Date;
}

function formatOptions(options: Record<string, string> | undefined): string {
  if (!options || Object.keys(options).length === 0) return "";
  const lines = Object.entries(options).map(
    ([key, text]) => `- **${key}.** ${text}`,
  );
  return `${lines.join("\n")}\n\n`;
}

export function buildQuizMarkdown(
  rows: QuizExportRow[],
  options: BuildQuizMarkdownOptions = {},
): string {
  const title = options.title?.trim() || "Quiz Session";
  const exportedAt = (options.exportedAt ?? new Date()).toISOString();
  const graded = rows.filter((row) => row.isCorrect !== null);
  const correctCount = graded.filter((row) => row.isCorrect).length;
  const scoreLine =
    graded.length > 0
      ? `_Score: ${correctCount}/${graded.length} auto-graded correct_\n\n`
      : "";
  const header = `# ${title}\n\n_Exported: ${exportedAt}_\n\n${scoreLine}---\n\n`;

  const body = rows
    .map((row) => {
      const { question, userAnswer, isCorrect } = row;
      const resultLine =
        isCorrect === null
          ? "_Not auto-graded — review your answer against the explanation below._"
          : isCorrect
            ? "**Result:** ✅ Correct"
            : "**Result:** ❌ Incorrect";
      const optionsBlock = formatOptions(question.options);
      const explanation = question.explanation?.trim()
        ? `\n\n**Explanation:** ${question.explanation.trim()}`
        : "";
      return (
        `## Q${row.index + 1}. ${question.question}\n\n` +
        optionsBlock +
        `**Your answer:** ${userAnswer || "_(no answer)_"}\n\n` +
        `**Correct answer:** ${question.correct_answer}\n\n` +
        resultLine +
        explanation
      );
    })
    .join("\n\n---\n\n");

  return header + body + "\n";
}

function sanitizeFilename(input: string): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|\n\r\t]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return cleaned || "quiz";
}

export function downloadQuizMarkdown(
  rows: QuizExportRow[],
  options: BuildQuizMarkdownOptions = {},
): void {
  if (!rows.length) return;
  const markdown = buildQuizMarkdown(rows, options);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const date = new Date().toISOString().slice(0, 10);
  anchor.download = `${sanitizeFilename(options.title || "quiz")}-${date}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// One consolidated answer to a question asked of a whole matter.
//
// It searches the matter's passages (words + meaning), hands the best ones to
// the model as the only source it may use, and asks for a single answer that
// cites the document and page for everything it says — reusing the same passages
// and page numbers the assistant cites elsewhere. If the passages do not answer
// the question, it says so rather than guessing.
import { completeText, resolveModel, DEFAULT_MAIN_MODEL, type UserApiKeys } from "./llm";
import { searchMatter, formatForAssistant, type MatterSearchHit } from "./matterSearch";
import { linkAnswerCitations, type AnswerCitation } from "./matterCitations";
import { loadProjectContext, caseOverviewBackground } from "./projectOverview";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

const SYSTEM_PROMPT = [
  "You are a careful legal assistant. Answer the question using ONLY the passages provided from a matter's documents.",
  "Rules:",
  "- Use only the passages given. Do not add outside knowledge and do not invent document content.",
  "- Cite the document and page for every fact you state, written as (filename, page N).",
  "- If the passages do not answer the question, say so plainly and stop. Do not guess.",
  "- A passage marked as matched on the file's name has no readable text inside the file; treat it only as a label, not as content.",
  "- Background on the matter may be given before the question. Use it to understand the parties and what the reader wants, but never cite it and never state it as something a document says.",
  "- Be concise and neutral. Nothing here replaces reading a document in full when it matters.",
].join("\n");

export type MatterAnswer = {
  question: string;
  answer: string;
  /** The passages the answer was drawn from, for citation and follow-up. */
  sources: MatterSearchHit[];
  /**
   * The citations written inside the answer, each tied back to the document and
   * passage it came from so a reader can click it open.
   */
  citations: AnswerCitation[];
};

export async function answerMatter(
  db: Db,
  params: {
    userId: string;
    projectId?: string | null;
    question: string;
    model?: string | null;
    apiKeys?: UserApiKeys;
    limit?: number;
  },
): Promise<MatterAnswer> {
  const question = params.question.trim();
  if (!question) {
    return {
      question: "",
      answer: "Ask a question to search the matter.",
      sources: [],
      citations: [],
    };
  }

  const sources = await searchMatter(db, {
    userId: params.userId,
    projectId: params.projectId ?? null,
    query: question,
    limit: params.limit ?? 12,
  });

  if (sources.length === 0) {
    return {
      question,
      answer:
        `Nothing in this matter's documents appears to address "${question}". ` +
        "The point may not be covered, or a scanned document may have read poorly — try different words.",
      sources: [],
      citations: [],
    };
  }

  const context = formatForAssistant(question, sources);
  // The matter's standing instructions, so the answer knows which side the
  // reader is on. It shapes how the passages are read; it is never a source
  // in its own right.
  const caseContext = await loadProjectContext(db, params.projectId);
  const background = caseOverviewBackground(
    caseContext.overview,
    caseContext.memories,
  );
  const model = resolveModel(params.model, DEFAULT_MAIN_MODEL);
  const answer = await completeText({
    model,
    systemPrompt: SYSTEM_PROMPT,
    user:
      background +
      `Question: ${question}\n\n` +
      `Passages found in the matter's documents:\n${context}\n\n` +
      "Answer the question using only these passages, citing the document and page for each point.",
    maxTokens: 800,
    apiKeys: params.apiKeys,
  });

  const text = answer.trim();
  return { question, answer: text, sources, citations: linkAnswerCitations(text, sources) };
}

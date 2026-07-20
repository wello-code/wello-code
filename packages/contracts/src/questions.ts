import { z } from "zod";

/**
 * Model-initiated clarifying questions. The agent proposes one or more questions
 * (each with 2–4 options); the user answers in the UI and the selection is fed back
 * to the model as a tool result. This is a first-class interaction, distinct from a
 * permission request (which only allows/denies an action).
 */
export const QuestionOption = z.object({
  label: z.string(),
  /** Optional one-line explanation of what choosing this option means. */
  description: z.string().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOption>;

export const Question = z.object({
  /** Short chip label naming the topic (e.g. "Палитра", "Auth method"). */
  header: z.string(),
  /** The full question, in the user's language. */
  question: z.string(),
  /** When true the user may pick several options. */
  multiSelect: z.boolean(),
  options: z.array(QuestionOption),
});
export type Question = z.infer<typeof Question>;

export const QuestionRequest = z.object({
  id: z.string(),
  runId: z.string(),
  questions: z.array(Question),
});
export type QuestionRequest = z.infer<typeof QuestionRequest>;

/** One answer per question: the chosen option labels plus optional free text. */
export const QuestionReply = z.object({
  selected: z.array(z.string()),
  custom: z.string().optional(),
});
export type QuestionReply = z.infer<typeof QuestionReply>;

export const QuestionAnswer = z.object({
  requestId: z.string(),
  answers: z.array(QuestionReply),
  /** The user dismissed the question; the model should proceed with its judgment. */
  skipped: z.boolean().optional(),
});
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

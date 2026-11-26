// Server-side Claude calls. The browser names a task and sends lesson fields;
// the prompts live here, so the endpoint cannot be used as a general chatbot.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const MODEL = process.env.FF_MODEL || "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];

let client: Anthropic | null = null;
export const aiConfigured = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const getClient = () => (client ??= new Anthropic());

export class AiError extends Error {
  status: number;
  code: string;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---------- input ----------
const s = (n: number) => z.string().max(n).optional().default("");
const Block = z.object({ kind: s(40), title: s(400), body: s(4000) });
export const AiInput = z.object({
  title: s(300),
  ref: s(200),
  mode: s(20),
  subj: s(600),
  comp: s(600),
  need: s(1500),
  grace: s(1500),
  passage: s(8000),
  a: Block.optional(),
  b: Block.optional(),
  image: z.string().max(8_000_000).optional(), // base64 PNG, for read-ink
});
export type AiInput = z.infer<typeof AiInput>;

const ctx = (l: AiInput) =>
  `Lesson: "${l.title}". Passage: ${l.ref || "none"}. Mode: ${l.mode} (Teach = men's group teaching, Discuss = small-group discussion, Solo = personal study). Big idea: ${l.comp || "not set"}.`;

const SYSTEM =
  "You help a Bible teacher prepare lessons for a men's ministry. You assist; you never write the lesson for him. " +
  "Be accurate and conservative with Scripture: do not invent verses or present speculation as fact. Use standard book names in references.";

// ---------- output schemas ----------
const Ref = z.object({ ref: z.string(), why: z.string() });
const Study = z.object({
  observations: z.array(z.string()),
  keywords: z.array(z.object({ word: z.string(), note: z.string() })),
  crossrefs: z.array(Ref),
  questions: z.array(z.string()),
});
const Suggest = z.object({ observations: z.array(z.string()), crossrefs: z.array(Ref), questions: z.array(z.string()) });
const Idea = z.object({ verdict: z.string(), suggestion: z.string() });
const Questions = z.object({ questions: z.array(z.string()) });

type Task = {
  prompt: (l: AiInput) => string;
  schema?: z.ZodType;
  needs?: (l: AiInput) => string | null;
  maxTokens?: number;
};

export const TASKS: Record<string, Task> = {
  study: {
    needs: (l) => (l.ref ? null : "Set the passage in Plan first."),
    schema: Study,
    prompt: (l) =>
      `${ctx(l)}\nPassage text (BSB, may be empty): ${l.passage}\n\nSuggest material for an inductive study of ${l.ref}: 4 short factual observations from the text, 3 key words with brief original-language or meaning notes, 4 cross references with a short reason each, and 3 open interpretive questions.`,
  },
  suggest: {
    needs: (l) => (l.ref ? null : "Set the passage in Plan first."),
    schema: Suggest,
    prompt: (l) =>
      `Passage: ${l.ref} (BSB):\n${l.passage}\n\nSuggest material for an inductive study: 4 short factual observations from the text, 3 cross references (ref as "Book chapter:verse") with a short reason each, and 3 open interpretive questions.`,
  },
  idea: {
    needs: (l) => (l.subj || l.comp ? null : "Write a subject and complement first."),
    schema: Idea,
    prompt: (l) =>
      `${ctx(l)}\nHaddon Robinson's big idea method: subject (a question: what is the text talking about?) plus complement (what it says about that). Subject: "${l.subj}". Complement: "${l.comp}".\nEvaluate briefly. verdict: one sentence on whether it is one clear, text-faithful idea. suggestion: an improved one-sentence big idea, or the same if it is good.`,
  },
  questions: {
    schema: Questions,
    prompt: (l) =>
      `${ctx(l)}\nNeed: ${l.need}. Grace: ${l.grace}.\nWrite 3 discussion questions for a men's group: one observation, one interpretation, one personal application.`,
  },
  transition: {
    needs: (l) => (l.a && l.b ? null : "Missing blocks."),
    maxTokens: 2000,
    prompt: (l) =>
      `${ctx(l)}\nWrite one spoken transition (1 or 2 short sentences, plain conversational words, no quotation marks) to move a group from this block:\n[${l.a!.kind}] ${l.a!.title}: ${l.a!.body}\nto the next block:\n[${l.b!.kind}] ${l.b!.title}: ${l.b!.body}\nReturn only the transition.`,
  },
  "read-ink": {
    needs: (l) => (l.image ? null : "No handwriting image."),
    maxTokens: 4000,
    prompt: () =>
      "Transcribe this handwriting exactly as written, keeping line breaks and Bible references. Return only the transcription. Mark any word you cannot read as [?].",
  },
};

export async function runTask(name: string, input: AiInput): Promise<{ text?: string; data?: unknown }> {
  const task = TASKS[name];
  if (!task) throw new AiError("unknown_task", "Unknown AI task.", 404);
  const missing = task.needs?.(input);
  if (missing) throw new AiError("bad_input", missing, 400);
  if (!aiConfigured()) throw new AiError("not_configured", "AI is not set up on this server.", 503);

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (name === "read-ink" && input.image) {
    content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: input.image } });
  }
  content.push({ type: "text", text: task.prompt(input) });

  const base = {
    model: MODEL,
    max_tokens: task.maxTokens ?? 8000,
    betas: BETAS,
    fallbacks: "default" as const,
    system: SYSTEM,
    messages: [{ role: "user" as const, content }],
  };

  try {
    if (task.schema) {
      const r = await getClient().beta.messages.parse({
        ...base,
        output_config: { effort: "low", format: betaZodOutputFormat(task.schema) },
      });
      if (r.stop_reason === "refusal") throw new AiError("refused", "Claude declined this request.", 422);
      if (r.parsed_output == null) throw new AiError("bad_output", "The answer came back in the wrong shape. Try again.");
      return { data: r.parsed_output };
    }
    const r = await getClient().beta.messages.create({ ...base, output_config: { effort: "low" } });
    if (r.stop_reason === "refusal") throw new AiError("refused", "Claude declined this request.", 422);
    const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    return { text };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new AiError("rate_limited", "Too many requests. Try again in a minute.", 429);
    if (e instanceof Anthropic.AuthenticationError) throw new AiError("not_configured", "The server's Anthropic key was rejected.", 503);
    if (e instanceof Anthropic.BadRequestError) {
      console.error("AI bad request:", e.message);
      throw new AiError("bad_request", "Claude could not take that request.", 400);
    }
    if (e instanceof Anthropic.APIError) {
      console.error("AI error:", e.status, e.message);
      throw new AiError("upstream", "Claude is not responding right now. Try again.", 502);
    }
    throw e;
  }
}

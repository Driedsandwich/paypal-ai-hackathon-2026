import { z } from "zod";
import type { AiMessage, AiProvider } from "../ai/provider.js";
import { redactDeep } from "../privacy/redact.js";

export class AgentOutputError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "AgentOutputError";
  }
}

/** Finds the first JSON object in a model reply (handles ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("no JSON object in reply");
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Pulls the task input back out of a prompt built by runJsonTask (used by the offline provider). */
export function inputFromPrompt(prompt: string): unknown {
  const m = /<input>\s*([\s\S]*?)\s*<\/input>/.exec(prompt);
  return m ? JSON.parse(m[1]!) : undefined;
}

export interface JsonTaskOptions<S extends z.ZodType> {
  task: string;
  system: string;
  input: unknown;
  schema: S;
  maxTokens: number;
}

/**
 * Asks for a JSON object, validates it with zod, and retries once with the
 * validation issues if the first answer does not fit. Works the same on every
 * provider: no forced tool choice and no provider-specific structured-output mode.
 */
export async function runJsonTask<S extends z.ZodType>(
  ai: AiProvider,
  opts: JsonTaskOptions<S>,
): Promise<{ value: z.infer<S>; provider: string; model?: string; fallbackFrom?: { provider: string; model?: string; reason: string } }> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(opts.schema));
  // Free text (item descriptions, dispute messages, seller notes) is redacted before it
  // reaches the model: email addresses, phone numbers, street-address-like lines (F7).
  const input = redactDeep(opts.input);
  const messages: AiMessage[] = [
    { role: "system", content: opts.system },
    {
      role: "user",
      content: [
        "Task input (JSON):",
        `<input>\n${JSON.stringify(input)}\n</input>`,
        "Reply with only one JSON object that matches this JSON Schema, no prose:",
        jsonSchema,
      ].join("\n"),
    },
  ];

  let issues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await ai.complete({ messages, maxTokens: opts.maxTokens, task: opts.task });
    let parsed: unknown;
    try {
      parsed = extractJson(result.text);
    } catch (err) {
      issues = [`not valid JSON: ${(err as Error).message}`];
      messages.push({ role: "assistant", content: result.text }, { role: "user", content: retryPrompt(issues) });
      continue;
    }
    const check = opts.schema.safeParse(parsed);
    if (check.success) {
      return { value: check.data, provider: result.provider, ...(result.model ? { model: result.model } : {}), ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom } : {}) };
    }
    issues = check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    messages.push({ role: "assistant", content: result.text }, { role: "user", content: retryPrompt(issues) });
  }
  throw new AgentOutputError(`The AI answer for ${opts.task} did not match the expected format`, issues);
}

function retryPrompt(issues: string[]): string {
  return `That answer did not match the schema:\n- ${issues.slice(0, 10).join("\n- ")}\nReply again with only the corrected JSON object.`;
}

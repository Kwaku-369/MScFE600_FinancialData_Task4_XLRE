/**
 * Shared Claude client and the one call shape every agent uses.
 *
 * Agents in this system are advisory. They read the deterministic findings and
 * the evidence behind them and propose a disposition; they never write a value
 * into a submission and never close a finding. Their output is stored in
 * `agent_reviews`, alongside but separate from the rule output, so an auditor
 * can always tell a model's judgement from a rule's — which is the difference
 * between an audit trail that survives scrutiny and one that does not.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env.js";

export interface AgentCallOptions {
  system: string;
  prompt: string;
  tool: Anthropic.Tool;
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface AgentCallResult<T> {
  output: T | null;
  /** Present when the model declined or returned no structured answer. */
  failure: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function createClient(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured. Set it with `wrangler secret put ANTHROPIC_API_KEY`.",
    );
  }
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
 * Run one agent turn and return its structured answer.
 *
 * Uses a strict tool as the output contract rather than free text: an auditor's
 * queue needs a fixed set of recommendations, and a strict schema is what makes
 * the response safe to store and act on without post-hoc parsing.
 */
export async function callAgent<T>(
  env: Env,
  options: AgentCallOptions,
): Promise<AgentCallResult<T>> {
  const client = createClient(env);
  const model = env.ANTHROPIC_MODEL || "claude-opus-5";

  const response = await client.beta.messages.create({
    model,
    max_tokens: options.maxTokens ?? 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: options.effort ?? "medium" },
    // A safety decline on a routine KYC record would stall the review queue, so
    // the request falls back to another model rather than simply stopping.
    betas: ["server-side-fallback-2026-06-01"],
    fallbacks: [{ model: "claude-opus-4-8" }],
    system: options.system,
    messages: [{ role: "user", content: options.prompt }],
    tools: [options.tool],
  });

  const usage = {
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    return {
      output: null,
      failure: `The model declined to assess this case (${response.stop_details?.category ?? "unspecified"}).`,
      model: response.model,
      ...usage,
    };
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .slice(0, 400);
    return {
      output: null,
      failure: text || "The model returned no structured recommendation.",
      model: response.model,
      ...usage,
    };
  }

  // Tool inputs are parsed JSON already; never string-match the serialised form.
  return { output: toolUse.input as T, failure: null, model: response.model, ...usage };
}

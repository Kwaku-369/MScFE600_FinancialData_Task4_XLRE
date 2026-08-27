/**
 * The column-mapping agent.
 *
 * The deterministic mapper handles every heading it has seen before. This agent
 * exists for the rest: a core banking system nobody has onboarded yet, headings
 * in Twi or abbreviated to initials, or a column whose meaning is only apparent
 * from the values under it. It is given sample values as well as the heading,
 * because `BAL` and `BALANCE B/F` are indistinguishable by name alone but
 * obvious once you see what is in them.
 *
 * Its proposals are never applied silently — they arrive in the mapping review
 * screen marked as agent-proposed, for an operator to confirm.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env.js";
import { callAgent } from "./client.js";

export interface MapperInput {
  unmappedHeaders: Array<{ header: string; samples: string[] }>;
  unfilledFields: Array<{ id: string; header: string; description: string; required: boolean }>;
}

export interface MapperOutput {
  mappings: Array<{
    source_header: string;
    field_id: string;
    confidence: number;
    reason: string;
  }>;
  unmappable: Array<{ source_header: string; reason: string }>;
}

const TOOL: Anthropic.Tool = {
  name: "propose_mappings",
  description:
    "Propose which uploaded spreadsheet columns correspond to which GDPC template fields.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      mappings: {
        type: "array",
        description: "One entry per column you can confidently map.",
        items: {
          type: "object",
          properties: {
            source_header: { type: "string" },
            field_id: {
              type: "string",
              description: "The exact template field id, copied from the list supplied.",
            },
            confidence: { type: "number" },
            reason: {
              type: "string",
              description:
                "Why this column is that field, citing the sample values where they were the deciding evidence.",
            },
          },
          required: ["source_header", "field_id", "confidence", "reason"],
          additionalProperties: false,
        },
      },
      unmappable: {
        type: "array",
        description:
          "Columns that do not correspond to any template field, or that you cannot identify.",
        items: {
          type: "object",
          properties: {
            source_header: { type: "string" },
            reason: { type: "string" },
          },
          required: ["source_header", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["mappings", "unmappable"],
    additionalProperties: false,
  },
};

const SYSTEM = `You map columns from a Ghanaian rural or community bank's customer export onto the GDPC depositor submission template.

You are given only the columns an exact and fuzzy matcher could not resolve, together with sample values from each, and the template fields still unfilled.

Judge by the values as much as the heading. In this domain the values are usually decisive:

- A Ghana Card number looks like GHA-123456789-0, and often arrives without the hyphens.
- A Ghanaian mobile number is nine digits after the country code, beginning 24, 25, 53, 54, 55, 59 (MTN), 20, 50 (Telecel), 26, 27, 56, 57 (AT), 23 (Glo). It is frequently missing its leading zero because Excel stored it as a number.
- A GhanaPostGPS digital address looks like GA-123-4567 — two letters, three digits, four digits.
- A date of birth will be spread across decades; an account opening date clusters in recent years. Both may be Excel serial numbers.
- A balance is a decimal amount, possibly with a currency symbol or in parentheses for a negative.
- A customer id is short and unique per row; an account number is longer and may repeat where a customer holds several accounts.

Rules you must follow:

- Only use field ids from the list supplied. Never invent one.
- Map a column only where you are genuinely confident. An unmapped column costs an operator one decision; a wrongly mapped column corrupts every record in the file and will not be noticed, because the upload will succeed.
- If two columns could both be the same field, map neither and say so in unmappable.
- A column that is a bank's internal working field — a row number, a teller id, a report note — belongs in unmappable, not forced onto a template field.`;

export async function proposeMappings(
  env: Env,
  input: MapperInput,
): Promise<ReturnType<typeof callAgent<MapperOutput>>> {
  const columns = input.unmappedHeaders
    .map(
      (h) =>
        `  "${h.header}"\n     samples: ${h.samples
          .slice(0, 6)
          .map((s) => JSON.stringify(s))
          .join(", ")}`,
    )
    .join("\n");

  const fields = input.unfilledFields
    .map(
      (f) =>
        `  ${f.id}  (template column ${f.header})${f.required ? " [REQUIRED]" : ""}${
          f.description ? ` — ${f.description}` : ""
        }`,
    )
    .join("\n");

  const prompt = `UNMAPPED COLUMNS FROM THE UPLOADED FILE
${columns || "  (none)"}

TEMPLATE FIELDS STILL UNFILLED
${fields || "  (none)"}

Propose the mappings with the propose_mappings tool.`;

  return callAgent<MapperOutput>(env, {
    system: SYSTEM,
    prompt,
    tool: TOOL,
    effort: "medium",
    maxTokens: 6000,
  });
}

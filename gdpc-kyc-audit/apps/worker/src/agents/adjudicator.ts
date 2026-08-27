/**
 * The identity adjudication agent.
 *
 * The rules engine settles the clear cases on its own: an exact match, a known
 * day-name equivalent, a transposed date. What reaches this agent is the
 * residue — a name that is close but unaccounted for, a partial match with an
 * extra token, a conflict where the evidence points both ways. Those are
 * judgement calls, and today a branch officer makes thousands of them by eye.
 *
 * The agent's job is to make that judgement explicit and consistent, and to
 * write down its reasoning. It cannot change data.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env.js";
import { callAgent } from "./client.js";
import { newId } from "../db/repo.js";

export type Recommendation =
  | "same_person_adopt_card"
  | "same_person_keep_bank"
  | "different_person"
  | "insufficient_evidence";

export interface AdjudicationInput {
  code: string;
  message: string;
  bankName: string;
  cardName: string;
  bankDateOfBirth: string | null;
  cardDateOfBirth: string | null;
  bankGender: string | null;
  cardGender: string | null;
  ghanaCardPin: string | null;
  matchScore: number | null;
  alignment: unknown;
}

export interface AdjudicationOutput {
  recommendation: Recommendation;
  confidence: number;
  rationale: string;
  /** The name the agent believes should be submitted, if it recommends one. */
  proposed_surname?: string;
  proposed_first_name?: string;
  proposed_other_names?: string;
  /** What a human should check to settle it, when evidence is insufficient. */
  what_to_check?: string;
}

const TOOL: Anthropic.Tool = {
  name: "record_adjudication",
  description:
    "Record the adjudication of a KYC identity discrepancy between a bank record and a Ghana Card record.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      recommendation: {
        type: "string",
        enum: [
          "same_person_adopt_card",
          "same_person_keep_bank",
          "different_person",
          "insufficient_evidence",
        ],
        description:
          "same_person_adopt_card: the same depositor, and the Ghana Card rendering should be submitted. same_person_keep_bank: the same depositor, but the bank's rendering is the correct one. different_person: the records describe two different people. insufficient_evidence: cannot be decided without more information.",
      },
      confidence: {
        type: "number",
        description: "Confidence in the recommendation, from 0 to 1.",
      },
      rationale: {
        type: "string",
        description:
          "Two or three sentences an auditor can read, citing the specific evidence relied on. Name the Ghanaian naming convention involved where one applies.",
      },
      proposed_surname: { type: "string" },
      proposed_first_name: { type: "string" },
      proposed_other_names: { type: "string" },
      what_to_check: {
        type: "string",
        description:
          "When evidence is insufficient, the specific document or check that would settle it.",
      },
    },
    required: ["recommendation", "confidence", "rationale"],
    additionalProperties: false,
  },
};

const SYSTEM = `You adjudicate identity discrepancies for a Ghanaian deposit-protection KYC audit.

A rural or community bank holds a depositor record. The National Identification Authority holds the Ghana Card record. Where they disagree, you decide whether they describe the same person.

What you must know about Ghanaian names:

- Akan day names have several spoken and written forms that are the same name: Kwadwo/Kojo, Kwabena/Kobina, Kwaku/Kweku, Kwame/Kwamena, Kwasi/Kwesi/Akwasi, Yaw/Ekow, Kofi/Fiifi; and for women Adwoa/Adjoa, Abena/Araba, Akua/Ekua, Yaa/Aba, Afua/Afia/Efua, Ama/Amma, Akosua/Esi.
- Arabic-derived names are transliterated inconsistently: Mohammed/Muhammad/Mahama, Abdul/Abdulai, Ibrahim/Braimah, Issah/Isa, Fuseini/Husseini, Yussif/Yusuf.
- A trailing H is often optional: Mensah/Mensa, Yeboah/Yeboa, Ansah/Ansa.
- Name order is not fixed. Many depositors give the surname first at the bank and last on the card, or the reverse. Order alone is never evidence of a different person.
- Honorifics — Mr, Alhaji, Hajia, Nana, Nii, Rev — are not part of the name.
- A middle name missing from the bank record is a routine capture gap, not a discrepancy in identity.

How to weigh the evidence:

- The Ghana Card is the authority on the legal name. Where the two records describe the same person, the card's rendering is normally the one to submit.
- A matching date of birth is strong corroboration; a matching gender is weak corroboration on its own.
- Two records that share a surname but nothing else are NOT the same person. Ghanaian surnames are common; Mensah alone proves nothing.
- A wholly different given name AND a different date of birth means different people, however similar the surname.
- If the evidence genuinely does not settle it, say insufficient_evidence and name the check that would. Guessing on a KYC record is worse than deferring: an incorrect merge misdirects a depositor's protected balance.

Be decisive where the evidence supports it and honest where it does not. Never invent a fact that is not in the record you are given.`;

export async function adjudicate(
  env: Env,
  input: AdjudicationInput,
): Promise<{ output: AdjudicationOutput | null; failure: string | null; model: string; inputTokens: number; outputTokens: number }> {
  const prompt = `Adjudicate this discrepancy.

Rule that raised it: ${input.code}
What the rule reported: ${input.message}

BANK RECORD
  Name:          ${input.bankName || "(not captured)"}
  Date of birth: ${input.bankDateOfBirth ?? "(not captured)"}
  Gender:        ${input.bankGender ?? "(not captured)"}

GHANA CARD RECORD (National Identification Authority)
  Name:          ${input.cardName || "(not available)"}
  Date of birth: ${input.cardDateOfBirth ?? "(not available)"}
  Gender:        ${input.cardGender ?? "(not available)"}
  Card number:   ${input.ghanaCardPin ?? "(not available)"}

Deterministic matcher output
  Similarity score: ${input.matchScore ?? "n/a"}
  Token alignment:  ${JSON.stringify(input.alignment ?? [])}

Record your adjudication with the record_adjudication tool.`;

  return callAgent<AdjudicationOutput>(env, {
    system: SYSTEM,
    prompt,
    tool: TOOL,
    effort: "medium",
    maxTokens: 4000,
  });
}

/** Persist an agent's recommendation against the finding it assessed. */
export async function saveAdjudication(
  env: Env,
  batchId: string,
  findingId: string,
  input: AdjudicationInput,
  result: Awaited<ReturnType<typeof adjudicate>>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_reviews (
       id, batch_id, finding_id, agent, model, recommendation, confidence,
       rationale, input_json, output_json, input_tokens, output_tokens
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      newId("agr"),
      batchId,
      findingId,
      "identity_adjudicator",
      result.model,
      result.output?.recommendation ?? "unavailable",
      result.output?.confidence ?? null,
      result.output?.rationale ?? result.failure ?? null,
      JSON.stringify(input),
      result.output ? JSON.stringify(result.output) : null,
      result.inputTokens,
      result.outputTokens,
    )
    .run();
}

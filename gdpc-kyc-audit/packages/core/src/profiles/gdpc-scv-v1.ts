/**
 * GDPC depositor-data submission profile.
 *
 * PROVENANCE
 *
 * The column list below is taken from a real GDPC extract produced by a member
 * rural bank from its Temenos T24 core: thirty-five columns on a single flat
 * sheet, headed exactly as reproduced in `header` here. This replaces the
 * earlier four-table Single Customer View guess, which was wrong — GDPC takes
 * one row per account, with the depositor's details repeated on each of their
 * accounts rather than normalised into separate depositor / address / account
 * tables.
 *
 * Field `id` values keep the `depositor.` / `address.` / `account.` namespaces
 * from the previous layout. Those ids are internal: every rule, normaliser and
 * report keys on them, and they stay stable across template revisions. Only
 * `header` is the wire format. When GDPC revises the template, change the
 * `header` strings, `required` flags and `enumValues`, bump `version`, and say
 * in `provenance` which extract the new list came from — nothing else in the
 * engine needs to change.
 *
 * THE COLUMN ORDER IS SIGNIFICANT. The portal reads positionally as well as by
 * heading; `fields` is the submission order.
 */

import type { TemplateProfile } from "../types.js";

export const GDPC_SCV_V1: TemplateProfile = {
  id: "gdpc-scv",
  version: "2.0.0",
  label: "GDPC depositor submission (35-column single sheet)",
  provenance:
    "Column list and value conventions derived from a production GDPC extract " +
    "produced from Temenos T24 by a member rural bank (Kwamanman Kona branch, " +
    "2026). Thirty-five columns, one flat sheet, one row per account. Verify " +
    "against the current GDPC circular before each submission cycle: this is a " +
    "real observed template, not a published specification.",
  tables: [
    {
      id: "A",
      name: "Depositor and Account Records",
      sheetName: "Sheet1",
      keyField: "account.account_number",
      fields: [
        {
          id: "depositor.customer_id",
          header: "Bank Specific Cin",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
          description:
            "The bank's own customer identification number (CIN). Repeats across " +
            "every account the customer holds — it is the link, not a unique key.",
        },
        {
          id: "depositor.customer_type",
          header: "Customer Type",
          kind: "enum",
          required: true,
          enumValues: ["INDIVIDUAL", "JOINT", "SOLE_PROPRIETOR", "CORPORATE", "GROUP", "TRUST"],
          materiality: "high",
          description:
            "I individual, C corporate, J joint, S sole proprietor, G group/susu, T trust.",
        },
        {
          id: "depositor.title",
          header: "Title",
          kind: "text",
          required: false,
          maxLength: 20,
          materiality: "low",
          description: "Mr. / Mrs. / Miss / Dr. — courtesy title, not part of the legal name.",
        },
        {
          id: "depositor.first_name",
          header: "First Name",
          kind: "name",
          required: true,
          maxLength: 60,
          materiality: "critical",
          description:
            "Given name only. Whole names amalgamated here — the single commonest " +
            "defect in these extracts — are split out by the name parser.",
        },
        {
          id: "depositor.other_names",
          header: "Middle Name",
          kind: "name",
          required: false,
          maxLength: 60,
          materiality: "medium",
        },
        {
          id: "depositor.surname",
          header: "Surname",
          kind: "name",
          required: true,
          maxLength: 60,
          materiality: "critical",
          description:
            "Family name only. Frequently duplicates the full string already in " +
            "First Name, or holds it in the opposite order.",
        },
        {
          id: "depositor.previous_name",
          header: "Previous Name",
          kind: "name",
          required: false,
          maxLength: 120,
          materiality: "medium",
          description:
            "Maiden or former name. Where present it is a legitimate reason for a " +
            "bank/NIA surname mismatch, so the matcher consults it before flagging.",
        },
        {
          id: "depositor.company_name",
          header: "Company Name",
          kind: "text",
          required: false,
          maxLength: 160,
          materiality: "high",
          description: "Required when Customer Type is C or S; must be empty for I.",
        },
        {
          id: "depositor.gender",
          header: "Gender",
          kind: "enum",
          required: true,
          enumValues: ["M", "F"],
          materiality: "medium",
        },
        {
          id: "depositor.other_id_type",
          header: "Id Type",
          kind: "enum",
          required: true,
          enumValues: ["GHANA_CARD", "VOTER_ID", "PASSPORT", "DRIVERS_LICENCE", "SSNIT", "NONE"],
          materiality: "critical",
          description:
            "G Ghana Card, V voters ID, P passport, D drivers licence, S SSNIT, " +
            "N none. The Bank of Ghana mandate is standardisation on G: anything " +
            "else is a remediation target, not an acceptable alternative.",
        },
        {
          id: "depositor.ghana_card_pin",
          header: "Id Number",
          kind: "ghana_card",
          required: true,
          maxLength: 20,
          materiality: "critical",
          description:
            "Carries the Ghana Card PIN when Id Type is G. Seen both hyphenated " +
            "(GHA-400200100-7) and bare (GHA4001002003); both normalise to the " +
            "canonical hyphenated form. When Id Type is not G this holds a legacy " +
            "document number and the record is flagged for remediation.",
        },
        {
          id: "depositor.company_number",
          header: "Company Number (If Any)",
          kind: "text",
          required: false,
          maxLength: 40,
          materiality: "medium",
          description: "Registrar-General incorporation or business registration number.",
        },
        {
          id: "depositor.date_of_birth",
          header: "Dob",
          kind: "date",
          required: true,
          materiality: "critical",
          description:
            "Day-first (DD/MM/YYYY) in every extract seen. 01/01/1900 is not a " +
            "birth date — it is the T24 migration default and is flagged as such.",
        },
        {
          id: "address.residential_address",
          header: "Home Address",
          kind: "text",
          required: true,
          maxLength: 200,
          materiality: "low",
          description:
            "Often a GhanaPost digital address (AZ-0000-0001), sometimes a plot " +
            "and block reference, sometimes a landmark or business name.",
        },
        {
          id: "address.postal_address",
          header: "Postal Address",
          kind: "text",
          required: false,
          maxLength: 200,
          materiality: "low",
        },
        {
          id: "address.country",
          header: "Country",
          kind: "text",
          required: true,
          maxLength: 60,
          materiality: "low",
        },
        {
          id: "depositor.email",
          header: "Email",
          kind: "email",
          required: false,
          maxLength: 120,
          materiality: "medium",
        },
        {
          id: "depositor.mobile_number",
          header: "Main Phone Number",
          kind: "msisdn",
          required: true,
          materiality: "critical",
          description:
            "Held as 233-prefixed international digits without a plus (233240000101). " +
            "The primary contact vector for the whole remediation exercise.",
        },
        {
          id: "depositor.alternate_number",
          header: "Mobile Phone Number",
          kind: "msisdn",
          required: false,
          materiality: "high",
        },
        {
          id: "depositor.momo_number",
          header: "Mobile Money Number",
          kind: "msisdn",
          required: false,
          materiality: "high",
          description:
            "Frequently identical to the main number. Worth carrying separately: a " +
            "live mobile money wallet is a payout route where a bank account is not.",
        },
        {
          id: "depositor.pep",
          header: "Politically Exposed Person (Yes/No)",
          kind: "enum",
          required: true,
          enumValues: ["YES", "NO"],
          materiality: "high",
        },
        {
          id: "account.account_type",
          header: "Account Type",
          kind: "enum",
          required: true,
          enumValues: ["SAVINGS", "CURRENT", "FIXED_DEPOSIT", "SUSU", "CALL", "SPECIAL"],
          materiality: "high",
          description: "C current, S savings, F fixed deposit, D susu/daily, L call.",
        },
        {
          id: "account.ownership",
          header: "Account By Ownership",
          kind: "enum",
          required: true,
          enumValues: ["INDIVIDUAL", "CORPORATE", "JOINT"],
          materiality: "high",
          description:
            "I individual, C corporate/commercial, J joint. Distinct from Customer " +
            "Type: an individual customer can hold a corporate-owned account.",
        },
        {
          id: "account.account_number",
          header: "Account Number",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
          description: "Unique within the file. This is the row key.",
        },
        {
          id: "account.product_name",
          header: "Product Name",
          kind: "text",
          required: true,
          maxLength: 120,
          materiality: "medium",
          description:
            "The core's product label. T24 exports leak section banners into this " +
            "column (<<<Current Accounts Start>>>), which are flagged, not mapped.",
        },
        {
          id: "account.status",
          header: "Status Of Account",
          kind: "enum",
          required: true,
          enumValues: ["ACTIVE", "DORMANT", "CLOSED", "BLOCKED", "INACTIVE"],
          materiality: "high",
          description: "A active, D dormant, C closed, B blocked/lien, I inactive.",
        },
        {
          id: "compensation.exclusion_type",
          header: "Exclusion Type",
          kind: "text",
          required: false,
          maxLength: 60,
          materiality: "critical",
          description:
            "Statutory grounds on which the deposit is excluded from protection. " +
            "Empty means covered — so a stray character here silently removes a " +
            "depositor from compensation and is treated as critical.",
        },
        {
          id: "account.branch_code",
          header: "Account Branch",
          kind: "text",
          required: true,
          maxLength: 60,
          materiality: "medium",
        },
        {
          id: "account.joint_share",
          header: "Account Balance (% Share For Joint Accounts)",
          kind: "money",
          required: false,
          materiality: "high",
          description:
            "For joint accounts, this holder's share. Shares across one account " +
            "number must total the account balance, or compensation is miscomputed.",
        },
        {
          id: "account.auth_negative_balance",
          header: "Auth. Negative Balance",
          kind: "money",
          required: false,
          materiality: "medium",
          description: "Authorised overdraft. Reduces the protected amount.",
        },
        {
          id: "account.currency",
          header: "Currency Of Account",
          kind: "enum",
          required: true,
          enumValues: ["GHS", "USD", "GBP", "EUR"],
          materiality: "high",
        },
        {
          id: "account.balance_original",
          header: "Account Balance In Original Currency",
          kind: "money",
          required: true,
          materiality: "critical",
        },
        {
          id: "account.exchange_rate",
          header: "Exchange Rate",
          kind: "money",
          required: true,
          materiality: "high",
          description: "1 for GHS accounts. Must be present and non-zero for any other currency.",
        },
        {
          id: "account.balance",
          header: " Account Balance In Cedis ",
          kind: "money",
          required: true,
          materiality: "critical",
          description:
            "The compensation base. Note the leading and trailing spaces in the " +
            "heading — they are present in the real template and are preserved " +
            "here deliberately; the mapper trims before comparing.",
        },
        {
          id: "account.overdue_loans",
          header: "Overdue Loans",
          kind: "money",
          required: true,
          materiality: "critical",
          description:
            "Set off against the balance before compensation is paid, so an " +
            "understated figure overstates the protected amount.",
        },
      ],
    },
  ],
};

/**
 * Statutory compensation ceilings, in Ghana cedis, per depositor per institution.
 *
 * Confirm against the prevailing Bank of Ghana / GDPC directive before a real
 * submission cycle — these are revised by legislative instrument.
 */
export const COVERAGE_LIMITS = {
  bank: 6_250,
  sdi: 1_250,
} as const;

/**
 * The T24 migration default date.
 *
 * When legacy accounts were migrated into T24, mandatory demographic fields with
 * no historical value were populated with this date to clear the core's own
 * validation. It is therefore a marker of an unverifiable legacy record, not a
 * date of birth, and records carrying it are almost always missing identification
 * and contact details too.
 */
export const T24_MIGRATION_DEFAULT_DOB = "1900-01-01";

/**
 * Section banners that T24 exports leak into data columns.
 *
 * These arrive as ordinary cell values in Product Name and must never be mapped
 * through as product labels.
 */
export const T24_SECTION_BANNER = /^<{2,}.*(?:start|end).*>{2,}$/i;

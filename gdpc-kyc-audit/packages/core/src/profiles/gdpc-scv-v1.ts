/**
 * GDPC Single Customer View submission profile.
 *
 * IMPORTANT — READ BEFORE RELYING ON THIS FILE
 *
 * The Ghana Deposit Protection Corporation does not publish its depositor-data
 * upload template openly; member institutions receive it directly. The layout
 * below follows the four-table Single Customer View structure used by deposit
 * insurers generally (A depositor, B address, C account, D compensation), with
 * field names and types chosen to match what Ghanaian rural and community banks
 * actually hold.
 *
 * It is therefore a STARTING POINT, not an authority. When the official
 * template is to hand, correct the `header` strings, `required` flags and
 * `enumValues` here — nothing else in the engine needs to change, because every
 * other module reads the profile rather than hard-coding columns. Bump
 * `version` and record where the definition came from in `provenance` so an
 * auditor can tell which template a past submission was validated against.
 */

import type { TemplateProfile } from "../types.js";

export const GDPC_SCV_V1: TemplateProfile = {
  id: "gdpc-scv",
  version: "1.0.0-draft",
  label: "GDPC Single Customer View (draft)",
  provenance:
    "Derived from the standard four-table SCV layout used by deposit insurers; NOT yet reconciled against the official GDPC template. Replace before production submission.",
  tables: [
    {
      id: "A",
      name: "Depositor Details",
      sheetName: "A_Depositors",
      keyField: "depositor.customer_id",
      fields: [
        {
          id: "depositor.customer_id",
          header: "CUSTOMER_ID",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
          description: "The bank's own unique customer identifier. Must be unique in the file.",
        },
        {
          id: "depositor.surname",
          header: "SURNAME",
          kind: "name",
          required: true,
          maxLength: 60,
          materiality: "critical",
        },
        {
          id: "depositor.first_name",
          header: "FIRST_NAME",
          kind: "name",
          required: true,
          maxLength: 60,
          materiality: "critical",
        },
        {
          id: "depositor.other_names",
          header: "OTHER_NAMES",
          kind: "name",
          required: false,
          maxLength: 80,
          materiality: "high",
        },
        {
          id: "depositor.ghana_card_pin",
          header: "GHANA_CARD_PIN",
          kind: "ghana_card",
          required: true,
          maxLength: 15,
          materiality: "critical",
          description: "NIA personal number in GHA-000000000-0 form.",
        },
        {
          id: "depositor.other_id_type",
          header: "OTHER_ID_TYPE",
          kind: "enum",
          required: false,
          enumValues: ["PASSPORT", "VOTER_ID", "DRIVERS_LICENCE", "SSNIT", "NHIS", "NONE"],
          materiality: "medium",
        },
        {
          id: "depositor.other_id_number",
          header: "OTHER_ID_NUMBER",
          kind: "other_id",
          required: false,
          maxLength: 40,
          materiality: "medium",
        },
        {
          id: "depositor.date_of_birth",
          header: "DATE_OF_BIRTH",
          kind: "date",
          required: true,
          materiality: "critical",
        },
        {
          id: "depositor.gender",
          header: "GENDER",
          kind: "enum",
          required: true,
          enumValues: ["M", "F"],
          materiality: "high",
        },
        {
          id: "depositor.mobile_number",
          header: "MOBILE_NUMBER",
          kind: "msisdn",
          required: true,
          maxLength: 15,
          materiality: "critical",
          description: "Primary contact number in +233XXXXXXXXX form.",
        },
        {
          id: "depositor.alternate_number",
          header: "ALTERNATE_NUMBER",
          kind: "msisdn",
          required: false,
          maxLength: 15,
          materiality: "low",
        },
        {
          id: "depositor.email",
          header: "EMAIL",
          kind: "email",
          required: false,
          maxLength: 120,
          materiality: "low",
        },
        {
          id: "depositor.customer_type",
          header: "CUSTOMER_TYPE",
          kind: "enum",
          required: true,
          enumValues: ["INDIVIDUAL", "JOINT", "SOLE_PROPRIETOR", "CORPORATE", "GROUP", "TRUST"],
          materiality: "high",
        },
        {
          id: "depositor.tin",
          header: "TIN",
          kind: "other_id",
          required: false,
          maxLength: 20,
          materiality: "low",
        },
      ],
    },
    {
      id: "B",
      name: "Address Details",
      sheetName: "B_Addresses",
      parentKeyField: "depositor.customer_id",
      keyField: "address.customer_id",
      fields: [
        {
          id: "address.customer_id",
          header: "CUSTOMER_ID",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
        },
        {
          id: "address.digital_address",
          header: "GHANA_POST_GPS",
          kind: "text",
          required: false,
          maxLength: 15,
          materiality: "medium",
          description: "GhanaPostGPS digital address, e.g. GA-123-4567.",
        },
        {
          id: "address.residential_address",
          header: "RESIDENTIAL_ADDRESS",
          kind: "text",
          required: true,
          maxLength: 200,
          materiality: "medium",
        },
        {
          id: "address.town",
          header: "TOWN",
          kind: "text",
          required: true,
          maxLength: 60,
          materiality: "low",
        },
        {
          id: "address.district",
          header: "DISTRICT",
          kind: "text",
          required: false,
          maxLength: 60,
          materiality: "low",
        },
        {
          id: "address.region",
          header: "REGION",
          kind: "enum",
          required: true,
          materiality: "low",
          enumValues: [
            "AHAFO", "ASHANTI", "BONO", "BONO EAST", "CENTRAL", "EASTERN",
            "GREATER ACCRA", "NORTH EAST", "NORTHERN", "OTI", "SAVANNAH",
            "UPPER EAST", "UPPER WEST", "VOLTA", "WESTERN", "WESTERN NORTH",
          ],
        },
        {
          id: "address.postal_address",
          header: "POSTAL_ADDRESS",
          kind: "text",
          required: false,
          maxLength: 120,
          materiality: "low",
        },
      ],
    },
    {
      id: "C",
      name: "Account Details",
      sheetName: "C_Accounts",
      parentKeyField: "depositor.customer_id",
      keyField: "account.account_number",
      fields: [
        {
          id: "account.customer_id",
          header: "CUSTOMER_ID",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
        },
        {
          id: "account.account_number",
          header: "ACCOUNT_NUMBER",
          kind: "text",
          required: true,
          maxLength: 30,
          materiality: "critical",
        },
        {
          id: "account.account_type",
          header: "ACCOUNT_TYPE",
          kind: "enum",
          required: true,
          enumValues: ["SAVINGS", "CURRENT", "FIXED_DEPOSIT", "SUSU", "CALL", "SPECIAL"],
          materiality: "high",
        },
        {
          id: "account.currency",
          header: "CURRENCY",
          kind: "enum",
          required: true,
          enumValues: ["GHS", "USD", "GBP", "EUR"],
          materiality: "high",
        },
        {
          id: "account.balance",
          header: "ACCOUNT_BALANCE",
          kind: "money",
          required: true,
          materiality: "critical",
        },
        {
          id: "account.accrued_interest",
          header: "ACCRUED_INTEREST",
          kind: "money",
          required: false,
          materiality: "medium",
        },
        {
          id: "account.branch_code",
          header: "BRANCH_CODE",
          kind: "text",
          required: true,
          maxLength: 20,
          materiality: "medium",
        },
        {
          id: "account.date_opened",
          header: "DATE_OPENED",
          kind: "date",
          required: true,
          materiality: "medium",
        },
        {
          id: "account.status",
          header: "ACCOUNT_STATUS",
          kind: "enum",
          required: true,
          enumValues: ["ACTIVE", "DORMANT", "CLOSED", "BLOCKED", "INACTIVE"],
          materiality: "high",
        },
        {
          id: "account.is_joint",
          header: "JOINT_ACCOUNT",
          kind: "boolean",
          required: false,
          materiality: "high",
        },
        {
          id: "account.lien_amount",
          header: "LIEN_AMOUNT",
          kind: "money",
          required: false,
          materiality: "high",
          description: "Amount encumbered; deducted when computing the insurable balance.",
        },
      ],
    },
    {
      id: "D",
      name: "Compensation Details",
      sheetName: "D_Compensation",
      parentKeyField: "depositor.customer_id",
      keyField: "compensation.customer_id",
      fields: [
        {
          id: "compensation.customer_id",
          header: "CUSTOMER_ID",
          kind: "text",
          required: true,
          maxLength: 40,
          materiality: "critical",
        },
        {
          id: "compensation.total_balance",
          header: "TOTAL_BALANCE",
          kind: "money",
          required: true,
          materiality: "critical",
          description: "Sum of all account balances for this depositor.",
        },
        {
          id: "compensation.total_lien",
          header: "TOTAL_LIEN",
          kind: "money",
          required: false,
          materiality: "high",
        },
        {
          id: "compensation.insured_amount",
          header: "INSURED_AMOUNT",
          kind: "money",
          required: true,
          materiality: "critical",
          description: "Protected amount, capped at the statutory coverage limit.",
        },
        {
          id: "compensation.uninsured_amount",
          header: "UNINSURED_AMOUNT",
          kind: "money",
          required: false,
          materiality: "high",
        },
      ],
    },
  ],
};

/**
 * The statutory coverage limit per depositor per institution, in Ghana cedis.
 * Kept here rather than inline so it is one edit when the Bank of Ghana revises
 * it. Confirm the current figure against the prevailing GDPC directive.
 */
export const COVERAGE_LIMITS = {
  bank: 6_250,
  sdi: 1_250,
} as const;

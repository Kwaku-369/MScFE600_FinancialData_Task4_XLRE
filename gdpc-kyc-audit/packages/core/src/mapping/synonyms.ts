/**
 * Header synonyms observed in rural and community bank exports.
 *
 * Every core banking system in use across Ghana's rural banks names these
 * columns differently, and branch staff routinely re-title them again in Excel
 * before sending the file. Rather than force each bank to rename columns by
 * hand — the step that most often gets skipped, producing the rejected upload —
 * the mapper resolves them automatically and asks a human only about what it
 * cannot resolve confidently.
 *
 * Keys are canonical field ids from the template profile. Values are canonical
 * (upper case, punctuation-stripped) header forms.
 */

export const HEADER_SYNONYMS: Record<string, string[]> = {
  "depositor.customer_id": [
    "CUSTOMER ID", "CUSTOMERID", "CUST ID", "CUSTID", "CUSTOMER NO",
    "CUSTOMER NUMBER", "CUSTOMER CODE", "CLIENT ID", "CLIENT CODE",
    "CIF", "CIF NO", "CIF NUMBER", "CIF ID", "MEMBER ID", "MEMBER NO",
    "DEPOSITOR ID", "UNIQUE ID", "CUSTOMER REF", "REF NO", "SERIAL",
  ],
  "depositor.surname": [
    "SURNAME", "LAST NAME", "LASTNAME", "FAMILY NAME", "SUR NAME",
    "MAIDEN NAME", "SURNAME FAMILY NAME",
  ],
  "depositor.first_name": [
    "FIRST NAME", "FIRSTNAME", "FORENAME", "GIVEN NAME", "FIRST",
    "CHRISTIAN NAME",
  ],
  "depositor.other_names": [
    "OTHER NAMES", "OTHERNAMES", "MIDDLE NAME", "MIDDLENAME", "MIDDLE NAMES",
    "OTHER NAME", "SECOND NAME", "MIDDLE INITIAL",
  ],
  // A single combined-name column is extremely common and is handled specially
  // by the mapper (it fans out into surname / first / other names).
  "depositor.full_name": [
    "FULL NAME", "FULLNAME", "NAME", "CUSTOMER NAME", "ACCOUNT NAME",
    "DEPOSITOR NAME", "NAME OF CUSTOMER", "NAME OF DEPOSITOR", "CLIENT NAME",
    "ACCOUNT TITLE", "TITLE OF ACCOUNT", "MEMBER NAME", "NAMES",
  ],
  "depositor.ghana_card_pin": [
    "GHANA CARD", "GHANA CARD NO", "GHANA CARD NUMBER", "GHANA CARD PIN",
    "GHANACARD", "GHANACARD NO", "GH CARD", "GHC NO", "NIA NUMBER", "NIA NO",
    "NIA PIN", "NATIONAL ID", "NATIONAL ID NO", "NATIONAL IDENTIFICATION",
    "PIN", "PERSONAL ID NUMBER", "PERSONAL NUMBER", "ID NUMBER", "ID NO",
    "IDENTIFICATION NUMBER", "CARD NUMBER", "GHANA CARD ID",
  ],
  "depositor.other_id_type": [
    "ID TYPE", "IDENTIFICATION TYPE", "TYPE OF ID", "OTHER ID TYPE",
    "ID DOCUMENT TYPE", "MEANS OF ID", "MEANS OF IDENTIFICATION",
  ],
  "depositor.other_id_number": [
    "OTHER ID NUMBER", "OTHER ID NO", "ALTERNATE ID", "SECONDARY ID",
    "PASSPORT NO", "VOTER ID", "VOTERS ID", "VOTER ID NO", "DRIVERS LICENCE",
    "DRIVERS LICENSE", "SSNIT NO", "SSNIT NUMBER", "NHIS NO",
  ],
  "depositor.date_of_birth": [
    "DATE OF BIRTH", "DOB", "D O B", "BIRTH DATE", "BIRTHDATE", "BIRTHDAY",
    "DATE BIRTH", "DATE OF BIRTH DDMMYYYY",
  ],
  "depositor.gender": [
    "GENDER", "SEX", "M F", "GENDER M F", "SEX M F",
  ],
  "depositor.mobile_number": [
    "MOBILE NUMBER", "MOBILE NO", "MOBILE", "PHONE", "PHONE NUMBER", "PHONE NO",
    "TELEPHONE", "TELEPHONE NUMBER", "TEL", "TEL NO", "CONTACT",
    "CONTACT NUMBER", "CONTACT NO", "CELL", "CELL NUMBER", "MSISDN",
    "PRIMARY PHONE", "PRIMARY CONTACT", "MOBILE PHONE", "CUSTOMER CONTACT",
    "MOMO NUMBER", "MOBILE MONEY NUMBER",
  ],
  "depositor.alternate_number": [
    "ALTERNATE NUMBER", "ALTERNATIVE NUMBER", "OTHER PHONE", "SECOND PHONE",
    "SECONDARY CONTACT", "OTHER CONTACT", "PHONE 2", "TEL 2",
  ],
  "depositor.email": [
    "EMAIL", "E MAIL", "EMAIL ADDRESS", "E MAIL ADDRESS", "MAIL",
  ],
  "depositor.customer_type": [
    "CUSTOMER TYPE", "CLIENT TYPE", "ACCOUNT CATEGORY", "DEPOSITOR TYPE",
    "TYPE OF CUSTOMER", "CATEGORY",
  ],
  "depositor.tin": ["TIN", "TIN NO", "TAX ID", "TAX IDENTIFICATION NUMBER"],

  "address.digital_address": [
    "GHANA POST GPS", "GHANAPOST GPS", "GPS ADDRESS", "DIGITAL ADDRESS",
    "GHANAPOSTGPS", "GPS", "DIGITAL ADD",
  ],
  "address.residential_address": [
    "RESIDENTIAL ADDRESS", "ADDRESS", "PHYSICAL ADDRESS", "HOME ADDRESS",
    "STREET ADDRESS", "LOCATION", "RESIDENCE", "HOUSE ADDRESS",
  ],
  "address.town": ["TOWN", "CITY", "COMMUNITY", "TOWN CITY", "VILLAGE"],
  "address.district": ["DISTRICT", "MUNICIPAL", "DISTRICT MUNICIPAL", "MMDA"],
  "address.region": ["REGION", "STATE", "PROVINCE"],
  "address.postal_address": [
    "POSTAL ADDRESS", "POSTAL", "PO BOX", "P O BOX", "BOX", "MAILING ADDRESS",
  ],

  "account.account_number": [
    "ACCOUNT NUMBER", "ACCOUNT NO", "ACCT NO", "ACCT NUMBER", "AC NO",
    "A C NO", "ACCOUNT", "ACCNO", "ACCOUNT ID", "DEPOSIT ACCOUNT NUMBER",
  ],
  "account.account_type": [
    "ACCOUNT TYPE", "ACCT TYPE", "TYPE OF ACCOUNT", "PRODUCT",
    "PRODUCT TYPE", "PRODUCT NAME", "SCHEME", "SCHEME TYPE", "DEPOSIT TYPE",
  ],
  "account.currency": ["CURRENCY", "CCY", "CURRENCY CODE"],
  "account.balance": [
    "ACCOUNT BALANCE", "BALANCE", "CURRENT BALANCE", "LEDGER BALANCE",
    "AVAILABLE BALANCE", "CLOSING BALANCE", "DEPOSIT BALANCE", "AMOUNT",
    "BAL", "BOOK BALANCE",
  ],
  "account.accrued_interest": [
    "ACCRUED INTEREST", "INTEREST", "INTEREST ACCRUED", "INT ACCRUED",
    "UNPAID INTEREST",
  ],
  "account.branch_code": [
    "BRANCH CODE", "BRANCH", "BRANCH NAME", "BRANCH ID", "BRANCH NO", "SOL ID",
  ],
  "account.date_opened": [
    "DATE OPENED", "ACCOUNT OPENING DATE", "OPENING DATE", "OPEN DATE",
    "DATE OF OPENING", "ACCT OPEN DATE", "DATE CREATED",
  ],
  "account.status": [
    "ACCOUNT STATUS", "STATUS", "ACCT STATUS", "ACCOUNT STATE",
    "DORMANCY STATUS", "ACTIVE INACTIVE",
  ],
  "account.is_joint": [
    "JOINT ACCOUNT", "IS JOINT", "JOINT", "JOINT Y N", "JOINT HOLDER",
  ],
  "account.lien_amount": [
    "LIEN AMOUNT", "LIEN", "ENCUMBERED AMOUNT", "AMOUNT ON LIEN",
    "HOLD AMOUNT", "BLOCKED AMOUNT", "PLEDGED AMOUNT",
  ],

  "compensation.total_balance": [
    "TOTAL BALANCE", "TOTAL DEPOSIT", "AGGREGATE BALANCE", "SUM OF BALANCES",
  ],
  "compensation.total_lien": ["TOTAL LIEN", "TOTAL ENCUMBRANCE"],
  "compensation.insured_amount": [
    "INSURED AMOUNT", "PROTECTED AMOUNT", "COVERED AMOUNT", "INSURED DEPOSIT",
  ],
  "compensation.uninsured_amount": [
    "UNINSURED AMOUNT", "UNPROTECTED AMOUNT", "EXCESS AMOUNT",
  ],
};

/**
 * A combined-name column has no single target field; the mapper fans it out.
 * Declared here so both the mapper and the UI know which id is virtual.
 */
export const COMBINED_NAME_FIELD = "depositor.full_name";

/** Reverse index: canonical header -> field id. */
export const FIELD_BY_HEADER = new Map<string, string>();
for (const [fieldId, headers] of Object.entries(HEADER_SYNONYMS)) {
  for (const header of headers) {
    // First declaration wins, so more specific fields should be listed first.
    if (!FIELD_BY_HEADER.has(header)) FIELD_BY_HEADER.set(header, fieldId);
  }
}

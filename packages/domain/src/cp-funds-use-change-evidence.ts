/**
 * Research-only evidence-shape check for a CP change to the use of proceeds.
 *
 * The confirmed clause chain for this check is:
 *   short-term financing bond business guide (NA028) 第四条 ->
 *   proceeds-use management procedure (NA004) 第六条 ->
 *   2023 disclosure rules (OF002) 第二十七条.
 * 第二十七条 requires disclosure of the proposed changed use at least five
 * working days before the changed funds are used. Neighbouring 第二十六条
 * governs a change of the credit enhancement institution and must never be
 * borrowed for a proceeds-use change.
 *
 * Clause mis-attribution, missing attribution, prospective wording, same-day
 * dates, date mismatch, future events and missing evidence all stay in review.
 * No calendar-day or working-day conversion is inferred and whether the
 * five-working-day lead time is actually met is not decided here.
 */

export type CpFundsUseChangeCitation = {
  sourceRefId: string;
  materialVersion: string;
  locator: string;
  quote: string;
  /** Confirmed clause the evidence is attributed to, e.g. 第四条/第六条/第二十七条. */
  clauseRef?: string;
};

export type CpFundsUseChangeClauseRole = 'rule_basis' | 'disclosure_requirement';

export type CpFundsUseChangeConfirmedClause = {
  sourceRefId: string;
  clauseNumber: number;
  clauseRef: string;
  role: CpFundsUseChangeClauseRole;
  note: string;
};

/** Confirmed clause chain for a CP proceeds-use change (research state). */
export const cpFundsUseChangeConfirmedClauses: readonly CpFundsUseChangeConfirmedClause[] = [
  {
    sourceRefId: 'nafmii-cp-guide-2021',
    clauseNumber: 4,
    clauseRef: '第四条',
    role: 'rule_basis',
    note: '企业存续期内变更募集资金用途应提前披露。',
  },
  {
    sourceRefId: 'nafmii-funds-use-procedure-2022',
    clauseNumber: 6,
    clauseRef: '第六条',
    role: 'rule_basis',
    note: '募集资金应按发行文件约定使用，变更用途应及时披露拟变更后用途并履行约定程序。',
  },
  {
    sourceRefId: 'nafmii-disclosure-rules-2023',
    clauseNumber: 27,
    clauseRef: '第二十七条',
    role: 'disclosure_requirement',
    note: '变更募集资金用途应至少于募集资金使用前5个工作日披露拟变更后的用途。',
  },
];

/** Neighbouring clauses that must never be borrowed as proceeds-use-change evidence. */
export const cpFundsUseChangeMisattributedClauses = [
  {
    sourceRefId: 'nafmii-disclosure-rules-2023',
    clauseNumber: 26,
    clauseRef: '第二十六条',
    note: '第二十六条是变更增进机构，不适用于募集资金用途变更。',
  },
] as const;

export type CpFundsUseChangeEvidenceValue = {
  value: string;
  citations: CpFundsUseChangeCitation[];
  uncertainty: 'clear' | 'uncertain';
  conflictingAssertions?: Array<{
    value: string;
    citations: CpFundsUseChangeCitation[];
  }>;
};

export type CpFundsUseChangeEvidenceInput = {
  /** Trusted evaluation date supplied by the caller, never read from the quote. */
  checkedOn: string;
  disclosureDate: CpFundsUseChangeEvidenceValue;
  changedUseEffectiveDate: CpFundsUseChangeEvidenceValue;
};

export type CpFundsUseChangeEvidenceDecision =
  | 'evidence_shape_pass'
  | 'disclosure_not_before_change'
  | 'needs_review';

export type CpFundsUseChangeEvidenceResult = {
  decision: CpFundsUseChangeEvidenceDecision;
  reasons: string[];
  evidence: CpFundsUseChangeEvidenceInput;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const QUOTE_DATE_PATTERN = /(?<!\d)(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})(?:日)?(?!\d)/g;
const CLAUSE_PATTERN = /第\s*([零一二两三四五六七八九十百\d]+)\s*条/;
const CHINESE_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= days;
}

/** Converts a small Chinese numeral (1–99) or Arabic digits to an integer. */
function clauseNumberFromToken(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return value > 0 ? value : null;
  }
  let section = 0;
  let current = 0;
  for (const character of token) {
    if (character in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[character]!;
    } else if (character === '十') {
      section += (current === 0 ? 1 : current) * 10;
      current = 0;
    } else {
      return null;
    }
  }
  const value = section + current;
  return value > 0 ? value : null;
}

function parseClauseNumber(clauseRef: string | undefined): number | null {
  if (!clauseRef) return null;
  const match = CLAUSE_PATTERN.exec(clauseRef.trim());
  return match ? clauseNumberFromToken(match[1]!) : null;
}

function confirmedClauseFor(citation: CpFundsUseChangeCitation): CpFundsUseChangeConfirmedClause | null {
  const clauseNumber = parseClauseNumber(citation.clauseRef);
  if (clauseNumber === null) return null;
  return cpFundsUseChangeConfirmedClauses.find(clause =>
    clause.sourceRefId === citation.sourceRefId && clause.clauseNumber === clauseNumber) ?? null;
}

type CpFundsUseChangeClauseAttribution = 'confirmed' | 'cross_clause_misattributed' | 'unconfirmed';

function clauseAttribution(citation: CpFundsUseChangeCitation): CpFundsUseChangeClauseAttribution {
  if (confirmedClauseFor(citation)) return 'confirmed';
  const clauseNumber = parseClauseNumber(citation.clauseRef);
  const misattributed = clauseNumber !== null && cpFundsUseChangeMisattributedClauses.some(clause =>
    clause.sourceRefId === citation.sourceRefId && clause.clauseNumber === clauseNumber);
  return misattributed ? 'cross_clause_misattributed' : 'unconfirmed';
}

function citationIsComplete(citation: CpFundsUseChangeCitation): boolean {
  return citation.sourceRefId.trim().length > 0 &&
    citation.materialVersion.trim().length > 0 &&
    citation.locator.trim().length > 0 &&
    citation.quote.trim().length > 0;
}

function hasEvidence(field: CpFundsUseChangeEvidenceValue): boolean {
  return field.citations.length > 0 && field.citations.every(citationIsComplete);
}

function hasConflict(field: CpFundsUseChangeEvidenceValue): boolean {
  return (field.conflictingAssertions ?? []).some(assertion =>
    assertion.value !== field.value || assertion.citations.length === 0 ||
    assertion.citations.some(citation => !citationIsComplete(citation)),
  );
}

function quoteContainsDate(quote: string, value: string): boolean {
  const target = DATE_PATTERN.exec(value);
  if (!target) return false;
  const [year, month, day] = target.slice(1).map(Number);
  const dateMentions = quote.matchAll(QUOTE_DATE_PATTERN);
  for (const mention of dateMentions) {
    if (Number(mention[1]) === year && Number(mention[2]) === month && Number(mention[3]) === day) return true;
  }
  return false;
}

function quoteDescribesCompletedEvent(quote: string, value: string, event: 'disclosure' | 'use_change'): boolean {
  // This is deliberately a narrow evidence-shape check, not Chinese-language
  // event extraction. A date shared with a board meeting or another event must
  // not be borrowed to prove disclosure or actual use of proceeds.
  const mentions = [...quote.matchAll(QUOTE_DATE_PATTERN)];
  if (mentions.length !== 1 || !quoteContainsDate(mentions[0]![0], value)) return false;
  const match = mentions[0]!;
  const start = Math.max(0, quote.slice(0, match.index).search(/[^，,。；;]*$/));
  const after = quote.slice(match.index + match[0].length).search(/[，,。；;]/);
  const end = after < 0 ? quote.length : match.index + match[0].length + after;
  const clause = quote.slice(start, end).replace(match[0], '<DATE>');
  if (/(?:拟|计划|预计|将于|将要|尚未|未披露|未公告|未发布|未执行|未实施|待披露|待实施|待生效|拟变更|计划变更)/.test(quote)) return false;
  if (event === 'disclosure') {
    return /(?:已|已经)于<DATE>(?:向市场|对外|公开)?(?:披露|公告|发布)(?:了)?(?:募集资金用途变更|变更后募集资金用途)/.test(clause);
  }
  return /(?:变更后的)?募集资金用途自<DATE>起?(?:已开始使用|已使用|已开始实施|已实施|已开始执行|已执行|已生效)/.test(clause);
}

function citationsBindActualEvent(
  field: CpFundsUseChangeEvidenceValue,
  event: 'disclosure' | 'use_change',
): boolean {
  return field.citations.length > 0 && field.citations.every(citation =>
    citationIsComplete(citation) &&
    quoteContainsDate(citation.quote, field.value) &&
    quoteDescribesCompletedEvent(citation.quote, field.value, event),
  );
}

function hasConfirmedClause(
  field: CpFundsUseChangeEvidenceValue,
  role: CpFundsUseChangeClauseRole,
): boolean {
  return field.citations.some(citation =>
    citationIsComplete(citation) && confirmedClauseFor(citation)?.role === role);
}

/**
 * A date strictly earlier than the effective date is consistent with prior
 * disclosure only when each source quote anchors the exact date, describes a
 * completed event and is attributed to a confirmed clause of the CP
 * proceeds-use-change chain. Prospective, future, same-day, clause-mismatched
 * or ambiguous evidence stays in review. No calendar-day or business-day
 * adjustment is inferred.
 */
export function checkCpFundsUseChangeEvidence(
  input: CpFundsUseChangeEvidenceInput,
): CpFundsUseChangeEvidenceResult {
  const reasons: string[] = [];
  const fields = [input.disclosureDate, input.changedUseEffectiveDate];

  if (!isCalendarDate(input.checkedOn)) reasons.push('checked_on_date_invalid');
  if (fields.some(field => !hasEvidence(field))) reasons.push('evidence_missing_or_unlocated');
  if (fields.some(field => field.uncertainty !== 'clear')) reasons.push('evidence_uncertain');
  if (fields.some(hasConflict)) reasons.push('conflicting_source_assertions');
  if (fields.some(field => !isCalendarDate(field.value))) reasons.push('invalid_or_missing_calendar_date');
  if (fields.some(field => field.citations.some(citation => citationIsComplete(citation) && !quoteContainsDate(citation.quote, field.value)))) {
    reasons.push('date_not_bound_to_citation_quote');
  }
  if (!citationsBindActualEvent(input.disclosureDate, 'disclosure')) reasons.push('actual_disclosure_event_not_proven');
  if (!citationsBindActualEvent(input.changedUseEffectiveDate, 'use_change')) reasons.push('actual_use_change_event_not_proven');
  if (isCalendarDate(input.checkedOn) && fields.some(field => isCalendarDate(field.value) && field.value > input.checkedOn)) {
    reasons.push('future_event_date_unresolved');
  }

  const citations = fields.flatMap(field => field.citations).filter(citationIsComplete);
  if (citations.some(citation => clauseAttribution(citation) === 'cross_clause_misattributed')) {
    reasons.push('cross_clause_citation_misattributed');
  }
  if (citations.some(citation => clauseAttribution(citation) === 'unconfirmed')) {
    reasons.push('clause_attribution_unconfirmed');
  }
  if (!hasConfirmedClause(input.disclosureDate, 'disclosure_requirement')) {
    reasons.push('disclosure_change_clause_mapping_missing');
  }
  if (!hasConfirmedClause(input.changedUseEffectiveDate, 'rule_basis')) {
    reasons.push('use_change_clause_mapping_missing');
  }

  if (reasons.length) return { decision: 'needs_review', reasons, evidence: input };

  if (input.disclosureDate.value === input.changedUseEffectiveDate.value) {
    return {
      decision: 'needs_review',
      reasons: ['same_day_ordering_not_established'],
      evidence: input,
    };
  }
  if (input.disclosureDate.value > input.changedUseEffectiveDate.value) {
    return {
      decision: 'disclosure_not_before_change',
      reasons: ['disclosure_date_after_changed_use_effective_date'],
      evidence: input,
    };
  }
  return {
    decision: 'evidence_shape_pass',
    reasons: ['disclosure_date_precedes_changed_use_effective_date'],
    evidence: input,
  };
}

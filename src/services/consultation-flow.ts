/**
 * Consultation flow — when the chat offers the report, and what the question
 * counter says. Kept out of the UI code so the rules are unit-tested.
 */

/** Roughly how many questions the advisor asks before offering the report. */
export const EXPECTED_QUESTIONS = 6;

const MENTIONS_REPORT = /\breport\b/i;
/** A question with one of these words asks the user something, rather than offering the report. */
const ASKS_SOMETHING = /\b(?:how|what|which|when|where|why|who)\b/i;

/**
 * Whether a message the model sent without answer options should get the
 * "generate my report" buttons: only when its last sentence is about the report
 * and asks nothing else. A follow-up, whether a question or an instruction
 * ("Tell me more about…"), deserves a typed answer. The model itself is told to
 * attach the report options when it offers the report.
 */
export function offersReport(message: string): boolean {
  const lastSentence = message.trim().match(/[^.!?]+[.!?]*$/)?.[0] ?? '';
  return MENTIONS_REPORT.test(lastSentence) && !ASKS_SOMETHING.test(lastSentence);
}

/**
 * Whether the user's input asks for the report. A bare "yes" only counts right
 * after the report was offered; otherwise it answers the advisor's question.
 */
export function isReportRequest(input: string, reportOffered: boolean): boolean {
  const text = input.trim().toLowerCase();
  if (text === 'generate_report' || /\bgenerate (?:my )?report\b/.test(text)) return true;
  return reportOffered && /^(?:yes|yeah|yep|sure|ok|okay)\b/.test(text);
}

export function questionCounterText(questionsAsked: number, reportOffered: boolean): string {
  if (reportOffered) return 'Ready for your report';
  return questionsAsked <= EXPECTED_QUESTIONS ? `Question ${questionsAsked} of ~${EXPECTED_QUESTIONS}` : 'Follow-up question';
}

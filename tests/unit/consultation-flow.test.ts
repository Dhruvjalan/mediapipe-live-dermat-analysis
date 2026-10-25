import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isReportRequest, offersReport, questionCounterText } from '../../src/services/consultation-flow';

describe('offersReport', () => {
  test('never puts the report buttons under a follow-up question', () => {
    const followUp =
      "I'm sorry you're feeling that way. How often do you feel overwhelmed, and what usually triggers those feelings?";
    assert.equal(offersReport(followUp), false);
    assert.equal(offersReport('Before I prepare your report, how much water do you drink a day?'), false);
  });

  test('never puts the report buttons under a follow-up written as an instruction', () => {
    assert.equal(offersReport('Tell me a bit more about how often you faint.'), false);
    assert.equal(offersReport('Thanks. Tell me a bit more about your sleep.'), false);
  });

  test('offers the report when the question is about the report', () => {
    assert.equal(offersReport("I've collected your answers. Ready to see your comprehensive health report?"), true);
    assert.equal(offersReport('Would you like me to prepare your report, or is there anything else to add?'), true);
  });

  test('offers the report when the message says it is ready, without asking anything else', () => {
    assert.equal(offersReport('Thank you. Your report is ready whenever you are.'), true);
  });

  test('leaves a wrap-up that never mentions the report to the model, which is told to offer it', () => {
    assert.equal(offersReport('Thank you, that gives me a clear picture.'), false);
  });
});

describe('isReportRequest', () => {
  test('a plain "yes" asks for the report only right after the report was offered', () => {
    assert.equal(isReportRequest('yes', true), true);
    assert.equal(isReportRequest('Yes', false), false);
  });

  test('the report button and a typed request always count', () => {
    assert.equal(isReportRequest('generate_report', false), true);
    assert.equal(isReportRequest('Please generate my report', false), true);
  });
});

describe('questionCounterText', () => {
  test('counts to six, then says follow-up instead of "Question 7 of ~6"', () => {
    assert.equal(questionCounterText(3, false), 'Question 3 of ~6');
    assert.equal(questionCounterText(7, false), 'Follow-up question');
  });

  test('says the report is ready once it has been offered', () => {
    assert.equal(questionCounterText(7, true), 'Ready for your report');
  });
});

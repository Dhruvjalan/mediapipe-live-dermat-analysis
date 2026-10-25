import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessLifestyle,
  detectSafetyFlags,
  emptyProfile,
  overallVerdict,
  parseLifestyleProfile,
  type LifestyleAssessment,
  type LifestyleProfile,
} from '../../src/services/lifestyle-risk';

const flags = (text: string) => detectSafetyFlags(text).map((f) => `${f.id}:${f.severity}`);
const profile = (over: Partial<LifestyleProfile>): LifestyleProfile => ({ ...emptyProfile(), ...over });
const severityOf = (a: LifestyleAssessment, topic: string) => a.risks.find((r) => r.topic === topic)?.severity;

describe('detectSafetyFlags', () => {
  test('flags a plain statement of not eating as critical', () => {
    assert.deepEqual(flags("I don't eat"), ['not_eating:critical']);
    assert.deepEqual(flags('i dont eat at all'), ['not_eating:critical']);
    assert.deepEqual(flags("I haven't eaten in 3 days"), ['not_eating:critical']);
  });

  test('does not flag avoiding a particular food or meal time', () => {
    assert.deepEqual(flags("I don't eat junk food"), []);
    assert.deepEqual(flags("I don't eat after 8pm"), []);
    assert.deepEqual(flags('no food after 9'), []);
  });

  test('treats eating very little as high, not critical', () => {
    assert.deepEqual(flags('I barely eat'), ['eating_very_little:high']);
    assert.deepEqual(flags("I don't eat much these days"), ['eating_very_little:high']);
  });

  test('flags not sleeping as critical and poor sleep as high', () => {
    assert.deepEqual(flags("I don't sleep"), ['no_sleep:critical']);
    assert.deepEqual(flags('I get 2 hours of sleep'), ['no_sleep:critical']);
    assert.deepEqual(flags("I can't sleep most nights"), ['sleep_problem:high']);
    assert.deepEqual(flags("I don't sleep much"), ['sleep_problem:high']);
  });

  test('does not flag healthy sleep statements', () => {
    assert.deepEqual(flags('I sleep 8 hours'), []);
    assert.deepEqual(flags('I never sleep less than 7 hours'), []);
  });

  test('flags fainting and self-harm as critical', () => {
    assert.deepEqual(flags('I fainted twice this week'), ['fainting:critical']);
    assert.deepEqual(flags('sometimes I want to kill myself'), ['self_harm:critical']);
  });

  test('handles curly apostrophes from phone keyboards', () => {
    assert.deepEqual(flags('I don’t eat'), ['not_eating:critical']);
  });

  test('flags barely drinking water as high', () => {
    assert.deepEqual(flags('I hardly drink water'), ['not_drinking:high']);
  });

  test('does not flag answers that deny the problem', () => {
    assert.deepEqual(flags("I've never fainted"), []);
    assert.deepEqual(flags('No fainting or dizziness'), []);
    assert.deepEqual(flags('No suicidal thoughts, I am fine'), []);
    assert.deepEqual(flags("I don't have insomnia"), []);
  });

  test('still flags self-harm when a negation belongs to another part of the sentence', () => {
    assert.deepEqual(flags("I'm not okay and I want to die"), ['self_harm:critical']);
    assert.deepEqual(flags('No one cares and I want to kill myself'), ['self_harm:critical']);
    assert.deepEqual(flags("I don't see the point and want to end it all"), ['self_harm:critical']);
    assert.deepEqual(flags('not sleeping want to die'), ['self_harm:critical']);
    assert.ok(flags("i don't eat i want to die").includes('self_harm:critical'));
  });

  test('still flags fainting when a negation belongs to another part of the sentence', () => {
    assert.deepEqual(flags("I don't know why I fainted yesterday"), ['fainting:critical']);
    assert.deepEqual(flags('I have no energy and I keep fainting'), ['fainting:critical']);
  });

  test('catches other common ways people say they want to die', () => {
    for (const text of [
      'I wish I was dead',
      'I want to end it',
      'Everyone would be better if I killed myself',
      "I don't want to be here anymore",
      "I'd rather be dead",
      'Thinking of ending it',
      'no will to live',
      'I never want to wake up',
      'kms',
      'I want to take my own life',
      'life is not worth living',
      'everyone would be better off without me',
    ]) {
      assert.deepEqual(flags(text), ['self_harm:critical'], text);
    }
  });

  test('does not read distances or everyday phrases with the same words as self-harm', () => {
    for (const text of [
      'I walk 5 kms every morning',
      'I want to end it with my boyfriend',
      "I'd rather die than eat broccoli",
      "I don't want to be here at this hour",
      'I never want to wake up early on weekends',
      'I would rather not wake up at 5am',
    ]) {
      assert.deepEqual(flags(text), [], text);
    }
  });

  test('still accepts a direct denial of these phrasings', () => {
    assert.deepEqual(flags("I've never thought of ending it"), []);
    assert.deepEqual(flags("I don't wish I was dead"), []);
  });

  test('accepts a denial only when the negation governs the statement itself', () => {
    assert.deepEqual(flags("I've never had suicidal thoughts"), []);
    assert.deepEqual(flags('No suicidal thoughts or self-harm'), []);
    assert.deepEqual(flags("I don't want to die"), []);
    assert.deepEqual(flags('I have never passed out'), []);
    assert.deepEqual(flags('No history of fainting'), []);
    assert.deepEqual(flags('No dizziness or fainting'), []);
    assert.deepEqual(flags("I haven't had any fainting episodes"), []);
  });

  test('does not read everyday injuries as self-harm', () => {
    assert.deepEqual(flags('I cut myself shaving'), []);
    assert.deepEqual(flags('I hurt myself at the gym'), []);
    assert.deepEqual(flags('I cut myself on purpose'), ['self_harm:critical']);
  });

  test('does not flag avoiding food at certain times or places', () => {
    assert.deepEqual(flags("I don't eat anything after 8pm"), []);
    assert.deepEqual(flags('I never eat anything fried'), []);
    assert.deepEqual(flags("I don't eat food from outside"), []);
    assert.deepEqual(flags('I stopped eating meat'), []);
  });

  test('does not read a missing sleep routine as no sleep', () => {
    assert.deepEqual(flags('I have no sleep schedule'), []);
  });

  test('catches eating nothing, not having eaten today, and sleep given as a range', () => {
    assert.deepEqual(flags('I eat nothing all day'), ['not_eating:critical']);
    assert.deepEqual(flags("I haven't eaten today"), ['eating_very_little:high']);
    assert.deepEqual(flags('I only sleep 2 to 3 hours a night'), ['no_sleep:critical']);
    assert.deepEqual(flags('I sleep 5 or 6 hours'), ['sleep_problem:high']);
  });

  test('keeps signs of disordered eating separate from how much someone eats', () => {
    assert.deepEqual(flags("I don't eat, and when I do I make myself throw up"), [
      'not_eating:critical',
      'disordered_eating:critical',
    ]);
  });

  test('does not read "nothing but" or a minimum amount of sleep as a problem', () => {
    assert.deepEqual(flags('I eat nothing but vegetables'), []);
    assert.deepEqual(flags('I never sleep less than 5 hours'), []);
  });

  test('catches other common ways of saying it', () => {
    assert.deepEqual(flags("I don't eat or sleep"), ['not_eating:critical', 'no_sleep:critical']);
    assert.deepEqual(flags("I'm not sleeping"), ['no_sleep:critical']);
    assert.deepEqual(flags('Not eating at all'), ['not_eating:critical']);
    assert.deepEqual(flags('I stopped eating'), ['not_eating:critical']);
  });
});

describe('assessLifestyle', () => {
  test('rates sleep by hours: under 4 critical, under 6 high, under 7 moderate, otherwise fine', () => {
    assert.equal(severityOf(assessLifestyle(profile({ sleepHours: 3 })), 'sleep'), 'critical');
    assert.equal(severityOf(assessLifestyle(profile({ sleepHours: 5 })), 'sleep'), 'high');
    assert.equal(severityOf(assessLifestyle(profile({ sleepHours: 6.5 })), 'sleep'), 'moderate');
    assert.equal(severityOf(assessLifestyle(profile({ sleepHours: 7.5 })), 'sleep'), undefined);
  });

  test('rates not eating as critical, one meal a day as high, and regular meals as fine', () => {
    assert.equal(severityOf(assessLifestyle(profile({ eatingPattern: 'not_eating' })), 'eating'), 'critical');
    assert.equal(severityOf(assessLifestyle(profile({ mealsPerDay: 0 })), 'eating'), 'critical');
    assert.equal(severityOf(assessLifestyle(profile({ mealsPerDay: 1 })), 'eating'), 'high');
    assert.equal(severityOf(assessLifestyle(profile({ eatingPattern: 'regular', mealsPerDay: 3 })), 'eating'), undefined);
  });

  test('rates multi-day fasting as high and asks for a doctor, but not intermittent fasting', () => {
    const extended = assessLifestyle(profile({ eatingPattern: 'extended_fasting' }));
    assert.equal(severityOf(extended, 'eating'), 'high');
    assert.equal(extended.risks[0].seeDoctor, true);
    assert.equal(severityOf(assessLifestyle(profile({ eatingPattern: 'intermittent_fasting' })), 'eating'), undefined);
  });

  test('rates water under 1 litre as high and under 1.5 litres as moderate', () => {
    assert.equal(severityOf(assessLifestyle(profile({ waterLiters: 0.5 })), 'water'), 'high');
    assert.equal(severityOf(assessLifestyle(profile({ waterLiters: 1.2 })), 'water'), 'moderate');
    assert.equal(severityOf(assessLifestyle(profile({ waterLiters: 2.5 })), 'water'), undefined);
  });

  test('keeps a keyword safety flag when the extracted answers say nothing on that topic', () => {
    const a = assessLifestyle(profile({ waterLiters: 2 }), detectSafetyFlags("I don't sleep"));
    assert.deepEqual(
      a.risks.filter((r) => r.topic === 'sleep').map((r) => r.severity),
      ['critical']
    );
  });

  test('lets a concrete extracted figure, which has the context, replace a keyword flag on the same topic', () => {
    // e.g. "I don't eat." answering "Do you eat breakfast?", then "just lunch and dinner" when asked
    const a = assessLifestyle(profile({ eatingPattern: 'skips_meals', mealsPerDay: 2 }), detectSafetyFlags("I don't eat."));
    assert.deepEqual(
      a.risks.filter((r) => r.topic === 'eating').map((r) => r.severity),
      ['moderate']
    );
  });

  test('does not let a vague extracted category soften a statement like "I don\'t eat"', () => {
    const a = assessLifestyle(profile({ eatingPattern: 'irregular' }), detectSafetyFlags("I don't eat"));
    assert.equal(severityOf(a, 'eating'), 'critical');
  });

  test('never lets the extraction clear a self-harm or fainting statement', () => {
    const a = assessLifestyle(profile({ sleepHours: 8 }), detectSafetyFlags('I fainted twice this week'));
    assert.equal(severityOf(a, 'fainting'), 'critical');
  });

  test('never lets a meal count cancel signs of disordered eating', () => {
    const purging = assessLifestyle(
      profile({ mealsPerDay: 3, eatingPattern: 'regular' }),
      detectSafetyFlags('I eat 3 meals a day but I make myself throw up after meals')
    );
    assert.equal(severityOf(purging, 'disordered_eating'), 'critical');
    assert.equal(purging.level, 'critical');
    const starving = assessLifestyle(profile({ mealsPerDay: 1 }), detectSafetyFlags("I've been starving myself"));
    assert.equal(severityOf(starving, 'disordered_eating'), 'critical');
    assert.equal(starving.risks[0].seeDoctor, true);
  });

  test('orders risks from most to least severe', () => {
    const a = assessLifestyle(profile({ waterLiters: 1.2, sleepHours: 5, eatingPattern: 'not_eating' }));
    assert.deepEqual(
      a.risks.map((r) => r.severity),
      ['critical', 'high', 'moderate']
    );
  });

  test('sets the overall level to the worst risk, or low when there is none', () => {
    assert.equal(assessLifestyle(profile({ sleepHours: 3, waterLiters: 1.2 })).level, 'critical');
    assert.equal(assessLifestyle(profile({ waterLiters: 1.2 })).level, 'moderate');
    assert.equal(assessLifestyle(profile({ sleepHours: 8, waterLiters: 2 })).level, 'low');
  });

  test('tells critical risks to see a doctor', () => {
    const a = assessLifestyle(profile({ sleepHours: 2 }));
    assert.equal(a.risks[0].seeDoctor, true);
    assert.equal(assessLifestyle(profile({ waterLiters: 1.2 })).risks[0].seeDoctor, false);
  });
});

describe('parseLifestyleProfile', () => {
  test('keeps well-formed values', () => {
    const p = parseLifestyleProfile({ sleepHours: 6, waterLiters: 2, eatingPattern: 'regular', stress: 'high', smoking: false });
    assert.equal(p.sleepHours, 6);
    assert.equal(p.waterLiters, 2);
    assert.equal(p.eatingPattern, 'regular');
    assert.equal(p.stress, 'high');
    assert.equal(p.smoking, false);
  });

  test('turns unknown, malformed or impossible values into null', () => {
    const p = parseLifestyleProfile({
      sleepHours: 30,
      waterLiters: -1,
      mealsPerDay: 'lots',
      eatingPattern: 'snacky',
      smoking: 'sometimes',
    });
    assert.equal(p.sleepHours, null);
    assert.equal(p.waterLiters, null);
    assert.equal(p.mealsPerDay, null);
    assert.equal(p.eatingPattern, null);
    assert.equal(p.smoking, null);
  });

  test('accepts numbers sent as strings and enum values in any case', () => {
    const p = parseLifestyleProfile({ sleepHours: '3', stress: 'SEVERE' });
    assert.equal(p.sleepHours, 3);
    assert.equal(p.stress, 'severe');
  });

  test('reads answers the model wrapped in an extra object', () => {
    assert.equal(parseLifestyleProfile({ answers: { sleepHours: 3 } }).sleepHours, 3);
  });

  test('returns an empty profile for anything that is not an object', () => {
    assert.deepEqual(parseLifestyleProfile(null), emptyProfile());
    assert.deepEqual(parseLifestyleProfile('sleep 3h'), emptyProfile());
  });
});

describe('overallVerdict', () => {
  test('a critical lifestyle risk means see a doctor, even with great skin', () => {
    assert.equal(overallVerdict(95, 'critical').level, 'urgent');
  });

  test('a high lifestyle risk or a skin score under 60 needs attention', () => {
    assert.equal(overallVerdict(95, 'high').level, 'attention');
    assert.equal(overallVerdict(59, 'low').level, 'attention');
  });

  test('a moderate lifestyle risk or a skin score from 60 to 79 is fair', () => {
    assert.equal(overallVerdict(90, 'moderate').level, 'fair');
    assert.equal(overallVerdict(79, 'low').level, 'fair');
    assert.equal(overallVerdict(60, 'low').level, 'fair');
  });

  test('a skin score of 80 or more with low lifestyle risk is good', () => {
    assert.equal(overallVerdict(80, 'low').level, 'good');
  });

  test('is never good when the answers or the skin score are missing', () => {
    assert.equal(overallVerdict(95, 'low', { incomplete: true }).level, 'fair');
    assert.equal(overallVerdict(Number.NaN, 'low').level, 'fair');
  });
});

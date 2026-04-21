import { detectFeature } from './featureDetector';

const keywordMap = {
  auth:        ['login', 'logout', 'password', 'sign in'],
  doctors:     ['doctor', 'physician', 'review'],
  patients:    ['patient', 'medical record'],
  departments: ['department', 'ward'],
};

// ─── Label priority ───────────────────────────────────────────────────────────

describe('detectFeature — label priority', () => {
  it('returns the feature from a feature:* label regardless of body keywords', () => {
    expect(detectFeature('login password sign in', ['feature:doctors'], '', keywordMap)).toBe('doctors');
  });

  it('extracts the value after the colon', () => {
    expect(detectFeature('', ['feature:patients'], '', keywordMap)).toBe('patients');
  });

  it('uses the first feature:* label when multiple labels are present', () => {
    expect(detectFeature('', ['status:in-progress', 'feature:departments', 'feature:auth'], '', keywordMap)).toBe('departments');
  });

  it('ignores non-feature labels and falls through to keyword scoring', () => {
    expect(detectFeature('patient admitted', ['status:in-progress'], '', keywordMap)).toBe('patients');
  });
});

// ─── Title multiplier ─────────────────────────────────────────────────────────

describe('detectFeature — title 3x multiplier', () => {
  it('title keyword beats more body keywords from a different feature', () => {
    // body: 'login password' (auth: 2pts), title: 'doctor' (doctors: 3pts) → doctors wins
    expect(detectFeature('login password', [], 'doctor visit', keywordMap)).toBe('doctors');
  });

  it('title with 1 keyword (3pts) beats body with 2 keywords (2pts)', () => {
    expect(detectFeature('patient medical record', [], 'doctor appointment', keywordMap)).toBe('doctors');
  });

  it('body keywords still win when title has no matches', () => {
    expect(detectFeature('patient admitted to ward', [], 'task 42', keywordMap)).toBe('patients');
  });
});

// ─── Keyword scoring ──────────────────────────────────────────────────────────

describe('detectFeature — keyword scoring', () => {
  it('returns "general" when nothing matches', () => {
    expect(detectFeature('some unrelated content', [], '', keywordMap)).toBe('general');
  });

  it('returns "general" when keywordMap is empty', () => {
    expect(detectFeature('login doctor patient', [], 'doctor', {})).toBe('general');
  });

  it('picks the feature with the highest score', () => {
    // auth: login + logout + password = 3pts; doctors: doctor = 1pt → auth wins
    expect(detectFeature('login logout password doctor', [], '', keywordMap)).toBe('auth');
  });

  it('is case-insensitive for body text', () => {
    expect(detectFeature('PATIENT was ADMITTED', [], '', keywordMap)).toBe('patients');
  });

  it('is case-insensitive for title text', () => {
    expect(detectFeature('', [], 'DOCTOR REVIEW', keywordMap)).toBe('doctors');
  });

  it('uses keywordMap provided by caller — no hardcoded domain knowledge', () => {
    const ecommerceMap = {
      checkout: ['cart', 'checkout', 'payment'],
      search:   ['search', 'filter'],
    };
    expect(detectFeature('add to cart and checkout', [], '', ecommerceMap)).toBe('checkout');
  });
});

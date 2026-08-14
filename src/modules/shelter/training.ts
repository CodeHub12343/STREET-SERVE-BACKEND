/**
 * B-5 — the resident starter curriculum.
 *
 * This is a gate, but it is not a hurdle. Handing someone consigned goods without telling them the
 * return window, what a cash sale costs them, and what they do owe is how a well-meaning program
 * creates its first debt spiral. Every question below maps to a rule the platform will otherwise
 * enforce silently, at the resident's expense.
 *
 * Authored in code rather than seeded to the database on purpose: this content is a compliance
 * artefact (it is what we can prove we told someone before they took on an obligation), so it
 * belongs in version control with a version string, reviewed like any other code.
 *
 * Phase D's Academy will serve richer courses from the same `training_completions` table. The shape
 * here is deliberately generic — modules, questions, a version — so nothing needs re-modelling.
 */
export const RESIDENT_STARTER_COURSE_VERSION = 'v1';

export interface TrainingQuestion {
  id: string;
  prompt: string;
  options: string[];
  /** Index into `options`. Never serialised to the client. */
  answerIndex: number;
  /** Shown after answering, right or wrong — the teaching moment is the explanation. */
  explanation: string;
}

export interface TrainingModule {
  slug: string;
  title: string;
  /** Short, plain-language body. Written for reading on a small borrowed screen. */
  body: string[];
  questions: TrainingQuestion[];
}

export const RESIDENT_STARTER_MODULES: TrainingModule[] = [
  {
    slug: 'how-consignment-works',
    title: 'How this works',
    body: [
      'You take products from a hub without paying for them. You sell what you can, bring back what you don’t, and you keep a share of everything you sell.',
      'You never buy the stock. It stays the hub’s property until it sells — that’s what makes it possible to start with nothing.',
      'Your share is agreed before you take anything, and it’s shown on screen every time. If you don’t like the terms, you don’t have to take the item.',
    ],
    questions: [
      {
        id: 'q1',
        prompt: 'Do you have to pay for stock before you can sell it?',
        options: [
          'Yes, you buy it upfront',
          'No — you take it on consignment and pay nothing',
          'Only if it costs more than $20',
        ],
        answerIndex: 1,
        explanation:
          'You pay nothing upfront. That is the whole point — you can start with no money at all.',
      },
    ],
  },
  {
    slug: 'returning-stock',
    title: 'Bringing stock back',
    body: [
      'Every item has a return date. Bring back anything unsold before that date and you owe nothing on it.',
      'If you return late, or items come back damaged or missing, that value can be charged to you.',
      'If something goes wrong — you got sick, your stuff was taken, you couldn’t get to the hub — tell the hub or your shelter staff before the date. Problems raised early are almost always sorted out. Problems raised late are not.',
    ],
    questions: [
      {
        id: 'q1',
        prompt: 'You have 4 items left and the return date is tomorrow. What should you do?',
        options: [
          'Keep them and try again next week',
          'Return them before the date — you’ll owe nothing',
          'Throw them away',
        ],
        answerIndex: 1,
        explanation:
          'Returning unsold stock on time costs you nothing. Holding onto it past the date is what creates a charge.',
      },
      {
        id: 'q2',
        prompt: 'Something has gone wrong and you can’t make the return date. What’s best?',
        options: [
          'Say nothing and hope it’s missed',
          'Tell the hub or your shelter staff before the date',
          'Wait until you’re charged, then explain',
        ],
        answerIndex: 1,
        explanation:
          'Telling someone before the deadline nearly always gets it extended. Nobody is trying to catch you out.',
      },
    ],
  },
  {
    slug: 'cash-and-card',
    title: 'Getting paid, and what you owe',
    body: [
      'If a customer pays by card in the app, the money is split automatically. Your share is yours; the hub’s share goes to the hub. You owe nothing afterwards.',
      'If a customer pays you in CASH, you are holding all of the money — including the hub’s share. That part is recorded as owed, and it comes out of your next card sale automatically.',
      'Card sales are simpler and cost you less. Take card whenever the customer can.',
    ],
    questions: [
      {
        id: 'q1',
        prompt: 'A customer hands you $20 in cash for an item. What’s true?',
        options: [
          'All $20 is yours to keep',
          'Part of it is the hub’s share, and it’s recorded as owed',
          'You must hand the cash to the hub immediately',
        ],
        answerIndex: 1,
        explanation:
          'You keep the cash in your hand, but the hub’s share is recorded and comes out of your next card sale. It is not a debt collector — it just nets off.',
      },
      {
        id: 'q2',
        prompt: 'Which is better for you?',
        options: ['Cash every time', 'Card in the app', 'No difference'],
        answerIndex: 1,
        explanation:
          'Card costs a lower fee, pays you automatically, and leaves you owing nothing afterwards.',
      },
    ],
  },
  {
    slug: 'getting-your-money',
    title: 'Where your money goes',
    body: [
      'If you don’t have a bank account, your earnings are sent to your shelter and held for you. The app shows you exactly how much is waiting and where to collect it.',
      'That money is yours. The shelter is holding it, not keeping it. Every cent is tracked, and you can confirm in the app when you’ve received it.',
      'When you’re ready, you can add your own bank account any time and get paid directly instead.',
    ],
    questions: [
      {
        id: 'q1',
        prompt: 'Your shelter is holding $40 of your earnings. Whose money is it?',
        options: ['The shelter’s', 'Yours — they’re holding it for you', 'The platform’s'],
        answerIndex: 1,
        explanation:
          'It is your money. Custody is tracked cent by cent, and you can confirm receipt in the app.',
      },
    ],
  },
];

/** Total questions across the course — the denominator for scoring. */
export const RESIDENT_STARTER_QUESTION_COUNT = RESIDENT_STARTER_MODULES.reduce(
  (n, m) => n + m.questions.length,
  0,
);

/** The course as the CLIENT sees it: no answer keys. */
export function publicCourse() {
  return {
    slug: 'resident-starter',
    version: RESIDENT_STARTER_COURSE_VERSION,
    title: 'Before you start selling',
    questionCount: RESIDENT_STARTER_QUESTION_COUNT,
    modules: RESIDENT_STARTER_MODULES.map((m) => ({
      slug: m.slug,
      title: m.title,
      body: m.body,
      questions: m.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })),
    })),
  };
}

/**
 * Grade a submission. Returns the score plus per-question correctness AND the explanation for every
 * question — including the ones they got right, because the explanation is the actual teaching and
 * withholding it from someone who guessed correctly helps nobody.
 */
export function gradeCourse(
  answers: Array<{ moduleSlug: string; questionId: string; answerIndex: number }>,
): {
  scorePercent: number;
  correctCount: number;
  totalCount: number;
  results: Array<{ moduleSlug: string; questionId: string; correct: boolean; explanation: string }>;
} {
  const byKey = new Map<string, { q: TrainingQuestion; moduleSlug: string }>();
  for (const m of RESIDENT_STARTER_MODULES) {
    for (const q of m.questions) byKey.set(`${m.slug}:${q.id}`, { q, moduleSlug: m.slug });
  }

  const results: Array<{
    moduleSlug: string;
    questionId: string;
    correct: boolean;
    explanation: string;
  }> = [];
  const seen = new Set<string>();

  for (const a of answers) {
    const key = `${a.moduleSlug}:${a.questionId}`;
    const entry = byKey.get(key);
    if (!entry || seen.has(key)) continue; // unknown or duplicate answers are ignored, never counted twice
    seen.add(key);
    results.push({
      moduleSlug: a.moduleSlug,
      questionId: a.questionId,
      correct: a.answerIndex === entry.q.answerIndex,
      explanation: entry.q.explanation,
    });
  }

  const correctCount = results.filter((r) => r.correct).length;
  const totalCount = RESIDENT_STARTER_QUESTION_COUNT;
  // Unanswered questions count as wrong — the denominator is the whole course, not what was
  // attempted, or skipping the hard half would be a passing strategy.
  const scorePercent = totalCount === 0 ? 100 : Math.round((correctCount / totalCount) * 100);
  return { scorePercent, correctCount, totalCount, results };
}

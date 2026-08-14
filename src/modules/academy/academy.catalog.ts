import {
  RESIDENT_STARTER_COURSE_VERSION,
  RESIDENT_STARTER_MODULES,
  type TrainingModule,
} from '../shelter/training';

/**
 * ═══ D-3 — THE ACADEMY CATALOG ═══
 *
 * B-5 authored one course (the resident starter curriculum) directly in code, against a deliberately
 * generic `training_completions` table. This is that decision paying off: the Academy is the same
 * table with a catalog in front of it, and the resident course becomes course #1 rather than a
 * special case that needed migrating.
 *
 * Courses stay in version control rather than the database for the same reason B-5's did: a course
 * is a compliance artefact — it is what we can prove we told someone before they took on an
 * obligation or were granted a capability — so it belongs somewhere reviewed, diffable and
 * versioned. Authoring tooling can come later and write to this shape.
 *
 * `version` matters: a materially changed curriculum bumps it, and completions of the old version
 * stop satisfying gates. That is why every completion row stores the version it passed.
 */
export interface Course {
  slug: string;
  version: string;
  title: string;
  /** One line, shown on the catalog card. */
  summary: string;
  /** Minutes, honestly estimated — an under-promise here costs trust. */
  estimatedMinutes: number;
  passMark: number;
  modules: TrainingModule[];
  /**
   * D-4: a course that awards a CERTIFICATION rather than just a badge. The distinction is real:
   * a badge says "did this", a certification is something the platform will gate access on (D-5),
   * so it carries a name a hub owner can recognise on a seller's profile.
   */
  certification: { key: string; label: string } | null;
  /** Course slugs that must be passed first. Kept shallow — deep trees strand people. */
  prerequisites: string[];
  /**
   * F-5 — paid certification. `null` means free, which every course in the starter catalog is and
   * the required ones always will be.
   *
   * The rule this encodes: **a course may only be paid if it is optional**. Charging for
   * `resident-starter` would put a paywall between a homeless resident and the ability to earn,
   * which is the precise opposite of what the programme exists for. Charging for
   * `inventory-handling` would paywall access to premium stock a seller could otherwise reach by
   * learning. So the paid tier is advanced material that unlocks nothing gated — it sells
   * credibility, not access.
   */
  priceCents: number | null;
  /**
   * Marks the course as required for a specific programme rather than optional self-improvement.
   * Purely presentational; the actual gate lives in the code that cares (B-5's checkout guard).
   */
  requiredFor: string | null;
}

/** Pass mark for optional courses. Comprehension, not an exam — same posture as B-5. */
const DEFAULT_PASS_MARK = 70;

/**
 * Course 1 — the resident starter curriculum, authored in B-5 and imported wholesale. Not copied:
 * the shelter module still owns the content it is legally responsible for, and the Academy simply
 * lists it.
 */
const RESIDENT_STARTER: Course = {
  slug: 'resident-starter',
  version: RESIDENT_STARTER_COURSE_VERSION,
  title: 'Before you start selling',
  summary: 'How consignment works, returns, cash vs card, and where your money goes.',
  estimatedMinutes: 6,
  passMark: DEFAULT_PASS_MARK,
  modules: RESIDENT_STARTER_MODULES,
  certification: null,
  prerequisites: [],
  priceCents: null,
  requiredFor: 'Shelter partner programme',
};

/**
 * Course 2 — selling skills. The brief's "AI Seller Academy" leads with sales coaching; this is the
 * human version of it, and it exists because the coaching module (FR-9.3) can only help someone
 * mid-conversation. This is what you read before the conversation.
 */
const SELLING_BASICS: Course = {
  slug: 'selling-basics',
  version: 'v1',
  title: 'Selling on the street',
  summary: 'Opening lines, handling a no, and reading a pitch that isn’t working.',
  estimatedMinutes: 8,
  passMark: DEFAULT_PASS_MARK,
  certification: null,
  prerequisites: [],
  priceCents: null,
  requiredFor: null,
  modules: [
    {
      slug: 'opening',
      title: 'Starting the conversation',
      body: [
        'Most sales are lost before a word is said. Stand beside your stock rather than behind it, keep your hands visible, and look at people rather than your phone.',
        'Open with something they can answer in one word. “Have you seen these?” beats “Would you like to buy something?” — the second asks for a decision before they know what’s on offer.',
        'If someone slows down, that is interest. Say one more thing, then stop talking and let them look.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'Someone slows down and glances at your items. What’s the best move?',
          options: [
            'Launch into the full pitch immediately',
            'Say one short thing, then let them look',
            'Wait silently until they speak first',
          ],
          answerIndex: 1,
          explanation:
            'Slowing down is interest. One line gives them a reason to stop; talking over their looking is what makes people walk on.',
        },
      ],
    },
    {
      slug: 'objections',
      title: 'When they say no',
      body: [
        '“Too expensive” usually means “I don’t see why it costs that.” Answer the second thing: what it’s made of, who made it, how long it lasts.',
        '“I don’t have cash” is solvable — take card in the app. It’s also cheaper for you, and you owe nothing afterwards.',
        'A real no is fine. Thank them and move on quickly. Your energy is your inventory, and spending ten minutes on a no costs you the next three yeses.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'A customer says “that’s too expensive”. What are they usually telling you?',
          options: [
            'They can’t afford it at any price',
            'They don’t yet see why it costs that',
            'They want you to halve the price',
          ],
          answerIndex: 1,
          explanation:
            'Price objections are usually value questions. Explain what it is before you touch the price.',
        },
        {
          id: 'q2',
          prompt: 'Someone gives you a firm no. What’s the best use of the next minute?',
          options: [
            'Keep trying — most people say no twice',
            'Thank them and move to the next person',
            'Offer a large discount',
          ],
          answerIndex: 1,
          explanation:
            'Your time is the scarce thing. Move on politely; the next person hasn’t said no yet.',
        },
      ],
    },
  ],
};

/**
 * Course 3 — handling other people's property, and the one course that awards a CERTIFICATION.
 *
 * This exists because D-5 needs something real to gate on. A hub owner deciding whether to hand
 * over $300 of fragile stock to someone they've never met has, until now, had only a Trust Score —
 * which measures whether past consignments went well, not whether this person knows how to pack a
 * box. The certification says they were told.
 */
const INVENTORY_HANDLING: Course = {
  slug: 'inventory-handling',
  version: 'v1',
  title: 'Handling stock properly',
  summary: 'Checking in, transporting, and returning goods that aren’t yours — certified.',
  estimatedMinutes: 10,
  passMark: 80, // Higher bar: this one unlocks access to other people's property.
  certification: { key: 'certified-handler', label: 'Certified Handler' },
  prerequisites: [],
  // Free forever: this one unlocks gated stock (D-5), and paywalling access to earning is the
  // thing this catalog must never do.
  priceCents: null,
  requiredFor: null,
  modules: [
    {
      slug: 'checkout',
      title: 'Taking stock out',
      body: [
        'Count everything in front of the hub staff before you leave, and photograph it. The photo is your protection as much as theirs — it is what proves the state something was in when you took it.',
        'If an item is already damaged, say so at the counter. Damage reported at pickup is the hub’s problem; the same damage reported at return is yours.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'You notice a chipped item while checking out. What should you do?',
          options: [
            'Take it and mention it when you return',
            'Point it out at the counter before you leave',
            'Leave it behind without saying anything',
          ],
          answerIndex: 1,
          explanation:
            'Damage raised at pickup belongs to the hub. The same damage raised at return looks like yours.',
        },
      ],
    },
    {
      slug: 'transport',
      title: 'Carrying it safely',
      body: [
        'Heavy at the bottom, fragile at the top, nothing loose. A single broken item can cost more than a day’s earnings.',
        'Never leave stock unattended, and never in view inside a vehicle. Lost and stolen goods are charged at their full value.',
        'Rain ruins paper, card, and fabric faster than people expect. If you have no cover, take less.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'You’re caught out with rain coming and no cover. What’s the right call?',
          options: [
            'Carry on and hope it passes',
            'Take less next time and get the stock under cover now',
            'Leave the stock in a doorway and come back',
          ],
          answerIndex: 1,
          explanation:
            'Water damage is charged at value, and unattended stock is charged as lost. Protecting it is cheaper than either.',
        },
        {
          id: 'q2',
          prompt: 'Who pays for stock that goes missing while it’s out with you?',
          options: ['The hub', 'The platform', 'You, at its full value'],
          answerIndex: 2,
          explanation:
            'Lost stock is charged to the person holding it. That’s why unattended is never worth it.',
        },
      ],
    },
    {
      slug: 'returning',
      title: 'Bringing it back',
      body: [
        'Return before the date on your checkout. Unsold stock returned on time costs you nothing at all.',
        'Sort it before you arrive — sold, unsold, damaged. A clean return takes two minutes; an unsorted one takes twenty and irritates the person who decides whether to give you stock next time.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'What does returning unsold stock on time cost you?',
          options: ['A small restocking fee', 'Nothing', 'Your deposit'],
          answerIndex: 1,
          explanation:
            'Nothing. That is the whole promise of consignment — you only ever pay out of what you sold.',
        },
      ],
    },
  ],
};

/**
 * Course 4 — F-5's paid certification.
 *
 * Deliberately ADVANCED and deliberately optional. It gates nothing: a seller who never buys it can
 * still take every product in the catalog, reach every Trust band and earn every free badge. What
 * it sells is a credential a hub owner recognises, and the material behind it.
 *
 * That constraint is what makes charging defensible. The moment a paid course unlocks access, the
 * platform is selling the right to earn to people whose defining characteristic is having no money.
 */
const PRO_SELLER: Course = {
  slug: 'pro-seller',
  version: 'v1',
  title: 'Running it like a business',
  summary: 'Pricing for margin, reading your own numbers, and planning a week of stock.',
  estimatedMinutes: 25,
  passMark: 80,
  certification: { key: 'pro-seller', label: 'Pro Seller' },
  prerequisites: ['selling-basics'],
  requiredFor: null,
  priceCents: 1900,
  modules: [
    {
      slug: 'margin',
      title: 'Pricing for margin, not for sales',
      body: [
        'Selling more at a thin margin can earn you less than selling half as much at a fair one. What matters is what you keep per hour worked, not how many items left your hands.',
        'Work backwards: decide what an hour of your time is worth, then check whether an item clears it at the split you were offered. If it does not, that item is not worth carrying however well it sells.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'You sell 20 items at  profit, or 6 at . Which was the better day?',
          options: ['The 20 items', 'The 6 items', 'They are the same'],
          answerIndex: 1,
          explanation:
            '0 beats 0, for less carrying, fewer conversations and less stock at risk. Volume is not the goal — what you keep is.',
        },
      ],
    },
    {
      slug: 'numbers',
      title: 'Reading your own numbers',
      body: [
        'Your sell-through — how much of what you took actually sold — is the number that tells you whether to take that product again. Anything under about a third is stock you are carrying for nothing.',
        'Track which places and times work for you, not which ones work in general. Your pitch, your hours and your stock are yours.',
      ],
      questions: [
        {
          id: 'q1',
          prompt: 'You took 20 items and sold 4. What does that tell you?',
          options: [
            'Sell harder next time',
            'This product or place is not working for you — change one of them',
            'Nothing, four sales is four sales',
          ],
          answerIndex: 1,
          explanation:
            'A 20% sell-through means most of what you carried earned nothing. Change the product or the place before you change your effort.',
        },
      ],
    },
  ],
};

export const COURSES: Course[] = [RESIDENT_STARTER, SELLING_BASICS, INVENTORY_HANDLING, PRO_SELLER];

export function findCourse(slug: string): Course | undefined {
  return COURSES.find((c) => c.slug === slug);
}

/** Every certification the catalog can award — the vocabulary D-5's product gate validates against. */
export function certificationKeys(): string[] {
  return COURSES.filter((c) => c.certification).map((c) => c.certification!.key);
}

export function courseForCertification(key: string): Course | undefined {
  return COURSES.find((c) => c.certification?.key === key);
}

/** The catalog as the CLIENT sees it: no answer keys, no explanations. */
export function publicCourseSummary(c: Course) {
  return {
    slug: c.slug,
    version: c.version,
    title: c.title,
    summary: c.summary,
    estimatedMinutes: c.estimatedMinutes,
    passMark: c.passMark,
    moduleCount: c.modules.length,
    questionCount: c.modules.reduce((n, m) => n + m.questions.length, 0),
    certification: c.certification,
    prerequisites: c.prerequisites,
    requiredFor: c.requiredFor,
    priceCents: c.priceCents,
  };
}

export function publicCourseDetail(c: Course) {
  return {
    ...publicCourseSummary(c),
    modules: c.modules.map((m) => ({
      slug: m.slug,
      title: m.title,
      body: m.body,
      questions: m.questions.map((q) => ({ id: q.id, prompt: q.prompt, options: q.options })),
    })),
  };
}

/**
 * Grade a submission against any course. Lifted from B-5's `gradeCourse` and generalised — the
 * scoring rules are identical, including that unanswered questions count as wrong (otherwise
 * skipping the hard half is a passing strategy) and that every question returns its explanation
 * whether or not it was answered correctly.
 */
export function gradeSubmission(
  course: Course,
  answers: Array<{ moduleSlug: string; questionId: string; answerIndex: number }>,
) {
  const byKey = new Map<string, { moduleSlug: string; answerIndex: number; explanation: string }>();
  for (const m of course.modules) {
    for (const q of m.questions) {
      byKey.set(`${m.slug}:${q.id}`, {
        moduleSlug: m.slug,
        answerIndex: q.answerIndex,
        explanation: q.explanation,
      });
    }
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
    if (!entry || seen.has(key)) continue; // unknown or duplicate answers never count twice
    seen.add(key);
    results.push({
      moduleSlug: a.moduleSlug,
      questionId: a.questionId,
      correct: a.answerIndex === entry.answerIndex,
      explanation: entry.explanation,
    });
  }

  const totalCount = byKey.size;
  const correctCount = results.filter((r) => r.correct).length;
  const scorePercent = totalCount === 0 ? 100 : Math.round((correctCount / totalCount) * 100);
  return { scorePercent, correctCount, totalCount, results };
}

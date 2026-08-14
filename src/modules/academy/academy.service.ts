import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { TrainingCompletionModel } from '../shelter/shelter.model';
import { CoursePurchaseModel } from './academy.model';
import {
  COURSES,
  findCourse,
  gradeSubmission,
  publicCourseDetail,
  publicCourseSummary,
  type Course,
} from './academy.catalog';

/** A passing completion of the CURRENT version of a course. Old versions no longer satisfy gates. */
async function passedCurrent(userId: string, course: Course) {
  return TrainingCompletionModel.findOne({
    user_id: userId,
    course_slug: course.slug,
    course_version: course.version,
    passed: true,
  })
    .sort({ completed_at: -1 })
    .lean()
    .exec();
}

/**
 * ═══ D-3/D-4 — THE ACADEMY ═══
 *
 * Free training, badges and certifications, on the same `training_completions` table B-5 introduced.
 * That table was deliberately named generically rather than `shelter_training`, which is why this
 * phase is additive instead of a migration.
 *
 * The posture from B-5 carries over wholesale: failing costs nothing, retakes are immediate and
 * unlimited, and every question returns its explanation whether or not you got it right. The goal is
 * comprehension, not assessment — the only reason a pass mark exists at all is that D-5 gates real
 * access on one of these courses.
 */
export const academyService = {
  /** The catalog with the caller's own progress folded in. One read, not one per course. */
  async listCourses(userId: string) {
    const completions = await TrainingCompletionModel.find({ user_id: userId }).lean().exec();

    /** Best passing score per (slug, version) — a retake can only improve what's shown. */
    const bestByKey = new Map<string, { score: number; at: Date }>();
    for (const c of completions) {
      if (!c.passed) continue;
      const key = `${c.course_slug}@${c.course_version}`;
      const cur = bestByKey.get(key);
      if (!cur || c.score_percent > cur.score) {
        bestByKey.set(key, { score: c.score_percent, at: c.completed_at });
      }
    }
    const attemptedSlugs = new Set(completions.map((c) => c.course_slug));

    const passedSlugs = new Set(
      COURSES.filter((c) => bestByKey.has(`${c.slug}@${c.version}`)).map((c) => c.slug),
    );

    return COURSES.map((c) => {
      const best = bestByKey.get(`${c.slug}@${c.version}`);
      const missingPrereqs = c.prerequisites.filter((p) => !passedSlugs.has(p));
      /**
       * A course passed at an OLD version reads as "needs retaking" rather than "not started" —
       * someone who did the work deserves to be told the content changed, not silently reset.
       */
      const outdated = !best && attemptedSlugs.has(c.slug);
      return {
        ...publicCourseSummary(c),
        passed: Boolean(best),
        scorePercent: best?.score ?? null,
        completedAt: best?.at ?? null,
        needsRetake: outdated,
        locked: missingPrereqs.length > 0,
        missingPrerequisites: missingPrereqs,
      };
    });
  },

  /** One course, ready to take. Never includes answer keys. */
  async getCourse(userId: string, slug: string) {
    const course = findCourse(slug);
    if (!course) throw NotFoundError('Course not found');

    const missing: string[] = [];
    for (const p of course.prerequisites) {
      const pre = findCourse(p);
      if (pre && !(await passedCurrent(userId, pre))) missing.push(p);
    }

    const best = await passedCurrent(userId, course);
    return {
      ...publicCourseDetail(course),
      passed: Boolean(best),
      scorePercent: best?.score_percent ?? null,
      locked: missing.length > 0,
      missingPrerequisites: missing,
    };
  },

  /**
   * Submit a course. Records the attempt either way — a failure is data about where the material is
   * unclear, and hiding it would waste the one signal that tells us to rewrite a module.
   */
  async submit(
    principal: Principal,
    slug: string,
    answers: Array<{ moduleSlug: string; questionId: string; answerIndex: number }>,
  ) {
    const course = findCourse(slug);
    if (!course) throw NotFoundError('Course not found');

    // Prerequisites are enforced server-side, not just hidden in the UI.
    for (const p of course.prerequisites) {
      const pre = findCourse(p);
      if (pre && !(await passedCurrent(principal.userId, pre))) {
        throw BusinessRuleError(
          ERROR_CODES.BUSINESS_RULE,
          `Finish “${pre.title}” first — it covers what this one builds on.`,
        );
      }
    }

    /**
     * F-5 — a paid course must be bought before it can be submitted.
     *
     * Enforced on SUBMIT rather than on read, deliberately: the course material stays readable to
     * anyone. Someone who can't afford $19 can still learn everything in it — they just don't get
     * the credential. Paywalling the teaching would be indefensible in a product whose whole
     * premise is that people start with nothing.
     */
    if (course.priceCents !== null) {
      const purchased = await CoursePurchaseModel.findOne({
        user_id: principal.userId,
        course_slug: course.slug,
      })
        .lean()
        .exec();
      if (!purchased) {
        throw BusinessRuleError(
          ERROR_CODES.PAYMENT_REQUIRED,
          `“${course.title}” needs to be purchased before you can take the assessment. The material stays free to read.`,
        );
      }
    }

    const graded = gradeSubmission(course, answers);
    const passed = graded.scorePercent >= course.passMark;

    await TrainingCompletionModel.create({
      user_id: principal.userId,
      course_slug: course.slug,
      course_version: course.version,
      score_percent: graded.scorePercent,
      passed,
    });

    if (passed) {
      await publish('training.completed', {
        userId: principal.userId,
        courseSlug: course.slug,
        scorePercent: graded.scorePercent,
      });
      if (course.certification) {
        // A certification gates real access (D-5), so its issuance is audited like a grant.
        await writeAudit({
          actorId: principal.userId,
          action: 'certification.issued',
          entityType: 'user',
          entityId: principal.userId,
          metadata: {
            certification: course.certification.key,
            courseSlug: course.slug,
            courseVersion: course.version,
            scorePercent: graded.scorePercent,
          },
        });
        await publish('certification.issued', {
          userId: principal.userId,
          certification: course.certification.key,
          courseSlug: course.slug,
        });
      }
    }

    return {
      courseSlug: course.slug,
      passed,
      scorePercent: graded.scorePercent,
      correctCount: graded.correctCount,
      totalCount: graded.totalCount,
      passMark: course.passMark,
      certificationAwarded: passed ? (course.certification ?? null) : null,
      results: graded.results,
    };
  },

  /**
   * F-5 — buy a paid course.
   *
   * Idempotent on (user, course): a retake never costs again, because charging someone twice to
   * demonstrate they learned something the second time would be indefensible.
   */
  async purchase(principal: Principal, slug: string, paymentRef?: string) {
    const course = findCourse(slug);
    if (!course) throw NotFoundError('Course not found');
    if (course.priceCents === null) {
      throw BusinessRuleError(ERROR_CODES.BUSINESS_RULE, 'That course is free — nothing to buy.');
    }

    const existing = await CoursePurchaseModel.findOne({
      user_id: principal.userId,
      course_slug: slug,
    })
      .lean()
      .exec();
    if (existing) {
      return { courseSlug: slug, purchased: true, priceCents: course.priceCents, alreadyOwned: true };
    }

    await CoursePurchaseModel.create({
      user_id: principal.userId,
      course_slug: slug,
      price_cents: course.priceCents,
      payment_ref: paymentRef ?? null,
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'course.purchased',
      entityType: 'course',
      entityId: slug,
      metadata: { priceCents: course.priceCents },
    });
    return { courseSlug: slug, purchased: true, priceCents: course.priceCents, alreadyOwned: false };
  },

  /**
   * D-4 — what someone has earned.
   *
   * Badges and certifications are DERIVED from completions rather than stored as their own rows.
   * A second table would be a copy of the truth that can drift from it, and every question worth
   * asking ("do they hold X?", "when?") is answerable from the completions directly.
   */
  async credentials(userId: string) {
    const completions = await TrainingCompletionModel.find({ user_id: userId, passed: true })
      .sort({ completed_at: -1 })
      .lean()
      .exec();

    const badges: Array<{ courseSlug: string; title: string; earnedAt: Date; scorePercent: number }> = [];
    const certifications: Array<{
      key: string;
      label: string;
      courseSlug: string;
      earnedAt: Date;
      /** False when the course has since been revised — the holder needs a retake to keep it. */
      current: boolean;
    }> = [];

    const seenCourses = new Set<string>();
    for (const c of completions) {
      const course = findCourse(c.course_slug);
      if (!course || seenCourses.has(c.course_slug)) continue;
      seenCourses.add(c.course_slug);

      badges.push({
        courseSlug: course.slug,
        title: course.title,
        earnedAt: c.completed_at,
        scorePercent: c.score_percent,
      });
      if (course.certification) {
        certifications.push({
          key: course.certification.key,
          label: course.certification.label,
          courseSlug: course.slug,
          earnedAt: c.completed_at,
          current: c.course_version === course.version,
        });
      }
    }

    return {
      badges,
      certifications,
      /** Only current certifications count for gating — see `heldCertifications`. */
      coursesCompleted: badges.length,
    };
  },

  /**
   * D-5's gate input: the certification keys this user currently holds. Only completions of the
   * CURRENT course version count — a certification earned against materially different content is
   * not evidence that someone was told today's rules.
   */
  async heldCertifications(userId: string): Promise<Set<string>> {
    const rows = await TrainingCompletionModel.find({ user_id: userId, passed: true })
      .lean()
      .exec();
    const held = new Set<string>();
    for (const r of rows) {
      const course = findCourse(r.course_slug);
      if (course?.certification && course.version === r.course_version) {
        held.add(course.certification.key);
      }
    }
    return held;
  },
};

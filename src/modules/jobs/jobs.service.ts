import {
  DEFAULT_JOB_TYPE,
  JOB_CHECKIN_RADIUS_M,
  JOB_NO_SHOW_GRACE_MIN,
  JOB_TYPE_LABELS,
  JOBS_DEFAULT_RADIUS_M,
  JOBS_MAX_RADIUS_M,
  type JobType,
} from '../../config/constants';
import { randomUUID } from 'node:crypto';

import { publish } from '../../events/bus';
import { writeAudit } from '../../shared/audit';
import { distanceMeters } from '../../shared/geo';
import { ERROR_CODES } from '../../shared/errors/codes';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import { notificationsService } from '../notifications/notifications.service';
import { paymentsService } from '../payments/payments.service';
import { vendorsService } from '../vendors/vendors.service';
import { BusinessModel } from '../vendors/vendors.model';
import { UserModel } from '../identity/identity.model';
import { JobApplicationModel, JobPostingModel } from './jobs.model';
import { currentJobQrToken, verifyJobQrToken } from './jobQr';

function isPlatformPoster(principal: Principal): boolean {
  return principal.roles.includes('admin');
}

/** Platform-posted gigs have no business behind them; the worker still needs a name to trust. */
const PLATFORM_EMPLOYER = 'StreetServe';

/** The statuses that still need something from the worker — used to order the "My gigs" feed. */
const ACTIVE_APPLICATION_STATUSES = ['applied', 'accepted', 'checked_in'];

interface JobPostingLike {
  _id: unknown;
  poster_business_id?: string | null;
  poster_user_id?: string;
  title: string;
  description?: string | null;
  pay_cents: number;
  pay_unit: string;
  job_type?: string | null;
  status: string;
  starts_at?: Date | null;
  duration_hrs?: number | null;
  cancelled_reason?: string | null;
  location?: { coordinates?: number[] } | null;
}

interface JobApplicationLike {
  _id: unknown;
  job_id: string;
  applicant_id: string;
  status: string;
  checked_in_at?: Date | null;
  checked_out_at?: Date | null;
  payout_ref?: string | null;
  payout_cents?: number;
  cancelled_reason?: string | null;
}

export const jobsService = {
  /** Post a gig. A business owner posts for their business; an admin posts a platform gig. */
  async post(
    principal: Principal,
    dto: {
      title: string;
      description?: string;
      lng: number;
      lat: number;
      payCents: number;
      payUnit?: 'flat' | 'hourly';
      jobType?: JobType;
      startsAt?: string;
      durationHrs?: number;
      businessId?: string;
    },
  ) {
    let posterBusinessId: string | null = null;
    if (dto.businessId) {
      const owner = await vendorsService.getBusinessOwner(dto.businessId);
      if (owner !== principal.userId) {
        throw ForbiddenError('You do not own this business', ERROR_CODES.NOT_OWNER);
      }
      posterBusinessId = dto.businessId;
    } else if (!isPlatformPoster(principal)) {
      throw ForbiddenError(
        'Only a business owner or platform admin can post a job',
        ERROR_CODES.ROLE_REQUIRED,
      );
    }

    const job = await JobPostingModel.create({
      poster_business_id: posterBusinessId,
      poster_user_id: principal.userId,
      title: dto.title,
      description: dto.description ?? null,
      location: { type: 'Point', coordinates: [dto.lng, dto.lat] },
      pay_cents: dto.payCents,
      pay_unit: dto.payUnit ?? 'flat',
      job_type: dto.jobType ?? DEFAULT_JOB_TYPE,
      starts_at: dto.startsAt ? new Date(dto.startsAt) : null,
      duration_hrs: dto.durationHrs ?? null,
      // Every gig gets a signing key so the QR fallback is available without a second setup step.
      checkin_qr_secret: randomUUID(),
    });
    await publish('job.posted', { jobId: String(job._id), posterBusinessId });
    const [employer] = await this.employerNames([posterBusinessId]);
    return this.view(job, employer);
  },

  /** Ranked nearby feed — pay-per-time + proximity (advisory ranking, explainable). */
  async nearby(input: {
    lng: number;
    lat: number;
    radiusM?: number;
    limit?: number;
    jobTypes?: JobType[];
  }) {
    const radius = Math.min(input.radiusM ?? JOBS_DEFAULT_RADIUS_M, JOBS_MAX_RADIUS_M);
    const jobs = await JobPostingModel.find({
      status: 'open',
      /**
       * A-5: postings written before `job_type` existed carry no field at all until the backfill
       * migration runs, and a schema default only applies to NEW documents. Adding `null` to the
       * `$in` list also matches missing fields, so during that deploy window a worker filtering for
       * the default type still sees the old gigs instead of losing them to a migration they can't
       * see. Filters that exclude the default type exclude the un-typed rows too, which is correct —
       * an untyped posting is a selling gig, not a delivery one.
       */
      ...(input.jobTypes?.length
        ? {
            job_type: input.jobTypes.includes(DEFAULT_JOB_TYPE)
              ? { $in: [...input.jobTypes, null] }
              : { $in: input.jobTypes },
          }
        : {}),
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: [input.lng, input.lat] },
          $maxDistance: radius,
        },
      },
    })
      .limit(input.limit ?? 50)
      .lean()
      .exec();
    if (jobs.length === 0) return [];

    const employers = await this.employerNameMap(jobs);
    const maxPay = Math.max(1, ...jobs.map((j) => j.pay_cents));
    return jobs
      .map((j) => {
        const coords = (j.location?.coordinates ?? [0, 0]) as [number, number];
        const dist = distanceMeters([input.lng, input.lat], coords);
        const payNorm = j.pay_cents / maxPay;
        const proxNorm = Math.max(0, 1 - dist / radius);
        const score = 0.6 * payNorm + 0.4 * proxNorm;
        return {
          ...this.view(j, employers.get(j.poster_business_id ?? '') ?? PLATFORM_EMPLOYER),
          distanceM: Math.round(dist),
          score,
          reasonSummary: `Ranked for pay (${j.pay_cents}¢) and being ~${Math.round(dist)}m away.`,
          application: null,
        };
      })
      .sort((a, b) => b.score - a.score);
  },

  /**
   * The worker's own gigs, newest first with the still-actionable ones on top. Without this the
   * lifecycle is unreachable: `apply` flips the posting to `filled`, which drops it out of
   * `/nearby`, so a claimed gig would have no surface left to check in or out from.
   */
  async mine(principal: Principal, viewer?: { lng: number; lat: number }) {
    const apps = await JobApplicationModel.find({ applicant_id: principal.userId })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    if (apps.length === 0) return [];

    const jobs = await JobPostingModel.find({ _id: { $in: apps.map((a) => a.job_id) } })
      .lean()
      .exec();
    const byId = new Map(jobs.map((j) => [String(j._id), j]));
    const employers = await this.employerNameMap(jobs);

    return apps
      .map((app) => {
        const job = byId.get(app.job_id);
        if (!job) return null;
        const coords = (job.location?.coordinates ?? [0, 0]) as [number, number];
        return {
          ...this.view(job, employers.get(job.poster_business_id ?? '') ?? PLATFORM_EMPLOYER),
          distanceM: viewer ? Math.round(distanceMeters([viewer.lng, viewer.lat], coords)) : null,
          application: this.applicationView(app),
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => {
        const aActive = ACTIVE_APPLICATION_STATUSES.includes(a.application.status) ? 0 : 1;
        const bActive = ACTIVE_APPLICATION_STATUSES.includes(b.application.status) ? 0 : 1;
        return aActive - bActive;
      });
  },

  /**
   * One gig, with the viewer's own application attached when they have one. Needed so a deep link
   * (or a hard refresh) of the detail screen resolves without a warm list cache.
   */
  async getById(principal: Principal, jobId: string, viewer?: { lng: number; lat: number }) {
    const job = await JobPostingModel.findById(jobId).lean().exec();
    if (!job) throw NotFoundError('Job not found');

    const app = await JobApplicationModel.findOne({
      job_id: jobId,
      applicant_id: principal.userId,
    })
      .lean()
      .exec();

    // A filled gig is only visible to the worker holding it and the poster — otherwise the feed
    // would leak other people's claimed work.
    const isPoster = job.poster_user_id === principal.userId || isPlatformPoster(principal);
    if (job.status === 'filled' && !app && !isPoster) throw NotFoundError('Job not found');

    const [employer] = await this.employerNames([job.poster_business_id ?? null]);
    const coords = (job.location?.coordinates ?? [0, 0]) as [number, number];
    return {
      ...this.view(job, employer),
      distanceM: viewer ? Math.round(distanceMeters([viewer.lng, viewer.lat], coords)) : null,
      application: app ? this.applicationView(app) : null,
      isPoster,
    };
  },

  /**
   * Claim a gig (self-serve apply/accept, pilot). Atomically fills the open posting so two workers
   * can't both claim it.
   */
  async apply(principal: Principal, jobId: string) {
    const filled = await JobPostingModel.findOneAndUpdate(
      { _id: jobId, status: 'open' },
      { $set: { status: 'filled', filled_by: principal.userId } },
      { new: true },
    ).exec();
    if (!filled) {
      const exists = await JobPostingModel.exists({ _id: jobId });
      if (!exists) throw NotFoundError('Job not found');
      throw ConflictError(ERROR_CODES.JOB_UNAVAILABLE, 'This job is no longer available');
    }
    const application = await JobApplicationModel.create({
      job_id: jobId,
      applicant_id: principal.userId,
      status: 'accepted',
    });
    await publish('job.claimed', { jobId, applicantId: principal.userId });
    if (filled.poster_user_id) {
      notificationsService.notify(filled.poster_user_id, {
        category: 'job',
        title: 'Job claimed',
        body: `${filled.title} was claimed`,
        data: { jobId },
      });
    }
    return { applicationId: String(application._id), jobId, status: application.status };
  },

  /** On-site tap check-in, proximity-validated against the posting's location. */
  /**
   * Check in with EITHER proof of presence: standing inside the geofence, or scanning the code the
   * employer is showing on site. Geofence-only stranded workers wherever GPS is unreliable —
   * indoors, loading bays, under market awnings — which is a lot of this work.
   */
  async checkIn(
    principal: Principal,
    jobId: string,
    proof: { lng?: number; lat?: number; qrToken?: string },
  ) {
    const job = await JobPostingModel.findById(jobId).exec();
    if (!job) throw NotFoundError('Job not found');
    if (job.status === 'cancelled') {
      throw BusinessRuleError(ERROR_CODES.JOB_UNAVAILABLE, 'This gig was cancelled');
    }

    const scanned =
      proof.qrToken && job.checkin_qr_secret
        ? verifyJobQrToken(job.checkin_qr_secret, jobId, proof.qrToken)
        : false;

    if (!scanned) {
      if (proof.qrToken) {
        // They tried the code and it didn't hold — say so rather than falling through to a
        // location error that describes a different problem.
        throw BusinessRuleError(
          ERROR_CODES.NOT_ON_SITE,
          'That code has expired — ask for the current one',
        );
      }
      if (proof.lng === undefined || proof.lat === undefined) {
        throw BusinessRuleError(
          ERROR_CODES.NOT_ON_SITE,
          'Share your location or scan the on-site code to check in',
        );
      }
      const jobCoords = (job.location?.coordinates ?? [0, 0]) as [number, number];
      const d = distanceMeters([proof.lng, proof.lat], jobCoords);
      if (d > JOB_CHECKIN_RADIUS_M) {
        throw BusinessRuleError(ERROR_CODES.NOT_ON_SITE, 'You must be on-site to check in');
      }
    }

    const app = await JobApplicationModel.findOneAndUpdate(
      { job_id: jobId, applicant_id: principal.userId, status: 'accepted' },
      { $set: { status: 'checked_in', checked_in_at: new Date() } },
      { new: true },
    ).exec();
    if (!app)
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'No accepted application to check in',
      );
    if (job.poster_user_id) {
      notificationsService.notify(job.poster_user_id, {
        category: 'job',
        title: 'Worker checked in',
        body: `Your worker checked in for ${job.title}`,
        data: { jobId },
      });
    }
    return this.applicationView(app.toObject() as JobApplicationLike);
  },

  /** Check out → complete → same-day payout to the worker's connected account. */
  async checkOut(principal: Principal, jobId: string) {
    const job = await JobPostingModel.findById(jobId).exec();
    if (!job) throw NotFoundError('Job not found');
    const app = await JobApplicationModel.findOne({
      job_id: jobId,
      applicant_id: principal.userId,
      status: 'checked_in',
    }).exec();
    if (!app) throw ConflictError(ERROR_CODES.INVALID_STATE_TRANSITION, 'Not checked in');

    const now = new Date();
    let payoutCents = job.pay_cents;
    if (job.pay_unit === 'hourly' && app.checked_in_at) {
      const worked = Math.ceil((now.getTime() - app.checked_in_at.getTime()) / (60 * 60 * 1000));
      // Bill at least an hour, and never more than the posted duration — otherwise a worker who
      // forgets to check out bills the employer for the rest of the day.
      const cap = job.duration_hrs ? Math.ceil(job.duration_hrs) : worked;
      payoutCents = job.pay_cents * Math.min(Math.max(1, worked), Math.max(1, cap));
    }

    const payout = await paymentsService.payoutTransfer({
      ownerType: 'user',
      ownerId: principal.userId,
      amountCents: payoutCents,
      transferGroup: `job_${jobId}`,
      idempotencyKey: `job_payout_${String(app._id)}`,
      // B-3: gig pay is often a resident's FIRST money on the platform — the same-day payout promise
      // is empty if it strands on a missing bank account.
      custodySource: { type: 'job_payout', refId: String(app._id) },
    });

    const updated = await JobApplicationModel.findOneAndUpdate(
      { _id: app._id },
      {
        $set: {
          status: 'completed',
          checked_out_at: now,
          payout_ref: payout?.transferId ?? null,
          payout_cents: payoutCents,
        },
      },
      { new: true },
    ).exec();
    await JobPostingModel.updateOne({ _id: jobId }, { $set: { status: 'completed' } }).exec();

    await writeAudit({
      actorId: principal.userId,
      action: 'job.completed',
      entityType: 'job',
      entityId: jobId,
      metadata: { payoutCents, payoutRef: payout?.transferId ?? null },
    });
    await publish('job.completed', { jobId, applicantId: principal.userId, payoutCents });
    if (job.poster_user_id) {
      notificationsService.notify(job.poster_user_id, {
        category: 'job',
        title: 'Job completed',
        body: `${job.title} was completed`,
        data: { jobId },
      });
    }
    return {
      ...this.applicationView((updated?.toObject() ?? app.toObject()) as JobApplicationLike),
      // `paid: false` means the work is recorded but the worker has no connected payout account
      // yet — the UI has to say so rather than implying money is on its way.
      paid: Boolean(payout),
    };
  },

  /**
   * The poster pulls a gig. Flow 9's failure state: if someone already claimed it they're told
   * immediately rather than turning up to a job that no longer exists.
   */
  async cancel(principal: Principal, jobId: string, reason?: string) {
    const job = await JobPostingModel.findById(jobId).exec();
    if (!job) throw NotFoundError('Job not found');
    if (job.poster_user_id !== principal.userId && !isPlatformPoster(principal)) {
      throw ForbiddenError('You did not post this job', ERROR_CODES.NOT_OWNER);
    }
    if (job.status === 'completed') {
      throw BusinessRuleError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'A completed job cannot be cancelled',
      );
    }
    // Work already underway is a payroll question, not a cancellation — the worker is on site.
    const active = await JobApplicationModel.findOne({
      job_id: jobId,
      status: { $in: ['accepted', 'checked_in'] },
    }).exec();
    if (active?.status === 'checked_in') {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'The worker is already checked in — check them out instead',
      );
    }

    await JobPostingModel.updateOne(
      { _id: jobId },
      { $set: { status: 'cancelled', cancelled_reason: reason ?? null } },
    ).exec();

    if (active) {
      await JobApplicationModel.updateOne(
        { _id: active._id },
        { $set: { status: 'cancelled', cancelled_reason: reason ?? null } },
      ).exec();
      notificationsService.notify(active.applicant_id, {
        category: 'job',
        title: 'Gig cancelled',
        body: reason
          ? `${job.title} was cancelled: ${reason}`
          : `${job.title} was cancelled by the employer`,
        data: { jobId },
      });
    }

    await writeAudit({
      actorId: principal.userId,
      action: 'job.cancelled',
      entityType: 'job',
      entityId: jobId,
      metadata: { reason: reason ?? null, notifiedApplicant: active?.applicant_id ?? null },
    });
    await publish('job.cancelled', { jobId, applicantId: active?.applicant_id ?? null });
    return { id: jobId, status: 'cancelled' as const };
  },

  /** Resolve poster business ids to display names in one round-trip. */
  async employerNameMap(jobs: { poster_business_id?: string | null }[]): Promise<Map<string, string>> {
    const ids = [...new Set(jobs.map((j) => j.poster_business_id).filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const businesses = await BusinessModel.find({ _id: { $in: ids } }, { name: 1 }).lean().exec();
    return new Map(businesses.map((b) => [String(b._id), b.name]));
  },

  async employerNames(ids: (string | null)[]): Promise<string[]> {
    const map = await this.employerNameMap(ids.map((id) => ({ poster_business_id: id })));
    return ids.map((id) => (id ? (map.get(id) ?? PLATFORM_EMPLOYER) : PLATFORM_EMPLOYER));
  },

  /**
   * The gigs this user POSTED. `mine()` returns what they applied to — the worker's half — so an
   * employer previously had no listing at all: they could create a job via the API and then never
   * see it again, nor who turned up for it.
   */
  async postedByMe(principal: Principal) {
    const jobs = await JobPostingModel.find({ poster_user_id: principal.userId })
      .sort({ created_at: -1 })
      .limit(100)
      .lean()
      .exec();
    if (jobs.length === 0) return [];

    const ids = jobs.map((j) => String(j._id));
    const apps = await JobApplicationModel.find({ job_id: { $in: ids } })
      .lean()
      .exec();
    const byJob = new Map<string, typeof apps>();
    for (const a of apps) {
      const list = byJob.get(a.job_id) ?? [];
      list.push(a);
      byJob.set(a.job_id, list);
    }
    const employers = await this.employerNameMap(jobs);

    return jobs.map((j) => {
      const list = byJob.get(String(j._id)) ?? [];
      return {
        ...this.view(j, employers.get(j.poster_business_id ?? '') ?? PLATFORM_EMPLOYER),
        applicantCount: list.length,
        /** Money actually paid out on this posting, so a poster can see what it cost. */
        paidOutCents: list.reduce((sum, a) => sum + (a.payout_cents ?? 0), 0),
        applications: list.map((a) => this.applicationView(a)),
      };
    });
  },

  /**
   * The rotating code the employer displays on site. Poster-only: whoever can see this code can
   * authorise a check-in, so it must never be readable by the worker in advance.
   */
  async checkInToken(principal: Principal, jobId: string) {
    const job = await JobPostingModel.findById(jobId).exec();
    if (!job) throw NotFoundError('Job not found');
    if (job.poster_user_id !== principal.userId) {
      throw ForbiddenError('Not your job posting', ERROR_CODES.NOT_OWNER);
    }
    // Older postings predate the field — mint a key on first use rather than failing.
    if (!job.checkin_qr_secret) {
      job.checkin_qr_secret = randomUUID();
      await job.save();
    }
    return { jobId, ...currentJobQrToken(job.checkin_qr_secret, jobId) };
  },

  /**
   * Sweep gigs whose worker never turned up (BACKGROUND_JOBS). A gig stuck at `filled` with nobody
   * checked in is worse than an empty one: it's off the board, so nobody else can take it, and the
   * employer may not be watching. After the grace period the claim is dropped and the shift is
   * relisted automatically.
   */
  async sweepNoShows(): Promise<number> {
    const cutoff = new Date(Date.now() - JOB_NO_SHOW_GRACE_MIN * 60_000);
    const stale = await JobPostingModel.find({
      status: 'filled',
      starts_at: { $ne: null, $lt: cutoff },
    })
      .limit(200)
      .lean()
      .exec();
    if (stale.length === 0) return 0;

    let swept = 0;
    for (const job of stale) {
      const jobId = String(job._id);
      const app = await JobApplicationModel.findOneAndUpdate(
        { job_id: jobId, status: { $in: ['applied', 'accepted'] } },
        { $set: { status: 'no_show' } },
        { new: true },
      ).exec();
      if (!app) continue; // already checked in — not a no-show

      await JobPostingModel.updateOne(
        { _id: jobId, status: 'filled' },
        { $set: { status: 'open', filled_by: null } },
      ).exec();
      swept += 1;

      notificationsService.notify(app.applicant_id, {
        category: 'job',
        title: 'Gig released',
        body: `You didn't check in for "${job.title}", so it's been reopened for someone else.`,
        data: { jobId, audience: 'seller' },
      });
      if (job.poster_user_id) {
        notificationsService.notify(job.poster_user_id, {
          category: 'job',
          title: 'Worker didn’t show',
          body: `Nobody checked in for "${job.title}" — it's back on the board.`,
          data: { jobId, audience: 'vendor' },
        });
      }
      await writeAudit({
        actorId: 'system',
        action: 'job.no_show_swept',
        entityType: 'job',
        entityId: jobId,
        metadata: { applicantId: app.applicant_id, graceMinutes: JOB_NO_SHOW_GRACE_MIN },
      });
    }
    return swept;
  },

  /** Who took this gig, for the poster only. */
  async applicants(principal: Principal, jobId: string) {
    const job = await JobPostingModel.findById(jobId).lean().exec();
    if (!job) throw NotFoundError('Job not found');
    if (job.poster_user_id !== principal.userId) {
      throw ForbiddenError('Not your job posting', ERROR_CODES.NOT_OWNER);
    }
    const apps = await JobApplicationModel.find({ job_id: jobId })
      .sort({ created_at: 1 })
      .lean()
      .exec();
    const names = await UserModel.find(
      { _id: { $in: apps.map((a) => a.applicant_id) } },
      { display_name: 1, photo_url: 1 },
    )
      .lean()
      .exec();
    const byId = new Map(names.map((u) => [String(u._id), u]));
    return apps.map((a) => ({
      ...this.applicationView(a),
      applicantId: a.applicant_id,
      applicantName: byId.get(a.applicant_id)?.display_name ?? 'Worker',
      applicantPhotoUrl: byId.get(a.applicant_id)?.photo_url ?? null,
    }));
  },

  /**
   * The employer records that the worker never turned up. `no_show` existed in the model and
   * rendered in the UI, but nothing could ever set it — so the state was unreachable and the
   * posting stayed `filled` forever, blocking anyone else from taking the gig.
   *
   * Reopening the posting is the point: an unfilled shift is worth more re-listed than closed.
   */
  async markNoShow(principal: Principal, jobId: string) {
    const job = await JobPostingModel.findById(jobId).lean().exec();
    if (!job) throw NotFoundError('Job not found');
    if (job.poster_user_id !== principal.userId) {
      throw ForbiddenError('Not your job posting', ERROR_CODES.NOT_OWNER);
    }
    const app = await JobApplicationModel.findOneAndUpdate(
      { job_id: jobId, status: { $in: ['applied', 'accepted'] } },
      { $set: { status: 'no_show' } },
      { new: true },
    ).exec();
    if (!app) {
      throw ConflictError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        'No worker is pending on this gig — they may have checked in already',
      );
    }
    // Put the shift back on the board rather than leaving it stranded as `filled`.
    await JobPostingModel.updateOne(
      { _id: jobId, status: 'filled' },
      { $set: { status: 'open', filled_by: null } },
    ).exec();

    notificationsService.notify(app.applicant_id, {
      category: 'job',
      title: 'Marked as a no-show',
      body: `You were marked as not attending "${job.title}". The shift has been reopened.`,
      data: { jobId, audience: 'seller' },
    });
    await writeAudit({
      actorId: principal.userId,
      action: 'job.no_show',
      entityType: 'job',
      entityId: jobId,
      metadata: { applicantId: app.applicant_id },
    });
    return { jobId, status: 'open', application: this.applicationView(app) };
  },

  /**
   * Completed gig payouts for one worker, for the unified earnings feed (S-13). Consignment
   * settlements and gig pay are the same income to the person receiving them.
   */
  async payoutsForWorker(workerId: string, since: Date) {
    const apps = await JobApplicationModel.find({
      applicant_id: workerId,
      status: 'completed',
      checked_out_at: { $gte: since },
    })
      .sort({ checked_out_at: -1 })
      .lean()
      .exec();
    if (apps.length === 0) return [];

    const jobs = await JobPostingModel.find({ _id: { $in: apps.map((a) => a.job_id) } })
      .lean()
      .exec();
    const byId = new Map(jobs.map((j) => [String(j._id), j]));
    const employers = await this.employerNameMap(jobs);

    return apps.map((a) => {
      const job = byId.get(a.job_id);
      return {
        source: 'job' as const,
        jobId: a.job_id,
        title: job?.title ?? 'Gig',
        employerName: job
          ? (employers.get(job.poster_business_id ?? '') ?? PLATFORM_EMPLOYER)
          : PLATFORM_EMPLOYER,
        netCents: a.payout_cents ?? 0,
        /** No transfer ref means the work is recorded but no payout account existed yet. */
        payoutStatus: a.payout_ref ? ('paid' as const) : ('no_account' as const),
        payoutRef: a.payout_ref ?? null,
        completedAt: a.checked_out_at ? new Date(a.checked_out_at).toISOString() : null,
      };
    });
  },

  applicationView(a: JobApplicationLike) {
    return {
      id: String(a._id),
      jobId: a.job_id,
      status: a.status,
      checkedInAt: a.checked_in_at ? new Date(a.checked_in_at).toISOString() : null,
      checkedOutAt: a.checked_out_at ? new Date(a.checked_out_at).toISOString() : null,
      payoutRef: a.payout_ref ?? null,
      payoutCents: a.payout_cents ?? 0,
      cancelledReason: a.cancelled_reason ?? null,
    };
  },

  view(j: JobPostingLike, employerName: string = PLATFORM_EMPLOYER) {
    return {
      id: String(j._id),
      posterBusinessId: j.poster_business_id ?? null,
      employerName,
      title: j.title,
      description: j.description ?? null,
      payCents: j.pay_cents,
      payUnit: j.pay_unit === 'hourly' ? 'hourly' : 'flat',
      // A-5: un-migrated rows report the default rather than null — the client should never have to
      // render "untyped work".
      jobType: (j.job_type ?? DEFAULT_JOB_TYPE) as JobType,
      jobTypeLabel: JOB_TYPE_LABELS[(j.job_type ?? DEFAULT_JOB_TYPE) as JobType],
      status: j.status,
      startsAt: j.starts_at ? new Date(j.starts_at).toISOString() : null,
      durationHrs: j.duration_hrs ?? null,
      cancelledReason: j.cancelled_reason ?? null,
      checkInRadiusM: JOB_CHECKIN_RADIUS_M,
      location: j.location?.coordinates ?? [],
    };
  },
};

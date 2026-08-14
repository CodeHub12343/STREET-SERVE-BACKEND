import { DisputeModel } from './disputes.model';

export const disputesRepository = {
  create(data: {
    subject_type: string;
    subject_id: string;
    related: { ref_type: string; ref_id: string };
    opened_by: string;
    sla_due_at: Date;
    evidence: { note?: string; by: string; at: Date }[];
  }) {
    return DisputeModel.create(data);
  },
  findById(id: string) {
    return DisputeModel.findById(id).exec();
  },
  addEvidence(id: string, entry: { url?: string; note?: string; by: string; at: Date }) {
    return DisputeModel.findByIdAndUpdate(
      id,
      { $push: { evidence: entry }, $set: { status: 'evidence_requested' } },
      { new: true },
    ).exec();
  },
  resolve(id: string, patch: { outcome: string; resolution: string }) {
    return DisputeModel.findOneAndUpdate(
      { _id: id, status: { $in: ['open', 'evidence_requested'] } },
      {
        $set: {
          status: 'resolved',
          outcome: patch.outcome,
          resolution: patch.resolution,
          resolved_at: new Date(),
        },
      },
      { new: true },
    ).exec();
  },
  /** Resolved-and-upheld disputes against a subject — the only disputes that penalise Trust. */
  /** Is there an unresolved dispute over this checkout? Money must not move while there is. */
  openForRef(refType: string, refId: string) {
    return DisputeModel.findOne({
      'related.ref_type': refType,
      'related.ref_id': refId,
      status: { $ne: 'resolved' },
    })
      .lean()
      .exec();
  },
  upheldResolvedCount(subjectType: string, subjectId: string) {
    return DisputeModel.countDocuments({
      subject_type: subjectType,
      subject_id: subjectId,
      status: 'resolved',
      outcome: 'upheld',
    }).exec();
  },
  listForSubject(subjectType: string, subjectId: string, limit: number) {
    return DisputeModel.find({ subject_type: subjectType, subject_id: subjectId })
      .sort({ created_at: -1 })
      .limit(limit)
      .lean()
      .exec();
  },
};

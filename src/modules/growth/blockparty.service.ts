import {
  BLOCK_PARTY_BROADCAST_RADIUS_M,
  BLOCK_PARTY_MIN_OVERLAP_MS,
  BLOCK_PARTY_RADIUS_M,
} from '../../config/constants';
import { publish } from '../../events/bus';
import { bizMetrics } from '../../observability/bizMetrics';
import { distanceMeters } from '../../shared/geo';
import { kv } from '../../shared/kv';
import { identityService } from '../identity/identity.service';
import { livemapService } from '../livemap/livemap.service';
import { notificationsService } from '../notifications/notifications.service';
import { BlockPartyEventModel } from './growth.model';

interface ActiveActor {
  actorType: string;
  actorId: string;
  coordinates: [number, number];
}

/** Greedy spatial clustering: groups of ≥2 actors within `radiusM` of a seed. */
function cluster(actors: ActiveActor[], radiusM: number): ActiveActor[][] {
  const used = new Set<number>();
  const clusters: ActiveActor[][] = [];
  for (let i = 0; i < actors.length; i += 1) {
    if (used.has(i)) continue;
    const group = [actors[i]!];
    used.add(i);
    for (let j = i + 1; j < actors.length; j += 1) {
      if (used.has(j)) continue;
      if (distanceMeters(actors[i]!.coordinates, actors[j]!.coordinates) <= radiusM) {
        group.push(actors[j]!);
        used.add(j);
      }
    }
    if (group.length >= 2) clusters.push(group);
  }
  return clusters;
}

export const blockPartyService = {
  /**
   * Block Party detection (FR-4.2): find clusters of ≥2 live vendors within the radius that have
   * PERSISTED for the overlap window, then broadcast to opted-in users within the wider radius.
   * Persistence is tracked in Redis (first-seen per cluster) so a transient cluster doesn't fire.
   */
  async detectAndBroadcast(
    opts: { radiusM?: number; overlapMs?: number } = {},
  ): Promise<{ eventId: string; participantCount: number }[]> {
    const radiusM = opts.radiusM ?? BLOCK_PARTY_RADIUS_M;
    const overlapMs = opts.overlapMs ?? BLOCK_PARTY_MIN_OVERLAP_MS;

    const actors = (await livemapService.listActiveSessions()).filter(
      (a) => a.actorType === 'business',
    );
    const clusters = cluster(actors, radiusM);
    const results: { eventId: string; participantCount: number }[] = [];

    for (const group of clusters) {
      const key = `bp:seen:${group
        .map((g) => g.actorId)
        .sort()
        .join('-')}`;
      const now = Date.now();
      const firstSeenRaw = await kv().get(key);
      const firstSeen = firstSeenRaw ? Number(firstSeenRaw) : now;
      if (!firstSeenRaw) await kv().set(key, String(now), 3600);
      if (now - firstSeen < overlapMs) continue; // not yet sustained

      // Cooldown so we don't re-broadcast the same cluster every sweep.
      const firedKey = `bp:fired:${group
        .map((g) => g.actorId)
        .sort()
        .join('-')}`;
      if (await kv().get(firedKey)) continue;
      await kv().set(firedKey, '1', 3600);

      const centroid: [number, number] = [
        group.reduce((s, g) => s + g.coordinates[0], 0) / group.length,
        group.reduce((s, g) => s + g.coordinates[1], 0) / group.length,
      ];
      const nearbyUserIds = await identityService.findUserIdsNearLocation(
        centroid[0],
        centroid[1],
        BLOCK_PARTY_BROADCAST_RADIUS_M,
        1000,
      );

      const event = await BlockPartyEventModel.create({
        centroid: { type: 'Point', coordinates: centroid },
        radius_m: radiusM,
        participant_actor_ids: group.map((g) => g.actorId),
        broadcast_at: new Date(),
        notified_user_count: nearbyUserIds.length,
      });
      for (const userId of nearbyUserIds) {
        notificationsService.notify(userId, {
          category: 'block_party',
          title: 'Block Party nearby!',
          body: `${group.length} vendors are clustered near you`,
          data: { eventId: String(event._id) },
        });
      }
      bizMetrics.blockPartyDetected.inc();
      await publish('block_party.detected', {
        eventId: String(event._id),
        participantCount: group.length,
      });
      results.push({ eventId: String(event._id), participantCount: group.length });
    }
    return results;
  },
};

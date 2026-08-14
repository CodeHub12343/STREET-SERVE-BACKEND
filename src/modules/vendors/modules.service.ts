import {
  COMMERCE_MODULES,
  COMMERCE_REQUIRES,
  CORE_MODULES,
  DEFAULT_ARCHETYPE_BY_TAB,
  PRIMARY_COMMERCE_BY_ARCHETYPE,
  type Archetype,
  type CategoryTab,
  type Module,
} from '../../config/constants';
import { ERROR_CODES } from '../../shared/errors/codes';
import { BusinessRuleError, NotFoundError } from '../../shared/errors/AppError';
import { CategoryModel } from '../catalog/catalog.model';
import { vendorsRepository as repo } from './vendors.repository';

/**
 * Business module resolution (BUSINESS_MODULE_SYSTEM.md §3) — the single source of truth for
 * "what can this business do". The dashboard nav, the route guards, and the customer profile all
 * ask this; nothing recomputes it.
 *
 * Chain: archetype defaults ⊕ category overrides ⊕ owner's set ⊕ auto rules ⊕ core (forced).
 * Pure apart from the two reads, so it is exhaustively unit-testable.
 */

/** On by default for the archetype. */
const ARCHETYPE_DEFAULTS: Record<Archetype, Module[]> = {
  counter_serve: ['menu', 'ordering', 'queue', 'wave_down'],
  appointment_service: ['services', 'booking'],
  /**
   * Booking by default, matching PRIMARY_COMMERCE_BY_ARCHETYPE (which already declares this
   * archetype's commerce mode as `booking`). Previously it defaulted to `wave_down` with no
   * commerce module at all, so two businesses under the same "services" tab behaved differently —
   * a cleaner offered "Book an appointment" while a courier offered "Wave" — for no reason the
   * customer could see. Every service now leads with booking.
   *
   * `wave_down` stays AVAILABLE below: a locksmith or mechanic whose whole trade is "come now" can
   * switch it back on from the Modules screen. The default changes; the capability doesn't vanish.
   */
  on_demand_service: ['services', 'booking'],
  // `menu` (not just `catalog`): a goods seller's product list is the same name+price shape and
  // uses the same /businesses/:id/menu surface — registration posts their first product there.
  // `catalog` remains for the hub-side listing, whose screens are gated by `hub_operations`.
  goods_seller: ['menu', 'catalog', 'ordering', 'consignment'],
};

/**
 * Everything the archetype may offer. Anything absent is hidden entirely (the `➖` column in
 * BUSINESS_CATEGORY_MATRIX.md §4) — a barber is never offered a menu, a mechanic never a queue
 * by default. This list is what makes the product feel category-built rather than generic.
 */
const ARCHETYPE_AVAILABLE: Record<Archetype, Module[]> = {
  counter_serve: [
    ...ARCHETYPE_DEFAULTS.counter_serve,
    'booking',
    'consignment',
    'gifting',
    'giveaways',
    'pay_it_forward',
    'ping_sharing',
    'ai_assistant',
  ],
  appointment_service: [
    ...ARCHETYPE_DEFAULTS.appointment_service,
    'ordering',
    'wave_down',
    'gifting',
    'giveaways',
    'pay_it_forward',
    'ping_sharing',
    'ai_assistant',
  ],
  on_demand_service: [
    ...ARCHETYPE_DEFAULTS.on_demand_service,
    'ordering',
    'wave_down', // opt-in: emergency dispatch for locksmith/mechanic-style trades
    'queue',
    'giveaways',
    'pay_it_forward',
    'ping_sharing',
    'ai_assistant',
  ],
  goods_seller: [
    ...ARCHETYPE_DEFAULTS.goods_seller,
    'menu',
    'queue',
    'gifting',
    'giveaways',
    'pay_it_forward',
    'ping_sharing',
    'ai_assistant',
  ],
};

export interface ResolvedModules {
  archetype: Archetype;
  /** Effective set — what this business can actually do right now. */
  enabled: Module[];
  /** Everything the archetype may offer (superset of `enabled`). */
  available: Module[];
  core: Module[];
  /** Cannot be turned off: core + auto rules that follow from data. */
  locked: Module[];
  /**
   * The one way customers transact with this business, or `null` if it does neither (an on-demand
   * trade that only takes wave-downs). Never both — see COMMERCE_MODULES.
   */
  commerceMode: Module | null;
}

/**
 * Rule A — dependency. A commerce module is only OFFERABLE alongside something to transact on, so
 * `booking` disappears from a business with no services rather than rendering a CTA that dead-ends.
 * Applied to `available`, which every later step intersects with.
 */
function pruneUnsupportedCommerce(available: Set<Module>): void {
  for (const mod of COMMERCE_MODULES) {
    const needs = COMMERCE_REQUIRES[mod] ?? [];
    if (needs.length > 0 && !needs.some((dep) => available.has(dep))) available.delete(mod);
  }
}

/**
 * Rule B — exclusivity. One account, one commerce mode. On conflict the archetype's own answer
 * wins, so resolution is deterministic and no owner is silently switched to the wrong inbox.
 * Mutates `chosen` and returns the surviving mode.
 */
function enforceExclusiveCommerce(chosen: Set<Module>, archetype: Archetype): Module | null {
  const held = COMMERCE_MODULES.filter((m) => chosen.has(m));
  if (held.length <= 1) return held[0] ?? null;

  const primary = PRIMARY_COMMERCE_BY_ARCHETYPE[archetype];
  const preferred = held.includes(primary) ? primary : (held[0] as Module);
  for (const m of held) if (m !== preferred) chosen.delete(m);
  return preferred;
}

/** Order the output by the canonical MODULES order so responses are stable and diffable. */
function ordered(set: Set<Module>): Module[] {
  return [...set];
}

/** The two documents resolution needs — nothing else about a business affects its modules. */
interface ModuleInputs {
  business: { enabled_modules?: unknown; is_hub?: boolean };
  category: {
    archetype?: unknown;
    top_level_tab?: unknown;
    module_overrides?: unknown;
    requires_license?: unknown;
  } | null;
}

export async function resolveModules(businessId: string): Promise<ResolvedModules> {
  const business = await repo.findBusinessById(businessId);
  if (!business) throw NotFoundError('Business not found');

  const category = await CategoryModel.findById(business.category_id).lean().exec();
  return resolveModulesFrom({ business, category });
}

/**
 * The pure core of resolution, over documents the caller already has. The map's pin list resolves
 * hundreds of businesses per request and cannot afford resolveModules' two reads each — it batches
 * the loads itself and calls this. Everything else should call `resolveModules`.
 */
export function resolveModulesFrom({ business, category }: ModuleInputs): ResolvedModules {
  // A category is required to create a business, but never trust a dangling ref at runtime.
  const archetype: Archetype =
    (category?.archetype as Archetype | null) ??
    DEFAULT_ARCHETYPE_BY_TAB[(category?.top_level_tab as CategoryTab) ?? 'more'];

  const available = new Set<Module>([...ARCHETYPE_AVAILABLE[archetype], ...CORE_MODULES]);
  const defaults = new Set<Module>(ARCHETYPE_DEFAULTS[archetype]);

  // Category overrides: may switch a default on (and thereby make it available) or off.
  const overrides = (category?.module_overrides ?? {}) as Record<string, boolean>;
  for (const [mod, on] of Object.entries(overrides)) {
    const m = mod as Module;
    if (on) {
      defaults.add(m);
      available.add(m);
    } else {
      defaults.delete(m);
    }
  }

  // Auto rules — derived from data, so they are never the owner's to toggle.
  const auto = new Set<Module>();
  if (category?.requires_license) auto.add('licensing');
  if (business.is_hub) auto.add('hub_operations');
  for (const m of auto) available.add(m);

  // Rule A, before anything reads `available` — a commerce module with no content module behind it
  // is not on offer at all, so it can be neither defaulted on nor chosen.
  pruneUnsupportedCommerce(available);
  for (const m of defaults) if (!available.has(m)) defaults.delete(m);

  // The owner's explicit set. `undefined` = inherit defaults (NOT "none").
  // Re-intersect with `available`: if the business was re-categorised, a stored module from the
  // old archetype must not resurrect an irrelevant screen.
  const chosen =
    business.enabled_modules === undefined || business.enabled_modules === null
      ? new Set<Module>(defaults)
      : new Set<Module>((business.enabled_modules as Module[]).filter((m) => available.has(m)));

  for (const m of auto) chosen.add(m);
  for (const m of CORE_MODULES) chosen.add(m);

  // Rule B, last — after every source has had its say, so a category override and a stored set can
  // never combine into a business that takes both orders and appointments.
  const commerceMode = enforceExclusiveCommerce(chosen, archetype);

  return {
    archetype,
    enabled: ordered(chosen),
    available: ordered(available),
    core: [...CORE_MODULES],
    locked: ordered(new Set<Module>([...CORE_MODULES, ...auto])),
    commerceMode,
  };
}

/**
 * Persist the owner's chosen optional modules. Core/auto modules are enforced server-side rather
 * than trusted from the body, and anything outside the archetype's `available` set is rejected.
 */
export async function setEnabledModules(
  businessId: string,
  requested: Module[],
): Promise<ResolvedModules> {
  const current = await resolveModules(businessId);

  // Asking for both commerce modes is a client bug, not something to silently resolve — the owner
  // must see that this is a choice. (Switching FROM one TO the other is always allowed: a business
  // that registered under the wrong model would otherwise be stuck forever.)
  const bothCommerce = COMMERCE_MODULES.filter((m) => requested.includes(m));
  if (bothCommerce.length > 1) {
    throw BusinessRuleError(
      ERROR_CODES.MODULE_EXCLUSIVE,
      'A business can take orders or take bookings, not both. Choose one.',
    );
  }

  const unavailable = requested.filter((m) => !current.available.includes(m));
  if (unavailable.length > 0) {
    throw BusinessRuleError(
      ERROR_CODES.MODULE_NOT_AVAILABLE,
      `Not available for this business category: ${unavailable.join(', ')}`,
    );
  }

  // Removing a locked module is a client bug, not a silent no-op — say so.
  const removedLocked = current.locked.filter((m) => !requested.includes(m));
  if (removedLocked.length > 0) {
    throw BusinessRuleError(
      ERROR_CODES.MODULE_LOCKED,
      `These modules cannot be disabled: ${removedLocked.join(', ')}`,
    );
  }

  await repo.updateBusiness(businessId, { enabled_modules: requested });
  return resolveModules(businessId);
}

/** Exposed for tests + the module-gate middleware. */
export const __moduleTables = { ARCHETYPE_DEFAULTS, ARCHETYPE_AVAILABLE };

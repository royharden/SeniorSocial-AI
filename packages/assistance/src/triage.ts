import type { TriageCategory } from './types.ts';

const categories: readonly [TriageCategory, readonly RegExp[]][] = [
  ['immediate_safety', [/\b(?:danger|unsafe|hurt|violence|fire|suicide|overdose|can't breathe|cannot breathe|peligro|violencia|incendio|suicidio|sobredosis|no puedo respirar)\b/iu]],
  ['food', [/\b(?:food|meal|hungry|grocer|comida|hambre|alimento)\w*\b/iu]],
  ['housing', [/\b(?:housing|evict|rent|shelter|homeless|heat|utility|utilities|vivienda|desalojo|alquiler|refugio|calefacci[oó]n|servicios)\w*\b/iu]],
  ['transportation', [/\b(?:ride|transport|bus|appointment|pickup|viaje|transporte|autob[uú]s|cita)\w*\b/iu]],
  ['social_support', [/\b(?:lonely|alone|isolated|company|someone to talk|soledad|solo|sola|aislado|aislada|alguien con quien hablar)\b/iu]],
];

/** Complete, deterministic native triage. Ordering is intentional and stable. */
export function triageByRules(summary: string): TriageCategory {
  for (const [category, patterns] of categories) {
    if (patterns.some(pattern => pattern.test(summary))) return category;
  }
  return 'general';
}

export const slaMinutes: Readonly<Record<TriageCategory, number>> = {
  immediate_safety: 15,
  food: 60,
  housing: 60,
  transportation: 120,
  social_support: 240,
  general: 240,
};

export function slaDueAt(createdAt: Date, category: TriageCategory): Date {
  return new Date(createdAt.getTime() + slaMinutes[category] * 60_000);
}

export class FixedUtcBusinessHours {
  constructor(private readonly startHour = 8, private readonly endHour = 18) {}
  isAfterHours(at: Date): boolean {
    const day = at.getUTCDay();
    const hour = at.getUTCHours();
    return day === 0 || day === 6 || hour < this.startHour || hour >= this.endHour;
  }
}

export class ZonedBusinessHours {
  readonly #format: Intl.DateTimeFormat;
  constructor(timeZone: string, private readonly startHour = 8, private readonly endHour = 18) {
    this.#format = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  }
  isAfterHours(at: Date): boolean {
    const parts = Object.fromEntries(this.#format.formatToParts(at).map(part => [part.type, part.value]));
    const hour = Number(parts.hour);
    return parts.weekday === 'Sat' || parts.weekday === 'Sun' || !Number.isInteger(hour) || hour < this.startHour || hour >= this.endHour;
  }
}

import enAdmin from '../en/admin.json' with { type: 'json' };
import enAssistance from '../en/assistance.json' with { type: 'json' };
import enAuth from '../en/auth.json' with { type: 'json' };
import enCaregiver from '../en/caregiver.json' with { type: 'json' };
import enCommon from '../en/common.json' with { type: 'json' };
import enEvents from '../en/events.json' with { type: 'json' };
import enGroups from '../en/groups.json' with { type: 'json' };
import enIntake from '../en/intake.json' with { type: 'json' };
import enMessages from '../en/messages.json' with { type: 'json' };
import enNotify from '../en/notify.json' with { type: 'json' };
import enProfile from '../en/profile.json' with { type: 'json' };
import enReports from '../en/reports.json' with { type: 'json' };
import enRides from '../en/rides.json' with { type: 'json' };
import enServices from '../en/services.json' with { type: 'json' };
import enShell from '../en/shell.json' with { type: 'json' };
import enTranslate from '../en/translate.json' with { type: 'json' };
import esAdmin from '../es/admin.json' with { type: 'json' };
import adminStatus from '../es/admin.status.json' with { type: 'json' };
import esAssistance from '../es/assistance.json' with { type: 'json' };
import assistanceStatus from '../es/assistance.status.json' with { type: 'json' };
import esAuth from '../es/auth.json' with { type: 'json' };
import authStatus from '../es/auth.status.json' with { type: 'json' };
import esCaregiver from '../es/caregiver.json' with { type: 'json' };
import caregiverStatus from '../es/caregiver.status.json' with { type: 'json' };
import policy from '../es/catalog-policy.json' with { type: 'json' };
import esCommon from '../es/common.json' with { type: 'json' };
import commonStatus from '../es/common.status.json' with { type: 'json' };
import esEvents from '../es/events.json' with { type: 'json' };
import eventsStatus from '../es/events.status.json' with { type: 'json' };
import esGroups from '../es/groups.json' with { type: 'json' };
import groupsStatus from '../es/groups.status.json' with { type: 'json' };
import esIntake from '../es/intake.json' with { type: 'json' };
import intakeStatus from '../es/intake.status.json' with { type: 'json' };
import esMessages from '../es/messages.json' with { type: 'json' };
import messagesStatus from '../es/messages.status.json' with { type: 'json' };
import esNotify from '../es/notify.json' with { type: 'json' };
import notifyStatus from '../es/notify.status.json' with { type: 'json' };
import esProfile from '../es/profile.json' with { type: 'json' };
import profileStatus from '../es/profile.status.json' with { type: 'json' };
import esReports from '../es/reports.json' with { type: 'json' };
import reportsStatus from '../es/reports.status.json' with { type: 'json' };
import esRides from '../es/rides.json' with { type: 'json' };
import ridesStatus from '../es/rides.status.json' with { type: 'json' };
import esServices from '../es/services.json' with { type: 'json' };
import servicesStatus from '../es/services.status.json' with { type: 'json' };
import esShell from '../es/shell.json' with { type: 'json' };
import shellStatus from '../es/shell.status.json' with { type: 'json' };
import esTranslate from '../es/translate.json' with { type: 'json' };
import translateStatus from '../es/translate.status.json' with { type: 'json' };
import { createCatalogResolver, type CatalogResolution } from './catalog-resolver';

export * from './catalog-resolver';

export const catalogs = {
  en: {
    admin: enAdmin,
    assistance: enAssistance,
    auth: enAuth,
    caregiver: enCaregiver,
    common: enCommon,
    events: enEvents,
    groups: enGroups,
    intake: enIntake,
    messages: enMessages,
    notify: enNotify,
    profile: enProfile,
    reports: enReports,
    rides: enRides,
    services: enServices,
    shell: enShell,
    translate: enTranslate,
  },
  es: {
    admin: esAdmin,
    assistance: esAssistance,
    auth: esAuth,
    caregiver: esCaregiver,
    common: esCommon,
    events: esEvents,
    groups: esGroups,
    intake: esIntake,
    messages: esMessages,
    notify: esNotify,
    profile: esProfile,
    reports: esReports,
    rides: esRides,
    services: esServices,
    shell: esShell,
    translate: esTranslate,
  },
} as const;

export type CatalogLocale = keyof typeof catalogs;
export type CatalogNamespace = keyof typeof catalogs.en;
export type CatalogKey<Namespace extends CatalogNamespace> =
  Extract<keyof (typeof catalogs.en)[Namespace], keyof (typeof catalogs.es)[Namespace]> & string;
export type CatalogMessageRequest<Namespace extends CatalogNamespace = CatalogNamespace> =
  Namespace extends CatalogNamespace ? {
    readonly locale: CatalogLocale;
    readonly namespace: Namespace;
    readonly key: CatalogKey<Namespace>;
  } : never;

export const authProblemTitles = { en: enAuth, es: esAuth } as const;
export type AuthProblemCode = keyof typeof enAuth;

const builtInResolver = createCatalogResolver({
  catalogs,
  statuses: {
    admin: adminStatus,
    assistance: assistanceStatus,
    auth: authStatus,
    caregiver: caregiverStatus,
    common: commonStatus,
    events: eventsStatus,
    groups: groupsStatus,
    intake: intakeStatus,
    messages: messagesStatus,
    notify: notifyStatus,
    profile: profileStatus,
    reports: reportsStatus,
    rides: ridesStatus,
    services: servicesStatus,
    shell: shellStatus,
    translate: translateStatus,
  },
  sourceBindings: policy.current_source_namespaces,
  criticalFallback: {
    renderState: policy.critical_fallback.render_state,
    affordance: policy.critical_fallback.affordance,
  },
});

export function resolveCatalogMessage(input: CatalogMessageRequest): CatalogResolution {
  return builtInResolver.resolve(input);
}

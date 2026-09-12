import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accountStateValues, localeValues, modeValues, roleValues } from './vocabulary.ts';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const locale = pgEnum('locale', localeValues);
export const displayMode = pgEnum('display_mode', modeValues);
export const accountState = pgEnum('account_state', accountStateValues);
export const userRole = pgEnum('user_role', roleValues);

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v4()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  localeDefault: locale('locale_default').notNull().default('en'),
  timezone: text('timezone').notNull().default('America/New_York'),
  createdAt,
  updatedAt,
});

export const users = pgTable('users', {
  id: uuid('id').notNull().default(sql`uuid_generate_v4()`),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  displayName: text('display_name').notNull(),
  email: citext('email'),
  phone: text('phone'),
  accountState: accountState('account_state').notNull().default('active'),
  mode: displayMode('mode').notNull().default('standard'),
  locale: locale('locale').notNull().default('en'),
  isDemo: boolean('is_demo').notNull().default(false),
  createdAt,
  updatedAt,
}, table => [
  primaryKey({ columns: [table.id] }),
  unique('users_org_id_id_key').on(table.orgId, table.id),
  uniqueIndex('users_org_id_email_key').on(table.orgId, table.email),
  index('users_org_id_account_state_idx').on(table.orgId, table.accountState),
]);

export const userRoles = pgTable('user_roles', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  role: userRole('role').notNull(),
  createdAt,
}, table => [
  primaryKey({ columns: [table.orgId, table.userId, table.role] }),
  foreignKey({
    columns: [table.orgId, table.userId],
    foreignColumns: [users.orgId, users.id],
    name: 'user_roles_user_key',
  }).onDelete('cascade'),
  index('user_roles_org_id_role_idx').on(table.orgId, table.role),
]);

export const profiles = pgTable('profiles', {
  id: uuid('id').notNull().default(sql`uuid_generate_v4()`),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  preferredName: text('preferred_name'),
  birthYear: integer('birth_year'),
  birthMonth: integer('birth_month'),
  contactEmail: citext('contact_email'),
  contactPhone: text('contact_phone'),
  accessibilityConditions: jsonb('accessibility_conditions').$type<string[]>().notNull().default([]),
  createdAt,
  updatedAt,
}, table => [
  primaryKey({ columns: [table.id] }),
  unique('profiles_org_id_id_key').on(table.orgId, table.id),
  unique('profiles_org_id_user_id_key').on(table.orgId, table.userId),
  foreignKey({
    columns: [table.orgId, table.userId],
    foreignColumns: [users.orgId, users.id],
    name: 'profiles_user_key',
  }).onDelete('cascade'),
  index('profiles_org_id_created_at_idx').on(table.orgId, table.createdAt),
  check('profiles_birth_year_check', sql`${table.birthYear} is null or ${table.birthYear} between 1900 and 2100`),
  check('profiles_birth_month_check', sql`${table.birthMonth} is null or ${table.birthMonth} between 1 and 12`),
]);

export const serviceCategories = pgTable('service_categories', {
  id: uuid('id').notNull().default(sql`uuid_generate_v4()`),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull(),
  labelEn: text('label_en').notNull(),
  labelEs: text('label_es').notNull(),
  createdAt,
  updatedAt,
}, table => [
  primaryKey({ columns: [table.id] }),
  unique('service_categories_org_id_id_key').on(table.orgId, table.id),
  unique('service_categories_org_id_slug_key').on(table.orgId, table.slug),
  index('service_categories_org_id_label_en_idx').on(table.orgId, table.labelEn),
]);

export const partners = pgTable('partners', {
  id: uuid('id').notNull().default(sql`uuid_generate_v4()`),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  categories: text('categories').array().notNull().default([]),
  contact: jsonb('contact').$type<Record<string, string>>().notNull().default({}),
  createdAt,
  updatedAt,
}, table => [
  primaryKey({ columns: [table.id] }),
  unique('partners_org_id_id_key').on(table.orgId, table.id),
  unique('partners_org_id_name_key').on(table.orgId, table.name),
  index('partners_org_id_created_at_idx').on(table.orgId, table.createdAt),
]);

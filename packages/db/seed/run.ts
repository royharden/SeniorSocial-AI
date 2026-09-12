import { createDatabaseClient } from '../src/client.ts';
import { coreSeed } from './core/data.ts';

const client = createDatabaseClient();
try {
  await client.begin(async transaction => {
    for (const org of coreSeed.orgs) {
      await transaction`
        insert into orgs (id, name, slug, locale_default)
        values (${org.id}, ${org.name}, ${org.slug}, ${org.localeDefault})
        on conflict (id) do update set
          name = excluded.name,
          slug = excluded.slug,
          locale_default = excluded.locale_default
      `;
    }
    for (const user of coreSeed.users) {
      await transaction`
        insert into users (id, org_id, display_name, email, is_demo)
        values (${user.id}, ${user.orgId}, ${user.displayName}, ${user.email}, true)
        on conflict (id) do update set
          org_id = excluded.org_id,
          display_name = excluded.display_name,
          email = excluded.email,
          is_demo = true
      `;
      await transaction`
        insert into user_roles (org_id, user_id, role)
        values (${user.orgId}, ${user.id}, ${user.role})
        on conflict (org_id, user_id, role) do nothing
      `;
      await transaction`
        insert into profiles (id, org_id, user_id, preferred_name)
        values (${user.profileId}, ${user.orgId}, ${user.id}, ${user.displayName})
        on conflict (org_id, user_id) do update set
          id = excluded.id,
          preferred_name = excluded.preferred_name
      `;
    }
    for (const category of coreSeed.serviceCategories) {
      await transaction`
        insert into service_categories (id, org_id, slug, label_en, label_es)
        values (${category.id}, ${category.orgId}, ${category.slug}, ${category.labelEn}, ${category.labelEs})
        on conflict (id) do update set
          org_id = excluded.org_id,
          slug = excluded.slug,
          label_en = excluded.label_en,
          label_es = excluded.label_es
      `;
    }
    for (const partner of coreSeed.partners) {
      await transaction`
        insert into partners (id, org_id, name, categories, contact)
        values (${partner.id}, ${partner.orgId}, ${partner.name}, ${['transportation']}, ${transaction.json({ synthetic: 'true' })})
        on conflict (id) do update set
          org_id = excluded.org_id,
          name = excluded.name,
          categories = excluded.categories,
          contact = excluded.contact
      `;
    }
  });
  console.log(`Seeded ${coreSeed.orgs.length} synthetic organisations.`);
} finally {
  await client.end();
}

export const coreSeed = Object.freeze({
  orgs: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Maple Harbor',
      slug: 'maple-harbor',
      localeDefault: 'en' as const,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Cedar Point',
      slug: 'cedar-point',
      localeDefault: 'es' as const,
    },
  ],
  users: [
    {
      id: '11111111-1111-4111-8111-111111111101',
      orgId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Mara Example',
      email: 'mara@example.invalid',
      role: 'senior' as const,
      profileId: '11111111-1111-4111-8111-111111111102',
    },
    {
      id: '22222222-2222-4222-8222-222222222201',
      orgId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Elena Example',
      email: 'elena@example.invalid',
      role: 'senior' as const,
      profileId: '22222222-2222-4222-8222-222222222202',
    },
  ],
  serviceCategories: [
    { id: '11111111-1111-4111-8111-111111111121', orgId: '11111111-1111-4111-8111-111111111111', slug: 'transportation', labelEn: 'Transportation', labelEs: 'Transporte' },
    { id: '22222222-2222-4222-8222-222222222221', orgId: '22222222-2222-4222-8222-222222222222', slug: 'transportation', labelEn: 'Transportation', labelEs: 'Transporte' },
  ],
  partners: [
    { id: '11111111-1111-4111-8111-111111111131', orgId: '11111111-1111-4111-8111-111111111111', name: 'Maple Harbor Mobility Example' },
    { id: '22222222-2222-4222-8222-222222222231', orgId: '22222222-2222-4222-8222-222222222222', name: 'Cedar Point Mobility Example' },
  ],
});

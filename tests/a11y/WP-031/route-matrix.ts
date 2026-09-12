export const BASE_URL = process.env.WP031_BASE_URL ?? 'http://localhost:3131';

export const routes = [
  { path: '/', name: 'public landing', shell: true },
  { path: '/home', name: 'home', shell: true },
  { path: '/settings', name: 'settings', shell: true },
  { path: '/settings/notifications', name: 'notification settings', shell: true },
  { path: '/help', name: 'priority assistance', shell: true },
  { path: '/events', name: 'events', shell: true },
  { path: '/caregiver', name: 'caregiver permissions', shell: true },
  { path: '/rides', name: 'ride request', shell: true },
  { path: '/preferences/confirm?mode=easy', name: 'display confirmation', shell: true },
  { path: '/print', name: 'printable schedule', shell: true },
  { path: '/services', name: 'service directory', shell: true },
  { path: '/concierge', name: 'service concierge', shell: true },
] as const;

export const locales = ['en', 'es'] as const;
export const modes = ['standard', 'easy'] as const;
export const viewports = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'narrow', width: 360, height: 640 },
] as const;

export type Locale = (typeof locales)[number];
export type Mode = (typeof modes)[number];

export const preferenceCookies = (locale: Locale, mode: Mode) => [
  { name: 'seniorsocial.locale.v1', value: locale, url: BASE_URL },
  { name: 'seniorsocial.display-mode.v1', value: mode, url: BASE_URL },
];

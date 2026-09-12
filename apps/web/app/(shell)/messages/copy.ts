import {
  resolveCatalogMessage,
  type CatalogKey,
  type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';

const messagingKeys = {
  title: 'page.title',
  signIn: 'auth.sign_in_required',
  start: 'conversation.start',
  participant: 'conversation.participant_label',
  create: 'conversation.create',
  conversation: 'conversation.label',
  empty: 'conversation.empty',
  loading: 'state.loading',
  unavailable: 'error.unavailable',
  body: 'composer.body_label',
  send: 'composer.send',
  sent: 'state.sent',
  refresh: 'conversation.refresh',
  notice: 'navigation.notification_preferences',
  back: 'navigation.back_to_conversations',
  select: 'conversation.open',
  retry: 'error.retry',
} as const satisfies Readonly<Record<string, CatalogKey<'messages'>>>;

export type MessagingCopy = {
  readonly [Name in keyof typeof messagingKeys]: CatalogResolution;
};

export function resolveMessagingCopy(locale: 'en' | 'es'): MessagingCopy {
  const message = (key: CatalogKey<'messages'>) => resolveCatalogMessage({ locale, namespace: 'messages', key });
  return {
    title: message(messagingKeys.title),
    signIn: message(messagingKeys.signIn),
    start: message(messagingKeys.start),
    participant: message(messagingKeys.participant),
    create: message(messagingKeys.create),
    conversation: message(messagingKeys.conversation),
    empty: message(messagingKeys.empty),
    loading: message(messagingKeys.loading),
    unavailable: message(messagingKeys.unavailable),
    body: message(messagingKeys.body),
    send: message(messagingKeys.send),
    sent: message(messagingKeys.sent),
    refresh: message(messagingKeys.refresh),
    notice: message(messagingKeys.notice),
    back: message(messagingKeys.back),
    select: message(messagingKeys.select),
    retry: message(messagingKeys.retry),
  };
}

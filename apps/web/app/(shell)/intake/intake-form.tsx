'use client';

import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import styles from './intake.module.css';

type IntakeKind = 'legal' | 'health';
type Locale = 'en' | 'es';
type Answers = Record<string, string>;
type IntakeKey = CatalogMessageRequest<'intake'>['key'];
type StatusMessage = { readonly key: IntakeKey; readonly parameters?: Readonly<Record<string, string>> };

export type IntakeMessageResolver = (input: CatalogMessageRequest<'intake'>) => CatalogResolution;

type IntakeResponse = {
  id?: string;
  kind?: IntakeKind;
  state?: 'draft' | 'submitted' | 'routed' | 'closed';
  answers?: Answers;
  disclaimer_acknowledged?: boolean;
  routed_to_partner_category?: string;
};

const legalTopics = [
  ['housing', 'topic.legal.housing'], ['benefits', 'topic.legal.benefits'],
  ['consumer', 'topic.legal.consumer'], ['family', 'topic.legal.family'],
  ['documents', 'topic.legal.documents'], ['other', 'topic.legal.other'],
] as const;
const healthTopics = [
  ['find_care', 'topic.health.find_care'], ['appointments', 'topic.health.appointments'],
  ['insurance', 'topic.health.insurance'], ['home_support', 'topic.health.home_support'],
  ['prescriptions', 'topic.health.prescriptions'], ['other', 'topic.health.other'],
] as const;

function readAnswers(form: HTMLFormElement): Answers {
  const data = new FormData(form);
  const answers: Answers = {};
  for (const [key, value] of data.entries()) {
    if (key !== 'disclaimer_acknowledged' && typeof value === 'string' && value.trim() !== '') answers[key] = value.trim();
  }
  return answers;
}

function formatMessage(value: CatalogResolution, parameters?: Readonly<Record<string, string>>): CatalogResolution {
  if (parameters === undefined || !value.found) return value;
  return {
    ...value,
    text: Object.entries(parameters).reduce(
      (text, [name, replacement]) => text.replaceAll(`{${name}}`, replacement), value.text,
    ),
  };
}

function CatalogText({ affordanceId, value }: {
  readonly affordanceId?: string | undefined;
  readonly value: CatalogResolution;
}) {
  if (!value.found) return null;
  return <span
    aria-describedby={value.affordance === null ? undefined : affordanceId}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale}
  >{value.text}</span>;
}

function CatalogAffordance({ id, value }: {
  readonly id: string;
  readonly value?: CatalogResolution | undefined;
}) {
  if (value?.found !== true || value.affordance === null) return null;
  return <p data-catalog-affordance={value.renderState} id={id} lang="en" role="note">{value.affordance}</p>;
}

export function IntakeForm({ kind, locale, resolveMessage = resolveCatalogMessage }: {
  readonly kind: IntakeKind;
  readonly locale: Locale;
  readonly resolveMessage?: IntakeMessageResolver;
}) {
  const id = useId();
  const [submissionId, setSubmissionId] = useState<string>();
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [routeCategory, setRouteCategory] = useState<string>();
  const mutationKey = useRef<string | undefined>(undefined);
  const mutationRevision = useRef(0);

  const message = (key: IntakeKey) => resolveMessage({ locale, namespace: 'intake', key });
  const formHeading = message(kind === 'legal' ? 'form.legal_heading' : 'form.health_heading');
  const formIntro = message(kind === 'legal' ? 'form.legal_intro' : 'form.health_intro');
  const topicLabel = message('field.topic');
  const dateLabel = message('field.date');
  const contactLabel = message('field.contact');
  const detailsLabel = message('field.details');
  const detailsHint = message('field.details_hint');
  const answersLegend = message('common.answers');
  const optional = message('common.optional');
  const preferNot = message('common.prefer_not');
  const yes = message('common.yes');
  const no = message('common.no');
  const unknown = message('common.unknown');
  const save = message('common.save');
  const submit = message('common.submit');
  const routed = message('state.routed');
  const statusResolution = status === null ? undefined : formatMessage(message(status.key), status.parameters);
  const topics = (kind === 'legal' ? legalTopics : healthTopics).map(([value, key]) => [value, message(key)] as const);
  const contacts = [
    ['phone', message('contact.phone')], ['text', message('contact.text')], ['email', message('contact.email')],
  ] as const;

  const urgentHeading = message('disclaimer.urgent_heading');
  const urgentBody = message('disclaimer.urgent_body');
  const call911 = message('disclaimer.call_911');
  const call988 = message('disclaimer.call_988');
  const talkPerson = message('disclaimer.talk_person');
  const importantHeading = message('disclaimer.important_heading');
  const disclaimer = message(kind === 'legal' ? 'disclaimer.legal' : 'disclaimer.health');
  const acknowledgement = message(kind === 'legal' ? 'disclaimer.legal_ack' : 'disclaimer.health_ack');
  const saveWithoutAcknowledgement = message('disclaimer.save_without_ack');

  const ordinaryValues = [
    formHeading, formIntro, topicLabel, dateLabel, contactLabel, detailsLabel, detailsHint, answersLegend,
    optional, preferNot, yes, no, unknown, save, submit, routed, statusResolution,
    ...topics.map(([, value]) => value), ...contacts.map(([, value]) => value),
  ].filter((value): value is CatalogResolution => value !== undefined);
  const ordinaryAffordance = ordinaryValues.find(value => value.affordance !== null);
  const ordinaryAffordanceId = `${id}-ordinary-translation-state`;
  const urgentAffordanceId = `${id}-urgent-translation-state`;
  const limitationAffordanceId = `${id}-limitation-translation-state`;

  useEffect(() => {
    const savedId = new URLSearchParams(window.location.search).get('submissionId');
    if (!savedId) return;
    const revision = ++mutationRevision.current;
    setBusy(true);
    fetch(`/api/v1/intake/${encodeURIComponent(savedId)}`)
      .then(async response => {
        if (!response.ok) throw new Error('load failed');
        return response.json() as Promise<IntakeResponse>;
      })
      .then(saved => {
        if (revision !== mutationRevision.current) return;
        if (saved.kind && saved.kind !== kind) throw new Error('wrong form kind');
        const resolvedId = saved.id ?? savedId;
        setSubmissionId(resolvedId);
        setAnswers(saved.answers ?? {});
        setAcknowledged(saved.disclaimer_acknowledged ?? false);
        setRouteCategory(saved.routed_to_partner_category);
        setStatus({ key: 'common.saved_number', parameters: { id: resolvedId } });
      })
      .catch(() => {
        if (revision === mutationRevision.current) setStatus({ key: 'common.load_failed' });
      })
      .finally(() => {
        if (revision === mutationRevision.current) setBusy(false);
      });
    return () => { mutationRevision.current += 1; };
  }, [kind, locale, resolveMessage]);

  async function persist(form: HTMLFormElement, finalSubmission: boolean) {
    if (finalSubmission && !acknowledged) { setStatus({ key: 'common.ack_required' }); return; }
    const revision = ++mutationRevision.current;
    setBusy(true);
    setStatus({ key: finalSubmission ? 'common.submitting' : 'common.saving' });
    const payload = {
      locale, answers: readAnswers(form), disclaimer_acknowledged: acknowledged,
      intent: finalSubmission ? 'submit' : 'save_draft',
    };
    try {
      mutationKey.current ??= globalThis.crypto.randomUUID();
      const response = await fetch(submissionId ? `/api/v1/intake/${encodeURIComponent(submissionId)}` : `/api/v1/intake/${kind}`, {
        method: submissionId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': mutationKey.current },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error('save failed');
      const saved = await response.json() as IntakeResponse;
      if (revision !== mutationRevision.current) return;
      const savedId = saved.id ?? submissionId;
      if (savedId) {
        setSubmissionId(savedId);
        window.history.replaceState(null, '', `/intake/${kind}?submissionId=${encodeURIComponent(savedId)}`);
      }
      setAnswers(payload.answers);
      setRouteCategory(saved.routed_to_partner_category);
      mutationKey.current = undefined;
      setStatus(finalSubmission
        ? { key: 'common.submitted' }
        : savedId ? { key: 'common.saved_number', parameters: { id: savedId } } : { key: 'state.draft' });
    } catch {
      if (revision === mutationRevision.current) setStatus({ key: 'common.save_failed' });
    } finally {
      if (revision === mutationRevision.current) setBusy(false);
    }
  }

  function submitForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void persist(event.currentTarget, true);
  }

  const ordinaryText = (value: CatalogResolution) => <CatalogText
    affordanceId={value.affordance === ordinaryAffordance?.affordance ? ordinaryAffordanceId : undefined}
    value={value}
  />;
  const option = (value: string, resolved: CatalogResolution) => <option
    data-catalog-fallback-reason={resolved.fallbackReason ?? undefined}
    data-catalog-key={`${resolved.namespace}.${resolved.key}`}
    data-catalog-render-state={resolved.renderState}
    key={value}
    lang={resolved.renderedLocale ?? undefined}
    value={value}
  >{resolved.text}</option>;

  return (
    <section aria-labelledby={`${id}-heading`} className={styles.stack}>
      <div>
        <h1 id={`${id}-heading`}>{ordinaryText(formHeading)}</h1>
        <p>{ordinaryText(formIntro)}</p>
        <CatalogAffordance id={ordinaryAffordanceId} value={ordinaryAffordance} />
      </div>
      <aside className={styles.crisisBand} aria-labelledby={`${id}-urgent`}>
        <h2 id={`${id}-urgent`}><CatalogText affordanceId={urgentAffordanceId} value={urgentHeading} /></h2>
        <p><CatalogText affordanceId={urgentAffordanceId} value={urgentBody} /></p>
        <a href="tel:911"><CatalogText affordanceId={urgentAffordanceId} value={call911} /></a>
        <a href="tel:988"><CatalogText affordanceId={urgentAffordanceId} value={call988} /></a>
        <a href="/help"><CatalogText affordanceId={urgentAffordanceId} value={talkPerson} /></a>
        <CatalogAffordance id={urgentAffordanceId} value={urgentHeading} />
      </aside>
      <form aria-busy={busy} className={`ss-card ${styles.form}`} onSubmit={submitForm}>
        <div className={styles.disclaimer} aria-labelledby={`${id}-disclaimer`}>
          <h2 id={`${id}-disclaimer`}><CatalogText affordanceId={limitationAffordanceId} value={importantHeading} /></h2>
          <p><CatalogText affordanceId={limitationAffordanceId} value={disclaimer} /></p>
          <CatalogAffordance id={limitationAffordanceId} value={disclaimer} />
        </div>
        <fieldset className={styles.fields} disabled={busy}>
          <legend>{ordinaryText(answersLegend)}</legend>
          <label className={styles.label} htmlFor={`${id}-topic`}>
            {ordinaryText(topicLabel)}<small>{ordinaryText(optional)}</small>
            <select id={`${id}-topic`} name="topic" value={answers.topic ?? ''} onChange={event => setAnswers(current => ({ ...current, topic: event.target.value }))}>
              {option('', preferNot)}
              {topics.map(([value, resolved]) => option(value, resolved))}
            </select>
          </label>
          <label className={styles.label} htmlFor={`${id}-date`}>
            {ordinaryText(dateLabel)}<small>{ordinaryText(optional)}</small>
            <select id={`${id}-date`} name="date_status" value={answers.date_status ?? ''} onChange={event => setAnswers(current => ({ ...current, date_status: event.target.value }))}>
              {option('', preferNot)}
              {option('yes', yes)}
              {option('no', no)}
              {option('unknown', unknown)}
            </select>
          </label>
          <label className={styles.label} htmlFor={`${id}-contact`}>
            {ordinaryText(contactLabel)}<small>{ordinaryText(optional)}</small>
            <select id={`${id}-contact`} name="contact_method" value={answers.contact_method ?? ''} onChange={event => setAnswers(current => ({ ...current, contact_method: event.target.value }))}>
              {option('', preferNot)}
              {contacts.map(([value, resolved]) => option(value, resolved))}
            </select>
          </label>
          <label className={styles.label} htmlFor={`${id}-details`}>
            {ordinaryText(detailsLabel)}<small>{ordinaryText(detailsHint)}</small>
            <textarea id={`${id}-details`} name="details" value={answers.details ?? ''} onChange={event => setAnswers(current => ({ ...current, details: event.target.value }))} />
          </label>
        </fieldset>
        <label className={styles.acknowledgment}>
          <input name="disclaimer_acknowledged" type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
          <CatalogText affordanceId={limitationAffordanceId} value={acknowledgement} />
        </label>
        <p className={styles.supporting}><CatalogText affordanceId={limitationAffordanceId} value={saveWithoutAcknowledgement} /></p>
        <div className={styles.actions}>
          <button type="button" disabled={busy} onClick={event => { const form = event.currentTarget.form; if (form) void persist(form, false); }}>{ordinaryText(save)}</button>
          <button type="submit" disabled={busy}>{ordinaryText(submit)}</button>
        </div>
        <div className={styles.resume}>
          <p className={styles.status} data-intake-status-key={status?.key} role="status" aria-atomic="true" aria-live="polite">
            {statusResolution === undefined ? null : ordinaryText(statusResolution)}
          </p>
          {routeCategory ? <p><strong>{ordinaryText(routed)}</strong> {routeCategory}.</p> : null}
        </div>
      </form>
    </section>
  );
}

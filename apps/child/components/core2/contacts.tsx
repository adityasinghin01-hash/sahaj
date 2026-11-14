import * as React from 'react';
import { router } from 'expo-router';
import { Btn, Card, Field, Notice, T } from '../sahaj/ui';
import { type Core2Api, type ContactScope, type TrustedContact } from '../../lib/core2';
import { useCore2Mutation, useCore2Read } from '../../lib/useCore2';
import { MutationState, ReadState, stateKey, useCore2Text } from './common';
const load = (api: Core2Api, signal: AbortSignal) => api.contacts({ limit: 50 }, signal);
const SCOPES: ContactScope[] = ['sos', 'watch_escalation', 'reassurance'];
export function ScopePicker({
  scopes,
  setScopes,
  disabled = false,
}: {
  scopes: ContactScope[];
  setScopes: (s: ContactScope[]) => void;
  disabled?: boolean;
}) {
  const t = useCore2Text();
  return (
    <>
      <T>{t('scopes')}</T>
      {SCOPES.map((scope) => (
        <Btn
          key={scope}
          label={`${scopes.includes(scope) ? '✓ ' : ''}${t(scope)}`}
          kind="ghost"
          disabled={disabled}
          onPress={() =>
            setScopes(
              scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope]
            )
          }
        />
      ))}
    </>
  );
}
export function LiveContacts() {
  const live = useCore2Read(load),
    t = useCore2Text();
  return (
    <>
      <T v="title">{t('contacts')}</T>
      <Notice>{t('inviteHelp')}</Notice>
      <ReadState {...live} />
      <Btn label={t('invite')} onPress={() => router.push('/invite')} />
      <Btn label={t('preferences')} kind="ghost" onPress={() => router.push('/permissions')} />
      <Btn label={t('safeTitle')} kind="ghost" onPress={() => router.push('/safe')} />
      {live.data?.contacts.length === 0 ? <Notice>{t('empty')}</Notice> : null}
      {live.data?.contacts.map((contact) => (
        <Contact
          key={`${contact.id}:${contact.version}`}
          contact={contact}
          refresh={live.refresh}
        />
      ))}
    </>
  );
}
function Contact({ contact, refresh }: { contact: TrustedContact; refresh: () => void }) {
  const t = useCore2Text(),
    action = useCore2Mutation();
  const [rank, setRank] = React.useState(String(contact.rank));
  const [scopes, setScopes] = React.useState(contact.scopes);
  const [until, setUntil] = React.useState(contact.effective_until ?? '');
  const [invalid, setInvalid] = React.useState(false);
  const [result, setResult] = React.useState<TrustedContact | null>(null);
  const current = result && result.version > contact.version ? result : contact;
  const complete = (value: { contact: TrustedContact }) => {
    setResult(value.contact);
    refresh();
  };
  return (
    <Card className="mt-4">
      <T v="h2">{contact.display_name}</T>
      <T>{t(current.state === 'active' ? 'contactActive' : stateKey(current.state))}</T>
      <T selectable>{contact.contact_person_id}</T>
      {current.state !== 'revoked' ? (
        <>
          <Field
            label={t('rank')}
            value={rank}
            onChangeText={setRank}
            keyboardType="number-pad"
            maxLength={2}
          />
          <Field label={t('until')} value={until} onChangeText={setUntil} autoCapitalize="none" />
          <ScopePicker scopes={scopes} setScopes={setScopes} disabled={action.blocked} />
          {invalid ? <Notice>{t('invalid')}</Notice> : null}
          <Btn
            label={t('saveContact')}
            disabled={action.blocked}
            onPress={() => {
              const n = Number(rank);
              if (
                !Number.isInteger(n) ||
                n < 1 ||
                n > 20 ||
                !scopes.length ||
                (until && !Number.isFinite(Date.parse(until)))
              ) {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              const input = {
                rank: n,
                scopes: [...scopes],
                effective_until: until ? new Date(until).toISOString() : null,
                expected_version: current.version,
              };
              void action.run((api, key) => api.updateContact(contact.id, input, key), complete);
            }}
          />
          {['invited', 'pending_consent'].includes(current.state) ? (
            <Btn
              label={t('approve')}
              kind="teal"
              disabled={action.blocked}
              onPress={() => {
                void action.run((api, key) => api.approveContact(contact.id, {}, key), complete);
              }}
            />
          ) : null}
          <Btn
            label={t('revoke')}
            kind="ghost"
            disabled={action.blocked}
            onPress={() => {
              void action.run(
                (api, key) =>
                  api.revokeContact(contact.id, { expected_version: current.version }, key),
                complete
              );
            }}
          />
        </>
      ) : null}
      <MutationState action={action} />
    </Card>
  );
}
export function LiveInvite() {
  const t = useCore2Text(),
    action = useCore2Mutation();
  const [person, setPerson] = React.useState(''),
    [rank, setRank] = React.useState('1');
  const [scopes, setScopes] = React.useState<ContactScope[]>([
    'sos',
    'watch_escalation',
    'reassurance',
  ]);
  const [until, setUntil] = React.useState('');
  const [result, setResult] = React.useState<TrustedContact | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  return (
    <>
      <Notice>{t('inviteHelp')}</Notice>
      <Card>
        <Field
          label={t('person')}
          value={person}
          onChangeText={setPerson}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label={t('rank')}
          value={rank}
          onChangeText={setRank}
          keyboardType="number-pad"
          maxLength={2}
        />
        <Field label={t('until')} value={until} onChangeText={setUntil} autoCapitalize="none" />
        <ScopePicker scopes={scopes} setScopes={setScopes} disabled={action.blocked} />
        {invalid ? <Notice>{t('invalid')}</Notice> : null}
        <Btn
          label={t('invite')}
          disabled={action.blocked || !!result}
          onPress={() => {
            const n = Number(rank);
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                person.trim()
              ) ||
              !Number.isInteger(n) ||
              n < 1 ||
              n > 20 ||
              !scopes.length ||
              (until && !Number.isFinite(Date.parse(until)))
            ) {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            const input = {
              contact_person_id: person.trim(),
              rank: n,
              scopes: [...scopes],
              effective_until: until ? new Date(until).toISOString() : null,
            };
            void action.run(
              (api, key) => api.inviteContact(input, key),
              (value) => setResult(value.contact)
            );
          }}
        />
      </Card>
      {result ? (
        <Notice>{t(result.state === 'active' ? 'contactActive' : stateKey(result.state))}</Notice>
      ) : null}
      <MutationState action={action} />
    </>
  );
}

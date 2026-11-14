import { Core2Gate } from '@/components/core2/common';
import { LiveInvite } from '@/components/core2/contacts';
import { Btn, Card, Field, Notice, Pop, Screen, T, TopBar } from '@/components/sahaj/ui';
import { circleSettings, updateDemo, useDemo } from '@/lib/demo';
import * as React from 'react';
function DemoInvite() {
  const demo = useDemo();
  const [name, setName] = React.useState(circleSettings.invite.name);
  const [role, setRole] = React.useState(circleSettings.invite.role);
  const [city, setCity] = React.useState(circleSettings.invite.city);
  const [error, setError] = React.useState(false);
  React.useEffect(() => {
    setName(circleSettings.invite.name);
    setRole(circleSettings.invite.role);
    setCity(circleSettings.invite.city);
    setError(false);
  }, [demo.revision]);
  return (
    <Screen>
      <TopBar title="Add someone" />
      <Pop>
        <T v="title">A familiar face</T>
        <T v="body" className="mt-2">
          {circleSettings.approval}
        </T>
        <Card className="mt-5">
          <Field label="Name" value={name} onChangeText={setName} />
          <Field label="Relationship" value={role} onChangeText={setRole} />
          <Field label="City" value={city} onChangeText={setCity} />
        </Card>
      </Pop>
      {demo.pendingInvite ? (
        <Notice tone="brand">
          {demo.pendingInvite} is waiting. Sahaj will ask Maa on her next call.
        </Notice>
      ) : (
        <>
          <Btn
            label="Ask Maa"
            className="mt-6"
            onPress={() => {
              if (!name.trim() || !role.trim() || !city.trim()) {
                setError(true);
                return;
              }
              setError(false);
              updateDemo({ pendingInvite: `${name.trim()} · ${role.trim()} · ${city.trim()}` });
            }}
          />
          {error ? <Notice tone="sand">Please fill in all three details.</Notice> : null}
        </>
      )}
      <T v="small" className="mt-4">
        Demo invitation only · nobody is contacted.
      </T>
    </Screen>
  );
}

export default function Invite() {
  return <Core2Gate title="invite" demo={<DemoInvite />}><LiveInvite /></Core2Gate>;
}

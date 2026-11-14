// Live "Maa heard it" badge: asks GET /api/core2/heard for one delivery and renders HeardBadge.
// Shows "sent, not confirmed" while loading or on any error; never marks heard on a timer.
import * as React from 'react';
import { HeardBadge } from './heard-badge';
import { fetchHeardStatus, type HeardStatus } from '@/lib/core2-news';
import { useSession } from '@/lib/session';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function LiveHeardBadge({
  deliveryId,
  messageKind,
}: {
  deliveryId: string;
  messageKind: HeardStatus['message_kind'];
}) {
  const { session } = useSession();
  const [status, setStatus] = React.useState<HeardStatus | null>(null);
  React.useEffect(() => {
    if (!session || !UUID.test(deliveryId)) return;
    let active = true;
    fetchHeardStatus(session, deliveryId, messageKind)
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session, deliveryId, messageKind]);
  return (
    <HeardBadge
      heardVerified={status?.heard_verified ?? false}
      heardAt={status?.heard_at}
      badgeLabel={status?.badge_label}
      evidenceType={status?.evidence_type ?? undefined}
    />
  );
}

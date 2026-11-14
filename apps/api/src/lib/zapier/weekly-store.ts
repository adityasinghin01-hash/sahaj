import type { SupabaseClient } from '@supabase/supabase-js';
import type { WeeklyScope, WeeklyStore } from './weekly';

export function weeklyStore(db: SupabaseClient): WeeklyStore {
  return {
    async scopeIsLive(scope: WeeklyScope) {
      const [member,parent] = await Promise.all([
        db.from('family_memberships').select('person_id').eq('family_id',scope.familyId).eq('person_id',scope.requesterId).eq('role','child').is('revoked_at',null).maybeSingle(),
        db.from('people').select('id').eq('family_id',scope.familyId).eq('id',scope.parentId).eq('role','parent').maybeSingle(),
      ]);
      if (member.error || parent.error) throw new Error('scope_lookup_failed');
      return !!member.data && !!parent.data;
    },
    async timeline(scope,start,end) {
      // Metadata, content previews, payloads, phones, names and recordings never enter the report reader.
      const {data,error} = await db.from('timeline_events').select('id,family_id,event_type,created_at')
        .eq('family_id',scope.familyId).gte('created_at',start).lt('created_at',end).order('created_at').order('id').limit(1001);
      if (error || !data) throw new Error('timeline_lookup_failed');
      return data.map(r => ({id:r.id,familyId:r.family_id,eventType:r.event_type,createdAt:r.created_at,source:'signed_timeline'}));
    },
  };
}

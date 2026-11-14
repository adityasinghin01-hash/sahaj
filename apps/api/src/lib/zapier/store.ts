import type { SupabaseClient } from '@supabase/supabase-js';
import type { SignedTimelineEvent } from '../timeline';
import type { ZapierStore } from './outbox';

export function zapierStore(db:SupabaseClient):ZapierStore {
  return {
    async source(family,id) {
      const {data,error}=await db.from('timeline_events').select('envelope_canonical,payload_canonical,chain_hash,signature')
        .eq('family_id',family).eq('id',id).maybeSingle();
      if(error)throw new Error('timeline_read_failed');
      if(!data)return null;
      const signed:SignedTimelineEvent={envelope:JSON.parse(data.envelope_canonical),chainHash:data.chain_hash,signature:data.signature};
      return {signed,payload:JSON.parse(data.payload_canonical)};
    },
    async enqueue(input) {
      const {data,error}=await db.rpc('enqueue_zapier_outbox',{p_family:input.family,p_timeline:input.timeline,p_channel:input.channel,
        p_hash:input.hash,p_ciphertext:input.ciphertext,p_chain_hash:input.chainHash});
      if(error || typeof data!=='string')throw new Error('zapier_enqueue_failed');
      return data;
    },
    async claim(worker,channels,limit) {
      const {data,error}=await db.rpc('claim_zapier_outbox',{p_worker:worker,p_channels:channels,p_limit:limit});
      if(error || !Array.isArray(data))throw new Error('zapier_claim_failed');
      return data;
    },
    async finish(row,success,code) {
      const {data,error}=await db.rpc('finish_outbox',{p_outbox_id:row.id,p_lease_token:row.lease_token,p_success:success,p_error_code:code});
      if(error)throw new Error('zapier_finish_failed');
      return data===true;
    },
  };
}

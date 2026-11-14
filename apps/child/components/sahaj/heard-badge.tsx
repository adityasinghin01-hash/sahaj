import React from "react";
import { View } from "react-native";
import { LevelPill, T } from "./ui";
import {
  BADGE_UNCONFIRMED_HI,
  formatHeardBadgeLabel,
  type HeardStatus,
} from "../../lib/core2-news";

export interface HeardBadgeProps {
  /** Verified heard timestamp ISO string (null/undefined if unconfirmed). */
  heardAt?: string | null;
  /** Explicit boolean override when using a pre-fetched DTO. */
  heardVerified?: boolean;
  /** Pre-formatted server badge label ("Maa ne suna ✓ 01:12" or "Bheja gaya — sunna confirm nahi"). */
  badgeLabel?: string | null;
  /** Optional channel/evidence caption for transparency. */
  evidenceType?: HeardStatus["evidence_type"];
  /** Optional recipient timezone (defaults to Asia/Kolkata). */
  timezone?: string;
}

const EVIDENCE_CAPTION: Record<NonNullable<HeardStatus["evidence_type"]>, string> = {
  device_signed_playback_end: "Maa ke phone par poora suna gaya",
  twilio_gather_after_playback: "Keypad call par sunne ke baad button dabaya",
  twilio_status_duration_gte_clip: "Keypad call par poori recording tak line par rahin",
};

/**
 * Displays verified "Maa heard it" proof in Riya's app:
 * - Verified: "Maa ne suna ✓ 01:12" (green pill)
 * - Unconfirmed: "Bheja gaya — sunna confirm nahi" (amber watch pill)
 *
 * Never marks a message heard on a timer; relies strictly on server-verified receipts.
 */
export function HeardBadge({
  heardAt,
  heardVerified,
  badgeLabel,
  evidenceType,
  timezone = "Asia/Kolkata",
}: HeardBadgeProps) {
  const isVerified = Boolean(heardVerified ?? heardAt);
  const label = isVerified
    ? badgeLabel && badgeLabel.startsWith("Maa ne suna")
      ? badgeLabel
      : formatHeardBadgeLabel(heardAt, timezone)
    : BADGE_UNCONFIRMED_HI;

  const caption = isVerified && evidenceType ? EVIDENCE_CAPTION[evidenceType] : null;

  return (
    <View className="items-start">
      <LevelPill level={isVerified ? "green" : "yellow"} label={label} />
      {caption ? (
        <T v="small" className="mt-1 text-ink-soft">
          {caption}
        </T>
      ) : null}
    </View>
  );
}

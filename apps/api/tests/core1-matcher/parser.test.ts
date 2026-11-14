import { describe, expect, it } from 'vitest';
import {
  UNKNOWN_FREE_TIME_LINE,
  parseHindiFreeTime,
} from '@/lib/core1-matcher/parser';

describe('parseHindiFreeTime', () => {
  it('parses the Build Bible C3 example "shaam 6 ke baad free hoon"', () => {
    const res = parseHindiFreeTime('shaam 6 ke baad free hoon');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.startTime).toBe('18:00');
    expect(res.endTime).toBe('20:00');
    expect(res.startMinute).toBe(1080);
    expect(res.endMinute).toBe(1200);
    expect(res.readBackLine).toBe('Theek hai, aap shaam 6 se 8 baje tak free hain.');
  });

  it('parses explicit ranges across subah, dopahar, shaam, raat, and bare numbers', () => {
    const subah = parseHindiFreeTime('subah 9 se 11 baje tak');
    expect(subah.ok).toBe(true);
    if (subah.ok) {
      expect(subah.startTime).toBe('09:00');
      expect(subah.endTime).toBe('11:00');
      expect(subah.readBackLine).toBe('Theek hai, aap subah 9 se 11 baje tak free hain.');
    }

    const dopahar = parseHindiFreeTime('dopahar 2 se 4');
    expect(dopahar.ok).toBe(true);
    if (dopahar.ok) {
      expect(dopahar.startTime).toBe('14:00');
      expect(dopahar.endTime).toBe('16:00');
    }

    const bare = parseHindiFreeTime('4 se 6');
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.startTime).toBe('16:00');
      expect(bare.endTime).toBe('18:00');
    }

    const raat = parseHindiFreeTime('raat 8 se 10');
    expect(raat.ok).toBe(true);
    if (raat.ok) {
      expect(raat.startTime).toBe('20:00');
      expect(raat.endTime).toBe('22:00');
    }
  });

  it('parses bare "6 ke baad" and cross-noon "subah 10 se 1"', () => {
    const afterSix = parseHindiFreeTime('6 ke baad');
    expect(afterSix.ok).toBe(true);
    if (afterSix.ok) {
      expect(afterSix.startTime).toBe('18:00');
      expect(afterSix.endTime).toBe('20:00');
    }

    const crossNoon = parseHindiFreeTime('subah 10 se 1');
    expect(crossNoon.ok).toBe(true);
    if (crossNoon.ok) {
      expect(crossNoon.startTime).toBe('10:00');
      expect(crossNoon.endTime).toBe('13:00');
    }
  });

  it('parses meal and routine anchors with sensible defaults', () => {
    const lunch = parseHindiFreeTime('khaana khaane ke baad free hoon');
    expect(lunch.ok).toBe(true);
    if (lunch.ok) {
      expect(lunch.startTime).toBe('14:00');
      expect(lunch.endTime).toBe('16:00');
      expect(lunch.confidence).toBe('routine_anchor');
    }

    const dinner = parseHindiFreeTime('raat ko khaana khaane ke baad');
    expect(dinner.ok).toBe(true);
    if (dinner.ok) {
      expect(dinner.startTime).toBe('21:00');
      expect(dinner.endTime).toBe('22:30');
    }

    const chai = parseHindiFreeTime('chai ke baad');
    expect(chai.ok).toBe(true);
    if (chai.ok) {
      expect(chai.startTime).toBe('17:00');
      expect(chai.endTime).toBe('19:00');
    }

    const pooja = parseHindiFreeTime('pooja ke baad');
    expect(pooja.ok).toBe(true);
    if (pooja.ok) {
      expect(pooja.startTime).toBe('09:00');
      expect(pooja.endTime).toBe('11:00');
    }
  });

  it('parses Hindi half/quarter modifiers and Devanagari script', () => {
    const sadhe = parseHindiFreeTime('shaam sadhe 5 se 7');
    expect(sadhe.ok).toBe(true);
    if (sadhe.ok) {
      expect(sadhe.startTime).toBe('17:30');
      expect(sadhe.endTime).toBe('19:00');
    }

    const paune = parseHindiFreeTime('shaam paune 7 se 8');
    expect(paune.ok).toBe(true);
    if (paune.ok) {
      expect(paune.startTime).toBe('18:45');
      expect(paune.endTime).toBe('20:00');
    }

    const devanagari = parseHindiFreeTime('शाम ६ के बाद फ्री हूँ');
    expect(devanagari.ok).toBe(true);
    if (devanagari.ok) {
      expect(devanagari.startTime).toBe('18:00');
      expect(devanagari.endTime).toBe('20:00');
    }

    const devLunch = parseHindiFreeTime('खाना खाने के बाद');
    expect(devLunch.ok).toBe(true);
    if (devLunch.ok) {
      expect(devLunch.startTime).toBe('14:00');
      expect(devLunch.endTime).toBe('16:00');
    }
  });

  it('parses period-only utterances', () => {
    const subah = parseHindiFreeTime('subah free hoon');
    expect(subah.ok).toBe(true);
    if (subah.ok) {
      expect(subah.startTime).toBe('09:00');
      expect(subah.endTime).toBe('12:00');
    }

    const shaam = parseHindiFreeTime('shaam ko');
    expect(shaam.ok).toBe(true);
    if (shaam.ok) {
      expect(shaam.startTime).toBe('17:00');
      expect(shaam.endTime).toBe('20:00');
    }
  });

  it('returns ask-again line on unknown, empty, or negative inputs and strips 4+ digit runs', () => {
    const empty = parseHindiFreeTime('   ');
    expect(empty).toEqual({
      ok: false,
      reason: 'empty_input',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    });

    const negative = parseHindiFreeTime('aaj free nahi hoon');
    expect(negative).toEqual({
      ok: false,
      reason: 'no_free_time',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    });

    const unknown = parseHindiFreeTime('hello beta kaise ho');
    expect(unknown).toEqual({
      ok: false,
      reason: 'unknown_time_window',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    });

    const withDigits = parseHindiFreeTime('mera number 9876543210 hai');
    expect(withDigits.ok).toBe(false);
    expect(withDigits.readBackLine).not.toContain('9876543210');
  });
});

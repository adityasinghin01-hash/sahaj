import { afterEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  platform: { OS: "android" },
  play: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: fake.platform }));
vi.mock("../modules/sahaj-shield", () => ({
  default: { playWarningLine: fake.play, stopWarningAudio: fake.stop },
  SHIELD_FEATURES: [],
}));
import { shield } from "../src/lib/shield";
afterEach(() => {
  vi.clearAllMocks();
});
describe("warning audio native port", () => {
  it("sends a fixed line with no invented drill outcome", () => {
    shield.playWarningLine(1);
    expect(fake.play).toHaveBeenCalledWith(1, null);
  });
  it.each([true, false])(
    "preserves drill handled=%s for native 9a/9b selection",
    (handled) => {
      shield.playWarningLine(9, handled);
      expect(fake.play).toHaveBeenCalledWith(9, handled);
    },
  );
  it("stops native audio when a preview is dismissed", () => {
    shield.stopWarningAudio();
    expect(fake.stop).toHaveBeenCalledOnce();
  });
  it("keeps the visual warning usable if the native player is unavailable", () => {
    fake.play.mockImplementationOnce(() => {
      throw new Error("native unavailable");
    });
    expect(() => shield.playWarningLine(1)).not.toThrow();
  });
});

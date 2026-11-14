import { ShieldAction } from "@sahaj/shared";
import type { ShieldRuntimePorts } from "@sahaj/shield";

export function createGatePort(sign: ShieldRuntimePorts["sign"]): ShieldRuntimePorts["gate"] {
  return {
    async check(input) {
      const parsed = ShieldAction.safeParse(input.action);
      const allowed = parsed.success;
      try {
        await sign({
          familyId: input.familyId,
          type: "shield.gate.check",
          line: allowed
            ? `Allowed Shield safety action "${String(input.action)}".`
            : `Denied non-Shield action "${String(input.action)}".`,
          data: { action: String(input.action), allowed },
        });
      } catch {
        // Signing failure during standalone gate check should fail closed.
        return { allowed: false };
      }
      return { allowed };
    },
  };
}


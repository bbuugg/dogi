"use client";

import { ClientRoot as SharedClientRoot } from "@fizz/agent-kit/shell/client-root";
import { useDeepLink } from "@/app/layout/use-deep-link";

export function ClientRoot() {
  useDeepLink();
  return <SharedClientRoot />;
}

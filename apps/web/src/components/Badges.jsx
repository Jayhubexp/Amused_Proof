import { Badge } from '@mantine/core';

/** Honest labelling: every claim about security posture is explicit. */
export function SimulatedBadge() {
  return (
    <Badge color="orange" variant="light" size="sm">
      Simulated
    </Badge>
  );
}

export function EnforcedBadge() {
  return (
    <Badge color="teal" variant="light" size="sm">
      Enforced
    </Badge>
  );
}

export function FictionalBadge() {
  return (
    <Badge color="gray" variant="light" size="sm">
      Fictional data
    </Badge>
  );
}

export function LiveBadge() {
  return (
    <Badge color="green" variant="light" size="sm">
      Live model
    </Badge>
  );
}

export function RulesOnlyBadge() {
  return (
    <Badge color="gray" variant="outline" size="sm">
      Rules only
    </Badge>
  );
}

export function ZKBadge() {
  return (
    <Badge color="teal" variant="outline" size="sm">
      ZK verified
    </Badge>
  );
}

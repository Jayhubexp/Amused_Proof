import { Link } from 'react-router-dom';
import {
  Accordion,
  Alert,
  Button,
  Card,
  Group,
  List,
  SimpleGrid,
  Text,
  Title,
} from '@mantine/core';

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e6b5e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

function BallotIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e6b5e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 8h14l1 12H4L5 8z" />
      <path d="M3 8h18" />
      <path d="m10 12 1.5 1.5L15 10" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0e6b5e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0e6b5e" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function DashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#868e96" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

const STEPS = [
  {
    icon: <ShieldIcon />,
    title: 'Verify',
    text: 'Authenticate with a WebAuthn passkey — fingerprint, device PIN, or security key.',
    linkTo: '/vote',
    linkLabel: 'Start verification',
  },
  {
    icon: <BallotIcon />,
    title: 'Participate',
    text: 'Submit a fictional demo ballot. Vote privacy here is experimental, not proven.',
    linkTo: '/vote',
    linkLabel: 'Cast a demo ballot',
  },
  {
    icon: <SearchIcon />,
    title: 'Investigate',
    text: 'Explore audit records with deterministic checks and Meta AI-powered analysis.',
    linkTo: '/integrity',
    linkLabel: 'Open analysis',
  },
];

const CAPABILITIES = [
  {
    title: 'WebAuthn passkey authentication',
    text: 'Phishing-resistant sign-in verified with an established library. No passwords, no biometric storage.',
  },
  {
    title: 'Server-enforced duplicate rejection',
    text: 'Each passkey maps to one nullifier; repeat submissions are rejected and logged.',
  },
  {
    title: 'Public audit explorer',
    text: 'Every election event is published as an inspectable record — hashes only, never identities.',
  },
  {
    title: 'Muse Spark integrity analysis',
    text: 'Deterministic rules plus read-only Meta AI interpretation of the audit trail.',
  },
];

const IMPLEMENTED = [
  'Real WebAuthn attestation and assertion verification',
  'Server-side duplicate submission rejection',
  'Session-bound demo voting with CSRF protection',
  'Server-published audit records',
  'Live Muse Spark analysis when an API key is configured',
];

const EXPERIMENTAL = [
  'Official voter eligibility verification',
  'Cryptographically anonymous voting',
  'Zero-knowledge proofs',
  'Blockchain anchoring',
  'Independently verifiable tallying',
];

export function Landing() {
  return (
    <div>
      {/* Hero */}
      <section aria-labelledby="hero-heading" className="max-w-2xl">
        <Text size="sm" fw={600} className="text-civic-accent">
          Election integrity research
        </Text>
        <Title
          id="hero-heading"
          order={1}
          mt="sm"
          className="text-4xl font-semibold tracking-tight text-civic-ink md:text-5xl"
        >
          Explore the future of verifiable voting.
        </Title>
        <Text size="lg" c="dimmed" mt="md">
          CivicProof AI is an experimental platform exploring passkey-based digital voting,
          privacy-preserving election technologies and AI-assisted audit intelligence.
        </Text>
        <Group mt="lg">
          <Button component={Link} to="/elections" color="teal" size="md">
            Explore demo elections
          </Button>
          <Button component={Link} to="/integrity" variant="outline" color="dark" size="md">
            View integrity dashboard
          </Button>
        </Group>
      </section>

      {/* Research notice */}
      <section aria-label="Research notice" className="mt-12 md:mt-16">
        <div className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Text size="sm" c="dimmed">
            Research prototype using fictional elections. Not approved for real-world election use.
          </Text>
          <a href="#transparency" className="shrink-0 text-sm font-medium text-civic-accent no-underline hover:underline">
            Detailed limitations
          </a>
        </div>
      </section>

      {/* How it works */}
      <section aria-labelledby="how-it-works" className="mt-16 md:mt-24">
        <Title id="how-it-works" order={2} className="text-2xl font-semibold tracking-tight text-civic-ink md:text-3xl">
          How it works
        </Title>
        <Text c="dimmed" mt="xs" className="max-w-2xl">
          Three steps take you from authentication to evidence — all against fictional demo data.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }} mt="lg" spacing="md">
          {STEPS.map((step, i) => (
            <Card key={step.title} withBorder radius="lg" padding="lg" className="bg-white">
              <Group justify="space-between" align="flex-start">
                {step.icon}
                <Text size="sm" fw={600} c="dimmed">
                  0{i + 1}
                </Text>
              </Group>
              <Title order={3} size="h4" mt="md">
                {step.title}
              </Title>
              <Text size="sm" c="dimmed" mt="xs" style={{ minHeight: 60 }}>
                {step.text}
              </Text>
              <Link to={step.linkTo} className="mt-2 inline-block text-sm font-medium text-civic-accent no-underline hover:underline">
                {step.linkLabel} →
              </Link>
            </Card>
          ))}
        </SimpleGrid>
      </section>

      {/* Capabilities */}
      <section aria-labelledby="capabilities" className="mt-16 md:mt-24">
        <Title id="capabilities" order={2} className="text-2xl font-semibold tracking-tight text-civic-ink md:text-3xl">
          Core capabilities
        </Title>
        <Text c="dimmed" mt="xs" className="max-w-2xl">
          What the prototype actually does today — described without production-security promises.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg" spacing="md">
          {CAPABILITIES.map((capability) => (
            <Card key={capability.title} withBorder radius="lg" padding="lg" className="bg-white">
              <Title order={3} size="h4">
                {capability.title}
              </Title>
              <Text size="sm" c="dimmed" mt="xs">
                {capability.text}
              </Text>
            </Card>
          ))}
        </SimpleGrid>
      </section>

      {/* Transparency */}
      <section aria-labelledby="transparency-heading" id="transparency" className="mt-16 scroll-mt-24 md:mt-24">
        <Title id="transparency-heading" order={2} className="text-2xl font-semibold tracking-tight text-civic-ink md:text-3xl">
          Technical transparency
        </Title>
        <Text c="dimmed" mt="xs" className="max-w-2xl">
          Server-enforced controls are checks this server performs. They are not independently
          verified security guarantees — no external party validates this prototype&apos;s claims.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg" spacing="md">
          <Card withBorder radius="lg" padding="lg" className="bg-white">
            <Title order={3} size="h4">
              Implemented in this prototype
            </Title>
            <List mt="md" spacing="sm" size="sm" icon={<CheckIcon />}>
              {IMPLEMENTED.map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
          </Card>
          <Card withBorder radius="lg" padding="lg" className="bg-white">
            <Title order={3} size="h4">
              Experimental / not yet implemented
            </Title>
            <List mt="md" spacing="sm" size="sm" icon={<DashIcon />}>
              {EXPERIMENTAL.map((item) => (
                <List.Item key={item}>{item}</List.Item>
              ))}
            </List>
          </Card>
        </SimpleGrid>
        <Accordion variant="separated" mt="md" radius="md">
          <Accordion.Item value="scope">
            <Accordion.Control>Full technical scope and limitations</Accordion.Control>
            <Accordion.Panel>
              <Text size="sm" c="dimmed">
                Authentication is real WebAuthn: the server verifies attestations and
                assertions (challenge, origin, RP ID, signature, user verification, counter)
                using an established library, keeps single-use short-lived challenges, and
                binds demo ballots to server-side sessions. Duplicate submissions are
                rejected by nullifier and logged to a server-published audit trail.
              </Text>
              <Text size="sm" c="dimmed" mt="sm">
                Limits: eligibility is a fictional roll with demo PINs, not identity proof.
                Ballot commitments are salted hashes that a small candidate set leaves
                brute-forceable — genuine voter anonymity needs zero-knowledge proofs that
                are not implemented. Nothing is anchored on-chain, tallies are not
                independently verifiable, and the AI assistant explains evidence but never
                rules on validity or fraud.
              </Text>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </section>

      {/* Final CTA */}
      <section aria-labelledby="cta-heading" className="mt-16 md:mt-24">
        <div className="rounded-xl bg-civic-ink px-6 py-10 md:px-12 md:py-14">
          <Title id="cta-heading" order={2} className="max-w-xl text-2xl font-semibold tracking-tight text-white md:text-3xl">
            Explore CivicProof in action.
          </Title>
          <Text mt="xs" className="max-w-xl text-stone-300">
            Walk through a fictional election, cast a demo ballot, and inspect the public
            audit trail it leaves behind.
          </Text>
          <Group mt="lg">
            <Button component={Link} to="/elections" color="teal" size="md">
              Open demo elections
            </Button>
            <Button component={Link} to="/audit" variant="outline" color="gray" size="md">
              Inspect audit trail
            </Button>
          </Group>
        </div>
      </section>

      {/* Prototype reminder */}
      <Alert color="gray" variant="light" mt="xl" title="Research prototype">
        CivicProof AI demonstrates concepts with fictional data. It is not operational
        election infrastructure and must not be used for real votes.
      </Alert>
    </div>
  );
}

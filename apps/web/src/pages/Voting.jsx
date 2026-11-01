import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Radio,
  SegmentedControl,
  Select,
  Stepper,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { apiGet, apiPost, sha256Hex } from '../lib/api';
import { elections as fixtureElections, demoRoll } from '../fixtures/fictional';
import { EnforcedBadge, FictionalBadge, SimulatedBadge, ZKBadge } from '../components/Badges';
import { AnonymousBallot } from '../components/AnonymousBallot';

const webauthnSupported = browserSupportsWebAuthn();

export function Voting() {
  const [params] = useSearchParams();
  const [elections, setElections] = useState(null);
  const [offline, setOffline] = useState(false);
  const [electionId, setElectionId] = useState(params.get('election') ?? '');
  const [step, setStep] = useState(0);
  const [voterRef, setVoterRef] = useState(params.get('voter') ?? '');
  const [pin, setPin] = useState('');
  const [registered, setRegistered] = useState(false);
  const [csrfToken, setCsrfToken] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [ballotMode, setBallotMode] = useState('standard');
  const [status, setStatus] = useState({ kind: 'idle', message: '' });
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    apiGet('/api/elections')
      .then((data) => {
        setElections(data.elections);
        if (!params.get('election')) {
          const firstOpen = data.elections.find((e) => ['open', 'enrolment', 'frozen', 'voting'].includes(e.status));
          if (firstOpen) setElectionId(firstOpen.id);
        }
      })
      .catch(() => {
        setElections(fixtureElections);
        setOffline(true);
      });
  }, [params]);

  const election = useMemo(
    () => elections?.find((e) => e.id === electionId) ?? null,
    [elections, electionId],
  );

  // Suggest the election's configured path; the server enforces the mode and
  // rejects the other path with a clear error if the voter switches.
  useEffect(() => {
    if (election?.votingMode === 'anonymous') setBallotMode('anonymous');
    else if (election?.votingMode === 'standard') setBallotMode('standard');
  }, [election]);
  const rollForElection = useMemo(
    () => demoRoll.filter((v) => v.electionId === electionId),
    [electionId],
  );

  function resetAfterElectionChange(id) {
    setElectionId(id);
    setStep(0);
    setVoterRef('');
    setPin('');
    setRegistered(false);
    setCsrfToken('');
    setCandidateId('');
    setBallotMode('standard');
    setReceipt(null);
    setStatus({ kind: 'idle', message: '' });
  }

  function fail(message) {
    // Browser abort (user cancelled the authenticator prompt) is routine.
    const cancelled = /abort|cancel|not allowed/i.test(message);
    setStatus({
      kind: 'error',
      message: cancelled
        ? 'The authenticator prompt was dismissed. Try again when ready.'
        : message,
    });
  }

  async function registerPasskey() {
    setStatus({ kind: 'working', message: 'Starting passkey registration…' });
    try {
      const { requestId, options } = await apiPost('/api/webauthn/register/options', {
        electionId,
        voterRef: voterRef.trim().toUpperCase(),
        pin,
      });
      setStatus({ kind: 'working', message: 'Follow your browser prompt to create the passkey…' });
      const attestation = await startRegistration({ optionsJSON: options });
      await apiPost('/api/webauthn/register/verify', { requestId, response: attestation });
      setRegistered(true);
      setStep(1);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(err.message);
    }
  }

  async function authenticate() {
    setStatus({ kind: 'working', message: 'Requesting authentication challenge…' });
    try {
      const { requestId, options } = await apiPost('/api/webauthn/auth/options', {
        electionId,
        voterRef: voterRef.trim().toUpperCase(),
      });
      setStatus({ kind: 'working', message: 'Follow your browser prompt to authenticate…' });
      const assertion = await startAuthentication({ optionsJSON: options });
      const verified = await apiPost('/api/webauthn/auth/verify', {
        requestId,
        response: assertion,
      });
      setCsrfToken(verified.csrfToken);
      setStep(2);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(err.message);
    }
  }

  async function castBallot() {
    setStatus({ kind: 'working', message: 'Sealing ballot and submitting…' });
    try {
      // The choice is hashed client-side with the session CSRF token as salt so
      // the server stores a commitment, never a plaintext vote. Prototype
      // honesty note: ballot privacy against the server itself is SIMULATED —
      // a small candidate set is brute-forceable, and real anonymity needs
      // zero-knowledge proofs (a future phase).
      const ballotCommitment = await sha256Hex(`${candidateId}:${csrfToken}:${electionId}`);
      const res = await apiPost(
        '/api/ballots',
        { electionId, ballotCommitment },
        { csrfToken },
      );
      setReceipt(res.ballot);
      setStep(3);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      setStatus({
        kind: 'error',
        message:
          err.status === 409
            ? `Rejected: ${err.message} The server enforces one credential, one vote.`
            : err.message,
      });
    }
  }

  async function logout() {
    try {
      await apiPost('/api/logout', {});
    } catch {
      // Session already gone; still reset the UI.
    }
    resetAfterElectionChange(electionId);
  }

  if (!elections) return <Loader />;
  if (offline) {
    return (
      <Alert color="yellow" title="Voting needs the API">
        The backend is unreachable, so ballots cannot be cast. Start it with{' '}
        <Code>npm run dev:api</Code> and reload this page.
      </Alert>
    );
  }
  if (!webauthnSupported) {
    return (
      <Alert color="red" title="Passkeys not supported">
        This browser does not support WebAuthn, so the passkey ceremony cannot run here. Use
        a current Chrome, Edge, Firefox, or Safari on localhost (secure context required).
      </Alert>
    );
  }

  return (
    <div className="max-w-2xl">
      <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
        Vote
      </Title>
      <Text c="dimmed" size="sm" mt="xs">
        Passkey authentication is <EnforcedBadge /> with real WebAuthn. Eligibility uses a{' '}
        <FictionalBadge /> roll. Ballots offer two paths: a standard session ballot, or an
        anonymous ballot with <ZKBadge /> group membership — while ballot secrecy stays{' '}
        <SimulatedBadge />. See the README for the full breakdown.
      </Text>

      <Select
        label="Election"
        mt="md"
        data={(elections.filter((e) => ['open', 'enrolment', 'frozen', 'voting'].includes(e.status)) ?? []).map((e) => ({
          value: e.id,
          label: `${e.title} (${e.status})`,
        }))}
        value={electionId}
        onChange={(id) => id && resetAfterElectionChange(id)}
      />

      {election && (
        <Stepper active={step} mt="xl" size="sm">
          <Stepper.Step
            label="Eligibility"
            description={election.access === 'invitation' ? 'Invitation required' : 'Fictional roll check'}
          >
            <Card withBorder radius="md" padding="md" mt="md">
              {election.access === 'invitation' ? (
                <>
                  <Text size="sm" c="dimmed">
                    This election is invitation-only. Redeem your single-use code to register
                    a passkey, then return here with your voter reference to authenticate.
                  </Text>
                  <Button
                    component={Link}
                    to={`/invite?election=${electionId}`}
                    mt="sm"
                    variant="light"
                  >
                    Redeem an invitation
                  </Button>
                  <TextInput
                    label="Voter reference"
                    placeholder="INV-…"
                    mt="sm"
                    value={voterRef}
                    onChange={(e) => setVoterRef(e.target.value)}
                  />
                </>
              ) : (
                <>
                  <Text size="sm" c="dimmed">
                    Only voters on the fictional roll may register. Pick a demo identity below —
                    no real identity is checked or stored.
                  </Text>
                  <Group mt="sm" grow>
                    <TextInput
                      label="Voter reference"
                      placeholder="PM-1001"
                      value={voterRef}
                      onChange={(e) => setVoterRef(e.target.value)}
                    />
                    <TextInput
                      label="Demo PIN"
                      placeholder="4921"
                      inputMode="numeric"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                    />
                  </Group>
                  <Button
                    onClick={registerPasskey}
                    mt="md"
                    color="teal"
                    disabled={!voterRef.trim() || !pin.trim()}
                  >
                    Register a passkey
                  </Button>
                </>
              )}
              {election.access !== 'invitation' && (
                <>
                  <Text size="sm" mt="md" fw={600}>
                    Demo roll for this election <FictionalBadge />
                  </Text>
                  <Table mt="xs" withTableBorder>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Ref</Table.Th>
                        <Table.Th>Name</Table.Th>
                        <Table.Th>PIN</Table.Th>
                        <Table.Th />
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {rollForElection.map((v) => (
                        <Table.Tr key={v.voterRef}>
                          <Table.Td>
                            <Code>{v.voterRef}</Code>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{v.displayName}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Code>{v.pin}</Code>
                          </Table.Td>
                          <Table.Td>
                            <Button
                              size="xs"
                              variant="light"
                              onClick={() => {
                                setVoterRef(v.voterRef);
                                setPin(v.pin);
                              }}
                            >
                              Use
                            </Button>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </>
              )}
              <Text size="sm" c="dimmed" mt="sm">
                Already registered a passkey for this voter?{' '}
                <Button
                  variant="subtle"
                  size="compact-sm"
                  disabled={!voterRef.trim()}
                  onClick={() => {
                    setRegistered(true);
                    setStep(1);
                  }}
                >
                  Continue to authentication
                </Button>
              </Text>
            </Card>
          </Stepper.Step>

          <Stepper.Step label="Passkey" description="Real WebAuthn ceremony">
            <Card withBorder radius="md" padding="md" mt="md">
              <Text size="sm">
                Voter: <Code>{voterRef.trim().toUpperCase() || '—'}</Code>{' '}
                {registered && <EnforcedBadge />}
              </Text>
              <Text size="sm" c="dimmed" mt="xs">
                Your authenticator signs a server challenge; the server verifies the
                signature, origin, RP ID, user verification, and counter. You can use a
                platform authenticator (fingerprint or device PIN) or a roaming security
                key — no biometrics required.
              </Text>
              <Button onClick={authenticate} mt="md" color="teal" disabled={!voterRef.trim()}>
                Authenticate with passkey
              </Button>
            </Card>
          </Stepper.Step>

          <Stepper.Step label="Ballot" description="Standard or anonymous">
            <SegmentedControl
              mt="md"
              fullWidth
              value={ballotMode}
              onChange={setBallotMode}
              data={[
                { label: 'Standard ballot', value: 'standard' },
                { label: 'Anonymous (zero-knowledge)', value: 'anonymous' },
              ]}
            />
            {ballotMode === 'standard' ? (
              <Card withBorder radius="md" padding="md" mt="md">
                <Radio.Group label={`Your choice — ${election.title}`} value={candidateId} onChange={setCandidateId}>
                  {election.candidates.map((c) => (
                    <Radio key={c.id} value={c.id} label={`${c.name} (${c.party})`} mt="xs" />
                  ))}
                </Radio.Group>
                <Text size="sm" c="dimmed" mt="sm">
                  Your browser hashes your choice into a commitment before sending. The server
                  stores the hash — never the plaintext vote. This path is session-bound, so
                  anonymity against the server is still simulated (see note above).
                </Text>
                <Group mt="md">
                  <Button onClick={castBallot} color="teal" disabled={!candidateId}>
                    Cast ballot
                  </Button>
                  <Button onClick={logout} variant="outline" color="dark">
                    Log out
                  </Button>
                </Group>
              </Card>
            ) : (
              <>
                <AnonymousBallot
                  election={election}
                  csrfToken={csrfToken}
                  onAccepted={(ballot, meta) => {
                    setReceipt({ ...ballot, ...meta });
                    setStep(3);
                    setStatus({ kind: 'idle', message: '' });
                  }}
                />
                <Button onClick={logout} mt="md" variant="outline" color="dark">
                  Log out
                </Button>
              </>
            )}
          </Stepper.Step>

          <Stepper.Completed>
            {receipt && (
              <Alert color="teal" mt="md" title="Ballot recorded">
                <Text size="sm">
                  Commitment <Code>{receipt.ballotCommitment.slice(0, 24)}…</Code> recorded at{' '}
                  {receipt.castAt}. Anyone can verify it in the{' '}
                  <Link to={`/audit?election=${electionId}`}>audit explorer</Link>.
                </Text>
                {receipt.nullifier && (
                  <Text size="sm" mt="xs">
                    <ZKBadge /> Verified anonymously: nullifier{' '}
                    <Code>{String(receipt.nullifier).slice(0, 24)}…</Code>
                    {receipt.groupVersion != null && (
                      <> from group <Code>v{receipt.groupVersion}</Code></>
                    )}
                    {receipt.anonymitySet != null && (
                      <> (anonymity set of {receipt.anonymitySet})</>
                    )}
                    .
                  </Text>
                )}
                <Button onClick={logout} mt="sm" variant="outline" color="dark" size="sm">
                  Log out
                </Button>
              </Alert>
            )}
          </Stepper.Completed>
        </Stepper>
      )}

      {status.kind === 'working' && (
        <Group mt="md" gap="xs">
          <Loader size="sm" />
          <Text size="sm">{status.message}</Text>
        </Group>
      )}
      {status.kind === 'error' && (
        <Alert color="red" mt="md" title="Something went wrong">
          {status.message}
        </Alert>
      )}
    </div>
  );
}

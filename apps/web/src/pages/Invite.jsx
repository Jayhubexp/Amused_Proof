import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Code,
  Group,
  Loader,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { apiPost } from '../lib/api';
import { EnforcedBadge, FictionalBadge } from '../components/Badges';

const webauthnSupported = browserSupportsWebAuthn();

// Invitation redemption for organizer-managed elections: paste the single-use
// code, register a personal passkey, authenticate, then continue to voting.
// The token is accepted exactly once and cleared from this page afterwards.
export function Invite() {
  const [params] = useSearchParams();
  const [token, setToken] = useState('');
  const [electionId, setElectionId] = useState(params.get('election') ?? '');
  const [electionTitle, setElectionTitle] = useState('');
  const [voterRef, setVoterRef] = useState('');
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState({ kind: 'idle', message: '' });

  function fail(message) {
    const cancelled = /abort|cancel|not allowed/i.test(message);
    setStatus({
      kind: 'error',
      message: cancelled
        ? 'The authenticator prompt was dismissed. Try again when ready.'
        : message,
    });
  }

  async function validateToken() {
    setStatus({ kind: 'working', message: 'Checking invitation…' });
    try {
      const body = electionId
        ? { invitationToken: token.trim(), electionId }
        : { invitationToken: token.trim() };
      const res = await apiPost('/api/invitations/validate', body);
      if (!res.valid) {
        setStatus({
          kind: 'error',
          message: 'That invitation is invalid, expired, already used, or revoked. Codes are single-use — check with your organizer.',
        });
        return;
      }
      setElectionId(res.election.id);
      setElectionTitle(res.election.title);
      setStep(1);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(err.message);
    }
  }

  async function registerPasskey() {
    setStatus({ kind: 'working', message: 'Starting passkey registration…' });
    try {
      const { requestId, options } = await apiPost('/api/webauthn/register/options', {
        invitationToken: token.trim(),
        electionId,
      });
      setStatus({ kind: 'working', message: 'Follow your browser prompt to create the passkey…' });
      const attestation = await startRegistration({ optionsJSON: options });
      const verified = await apiPost('/api/webauthn/register/verify', { requestId, response: attestation });
      setVoterRef(verified.voterRef);
      setToken(''); // single-use: never keep the code around after redeeming it
      setStep(2);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(err.message);
    }
  }

  async function authenticate() {
    setStatus({ kind: 'working', message: 'Requesting authentication challenge…' });
    try {
      const { requestId, options } = await apiPost('/api/webauthn/auth/options', { electionId, voterRef });
      setStatus({ kind: 'working', message: 'Follow your browser prompt to authenticate…' });
      const assertion = await startAuthentication({ optionsJSON: options });
      await apiPost('/api/webauthn/auth/verify', { requestId, response: assertion });
      setStep(3);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(err.message);
    }
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
        Redeem invitation
      </Title>
      <Text c="dimmed" size="sm" mt="xs">
        Invited to a <FictionalBadge /> election? Enter your single-use code, register your own
        passkey (<EnforcedBadge /> WebAuthn), and authenticate to vote. Invitation approval is
        organizer-managed testing access — not government identity verification.
      </Text>

      <Stepper active={step} mt="xl" size="sm">
        <Stepper.Step label="Invitation" description="Single-use code">
          <Card withBorder radius="md" padding="md" mt="md">
            <TextInput
              label="Invitation code"
              placeholder="inv_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <Button onClick={validateToken} mt="md" color="teal" disabled={!token.trim()}>
              Check invitation
            </Button>
          </Card>
        </Stepper.Step>

        <Stepper.Step label="Passkey" description="Register yours">
          <Card withBorder radius="md" padding="md" mt="md">
            <Text size="sm">
              Election: <Code>{electionTitle || electionId}</Code>
            </Text>
            <Text size="sm" c="dimmed" mt="xs">
              Create a passkey with your platform authenticator (fingerprint or device PIN) or
              a roaming security key — no biometrics required. Redeeming the code binds one
              passkey to your invited voter record.
            </Text>
            <Button onClick={registerPasskey} mt="md" color="teal">
              Register a passkey
            </Button>
          </Card>
        </Stepper.Step>

        <Stepper.Step label="Authenticate" description="Sign in">
          <Card withBorder radius="md" padding="md" mt="md">
            <Text size="sm">
              Voter: <Code>{voterRef || '—'}</Code>
            </Text>
            <Text size="sm" c="dimmed" mt="xs">
              Authenticate with the passkey you just registered to open a voting session.
            </Text>
            <Button onClick={authenticate} mt="md" color="teal" disabled={!voterRef}>
              Authenticate with passkey
            </Button>
          </Card>
        </Stepper.Step>

        <Stepper.Completed>
          <Alert color="teal" mt="md" title="Ready to vote">
            <Text size="sm">
              You are signed in as <Code>{voterRef}</Code> for <Code>{electionTitle}</Code>.
            </Text>
            <Group mt="sm">
              <Button
                component={Link}
                to={`/vote?election=${encodeURIComponent(electionId)}&voter=${encodeURIComponent(voterRef)}`}
                color="teal"
                size="sm"
              >
                Continue to voting
              </Button>
            </Group>
          </Alert>
        </Stepper.Completed>
      </Stepper>

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

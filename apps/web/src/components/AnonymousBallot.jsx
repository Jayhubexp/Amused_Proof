import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Code, CopyButton, Group, Loader, Radio, Text } from '@mantine/core';
import { apiGetAnon, apiPost, apiPostAnon, sha256Hex } from '../lib/api';
import {
  clearIdentityBackup,
  createIdentity,
  generateBallotProof,
  loadIdentityBackup,
  restoreIdentity,
  saveIdentityBackup,
} from '../lib/semaphore';
import { FictionalBadge, SimulatedBadge, ZKBadge } from '../components/Badges';

/**
 * Anonymous zero-knowledge ballot flow. The Semaphore identity lives only in
 * this tab: enrollment sends the commitment (authenticated), while group
 * fetches and ballot submission deliberately omit cookies (anonymous).
 */
export function AnonymousBallot({ election, csrfToken, onAccepted }) {
  const [backup, setBackup] = useState(null);
  const [commitment, setCommitment] = useState('');
  const [group, setGroup] = useState(null);
  const [candidateId, setCandidateId] = useState('');
  const [phase, setPhase] = useState('identity'); // identity → enrolled → sending → done
  const [status, setStatus] = useState({ kind: 'idle', message: '' });
  const [evidenceSeq, setEvidenceSeq] = useState(null);

  // Restore this tab's backup (if any) and re-derive its public commitment.
  useEffect(() => {
    const stored = loadIdentityBackup(election.id);
    if (!stored) return;
    restoreIdentity(stored).then(
      (restored) => {
        setBackup(stored);
        setCommitment(restored.commitment);
      },
      () => clearIdentityBackup(election.id),
    );
  }, [election.id]);

  function fail(message) {
    setStatus({ kind: 'error', message });
    setPhase((current) => (current === 'sending' ? 'enrolled' : current));
  }

  async function handleCreateIdentity() {
    setStatus({ kind: 'working', message: 'Generating anonymous identity in this browser…' });
    try {
      const created = await createIdentity();
      saveIdentityBackup(election.id, created.backup);
      setBackup(created.backup);
      setCommitment(created.commitment);
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      fail(`Could not generate an identity: ${err.message}`);
    }
  }

  function handleDiscardIdentity() {
    clearIdentityBackup(election.id);
    setBackup(null);
    setCommitment('');
    setGroup(null);
    setPhase('identity');
    setStatus({ kind: 'idle', message: '' });
  }

  async function refreshGroup() {
    const snapshot = await apiGetAnon(`/api/semaphore/group/${election.id}`);
    setGroup(snapshot);
    return snapshot;
  }

  async function handleEnroll() {
    setStatus({ kind: 'working', message: 'Enrolling commitment (authenticated)…' });
    try {
      const result = await apiPost(
        '/api/semaphore/enroll',
        { electionId: election.id, commitment },
        { csrfToken },
      );
      setGroup({ version: result.version, root: result.root, members: [] });
      setPhase('enrolled');
      setStatus({ kind: 'idle', message: '' });
    } catch (err) {
      if (err.status === 409 && /already enrolled an anonymous credential/.test(err.message)) {
        // Voter enrolled before (e.g. reloaded page): rejoin anonymously.
        try {
          await refreshGroup();
          setPhase('enrolled');
          setStatus({ kind: 'idle', message: '' });
        } catch (inner) {
          fail(inner.message);
        }
        return;
      }
      fail(err.message);
    }
  }

  async function findEvidence(type, ref) {
    try {
      const { events } = await apiGetAnon(
        `/api/audit?electionId=${election.id}&type=${type}&limit=500`,
      );
      const match = events.find((event) => event.ref === ref);
      if (match) setEvidenceSeq(match.seq);
    } catch {
      // Evidence lookup is a convenience; the audit explorer always works.
    }
  }

  async function handleProveAndSubmit() {
    setPhase('sending');
    setEvidenceSeq(null);
    try {
      setStatus({ kind: 'working', message: 'Fetching the approved group snapshot…' });
      const snapshot = await refreshGroup();
      if (!snapshot.members.includes(commitment)) {
        throw new Error('This identity is not enrolled in the current group snapshot.');
      }
      const ballotCommitment = await sha256Hex(`${candidateId}:${commitment}:${election.id}`);
      setStatus({
        kind: 'working',
        message: 'Generating zero-knowledge proof… (first run downloads proving keys)',
      });
      const proof = await generateBallotProof({
        backup,
        members: snapshot.members,
        ballotCommitment,
        scope: snapshot.scope,
      });
      setStatus({ kind: 'working', message: 'Submitting anonymously for verification…' });
      try {
        const res = await apiPostAnon('/api/ballots/anonymous', {
          electionId: election.id,
          ballotCommitment,
          proof,
        });
        await findEvidence('ballot.cast', ballotCommitment);
        setPhase('done');
        setStatus({ kind: 'idle', message: '' });
        onAccepted(res.ballot, {
          nullifier: proof.nullifier,
          groupVersion: snapshot.version,
          anonymitySet: snapshot.members.length,
        });
      } catch (err) {
        if (err.status === 409) {
          await findEvidence('ballot.rejected', await sha256Hex(proof.nullifier));
          fail(`Duplicate rejected: this anonymous credential has already voted. ${err.message}`);
        } else if (err.status === 401) {
          await findEvidence('proof.rejected', await sha256Hex(proof.nullifier));
          fail(`Proof rejected by the server: ${err.message}`);
        } else {
          throw err;
        }
      }
    } catch (err) {
      fail(err.message);
    }
  }

  return (
    <Card withBorder radius="md" padding="md" mt="md">
      <Group gap="xs">
        <Text size="sm" fw={600}>
          Anonymous ballot
        </Text>
        <ZKBadge />
        <FictionalBadge />
      </Group>
      <Text size="sm" c="dimmed" mt="xs">
        Real Semaphore membership proof. The server verifies you belong to the voter group
        without learning which member you are. Ballot secrecy itself stays{' '}
        <SimulatedBadge /> — candidate hashes are brute-forceable.
      </Text>

      {phase === 'identity' && (
        <>
          {!backup ? (
            <>
              <Text size="sm" mt="sm">
                First, generate a Semaphore identity. Its secret never leaves this browser tab.
              </Text>
              <Button onClick={handleCreateIdentity} mt="sm" color="teal">
                Generate anonymous identity
              </Button>
            </>
          ) : (
            <>
              <Alert color="yellow" variant="light" mt="sm" title="Identity backup">
                <Text size="sm">
                  Commitment <Code>{commitment ? `${commitment.slice(0, 24)}…` : '…'}</Code>.
                  The secret lives only in this tab (auto-restored on reload). Losing every
                  copy means losing this vote — there is deliberately no server recovery.
                </Text>
                <Code mt="xs" style={{ wordBreak: 'break-all' }}>
                  {backup}
                </Code>
                <CopyButton value={backup}>
                  {({ copied, copy }) => (
                    <Button onClick={copy} size="xs" variant="light" mt="xs">
                      {copied ? 'Copied' : 'Copy backup'}
                    </Button>
                  )}
                </CopyButton>
              </Alert>
              <Group mt="sm">
                <Button onClick={handleEnroll} color="teal" disabled={!commitment}>
                  Enroll commitment (authenticated)
                </Button>
                <Button onClick={handleDiscardIdentity} variant="outline" color="dark">
                  Discard and generate fresh
                </Button>
              </Group>
            </>
          )}
        </>
      )}

      {(phase === 'enrolled' || phase === 'sending') && (
        <>
          <Text size="sm" mt="sm">
            Enrolled at group <Code>v{group?.version ?? '?'}</Code>
            {group?.members?.length > 0 && (
              <>
                {' '}· anonymity set: <Code>{group.members.length} member{group.members.length === 1 ? '' : 's'}</Code>
              </>
            )}
            .
          </Text>
          {group?.members?.length < 3 && (
            <Text size="xs" c="dimmed" mt="xs">
              Note: the Semaphore authors warn that groups under 3 members provide no
              meaningful anonymity. Enroll more demo voters to grow the set.
            </Text>
          )}
          <Radio.Group
            label={`Your choice — ${election.title}`}
            value={candidateId}
            onChange={setCandidateId}
            mt="sm"
          >
            {election.candidates.map((c) => (
              <Radio key={c.id} value={c.id} label={`${c.name} (${c.party})`} mt="xs" />
            ))}
          </Radio.Group>
          <Button
            onClick={handleProveAndSubmit}
            mt="md"
            color="teal"
            disabled={!candidateId || phase === 'sending'}
          >
            {phase === 'sending' ? 'Proving and submitting…' : 'Generate proof and submit anonymously'}
          </Button>
        </>
      )}

      {status.kind === 'working' && (
        <Group mt="md" gap="xs">
          <Loader size="sm" />
          <Text size="sm">{status.message}</Text>
        </Group>
      )}
      {status.kind === 'error' && (
        <Alert color="red" mt="md" title="Submission failed">
          {status.message}{' '}
          {evidenceSeq && (
            <Link to={`/audit?election=${election.id}&highlight=${evidenceSeq}`}>
              Inspect the audit evidence (event #{evidenceSeq}).
            </Link>
          )}
        </Alert>
      )}
    </Card>
  );
}

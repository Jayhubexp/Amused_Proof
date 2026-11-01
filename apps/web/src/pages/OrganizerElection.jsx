import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Loader,
  NumberInput,
  Select,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { organizerDelete, organizerGet, organizerPatch, organizerPost } from '../lib/organizer';
import { FictionalBadge } from '../components/Badges';

function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function OrganizerElection() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const [election, setElection] = useState(null);
  const [stats, setStats] = useState(null);
  const [invitations, setInvitations] = useState([]);
  const [issued, setIssued] = useState([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [candidates, setCandidates] = useState([{ name: '', party: '' }, { name: '', party: '' }]);
  const [access, setAccess] = useState('invitation');
  const [votingMode, setVotingMode] = useState('anonymous');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [inviteCount, setInviteCount] = useState(5);
  const [inviteHours, setInviteHours] = useState(72);
  const [inviteLabel, setInviteLabel] = useState('');
  const [status, setStatus] = useState({ kind: 'idle', message: '' });

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      const session = await organizerGet('/api/organizer/session');
      if (!session.authenticated) {
        navigate('/organizer/login');
        return;
      }
      const data = await organizerGet('/api/organizer/elections');
      const found = data.elections.find((e) => e.id === id);
      if (!found) {
        setStatus({ kind: 'error', message: 'Election not found.' });
        return;
      }
      setElection(found);
      setStats(found.stats ?? null);
      setTitle(found.title);
      setDescription(found.description ?? '');
      setCandidates(found.candidates.map((c) => ({ name: c.name, party: c.party ?? '' })));
      setAccess(found.access ?? 'invitation');
      setVotingMode(found.votingMode ?? 'anonymous');
      setStartsAt(toLocalInput(found.startsAt));
      setEndsAt(toLocalInput(found.endsAt));
      const invites = await organizerGet(`/api/organizer/elections/${id}/invitations`);
      setInvitations(invites.invitations);
    } catch (err) {
      if (err.status === 401) {
        navigate('/organizer/login');
        return;
      }
      setStatus({ kind: 'error', message: err.message });
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const trimmedCandidates = candidates
    .map((c) => ({ name: c.name.trim(), party: c.party.trim() }))
    .filter((c) => c.name.length > 0);
  const formValid = title.trim().length > 0 && trimmedCandidates.length >= 2;
  const editable = isNew || election?.status === 'draft';

  async function save() {
    setStatus({ kind: 'idle', message: '' });
    const payload = {
      title: title.trim(),
      description: description.trim(),
      candidates: trimmedCandidates,
      access,
      votingMode,
    };
    const start = fromLocalInput(startsAt);
    const end = fromLocalInput(endsAt);
    if (start) payload.startsAt = start;
    if (end) payload.endsAt = end;
    try {
      if (isNew) {
        const res = await organizerPost('/api/organizer/elections', payload);
        navigate(`/organizer/elections/${res.election.id}`);
      } else {
        const res = await organizerPatch(`/api/organizer/elections/${id}`, payload);
        setElection(res.election);
        setStatus({ kind: 'ok', message: 'Draft saved.' });
      }
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  async function lifecycle(action, confirmMessage) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setStatus({ kind: 'idle', message: '' });
    try {
      await organizerPost(`/api/organizer/elections/${id}/${action}`, {});
      await load();
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the draft "${election.title}"? This cannot be undone.`)) return;
    try {
      await organizerDelete(`/api/organizer/elections/${id}`);
      navigate('/organizer');
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  async function issueInvitations() {
    setStatus({ kind: 'idle', message: '' });
    try {
      const res = await organizerPost(`/api/organizer/elections/${id}/invitations`, {
        count: inviteCount,
        expiresInHours: inviteHours,
        label: inviteLabel.trim(),
      });
      setIssued(res.invitations);
      const invites = await organizerGet(`/api/organizer/elections/${id}/invitations`);
      setInvitations(invites.invitations);
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  async function revoke(tokenHash) {
    if (!window.confirm('Revoke this invitation? The code stops working immediately.')) return;
    try {
      await organizerDelete(`/api/organizer/elections/${id}/invitations/${tokenHash}`);
      const invites = await organizerGet(`/api/organizer/elections/${id}/invitations`);
      setInvitations(invites.invitations);
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  function updateCandidate(index, field, value) {
    setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  }

  if (!isNew && !election && status.kind !== 'error') return <Loader />;

  return (
    <div>
      <Button component={Link} to="/organizer" variant="subtle" size="sm" px={0}>
        ← Back to dashboard
      </Button>
      <Group justify="space-between" align="end" mt="xs">
        <div>
          <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
            {isNew ? 'New election' : election?.title}
          </Title>
          <Text c="dimmed" size="sm">
            {isNew ? (
              <>Draft a <FictionalBadge /> election for controlled testing.</>
            ) : (
              <>
                <Badge color={election?.status === 'open' ? 'teal' : election?.status === 'draft' ? 'yellow' : 'gray'} variant="light">
                  {election?.status}
                </Badge>{' '}
                <Badge color="gray" variant="light">
                  {election?.access === 'invitation' ? 'invitation access' : 'demo-roll access'}
                </Badge>
                {election?.groupFrozen && (
                  <>
                    {' '}
                    <Badge color="blue" variant="light">group frozen</Badge>
                  </>
                )}
              </>
            )}
          </Text>
        </div>
        {!isNew && election && (
          <Group gap="xs">
            {election.status === 'draft' && (
              <>
                <Button size="sm" color="teal" onClick={() => lifecycle('start-enrolment')}>
                  Start enrolment
                </Button>
                <Button size="sm" color="red" variant="light" onClick={remove}>
                  Delete draft
                </Button>
              </>
            )}
            {election.status === 'enrolment' && (
              <Button
                size="sm"
                color="blue"
                variant="light"
                onClick={() => lifecycle('freeze', 'Freeze enrolment? No further anonymous credentials can be enrolled. This cannot be undone.')}
              >
                Freeze group
              </Button>
            )}
            {election.status === 'frozen' && (
              <Button size="sm" color="teal" onClick={() => lifecycle('start-voting')}>
                Open voting
              </Button>
            )}
            {(election.status === 'voting' || election.status === 'open') && (
              <>
                {election.status === 'open' && !election.groupFrozen && (
                  <Button
                    size="sm"
                    color="blue"
                    variant="light"
                    onClick={() => lifecycle('freeze', 'Freeze enrolment? No further anonymous credentials can be enrolled. This cannot be undone.')}
                  >
                    Freeze group
                  </Button>
                )}
                <Button
                  size="sm"
                  color="dark"
                  onClick={() => lifecycle('close', `Close "${election.title}"? Voting and registration stop.`)}
                >
                  Close election
                </Button>
              </>
            )}
            {(election.status === 'enrolment' || election.status === 'frozen') && (
              <Button
                size="sm"
                color="dark"
                variant="light"
                onClick={() => lifecycle('close', `Close "${election.title}" early? Registration, enrolment, and voting stop.`)}
              >
                Close early
              </Button>
            )}
          </Group>
        )}
      </Group>

      {status.kind === 'error' && (
        <Alert color="red" mt="md" title="Something went wrong">
          {status.message}
        </Alert>
      )}
      {status.kind === 'ok' && (
        <Alert color="teal" mt="md">
          {status.message}
        </Alert>
      )}

      {!isNew && stats && (
        <Group mt="md" gap="lg">
          <Text size="sm" c="dimmed">Ballots <strong>{stats.ballotsCast}</strong></Text>
          <Text size="sm" c="dimmed">Passkeys <strong>{stats.passkeys}</strong></Text>
          <Text size="sm" c="dimmed">Invites redeemed <strong>{stats.invitationsRedeemed}/{stats.invitationsIssued}</strong></Text>
          <Text size="sm" c="dimmed">Group <strong>v{stats.groupVersion}</strong></Text>
        </Group>
      )}

      <Card withBorder radius="md" padding="md" mt="md">
        <Title order={3} size="h5">
          {isNew ? 'Election details' : 'Details (editable while drafting)'}
        </Title>
        <TextInput
          label="Title"
          mt="sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!editable}
        />
        <Textarea
          label="Description"
          mt="sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!editable}
          minRows={2}
        />
        <Title order={4} size="sm" mt="md">
          Ballot choices (at least two)
        </Title>
        {candidates.map((candidate, index) => (
          <Group key={index} mt="xs" grow align="end">
            <TextInput
              label={index === 0 ? 'Name' : undefined}
              placeholder={`Choice ${index + 1}`}
              value={candidate.name}
              onChange={(e) => updateCandidate(index, 'name', e.target.value)}
              disabled={!editable}
            />
            <TextInput
              label={index === 0 ? 'Party / slate (optional)' : undefined}
              placeholder="Independent"
              value={candidate.party}
              onChange={(e) => updateCandidate(index, 'party', e.target.value)}
              disabled={!editable}
            />
            {candidates.length > 2 && editable && (
              <Button
                variant="subtle"
                color="red"
                size="sm"
                onClick={() => setCandidates((prev) => prev.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            )}
          </Group>
        ))}
        {editable && (
          <Button
            mt="xs"
            variant="light"
            size="sm"
            onClick={() => setCandidates((prev) => [...prev, { name: '', party: '' }])}
          >
            Add choice
          </Button>
        )}
        <Group mt="md" grow>
          <Select
            label="Eligibility"
            data={[
              { value: 'invitation', label: 'Invitation only (recommended)' },
              { value: 'roll', label: 'Demo roll + PIN' },
            ]}
            value={access}
            onChange={(value) => value && setAccess(value)}
            disabled={!editable}
          />
          <Select
            label="Voting mode (locked after draft)"
            description="Anonymous rejects standard ballots; standard rejects enrolment and proofs."
            data={[
              { value: 'anonymous', label: 'Anonymous (zero-knowledge)' },
              { value: 'standard', label: 'Standard (session ballot)' },
            ]}
            value={votingMode}
            onChange={(value) => value && setVotingMode(value)}
            disabled={!editable}
          />
        </Group>
        <Group mt="sm" grow>
          <TextInput
            label="Starts at (optional)"
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            disabled={!editable}
          />
          <TextInput
            label="Ends at (optional)"
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            disabled={!editable}
          />
        </Group>
        {editable && (
          <Button onClick={save} mt="md" color="teal" disabled={!formValid}>
            {isNew ? 'Create draft' : 'Save draft'}
          </Button>
        )}
        {!editable && (
          <Text size="sm" c="dimmed" mt="md">
            Open and closed elections are read-only: ballot choices cannot change after opening.
          </Text>
        )}
      </Card>

      {!isNew && election && (
        <Card withBorder radius="md" padding="md" mt="md">
          <Title order={3} size="h5">
            Voter invitations
          </Title>
          <Text size="sm" c="dimmed" mt="xs">
            Codes are random, single-use, and expire automatically. Plaintext codes are shown
            once at creation — afterwards only hashes exist. Share them privately with testers.
          </Text>
          <Group mt="sm" align="end">
            <NumberInput
              label="Count (1–50)"
              value={inviteCount}
              onChange={(value) => setInviteCount(Number(value) || 1)}
              min={1}
              max={50}
            />
            <NumberInput
              label="Expires in hours"
              value={inviteHours}
              onChange={(value) => setInviteHours(Number(value) || 72)}
              min={1}
              max={720}
            />
            <TextInput
              label="Label (optional)"
              placeholder="precinct-7"
              value={inviteLabel}
              onChange={(e) => setInviteLabel(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button onClick={issueInvitations} color="teal">
              Issue
            </Button>
          </Group>

          {issued.length > 0 && (
            <Alert color="yellow" mt="md" title="Copy these codes now — they will never be shown again">
              {issued.map((inv) => (
                <Group key={inv.tokenHash ?? inv.token} mt="xs" gap="xs">
                  <Code style={{ wordBreak: 'break-all' }}>{inv.token}</Code>
                  <CopyButton value={inv.token}>
                    {({ copied, copy }) => (
                      <Button size="compact-sm" variant="light" color={copied ? 'teal' : 'blue'} onClick={copy}>
                        {copied ? 'Copied' : 'Copy'}
                      </Button>
                    )}
                  </CopyButton>
                  <Text size="xs" c="dimmed">
                    {inv.voterRef} · expires {new Date(inv.expiresAt).toLocaleString()}
                  </Text>
                </Group>
              ))}
            </Alert>
          )}

          <div style={{ overflowX: 'auto' }} className="mt-4">
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Voter</Table.Th>
                  <Table.Th>Label</Table.Th>
                  <Table.Th>Expires</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invitations.map((inv) => (
                  <Table.Tr key={inv.tokenHash}>
                    <Table.Td>
                      <Code>{inv.voterRef}</Code>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{inv.label || '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{new Date(inv.expiresAt).toLocaleString()}</Text>
                    </Table.Td>
                    <Table.Td>
                      {inv.redeemedAt ? (
                        <Badge color="teal" variant="light">redeemed</Badge>
                      ) : new Date(inv.expiresAt).getTime() < Date.now() ? (
                        <Badge color="gray" variant="light">expired</Badge>
                      ) : (
                        <Badge color="yellow" variant="light">pending</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {!inv.redeemedAt && (
                        <Button size="compact-sm" variant="subtle" color="red" onClick={() => revoke(inv.tokenHash)}>
                          Revoke
                        </Button>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
          {invitations.length === 0 && (
            <Text size="sm" c="dimmed" mt="sm">
              No invitations issued yet.
            </Text>
          )}
        </Card>
      )}
    </div>
  );
}

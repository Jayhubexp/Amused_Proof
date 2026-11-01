import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { apiPost } from '../lib/api';
import { clearOrganizerCsrf, organizerGet, organizerPost } from '../lib/organizer';
import { FictionalBadge } from '../components/Badges';

function statusColor(status) {
  if (status === 'open') return 'teal';
  if (status === 'draft') return 'yellow';
  return 'gray';
}

export function Organizer() {
  const navigate = useNavigate();
  const [organizerId, setOrganizerId] = useState('');
  const [elections, setElections] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const session = await organizerGet('/api/organizer/session');
      if (!session.authenticated) {
        navigate('/organizer/login');
        return;
      }
      setOrganizerId(session.organizerId);
      const data = await organizerGet('/api/organizer/elections');
      setElections(data.elections);
    } catch (err) {
      if (err.status === 401) {
        navigate('/organizer/login');
        return;
      }
      setError(err.message);
    }
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  async function lifecycle(id, action, confirmMessage) {
    if (confirmMessage && !window.confirm(confirmMessage)) return;
    setError('');
    try {
      await organizerPost(`/api/organizer/elections/${id}/${action}`, {});
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function logout() {
    try {
      await apiPost('/api/organizer/logout', {});
    } catch {
      // Session already gone; still reset the UI.
    }
    clearOrganizerCsrf();
    navigate('/');
  }

  if (!elections && !error) return <Loader />;
  if (error && !elections) {
    return (
      <Alert color="red" title="Could not load organizer data">
        {error}
      </Alert>
    );
  }

  return (
    <div>
      <Group justify="space-between" align="end">
        <div>
          <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
            Organizer dashboard
          </Title>
          <Text c="dimmed" size="sm">
            Signed in as <strong>{organizerId}</strong>. All elections are <FictionalBadge /> —
            for controlled multi-user testing only.
          </Text>
        </div>
        <Group>
          <Button component={Link} to="/organizer/elections/new" color="teal" size="sm">
            New election
          </Button>
          <Button onClick={logout} variant="outline" color="dark" size="sm">
            Sign out
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" mt="md" title="Action failed">
          {error}
        </Alert>
      )}

      <Card withBorder radius="md" padding="0" mt="lg">
        <div style={{ overflowX: 'auto' }}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Election</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Access</Table.Th>
                <Table.Th>Mode</Table.Th>
                <Table.Th>Ballots</Table.Th>
                <Table.Th>Passkeys</Table.Th>
                <Table.Th>Invites</Table.Th>
                <Table.Th>Group</Table.Th>
                <Table.Th>Actions</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {elections.map((election) => (
                <Table.Tr key={election.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>
                      {election.title}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {election.id}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={statusColor(election.status)} variant="light">
                      {election.status}
                    </Badge>
                    {election.groupFrozen && (
                      <Badge color="blue" variant="light" ml="xs">
                        frozen
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{election.access === 'invitation' ? 'Invitation' : 'Demo roll'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{election.votingMode === 'standard' ? 'Standard' : election.votingMode === 'anonymous' ? 'Anonymous' : 'Legacy'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{election.stats?.ballotsCast ?? 0}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{election.stats?.passkeys ?? 0}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">
                      {election.stats?.invitationsRedeemed ?? 0}/{election.stats?.invitationsIssued ?? 0}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">v{election.stats?.groupVersion ?? 0}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs">
                      <Button
                        component={Link}
                        to={`/organizer/elections/${election.id}`}
                        size="compact-sm"
                        variant="light"
                      >
                        Manage
                      </Button>
                      {election.status === 'draft' && (
                        <Button size="compact-sm" color="teal" onClick={() => lifecycle(election.id, 'start-enrolment')}>
                          Enrol
                        </Button>
                      )}
                      {election.status === 'enrolment' && (
                        <Button size="compact-sm" color="blue" variant="light" onClick={() => lifecycle(election.id, 'freeze', `Freeze enrolment for "${election.title}"? Irreversible.`)}>
                          Freeze
                        </Button>
                      )}
                      {election.status === 'frozen' && (
                        <Button size="compact-sm" color="teal" onClick={() => lifecycle(election.id, 'start-voting')}>
                          Vote
                        </Button>
                      )}
                      {(election.status === 'voting' || election.status === 'open') && (
                        <Button
                          size="compact-sm"
                          color="dark"
                          onClick={() => lifecycle(election.id, 'close', `Close "${election.title}"? Voting and registration stop.`)}
                        >
                          Close
                        </Button>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      </Card>

      <Text size="sm" c="dimmed" mt="md">
        Lifecycle: draft → enrolment (register + enrol) → frozen (enrolment locked) →
        voting (ballots only) → closed. Invitations stay single-use throughout, and the
        voting mode locks once an election leaves draft.
      </Text>
    </div>
  );
}

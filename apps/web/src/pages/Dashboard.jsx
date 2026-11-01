import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Text, Title } from '@mantine/core';
import { apiGet } from '../lib/api';
import { elections as fixtureElections } from '../fixtures/fictional';
import { FictionalBadge } from '../components/Badges';

export function Dashboard() {
  const [elections, setElections] = useState(null);
  const [offline, setOffline] = useState(false);
  const [session, setSession] = useState(null);

  useEffect(() => {
    apiGet('/api/elections')
      .then((data) => setElections(data.elections))
      .catch(() => {
        setElections(fixtureElections);
        setOffline(true);
      });
    apiGet('/api/session')
      .then(setSession)
      .catch(() => setSession({ authenticated: false }));
  }, []);

  if (!elections) return <Loader />;

  const myElection = session?.authenticated
    ? elections.find((e) => e.id === session.electionId)
    : null;

  return (
    <div>
      <Group justify="space-between" align="end">
        <div>
          <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
            Elections
          </Title>
          <Text c="dimmed" size="sm">
            Administered with fictional records for research purposes only. <FictionalBadge />
          </Text>
        </div>
      </Group>

      {offline && (
        <Alert color="yellow" mt="md" title="API unreachable">
          Showing bundled fixtures. Start the backend (`npm run dev:api`) for live data.
        </Alert>
      )}

      {myElection && (
        <Card withBorder radius="md" padding="md" mt="md" style={{ borderColor: 'var(--mantine-color-teal-5)' }}>
          <Group justify="space-between" gap="xs">
            <div>
              <Text size="sm" fw={600}>
                You are signed in as {session.voterRef}
              </Text>
              <Text size="sm" c="dimmed">
                Eligible election: {myElection.title}
              </Text>
            </div>
            <Button
              component={Link}
              to={`/vote?election=${myElection.id}&voter=${encodeURIComponent(session.voterRef)}`}
              size="sm"
              color="teal"
            >
              Continue voting
            </Button>
          </Group>
        </Card>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg">
        {elections.map((election) => (
          <Card key={election.id} withBorder radius="md" padding="lg">
            <Group justify="space-between" gap="xs">
              <Group gap="xs">
                <Badge color={election.status === 'open' ? 'teal' : 'gray'} variant="light">
                  {election.status}
                </Badge>
                <Badge color={election.access === 'invitation' ? 'grape' : 'blue'} variant="light">
                  {election.access === 'invitation' ? 'invitation only' : 'demo roll'}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {election.ballotsCast ?? 0} commitments recorded
              </Text>
            </Group>
            <Title order={3} size="h4" mt="sm">
              {election.title}
            </Title>
            <Text size="sm" c="dimmed" mt="xs">
              {election.description}
            </Text>
            <Text size="sm" mt="sm">
              Candidates: {election.candidates.map((c) => c.name).join(' · ')}
            </Text>
            <Group mt="md">
              {['open', 'enrolment', 'frozen', 'voting'].includes(election.status) ? (
                <Button component={Link} to={`/vote?election=${election.id}`} size="sm" color="teal">
                  Vote in this election
                </Button>
              ) : (
                <Button component={Link} to={`/audit?election=${election.id}`} size="sm" variant="light">
                  View audit trail
                </Button>
              )}
            </Group>
          </Card>
        ))}
      </SimpleGrid>
    </div>
  );
}

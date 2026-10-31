import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Text, Title } from '@mantine/core';
import { apiGet } from '../lib/api';
import { elections as fixtureElections } from '../fixtures/fictional';
import { FictionalBadge } from '../components/Badges';

export function Dashboard() {
  const [elections, setElections] = useState(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    apiGet('/api/elections')
      .then((data) => setElections(data.elections))
      .catch(() => {
        setElections(fixtureElections);
        setOffline(true);
      });
  }, []);

  if (!elections) return <Loader />;

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

      <SimpleGrid cols={{ base: 1, sm: 2 }} mt="lg">
        {elections.map((election) => (
          <Card key={election.id} withBorder radius="md" padding="lg">
            <Group justify="space-between" gap="xs">
              <Badge color={election.status === 'open' ? 'teal' : 'gray'} variant="light">
                {election.status}
              </Badge>
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
              {election.status === 'open' ? (
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

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Anchor, Code, Group, Loader, Select, Table, Text, Title } from '@mantine/core';
import { apiGet } from '../lib/api';
import { auditEvents as fixtureEvents } from '../fixtures/fictional';

const TYPES = [
  'election.opened',
  'voter.registered',
  'ballot.cast',
  'ballot.rejected',
  'proof.rejected',
  'semaphore.enrolled',
  'auth.failed',
  'admin.updated',
  'transaction.error',
  'tally.checkpoint',
];

export function AuditExplorer() {
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState(null);
  const [offline, setOffline] = useState(false);
  const [electionFilter, setElectionFilter] = useState(params.get('election') ?? '');
  const [typeFilter, setTypeFilter] = useState('');
  const highlight = Number.parseInt(params.get('highlight') ?? '', 10);

  useEffect(() => {
    const query = new URLSearchParams();
    if (electionFilter) query.set('electionId', electionFilter);
    if (typeFilter) query.set('type', typeFilter);
    apiGet(`/api/audit?${query.toString()}`)
      .then((data) => {
        setEvents(data.events);
        setOffline(false);
      })
      .catch(() => {
        setEvents(fixtureEvents);
        setOffline(true);
      });
  }, [electionFilter, typeFilter]);

  if (!events) return <Loader />;

  return (
    <div>
      <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
        Audit explorer
      </Title>
      <Text c="dimmed" size="sm" mt="xs">
        Public, verifiable transaction events. Hashes only — this log never contains voter
        identities or plaintext votes.
      </Text>

      {offline && (
        <Alert color="yellow" mt="md" title="API unreachable">
          Showing a bundled fixture. Start the backend (`npm run dev:api`) for the live
          audit trail.
        </Alert>
      )}

      <Group mt="md" grow>
        <Select
          label="Election"
          placeholder="All elections"
          clearable
          data={[
            { value: 'metro-transit-2026', label: 'Metro Transit Funding' },
            { value: 'harbor-board-2026', label: 'Harbor Board Seat 3' },
            { value: 'library-levy-2025', label: 'Library Levy (certified)' },
          ]}
          value={electionFilter}
          onChange={(v) => setElectionFilter(v ?? '')}
        />
        <Select
          label="Event type"
          placeholder="All types"
          clearable
          data={TYPES}
          value={typeFilter}
          onChange={(v) => setTypeFilter(v ?? '')}
        />
      </Group>

      {Number.isInteger(highlight) && (
        <Alert color="teal" variant="light" mt="md">
          Highlighting evidence event #{highlight}.{' '}
          <Anchor
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('highlight');
              setParams(next);
            }}
          >
            Clear highlight
          </Anchor>
        </Alert>
      )}

      <Table mt="md" striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Seq</Table.Th>
            <Table.Th>Time</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Election</Table.Th>
            <Table.Th>Reference hash</Table.Th>
            <Table.Th>Detail</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {events.map((e) => (
            <Table.Tr
              key={e.seq}
              style={e.seq === highlight ? { backgroundColor: 'var(--mantine-color-teal-1)' } : undefined}
            >
              <Table.Td>{e.seq}</Table.Td>
              <Table.Td>
                <Text size="xs">{new Date(e.ts).toLocaleString()}</Text>
              </Table.Td>
              <Table.Td>
                <Code>{e.type}</Code>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{e.electionId}</Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs" style={{ wordBreak: 'break-all' }}>
                  {e.ref ? `${e.ref.slice(0, 20)}…` : '—'}
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{e.detail}</Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>

      <Text size="xs" c="dimmed" mt="sm">
        Events are server-published statements. A future phase anchors batch hashes to a
        testnet contract so anyone can verify this log was not rewritten.
      </Text>
    </div>
  );
}

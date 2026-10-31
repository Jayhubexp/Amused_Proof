import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  Group,
  List,
  Loader,
  Select,
  SimpleGrid,
  Skeleton,
  Table,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiGet, apiPost } from '../lib/api';
import { FictionalBadge, LiveBadge, RulesOnlyBadge } from '../components/Badges';

const SEVERITY_COLORS = { high: 'red', medium: 'orange', low: 'blue', info: 'gray' };
const SEVERITY_HEX = { high: '#e03131', medium: '#f08c00', low: '#1971c2', info: '#868e96' };
const CATEGORY_LABELS = {
  'duplicate-vote-attempts': 'Duplicate votes',
  'repeated-auth-failures': 'Auth failures',
  'suspicious-admin-changes': 'Admin changes',
  'transaction-error': 'Transaction errors',
  'transaction-errors': 'Transaction errors',
  'invalid-proofs': 'Invalid proofs',
};
const CHART_HEIGHT = 260;

function KpiCard({ label, value, sub }) {
  return (
    <Card withBorder radius="md" padding="sm">
      <Title order={3}>{value}</Title>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </Card>
  );
}

function ChartCard({ title, children, empty, fallback }) {
  return (
    <Card withBorder radius="md" padding="md">
      <Title order={4}>{title}</Title>
      {fallback ? (
        <Text size="sm" c="dimmed" mt="md" style={{ minHeight: CHART_HEIGHT }}>
          {fallback}
        </Text>
      ) : empty ? (
        <Text size="sm" c="dimmed" mt="md" style={{ minHeight: CHART_HEIGHT }}>
          {empty}
        </Text>
      ) : (
        <div style={{ height: CHART_HEIGHT }} className="mt-2">
          {children}
        </div>
      )}
    </Card>
  );
}

function EvidenceChips({ seqs }) {
  if (!seqs || seqs.length === 0) return <Text size="sm" c="dimmed">No direct event citations.</Text>;
  return (
    <Group gap="xs" mt="xs">
      {seqs.map((seq) => (
        <Anchor key={seq} component={Link} to={`/audit?highlight=${seq}`} size="sm">
          <Code>event #{seq}</Code>
        </Anchor>
      ))}
    </Group>
  );
}

function FindingsTable({ findings }) {
  const [expanded, setExpanded] = useState(null);
  if (findings.length === 0) {
    return (
      <Text size="sm" c="dimmed" mt="xs">
        No issues flagged in this scope. That means nothing in these events matched a
        detection rule — not that the election is certified.
      </Text>
    );
  }
  return (
    <Table.ScrollContainer minWidth={640} mt="sm">
      <Table striped highlightOnHover withTableBorder>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Severity</Table.Th>
            <Table.Th>Finding</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Evidence</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {findings.map((finding, i) => (
            <Fragment key={`${finding.source}-${i}`}>
              <Table.Tr
                onClick={() => setExpanded(expanded === i ? null : i)}
                style={{ cursor: 'pointer' }}
              >
                <Table.Td>
                  <Badge color={SEVERITY_COLORS[finding.severity] ?? 'gray'} variant="filled" size="sm">
                    {finding.severity}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={600}>
                    {finding.title}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge color={finding.source === 'rule' ? 'teal' : 'blue'} variant="light" size="sm">
                    {finding.source === 'rule' ? 'Rule-based' : 'AI-generated'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {finding.eventSeqs?.length > 0 ? (
                    <Anchor
                      component={Link}
                      to={`/audit?highlight=${finding.eventSeqs[0]}`}
                      size="sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      event #{finding.eventSeqs[0]}
                      {finding.eventSeqs.length > 1 ? ` +${finding.eventSeqs.length - 1} more` : ''}
                    </Anchor>
                  ) : (
                    <Text size="sm" c="dimmed">—</Text>
                  )}
                </Table.Td>
              </Table.Tr>
              {expanded === i && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text size="sm">{finding.explanation}</Text>
                    {finding.source === 'rule' && (
                      <Text size="xs" c="dimmed" mt="xs">
                        Deterministic rule: <Code>{finding.ruleId}</Code> — mechanical fact, not
                        model output.
                      </Text>
                    )}
                    {finding.recommendedSteps?.length > 0 && (
                      <>
                        <Text size="sm" fw={600} mt="sm">
                          Recommended investigation steps
                        </Text>
                        <List size="sm" spacing="xs" mt="xs">
                          {finding.recommendedSteps.map((step, j) => (
                            <List.Item key={j}>{step}</List.Item>
                          ))}
                        </List>
                      </>
                    )}
                    <Text size="sm" fw={600} mt="sm">
                      All supporting evidence
                    </Text>
                    <EvidenceChips seqs={finding.eventSeqs} />
                  </Table.Td>
                </Table.Tr>
              )}
            </Fragment>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

export function Integrity() {
  const [elections, setElections] = useState([]);
  const [electionId, setElectionId] = useState('');
  const [report, setReport] = useState(null);
  const [auditEvents, setAuditEvents] = useState(undefined); // undefined = not loaded, null = failed
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [qa, setQa] = useState(null);
  const [qaError, setQaError] = useState('');

  useEffect(() => {
    apiGet('/api/elections')
      .then((data) => setElections(data.elections ?? []))
      .catch(() => setElections([]));
  }, []);

  async function analyse(scope) {
    setLoading(true);
    setOffline(false);
    setQa(null);
    setQaError('');
    const query = scope ? `?electionId=${scope}` : '';
    try {
      setReport(await apiGet(`/api/ai/integrity${query}`));
    } catch {
      setOffline(true);
      setReport(null);
      setAuditEvents(undefined);
      setLoading(false);
      return;
    }
    try {
      const audit = await apiGet(`/api/audit?limit=500${scope ? `&electionId=${scope}` : ''}`);
      setAuditEvents(audit.events ?? []);
    } catch {
      setAuditEvents(null); // timeline falls back; everything else still works
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    analyse('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ask() {
    if (!question.trim()) return;
    setAsking(true);
    setQaError('');
    setQa(null);
    try {
      setQa(await apiPost('/api/ai/ask', { electionId: electionId || null, question: question.trim() }));
    } catch (err) {
      setQaError(err.message);
    } finally {
      setAsking(false);
    }
  }

  const findings = useMemo(() => report?.findings ?? [], [report]);
  const ruleById = useMemo(
    () => Object.fromEntries((report?.ruleFindings ?? []).map((f) => [f.ruleId, f])),
    [report],
  );
  const breakdown = useMemo(() => report?.electionBreakdown ?? [], [report]);

  const severityData = useMemo(
    () =>
      ['high', 'medium', 'low', 'info']
        .map((severity) => ({
          name: `${severity} (${findings.filter((f) => f.severity === severity).length})`,
          value: findings.filter((f) => f.severity === severity).length,
          color: SEVERITY_HEX[severity],
        }))
        .filter((d) => d.value > 0),
    [findings],
  );

  const categoryData = useMemo(() => {
    const groups = new Map();
    for (const finding of findings) {
      const key = finding.source === 'rule' ? finding.ruleId : 'ai-interpretation';
      if (!groups.has(key)) {
        groups.set(key, {
          category: finding.source === 'rule' ? CATEGORY_LABELS[key] ?? key : 'AI interpretation',
          count: 0,
          ai: finding.source !== 'rule',
        });
      }
      groups.get(key).count += 1;
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }, [findings]);

  const electionData = useMemo(
    () =>
      breakdown.map((b) => ({
        name: b.title.length > 22 ? `${b.title.slice(0, 21)}…` : b.title,
        high: b.high,
        medium: b.medium,
        low: b.low,
      })),
    [breakdown],
  );

  const timelineData = useMemo(() => {
    if (!auditEvents) return null;
    const cited = new Set(findings.flatMap((f) => f.eventSeqs ?? []));
    const buckets = new Map();
    for (const event of auditEvents) {
      if (!cited.has(event.seq)) continue;
      const day = new Date(event.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const key = `${new Date(event.ts).toISOString().slice(0, 10)}|${day}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, events]) => ({ day: key.split('|')[1], events }));
  }, [auditEvents, findings]);

  const electionsAffected = breakdown.filter((b) => b.findings > 0).length;

  return (
    <div>
      <Group gap="xs" align="center">
        <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
          Integrity dashboard
        </Title>
        {report && (report.live ? <LiveBadge /> : <RulesOnlyBadge />)}
        <FictionalBadge />
      </Group>
      <Text c="dimmed" size="sm" mt="xs">
        Read-only monitoring of the fictional audit trail. Findings are investigative leads —
        never fraud verdicts — and the assistant cannot modify ballots or certify results.
      </Text>

      <Group mt="md" align="end">
        <Select
          label="Scope"
          placeholder="All elections"
          clearable
          style={{ flex: 1, maxWidth: 420 }}
          data={elections.map((e) => ({ value: e.id, label: e.title }))}
          value={electionId}
          onChange={(v) => setElectionId(v ?? '')}
        />
        <Button onClick={() => analyse(electionId)} color="teal" loading={loading}>
          Run analysis
        </Button>
      </Group>

      {offline && (
        <Alert color="yellow" mt="md" title="API unreachable">
          Start the backend (<Code>npm run dev:api</Code>) to analyse the audit trail.
        </Alert>
      )}

      {loading && !report && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mt="md">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={84} radius="md" />
            ))}
          </SimpleGrid>
          <SimpleGrid cols={{ base: 1, md: 2 }} mt="md">
            <Skeleton height={320} radius="md" />
            <Skeleton height={320} radius="md" />
          </SimpleGrid>
          <Group mt="md" gap="xs">
            <Loader size="sm" />
            <Text size="sm">Analysing audit events…</Text>
          </Group>
        </>
      )}

      {report && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mt="md">
            <KpiCard label="Events analysed" value={report.eventCount} />
            <KpiCard label="High severity" value={findings.filter((f) => f.severity === 'high').length} sub="findings" />
            <KpiCard label="Medium severity" value={findings.filter((f) => f.severity === 'medium').length} sub="findings" />
            <KpiCard
              label="Duplicate attempts"
              value={ruleById['duplicate-vote-attempts']?.eventSeqs.length ?? 0}
              sub="rejected ballots"
            />
            <KpiCard
              label="Auth failures"
              value={ruleById['repeated-auth-failures']?.eventSeqs.length ?? 0}
              sub="failed verifications"
            />
            <KpiCard label="Elections affected" value={electionsAffected} sub={`of ${breakdown.length} in scope`} />
          </SimpleGrid>

          <SimpleGrid cols={{ base: 1, md: 2 }} mt="md">
            <ChartCard title="Findings by severity" empty={severityData.length === 0 ? 'No findings in this scope.' : null}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={severityData} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2}>
                    {severityData.map((entry) => (
                      <Cell key={entry.name} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Findings by category" empty={categoryData.length === 0 ? 'No findings in this scope.' : null}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryData} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="category" width={128} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Bar dataKey="count" name="Findings">
                    {categoryData.map((entry) => (
                      <Cell key={entry.category} fill={entry.ai ? '#1971c2' : '#0e6b5e'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Findings by election"
              empty={electionData.every((e) => e.high + e.medium + e.low === 0) ? 'No election in scope has findings.' : null}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={electionData} margin={{ bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="high" stackId="a" fill={SEVERITY_HEX.high} name="High" />
                  <Bar dataKey="medium" stackId="a" fill={SEVERITY_HEX.medium} name="Medium" />
                  <Bar dataKey="low" stackId="a" fill={SEVERITY_HEX.low} name="Low" />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard
              title="Suspicious events over time"
              empty={timelineData && timelineData.length === 0 ? 'No cited events in this scope.' : null}
              fallback={
                auditEvents === null
                  ? 'Timeline unavailable: the audit fetch failed, but the analysis above is unaffected.'
                  : auditEvents === undefined
                    ? 'Loading timeline…'
                    : null
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timelineData ?? []} margin={{ bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="events" name="Cited events" stroke="#0e6b5e" fill="#0e6b5e" fillOpacity={0.25} />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>
          </SimpleGrid>

          <Text size="xs" c="dimmed" mt="sm">
            Teal marks rule-based detections; blue marks AI-generated interpretation. Counts
            reflect the current scope{report.live ? ' and live model output' : ''}.
          </Text>

          <Title order={3} size="h4" mt="lg">
            Analyst summary
          </Title>
          <Alert color={report.live ? 'teal' : 'blue'} variant="light" mt="sm" title="Integrity overview">
            {report.summary}
          </Alert>

          <Group mt="md" gap="xs">
            <Badge variant="light">Events analysed: {report.eventCount}</Badge>
            <Badge variant="light" color="teal">
              Mode: read-only
            </Badge>
            <Badge variant="light" color="gray">
              Model: {report.live ? report.model : report.aiStatus === 'disabled' ? 'none (set MUSE_SPARK_API_KEY)' : 'unavailable — rules shown'}
            </Badge>
          </Group>

          {report.warnings?.length > 0 && (
            <Alert color="orange" variant="light" mt="md" title="Validation warnings">
              <List size="sm" spacing="xs">
                {report.warnings.map((w, i) => (
                  <List.Item key={i}>{w}</List.Item>
                ))}
              </List>
            </Alert>
          )}

          <Title order={3} size="h4" mt="lg">
            Findings ({findings.length})
          </Title>
          <FindingsTable findings={findings} />

          {report.limitations?.length > 0 && (
            <>
              <Title order={3} size="h4" mt="lg">
                Limitations
              </Title>
              <List size="sm" mt="xs" spacing="xs">
                {report.limitations.map((l, i) => (
                  <List.Item key={i}>{l}</List.Item>
                ))}
              </List>
            </>
          )}

          <div className="max-w-2xl">
            <Title order={3} size="h4" mt="lg">
              Ask about this audit log
            </Title>
            <Textarea
              placeholder="e.g. Were there any duplicate-vote attempts?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              minRows={2}
              maxLength={500}
              mt="xs"
            />
            <Button onClick={ask} mt="sm" color="teal" loading={asking} disabled={!question.trim()}>
              Ask the assistant
            </Button>
            {qaError && (
              <Alert color={qaError.includes('MUSE_SPARK_API_KEY') ? 'yellow' : 'red'} mt="md" title="Assistant unavailable">
                {qaError}
              </Alert>
            )}
            {qa && (
              <Card withBorder radius="md" padding="md" mt="md">
                <Text size="sm">{qa.answer}</Text>
                <Text size="sm" fw={600} mt="sm">
                  Supporting evidence
                </Text>
                <EvidenceChips seqs={qa.eventSeqs} />
                {qa.limitations?.length > 0 && (
                  <Text size="xs" c="dimmed" mt="sm">
                    Limitations: {qa.limitations.join(' ')}
                  </Text>
                )}
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

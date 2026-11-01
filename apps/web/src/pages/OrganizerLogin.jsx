import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Card, PasswordInput, SegmentedControl, Text, TextInput, Title } from '@mantine/core';
import { apiPost } from '../lib/api';
import { setOrganizerCsrf } from '../lib/organizer';
import { FictionalBadge } from '../components/Badges';

// Organizer sign-in plus first-time bootstrap. The setup token is configured
// server-side (ORGANIZER_SETUP_TOKEN); without it no account can be created.
export function OrganizerLogin() {
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [status, setStatus] = useState({ kind: 'idle', message: '' });

  async function login() {
    setStatus({ kind: 'idle', message: '' });
    try {
      const res = await apiPost('/api/organizer/login', { username: username.trim(), password });
      setOrganizerCsrf(res.csrfToken);
      navigate('/organizer');
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  async function setup() {
    setStatus({ kind: 'idle', message: '' });
    try {
      await apiPost('/api/organizer/setup', {
        token: setupToken.trim(),
        username: username.trim(),
        password,
      });
      setMode('login');
      setSetupToken('');
      setPassword('');
      setStatus({ kind: 'ok', message: 'Organizer account created. Sign in to continue.' });
    } catch (err) {
      setStatus({ kind: 'error', message: err.message });
    }
  }

  const valid = username.trim().length >= 3 && password.length >= 12;

  return (
    <div className="max-w-md">
      <Title order={1} style={{ fontFamily: 'Georgia, serif' }}>
        Organizer access
      </Title>
      <Text c="dimmed" size="sm" mt="xs">
        Manage <FictionalBadge /> elections for controlled testing. Accounts are created by
        invitation of an existing organizer — or once via the server setup token.
      </Text>

      <SegmentedControl
        mt="md"
        fullWidth
        value={mode}
        onChange={setMode}
        data={[
          { label: 'Sign in', value: 'login' },
          { label: 'First-time setup', value: 'setup' },
        ]}
      />

      <Card withBorder radius="md" padding="md" mt="md">
        {mode === 'setup' && (
          <PasswordInput
            label="Setup token"
            description="Single-use server token (ORGANIZER_SETUP_TOKEN)."
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            autoComplete="off"
          />
        )}
        <TextInput
          label="Username"
          placeholder="organizer-1"
          mt={mode === 'setup' ? 'sm' : undefined}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
        <PasswordInput
          label="Password"
          description="At least 12 characters."
          mt="sm"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
        />
        {mode === 'login' ? (
          <Button onClick={login} mt="md" color="teal" fullWidth disabled={!valid}>
            Sign in
          </Button>
        ) : (
          <Button onClick={setup} mt="md" color="teal" fullWidth disabled={!valid || !setupToken.trim()}>
            Create founding organizer
          </Button>
        )}
      </Card>

      {status.kind === 'error' && (
        <Alert color="red" mt="md" title="Could not continue">
          {status.message}
        </Alert>
      )}
      {status.kind === 'ok' && (
        <Alert color="teal" mt="md">
          {status.message}
        </Alert>
      )}
    </div>
  );
}

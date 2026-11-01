import { Link, NavLink } from 'react-router-dom';
import { Burger, Container, Drawer, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';

const links = [
  { to: '/', label: 'Home' },
  { to: '/elections', label: 'Elections' },
  { to: '/vote', label: 'Vote' },
  { to: '/audit', label: 'Audit explorer' },
  { to: '/integrity', label: 'Integrity' },
  { to: '/organizer', label: 'Organizer' },
];

function BrandMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-civic-accent"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

export function Layout({ children }) {
  const [opened, { toggle, close }] = useDisclosure(false);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-50 border-b border-stone-200 bg-civic-paper">
        <Container size="lg" className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center gap-2 no-underline" aria-label="CivicProof AI home">
            <BrandMark />
            <span className="flex flex-col leading-tight">
              <Text fw={700} size="md" className="text-civic-ink">
                CivicProof AI
              </Text>
              <Text size="xs" c="dimmed">
                Research prototype
              </Text>
            </span>
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === '/'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-2 text-sm font-medium no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-civic-accent ${
                    isActive ? 'bg-civic-accent/10 text-civic-accent' : 'text-civic-ink hover:bg-stone-200/60'
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
          <Burger
            opened={opened}
            onClick={toggle}
            className="md:hidden"
            color="#14232e"
            aria-label={opened ? 'Close menu' : 'Open menu'}
            aria-expanded={opened}
          />
        </Container>
      </header>

      <Drawer
        opened={opened}
        onClose={close}
        title="CivicProof AI"
        position="right"
        className="md:hidden"
        aria-label="Mobile navigation"
      >
        <Stack gap="xs">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              onClick={close}
              className={({ isActive }) =>
                `rounded-md px-3 py-2.5 text-base font-medium no-underline ${
                  isActive ? 'bg-civic-accent/10 text-civic-accent' : 'text-civic-ink hover:bg-stone-200/60'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
          <Text size="xs" c="dimmed" mt="md">
            Research prototype using fictional elections.
          </Text>
        </Stack>
      </Drawer>

      <main className="flex-1">
        <Container size="lg" className="py-8 md:py-12">
          {children}
        </Container>
      </main>

      <footer className="border-t border-stone-200">
        <Container size="lg" className="flex flex-col gap-4 py-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-md">
            <Group gap="xs">
              <BrandMark />
              <Text fw={700} size="sm">
                CivicProof AI
              </Text>
            </Group>
            <Text size="xs" c="dimmed" mt="xs">
              A research prototype exploring verifiable voting. All voters and elections are
              fictional. Not approved for real-world election use.
            </Text>
          </div>
          <nav aria-label="Footer" className="flex gap-8">
            <div className="flex flex-col gap-2">
              <Text size="xs" fw={600} c="dimmed">
                Product
              </Text>
              {links.slice(1).map((l) => (
                <Link key={l.to} to={l.to} className="text-sm text-civic-ink no-underline hover:underline">
                  {l.label}
                </Link>
              ))}
            </div>
            <div className="flex flex-col gap-2">
              <Text size="xs" fw={600} c="dimmed">
                Transparency
              </Text>
              <Link to="/#transparency" className="text-sm text-civic-ink no-underline hover:underline">
                Technical scope
              </Link>
              <Link to="/integrity" className="text-sm text-civic-ink no-underline hover:underline">
                Integrity dashboard
              </Link>
            </div>
          </nav>
        </Container>
      </footer>
    </div>
  );
}

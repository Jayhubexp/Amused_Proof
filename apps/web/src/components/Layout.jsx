import { useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Badge, Burger, Container, Drawer, Group, Stack, Text } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';

const links = [
  { to: '/', label: 'Overview' },
  { to: '/elections', label: 'Elections' },
  { to: '/vote', label: 'Vote' },
  { to: '/audit', label: 'Audit explorer' },
  { to: '/integrity', label: 'Integrity' },
  { to: '/organizer', label: 'Organizer' },
];

const publicLinks = links.filter((l) => l.to !== '/organizer');

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-civic-accent';

/** Proof Network mark: stacked proof layers on deep navy, sealed with a sand check. */
function BrandMark() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" className="h-8 w-8 shrink-0">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="#0B1F3B" />
      <path
        d="M16 6.5 22 10 16 13.5 10 10Z"
        fill="none"
        stroke="#F8F9F6"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M16 11.5 22 15 16 18.5 10 15Z"
        fill="none"
        stroke="#9BC2B0"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 20.5 14 24 22 15"
        fill="none"
        stroke="#D9C27A"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Wordmark({ size = 'md' }) {
  return (
    <Text fw={700} size={size} className="whitespace-nowrap tracking-tight text-civic-ink">
      CivicProof <span className="text-civic-accent">AI</span>
    </Text>
  );
}

function DemoPill({ className = 'hidden xl:inline-flex' }) {
  return (
    <span
      className={`${className} items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-civic-ink`}
      title="Demonstration with fictional data — not a live election"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-civic-gold" />
      Demo mode
    </span>
  );
}

export function Layout({ children }) {
  const [opened, { toggle, close }] = useDisclosure(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <div className="sticky top-0 z-50">
        <div className="h-[3px] bg-civic-accent" aria-hidden="true">
          <div className="h-full w-24 bg-civic-gold" />
        </div>
        <header
          className={`border-b border-civic-line bg-civic-paper transition-shadow duration-150 ${
            scrolled ? 'shadow-[0_2px_14px_rgba(11,31,59,0.10)]' : ''
          }`}
        >
          <Container size="lg" className="flex h-16 items-center justify-between gap-4">
            <Link
              to="/"
              className={`flex items-center gap-2.5 rounded-md no-underline ${focusRing}`}
              aria-label="CivicProof AI home"
            >
              <BrandMark />
              <Wordmark />
              <span className="hidden lg:inline">
                <Badge color="gray" variant="light" size="xs">
                  Research prototype
                </Badge>
              </span>
            </Link>
            <nav aria-label="Primary" className="hidden items-center gap-6 lg:flex xl:gap-8">
              {publicLinks.map((l) => (
                <NavLink
                  key={l.to}
                  to={l.to}
                  end={l.to === '/'}
                  className={({ isActive }) =>
                    `whitespace-nowrap rounded-t-md border-b-2 px-1 py-2 text-[15px] font-medium no-underline transition-colors duration-150 ${focusRing} ${
                      isActive
                        ? 'border-civic-accent text-civic-accent'
                        : 'border-transparent text-civic-ink hover:bg-civic-accent/10 hover:text-civic-accent'
                    }`
                  }
                >
                  {l.label}
                </NavLink>
              ))}
            </nav>
            <div className="hidden items-center gap-3 lg:flex">
              <DemoPill />
              <NavLink
                to="/organizer"
                className={`whitespace-nowrap rounded-md bg-civic-accent px-4 py-2 text-[15px] font-semibold text-white no-underline transition-colors duration-150 hover:bg-[#0b5443] ${focusRing}`}
              >
                Organizer
              </NavLink>
            </div>
            <Burger
              opened={opened}
              onClick={toggle}
              className="lg:hidden"
              color="#0b1f3b"
              aria-label={opened ? 'Close menu' : 'Open menu'}
              aria-expanded={opened}
            />
          </Container>
        </header>
      </div>

      <Drawer
        opened={opened}
        onClose={close}
        title="CivicProof AI"
        position="right"
        className="lg:hidden"
        aria-label="Mobile navigation"
      >
        <Stack gap={4}>
          {publicLinks.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              onClick={close}
              className={({ isActive }) =>
                `flex min-h-[44px] items-center rounded-md px-3 text-base font-medium no-underline transition-colors duration-150 ${focusRing} ${
                  isActive ? 'bg-civic-accent/10 text-civic-accent' : 'text-civic-ink hover:bg-stone-200/60'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
          <NavLink
            to="/organizer"
            onClick={close}
            className={`mt-2 flex min-h-[44px] items-center justify-center rounded-md bg-civic-accent px-3 text-base font-semibold text-white no-underline transition-colors duration-150 hover:bg-[#0b5443] ${focusRing}`}
          >
            Organizer
          </NavLink>
          <Group mt="md" gap="xs">
            <DemoPill className="inline-flex" />
          </Group>
          <Text size="xs" c="dimmed">
            Research prototype using fictional elections.
          </Text>
        </Stack>
      </Drawer>

      <main className="flex-1">
        <Container size="lg" className="py-8 md:py-12">
          {children}
        </Container>
      </main>

      <footer className="border-t border-civic-line">
        <Container size="lg" className="flex flex-col gap-4 py-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-md">
            <Group gap="xs">
              <BrandMark />
              <Wordmark size="sm" />
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

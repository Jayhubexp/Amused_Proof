import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { Voting } from './pages/Voting';
import { AuditExplorer } from './pages/AuditExplorer';
import { Integrity } from './pages/Integrity';
import { Invite } from './pages/Invite';
import { Organizer } from './pages/Organizer';
import { OrganizerElection } from './pages/OrganizerElection';
import { OrganizerLogin } from './pages/OrganizerLogin';

export function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/elections" element={<Dashboard />} />
          <Route path="/vote" element={<Voting />} />
          <Route path="/audit" element={<AuditExplorer />} />
          <Route path="/integrity" element={<Integrity />} />
          <Route path="/invite" element={<Invite />} />
          <Route path="/organizer/login" element={<OrganizerLogin />} />
          <Route path="/organizer" element={<Organizer />} />
          <Route path="/organizer/elections/:id" element={<OrganizerElection />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

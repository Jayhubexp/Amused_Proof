import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { Voting } from './pages/Voting';
import { AuditExplorer } from './pages/AuditExplorer';
import { Integrity } from './pages/Integrity';

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
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}

import { Navigate, Route, Routes } from 'react-router-dom';
import EditorPage from './EditorPage';
import LandingPage from './LandingPage';
import ProjectPage from './ProjectPage';
import CollabJoinPage from './CollabJoinPage';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/projects" element={<ProjectPage />} />
      <Route path="/editor/:projectId" element={<EditorPage />} />
      <Route path="/collab" element={<CollabJoinPage />} />
      <Route path="*" element={<Navigate to="/projects" replace />} />
    </Routes>
  );
}

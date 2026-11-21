import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, NavLink, useParams } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth.jsx';
import AuctionList from './pages/AuctionList.jsx';
import RfqForm from './pages/RfqForm.jsx';
import AuctionDetails from './pages/AuctionDetails.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import './styles.css';

function TopBar() {
  const { user, logout } = useAuth();
  return (
    <header className="topbar">
      <Link to="/" className="brand"><span className="brand-mark">⚑</span> British Auction RFQ</Link>
      {user && (
        <nav>
          <NavLink to="/" end>Auctions</NavLink>
          {user.role === 'BUYER' && <NavLink to="/dashboard">Dashboard</NavLink>}
          {user.role === 'BUYER' && <NavLink to="/rfqs/new" className="btn btn-primary btn-sm">+ New RFQ</NavLink>}
          <span className="who">
            <span className={`role-pill role-${user.role.toLowerCase()}`}>{user.role === 'BUYER' ? 'Buyer' : 'Supplier'}</span>
            <span className="who-name">{user.companyName || user.name}</span>
          </span>
          <button type="button" className="link" onClick={logout}>Sign out</button>
        </nav>
      )}
    </header>
  );
}

function EditRfqRoute() {
  const { id } = useParams();
  return <RfqForm editId={id} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <TopBar />
        <main className="container">
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={<RequireAuth><AuctionList /></RequireAuth>} />
            <Route path="/dashboard" element={<RequireAuth role="BUYER"><Dashboard /></RequireAuth>} />
            <Route path="/rfqs/new" element={<RequireAuth role="BUYER"><RfqForm /></RequireAuth>} />
            <Route path="/rfqs/:id/edit" element={<RequireAuth role="BUYER"><EditRfqRoute /></RequireAuth>} />
            <Route path="/rfqs/:id" element={<RequireAuth><AuctionDetails /></RequireAuth>} />
            <Route path="*" element={<p>Page not found. <Link to="/">Back to auctions</Link></p>} />
          </Routes>
        </main>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

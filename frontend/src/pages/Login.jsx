import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Field, ErrorText } from '../components/ui.jsx';

const DEMO = [
  ['buyer@demo.test', 'Buyer'],
  ['maersk@demo.test', 'Supplier · Maersk Line'],
  ['hapag@demo.test', 'Supplier · Hapag-Lloyd'],
  ['cma@demo.test', 'Supplier · CMA CGM'],
];

export default function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await login(form.email, form.password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-page">
      <form className="card form" onSubmit={submit} noValidate>
        <h1>Sign in</h1>
        <Field label="Email">
          <input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <ErrorText error={error} />
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small center">No account? <Link to="/register">Create one</Link></p>
      </form>

      <div className="card demo-box">
        <h2>Demo accounts</h2>
        <p className="muted small">Created by <code>npm run seed</code>. Password for all: <code>demo1234</code></p>
        <ul>
          {DEMO.map(([email, label]) => (
            <li key={email}>
              <button type="button" className="link" onClick={() => setForm({ email, password: 'demo1234' })}>{email}</button>
              <span className="muted small"> — {label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

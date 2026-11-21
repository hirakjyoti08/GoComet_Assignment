import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Field, ErrorText } from '../components/ui.jsx';

export default function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ role: 'SUPPLIER', name: '', companyName: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (user) return <Navigate to="/" replace />;

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setErrors({});
    try {
      await register(form);
      navigate('/', { replace: true });
    } catch (err) {
      setErrors(err.details || {});
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-page">
      <form className="card form" onSubmit={submit} noValidate>
        <h1>Create account</h1>
        <fieldset className="segmented">
          <legend className="label">I am a</legend>
          {[['SUPPLIER', 'Supplier / Carrier'], ['BUYER', 'Buyer']].map(([v, l]) => (
            <label key={v} className={form.role === v ? 'selected' : ''}>
              <input type="radio" name="role" value={v} checked={form.role === v} onChange={set('role')} /> {l}
            </label>
          ))}
        </fieldset>
        <Field label="Your name" error={errors.name}><input value={form.name} onChange={set('name')} autoComplete="name" /></Field>
        <Field label={form.role === 'SUPPLIER' ? 'Company name (shown to buyers)' : 'Company name (optional)'} error={errors.companyName}>
          <input value={form.companyName} onChange={set('companyName')} autoComplete="organization" />
        </Field>
        <Field label="Email" error={errors.email}><input type="email" value={form.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label="Password" error={errors.password} hint="At least 8 characters">
          <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <ErrorText error={Object.keys(errors).length ? '' : error} />
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="muted small center">Already registered? <Link to="/login">Sign in</Link></p>
      </form>
    </section>
  );
}

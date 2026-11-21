import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, newIdempotencyKey } from '../api.js';
import { CURRENCIES, TRIGGER_LABEL, VISIBILITY_LABEL } from '../format.js';
import { Field, ErrorText } from '../components/ui.jsx';

const pad = (n) => String(n).padStart(2, '0');
// value for <input type="datetime-local"> in the user's local time
const localInput = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const roundedPlusMin = (m) => { const d = new Date(Date.now() + m * 60_000); d.setSeconds(0, 0); return d.getTime(); };

function defaults() {
  return {
    name: '',
    referenceId: `RFQ-${Date.now().toString(36).toUpperCase().slice(-6)}`,
    currency: 'USD',
    bidStartAt: localInput(roundedPlusMin(1)),
    bidCloseAt: localInput(roundedPlusMin(31)),
    forcedCloseAt: localInput(roundedPlusMin(61)),
    pickupDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    triggerWindowMinutes: 10,
    extensionMinutes: 5,
    triggerType: 'BID_RECEIVED',
    minDecrementType: 'AMOUNT',
    minDecrementValue: '0',
    supplierVisibility: 'RANK_ONLY',
    invitedSupplierIds: [],
  };
}

/** Convert an RFQ from the API back into form values (for editing). */
function fromRfq(r) {
  return {
    name: r.name, referenceId: r.reference_id, currency: r.currency,
    bidStartAt: localInput(r.bid_start_at), bidCloseAt: localInput(r.bid_close_at), forcedCloseAt: localInput(r.forced_close_at),
    pickupDate: r.pickup_date, triggerWindowMinutes: r.trigger_window_minutes, extensionMinutes: r.extension_minutes,
    triggerType: r.trigger_type, minDecrementType: r.min_decrement_type,
    minDecrementValue: String(r.min_decrement_value / 100), // minor units / basis points → display value
    supplierVisibility: r.supplier_visibility, invitedSupplierIds: r.invitations.map((i) => i.supplier_id),
  };
}

function clientValidate(f) {
  const e = {};
  if (!f.name.trim()) e.name = 'RFQ name is required';
  if (!f.referenceId.trim()) e.referenceId = 'Reference ID is required';
  const s = new Date(f.bidStartAt).getTime(), c = new Date(f.bidCloseAt).getTime(), x = new Date(f.forcedCloseAt).getTime();
  if (!(c > s)) e.bidCloseAt = 'Bid close must be after bid start';
  if (!(x > c)) e.forcedCloseAt = 'Forced close must be later than bid close';
  if (!f.pickupDate) e.pickupDate = 'Pickup / service date is required';
  if (!(Number(f.triggerWindowMinutes) >= 1)) e.triggerWindowMinutes = 'Must be at least 1 minute';
  if (!(Number(f.extensionMinutes) >= 1)) e.extensionMinutes = 'Must be at least 1 minute';
  if (!/^\d+(\.\d{1,2})?$/.test(String(f.minDecrementValue).trim())) e.minDecrementValue = 'Enter a number with up to 2 decimals';
  if (!f.invitedSupplierIds.length) e.invitedSupplierIds = 'Invite at least one supplier';
  return e;
}

export default function RfqForm({ editId }) {
  const navigate = useNavigate();
  const [form, setForm] = useState(editId ? null : defaults);
  const [suppliers, setSuppliers] = useState([]);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [createKey] = useState(newIdempotencyKey); // double-clicking "Create" can never make two RFQs

  useEffect(() => {
    api.suppliers().then((r) => setSuppliers(r.suppliers)).catch((e) => setLoadError(e.message));
    if (editId) {
      api.getRfq(editId).then((r) => {
        if (r.rfq.status !== 'UPCOMING') setLoadError('This RFQ can no longer be edited because bidding has opened.');
        else setForm(fromRfq(r.rfq));
      }).catch((e) => setLoadError(e.message));
    }
  }, [editId]);

  if (loadError) return <p className="error">{loadError} <Link to={editId ? `/rfqs/${editId}` : '/'}>Go back</Link></p>;
  if (!form) return <p className="muted">Loading…</p>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggleSupplier = (id) => setForm((f) => ({
    ...f, invitedSupplierIds: f.invitedSupplierIds.includes(id) ? f.invitedSupplierIds.filter((x) => x !== id) : [...f.invitedSupplierIds, id],
  }));

  async function onSubmit(e) {
    e.preventDefault();
    const errs = clientValidate(form);
    setErrors(errs);
    setSubmitError('');
    if (Object.keys(errs).length) return;
    setSaving(true);
    const body = {
      ...form,
      bidStartAt: new Date(form.bidStartAt).toISOString(),
      bidCloseAt: new Date(form.bidCloseAt).toISOString(),
      forcedCloseAt: new Date(form.forcedCloseAt).toISOString(),
      triggerWindowMinutes: Number(form.triggerWindowMinutes),
      extensionMinutes: Number(form.extensionMinutes),
      minDecrementValue: String(form.minDecrementValue).trim(),
    };
    try {
      const rfq = editId ? await api.updateRfq(editId, body) : await api.createRfq(body, createKey);
      navigate(`/rfqs/${rfq.id}`);
    } catch (err) {
      setErrors(err.details || {});
      setSubmitError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const X = Number(form.triggerWindowMinutes) || 'X';
  const Y = Number(form.extensionMinutes) || 'Y';

  return (
    <section className="narrow">
      <h1>{editId ? 'Edit RFQ' : 'Create RFQ'}</h1>
      <p className="muted">British Auction is enabled for this RFQ. Times are in your local timezone.
        {editId && ' Editing is only possible until bidding opens.'}</p>
      <form className="card form" onSubmit={onSubmit} noValidate>
        <h2>RFQ details</h2>
        <div className="grid-2">
          <Field label="RFQ name" error={errors.name}>
            <input value={form.name} onChange={set('name')} placeholder="e.g. Mumbai → Rotterdam 40ft FCL" />
          </Field>
          <Field label="Reference ID" error={errors.referenceId}>
            <input value={form.referenceId} onChange={set('referenceId')} />
          </Field>
          <Field label="Bid start" error={errors.bidStartAt}>
            <input type="datetime-local" value={form.bidStartAt} onChange={set('bidStartAt')} />
          </Field>
          <Field label="Bid close" error={errors.bidCloseAt}>
            <input type="datetime-local" value={form.bidCloseAt} onChange={set('bidCloseAt')} />
          </Field>
          <Field label="Forced bid close" error={errors.forcedCloseAt} hint="Hard stop. Extensions never go past this.">
            <input type="datetime-local" value={form.forcedCloseAt} onChange={set('forcedCloseAt')} />
          </Field>
          <Field label="Pickup / service date" error={errors.pickupDate}>
            <input type="date" value={form.pickupDate} onChange={set('pickupDate')} />
          </Field>
          <Field label="Currency" error={errors.currency} hint="All quotes for this RFQ use this currency.">
            <select value={form.currency} onChange={set('currency')}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <h2>Invited suppliers</h2>
        {errors.invitedSupplierIds && <p className="field-error">{errors.invitedSupplierIds}</p>}
        {suppliers.length === 0 ? <p className="muted">No suppliers have registered yet.</p> : (
          <div className="checks">
            {suppliers.map((s) => (
              <label key={s.id} className={`check ${form.invitedSupplierIds.includes(s.id) ? 'selected' : ''}`}>
                <input type="checkbox" checked={form.invitedSupplierIds.includes(s.id)} onChange={() => toggleSupplier(s.id)} />
                {s.name}
              </label>
            ))}
          </div>
        )}

        <h2>British Auction rules</h2>
        <div className="grid-2">
          <Field label="Trigger window (X minutes)" error={errors.triggerWindowMinutes} hint="How close to the close time activity is watched.">
            <input type="number" min="1" value={form.triggerWindowMinutes} onChange={set('triggerWindowMinutes')} />
          </Field>
          <Field label="Extension duration (Y minutes)" error={errors.extensionMinutes} hint="Time added each time the trigger fires.">
            <input type="number" min="1" value={form.extensionMinutes} onChange={set('extensionMinutes')} />
          </Field>
        </div>
        <fieldset className="radio-group">
          <legend className="label">Extension trigger</legend>
          {Object.entries(TRIGGER_LABEL).map(([k, label]) => (
            <label key={k} className={`radio ${form.triggerType === k ? 'selected' : ''}`}>
              <input type="radio" name="triggerType" value={k} checked={form.triggerType === k} onChange={set('triggerType')} />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>

        <div className="grid-2">
          <Field label="Minimum decrement type" error={errors.minDecrementType}>
            <select value={form.minDecrementType} onChange={set('minDecrementType')}>
              <option value="AMOUNT">Fixed amount ({form.currency})</option>
              <option value="PERCENT">Percentage (%)</option>
            </select>
          </Field>
          <Field label={form.minDecrementType === 'PERCENT' ? 'Minimum decrement (%)' : `Minimum decrement (${form.currency})`}
            error={errors.minDecrementValue} hint="Each re-bid, and any bid taking L1, must be at least this much lower. 0 = no minimum.">
            <input inputMode="decimal" value={form.minDecrementValue} onChange={set('minDecrementValue')} />
          </Field>
        </div>
        <fieldset className="radio-group">
          <legend className="label">What suppliers can see</legend>
          {Object.entries(VISIBILITY_LABEL).map(([k, label]) => (
            <label key={k} className={`radio ${form.supplierVisibility === k ? 'selected' : ''}`}>
              <input type="radio" name="supplierVisibility" value={k} checked={form.supplierVisibility === k} onChange={set('supplierVisibility')} />
              <span>{label}</span>
            </label>
          ))}
          <span className="hint">Competitor names and individual quotes are never shown to suppliers.</span>
        </fieldset>

        <p className="callout">
          If the trigger fires in the last <b>{X} min</b> before close, the close time moves out by <b>{Y} min</b>, never past the forced close.
        </p>

        <ErrorText error={submitError} />
        <div className="actions">
          <button type="button" className="btn" onClick={() => navigate(editId ? `/rfqs/${editId}` : '/')}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : editId ? 'Save changes' : 'Create RFQ'}</button>
        </div>
      </form>
    </section>
  );
}

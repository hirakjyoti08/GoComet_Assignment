import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge, Clock, ActivityLog, Field } from './ui.jsx';

const MIN = 60_000;
const rfq = (o = {}) => ({ bid_start_at: 0, current_close_at: 60 * MIN, forced_close_at: 90 * MIN, trigger_window_minutes: 10, ...o });

describe('StatusBadge', () => {
  test.each([['FORCE_CLOSED', 'Force Closed'], ['ACTIVE', 'Active'], ['AWARDED', 'Awarded'], ['PAUSED', 'Paused']])('%s → %s', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label).className).toContain(`badge-${status.toLowerCase()}`);
  });
});

describe('Clock', () => {
  test('counts down and is calm outside the trigger window', () => {
    const { container } = render(<Clock rfq={rfq()} status="ACTIVE" now={30 * MIN} />);
    expect(screen.getByText('30:00')).toBeTruthy();
    expect(container.firstChild.className).not.toContain('clock-hot');
  });

  test('turns hot inside the last X minutes', () => {
    const { container } = render(<Clock rfq={rfq()} status="ACTIVE" now={55 * MIN} />);
    expect(container.firstChild.className).toContain('clock-hot');
    expect(screen.getByText('In trigger window')).toBeTruthy();
  });

  test('shows frozen remaining time while paused', () => {
    render(<Clock rfq={rfq({ paused_at: 50 * MIN })} status="PAUSED" now={58 * MIN} />);
    expect(screen.getByText('10:00')).toBeTruthy();
  });
});

describe('ActivityLog', () => {
  test('extensions show old → new time and the reason', () => {
    render(<ActivityLog activity={[{
      id: 1, type: 'TIME_EXTENDED', message: 'Bid close time extended by 5 min', created_at: 0,
      metadata: { from: 0, to: 5 * MIN, capped: true, reason: 'Lowest bidder (L1) changed within the trigger window' },
    }]} />);
    expect(screen.getByText(/Reason: Lowest bidder \(L1\) changed/)).toBeTruthy();
    expect(screen.getByText(/capped at forced close/)).toBeTruthy();
  });

  test('empty state', () => {
    render(<ActivityLog activity={[]} />);
    expect(screen.getByText('No activity yet.')).toBeTruthy();
  });
});

describe('Field', () => {
  test('error replaces hint', () => {
    const { rerender } = render(<Field label="X" hint="the hint"><input /></Field>);
    expect(screen.getByText('the hint')).toBeTruthy();
    rerender(<Field label="X" hint="the hint" error="bad value"><input /></Field>);
    expect(screen.queryByText('the hint')).toBeNull();
    expect(screen.getByText('bad value')).toBeTruthy();
  });
});

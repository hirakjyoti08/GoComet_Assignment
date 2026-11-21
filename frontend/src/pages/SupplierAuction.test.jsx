import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock only the network calls; keep everything else real.
vi.mock('../api.js', async (orig) => {
  const actual = await orig();
  return { ...actual, api: { ...actual.api, submitBid: vi.fn() } };
});
import { api, ApiError } from '../api.js';
import { Position, BidForm } from './SupplierAuction.jsx';

const rfq = (o = {}) => ({
  id: 7, currency: 'USD', min_decrement_type: 'AMOUNT', min_decrement_value: 2500,
  my_rank: 2, competitor_count: 3, my_best: { total_minor: 240000 }, l1_visible: false, l1_total_minor: null, i_am_l1: false,
  my_bids: [{ carrier_name: 'Maersk', origin_charges_minor: 15000, destination_charges_minor: 22000, transit_time_days: 24, quote_valid_until: '2026-12-30' }],
  ...o,
});

describe('Position', () => {
  test('rank-only visibility: L1 price hidden', () => {
    render(<Position rfq={rfq()} />);
    expect(screen.getByText('L2')).toBeTruthy();
    expect(screen.getByText('of 4 bidding suppliers')).toBeTruthy();
    expect(screen.getByText('hidden by buyer')).toBeTruthy();
  });

  test('L1 price visible: shows the gap', () => {
    render(<Position rfq={rfq({ l1_visible: true, l1_total_minor: 236000 })} />);
    expect(screen.getByText(/you are USD\s?40\.00 above L1/)).toBeTruthy();
  });
});

describe('BidForm', () => {
  beforeEach(() => api.submitBid.mockReset());
  const fillFreight = (v) => fireEvent.change(screen.getByLabelText(/Freight charges/), { target: { value: v } });

  test('shows the re-bid ceiling and flags a total above it', () => {
    render(<BidForm rfq={rfq()} onPlaced={() => {}} />);
    expect(screen.getByText(/USD\s?2,375\.00/)).toBeTruthy(); // 2,400 − 25
    fillFreight('2100'); // + 150 + 220 prefilled = 2,470 > ceiling
    expect(screen.getByText(/USD\s?2,470\.00/).className).toContain('over');
  });

  test('review → confirm sends one idempotency key; a network error keeps it for a safe retry', async () => {
    const onPlaced = vi.fn();
    render(<BidForm rfq={rfq()} onPlaced={onPlaced} />);
    fillFreight('1900');
    fireEvent.click(screen.getByText('Review bid'));
    expect(screen.getByText(/Submit a bid of/)).toBeTruthy();

    api.submitBid.mockRejectedValueOnce(new ApiError('Network error — safe to retry', 0));
    fireEvent.click(screen.getByText('Confirm bid'));
    await screen.findByText(/Network error/);
    const firstKey = api.submitBid.mock.calls[0][2];
    expect(firstKey).toMatch(/^[\w-]{8,}$/);

    api.submitBid.mockResolvedValueOnce({ rank: 1, totalMinor: 227000, extension: null });
    fireEvent.click(screen.getByText('Confirm bid')); // still on the confirm step
    await screen.findByText(/you are L1/);
    expect(api.submitBid.mock.calls[1][2]).toBe(firstKey);
    expect(onPlaced).toHaveBeenCalledOnce();
  });

  test('a rejected bid clears the key so the next attempt is a new action', async () => {
    render(<BidForm rfq={rfq()} onPlaced={() => {}} />);
    fillFreight('1900');
    fireEvent.click(screen.getByText('Review bid'));
    api.submitBid.mockRejectedValueOnce(new ApiError('Your new bid must be lower', 409));
    fireEvent.click(screen.getByText('Confirm bid'));
    await screen.findByText(/must be lower/);
    await waitFor(() => expect(screen.getByText('Review bid')).toBeTruthy());
    fireEvent.click(screen.getByText('Review bid'));
    api.submitBid.mockResolvedValueOnce({ rank: 2, totalMinor: 227000, extension: null });
    fireEvent.click(screen.getByText('Confirm bid'));
    await screen.findByText(/you are L2/);
    expect(api.submitBid.mock.calls[1][2]).not.toBe(api.submitBid.mock.calls[0][2]);
  });
});

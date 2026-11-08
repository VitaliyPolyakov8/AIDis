import { afterEach, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SeasonalDecor } from './SeasonalDecor';
import { useSettingsStore } from '../stores/settingsStore';

afterEach(() => useSettingsStore.setState({ seasonalTheme: 'off' }));

it('lets people light the pumpkin, mix potions and finish a candy hunt', async () => {
  useSettingsStore.setState({ seasonalTheme: 'halloween' });
  const user = userEvent.setup();
  render(<SeasonalDecor />);
  const pumpkin = screen.getByRole('button', { name: 'Light the pumpkin' });
  expect(pumpkin).toHaveAttribute('aria-pressed', 'false');
  await user.click(pumpkin);
  expect(pumpkin).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('button', { name: 'Mix a potion' }));
  expect(screen.getByRole('status')).toHaveTextContent('Potion of courage');
  for (let i = 0; i < 5; i++) await user.click(screen.getByRole('button', { name: 'Take a candy' }));
  expect(screen.getByRole('status')).toHaveTextContent('All five!');
  expect(screen.getByRole('button', { name: 'Take a candy' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Play again' }));
  expect(screen.getByRole('button', { name: 'Take a candy' })).toBeEnabled();
});

it('can collapse the scene and removes all Halloween UI when switched off', async () => {
  useSettingsStore.setState({ seasonalTheme: 'halloween' });
  const user = userEvent.setup();
  render(<SeasonalDecor />);
  await user.click(screen.getByRole('button', { name: 'Halloween corner' }));
  expect(screen.queryByRole('button', { name: 'Light the pumpkin' })).not.toBeInTheDocument();
  act(() => useSettingsStore.setState({ seasonalTheme: 'off' }));
  expect(screen.queryByRole('button', { name: 'Halloween corner' })).not.toBeInTheDocument();
  expect(document.documentElement).not.toHaveAttribute('data-season');
});

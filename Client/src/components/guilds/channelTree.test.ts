import { describe, expect, it } from 'vitest';
import type { Channel, OverwriteView } from '../../api/types';
import { buildTree, isLockedChannel, moveInTree } from './channelTree';

const ch = (id: string, type: Channel['type'], position: number, parentId: string | null = null, extra: Partial<Channel> = {}): Channel => ({
  id,
  guildId: 'G',
  type,
  name: id,
  description: null,
  position,
  createdAt: `2026-01-01T00:00:0${position}.000Z`,
  parentId,
  permissionsSynced: true,
  ...extra,
});

describe('buildTree', () => {
  it('groups channels under categories in position order, orphans first', () => {
    const tree = buildTree([ch('b', 'CATEGORY', 1), ch('a', 'CATEGORY', 0), ch('a2', 'TEXT', 2, 'a'), ch('a1', 'VOICE', 1, 'a'), ch('top', 'TEXT', 5), ch('b1', 'TEXT', 0, 'b'), ch('top0', 'TEXT', 0)]);
    expect(tree.orphans.map((c) => c.id)).toEqual(['top0', 'top']);
    expect(tree.categories.map((g) => g.category.id)).toEqual(['a', 'b']);
    expect(tree.categories[0]!.children.map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(tree.categories[1]!.children.map((c) => c.id)).toEqual(['b1']);
  });

  it('a channel with an unknown parent becomes an orphan; an empty category stays', () => {
    const tree = buildTree([ch('x', 'TEXT', 0, 'gone'), ch('empty', 'CATEGORY', 0)]);
    expect(tree.orphans.map((c) => c.id)).toEqual(['x']);
    expect(tree.categories).toHaveLength(1);
    expect(tree.categories[0]?.category.id).toBe('empty');
    expect(tree.categories[0]?.children).toEqual([]);
  });

  it('ties on position are ordered by creation time', () => {
    const tree = buildTree([ch('late', 'TEXT', 0, null, { createdAt: '2026-02-01T00:00:00.000Z' }), ch('early', 'TEXT', 0, null, { createdAt: '2026-01-01T00:00:00.000Z' })]);
    expect(tree.orphans.map((c) => c.id)).toEqual(['early', 'late']);
  });
});

describe('moveInTree', () => {
  const channels = [ch('a', 'CATEGORY', 0), ch('b', 'CATEGORY', 1), ch('a1', 'TEXT', 0, 'a'), ch('a2', 'TEXT', 1, 'a'), ch('b1', 'VOICE', 0, 'b'), ch('top', 'TEXT', 0)];
  const tree = buildTree(channels);

  it('reorders inside one category', () => {
    expect(moveInTree(tree, 'a2', { kind: 'before', id: 'a1' })).toEqual([
      { id: 'a2', parentId: 'a', position: 0 },
      { id: 'a1', parentId: 'a', position: 1 },
    ]);
  });

  it('moves a channel into another category (both groups renumbered)', () => {
    expect(moveInTree(tree, 'top', { kind: 'into', categoryId: 'b' })).toEqual([
      { id: 'b1', parentId: 'b', position: 0 },
      { id: 'top', parentId: 'b', position: 1 },
    ]);
    expect(moveInTree(tree, 'a1', { kind: 'before', id: 'b1' })).toEqual([
      { id: 'a2', parentId: 'a', position: 0 },
      { id: 'a1', parentId: 'b', position: 0 },
      { id: 'b1', parentId: 'b', position: 1 },
    ]);
  });

  it('moves a channel out to the top level', () => {
    expect(moveInTree(tree, 'b1', { kind: 'before', id: 'top' })).toEqual([
      { id: 'b1', parentId: null, position: 0 },
      { id: 'top', parentId: null, position: 1 },
    ]);
  });

  it('reorders categories', () => {
    expect(moveInTree(tree, 'b', { kind: 'before', id: 'a' })).toEqual([
      { id: 'b', parentId: null, position: 0 },
      { id: 'a', parentId: null, position: 1 },
    ]);
  });

  it('ignores no-ops and categories dropped onto channels', () => {
    expect(moveInTree(tree, 'a1', { kind: 'before', id: 'a1' })).toBeNull();
    expect(moveInTree(tree, 'a1', { kind: 'before', id: 'a2' })).toBeNull();
    expect(moveInTree(tree, 'a', { kind: 'before', id: 'top' })).toBeNull();
    expect(moveInTree(tree, 'a', { kind: 'into', categoryId: 'b' })).toBeNull();
    expect(moveInTree(tree, 'gone', { kind: 'into', categoryId: 'b' })).toBeNull();
  });
});

describe('isLockedChannel', () => {
  const hide: OverwriteView = { targetType: 'ROLE', targetId: 'everyone', allow: [], deny: ['VIEW_CHANNEL'] };
  it('is locked when @everyone cannot see it', () => {
    expect(isLockedChannel(ch('c', 'TEXT', 0, null, { permissionsSynced: false, overwrites: [hide] }), [], 'everyone')).toBe(true);
    expect(isLockedChannel(ch('c', 'TEXT', 0, null, { permissionsSynced: false, overwrites: [] }), [], 'everyone')).toBe(false);
  });
  it('a synced channel uses its category overwrites', () => {
    const cat = ch('cat', 'CATEGORY', 0, null, { overwrites: [hide] });
    expect(isLockedChannel(ch('c', 'TEXT', 0, 'cat', { overwrites: [] }), [cat], 'everyone')).toBe(true);
    expect(isLockedChannel(ch('c', 'TEXT', 0, 'cat', { permissionsSynced: false, overwrites: [] }), [cat], 'everyone')).toBe(false);
  });
  it('no overwrites known (not a manager) or no @everyone role: not shown as locked', () => {
    expect(isLockedChannel(ch('c', 'TEXT', 0), [], 'everyone')).toBe(false);
    expect(isLockedChannel(ch('c', 'TEXT', 0, null, { overwrites: [hide] }), [], null)).toBe(false);
  });
});

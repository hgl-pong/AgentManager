import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortStoreItems } from './store-sort.ts';
import type { StoreSkill } from '../../../shared/types.ts';

function skill(name: string, quality?: number, updatedAt?: string): StoreSkill {
  return {
    id: name,
    slug: name,
    owner: 'acme',
    name,
    summary: '',
    ...(quality === undefined ? {} : { quality }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    downloads: 0,
    favorites: 0,
    inSource: false,
  };
}

const ROWS = [
  skill('beta', 60, '2026-10-01T00:00:00.000Z'),
  skill('alpha', 90, '2026-11-20T00:00:00.000Z'),
  skill('gamma'),
];

test('default keeps the registry order untouched', () => {
  const sorted = sortStoreItems(ROWS, 'default');
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['beta', 'alpha', 'gamma'],
  );
  assert.equal(sorted, ROWS, 'no copy is made when nothing is reordered');
});

test('quality puts the highest score first and missing scores last', () => {
  assert.deepEqual(
    sortStoreItems(ROWS, 'quality').map((item) => item.name),
    ['alpha', 'beta', 'gamma'],
  );
});

test('updated puts the newest first and rows without a date last', () => {
  assert.deepEqual(
    sortStoreItems(ROWS, 'updated').map((item) => item.name),
    ['alpha', 'beta', 'gamma'],
  );
  assert.deepEqual(
    sortStoreItems([skill('x', 1, 'not a date'), skill('y', 1, '2026-01-01T00:00:00Z')], 'updated').map(
      (item) => item.name,
    ),
    ['y', 'x'],
  );
});

test('name sorts alphabetically and never mutates the rows it was given', () => {
  const sorted = sortStoreItems(ROWS, 'name');
  assert.deepEqual(
    sorted.map((item) => item.name),
    ['alpha', 'beta', 'gamma'],
  );
  assert.deepEqual(
    ROWS.map((item) => item.name),
    ['beta', 'alpha', 'gamma'],
    'the source order stays as the registry sent it',
  );
});

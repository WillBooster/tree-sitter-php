import { expect, test } from 'vitest';

import phpNodes from '../../php/src/node-types.json';
import phpOnlyNodes from '../../php_only/src/node-types.json';

test.each([
  ['php', phpNodes],
  ['php_only', phpOnlyNodes],
] as const)('%s publishes definitions for every referenced node type', (_dialect, nodes) => {
  const definitions = new Set(nodes.map(({ type, named }) => JSON.stringify([type, named])));
  const missing = collectReferences(nodes).filter((reference) => !definitions.has(reference));
  expect([...new Set(missing)]).toEqual([]);
});

function collectReferences(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(collectReferences);
  const references = Object.values(value).flatMap(collectReferences);
  if ('type' in value && 'named' in value) references.push(JSON.stringify([value.type, value.named]));
  return references;
}

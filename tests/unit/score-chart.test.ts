import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { labelledIndices } from '../../src/ui/score-chart';

const LABEL_WIDTH = 64;

describe('labelledIndices', () => {
  test('dates the first and the latest scan, and as many in between as fit', () => {
    assert.deepEqual(labelledIndices(12, 244), [0, 4, 7, 11]);
    assert.deepEqual(labelledIndices(3, 600), [0, 1, 2]);
    assert.deepEqual(labelledIndices(1, 600), [0]);
  });

  test('never puts two date labels closer than one label is wide', () => {
    for (const count of [2, 3, 5, 6, 12, 40]) {
      for (const width of [100, 150, 244, 300, 600, 1000]) {
        const picked = labelledIndices(count, width);
        const step = width / (count - 1);
        assert.equal(picked[picked.length - 1], count - 1, `the latest scan is always dated (${count}, ${width})`);
        for (let i = 1; i < picked.length; i++) {
          assert.ok((picked[i] - picked[i - 1]) * step >= LABEL_WIDTH, `${count} scans, ${width}px: ${picked}`);
        }
      }
    }
  });
});

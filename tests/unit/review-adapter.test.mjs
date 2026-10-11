import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reviewArguments,
  authenticatedStatus,
  completedReview,
} from '../../scripts/coderabbit-review.mjs';
test('review adapter cannot inject CLI flags or authorize paid credit use', () => {
  assert.deepEqual(reviewArguments('main'), [
    'review',
    '--agent',
    '--uncommitted',
    '--include-untracked',
    '--base',
    'main',
  ]);
  assert.throws(() => reviewArguments('--use-credits'));
  assert.throws(() => reviewArguments('main; curl secret'));
  assert.equal(reviewArguments().includes('--use-credits'), false);
});
test('review authentication requires explicit current authenticated status', () => {
  assert.equal(
    authenticatedStatus('{"type":"status","phase":"auth","authenticated":true}\n'),
    true,
  );
  assert.equal(authenticatedStatus('{"phase":"auth","authenticated":false}\n'), false);
  assert.equal(authenticatedStatus('unknown\n{"phase":"review","authenticated":true}\n'), false);
});

test('a successful exit or partial findings cannot masquerade as a completed source review', () => {
  assert.equal(completedReview('{"type":"finding","severity":"minor"}'), false);
  assert.equal(
    completedReview(
      '{"type":"complete","status":"review_completed","outcome":"completed","reviewedFiles":[]}',
    ),
    false,
  );
  assert.equal(
    completedReview(
      '{"type":"complete","status":"review_completed","outcome":"completed","reviewedFiles":["app.go"]}',
    ),
    true,
  );
});

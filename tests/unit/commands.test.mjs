import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from '../../shared/commands.js';
test('spoken control commands are normalized without invoking the planner', () => {
  assert.equal(classifyCommand('Run these tests!'), 'start');
  assert.equal(classifyCommand('Please stop.'), 'cancel');
  assert.equal(classifyCommand('Test status?'), 'status');
  assert.equal(classifyCommand('Run again'), 'rerun');
});
test('workflow requests containing control words remain test requests', () => {
  assert.equal(classifyCommand('Test the cancel button'), 'request');
  assert.equal(classifyCommand('Confirm the order total is 24'), 'request');
  assert.equal(classifyCommand('Stop the checkout modal from overlapping the button'), 'request');
});
